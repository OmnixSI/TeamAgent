import { quoteIn } from '../view';
import { DENY_WORDS } from './constants';
import { CATALOG_VERSION, TOOLS_CATALOG, capabilityNeeds, switchKeysFor } from './catalog';
import { CAPABILITIES,DIMENSIONS,FAILURE_TYPES,FIX_LAYERS,GAP_TYPES,RULE_KINDS,SEVERITIES,VERDICT,
  type Evidence,type JudgeMemoryUpdate,type JudgePromise,type JudgeRequirement,type JudgeVerdict,
  type JudgeReply,type Snapshot,type Trace,type TraceMsg,type Origin,type SecondVerdict } from './types';
import { redact, redacted } from './redact';
import type { ScheduleRequest } from '../learning-types';
export type ValidateContext={traces:readonly Trace[];snapshot:Snapshot;same_family:0|1;memberIds:readonly string[];
  names?:Map<string,string>;revokedMemberIds?:readonly string[];requestWords?:readonly string[];
  imageNotes?:readonly {message_id:string;idx:number;sha:string;desc?:string;text?:string}[];
  finish_reason?:JudgeReply['finish_reason'];imageUnavailableTraceIds?:readonly string[]};
export type ReviewReject={kind:'result'|'verdict'|'requirement'|'memory_update'|'promise'|'schedule_request';id:string;reason:string;detail?:string};
export type ValidatedResult={verdicts:JudgeVerdict[];requirements:JudgeRequirement[];memory_updates:JudgeMemoryUpdate[];promises:JudgePromise[];schedule_requests:ScheduleRequest[];rejects:ReviewReject[]};
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max;
const nullable=(v:unknown,max:number)=>v===null||text(v,max);
const oneOf=(v:unknown,xs:readonly unknown[])=>xs.includes(v);
const quote=(v:unknown):v is string=>text(v,60)&&redact(v)===v;
const messages=(t:Trace):TraceMsg[]=>[...(t.inbound?[t.inbound]:[]),...t.context_before,...t.after];
// Exact ownClauses expression from src/authz.ts:54–58; D-3 owns provenance segment construction.
function ownClauses(body:string):string[]{return body.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g,'').split(/[，,。！？!?；;\n]/).map(part=>part.trim().replace(/^@\S+\s+/,''));}
function sourceClauses(m:TraceMsg):string[]{
  let direct=m.segs.filter(s=>s.origin==='direct').map(s=>s.text).join('\n')
    .replace(/^[ \t]*>[^\n]*$/gm,'').replace(/```[\s\S]*?```|`[^`]*`/g,'');
  // An unfinished code fence remains data through end-of-message, even if upstream supplied one direct segment.
  const unfinished=direct.indexOf('`');if(unfinished>=0)direct=direct.slice(0,unfinished);
  return ownClauses(direct);
}
function originOf(m:TraceMsg,q:string):Origin {
  const hits=m.segs.filter(s=>s.text.includes(q));
  return hits.find(s=>s.origin!=='direct')?.origin??hits.find(s=>s.origin==='direct')?.origin??'quoted';
}
function scalarAt(root:unknown,path:string):unknown {
  let v=root;for(const k of path.split('.')){if(['__proto__','constructor','prototype'].includes(k)||!v||typeof v!=='object'||!Object.hasOwn(v,k))return undefined;v=(v as Record<string,unknown>)[k];}
  return ['string','number','boolean'].includes(typeof v)||v===null?v:undefined;
}
function checkedEvidence(e:unknown,t:Trace,ctx:ValidateContext):Evidence|null {
  if(!record(e)||!text(e.id,300)||!quote(e.quote))return null;
  const basic={source:e.source,id:e.id,quote:e.quote};
  if(e.source==='message'){
    const m=messages(t).find(m=>m.id===e.id);return m&&quoteIn(m,e.quote,ctx.names)?{...basic,origin:originOf(m,e.quote)}:null;
  }
  if(e.source==='outbox')return t.replies.some(r=>r.outbox_id===e.id&&r.body.includes(e.quote))?{...basic,origin:'bot'}:null;
  if(e.source==='snapshot'){
    // Historical fields only; never resolve current snapshot for a historical verdict.
    const root={tools_offered:t.tools_offered,snapshot_ref:t.snapshot_ref};const v=scalarAt(root,e.id);
    return v!==undefined&&String(v)===e.quote?basic:null;
  }
  if(e.source==='tool'){
    const rows=t.tools==='unrecorded'?[]:t.tools.filter(r=>r.id===e.id);
    return rows.some(r=>(['name','ok','error_kind','ms'] as const).some(k=>e.quote===`${k}=${r[k]}`))?basic:null;
  }
  if(e.source==='image'&&record(e.image)){
    const m=messages(t).find(m=>m.id===e.image.message_id),im=m?.images.find(i=>i.idx===e.image.idx&&i.sha===e.image.sha);
    // Only stored image_notes descriptions (and optionally separately loaded text), never a fresh vision inference.
    const note=ctx.imageNotes?.find(i=>i.message_id===m?.id&&i.idx===im?.idx&&i.sha===im?.sha);
    if(im&&e.id===im.sha&&[im.desc,note?.desc,note?.text].some(s=>typeof s==='string'&&s.includes(e.quote)))
      return {...basic,origin:'image_text',image:{message_id:m!.id,idx:im.idx,sha:im.sha}};
  }
  return null;
}
function allEvidence(es:unknown,t:Trace,ctx:ValidateContext):Evidence[]|null {
  if(!Array.isArray(es)||!es.length||es.length>20)return null;
  const checked=es.map(e=>checkedEvidence(e,t,ctx));return checked.every((e):e is Evidence=>e!==null)?checked:null;
}
function sourceTrace(es:unknown,ctx:ValidateContext):{trace:Trace;evidence:Evidence[]}|null {
  for(const t of ctx.traces){const evidence=allEvidence(es,t,ctx);if(evidence)return{trace:t,evidence};}return null;
}
const HISTORICAL_GAPS=['tool_not_selected','tool_missing','switch_or_policy_off','capability_offline'];
function historical(v:Pick<JudgeVerdict,'gap_type'|'dimensions'|'capability'|'should_use_tool'>,t:Trace):{gap:JudgeVerdict['gap_type'];dimensions:JudgeVerdict['dimensions'];reason?:string} {
  let gap=v.gap_type;const dimensions={...v.dimensions},offered=t.tools_offered;
  if(offered==='unknown'||offered.catalog_version!==CATALOG_VERSION){
    dimensions.tool_choice='INSUFFICIENT';if(gap&&HISTORICAL_GAPS.includes(gap))gap=null;
    return{gap,dimensions,reason:'historical_capability_unknown'};
  }
  const names=v.should_use_tool?[v.should_use_tool]:t.tools==='unrecorded'?[]:t.tools.filter(r=>!r.ok).map(r=>r.name);
  const tools=TOOLS_CATALOG.filter(r=>names.includes(r.name));
  const switches=[...switchKeysFor(v.capability??''),...(tools.some(r=>r.name.startsWith('repo_'))?['off:repo_tools']:[])];
  if(switches.some(k=>offered.switches[k]===(k.startsWith('off:')?'on':'off')))gap='switch_or_policy_off';
  else if((tools.some(r=>r.needs.includes('runner'))||capabilityNeeds(v.capability??'').includes('runner'))&&(offered.runner_ok===0||t.snapshot_ref?.runner_ok===0))gap='capability_offline';
  else if(gap==='tool_missing'&&names.some(n=>offered.names.includes(n)))gap=t.tools==='unrecorded'?null:t.tools.some(r=>names.includes(r.name))?'tool_failed':'tool_not_selected';
  else if(gap==='tool_not_selected'&&(!names.length||!names.every(n=>offered.names.includes(n))||t.tools==='unrecorded')){gap=null;dimensions.tool_choice='INSUFFICIENT';}
  else if(gap==='switch_or_policy_off'||gap==='capability_offline'){gap=null;dimensions.tool_choice='INSUFFICIENT';}
  return{gap,dimensions,...(gap!==v.gap_type?{reason:'gap_historical_conflict'}:{})};
}
function verdictShape(v:Record<string,any>):boolean {
  return text(v.trace_id,300)&&text(v.reasoning,300)&&record(v.dimensions)&&DIMENSIONS.every(d=>oneOf(v.dimensions[d],VERDICT))&&
    (v.failure_type===null||oneOf(v.failure_type,FAILURE_TYPES))&&oneOf(v.severity,SEVERITIES)&&oneOf(v.fix_layer,FIX_LAYERS)&&
    (v.gap_type===null||oneOf(v.gap_type,GAP_TYPES))&&(v.capability===null||oneOf(v.capability,CAPABILITIES)||typeof v.capability==='string'&&/^other:\S.{0,79}$/u.test(v.capability))&&
    nullable(v.should_use_tool,100)&&[v.what_happened,v.expected,v.root_cause,v.next_attempt_plan].every(s=>text(s,2000))&&
    typeof v.confidence==='number'&&Number.isFinite(v.confidence)&&v.confidence>=0&&v.confidence<=1&&oneOf(v.kind,['response_fault','capability_gap','system_fault','none'])&&
    (v.kind!=='none'||v.failure_type===null);
}
function directSource(es:Evidence[],t:Trace,ctx:ValidateContext,requirement:boolean):string|null {
  for(const e of es){
    const m=messages(t).find(m=>m.id===e.id);
    if(e.source!=='message'||e.origin!=='direct'||e.quote.length<4||!m||!sourceClauses(m).some(c=>c.includes(e.quote)))return 'origin_not_direct_own_clause';
    if(!m.bound_member||![m.sender,'qq:'+m.sender].includes(m.bound_member)||!ctx.memberIds.includes(m.bound_member)||ctx.revokedMemberIds?.includes(m.bound_member))return 'unbound_or_revoked';
    if(requirement&&m.addressed!=='bot')return 'not_addressed_to_bot';
    const words=ctx.requestWords??['以后','下次','别','不要','请','少','多','只','收敛','简短','每天','每周','每早','每晚','定时','按时','please','always','never'];
    if(requirement&&!sourceClauses(m).some(c=>c.includes(e.quote)&&words.some(w=>c.toLowerCase().includes(w.toLowerCase()))))return 'not_explicit_request';
  }return null;
}
const parseClock=(v:unknown):string|null=>{if(typeof v!=='string')return null;const t=v.trim(),m=/^(\d{1,2}):(\d{2})$/.exec(t);if(!m)return null;const h=Number(m[1]),mi=Number(m[2]);return h<=23&&mi<=59?t:null;};
const safeTopic=(s:string)=>redact(s)===s&&!/[「」\r\n]/u.test(s)&&!DENY_WORDS.some(w=>s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu,'').toLowerCase().includes(w.toLowerCase()));
const normMember=(v:string)=>String(v??'').trim().toLowerCase().replace(/^qq:/,'');
/** Canonical params: max, minutes, value, phrase, or member+name. Downstream can reuse the rendered rule verbatim. */
export function normalizeRequirement(r:Record<string,any>):JudgeRequirement|null {
  if(!oneOf(r.kind,RULE_KINDS)||!record(r.params)||!Number.isInteger(r.ttl_days)||r.ttl_days<1||!text(r.scene,300))return null;
  if(DENY_WORDS.some(w=>JSON.stringify({rule:r.rule,params:r.params}).toLowerCase().includes(w.toLowerCase())))return null;
  let rule='',params:JudgeRequirement['params']={};const keys=Object.keys(r.params),max=r.params.max,value=r.params.value;
  if(r.kind==='avoid_phrase'){
    // 1–12 字、不夹引号/换行；是否真的在 bot 原话里出现过由 applyRequirements/L4 查 outbox（validate 无 DB）。
    const phrase=r.params.phrase;if(keys.length!==1||keys[0]!=='phrase'||typeof phrase!=='string')return null;
    const p=phrase.trim();if(Array.from(p).length<1||Array.from(p).length>12||/[「」\r\n]/u.test(p))return null;
    params={phrase:p};rule=`不要再说「${p}」。`;
  }else if(r.kind==='address_as'){
    const member=r.params.member,name=r.params.name;
    if(keys.length!==2||!keys.includes('member')||!keys.includes('name')||typeof member!=='string'||typeof name!=='string')return null;
    const who=member.trim(),label=name.trim();
    if(Array.from(who).length<1||Array.from(who).length>40||Array.from(label).length<1||Array.from(label).length>10||/[「」\r\n]/u.test(who)||/[「」\r\n]/u.test(label))return null;
    params={member:who,name:label};rule=`称呼${who}为「${label}」。`;
  }else if(r.kind==='free'){
    if(keys.length||!text(r.rule,80)||/不主动参与|(?:永远|永久).*(?:回复|参与|说话)|只在被\s*@.*回/u.test(r.rule))return null;
    rule=r.rule;
  }
  else if(r.kind==='reply_max_chars'||r.kind==='burst_max'){
    const bounds=r.kind==='reply_max_chars'?[80,2000]:[1,4];
    if(keys.length!==1||keys[0]!=='max'||!Number.isInteger(max)||max<bounds[0]||max>bounds[1])return null;
    params={max};rule=r.kind==='reply_max_chars'?`回复最多${max}字。`:`每轮最多回复${max}条。`;
  }else if(r.kind==='mention_only_window'){
    const minutes=r.params.minutes;if(keys.length!==1||keys[0]!=='minutes'||!Number.isInteger(minutes)||minutes<30||minutes>120||r.ttl_days>1)return null;
    params={minutes};rule=`接下来${minutes}分钟只在被点名或追问时回复。`;
  }else{
    if(keys.length!==1||keys[0]!=='value'||!oneOf(value,r.kind==='language'?['zh','en']:['plain','list','table']))return null;
    params={value};rule=r.kind==='language'?(value==='zh'?'使用中文回复。':'使用英文回复。'):`回复格式优先使用${({plain:'普通文本',list:'列表',table:'表格'} as Record<string,string>)[value]}。`;
  }
  return{kind:r.kind,params,rule,scene:r.scene,evidence:r.evidence,ttl_days:Math.min(r.ttl_days,30)};
}
export type ParsedReply={state:'ok'|'truncated'|'invalid'|'error'|'timeout';json?:any};
export function parseJudgeReply(reply:JudgeReply,schema='ta.review.result.v2'):ParsedReply {
  if(reply.finish_reason==='length')return{state:'truncated'};
  if(!reply.ok)return{state:reply.finish_reason==='timeout'?'timeout':'error'};
  try{const json=JSON.parse(reply.text);return record(json)&&json.schema===schema&&Array.isArray(json.verdicts)&&
    (schema!=='ta.review.result.v2'||[json.requirements,json.memory_updates,json.promises,json.no_action].every(Array.isArray))?{state:'ok',json}:{state:'invalid'};}
  catch(error){const s=reply.text.trim();return{state:/end of JSON|unterminated/i.test(String(error))||/^[{[]/.test(s)&&!/[}\]]$/.test(s)?'truncated':'invalid'};}
}
export function validateResult(raw:unknown,ctx:ValidateContext):ValidatedResult {
  const out:ValidatedResult={verdicts:[],requirements:[],memory_updates:[],promises:[],schedule_requests:[],rejects:[]};
  const reject=(kind:ReviewReject['kind'],id:string,reason:string)=>out.rejects.push({kind,id,reason});
  if(typeof raw==='string'||ctx.finish_reason==='length'){
    const parsed=parseJudgeReply({ok:true,text:typeof raw==='string'?raw:JSON.stringify(raw),finish_reason:ctx.finish_reason??'stop',usage:null});
    if(parsed.state!=='ok'){reject('result','',parsed.state==='truncated'?'judge_truncated':'invalid_schema');return out;}raw=parsed.json;
  }
  if(!record(raw)||raw.schema!=='ta.review.result.v2'||![raw.verdicts,raw.requirements,raw.memory_updates,raw.promises,raw.no_action].every(Array.isArray)){reject('result','','invalid_schema');return out;}
  const seen=new Set<string>();for(const v of raw.verdicts){
    const id=record(v)&&typeof v.trace_id==='string'?v.trace_id:'',t=ctx.traces.find(t=>t.id===id);
    if(!record(v)||!verdictShape(v)||!t||seen.has(id)){reject('verdict',id,'invalid_verdict');continue;}
    const es=allEvidence(v.evidence,t,ctx);
    if(!es||!es.some(e=>e.source==='message'||e.source==='outbox')){reject('verdict',id,'evidence_mismatch');continue;}
    if(v.severity==='p0'&&v.dimensions.boundary!=='UNSATISFIED'&&v.dimensions.facts!=='UNSATISFIED'){reject('verdict',id,'p0_without_boundary_or_facts');continue;}
    const fixed=historical(v as JudgeVerdict,t);if(fixed.reason)reject('verdict',id,fixed.reason);
    out.verdicts.push({trace_id:id,kind:v.kind,reasoning:v.reasoning,failure_type:v.failure_type,severity:v.severity,fix_layer:v.fix_layer,
      capability:v.capability,should_use_tool:v.should_use_tool,what_happened:v.what_happened,expected:v.expected,root_cause:v.root_cause,
      next_attempt_plan:v.next_attempt_plan,evidence:es,gap_type:fixed.gap,dimensions:fixed.dimensions,confidence:Math.min(v.confidence,ctx.same_family===1?.7:.95)} as JudgeVerdict);seen.add(id);
  }
  for(const [i,r] of raw.requirements.entries()){
    const src=record(r)?sourceTrace(r.evidence,ctx):null;if(!src){reject('requirement',String(i),'origin_evidence_mismatch');continue;}
    const reason=directSource(src.evidence,src.trace,ctx,true);if(reason){reject('requirement',String(i),reason);continue;}
    const normalized=normalizeRequirement({...r,evidence:src.evidence});if(!normalized){reject('requirement',String(i),'invalid_requirement_params');continue;}
    if(normalized.kind==='address_as'){
      const source=messages(src.trace).find(m=>m.id===src.evidence[0].id);
      if(!source||normMember(String(normalized.params.member))!==normMember(source.sender)){reject('requirement',String(i),'address_sender_mismatch');continue;}
    }
    out.requirements.push(normalized);
  }
  const rawSchedules=raw.schedule_requests==null?[]:raw.schedule_requests;
  if(!Array.isArray(rawSchedules)) reject('schedule_request','','invalid_schedule_requests');
  else for(const [i,s] of rawSchedules.entries()){
    if(out.schedule_requests.length>=3) break;
    if(!record(s)){reject('schedule_request',String(i),'invalid_schedule_request');continue;}
    const src=sourceTrace(s.evidence,ctx);if(!src){reject('schedule_request',String(i),'origin_evidence_mismatch');continue;}
    const reason=directSource(src.evidence,src.trace,ctx,true);if(reason){reject('schedule_request',String(i),reason);continue;}
    if(!oneOf(s.cadence,['daily','weekly'])){reject('schedule_request',String(i),'invalid_cadence');continue;}
    const clock=parseClock(s.time);if(!clock){reject('schedule_request',String(i),'invalid_time');continue;}
    const topic=typeof s.topic==='string'?s.topic.trim():'';const size=Array.from(topic).length;
    if(size<1||size>40||!safeTopic(topic)){reject('schedule_request',String(i),'invalid_topic');continue;}
    let weekdays:number[]|undefined;
    if(s.weekdays!==undefined){
      if(!Array.isArray(s.weekdays)||!s.weekdays.length||s.weekdays.length>7||!s.weekdays.every(d=>Number.isInteger(d)&&d>=0&&d<=6)){reject('schedule_request',String(i),'invalid_weekdays');continue;}
      weekdays=[...new Set(s.weekdays as number[])].sort((a,b)=>a-b);
    }
    if(s.cadence==='weekly'&&!weekdays){reject('schedule_request',String(i),'weekly_without_weekdays');continue;}
    out.schedule_requests.push({evidence:src.evidence.map(e=>({source:'message' as const,id:e.id,quote:e.quote})),cadence:s.cadence,time:clock,topic,...(s.cadence==='weekly'?{weekdays}:{})});
  }
  for(const [i,m] of raw.memory_updates.entries()){
    const src=record(m)?sourceTrace(m.evidence,ctx):null;if(!src){reject('memory_update',String(i),'origin_evidence_mismatch');continue;}
    const reason=directSource(src.evidence,src.trace,ctx,false);if(reason){reject('memory_update',String(i),reason);continue;}
    if(!oneOf(m.op,['ADD','UPDATE','DELETE','NONE'])||![m.repo,m.subject,m.predicate,m.value].every(s=>text(s,2000))){reject('memory_update',String(i),'invalid_memory_update');continue;}
    out.memory_updates.push({op:m.op,repo:m.repo,subject:m.subject,predicate:m.predicate,value:m.value,evidence:src.evidence});
  }
  for(const [i,p] of raw.promises.entries()){
    if(!record(p)||!text(p.outbox_id,300)||!quote(p.quote)||!text(p.what,2000)||!nullable(p.due,80)||p.due!==null&&!Number.isFinite(Date.parse(p.due))||!nullable(p.recurring,100)||!ctx.traces.some(t=>t.replies.some(r=>r.outbox_id===p.outbox_id&&r.body.includes(p.quote)))){reject('promise',String(i),'invalid_promise');continue;}
    out.promises.push({outbox_id:p.outbox_id,quote:p.quote,what:p.what,due:p.due,recurring:p.recurring});
  }
  return redacted(out);
}
export function validateSecondResult(raw:unknown,ctx:ValidateContext):{verdicts:SecondVerdict[];rejects:ReviewReject[]} {
  const result:{verdicts:SecondVerdict[];rejects:ReviewReject[]}={verdicts:[],rejects:[]};
  if(!record(raw)||raw.schema!=='ta.review.second.v1'||!Array.isArray(raw.verdicts)){result.rejects.push({kind:'result',id:'',reason:'invalid_second_schema'});return result;}
  for(const v of raw.verdicts){
    if(!record(v)||!oneOf(v.verdict,['issue','pass','insufficient'])||!text(v.reason,300)){result.rejects.push({kind:'verdict',id:'',reason:'invalid_second_verdict'});continue;}
    const t=ctx.traces.find(t=>t.id===v.trace_id),offers=t?.tools_offered;
    const witnessed=Array.isArray(v.evidence)?v.evidence.flatMap(e=>{
      if(e.source==='tool')return t?.tools==='unrecorded'?[]:t?.tools.filter(r=>r.id===e.id).map(r=>r.name)??[];
      return e.source==='snapshot'&&e.id.startsWith('tools_offered.names.')&&offers&&offers!=='unknown'&&offers.names.includes(e.quote)?[e.quote]:[];
    }):[];
    // SecondVerdict has no should_use_tool field. Use an exact witnessed name or the sole recorded offer.
    const tool=witnessed[0]??(offers&&offers!=='unknown'&&offers.names.length===1?offers.names[0]:null);
    const proxy={...v,kind:v.verdict==='issue'?'response_fault':'none',reasoning:v.reason,fix_layer:'prompt',capability:null,should_use_tool:tool,
      what_happened:v.reason,expected:'复核',root_cause:'复核',next_attempt_plan:'复核'};
    const checked=validateResult({schema:'ta.review.result.v2',verdicts:[proxy],requirements:[],memory_updates:[],promises:[],no_action:[]},ctx);
    // Second has no should_use_tool field; infer the historical target from its exact tool evidence if present.
    result.rejects.push(...checked.rejects);if(!checked.verdicts.length)continue;const x=checked.verdicts[0];
    const missing=ctx.imageUnavailableTraceIds?.includes(v.trace_id);
    result.verdicts.push({trace_id:v.trace_id,verdict:missing?'insufficient':v.verdict,failure_type:x.failure_type,gap_type:x.gap_type,severity:x.severity,
      dimensions:missing?Object.fromEntries(DIMENSIONS.map(d=>[d,'INSUFFICIENT'])) as SecondVerdict['dimensions']:x.dimensions,
      evidence:x.evidence,reason:v.reason,confidence:x.confidence});
  }return redacted(result);
}
