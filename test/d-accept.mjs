// D 版验收回放器（阶段 1：骨架）
//
// 做的事：
//   1. 用 schema.sql + migrations 在内存 SQLite 建一套假 D1（D0 未合入时按
//      design.md §5.1/§5.2 的 DDL 内联建库）；
//   2. 校验 test/fixtures/d-real.json：线上抽取只有 SELECT、rows_written=0，
//      sender/group_id 已换代号，14 条真实 + 18 条合成 = 32 条验收用例齐全；
//   3. 逐条跑 acceptance.json 的 32 条用例，输出 `PASS/FAIL/SKIP <id> <实际值>`；
//      阶段 1 没有 D 版实现，未接线的一律 SKIP(not-implemented)，不是 FAIL。
//
// 安全边界：
//   - 不读任何 Cloudflare 令牌，不连线上 D1；抽取审计来自夹具里的只读记录；
//   - fetch 只允许 api.deepseek.com/chat/completions（阶段 2 的真实意图回放），
//     余额接口固定 ¥277.56，QQ/Cloudflare/其他域名一律拒绝；
//   - QQ 发送走内存 stub，outbox 只在内存库；结束打印真实发送 0、线上写入 0。
//
// 运行：
//   node test/d-accept.mjs [--acceptance <acceptance.json>] [--json <out.json>]
//   入口：/Users/yanghongming/Projects/.agent/scenarios/D/run.sh
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURE_PATH = join(ROOT, "test/fixtures/d-real.json");
const DEFAULT_ACCEPTANCE = "/Users/yanghongming/Projects/.agent/releases/D/acceptance.json";
const DEEPSEEK_KEY_FILE = "/Users/yanghongming/.inkboard-team/secrets/deepseek-api-key";
const BUILD_PATH = join(ROOT, `.wrangler/d-accept-${process.pid}.mjs`);

const MIGRATIONS = [
  "schema.sql",
  "migrations/0002_plan_authority.sql",
  "migrations/0003_stage_timings.sql",
  "migrations/0004_repo_index.sql",
  "migrations/0008_review.sql",
  "migrations/0009_f6_schedules.sql",
  "migrations/0020_history_idx.sql",
  "migrations/0021_summaries.sql",
  "migrations/0022_profiles.sql",
  "migrations/0023_episodes.sql",
  "migrations/0025_tool_calls.sql",
  "migrations/0026_kb.sql",
  "migrations/0040_openai.sql",
  "migrations/0041_generated_images.sql",
  "migrations/0042_image_gen_log.sql",
  "migrations/0043_image_notes_provider.sql",
  "migrations/0044_image_cache.sql",
  "migrations/0060_ds_usage.sql",
  "migrations/0061_ds_balance.sql",
  "migrations/0070_feature_requests.sql",
  "migrations/0080_learning.sql",
];

// design.md §5.1（D0 的 migrations/0090_records.sql 合入后优先用文件）。
const RECORDS_DDL = `
CREATE TABLE IF NOT EXISTS record_types(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ledger' CHECK(kind IN ('ledger','list','log')),
  schema TEXT NOT NULL DEFAULT '{}',
  visibility_default TEXT NOT NULL DEFAULT 'group' CHECK(visibility_default IN ('group','private')),
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
CREATE TABLE IF NOT EXISTS records(
  id TEXT PRIMARY KEY, type_id TEXT NOT NULL, group_id TEXT NOT NULL,
  creator TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'group' CHECK(visibility IN ('group','private')),
  data TEXT NOT NULL,
  person TEXT GENERATED ALWAYS AS (json_extract(data,'$.person')) STORED,
  title TEXT GENERATED ALWAYS AS (json_extract(data,'$.title')) STORED,
  amount_cents INTEGER GENERATED ALWAYS AS (json_extract(data,'$.amount_cents')) STORED,
  occurred_at INTEGER GENERATED ALWAYS AS (json_extract(data,'$.occurred_at')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  dedup_key TEXT UNIQUE, source_msg_id TEXT, deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_type ON records(type_id,deleted_at,occurred_at);
CREATE INDEX IF NOT EXISTS records_person ON records(type_id,person);
CREATE INDEX IF NOT EXISTS records_group ON records(group_id,created_at);
CREATE TABLE IF NOT EXISTS record_events(
  id TEXT PRIMARY KEY, record_id TEXT, type_id TEXT NOT NULL, group_id TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('define','add','update','delete','restore','export')),
  before TEXT, after TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS record_events_rec ON record_events(record_id,created_at);
CREATE INDEX IF NOT EXISTS record_events_group ON record_events(group_id,created_at);
CREATE TABLE IF NOT EXISTS skills(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('proposed','active','disabled')),
  uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
  source_msg_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
CREATE TABLE IF NOT EXISTS pending_actions(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender TEXT NOT NULL,
  tool TEXT NOT NULL, draft TEXT NOT NULL, missing TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','expired')),
  asked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pending_actions_open ON pending_actions(group_id,sender,status,expires_at);
`;

class Skip extends Error {}

// ---------------------------------------------------------------- 夹具 / 审计
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

function sanitizeFixture(fx) {
  const errors = [];
  const senders = Object.keys(fx.senders || {});
  if (!senders.length || senders.some((s) => !/^U\d+$/.test(s))) errors.push("senders 键必须全是 U1/U2/…");
  if (senders.join(",") !== "U1,U2,U3") errors.push("senders 代号异常: " + senders.join(","));
  for (const m of fx.messages || []) {
    if (!Number.isInteger(m.rid)) errors.push("rid 不是整数");
    if (!m.id || typeof m.id !== "string") errors.push("消息 id 缺失");
    if (!/^U\d+$/.test(m.sender)) errors.push(`rid ${m.rid} sender 未脱敏: ${m.sender}`);
    if (m.group_id !== "G1") errors.push(`rid ${m.rid} group_id 未脱敏: ${m.group_id}`);
    if (typeof m.body !== "string") errors.push(`rid ${m.rid} body 不是字符串`);
    if (/<@[0-9A-F]{10,}>/i.test(m.body)) errors.push(`rid ${m.rid} body 里残留未脱敏 @id`);
    if (/[0-9A-F]{32}/i.test(m.body)) errors.push(`rid ${m.rid} body 里残留 32 位 hex id`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.test(m.ts)) errors.push(`rid ${m.rid} ts 格式异常`);
    if (![0, 1].includes(m.mentioned)) errors.push(`rid ${m.rid} mentioned 异常`);
  }
  const ids = new Set((fx.messages || []).map((m) => m.rid));
  for (const [id, spec] of Object.entries(fx.real || {})) {
    if (!spec.batch_rids?.length) errors.push(`${id} 没有 batch`);
    for (const rid of [...(spec.batch_rids || []), ...(spec.history_rids || [])]) {
      if (!ids.has(rid)) errors.push(`${id} 引用了不存在的 rid ${rid}`);
    }
    if (!ids.has(spec.rid)) errors.push(`${id} 的主 rid ${spec.rid} 不在 messages`);
  }
  for (const [name, spec] of Object.entries(fx.synthetic || {})) {
    if (spec.synthetic !== true) errors.push(`${name} 未标 synthetic:true`);
  }
  const coverage = [...Object.keys(fx.real || {}), ...Object.keys(fx.synthetic || {})];
  if (new Set(coverage).size !== 32) errors.push(`用例覆盖 ${new Set(coverage).size}/32`);
  for (const query of fx.extraction?.queries || []) {
    if (!/^\s*SELECT\b/i.test(query.sql || "")) errors.push(`抽取不是 SELECT: ${query.name}`);
    if (query.mode !== "SELECT") errors.push(`抽取 mode 不是 SELECT: ${query.name}`);
    if (query.rows_written !== 0) errors.push(`抽取写了 ${query.rows_written} 行: ${query.name}`);
    if (query.changed_db !== false) errors.push(`抽取 changed_db: ${query.name}`);
  }
  if (fx.extraction?.rows_written !== 0 || fx.extraction?.changed_db !== false) errors.push("抽取审计汇总不是只读");
  // 结构化字段里不允许出现完整 QQ 号/32 位 hex 发送者 id。
  const structural = JSON.stringify({ senders: fx.senders, real: fx.real, messages: (fx.messages || []).map((m) => [m.rid, m.sender, m.group_id]) });
  if (/[0-9A-F]{32}/.test(structural)) errors.push("结构化字段里残留 32 位 hex id");
  if (/qq:\d{5,}/i.test(structural)) errors.push("结构化字段里残留 QQ 号");
  return errors;
}

function loadAcceptance(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------- 假 D1
async function ensureSchedulesV2(raw) {
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'").get()?.sql || "";
  if (sql.includes("'agent_task'")) return;
  // D0 合入后用它的幂等实现；未合入时内联 design §5.2 的同一批 SQL。
  const d0 = join(ROOT, "scripts/migrate-schedules.mjs");
  if (existsSync(d0)) {
    const { ensureSchedulesV2: ensure } = await import("file://" + d0);
    ensure((statement) => /^\s*SELECT\b/i.test(statement)
      ? [{ results: raw.prepare(statement).all() }]
      : (raw.exec(statement), [{ results: [] }]));
    return;
  }
  raw.exec(`
CREATE TABLE schedules_v2(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('digest_daily','digest_weekly','reminder','mute','agent_task')),
  tz TEXT NOT NULL DEFAULT 'Australia/Sydney', spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled','paused')),
  next_run_at INTEGER, last_run_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
INSERT INTO schedules_v2(id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at)
  SELECT id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_v2 RENAME TO schedules;
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);
CREATE INDEX IF NOT EXISTS schedules_group ON schedules(group_id,status);`);
}

async function buildLocalDb() {
  const raw = new DatabaseSync(":memory:");
  for (const file of MIGRATIONS) raw.exec(readFileSync(join(ROOT, file), "utf8"));
  const d0 = join(ROOT, "migrations/0090_records.sql");
  raw.exec(existsSync(d0) ? readFileSync(d0, "utf8") : RECORDS_DDL);
  await ensureSchedulesV2(raw);
  return raw;
}

function d1(raw) {
  const calls = [];
  const writes = [];
  const DB = {
    raw, calls, writes,
    prepare(sql) {
      const stmt = (args = []) => ({
        sql, args,
        bind(...next) { return stmt(next); },
        async all() { calls.push(sql); return { results: raw.prepare(sql).all(...args) }; },
        async first() { calls.push(sql); return raw.prepare(sql).get(...args) ?? null; },
        async run() {
          calls.push(sql);
          if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) writes.push(sql.slice(0, 120));
          const result = raw.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      });
      return stmt();
    },
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) {
          const sql = String(statement.sql || "");
          out.push(/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql) ? await statement.all() : await statement.run());
        }
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return DB;
}

function makeEnv(raw) {
  const DB = d1(raw);
  const sent = [];
  const e = {
    DB,
    ADMIN_TOKEN: "replay-owner-secret",
    RUNNER_TOKEN: "replay-runner-secret",
    QQ_APP_SECRET: "replay-qq-secret",
    MODEL: "deepseek-flash",
    DEEPSEEK_MODEL: "deepseek-flash",
    DEEPSEEK_API_KEY: "sk-replay-fake",
    DEEPSEEK_INPUT_USD_MICROS: "0.01",
    DEEPSEEK_OUTPUT_USD_MICROS: "0.1",
    DEEPSEEK_DAY_CAP_USD_MICROS: "100000",
    OPENAI_MODEL: "replay-openai-off",
    OPENAI_API_KEY: "sk-replay-openai-off",
    OPENAI_INPUT_USD_MICROS: "0.01",
    OPENAI_OUTPUT_USD_MICROS: "0.1",
    WORK: { sent, async send(body, opts) { sent.push({ body, opts }); } },
  };
  return { e, raw, DB, sent };
}

// ---------------------------------------------------------------- 网络 / 时钟
function installNetworkGuard() {
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN"]) delete process.env[key];
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    seen.push(href);
    let parsed;
    try { parsed = new URL(href); } catch { throw Error("replay network disabled: " + href); }
    if (parsed.host !== "api.deepseek.com") throw Error("replay network disabled: " + href);
    if (parsed.pathname === "/user/balance") {
      // design.md §9：余额接口固定 ¥277.56，不触碰真实账户。
      return Response.json({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "277.56", granted_balance: "0.00", topped_up_balance: "277.56" }],
      });
    }
    if (!readDeepSeekKey()) throw Error("DEEPSEEK_API_KEY 未配置，真实意图回放不可用");
    return realFetch(url, init);
  };
  return seen;
}

function readDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try { return readFileSync(DEEPSEEK_KEY_FILE, "utf8").trim(); } catch { return ""; }
}

async function withFixedNow(now, fn) {
  const real = Date.now;
  Date.now = () => now;
  try { return await fn(); } finally { Date.now = real; }
}

// ---------------------------------------------------------------- D 版实现装载
let apiCache;
async function loadReplayApi() {
  if (apiCache !== undefined) return apiCache;
  const required = ["src/records.ts", "src/actions.ts", "src/schedule-parse.ts", "src/tools/schedule-tools.ts", "src/receipt-guard.ts"];
  const missing = required.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length) {
    apiCache = { api: null, missing };
    return apiCache;
  }
  mkdirSync(dirname(BUILD_PATH), { recursive: true });
  const entry = ['export { agentAnswer } from "./src/semantic";', 'export { enqueueVoice, decodeVoice } from "./src/voice";'];
  for (const [file, source] of [
    ["src/records.ts", 'export * from "./src/records";'],
    ["src/actions.ts", 'export * from "./src/actions";'],
    ["src/schedule-parse.ts", 'export * from "./src/schedule-parse";'],
    ["src/receipt-guard.ts", 'export * from "./src/receipt-guard";'],
    ["src/skills.ts", 'export * from "./src/skills";'],
  ]) if (existsSync(join(ROOT, file))) entry.push(source);
  await build({
    stdin: {
      contents: entry.join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: BUILD_PATH,
    logLevel: "silent",
  });
  const api = await import("file://" + BUILD_PATH + `?${Date.now()}`);
  apiCache = { api, missing: [] };
  return apiCache;
}

// ---------------------------------------------------------------- 32 条用例
// needs 只用于解释 SKIP 的原因；阶段 2 把 run() 接上后由 DB 判定 PASS/FAIL。
const CASES = [
  { id: "RC-01", needs: ["agent"], expect: "outbox +1 且含当天要点；schedules +0" },
  { id: "RC-02", needs: ["agent", "schedule-parse"], expect: "schedules +1 digest_daily 08:00 Sydney，source_msg_id 对；回复含记下了+首次时间" },
  { id: "RC-03", needs: ["agent", "schedules-v2"], expect: "回复命中承诺词时 schedules 必须有 active 行" },
  { id: "RC-04", needs: ["agent", "tasks"], expect: "tasks +1 repo=inbox status=proposal 且回复带任务号，或不建且不说已发布" },
  { id: "RC-05", needs: ["agent", "records"], expect: "record_types +1，records +3（36000/5000/9000 分），回复合计 ¥500" },
  { id: "RC-06", needs: ["agent", "records"], expect: "records +1 TOO +1000 分；TOO=370 合计 510" },
  { id: "RC-06b", needs: ["agent", "records"], expect: "records +1 Souvereign +20000 分；合计 710" },
  { id: "RC-07", needs: ["agent", "schedule-parse"], expect: "第一轮 schedules +0、pending_actions +1、追问一次；补时后 schedules +1、pending done" },
  { id: "RC-08", needs: ["agent", "schedule-parse"], expect: "schedules +1 agent_task tz=Asia/Shanghai time=00:00 steps=[quota]；next_run_at=下一个北京 0 点；回复双时区且无兜底句" },
  { id: "RC-09", needs: ["agent", "records", "schedule-parse"], expect: "schedules +1 steps⊇账本+余额+token；记账工具=已有类型或 feature_requests +1" },
  { id: "RC-10", needs: ["agent", "records"], expect: "冷上下文回复含 370/50/290/710 且调用 records_read" },
  { id: "RC-11", needs: ["agent", "records"], expect: "带上下文回复含 370/50/290/710" },
  { id: "RC-12", needs: ["agent", "schedules-v2"], expect: "schedules +1 kind=mute run_at=now+10min±1min；回复一句确认" },
  { id: "RC-13", needs: ["agent"], expect: "schedules +0、outbox +0" },
  { id: "S-01", needs: ["agent", "schedule-parse"], expect: "agent_task monthly month_days=[1] 09:00 Sydney，next_run_at 下月 1 日" },
  { id: "S-02", needs: ["agent", "schedule-parse"], expect: "kind=reminder run_at=次日 15:00 Sydney，回执含日期" },
  { id: "S-03", needs: ["agent", "schedule-parse"], expect: "digest_weekly weekdays=[1] 09:00 Asia/Shanghai" },
  { id: "S-04", needs: ["agent", "schedule-parse"], expect: "cadence=every every_minutes=30 until=当天 22:00；超上限如实说" },
  { id: "S-05", needs: ["agent", "records"], expect: "第一句只回 quote 旧 50→新 60，records 不变；确认后 UPDATE 且 record_events +1 update" },
  { id: "S-06", needs: ["agent", "records"], expect: "单条软删 deleted_at 非空；清空需 confirm_token，普通成员拒绝" },
  { id: "S-07", needs: ["agent", "records", "jobs"], expect: "CSV 带 BOM ≤500 行；runner 在线 jobs +1 mode=file，离线 ≤50 行文本；下载链接可用" },
  { id: "S-08", needs: ["agent", "records"], expect: "record_types +1 kind=list；records +2；鸡蛋 done；查询只列牛奶" },
  { id: "S-09", needs: ["agent", "skills"], expect: "skills +1 active 只读；第二句 skill_run 回复含账本合计与余额" },
  { id: "S-10", needs: ["agent", "skills"], expect: "skills +0；feature_requests +1 且回复说明做不了+单号" },
  { id: "S-11", needs: ["agent", "actions"], expect: "run_steps 当场返回；jobs +0；数字与 records_read/get_quota 一致" },
  { id: "S-12", needs: ["agent", "run-task"], expect: "jobs +1 id=exec-<msg> mode=exec；回执已排队；claim 后 job-start outbox +1" },
  { id: "S-13", needs: ["agent", "run-task"], expect: "jobs +0；回复说明权限原因并给可用即时动作" },
  { id: "S-14", needs: ["receipt-guard"], expect: "可解析则补建 schedules +1；否则换成如实失败句且不与上一条重复" },
  { id: "S-15", needs: ["agent", "actions"], expect: "agent_task 只执行只读动作；records 不变；run 记 error 或正常只读输出" },
  { id: "S-16", needs: ["agent", "schedules-v2"], expect: "非 owner 非管理员取消被拒；schedules 不变" },
  { id: "S-17", needs: ["agent", "schedules-v2"], expect: "连续失败 9 次后 status=paused；sched-paused:<id> outbox 恰好 1 条" },
  { id: "S-18", needs: ["agent", "records"], expect: "visibility=private；他人汇总不含；本人群里只得到条数+工作台提示" },
];

function capability(name, api) {
  switch (name) {
    case "agent": return !!api?.agentAnswer;
    case "records": return existsSync(join(ROOT, "src/records.ts"));
    case "actions": return existsSync(join(ROOT, "src/actions.ts"));
    case "schedule-parse": return existsSync(join(ROOT, "src/schedule-parse.ts"));
    case "schedules-v2": return existsSync(join(ROOT, "src/tools/schedule-tools.ts"));
    case "receipt-guard": return existsSync(join(ROOT, "src/receipt-guard.ts"));
    case "skills": return existsSync(join(ROOT, "src/skills.ts"));
    case "run-task": return existsSync(join(ROOT, "src/tools/run.ts"));
    case "tasks": return true;
    case "jobs": return true;
    case "outbox": return true;
    default: return false;
  }
}

async function runCase(caseDef, api) {
  const missing = caseDef.needs.filter((need) => !capability(need, api));
  if (missing.length) throw new Skip(`not-implemented: 缺 ${missing.join("/")}`);
  // 阶段 1 到这里说明 D 版实现已合入，但逐条断言仍未接线（阶段 2）。
  throw new Skip("not-implemented: 阶段 2 断言未接线");
}

// ---------------------------------------------------------------- 主流程
function parseArgs(argv) {
  const out = { acceptance: process.env.D_ACCEPTANCE || DEFAULT_ACCEPTANCE, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--acceptance") out.acceptance = argv[++i];
    else if (argv[i] === "--json") out.json = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const failure = [];
  const results = [];
  const started = Date.now();
  const network = installNetworkGuard();

  const sanitizeErrors = sanitizeFixture(fixture);
  if (sanitizeErrors.length) {
    console.log("SANITIZE FAIL " + sanitizeErrors.join("；"));
    process.exitCode = 1;
    return;
  }
  console.log(`SANITIZE PASS messages=${fixture.messages.length} senders=U1..U3 groups=1 extraction=${fixture.extraction.queries.length}/${fixture.extraction.queries.length} SELECT rows_written=0`);

  // 假 D1 自检
  const raw = await buildLocalDb();
  const schedSql = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'").get().sql;
  const tables = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const table of ["messages", "outbox", "schedules", "schedule_runs", "record_types", "records", "record_events", "skills", "pending_actions", "facts", "tasks", "jobs"]) {
    if (!tables.has(table)) failure.push("缺少表 " + table);
  }
  if (!schedSql.includes("'agent_task'") || !schedSql.includes("'paused'")) failure.push("schedules 不是 v2");
  if (failure.length) {
    console.log("HARNESS FAIL " + failure.join("；"));
    process.exitCode = 1;
    return;
  }
  const d0Build = existsSync(join(ROOT, "migrations/0090_records.sql"))
    ? (existsSync(join(ROOT, "scripts/migrate-schedules.mjs")) ? "D0-file+D0-helper" : "D0-file")
    : "inline-design-5.1/5.2";
  console.log(`HARNESS DB PASS tables=${tables.size} schedules=v2(agent_task,paused) build=${d0Build}`);
  console.log(`HARNESS CLOCK PASS fixed-now=${await withFixedNow(1700000000000, () => Date.now())}`);

  const balance = await fetch("https://api.deepseek.com/user/balance").then((r) => r.json());
  const balanceOk = balance?.balance_infos?.[0]?.total_balance === "277.56";
  if (!balanceOk) failure.push("余额 mock 不是 ¥277.56");
  let blocked = false;
  try { await fetch("https://api.sgroup.qq.com/v2/groups/1/messages"); } catch { blocked = true; }
  if (!blocked) failure.push("QQ 域名没有被拦截");
  console.log(`HARNESS NET PASS balance=${balanceOk ? "¥277.56" : "BAD"} qq=blocked external=${network.length} calls`);

  const acceptance = loadAcceptance(args.acceptance);
  let expectedIds = null;
  if (acceptance) {
    expectedIds = acceptance.map((item) => item.id);
    const got = new Set(CASES.map((item) => item.id));
    const missing = expectedIds.filter((id) => !got.has(id));
    const extra = CASES.map((item) => item.id).filter((id) => !expectedIds.includes(id));
    if (missing.length || extra.length) {
      console.log(`HARNESS ACCEPTANCE FAIL missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`HARNESS ACCEPTANCE PASS ${acceptance.length}/32 ids match ${args.acceptance}`);
  } else {
    console.log(`HARNESS ACCEPTANCE SKIP 未找到 ${args.acceptance}，按内置 32 条运行`);
  }

  const loaded = await loadReplayApi();
  if (loaded.api) console.log(`HARNESS API PASS 已装载 D 版实现${loaded.missing.length ? "（缺 " + loaded.missing.join(",") + "）" : ""}`);
  else console.log(`HARNESS API SKIP 未合入: ${loaded.missing.join(",")}`);

  for (const caseDef of CASES) {
    const at = Date.now();
    try {
      const actual = await runCase(caseDef, loaded.api);
      results.push({ id: caseDef.id, status: "PASS", actual, expect: caseDef.expect, ms: Date.now() - at });
      console.log(`PASS ${caseDef.id} ${actual}`);
    } catch (error) {
      if (error instanceof Skip) {
        results.push({ id: caseDef.id, status: "SKIP", actual: error.message, expect: caseDef.expect, ms: Date.now() - at });
        console.log(`SKIP ${caseDef.id} ${error.message}`);
      } else {
        failure.push(`${caseDef.id}: ${error.message}`);
        results.push({ id: caseDef.id, status: "FAIL", actual: error.message, expect: caseDef.expect, ms: Date.now() - at });
        console.log(`FAIL ${caseDef.id} ${error.message}`);
      }
    }
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`SUMMARY total=${results.length} pass=${pass} fail=${fail} skip=${skip} seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
  console.log("SAFETY QQ真实发送 0 次、线上 D1 写入 0 行、Cloudflare 访问 0 次");

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({
      started_at: new Date(started).toISOString(),
      acceptance: args.acceptance,
      fixture: FIXTURE_PATH,
      sanitize: "PASS",
      results,
      safety: { qq_real_sends: 0, online_d1_rows_written: 0, cloudflare_calls: 0 },
    }, null, 2) + "\n");
  }
  if (fail || failure.length) process.exitCode = 1;
}

await main();
if (existsSync(BUILD_PATH)) rmSync(BUILD_PATH, { force: true });
