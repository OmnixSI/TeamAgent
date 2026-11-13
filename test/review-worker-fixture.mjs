import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';
const file = `.wrangler/review-shell-${process.pid}.mjs`;
await build({stdin:{contents:"export {default} from './src/review/worker.ts'; export * from './src/review/worker.ts'; export { signalsOf } from './src/review/signals.ts';",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',outfile:file,metafile:true}).then(result=>{
  for(const name of Object.entries(Object.values(result.metafile.outputs)[0].inputs).filter(([,v])=>v.bytesInOutput>0).map(([name])=>name)) if(/^src\/(worker|semantic|tasks|lanes)\.ts$/.test(name)) throw Error('forbidden import: '+name);
});
export const api = await import('../'+file);
rmSync(file);
export const night = Date.parse('2026-11-13T18:00:00Z');
export function database(path=':memory:') {
  const raw=new DatabaseSync(path);
  for(const f of ['schema.sql','migrations/0002_plan_authority.sql','migrations/0003_stage_timings.sql','migrations/0004_repo_index.sql','migrations/0008_review.sql']) raw.exec(readFileSync(f,'utf8'));
  const calls=[];
  let before;
  const DB={calls,raw,setBefore(fn){before=fn},prepare(sql){
    const stmt=(args=[])=>({sql,args,bind(...args){return stmt(args)},async all(){before?.(sql,args);calls.push(sql);return {results:raw.prepare(sql).all(...args)}},async first(){before?.(sql,args);calls.push(sql);return raw.prepare(sql).get(...args)||null},async run(){before?.(sql,args);calls.push(sql);return raw.prepare(sql).run(...args)}});
    return stmt();
  },async batch(ss){raw.exec('BEGIN');try{const out=[];for(const s of ss)out.push(/^\s*SELECT/i.test(s.sql)?await s.all():await s.run());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}}};
  return DB;
}
export function setup(mode='shadow',path) {
  const DB=database(path),e={DB,REVIEW_MODE:mode,OPENAI_MODEL:'fake-second',DEEPSEEK_MODEL:'fake-first',OPENAI_API_KEY:'sk-fakeOPENAIKEY123456',DEEPSEEK_API_KEY:'sk-fakeDEEPSEEK123456',DEEPSEEK_INPUT_USD_MICROS:'0.01',DEEPSEEK_OUTPUT_USD_MICROS:'0.1',OPENAI_INPUT_USD_MICROS:'0.01',OPENAI_OUTPUT_USD_MICROS:'0.1'};
  return {e,db:DB.raw};
}
export function seed(db,count=3) {
  db.exec("INSERT OR IGNORE INTO members(id,name,token_hash,role) VALUES('qq:u','成员','member-hash','admin')");
  for(let i=0;i<count;i++){
    const at=night-86400000+i*1000;
    db.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,1)').run('m'+i,'g','u','请你以后回复最多200字，帮我查一下仓库改动',new Date(at).toISOString());
    db.prepare("INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,'sent',?)").run('o'+i,'g','m'+i,'我没有查到仓库的新改动',at+100);
  }
}
export function fakeFetch(seen=[],{issue=true,fail=false,requirements=false,gap=false,memory=false}={}) {
  return async(url,init)=>{
    seen.push({url:String(url),method:init.method});
    if(!['https://api.deepseek.com/chat/completions','https://api.openai.com/v1/chat/completions'].includes(String(url)))throw Error('disallowed network');
    if(fail) return new Response('unauthorized '+ 'sk-fakeDEEPSEEK123456',{status:401});
    const wire=JSON.parse(init.body),data=JSON.parse(wire.messages[1].content),second=String(url).includes('openai.com');
    const dimensions={answered:issue?'UNSATISFIED':'SATISFIED',facts:gap?'UNSATISFIED':'SATISFIED',tool_choice:'INSUFFICIENT',memory:'SATISFIED',expression:'SATISFIED',boundary:'SATISFIED'};
    const evidence=t=>t.inbound?[{source:'message',id:t.inbound.id,quote:t.inbound.body.slice(0,15)}]:[{source:'outbox',id:t.replies[0].outbox_id,quote:t.replies[0].body.slice(0,15)}];
    const verdicts=data.traces.map(t=>second?{trace_id:t.id,verdict:issue?'issue':'pass',failure_type:issue?'reasoning.decision.tool_selection':null,gap_type:gap?'tool_missing':null,severity:gap?'p0':'p1',dimensions,evidence:evidence(t),reason:'没有完成仓库检查',confidence:.9}:{trace_id:t.id,kind:issue?'response_fault':'none',reasoning:'依据原话',dimensions,failure_type:issue?'reasoning.decision.tool_selection':null,severity:gap?'p0':'p1',fix_layer:'prompt',gap_type:gap?'tool_missing':null,capability:'repo_read',should_use_tool:'none',what_happened:'没有查到改动',expected:'查询后给出提交',root_cause:'没有核对仓库',next_attempt_plan:'回放查询',evidence:evidence(t),confidence:.9});
    const result=second?{schema:'ta.review.second.v1',verdicts}:{schema:'ta.review.result.v2',verdicts,requirements:requirements?data.traces.filter(t=>t.inbound).map(t=>({kind:'reply_max_chars',params:{max:200},rule:'回复最多200字。',scene:'群回复',ttl_days:7,evidence:[{source:'message',id:t.inbound.id,quote:'请你以后回复最多200字'}]})):[],memory_updates:memory?data.traces.filter(t=>t.inbound).map(t=>({op:'ADD',repo:'OmnixSI/TeamAgent',subject:'成员',predicate:'回复偏好',value:'200字',evidence:[{source:'message',id:t.inbound.id,quote:'请你以后回复最多200字'}]})):[],promises:[],no_action:[]};
    return Response.json({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:100}});
  };
}
export async function tick(e,now=night,options={}) {
  const start=e.DB.calls.length;
  const result=await api.reviewTick(e,{now:()=>now,fetch:fakeFetch(),...options});
  const used=e.DB.calls.length-start;
  if(used>48) throw Error('tick exceeded 48: '+used);
  return {...result,used};
}
export async function finish(e,now=night,options={},max=150) {
  const counts=[];
  for(let n=0;n<max;n++){
    const result=await tick(e,now+n*1000,options);counts.push(result.used);
    const runs=e.DB.raw.prepare('SELECT step,error FROM review_runs WHERE date=?').all(api.sydneyTime(now).date);
    if(runs.length&&runs.every(r=>['done','failed'].includes(r.step))){if(runs.some(r=>r.step!=='done'))throw Error(JSON.stringify(runs));return counts}
  }
  throw Error('pipeline did not finish: '+JSON.stringify(e.DB.raw.prepare('SELECT step,stats,error FROM review_runs').all()));
}
