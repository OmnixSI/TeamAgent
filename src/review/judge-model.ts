import { PROVIDERS,type Provider,type JudgeCall,type JudgeReply } from './types';
import { redact } from './redact';
import { parseJudgeReply } from './validate';
import { batchSize, MAX_JUDGE_INPUT_CHARS } from './prompt';
export type JudgePrice={unit:'usd_micros'|'neurons';input:number;output:number};
export type JudgeOptions={price?:JudgePrice;prices?:Partial<Record<Provider,JudgePrice>>;dayCap?:number;monthCapUsdMicros?:number;
  workersAiEnabled?:boolean;mode?:'nightly'|'replay';chargeFullReservation?:boolean;now?:()=>number;fetch?:typeof fetch;offline?:(call:JudgeCall)=>Promise<JudgeReply>};
export type JudgeEnv={DB?:any;AI?:{run(model:string,input:Record<string,unknown>):Promise<any>};DEEPSEEK_API_KEY?:string;OPENAI_API_KEY?:string;
  OPENAI_MODEL?:string;REVIEW_MONTH_CAP_USD_MICROS?:string|number;REVIEW_WORKERS_AI_ENABLED?:string};
const errorReply=(error_kind:string,finish_reason:JudgeReply['finish_reason']='error'):JudgeReply=>({ok:false,text:'',finish_reason,usage:null,error_kind});
const validPrice=(p:JudgePrice|undefined):p is JudgePrice=>!!p&&['neurons','usd_micros'].includes(p.unit)&&[p.input,p.output].every(v=>Number.isFinite(v)&&v>=0)&&(p.input>0||p.output>0);
export function validateProviders(primary:Provider='deepseek',second:Provider='openai',mode:'nightly'|'replay'='nightly',workersAiEnabled=false){
  if(!PROVIDERS.includes(primary)||!PROVIDERS.includes(second))throw Error('invalid provider');
  if(mode==='nightly'&&[primary,second].includes('codex-offline'))throw Error('codex-offline is unavailable nightly');
  if([primary,second].includes('workers-ai')&&!workersAiEnabled)throw Error('workers-ai is not qualified');
  return{primary,second};
}
/** UTF-8 byte input bound plus framing; image bound is deliberately conservative and never logged. */
export function estimateReservation(call:JudgeCall,price:JudgePrice):number {
  if(!validPrice(price))throw Error('price_unavailable');
  const bytes=new TextEncoder().encode(redact(call.system)+redact(call.user)).length+128+
    (call.images??[]).reduce((n,image)=>n+image.b64.length+32768,0);
  const amount=Math.ceil(bytes*price.input+call.max_tokens*price.output);
  if(!Number.isSafeInteger(amount)||amount<1)throw Error('invalid_budget_amount');return amount;
}
function changed(r:any):number{return Number(r?.meta?.changes??r?.changes??0);}
function defaultCap(provider:Provider):number{return provider==='workers-ai'?6000:provider==='openai'?500000:100000;}
async function reserve(e:JudgeEnv,call:JudgeCall,price:JudgePrice,amount:number,opts:JudgeOptions){
  const at=(opts.now??Date.now)(),day=new Date(at).toISOString().slice(0,10),month=day.slice(0,7);
  const cap=opts.dayCap??defaultCap(call.provider),monthCap=opts.monthCapUsdMicros??Number(e.REVIEW_MONTH_CAP_USD_MICROS??10000000);
  if(!e.DB||![cap,monthCap].every(n=>Number.isSafeInteger(n)&&n>0))return null;
  await e.DB.prepare('INSERT OR IGNORE INTO review_budget(day_utc,provider,unit,cap,reserved,used,calls,updated_at) VALUES(?,?,?,?,0,0,0,?)')
    .bind(day,redact(call.provider),price.unit,cap,at).run();
  // One conditional write serializes both daily and cross-provider monthly reservations in D1.
  const r=await e.DB.prepare(`UPDATE review_budget SET reserved=reserved+?,calls=calls+1,updated_at=?
    WHERE day_utc=? AND provider=? AND unit=? AND used+reserved+?<=cap
    AND (?!='usd_micros' OR (SELECT COALESCE(SUM(used+reserved),0) FROM review_budget
      WHERE unit='usd_micros' AND substr(day_utc,1,7)=?)+?<=?)`)
    .bind(amount,at,day,call.provider,price.unit,amount,price.unit,month,amount,monthCap).run();
  if(changed(r)!==1)return null;
  let settled=false;
  return{async settle(used:number){
    if(settled)return;settled=true;
    await e.DB.prepare('UPDATE review_budget SET reserved=reserved-?,used=used+?,updated_at=? WHERE day_utc=? AND provider=? AND unit=? AND reserved>=?')
      .bind(amount,used,(opts.now??Date.now)(),day,call.provider,price.unit,amount).run();
  }};
}
function usageOf(raw:any):{input:number;output:number;neurons?:number}|null {
  const input=raw?.prompt_tokens??raw?.input_tokens??raw?.input,output=raw?.completion_tokens??raw?.output_tokens??raw?.output;
  if(![input,output].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0))return null;
  return{input,output,...(typeof raw?.neurons==='number'&&Number.isFinite(raw.neurons)&&raw.neurons>=0?{neurons:raw.neurons}:{})};
}
/** Exactly one provider attempt. Persistence of the judgment and split/retry policy are separate from the wire adapter. */
export async function judgeModel(e:JudgeEnv,call:JudgeCall,opts:JudgeOptions={}):Promise<JudgeReply> {
  if(!PROVIDERS.includes(call.provider)||!call.model||!Number.isInteger(call.max_tokens)||call.max_tokens<1||call.max_tokens>32768||
    !Number.isFinite(call.timeout_ms)||call.timeout_ms<1||call.timeout_ms>180000||typeof call.system!=='string'||typeof call.user!=='string'||
    call.system.length+call.user.length>MAX_JUDGE_INPUT_CHARS)return errorReply('invalid_call');
  if(call.provider==='codex-offline'){
    if(opts.mode!=='replay'||!opts.offline)return errorReply('offline_nightly_forbidden');
    try{const r=await opts.offline({...call,system:redact(call.system),user:redact(call.user)});return{...r,text:redact(r.text)};}catch{return errorReply('offline_failed');}
  }
  if(call.provider==='workers-ai'&&!(opts.workersAiEnabled||e.REVIEW_WORKERS_AI_ENABLED==='1'))return errorReply('provider_unavailable');
  if(call.provider==='workers-ai'&&/gpt-oss/.test(call.model)&&call.max_tokens<4096)return errorReply('invalid_max_tokens');
  if((call.images?.length??0)>0&&call.provider!=='openai')return errorReply('image_provider_required');
  if(call.images?.some(im=>!['image/jpeg','image/png','image/gif','image/webp'].includes(im.mime)||
    typeof im.b64!=='string'||!im.b64.length||im.b64.length>6700000||im.b64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(im.b64)))return errorReply('invalid_image');
  const price=opts.price??opts.prices?.[call.provider];
  if(!validPrice(price)||price.unit!==(call.provider==='workers-ai'?'neurons':'usd_micros'))return errorReply('price_unavailable');
  if(call.provider==='workers-ai'?!e.AI:!e[call.provider==='deepseek'?'DEEPSEEK_API_KEY':'OPENAI_API_KEY'])return errorReply('provider_unavailable');
  let amount:number;try{amount=estimateReservation(call,price);}catch{return errorReply('price_unavailable');}
  let reservation:Awaited<ReturnType<typeof reserve>>;
  try{reservation=await reserve(e,call,price,amount,opts);}catch{return errorReply('budget_store');}
  if(!reservation)return errorReply('budget');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let reply:JudgeReply,errorKind='upstream';
  try{
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('review_timeout'));},call.timeout_ms);});
    const wire=async()=>{
      const system=redact(call.system),user=redact(call.user);
      const userContent=call.images?.length?[{type:'text',text:user},...call.images.map(im=>({type:'image_url',image_url:{url:`data:${im.mime};base64,${im.b64}`}}))]:user;
      const messages=[{role:'system',content:system},{role:'user',content:userContent}];
      if(call.provider==='workers-ai')return e.AI!.run(call.model,{messages,max_tokens:call.max_tokens,response_format:{type:'json_object'},
        ...(/gpt-oss/.test(call.model)?{reasoning_effort:'low'}:{})});
      const r=await (opts.fetch??fetch)(call.provider==='deepseek'?'https://api.deepseek.com/chat/completions':'https://api.openai.com/v1/chat/completions',{
        method:'POST',headers:{Authorization:'Bearer '+e[call.provider==='deepseek'?'DEEPSEEK_API_KEY':'OPENAI_API_KEY'],'Content-Type':'application/json'},
        body:JSON.stringify({model:call.model,messages,max_tokens:call.max_tokens,response_format:{type:'json_object'},stream:false}),signal:controller.signal});
      if(!r.ok){errorKind='http_'+r.status;throw Error('review_http');}return r.json();
    };
    const raw=await Promise.race([wire(),timeout]);
    const value=raw?.response??raw?.choices?.[0]?.message?.content;
    const finish=raw?.finish_reason??raw?.choices?.[0]?.finish_reason;
    reply={ok:true,text:redact(typeof value==='string'?value:JSON.stringify(value??'')),finish_reason:finish==='length'||raw?.status==='incomplete'?'length':'stop',usage:null};
    const parsed=parseJudgeReply(reply,call.system.includes('只判不提，输出 ta.review.second.v1')?'ta.review.second.v1':'ta.review.result.v2');
    if(parsed.state==='truncated')reply.finish_reason='length';
    const usage=usageOf(raw?.usage);
    let used=amount;
    if(parsed.state==='ok'&&reply.finish_reason==='stop'&&usage){
      used=opts.chargeFullReservation?amount:price.unit==='neurons'&&usage.neurons!==undefined?usage.neurons:Math.ceil(usage.input*price.input+usage.output*price.output);
      reply.usage={...usage,...(price.unit==='neurons'?{neurons:used}:{usd_micros:used})};
    }
    await reservation.settle(used);
  }catch{
    reply=errorReply(controller.signal.aborted?'timeout':errorKind,controller.signal.aborted?'timeout':'error');
    try{await reservation.settle(amount);}catch{return errorReply('budget_store');}
  }finally{clearTimeout(timer);controller.abort();}
  return reply;
}
export type BatchJudgment={trace_ids:string[];reply:JudgeReply;state:ReturnType<typeof parseJudgeReply>['state'];json?:any};
/** A truncated batch splits once; each child is a fresh budgeted request. No bot finding is invented. */
export async function judgeBatches(e:JudgeEnv,traceIds:readonly string[],makeCall:(ids:string[])=>JudgeCall,opts:JudgeOptions={}){
  const judgments:BatchJudgment[]=[],failedTraceIds:string[]=[];
  async function run(ids:string[],retry:boolean,isRetry=false){
    const call=makeCall(ids),limit=batchSize(call.max_tokens,call.provider==='openai'?'second':'primary');
    if(ids.length>1&&(ids.length>limit||call.system.length+call.user.length>MAX_JUDGE_INPUT_CHARS)){
      const half=Math.ceil(ids.length/2);await run(ids.slice(0,half),retry,isRetry);await run(ids.slice(half),retry,isRetry);return;
    }
    const reply=await judgeModel(e,call,{...opts,chargeFullReservation:opts.chargeFullReservation||isRetry}),parsed=parseJudgeReply(reply,call.system.includes('只判不提，输出 ta.review.second.v1')?'ta.review.second.v1':'ta.review.result.v2');
    judgments.push({trace_ids:ids,reply,...parsed});
    if(parsed.state==='truncated'&&retry&&ids.length>1){const half=Math.ceil(ids.length/2);await run(ids.slice(0,half),false,true);await run(ids.slice(half),false,true);}
    else if(parsed.state==='invalid'&&retry)await run(ids,false,true);
    else if(parsed.state!=='ok')failedTraceIds.push(...ids);
  }
  if(traceIds.length)await run([...traceIds],true);return{judgments,failedTraceIds};
}
