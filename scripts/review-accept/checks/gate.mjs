// VD-GATE / VD-R-MIG / VD-D0: the repository gate, migration registration and
// the D-0 evidence review. The gate runs the real check/test commands unless
// it is already running inside `node --test`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { assert, equal, includes, paths, runCommand, tail, readJson } from "../harness.mjs";

const REVIEW_TABLES = [
  "turn_tools", "turn_offers", "review_runs", "review_cursors", "review_snapshots", "review_traces",
  "review_judgments", "review_budget", "review_findings", "review_rejects", "review_consumed",
  "capability_gaps", "behavior_rules", "review_memory_candidates", "promises", "review_probes",
];

function applyTwice(label, { schema = false } = {}) {
  const raw = new DatabaseSync(":memory:");
  try {
    if (schema) raw.exec(readFileSync("schema.sql", "utf8"));
    const before = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
    const sql = readFileSync("migrations/0008_review.sql", "utf8");
    raw.exec(sql);
    const once = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
    raw.exec(sql);
    const twice = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
    equal(twice, once, `${label}: second execution adds no table`);
    if (!schema) equal(once - before, 16, `${label}: 0008 creates 16 tables`);
    for (const table of REVIEW_TABLES) {
      assert(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `${label}: missing ${table}`);
    }
    return `${label}: ${before}→${once}→${twice} tables, 16 review tables present`;
  } finally {
    raw.close();
  }
}

const nested = process.env.REVIEW_ACCEPT_IN_TEST === "1" || Boolean(process.env.NODE_TEST_CONTEXT);

export async function vdGate() {
  const evidence = [];
  let suite = "suite 由调用方执行（嵌套 node --test）";
  const check = runCommand("npm", ["run", "check"], { timeout: 240_000 });
  assert(check.ok, `npm run check failed (exit ${check.status}):\n${tail(check.stderr || check.stdout, 30)}`);
  evidence.push("npm run check: 0 error");
  if (nested) {
    evidence.push("npm test: 由调用方 node --test 执行（嵌套运行时不再递归）");
  } else {
    const test = runCommand("npm", ["test"], { timeout: 600_000 });
    assert(test.ok, `npm test failed (exit ${test.status}):\n${tail(test.stderr || test.stdout, 40)}`);
    const output = `${test.stdout}\n${test.stderr}`;
    const summary = (output.match(/^ℹ (tests|pass|fail|skipped) \d+.*$/gm) || []).join(" | ");
    suite = summary || "test 全绿";
    evidence.push(`npm test: ${suite}`);
  }
  evidence.push(applyTwice("empty db"));
  evidence.push(applyTwice("schema.sql db", { schema: true }));
  return { detail: `check 通过；${suite}；0008 在空库与 schema 库各跑两次无报错`, evidence };
}

export async function vdRMig() {
  const migrate = readFileSync("scripts/migrate.mjs", "utf8");
  includes(migrate, "migrations/0008_review.sql", "migrate.mjs registers 0008");
  const offenders = [];
  for (const file of ["scripts/deploy.mjs", "scripts/migrate.mjs", "README.md"]) {
    if (!existsSync(file)) continue;
    if (/wrangler\s+d1\s+migrations\s+apply/.test(readFileSync(file, "utf8"))) offenders.push(file);
  }
  equal(offenders, [], "no wrangler d1 migrations apply");
  const evidence = [applyTwice("empty db (migration)"), applyTwice("schema.sql db (migration)", { schema: true })];
  return { detail: "migrate.mjs 含 0008；0008 两种库各跑两次无错；仓库无 wrangler d1 migrations apply（部署执行属 D-11）", evidence };
}

export async function vdD0() {
  const release = paths().release;
  if (!release) return { blocked: true, reason: "release-dir-missing" };
  const note = join(release, "notes/D-0.md");
  if (!existsSync(note)) return { blocked: true, reason: "notes/D-0.md missing" };
  const text = readFileSync(note, "utf8");
  const checks = [
    ["账户计划", /Free|Paid/],
    ["超额行为", /超额|10,000 neurons|neurons/],
    ["令牌权限", /tokens\/verify|令牌/],
    ["cron 配额", /cron|schedule/i],
    ["模型选择/复测", /gpt-oss|模型/],
    ["线上零写入", /线上 D1 查询0、写入0|未部署/],
    ["零群发", /QQ真实发送0次/],
  ];
  const missing = checks.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  equal(missing, [], "D-0 note sections");
  const dir = join(release, "notes/D-0-evidence");
  assert(existsSync(dir), "D-0-evidence directory");
  const files = readdirSync(dir);
  for (const wanted of ["checks.txt", "prompt.txt"]) assert(files.includes(wanted), `D-0 evidence ${wanted}`);
  // Any JSON evidence file must parse.
  let json = 0;
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    readJson(join(dir, file));
    json++;
  }
  assert(json >= 3, "at least three JSON evidence files");
  return {
    detail: `notes/D-0.md 覆盖计划/超额/令牌/cron/模型/零写入/零群发；D-0-evidence ${files.length} 个文件、${json} 个 JSON 可解析`,
    evidence: [note, ...files.slice(0, 3).map((file) => join(dir, file))],
  };
}
