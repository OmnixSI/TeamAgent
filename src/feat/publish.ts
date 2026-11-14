// Publishing: the bot writes a web page (mini game, poll, gallery, report) and gets a public link for it.
// A site is a set of files in R2 under site/<id>/<path>; its bookkeeping lives in the Hub's SQLite, so serving
// a request costs at most one R2 read. The only protection is the unguessable id: no route ever lists sites.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { BJ, clip, fmtFull } from "../util.ts";

const DEFAULT_URL = "https://teamagent.inkboard-server.workers.dev";
export const LIMITS = {
  siteBytes: 8 * 1024 * 1024, siteFiles: 60, totalBytes: 300 * 1024 * 1024, sites: 200,
  state: 64 * 1024, item: 2048, keep: 500, writesPerHour: 120, globalWritesPerHour: 1200, oldMs: 365 * 86400000,
};

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4",
  webm: "video/webm", wasm: "application/wasm", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8", xml: "application/xml; charset=utf-8", pdf: "application/pdf", woff: "font/woff", woff2: "font/woff2",
};
export const contentType = (path: string) => TYPES[(path.split(".").pop() || "").toLowerCase()] || "";
const IMG_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

/** A clean relative path inside a site, or null: no absolute paths, backslashes, dot segments, reserved names or unknown file types. */
export function normPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim();
  if (!p || p.length > 120 || p.startsWith("/") || /[\\\x00-\x1f\x7f<>:"|?*#%]/.test(p)) return null;
  const segs: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s.startsWith(".") || s.length > 60) return null;
    segs.push(s);
  }
  if (!segs.length || segs.length > 6 || segs[0] === "_api" || segs[0] === "_img") return null;
  return contentType(segs[segs.length - 1]) ? segs.join("/") : null;
}

export function newId() {
  const out: string[] = [], a = "abcdefghijklmnopqrstuvwxyz0123456789";
  while (out.length < 12) for (const b of crypto.getRandomValues(new Uint8Array(24))) if (b < 252 && out.length < 12) out.push(a[b % 36]);
  return out.join("");
}

const enc = new TextEncoder();
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
const kb = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
const fnv = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
const baseUrl = (hub: Hub) => String(hub.env.PUBLIC_URL || DEFAULT_URL).replace(/\/+$/, "");
const key = (id: string, path: string) => "site/" + id + "/" + path;
const bucket = (hub: Hub) => hub.env.FILES as any;

type Site = { id: string; conv: string; title: string; created: number; updated: number; by: string; files: number; bytes: number; views: number };
const siteRow = (hub: Hub, id: string) => hub.sql.exec('SELECT id,conv,title,created,updated,"by" AS "by",files,bytes,views FROM site WHERE id=?', id).toArray()[0] as unknown as Site | undefined;

// ---- responses ----

const secure = (h: Headers) => {
  h.set("X-Robots-Tag", "noindex, nofollow"); h.set("X-Content-Type-Options", "nosniff"); h.set("X-Frame-Options", "DENY");
  h.set("Content-Security-Policy", "frame-ancestors 'none'"); h.set("Referrer-Policy", "strict-origin");
  return h;
};
const reply = (body: BodyInit | null, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers: secure(new Headers(headers)) });
const json = (data: unknown, status = 200) => reply(JSON.stringify(data), status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
const page = (status: number, title: string, text: string) => reply(
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f6f4;color:#222}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#777;margin:0}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`,
  status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
const notFound = () => page(404, "找不到这个页面", "链接可能写错了，或者页面已经被删掉了。");

// ---- serving ----

const etagOf = (site: Site, path: string, size: number) => '"' + site.updated.toString(36) + "-" + size.toString(36) + "-" + fnv(path) + '"';
const matches = (header: string | null, etag: string) => !!header && (header.trim() === "*" || header.split(",").some(t => t.trim().replace(/^W\//, "") === etag));

function parseRange(h: string, size: number): { start: number; end: number } | "bad" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") { const n = Number(m[2]); return n === 0 || !size ? "bad" : { start: Math.max(0, size - n), end: size - 1 }; }
  const start = Number(m[1]), end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || start > end ? "bad" : { start, end };
}

async function serveFile(hub: Hub, req: Request, site: Site, rawRest: string) {
  let decoded = "";
  try { decoded = decodeURIComponent(rawRest.slice(1)); } catch { return notFound(); }
  const wanted = decoded === "" || decoded.endsWith("/") ? decoded + "index.html" : decoded;
  const path = normPath(wanted), has = (p: string | null) => p ? hub.sql.exec("SELECT size FROM site_file WHERE id=? AND path=?", site.id, p).toArray()[0] as any : undefined;
  const f = has(path);
  if (!f) {
    // "docs" with no slash, where docs/index.html exists: send the browser to "docs/" so relative links resolve
    if (!decoded.endsWith("/") && has(normPath(decoded + "/index.html")))
      return reply(null, 301, { Location: "/p/" + site.id + "/" + decoded.split("/").map(encodeURIComponent).join("/") + "/" });
    return notFound();
  }
  const size = Number(f.size), etag = etagOf(site, path!, size);
  const head: Record<string, string> = { "Content-Type": contentType(path!), "Cache-Control": "public, max-age=300", ETag: etag, "Accept-Ranges": "bytes" };
  const get = req.method === "GET";
  if (get && path === "index.html") hub.sql.exec("UPDATE site SET views=views+1 WHERE id=?", site.id);
  if (matches(req.headers.get("if-none-match"), etag)) return reply(null, 304, { "Cache-Control": head["Cache-Control"], ETag: etag });
  const rangeHeader = req.headers.get("range"), range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === "bad") return reply(null, 416, { "Content-Range": "bytes */" + size });
  if (!get) return reply(null, 200, { ...head, "Content-Length": String(size) });
  if (!bucket(hub)) return page(503, "暂时打不开", "存储没有接好，稍后再试。");
  if (!hub.plan.take("r2_reads", 1)) return page(503, "这个月的额度用完了", "网页的读取次数到了本月上限，下个周期恢复。");
  const obj = await bucket(hub).get(key(site.id, path!), range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined).catch(() => null);
  if (!obj) return notFound();
  const buf = await obj.arrayBuffer();
  if (range) return reply(buf, 206, { ...head, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(buf.byteLength) });
  return reply(buf, 200, head);
}

async function galleryImage(hub: Hub, req: Request, site: Site, n: string) {
  if (req.method !== "GET" && req.method !== "HEAD") return reply(null, 405, { Allow: "GET, HEAD" });
  if (!/^\d{1,9}$/.test(n)) return notFound();
  // Only the bot's own pictures of this site's conversation; the store itself looks pictures up by number alone.
  const row = hub.sql.exec("SELECT id,mime FROM img WHERE id=? AND conv=? AND name IS NULL AND src IS NULL", Number(n), site.conv).toArray()[0] as any;
  if (!row) return notFound();
  const etag = '"g' + n + '"', mime = /^image\/(png|jpeg|gif|webp)$/.test(String(row.mime)) ? String(row.mime) : "image/jpeg";
  const head = { "Content-Type": mime, "Cache-Control": "public, max-age=3600", ETag: etag };
  if (matches(req.headers.get("if-none-match"), etag)) return reply(null, 304, { "Cache-Control": head["Cache-Control"], ETag: etag });
  if (req.method === "HEAD") return reply(null, 200, head);
  const img = await hub.store.imageRef(site.conv, "g" + n).catch(() => null);
  return img ? reply(img.bytes as any, 200, head) : notFound();
}

// ---- the small shared-state API ----

const rates = new WeakMap<object, Map<string, { hour: number; n: number }>>();
function writes(hub: Hub, id: string) {
  let m = rates.get(hub); if (!m) rates.set(hub, m = new Map());
  const hour = Math.floor(Date.now() / 3600000), at = (k: string) => { const r = m!.get(k); return r && r.hour === hour ? r : { hour, n: 0 }; };
  const one = at(id), all = at("*");
  return {
    open: one.n < LIMITS.writesPerHour && all.n < LIMITS.globalWritesPerHour,
    count() {   // only accepted writes count: a refused body costs no row write
      one.n++; all.n++; m!.set(id, one); m!.set("*", all);
      if (m!.size > 600) for (const [k, v] of m!) if (v.hour !== hour) m!.delete(k);
    },
  };
}

async function readJson(req: Request, max: number): Promise<{ ok: true; text: string } | { ok: false; res: Response }> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > max + 64) return { ok: false, res: json({ ok: false, error: "内容太大，最多 " + kb(max) }, 413) };
  const text = await req.text();
  if (enc.encode(text).length > max) return { ok: false, res: json({ ok: false, error: "内容太大，最多 " + kb(max) }, 413) };
  try { JSON.parse(text); } catch { return { ok: false, res: json({ ok: false, error: "内容不是合法的 JSON" }, 400) }; }
  return { ok: true, text };
}

async function api(hub: Hub, req: Request, site: Site, name: string) {
  const m = req.method, id = site.id;
  if (m === "OPTIONS") return reply(null, 204, { Allow: "GET, PUT, POST, HEAD" });
  const fetchSite = req.headers.get("sec-fetch-site");
  if (m !== "GET" && m !== "HEAD" && fetchSite && fetchSite !== "same-origin") return json({ ok: false, error: "只能由页面自己写入" }, 403);
  if (name === "state") {
    if (m === "GET" || m === "HEAD") {
      const r = hub.sql.exec("SELECT v FROM site_state WHERE id=?", id).toArray()[0] as any;
      return reply(m === "HEAD" ? null : r ? String(r.v) : "{}", 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    }
    if (m !== "PUT") return json({ ok: false, error: "这里只能 GET 或 PUT" }, 405);
    const w = writes(hub, id);
    if (!w.open) return json({ ok: false, error: "写得太频繁了，每小时最多 " + LIMITS.writesPerHour + " 次，过一会儿再试" }, 429);
    const body = await readJson(req, LIMITS.state);
    if (!body.ok) return body.res;
    w.count();
    hub.sql.exec("INSERT INTO site_state(id,v,t) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET v=excluded.v, t=excluded.t", id, JSON.stringify(JSON.parse(body.text)), Date.now());
    return json({ ok: true });
  }
  if (name === "append") {
    if (m !== "POST") return json({ ok: false, error: "这里只能 POST" }, 405);
    const w = writes(hub, id);
    if (!w.open) return json({ ok: false, error: "写得太频繁了，每小时最多 " + LIMITS.writesPerHour + " 次，过一会儿再试" }, 429);
    const body = await readJson(req, LIMITS.item);
    if (!body.ok) return body.res;
    w.count();
    const n = Number((hub.sql.exec("SELECT COALESCE(MAX(n),0)+1 n FROM site_item WHERE id=?", id).toArray()[0] as any).n);
    hub.sql.exec("INSERT INTO site_item(id,n,t,v) VALUES(?,?,?,?)", id, n, Date.now(), JSON.stringify(JSON.parse(body.text)));
    if (n > LIMITS.keep) hub.sql.exec("DELETE FROM site_item WHERE id=? AND n<=?", id, n - LIMITS.keep);
    return json({ ok: true, n });
  }
  if (name === "list") {
    if (m !== "GET" && m !== "HEAD") return json({ ok: false, error: "这里只能 GET" }, 405);
    const q = new URL(req.url).searchParams, limit = Math.min(LIMITS.keep, Math.max(1, Number(q.get("limit")) || 100)), after = Number(q.get("after"));
    const rows = (after > 0
      ? hub.sql.exec("SELECT n,v FROM site_item WHERE id=? AND n>? ORDER BY n LIMIT ?", id, after, limit)
      : hub.sql.exec("SELECT n,v FROM (SELECT n,v FROM site_item WHERE id=? ORDER BY n DESC LIMIT ?) ORDER BY n", id, limit)).toArray() as any[];
    return json({ ok: true, items: rows.map(r => JSON.parse(String(r.v))), last: rows.length ? Number(rows[rows.length - 1].n) : after > 0 ? after : 0 });
  }
  return json({ ok: false, error: "没有这个接口" }, 404);
}

// ---- writing sites ----

function removeSite(hub: Hub, id: string) {
  const paths = hub.sql.exec("SELECT path FROM site_file WHERE id=?", id).toArray().map((r: any) => key(id, String(r.path)));
  for (const t of ["site", "site_file", "site_state", "site_item"]) hub.sql.exec(`DELETE FROM ${t} WHERE id=?`, id);
  return paths.length && bucket(hub) ? Promise.resolve(bucket(hub).delete(paths)).catch((e: any) => console.log("publish: r2 delete failed", e?.message)) : Promise.resolve();
}

/** Frees room by dropping sites nobody ever opened that are over a year old; returns a refusal when that is not enough. */
async function makeRoom(hub: Hub, addBytes: number, addSites: number, keep: string) {
  for (let i = 0; i < LIMITS.sites + 1; i++) {
    const t = hub.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b FROM site").toArray()[0] as any;
    if (Number(t.c) + addSites <= LIMITS.sites && Number(t.b) + addBytes <= LIMITS.totalBytes) return "";
    const old = hub.sql.exec("SELECT id FROM site WHERE views=0 AND created<? AND id<>? ORDER BY created LIMIT 1", Date.now() - LIMITS.oldMs, keep).toArray()[0] as any;
    if (!old) return Number(t.c) + addSites > LIMITS.sites ? "网页已经有 " + LIMITS.sites + " 个，到上限了，先删掉不要的再做新的" : "所有网页加起来占的空间到 " + LIMITS.totalBytes / 1048576 + " MB 上限了，先删掉不要的再做新的";
    await removeSite(hub, String(old.id));
  }
  return "网页数量到上限了，先删掉不要的";
}

type Plan = { put: Map<string, Uint8Array>; remove: string[] };

async function commit(hub: Hub, conv: string, existing: Site | null, plan: Plan, title: string, by: string): Promise<{ ok: true; id: string; files: number; bytes: number } | { ok: false; error: string }> {
  if (!bucket(hub)) return { ok: false, error: "存储没接好，现在发不了网页" };
  const old = new Map<string, number>(existing ? hub.sql.exec("SELECT path,size FROM site_file WHERE id=?", existing.id).toArray().map((r: any) => [String(r.path), Number(r.size)] as [string, number]) : []);
  const next = new Map(old);
  for (const p of plan.remove) next.delete(p);
  for (const [p, b] of plan.put) next.set(p, b.length);
  if (!next.has("index.html")) return { ok: false, error: "网页要有 index.html 作为首页" };
  const total = [...next.values()].reduce((a, b) => a + b, 0);
  if (next.size > LIMITS.siteFiles) return { ok: false, error: "一个网页最多 " + LIMITS.siteFiles + " 个文件，现在有 " + next.size + " 个" };
  if (total > LIMITS.siteBytes) return { ok: false, error: "一个网页最多 " + kb(LIMITS.siteBytes) + "，现在有 " + kb(total) };
  const oldTotal = [...old.values()].reduce((a, b) => a + b, 0);
  const full = await makeRoom(hub, total - oldTotal, existing ? 0 : 1, existing?.id || "");
  if (full) return { ok: false, error: full };
  if (!hub.plan.take("r2_writes", plan.put.size)) return { ok: false, error: "这个月 R2 写入的额度用完了，下个周期再发" };
  const now = Date.now();
  let id = existing?.id || "";
  if (!existing) {
    do id = newId(); while (siteRow(hub, id));
    hub.sql.exec('INSERT INTO site(id,conv,title,created,updated,"by",files,bytes,views) VALUES(?,?,?,?,?,?,0,0,0)', id, conv, title, now, now, by);
  }
  try {
    for (const [p, bytes] of plan.put) {
      await bucket(hub).put(key(id, p), bytes);
      hub.sql.exec("INSERT INTO site_file(id,path,size) VALUES(?,?,?) ON CONFLICT(id,path) DO UPDATE SET size=excluded.size", id, p, bytes.length);
    }
    if (plan.remove.length) {
      const gone = plan.remove.filter(p => old.has(p));
      if (gone.length) await bucket(hub).delete(gone.map(p => key(id, p)));
      for (const p of gone) hub.sql.exec("DELETE FROM site_file WHERE id=? AND path=?", id, p);
    }
  } catch (e: any) {
    console.log("publish: write failed", e?.message);
    if (!existing) await removeSite(hub, id);
    else hub.sql.exec("UPDATE site SET files=(SELECT COUNT(*) FROM site_file WHERE id=?1), bytes=(SELECT COALESCE(SUM(size),0) FROM site_file WHERE id=?1), updated=?2 WHERE id=?1", id, now);
    return { ok: false, error: "文件写入失败，没有发布成功" };
  }
  hub.sql.exec("UPDATE site SET files=?, bytes=?, updated=?, title=? WHERE id=?", next.size, total, now, title || existing?.title || "", id);
  return { ok: true, id, files: next.size, bytes: total };
}

// ---- tool ----

const bytesOf = (s: string) => enc.encode(s);
const isText = (p: string) => /\.(html?|css)$/i.test(p);

/** src="img:g12" and friends: copies the picture into the site and points the page at the copy. */
async function bringImages(ctx: Ctx, put: Map<string, Uint8Array>, missing: string[]) {
  const found = new Map<string, string | null>();
  const refOf = (t: string) => [...t.matchAll(/(?<=["'(=\s])img:([^"'\s)>]+)/g)].map(m => m[1]);
  const refs = [...new Set([...put].filter(([p]) => isText(p)).flatMap(([, b]) => refOf(new TextDecoder().decode(b))))].slice(0, 24);
  for (const ref of refs) {
    let got: { bytes: Uint8Array; mime: string } | null = null;
    const g = /^g(\d+)$/i.exec(ref.trim());
    if (g) {
      const r = ctx.hub.sql.exec("SELECT conv FROM img WHERE id=?", Number(g[1])).toArray()[0] as any;
      const mine = r && (String(r.conv) === ctx.conv || String(r.conv) === ctx.hub.shadow(ctx.conv));
      if (mine) got = await ctx.host.imageRef(ref).catch(() => null) as any;
    } else got = await ctx.host.imageRef(ref).catch(() => null) as any;
    const ext = got ? IMG_EXT[String(got.mime).toLowerCase()] : "";
    if (!got || !ext) { found.set(ref, null); missing.push(ref); continue; }
    const path = "img/" + (/^[a-z0-9_-]{1,24}$/i.test(ref) ? ref : "x" + fnv(ref)) + "." + ext;
    if (!put.has(path)) put.set(path, got.bytes);
    found.set(ref, path);
  }
  for (const [p, b] of [...put]) {
    if (!isText(p)) continue;
    const text = new TextDecoder().decode(b), up = "../".repeat(p.split("/").length - 1);
    const out = text.replace(/(?<=["'(=\s])img:([^"'\s)>]+)/g, (all, ref) => found.get(ref) ? up + found.get(ref) : all);
    if (out !== text) put.set(p, bytesOf(out));
  }
}

function collect(a: any, op: "create" | "update"): { put: Map<string, Uint8Array>; error?: string } {
  const put = new Map<string, Uint8Array>();
  if (typeof a.html === "string" && a.html.trim()) put.set("index.html", bytesOf(a.html));
  const files = Array.isArray(a.files) ? a.files : [];
  for (const f of files) {
    const p = normPath(f?.path);
    if (!p) return { put, error: "文件路径不合法：" + clip(f?.path, 60) + "。只能写相对路径（如 index.html、js/game.js），不能有 .. 或反斜杠，扩展名要是 html css js json png jpg gif webp svg mp3 mp4 wasm txt pdf 之类" };
    if (typeof f.content !== "string") return { put, error: "文件 " + p + " 缺少 content（文本内容）" };
    put.set(p, bytesOf(f.content));
  }
  if (!put.size && op === "create") return { put, error: "要给 html（一个完整页面），或者 files（多个文件，其中要有 index.html）" };
  if (put.size > LIMITS.siteFiles) return { put, error: "一个网页最多 " + LIMITS.siteFiles + " 个文件" };
  return { put };
}

function galleryPage(rows: any[]) {
  const cards = rows.map(r => `<a class="c" href="_img/${Number(r.id)}"><img loading="lazy" src="_img/${Number(r.id)}" alt=""><span>${esc(clip(r.note || "", 80))}</span><time>${esc(fmtFull(Number(r.ts), BJ).slice(0, 10))}</time></a>`).join("\n");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>图库</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f3ef;color:#222;font:14px/1.5 system-ui,-apple-system,sans-serif}
header{padding:20px 16px 8px}h1{margin:0;font-size:22px}header p{margin:4px 0 0;color:#888}
.g{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:8px 16px 32px}@media(min-width:640px){.g{grid-template-columns:repeat(4,1fr)}}
.c{display:block;background:#fff;border-radius:10px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 3px #0001}
.c img{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#e8e6df}.c span{display:block;padding:6px 8px 0;font-size:13px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:2.9em}
.c time{display:block;padding:0 8px 8px;color:#aaa;font-size:12px}
</style></head><body><header><h1>图库</h1><p>共 ${rows.length} 张，点开看大图</p></header><div class="g">
${cards}
</div></body></html>`;
}

function makeTool(ctx: Ctx): Tool {
  const { hub, conv } = ctx, url = (id: string, v?: number) => baseUrl(hub) + "/p/" + id + "/" + (v ? "?v=" + v.toString(36) : "");
  const by = ctx.askers.map(a => a.name).filter(Boolean).join("、").slice(0, 40);
  const mine = (id: unknown) => { const s = typeof id === "string" ? siteRow(hub, id) : undefined; return s && s.conv === conv ? s : undefined; };
  const allowed = async () => ctx.host.quota("publish", Number(ctx.host.cfg("publish_daily")));
  const OUT = { ok: false, error: "今天发布网页的次数用完了，明天再来" };
  return {
    name: "publish", work: true,
    description: "把一个网页发布到网上，得到一个链接，可以直接发到群里让大家点开玩。适合：能在手机上玩的 H5 小游戏、投票和报名（用下面的共享状态接口）、会动的交互图表、图库、很长的报告和攻略。" +
      "op=create：新建，给 title，再给 html（一个完整页面，最好一个文件写完，样式和脚本都内联）或 files（[{path, content}]，多文件，必须有 index.html，content 是文本）；返回 url 和 id，把 url 原样发到群里。" +
      "op=update：给 id（之前发布的），html 替换首页，或 files 替换/新增文件，remove 删文件，title 改名；改完后给大家新的 url（带 ?v=），旧链接在已经打开过的手机上最多 5 分钟后才会刷新。" +
      "op=list：列出这个对话发布过的网页（标题、链接、浏览次数、大小、时间）。op=delete：给 id 删掉。op=gallery：把你在这个对话里画过的图做成一个图库网页（已有就刷新），返回链接。" +
      "写页面要注意：大家多半在 QQ 里用手机打开，要按手机竖屏来做（<meta name=viewport>、按钮够大、不依赖悬停和键盘）；库可以用 CDN 上的（如 cdn.jsdelivr.net）；你画过的图写 <img src=\"img:g12\">（聊天里的图用编号如 123-0，保存的形象用名字），发布时会自动把图拷进网页；页面里不要放任何密钥、口令、私人信息，链接对拿到的人都是公开的（别人猜不到，但转发出去谁都能看）；一个网页最多 60 个文件、8 MB，只能放 html css js json 图片 音视频 wasm txt pdf 这些。" +
      "共享状态（投票、排行榜、留言、多人小游戏）：不用自己搭后端，页面里直接用同站接口。先 const API = location.pathname.split('/').slice(0,3).join('/') + '/_api/'。" +
      "整体状态：await (await fetch(API+'state')).json() 读（没写过是 {}），await fetch(API+'state',{method:'PUT',body:JSON.stringify(obj)}) 整个替换，≤64KB。" +
      "追加记录：await fetch(API+'append',{method:'POST',body:JSON.stringify({name:'小明',vote:'A'})}) 每条 ≤2KB，只留最近 500 条；读：const {items,last} = await (await fetch(API+'list?limit=100')).json()（?after=上次的last 只取新的）。投票统计在页面里用 items 自己数，不要靠 PUT 去累加（多人同时写会互相覆盖）。每个网页每小时最多写 120 次，轮询读取别太密（5 秒以上一次）。",
    parameters: {
      type: "object", required: ["op"], additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["create", "update", "list", "delete", "gallery"] },
        title: { type: "string", description: "网页标题，create 必填" },
        html: { type: "string", description: "一个完整的 HTML 页面（create 或 update 用）" },
        files: { type: "array", description: "多文件网页：每项 {path, content}，path 是相对路径如 index.html、js/game.js，content 是文本", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
        id: { type: "string", description: "update、delete 用：网页 id" },
        remove: { type: "array", items: { type: "string" }, description: "update 用：要删掉的文件路径" },
      },
    },
    run: async a => {
      const op = String(a.op || "");
      if (op === "list") {
        const rows = hub.sql.exec("SELECT id,title,files,bytes,views,updated FROM site WHERE conv=? ORDER BY updated DESC LIMIT 50", conv).toArray() as any[];
        return { ok: true, sites: rows.map(r => ({ id: String(r.id), title: String(r.title), url: url(String(r.id)), views: Number(r.views), files: Number(r.files), size: kb(Number(r.bytes)), updated: fmtFull(Number(r.updated), BJ) + " 北京时间" })), ...(rows.length ? {} : { note: "这个对话还没有发布过网页" }) };
      }
      if (op === "delete") {
        const s = mine(a.id);
        if (!s) return { ok: false, error: "这个对话里没有这个 id 的网页" };
        await removeSite(hub, s.id);
        return { ok: true, deleted: s.title };
      }
      if (op === "gallery") {
        const rows = hub.sql.exec("SELECT id,ts,note FROM img WHERE conv=? AND name IS NULL AND src IS NULL ORDER BY id DESC LIMIT 300", conv).toArray();
        if (!rows.length) return { ok: false, error: "这个对话里还没有画过图，做不了图库" };
        if (!(await allowed())) return OUT;
        const old = hub.sql.exec('SELECT id FROM site WHERE conv=? AND "by"=? ORDER BY created LIMIT 1', conv, "gallery").toArray()[0] as any;
        const r = await commit(hub, conv, old ? siteRow(hub, String(old.id))! : null, { put: new Map([["index.html", bytesOf(galleryPage(rows))]]), remove: [] }, "图库", "gallery");
        return r.ok ? { ok: true, url: url(r.id, old ? Date.now() : 0), id: r.id, pictures: rows.length, note: "图是点开才从存储里读的，图库里的图保持和对话里画的一致" } : r;
      }
      if (op !== "create" && op !== "update") return { ok: false, error: "op 只能是 create、update、list、delete、gallery" };
      const existing = op === "update" ? mine(a.id) : null;
      if (op === "update" && !existing) return { ok: false, error: "这个对话里没有这个 id 的网页，先 list 看看" };
      const title = clip(String(a.title || existing?.title || "").trim() || "未命名", 60);
      const { put, error } = collect(a, op);
      if (error) return { ok: false, error };
      const remove: string[] = [];
      for (const r of Array.isArray(a.remove) ? a.remove : []) { const p = normPath(r); if (!p) return { ok: false, error: "要删的路径不合法：" + clip(r, 60) }; if (p === "index.html" && !put.has(p)) return { ok: false, error: "首页 index.html 不能删，要换就直接给新的" }; remove.push(p); }
      if (op === "update" && !put.size && !remove.length && !a.title) return { ok: false, error: "update 要给 html、files、remove 或 title 之一" };
      const missing: string[] = [];
      await bringImages(ctx, put, missing);
      if (!(await allowed())) return OUT;
      const r = await commit(hub, conv, existing || null, { put, remove }, title, by);
      if (!r.ok) return r;
      return { ok: true, id: r.id, url: url(r.id, existing ? Date.now() : 0), files: r.files, size: kb(r.bytes), ...(missing.length ? { missing_images: missing, note: "这些图没找到，页面里对应位置还是 img: 开头的占位：" + missing.join("、") } : {}) };
    },
  };
}

const feature: Feature = {
  name: "publish",
  schema: `CREATE TABLE IF NOT EXISTS site(id TEXT PRIMARY KEY, conv TEXT, title TEXT, created INTEGER, updated INTEGER, "by" TEXT, files INTEGER, bytes INTEGER, views INTEGER);
CREATE INDEX IF NOT EXISTS site_conv ON site(conv, updated);
CREATE TABLE IF NOT EXISTS site_file(id TEXT, path TEXT, size INTEGER, PRIMARY KEY(id, path));
CREATE TABLE IF NOT EXISTS site_state(id TEXT PRIMARY KEY, v TEXT, t INTEGER);
CREATE TABLE IF NOT EXISTS site_item(id TEXT, n INTEGER, t INTEGER, v TEXT, PRIMARY KEY(id, n));`,
  tunables: { publish_daily: { default: 20, min: 0, max: 200, what: "每天最多发布或更新几次网页" } },
  tools: ctx => [makeTool(ctx)],
  open(hub, req, url) {
    const m = /^\/p\/([a-z0-9]{12})(\/.*)?$/.exec(url.pathname);
    if (!m) return null;
    const site = siteRow(hub, m[1]), rest = m[2] ?? "";
    if (!site) return notFound();
    if (rest === "") return reply(null, 301, { Location: "/p/" + site.id + "/" + url.search });
    if (rest.startsWith("/_api/")) return api(hub, req, site, rest.slice(6));
    if (rest.startsWith("/_img/")) return galleryImage(hub, req, site, rest.slice(6));
    if (req.method !== "GET" && req.method !== "HEAD") return reply(null, 405, { Allow: "GET, HEAD" });
    return serveFile(hub, req, site, rest);
  },
  about: [
    "我能把网页发布到网上并把链接发到群里：能在手机上玩的小游戏、投票和报名页、交互图表、图库、长报告都行，用 publish 工具。",
    "网页存在 R2 里，链接形如 teamagent 域名下 /p/一串十二位随机字符/；链接别人猜不到，但拿到链接的人都能看，所以页面里不放密钥和私人信息，也没有任何公开的网页列表。",
    "网页可以用站内的小接口存共享状态（整体状态最多 64KB，追加记录每条 2KB、保留最近 500 条），投票和排行榜靠它，每个网页每小时最多写 120 次。",
    "限制：一个网页最多 60 个文件、8 MB，所有网页加起来最多 200 个、300 MB；每天发布次数有上限（publish_daily，默认 20）；网页被浏览的读取次数计入 R2 额度，用完本月就暂停打开。",
  ],
};
export default feature;
