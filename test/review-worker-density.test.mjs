import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { api, setup, seed, tick, finish, night, fakeFetch } from './review-worker-fixture.mjs';
const DAY=86400000,start=night-3600000;
const group='density';
const replay=process.env.REVIEW_REPLAY_DIR||fileURLToPath(new URL('../../TeamAgent-p4b-login/.agent/releases/V-D-reflection-loop/replay',import.meta.url));
const sourceFile=join(replay,'seed-437.sqlite');
function quiet(body,reply=false){
  const at=start-DAY;
  return api.signalsOf({inbound:reply?null:{id:'q',sender:'q',ts:new Date(at).toISOString(),body,mentioned:0},replies:[{body:reply?body:'确认收到这条消息',status:'sent',at:at+1000}],tools:[],signals:[]},{after:reply?[]:[{body,ts:new Date(at+5000).toISOString()}]}).length===0;
}
function densityFixture(t){
  assert.ok(existsSync(sourceFile),'real seed required for density replay');
  const source=new DatabaseSync(sourceFile,{readOnly:true});t.after(()=>source.close());
  const sourceMessages=source.prepare('SELECT body FROM messages ORDER BY rowid').all().map(r=>r.body).filter(body=>body.length>=15&&quiet(body));
  const sourceReplies=[];
  const candidateReplies=source.prepare('SELECT DISTINCT body FROM outbox ORDER BY created_at').all().map(r=>r.body).filter(body=>body.length>=4&&quiet(body,true));
  // Keep real wording, but avoid introducing an accidental S10 contradiction
  // between adjacent source excerpts in this controlled 20% density fixture.
  const noDuplicate=(body,previous)=>!api.signalsOf({inbound:null,replies:[{body,status:'sent',at:start}],tools:[],signals:[]},{bot_before:[{body:previous,at:start-1000}]}).includes('S10');
  for(const body of candidateReplies)if(sourceReplies.every(previous=>noDuplicate(body,previous)&&noDuplicate(previous,body)))sourceReplies.push(body);
  assert.ok(sourceMessages.length>=90);assert.ok(sourceReplies.length>=16);
  const {e,db}=setup('shadow');t.after(()=>db.close());
  function addDay(day){
    for(let i=0;i<90;i++){
      const at=start+day*DAY-22*3600000+i*14*60000,id=`d${day}-m${i}`;
      db.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').run(id,group,'real-fixture',sourceMessages[i],new Date(at).toISOString(),i%5===0||i%15===1?1:0);
      db.prepare('INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?)').run(`d${day}-o${i}`,group,id,sourceReplies[i%sourceReplies.length],i%5===0?'failed':'sent',at+1000);
    }
  }
  return {e,db,addDay};
}
function cronMinutes(){
  const cron=readFileSync('wrangler.review.toml','utf8').match(/crons\s*=\s*\["\*\/(\d+) \* \* \* \*"\]/);assert.ok(cron);return Number(cron[1]);
}
async function window(e,at,max=Infinity,options={}){
  const interval=cronMinutes()*60000,used=[];
  for(let i=0;i<max&&i*interval<210*60000;i++){
    used.push((await tick(e,at+i*interval,options)).used);
    const row=e.DB.raw.prepare("SELECT id,step,stats,gen FROM review_runs WHERE step NOT IN ('failed','skipped') ORDER BY date DESC LIMIT 1").get();
    if(row?.step==='done')return {row,ticks:i+1,used};
  }
  return {row:e.DB.raw.prepare('SELECT * FROM review_runs ORDER BY date DESC LIMIT 1').get(),ticks:used.length,used};
}

test('D6b actual cron clears three days of 90 real traces with 20 percent signals and samples within each night',{skip:!existsSync(sourceFile)},async(t)=>{
  const {e,db,addDay}=densityFixture(t);const seen=[];
  for(let day=0;day<3;day++){
    addDay(day);
    const result=await window(e,start+day*DAY,Infinity,{fetch:fakeFetch(seen)});
    assert.equal(result.row.step,'done',`day ${day}: ${result.row.step}`);
    assert.ok(result.ticks<=42);assert.ok(Math.max(...result.used)<=48);
    const stats=JSON.parse(result.row.stats),coverage=stats.coverage;
    assert.equal(coverage.messages,coverage.inbound_traces+coverage.skipped_by_rule);
    assert.equal(coverage.unaccounted,0);assert.ok(coverage.skipped_by_rule>=70);
    const traces=db.prepare("SELECT state,signals FROM review_traces WHERE inbound_id LIKE ?").all(`d${day}-m%`);
    assert.equal(traces.length,90);assert.equal(traces.filter(r=>JSON.parse(r.signals).length).length,18);
    assert.equal(traces.filter(r=>r.state==='judged').length,20);
    assert.equal(traces.filter(r=>r.state==='skipped').length,70);
    t.diagnostic(`day${day+1}: ticks=${result.ticks}; trace=90; signal=18; sampled=2; judged=20; skipped=70; max_sql=${Math.max(...result.used)}`);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM review_runs').get().n,3);
});
test('D6b only ten first-night ticks resume the same run next night without duplicate effects',{skip:!existsSync(sourceFile)},async(t)=>{
  const {e,db,addDay}=densityFixture(t);addDay(0);e.REVIEW_MODE='propose';
  for(const row of db.prepare('SELECT id FROM messages').all()) db.prepare("INSERT INTO turn_offers(turn_id,group_id,inbound_id,names,catalog_version,switches,runner_ok,created_at) VALUES(?,?,?,'[]','cat-v2','{}',1,?)").run(row.id,group,row.id,start-DAY);
  const fetch=fakeFetch([],{gap:true});
  const first=await window(e,start,10,{fetch});assert.notEqual(first.row.step,'done');
  const before=db.prepare('SELECT id,gen FROM review_runs').get();
  const second=await window(e,start+DAY,Infinity,{fetch});assert.equal(second.row.step,'done');assert.equal(second.row.id,before.id);assert.ok(second.row.gen>before.gen);
  assert.equal(db.prepare('SELECT count(*) n FROM review_runs').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,20);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,1);
  assert.equal(db.prepare('SELECT occurrences FROM capability_gaps').get().occurrences,20);
  assert.equal(db.prepare("SELECT count(*) n FROM review_consumed WHERE kind='gap_occurrence'").get().n,20);
  const fingerprints=db.prepare('SELECT trace_id,failure_type,count(*) n FROM review_findings GROUP BY trace_id,failure_type').all();assert.ok(fingerprints.every(f=>f.n===1));
});
test('D6b caps a night at sixty unique traces and keeps the remaining signal backlog pending',async()=>{
  const {e,db}=setup();seed(db,90);const fetch=fakeFetch([],{issue:false});
  await finish(e,start,{fetch},200);
  assert.equal(db.prepare("SELECT count(DISTINCT x.value) n FROM review_judgments j,json_each(j.trace_ids)x WHERE role='primary' AND state='ok'").get().n,60);
  assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='pending'").get().n,30);
  assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='judged'").get().n,60);
});
test('D6b third night publishes existing judgments with an explicit unfinished count and no further provider calls',async()=>{
  const {e,db}=setup();seed(db,12);
  for(let i=0;i<3;i++)await tick(e,start+i*300000); // snapshot, trace, one primary call
  const runId=db.prepare('SELECT id FROM review_runs').get().id;
  await tick(e,start+DAY); // still same run, limited second night
  let calls=0;const fetch=async()=>{calls++;throw Error('third night must not judge')};
  for(let i=0;i<42;i++){
    await tick(e,start+2*DAY+i*300000,{fetch});
    if(db.prepare('SELECT step FROM review_runs WHERE id=?').get(runId).step==='done')break;
  }
  assert.equal(calls,0);assert.equal(db.prepare('SELECT count(*) n FROM review_runs').get().n,1);
  const run=db.prepare('SELECT step,stats FROM review_runs').get();assert.equal(run.step,'done');assert.equal(JSON.parse(run.stats).unreviewed,8);
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,4);
  e.ADMIN_TOKEN='test-admin';
  const response=await api.default.fetch(new Request('https://review.test/review/digest?date=2026-11-14',{headers:{Authorization:'Bearer test-admin'}}),e);
  assert.equal(response.status,200);assert.match(JSON.stringify(await response.json()),/未评完 8 条/);
});
