import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseArgs, DEFAULT_SOURCE_ID } from "../scripts/create-daily-push.mjs";

const ROW = {
  id: "sched-digest_daily-" + DEFAULT_SOURCE_ID,
  group_id: "9968A083EE07797A987010E64CD421B9",
  owner: "CBFDDE8B8487BC8C95C6907AA6193E90",
  kind: "digest_daily",
  tz: "Australia/Sydney",
  spec: '{"time":"08:00"}',
  next_run_at: 1794531600000,
  next_run_text: "2026-11-13 08:00（悉尼）",
  source_msg_id: DEFAULT_SOURCE_ID,
  status: "active",
};

function withEnv(values, fn) {
  const old = {};
  for (const [k, v] of Object.entries(values)) {
    old[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(old)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("P1 defaults target the real 01:11 request at 08:00 Sydney and stay dry-run", () => {
  const args = parseArgs([]);
  assert.equal(args.sourceId, DEFAULT_SOURCE_ID);
  assert.equal(args.time, "08:00");
  assert.equal(args.confirm, false);
  assert.throws(() => parseArgs(["--time", "8点"]), /HH:MM/);
  assert.throws(() => parseArgs(["--bogus"]), /未知参数/);
});

test("P2 dry-run posts dry_run=true and prints the exact row without writing", async () => {
  await withEnv({ TEAM_ADMIN_TOKEN: "owner-secret", TEAM_AGENT_URL: "https://team.example" }, async () => {
    const calls = [];
    const logs = [];
    const body = await main([], {
      fetchImpl: async (url, opt) => {
        calls.push({ url, body: JSON.parse(opt.body), auth: opt.headers.Authorization });
        return Response.json({ ok: true, dry_run: true, would_write: true, schedule: ROW });
      },
      log: (line) => logs.push(line),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://team.example/api/admin/daily-push");
    assert.equal(calls[0].body.dry_run, true);
    assert.equal(calls[0].body.source_msg_id, DEFAULT_SOURCE_ID);
    assert.equal(calls[0].body.time, "08:00");
    assert.equal(calls[0].auth, "Bearer owner-secret");
    assert.equal(body.dry_run, true);
    const text = logs.join("\n");
    assert.match(text, /dry-run：将写入 schedules（未写线上 D1）/);
    assert.match(text, /08:00（悉尼）/);
    assert.match(text, /确认写入/);
  });
});

test("P3 --confirm posts dry_run=false and reports the written row", async () => {
  await withEnv({ TEAM_ADMIN_TOKEN: "owner-secret", TEAM_AGENT_URL: "https://team.example" }, async () => {
    let sent;
    const logs = [];
    await main(["--confirm"], {
      fetchImpl: async (_url, opt) => {
        sent = JSON.parse(opt.body);
        return Response.json({ ok: true, dry_run: false, would_write: false, schedule: ROW });
      },
      log: (line) => logs.push(line),
    });
    assert.equal(sent.dry_run, false);
    assert.match(logs.join("\n"), /已写入 schedules/);
  });
});

test("P4 missing owner token fails before any network call", async () => {
  await withEnv(
    { TEAM_ADMIN_TOKEN: null, ADMIN_TOKEN: null, TEAM_AGENT_CONFIG: "/nonexistent/team-config.json" },
    async () => {
      let called = 0;
      await assert.rejects(
        main([], {
          fetchImpl: async () => {
            called++;
            return Response.json({});
          },
          log: () => {},
        }),
        /缺少 owner 令牌/,
      );
      assert.equal(called, 0);
    },
  );
});

test("P5 --help prints usage and never calls the Worker", async () => {
  const logs = [];
  let called = 0;
  const body = await main(["--help"], {
    fetchImpl: async () => {
      called++;
      return Response.json({});
    },
    log: (line) => logs.push(line),
  });
  assert.equal(body.ok, true);
  assert.equal(called, 0);
  assert.match(logs.join("\n"), /用法：node scripts\/create-daily-push\.mjs/);
});
