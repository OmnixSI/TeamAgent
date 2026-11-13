// Shared harness for the V-D acceptance runner: paths, SQLite adapters,
// replay loading, trace page memoisation and evidence files.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";

export const ROOT = process.cwd();

function ancestors(start) {
  const out = [];
  let dir = resolve(start);
  for (let i = 0; i < 5; i++) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

let cachedPaths = null;
export function paths() {
  if (cachedPaths) return cachedPaths;
  const releaseCandidates = [
    process.env.REVIEW_RELEASE_DIR,
    ...ancestors(ROOT).map((dir) => join(dir, ".agent/releases/V-D-reflection-loop")),
  ].filter(Boolean);
  const release = releaseCandidates.find(
    (dir) => existsSync(join(dir, "acceptance.json")) || existsSync(join(dir, "replay")),
  ) || null;
  const replay = process.env.REVIEW_REPLAY_DIR
    ? resolve(process.env.REVIEW_REPLAY_DIR)
    : release
      ? join(release, "replay")
      : join(ROOT, "replay");
  cachedPaths = { root: ROOT, release, replay };
  return cachedPaths;
}

export const replayFile = (name) => join(paths().replay, name);
export const hasReplay = () =>
  existsSync(replayFile("seed-437.sqlite")) &&
  existsSync(replayFile("golden.jsonl")) &&
  existsSync(replayFile("negatives.jsonl"));

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
export function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
export function count(db, table, where = "", params = []) {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? " WHERE " + where : ""}`;
  return db.prepare(sql).bind(...params).first().n;
}
export function rows(db, sql, params = []) {
  return db.prepare(sql).bind(...params).all().results;
}
export function rawRows(raw, sql, params = []) {
  return raw.prepare(sql).all(...params);
}

/** D1-shaped adapter over node:sqlite, counting every execution. */
export function wrapDb(raw) {
  const log = [];
  let executed = 0;
  const make = (sql, args = []) => ({
    sql,
    bind(...values) {
      return make(sql, values);
    },
    async first() {
      executed++;
      return raw.prepare(sql).get(...args) ?? null;
    },
    async all() {
      executed++;
      return { results: raw.prepare(sql).all(...args) };
    },
    async run() {
      executed++;
      const info = raw.prepare(sql).run(...args);
      return { meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
    },
  });
  const db = {
    get executed() {
      return executed;
    },
    get log() {
      return log;
    },
    prepare(sql) {
      log.push(sql);
      return make(sql);
    },
    async batch(statements) {
      if (!statements.length) return [];
      executed += statements.length;
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  };
  return db;
}

export function memoryDb({ schema = true, migration = true, fixture = false } = {}) {
  const raw = new DatabaseSync(":memory:");
  if (schema) raw.exec(readFileSync("schema.sql", "utf8"));
  if (migration) raw.exec(readFileSync("migrations/0008_review.sql", "utf8"));
  if (fixture) raw.exec(readFileSync("test/fixtures/review/subset.sql", "utf8"));
  return { raw, db: wrapDb(raw) };
}

export function seedDb() {
  const file = replayFile("seed-437.sqlite");
  if (!existsSync(file)) throw new Error(`replay-data-missing: ${file}`);
  const raw = new DatabaseSync(file, { readOnly: true });
  return { raw, db: wrapDb(raw), file };
}

export function rowidId(raw, table, rowid) {
  const row = raw.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(rowid);
  return row?.id ?? null;
}
export function rowidIds(raw, table, rowids) {
  return rowids.map((rowid) => ({ rowid, id: rowidId(raw, table, rowid) }));
}

const GROUP_SQL = "SELECT group_id, COUNT(*) AS n FROM messages GROUP BY group_id ORDER BY n DESC LIMIT 1";
export function seedGroup(raw) {
  return raw.prepare(GROUP_SQL).get().group_id;
}

let cachedNights = null;
export function simNights() {
  if (cachedNights) return cachedNights;
  const file = replayFile("sim-nights.json");
  if (!existsSync(file)) return null;
  const data = readJson(file);
  const nights = data.nights.map((night, index) => {
    const end = Date.parse(night.utc);
    const next = data.nights[index + 1];
    const start = index === 0 ? end - 86_400_000 : Date.parse(data.nights[index - 1].utc);
    return { ...night, end_ms: end, start_ms: start, window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString() };
  });
  cachedNights = { ...data, nights };
  return cachedNights;
}

let cachedTraceRun = null;
/** Build the three simulated nights once per process. */
export async function traceRun(loadReview, { db = null } = {}) {
  if (cachedTraceRun) return cachedTraceRun;
  const sim = simNights();
  if (!sim) throw new Error(`replay-data-missing: ${replayFile("sim-nights.json")}`);
  const opened = db ? null : seedDb();
  const database = db || opened.db;
  const raw = db ? null : opened.raw;
  const group = raw ? seedGroup(raw) : process.env.REVIEW_GROUP || null;
  if (!group) throw new Error("seed has no message group");
  const pages = [];
  for (const night of sim.nights) {
    pages.push(
      await (await loadReview()).buildTraces(
        { DB: database },
        { group_id: group, window_start: night.window_start, window_end: night.window_end },
      ),
    );
  }
  const traces = pages.flatMap((page) => page.traces);
  cachedTraceRun = { sim, group, pages, traces, raw, db: database };
  return cachedTraceRun;
}

export function findTrace(traces, kind, id) {
  return traces.find((trace) => trace.kind === kind && (trace.inbound?.id === id || trace.replies.some((reply) => reply.outbox_id === id)));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
export function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message}: missing ${JSON.stringify(needle)}`);
}
export function notIncludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) throw new Error(`${message}: unexpectedly contains ${JSON.stringify(needle)}`);
}

export function evidenceDir() {
  const dir = paths().release
    ? join(paths().release, "evidence/D-10b1")
    : join(ROOT, ".wrangler/review-accept-evidence");
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function writeEvidence(name, body) {
  const file = join(evidenceDir(), name);
  writeFileSync(file, body);
  return file;
}
export function cleanupEvidenceTmp() {
  const dir = join(ROOT, ".wrangler");
  for (const name of ["review-accept-tmp"]) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {}
  }
}

export function runCommand(command, args, { timeout = 300_000, cwd = ROOT } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}
export function tail(text, lines = 40) {
  return String(text).trimEnd().split("\n").slice(-lines).join("\n");
}

export function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
