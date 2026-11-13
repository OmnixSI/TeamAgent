#!/usr/bin/env node
/**
 * SK-3 manual replay / evidence report.
 *
 *   node scripts/self-card-replay.mjs --facts
 *   node scripts/self-card-replay.mjs --mode a
 *   DEEPSEEK_API_KEY_FILE=~/.inkboard-team/worker-secrets.json \
 *     node scripts/self-card-replay.mjs --mode b
 *   node scripts/self-card-replay.mjs --mode all
 *
 * A = deterministic: real describe_self tool + fake D1 (test/support.mjs env()).
 * B = one real DeepSeek pass over the same questions. The only network endpoint
 *     allowed is api.deepseek.com/chat/completions; every other outbound call
 *     is counted and answered with 503 locally. No QQ send, no online D1 write.
 *     The key comes from DEEPSEEK_API_KEY_FILE (raw text or JSON with
 *     DEEPSEEK_API_KEY) or DEEPSEEK_API_KEY and is never printed or persisted.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  repoPath,
  readFacts,
  buildChecks,
  evaluateAnswer,
} from "../test/self-card-facts.mjs";
import {
  loadQuestions,
  replayAvailability,
  loadReplayApi,
  readCardCommit,
  prepareEnv,
  renderQuestion,
  redactSecrets,
  outputText,
} from "../test/self-card-harness.mjs";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const MODE = valueOf("--mode", has("--facts") ? "facts" : "a");
const LIMIT = Number(valueOf("--limit", "0")) || 0;
const GROUPS = String(valueOf("--groups", "") || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const inGroups = (group) => !GROUPS.length || GROUPS.includes(group.id);
const STRICT = has("--strict");
const QUIET = has("--quiet");
const FACTS = readFacts();
const CHECKS = buildChecks(FACTS);
const QUESTIONS = loadQuestions();
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const CARD_COMMIT = readCardCommit();

function agentRoot() {
  if (process.env.SK_AGENT_DIR) return path.resolve(process.env.SK_AGENT_DIR);
  const sibling = path.resolve(REPO_ROOT, "../../.agent");
  if (fs.existsSync(sibling)) return sibling;
  return path.resolve(REPO_ROOT, ".agent");
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeReport(report) {
  const dir = path.join(agentRoot(), "releases/SK/replay");
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(report, null, 2);
  const file = path.join(dir, `self-card-replay-${stamp()}.json`);
  fs.writeFileSync(file, body + "\n");
  fs.writeFileSync(path.join(dir, "self-card-replay-latest.json"), body + "\n");
  return file;
}

function row({ layer, group, question, state, answer, result, extra = {} }) {
  return {
    layer,
    acceptance: group.acceptance,
    group: group.id,
    id: question.id,
    question: question.text,
    state: state?.id || "default",
    topic: group.topic,
    query: group.query,
    pass: result.pass,
    failures: result.failures,
    conflicts: result.conflicts,
    asserted: result.asserted,
    answer: redactSecrets(answer, extra.secrets || []).slice(0, 600),
    ...extra,
  };
}

function summarize(rows, extra = {}) {
  const passed = rows.filter((r) => r.pass).length;
  return {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    pass_rate: rows.length ? Number(((passed / rows.length) * 100).toFixed(1)) : 0,
    ...extra,
  };
}

function printRow(r) {
  if (QUIET) return;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.layer} ${r.id}/${r.state} ${r.question}`);
  for (const f of r.failures) console.log("     " + f);
}

// ---------------------------------------------------------------------------
// Facts mode
// ---------------------------------------------------------------------------
if (MODE === "facts") {
  console.log(JSON.stringify({ head: HEAD, card_commit: CARD_COMMIT, facts: FACTS, checks: Object.keys(CHECKS) }, null, 2));
  process.exit(0);
}

const availability = replayAvailability();
if ((MODE === "a" || MODE === "all") && !availability.ready) {
  console.error(
    `A 层还不能跑：generated=${availability.generated} runtime=${availability.runtime} tool=${availability.toolFile} registered=${availability.registered}`,
  );
  if (MODE === "a") process.exit(2);
}

const rows = [];
const startedAt = new Date().toISOString();
let factsMode = null;

// ---------------------------------------------------------------------------
// A layer: real tool + fake D1
// ---------------------------------------------------------------------------
if ((MODE === "a" || MODE === "all") && availability.ready) {
  const support = await import("../test/support.mjs");
  const api = await loadReplayApi();
  let index = 0;
  for (const group of QUESTIONS.groups) {
    if (!inGroups(group)) continue;
    for (const question of group.questions) {
      if (LIMIT && index >= LIMIT) break;
      const states = group.states?.length
        ? group.states
        : [{ id: "default", env: {} }];
      for (const state of states) {
        if (LIMIT && index >= LIMIT) break;
        try {
          const e = await prepareEnv(support.env(), {
            settings: state.settings,
            env: state.env,
            removeEnv: state.removeEnv,
            release: CARD_COMMIT,
          });
          const answer = await renderQuestion(api, e, question, group, state);
          const result = evaluateAnswer(answer, group, FACTS, CHECKS, question, state);
          const r = row({ layer: "A", group, question, state, answer, result });
          rows.push(r);
          printRow(r);
        } catch (error) {
          const r = row({
            layer: "A",
            group,
            question,
            state,
            answer: "",
            result: { pass: false, failures: ["抛出异常：" + String(error?.message || error)], conflicts: [], asserted: [] },
          });
          rows.push(r);
          printRow(r);
        }
        index++;
      }
    }
    if (LIMIT && index >= LIMIT) break;
  }
  factsMode = "A";
}

// ---------------------------------------------------------------------------
// B layer: real DeepSeek, everything else mocked
// ---------------------------------------------------------------------------
function deepseekKey() {
  const file = process.env.DEEPSEEK_API_KEY_FILE;
  if (file) {
    const raw = fs.readFileSync(file, "utf8");
    try {
      const json = JSON.parse(raw);
      const value = json.DEEPSEEK_API_KEY || json.deepseekApiKey || json.deepseek_api_key;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {}
    if (raw.trim()) return raw.trim();
  }
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  throw new Error("DEEPSEEK_API_KEY_FILE 或 DEEPSEEK_API_KEY 未设置，B 层拒绝调用付费接口");
}

if (MODE === "b" || MODE === "all") {
  const key = deepseekKey();
  const support = await import("../test/support.mjs");
  const outfile = `.wrangler/sk3-live-${process.pid}.mjs`;
  await build({
    stdin: { contents: 'export { agentAnswer } from "./src/semantic";', resolveDir: REPO_ROOT, loader: "ts" },
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const { agentAnswer } = await import(pathToFileURL(path.join(REPO_ROOT, outfile)).href);
  const realFetch = globalThis.fetch.bind(globalThis);
  let index = 0;
  for (const group of QUESTIONS.groups) {
    if (!inGroups(group)) continue;
    for (const question of group.questions) {
      if (LIMIT && index >= LIMIT) break;
      const states = group.states?.length
        ? group.states
        : [{ id: "default", env: {} }];
      for (const state of states) {
        if (LIMIT && index >= LIMIT) break;
        if (state.live === false) continue;
        const blocked = [];
        const trace = [];
        let modelCalls = 0;
        try {
          const e = await prepareEnv(support.env(), {
            settings: state.settings,
            env: state.env,
            removeEnv: state.removeEnv,
            release: CARD_COMMIT || HEAD,
          });
          e.DEEPSEEK_API_KEY = key;
          const latest = {
            id: "self-live-" + question.id + "-" + state.id,
            group_id: "GROUP000001",
            sender: "U1",
            body: question.text,
            ts: new Date().toISOString(),
            mentioned: 1,
            meta: { direct: true, media: [] },
          };
          await e.DB.prepare(
            "INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
          )
            .bind(latest.id, latest.group_id, latest.sender, latest.body, latest.ts, latest.mentioned)
            .run();
          const ctx = {
            latest,
            batch: [latest],
            recent: [latest],
            names: new Map(),
            refs: new Map(),
            mentioned: true,
          };
          globalThis.fetch = async (url, options = {}) => {
            const target = String(url);
            if (target === "https://api.deepseek.com/chat/completions") {
              modelCalls++;
              let body = null;
              try { body = JSON.parse(options.body); } catch {}
              const lastTool = [...(body?.messages || [])].reverse().find((m) => m?.role === "tool");
              const headers = new Headers(options.headers || {});
              headers.set("Authorization", "Bearer " + key);
              const response = await realFetch(target, { ...options, headers });
              try {
                const data = await response.clone().json();
                const message = data?.choices?.[0]?.message;
                trace.push({
                  request: modelCalls,
                  tool_calls: (message?.tool_calls || []).map((t) => ({
                    name: t.function?.name,
                    args: String(t.function?.arguments || "").slice(0, 160),
                  })),
                  tool_result: String(lastTool?.content || "").slice(0, 320),
                  content: String(message?.content || "").slice(0, 240),
                });
              } catch {}
              return response;
            }
            blocked.push(target.replace(/^https?:\/\//, "").split("/")[0]);
            return new Response(JSON.stringify({ error: "blocked by SK-3 replay" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          };
          let raw;
          try {
            raw = await agentAnswer(e, ctx);
          } finally {
            globalThis.fetch = realFetch;
          }
          const answer = outputText(raw);
          const result = evaluateAnswer(answer, group, FACTS, CHECKS, question, state, { layer: "B" });
          const leaked = answer.includes(key) || /sk-[A-Za-z0-9_-]{20,}/.test(answer);
          if (leaked) result.failures.push("回答里出现了密钥/令牌形状");
          const dsmlInAnswer = /DSML|＜｜｜|<｜｜/.test(answer);
          if (dsmlInAnswer) result.failures.push("正文含 DSML 残片");
          result.pass = result.failures.length === 0;
          const sent = await e.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='sent'").first();
          const r = row({
            layer: "B",
            group,
            question,
            state,
            answer,
            result,
            extra: {
              model_calls: modelCalls,
              outbound_blocked: [...new Set(blocked)],
              qq_sends: 0,
              online_d1_writes: 0,
              outbox_sent_rows: Number(sent?.n || 0),
              secret_leak: leaked,
              dsml_in_answer: dsmlInAnswer,
              tool_trace: redactSecrets(JSON.stringify(trace.slice(-8)), [key]).slice(0, 3000),
              secrets: [key],
            },
          });
          rows.push(r);
          printRow(r);
        } catch (error) {
          const r = row({
            layer: "B",
            group,
            question,
            state,
            answer: "",
            result: { pass: false, failures: ["抛出异常：" + String(error?.message || error)], conflicts: [], asserted: [] },
            extra: { model_calls: modelCalls, outbound_blocked: [...new Set(blocked)], qq_sends: 0, online_d1_writes: 0 },
          });
          rows.push(r);
          printRow(r);
        }
        index++;
      }
    }
    if (LIMIT && index >= LIMIT) break;
  }
}

const report = {
  schema: 1,
  version: "SK-3",
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  mode: MODE,
  head: HEAD,
  card_commit: CARD_COMMIT,
  card_matches_head: CARD_COMMIT === HEAD,
  availability,
  facts_notes: {
    image: FACTS.image.note,
    asr: FACTS.asr.note,
    vision: FACTS.vision.note,
    tts: FACTS.tts.note,
  },
  safety: {
    database: "local node:sqlite fake (test/support.mjs env())",
    online_d1_writes: 0,
    qq_real_sends: 0,
    outbound_policy:
      "A: no network; B: only api.deepseek.com/chat/completions forwarded, every other host counted and answered 503 locally",
  },
  summary: summarize(rows, {
    layer: factsMode || (MODE === "b" ? "B" : "mixed"),
  }),
  rows,
};
const file = writeReport(report);
console.log(
  `\n${report.summary.passed}/${report.summary.total} PASS (${report.summary.pass_rate}%)  head=${HEAD.slice(0, 7)} card=${String(CARD_COMMIT).slice(0, 7)}`,
);
console.log(`report: ${file}`);
if (STRICT && report.summary.failed) process.exit(1);
