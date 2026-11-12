import {FAILURE_PREFIX,OFFLINE_MS,READ_REASONS,fetchFailure,failureTtl,jobReason,biliFailReply,biliFailMaterial,type ReadReason} from './linkfail';
import { left } from "./d1";
import { stage, flushTail } from "./timing";
import { TEAM } from "./config";
import { extractBili } from "./inbound";
import { metaOf } from "./view";
import { loadChatContext } from "./context";
import { agentAnswer } from "./semantic";
import { enqueueVoice, decodeVoice } from "./voice";
import { queueFor } from "./lanes";
import { untrusted } from "./untrusted";
import { redact } from "./runtime";
import {recordAuthStatus} from './auth-status';
import {claimLogin,reportLogin,fetcherSeen} from './login-flow';
export {authReminder} from './auth-status';
import {isTitleRef,titleRef,titleMissOf,titleMaterial,titleMissMaterial,TITLE_FALLBACK,type TitleMiss} from './bilititle';

type Row = Record<string, any>;
export type BiliResult = {
  bvid: string; title: string; desc: string; owner: string; tname: string;
  duration: number; pubdate: number; stat: Record<string, number>;
  subtitle: string | null; subtitle_lang: string | null;
  subtitle_status: "ok" | "none" | "login_required" | "unavailable";
  comments: { uname: string; message: string }[]; tier: "light"; fetched_at: string;
};
const BV = /^BV[0-9A-Za-z]{10}$/;
const validRef = (s: string) => BV.test(s) || /^[0-9A-Za-z]{4,12}$/.test(s);
function refIn(bili: any[]): string | null {
  return bili?.find(b => BV.test(b.bvid || ""))?.bvid || bili?.find(b => /^[0-9A-Za-z]{4,12}$/.test(b.short || ""))?.short || null;
}
type VideoTarget = {ref:string;title?:string};
function targetOf(meta: any): VideoTarget | null {
  const direct = refIn(meta.bili); if (direct) return {ref:direct};
  const title = meta.biliCard?.title, ref = typeof title === 'string' ? titleRef(title) : null;
  return ref ? {ref,title} : null;
}
export function videoTarget(_batch: Row[], latest: Row, recent: Row[], cfg: any): VideoTarget | null {
  if (!cfg.bili?.enabled) return null;
  const meta = metaOf(latest);
  if (latest.mentioned) { const target = targetOf(meta); if (target) return target; }
  const quoted = recent.find(r => r.id === meta.replyTo?.targetId);
  const quotedTarget = quoted ? targetOf(metaOf(quoted)) : null;
  if (quotedTarget) return quotedTarget;
  const ref = refIn(extractBili(meta.quotedBiliUrls ?? meta.quotedUrls ?? [], ""));
  if (ref) return {ref};
  const embedded = targetOf(meta.quoted || {}); if (embedded) return embedded;
  if (/视频|讲了?啥|讲的什么|说了什么|总结|值得看|up主/i.test(latest.body || "")) {
    const candidates = recent.some(r => r.id === latest.id) ? recent : [...recent, latest];
    for (const r of candidates.slice(-10).reverse()) { const target = targetOf(metaOf(r)); if (target) return target; }
  }
  return null;
}
export const needsVideo = (batch: Row[], latest: Row, recent: Row[], cfg: any) => videoTarget(batch,latest,recent,cfg)?.ref ?? null;
export async function biliCached(e: any, ref: string): Promise<BiliResult | TitleMiss | null> {
  const row = await e.DB.prepare("SELECT body,created_at FROM media_notes WHERE id=?").bind("bili:" + ref).first();
  if (!row || !(Date.parse(row.created_at) >= Date.now() - (isTitleRef(ref) ? 86400000 : 7 * 86400000))) return null;
  try { const value = JSON.parse(row.body); return isTitleRef(ref) && titleMissOf(value) || cleanResult(value); } catch { return null; }
}
/** Read stable failures and reader presence together within the chat budget. */
export async function biliFailure(e: any, ref: string): Promise<ReadReason | null> {
  const row = await e.DB.prepare("SELECT (SELECT body FROM media_notes WHERE id=?) f,(SELECT value FROM settings WHERE key='fetcher:last-seen') seen")
    .bind(FAILURE_PREFIX + ref).first();
  const now = Date.now();
  try { const f = JSON.parse(row.f); if (f && f.until > now && READ_REASONS.includes(f.reason)) return f.reason; } catch {}
  return row.seen !== null && now - Number(row.seen) > OFFLINE_MS ? 'offline' : null;
}
/** Failed jobs take precedence over presence; an online reader may simply be slow. */
export async function fetchOutcome(e: any, ref: string): Promise<ReadReason> {
  const row = await e.DB.prepare("SELECT (SELECT status FROM jobs WHERE id=?) status,(SELECT error FROM jobs WHERE id=?) error,(SELECT value FROM settings WHERE key='fetcher:last-seen') seen")
    .bind('fetch-bili-' + ref, 'fetch-bili-' + ref).first();
  if (row.status === 'failed') return jobReason(row.error);
  return row.seen !== null && Date.now() - Number(row.seen) > OFFLINE_MS ? 'offline' : 'timeout';
}
function fetchStatement(e: any, ref: string, tier: string, waiter: string, waitCreated?: number, title?: string) {
  return e.DB.prepare(`INSERT INTO jobs(id,kind,payload,created_at)
    SELECT ?,'fetch',?,? ${waitCreated === undefined ? "" : "WHERE EXISTS(SELECT 1 FROM video_waits WHERE id=? AND created_at=?)"}
    ON CONFLICT(id) DO UPDATE SET
      payload=CASE WHEN jobs.status IN ('pending','running') THEN json_insert(jobs.payload,'$.waiters[#]',?) ELSE excluded.payload END,
      status=CASE WHEN jobs.status IN ('pending','running') THEN jobs.status ELSE 'pending' END,
      attempts=CASE WHEN jobs.status IN ('pending','running') THEN jobs.attempts ELSE 0 END,
      lease_until=CASE WHEN jobs.status IN ('pending','running') THEN jobs.lease_until ELSE 0 END,error=NULL`)
    .bind("fetch-bili-" + ref, JSON.stringify({ type: "bili", tier, ref, ...(isTitleRef(ref) ? {title} : {}), waiters: [waiter] }), Date.now(), ...(waitCreated === undefined ? [] : [waiter, waitCreated]), waiter);
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
export async function startVideoWait(e: any, x: { groupId: string; ref: string; title?: string; latest: Row; batchIds: string[]; mentioned: boolean }): Promise<boolean> {
  if (isTitleRef(x.ref) && (!x.title || !titleRef(x.title))) return false;
  if (await videoWaitExists(e, x.groupId, x.latest.id)) return true;
  const active = await e.DB.prepare("SELECT COUNT(*) n FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')").bind(x.groupId, x.ref).first();
  if (active.n >= 3) return false;
  const now = Date.now(), id = "vw-" + x.latest.id;
  await e.DB.batch([
    e.DB.prepare(`INSERT OR IGNORE INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,due_at,created_at)
      SELECT ?,?,?,?,?,?,COALESCE((SELECT MIN(due_at) FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')),?),?
      WHERE (SELECT COUNT(*) FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')) < 3`)
      .bind(id, x.groupId, x.ref, x.latest.id, JSON.stringify(x.batchIds.slice(0, 60)), x.mentioned ? 1 : 0, x.groupId, x.ref, now + TEAM.bili.wait_seconds * 1000, now, x.groupId, x.ref),
    fetchStatement(e, x.ref, "light", id, now, x.title),
  ]);
  const created = await e.DB.prepare("SELECT id FROM video_waits WHERE id=? AND created_at=? AND status='waiting'").bind(id, now).first();
  if (created) stage(e, x.latest.id, "bili_wait_start");
  return !!created;
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
  if (row) {
    await queueFor(e, "video_reply")?.send({ id });
    stage(e, waitId.slice(3), "wait_woken");
  }
}
export function biliNoteText(r: BiliResult): string {
  const hasSubtitle = r.subtitle_status === 'ok' && !!r.subtitle?.trim();
  return [hasSubtitle ? '【已取得字幕】' : '【已读元数据/热评】',`标题：${r.title}`, `UP 主：${r.owner}；分区：${r.tname}；时长：${r.duration}秒`, `简介：${r.desc}`,
    `热评（观众意见）：${r.comments.map(c => c.uname + "：" + c.message).join("\n") || "未读到"}`,
    hasSubtitle
      ? `字幕（${r.subtitle_lang || "未知语言"}）：${r.subtitle}`
      : r.subtitle_status === "login_required"
        ? "未读到 CC 字幕（需登录）；未查看画面或听取音轨。"
        : r.subtitle_status === "unavailable"
          ? "未读到 CC 字幕（字幕接口未完成）；未查看画面或听取音轨。"
          : "无 CC 字幕；未查看画面或听取音轨。"].join("\n").slice(0, 6000);
}
export function videoMaterial(r: BiliResult | TitleMiss, ref = '') {
  return 'miss' in r ? titleMissMaterial(r) : isTitleRef(ref) ? titleMaterial(r) : untrusted('bilibili',biliNoteText(r),r.fetched_at);
}
export async function runVideoWait(e: any, waitId: string): Promise<void> {
  e.timingTurn = waitId.slice(3);
  const now = Date.now();
  const w = await e.DB.prepare(`UPDATE video_waits SET status='running',lease_until=?,attempts=attempts+1 WHERE id=? AND attempts<3 AND
    ((status='waiting' AND (ready=1 OR due_at<=?)) OR (status='running' AND lease_until<?)) RETURNING *`)
    .bind(now + 120000, waitId, now, now).first();
  if (!w) return;
  try {
    const cached = await biliCached(e, w.ref);
    const outcome = cached ? null : await fetchOutcome(e, w.ref);
    if (outcome && outcome !== 'timeout' && w.mentioned) {
      const owns = await e.DB.prepare("SELECT id FROM video_waits WHERE id=? AND status='running' AND lease_until=?").bind(w.id, w.lease_until).first();
      if (!owns) return;
      await enqueueVoice(e, "video-" + w.id, w.group_id, w.latest_id, biliFailReply(outcome,{title:isTitleRef(w.ref)}));
      await e.DB.prepare("UPDATE video_waits SET status='done' WHERE id=? AND status='running' AND lease_until=?").bind(w.id, w.lease_until).run();
      return;
    }
    const context = await loadChatContext(e, { groupId: w.group_id, latestId: w.latest_id, batchIds: JSON.parse(w.batch_ids) });
    const materials = cached ? [videoMaterial(cached,w.ref)] : [biliFailMaterial(outcome!,{title:isTitleRef(w.ref),titleFallback:TITLE_FALLBACK})];
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
  await e.DB.prepare("UPDATE jobs SET status='failed',error='timeout' WHERE kind='fetch' AND status='running' AND attempts>=2 AND lease_until<?").bind(now).run();
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
    subtitle_status: ["ok", "none", "login_required", "unavailable"].includes(r.subtitle_status)
      ? r.subtitle_status
      : typeof r.subtitle === "string" ? "ok" : "none",
    comments: (Array.isArray(r.comments) ? r.comments : []).slice(0, 8).map((c: any) => ({ uname: text(c?.uname, 100), message: text(c?.message, 120) })), tier: "light", fetched_at: Number.isFinite(Date.parse(r.fetched_at)) ? new Date(r.fetched_at).toISOString() : new Date().toISOString() };
}
export async function reportFetch(e: any, b: any): Promise<Response> {
  const fail = b.success === true ? null : fetchFailure(b);
  let result: BiliResult | TitleMiss | null = null;
  if (b.success === true) {
    try {
      if (b.result && Object.hasOwn(b.result,'miss')) { result = titleMissOf(b.result); if (!result) throw Error('invalid title miss'); }
      else result = cleanResult(b.result);
    } catch { return Response.json({ error: "invalid video result" }, { status: 400 }); }
  }
  const now = Date.now();
  // Repeat reports can finish cache/waiter writes after an interrupted response.
  const row = await e.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status IN ('done','failed'))").bind(b.id, b.lease, now).first();
  if (!row) return Response.json({ error: "lease conflict" }, { status: 409 });
  if (row.status !== "running" && (row.status === "done") !== (b.success === true))
    return Response.json({ error: "lease conflict" }, { status: 409 });
  const p = JSON.parse(row.payload), status = result ? "done" : "failed";
  if (result && 'miss' in result && !isTitleRef(p.ref)) return Response.json({error:'invalid title result'}, {status:400});
  // Fence every write, not only the initial read: another runner may acquire the
  // expired lease between reading the payload and committing this batch.
  const guard = "id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status=?)";
  const leaseArgs = [b.id, b.lease, now, status];
  const writes = [];
  if (result) for (const ref of new Set('miss' in result ? [p.ref] : [p.ref,result.bvid]))
    writes.push(e.DB.prepare("INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE " + guard + ")")
      .bind("bili:" + ref, JSON.stringify(result), new Date(now).toISOString(), ...leaseArgs));
  writes.push(e.DB.prepare("UPDATE video_waits SET ready=1 WHERE status='waiting' AND id IN (SELECT value FROM jobs,json_each(jobs.payload,'$.waiters') WHERE " + guard.replace("id=?", "jobs.id=?") + ")")
    .bind(...leaseArgs));
  if (fail && failureTtl(fail) > 0)
    writes.push(e.DB.prepare("INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE " + guard + ")")
      .bind(FAILURE_PREFIX + p.ref, JSON.stringify({reason:fail.reason,until:now + failureTtl(fail)}), new Date(now).toISOString(), ...leaseArgs));
  writes.push(e.DB.prepare("UPDATE jobs SET status=?,error=? WHERE " + guard)
    .bind(status, result ? null : fail!.reason, ...leaseArgs));
  await e.DB.batch(writes);
  const committed = await e.DB.prepare("SELECT payload FROM jobs WHERE id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND status=?")
    .bind(b.id, b.lease, status).first();
  if (!committed) return Response.json({ error: "lease conflict" }, { status: 409 });
  const waiters: string[] = [...new Set<string>((JSON.parse(committed.payload).waiters || []).filter((s: any) => typeof s === "string"))];
  for (const waiter of waiters.slice(0, 3)) stage(e, waiter.slice(3), "fetch_reported");
  for (const waiter of waiters) await wakeVideoWait(e, waiter);
  return Response.json({ ok: true });
}
async function dispatchFetch(e: any, path: string, b: any): Promise<Response> {
  await fetcherSeen(e);
  if (path.endsWith('/claim')) {
    const login=await claimLogin(e);
    const job=login?null:await claimFetch(e);
    for (const waiter of (job?.payload?.waiters || []).slice(0,3)) stage(e, waiter.slice(3), "fetch_claimed");
    return Response.json({login,job});
  }
  if(path.endsWith('/login-state'))return reportLogin(e,b);
  if (path.endsWith('/heartbeat')) { const ok = await heartbeatFetch(e, b.id, b.lease); return Response.json({ ok }, { status: ok ? 200 : 409 }); }
  if (path.endsWith('/report')) return reportFetch(e, b);
  if (path.endsWith('/auth-status')) return recordAuthStatus(e,b);
  return Response.json({ error: "not found" }, { status: 404 });
}
export async function fetchRoute(e: any, path: string, b: any): Promise<Response> {
  const result = await dispatchFetch(e, path, b);
  await flushTail(e);
  return result;
}
