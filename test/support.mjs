import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const output = ".wrangler/test-worker-" + process.pid + ".mjs";
// Behavior fixtures keep the documented high/max and Sydney scenarios stable.
// Valid production parameter changes are checked separately in config.test.mjs.
const fixture = JSON.parse(
  readFileSync(new URL("../config/team.json", import.meta.url), "utf8"),
);
fixture.model.name = "deepseek-flash";
fixture.model.quick_effort = "high";
fixture.model.important_effort = "max";
fixture.model.effort_by_kind = {
  voice: "high",
  participation: "high",
  research: "high",
  memory: "max",
  code: "max",
  vision: "none",
};
fixture.rhythm = { ...fixture.rhythm, mention: 0, image: 0, busy: 0, idle: 0 };
fixture.memory = {
  timezone: "Australia/Sydney",
  start_hour: 3,
  end_hour: 6,
  quiet_minutes: 20,
  batches_per_night: 8,
  messages_per_batch: 60,
};
fixture.scout = { enabled: true, hours: [12, 19] };
fixture.repositories = [
  "OmnixSI/NextThought",
  "OmnixSI/NextThought-Website",
  "OmnixSI/WhalePartner",
  "OmnixSI/peiwan-store-platform-blueprint",
  "OmnixSI/TeamAgent",
];
fixture.project_aliases = {
  "OmnixSI/WhalePartner": ["大肥鱼", "大鲸鱼"],
  "OmnixSI/NextThought": ["面试软件"],
  "OmnixSI/TeamAgent": ["群助手"],
};
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: output,
  plugins: [
    {
      name: "stable-team-fixture",
      setup(builder) {
        builder.onLoad({ filter: /config\/team\.json$/ }, () => ({
          contents: JSON.stringify(fixture),
          loader: "json",
        }));
      },
    },
  ],
});
const { default: worker, signature } = await import("../" + output);
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const database = {
    executed: 0,
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) { return statement(values); },
        async first() { database.executed++; return d.prepare(sql).get(...args) || null; },
        async all() { database.executed++; return { results: d.prepare(sql).all(...args) }; },
        async run() { database.executed++; return d.prepare(sql).run(...args); },
      });
      return statement();
    },
    async batch(ss) {
      return Promise.all(ss.map(s => /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? s.all() : s.run()));
    },
  };
  return database;
}
function env() {
  return {
    DB: db(),
    ADMIN_TOKEN: "owner-secret",
    RUNNER_TOKEN: "runner-secret",
    QQ_APP_SECRET: "test-only-secret",
    WORK: { sent: [], async send(body, opts) { this.sent.push({ body, opts }); } },
    DEEPSEEK_API_KEY: "fake",
  };
}
async function req(
  e,
  path,
  body,
  key = "owner-secret",
  method = body ? "POST" : "GET",
) {
  return (e.testWorker || worker).fetch(
    new Request("https://team.example" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    e,
  );
}
async function qq(e, data, type = "GROUP_MESSAGE_CREATE") {
  const raw = JSON.stringify({ op: 0, t: type, d: data });
  const ts = String(Math.floor(Date.now() / 1000));
  return (e.testWorker || worker).fetch(
    new Request("https://team.example/api/qq/events", {
      method: "POST",
      body: raw,
      headers: {
        "x-signature-timestamp": ts,
        "x-signature-ed25519": await signature(e.QQ_APP_SECRET, ts + raw),
      },
    }),
    e,
  );
}
const msg = (id, content, group = "GROUP000001") => ({
  id,
  content,
  group_openid: group,
  timestamp: new Date().toISOString(),
  author: { id: "member1", member_role: "owner", bot: false },
});

export { worker, env, req, qq, msg };

// Build an isolated configuration fixture for tests that exercise real delays.
export async function setupWith(patch) {
  const { createHash } = await import('node:crypto');
  const next = structuredClone(fixture);
  for (const [key, value] of Object.entries(patch))
    next[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...next[key], ...value } : value;
  const tag = createHash('sha256').update(JSON.stringify(patch)).digest('hex').slice(0, 12);
  const outfile = `.wrangler/test-patch-${process.pid}-${tag}.mjs`;
  await build({ entryPoints: ['src/worker.ts'], bundle: true, format: 'esm', platform: 'browser', outfile,
    plugins: [{ name: 'patched-team-fixture', setup(builder) {
      builder.onLoad({ filter: /config\/team\.json$/ }, () => ({ contents: JSON.stringify(next), loader: 'json' }));
    } }],
  });
  const module = await import('../' + outfile), e = env();
  e.testWorker = module.default;
  return e;
}

export async function runChat(e, id) {
  const runtime = e.testWorker || worker;
  const send = task => runtime.queue({ messages: [{ body: { id: task }, ack() {} }] }, e);
  await send(id);
  for (let round = 0; round < 3; round++) {
    const pending = (await e.DB.prepare("SELECT id FROM jobs WHERE kind='chat' AND status='pending' AND id LIKE 'chat-v-%' ORDER BY created_at").all()).results;
    if (!pending.length) return;
    for (const task of pending) await send(task.id);
  }
}
