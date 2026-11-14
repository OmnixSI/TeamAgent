// The whole bot lives in one Durable Object: it holds the QQ connection, stores the chat,
// runs turns one conversation at a time, and wakes itself for schedules and nightly memory work.
import { DurableObject } from "cloudflare:workers";
import { displayName, runTurn } from "./core.ts";
import type { Row, TurnResult } from "./core.ts";
import { dsChat } from "./llm.ts";
import { caption, reflect } from "./memory.ts";
import { QQ, parseEvent } from "./qq.ts";
import type { Inbound } from "./qq.ts";
import { buildTools } from "./tools.ts";
import type { Host } from "./tools.ts";
import { BJ, SYD, b64, clip, fmtDate, fmtFull, nextDaily, sleep, zonedToUtc } from "./util.ts";
import type { Env } from "./util.ts";

const INTENTS = (1 << 0) | (1 << 1) | (1 << 30) | (1 << 12) | (1 << 25) | (1 << 26);
const TICK_MS = 20000;
const REPLY_WINDOW_MS = 270000;   // a QQ message can be answered for five minutes
const REPLIES_PER_MESSAGE = 5;

export class Hub extends DurableObject<Env> {
  sql: any;
  qq: QQ;
  ws: WebSocket | null = null;
  beat: any = null;
  lastAck = 0;
  lastSeq: number | null = null;
  session: string | null = null;
  connecting = false;
  gwError = "";
  running = new Set<string>();
  wake = new Map<string, number>();
  firstPending = new Map<string, number>();
  anchorUse = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.qq = new QQ(env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS msg(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, conv TEXT NOT NULL, role TEXT NOT NULL,
        sender TEXT, name TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL, mentioned INTEGER DEFAULT 0, meta TEXT);
      CREATE INDEX IF NOT EXISTS msg_conv ON msg(conv, seq);
      CREATE INDEX IF NOT EXISTS msg_ts ON msg(conv, ts);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS note(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, text TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS day(conv TEXT, date TEXT, summary TEXT, PRIMARY KEY(conv, date));
      CREATE TABLE IF NOT EXISTS sched(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, spec TEXT, task TEXT, next INTEGER, active INTEGER DEFAULT 1, last INTEGER);
      CREATE TABLE IF NOT EXISTS turn(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, kind TEXT, ms INTEGER, first_ms INTEGER,
        calls INTEGER, tools TEXT, in_tok INTEGER, out_tok INTEGER, cached INTEGER, said TEXT, err TEXT);
      CREATE TABLE IF NOT EXISTS ledger(conv TEXT, name TEXT, balance REAL NOT NULL DEFAULT 0, PRIMARY KEY(conv, name));
      CREATE TABLE IF NOT EXISTS ledger_log(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, name TEXT, delta REAL, balance REAL, note TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, kind TEXT, body TEXT, ts INTEGER);
    `);
    const gw = this.get("gw");
    if (gw) { try { const s = JSON.parse(gw); this.session = s.session; this.lastSeq = s.seq; } catch {} }
  }

  // ---------- storage helpers ----------
  get(k: string): string | null { const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray()[0]; return r ? String(r.v) : null; }
  set(k: string, v: string) { this.sql.exec("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v); }
  rowOf = (r: any): Row => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : undefined });
  recent(conv: string, n: number): Row[] {
    return this.sql.exec("SELECT * FROM msg WHERE conv=? ORDER BY seq DESC LIMIT ?", conv, n).toArray().reverse().map(this.rowOf);
  }
  insert(conv: string, r: { id: string; role: string; sender?: string; name?: string; text: string; ts: number; mentioned?: boolean | number; meta?: any }) {
    const out = this.sql.exec(
      "INSERT OR IGNORE INTO msg(id,conv,role,sender,name,text,ts,mentioned,meta) VALUES(?,?,?,?,?,?,?,?,?) RETURNING seq",
      r.id, conv, r.role, r.sender || null, r.name || null, r.text, r.ts, r.mentioned ? 1 : 0, r.meta ? JSON.stringify(r.meta) : null,
    ).toArray()[0];
    return out ? Number(out.seq) : 0;
  }
  on(flag: string) { return this.get("flag:" + flag) === "1"; }

  // ---------- QQ gateway (outbound WebSocket held by this object) ----------
  async connect() {
    if (this.connecting || !this.on("gateway")) return;
    this.connecting = true;
    try {
      this.closeWs();
      const url = await this.qq.gatewayUrl();
      const resp = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws) throw new Error("gateway upgrade failed " + resp.status);
      ws.accept();
      this.ws = ws;
      this.lastAck = Date.now();
      ws.addEventListener("message", ev => { if (ws === this.ws) this.onFrame(ws, ev.data).catch(e => console.log("frame error", e?.message)); });
      ws.addEventListener("close", ev => { if (ws === this.ws) this.onClose(ev.code); });
      ws.addEventListener("error", () => { if (ws === this.ws) this.onClose(0); });
      this.gwError = "";
    } catch (e: any) {
      this.gwError = clip(e?.message || String(e), 200);
      console.log("gateway connect failed", this.gwError);
    } finally { this.connecting = false; }
  }
  closeWs() {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000, "bye"); } catch {}
  }
  saveGw() { this.set("gw", JSON.stringify({ session: this.session, seq: this.lastSeq })); }
  onClose(code: number) {
    console.log("gateway closed", code);
    if ([4006, 4007, 4009].includes(code)) { this.session = null; this.lastSeq = null; this.saveGw(); }
    if (code === 4004) this.qq.tok = null;
    if (code === 4914 || code === 4915) { this.gwError = "QQ 平台拒绝连接（" + code + "）"; this.set("flag:gateway", "0"); }
    this.closeWs();
    this.ctx.storage.setAlarm(Date.now() + 2000);
  }
  async onFrame(ws: WebSocket, raw: any) {
    const p = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    if (p.s) this.lastSeq = p.s;
    if (p.op === 10) {
      const token = "QQBot " + (await this.qq.token());
      ws.send(JSON.stringify(this.session && this.lastSeq !== null
        ? { op: 6, d: { token, session_id: this.session, seq: this.lastSeq } }
        : { op: 2, d: { token, intents: INTENTS, shard: [0, 1] } }));
      if (this.beat) clearInterval(this.beat);
      this.beat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: this.lastSeq })); } catch {} }, p.d.heartbeat_interval);
    } else if (p.op === 11) this.lastAck = Date.now();
    else if (p.op === 7) this.onClose(1000);
    else if (p.op === 9) { if (!p.d) { this.session = null; this.lastSeq = null; this.qq.tok = null; this.saveGw(); } await sleep(3000); this.onClose(1000); }
    else if (p.op === 0) {
      this.lastAck = Date.now();
      if (p.t === "READY") { this.session = p.d.session_id; this.set("gw:ready", new Date().toISOString()); }
      this.saveGw();
      if (p.t !== "READY" && p.t !== "RESUMED") await this.onEvent(p.t, p.d);
    }
  }

  // ---------- inbound ----------
  async onEvent(type: string, d: any) {
    const m = parseEvent(type, d);
    if (!m) return;
    const allowed = this.get("allow");                    // optional comma list of convs; empty = all
    if (allowed && !allowed.split(",").includes(m.conv)) return;
    this.ingest(m);
  }
  ingest(m: Inbound) {
    const seq = this.insert(m.conv, { ...m, role: "user" });
    if (!seq) return 0;
    if (m.conv.startsWith("g:") && !this.get("main")) this.set("main", m.conv);
    this.flushPending(m.conv).catch(() => {});
    const now = Date.now(), first = this.firstPending.get(m.conv) ?? now;
    this.firstPending.set(m.conv, first);
    // Short pause so a burst of lines is read together; a direct call barely waits.
    const due = Math.min(now + (m.mentioned ? 350 : 2200), Math.max(first + 6000, now + 200));
    const current = this.wake.get(m.conv);
    this.wake.set(m.conv, m.mentioned && current ? Math.min(current, due) : due);
    setTimeout(() => this.poke(m.conv), due - now + 5);
    return seq;
  }
  poke(conv: string) {
    const due = this.wake.get(conv);
    if (due === undefined || Date.now() < due - 2) return;
    this.wake.delete(conv); this.firstPending.delete(conv);
    this.runConv(conv).catch(e => console.log("turn crashed", e?.message));
  }

  // ---------- outbound ----------
  anchor(conv: string): string | undefined {
    const rows = this.sql.exec("SELECT id FROM msg WHERE conv=? AND role='user' AND ts>? ORDER BY seq DESC LIMIT 8", conv, Date.now() - REPLY_WINDOW_MS).toArray();
    for (const r of rows) if ((this.anchorUse.get(r.id) || 0) < REPLIES_PER_MESSAGE) return String(r.id);
    return undefined;
  }
  used(id?: string) { if (id) this.anchorUse.set(id, (this.anchorUse.get(id) || 0) + 1); if (this.anchorUse.size > 400) this.anchorUse.clear(); }
  /** Sends text now if QQ allows it, otherwise holds it until someone next speaks. */
  async say(conv: string, text: string, opts: { queue?: boolean } = {}) {
    const record = (id: string) => this.insert(conv, { id: "bot:" + id, role: "bot", name: "Bot", text, ts: Date.now() });
    if (conv.startsWith("t:")) { record(crypto.randomUUID()); return true; }
    const id = this.anchor(conv);
    const r = await this.qq.sendText(conv, text, id).catch(() => null);
    if (r?.ok) { this.used(id); record(String(r.data?.id || crypto.randomUUID())); return true; }
    console.log("send failed", r?.status, JSON.stringify(r?.data || {}).slice(0, 200));
    if (opts.queue !== false) this.sql.exec("INSERT INTO pending(conv,kind,body,ts) VALUES(?,?,?,?)", conv, "text", text, Date.now());
    return false;
  }
  async flushPending(conv: string) {
    const rows = this.sql.exec("SELECT * FROM pending WHERE conv=? ORDER BY id LIMIT 3", conv).toArray();
    for (const p of rows) {
      this.sql.exec("DELETE FROM pending WHERE id=?", p.id);
      if (Date.now() - Number(p.ts) > 36 * 3600000) continue;
      await this.say(conv, String(p.body), { queue: false });
    }
  }
  async sendImage(conv: string, jpegB64: string) {
    if (conv.startsWith("t:")) { this.insert(conv, { id: "bot:" + crypto.randomUUID(), role: "bot", name: "Bot", text: "[你发了一张图]", ts: Date.now() }); return { ok: true }; }
    const id = this.anchor(conv);
    const r = await this.qq.sendMedia(conv, 1, jpegB64, id).catch((e: any) => ({ ok: false, status: 0, data: { message: e?.message }, stage: "network" }));
    if (!r.ok) return { ok: false, error: (r.stage === "upload" ? "上传被拒" : "发送被拒") + "（" + r.status + " " + clip(r.data?.message || r.data?.code || "", 80) + "）" };
    this.used(id);
    this.insert(conv, { id: "bot:" + String(r.data?.id || crypto.randomUUID()), role: "bot", name: "Bot", text: "[你发了一张图]", ts: Date.now() });
    return { ok: true };
  }

  // ---------- turns ----------
  host(conv: string): Host {
    const hub = this;
    return {
      env: this.env, now: () => Date.now(),
      sendImage: b => hub.sendImage(conv, b),
      quota: async (kind, limit) => {
        const k = "quota:" + kind + ":" + fmtDate(Date.now(), SYD), n = Number(hub.get(k) || 0);
        if (n >= limit) return false;
        hub.set(k, String(n + 1)); return true;
      },
      remember: async text => { hub.sql.exec("INSERT INTO note(conv,text,ts) VALUES(?,?,?)", conv, text, Date.now()); },
      forget: async keyword => {
        if (!keyword.trim()) return 0;
        const n = hub.sql.exec("SELECT COUNT(*) n FROM note WHERE conv=? AND text LIKE ?", conv, "%" + keyword + "%").toArray()[0].n;
        hub.sql.exec("DELETE FROM note WHERE conv=? AND text LIKE ?", conv, "%" + keyword + "%");
        return Number(n);
      },
      searchHistory: async (query, days, limit) => {
        const words = query.split(/\s+/).filter(Boolean).slice(0, 5);
        if (!words.length) return [];
        return hub.sql.exec(
          "SELECT * FROM msg WHERE conv=? AND ts>? AND " + words.map(() => "text LIKE ?").join(" AND ") + " ORDER BY seq DESC LIMIT ?",
          conv, Date.now() - days * 86400000, ...words.map(w => "%" + w + "%"), limit,
        ).toArray().reverse().map(hub.rowOf);
      },
      getHistory: async (from, to, limit) =>
        hub.sql.exec("SELECT * FROM (SELECT * FROM msg WHERE conv=? AND ts>=? AND ts<? ORDER BY seq DESC LIMIT ?) ORDER BY seq", conv, from, to, limit).toArray().map(hub.rowOf),
      summaries: async n => hub.sql.exec("SELECT date,summary FROM day WHERE conv=? ORDER BY date DESC LIMIT ?", conv, n).toArray() as any,
      scheduleCreate: async (spec, task) => hub.addSchedule(conv, spec, task),
      scheduleList: async () => hub.sql.exec("SELECT id,spec,task,next FROM sched WHERE conv=? AND active=1 ORDER BY next", conv).toArray()
        .map((s: any) => ({ id: s.id, spec: JSON.parse(s.spec), task: s.task, next: Number(s.next) })),
      scheduleCancel: async id => { hub.sql.exec("UPDATE sched SET active=0 WHERE id=? AND conv=?", id, conv); return true; },
      ledger: async (op, name, amount, note) => {
        if (op !== "list" && name) {
          const old = hub.sql.exec("SELECT balance FROM ledger WHERE conv=? AND name=?", conv, name).toArray()[0];
          const before = old ? Number(old.balance) : 0, after = Math.round((op === "set" ? amount! : before + amount!) * 100) / 100;
          hub.sql.exec("INSERT INTO ledger(conv,name,balance) VALUES(?,?,?) ON CONFLICT(conv,name) DO UPDATE SET balance=excluded.balance", conv, name, after);
          hub.sql.exec("INSERT INTO ledger_log(conv,name,delta,balance,note,ts) VALUES(?,?,?,?,?,?)", conv, name, after - before, after, note || "", Date.now());
        }
        return hub.sql.exec("SELECT name,balance FROM ledger WHERE conv=? ORDER BY name", conv).toArray().map((r: any) => ({ name: String(r.name), balance: Number(r.balance) }));
      },
    };
  }
  addSchedule(conv: string, spec: any, task: string) {
    const count = this.sql.exec("SELECT COUNT(*) n FROM sched WHERE conv=? AND active=1", conv).toArray()[0].n;
    if (Number(count) >= 20) throw new Error("定时任务太多了（20 个），先取消几个");
    const next = spec.type === "daily" ? nextDaily(spec.time, spec.tz, Date.now(), spec.days) : Number(spec.at);
    const row = this.sql.exec("INSERT INTO sched(conv,spec,task,next) VALUES(?,?,?,?) RETURNING id", conv, JSON.stringify(spec), task, next).toArray()[0];
    return { id: Number(row.id), next };
  }
  /** History window whose start only moves every 20 messages, so the model's prompt cache keeps hitting. */
  window(conv: string) {
    const rows = this.recent(conv, 90);
    if (rows.length <= 70) return rows;
    const cut = rows.findIndex(r => r.seq % 20 === 0);
    return cut > 0 && cut <= 20 ? rows.slice(cut) : rows.slice(-70);
  }
  async loadImages(rows: Row[]) {
    const out: { seq: number; index: number; dataUrl: string }[] = [];
    for (const r of rows.slice().reverse()) {
      const images: any[] = r.meta?.images || [];
      for (let i = 0; i < images.length && out.length < 4; i++) {
        if (images[i].caption || !images[i].url) continue;
        try {
          const res = await fetch(images[i].url, { signal: AbortSignal.timeout(8000) });
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (!res.ok || bytes.length < 100 || bytes.length > 5 * 1024 * 1024) continue;
          const type = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
          out.push({ seq: r.seq, index: i, dataUrl: "data:" + (type.startsWith("image/") ? type : "image/jpeg") + ";base64," + b64(bytes) });
        } catch {}
      }
    }
    return out;
  }
  logTurn(conv: string, kind: string, res: TurnResult) {
    const s = res.stats;
    this.sql.exec("INSERT INTO turn(conv,ts,kind,ms,first_ms,calls,tools,in_tok,out_tok,cached,said,err) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      conv, Date.now(), kind, s.ms, s.firstMs, s.calls, s.tools.join(","), s.inTok, s.outTok, s.cached, res.silent ? "" : clip(res.replies.join(" ‖ "), 300), s.error || null);
    this.sql.exec("DELETE FROM turn WHERE id < (SELECT MAX(id) FROM turn) - 3000");
  }
  deps(conv: string, interim: boolean) {
    return {
      chat: (body: any, effort: any, timeout?: number) => dsChat(this.env, body, effort, timeout),
      tools: buildTools(this.host(conv)),
      ...(interim ? { interim: async (text: string) => { await this.say(conv, text, { queue: false }); } } : {}),
    };
  }
  async runConv(conv: string): Promise<TurnResult | null> {
    if (this.running.has(conv)) { this.wake.set(conv, Date.now() + 1500); setTimeout(() => this.poke(conv), 1510); return null; }
    this.running.add(conv);
    let top = 0;
    try {
      const cursor = Number(this.get("cursor:" + conv) || 0);
      const rows = this.window(conv);
      const fresh = rows.filter(r => r.seq > cursor && r.role === "user");
      if (!fresh.length) return null;
      top = rows[rows.length - 1].seq;
      const mentioned = fresh.some(r => r.mentioned);
      const images = await this.loadImages(fresh);
      const res = await runTurn(
        { rows, cursor, mentioned, memory: this.get("memory:" + conv) || "", notes: this.notes(conv), now: Date.now(), images },
        this.deps(conv, true),
      );
      this.set("cursor:" + conv, String(top));
      // A casual remark that the chat has already moved past is dropped; the next turn sees everything.
      const newer = Number(this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, top).toArray()[0].n);
      const stale = !mentioned && (newer >= 3 || (newer >= 1 && res.stats.ms > 9000));
      if (!res.silent && !stale) {
        for (let i = 0; i < res.replies.length; i++) {
          if (i) await sleep(Math.min(1400, 350 + res.replies[i].length * 35));
          await this.say(conv, res.replies[i], { queue: mentioned });
        }
      }
      this.logTurn(conv, stale ? "stale" : mentioned ? "called" : "chat", res);
      if (images.length) this.ctx.waitUntil(this.captionImages(images));
      return res;
    } catch (e: any) {
      console.log("turn failed", e?.message);
      if (top) this.set("cursor:" + conv, String(top));
      return null;
    } finally {
      this.running.delete(conv);
      const cursor = Number(this.get("cursor:" + conv) || 0);
      const more = this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, cursor).toArray()[0].n;
      if (Number(more) && !this.wake.has(conv)) { this.wake.set(conv, Date.now() + 600); setTimeout(() => this.poke(conv), 610); }
    }
  }
  notes(conv: string): string[] {
    return this.sql.exec("SELECT text FROM note WHERE conv=? ORDER BY id DESC LIMIT 30", conv).toArray().reverse().map((n: any) => String(n.text));
  }
  async captionImages(images: { seq: number; index: number; dataUrl: string }[]) {
    for (const im of images) {
      try {
        const text = await caption(this.env, im.dataUrl);
        const row = this.sql.exec("SELECT meta FROM msg WHERE seq=?", im.seq).toArray()[0];
        if (!row || !text) continue;
        const meta = JSON.parse(String(row.meta || "{}"));
        if (meta.images?.[im.index]) { meta.images[im.index].caption = text; this.sql.exec("UPDATE msg SET meta=? WHERE seq=?", JSON.stringify(meta), im.seq); }
      } catch {}
    }
  }
  async runTask(conv: string, task: string) {
    if (this.running.has(conv)) return false;
    this.running.add(conv);
    try {
      const rows = this.window(conv), top = rows.length ? rows[rows.length - 1].seq : 0;
      const res = await runTurn(
        { rows, cursor: top, mentioned: false, memory: this.get("memory:" + conv) || "", notes: this.notes(conv), now: Date.now(), task },
        this.deps(conv, false),
      );
      if (!res.silent) for (const reply of res.replies) await this.say(conv, reply);
      this.logTurn(conv, "task", res);
      return true;
    } finally { this.running.delete(conv); }
  }

  // ---------- nightly memory ----------
  async reflectConv(conv: string, all = false) {
    const from = all ? 0 : Number(this.get("reflect:seq:" + conv) || 0);
    const rows: Row[] = this.sql.exec("SELECT * FROM (SELECT * FROM msg WHERE conv=? AND seq>? ORDER BY seq DESC LIMIT 1500) ORDER BY seq", conv, from).toArray().map(this.rowOf);
    if (rows.filter(r => r.role === "user").length < 3) return { skipped: true };
    const transcript = rows.map(r => "[" + fmtFull(r.ts, BJ) + "] " + (r.role === "bot" ? "Bot(你)" : displayName(r)) + "：" + clip(r.text, 600)).join("\n");
    const notes = this.notes(conv);
    const out = await reflect(this.env, {
      memory: this.get("memory:" + conv) || "", notes, transcript: clip(transcript, 240000),
      label: fmtFull(rows[0].ts, BJ) + " 到 " + fmtFull(rows[rows.length - 1].ts, BJ) + "（北京时间）",
    });
    this.set("memory:prev:" + conv, this.get("memory:" + conv) || "");
    this.set("memory:" + conv, out.memory);
    this.set("reflect:seq:" + conv, String(rows[rows.length - 1].seq));
    this.sql.exec("DELETE FROM note WHERE conv=?", conv);
    if (out.summary) this.sql.exec("INSERT INTO day(conv,date,summary) VALUES(?,?,?) ON CONFLICT(conv,date) DO UPDATE SET summary=excluded.summary",
      conv, fmtDate(rows[rows.length - 1].ts, SYD), out.summary);
    return { memory: out.memory.length, summary: out.summary };
  }

  // ---------- clock ----------
  async alarm() { await this.tick(); }
  async tick() {
    const now = Date.now();
    try {
      if (this.on("gateway")) {
        const dead = !this.ws || now - this.lastAck > 130000;
        if (dead && !this.connecting) await this.connect();
      } else if (this.ws) this.closeWs();

      for (const s of this.sql.exec("SELECT * FROM sched WHERE active=1 AND next<=? ORDER BY next LIMIT 3", now).toArray()) {
        const spec = JSON.parse(String(s.spec)), conv = String(s.conv);
        if (this.running.has(conv)) continue;
        if (spec.type === "daily") this.sql.exec("UPDATE sched SET next=?, last=? WHERE id=?", nextDaily(spec.time, spec.tz, now, spec.days), now, s.id);
        else this.sql.exec("UPDATE sched SET active=0, last=? WHERE id=?", now, s.id);
        if (now - Number(s.next) < 6 * 3600000) this.ctx.waitUntil(this.runTask(conv, String(s.task)).catch(e => console.log("task failed", e?.message)));
      }

      // Memory consolidation once a night, at 04:30 Sydney, when the group is asleep.
      const today = fmtDate(now, SYD);
      if (this.get("reflect:day") !== today && now >= zonedToUtc(today, "04:30", SYD)) {
        this.set("reflect:day", today);
        for (const c of this.sql.exec("SELECT DISTINCT conv FROM msg WHERE ts>? AND conv NOT LIKE 't:%'", now - 36 * 3600000).toArray())
          this.ctx.waitUntil(this.reflectConv(String(c.conv)).catch(e => console.log("reflect failed", e?.message)));
      }

      // Anything a lost timer left unanswered.
      for (const c of this.sql.exec("SELECT DISTINCT conv FROM msg WHERE role='user' AND ts>? AND ts<?", now - 240000, now - 12000).toArray()) {
        const conv = String(c.conv);
        if (this.running.has(conv) || this.wake.has(conv)) continue;
        const cursor = Number(this.get("cursor:" + conv) || 0);
        if (Number(this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, cursor).toArray()[0].n))
          this.ctx.waitUntil(this.runConv(conv).catch(() => {}));
      }
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  // ---------- control surface (called by the Worker after it checks the admin token) ----------
  async fetch(req: Request): Promise<Response> {
    try { return await this.route(req); }
    catch (e: any) { return new Response(JSON.stringify({ error: clip(e?.message || String(e), 500) }), { status: 500, headers: { "Content-Type": "application/json" } }); }
  }
  async route(req: Request): Promise<Response> {
    const url = new URL(req.url), path = url.pathname;
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const json = (v: any, status = 200) => new Response(JSON.stringify(v, null, 1), { status, headers: { "Content-Type": "application/json" } });
    const conv = String(body.conv || url.searchParams.get("conv") || this.get("main") || "");

    if (path === "/tick") { await this.tick(); return json({ ok: true }); }
    if (path === "/event") { await this.onEvent(String(body.t), body.d); return json({ op: 12, d: 0 }); }
    if (path === "/admin/status") {
      const count = (q: string, ...b: any[]) => Number(this.sql.exec(q, ...b).toArray()[0].n);
      return json({
        gateway: { on: this.on("gateway"), connected: !!this.ws, lastAckAgoMs: this.lastAck ? Date.now() - this.lastAck : null, session: !!this.session, ready: this.get("gw:ready"), error: this.gwError },
        main: this.get("main"), messages: count("SELECT COUNT(*) n FROM msg"), pending: count("SELECT COUNT(*) n FROM pending"),
        notes: count("SELECT COUNT(*) n FROM note"), schedules: this.sql.exec("SELECT id,conv,spec,task,next,active FROM sched WHERE active=1").toArray(),
        memoryChars: (this.get("memory:" + conv) || "").length, reflectDay: this.get("reflect:day"),
        last24h: this.sql.exec("SELECT kind, COUNT(*) n, CAST(AVG(ms) AS INT) avg_ms, MAX(ms) max_ms, SUM(in_tok) in_tok, SUM(cached) cached, SUM(out_tok) out_tok FROM turn WHERE ts>? GROUP BY kind", Date.now() - 86400000).toArray(),
      });
    }
    if (path === "/admin/gateway") {
      this.set("flag:gateway", body.on ? "1" : "0");
      if (body.reset) { this.session = null; this.lastSeq = null; this.saveGw(); }
      await this.tick();
      return json({ on: this.on("gateway"), connected: !!this.ws, error: this.gwError });
    }
    if (path === "/admin/import") {
      let n = 0;
      for (const r of body.rows || []) n += this.insert(conv, r) ? 1 : 0;
      if (typeof body.memory === "string") this.set("memory:" + conv, body.memory);
      if (body.main) this.set("main", conv);
      if (body.cursorToEnd) {
        const top = this.sql.exec("SELECT MAX(seq) n FROM msg WHERE conv=?", conv).toArray()[0].n;
        this.set("cursor:" + conv, String(top || 0));
      }
      return json({ inserted: n });
    }
    if (path === "/admin/dry") {
      // A private test conversation: same brain and memory as the real group, nothing goes to QQ.
      const test = "t:" + (body.room || "lab");
      if (body.reset) { this.sql.exec("DELETE FROM msg WHERE conv=?", test); this.set("cursor:" + test, "0"); }
      if (body.seedFrom) {
        this.set("memory:" + test, this.get("memory:" + body.seedFrom) || "");
        if (!Number(this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=?", test).toArray()[0].n)) {
          for (const r of this.recent(body.seedFrom, 40)) this.insert(test, { ...r, id: "seed:" + r.id });
          const top = this.sql.exec("SELECT MAX(seq) n FROM msg WHERE conv=?", test).toArray()[0].n;
          this.set("cursor:" + test, String(top || 0));
        }
      }
      this.insert(test, { id: "dry:" + crypto.randomUUID(), role: "user", sender: "tester", name: body.name || "测试员", text: String(body.text || ""), ts: Date.now(), mentioned: body.mentioned !== false, meta: body.meta });
      const res = await this.runConv(test);
      return json(res || { error: "no turn" });
    }
    if (path === "/admin/reflect") return json(await this.reflectConv(conv, !!body.all));
    if (path === "/admin/memory") {
      if (req.method === "POST" && typeof body.memory === "string") this.set("memory:" + conv, body.memory);
      return json({ conv, memory: this.get("memory:" + conv) || "", notes: this.notes(conv), days: this.sql.exec("SELECT date,summary FROM day WHERE conv=? ORDER BY date DESC LIMIT 7", conv).toArray() });
    }
    if (path === "/admin/turns") return json(this.sql.exec("SELECT * FROM turn ORDER BY id DESC LIMIT ?", Number(url.searchParams.get("n") || 30)).toArray());
    if (path === "/admin/recent") return json(this.recent(conv, Number(url.searchParams.get("n") || 30)).map(r => ({ seq: r.seq, t: fmtFull(r.ts, SYD), who: r.role === "bot" ? "BOT" : displayName(r), text: clip(r.text, 300), at: r.mentioned })));
    if (path === "/admin/sched") {
      if (body.cancel) { this.sql.exec("UPDATE sched SET active=0 WHERE id=?", body.cancel); return json({ ok: true }); }
      return json(this.addSchedule(conv, body.spec, String(body.task)));
    }
    if (path === "/admin/ledger") {
      const h = this.host(conv);
      for (const [name, amount] of Object.entries(body.set || {})) await h.ledger("set", name, Number(amount), "初始化");
      return json(await h.ledger("list"));
    }
    if (path === "/admin/task") return json({ ran: await this.runTask(conv, String(body.task)) });
    if (path === "/admin/set") { this.set(String(body.k), String(body.v)); return json({ ok: true }); }
    return json({ error: "not found" }, 404);
  }
}
