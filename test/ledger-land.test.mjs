// D4 返工 B：账本承诺的确定性补建（非 thinking JSON 抽取 + records_write 内部实现）。
// 只跑本地假 D1 和 mock 的模型；不发 QQ、不写线上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { env } from "./support.mjs";

const outfile = `.wrangler/ledger-land-${process.pid}.mjs`;
await build({
  stdin: {
    contents:
      'export { landLedger, extractLedgerAction } from "./src/ledger-land";' +
      'export { defineRecordType, addRecords } from "./src/records";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);
const GROUP = "GROUP000001";

function recordsSchema(e) {
  for (const statement of readFileSync("migrations/0090_records.sql", "utf8").split(";")) {
    const sql = statement
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (sql) e.DB.prepare(sql).run();
  }
}

const writeCtx = (e) => ({
  e,
  groupId: GROUP,
  actor: { sender: "U1", name: "U1", isAdmin: true },
  sourceMsgId: "seed",
  dedupBase: "seed",
  now: Date.now(),
  names: new Map(),
});

async function fixture() {
  const e = env();
  recordsSchema(e);
  const write = writeCtx(e);
  const { type } = await api.defineRecordType(write, { name: "报销额度", kind: "ledger" });
  await api.addRecords(write, type.id, [
    { person: "TOO", amount: "360" },
    { person: "卡特龙", amount: "50" },
    { person: "Souvereign", amount: "90" },
  ]);
  return e;
}

async function contextFor(e, { id = "m1", body, sender = "U1" } = {}) {
  await e.DB.prepare(
    "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,1)",
  )
    .bind(id, GROUP, sender, body, new Date().toISOString())
    .run();
  const row = { id, group_id: GROUP, sender, body, ts: new Date().toISOString(), mentioned: 1, meta: { direct: true, media: [] } };
  return { latest: row, batch: [row], recent: [row], names: new Map([["U1", "TOO"]]), refs: new Map(), mentioned: true };
}

function stub(body) {
  const old = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body || "{}");
    seen.push(request);
    return Response.json({ choices: [{ message: { content: JSON.stringify(body) } }] });
  };
  return { seen, restore: () => { globalThis.fetch = old; } };
}

const rows = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

test("LB1 我加10 is written as a new ledger row and the receipt is real", async () => {
  const e = await fixture();
  const context = await contextFor(e, { body: "我加10" });
  const s = stub({ op: "add", type: "报销额度", person: "TOO", amount: "10" });
  let landed;
  try {
    landed = await api.landLedger(e, context, [], () => false);
  } finally {
    s.restore();
  }
  assert.ok(landed, "fallback must land");
  assert.equal(landed.family, "record");
  assert.match(landed.say, /370/);
  assert.match(landed.say, /510/);
  assert.equal(s.seen[0].response_format.type, "json_object");
  assert.equal(s.seen[0].thinking.type, "disabled");
  assert.equal(s.seen[0].reasoning_effort, "none");
  const records = await rows(e, "SELECT person,amount_cents FROM records WHERE deleted_at IS NULL");
  assert.equal(records.length, 4);
  assert.equal(records.filter((r) => r.person === "TOO").reduce((n, r) => n + Number(r.amount_cents), 0), 37000);
});

test("LB2 把卡特龙那笔改成60 applies the update after the quote", async () => {
  const e = await fixture();
  const context = await contextFor(e, { body: "把卡特龙那笔改成60" });
  const s = stub({ op: "set", type: "报销额度", person: "卡特龙", amount: "60" });
  let landed;
  try {
    landed = await api.landLedger(e, context, [], () => false);
  } finally {
    s.restore();
  }
  assert.ok(landed);
  assert.match(landed.say, /改好了|60/);
  const row = await e.DB.prepare("SELECT amount_cents FROM records WHERE person='卡特龙' AND deleted_at IS NULL").first();
  assert.equal(Number(row.amount_cents), 6000);
  assert.equal((await rows(e, "SELECT * FROM record_events WHERE action='update'")).length, 1);
});

test("LB3 删掉某人的那笔 soft-deletes exactly one row", async () => {
  const e = await fixture();
  const context = await contextFor(e, { body: "删掉 Souvereign 那笔" });
  const s = stub({ op: "delete", type: "报销额度", person: "Souvereign" });
  let landed;
  try {
    landed = await api.landLedger(e, context, [], () => false);
  } finally {
    s.restore();
  }
  assert.ok(landed);
  assert.match(landed.say, /删好了/);
  assert.equal((await rows(e, "SELECT id FROM records WHERE deleted_at IS NOT NULL")).length, 1);
  assert.equal((await rows(e, "SELECT id FROM records WHERE deleted_at IS NULL")).length, 2);
});

test("LB4 an incomplete extraction writes nothing and returns null", async () => {
  const e = await fixture();
  const context = await contextFor(e, { body: "我加10" });
  const s = stub({ op: "add", type: "报销额度" });
  let landed;
  try {
    landed = await api.landLedger(e, context, [], () => false);
  } finally {
    s.restore();
  }
  assert.equal(landed, null);
  assert.equal((await rows(e, "SELECT id FROM records WHERE deleted_at IS NULL")).length, 3);
});

test("LB6 an extraction without a person defaults to the speaker", async () => {
  const e = await fixture();
  const context = await contextFor(e, { id: "m-noperson", body: "我加10" });
  const s = stub({ op: "add", type: "报销额度", amount: "10" });
  let landed;
  try {
    landed = await api.landLedger(e, context, [], () => false);
  } finally {
    s.restore();
  }
  assert.ok(landed, JSON.stringify(landed));
  const records = await rows(e, "SELECT person,amount_cents FROM records WHERE deleted_at IS NULL");
  assert.equal(records.length, 4);
  assert.equal(records.filter((r) => r.person === "TOO").reduce((n, r) => n + Number(r.amount_cents), 0), 37000);
});

test("LB5 a quoted material turn and a non-addressed message are refused before any write", async () => {
  const e = await fixture();
  const quoted = await contextFor(e, { id: "m-quoted", body: "我加10" });
  quoted.latest.meta = { direct: true, media: [], quoted: { text: "外部资料" } };
  quoted.batch = [quoted.latest];
  const plain = await contextFor(e, { id: "m-plain", body: "我加10" });
  plain.mentioned = false;
  plain.latest.mentioned = 0;
  plain.latest.meta = { direct: false, media: [] };
  plain.batch = [plain.latest];
  for (const context of [quoted, plain]) {
    const s = stub({ op: "add", type: "报销额度", person: "TOO", amount: "10" });
    let landed;
    try {
      landed = await api.landLedger(e, context, [], () => false);
    } finally {
      s.restore();
    }
    assert.equal(landed, null, context.latest.id);
  }
  assert.equal((await rows(e, "SELECT id FROM records WHERE deleted_at IS NULL")).length, 3);
});
