// F7-4: proactive-speech frequency gate.
// Pure function on purpose: no D1, no timers, no module-level state. The caller owns group
// isolation and passes per-group counts in; that keeps this module testable and lets F7-4w wire
// it after the V-A event layer lands. Rules: mentions / commands / direct replies always speak;
// ambient (proactive) speech must pass quiet hours, cooldown, hourly cap and human density.
// 思路参考 MaiBot dynamic_gate.py / idle_backoff.py（GPL-3.0，只借特征与阈值思路，代码自写）。

export type GateMode = "chat" | "proactive" | "direct" | "command";

export interface GateQuietHours {
  /** local start, "HH:MM", inclusive */
  start: string;
  /** local end, "HH:MM", exclusive; may wrap past midnight */
  end: string;
  /** minutes east of UTC for the group's clock; default 480 (UTC+8, the team group) */
  utcOffsetMinutes?: number;
}

export interface GateConfig {
  /** minimum seconds since any bot message before another proactive message */
  cooldownSeconds: number;
  /** maximum bot messages (direct + proactive) in the trailing hour */
  maxPerHour: number;
  /** minimum human messages in the density window */
  minHumanMessages: number;
  /** what window recentHumanCount was counted over (documented in the trace reason) */
  humanWindowMinutes: number;
}

export interface GateInput {
  /** "chat": a batch woke the bot; "proactive": bot-initiated; "direct": quoted/replied to bot; "command": explicit command */
  mode: GateMode | string;
  /** true when the batch @-mentioned the bot */
  mentioned: boolean;
  /** epoch ms of the last bot message in this group, or null/0 when none */
  lastBotTs?: number | null;
  /** epoch ms of the decision point */
  now: number;
  /** bot messages in the trailing hour in this group, before this decision */
  recentBotCount: number;
  /** human messages in humanWindowMinutes, before this decision */
  recentHumanCount: number;
  /** per-group quiet hours; null/undefined disables the window */
  quietHours?: GateQuietHours | null;
  /** per-group thresholds; omitted fields fall back to GATE_DEFAULTS */
  config?: Partial<GateConfig>;
}

export interface GateDecision {
  speak: boolean;
  /** short, stable prefix for chat_decisions.reason (quiet_hours / cooldown / hourly_cap / ...) */
  reason: string;
}

export const GATE_DEFAULTS: GateConfig = Object.freeze({
  cooldownSeconds: 120,
  maxPerHour: 4,
  minHumanMessages: 2,
  humanWindowMinutes: 10,
});

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function normalizeGateConfig(config?: Partial<GateConfig> | null): GateConfig {
  const c = config || {};
  return {
    cooldownSeconds: numberIn(c.cooldownSeconds, GATE_DEFAULTS.cooldownSeconds, 0, 86400),
    maxPerHour: numberIn(c.maxPerHour, GATE_DEFAULTS.maxPerHour, 1, 1000),
    minHumanMessages: numberIn(c.minHumanMessages, GATE_DEFAULTS.minHumanMessages, 0, 10000),
    humanWindowMinutes: numberIn(c.humanWindowMinutes, GATE_DEFAULTS.humanWindowMinutes, 1, 1440),
  };
}

function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function quietWindow(hours?: GateQuietHours | null): { start: number; end: number; offset: number } | null {
  if (!hours) return null;
  const start = parseClock(hours.start), end = parseClock(hours.end);
  if (start === null || end === null || start === end) return null;
  const raw = Number(hours.utcOffsetMinutes);
  const offset = Number.isFinite(raw) ? Math.min(840, Math.max(-720, Math.floor(raw))) : 480;
  return { start, end, offset };
}

function localMinute(now: number, offset: number): number {
  const m = Math.floor(now / 60000) + offset;
  return ((m % 1440) + 1440) % 1440;
}

function inWindow(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function clock(minute: number): string {
  return String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
}

/** Decide whether one bot turn may speak. Never throws on partial input. */
export function shouldSpeak(input: GateInput): GateDecision {
  const i = input || ({} as GateInput);
  const mode = String(i.mode || "chat").toLowerCase();

  // Forced paths: a mention, a command or a reply to the bot must never be muted by a gate.
  if (mode === "command") return { speak: true, reason: "forced:command" };
  if (mode === "direct") return { speak: true, reason: "forced:direct" };
  if (i.mentioned) return { speak: true, reason: "forced:mentioned" };

  const now = Number(i.now);
  if (!Number.isFinite(now)) return { speak: false, reason: "invalid_now" };

  const config = normalizeGateConfig(i.config);
  const quiet = quietWindow(i.quietHours);
  if (quiet) {
    const minute = localMinute(now, quiet.offset);
    if (inWindow(minute, quiet.start, quiet.end)) {
      return { speak: false, reason: `quiet_hours ${clock(minute)} in ${clock(quiet.start)}-${clock(quiet.end)}` };
    }
  }

  const last = Number(i.lastBotTs);
  const hasLast = Number.isFinite(last) && last > 0;
  const sinceLast = hasLast ? Math.max(0, Math.floor((now - last) / 1000)) : null;
  if (sinceLast !== null && sinceLast < config.cooldownSeconds) {
    return { speak: false, reason: `cooldown ${sinceLast}s<${config.cooldownSeconds}s` };
  }

  const bots = Math.max(0, Math.floor(Number(i.recentBotCount) || 0));
  if (bots >= config.maxPerHour) {
    return { speak: false, reason: `hourly_cap ${bots}>=${config.maxPerHour}` };
  }

  const humans = Math.max(0, Math.floor(Number(i.recentHumanCount) || 0));
  if (humans < config.minHumanMessages) {
    return { speak: false, reason: `low_human_activity ${humans}<${config.minHumanMessages} in ${config.humanWindowMinutes}m` };
  }

  return {
    speak: true,
    reason: `eligible humans=${humans} bots=${bots} last=${sinceLast === null ? "none" : sinceLast + "s"}`,
  };
}
