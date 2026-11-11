import { test } from "node:test";
import assert from "node:assert/strict";
import { worker, env, req } from "./support.mjs";
const bill =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased.";
const check = (
  id = 1,
  name = "check",
  message = null,
  conclusion = "failure",
) => ({
  id,
  name,
  head_sha: String(id).padStart(40, "a"),
  conclusion,
  html_url: "https://github.com/OmnixSI/TeamAgent/actions/runs/" + id,
  evidence: message ? { annotations: [{ message, level: "failure" }] } : {},
});
async function sync(e, checks, repo = "OmnixSI/TeamAgent") {
  const r = await req(
    e,
    "/api/runner/context",
    { repo, context: { checks } },
    "runner-secret",
  );
  assert.equal(r.status, 200, await r.text());
}
async function drain(e) {
  for (const j of (
    await e.DB.prepare(
      "SELECT id FROM jobs WHERE kind='ci_triage' AND status='pending'",
    ).all()
  ).results)
    await worker.queue({ messages: [{ body: { id: j.id }, ack() {} }] }, e);
}
async function setup() {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  return e;
}
async function count(e, table = "outbox") {
  return (await e.DB.prepare("SELECT COUNT(*) AS n FROM " + table).first()).n;
}

test("repeated runs and commits of one unknown failure produce one combined notice and no repeat model work", async () => {
  const e = await setup();
  await sync(e, [check()]);
  assert.equal(await count(e), 0, "no separate pre-alert");
  await drain(e);
  assert.equal(await count(e), 1);
  for (let id = 2; id < 7; id++) {
    await sync(e, [check(id)]);
    await drain(e);
  }
  assert.equal(await count(e), 1);
  assert.equal(await count(e, "jobs"), 1);
  assert.equal(await count(e, "ci_incidents"), 1);
  assert.equal(
    JSON.parse(
      (await e.DB.prepare("SELECT check_json FROM ci_incidents").first())
        .check_json,
    ).id,
    6,
  );
  assert.match(
    (await e.DB.prepare("SELECT body FROM discoveries").first()).body,
    /最新检查/,
  );
});
test("shared organization billing failure is one incident across repositories and jobs; recovery must be verified", async () => {
  const e = await setup(),
    original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("billing facts need no model");
  };
  try {
    await Promise.all([
      sync(e, [check(10, "macos", bill)]),
      sync(e, [check(11, "check", bill)], "OmnixSI/WhalePartner"),
    ]);
    await drain(e);
    assert.equal(await count(e), 1);
    assert.equal(await count(e, "ci_incidents"), 1);
    await sync(e, [check(12, "macos", bill)]);
    await drain(e);
    assert.equal(await count(e), 1);
    await sync(e, [check(13, "macos", null, "success")]);
    assert.equal(
      await count(e),
      1,
      "one repository recovering cannot clear the shared blocker",
    );
    await sync(
      e,
      [check(14, "check", null, "success")],
      "OmnixSI/WhalePartner",
    );
    assert.equal(await count(e), 2);
    await sync(
      e,
      [check(14, "check", null, "success")],
      "OmnixSI/WhalePartner",
    );
    assert.equal(await count(e), 2);
    await sync(e, [check(11, "check", bill)], "OmnixSI/WhalePartner");
    await drain(e);
    assert.equal(
      await count(e),
      2,
      "stale failed check after recovery must be ignored",
    );
    await sync(e, [check(15, "check", bill)], "OmnixSI/WhalePartner");
    await drain(e);
    assert.equal(await count(e), 3, "a genuine new episode may notify once");
  } finally {
    globalThis.fetch = original;
  }
});
test("deployment remembers an already announced billing blocker and retires old queued duplicate alerts", async () => {
  const e = await setup();
  await e.DB.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)")
    .bind(
      "ci-old-triage",
      "GROUP000001",
      null,
      "账户付款或支出限额受限，job未启动。",
      "sent",
      Date.now(),
    )
    .run();
  await e.DB.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)")
    .bind(
      "ci-old-pending",
      "GROUP000001",
      null,
      "repeat",
      "pending",
      Date.now(),
    )
    .run();
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      "old-job",
      "ci_triage",
      JSON.stringify({ repo: "OmnixSI/TeamAgent", check: check() }),
      Date.now(),
    )
    .run();
  await sync(e, [check(100, "check", bill)]);
  await drain(e);
  assert.equal(
    (
      await e.DB.prepare(
        "SELECT status FROM outbox WHERE id='ci-old-pending'",
      ).first()
    ).status,
    "superseded",
  );
  assert.equal(
    (await e.DB.prepare("SELECT status FROM jobs WHERE id='old-job'").first())
      .status,
    "done",
  );
  assert.equal(
    (
      await e.DB.prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'ci2-%'",
      ).first()
    ).n,
    0,
  );
  const incident = await e.DB.prepare("SELECT * FROM ci_incidents").first();
  assert.equal(incident.notified_cycle, incident.cycle);
  await sync(e, [check(101, "check", bill)]);
  await drain(e);
  assert.equal(await count(e), 2);
});
test("new concrete evidence may follow an unknown failure once, and resolved jobs cannot send stale triage", async () => {
  const e = await setup(),
    original = globalThis.fetch;
  await sync(e, [check(1)]);
  await drain(e);
  assert.equal(await count(e), 1);
  globalThis.fetch = async () => {
    throw Error("provider offline");
  };
  try {
    await sync(e, [
      check(2, "check", "TS2307 Cannot find module 'actual-dependency'"),
    ]);
    await drain(e);
    assert.equal(await count(e), 2);
    assert.match(
      (
        await e.DB.prepare(
          "SELECT body FROM outbox ORDER BY created_at DESC LIMIT 1",
        ).first()
      ).body,
      /actual-dependency/,
    );
    await sync(e, [
      check(3, "check", "TS2307 Cannot find module 'actual-dependency'"),
    ]);
    await drain(e);
    assert.equal(await count(e), 2);
    await sync(e, [check(4, "check", null, "success")]);
    assert.equal(await count(e), 3);
    await sync(e, [check(5, "check", "A new actual error")]);
    await sync(e, [check(6, "check", null, "success")]);
    await drain(e);
    assert.equal(
      await count(e),
      3,
      "a failure fixed before triage should not emit stale warning or fake recovery",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("twenty independent checks and their recovery stay inside the free D1 request query budget", async () => {
  const e = await setup();
  let queries = 0;
  const prepare = e.DB.prepare;
  e.DB.prepare = (sql) => {
    queries++;
    return prepare(sql);
  };
  await sync(
    e,
    Array.from({ length: 20 }, (_, i) => check(i + 1, "job-" + i)),
  );
  assert.ok(queries <= 50, "first observation queries: " + queries);
  await drain(e);
  queries = 0;
  await sync(
    e,
    Array.from({ length: 20 }, (_, i) =>
      check(i + 101, "job-" + i, null, "success"),
    ),
  );
  assert.ok(queries <= 50, "recovery queries: " + queries);
  assert.equal(await count(e), 40);
});
