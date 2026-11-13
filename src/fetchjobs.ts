import {planVideo,switchToMedia,sweepMedia,dispatchMedia} from "./mediajobs";
import {FAILURE_PREFIX,OFFLINE_MS,READ_REASONS,fetchFailure,failureTtl,jobReason,biliFailReply,biliFailMaterial,type ReadReason} from './linkfail';
import { left } from "./d1";
import { stage, flushTail } from "./timing";
import { TEAM } from "./config";
import { extractBili } from "./inbound";
import { SHORT_CODE,parseBiliTarget,type BiliTarget as ParsedBiliTarget } from './bili-links';
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
  bvid: string; cid?: number; page: number; pages: number; aid: number; title: string; desc: string; owner: string; tname: string;
  duration: number; pubdate: number; stat: Record<string, number>;
  subtitle: string | null; subtitle_lang: string | null;
  subtitle_status: "ok" | "none" | "login_required" | "unavailable";
  comments: { uname: string; message: string }[]; tier: "light"; fetched_at: string;
};
const BV = /^BV[0-9A-Za-z]{10}$/;
export type BiliTarget = ParsedBiliTarget & {sourceId:string};
export const refKey = (t: ParsedBiliTarget) => t.base + (t.page > 1 ? '~p' + t.page : '');
function refTarget(ref: string): ParsedBiliTarget | null {
  if (typeof ref !== 'string') return null;
  const parts=ref.match(/^(.+?)(?:~p([1-9]\d{0,2}))?$/);if(!parts)return null;
  const base=parts[1],page=Number(parts[2]||1);
  if(isTitleRef(base))return parts[2]?null:{kind:'title',base,page:1};
  if(BV.test(base))return {kind:'bv',base,page};
  if(/^av\d{1,12}$/.test(base))return {kind:'aid',base,page};
  return SHORT_CODE.test(base)&&!parts[2]?{kind:'short',base,page:0}:null;
}
export const validRef = (s: string) => refTarget(s)!==null;
export function targetIn(bili: any[],sourceId=''): BiliTarget | null {
  for(const field of ['bvid','aid','short'])for(const b of bili||[]){
    const base=b?.[field];if(typeof base!=='string')continue;
    const parsed=refTarget(base);if(!parsed||parsed.kind!==({bvid:'bv',aid:'aid',short:'short'} as any)[field])continue;
    const page=field==='short'?0:b.page??parseBiliTarget(b.url||'')?.page??1;
    if(!Number.isInteger(page)||page<0||page>999||field!=='short'&&page<1)continue;
    return {...parsed,page,sourceId};
  }
  return null;
}
export type VideoTarget = {ref:string;target:BiliTarget;title?:string};
function asVideo(target:BiliTarget,title?:string):VideoTarget { return {ref:refKey(target),target,...(title?{title}:{})}; }
function targetOf(meta: any,sourceId=''): VideoTarget | null {
  const direct = targetIn(meta.bili,sourceId); if (direct) return asVideo(direct);
  const title = meta.biliCard?.title, ref = typeof title === 'string' ? titleRef(title) : null;
  return ref ? asVideo({kind:'title',base:ref,page:1,sourceId},title) : null;
}
export function videoTarget(_batch: Row[], latest: Row, recent: Row[], cfg: any): VideoTarget | null {
  if (!cfg.bili?.enabled) return null;
  const meta = metaOf(latest);
  if (latest.mentioned) { const target = targetOf(meta,latest.id); if (target) return target; }
  const quoted = recent.find(r => r.id === meta.replyTo?.targetId);
  const quotedTarget = quoted ? targetOf(metaOf(quoted),quoted.id) : null;
  if (quotedTarget) return quotedTarget;
  const direct = targetIn(extractBili(meta.quotedBiliUrls ?? meta.quotedUrls ?? [], ""),meta.replyTo?.targetId||latest.id);
  if (direct) return asVideo(direct);
  const embedded = targetOf(meta.quoted || {},meta.replyTo?.targetId||latest.id); if (embedded) return embedded;
  if (/视频|讲了?啥|讲的什么|说了什么|总结|值得看|up主/i.test(latest.body || "")) {
    const candidates = recent.some(r => r.id === latest.id) ? recent : [...recent, latest];
    for (const r of candidates.slice(-10).reverse()) { const target = targetOf(metaOf(r),r.id); if (target) return target; }
  }
  return null;
}
export const needsVideo = (batch: Row[], latest: Row, recent: Row[], cfg: any) => videoTarget(batch,latest,recent,cfg)?.ref ?? null;
export async function biliCached(e: any, ref: string): Promise<BiliResult | TitleMiss | null> {
  const target=refTarget(ref);if(!target)return null;
  // One statement keeps research and chat within their existing read budgets.
  const row=await e.DB.prepare(`SELECT n.body,n.created_at,a.body alias,a.created_at alias_at,r.body resource,r.created_at resource_at,l.body legacy,l.created_at legacy_at,f.body failure
    FROM (SELECT 1) LEFT JOIN media_notes n ON n.id=? LEFT JOIN media_notes a ON a.id=?
    LEFT JOIN media_notes r ON r.id='resource:v1:bili:'||json_extract(CASE WHEN json_valid(a.body) THEN a.body ELSE '{}' END,'$.bvid')||':p:'||json_extract(CASE WHEN json_valid(a.body) THEN a.body ELSE '{}' END,'$.page')
    LEFT JOIN media_notes l ON l.id=? LEFT JOIN media_notes f ON f.id=?`)
    .bind(target.kind==='bv'?'resource:v1:bili:'+target.base+':p:'+target.page:'', 'alias:v1:bili:'+ref,
      target.kind==='title'||target.kind==='bv'&&target.page===1?'bili:'+ref:'', FAILURE_PREFIX+ref).first();
  const fresh=(at:any,ttl=7*86400000)=>Date.parse(at)>=Date.now()-ttl;
  try {if(row?.body&&fresh(row.created_at)){const value=cleanResult(JSON.parse(row.body),true);if(value.bvid===target.base&&value.page===target.page)return value;}}catch{}
  try {
    if(row?.resource&&fresh(row.resource_at)&&fresh(row.alias_at,target.kind==='title'?86400000:7*86400000)){
      const alias=JSON.parse(row.alias),value=cleanResult(JSON.parse(row.resource),true);
      if(value.bvid===alias.bvid&&value.page===alias.page&&(target.kind==='short'||target.kind==='title'&&value.page===1||target.kind==='bv'&&value.bvid===target.base&&value.page===target.page||target.kind==='aid'&&value.page===target.page))return value;
    }
  }catch{}
  try {if(row?.legacy&&fresh(row.legacy_at,target.kind==='title'?86400000:7*86400000)){const value=JSON.parse(row.legacy);return target.kind==='title'&&titleMissOf(value)||cleanResult(value);}}catch{}
  try {const f=JSON.parse(row?.failure);if(target.kind==='title'&&f.until>Date.now())return titleMissOf(f);}catch{}
  return null;
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
  const target=refTarget(ref);if(!target)throw Error('invalid fetch request');
  if(target.kind==='title'&&(typeof title!=='string'||![...title].length||[...title].length>100||/[\p{Cc}\p{Cf}]/u.test(title)))throw Error('invalid fetch title');
  return e.DB.prepare(`INSERT INTO jobs(id,kind,payload,created_at)
    SELECT ?,'fetch',?,? ${waitCreated === undefined ? "" : "WHERE EXISTS(SELECT 1 FROM video_waits WHERE id=? AND created_at=?)"}
    ON CONFLICT(id) DO UPDATE SET
      payload=CASE WHEN jobs.status IN ('pending','running') THEN json_insert(jobs.payload,'$.waiters[#]',?) ELSE excluded.payload END,
      status=CASE WHEN jobs.status IN ('pending','running') THEN jobs.status ELSE 'pending' END,
      attempts=CASE WHEN jobs.status IN ('pending','running') THEN jobs.attempts ELSE 0 END,
      lease_until=CASE WHEN jobs.status IN ('pending','running') THEN jobs.lease_until ELSE 0 END,error=NULL`)
    .bind("fetch-bili-" + ref, JSON.stringify({ v:2, type: "bili", tier, ref, ...target, ...(isTitleRef(ref) ? {title} : {}), waiters: [waiter] }), Date.now(), ...(waitCreated === undefined ? [] : [waiter, waitCreated]), waiter);
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
export async function startVideoWait(e: any, x: { groupId: string; ref: string; title?: string; latest: Row; batchIds: string[]; mentioned: boolean; lightReady?: boolean }): Promise<boolean> {
  if (isTitleRef(x.ref) && (!x.title || !titleRef(x.title))) return false;
  if (await videoWaitExists(e, x.groupId, x.latest.id)) return true;
  const active = await e.DB.prepare("SELECT COUNT(*) n FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')").bind(x.groupId, x.ref).first();
  if (active.n >= 3) return false;
  const now = Date.now(), id = "vw-" + x.latest.id;
  await e.DB.batch([
    e.DB.prepare(`INSERT OR IGNORE INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,ready,due_at,created_at)
      SELECT ?,?,?,?,?,?,?,COALESCE((SELECT MIN(due_at) FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')),?),?
      WHERE (SELECT COUNT(*) FROM video_waits WHERE group_id=? AND ref=? AND status IN ('waiting','running')) < 3`)
      .bind(id, x.groupId, x.ref, x.latest.id, JSON.stringify(x.batchIds.slice(0, 60)), x.mentioned ? 1 : 0, x.lightReady ? 1 : 0, x.groupId, x.ref, now + TEAM.bili.wait_seconds * 1000, now, x.groupId, x.ref),
    ...(x.lightReady ? [] : [fetchStatement(e, x.ref, "light", id, now, x.title)]),
  ]);
  const created = await e.DB.prepare("SELECT id FROM video_waits WHERE id=? AND created_at=? AND status='waiting'").bind(id, now).first();
  if (created) { stage(e, x.latest.id, "bili_wait_start"); if(x.lightReady)await wakeVideoWait(e,id); }
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
type BiliMaterialOptions = {asr?:boolean; asrOmitted?:boolean};
export function biliNoteText(r: BiliResult, opts: BiliMaterialOptions = {}): string {
  const hasSubtitle = r.subtitle_status === 'ok' && !!r.subtitle?.trim();
  // Keep answerable facts before long descriptions/subtitles so bounded material
  // never loses the video's identity or the first available viewer comment.
  return [`BV号：${r.bvid}`, `标题：${r.title}`, `UP主：${r.owner}`, `时长：${r.duration}秒`,
    `热评：${r.comments.map(c => c.uname + "：" + c.message).join("\n") || "热评未读到"}`,
    hasSubtitle ? '【已取得字幕】' : '【已读元数据/热评】',
    `分区：${r.tname}`, `简介：${r.desc}`,
    hasSubtitle
      ? `字幕（${r.subtitle_lang || "未知语言"}）：${r.subtitle}`
      : [r.subtitle_status === "login_required" ? "未拿到 CC 字幕（需登录）。"
          : r.subtitle_status === "unavailable" ? "未拿到 CC 字幕（字幕接口未完成）。" : "无 CC 字幕。",
        opts.asr ? "没拿到字幕；已用本机语音转写读取音轨，转写见【bilibili-asr】素材。未查看画面。" : opts.asrOmitted ? "没拿到字幕；本轮只附一份转写，此视频仅附标题、简介和热评。未查看画面。" : "没拿到字幕，以下基于标题与评论。未查看画面或听取音轨。"].join("")].join("\n").slice(0, 6000);
}
const RESEARCH_REFS = 3, RESEARCH_READS = 8, MATERIAL_CHARS = 4000, MATERIALS_CHARS = 10000;
// These are application requirements, not instructions supplied by a video/UP.
// Keep them outside the untrusted envelope, whose closing boundary stays intact.
const BILI_ANSWER_RULE = '回答必须保留素材里已读到的BV号、标题、UP主、时长，有热评就转述至少一条；没有就如实说热评未读到。给最终表达的brief必须包含这五项原文，不要只说“已读到”。没拿到字幕时说“没拿到字幕，以下基于标题与评论”，不能因此整体否定已取得的素材。素材里没有的数字不要写，不把另行检索的信息当成视频内容。';
const BILI_ASR_RULE = BILI_ANSWER_RULE.replace('没拿到字幕时说“没拿到字幕，以下基于标题与评论”，不能因此整体否定已取得的素材。', '没拿到字幕但有音轨转写时，以转写为主要依据，开头说明“根据音轨转写”，转写可能有错别字和专名误识；转写只覆盖部分时说明覆盖到几分几秒。');
const BILI_ASR_OMITTED_RULE = BILI_ANSWER_RULE.replace('没拿到字幕时说“没拿到字幕，以下基于标题与评论”，不能因此整体否定已取得的素材。', '本轮只附一份转写；未附转写的视频只依据各自标题、简介和热评，不推测音轨内容。');
export type VideoMaterial = {material:string;rule:string};
/** The application rule is returned beside the envelope, never inside it. */
export function videoMaterial(r: BiliResult | TitleMiss, ref = '', max = MATERIAL_CHARS, opts: BiliMaterialOptions = {}): VideoMaterial {
  let answerRule = BILI_ANSWER_RULE;
  if (!('miss' in r) && !(r.subtitle_status==='ok' && r.subtitle?.trim()))
    answerRule = opts.asr ? BILI_ASR_RULE : opts.asrOmitted ? BILI_ASR_OMITTED_RULE : BILI_ANSWER_RULE;
  const rule = 'miss' in r ? '' : answerRule;
  const bodyMax = Math.max(0, max - untrusted('bilibili', '', r.fetched_at).length);
  const material = 'miss' in r ? titleMissMaterial(r, bodyMax) : isTitleRef(ref) ? titleMaterial(r, bodyMax)
    : untrusted('bilibili',biliNoteText(r,opts),r.fetched_at,bodyMax);
  return {material, rule};
}
/** Cached Bili notes already fetched for this turn; never invent missing content. */
export type BiliResearchMaterials = {materials:string[];rules:string[]};
export async function biliResearchMaterials(e: any, context: any): Promise<BiliResearchMaterials> {
  const batch = (context.batch || []).filter(Boolean), latest = context.latest, recent = context.recent || [];
  const refs: string[] = [];
  const add = (value: any) => {
    if (typeof value !== 'string' || refs.length >= RESEARCH_REFS) return;
    if (validRef(value) && !refs.includes(value)) refs.push(value);
  };
  // Only this turn's target and messages; old links in unrelated history are not material.
  const target = latest ? videoTarget(batch, latest, recent, TEAM) : null;
  if (target) add(target.ref);
  for (const row of [latest, ...batch].filter(Boolean)) {
    const meta = row.meta || {};
    for (const b of meta.bili || []) { const t=targetIn([b],row.id);if(t)add(refKey(t)); }
    for (const url of [...(meta.biliUrls || []), ...(meta.quotedBiliUrls || []), ...(meta.quotedUrls || [])]) {
      const t=targetIn(extractBili([url], ''),row.id);if(t)add(refKey(t));
    }
    const quoted = targetOf(meta.quoted || {}); if (quoted) add(quoted.ref);
  }
  if (!refs.length) return {materials:[],rules:[]};
  const materials: string[] = [], rules: string[] = [];
  let total = 0, reads = 0, asrAttached = false;
  const budget = Math.min(RESEARCH_READS, Number.isFinite(left(e)) ? Math.max(0, left(e) - 2) : RESEARCH_READS);
  for (const ref of refs.slice(0, RESEARCH_REFS)) {
    if (reads + 1 > budget) break;
    const cached = await biliCached(e, ref); reads++;
    let material: string, rule = '', extra: string | undefined, isAsr = false;
    if (cached) {
      if(reads+1>budget)break;
      const plan=await planVideo(e,cached,ref,'research',Date.now());reads++;
      isAsr=plan.materials[1]?.includes('来源:bilibili-asr')??false;
      extra=isAsr&&asrAttached?undefined:plan.materials[1];
      const out=videoMaterial(cached,ref,Math.min(MATERIAL_CHARS,MATERIALS_CHARS-total),{asr:isAsr&&!asrAttached,asrOmitted:isAsr&&asrAttached});
      material=out.material; rule=out.rule;
    }
    else {
      if (reads + 1 > budget) break;
      const outcome = await fetchOutcome(e, ref); reads++;
      if (!outcome || outcome === 'timeout') continue;
      material = biliFailMaterial(outcome, {title:isTitleRef(ref), titleFallback:TITLE_FALLBACK});
    }
    if (materials.includes(material) || total + material.length > MATERIALS_CHARS) continue;
    materials.push(material); total += material.length;
    if(rule&&!rules.includes(rule))rules.push(rule);
    if(extra&&!materials.includes(extra)){
      if(isAsr&&!asrAttached){materials.push(extra);asrAttached=true;}
      else if(!isAsr&&total+extra.length<=MATERIALS_CHARS){materials.push(extra);total+=extra.length;}
    }
  }
  return {materials,rules};
}
/** True when a resume message list already carries this material; a handoff must not append it twice. */
export function materialInjected(messages: any[], material: string): boolean {
  const visit = (value: any): boolean => {
    if (typeof value === 'string') {
      if (value.includes(material)) return true;
      if (/^\s*[[{]/.test(value)) { try { return visit(JSON.parse(value)); } catch {} }
      return false;
    }
    if (Array.isArray(value)) return value.some(visit);
    return !!value && typeof value === 'object' && Object.values(value).some(visit);
  };
  return (messages || []).some(m => visit(m?.content));
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
    let materials: string[], rules: string[] = [];
    if(cached){
      const plan=await planVideo(e,cached,w.ref,w.phase,now,w.due_at);
      if(plan.media==='start'){await switchToMedia(e,w,cached as BiliResult);return;}
      if(plan.media==='release'){
        await e.DB.prepare("UPDATE video_waits SET status='waiting',ready=0,lease_until=NULL,attempts=MAX(attempts-1,0) WHERE id=? AND status='running' AND lease_until=?").bind(w.id,w.lease_until).run();return;
      }
      materials=plan.materials;rules=plan.rules;
    }else materials=[biliFailMaterial(outcome!,{title:isTitleRef(w.ref),titleFallback:TITLE_FALLBACK})];
    const context = await loadChatContext(e, { groupId: w.group_id, latestId: w.latest_id, batchIds: JSON.parse(w.batch_ids) });
    const answer = await agentAnswer(e, { ...context, mentioned: !!w.mentioned, materials, rules, videoWaited: true });
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
  await sweepMedia(e);
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
function cleanResult(r: any,strict=false): BiliResult {
  const page=r?.page??(strict?undefined:1),pages=r?.pages??(strict?undefined:1),aid=r?.aid??(strict?undefined:0);
  if(!Number.isInteger(page)||!Number.isInteger(pages)||page<1||pages<page||!Number.isInteger(aid)||aid<0)throw Error('invalid video page');
  if (!r || !BV.test(r.bvid)) throw Error("invalid video result");
  const text = (s: any, max: number) => redact(typeof s === "string" ? s : "").slice(0, max);
  const number = (n: any) => Number.isFinite(n) && n >= 0 ? n : 0;
  return { bvid: r.bvid, ...(Number.isSafeInteger(r.cid)&&r.cid>0?{cid:r.cid}:{}), page, pages, aid, title: text(r.title, 300), desc: text(r.desc, 1500), owner: text(r.owner, 100), tname: text(r.tname, 100), duration: number(r.duration), pubdate: number(r.pubdate),
    stat: Object.fromEntries(["view", "like", "coin", "favorite", "reply"].map(k => [k, number(r.stat?.[k])])),
    subtitle: typeof r.subtitle === "string" ? text(r.subtitle, 6000) : null, subtitle_lang: typeof r.subtitle_lang === "string" ? text(r.subtitle_lang, 30) : null,
    subtitle_status: ["ok", "none", "login_required", "unavailable"].includes(r.subtitle_status)
      ? r.subtitle_status
      : typeof r.subtitle === "string" ? "ok" : "none",
    comments: (Array.isArray(r.comments) ? r.comments : []).slice(0, 8).map((c: any) => ({ uname: text(c?.uname, 100), message: text(c?.message, 120) })), tier: "light", fetched_at: Number.isFinite(Date.parse(r.fetched_at)) ? new Date(r.fetched_at).toISOString() : new Date().toISOString() };
}
export async function reportFetch(e: any, b: any): Promise<Response> {
  const now = Date.now();
  const row = await e.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status IN ('done','failed'))").bind(b.id, b.lease, now).first();
  if (!row) return Response.json({ error: "lease conflict" }, { status: 409 });
  const p=JSON.parse(row.payload),v2=p.v===2,compatible=p.kind==='bv'&&(p.page||1)===1||p.kind==='title';
  let fail: {reason:ReadReason;retryAfter?:number}|null=null,result:BiliResult|TitleMiss|null=null,miss:TitleMiss|null=null;
  if(b.success===true){
    if(v2&&b.proto!==2&&!compatible)fail={reason:'runner_outdated'};
    else try {
      if(b.result&&Object.hasOwn(b.result,'miss')){
        miss=titleMissOf(b.result);if(!miss||!isTitleRef(p.ref))return Response.json({error:'invalid title result'},{status:400});
        if(v2)fail={reason:miss.miss==='multiple'?'ambiguous':'not_found'};else result=miss;
      }else {
        const paged=v2&&b.proto===2;
        const raw=paged?b.result:{...b.result,page:1,pages:Number.isInteger(b.result?.pages)&&b.result.pages>=1?b.result.pages:1};
        result=cleanResult(raw,paged);
        if(v2&&b.proto===2&&('page' in result)&&((p.kind==='bv'||p.kind==='aid')&&result.page!==(p.page||1)||p.kind==='title'&&result.page!==1||p.kind==='bv'&&result.bvid!==p.base))throw Error('invalid video page');
      }
    }catch{
      if(!v2)return Response.json({error:'invalid video result'},{status:400});
      result=null;fail={reason:'invalid'};
    }
  }else if(!v2)fail=fetchFailure(b);
  else if(b.proto===2){
    const reasons=['risk','offline','timeout','not_found','login_required','ambiguous','runner_outdated','invalid'];
    fail={reason:reasons.includes(b.reason)?b.reason:'invalid',...(b.reason==='risk'?{retryAfter:fetchFailure(b).retryAfter}:{})};
  }else fail=b.reason==='风控'?{reason:'risk',retryAfter:600}:{reason:compatible?'invalid':'runner_outdated'};
  const status=result?'done':'failed';
  if(row.status!=='running'&&row.status!==status)return Response.json({error:'lease conflict'},{status:409});
  // Fence every write, not only the initial read: another runner may acquire the
  // expired lease between reading the payload and committing this batch.
  const guard = "id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status=?)";
  const leaseArgs = [b.id, b.lease, now, status];
  const writes = [];
  const cache=(key:string,value:any)=>writes.push(e.DB.prepare("INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE "+guard+")").bind(key,JSON.stringify(value),new Date(now).toISOString(),...leaseArgs));
  if(result&&'bvid' in result){
    cache('resource:v1:bili:'+result.bvid+':p:'+result.page,result);
    for(const ref of new Set([p.ref,result.bvid+(result.page>1?'~p'+result.page:'')]))cache('alias:v1:bili:'+ref,{bvid:result.bvid,page:result.page});
  }else if(result&&'miss' in result)cache('bili:'+p.ref,result); // In-flight pre-v2 jobs retain their old miss TTL.
  writes.push(e.DB.prepare("UPDATE video_waits SET ready=1 WHERE status='waiting' AND phase='light' AND id IN (SELECT value FROM jobs,json_each(jobs.payload,'$.waiters') WHERE " + guard.replace("id=?", "jobs.id=?") + ")")
    .bind(...leaseArgs));
  const ttl=fail?.reason==='ambiguous'?600000:fail?failureTtl(fail):0;
  if (fail && ttl > 0)
    writes.push(e.DB.prepare("INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE " + guard + ")")
      .bind(FAILURE_PREFIX + p.ref, JSON.stringify({reason:fail.reason,until:now + ttl,...(miss?{miss:miss.miss}:{})}), new Date(now).toISOString(), ...leaseArgs));
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
  if(path.startsWith('/api/runner/fetch/media/'))return dispatchMedia(e,path,b);
  await fetcherSeen(e);
  if (path.endsWith('/claim')) {
    const login=await claimLogin(e);
    const job=login?null:await claimFetch(e);
    for (const waiter of (job?.payload?.waiters || []).slice(0,3)) stage(e, waiter.slice(3), "fetch_claimed");
    return Response.json({login,job,proto:2});
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
