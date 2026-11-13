// Static guard and secret scans used by VD-R-GUARD / VD-R-KEY / VD-SAFE.
// Runtime three-night checks belong to D-6; these functions are preflights.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, equal, paths, replayFile, hasReplay, seedDb, rows, rawRows, memoryDb } from "../harness.mjs";

export function staticGuard() {
  const dir = "src/review";
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  const problems = [];
  const allowedFromOutbox = new Set(["trace.ts"]); // read-only trace source
  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const [pattern, why] of [
      [/from\s+["'][^"']*\/?(worker|semantic|tasks|lanes)(\.ts)?["']/, "imports a main-worker module"],
      [/sendGroup/, "sendGroup"],
      [/api\.qq|https?:\/\/[^"'\s]*(qq|gateway)/i, "QQ/gateway URL"],
      [/INSERT\s+(OR\s+\w+\s+)?INTO\s+outbox/i, "writes outbox"],
      [/UPDATE\s+outbox/i, "updates outbox"],
    ]) {
      if (pattern.test(text)) problems.push(`${name}: ${why}`);
    }
    if (!allowedFromOutbox.has(name) && /\bFROM\s+outbox\b/i.test(text)) problems.push(`${name}: reads outbox outside trace.ts`);
  }
  assert(problems.length === 0, `static guard failed: ${problems.join("; ")}`);
  return `${files.length} 个 review 模块无 worker/semantic/tasks/lanes 导入、无群发/出站写`;
}

const SECRET = /sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9._-]{8,}|token=[A-Za-z0-9._-]{8,}|cookie/i;

export function secretScanText() {
  const hits = [];
  const dir = paths().replay;
  for (const name of readdirSync(dir)) {
    if (/\.(sqlite|db)$/.test(name)) continue;
    const text = readFileSync(join(dir, name), "utf8");
    const match = text.match(SECRET);
    if (match) hits.push(`${name}: ${match[0].slice(0, 24)}`);
  }
  const fixtureDir = "test/fixtures/review";
  for (const name of readdirSync(fixtureDir)) {
    if (!/\.(txt|json|sql|md)$/.test(name)) continue;
    const text = readFileSync(join(fixtureDir, name), "utf8");
    const match = text.match(SECRET);
    if (match) hits.push(`fixture/${name}: ${match[0].slice(0, 24)}`);
  }
  equal(hits, [], "secret scan");
  return `${dir} 与 test/fixtures/review 文本文件 0 命中`;
}

export function seedSecretScan() {
  const { raw } = seedDb();
  try {
    const queries = [
      "SELECT body AS text FROM messages",
      "SELECT body AS text FROM outbox",
      "SELECT json AS text FROM message_meta",
      "SELECT json AS text FROM outbox_meta",
      "SELECT value AS text FROM settings",
      "SELECT summary AS text FROM activity",
      "SELECT value AS text FROM facts",
      "SELECT evidence AS text FROM facts",
    ];
    let scanned = 0;
    for (const sql of queries) {
      for (const row of rawRows(raw, sql)) {
        scanned++;
        if (SECRET.test(String(row.text || ""))) throw new Error(`secret-shaped text in ${sql}`);
      }
    }
    return `${scanned} 行种子文本 0 命中`;
  } finally {
    raw.close();
  }
}

export function fakeKeyScan(api) {
  const text = "Authorization: Bearer sk-test-REDACTME0000";
  const redacted = api.reviewRedact(text);
  equal(/sk-test-REDACTME|Bearer/.test(redacted), false, `fake key redaction: ${redacted}`);
  return "假密钥在报告/日志字符串中 0 命中（D-4 脱敏；整晚 401/超时运行属 D-6）";
}
