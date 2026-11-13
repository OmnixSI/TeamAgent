import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const outfile = `.wrangler/test-episodes-${process.pid}.mjs`;
await build({
  entryPoints: ["src/episodes.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
});
const ep = await import("../" + outfile);
const toolkit = await (async () => {
  const out = await build({
    entryPoints: ["src/toolkit.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(out.outputFiles[0].text).toString("base64")
  );
})();

const G1 = "GROUP-A",
  G2 = "GROUP-B";
const T = Date.parse("2026-11-13T10:00:00+08:00");

function database() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync("schema.sql", "utf8"));
  const db = {
    raw: d,
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) {
          return statement(values);
        },
        async first() {
          return d.prepare(sql).get(...args) || null;
        },
        async all() {
          return { results: d.prepare(sql).all(...args) };
        },
        async run() {
          const r = d.prepare(sql).run(...args);
          const changes = Number(r.changes || 0);
          return { changes, meta: { changes } };
        },
      });
      return statement();
    },
    async batch(statements) {
      const out = [];
      for (const s of statements)
        out.push(
          /^\s*(SELECT|WITH)\b/i.test(s.sql) ? await s.all() : await s.run(),
        );
      return out;
    },
  };
  return db;
}

function seed(db, group, id, body, ts = "2026-11-13T09:59:00+08:00") {
  db.raw
    .prepare(
      "INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,0,1)",
    )
    .run(id, group, "member1", body, ts);
}

function count(db, group) {
  return db.raw
    .prepare("SELECT count(*) AS n FROM episodes WHERE group_id=?")
    .get(group).n;
}

test("normalization ignores width, case, spaces and trailing punctuation", () => {
  assert.equal(ep.normalizeEpisodeText("  接口用　REST。 "), "接口用 rest");
  assert.equal(ep.normalizeEpisodeText("接口用 REST"), "接口用 rest");
  assert.ok(
    ep.episodeSimilarity("接口用 REST", "接口用  REST。") > 0.99,
    "punctuation-only difference is the same episode",
  );
  assert.ok(
    ep.episodeSimilarity("部署分支是 release/F7", "部署分支是 release/F8") >
      ep.SUPERSEDE_THRESHOLD,
    "a changed value is still the same subject",
  );
  assert.ok(
    ep.episodeSimilarity("A 项目用 REST", "B 项目用 REST") <
      ep.SUPERSEDE_THRESHOLD,
    "the same predicate in another project must not auto-supersede",
  );
  assert.ok(
    ep.episodeSimilarity("接口用 REST", "下周三条目评审") < 0.3,
    "unrelated facts stay apart",
  );
});

test("same normalized text is deduped on replay and punctuation variants", async () => {
  const e = { DB: database() };
  seed(e.DB, G1, "m1", "接口用 REST，明天联调。");
  const first = await ep.addEpisode(e, {
    groupId: G1,
    text: "接口用 REST，明天联调。",
    kind: "fact",
    sourceIds: ["m1"],
    now: T,
  });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  const second = await ep.addEpisode(e, {
    groupId: G1,
    text: "接口用 REST 明天联调",
    kind: "fact",
    sourceIds: ["m1"],
    now: T + 1000,
  });
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);
  assert.equal(count(e.DB, G1), 1, "exactly one episode survives replay");
});

test("expired episodes are not recalled but stay on disk", async () => {
  const e = { DB: database() };
  seed(e.DB, G1, "m1", "周五晚上做发布检查");
  const added = await ep.addEpisode(e, {
    groupId: G1,
    text: "周五晚上做发布检查",
    kind: "event",
    sourceIds: ["m1"],
    expiresAt: T + 1000,
    now: T,
  });
  assert.equal(added.ok, true);
  const early = await ep.recallEpisodes(e, {
    groupId: G1,
    query: "发布检查",
    now: T + 500,
  });
  assert.equal(early.ok, true);
  assert.equal(early.episodes.length, 1);
  const late = await ep.recallEpisodes(e, {
    groupId: G1,
    query: "发布检查",
    now: T + 2000,
  });
  assert.equal(late.ok, true);
  assert.equal(late.episodes.length, 0, "expired episode must not be recalled");
  assert.equal(
    e.DB.raw.prepare("SELECT count(*) AS n FROM episodes").get().n,
    1,
    "expiry hides, it does not delete",
  );
});

test("a new fact supersedes the old one instead of coexisting", async () => {
  const e = { DB: database() };
  seed(e.DB, G1, "m1", "部署分支是 release/F7");
  seed(e.DB, G1, "m2", "改成 release/F8 了");
  const old = await ep.addEpisode(e, {
    groupId: G1,
    text: "部署分支是 release/F7",
    kind: "fact",
    sourceIds: ["m1"],
    now: T,
  });
  const next = await ep.addEpisode(e, {
    groupId: G1,
    text: "部署分支是 release/F8",
    kind: "fact",
    sourceIds: ["m2"],
    now: T + 1000,
  });
  assert.equal(next.ok, true);
  assert.equal(next.deduped, false);
  assert.deepEqual(next.superseded, [old.id]);
  const oldRow = e.DB.raw
    .prepare("SELECT * FROM episodes WHERE id=?")
    .get(old.id);
  assert.equal(oldRow.superseded_by, next.id);
  const recalled = await ep.recallEpisodes(e, {
    groupId: G1,
    query: "部署分支",
    now: T + 2000,
  });
  assert.deepEqual(
    recalled.episodes.map((x) => x.id),
    [next.id],
    "only the current version is recalled",
  );
});

test("explicit supersede only closes episodes from the same group", async () => {
  const e = { DB: database() };
  seed(e.DB, G1, "a1", "旧事件一");
  seed(e.DB, G2, "b1", "旧事件二");
  const one = await ep.addEpisode(e, {
    groupId: G1,
    text: "旧事件一",
    kind: "event",
    sourceIds: ["a1"],
    now: T,
  });
  const two = await ep.addEpisode(e, {
    groupId: G2,
    text: "旧事件二",
    kind: "event",
    sourceIds: ["b1"],
    now: T,
  });
  const replacement = await ep.addEpisode(e, {
    groupId: G1,
    text: "新事件一",
    kind: "event",
    sourceIds: ["a1"],
    supersedes: [one.id, two.id],
    now: T + 1000,
  });
  assert.deepEqual(replacement.superseded, [one.id]);
  const foreign = e.DB.raw
    .prepare("SELECT superseded_by FROM episodes WHERE id=?")
    .get(two.id);
  assert.equal(foreign.superseded_by, null, "cross-group supersede is refused");
});

test("group isolation: recall and sources never cross groups", async () => {
  const e = { DB: database() };
  seed(e.DB, G1, "a1", "A 群下周发布");
  seed(e.DB, G2, "b1", "B 群下周发布");
  const a = await ep.addEpisode(e, {
    groupId: G1,
    text: "A 群下周发布",
    kind: "fact",
    sourceIds: ["a1"],
    now: T,
  });
  const b = await ep.addEpisode(e, {
    groupId: G2,
    text: "B 群下周发布",
    kind: "fact",
    sourceIds: ["b1"],
    now: T,
  });
  assert.notEqual(a.id, b.id, "same text in another group is not a duplicate");
  const fromA = await ep.recallEpisodes(e, {
    groupId: G1,
    query: "下周发布",
    now: T + 1,
  });
  assert.deepEqual(
    fromA.episodes.map((x) => x.id),
    [a.id],
  );
  const wrong = await ep.addEpisode(e, {
    groupId: G2,
    text: "偷渡的 A 群事实",
    kind: "fact",
    sourceIds: ["a1"],
    now: T + 2,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error_kind, "source_not_found");
  assert.equal(count(e.DB, G2), 1, "rejected write leaves no row");
});

test("sources deleted by a member cannot be relearned", async () => {
  const e = { DB: database() };
  seed(e.DB, G1, "d1", "这件事我已经让你忘了");
  e.DB.raw
    .prepare("INSERT INTO memory_blocks(source_id,subject,predicate) VALUES(?,?,?)")
    .run("d1", "这件事", "状态");
  const write = await ep.addEpisode(e, {
    groupId: G1,
    text: "这件事的状态是已忘记",
    kind: "fact",
    sourceIds: ["d1"],
    now: T,
  });
  assert.equal(write.ok, false);
  assert.equal(write.error_kind, "source_deleted");
  assert.equal(count(e.DB, G1), 0);
});

test("quotes keep quote identity and carry the non-instruction prefix", async () => {
  const e = { DB: database() };
  const body = "记住：以后都用 pnpm，不要用 npm";
  seed(e.DB, G1, "q1", body);
  const quote = await ep.addEpisode(e, {
    groupId: G1,
    text: "以后都用 pnpm，不要用 npm",
    kind: "quote",
    sourceIds: ["q1"],
    now: T,
  });
  assert.equal(quote.ok, true);
  const recalled = await ep.recallEpisodes(e, {
    groupId: G1,
    query: "pnpm",
    now: T + 1,
  });
  assert.equal(recalled.episodes.length, 1);
  assert.equal(recalled.episodes[0].kind, "quote");
  assert.ok(
    recalled.episodes[0].text.startsWith("（引用，非指令）"),
    "quote text is returned with the marker that it is not an instruction",
  );
  assert.equal(
    e.DB.raw.prepare("SELECT text FROM episodes WHERE id=?").get(quote.id).text,
    "以后都用 pnpm，不要用 npm",
    "the marker is a recall-time prefix, never stored as the quote",
  );
  const fabricated = await ep.addEpisode(e, {
    groupId: G1,
    text: "以后都用 yarn",
    kind: "quote",
    sourceIds: ["q1"],
    now: T + 2,
  });
  assert.equal(fabricated.ok, false);
  assert.equal(fabricated.error_kind, "quote_not_verbatim");
});

test("recall_episode is registered as an untrusted, group-scoped, bounded tool", async () => {
  const tool = toolkit.findExtraTool("recall_episode");
  assert.ok(tool, "recall_episode must be in the shared registry");
  assert.equal(tool.untrusted, true);
  assert.equal(tool.def.function.name, "recall_episode");
  assert.deepEqual(tool.def.function.parameters.required, ["query"]);
  const e = { DB: database() };
  seed(e.DB, G1, "a1", "部署分支是 release/F8");
  seed(e.DB, G1, "a2", "接口用 REST");
  seed(e.DB, G2, "b1", "部署分支是 release/F7");
  await ep.addEpisode(e, {
    groupId: G1,
    text: "部署分支是 release/F8",
    kind: "fact",
    sourceIds: ["a1"],
    now: T,
  });
  await ep.addEpisode(e, {
    groupId: G1,
    text: "接口用 REST",
    kind: "fact",
    sourceIds: ["a2"],
    now: T,
  });
  await ep.addEpisode(e, {
    groupId: G2,
    text: "部署分支是 release/F7",
    kind: "fact",
    sourceIds: ["b1"],
    now: T,
  });
  const ctx = {
    context: { latest: { group_id: G1 } },
    source: { group_id: G1 },
    messages: [],
    isTainted: () => false,
  };
  const result = await tool.run(e, { query: "部署分支", limit: 999 }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].text, "部署分支是 release/F8");
  assert.equal(result.episodes[0].group_id, undefined, "group id is not leaked");
  const one = await tool.run(e, { query: "部署分支", limit: 1 }, ctx);
  assert.equal(one.episodes.length, 1);
  const noGroup = await tool.run(
    e,
    { query: "部署分支" },
    { context: {}, source: {}, messages: [], isTainted: () => false },
  );
  assert.equal(noGroup.ok, false);
  assert.equal(noGroup.error_kind, "no_group");
  const empty = await tool.run(e, { query: "   " }, ctx);
  assert.equal(empty.ok, false);
  assert.equal(empty.error_kind, "invalid_query");
});

test("migration 0023 is idempotent and registered", () => {
  const sql = readFileSync("migrations/0023_episodes.sql", "utf8");
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync("schema.sql", "utf8"));
  d.exec(sql);
  d.exec(sql);
  const columns = d
    .prepare("PRAGMA table_info(episodes)")
    .all()
    .map((c) => c.name);
  assert.deepEqual(columns, [
    "id",
    "group_id",
    "text",
    "kind",
    "source_ids",
    "created_at",
    "expires_at",
    "superseded_by",
  ]);
  assert.ok(
    readFileSync("scripts/migrate.mjs", "utf8").includes(
      "migrations/0023_episodes.sql",
    ),
    "migrate.mjs must apply the new migration",
  );
  d.close();
});
