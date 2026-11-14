// Daily copy of everything the bot knows to R2. The Hub's SQLite is the only place that data lives, so this
// is the only other copy. Output is built in small pieces and streamed (gzip, multipart upload) so the
// Durable Object never holds more than a few MB of it at once.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import { BJ, b64, fmtDate, unb64, zonedToUtc } from "../util.ts";

/** Knobs the tests turn down. */
export const LIMITS = { page: 2000, part: 5 * 1024 * 1024, mediaRaw: 60 * 1024 * 1024, chunk: 256 * 1024 };

const START_TIME = "03:10";
const KEEP_DAILY = 30, KEEP_MONTHS = 12;
/** Keys in kv that are not copied (and never touched by a restore). `backup:` is this feature's own bookkeeping. */
const KV_SKIP = ["cookie:", "quota:", "plan:", "scratch:", "backup:"];
const STAGE = "_bk_";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const q = (id: string) => '"' + id.replace(/"/g, '""') + '"';
const mb = (n: number) => Math.round(n / 1048576 * 10) / 10;

type Col = { name: string; blob: boolean };
type TableInfo = { name: string; cols: Col[]; rowid: boolean; pk: string[] };
type Part = { partNumber: number; etag: string };

const running = new WeakSet<object>();

// ---------- tables ----------
export function tables(hub: Hub): TableInfo[] {
  const rows = hub.sql.exec("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE ? ORDER BY name", STAGE + "%").toArray();
  const out: TableInfo[] = [];
  for (const r of rows) {
    const ddl = String(r.sql || "");
    if (/^\s*CREATE\s+VIRTUAL/i.test(ddl)) continue;
    const info = hub.sql.exec("PRAGMA table_info(" + q(String(r.name)) + ")").toArray();
    out.push({
      name: String(r.name),
      cols: info.map((c: any) => ({ name: String(c.name), blob: /BLOB/i.test(String(c.type || "")) })),
      rowid: !/WITHOUT\s+ROWID/i.test(ddl),
      pk: info.filter((c: any) => Number(c.pk) > 0).sort((a: any, b: any) => Number(a.pk) - Number(b.pk)).map((c: any) => String(c.name)),
    });
  }
  return out;
}
const kvSkip = (col = "k") => KV_SKIP.map(p => `substr(${col},1,${p.length})<>'${p}'`).join(" AND ");

// ---------- streaming upload ----------
/** Collects compressed bytes and sends them to R2: one put when small, a multipart upload when not. */
class Upload {
  private hub: Hub; private key: string;
  private pending: Uint8Array[] = []; private plen = 0;
  private mp: any = null; private parts: Part[] = [];
  bytes = 0; writes = 0;
  constructor(hub: Hub, key: string) { this.hub = hub; this.key = key; }
  private spend() { if (!this.hub.plan.take("r2_writes", 1)) throw new Error("R2 写入额度用完了"); this.writes++; }
  private join() {
    const all = new Uint8Array(this.plen);
    let at = 0;
    for (const c of this.pending) { all.set(c, at); at += c.length; }
    this.pending = []; this.plen = 0;
    return all;
  }
  async push(chunk: Uint8Array) {
    this.pending.push(chunk); this.plen += chunk.length; this.bytes += chunk.length;
    if (this.plen < LIMITS.part) return;
    if (!this.mp) { this.spend(); this.mp = await this.hub.env.FILES.createMultipartUpload(this.key); }
    let all = this.join();
    while (all.length >= LIMITS.part) {
      this.spend();
      this.parts.push(await this.mp.uploadPart(this.parts.length + 1, all.slice(0, LIMITS.part)));
      all = all.subarray(LIMITS.part);
    }
    if (all.length) { this.pending.push(all.slice()); this.plen = all.length; }
  }
  async finish() {
    if (!this.mp) { this.spend(); await this.hub.env.FILES.put(this.key, this.join()); return; }
    if (this.plen) { this.spend(); this.parts.push(await this.mp.uploadPart(this.parts.length + 1, this.join())); }
    this.spend();
    await this.mp.complete(this.parts);
  }
  async abort() { try { await this.mp?.abort(); } catch {} }
}

/** Runs `fill` with a function that appends text lines, gzips it all, and uploads it to `key`. */
async function gzipTo(hub: Hub, key: string, fill: (line: (s: string) => Promise<void>) => Promise<void>) {
  const up = new Upload(hub, key), enc = new TextEncoder();
  const cs = new CompressionStream("gzip"), w = cs.writable.getWriter();
  const pump = (async () => { const r = cs.readable.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; await up.push(value); } })();
  let buf = "", raw = 0;
  const flush = async () => { if (!buf) return; const b = enc.encode(buf); raw += b.length; buf = ""; await w.write(b); };
  try {
    await fill(async s => { buf += s + "\n"; if (buf.length >= LIMITS.chunk) await flush(); });
    await flush(); await w.close(); await pump; await up.finish();
  } catch (e) {
    try { await w.abort(e); } catch {}
    await pump.catch(() => {});
    await up.abort();
    throw e;
  }
  return { key, bytes: up.bytes, raw_bytes: raw, writes: up.writes };
}

// ---------- backup ----------
export type Manifest = any;

async function writeCore(hub: Hub, date: string) {
  const rows: Record<string, number> = {}, omitted: Record<string, string[]> = {}, skipped: any = {};
  const file = await gzipTo(hub, `backup/${date}/core.jsonl.gz`, async line => {
    for (const t of tables(hub)) {
      const cols = t.cols.filter(c => !c.blob);
      if (cols.length < t.cols.length) omitted[t.name] = t.cols.filter(c => c.blob).map(c => c.name);
      if (!cols.length) continue;
      const list = cols.map(c => q(c.name)).join(","), skipKv = t.name === "kv" ? kvSkip() : "";
      let n = 0, last = 0, offset = 0;
      for (;;) {
        let page: any[];
        if (t.rowid) page = hub.sql.exec(`SELECT rowid AS __rid, ${list} FROM ${q(t.name)} WHERE rowid>?${skipKv ? " AND " + skipKv : ""} ORDER BY rowid LIMIT ?`, last, LIMITS.page).toArray();
        else {
          const order = (t.pk.length ? t.pk : cols.map(c => c.name)).map(q).join(",");
          page = hub.sql.exec(`SELECT ${list} FROM ${q(t.name)} ORDER BY ${order} LIMIT ? OFFSET ?`, LIMITS.page, offset).toArray();
          offset += page.length;
        }
        for (const r of page) {
          const { __rid, ...row } = r;
          for (const k in row) if (row[k] instanceof ArrayBuffer || ArrayBuffer.isView(row[k])) delete row[k];
          await line(JSON.stringify({ t: t.name, r: row }));
          if (__rid !== undefined) last = Number(__rid);
          n++;
        }
        if (page.length < LIMITS.page) break;
      }
      rows[t.name] = n;
      if (skipKv) {
        for (const p of KV_SKIP) {
          const c = Number(hub.sql.exec("SELECT COUNT(*) n FROM kv WHERE substr(k,1,?)=?", p.length, p).toArray()[0].n);
          if (c) (skipped.kv_keys ||= {})[p + "*"] = c;
        }
      }
    }
  });
  return { file, rows, omitted, skipped };
}

async function writeMedia(hub: Hub, date: string) {
  const metaCols = ["id", "conv", "ts", "mime", "note", "name", "src", "made", "size", "r2"];
  const have = new Set(hub.sql.exec("PRAGMA table_info(img)").toArray().map((c: any) => String(c.name)));
  const cols = metaCols.filter(c => have.has(c));
  const ids = hub.sql.exec("SELECT id, name, length(data) n FROM img WHERE name IS NOT NULL AND r2 IS NULL AND data IS NOT NULL ORDER BY id").toArray();
  const inR2 = Number(hub.sql.exec("SELECT COUNT(*) n FROM img WHERE name IS NOT NULL AND r2 IS NOT NULL").toArray()[0].n);
  const skipped: any[] = []; let total = 0, count = 0;
  const file = await gzipTo(hub, `backup/${date}/media.jsonl.gz`, async line => {
    for (const x of ids) {
      const n = Number(x.n || 0);
      if (total + n > LIMITS.mediaRaw) { skipped.push({ id: Number(x.id), name: String(x.name), bytes: n }); continue; }
      const r = hub.sql.exec(`SELECT ${cols.map(q).join(",")}, data FROM img WHERE id=?`, x.id).toArray()[0];
      if (!r?.data) continue;
      const { data, ...row } = r;
      await line(JSON.stringify({ t: "img", r: row, data: b64(new Uint8Array(data)) }));
      total += n; count++;
    }
  });
  return { file, rows: count, raw_picture_bytes: total, skipped, in_r2_not_copied: inR2 };
}

/** Which dates to keep: the newest 30, plus the first backup of each of the last 12 calendar months. */
export function retain(dates: string[], today: string) {
  const sorted = [...new Set(dates)].sort();
  const keep = new Set(sorted.slice(-KEEP_DAILY));
  const [ty, tm] = today.split("-").map(Number), floor = ty * 12 + tm - 1 - (KEEP_MONTHS - 1);
  const seen = new Set<string>();
  for (const d of sorted) {
    const month = d.slice(0, 7);
    if (seen.has(month)) continue;
    seen.add(month);
    const [y, m] = d.split("-").map(Number);
    if (y * 12 + m - 1 >= floor) keep.add(d);
  }
  return { keep: sorted.filter(d => keep.has(d)), drop: sorted.filter(d => !keep.has(d)) };
}

async function listAll(hub: Hub) {
  const out: { key: string; size: number; uploaded?: number }[] = [];
  let cursor: string | undefined;
  for (;;) {
    hub.plan.add("r2_writes", 1);          // a listing is billed like a write
    const r = await hub.env.FILES.list({ prefix: "backup/", cursor });
    for (const o of r.objects) out.push({ key: String(o.key), size: Number(o.size), uploaded: o.uploaded ? +new Date(o.uploaded) : undefined });
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
}
const dateOf = (key: string) => key.match(/^backup\/(\d{4}-\d{2}-\d{2})\//)?.[1] || "";

export async function runBackup(hub: Hub, now: number, opts: { media?: boolean } = {}): Promise<Manifest> {
  if (!hub.env.FILES) throw new Error("没有 R2 存储桶");
  if (running.has(hub)) throw new Error("备份正在进行");
  running.add(hub);
  const t0 = Date.now(), date = fmtDate(now, BJ);
  try {
    // core file, media file (Sundays), manifest, and one listing
    if (!hub.plan.fits("r2_writes", 6)) throw new Error("R2 写入额度用完了");
    const core = await writeCore(hub, date);
    let media: Awaited<ReturnType<typeof writeMedia>> | null = null;
    const sunday = new Date(date + "T00:00:00Z").getUTCDay() === 0;
    if (opts.media ?? sunday) media = await writeMedia(hub, date);

    const files = await listAll(hub);
    const { drop } = retain(files.map(f => dateOf(f.key)).filter(Boolean), date);
    const doomed = files.filter(f => drop.includes(dateOf(f.key)));
    for (let i = 0; i < doomed.length; i += 500) await hub.env.FILES.delete(doomed.slice(i, i + 500).map(f => f.key));
    const dead = new Set(doomed.map(f => f.key));
    const kept = files.filter(f => !dead.has(f.key) && f.key !== `backup/${date}/manifest.json`);

    const manifest: Manifest = {
      date, started: new Date(t0).toISOString(), finished: "", seconds: 0, version: hub.build(),
      tables: core.rows, omitted_binary_columns: core.omitted, skipped: core.skipped,
      files: {
        core: { key: core.file.key, bytes: core.file.bytes, raw_bytes: core.file.raw_bytes },
        ...(media ? { media: { key: media.file.key, bytes: media.file.bytes, raw_picture_bytes: media.raw_picture_bytes, pictures: media.rows } } : {}),
      },
      ...(media ? { media_skipped: { over_size_cap: media.skipped, already_in_r2: media.in_r2_not_copied } } : {}),
      retention: { deleted_dates: drop, kept_dates: kept.map(f => dateOf(f.key)).filter((d, i, a) => d && a.indexOf(d) === i).length },
      r2_writes: core.file.writes + (media?.file.writes || 0) + 2,
      total_backup_bytes: 0,
    };
    const body = () => JSON.stringify(manifest, null, 1);
    manifest.total_backup_bytes = kept.reduce((s, f) => s + f.size, 0) + body().length + 64;
    manifest.finished = new Date().toISOString(); manifest.seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (!hub.plan.take("r2_writes", 1)) throw new Error("R2 写入额度用完了");
    await hub.env.FILES.put(`backup/${date}/manifest.json`, body(), { httpMetadata: { contentType: "application/json" } });
    hub.set("backup:bytes", String(manifest.total_backup_bytes));
    return manifest;
  } finally { running.delete(hub); }
}

function summary(m: Manifest) {
  return { date: m.date, ok: true, at: m.finished, seconds: m.seconds, rows: Object.values(m.tables as Record<string, number>).reduce((a, b) => a + b, 0), bytes: Number(m.files.core.bytes) + Number(m.files.media?.bytes || 0), media: !!m.files.media };
}

// ---------- daily clock ----------
async function attempt(hub: Hub, now: number) {
  const day = fmtDate(now, BJ);
  try {
    const m = await runBackup(hub, now);
    hub.set("backup:day", day);
    hub.set("backup:last", JSON.stringify(summary(m)));
  } catch (e: any) {
    const msg = String(e?.message || e), refused = /额度/.test(msg);
    const [d, n] = (hub.get("backup:tries") || "").split("|"), tries = (d === day ? Number(n) : 0) + 1;
    hub.set("backup:tries", day + "|" + tries);
    hub.set("backup:retry", String(now + 30 * 60000));
    // A used-up allowance waits for tomorrow; other failures get three tries today.
    if (refused || tries >= 3) hub.set("backup:day", day);
    hub.set("backup:last", JSON.stringify({ date: day, ok: false, at: new Date().toISOString(), error: msg }));
    console.log("backup failed", msg);
  }
}

async function tick(hub: Hub, now: number) {
  const day = fmtDate(now, BJ);
  if (hub.get("backup:day") === day || now < zonedToUtc(day, START_TIME, BJ) || running.has(hub)) return;
  if (now < Number(hub.get("backup:retry") || 0)) return;
  if (!hub.env.FILES) return;
  hub.ctx.waitUntil(attempt(hub, now));
}

// ---------- listing ----------
async function listing(hub: Hub) {
  const files = await listAll(hub), by = new Map<string, { name: string; bytes: number }[]>();
  for (const f of files) { const d = dateOf(f.key); if (d) (by.get(d) || by.set(d, []).get(d)!).push({ name: f.key.split("/").pop()!, bytes: f.size }); }
  const backups = [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, fs]) => ({ date, bytes: fs.reduce((s, f) => s + f.bytes, 0), files: fs }));
  let last: any = null;
  try { last = JSON.parse(hub.get("backup:last") || "null"); } catch {}
  return { backups, total_bytes: backups.reduce((s, b) => s + b.bytes, 0), last };
}

// ---------- restore ----------
async function* linesOf(body: ReadableStream) {
  const r = body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    buf += value;
    let at = 0, i: number;
    while ((i = buf.indexOf("\n", at)) >= 0) { if (i > at) yield buf.slice(at, i); at = i + 1; }
    buf = buf.slice(at);
  }
  if (buf.trim()) yield buf;
}
async function open(hub: Hub, key: string) {
  if (!hub.plan.take("r2_reads", 1)) throw new Error("R2 读取额度用完了");
  const o = await hub.env.FILES.get(key);
  if (!o) throw new Error("备份里没有 " + key);
  return o.body as ReadableStream;
}

async function restore(hub: Hub, body: any) {
  const date = String(body.restore || ""), dry = body.dry === true;
  if (!DATE.test(date)) return { status: 400, out: { ok: false, error: "restore 要填备份日期，如 2026-11-15" } };
  const want: string[] = Array.isArray(body.tables) ? body.tables.map(String) : [];
  if (!want.length) return { status: 400, out: { ok: false, error: "tables 要列出要恢复的表，没有列出的表不会动" } };
  if (!dry && body.confirm !== date) return { status: 400, out: { ok: false, error: "confirm 必须等于备份日期 " + date + "，这是确认要覆盖这些表" } };
  const mf = await hub.env.FILES.get(`backup/${date}/manifest.json`);
  if (!mf) return { status: 404, out: { ok: false, error: "没有 " + date + " 的备份" } };
  const manifest = JSON.parse(await mf.text());
  const live = new Map(tables(hub).map(t => [t.name, t]));
  const plan: { name: string; media: boolean }[] = [], refused: Record<string, string> = {};
  for (const name of want) {
    if (name === "media") {
      if (!manifest.files?.media) refused[name] = date + " 的备份没有图片部分（只有周日才备份图片）";
      else plan.push({ name, media: true });
    } else if (!live.has(name)) refused[name] = "现在的数据库里没有这张表";
    else if (!(name in (manifest.tables || {}))) refused[name] = "这份备份里没有这张表";
    else if (live.get(name)!.cols.some(c => c.blob)) refused[name] = "这张表带图片/文件的二进制内容，核心备份里没有；整表覆盖会清掉现有图片。要恢复已保存的角色和表情包，tables 里写 \"media\"";
    else plan.push({ name, media: false });
  }
  if (Object.keys(refused).length) return { status: 400, out: { ok: false, error: "有表不能恢复，什么都没改", refused } };
  const warnings: string[] = [];
  const has = (n: string) => plan.some(p => p.name === n);
  if (has("ledger") !== has("ledger_log") && (has("ledger") || has("ledger_log"))) warnings.push("ledger 和 ledger_log 是配套的，只恢复一张可能让余额与流水对不上");
  if (has("turn") !== has("toolrun") && (has("turn") || has("toolrun"))) warnings.push("turn 和 toolrun 通过 turn 编号关联，只恢复一张会让编号对不上");

  const result: Record<string, any> = {};
  const cores = plan.filter(p => !p.media), cur = (n: string) => Number(hub.sql.exec(`SELECT COUNT(*) n FROM ${q(n)}`).toArray()[0].n);
  const stage = (n: string) => q(STAGE + n);
  const staged: string[] = [];
  try {
    if (cores.length) {
      for (const p of cores) {
        hub.sql.exec(`DROP TABLE IF EXISTS ${stage(p.name)}`);
        if (!dry) { hub.sql.exec(`CREATE TABLE ${stage(p.name)} AS SELECT * FROM ${q(p.name)} WHERE 0`); staged.push(p.name); }
        result[p.name] = { current_rows: cur(p.name), backup_rows: 0 };
      }
      const names = new Set(cores.map(p => p.name)), cols = new Map<string, string[]>();
      for await (const l of linesOf(await open(hub, manifest.files.core.key))) {
        const j = JSON.parse(l);
        if (!names.has(j.t)) continue;
        result[j.t].backup_rows++;
        if (dry) continue;
        const have = new Set(live.get(j.t)!.cols.map(c => c.name));
        const keys = Object.keys(j.r).filter(k => have.has(k));
        if (!cols.has(j.t)) cols.set(j.t, keys);
        hub.sql.exec(`INSERT INTO ${stage(j.t)}(${keys.map(q).join(",")}) VALUES(${keys.map(() => "?").join(",")})`, ...keys.map(k => j.r[k]));
      }
      if (!dry) {
        hub.ctx.storage.transactionSync(() => {
          for (const p of cores) {
            const ks = [...new Set(live.get(p.name)!.cols.map(c => c.name))].filter(c => (cols.get(p.name) || []).includes(c));
            const kv = p.name === "kv";
            hub.sql.exec(`DELETE FROM ${q(p.name)}${kv ? " WHERE " + kvSkip() : ""}`);
            if (ks.length) hub.sql.exec(`INSERT OR REPLACE INTO ${q(p.name)}(${ks.map(q).join(",")}) SELECT ${ks.map(q).join(",")} FROM ${stage(p.name)}${kv ? " WHERE " + kvSkip() : ""}`);
          }
        });
        for (const p of cores) result[p.name].rows_after = cur(p.name);
      }
    }
    if (plan.some(p => p.media)) {
      const info: any = { current_named_pictures: Number(hub.sql.exec("SELECT COUNT(*) n FROM img WHERE name IS NOT NULL").toArray()[0].n), backup_pictures: 0, restored: 0, kept_newer: 0 };
      const have = new Set(hub.sql.exec("PRAGMA table_info(img)").toArray().map((c: any) => String(c.name)));
      for await (const l of linesOf(await open(hub, manifest.files.media.key))) {
        const j = JSON.parse(l);
        info.backup_pictures++;
        if (dry) continue;
        const clash = hub.sql.exec("SELECT id FROM img WHERE conv=? AND name=? AND id<>?", j.r.conv, j.r.name, j.r.id).toArray()[0];
        if (clash) { info.kept_newer++; continue; }
        const keys = Object.keys(j.r).filter(k => have.has(k));
        hub.sql.exec(`INSERT OR REPLACE INTO img(${keys.map(q).join(",")},data) VALUES(${keys.map(() => "?").join(",")},?)`, ...keys.map(k => j.r[k]), unb64(j.data).buffer);
        info.restored++;
      }
      result.media = info;
    }
  } finally {
    for (const p of cores) { try { hub.sql.exec(`DROP TABLE IF EXISTS ${stage(p.name)}`); } catch {} }
  }
  return { status: 200, out: { ok: true, date, dry, result, ...(warnings.length ? { warnings } : {}), ...(dry ? {} : { note: "已恢复。Hub 里有缓存，调用 POST /admin/restart 让它重新读取。" }) } };
}

// ---------- feature ----------
const feature: Feature = {
  name: "backup",
  tick,
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/backup") return null;
    const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    if (req.method === "GET") return json({ ok: true, ...(await listing(hub)), total_bytes_tracked: Number(hub.get("backup:bytes") || 0), next: "每天北京时间 03:10 之后自动备份一次" });
    if (req.method !== "POST") return json({ ok: false, error: "GET 或 POST" }, 405);
    if (body?.restore) {
      try { const r = await restore(hub, body); return json(r.out, r.status); } catch (e: any) { return json({ ok: false, error: String(e?.message || e) }, 500); }
    }
    if (body?.run) {
      try {
        const m = await runBackup(hub, Date.now(), { media: body.media === true ? true : undefined });
        hub.set("backup:day", fmtDate(Date.now(), BJ));
        hub.set("backup:last", JSON.stringify(summary(m)));
        return json(m);
      } catch (e: any) { return json({ ok: false, error: String(e?.message || e) }, 500); }
    }
    return json({ ok: false, error: '用 {"run":true} 立即备份，或 {"restore":"日期","tables":[…],"confirm":"日期"}（加 "dry":true 只看会改什么）' }, 400);
  },
  tools: ({ hub }) => [{
    name: "backups",
    description: "查看 Bot 自己的数据备份：最近有哪些备份、各多大、上次什么时候备份、成功没有。群友问“有备份吗”“数据安全吗”时用。只能查看，恢复要管理员在后台做。",
    parameters: { type: "object", properties: { op: { type: "string", enum: ["list"], description: "list：列出最近的备份" } }, required: ["op"] },
    async run() {
      if (!hub.env.FILES) return { ok: false, error: "没有接存储桶，没法备份" };
      const l = await listing(hub);
      return {
        ok: true,
        last_run: l.last ? (l.last.ok ? { 日期: l.last.date, 结果: "成功", 用时秒: l.last.seconds, 行数: l.last.rows, 含图片: l.last.media } : { 日期: l.last.date, 结果: "失败", 原因: l.last.error }) : "还没跑过",
        recent: l.backups.slice(0, 10).map(b => ({ 日期: b.date, 大小MB: mb(b.bytes), 内容: b.files.map(f => f.name.replace(".jsonl.gz", "").replace(".json", "")).join("、") })),
        count: l.backups.length, total_mb: mb(l.total_bytes),
      };
    },
  }],
  about: [
    "每天北京时间 03:10 之后，Bot 自动把自己的数据备份一份到 R2 存储桶：聊天记录、长期记忆和设置、账本、定时任务、改动记录、用量统计等所有表。",
    "每周日另外备份一次已保存的角色图和表情包（直接存在数据库里的那些，总量上限 60 MB）。",
    "备份保留最近 30 天，另外每个月第一天的那份保留 12 个月，更早的自动删除。",
    "不在备份里的：网站登录的 cookie、今日额度和计划用量的计数、临时草稿；已经放在 R2 里的大图和文件本来就有一份，不重复备份；群友在聊天里发的图和 Bot 画的图。",
    "备份由管理员在后台查看和恢复，恢复只能整表覆盖，聊天里不能恢复。",
  ],
};
export default feature;
