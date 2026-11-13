import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { env, msg, qq, req, worker } from "./support.mjs";

const outfile = `.wrangler/imagecache-${process.pid}.mjs`;
await build({
  stdin: {
    contents:
      'export {downloadAndStore,getCached,purgeExpired,sourceSha,MAX_IMAGE_CACHE_BYTES,imageCachePurgeJob} from "./src/imagecache";' +
      'export {applyImageOutcomes,describeImage} from "./src/vision";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile,
});
const cache = await import("../" + outfile);

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
]);
const imageUrl = (name) => "https://multimedia.nt.qq.com.cn/" + name + ".png";
const okImage = () =>
  new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
const withFetch = async (fn, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};
const cacheRow = (e, sha) =>
  e.DB.prepare("SELECT * FROM image_cache WHERE sha=?").bind(sha).first();

test("I1 an image message enqueues one background cache job and stores the bytes; a text message adds no cache statements", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });

  const textBefore = e.DB.executed;
  await qq(e, msg("plain-1", "今天吃什么"), "GROUP_MESSAGE_CREATE");
  const textUsed = e.DB.executed - textBefore;
  assert.equal(
    (await e.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='image_cache'").first()).n,
    0,
    "text message must not enqueue a cache job",
  );

  const imageBefore = e.DB.executed;
  await qq(
    e,
    {
      ...msg("image-1", "看这张图"),
      attachments: [
        { content_type: "image/png", url: imageUrl("one"), width: 640, height: 480, size: 900000 },
      ],
    },
    "GROUP_MESSAGE_CREATE",
  );
  const imageUsed = e.DB.executed - imageBefore;
  assert.equal(imageUsed, textUsed + 1, "an image message adds exactly one statement (the cache job)");

  const job = await e.DB.prepare("SELECT * FROM jobs WHERE kind='image_cache'").first();
  assert.equal(job.id, "image-cache-image-1");
  assert.equal(job.status, "pending");
  assert.equal(JSON.parse(job.payload).images.length, 1);

  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return okImage();
    },
    () => worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e),
  );
  assert.equal(calls, 1);
  const sha = await cache.sourceSha(imageUrl("one"));
  const row = await cacheRow(e, sha);
  assert.ok(row, "cached row");
  assert.equal(row.group_id, "GROUP000001");
  assert.equal(row.source_msg, "image-1");
  assert.equal(row.source_idx, 0);
  assert.equal(row.mime, "image/png");
  assert.equal(row.bytes, PNG.byteLength);
  assert.ok(row.expires_at > Date.now());
  assert.deepEqual(new Uint8Array(row.data), PNG);
  assert.equal((await e.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(job.id).first()).status, "done");
});

test("I2 URLs outside the QQ image whitelist are denied without a request and recorded as skipped", async () => {
  const e = env();
  let calls = 0;
  const result = await withFetch(
    async () => {
      calls++;
      return okImage();
    },
    () =>
      cache.downloadAndStore(e, {
        url: "https://example.com/evil.png",
        groupId: "GROUP000001",
        messageId: "blocked-1",
        idx: 0,
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "denied");
  assert.equal(calls, 0, "blocked URLs must not be requested");
  const sha = await cache.sourceSha("https://example.com/evil.png");
  const row = await cacheRow(e, sha);
  assert.ok(row);
  assert.equal(row.data, null);
  assert.equal(row.error_kind, "denied");
  assert.equal(row.bytes, 0);
  assert.match(row.skipped_reason, /安全|白名单/);
  const hit = await cache.getCached(e, sha);
  assert.equal(hit.data, null);
  assert.equal(hit.error_kind, "denied");
});

test("I3 images above the 1.5MB cache cap are not stored and keep the reason", async () => {
  const e = env();
  const result = await withFetch(
    async () =>
      new Response("", {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "2000000" },
      }),
    () =>
      cache.downloadAndStore(e, {
        url: imageUrl("huge"),
        groupId: "GROUP000001",
        messageId: "huge-1",
        idx: 0,
      }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "too_large");
  const sha = await cache.sourceSha(imageUrl("huge"));
  const row = await cacheRow(e, sha);
  assert.ok(row);
  assert.equal(row.data, null);
  assert.equal(row.error_kind, "too_large");
  assert.equal(row.bytes, 0);
  assert.match(row.skipped_reason, /1\.5MB|大小/);
});

test("I4 #222: a cached image is described after the original URL starts returning 400", async () => {
  const e = env();
  await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('vision:provider','workers')").run();
  const url = imageUrl("expired");
  const stored = await withFetch(async () => okImage(), () =>
    cache.downloadAndStore(e, { url, groupId: "GROUP000001", messageId: "expired-1", idx: 0 }),
  );
  assert.equal(stored.ok, true);
  e.AI = {
    async run() {
      return { response: JSON.stringify({ desc: "一只橘猫", text: "", tags: ["cat"], meme: false }) };
    },
  };
  let hits = 0;
  const note = await withFetch(
    async () => {
      hits++;
      return new Response("expired", { status: 400 });
    },
    () =>
      cache.describeImage(
        e,
        { kind: "image", url },
        "看这张图",
        new AbortController().signal,
      ),
  );
  assert.equal(hits, 0, "a cache hit must not go back to the original URL");
  assert.ok(note);
  assert.equal(note.desc, "一只橘猫");
});

test("I5 expired rows are purged by the shared cron job", async () => {
  const e = env();
  await withFetch(async () => okImage(), () =>
    cache.downloadAndStore(e, { url: imageUrl("keep"), groupId: "GROUP000001", messageId: "keep-1", idx: 0 }),
  );
  await withFetch(async () => okImage(), () =>
    cache.downloadAndStore(e, { url: imageUrl("drop"), groupId: "GROUP000001", messageId: "drop-1", idx: 0 }),
  );
  const dropSha = await cache.sourceSha(imageUrl("drop"));
  await e.DB.prepare("UPDATE image_cache SET expires_at=? WHERE sha=?").bind(Date.now() - 1000, dropSha).run();
  const removed = await cache.purgeExpired(e);
  assert.equal(removed, 1);
  assert.equal(await cacheRow(e, dropSha), null);
  assert.ok(await cacheRow(e, await cache.sourceSha(imageUrl("keep"))));

  await e.DB.prepare(
    "INSERT INTO image_cache(sha,group_id,created_at,expires_at) VALUES('old-direct','G',1,2)",
  ).run();
  await cache.imageCachePurgeJob.run(e, new Date());
  assert.equal(await cacheRow(e, "old-direct"), null);
});

test("I6 the cache is scoped to the group that received the image", async () => {
  const e = env();
  const url = imageUrl("scoped");
  const sha = await cache.sourceSha(url);
  await withFetch(async () => okImage(), () =>
    cache.downloadAndStore(e, { url, groupId: "GROUP-A", messageId: "a-1", idx: 0 }),
  );
  const a = await cache.getCached(e, sha, "GROUP-A");
  assert.ok(a.data);
  assert.equal(await cache.getCached(e, sha, "GROUP-B"), null);
  // A later download in another group must not overwrite or expose the first group's row.
  await withFetch(async () => okImage(), () =>
    cache.downloadAndStore(e, { url, groupId: "GROUP-B", messageId: "b-1", idx: 0 }),
  );
  assert.equal((await cacheRow(e, sha)).group_id, "GROUP-A");
  assert.equal(await cache.getCached(e, sha, "GROUP-B"), null);
  assert.equal(
    (await e.DB.prepare("SELECT COUNT(*) n FROM image_cache WHERE sha=?").bind(sha).first()).n,
    1,
  );
});

test("I7 repeated downloads of the same sha stay one row and never overwrite the stored bytes", async () => {
  const e = env();
  const url = imageUrl("repeat");
  let calls = 0;
  for (let i = 0; i < 2; i++)
    await withFetch(
      async () => {
        calls++;
        return okImage();
      },
      () => cache.downloadAndStore(e, { url, groupId: "GROUP000001", messageId: "repeat-" + i, idx: 0 }),
    );
  assert.equal(calls, 2);
  const sha = await cache.sourceSha(url);
  assert.equal(
    (await e.DB.prepare("SELECT COUNT(*) n FROM image_cache WHERE sha=?").bind(sha).first()).n,
    1,
  );
  const first = await cacheRow(e, sha);
  await withFetch(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }), () =>
    cache.downloadAndStore(e, { url, groupId: "GROUP000001", messageId: "repeat-x", idx: 0 }),
  );
  const again = await cacheRow(e, sha);
  assert.deepEqual(new Uint8Array(again.data), new Uint8Array(first.data));
  // A skipped row may be upgraded once a later download succeeds.
  const upgradeUrl = imageUrl("upgrade");
  await withFetch(async () => new Response("nope", { status: 503 }), () =>
    cache.downloadAndStore(e, { url: upgradeUrl, groupId: "GROUP000001", messageId: "u-1", idx: 0 }),
  );
  const upgradeSha = await cache.sourceSha(upgradeUrl);
  assert.equal((await cacheRow(e, upgradeSha)).data, null);
  await withFetch(async () => okImage(), () =>
    cache.downloadAndStore(e, { url: upgradeUrl, groupId: "GROUP000001", messageId: "u-2", idx: 0 }),
  );
  const upgraded = await cacheRow(e, upgradeSha);
  assert.ok(upgraded.data);
  assert.equal(upgraded.error_kind, null);
});

test("schema and the registered 0044 migration are idempotent", () => {
  const d = new DatabaseSync(":memory:");
  for (let i = 0; i < 2; i++) {
    d.exec(readFileSync("schema.sql", "utf8"));
    d.exec(readFileSync("migrations/0044_image_cache.sql", "utf8"));
  }
  assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='image_cache'").get());
  assert.ok(readFileSync("scripts/migrate.mjs", "utf8").includes("migrations/0044_image_cache.sql"));
});

test("I4b a chat turn reads the prefetched cache instead of the dead URL", async () => {
  const e = env();
  await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('vision:provider','workers')").run();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const url = imageUrl("turn");
  await withFetch(async () => okImage(), () =>
    cache.downloadAndStore(e, { url, groupId: "GROUP000001", messageId: "seed", idx: 0 }),
  );
  e.AI = {
    async run() {
      return { response: JSON.stringify({ desc: "缓存里的橘猫", text: "", tags: ["cat"], meme: false }) };
    },
  };
  await qq(
    e,
    {
      ...msg("turn-image", "看图"),
      attachments: [{ content_type: "image/png", url, width: 640, height: 480 }],
    },
    "GROUP_MESSAGE_CREATE",
  );
  let hits = 0;
  await withFetch(
    async (target) => {
      if (String(target).endsWith(".png")) {
        hits++;
        return new Response("expired", { status: 400 });
      }
      throw Error("unexpected request " + String(target));
    },
    () => worker.queue({ messages: [{ body: { id: "chat-turn-image" }, ack() {} }] }, e),
  );
  assert.equal(hits, 0, "the cached image must be used before any network request");
  const job = await e.DB.prepare("SELECT payload FROM jobs WHERE id='chat-v-turn-image'").first();
  assert.ok(job, "the annotated turn is queued");
  const outcomes = JSON.parse(job.payload).imageOutcomes;
  assert.equal(outcomes[0].status, "ok");
});

test("I3b a skipped record is reported truthfully when the URL is dead at view time", async () => {
  const e = env();
  await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('vision:provider','workers')").run();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const url = imageUrl("skipped");
  const skipped = await withFetch(
    async () => new Response("nope", { status: 503 }),
    () => cache.downloadAndStore(e, { url, groupId: "GROUP000001", messageId: "skipped-seed", idx: 0 }),
  );
  assert.equal(skipped.ok, false);
  await qq(
    e,
    {
      ...msg("skipped-image", "看图"),
      attachments: [{ content_type: "image/png", url, width: 640, height: 480 }],
    },
    "GROUP_MESSAGE_CREATE",
  );
  await withFetch(
    async (target) => {
      if (String(target).endsWith(".png")) return new Response("expired", { status: 400 });
      throw Error("unexpected request " + String(target));
    },
    () => worker.queue({ messages: [{ body: { id: "chat-skipped-image" }, ack() {} }] }, e),
  );
  const job = await e.DB.prepare("SELECT payload FROM jobs WHERE id='chat-v-skipped-image'").first();
  assert.ok(job);
  const notes = new Map();
  cache.applyImageOutcomes(notes, JSON.parse(job.payload).imageOutcomes);
  const text = notes.get("skipped-image")?.[0] || "";
  assert.match(text, /原图已过期且收到时没能保存/);
  assert.match(text, /HTTP 400/);
});
