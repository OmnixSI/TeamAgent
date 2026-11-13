import { fetchImage,b64 } from '../vision';
import { judgeModel,type JudgeEnv,type JudgeOptions } from './judge-model';
import { buildJudgeInput } from './prompt';
import { validateSecondResult,parseJudgeReply,type ValidateContext } from './validate';
import type { Agreement,JudgeCall,JudgeResult,JudgeVerdict,Provider,SecondVerdict,Snapshot,Trace } from './types';
export function compareVerdicts(primary:JudgeVerdict|undefined,second:SecondVerdict|undefined,providers?:{primary:Provider;second:Provider}):Agreement {
  if(!second)return 'single';if(!primary)return 'pending';
  const family=(p:Provider)=>p==='codex-offline'?'openai':p;
  if(providers&&family(providers.primary)===family(providers.second))return 'single';
  if(second.verdict==='insufficient')return 'disagree';
  const issue=primary.kind!=='none'&&primary.failure_type!==null;
  return issue===(second.verdict==='issue')&&primary.failure_type?.split('.')[0]===second.failure_type?.split('.')[0]&&primary.gap_type===second.gap_type?'agree':'disagree';
}
export function selectForSecond(traces:readonly Trace[],primary:JudgeResult,options:{taskTraceIds?:readonly string[];random?:()=>number;sampleCount?:number}={}):Trace[]{
  const selected=new Set(options.taskTraceIds??[]);
  for(const t of traces)if(t.has_image)selected.add(t.id);
  for(const v of primary.verdicts)if(v.kind!=='none'&&(v.severity==='p0'||v.severity==='p1'))selected.add(v.trace_id);
  const proposalIds=new Set([...primary.requirements,...primary.memory_updates].flatMap(r=>r.evidence.filter(e=>e.source==='message').map(e=>e.id)));
  for(const t of traces)if([...(t.inbound?[t.inbound]:[]),...t.context_before,...t.after].some(m=>proposalIds.has(m.id)))selected.add(t.id);
  const passed=new Set([...primary.no_action.map(x=>x.trace_id),...primary.verdicts.filter(v=>v.kind==='none').map(v=>v.trace_id)]);
  const candidates=traces.filter(t=>passed.has(t.id)&&!selected.has(t.id)).map(t=>({t,n:(options.random??Math.random)()})).sort((a,b)=>a.n-b.n);
  for(const {t}of candidates.slice(0,options.sampleCount??2))selected.add(t.id);
  return traces.filter(t=>selected.has(t.id));
}
export type SecondOptions=JudgeOptions&{provider?:Provider;model?:string;max_tokens?:number;timeout_ms?:number;
  imageSources?:readonly {message_id:string;idx:number;url:string}[];context?:Partial<ValidateContext>};
export async function secondJudge(e:JudgeEnv,input:readonly Trace[],snapshot:Snapshot,opts:SecondOptions={}){
  // Do not mutate traces already persisted by the first judge. Image bytes are request-local only.
  const max_tokens=opts.max_tokens??2048;
  const firstInput=buildJudgeInput(input,snapshot,snapshot.tools_catalog,[],[],[],{role:'second',max_tokens});
  const selected=new Set<string>((JSON.parse(firstInput[1].content).traces as Trace[]).map(t=>t.id));
  const traces=structuredClone(input.filter(t=>selected.has(t.id))) as Trace[],images:NonNullable<JudgeCall['images']>=[],missing=new Set<string>();
  for(const t of traces){
    if(!t.has_image)continue;
    const msgs=[...(t.inbound?[t.inbound]:[]),...t.context_before,...t.after];let count=0;
    for(const m of msgs)for(const image of m.images){
      count++;const source=opts.imageSources?.find(s=>s.message_id===m.id&&s.idx===image.idx);
      // fetchImage gates every redirect with the vision.ts hostname whitelist; no URLs or bytes are logged.
      const bytes=source?await fetchImage(source.url,AbortSignal.timeout(opts.timeout_ms??15000),5000000,()=>{}):null;
      image.url_ok=!!bytes;if(bytes)images.push({message_id:m.id,idx:image.idx,mime:bytes.mime,b64:b64(bytes.bytes)});else missing.add(t.id);
    }if(!count)missing.add(t.id);
  }
  const provider=traces.some(t=>t.has_image)?'openai':opts.provider??'openai';
  const messages=buildJudgeInput(traces,snapshot,snapshot.tools_catalog,[],[],[],{role:'second',max_tokens});
  const included=new Set<string>((JSON.parse(messages[1].content).traces as Trace[]).map(t=>t.id));
  const includedImages=images.filter(i=>traces.some(t=>included.has(t.id)&&[...(t.inbound?[t.inbound]:[]),...t.context_before,...t.after].some(m=>m.id===i.message_id)));
  const model=provider==='openai'&&opts.provider&&opts.provider!=='openai'?e.OPENAI_MODEL??'':opts.model??e.OPENAI_MODEL??'';
  const call:JudgeCall={provider,model,system:messages[0].content,user:messages[1].content,
    max_tokens,timeout_ms:opts.timeout_ms??90000,...(includedImages.length?{images:includedImages}:{})};
  const reply=await judgeModel(e,call,opts),parsed=parseJudgeReply(reply,'ta.review.second.v1');
  const same_family=provider==='deepseek'?1:0;
  const context:ValidateContext={memberIds:[],...opts.context,traces:traces.filter(t=>included.has(t.id)),snapshot,same_family,imageUnavailableTraceIds:[...missing]};
  const result=parsed.state==='ok'?validateSecondResult(parsed.json,context):null;
  return{reply,result,traces,provider,model,same_family,omittedTraceIds:input.filter(t=>!included.has(t.id)).map(t=>t.id)};
}
