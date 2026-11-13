#!/usr/bin/env node
// F7-4 offline gate fit. Reads a read-only JSON history export (messages/outbox/decisions),
// replays the bot's own speeches through src/gate.ts and reports how many proactive messages
// the gate would suppress. It never opens D1, never sends QQ and never writes into <history-dir>.
//
// usage: node scripts/fit-gate.mjs <history-dir> [--target-per-hour 4]
//        [--bot-count all|proactive] [--quiet 23:00-08:00] [--quiet-off] [--json] [--out report.json]
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TZ_OFFSET = 480; // the team group's clock, UTC+8
const HOUR = 3600000;

function usage(code = 2) {
  console.error("usage: node scripts/fit-gate.mjs <history-dir> [--target-per-hour 4] [--bot-count all|proactive] [--quiet 23:00-08:00] [--quiet-off] [--json] [--out report.json]");
  process.exit(code);
}

function parseQuiet(text) {
  const m = /^((?:[01]?\d|2[0-3]):[0-5]\d)-((?:[01]?\d|2[0-3]):[0-5]\d)$/.exec(String(text || "").trim());
  if (!m) usage();
  return { start: m[1], end: m[2], utcOffsetMinutes: TZ_OFFSET };
}

const argv = process.argv.slice(2);
const positional = [];
let quiet = { start: "23:00", end: "08:00", utcOffsetMinutes: TZ_OFFSET };
let targetPerHour = 4;
let botCountMode = "all";
let asJson = false;
let outFile = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") asJson = true;
  else if (a === "--quiet-off") quiet = null;
  else if (a === "--quiet") quiet = parseQuiet(argv[++i]);
  else if (a === "--target-per-hour") targetPerHour = Number(argv[++i]);
  else if (a === "--bot-count") botCountMode = argv[++i];
  else if (a === "--out") outFile = argv[++i];
  else if (a === "--help" || a === "-h") usage(0);
  else if (a.startsWith("--")) usage();
  else positional.push(a);
}
if (!Number.isInteger(targetPerHour) || targetPerHour < 1 || targetPerHour > 100) usage();
if (!["all", "proactive"].includes(botCountMode)) usage();
const dir = positional[0] || process.env.GATE_HISTORY_DIR;
if (!dir) usage();

function load(name, required) {
  const file = join(dir, name + ".json");
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(value)) throw Error("not an array");
    return value;
  } catch (error) {
    if (required) {
      console.error(`cannot read ${file}: ${error.message}`);
      process.exit(2);
    }
    console.error(`warning: ${name}.json not readable (${error.message}); continuing without it`);
    return [];
  }
}

const messages = load("messages", true);
const outbox = load("outbox", true);
const decisions = load("decisions", false);

const outfile = join(ROOT, ".wrangler", `fit-gate-${process.pid}.mjs`);
mkdirSync(dirname(outfile), { recursive: true });
let gate;
try {
  await build({ entryPoints: [join(ROOT, "src/gate.ts")], bundle: true, format: "esm", platform: "browser", outfile });
  gate = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(outfile, { force: true });
}

function metaOf(row) {
  const value = row && row.meta;
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === "object" ? value : {};
}

function groupData(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row.group_id || "");
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

const msgGroups = groupData(messages);
const outGroups = groupData(outbox);
const decGroups = groupData(decisions);
const groupIds = [...new Set([...outGroups.keys(), ...msgGroups.keys(), ...decGroups.keys()])].sort();

function baseId(id) {
  return String(id || "").split("~")[0];
}

function classify(outboxRows, decisionRows, messageRows) {
  const byId = new Map(messageRows.map((m) => [String(m.id), m]));
  const decisionsByOutbox = new Map();
  for (const d of decisionRows) if (d.outbox_id) decisionsByOutbox.set(baseId(d.outbox_id), d);
  const segments = new Map();
  let failed = 0;
  for (const o of outboxRows) {
    if (o.status === "failed") { failed++; continue; }
    const id = baseId(o.id);
    if (!segments.has(id)) segments.set(id, []);
    segments.get(id).push(o);
  }
  const speeches = [];
  for (const [id, rows] of segments) {
    const first = rows.reduce((a, b) => Number(a.created_at) <= Number(b.created_at) ? a : b);
    const d = decisionsByOutbox.get(id);
    const msg = byId.get(String(first.msg_id || ""));
    const latest = byId.get(String((d && d.latest_id) || ""));
    const categories = new Set();
    if (d && d.spoken_kind === "direct") categories.add("decision");
    if (d && (Number(d.mentioned) === 1 || Number(d.forced) === 1)) categories.add("decision");
    if (msg && Number(msg.mentioned) === 1) categories.add("mention");
    if (msg && metaOf(msg).replyTo && metaOf(msg).replyTo.kind === "bot") categories.add("reply_to_bot");
    if (latest && Number(latest.mentioned) === 1) categories.add("mention");
    if (latest && metaOf(latest).replyTo && metaOf(latest).replyTo.kind === "bot") categories.add("reply_to_bot");
    speeches.push({ ts: Number(first.created_at), id, direct: categories.size > 0, categories: [...categories], body: String(first.body || "") });
  }
  speeches.sort((a, b) => a.ts - b.ts);
  return { speeches, failed };
}

function countBetween(sorted, fromExclusive, toInclusive) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= fromExclusive) lo = mid + 1; else hi = mid; }
  const start = lo;
  hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= toInclusive) lo = mid + 1; else hi = mid; }
  return lo - start;
}

function maxPerHour(sorted) {
  let best = 0, left = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (sorted[left] <= sorted[i] - HOUR) left++;
    if (i - left + 1 > best) best = i - left + 1;
  }
  return best;
}

function localStamp(ts) {
  return new Date(ts + TZ_OFFSET * 60000).toISOString().slice(0, 16).replace("T", " ");
}

function simulate(group, config, botCountMode) {
  const { speeches } = group;
  const humans = group.messages.map((m) => Date.parse(m.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  const kept = [];
  const keptProactive = [];
  const keptDirect = [];
  const reasons = new Map();
  const blockedSamples = [];
  let direct = 0, directBlocked = 0, blocked = 0;
  for (const s of speeches) {
    const budget = botCountMode === "proactive" ? keptProactive : kept;
    const bots = countBetween(budget, s.ts - HOUR, s.ts);
    const lastBotTs = kept.length ? kept[kept.length - 1] : null;
    const humanWindowMs = config.humanWindowMinutes * 60000;
    const humansRecent = countBetween(humans, s.ts - humanWindowMs, s.ts);
    const result = gate.shouldSpeak({
      mode: s.direct ? "direct" : "proactive",
      mentioned: s.categories.includes("mention"),
      lastBotTs,
      now: s.ts,
      recentBotCount: bots,
      recentHumanCount: humansRecent,
      quietHours: quiet,
      config,
    });
    if (s.direct) {
      direct++;
      if (!result.speak) { directBlocked++; continue; }
      kept.push(s.ts);
      keptDirect.push(s.ts);
    } else if (result.speak) {
      kept.push(s.ts);
      keptProactive.push(s.ts);
    } else {
      blocked++;
      const prefix = result.reason.split(" ")[0];
      reasons.set(prefix, (reasons.get(prefix) || 0) + 1);
      if (blockedSamples.length < 5) blockedSamples.push({ at: localStamp(s.ts), reason: result.reason });
    }
  }
  return {
    direct, directBlocked, blocked,
    keptProactive: keptProactive.length,
    maxProactivePerHour: maxPerHour(keptProactive),
    maxAllPerHour: maxPerHour(kept),
    reasons: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])),
    blockedSamples,
  };
}

function distanceFromDefaults(config) {
  const d = gate.GATE_DEFAULTS;
  return Math.abs(config.cooldownSeconds - d.cooldownSeconds) / Math.max(1, d.cooldownSeconds)
    + Math.abs(config.minHumanMessages - d.minHumanMessages) / Math.max(1, d.minHumanMessages)
    + Math.abs(config.humanWindowMinutes - d.humanWindowMinutes) / Math.max(1, d.humanWindowMinutes);
}

function fit(group, botCountMode) {
  const candidates = [];
  for (const cooldownSeconds of [30, 60, 90, 120, 180, 300, 600]) {
    for (const minHumanMessages of [2, 3, 4]) {
      for (const humanWindowMinutes of [5, 10, 15, 30]) {
        const config = { cooldownSeconds, maxPerHour: targetPerHour, minHumanMessages, humanWindowMinutes };
        candidates.push({ config, result: simulate(group, config, botCountMode) });
      }
    }
  }
  const feasible = candidates.filter((c) => c.result.directBlocked === 0 && c.result.maxProactivePerHour <= targetPerHour);
  feasible.sort((a, b) =>
    b.result.keptProactive - a.result.keptProactive
    || distanceFromDefaults(a.config) - distanceFromDefaults(b.config)
    || a.config.cooldownSeconds - b.config.cooldownSeconds);
  if (feasible.length) return { feasible: true, ...feasible[0] };
  candidates.sort((a, b) =>
    a.result.maxProactivePerHour - b.result.maxProactivePerHour
    || b.result.keptProactive - a.result.keptProactive
    || distanceFromDefaults(a.config) - distanceFromDefaults(b.config));
  return { feasible: false, ...candidates[0] };
}

const reports = [];
for (const groupId of groupIds) {
  const group = {
    id: groupId,
    messages: msgGroups.get(groupId) || [],
    outbox: outGroups.get(groupId) || [],
    decisions: decGroups.get(groupId) || [],
  };
  if (!group.outbox.length) continue;
  const classified = classify(group.outbox, group.decisions, group.messages);
  group.speeches = classified.speeches;
  group.failedOutbox = classified.failed;
  if (!group.speeches.length) continue;
  const first = group.speeches[0].ts, last = group.speeches[group.speeches.length - 1].ts;
  group.spanHours = (last - first) / HOUR;
  group.direct = group.speeches.filter((s) => s.direct);
  group.proactive = group.speeches.filter((s) => !s.direct);
  group.directMention = group.direct.filter((s) => s.categories.includes("mention")).length;
  group.directReply = group.direct.filter((s) => s.categories.includes("reply_to_bot")).length;
  group.directDecision = group.direct.filter((s) => s.categories.includes("decision")).length;
  group.baseline = {
    speeches: group.speeches.length,
    proactive: group.proactive.length,
    direct: group.direct.length,
    proactivePerHour: group.proactive.length / Math.max(0.01, group.spanHours),
    maxProactivePerHour: maxPerHour(group.proactive.map((s) => s.ts)),
    maxAllPerHour: maxPerHour(group.speeches.map((s) => s.ts)),
  };
  const defaultConfig = { ...gate.GATE_DEFAULTS };
  group.defaultResult = simulate(group, defaultConfig, botCountMode);
  group.fitted = fit(group, botCountMode);
  group.from = localStamp(first);
  group.to = localStamp(last);
  reports.push(group);
}

const totals = reports.reduce((t, g) => {
  t.groups++;
  t.messages += g.messages.length;
  t.speeches += g.baseline.speeches;
  t.direct += g.baseline.direct;
  t.proactive += g.baseline.proactive;
  t.directBlocked += g.fitted.result.directBlocked;
  t.proactiveKept += g.fitted.result.keptProactive;
  t.proactiveBlocked += g.fitted.result.blocked;
  return t;
}, { groups: 0, messages: 0, speeches: 0, direct: 0, proactive: 0, directBlocked: 0, proactiveKept: 0, proactiveBlocked: 0 });

const payload = {
  schema: "f7-4-gate-fit/1",
  generatedAt: new Date().toISOString(),
  source: resolve(dir),
  readOnly: true,
  writes: "0 D1 rows, 0 QQ messages",
  targetPerHour,
  botCountMode,
  quietHours: quiet,
  configs: { defaults: gate.GATE_DEFAULTS, fitted: reports.map((g) => ({ groupId: g.id, ...g.fitted.config, feasible: g.fitted.feasible })) },
  totals,
  groups: reports.map((g) => ({
    groupId: g.id,
    from: g.from, to: g.to, spanHours: Number(g.spanHours.toFixed(2)),
    messages: g.messages.length, failedOutbox: g.failedOutbox,
    baseline: g.baseline,
    directCategories: { mention: g.directMention, reply_to_bot: g.directReply, decision: g.directDecision },
    defaultConfig: { ...gate.GATE_DEFAULTS, result: g.defaultResult },
    fitted: { feasible: g.fitted.feasible, config: g.fitted.config, result: g.fitted.result },
  })),
};

if (outFile) {
  const target = resolve(outFile);
  if (target === resolve(dir) || target.startsWith(resolve(dir) + sep)) {
    console.error("refusing to write into the read-only history dir");
    process.exit(2);
  }
  writeFileSync(target, JSON.stringify(payload, null, 2) + "\n");
  console.error(`wrote ${target}`);
}

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const lines = [];
  lines.push("# gate fit · real history");
  lines.push("");
  lines.push(`source: ${resolve(dir)} (read-only JSON export; no D1 writes, no QQ sends)`);
  lines.push(`groups: ${totals.groups}  messages: ${totals.messages}  bot speeches: ${totals.speeches} (direct ${totals.direct}, proactive ${totals.proactive})  bot-count budget: ${botCountMode}`);
  lines.push("");
  for (const g of reports) {
    lines.push(`## group ${g.id}`);
    lines.push("");
    lines.push(`window: ${g.from} .. ${g.to} +08:00 (${g.spanHours.toFixed(1)} h)  failed outbox rows skipped: ${g.failedOutbox}`);
    lines.push(`baseline: proactive ${g.baseline.proactive} (${g.baseline.proactivePerHour.toFixed(2)}/h, max ${g.baseline.maxProactivePerHour}/h); direct ${g.baseline.direct}; max all ${g.baseline.maxAllPerHour}/h`);
    lines.push(`direct categories (may overlap): mention ${g.directMention}, reply_to_bot ${g.directReply}, decision/forced ${g.directDecision}`);
    lines.push("");
    lines.push("| config | cooldown | max/h | min humans | window | quiet | proactive kept | blocked | max/h | direct blocked |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    const row = (label, r) => `| ${label} | ${r.config.cooldownSeconds}s | ${r.config.maxPerHour} | ${r.config.minHumanMessages} | ${r.config.humanWindowMinutes}m | ${quiet ? quiet.start + "-" + quiet.end : "off"} | ${r.result.keptProactive} | ${r.result.blocked} | ${r.result.maxProactivePerHour} | ${r.result.directBlocked} |`;
    lines.push(row("default", { config: gate.GATE_DEFAULTS, result: g.defaultResult }));
    lines.push(row(g.fitted.feasible ? "fitted" : "best-effort", { config: g.fitted.config, result: g.fitted.result }));
    lines.push("");
    const f = g.fitted.result;
    const cut = g.baseline.proactive ? ((f.blocked / g.baseline.proactive) * 100).toFixed(1) : "0.0";
    lines.push(`fitted result: proactive ${g.baseline.proactive} -> ${f.keptProactive} kept, ${f.blocked} suppressed (${cut}%), max ${g.baseline.maxProactivePerHour}/h -> ${f.maxProactivePerHour}/h`);
    lines.push(`blocked reasons: ${Object.entries(f.reasons).map(([k, v]) => k + " " + v).join(", ") || "none"}`);
    lines.push(`direct replies: ${f.direct} kept, ${f.directBlocked} blocked${f.directBlocked ? "  <-- FAIL" : ""}`);
    if (f.blockedSamples.length) lines.push(`blocked examples: ${f.blockedSamples.map((s) => s.at + " " + s.reason).join("; ")}`);
    lines.push("");
  }
  lines.push("## totals");
  lines.push("");
  lines.push(`direct replies: ${totals.direct} kept, ${totals.directBlocked} blocked${totals.directBlocked ? "  <-- FAIL" : ""}`);
  lines.push(`proactive: ${totals.proactive} -> ${totals.proactiveKept} kept, ${totals.proactiveBlocked} suppressed`);
  lines.push("");
  console.log(lines.join("\n"));
}

process.exitCode = totals.directBlocked > 0 ? 1 : 0;
