import test from "node:test";
import assert from "node:assert/strict";
import { worker, env } from "./support.mjs";

const call = (e, path, body, token = "runner-secret") =>
  worker.fetch(new Request("https://team.example" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body || {}),
  }), e);

test("the doc runner route is wired under the runner token only", async () => {
  const e = env();
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)")
    .bind("docread-m1-0-abc", "docread", JSON.stringify({ message_id: "m1", key: "doc:m1:0:abc", filename: "a.pdf", url: "https://multimedia.nt.qq.com.cn/a.pdf" }), Date.now())
    .run();
  const denied = await call(e, "/api/runner/doc/claim", {}, "nope");
  assert.equal(denied.status, 401);
  const res = await call(e, "/api/runner/doc/claim");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.job.id, "docread-m1-0-abc");
  assert.equal(body.job.status, "running");
  assert.ok(body.job.payload.lease);
  const empty = await (await call(e, "/api/runner/doc/claim")).json();
  assert.equal(empty.job, null);
});

test("a stray queue wake cannot finalize a docread job before the runner claims it", async () => {
  const e = env();
  const id = "docread-m2-0-def";
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)")
    .bind(id, "docread", JSON.stringify({ message_id: "m2", key: "doc:m2:0:def", filename: "b.pdf", url: "https://multimedia.nt.qq.com.cn/b.pdf" }), Date.now())
    .run();
  let acked = false;
  await worker.queue({ messages: [{ body: { id }, ack() { acked = true; } }] }, e);
  assert.equal(acked, true);
  const row = await e.DB.prepare("SELECT status,attempts FROM jobs WHERE id=?").bind(id).first();
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  const claimed = await (await call(e, "/api/runner/doc/claim")).json();
  assert.equal(claimed.job.id, id);
});
