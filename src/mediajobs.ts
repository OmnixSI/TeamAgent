import {TEAM} from './config';
import {left} from './d1';
import {redact} from './runtime';
import {untrusted} from './untrusted';
import {isTitleRef} from './bilititle';
import {videoMaterial,wakeVideoWait,type BiliResult} from './fetchjobs';

const BV=/^BV[0-9A-Za-z]{10}$/;
export const MEDIA_OFFLINE_MS=180000;
export const RUNNER_REASONS=['login_required','paid','not_found','risk','audio_unavailable','download_failed','asr_unavailable','asr_failed','no_speech','media_timeout','mem_limit','local_busy','runner_outdated'] as const;
export const MEDIA_TEXT={
 runner_outdated:'本机音轨读取端版本过旧，请更新后再试',
 offline:'本机转写端没开，这次只看了标题、简介和热评',disabled:'听音轨功能现在是关着的',pending:'这条视频的音轨正在转写，还没出结果',
 login_required:'视频要登录才能播放，本机登录已失效',paid:'这是付费或充电专属视频，账号没有观看权限',not_found:'视频已删除或不可见',risk:'B 站暂时拦住了下载，请 10 分钟后再问',
 audio_unavailable:'B 站没给出可下载的音轨',download_failed:'音轨下载中断了',asr_unavailable:'本机语音转写程序没装好',asr_failed:'语音转写出错（第 N 段）',no_speech:'音轨里几乎没有人声（可能是纯音乐）',
 mem_limit:'本机内存不够，转写中途停了',local_busy:'本机临时空间或内存不够，这次没转写',media_timeout:'视频 X 分钟，本机 Y 分钟内没转写完',timeout:'视频 X 分钟，本机 Y 分钟内没转写完',
} as const;
export type MediaReason=keyof typeof MEDIA_TEXT;
export type AsrNote={bvid:string;page?:number;cid?:number;text:string;covered:number;duration:number;partial:boolean;chunks:number;created_at?:string};
export type VideoPlan={materials:string[];rules:string[];media:'none'|'start'|'release';reason?:MediaReason};
export const MEDIA_PENDING_MATERIAL='这条视频没有 CC 字幕，音轨本轮没有转写；只依据标题、简介和热评。';
const cfg=()=>({enabled:false,max_minutes:90,rtf:0.05,deadline_cap_minutes:40,mem_cap_mb:1300,tmp_cap_mb:2048,...(TEAM.bili as any)?.media});
export const mediaDeadlineMs=(seconds:number)=>Math.min(cfg().deadline_cap_minutes*60000,(180+seconds*(cfg().rtf+0.05)*2)*1000);
export const mediaAckText=(seconds:number)=>`这条视频没有字幕，我在听音轨，大约 ${Math.max(1,Math.ceil(mediaDeadlineMs(seconds)/120000))} 分钟后回复。`;
const clock=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
function reasonOf(value:unknown):MediaReason{const key=String(value??'').split(':')[0];return Object.hasOwn(MEDIA_TEXT,key)?key as MediaReason:'media_timeout';}
export function mediaFailMaterial(value:unknown,light:{duration:number}):string{
 const reason=reasonOf(value),chunk=/^asr_failed:(\d+)$/.exec(String(value));
 const text=MEDIA_TEXT[reason].replace('N',chunk?.[1]??'?').replace('X',String(Math.ceil(light.duration/60))).replace('Y',String(Math.ceil(mediaDeadlineMs(light.duration)/60000)));
 return `音轨读取结果：${text}。仍可依据标题、简介和热评回答；第一句说明这个原因，不假装已听取音轨或查看画面。`;
}
/** Select whole timestamped blocks: omission intervals are boundaries actually
 * present in the report, never an estimate from characters per second. */
function boundedTranscript(text:string,max:number):string{
 if(text.length<=max)return text;
 const matches=[...text.matchAll(/(?:^|\n)\[(\d+:\d{2})\]/g)];
 if(matches.length<4){
  const mark='\n[中间省略（缺少可核对的时间边界）]\n',room=Math.max(0,max-mark.length*2),a=Math.floor(room*.4),b=Math.floor(room*.2),c=room-a-b;
  return text.slice(0,a)+mark+text.slice(Math.max(a,Math.floor(text.length/2)-Math.floor(b/2)),Math.floor(text.length/2)+Math.ceil(b/2))+mark+text.slice(-c);
 }
 const blocks=matches.map((m,i)=>({time:m[1],text:text.slice(m.index!,matches[i+1]?.index??text.length).replace(/^\n/,'')}));
 const usable=Math.max(0,max-160),selected=new Set<number>();
 const select=(start:number,step:number,cap:number)=>{let n=0;for(let i=start;i>=0&&i<blocks.length;i+=step){const size=blocks[i].text.length+1;if(n+size>cap)break;selected.add(i);n+=size;}};
 select(0,1,Math.floor(usable*.4));select(Math.floor(blocks.length/2),1,Math.floor(usable*.2));select(blocks.length-1,-1,Math.floor(usable*.4));
 // A single anomalously long block still gets a bounded, explicitly un-timed omission.
 if(!selected.size)return boundedTranscript(text.replace(/\[(\d+:\d{2})\]/g,'($1)'),max);
 const ids=[...selected].sort((a,b)=>a-b),parts:string[]=[];let previous=-1;
 for(const id of ids){if(id>previous+1)parts.push(`[中间省略 ${blocks[previous+1].time}–${blocks[id].time}]`);parts.push(blocks[id].text);previous=id;}
 if(previous<blocks.length-1)parts.push(`[中间省略 ${blocks[previous+1].time}–末尾]`);
 return parts.join('\n').slice(0,max);
}
export function asrMaterial(note:AsrNote,max:number):string{
 const at=note.created_at??'未记录',header=`【bilibili-asr】本机语音转写，覆盖 0:00–${clock(note.covered)}（共 ${clock(note.duration)}）${note.partial?'，仅部分':''}`;
 const room=Math.max(0,max-untrusted('bilibili-asr','',at).length-header.length-1);
 return untrusted('bilibili-asr',header+'\n'+boundedTranscript(note.text,room),at,Math.max(0,max-untrusted('bilibili-asr','',at).length));
}
export const needsMedia=(light:BiliResult|Record<string,any>,ref:string)=>!('miss' in light)&&!isTitleRef(ref)&&light.subtitle_status!=='ok'&&light.duration>0;
/** Page one retains every deployed key; other pages never fall back to it. */
function mediaTarget(light:{page?:number;cid?:number},ref=''):{page:number;cid?:number}{
 const page=light.page??Number(/~p([1-9]\d{0,2})$/.exec(ref)?.[1]??1);
 if(!Number.isInteger(page)||page<1||page>999||light.cid!==undefined&&(!Number.isSafeInteger(light.cid)||light.cid<=0))throw Error('invalid media target');
 return {page,...(light.cid!==undefined?{cid:light.cid}:{})};
}
const mediaKeys=(bvid:string,page:number)=>({asr:'asr:'+bvid+(page>1?':p:'+page:''),failure:'asrfail:'+bvid+(page>1?':p:'+page:''),job:'bmedia-'+bvid+(page>1?'-p'+page:'')});
export async function planVideo(e:any,light:any,ref:string,mode:'light'|'media'|'research',now:number,waitDueAt?:number):Promise<VideoPlan>{
 const base=videoMaterial(light,ref),baseRules=base.rule?[base.rule]:[],none=(materials:string[],rules:string[]=baseRules):VideoPlan=>({materials,rules,media:'none'});
 if(!needsMedia(light,ref))return none([base.material]);
 const bvid=light.bvid,{page,cid}=mediaTarget(light,ref),keys=mediaKeys(bvid,page);
 const row=await e.DB.prepare(`SELECT
  (SELECT body FROM media_notes WHERE id=?1 AND created_at>=?2) AS asr,
  (SELECT created_at FROM media_notes WHERE id=?1) AS asr_at,
  (SELECT body FROM media_notes WHERE id=?3) AS failure,
  (SELECT value FROM settings WHERE key='media:last-seen') AS seen,
  (SELECT status FROM jobs WHERE id=?4) AS status,(SELECT error FROM jobs WHERE id=?4) AS error`)
  .bind(keys.asr,new Date(now-30*86400000).toISOString(),keys.failure,keys.job).first();
 try{const asr=JSON.parse(row.asr);if(asr&&asr.bvid===bvid&&typeof asr.text==='string'&&(asr.page??1)===page&&(page===1||Number.isSafeInteger(asr.cid)&&asr.cid>0)&&(cid===undefined||asr.cid===undefined&&page===1||asr.cid===cid)){const material=videoMaterial(light,ref,undefined,{asr:true});return none([material.material,asrMaterial({...asr,created_at:row.asr_at},mode==='research'?12000:24000)],material.rule?[material.rule]:[]);}}catch{}
 if(mode==='research')return none([base.material,MEDIA_PENDING_MATERIAL]);
 const fail=(reason:MediaReason,value:unknown=reason):VideoPlan=>({materials:[base.material,mediaFailMaterial(value,light)],rules:baseRules,media:'none',reason});
 if(cfg().enabled!==true)return fail('disabled');
 try{const failure=JSON.parse(row.failure);if(failure?.until>now)return fail(reasonOf(failure.reason),failure.chunk?failure.reason+':'+failure.chunk:failure.reason);}catch{}
 if(mode==='light')return row.seen!==null&&Number.isFinite(Number(row.seen))&&now-Number(row.seen)<MEDIA_OFFLINE_MS?{materials:[base.material],rules:baseRules,media:'start'}:fail('offline');
 if(row.status==='failed')return fail(reasonOf(row.error),row.error);
 if(['pending','running'].includes(row.status)&&now<(waitDueAt??0))return {materials:[base.material],rules:baseRules,media:'release'};
 return fail('media_timeout');
}
type Guard={sql:string;args:any[]};
/** The optional guard carries switchToMedia's existing wait lease into this INSERT. */
export function enqueueMediaStatement(e:any,bvid:string,waitId:string,duration:number,now:number,guard?:Guard,target:{page?:number;cid?:number}={}):any{
 const identity=mediaTarget(target),keys=mediaKeys(bvid,identity.page);
 return e.DB.prepare(`INSERT INTO jobs(id,kind,payload,created_at)
  SELECT ?,'bili_media',?,? WHERE ${guard?'EXISTS(SELECT 1 FROM video_waits WHERE '+guard.sql+')':'1'}
  ON CONFLICT(id) DO UPDATE SET
   payload=CASE WHEN jobs.status IN ('pending','running') THEN CASE
    WHEN json_array_length(jobs.payload,'$.waiters')<10 AND NOT EXISTS(SELECT 1 FROM json_each(jobs.payload,'$.waiters') WHERE value=json_extract(excluded.payload,'$.waiters[0]'))
    THEN json_insert(jobs.payload,'$.waiters[#]',json_extract(excluded.payload,'$.waiters[0]')) ELSE jobs.payload END ELSE excluded.payload END,
   status=CASE WHEN jobs.status IN ('pending','running') THEN jobs.status ELSE 'pending' END,
   attempts=CASE WHEN jobs.status IN ('pending','running') THEN jobs.attempts ELSE 0 END,
   lease_until=CASE WHEN jobs.status IN ('pending','running') THEN jobs.lease_until ELSE 0 END,error=NULL`)
  .bind(keys.job,JSON.stringify({v:2,bvid,...identity,waiters:[waitId],duration,until:now+cfg().deadline_cap_minutes*60000}),now,...guard?.args??[]);
}
export async function switchToMedia(e:any,w:any,light:BiliResult):Promise<boolean>{
 const now=Date.now(),due=now+mediaDeadlineMs(light.duration),guard="id=? AND status='running' AND lease_until=? AND phase='light'",args=[w.id,w.lease_until];
 await e.DB.batch([
  enqueueMediaStatement(e,light.bvid,w.id,light.duration,now,{sql:guard,args},mediaTarget(light,w.ref)),
  ...(w.mentioned?[e.DB.prepare("INSERT OR IGNORE INTO outbox SELECT ?,group_id,latest_id,?,'pending',? FROM video_waits WHERE "+guard).bind('video-ack-'+w.id,mediaAckText(light.duration),now,...args)]:[]),
  e.DB.prepare("UPDATE video_waits SET phase='media',status='waiting',ready=0,attempts=0,lease_until=NULL,due_at=? WHERE "+guard).bind(due,...args),
 ]);
 const committed=await e.DB.prepare("SELECT id FROM video_waits WHERE id=? AND phase='media' AND due_at=?").bind(w.id,due).first();
 if(committed&&w.mentioned)e.enqueued=true;
 return !!committed;
}
export async function claimMedia(e:any,proto?:number):Promise<any>{
 const now=Date.now(),lease=crypto.randomUUID();
 const row=await e.DB.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,lease_until=?,payload=json_set(payload,'$.lease',?)
  WHERE id=(SELECT id FROM jobs WHERE kind='bili_media' AND attempts<2 AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 1) RETURNING *`)
  .bind(now+180000,lease,now).first();
 if(!row)return null;
 const payload=JSON.parse(row.payload);
 if((payload.page??1)>1&&proto!==2){
  await reportMedia(e,{id:row.id,lease:payload.lease,success:false,reason:'runner_outdated'});
  return null;
 }
 return {...row,payload};
}
export async function heartbeatMedia(e:any,id:string,lease:string,progress:string):Promise<boolean>{
 const now=Date.now();return !!await e.DB.prepare("UPDATE jobs SET lease_until=?,payload=json_set(payload,'$.progress',?) WHERE id=? AND kind='bili_media' AND status='running' AND json_extract(payload,'$.lease')=? AND lease_until>? RETURNING id")
  .bind(now+180000,redact(typeof progress==='string'?progress:'').slice(0,40),id,lease,now).first();
}
export async function reportMedia(e:any,b:any):Promise<Response>{
 let result:AsrNote|null=null;
 if(b.success===true){
  const r=b.result;
  if(!r||!BV.test(r.bvid)||typeof r.text!=='string'||redact(r.text).length>60000||!Number.isFinite(r.covered)||r.covered<0||!Number.isFinite(r.duration)||r.duration<0||!Number.isInteger(r.chunks)||r.chunks<1||typeof r.partial!=='boolean')return Response.json({error:'invalid transcription'},{status:400});
  if(r.page!==undefined&&(!Number.isInteger(r.page)||r.page<1||r.page>999)||r.cid!==undefined&&(!Number.isSafeInteger(r.cid)||r.cid<=0))return Response.json({error:'invalid transcription target'},{status:400});
  result={bvid:r.bvid,...(r.page!==undefined?{page:r.page}:{}),...(r.cid!==undefined?{cid:r.cid}:{}),text:redact(r.text),covered:r.covered,duration:r.duration,partial:r.partial,chunks:r.chunks};
 }else if(!RUNNER_REASONS.includes(b.reason))return Response.json({error:'invalid media reason'},{status:400});
 if(b.cleanup!==undefined&&(!b.cleanup||!Number.isInteger(b.cleanup.residue)||b.cleanup.residue<0||!Array.isArray(b.cleanup.paths)||b.cleanup.paths.length>5||b.cleanup.paths.some((p:any)=>typeof p!=='string')))return Response.json({error:'invalid cleanup'},{status:400});
 const now=Date.now(),row=await e.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='bili_media' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status IN ('done','failed'))").bind(b.id,b.lease,now).first();
 if(!row)return Response.json({error:'lease conflict'},{status:409});
 const payload=JSON.parse(row.payload),{page,cid}=mediaTarget(payload),keys=mediaKeys(payload.bvid,page),outdated=page>1&&b.proto!==2;
 const reason=outdated?'runner_outdated':b.reason;
 if(outdated)result=null;
 if(result&&(result.bvid!==payload.bvid||(result.page??1)!==page||page>1&&(!Number.isSafeInteger(result.cid)||result.cid!<=0)||cid!==undefined&&result.cid!==undefined&&result.cid!==cid))return Response.json({error:'transcription target conflict'},{status:400});
 const status=result?'done':'failed';
 if(row.status!=='running'&&row.status!==status)return Response.json({error:'lease conflict'},{status:409});
 const guard="id=? AND kind='bili_media' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status=?)",args=[b.id,b.lease,now,status],ss=[];
 if(result)ss.push(e.DB.prepare('INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE '+guard+')').bind(keys.asr,JSON.stringify(result),new Date(now).toISOString(),...args));
 else if(['paid','not_found','no_speech','audio_unavailable'].includes(reason))ss.push(e.DB.prepare('INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE '+guard+')').bind(keys.failure,JSON.stringify({reason,...(b.chunk!==undefined?{chunk:b.chunk}:{}),until:now+86400000}),new Date(now).toISOString(),...args));
 ss.push(e.DB.prepare("UPDATE video_waits SET ready=1 WHERE status='waiting' AND phase='media' AND id IN (SELECT value FROM jobs,json_each(jobs.payload,'$.waiters') WHERE "+guard.replace('id=?','jobs.id=?')+')').bind(...args));
 ss.push(e.DB.prepare("UPDATE jobs SET status=?,error=?,payload=json_set(payload,'$.cleanup',json(?)) WHERE "+guard).bind(status,result?null:reason==='asr_failed'&&b.chunk!==undefined?'asr_failed:'+b.chunk:reason,JSON.stringify(b.cleanup??null),...args));
 await e.DB.batch(ss);
 const committed=await e.DB.prepare("SELECT payload FROM jobs WHERE id=? AND kind='bili_media' AND json_extract(payload,'$.lease')=? AND status=?").bind(b.id,b.lease,status).first();
 if(!committed)return Response.json({error:'lease conflict'},{status:409});
 const waiters=[...new Set<string>((JSON.parse(committed.payload).waiters||[]).filter((s:any)=>typeof s==='string'))];
 for(const waiter of waiters.slice(0,3)){if(left(e)<4)break;await wakeVideoWait(e,waiter);}
 return Response.json({ok:true});
}
export async function dispatchMedia(e:any,path:string,b:any):Promise<Response>{
 await e.DB.prepare("INSERT INTO settings VALUES('media:last-seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
 if(path.endsWith('/claim'))return Response.json({job:await claimMedia(e,b.proto),proto:2});
 if(path.endsWith('/heartbeat')){const ok=await heartbeatMedia(e,b.id,b.lease,b.progress);return Response.json({ok},{status:ok?200:409});}
 if(path.endsWith('/report'))return reportMedia(e,b);
 return Response.json({error:'not found'},{status:404});
}
export async function sweepMedia(e:any):Promise<void>{
 const now=Date.now();await e.DB.batch([
  e.DB.prepare("UPDATE jobs SET status='failed',error='timeout' WHERE kind='bili_media' AND status='running' AND attempts>=2 AND lease_until<?").bind(now),
  e.DB.prepare("DELETE FROM media_notes WHERE (id LIKE 'asr:%' OR id LIKE 'asrfail:%') AND created_at<?").bind(new Date(now-30*86400000).toISOString()),
  e.DB.prepare("DELETE FROM jobs WHERE kind='bili_media' AND status IN ('done','failed','cancelled') AND created_at<?").bind(now-7*86400000),
 ]);
}
