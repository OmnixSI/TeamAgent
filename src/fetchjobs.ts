import { left } from "./d1";
import { TEAM } from "./config";
import { extractBili } from "./inbound";
import { metaOf } from "./view";
import { loadChatContext } from "./context";
import { agentAnswer } from "./semantic";
import { enqueueVoice, decodeVoice } from "./voice";
import { queueFor } from "./lanes";
import { untrusted } from "./untrusted";
import { redact } from "./runtime";

type Row = Record<string, any>;
export type BiliResult = {
  bvid: string; title: string; desc: string; owner: string; tname: string;
  duration: number; pubdate: number; stat: Record<string, number>;
  subtitle: string | null; subtitle_lang: string | null;
  comments: { uname: string; message: string }[]; tier: "light"; fetched_at: string;
};
const BV = /^BV[0-9A-Za-z]{10}$/;
const validRef = (s: string) => BV.test(s) || /^[0-9A-Za-z]{4,12}$/.test(s);
function refIn(bili: any[]): string | null {
  return bili?.find(b => BV.test(b.bvid || ""))?.bvid || bili?.find(b => /^[0-9A-Za-z]{4,12}$/.test(b.short || ""))?.short || null;
}
export function needsVideo(_batch: Row[], latest: Row, recent: Row[], cfg: any): string | null {
  if (!cfg.bili?.enabled) return null;
  const meta = metaOf(latest);
  if (latest.mentioned) { const ref = refIn(meta.bili); if (ref) return ref; }
  const quoted = recent.find(r => r.id === meta.replyTo?.targetId);
  const ref = refIn(quoted ? metaOf(quoted).bili : []) || refIn(extractBili(meta.quotedUrls || [], ""));
  if (ref) return ref;
  if (/视频|讲了?啥|讲的什么|说了什么|总结|值得看|up主/i.test(latest.body || "")) {
    const candidates = recent.some(r => r.id === latest.id) ? recent : [...recent, latest];
    for (const r of candidates.slice(-10).reverse()) { const ref = refIn(metaOf(r).bili); if (ref) return ref; }
  }
  return null;
}
export async function biliCached(e: any, ref: string): Promise<BiliResult | null> {
  const row = await e.DB.prepare("SELECT body,created_at FROM media_notes WHERE id=?").bind("bili:" + ref).first();
  if (!row || !(Date.parse(row.created_at) >= Date.now() - 7 * 86400000)) return null;
  try { return cleanResult(JSON.parse(row.body)); } catch { return null; }
}
function fetchStatement(e: any, ref: string, tier: string, waiter: string, waitCreated?: number) {
  return e.DB.prepare(`INSERT INTO jobs(id,kind,payload,created_at)
    SELECT ?,'fetch',?,? ${waitCreated === undefined ? "" : "WHERE EXISTS(SELECT 1 FROM video_waits WHERE id=? AND created_at=?)"}
    ON CONFLICT(id) DO UPDATE SET
      payload=CASE WHEN jobs.status IN ('pending','running') THEN json_insert(jobs.payload,'$.waiters[#]',?) ELSE excluded.payload END,
      status=CASE WHEN jobs.status IN ('pending','running') THEN jobs.status ELSE 'pending' END,
      attempts=CASE WHEN jobs.status IN ('pending','running') THEN jobs.attempts ELSE 0 END,
      lease_until=CASE WHEN jobs.status IN ('pending','running') THEN jobs.lease_until ELSE 0 END,error=NULL`)
    .bind("fetch-bili-" + ref, JSON.stringify({ type: "bili", tier, ref, waiters: [waiter] }), Date.now(), ...(waitCreated === undefined ? [] : [waiter, waitCreated]), waiter);
}
export async function requestBili(e: any, ref: string, tier: string, waiter: string): Promise<void> {
  if (!validRef(ref) || tier !== "light") throw Error("invalid fetch request");
  await fetchStatement(e, ref, tier, waiter).run();
}
/** A committed handoff remains authoritative even after its reply finishes. */
export async function videoWaitExists(e: any, groupId: string, latestId: string | string[]): Promise<boolean> {
  const ids = Array.isArray(latestId) ? latestId : [latestId];
  if (!ids.length) return false;
  return !!(await e.DB.prepare("SELECT id FROM video_waits WHERE group_id=? AND latest_id IN (" + ids.map(() => "?").join(",") + ") LIMIT 1")
    .bind(groupId, ...ids).first());
}
export async function startVideoWait(e: any, x: { groupId: string; ref: string; latest: Row; batchIds: string[]; mentioned: boolean }): Promise<boolean> {
  if (await videoWaitExists(e, x.groupId, x.latest.id)) return true;
  const active = await e.DB.prepare("SELECT COUNT(*) n FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')").bind(x.groupId, x.ref).first();
  if (active.n >= 3) return false;
  const now = Date.now(), id = "vw-" + x.latest.id;
  await e.DB.batch([
    e.DB.prepare(`INSERT OR IGNORE INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,due_at,created_at)
      SELECT ?,?,?,?,?,?,COALESCE((SELECT MIN(due_at) FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')),?),?
      WHERE (SELECT COUNT(*) FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')) < 3`)
      .bind(id, x.groupId, x.ref, x.latest.id, JSON.stringify(x.batchIds.slice(0, 60)), x.mentioned ? 1 : 0, x.groupId, x.ref, now + TEAM.bili.wait_seconds * 1000, now, x.groupId, x.ref),
    fetchStatement(e, x.ref, "light", id, now),
  ]);
  return !!(await e.DB.prepare("SELECT id FROM video_waits WHERE id=? AND created_at=? AND status='waiting'").bind(id, now).first());
}
export async function wakeVideoWait(e: any, waitId: string): Promise<void> {
  const now = Date.now(), id = "video-" + waitId;
  // video_waits is authoritative. A no-op delivery can have completed the wake job
  // while its video lease was still held; reopen it when the video becomes due.
  const row = await e.DB.prepare(`INSERT INTO jobs(id,kind,payload,created_at)
    SELECT ?,'video_reply',?,? WHERE EXISTS(SELECT 1 FROM video_waits WHERE id=? AND
      ((status='waiting' AND (ready=1 OR due_at<=?)) OR (status='running' AND lease_until<?)))
    ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=0,error=NULL
    RETURNING id`)
    .bind(id, JSON.stringify({ wait: waitId }), now, waitId, now, now).first();
  if (row) await queueFor(e, "video_reply")?.send({ id });
}
export function biliNoteText(r: BiliResult): string {
  return [`标题：${r.title}`, `UP 主：${r.owner}；分区：${r.tname}；时长：${r.duration}秒`, `简介：${r.desc}`,
    `热评（观众意见）：${r.comments.map(c => c.uname + "：" + c.message).join("\n") || "未读到"}`,
    r.subtitle ? `字幕（${r.subtitle_lang || "未知语言"}）：${r.subtitle}` : "未读到 CC 字幕；未查看画面或听取音轨。"].join("\n").slice(0, 6000);
}
export const videoMaterial = (r: BiliResult) => untrusted("bilibili", biliNoteText(r), r.fetched_at);
export async function runVideoWait(e: any, waitId: string): Promise<void> {
  const now = Date.now();
  const w = await e.DB.prepare(`UPDATE video_waits SET status='running',lease_until=?,attempts=attempts+1 WHERE id=? AND attempts<3 AND
    ((status='waiting' AND (ready=1 OR due_at<=?)) OR (status='running' AND lease_until<?)) RETURNING *`)
    .bind(now + 120000, waitId, now, now).first();
  if (!w) return;
  try {
    const context = await loadChatContext(e, { groupId: w.group_id, latestId: w.latest_id, batchIds: JSON.parse(w.batch_ids) });
    const cached = await biliCached(e, w.ref);
    const materials = cached ? [videoMaterial(cached)] : ["视频内容暂时没读到（本机抓取端可能离线），只依据卡片信息作答。"];
    const answer = await agentAnswer(e, { ...context, mentioned: !!w.mentioned, materials, videoWaited: true });
    // A timed-out old attempt must not finish a newer lease.
    const owns = await e.DB.prepare("SELECT id FROM video_waits WHERE id=? AND status='running' AND lease_until=?").bind(w.id, w.lease_until).first();
    if (!owns) return;
    if (decodeVoice(answer).text !== "[[SILENT]]") await enqueueVoice(e, "video-" + w.id, w.group_id, w.latest_id, answer);
    await e.DB.prepare("UPDATE video_waits SET status='done' WHERE id=? AND status='running' AND lease_until=?").bind(w.id, w.lease_until).run();
  } catch (error) {
    if (w.attempts >= 3) await failVideoWait(e, w);
    else throw error;
  }
}
/** No model call at the retry limit. Batch the one fallback with its terminal state. */
async function failVideoWait(e: any, w: Row): Promise<void> {
  const guard = "id=? AND status='running' AND lease_until=? AND attempts>=3";
  await e.DB.batch([
    e.DB.prepare("INSERT OR IGNORE INTO outbox SELECT ?,group_id,latest_id,?,'pending',? FROM video_waits WHERE " + guard)
      .bind("video-" + w.id, "视频解读暂时无法完成，已停止自动重试。请稍后再问。", Date.now(), w.id, w.lease_until),
    e.DB.prepare("UPDATE video_waits SET status='failed' WHERE " + guard).bind(w.id, w.lease_until),
  ]);
}
export async function sweepVideoWaits(e: any): Promise<void> {
  const now = Date.now();
  await e.DB.prepare("UPDATE jobs SET status='failed',error='本机抓取端未回报' WHERE kind='fetch' AND status='running' AND attempts>=2 AND lease_until<?").bind(now).run();
  const exhausted = (await e.DB.prepare("SELECT * FROM video_waits WHERE status='running' AND attempts>=3 AND lease_until<? LIMIT 5").bind(now).all()).results;
  for (const w of exhausted) {
    if (left(e) < 4) break;
    await failVideoWait(e, w);
  }
  const rows = (await e.DB.prepare("SELECT id FROM video_waits WHERE (status='waiting' AND (ready=1 OR due_at<=?)) OR (status='running' AND lease_until<?) ORDER BY due_at LIMIT 5").bind(now, now).all()).results;
  for (const w of rows) {
    if (left(e) < 4) break;
    await wakeVideoWait(e, w.id);
  }
}
export async function claimFetch(e: any): Promise<Row | null> {
  const now = Date.now(), lease = crypto.randomUUID();
  const row = await e.DB.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,lease_until=?,payload=json_set(payload,'$.lease',?)
    WHERE id=(SELECT id FROM jobs WHERE kind='fetch' AND attempts<2 AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 1) RETURNING *`)
    .bind(now + 120000, lease, now).first();
  return row ? { ...row, payload: JSON.parse(row.payload) } : null;
}
export async function heartbeatFetch(e: any, id: string, lease: string): Promise<boolean> {
  return !!(await e.DB.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND kind='fetch' AND status='running' AND json_extract(payload,'$.lease')=? AND lease_until>? RETURNING id").bind(Date.now() + 120000, id, lease, Date.now()).first());
}
function cleanResult(r: any): BiliResult {
  if (!r || !BV.test(r.bvid)) throw Error("invalid video result");
  const text = (s: any, max: number) => redact(typeof s === "string" ? s : "").slice(0, max);
  const number = (n: any) => Number.isFinite(n) && n >= 0 ? n : 0;
  return { bvid: r.bvid, title: text(r.title, 300), desc: text(r.desc, 1500), owner: text(r.owner, 100), tname: text(r.tname, 100), duration: number(r.duration), pubdate: number(r.pubdate),
    stat: Object.fromEntries(["view", "like", "coin", "favorite", "reply"].map(k => [k, number(r.stat?.[k])])),
    subtitle: typeof r.subtitle === "string" ? text(r.subtitle, 6000) : null, subtitle_lang: typeof r.subtitle_lang === "string" ? text(r.subtitle_lang, 30) : null,
    comments: (Array.isArray(r.comments) ? r.comments : []).slice(0, 8).map((c: any) => ({ uname: text(c?.uname, 100), message: text(c?.message, 120) })), tier: "light", fetched_at: Number.isFinite(Date.parse(r.fetched_at)) ? new Date(r.fetched_at).toISOString() : new Date().toISOString() };
}
export async function reportFetch(e: any, b: any): Promise<Response> {
  let result: BiliResult | null = null;
  if (b.success === true) { try { result = cleanResult(b.result); } catch { return Response.json({ error: "invalid video result" }, { status: 400 }); } }
  const now = Date.now();
  // Repeat reports can finish cache/waiter writes after an interrupted response.
  const row = await e.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status IN ('done','failed'))").bind(b.id, b.lease, now).first();
  if (!row) return Response.json({ error: "lease conflict" }, { status: 409 });
  if (row.status !== "running" && (row.status === "done") !== (b.success === true))
    return Response.json({ error: "lease conflict" }, { status: 409 });
  const p = JSON.parse(row.payload), status = result ? "done" : "failed";
  // Fence every write, not only the initial read: another runner may acquire the
  // expired lease between reading the payload and committing this batch.
  const guard = "id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status=?)";
  const leaseArgs = [b.id, b.lease, now, status];
  const writes = [];
  if (result) for (const ref of new Set([p.ref, result.bvid]))
    writes.push(e.DB.prepare("INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE " + guard + ")")
      .bind("bili:" + ref, JSON.stringify(result), new Date(now).toISOString(), ...leaseArgs));
  writes.push(e.DB.prepare("UPDATE video_waits SET ready=1 WHERE status='waiting' AND id IN (SELECT value FROM jobs,json_each(jobs.payload,'$.waiters') WHERE " + guard.replace("id=?", "jobs.id=?") + ")")
    .bind(...leaseArgs));
  writes.push(e.DB.prepare("UPDATE jobs SET status=?,error=? WHERE " + guard)
    .bind(status, result ? null : "本机抓取未完成", ...leaseArgs));
  await e.DB.batch(writes);
  const committed = await e.DB.prepare("SELECT payload FROM jobs WHERE id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND status=?")
    .bind(b.id, b.lease, status).first();
  if (!committed) return Response.json({ error: "lease conflict" }, { status: 409 });
  const waiters: string[] = [...new Set<string>((JSON.parse(committed.payload).waiters || []).filter((s: any) => typeof s === "string"))];
  for (const waiter of waiters) await wakeVideoWait(e, waiter);
  return Response.json({ ok: true });
}
export async function fetchRoute(e: any, path: string, b: any): Promise<Response> {
  if (path.endsWith('/claim')) return Response.json({ job: await claimFetch(e) });
  if (path.endsWith('/heartbeat')) { const ok = await heartbeatFetch(e, b.id, b.lease); return Response.json({ ok }, { status: ok ? 200 : 409 }); }
  if (path.endsWith('/report')) return reportFetch(e, b);
  if (path.endsWith('/auth-status')) {
    if (!["bili", "x"].includes(b.service) || !["ok", "expired", "risk", "missing"].includes(b.state)) return Response.json({ error: "invalid auth state" }, { status: 400 });
    const key = "auth:" + b.service, old = await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
    let previous: any = {}; try { previous = JSON.parse(old?.value || "{}"); } catch {}
    await e.DB.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, JSON.stringify({ state: b.state, checked_at: new Date().toISOString(), had_ok: b.state === "ok" || previous.had_ok === true })).run();
    return Response.json({ ok: true });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
