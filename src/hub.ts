// The bot is one Durable Object. This file is its spine: messages in, turns, messages out, background
// jobs, and the clock. The parts live next door: gateway.ts (QQ connection), store.ts (pictures and
// files), selfedit.ts (what it may change about itself), accounts.ts (its books), budget.ts (the plan's
// monthly allowance), health.ts (daily self-check), host.ts (what tools can reach), admin.ts (control surface).
import { DurableObject } from "cloudflare:workers";
import { displayName, runTurn } from "./core.ts";
import type { Row, TurnResult } from "./core.ts";
import { dsChat } from "./llm.ts";
import { setMeter } from "./meter.ts";
import { caption, reflect } from "./memory.ts";
import { QQ, parseEvent } from "./qq.ts";
import type { Inbound } from "./qq.ts";
import { buildTools } from "./tools.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import type { Made } from "./store.ts";
import { Plan } from "./budget.ts";
import { SelfEdit } from "./selfedit.ts";
import type { Asker } from "./selfedit.ts";
import { Accounts } from "./accounts.ts";
import { dailyHealth } from "./health.ts";
import { makeHost } from "./host.ts";
import { hearSilk } from "./sites.ts";
import { route } from "./admin.ts";
import { FEATURES } from "./feat/index.ts";
import { BJ, SYD, b64, buildOf, clip, fmtDate, fmtFull, nextDaily, sleep, zonedToUtc } from "./util.ts";
import type { Env } from "./util.ts";

const TICK_MS = 20000;
const REPLY_WINDOW_MS = 270000;   // a QQ message can be answered for five minutes
const REPLIES_PER_MESSAGE = 5;
const JOBS_PER_CONV = 2;

type Job = { conv: string; title: string; since: number; cancel: boolean };

export class Hub extends DurableObject<Env> {
  declare env: Env;
  declare ctx: DurableObjectState<{}>;
  sql: any;
  qq: QQ;
  gateway: Gateway;
  store: Store;
  plan: Plan;
  edit: SelfEdit;
  accounts: Accounts;
  running = new Set<string>();
  wake = new Map<string, number>();
  firstPending = new Map<string, number>();
  anchorUse = new Map<string, number>();
  jobs = new Map<number, Job>();
  restartWanted = "";
  restartSince = 0;
  recovered = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
      CREATE TABLE IF NOT EXISTS toolrun(id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER, conv TEXT, ts INTEGER, name TEXT, ms INTEGER, ok INTEGER, args TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS ledger(conv TEXT, name TEXT, balance REAL NOT NULL DEFAULT 0, PRIMARY KEY(conv, name));
      CREATE TABLE IF NOT EXISTS ledger_log(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, name TEXT, delta REAL, balance REAL, note TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT);
      CREATE TABLE IF NOT EXISTS change(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, by TEXT, kind TEXT, key TEXT, before TEXT, after TEXT, reason TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS spend(day TEXT, provider TEXT, item TEXT, unit TEXT, calls INTEGER DEFAULT 0, in_tok INTEGER DEFAULT 0, cached_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, units REAL DEFAULT 0, usd REAL DEFAULT 0, PRIMARY KEY(day, provider, item));
      CREATE TABLE IF NOT EXISTS snap(day TEXT PRIMARY KEY, cny REAL, ts INTEGER);
      CREATE TABLE IF NOT EXISTS blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, name TEXT, data BLOB);
      CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, kind TEXT, body TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS job(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, kind TEXT, title TEXT, task TEXT, state TEXT, created INTEGER, updated INTEGER,
        tries INTEGER DEFAULT 0, steps INTEGER DEFAULT 0, error TEXT);
    `);
    for (const f of FEATURES) if (f.schema) this.sql.exec(f.schema);
    this.qq = new QQ(env);
    this.plan = new Plan(this);
    this.store = new Store(this);
    this.edit = new SelfEdit(this);
    this.accounts = new Accounts(this);
    this.gateway = new Gateway(this);
    setMeter(u => this.accounts.record(u));
  }

  // ---------- storage helpers ----------
  get(k: string): string | null { const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray()[0]; return r ? String(r.v) : null; }
  set(k: string, v: string) { this.sql.exec("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v); }
  on(flag: string) { return this.get("flag:" + flag) === "1"; }
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
  /** A private test room ("t:…") borrows the main group's memory, settings, characters and stickers; this is that group. */
  shadow(conv: string) { return conv.startsWith("t:") ? this.get("main") || "" : ""; }
  memoryOf(conv: string) { return this.get("memory:" + conv) || (this.shadow(conv) ? this.get("memory:" + this.shadow(conv)) || "" : ""); }
  notes(conv: string): string[] {
    return this.sql.exec("SELECT text FROM note WHERE conv=? ORDER BY id DESC LIMIT 40", conv).toArray().reverse().map((n: any) => String(n.text));
  }

  // ---------- inbound ----------
  async onEvent(type: string, d: any) {
    const conv = type === "C2C_MESSAGE_CREATE" ? "u:" + String(d.author?.user_openid || d.author?.id || "") : "g:" + String(d.group_openid);
    const m = parseEvent(type, d, this.edit.aliases(conv));
    if (!m) return;
    const allowed = this.get("allow");                    // optional comma list of convs; empty = all
    if (allowed && !allowed.split(",").includes(m.conv)) return;
    this.ingest(m);
  }
  ingest(m: Inbound) {
    const seq = this.insert(m.conv, { ...m, role: "user" });
    if (!seq) return 0;
    if (m.conv.startsWith("g:") && !this.get("main")) this.set("main", m.conv);
    if (m.meta && !m.conv.startsWith("t:")) this.ctx.waitUntil(this.store.archiveChat(m.conv, seq, m.meta).catch(e => console.log("archive failed", e?.message)));
    this.flushPending(m.conv).catch(() => {});
    const now = Date.now(), first = this.firstPending.get(m.conv) ?? now;
    this.firstPending.set(m.conv, first);
    // Short pause so a burst of lines is read together; a direct call barely waits.
    const due = Math.min(now + Number(this.edit.cfg(m.conv, m.mentioned ? "wait_called_ms" : "wait_chat_ms")), Math.max(first + Number(this.edit.cfg(m.conv, "wait_max_ms")), now + 200));
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
  /** The message a reply can hang on: QQ lets each message be answered five times within five minutes. */
  anchor(conv: string): string | undefined {
    const rows = this.sql.exec("SELECT id FROM msg WHERE conv=? AND role='user' AND ts>? ORDER BY seq DESC LIMIT 8", conv, Date.now() - REPLY_WINDOW_MS).toArray();
    for (const r of rows) if ((this.anchorUse.get(r.id) || 0) < REPLIES_PER_MESSAGE) return String(r.id);
    return undefined;
  }
  used(id?: string) { if (id) this.anchorUse.set(id, (this.anchorUse.get(id) || 0) + 1); if (this.anchorUse.size > 400) this.anchorUse.clear(); }
  private recordBot(conv: string, id: string, text: string) { this.insert(conv, { id: "bot:" + id, role: "bot", name: "Bot", text, ts: Date.now() }); }
  /** Sends text now if QQ allows it, otherwise holds it until someone next speaks. */
  async say(conv: string, text: string, opts: { queue?: boolean; quote?: string } = {}) {
    if (conv.startsWith("t:")) { this.recordBot(conv, crypto.randomUUID(), text); return true; }
    const id = this.anchor(conv);
    const r = await this.qq.sendText(conv, text, id, opts.quote).catch(() => null);
    if (r?.ok) { this.used(id); this.recordBot(conv, String(r.data?.id || crypto.randomUUID()), text); return true; }
    console.log("send failed", r?.status, JSON.stringify(r?.data || {}).slice(0, 200));
    if (opts.queue !== false) this.sql.exec("INSERT INTO pending(conv,kind,body,ts) VALUES(?,?,?,?)", conv, "text", text, Date.now());
    return false;
  }
  /**
   * fileType 1 = image, 2 = video (MP4), 3 = voice (SILK), 4 = file. With nobody to reply to (a scheduled task at night),
   * QQ may refuse an unprompted picture or file; it is then kept and goes out when someone next speaks.
   */
  async sendMediaMessage(conv: string, fileType: number, bytes: Uint8Array, label: string, fileName?: string): Promise<{ ok: boolean; error?: string; queued?: boolean }> {
    if (conv.startsWith("t:")) { this.recordBot(conv, crypto.randomUUID(), label); return { ok: true }; }
    const id = this.anchor(conv);
    const r = await this.qq.sendMedia(conv, fileType, b64(bytes), id, fileName).catch((e: any) => ({ ok: false, status: 0, data: { message: e?.message }, stage: "network" }));
    if (r.ok) { this.used(id); this.recordBot(conv, String(r.data?.id || crypto.randomUUID()), label); return { ok: true }; }
    const error = (r.stage === "upload" ? "上传被拒" : "发送被拒") + "（" + r.status + " " + clip(r.data?.message || r.data?.code || "", 80) + "）";
    if (!id && r.stage !== "upload") {
      const kept = await this.store.putFile(conv, "queued-" + (fileName || fileType), bytes);
      if (kept) {
        this.sql.exec("INSERT INTO pending(conv,kind,body,ts) VALUES(?,?,?,?)", conv, "media", JSON.stringify({ fileType, file: "f" + kept, label, fileName }), Date.now());
        return { ok: true, queued: true };
      }
    }
    return { ok: false, error };
  }
  async flushPending(conv: string) {
    const rows = this.sql.exec("SELECT * FROM pending WHERE conv=? ORDER BY id LIMIT 4", conv).toArray();
    for (const p of rows) {
      this.sql.exec("DELETE FROM pending WHERE id=?", p.id);
      if (Date.now() - Number(p.ts) > 36 * 3600000) continue;
      if (p.kind === "media") {
        const m = JSON.parse(String(p.body)), f = await this.store.fileRef(conv, String(m.file)).catch(() => null), id = this.anchor(conv);
        if (!f || !id) continue;
        const r = await this.qq.sendMedia(conv, Number(m.fileType), b64(f.bytes), id, m.fileName).catch(() => null);
        if (r?.ok) { this.used(id); this.recordBot(conv, String(r.data?.id || crypto.randomUUID()), String(m.label)); }
      } else await this.say(conv, String(p.body), { queue: false });
    }
  }
  /** Keeps a picture (so it can be referenced later as "g12") and, unless `silent`, sends it. */
  async sendImage(conv: string, bytes: Uint8Array, note: string, mime = "image/jpeg", silent = false, made?: Made) {
    const n = await this.store.putImage(conv, bytes, mime, note, made ? { made } : {}), id = n ? "g" + n : "";
    if (silent) return { ok: !!id, id };
    const r = await this.sendMediaMessage(conv, 1, bytes, "[你发了一张图" + (id ? " " + id : "") + "：" + clip(note, 60) + "]");
    return { ...r, id };
  }
  async fetchBytes(url: string, limit: number) {
    const origin = new URL(url).origin;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", Referer: origin + "/" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length < 64 || bytes.length > limit) return null;
    return { bytes, mime: (r.headers.get("content-type") || "").split(";")[0] };
  }

  // ---------- background jobs ----------
  // A job is anything that outlives one chat reply: a scheduled task, a planned multi-step production,
  // a book. It has a row, so the bot can say what is running, stop it, and pick it up after a restart.
  startJob(conv: string, kind: "chat" | "task", title: string, task = "") {
    const id = Number(this.sql.exec("INSERT INTO job(conv,kind,title,task,state,created,updated) VALUES(?,?,?,?,'running',?,?) RETURNING id", conv, kind, clip(title, 80), task, Date.now(), Date.now()).toArray()[0].id);
    this.jobs.set(id, { conv, title: clip(title, 80), since: Date.now(), cancel: false });
    this.sql.exec("DELETE FROM job WHERE id < (SELECT MAX(id) FROM job) - 300");
    return id;
  }
  finishJob(id: number, state: "done" | "failed" | "cancelled", error = "") {
    this.jobs.delete(id);
    this.sql.exec("UPDATE job SET state=?, error=?, updated=? WHERE id=?", state, clip(error, 300) || null, Date.now(), id);
    if (this.env.FILES) this.ctx.waitUntil(this.env.FILES.delete("job/" + id + ".json").catch(() => {}));
    this.maybeRestart();
  }
  /** Saves where a job has got to. Picture data is left out; the steps and their results are what a restart needs. */
  async checkpoint(id: number, messages: any[], roundDone: boolean) {
    this.sql.exec("UPDATE job SET steps=steps+?, updated=? WHERE id=?", roundDone ? 1 : 0, Date.now(), id);
    if (!this.env.FILES || !this.plan.take("r2_writes", 1)) return;
    const slim = JSON.stringify(messages, (_k, v) => (typeof v === "string" && v.length > 4000 && v.startsWith("data:") ? "data:omitted" : v));
    await this.env.FILES.put("job/" + id + ".json", slim).catch(() => {});
  }
  jobNote(conv: string) {
    const mine = [...this.jobs.entries()].filter(([, j]) => j.conv === conv);
    return mine.length ? mine.map(([id, j]) => "第 " + id + " 号「" + j.title + "」（已经做了 " + Math.max(1, Math.round((Date.now() - j.since) / 60000)) + " 分钟）").join("；") : "";
  }
  jobList(conv: string) {
    return this.sql.exec("SELECT id,kind,title,state,created,updated,steps,error FROM job WHERE conv=? ORDER BY id DESC LIMIT 8", conv).toArray().map((j: any) => ({
      id: Number(j.id), what: String(j.title), kind: j.kind === "task" ? "定时或交办任务" : "聊天里开的大活",
      state: ({ running: this.jobs.has(Number(j.id)) ? "正在做" : "被重启打断，等着接上", done: "做完了", failed: "失败了", cancelled: "被叫停了" } as Record<string, string>)[String(j.state)] || String(j.state),
      started: fmtFull(Number(j.created), BJ) + " 北京时间", minutes: Math.max(1, Math.round((Number(j.updated) - Number(j.created)) / 60000)), steps_done: Number(j.steps), ...(j.error ? { error: String(j.error) } : {}),
    }));
  }
  cancelJob(id: number, conv: string) {
    const j = this.jobs.get(id);
    if (!j || j.conv !== conv) return false;
    j.cancel = true;
    return true;
  }
  /** Runs a task in the background: the conversation is not held, so the chat goes on while it works. */
  async runTask(conv: string, task: string, resume?: { id: number; messages?: any[] }) {
    const title = clip(task.replace(/\s+/g, " "), 40);
    const id = resume?.id ?? this.startJob(conv, "task", title, task);
    if (resume) this.jobs.set(id, { conv, title, since: Date.now(), cancel: false });
    try {
      const rows = this.window(conv), top = rows.length ? rows[rows.length - 1].seq : 0;
      const res = await runTurn(
        { rows, cursor: top, mentioned: false, memory: this.memoryOf(conv), notes: this.notes(conv), now: Date.now(), task, rules: this.edit.play(conv, "persona"), resume: resume?.messages },
        this.deps(conv, false, [], id),
      );
      if (!res.silent) for (const reply of res.replies) await this.say(conv, reply);
      this.logTurn(conv, "task", res);
      const err = res.stats.error || "";
      if (err && err !== "cancelled" && res.silent) await this.say(conv, "交办的任务「" + title + "」没跑成：" + clip(err, 100));
      this.finishJob(id, err === "cancelled" ? "cancelled" : err ? "failed" : "done", err);
      return true;
    } catch (e: any) {
      this.finishJob(id, "failed", e?.message || String(e));
      await this.say(conv, "交办的任务「" + title + "」没跑成：" + clip(e?.message || "未知错误", 100)).catch(() => {});
      return false;
    }
  }
  /** Continues a job that a chat turn had moved to the background before the restart. */
  async resumeChatJob(id: number, conv: string, title: string, messages: any[]) {
    this.jobs.set(id, { conv, title, since: Date.now(), cancel: false });
    try {
      const res = await runTurn({ rows: [], cursor: 0, mentioned: true, memory: "", notes: [], now: Date.now(), resume: messages }, this.deps(conv, false, [], id));
      if (!res.silent) for (const reply of res.replies) await this.say(conv, reply);
      this.logTurn(conv, "job", res);
      this.finishJob(id, res.stats.error === "cancelled" ? "cancelled" : res.stats.error ? "failed" : "done", res.stats.error || "");
    } catch (e: any) {
      this.finishJob(id, "failed", e?.message || String(e));
      await this.say(conv, "「" + title + "」接着做的时候出错了，没做完：" + clip(e?.message || "未知错误", 80)).catch(() => {});
    }
  }
  /** After a restart: every job still marked running was cut off. Pick each up from its last saved step, twice at most. */
  async recoverJobs() {
    for (const j of this.sql.exec("SELECT * FROM job WHERE state='running' ORDER BY id").toArray() as any[]) {
      const id = Number(j.id), conv = String(j.conv), title = String(j.title);
      if (this.jobs.has(id)) continue;
      const saved = this.env.FILES ? await this.env.FILES.get("job/" + id + ".json").then((o: any) => (o ? o.json() : null)).catch(() => null) : null;
      // Picture data was not saved; leave a marker where each picture was.
      const messages: any[] | undefined = Array.isArray(saved) ? saved.map((m: any) => Array.isArray(m.content)
        ? { ...m, content: m.content.map((p: any) => (p?.type === "image_url" && String(p.image_url?.url || "").startsWith("data:omitted") ? { type: "text", text: "[这里原来有一张图，重启后没保留]" } : p)) } : m) : undefined;
      const stale = Number(j.tries) >= 2 || Date.now() - Number(j.created) > 3 * 3600000;
      if (stale || (j.kind === "chat" && !messages)) {
        this.finishJob(id, "failed", "被重启打断");
        await this.say(conv, "「" + title + "」被一次重启打断了，没做完。还要的话再叫我一次").catch(() => {});
        continue;
      }
      this.sql.exec("UPDATE job SET tries=tries+1, updated=? WHERE id=?", Date.now(), id);
      this.ctx.waitUntil(j.kind === "task" ? this.runTask(conv, String(j.task), { id, messages }) : this.resumeChatJob(id, conv, title, messages!));
    }
  }
  /** A new version waits for work in flight; jobs are given ten minutes, after which they resume from their last step. */
  maybeRestart() {
    if (!this.restartWanted || this.running.size) return;
    if (this.jobs.size && Date.now() - this.restartSince < 600000) return;
    const why = this.restartWanted; this.restartWanted = "";
    this.gateway.close();
    this.ctx.storage.setAlarm(Date.now() + 1500).then(() => this.ctx.abort("restart for " + why));
  }
  wantRestart(why: string) {
    if (!this.restartWanted) this.restartSince = Date.now();
    this.restartWanted = why;
    this.maybeRestart();
    return this.running.size + this.jobs.size;
  }

  // ---------- turns ----------
  addSchedule(conv: string, spec: any, task: string) {
    const count = this.sql.exec("SELECT COUNT(*) n FROM sched WHERE conv=? AND active=1", conv).toArray()[0].n;
    if (Number(count) >= 20) throw new Error("定时任务太多了（20 个），先取消几个");
    const next = spec.type === "daily" ? nextDaily(spec.time, spec.tz, Date.now(), spec.days) : Number(spec.at);
    const row = this.sql.exec("INSERT INTO sched(conv,spec,task,next) VALUES(?,?,?,?) RETURNING id", conv, JSON.stringify(spec), task, next).toArray()[0];
    return { id: Number(row.id), next };
  }
  /**
   * What the model reads each turn: everything since last night's consolidation plus a carry-over tail,
   * so a whole day of chat stays in view. The start only moves in steps of 100, which keeps the
   * model's prompt cache hitting; older days live on in the memory document.
   */
  window(conv: string) {
    const since = Number(this.get("reflect:seq:" + conv) || 0);
    const rows: Row[] = this.sql.exec("SELECT * FROM (SELECT * FROM msg WHERE conv=? AND seq>? ORDER BY seq DESC LIMIT 900) ORDER BY seq", conv, since - Number(this.edit.cfg(conv, "history_carry"))).toArray().map(this.rowOf);
    if (rows.length <= 200) return rows;
    const cut = rows.findIndex(r => r.seq % 100 === 0);
    return cut > 0 && cut <= 100 ? rows.slice(cut) : rows;
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
    const id = Number(this.sql.exec("INSERT INTO turn(conv,ts,kind,ms,first_ms,calls,tools,in_tok,out_tok,cached,said,err) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
      conv, Date.now(), kind, s.ms, s.firstMs, s.calls, s.tools.join(","), s.inTok, s.outTok, s.cached, res.silent ? "" : clip(res.replies.join(" ‖ "), 300), s.error || null).toArray()[0].id);
    for (const r of s.runs) this.sql.exec("INSERT INTO toolrun(turn,conv,ts,name,ms,ok,args,error) VALUES(?,?,?,?,?,?,?,?)", id, conv, Date.now(), r.name, r.ms, r.ok ? 1 : 0, r.args, r.error || null);
    this.sql.exec("DELETE FROM turn WHERE id < (SELECT MAX(id) FROM turn) - 3000");
    if (s.runs.length) this.sql.exec("DELETE FROM toolrun WHERE id < (SELECT MAX(id) FROM toolrun) - 6000");
  }
  tools(conv: string, askers: Asker[] = []) {
    const host = makeHost(this, conv, askers), built = buildTools(host);
    // Feature tools are appended in place: about_self describes whatever this list holds.
    for (const f of FEATURES) built.push(...(f.tools?.({ hub: this, conv, askers, host }) || []));
    return built;
  }
  /** `job` is a getter because a chat turn only becomes a job partway through. */
  deps(conv: string, interim: boolean, askers: Asker[], job: number | (() => number), detach?: (what: string) => void) {
    const jobId = () => (typeof job === "function" ? job() : job);
    return {
      ...(detach ? { detach } : {}),
      chat: (body: any, effort: any, timeout?: number) => dsChat(this.env, { ...body, label: "聊天" }, effort, timeout),
      tools: this.tools(conv, askers),
      ...(interim ? { interim: async (text: string) => { await this.say(conv, text, { queue: false }); } } : {}),
      checkpoint: (messages: any[], roundDone: boolean) => (jobId() ? this.checkpoint(jobId(), messages, roundDone) : undefined),
      cancelled: () => !!this.jobs.get(jobId())?.cancel,
    };
  }
  async runConv(conv: string): Promise<TurnResult | null> {
    if (this.running.has(conv)) { this.wake.set(conv, Date.now() + 1500); setTimeout(() => this.poke(conv), 1510); return null; }
    this.running.add(conv);
    let top = 0, jobId = 0;
    try {
      const cursor = Number(this.get("cursor:" + conv) || 0);
      await this.hearVoices(conv, cursor).catch(() => {});
      const rows = this.window(conv);
      const fresh = rows.filter(r => r.seq > cursor && r.role === "user");
      if (!fresh.length) return null;
      top = rows[rows.length - 1].seq;
      const mentioned = fresh.some(r => r.mentioned);
      const images = await this.loadImages(fresh);
      const askers = fresh.filter(r => r.mentioned).map(r => ({ id: String(r.sender || ""), name: displayName(r) }));
      // A long job lets go of the conversation: the chat moves on, and the result is posted when it is done.
      const detach = (what: string) => {
        if (jobId) return;
        jobId = this.startJob(conv, "chat", what);
        this.set("cursor:" + conv, String(top));
        this.running.delete(conv);
      };
      const res = await runTurn(
        {
          rows, cursor, mentioned, memory: this.memoryOf(conv), notes: this.notes(conv), now: Date.now(), images,
          rules: this.edit.play(conv, "persona"), askers: askers.map(a => a.name), talkative: String(this.edit.cfg(conv, "talkative")), splitMax: Number(this.edit.cfg(conv, "reply_split_max")),
          ...(this.jobNote(conv) ? { job: this.jobNote(conv) } : {}),
        },
        this.deps(conv, true, askers, () => jobId, detach),
      );
      if (!jobId) this.set("cursor:" + conv, String(top));
      // A casual remark that the chat has already moved past is dropped; the next turn sees everything.
      const newer = Number(this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, top).toArray()[0].n);
      const stale = !jobId && !mentioned && (newer >= 3 || (newer >= 1 && res.stats.ms > 9000));
      if (!res.silent && !stale) {
        // When one person asked and the chat has moved on since, quote their message so it is clear who is being answered.
        const asked = fresh.filter(r => r.mentioned);
        const one = new Set(asked.map(r => r.sender)).size === 1 ? asked[asked.length - 1] : null;
        const movedOn = one ? Number(this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, one.seq).toArray()[0].n) > 0 : false;
        const quote = one && movedOn && Date.now() - one.ts < REPLY_WINDOW_MS ? one.id : undefined;
        for (let i = 0; i < res.replies.length; i++) {
          if (i) await sleep(Math.min(1400, 350 + res.replies[i].length * 35));
          await this.say(conv, res.replies[i], { queue: mentioned || !!jobId, quote: i === 0 ? quote : undefined });
        }
      }
      this.logTurn(conv, jobId ? "job" : stale ? "stale" : mentioned ? "called" : "chat", res);
      if (jobId) this.finishJob(jobId, res.stats.error === "cancelled" ? "cancelled" : res.stats.error ? "failed" : "done", res.stats.error || "");
      if (images.length) this.ctx.waitUntil(this.captionImages(images));
      return res;
    } catch (e: any) {
      console.log("turn failed", e?.message);
      if (top && !jobId) this.set("cursor:" + conv, String(top));
      if (jobId) {
        this.finishJob(jobId, "failed", e?.message || String(e));
        await this.say(conv, "刚才那个活做到一半出错了，没做完：" + clip(e?.message || "未知错误", 80)).catch(() => {});
      }
      return null;
    } finally {
      if (!jobId) this.running.delete(conv);
      this.maybeRestart();
      const cursor = Number(this.get("cursor:" + conv) || 0);
      const more = this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, cursor).toArray()[0].n;
      if (Number(more) && !this.wake.has(conv)) { this.wake.set(conv, Date.now() + 600); setTimeout(() => this.poke(conv), 610); }
    }
  }
  /** Voice messages that came without QQ's own transcript are transcribed before the model reads them. */
  async hearVoices(conv: string, cursor: number) {
    const rows = this.sql.exec("SELECT seq, text, meta FROM msg WHERE conv=? AND seq>? AND role='user' AND meta LIKE '%\"voice\"%' ORDER BY seq DESC LIMIT 3", conv, cursor).toArray() as any[];
    const net = { env: this.env as any, cookie: () => "" };
    await Promise.all(rows.map(async r => {
      const meta = JSON.parse(String(r.meta));
      if (!meta.voice?.length || meta.heard) return;
      let said = "";
      try { const got = await this.fetchBytes(String(meta.voice[0].url), 6 * 1024 * 1024); if (got) said = await hearSilk(net, got.bytes); } catch (e: any) { console.log("voice failed", e?.message); }
      meta.heard = true;
      this.sql.exec("UPDATE msg SET text=?, meta=? WHERE seq=?", String(r.text).replace("[语音 …]", "[语音] " + (said || "（没听清）")), JSON.stringify(meta), r.seq);
    }));
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

  // ---------- nightly memory ----------
  /** Reads everything since the last consolidation, a stretch at a time, and rewrites the memory document. */
  async reflectConv(conv: string, all = false) {
    const from = all ? 0 : Number(this.get("reflect:seq:" + conv) || 0);
    const rows: Row[] = this.sql.exec("SELECT * FROM (SELECT * FROM msg WHERE conv=? AND seq>? ORDER BY seq DESC LIMIT 6000) ORDER BY seq", conv, from).toArray().map(this.rowOf);
    if (rows.filter(r => r.role === "user").length < 3) return { skipped: true };
    const abilities = this.tools(conv).map(t => t.name + "：" + clip(t.description, 46)).join("\n");
    const before = this.get("memory:" + conv) || "";
    let memory = before, notes = this.notes(conv);
    const summaries: string[] = [];
    for (let i = 0; i < rows.length; i += 1200) {
      const part = rows.slice(i, i + 1200);
      const transcript = part.map(r => "[" + fmtFull(r.ts, BJ) + "] " + (r.role === "bot" ? "Bot(你)" : displayName(r)) + "：" + clip(r.text, 600)).join("\n");
      const out = await reflect(this.env, {
        memory, notes, transcript: clip(transcript, 240000), abilities, today: fmtDate(Date.now(), BJ),
        label: fmtFull(part[0].ts, BJ) + " 到 " + fmtFull(part[part.length - 1].ts, BJ) + "（北京时间）",
      });
      memory = out.memory; notes = [];
      if (out.summary) summaries.push(out.summary);
    }
    this.set("memory:prev:" + conv, before);
    this.sql.exec("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", "memory:hist:" + conv + ":" + fmtDate(Date.now(), SYD), before);
    this.sql.exec("DELETE FROM kv WHERE k LIKE ? AND k < ?", "memory:hist:" + conv + ":%", "memory:hist:" + conv + ":" + fmtDate(Date.now() - 14 * 86400000, SYD));
    this.set("memory:" + conv, memory);
    this.set("reflect:seq:" + conv, String(rows[rows.length - 1].seq));
    this.sql.exec("DELETE FROM note WHERE conv=?", conv);
    const summary = summaries.join(" ");
    if (summary) this.sql.exec("INSERT INTO day(conv,date,summary) VALUES(?,?,?) ON CONFLICT(conv,date) DO UPDATE SET summary=excluded.summary",
      conv, fmtDate(rows[rows.length - 1].ts, SYD), clip(summary, 1200));
    return { memory: memory.length, rows: rows.length, summary };
  }

  // ---------- clock ----------
  async alarm() { await this.tick(); }
  async tick() {
    const now = Date.now();
    try {
      await this.gateway.watch(now);
      if (!this.recovered) { this.recovered = true; this.ctx.waitUntil(this.recoverJobs().catch(e => console.log("recover failed", e?.message))); }

      for (const s of this.sql.exec("SELECT * FROM sched WHERE active=1 AND next<=? ORDER BY next LIMIT 3", now).toArray()) {
        const spec = JSON.parse(String(s.spec)), conv = String(s.conv);
        if ([...this.jobs.values()].filter(j => j.conv === conv).length >= JOBS_PER_CONV) continue;
        if (spec.type === "daily") this.sql.exec("UPDATE sched SET next=?, last=? WHERE id=?", nextDaily(spec.time, spec.tz, now, spec.days), now, s.id);
        else this.sql.exec("UPDATE sched SET active=0, last=? WHERE id=?", now, s.id);
        if (now - Number(s.next) < 6 * 3600000) this.ctx.waitUntil(this.runTask(conv, String(s.task)));
      }

      if (this.get("snap:day") !== fmtDate(now, BJ)) { this.set("snap:day", fmtDate(now, BJ)); this.ctx.waitUntil(this.accounts.snapshot().catch(() => {})); }

      // Memory consolidation once a night, at 04:30 Sydney, when the group is asleep.
      const today = fmtDate(now, SYD);
      if (this.get("reflect:day") !== today && now >= zonedToUtc(today, "04:30", SYD)) {
        this.set("reflect:day", today);
        for (const c of this.sql.exec("SELECT DISTINCT conv FROM msg WHERE ts>? AND conv NOT LIKE 't:%'", now - 36 * 3600000).toArray())
          this.ctx.waitUntil(this.reflectConv(String(c.conv)).catch(e => console.log("reflect failed", e?.message)));
      }

      // Self-check once a day, mid-morning in Beijing; only new problems are told to the group.
      const bjDay = fmtDate(now, BJ), main = this.get("main");
      if (main && this.get("health:day") !== bjDay && now >= zonedToUtc(bjDay, "10:30", BJ)) {
        this.set("health:day", bjDay);
        this.ctx.waitUntil(dailyHealth(this).then(fresh => (fresh.length ? this.say(main, "自检发现 " + fresh.length + " 件要处理的事：\n" + fresh.map((c, i) => (i + 1) + ". " + c.text).join("\n")) : false)).catch(e => console.log("health failed", e?.message)));
      }

      // Anything a lost timer left unanswered.
      for (const c of this.sql.exec("SELECT DISTINCT conv FROM msg WHERE role='user' AND ts>? AND ts<?", now - 1800000, now - 12000).toArray()) {
        const conv = String(c.conv);
        if (this.running.has(conv) || this.wake.has(conv)) continue;
        const cursor = Number(this.get("cursor:" + conv) || 0);
        const waiting = this.sql.exec("SELECT COUNT(*) n, SUM(mentioned) m, MAX(ts) t FROM msg WHERE conv=? AND seq>? AND role='user'", conv, cursor).toArray()[0];
        if (Number(waiting.n) && (Number(waiting.m) > 0 || now - Number(waiting.t) < 240000)) this.ctx.waitUntil(this.runConv(conv).catch(() => {}));
      }
      for (const f of FEATURES) { try { await f.tick?.(this, now); } catch (e: any) { console.log("feature tick failed", f.name, e?.message); } }
      if (this.restartWanted) this.maybeRestart();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  // ---------- control surface (the Worker checks the admin token before forwarding here) ----------
  async fetch(req: Request): Promise<Response> {
    try { return await route(this, req); }
    catch (e: any) { return new Response(JSON.stringify({ error: clip(e?.message || String(e), 500) }), { status: 500, headers: { "Content-Type": "application/json" } }); }
  }
  build() { return buildOf(this.env); }
}
