// F7-4w: wire the pure proactive-speech gate (src/gate.ts) to D1 state.
// Every query is bound to one group_id, so group A can never spend group B's budget.
// `settings` is the already-loaded switch batch (loadSwitches): the wire adds no
// settings read on the hot chat path. Without it (offline replay/tests) the two
// gate keys are read directly.
import { normalizeGateConfig, shouldSpeak, type GateConfig, type GateQuietHours } from "./gate";

export type GateMode = "off" | "shadow" | "on";

export interface GateCheckInput {
  groupId: string;
  latest?: any;
  mentioned: boolean;
  forced: boolean;
  now: number;
  /** loadSwitches() result, already fetched by the chat claim; avoids a per-message read */
  settings?: Record<string, string | undefined>;
}

export interface GateCheckResult {
  speak: boolean;
  reason: string;
  mode: GateMode;
}

const MODES = new Set(["off", "shadow", "on"]);
const HOUR_MS = 3600000;

/** Anything that is not an explicit shadow/on value falls back to off. */
export function parseGateMode(value: unknown): GateMode {
  const mode = String(value ?? "").trim().toLowerCase();
  return (MODES.has(mode) ? mode : "off") as GateMode;
}

/** gate:config is JSON; snake_case is accepted because config/team.json uses it. */
export function parseGateSettings(raw: string | undefined): { config: GateConfig; quietHours: GateQuietHours | null } {
  let value: any = {};
  if (raw) {
    try {
      value = JSON.parse(raw) || {};
    } catch {
      value = {};
    }
  }
  if (!value || typeof value !== "object") value = {};
  const config = normalizeGateConfig({
    cooldownSeconds: value.cooldownSeconds ?? value.cooldown_seconds,
    maxPerHour: value.maxPerHour ?? value.max_per_hour,
    minHumanMessages: value.minHumanMessages ?? value.min_human_messages,
    humanWindowMinutes: value.humanWindowMinutes ?? value.human_window_minutes,
  });
  const quiet = value.quietHours ?? value.quiet_hours;
  const quietHours: GateQuietHours | null =
    quiet && typeof quiet === "object" && typeof quiet.start === "string" && typeof quiet.end === "string"
      ? { start: quiet.start, end: quiet.end, utcOffsetMinutes: quiet.utcOffsetMinutes ?? quiet.utc_offset_minutes }
      : null;
  // Silence is opt-in only: the default config never mutes anyone.
  return { config, quietHours };
}

async function settingValue(e: any, key: string): Promise<string | undefined> {
  return (await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first())?.value;
}

export async function gateCheck(e: any, input: GateCheckInput): Promise<GateCheckResult> {
  const groupId = String(input.groupId || "");
  const mode = parseGateMode(
    input.settings ? input.settings["gate:mode"] : await settingValue(e, "gate:mode"),
  );
  const now = Number(input.now);

  // Forced paths never reach the counters: a mention, a quoted bot message,
  // a video wait or an explicit direct request must always be answered.
  if (input.forced || input.mentioned || input.latest?.meta?.replyTo?.kind === "bot") {
    const reason = input.mentioned ? "forced:mentioned" : input.forced ? "forced:direct" : "forced:reply";
    return { speak: true, reason, mode };
  }
  if (mode === "off") return { speak: true, reason: "gate:off", mode };
  if (!groupId || !Number.isFinite(now)) return { speak: false, reason: "invalid_now", mode };

  const rawConfig = input.settings ? input.settings["gate:config"] : await settingValue(e, "gate:config");
  const { config, quietHours } = parseGateSettings(rawConfig);
  const humanCutoff = new Date(now - config.humanWindowMinutes * 60000).toISOString();
  const nowIso = new Date(now).toISOString();
  const row = await e.DB.prepare(
    `SELECT
      (SELECT MAX(created_at) FROM outbox WHERE group_id=?1 AND status IN ('pending','sent') AND id NOT LIKE '%~s' AND created_at<=?2) AS last_bot_ts,
      (SELECT COUNT(*) FROM chat_decisions WHERE group_id=?1 AND created_at>?3 AND created_at<=?2 AND spoken_kind='proactive' AND forced=0 AND mentioned=0 AND outbox_id IS NOT NULL) AS proactive_count,
      (SELECT COUNT(*) FROM messages WHERE group_id=?1 AND datetime(ts)>datetime(?4) AND datetime(ts)<=datetime(?5)) AS human_count`,
  )
    .bind(groupId, now, now - HOUR_MS, humanCutoff, nowIso)
    .first();
  const decision = shouldSpeak({
    mode: "proactive",
    mentioned: false,
    lastBotTs: row?.last_bot_ts ?? null,
    now,
    recentBotCount: Number(row?.proactive_count || 0),
    recentHumanCount: Number(row?.human_count || 0),
    quietHours,
    config,
  });
  return { speak: decision.speak, reason: decision.reason, mode };
}
