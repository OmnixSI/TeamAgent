import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,worker} from './support.mjs';
const out=`.wrangler/resend-scans-${process.pid}.mjs`;
await build({entryPoints:['src/fetchjobs.ts'],bundle:true,platform:'browser',format:'esm',outfile:out});
const {sweepVideoWaits}=await import('../'+out);

test('cron retires old reply-producing jobs instead of waking a deployment backlog',async()=>{
  const e=env(),now=Date.now();
  for(const kind of ['chat','research','voice_notice','scout','semantic_reply','links','claim_notice','ci_triage'])for(const age of ['old','fresh']){
    await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)')
      .bind(kind+'-'+age,kind,'{}',now-(age==='old'?25*3600000:100000)).run();
  }
  const tasks=[];await worker.scheduled({},e,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);
  for(const kind of ['chat','research','voice_notice','scout','semantic_reply','links','claim_notice','ci_triage']){
    assert.equal((await e.DB.prepare('SELECT status FROM jobs WHERE id=?').bind(kind+'-old').first()).status,'failed');
    assert.ok(!e.WORK.sent.some(x=>x.body.id===kind+'-old'));
  }
  for(const kind of ['chat','research','voice_notice','scout','semantic_reply','links','claim_notice','ci_triage'])
    assert.ok(e.WORK.sent.some(x=>x.body.id===kind+'-fresh'));

});

test('video wait scanner skips expired sources without creating wakeups or fallback replies',async()=>{
  const e=env(),now=Date.now();
  await e.DB.prepare(`INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,ready,due_at,created_at)
    VALUES('old-video','GROUP000001','BV1xx411c7mD','old','["old"]',1,0,?,?)`).bind(now-25*3600000,now-25*3600000).run();
  await sweepVideoWaits(e);
  assert.equal((await e.DB.prepare("SELECT status FROM video_waits WHERE id='old-video'").first()).status,'skipped');
  assert.equal(e.WORK.sent.length,0);
  assert.equal((await e.DB.prepare('SELECT * FROM outbox').all()).results.length,0);
});
