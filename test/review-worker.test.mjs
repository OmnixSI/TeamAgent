import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync,mkdtempSync,copyFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api,setup,seed,tick,finish,night,fakeFetch } from './review-worker-fixture.mjs';

test('Sydney window includes 04:00, excludes 07:30 across both DST transitions',()=>{
  for(const [at,allowed] of [['2026-04-04T17:59:00Z',false],['2026-04-04T18:00:00Z',true],['2026-04-04T21:29:00Z',true],['2026-04-04T21:30:00Z',false],['2026-10-03T16:59:00Z',false],['2026-10-03T17:00:00Z',true],['2026-10-03T20:30:00Z',false]])assert.equal(api.sydneyTime(Date.parse(at)).inWindow,allowed,at);
});
test('off review means zero writes and production ignores REVIEW_NOW',async()=>{
  const {e,db}=setup();seed(db);db.exec("INSERT INTO settings VALUES('off:review','1')");
  await tick(e);assert.equal(e.DB.calls.filter(s=>!/^\s*SELECT/i.test(s)).length,0);
  e.REVIEW_NOW='2026-11-14T05:00:00+11:00';e.REVIEW_DEV='1';await api.default.scheduled({scheduledTime:Date.parse('2026-11-14T00:00:00Z')},e);assert.equal(db.prepare('SELECT count(*) n FROM review_runs').get().n,0);
});
test('VD-R4-IDEM concurrent claims run only one snapshot',async()=>{
  const {e,db}=setup();seed(db);await Promise.all([tick(e),tick(e)]);
  assert.equal(db.prepare('SELECT count(*) n FROM review_runs').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM review_snapshots').get().n,1);
  assert.equal(db.prepare('SELECT step FROM review_runs').get().step,'trace');
});
test('VD-R4-IDEM stale model result persists validated evidence but cannot advance newer gen',async()=>{
  const {e,db}=setup('propose');seed(db);await tick(e);await tick(e);
  assert.equal(db.prepare('SELECT count(*) n FROM review_traces').get().n,3);
  let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
  const fetch=async(...args)=>{enter();await held;return fakeFetch()(...args)};
  const old=tick(e,night+2000,{fetch});await entered;
  const generation=db.prepare('SELECT gen FROM review_runs').get().gen;
  await tick(e,night+303000);
  const newer=db.prepare('SELECT gen,step FROM review_runs').get();assert.ok(newer.gen>generation);
  release();await old;assert.deepEqual(db.prepare('SELECT gen,step FROM review_runs').get(),newer);
  await finish(e,night+304000);
  const before=JSON.stringify(db.prepare('SELECT id FROM review_findings ORDER BY id').all());await tick(e,night+500000);
  assert.equal(JSON.stringify(db.prepare('SELECT id FROM review_findings ORDER BY id').all()),before);
  for(const row of db.prepare("SELECT raw FROM review_judgments WHERE role='primary' AND state='ok'").all())for(const v of JSON.parse(row.raw).verdicts)assert.equal(v.evidence[0].origin,'direct');
});
test('VD-R4-IDEM interrupt after atomic apply page resumes without duplicate findings or tasks',async()=>{
  const {e,db}=setup('propose');seed(db,20);
  for(let i=0;i<50&&db.prepare('SELECT step FROM review_runs').get()?.step!=='apply';i++)await tick(e,night+i*1000);
  await tick(e,night+51000); // persist stable plan
  let fail=true;e.DB.setBefore(sql=>{if(fail&&/UPDATE review_runs SET step/.test(sql)){fail=false;throw Error('crash')}});
  await tick(e,night+52000);e.DB.setBefore(null);await finish(e,night+60000);
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,20);
  assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='judged'").get().n,20);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});
test('three failed attempts stop the run and a following night starts afresh',async()=>{
  const {e,db}=setup();seed(db);e.DB.setBefore(sql=>{if(/FROM repo_state/.test(sql))throw Error('snapshot failed sk-fakeSECRET123456')});
  for(let i=0;i<3;i++)await tick(e,night+i*1000);
  assert.equal(db.prepare('SELECT step FROM review_runs').get().step,'failed');
  assert.ok(!db.prepare('SELECT error FROM review_runs').get().error.includes('sk-'));
  e.DB.setBefore(null);await finish(e,night+86400000);
  assert.equal(db.prepare('SELECT step FROM review_runs ORDER BY date DESC LIMIT 1').get().step,'done');
});
test('coverage mismatch fails closed before any judge request',async()=>{
  const {e,db}=setup();seed(db);await tick(e);await tick(e);
  const run=db.prepare('SELECT stats FROM review_runs').get(),stats=JSON.parse(run.stats);stats.coverage.unaccounted=1;
  db.prepare('UPDATE review_runs SET stats=?').run(JSON.stringify(stats));const seen=[];await tick(e,night,{fetch:fakeFetch(seen)});
  assert.equal(db.prepare('SELECT step FROM review_runs').get().step,'failed');assert.equal(seen.length,0);
});
test('VD-R-GUARD VD-R-SHADOW-LOCAL three real fixture nights finish with bounded ticks and zero daytime mutations',async(t)=>{
  const priorFetch=globalThis.fetch,imageCalls=[];
  globalThis.fetch=async(url,init={})=>{
    const target=new URL(url),method=init.method??'GET';imageCalls.push({host:target.hostname,method});
    assert.ok(target.protocol==='https:'&&(target.hostname==='multimedia.nt.qq.com.cn'||target.hostname==='gchat.qpic.cn'||target.hostname.endsWith('.qpic.cn')));
    assert.equal(method,'GET');return new Response(null,{status:404});
  };t.after(()=>{globalThis.fetch=priorFetch});
  const replay=process.env.REVIEW_REPLAY_DIR||fileURLToPath(new URL('../../TeamAgent-p4b-login/.agent/releases/V-D-reflection-loop/replay',import.meta.url));
  const real=existsSync(join(replay,'seed-437.sqlite'));
  const dir=mkdtempSync(join(tmpdir(),'review-d6-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const target=join(dir,'copy.sqlite');if(real)copyFileSync(join(replay,'seed-437.sqlite'),target);
  const {e,db}=setup('shadow',real?target:undefined);t.after(()=>db.close());if(!real)seed(db,40);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'review_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const snapshot=()=>tables.map(({name})=>[name,JSON.stringify((()=>{try{return db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all();}catch{return db.prepare('SELECT * FROM "'+name+'" ORDER BY 1,2').all();}})())]);const before=snapshot(),seen=[];
  const nights=real?JSON.parse(readFileSync(join(replay,'sim-nights.json'),'utf8')).nights.map(n=>Date.parse(n.utc)):[night-86400000,night,night+86400000];
  const counts=[];for(const at of nights)counts.push(...await finish(e,at,{fetch:fakeFetch(seen,{issue:false})},1000));
  t.diagnostic(`real_fixture=${real}; nights=3; runs=${db.prepare('SELECT count(*) n FROM review_runs').get().n}; traces=${db.prepare('SELECT count(*) n FROM review_traces').get().n}; max_tick_statements=${Math.max(...counts)}; real_sends=0; online_rows_written=0`);
  assert.deepEqual(db.prepare('SELECT DISTINCT step FROM review_runs').all().map(r=>r.step),['done']);assert.deepEqual(snapshot(),before);
  for(const call of imageCalls){assert.equal(call.method,'GET');assert.ok(call.host==='multimedia.nt.qq.com.cn'||call.host==='gchat.qpic.cn'||call.host.endsWith('.qpic.cn'));}
  assert.ok(seen.length>0);for(const call of seen)assert.ok(['https://api.deepseek.com/chat/completions','https://api.openai.com/v1/chat/completions'].includes(call.url));
});
test('VD-R-KEY provider 401 and timeouts do not leak either fake key into any table or digest',async()=>{
  const logs=[],prior={info:console.info,error:console.error,warn:console.warn};
  for(const method of Object.keys(prior))console[method]=(...args)=>logs.push(args.join(' '));
  try{
  for(const fetch of [fakeFetch([],{fail:true}),async()=>{throw new DOMException('timeout sk-fakeDEEPSEEK123456','TimeoutError')}]){
  const {e,db}=setup();seed(db);await finish(e,night,{fetch});
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,0);
  assert.ok(db.prepare("SELECT count(*) n FROM review_traces WHERE state='judge_failed'").get().n>0);
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())assert.ok(!JSON.stringify(db.prepare('SELECT * FROM "'+name+'"').all()).includes('sk-fake'),name);
  }assert.ok(!logs.join('\n').includes('sk-fake'));
  }finally{Object.assign(console,prior)}
});
test('full mode applies typed requirements after second, propose leaves rules untouched',async()=>{
  for(const mode of ['shadow','propose','full']){
    const {e,db}=setup(mode);seed(db);await finish(e,night,{fetch:fakeFetch([],{requirements:true})});
    assert.equal(db.prepare('SELECT count(*) n FROM behavior_rules').get().n,mode==='full'?3:0);
    if(mode==='full')assert.equal(db.prepare("SELECT count(*) n FROM behavior_rules WHERE status='canary'").get().n,1);
  }
});
test('API auth, CORS, digest days and rowid detail are read only; PATCH requires admin',async()=>{
  const {e,db}=setup();seed(db);await finish(e);
  const hash=async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
  db.prepare('UPDATE members SET token_hash=?,role=? WHERE id=?').run(await hash('member'),'member','qq:u');
  db.prepare('INSERT INTO members(id,name,token_hash,role) VALUES(?,?,?,?)').run('a','管理员',await hash('admin'),'admin');
  const request=(path,key='member',method='GET',body)=>api.default.fetch(new Request('https://review.test'+path,{method,headers:{Authorization:'Bearer '+key,Origin:'https://inkboard-team.inkboard-server.workers.dev','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),e);
  const start=e.DB.calls.length;
  assert.equal((await request('/review/health','bad')).status,401);
  const res=await request('/review/digest?days=7');assert.equal(res.status,200);assert.equal(res.headers.get('Access-Control-Allow-Origin'),'https://inkboard-team.inkboard-server.workers.dev');
  const data=await res.json();assert.ok(Array.isArray(data.days)&&Array.isArray(data.gaps)&&Array.isArray(data.rules));
  const f=data.days[0].findings[0];assert.equal(f.inbound.rowid,Number(f.inbound.id.slice(1))+1);assert.equal(f.evidence[0].rowid,f.inbound.rowid);assert.equal(typeof f.dimensions,'object');
  assert.equal(e.DB.calls.slice(start).filter(s=>!/^\s*SELECT/i.test(s)).length,0);
  assert.equal((await request('/review/finding/'+f.id,'member','PATCH',{status:'accepted'})).status,403);
  assert.equal((await request('/review/finding/'+f.id,'admin','PATCH',{status:'accepted'})).status,200);
  assert.equal(db.prepare('SELECT status FROM review_findings WHERE id=?').get(f.id).status,'accepted');
  assert.equal((await request('/review/digest?date=2026-02-31')).status,400);
});

test('VD-R4-IDEM a retried p0 gap plan retains exactly one occurrence per finding and one task',async()=>{
  const {e,db}=setup('propose');seed(db,4);
  const fetch=fakeFetch([],{gap:true,memory:true});
  // Historical offers identify a genuine missing capability, independent of now.
  for(let i=0;i<4;i++)db.prepare("INSERT INTO turn_offers(turn_id,group_id,inbound_id,names,catalog_version,switches,runner_ok,created_at) VALUES(?,? ,?,'[]','cat-v1','{}',1,?)").run('m'+i,'g','m'+i,night-86400000);
  let interrupted=false;
  for(let i=0;i<150;i++){
    const run=db.prepare('SELECT step,stats FROM review_runs').get();
    if(run?.step==='apply'&&!interrupted){
      let once=true;e.DB.setBefore(sql=>{if(once&&/UPDATE review_runs SET step/.test(sql)){once=false;throw Error('power loss')}});
      await tick(e,night+i*1000,{fetch});e.DB.setBefore(null);interrupted=true;
    } else await tick(e,night+i*1000,{fetch});
    if(db.prepare('SELECT step FROM review_runs').get()?.step==='done')break;
  }
  assert.equal(db.prepare('SELECT step FROM review_runs').get().step,'done');
  assert.ok(interrupted);
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,4);
  assert.equal(db.prepare('SELECT occurrences FROM capability_gaps').get().occurrences,4);
  assert.equal(db.prepare("SELECT count(*) n FROM review_consumed WHERE kind='gap_occurrence'").get().n,4);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM review_memory_candidates').get().n,4);
  assert.equal(db.prepare('SELECT count(*) n FROM facts').get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM tasks WHERE status='proposal' AND source_id LIKE 'review:%'").get().n,1);
});
test('reservation and journal are atomic before outbound fetch; split retries never invent findings',async()=>{
  const {e,db}=setup();seed(db,2);let requests=0;
  const fetch=async(url,init)=>{
    requests++;
    assert.equal(db.prepare("SELECT count(*) n FROM review_judgments WHERE state='reserved'").get().n,1);
    assert.ok(db.prepare('SELECT sum(reserved) n FROM review_budget').get().n>0);
    return Response.json({choices:[{message:{content:'{"schema":'},finish_reason:'length'}]});
  };
  await finish(e,night,{fetch});
  assert.equal(requests,3);assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='judge_failed'").get().n,2);
  assert.equal(db.prepare('SELECT sum(reserved) n FROM review_budget').get().n,0);
  assert.ok(db.prepare('SELECT sum(used) n FROM review_budget').get().n>0);
});
test('API rule approve/revoke and memory approve/reject are scoped to authenticated admins',async()=>{
  const {e,db}=setup('propose');seed(db,2);await finish(e,night,{fetch:fakeFetch([],{memory:true})});
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('admin'))).toString('hex');
  db.prepare("INSERT INTO members(id,name,token_hash,role) VALUES('a','管理员',?,'admin')").run(hash);
  const request=(kind,id,status,reason)=>api.default.fetch(new Request('https://review.test/review/'+kind+'/'+id,{method:'PATCH',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify({status,reason})}),e);
  const memory=db.prepare('SELECT id FROM review_memory_candidates ORDER BY id').all();assert.equal(memory.length,2);
  assert.equal((await request('memory',memory[0].id,'approved')).status,200);
  const facts=db.prepare('SELECT count(*) n FROM facts').get().n;assert.equal(facts,1);
  assert.equal((await request('memory',memory[0].id,'approved')).status,200);assert.equal(db.prepare('SELECT count(*) n FROM facts').get().n,facts);
  assert.equal((await request('memory',memory[1].id,'rejected')).status,200);
  db.prepare("INSERT INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,expires_at,created_at,updated_at) VALUES('free','g','回复简短','回复','free','{}',?,'member:qq:u','candidate',?,?,?)").run(JSON.stringify([{source:'message',id:'m0',quote:'请你以后回复最多200字',origin:'direct'}]),Date.now()+86400000,night,night);
  assert.equal((await request('rule','free','canary')).status,200);
  assert.equal(db.prepare("SELECT status FROM behavior_rules WHERE id='free'").get().status,'canary');
  assert.equal((await request('rule','free','retired','管理员撤销')).status,200);
  assert.equal(db.prepare("SELECT status FROM behavior_rules WHERE id='free'").get().status,'retired');
});

test('API empty workspace, AI readonly identity, health migration and hostile CORS',async()=>{
  const {e,db}=setup();
  const hash=async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
  db.prepare("INSERT INTO members(id,name,token_hash,role) VALUES('a','管理员',?,'admin')").run(await hash('admin'));
  db.prepare("INSERT INTO member_passwords(member_id,login_name,password_hash) VALUES('a','admin','fake')").run();
  db.prepare("INSERT INTO ai_tokens(id,member_id,label,token_hash,created_at,expires,revoked) VALUES('ai','a','readonly',?,?,?,0)").run(await hash('teamai_fake'),night,Date.now()+86400000);
  const request=(path,key='admin',origin)=>api.default.fetch(new Request('https://review.test'+path,{headers:{Authorization:'Bearer '+key,...(origin?{Origin:origin}:{})}}),e);
  const empty=await request('/review/digest?days=7');assert.equal(empty.status,200);assert.deepEqual((await empty.json()).days,[]);
  assert.equal((await request('/review/health','teamai_fake')).status,200);
  assert.equal(db.prepare("SELECT last_used FROM ai_tokens WHERE id='ai'").get().last_used,null);
  assert.equal((await request('/review/health','admin','https://evil.example')).status,403);
  const health=await(await request('/review/health')).json();assert.equal(health.migration,'0008');assert.ok(health.ok);
  db.exec('DROP TABLE review_judgments');assert.equal((await request('/review/health')).status,503);
});
test('stolen generation fences every apply page mutation inside its atomic batch',async()=>{
  const {e,db}=setup('propose');seed(db,2);
  for(let i=0;i<40;i++){
    const run=db.prepare('SELECT step,stats FROM review_runs').get();if(run?.step==='apply')break;
    await tick(e,night+i*1000);
  }
  let once=true;e.DB.setBefore(sql=>{if(once&&/^INSERT OR IGNORE INTO review_findings/.test(sql)){once=false;db.exec('UPDATE review_runs SET gen=gen+1,lease_until=NULL')}});
  const result=await tick(e,night+50000);e.DB.setBefore(null);assert.equal(result.status,'stale');
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,0);
  await finish(e,night+60000);assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n,2);
});

test('budget exhaustion defers pending traces to the following night and expires old backlog',async()=>{
  const {e,db}=setup();seed(db,2);e.DEEPSEEK_DAY_CAP_USD_MICROS='1';const seen=[];
  await finish(e,night,{fetch:fakeFetch(seen)});
  assert.equal(seen.length,0);assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='pending'").get().n,2);
  assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='judge_failed'").get().n,0);
  e.DEEPSEEK_DAY_CAP_USD_MICROS='100000';await finish(e,night+86400000);
  assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='judged'").get().n,2);
  db.prepare("UPDATE review_traces SET state='pending',created_at=?").run(night-4*86400000);
  await finish(e,night+2*86400000);assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='expired'").get().n,2);
});
