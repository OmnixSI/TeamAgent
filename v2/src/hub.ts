// The whole bot lives in one Durable Object: it holds the QQ connection, stores the chat,
// runs turns one conversation at a time, and wakes itself for schedules and nightly memory work.
import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { displayName, runTurn } from "./core.ts";
import type { Row, TurnResult } from "./core.ts";
import { dsBalance, dsChat } from "./llm.ts";
import { PRICE, setMeter } from "./meter.ts";
import type { Use } from "./meter.ts";
import { caption, reflect } from "./memory.ts";
import { QQ, parseEvent } from "./qq.ts";
import type { Inbound } from "./qq.ts";
import { buildTools } from "./tools.ts";
import type { Host } from "./tools.ts";
import { PLAYBOOKS, PLAYBOOK_LIMIT, TUNABLES, checkTunable } from "./config.ts";
import { BJ, BUILD, SYD, b64, clip, fmtDate, fmtFull, nextDaily, sleep, zonedToUtc } from "./util.ts";
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
  restartWanted = "";

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
      CREATE TABLE IF NOT EXISTS img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT);
      CREATE TABLE IF NOT EXISTS change(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, by TEXT, kind TEXT, key TEXT, before TEXT, after TEXT, reason TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS spend(day TEXT, provider TEXT, item TEXT, unit TEXT, calls INTEGER DEFAULT 0, in_tok INTEGER DEFAULT 0, cached_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, units REAL DEFAULT 0, usd REAL DEFAULT 0, PRIMARY KEY(day, provider, item));
      CREATE TABLE IF NOT EXISTS snap(day TEXT PRIMARY KEY, cny REAL, ts INTEGER);
      CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, kind TEXT, body TEXT, ts INTEGER);
    `);
    setMeter(u => this.record(u));
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

  // ---------- stickers and rendered pages ----------
  stickerNames(conv: string): string[] {
    const of = (c: string) => this.sql.exec("SELECT DISTINCT name FROM img WHERE conv=? AND name LIKE 'sticker:%' ORDER BY name", c).toArray().map((r: any) => String(r.name).slice(8));
    return [...new Set([...of(conv), ...(conv.startsWith("t:") ? of(this.get("main") || "") : [])])];
  }
  async render(page: { html: string; width: number; height: number; full: boolean; selector?: string; settle: number }) {
    const browser = await puppeteer.launch((this.env as any).BROWSER);
    try {
      const tab = await browser.newPage();
      const shoot = async (scale: number, quality: number) => {
        await tab.setViewport({ width: page.width, height: page.height, deviceScaleFactor: scale });
        await tab.setContent(page.html, { waitUntil: "networkidle0", timeout: 25000 }).catch(() => {});
        await sleep(page.settle);
        let clipBox: any, truncated = false;
        if (page.selector) {
          const box = await (await tab.$(page.selector))?.boundingBox();
          if (box && box.width > 120 && box.height > 80) clipBox = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(Math.ceil(box.width), 3200), height: Math.min(Math.ceil(box.height), 7000) };
        }
        if (!clipBox && page.full) {
          const h = Number(await tab.evaluate("document.documentElement.scrollHeight"));
          truncated = h > 7000;
          clipBox = { x: 0, y: 0, width: page.width, height: Math.min(h, 7000) };
        }
        const shot = await tab.screenshot({ type: "jpeg", quality, ...(clipBox ? { clip: clipBox } : {}) });
        return { bytes: new Uint8Array(shot as ArrayBuffer), truncated };
      };
      let out = await shoot(2, 86);
      if (out.bytes.length > 3_500_000) out = await shoot(1, 80);   // very long pages: trade sharpness for a size QQ accepts
      return out;
    } finally { await browser.close().catch(() => {}); }
  }

  // ---------- its own books ----------
  record(u: Use) {
    this.sql.exec(
      "INSERT INTO spend(day,provider,item,unit,calls,in_tok,cached_tok,out_tok,units,usd) VALUES(?,?,?,?,1,?,?,?,?,?) " +
      "ON CONFLICT(day,provider,item) DO UPDATE SET calls=calls+1, in_tok=in_tok+excluded.in_tok, cached_tok=cached_tok+excluded.cached_tok, out_tok=out_tok+excluded.out_tok, units=units+excluded.units, usd=usd+excluded.usd",
      fmtDate(Date.now(), BJ), u.provider, u.item, u.unit || "", u.inTok || 0, u.cachedTok || 0, u.outTok || 0, u.units || 0, u.usd || 0);
  }
  /** DeepSeek balance at the start of each Beijing day; the difference between days is what was really spent. */
  async snapshot() {
    const day = fmtDate(Date.now(), BJ);
    if (this.sql.exec("SELECT 1 FROM snap WHERE day=?", day).toArray().length) return;
    const d: any = await dsBalance(this.env);
    const cny = Number((d.balance_infos || []).find((b: any) => b.currency === "CNY")?.total_balance);
    if (Number.isFinite(cny)) this.sql.exec("INSERT OR IGNORE INTO snap(day,cny,ts) VALUES(?,?,?)", day, cny, Date.now());
  }
  async usage(days: number) {
    await this.snapshot().catch(() => {});
    const since = fmtDate(Date.now() - (days - 1) * 86400000, BJ), today = fmtDate(Date.now(), BJ);
    const rows = this.sql.exec("SELECT * FROM spend WHERE day>=? ORDER BY day DESC, usd DESC", since).toArray();
    const cny = (usd: number) => Math.round(usd * PRICE.dsCnyPerUsd * 1000) / 1000, r4 = (n: number) => Math.round(n * 10000) / 10000;
    const byDay: Record<string, any> = {};
    for (const r of rows as any[]) {
      const d = (byDay[r.day] ||= { date: r.day, deepseek_estimate_cny: 0, openai_estimate_usd: 0, items: [] });
      if (r.provider === "deepseek") d.deepseek_estimate_cny += Number(r.usd) * PRICE.dsCnyPerUsd; else d.openai_estimate_usd += Number(r.usd);
      d.items.push({
        what: r.item, via: r.provider === "deepseek" ? "DeepSeek" : "OpenAI", calls: r.calls,
        ...(r.in_tok || r.out_tok ? { input_tokens: r.in_tok, cached_input_tokens: r.cached_tok, output_tokens: r.out_tok } : {}),
        ...(r.units && r.unit ? { amount: Math.round(Number(r.units) * 10) / 10 + " " + r.unit } : {}),
        cost: r.provider === "deepseek" ? "约 ¥" + cny(Number(r.usd)) : "约 $" + r4(Number(r.usd)),
      });
    }
    let balanceNow: number | null = null;
    try { const d: any = await dsBalance(this.env); balanceNow = Number((d.balance_infos || []).find((b: any) => b.currency === "CNY")?.total_balance); } catch {}
    const snaps = this.sql.exec("SELECT day,cny FROM snap WHERE day>=? ORDER BY day", fmtDate(Date.now() - days * 86400000, BJ)).toArray() as any[];
    const real: any[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const end = i + 1 < snaps.length ? Number(snaps[i + 1].cny) : snaps[i].day === today ? balanceNow : null;
      if (end === null || !Number.isFinite(end)) continue;
      const diff = Math.round((Number(snaps[i].cny) - end) * 100) / 100;
      real.push({ date: snaps[i].day, ...(diff >= 0 ? { really_spent_cny: diff } : { topped_up_cny: -diff }), ...(snaps[i].day === today ? { note: "今天到现在" } : {}) });
    }
    const list = Object.values(byDay).map((d: any) => ({ ...d, deepseek_estimate_cny: Math.round(d.deepseek_estimate_cny * 1000) / 1000, openai_estimate_usd: r4(d.openai_estimate_usd) }));
    return {
      days: list,
      total: { deepseek_estimate_cny: Math.round(list.reduce((n, d: any) => n + d.deepseek_estimate_cny, 0) * 100) / 100, openai_estimate_usd: r4(list.reduce((n, d: any) => n + d.openai_estimate_usd, 0)) },
      deepseek_account: { balance_now_cny: balanceNow, real_spend_by_day: real, note: "真实花费是账户余额的变化，包含这个 key 在别处的用量；记账是从 2026-11-14 晚上开始的，之前的没有明细" },
      about_the_numbers: "DeepSeek 按官方价格表估（工作日北京时间 9–12 点、14–18 点是双倍价），以余额变化为准。OpenAI 是按每次调用返回的用量和官方价格估的美元，真实账单要这把 key 有读账单的权限才能查，现在没有。日期按北京时间。",
    };
  }

  // ---------- the layer the bot may edit by itself ----------
  /** Test rooms read the main group's values unless they have their own. */
  scoped(prefix: string, conv: string, key: string) {
    return this.get(prefix + ":" + conv + ":" + key) ?? (conv.startsWith("t:") ? this.get(prefix + ":" + (this.get("main") || "") + ":" + key) : null);
  }
  cfg(conv: string, key: string): number | string {
    const t = TUNABLES[key], raw = this.scoped("cfg", conv, key);
    if (!t) return 0;
    if (raw === null) return t.default;
    return t.options ? raw : Number(raw);
  }
  play(conv: string, slot: string) { return this.scoped("play", conv, slot) || ""; }
  aliases(conv: string): string[] { try { return JSON.parse(this.scoped("alias", conv, "list") || "[]"); } catch { return []; } }
  isOwner(askers: { id: string; name: string }[]) {
    const owners = (this.get("owners") || (this.env as any).OWNERS || "").split(",").map((x: string) => x.trim()).filter(Boolean);
    return askers.some(a => owners.includes(a.id));
  }
  writeChange(conv: string, kind: string, key: string, value: string) {
    this.set((kind === "config" ? "cfg" : kind === "playbook" ? "play" : "alias") + ":" + conv + ":" + (kind === "alias" ? "list" : key), value);
  }
  async selfUpdate(conv: string, askers: { id: string; name: string }[], a: any) {
    const op = String(a.op || "status"), owner = this.isOwner(askers), by = askers.map(x => x.name || x.id.slice(-4)).join("、") || "（没人，系统任务）";
    const reason = String(a.reason || "").trim();
    if (op === "status") {
      return {
        can_change_myself: "参数、做法说明、别人叫我的名字。代码逻辑（收发、存储、安全、工具实现）我自己改不了，只能写提议。",
        settings: Object.fromEntries(Object.entries(TUNABLES).map(([k, t]) => [k, { now: this.cfg(conv, k), default: t.default, what: t.what, ...(t.options ? { options: t.options } : { min: t.min, max: t.max }) }])),
        playbooks: Object.fromEntries(Object.keys(PLAYBOOKS).map(slot => [slot, { what: PLAYBOOKS[slot], text: this.play(conv, slot) || "（空）" }])),
        aliases: this.aliases(conv),
        recent_changes: this.sql.exec("SELECT id,ts,by,kind,key,after,reason,status FROM change WHERE conv=? ORDER BY id DESC LIMIT 12", conv).toArray()
          .map((r: any) => ({ id: r.id, when: fmtFull(Number(r.ts), BJ), by: r.by, what: r.kind + " " + r.key + " → " + clip(r.after, 80), reason: clip(r.reason, 120), status: r.status })),
      };
    }
    const log = (kind: string, key: string, before: string, after: string, status: string) =>
      Number(this.sql.exec("INSERT INTO change(conv,ts,by,kind,key,before,after,reason,status) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id", conv, Date.now(), by, kind, key, before, after, reason, status).toArray()[0].id);
    if (op === "revert" || op === "apply") {
      if (!owner) return { ok: false, error: "撤销和批准只有群主能做" };
      const row = this.sql.exec("SELECT * FROM change WHERE id=? AND conv=?", Number(a.id), conv).toArray()[0];
      if (!row || row.kind === "code") return { ok: false, error: "没有这条可操作的改动" };
      if (op === "revert" && row.status === "applied") { this.writeChange(conv, String(row.kind), String(row.key), String(row.before)); this.sql.exec("UPDATE change SET status='reverted' WHERE id=?", row.id); return { ok: true, reverted: row.id, restored: clip(row.before, 200) }; }
      if (op === "apply" && row.status === "proposed") { this.writeChange(conv, String(row.kind), String(row.key), String(row.after)); this.sql.exec("UPDATE change SET status='applied' WHERE id=?", row.id); return { ok: true, applied: row.id, now: clip(row.after, 200) }; }
      return { ok: false, error: "这条现在的状态是 " + row.status + "，不能这么操作" };
    }
    if (reason.length < 8) return { ok: false, error: "要写 reason：问题是什么、查到的原因、为什么这样改" };
    if (op === "propose_code") {
      const id = log("code", clip(a.title || "未命名", 80), "", clip(a.text || "", 3000), "proposed");
      return { ok: true, id, note: "已记成第 " + id + " 号改进提议，等维护代码的人处理；这个问题现在还没修好，别说修好了" };
    }
    let kind = "", key = "", before = "", after = "";
    if (op === "set_config") {
      const checked = checkTunable(String(a.key), a.value);
      if (!checked.ok) return { ok: false, error: checked.error };
      kind = "config"; key = String(a.key); before = String(this.cfg(conv, key)); after = String(checked.value);
    } else if (op === "set_playbook") {
      const slot = String(a.slot), text = String(a.text || "").trim();
      if (!PLAYBOOKS[slot]) return { ok: false, error: "slot 只能是 " + Object.keys(PLAYBOOKS).join(" / ") };
      if (!text && a.mode !== "replace") return { ok: false, error: "要写 text" };
      kind = "playbook"; key = slot; before = this.play(conv, slot);
      after = a.mode === "replace" ? text : (before ? before + "\n" : "") + "· " + text.replace(/^[·\-\s]+/, "");
      if (after.length > PLAYBOOK_LIMIT) return { ok: false, error: "这段做法说明超过 " + PLAYBOOK_LIMIT + " 字了，先用 mode=replace 合并精简再加" };
    } else if (op === "add_alias" || op === "remove_alias") {
      const alias = String(a.alias || "").trim(), list = this.aliases(conv);
      if (alias.length < 2 || alias.length > 12) return { ok: false, error: "名字要 2 到 12 个字" };
      kind = "alias"; key = alias; before = JSON.stringify(list);
      after = JSON.stringify(op === "add_alias" ? [...new Set([...list, alias])].slice(0, 12) : list.filter(x => x !== alias));
    } else return { ok: false, error: "不认识的 op" };
    if (before === after) return { ok: true, unchanged: true, now: clip(after, 200) };
    if (!owner) {
      const id = log(kind, key, before, after, "proposed");
      return { ok: false, needs_owner: true, id, note: "改自己的设置要群主点头。已记成第 " + id + " 号提议，群主说同意后用 op=apply 生效；现在还没改" };
    }
    this.writeChange(conv, kind, key, after);
    const id = log(kind, key, before, after, "applied");
    return { ok: true, id, before: clip(before, 200) || "（空）", now: clip(after, 300), undo: "群主说撤销第 " + id + " 号就能改回去" };
  }

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
    const conv = type === "C2C_MESSAGE_CREATE" ? "u:" + String(d.author?.user_openid || d.author?.id || "") : "g:" + String(d.group_openid);
    const m = parseEvent(type, d, this.aliases(conv));
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
    const due = Math.min(now + Number(this.cfg(m.conv, m.mentioned ? "wait_called_ms" : "wait_chat_ms")), Math.max(first + Number(this.cfg(m.conv, "wait_max_ms")), now + 200));
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
  async say(conv: string, text: string, opts: { queue?: boolean; quote?: string } = {}) {
    const record = (id: string) => this.insert(conv, { id: "bot:" + id, role: "bot", name: "Bot", text, ts: Date.now() });
    if (conv.startsWith("t:")) { record(crypto.randomUUID()); return true; }
    const id = this.anchor(conv);
    const r = await this.qq.sendText(conv, text, id, opts.quote).catch(() => null);
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
  /** fileType 1 = image, 3 = voice (SILK), 4 = file. */
  async sendMediaMessage(conv: string, fileType: number, dataB64: string, label: string, fileName?: string) {
    if (conv.startsWith("t:")) { this.insert(conv, { id: "bot:" + crypto.randomUUID(), role: "bot", name: "Bot", text: label, ts: Date.now() }); return { ok: true }; }
    const id = this.anchor(conv);
    const r = await this.qq.sendMedia(conv, fileType, dataB64, id, fileName).catch((e: any) => ({ ok: false, status: 0, data: { message: e?.message }, stage: "network" }));
    if (!r.ok) return { ok: false, error: (r.stage === "upload" ? "上传被拒" : "发送被拒") + "（" + r.status + " " + clip(r.data?.message || r.data?.code || "", 80) + "）" };
    this.used(id);
    this.insert(conv, { id: "bot:" + String(r.data?.id || crypto.randomUUID()), role: "bot", name: "Bot", text: label, ts: Date.now() });
    return { ok: true };
  }
  /** Keeps a picture so it can be referenced later ("g12"); unnamed ones are trimmed to the latest 40. */
  keepImage(conv: string, bytes: Uint8Array, mime: string, note: string) {
    if (bytes.length > 1_800_000) return "";
    const row = this.sql.exec("INSERT INTO img(conv,ts,mime,data,note) VALUES(?,?,?,?,?) RETURNING id", conv, Date.now(), mime, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), note).toArray()[0];
    this.sql.exec("DELETE FROM img WHERE conv=? AND name IS NULL AND id NOT IN (SELECT id FROM img WHERE conv=? AND name IS NULL ORDER BY id DESC LIMIT 40)", conv, conv);
    return "g" + row.id;
  }
  async sendImage(conv: string, bytes: Uint8Array, note: string, mime = "image/jpeg") {
    const id = this.keepImage(conv, bytes, mime, note);
    const r = await this.sendMediaMessage(conv, 1, b64(bytes), "[你发了一张图" + (id ? " " + id : "") + "：" + clip(note, 60) + "]");
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
  async imageRef(conv: string, ref: string) {
    const label = ref.trim().replace(/^\[?图片\s*/, "").replace(/\]$/, "");
    const stored = (row: any) => row ? { label, bytes: new Uint8Array(row.data as ArrayBuffer), mime: String(row.mime || "image/jpeg") } : null;
    const g = label.match(/^g(\d+)$/i);
    if (g) return stored(this.sql.exec("SELECT data,mime FROM img WHERE id=?", Number(g[1])).toArray()[0]);
    let url = /^https?:\/\//.test(label) ? label : "";
    const chat = label.match(/^(\d+)-(\d+)$/);
    if (chat) {
      const row = this.sql.exec("SELECT meta FROM msg WHERE seq=? AND conv=?", Number(chat[1]), conv).toArray()[0];
      url = row?.meta ? JSON.parse(String(row.meta)).images?.[Number(chat[2])]?.url || "" : "";
    }
    if (!url) {
      // Saved characters; private test rooms borrow the main group's.
      const named = (c: string) => this.sql.exec("SELECT data,mime FROM img WHERE conv=? AND name=? ORDER BY id DESC LIMIT 1", c, label).toArray()[0];
      return stored(named(conv) || (conv.startsWith("t:") ? named(this.get("main") || "") : null));
    }
    const got = await this.fetchBytes(url, 8 * 1024 * 1024);
    return got ? { label, bytes: got.bytes, mime: got.mime.startsWith("image/") ? got.mime : "image/jpeg" } : null;
  }

  // ---------- turns ----------
  host(conv: string, askers: { id: string; name: string }[] = []): Host {
    const hub = this;
    return {
      usage: days => hub.usage(days),
      sandbox: (id, opened) => {
        if (id) { if (opened || hub.get("sandbox:id") !== id) { hub.set("sandbox:id", id); hub.set("sandbox:at", String(Date.now())); } return id; }
        // A session is paid for 20 minutes; stop reusing it a little before that.
        return Date.now() - Number(hub.get("sandbox:at") || 0) < 17 * 60000 ? hub.get("sandbox:id") || "" : "";
      },
      render: page => hub.render(page),
      stickerNames: () => hub.stickerNames(conv),
      sendSticker: async name => {
        const lib = hub.stickerNames(conv), pick = lib.includes(name) ? name : lib.find(n => n.includes(name) || name.includes(n));
        const owner = hub.sql.exec("SELECT COUNT(*) n FROM img WHERE conv=? AND name=?", conv, "sticker:" + pick).toArray()[0].n ? conv : hub.get("main") || conv;
        const row = pick ? hub.sql.exec("SELECT data,mime FROM img WHERE conv=? AND name=? ORDER BY id DESC LIMIT 1", owner, "sticker:" + pick).toArray()[0] : null;
        if (!row) return { ok: false, error: "没有叫这个名字的表情包，现有的：" + lib.join("、") };
        return hub.sendMediaMessage(conv, 1, b64(new Uint8Array(row.data as ArrayBuffer)), "[你发了表情包：" + pick + "]");
      },
      saveSticker: async (ref, name) => {
        const img = await hub.imageRef(conv, ref), clean = name.trim().slice(0, 16);
        if (!img || !clean || img.bytes.length > 1_500_000) return false;
        hub.sql.exec("DELETE FROM img WHERE conv=? AND name=?", conv, "sticker:" + clean);
        hub.sql.exec("INSERT INTO img(conv,ts,mime,data,note,name) VALUES(?,?,?,?,?,?)", conv, Date.now(), img.mime, img.bytes.buffer.slice(img.bytes.byteOffset, img.bytes.byteOffset + img.bytes.byteLength), "表情包", "sticker:" + clean);
        return true;
      },
      cfg: key => hub.cfg(conv, key),
      play: slot => hub.play(conv, slot),
      selfUpdate: args => hub.selfUpdate(conv, askers, args),
      chatCsv: days => {
        const rows = hub.sql.exec("SELECT ts,name,role,text FROM msg WHERE conv=? AND ts>? ORDER BY seq", conv, Date.now() - days * 86400000).toArray();
        const cell = (v: string) => '"' + v.replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
        return new TextEncoder().encode("\ufefftime,name,text\n" + rows.map((r: any) => [fmtDate(Number(r.ts), BJ) + " " + new Date(Number(r.ts) + 8 * 3600000).toISOString().slice(11, 19), r.role === "bot" ? "Bot" : String(r.name || "成员"), String(r.text || "")].map(cell).join(",")).join("\n"));
      },
      env: this.env, now: () => Date.now(),
      sendImage: (bytes, note, mime) => hub.sendImage(conv, bytes, note, mime),
      sendFile: (name, bytes) => hub.sendMediaMessage(conv, 4, b64(bytes), "[你发了一个文件：" + name + "]", name),
      imageRef: ref => hub.imageRef(conv, ref),
      nameImage: async (ref, name) => {
        const img = await hub.imageRef(conv, ref);
        if (!img || img.bytes.length > 1_800_000) return false;
        hub.sql.exec("DELETE FROM img WHERE conv=? AND name=?", conv, name);
        hub.sql.exec("INSERT INTO img(conv,ts,mime,data,note,name) VALUES(?,?,?,?,?,?)", conv, Date.now(), img.mime, img.bytes.buffer.slice(img.bytes.byteOffset, img.bytes.byteOffset + img.bytes.byteLength), "参考图", name);
        return true;
      },
      fileRef: async ref => {
        if (/^https?:\/\//.test(ref.trim())) {
          const got = await hub.fetchBytes(ref.trim(), 30 * 1024 * 1024);
          const named = hub.sql.exec("SELECT meta FROM msg WHERE conv=? AND meta LIKE ? ORDER BY seq DESC LIMIT 1", conv, "%" + ref.trim().slice(0, 80) + "%").toArray()[0];
          const name = named?.meta ? (JSON.parse(String(named.meta)).files || []).find((f: any) => f.url === ref.trim())?.name : "";
          return got ? { name: name || decodeURIComponent(ref.split("/").pop()?.split("?")[0] || "input.bin"), bytes: got.bytes } : null;
        }
        const img = await hub.imageRef(conv, ref);
        return img ? { name: "image-" + ref.replace(/[^0-9a-z-]/gi, "") + "." + (img.mime.split("/")[1] || "jpg"), bytes: img.bytes } : null;
      },
      status: () => {
        const n = (q: string, ...b: any[]) => Number(hub.sql.exec(q, ...b).toArray()[0].n);
        const real = conv.startsWith("t:") ? hub.get("main") || conv : conv;
        return {
          gateway_connected: !!hub.ws,
          messages: n("SELECT COUNT(*) n FROM msg WHERE conv=?", real),
          saved_images: n("SELECT COUNT(*) n FROM img WHERE conv=?", real),
          saved_characters: hub.sql.exec("SELECT DISTINCT name FROM img WHERE conv=? AND name IS NOT NULL AND name NOT LIKE 'sticker:%'", real).toArray().map((r: any) => String(r.name)),
          schedules: hub.sql.exec("SELECT spec,task FROM sched WHERE conv=? AND active=1 ORDER BY next", real).toArray().map((r: any) => {
            const spec = JSON.parse(String(r.spec));
            return { when: spec.type === "daily" ? "每天 " + spec.time + "（" + (spec.tz === BJ ? "北京" : "悉尼") + "时间）" : "一次性 " + fmtFull(Number(spec.at), BJ) + " 北京时间", task: clip(r.task, 80) };
          }),
          logins: hub.sql.exec("SELECT k FROM kv WHERE k LIKE 'cookie:%'").toArray().map((r: any) => ({ bili: "B 站", xhs: "小红书", zhihu: "知乎", douyin: "抖音", x: "X" } as Record<string, string>)[String(r.k).slice(7)] || String(r.k).slice(7)),
          memory_chars: (hub.get("memory:" + real) || "").length,
          notes_today: n("SELECT COUNT(*) n FROM note WHERE conv=?", real),
          last_24h: hub.sql.exec("SELECT kind, COUNT(*) c, AVG(ms) m FROM turn WHERE conv=? AND ts>? GROUP BY kind", real, Date.now() - 86400000).toArray()
            .map((r: any) => ({ kind: ({ chat: "没人叫我的闲聊", called: "被叫到的回复", task: "定时或交办任务", stale: "来不及接的话" } as Record<string, string>)[String(r.kind)] || String(r.kind), turns: Number(r.c), avg_seconds: Math.round(Number(r.m) / 100) / 10 })),
          last_memory_consolidation: hub.get("reflect:day"),
        };
      },
      members: () => {
        const real = conv.startsWith("t:") ? hub.get("main") || conv : conv;
        return hub.sql.exec("SELECT name, COUNT(*) c FROM msg WHERE conv=? AND role='user' AND name IS NOT NULL AND name<>'' GROUP BY name ORDER BY c DESC LIMIT 12", real).toArray().map((r: any) => String(r.name));
      },
      savedNames: () => {
        const of = (c: string) => hub.sql.exec("SELECT DISTINCT name FROM img WHERE conv=? AND name IS NOT NULL AND name NOT LIKE 'sticker:%'", c).toArray().map((r: any) => String(r.name));
        return [...new Set([...of(conv), ...(conv.startsWith("t:") ? of(hub.get("main") || "") : [])])];
      },
      stats: days => hub.sql.exec(
        "SELECT date(ts/1000 + 28800, 'unixepoch') d, COALESCE(NULLIF(name,''), '成员') n, COUNT(*) c, SUM(length(text)) ch FROM msg WHERE conv=? AND role='user' AND ts>? GROUP BY d, n ORDER BY d DESC, c DESC",
        conv, Date.now() - days * 86400000).toArray().map((r: any) => ({ date: String(r.d), name: String(r.n), count: Number(r.c), chars: Number(r.ch) })),
      recentLines: n => hub.recent(conv, n).map(r => (r.role === "bot" ? "Bot" : displayName(r)) + "：" + clip(r.text, 300)).join("\n"),
      memory: () => hub.get("memory:" + conv) || "",
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
      cookie: site => hub.get("cookie:" + site) || "",
      sendVoice: silk => hub.sendMediaMessage(conv, 3, silk, "[你发了一条语音]"),
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
  /**
   * What the model reads each turn: everything since last night's consolidation plus a carry-over tail,
   * so a whole day of chat stays in view. The start only moves in steps of 100, which keeps the
   * model's prompt cache hitting; older days live on in the memory document.
   */
  window(conv: string) {
    const since = Number(this.get("reflect:seq:" + conv) || 0);
    const rows: Row[] = this.sql.exec("SELECT * FROM (SELECT * FROM msg WHERE conv=? AND seq>? ORDER BY seq DESC LIMIT 900) ORDER BY seq", conv, since - Number(this.cfg(conv, "history_carry"))).toArray().map(this.rowOf);
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
    this.sql.exec("INSERT INTO turn(conv,ts,kind,ms,first_ms,calls,tools,in_tok,out_tok,cached,said,err) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      conv, Date.now(), kind, s.ms, s.firstMs, s.calls, s.tools.join(","), s.inTok, s.outTok, s.cached, res.silent ? "" : clip(res.replies.join(" ‖ "), 300), s.error || null);
    this.sql.exec("DELETE FROM turn WHERE id < (SELECT MAX(id) FROM turn) - 3000");
  }
  deps(conv: string, interim: boolean, askers: { id: string; name: string }[] = []) {
    return {
      chat: (body: any, effort: any, timeout?: number) => dsChat(this.env, { ...body, label: "聊天" }, effort, timeout),
      tools: buildTools(this.host(conv, askers)),
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
      const askers = fresh.filter(r => r.mentioned).map(r => ({ id: String(r.sender || ""), name: displayName(r) }));
      const res = await runTurn(
        {
          rows, cursor, mentioned, memory: this.get("memory:" + conv) || "", notes: this.notes(conv), now: Date.now(), images,
          rules: this.play(conv, "persona"), askers: askers.map(a => a.name), talkative: String(this.cfg(conv, "talkative")), splitMax: Number(this.cfg(conv, "reply_split_max")),
        },
        this.deps(conv, true, askers),
      );
      this.set("cursor:" + conv, String(top));
      // A casual remark that the chat has already moved past is dropped; the next turn sees everything.
      const newer = Number(this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, top).toArray()[0].n);
      const stale = !mentioned && (newer >= 3 || (newer >= 1 && res.stats.ms > 9000));
      if (!res.silent && !stale) {
        // When one person asked and the chat has moved on since, quote their message so it is clear who is being answered.
        const asked = fresh.filter(r => r.mentioned);
        const one = new Set(asked.map(r => r.sender)).size === 1 ? asked[asked.length - 1] : null;
        const movedOn = one ? Number(this.sql.exec("SELECT COUNT(*) n FROM msg WHERE conv=? AND seq>? AND role='user'", conv, one.seq).toArray()[0].n) > 0 : false;
        const quote = one && movedOn && Date.now() - one.ts < REPLY_WINDOW_MS ? one.id : undefined;
        for (let i = 0; i < res.replies.length; i++) {
          if (i) await sleep(Math.min(1400, 350 + res.replies[i].length * 35));
          await this.say(conv, res.replies[i], { queue: mentioned, quote: i === 0 ? quote : undefined });
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
      this.maybeRestart();
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
        { rows, cursor: top, mentioned: false, memory: this.get("memory:" + conv) || "", notes: this.notes(conv), now: Date.now(), task, rules: this.play(conv, "persona") },
        this.deps(conv, false),
      );
      if (!res.silent) for (const reply of res.replies) await this.say(conv, reply);
      this.logTurn(conv, "task", res);
      return true;
    } finally { this.running.delete(conv); this.maybeRestart(); }
  }
  /** A new build waits for the turns in flight to finish, so nobody's answer is cut off. */
  maybeRestart() {
    if (!this.restartWanted || this.running.size) return;
    const why = this.restartWanted; this.restartWanted = "";
    this.closeWs();
    this.ctx.storage.setAlarm(Date.now() + 1500).then(() => this.ctx.abort("restart for " + why));
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

      if (this.get("snap:day") !== fmtDate(now, BJ)) { this.set("snap:day", fmtDate(now, BJ)); this.ctx.waitUntil(this.snapshot().catch(() => {})); }

      // Memory consolidation once a night, at 04:30 Sydney, when the group is asleep.
      const today = fmtDate(now, SYD);
      if (this.get("reflect:day") !== today && now >= zonedToUtc(today, "04:30", SYD)) {
        this.set("reflect:day", today);
        for (const c of this.sql.exec("SELECT DISTINCT conv FROM msg WHERE ts>? AND conv NOT LIKE 't:%'", now - 36 * 3600000).toArray())
          this.ctx.waitUntil(this.reflectConv(String(c.conv)).catch(e => console.log("reflect failed", e?.message)));
      }

      // Anything a lost timer left unanswered.
      for (const c of this.sql.exec("SELECT DISTINCT conv FROM msg WHERE role='user' AND ts>? AND ts<?", now - 1800000, now - 12000).toArray()) {
        const conv = String(c.conv);
        if (this.running.has(conv) || this.wake.has(conv)) continue;
        const cursor = Number(this.get("cursor:" + conv) || 0);
        const waiting = this.sql.exec("SELECT COUNT(*) n, SUM(mentioned) m, MAX(ts) t FROM msg WHERE conv=? AND seq>? AND role='user'", conv, cursor).toArray()[0];
        if (Number(waiting.n) && (Number(waiting.m) > 0 || now - Number(waiting.t) < 240000)) this.ctx.waitUntil(this.runConv(conv).catch(() => {}));
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

    if (path === "/tick" || path === "/admin/restart") {
      // A deploy does not replace an object that is holding a live connection, so it steps aside itself.
      const want = url.searchParams.get("build");
      if (path === "/admin/restart" || (want && want !== BUILD)) {
        this.restartWanted = "build " + (want || "manual");
        if (this.running.size) return json({ ok: true, build: BUILD, restart: "after " + this.running.size + " running turn(s)" });
        this.maybeRestart();
      }
      await this.tick();
      return json({ ok: true, build: BUILD });
    }
    if (path === "/event") { await this.onEvent(String(body.t), body.d); return json({ op: 12, d: 0 }); }
    if (path === "/admin/status") {
      const count = (q: string, ...b: any[]) => Number(this.sql.exec(q, ...b).toArray()[0].n);
      return json({
        build: BUILD,
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
      this.insert(test, { id: "dry:" + crypto.randomUUID(), role: "user", sender: body.sender || "tester", name: body.name || "测试员", text: String(body.text || ""), ts: Date.now(), mentioned: body.mentioned !== false, meta: body.meta });
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
    if (path === "/admin/usage") return json(await this.usage(Number(url.searchParams.get("days") || 3)));
    if (path === "/admin/changes") return json(this.sql.exec("SELECT * FROM change ORDER BY id DESC LIMIT ?", Number(url.searchParams.get("n") || 30)).toArray());
    if (path === "/admin/img") {
      if (body.delete) { this.sql.exec("DELETE FROM img WHERE id=?", Number(body.delete)); return json({ ok: true }); }
      if (body.name && body.url) {
        const got = await this.fetchBytes(String(body.url), 1_800_000);
        if (!got) return json({ error: "fetch failed" }, 400);
        this.sql.exec("DELETE FROM img WHERE conv=? AND name=?", conv, String(body.name));
        this.sql.exec("INSERT INTO img(conv,ts,mime,data,note,name) VALUES(?,?,?,?,?,?)", conv, Date.now(), got.mime || "image/png", got.bytes.buffer.slice(got.bytes.byteOffset, got.bytes.byteOffset + got.bytes.byteLength), "参考图", String(body.name));
        return json({ ok: true, bytes: got.bytes.length });
      }
      const id = url.searchParams.get("id");
      if (!id) return json(this.sql.exec("SELECT id,conv,ts,mime,length(data) bytes,note,name FROM img ORDER BY id DESC LIMIT 30").toArray());
      const row = this.sql.exec("SELECT data,mime FROM img WHERE id=?", Number(id)).toArray()[0];
      return row ? new Response(row.data as ArrayBuffer, { headers: { "Content-Type": String(row.mime) } }) : json({ error: "no such image" }, 404);
    }
    if (path === "/admin/cookie") {
      if (typeof body.cookie === "string" && body.site) this.set("cookie:" + body.site, body.cookie);
      return json(this.sql.exec("SELECT k, length(v) n FROM kv WHERE k LIKE 'cookie:%'").toArray());
    }
    if (path === "/admin/tool") {
      // Run one tool by hand, as the given conversation would.
      const tool = buildTools(this.host(conv)).find(t => t.name === body.name);
      if (!tool) return json({ error: "no such tool" }, 404);
      const started = Date.now();
      try { return json({ ms: Date.now() - started, result: await tool.run(body.args || {}) }); }
      catch (e: any) { return json({ ms: Date.now() - started, error: clip(e?.message || String(e), 400) }); }
    }
    if (path === "/admin/probe") {
      // Debug aid: what a URL looks like when fetched from Cloudflare.
      const r = await fetch(String(body.url), { method: body.method || "GET", headers: body.headers || {}, body: body.body, redirect: body.redirect || "follow", signal: AbortSignal.timeout(25000) });
      const buf = new Uint8Array(await r.arrayBuffer());
      const text = new TextDecoder(body.charset || "utf-8").decode(buf.slice(0, Number(body.max) || 1500));
      return json({ status: r.status, url: r.url, type: r.headers.get("content-type"), location: r.headers.get("location"), bytes: buf.length, text });
    }
    if (path === "/admin/task") return json({ ran: await this.runTask(conv, String(body.task)) });
    if (path === "/admin/set") { this.set(String(body.k), String(body.v)); return json({ ok: true }); }
    return json({ error: "not found" }, 404);
  }
}
