// L8：把本地回放库里「答应过但没落地」的定时要求列成候选，并可选地回填。
// - 不带参数：只扫描本地回放库、写 backfill-candidates.json；不连 Worker、不写 D1、不发群。
// - --propose：把设计里指定的两条（周报 / 「草」口头禅）写成 review_learnings(proposed)，
//   第二天的晨报会问本人；默认 dry_run。
// - --apply：只对 --only 指定的一条日程候选调 /api/admin/daily-push；默认 dry_run。
// 日程解析器和 S11 词表直接从 src/schedules.ts / src/review/constants.ts 打进来，避免抄一份会漂移。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// 数据目录按当前目录解析：在资料 clone（含 .agent）里跑 no-arg 即可写到约定路径。
const root = process.cwd();
export const DEFAULT_URL = "https://inkboard-team.inkboard-server.workers.dev";
export const DEFAULT_DB = ".agent/releases/V-D-reflection-loop/replay/seed-437.sqlite";
export const DEFAULT_OUT = ".agent/releases/V-D-learning/backfill-candidates.json";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const USAGE = [
  "用法：node scripts/backfill-schedule-requests.mjs [选项]",
  "",
  "默认只扫描本地回放库并写候选 JSON：0 次 Worker 调用、0 行 D1 写入、0 条 QQ 消息。",
  "",
  "  --db <file>       本地回放 SQLite（默认 .agent/releases/V-D-reflection-loop/replay/seed-437.sqlite）",
  "  --out <file>      候选 JSON（默认 .agent/releases/V-D-learning/backfill-candidates.json）",
  "  --propose         把周报 / 「草」两条写成 review_learnings(proposed)，默认 dry-run",
  "  --apply           回填日程；必须配 --only <rid 或完整消息 id>，默认 dry-run",
  "  --only <id>       --apply 的目标候选",
  "  --dedup <key>     --apply 时写入 spec.dedup（TOO 的 8 点日推用 morning-report）",
  "  --ack <text>      --apply 时同批入队 sched-ack 回执",
  "  --confirm         真正写入（不带时一律 dry-run）",
  "  --url <url>       Worker 地址（默认 $TEAM_AGENT_URL 或线上地址）",
  "  --config <file>   本机团队配置（默认 ~/.inkboard-team/config.json，只读 adminToken/url）",
  "  --json            以 JSON 打印结果",
  "  --help            显示本说明",
  "",
  "令牌：TEAM_ADMIN_TOKEN / ADMIN_TOKEN，或 TEAM_ADMIN_TOKEN_FILE 指向的文件，或 --config 的 adminToken；不会打印。",
].join("\n");

export function parseArgs(argv = []) {
  const args = {
    db: "", out: "", url: "", config: "", only: "", dedup: "", ack: "",
    propose: false, apply: false, confirm: false, json: false, help: false,
  };
  const value = (i, name) => {
    const v = argv[i];
    if (v == null || v.startsWith("--")) throw Error(name + " 需要一个值");
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--propose") args.propose = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--db") args.db = value(++i, "--db");
    else if (a.startsWith("--db=")) args.db = a.slice(5);
    else if (a === "--out") args.out = value(++i, "--out");
    else if (a.startsWith("--out=")) args.out = a.slice(6);
    else if (a === "--url") args.url = value(++i, "--url");
    else if (a.startsWith("--url=")) args.url = a.slice(6);
    else if (a === "--config") args.config = value(++i, "--config");
    else if (a.startsWith("--config=")) args.config = a.slice(9);
    else if (a === "--only") args.only = value(++i, "--only");
    else if (a.startsWith("--only=")) args.only = a.slice(7);
    else if (a === "--dedup") args.dedup = value(++i, "--dedup");
    else if (a.startsWith("--dedup=")) args.dedup = a.slice(8);
    else if (a === "--ack") args.ack = value(++i, "--ack");
    else if (a.startsWith("--ack=")) args.ack = a.slice(6);
    else throw Error("未知参数：" + a + "（用 --help 看用法）");
  }
  if (args.propose && args.apply) throw Error("--propose 和 --apply 只能选一个");
  if (args.apply && !args.only) throw Error("--apply 需要 --only <rid 或消息 id>，避免一次误写多条");
  if (args.dedup && !/^[a-z][a-z0-9-]{2,30}$/.test(args.dedup))
    throw Error("--dedup 只能用 3–31 位小写字母、数字和连字符，且以字母开头");
  return args;
}

/** 用 esbuild 把 TS 解析器与 S11 词表打进临时模块；读完立即删，不留临时文件。 */
export async function loadParser({ rootDir = repoRoot } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "teamagent-test-backfill-"));
  const outfile = join(dir, "rules.mjs");
  try {
    await build({
      stdin: {
        contents:
          'export { parseScheduleRequest } from "./src/schedules"; ' +
          'export { SIGNAL_DEFAULTS } from "./src/review/constants";',
        resolveDir: rootDir,
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      outfile,
      logLevel: "silent",
    });
    const mod = await import(pathToFileURL(outfile).href + "?v=" + Date.now());
    if (typeof mod.parseScheduleRequest !== "function" || !mod.SIGNAL_DEFAULTS?.s11?.words)
      throw Error("解析器打包结果缺少 parseScheduleRequest / S11 词表");
    return { parseScheduleRequest: mod.parseScheduleRequest, s11Words: [...mod.SIGNAL_DEFAULTS.s11.words] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readMessages(file) {
  if (!existsSync(file)) throw Error("本地回放库不存在：" + file + "（用 --db 指定）");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
    if (!columns.length) throw Error("回放库没有 messages 表：" + file);
    const mentioned = columns.includes("mentioned") ? "mentioned" : "0 AS mentioned";
    return db
      .prepare(
        `SELECT rowid AS rid,id,group_id,sender,body,ts,${mentioned} FROM messages WHERE body IS NOT NULL AND body<>'' ORDER BY rowid`,
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** 「昨日聊天内容总结」是日推的默认内容，不算自定义 topic；其余才进 spec.topic。 */
export function cleanTopic(topic) {
  const t = String(topic || "").trim();
  if (!t) return "";
  if (/(昨日|昨天).*(总结|摘要)/.test(t)) return "";
  if (/^(昨日|昨天)?的?(聊天|群聊|内容|聊天内容)?(总结|摘要|日报)$/.test(t)) return "";
  return t;
}

export function plainFor(parsed, topic) {
  if (parsed.cadence === "weekly") {
    const days = (Array.isArray(parsed.weekdays) && parsed.weekdays.length ? parsed.weekdays : [0])
      .map((d) => WEEKDAYS[d] ?? String(d))
      .join("、");
    return `每${days} ${parsed.time}（悉尼）发${topic || "上周总结"}`;
  }
  return `每天 ${parsed.time}（悉尼）发${topic || "昨日群聊总结"}`;
}

// 设计 §礼物日早报 指定的两条提案：不自动建，只写成 proposed 让晨报问本人。
// 用原话匹配而不是消息 id，避免导出快照的 id 变体（- 与 _）导致漏掉。
const CURATED = [
  {
    matches: (body) => body.includes("每个星期日是一周的开始"),
    build: () => ({
      kind: "schedule",
      subkind: "weekly",
      params: { time: "08:00", weekdays: [0], topic: "上周总结" },
      plain: "每周日 08:00（悉尼）发上周总结（原话没给时间，08:00 是默认）",
      reason: "设计 §礼物日早报：周报提案，原话没说时间，08:00 是默认值",
    }),
  },
  {
    matches: (body) => body.includes("口头禅") && body.includes("草"),
    build: () => ({
      kind: "rule",
      subkind: "avoid_phrase",
      params: { phrase: "草" },
      plain: "不要再说「草」。",
      reason: "设计 §礼物日早报：口头禅提案；「草」在 outbox 出现过 18 次",
    }),
  },
];

export function scanMessages(rows, { parseScheduleRequest, s11Words }) {
  const candidates = [];
  const proposals = [];
  const seen = new Set();
  for (const row of rows) {
    const body = String(row.body || "");
    const parsed = parseScheduleRequest(body);
    const s11 = s11Words.filter((word) => body.includes(word));
    if (parsed || s11.length) {
      const topic = parsed ? cleanTopic(parsed.topic) : "";
      const suggestion = parsed
        ? {
            kind: "schedule",
            subkind: parsed.cadence,
            params: {
              time: parsed.time,
              ...(Array.isArray(parsed.weekdays) && parsed.weekdays.length ? { weekdays: parsed.weekdays } : {}),
              ...(topic ? { topic } : {}),
            },
            plain: plainFor(parsed, topic),
          }
        : null;
      candidates.push({
        rid: row.rid ?? null,
        source_msg_id: row.id,
        group_id: row.group_id,
        sender: row.sender,
        ts: row.ts,
        mentioned: Number(row.mentioned || 0),
        quote: body,
        s11,
        parse: parsed || null,
        suggestion,
      });
    }
    for (const curated of CURATED) {
      if (!curated.matches(body)) continue;
      const proposal = curated.build();
      const key = proposal.kind + "|" + proposal.subkind + "|" + proposal.plain;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push({
        rid: row.rid ?? null,
        source_msg_id: row.id,
        group_id: row.group_id,
        sender: row.sender,
        ts: row.ts,
        quote: body,
        ...proposal,
      });
    }
  }
  return { candidates, proposals };
}

function localConfig(path) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function resolve(args) {
  const config = localConfig(args.config || join(homedir(), ".inkboard-team", "config.json"));
  const url = String(args.url || process.env.TEAM_AGENT_URL || config.url || DEFAULT_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw Error("Worker 地址要以 http(s):// 开头");
  const fromFile = process.env.TEAM_ADMIN_TOKEN_FILE
    ? readFileSync(process.env.TEAM_ADMIN_TOKEN_FILE, "utf8").trim()
    : "";
  const token = String(
    process.env.TEAM_ADMIN_TOKEN || process.env.ADMIN_TOKEN || fromFile || config.adminToken || "",
  );
  if (!token)
    throw Error(
      "缺少 owner 令牌：设置 TEAM_ADMIN_TOKEN、TEAM_ADMIN_TOKEN_FILE，或在 --config 指向的本机团队配置里提供 adminToken",
    );
  return { url, token };
}

async function post(fetchImpl, url, token, path, payload) {
  const response = await fetchImpl(url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw Error("Worker 返回的不是 JSON（HTTP " + response.status + "）");
  }
  if (!response.ok || !body.ok)
    throw Error("请求失败（HTTP " + response.status + "）：" + (body.error || "未知错误"));
  return body;
}

export async function main(
  argv = process.argv.slice(2),
  { fetchImpl = globalThis.fetch, log = console.log, dbPath, outPath } = {},
) {
  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return { ok: true, dry_run: true, writes: 0 };
  }
  const dbFile = dbPath || args.db || process.env.TEAM_REPLAY_DB || join(root, DEFAULT_DB);
  const out = outPath || args.out || process.env.TEAM_BACKFILL_OUT || join(root, DEFAULT_OUT);
  const { parseScheduleRequest, s11Words } = await loadParser();
  const rows = readMessages(dbFile);
  const { candidates, proposals } = scanMessages(rows, { parseScheduleRequest, s11Words });
  const doc = {
    generated_at: new Date().toISOString(),
    db: dbFile,
    scanned: rows.length,
    candidates,
    proposals,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  log(`扫描 ${rows.length} 条消息：候选 ${candidates.length} 条，提案 ${proposals.length} 条；写入 ${out}`);
  log("本轮 D1 写入 0、QQ 发送 0。");
  if (!args.propose && !args.apply)
    return { ok: true, dry_run: true, writes: 0, out, scanned: rows.length, candidates, proposals };

  let auth = null;
  const credentials = () => (auth ??= resolve(args));
  const results = [];
  let writes = 0;
  if (args.propose) {
    for (const proposal of proposals) {
      const payload = {
        source_msg_id: proposal.source_msg_id,
        kind: proposal.kind,
        subkind: proposal.subkind,
        params: proposal.params,
        plain: proposal.plain,
        dry_run: !args.confirm,
      };
      const { url, token } = credentials();
      const body = await post(fetchImpl, url, token, "/api/admin/learning-backfill", payload);
      if (args.confirm) writes++;
      results.push({
        target: proposal.source_msg_id,
        subkind: proposal.subkind,
        ok: true,
        dry_run: !args.confirm,
        learning: body.learning?.id || null,
      });
      log(
        `提案 ${proposal.subkind} ← ${proposal.rid ?? proposal.source_msg_id}：` +
          (args.confirm ? "已写入 review_learnings" : "dry-run 可写"),
      );
    }
  }
  if (args.apply) {
    const matched = candidates.filter(
      (candidate) => String(candidate.rid) === args.only || candidate.source_msg_id === args.only,
    );
    if (!matched.length) throw Error("--only 没有匹配的候选：" + args.only);
    if (matched.length > 1) throw Error("--only 匹配到多条，请用完整 source_msg_id：" + args.only);
    const candidate = matched[0];
    if (!candidate.suggestion || candidate.suggestion.kind !== "schedule")
      throw Error("--only 指向的不是日程候选");
    const payload = {
      source_msg_id: candidate.source_msg_id,
      time: candidate.suggestion.params.time,
      dry_run: !args.confirm,
      request_quote: String(candidate.quote).replace(/<@!?[^>]+>/g, "").trim().slice(0, 200),
      ...(args.dedup ? { dedup: args.dedup } : {}),
      ...(args.ack ? { ack: args.ack } : {}),
    };
    const { url, token } = credentials();
    const body = await post(fetchImpl, url, token, "/api/admin/daily-push", payload);
    if (args.confirm) writes++;
    results.push({
      target: candidate.source_msg_id,
      ok: true,
      dry_run: !args.confirm,
      schedule: body.schedule?.id || null,
      ack: body.ack || null,
    });
    log(
      `日程 ${candidate.suggestion.plain}：` +
        (args.confirm ? "已写入 schedules" : "dry-run 可写"),
    );
  }
  const result = { ok: true, dry_run: !args.confirm, writes, out, results };
  if (args.json) log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
