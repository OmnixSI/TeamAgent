import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {api,env,worker,call,context,rows,models} from './support-tool-audit.mjs';
test('turn_tools schema and migration are repeatable and match the review contract',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync('schema.sql','utf8'));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='turn_tools'").get());
    const migration=readFileSync('migrations/0010_f6_turn_tools.sql','utf8');db.exec(migration);db.exec(migration);
    assert.deepEqual(db.prepare('PRAGMA table_info(turn_tools)').all().map(r=>r.name),['id','turn_id','group_id','name','args','ok','error_kind','ms','offered','created_at']);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='turn_tools_turn'").get());
  }finally{db.close();}
});
test('one audit row per invocation includes redacted bounded arguments, outcome and duration',async()=>{
  const e=env(),ctx=await context(e);
  await models([[call('get_work_status',{query:'sk-'+ 'S'.repeat(30)+'x'.repeat(400)}),call('get_project',{repo:'OmnixSI/TeamAgent'})]],async()=>{
    await api.agentAnswer(e,ctx);
    const audit=await rows(e,'turn_tools');assert.equal(audit.length,2);
    const success=audit.find(r=>r.name==='get_work_status'),failure=audit.find(r=>r.name==='get_project');
    assert.equal(success.ok,1);assert.equal(success.error_kind,null);assert.equal(failure.ok,0);assert.equal(failure.error_kind,'not_synced');
    for(const r of audit){assert.equal(r.turn_id,ctx.latest.id);assert.equal(r.group_id,ctx.latest.group_id);assert.ok(r.ms>=0);assert.equal(r.offered,1);assert.ok(r.created_at>0);assert.ok(r.args.length<=200);assert.doesNotMatch(r.args,/sk-S/);}
  });
});
test('an audit insert failure does not break a successful tool or the reply',async()=>{
  const e=env(),ctx=await context(e),prepare=e.DB.prepare.bind(e.DB);
  e.DB.prepare=sql=>{if(sql.includes('INSERT')&&sql.includes('turn_tools'))throw Error('audit unavailable');return prepare(sql);};
  await models([call('get_work_status')],async()=>assert.ok(JSON.parse(await api.agentAnswer(e,ctx)).text));
});
test('tools excluded by the current budget are audited as not offered and never execute',async()=>{
  const e=env(),ctx=await context(e),prepare=e.DB.prepare.bind(e.DB);
  e.meter={left:()=>15};
  e.DB.prepare=sql=>{assert.ok(!sql.includes('SELECT t.id,t.repo'),'unoffered executor ran');return prepare(sql);};
  await models([call('get_work_status')],async()=>{
    await api.agentAnswer(e,ctx);const [r]=await rows(e,'turn_tools');
    assert.equal(r.ok,0);assert.equal(r.offered,0);assert.equal(r.error_kind,'budget');
  });
});
test('a metered research invocation flushes its audit once and retains the reply if deferred auditing fails',async()=>{
  for(const broken of [false,true]) {
    const e=env(),ctx=await context(e),prepare=e.DB.prepare.bind(e.DB);let acked=false;
    await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('audit-research','research',JSON.stringify({latestId:ctx.latest.id,batchIds:[ctx.latest.id],mentioned:true,resume:{messages:[{role:'system',content:'恢复现有查询'}],pending:{role:'assistant',tool_calls:[call('get_work_status')]},turn:0}}),Date.now()).run();
    if(broken)e.DB.prepare=sql=>{if(sql.includes('INSERT')&&sql.includes('turn_tools'))throw Error('audit unavailable');return prepare(sql);};
    await models([],async()=>worker.queue({messages:[{body:{id:'audit-research'},ack(){acked=true;}}]},e));
    assert.equal(acked,true);assert.equal((await rows(e,'jobs'))[0].status,'done');assert.ok((await rows(e,'outbox')).length);
    assert.equal((await rows(e,'turn_tools')).length,broken?0:1);
  }
});
