import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import feature, { issueAccess, checkAccess, revokeAccess, listAccess, cookieToken, bearerToken, personOf, bases } from "../src/feat/access.ts";

function mkHub(env = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(feature.schema);
  return { env, db, sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } } };
}
const ME = { id: "u1", name: "小明" };

test("a link stands for one person in one group; only its hash is stored", async () => {
  const hub = mkHub(), t = await issueAccess(hub, "g:1", ME);
  assert.match(t, /^[a-f0-9]{40}$/);
  assert.deepEqual(await checkAccess(hub, t), { conv: "g:1", uid: "u1", name: "小明" });
  assert.equal(await checkAccess(hub, "0".repeat(40)), null);
  assert.equal(await checkAccess(hub, "not a token"), null);
  assert.ok(!JSON.stringify(hub.db.prepare("SELECT * FROM access").all()).includes(t));
});
test("the sixth link retires the oldest; revoke stops them all", async () => {
  const hub = mkHub(), ts = [];
  for (let i = 0; i < 6; i++) ts.push(await issueAccess(hub, "g:1", ME, 1000 + i));
  assert.equal(await checkAccess(hub, ts[0]), null);
  assert.ok(await checkAccess(hub, ts[5]));
  assert.equal(listAccess(hub, "g:1").length, 5);
  assert.equal(revokeAccess(hub, "g:1", "u1"), 5);
  assert.equal(await checkAccess(hub, ts[5]), null);
});
test("cookie, bearer, and the link route", async () => {
  const hub = mkHub(), t = await issueAccess(hub, "g:1", ME);
  assert.equal(cookieToken("a=1; tabd=" + t + "; b=2"), t);
  assert.equal(cookieToken("xtabd=" + t), "");
  assert.equal(bearerToken("Bearer " + t), t);
  assert.equal((await personOf(hub, new Request("https://x/x/board", { headers: { cookie: "tabd=" + t } }))).name, "小明");
  assert.equal(await personOf(hub, new Request("https://x/x/board")), null);
  const ok = await feature.open(hub, new Request("https://x/x/board/k/" + t), new URL("https://x/x/board/k/" + t));
  assert.equal(ok.status, 302); assert.equal(ok.headers.get("location"), "/x/board");
  assert.match(ok.headers.get("set-cookie"), new RegExp("^tabd=" + t + "; Path=/x/; .*HttpOnly; Secure"));
  const bad = await feature.open(hub, new Request("https://x/x/board/k/" + "1".repeat(40)), new URL("https://x/x/board/k/" + "1".repeat(40)));
  assert.equal(bad.status, 403);
  assert.equal(await feature.open(hub, new Request("https://x/x/board"), new URL("https://x/x/board")), null);
});
test("the tool gives links for every address and an MCP line; revoke works for the asker only", async () => {
  const hub = mkHub({ PUBLIC_URL: "https://a.example/", PUBLIC_URL_CN: "https://b.example" });
  assert.deepEqual(bases(hub), ["https://a.example", "https://b.example"]);
  const tool = feature.tools({ hub, conv: "g:1", askers: [ME], host: {} })[0];
  const r = await tool.run({ op: "link" });
  assert.equal(r.links.length, 2); assert.match(r.links[1], /^https:\/\/b\.example\/x\/board\/k\/[a-f0-9]{40}$/);
  assert.match(r.mcp.claude_code, /^claude mcp add --scope user --transport http teamagent https:\/\/b\.example\/x\/mcp\/[a-f0-9]{40}$/);
  assert.match(r.mcp.codex, /^codex mcp add teamagent --url https:\/\/b\.example\/x\/mcp\/[a-f0-9]{40}$/);
  assert.equal((await tool.run({ op: "list" })).people.length, 1);
  assert.equal((await tool.run({ op: "revoke" })).revoked, 1);
  assert.equal((await feature.tools({ hub, conv: "g:1", askers: [], host: {} })[0].run({ op: "link" })).ok, false);
});
