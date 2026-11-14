// The control surface. The Worker checks the admin token and forwards the request here.
import type { Hub } from "./hub.ts";
import { displayName } from "./core.ts";
import { checkHealth } from "./health.ts";
import { SYD, clip, fmtFull } from "./util.ts";

export async function route(hub: Hub, req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const json = (v: any, status = 200) => new Response(JSON.stringify(v, null, 1), { status, headers: { "Content-Type": "application/json" } });
  const conv = String(body.conv || url.searchParams.get("conv") || hub.get("main") || "");
  const count = (q: string, ...b: any[]) => Number(hub.sql.exec(q, ...b).toArray()[0].n);
  const limit = Number(url.searchParams.get("n") || 30);

  if (path === "/tick" || path === "/admin/restart") {
    // A deploy does not replace an object that is holding a live connection, so it steps aside itself
    // when the Worker (which always runs the newest version) reports a different one.
    const want = url.searchParams.get("build");
    if (path === "/admin/restart" && url.searchParams.get("force")) {   // testing recovery: cut running work off
      hub.running.clear(); hub.restartSince = 1; hub.restartWanted = "forced"; hub.maybeRestart();
      return json({ ok: true, forced: true });
    }
    if (path === "/admin/restart" || (want && want !== hub.build())) {
      const waiting = hub.wantRestart("version " + (want || "manual"));
      if (waiting) return json({ ok: true, build: hub.build(), restart: "after " + waiting + " running turn(s) or job(s)" });
    }
    await hub.tick();
    return json({ ok: true, build: hub.build() });
  }
  if (path === "/event") { await hub.onEvent(String(body.t), body.d); return json({ op: 12, d: 0 }); }
  if (path === "/admin/status") {
    const g = hub.gateway;
    return json({
      build: hub.build().slice(0, 8), deployed: hub.env.VERSION?.timestamp || "",
      gateway: { on: hub.on("gateway"), connected: g.connected, lastAckAgoMs: g.lastAck ? Date.now() - g.lastAck : null, session: !!g.session, ready: hub.get("gw:ready"), error: g.error },
      main: hub.get("main"), messages: count("SELECT COUNT(*) n FROM msg"), pending: count("SELECT COUNT(*) n FROM pending"),
      notes: count("SELECT COUNT(*) n FROM note"), schedules: hub.sql.exec("SELECT id,conv,spec,task,next,active FROM sched WHERE active=1").toArray(),
      jobs: { running: [...hub.jobs.entries()].map(([id, j]) => ({ id, ...j })), restartWanted: hub.restartWanted },
      trusted: hub.edit.trusted(conv).map(m => m.name),
      memoryChars: (hub.get("memory:" + conv) || "").length, reflectDay: hub.get("reflect:day"),
      last24h: hub.sql.exec("SELECT kind, COUNT(*) n, CAST(AVG(ms) AS INT) avg_ms, MAX(ms) max_ms, SUM(in_tok) in_tok, SUM(cached) cached, SUM(out_tok) out_tok FROM turn WHERE ts>? GROUP BY kind", Date.now() - 86400000).toArray(),
    });
  }
  if (path === "/admin/gateway") {
    hub.set("flag:gateway", body.on ? "1" : "0");
    if (body.reset) hub.gateway.forget();
    await hub.tick();
    return json({ on: hub.on("gateway"), connected: hub.gateway.connected, error: hub.gateway.error });
  }
  if (path === "/admin/import") {
    let n = 0;
    for (const r of body.rows || []) n += hub.insert(conv, r) ? 1 : 0;
    if (typeof body.memory === "string") hub.set("memory:" + conv, body.memory);
    if (body.main) hub.set("main", conv);
    if (body.cursorToEnd) hub.set("cursor:" + conv, String(hub.sql.exec("SELECT MAX(seq) n FROM msg WHERE conv=?", conv).toArray()[0].n || 0));
    return json({ inserted: n });
  }
  if (path === "/admin/dry") {
    // A private test conversation: same brain, memory and settings as the real group, nothing goes to QQ.
    const test = "t:" + (body.room || "lab");
    if (body.reset) { hub.sql.exec("DELETE FROM msg WHERE conv=?", test); hub.set("cursor:" + test, "0"); }
    if (body.seedFrom && !count("SELECT COUNT(*) n FROM msg WHERE conv=?", test)) {
      for (const r of hub.recent(body.seedFrom, 40)) hub.insert(test, { ...r, id: "seed:" + r.id });
      hub.set("cursor:" + test, String(hub.sql.exec("SELECT MAX(seq) n FROM msg WHERE conv=?", test).toArray()[0].n || 0));
    }
    hub.insert(test, { id: "dry:" + crypto.randomUUID(), role: "user", sender: body.sender || "tester", name: body.name || "测试员", text: String(body.text || ""), ts: Date.now(), mentioned: body.mentioned !== false, meta: body.meta });
    const res = await hub.runConv(test);
    return json(res || { error: "no turn" });
  }
  if (path === "/admin/reflect") return json(await hub.reflectConv(conv, !!body.all));
  if (path === "/admin/memory") {
    if (req.method === "POST" && typeof body.memory === "string") { hub.set("memory:prev:" + conv, hub.get("memory:" + conv) || ""); hub.set("memory:" + conv, body.memory); }
    return json({ conv, memory: hub.get("memory:" + conv) || "", notes: hub.notes(conv), days: hub.sql.exec("SELECT date,summary FROM day WHERE conv=? ORDER BY date DESC LIMIT 7", conv).toArray() });
  }
  if (path === "/admin/turns") return json(hub.sql.exec("SELECT * FROM turn ORDER BY id DESC LIMIT ?", limit).toArray());
  if (path === "/admin/toolruns") {
    const name = url.searchParams.get("name");
    return json(name ? hub.sql.exec("SELECT * FROM toolrun WHERE name=? ORDER BY id DESC LIMIT ?", name, limit).toArray() : hub.sql.exec("SELECT * FROM toolrun ORDER BY id DESC LIMIT ?", limit).toArray());
  }
  if (path === "/admin/jobs") {
    if (body.cancel) return json({ ok: hub.cancelJob(Number(body.cancel), conv) });
    return json(hub.sql.exec("SELECT * FROM job ORDER BY id DESC LIMIT ?", limit).toArray());
  }
  if (path === "/admin/recent") return json(hub.recent(conv, limit).map(r => ({ seq: r.seq, t: fmtFull(r.ts, SYD), who: r.role === "bot" ? "BOT" : displayName(r), text: clip(r.text, 300), at: r.mentioned })));
  if (path === "/admin/sched") {
    if (body.cancel) { hub.sql.exec("UPDATE sched SET active=0 WHERE id=?", body.cancel); return json({ ok: true }); }
    if (body.spec && body.task) return json(hub.addSchedule(conv, body.spec, String(body.task)));
    return json(hub.sql.exec("SELECT * FROM sched WHERE active=1 ORDER BY next").toArray());
  }
  if (path === "/admin/ledger") {
    const h = hub.tools(conv).find(t => t.name === "ledger")!;
    for (const [name, amount] of Object.entries(body.set || {})) await h.run({ op: "set", name, amount: Number(amount), note: "初始化" });
    return json(await h.run({ op: "list" }));
  }
  if (path === "/admin/usage") return json(await hub.accounts.usage(Number(url.searchParams.get("days") || 3)));
  if (path === "/admin/health") return json(await checkHealth(hub));
  if (path === "/admin/trust") return json(body.name ? hub.edit.setTrusted(conv, String(body.name), body.on !== false) : { trusted: hub.edit.trusted(conv).map(m => m.name) });
  if (path === "/admin/changes") {
    // A maintainer closes a code proposal: status "done" or "declined", with a line the bot can relay.
    if (body.id && body.status) hub.sql.exec("UPDATE change SET status=?, reason=reason || ? WHERE id=? AND kind='code'", String(body.status), body.note ? "\n【处理结果】" + String(body.note) : "", Number(body.id));
    return json(hub.sql.exec("SELECT * FROM change ORDER BY id DESC LIMIT ?", limit).toArray());
  }
  if (path === "/admin/img") {
    if (body.delete) { hub.store.removeImage(Number(body.delete)); return json({ ok: true }); }
    if (body.id && typeof body.note === "string") { hub.sql.exec("UPDATE img SET note=? WHERE id=?", body.note, Number(body.id)); return json({ ok: true }); }
    if (url.searchParams.get("stickers")) return json(hub.sql.exec("SELECT id,name,note FROM img WHERE conv=? AND name LIKE 'sticker:%' ORDER BY name", conv).toArray());
    if (body.name && body.url) {
      const got = await hub.fetchBytes(String(body.url), 8 * 1024 * 1024);
      if (!got) return json({ error: "fetch failed" }, 400);
      const id = await hub.store.putImage(conv, got.bytes, got.mime || "image/png", String(body.name).startsWith("sticker:") ? "表情包" : "参考图", { name: String(body.name) });
      return json({ ok: !!id, bytes: got.bytes.length });
    }
    const id = url.searchParams.get("id");
    if (!id) return json(hub.sql.exec("SELECT id,conv,ts,mime,COALESCE(size,length(data)) bytes,r2,src,note,name FROM img ORDER BY id DESC LIMIT ?", limit).toArray());
    const row = hub.sql.exec("SELECT * FROM img WHERE id=?", Number(id)).toArray()[0] as any, bytes = await hub.store.bytes(row);
    if (url.searchParams.get("made")) return json(row?.made ? JSON.parse(String(row.made)) : null);
    return bytes ? new Response(bytes, { headers: { "Content-Type": String(row.mime) } }) : json({ error: "no such image" }, 404);
  }
  if (path === "/admin/cookie") {
    if (typeof body.cookie === "string" && body.site) hub.set("cookie:" + body.site, body.cookie);
    return json(hub.sql.exec("SELECT k, length(v) n FROM kv WHERE k LIKE 'cookie:%'").toArray());
  }
  if (path === "/admin/tool") {
    // Run one tool by hand, as the given conversation would.
    const tool = hub.tools(conv).find(t => t.name === body.name);
    if (!tool) return json({ error: "no such tool" }, 404);
    const started = Date.now();
    try { const result = await tool.run(body.args || {}); if (result?._images) result._images = result._images.length + " image(s)"; return json({ ms: Date.now() - started, result }); }
    catch (e: any) { return json({ ms: Date.now() - started, error: clip(e?.message || String(e), 400) }); }
  }
  if (path === "/admin/probe") {
    // Debug aid: what a URL looks like when fetched from Cloudflare.
    const r = await fetch(String(body.url), { method: body.method || "GET", headers: body.headers || {}, body: body.body, redirect: body.redirect || "follow", signal: AbortSignal.timeout(25000) });
    const buf = new Uint8Array(await r.arrayBuffer());
    const text = new TextDecoder(body.charset || "utf-8").decode(buf.slice(0, Number(body.max) || 1500));
    return json({ status: r.status, url: r.url, type: r.headers.get("content-type"), location: r.headers.get("location"), bytes: buf.length, text });
  }
  if (path === "/admin/task") {
    if (body.wait) return json({ ran: await hub.runTask(conv, String(body.task)) });
    hub.ctx.waitUntil(hub.runTask(conv, String(body.task)));
    return json({ started: true });
  }
  if (path === "/admin/set") { hub.set(String(body.k), String(body.v)); return json({ ok: true }); }
  return json({ error: "not found" }, 404);
}
