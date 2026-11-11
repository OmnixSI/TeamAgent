import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const output = ".wrangler/test-worker-" + process.pid + ".mjs";
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: output,
});
const { default: worker, signature } = await import("../" + output);
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return d.prepare(sql).get(...args) || null;
            },
            async all() {
              return { results: d.prepare(sql).all(...args) };
            },
            async run() {
              return d.prepare(sql).run(...args);
            },
          };
        },
        async all() {
          return { results: d.prepare(sql).all() };
        },
        async first() {
          return d.prepare(sql).get() || null;
        },
      };
    },
    async batch(ss) {
      return Promise.all(ss.map((s) => s.run()));
    },
  };
}
function env() {
  return {
    DB: db(),
    ADMIN_TOKEN: "owner-secret",
    RUNNER_TOKEN: "runner-secret",
    QQ_APP_SECRET: "test-only-secret",
    WORK: { async send() {} },
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
  return worker.fetch(
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
  return worker.fetch(
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
