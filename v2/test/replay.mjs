// Local replay against real chat history with the real model and tools; nothing is sent to QQ.
// Usage: node test/replay.mjs <history.json> <secrets.json> [needle ...]
import fs from "node:fs";
import { loadLegacy } from "../scripts/legacy.mjs";
import { runTurn } from "../src/core.ts";
import { buildTools } from "../src/tools.ts";
import { dsChat } from "../src/llm.ts";

const [file, secretFile, ...needles] = process.argv.slice(2);
const sec = JSON.parse(fs.readFileSync(secretFile, "utf8"));
const env = { DEEPSEEK_API_KEY: sec.DEEPSEEK_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API, GITHUB_TOKEN: process.env.ORGANIZATION_GITHUB, GITHUB_ORG: "OmnixSI" };
const { rows } = loadLegacy(file);
const memory = fs.existsSync(process.env.MEMORY_FILE || "") ? fs.readFileSync(process.env.MEMORY_FILE, "utf8") : "";

function host(now, upto) {
  const notes = [];
  return {
    env, now: () => now, notes,
    sendImage: async () => ({ ok: true }),
    quota: async () => true,
    remember: async t => { notes.push(t); console.log("     [remember]", t); },
    forget: async () => 0,
    searchHistory: async (q, days, limit) => { const ks = q.split(/\s+/).filter(Boolean); return rows.filter(r => r.seq <= upto && ks.every(k => r.text.includes(k))).slice(-limit); },
    getHistory: async (from, to, limit) => rows.filter(r => r.seq <= upto && r.ts >= from && r.ts < to).slice(-limit),
    summaries: async () => [],
    scheduleCreate: async (spec, task) => { console.log("     [schedule]", JSON.stringify(spec), task); return { id: 1, next: now + 3600000 }; },
    scheduleList: async () => [], scheduleCancel: async () => true, ledger: async () => [], cookie: () => '', sendVoice: async () => ({ ok: true }),
  };
}

async function at(index, windowBack = 1) {
  // The turn covers the last `windowBack` human messages ending at rows[index].
  const end = rows[index], hist = rows.slice(Math.max(0, index - 70), index + 1).filter(r => r.role === "user" || r.seq < rows[index - windowBack + 1].seq);
  const cursor = rows[index - windowBack]?.seq ?? 0;
  const fresh = hist.filter(r => r.seq > cursor && r.role === "user");
  const h = host(end.ts + 1500, end.seq);
  const res = await runTurn(
    { rows: hist, cursor, mentioned: fresh.some(r => r.mentioned || /@\s*bot|^\s*(bot|boat)[，,：: ]/i.test(r.text)), memory, notes: [], now: end.ts + 1500 },
    { chat: (b, e, t) => dsChat(env, b, e, t), tools: buildTools(h), interim: async t => console.log("     [interim]", t) },
  );
  console.log("\n— " + fresh.map(r => (r.name || "?") + ": " + r.text.slice(0, 90)).join(" | "));
  console.log("  → " + (res.silent ? "(PASS)" : res.replies.map(x => x.replace(/\n/g, "⏎")).join("  ‖  ")));
  console.log("    " + res.stats.ms + "ms first " + res.stats.firstMs + "ms calls " + res.stats.calls + " tools [" + res.stats.tools.join(",") + "] in " + res.stats.inTok + " cached " + res.stats.cached + (res.stats.error ? " ERR " + res.stats.error : ""));
  return res;
}

if (needles[0] === "--range") {
  const from = rows.findIndex(r => r.role === "user" && r.text.includes(needles[1]));
  const n = Number(needles[2] || 20);
  let pass = 0, total = 0, ms = [];
  for (let i = from; i < rows.length && total < n; i++) {
    if (rows[i].role !== "user") continue;
    const r = await at(i); total++; if (r.silent) pass++; else ms.push(r.stats.ms);
  }
  ms.sort((a, b) => a - b);
  console.log("\nturns", total, "silent", pass, "spoke", total - pass, "median ms", ms[Math.floor(ms.length / 2)], "max", ms.at(-1));
} else {
  for (const needle of needles) {
    const i = rows.findIndex(r => r.role === "user" && r.text.includes(needle));
    if (i < 0) { console.log("not found:", needle); continue; }
    await at(i);
  }
}
