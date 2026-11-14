// Offline incident replay: real messages and timestamps, disposable independent SQLite.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'teamagent-test-resend-'));
const originalFetch=globalThis.fetch;
let db,networkCalls=0,simulatedQQSends=0;
try{
  const bundle=join(temp,'replay.mjs');
  await build({absWorkingDir:root,stdin:{contents:'export {default as worker} from "./src/worker"; export {sweepMentions} from "./src/mention-guard";',resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile:bundle,
    // UI is not executed by the replay; a clean checkout need not build it.
    plugins:[{name:'unused-ui',setup(b){b.onLoad({filter:/\/src\/ui\.ts$/},()=>({contents:'export const HTML="";',loader:'ts'}));}}]});
  const {worker,sweepMentions}=await import(pathToFileURL(bundle).href);
  db=new DatabaseSync(join(temp,'replay.sqlite'));
  db.exec(readFileSync(join(root,'schema.sql'),'utf8'));
  const statement=(sql,args=[])=>({sql,bind(...xs){return statement(sql,xs);},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return db.prepare(sql).run(...args);}});
  const e={DB:{prepare:statement,async batch(ss){db.exec('BEGIN');try{const rs=[];for(const s of ss)rs.push(await (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql)?s.all():s.run()));db.exec('COMMIT');return rs;}catch(err){db.exec('ROLLBACK');throw err;}}},WORK:{async send(){}},DEEPSEEK_API_KEY:'offline-only',QQ_APP_ID:'offline-only',QQ_APP_SECRET:'offline-only'};
  const fixture=JSON.parse(readFileSync(join(root,'test/fixtures/resend-real.json'),'utf8'));
  const insert=db.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,0)');
  for(const m of fixture.messages)insert.run(m.id,m.group_id,m.sender,m.body,m.ts,m.mentioned);
  globalThis.fetch=async()=>{networkCalls++;throw Error('Replay forbids network');};
  // Sweep as at the first incident tick, then several later ticks.
  const incident=Date.parse('2026-11-13T14:45:02Z');
  for(let tick=0;tick<5;tick++)await sweepMentions(e,incident+tick*60000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n,0);
  // Also replay already-queued rows to exercise the independent sender gate.
  for(const m of fixture.messages)for(const prefix of ['mention-recovery:','mention-receipt:']){
    const id=prefix+m.id+(prefix==='mention-recovery:'?':1':'');
    db.prepare("INSERT INTO outbox VALUES(?,?,?,?,'pending',?)").run(id,m.group_id,m.id,'历史待发补偿',incident);
  }
  for(let i=0;i<2;i++)await worker.queue({messages:[]},e);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox WHERE status<>'skipped'").get().n,0);
  for(const m of fixture.messages)console.log(`rowid ${m.rid} | ${m.ts} | 未补发（扫描 0，遗留待发已 skipped）`);
  // A new source 100 seconds ago must still recover exactly once and send once.
  const now=Date.now(),group=fixture.messages[0].group_id,source='replay-new';
  insert.run(source,group,'offline-member','说话',new Date(now-100000).toISOString(),1);
  db.prepare('INSERT INTO settings VALUES(?,?)').run('group_id',group);
  await sweepMentions(e,now);await sweepMentions(e,now);
  const recoveries=db.prepare("SELECT * FROM jobs WHERE kind='chat'").all();
  assert.equal(recoveries.length,1);
  // Model and QQ are simulated locally, no requests leave this process.
  e.QQ_APP_ID='';
  globalThis.fetch=async(url,options)=>{
    if(String(url)==='https://api.deepseek.com/chat/completions'){
      const body=JSON.parse(options.body);
      const content=body.messages[0].content.includes('最后的嘴替模块')?'{"mode":"work","text":"我在，正在看。"}':'{"action":"reply","kind":"direct","brief":"我在。"}';
      return Response.json({choices:[{message:{content}}]});
    }
    networkCalls++;throw Error('Unexpected request in offline model phase');
  };
  await worker.queue({messages:[{body:{id:recoveries[0].id},ack(){}}]},e);
  e.QQ_APP_ID='offline-only';
  globalThis.fetch=async url=>{
    if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'offline-only',expires_in:300});
    if(String(url).startsWith('https://api.bot.qq.com/v2/groups/')){simulatedQQSends++;return Response.json({id:'offline-simulated'});}
    networkCalls++;throw Error('Unexpected request in offline send phase');
  };
  await worker.queue({messages:[]},e);await worker.queue({messages:[]},e);
  assert.equal(simulatedQQSends,1);
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id=?').get(recoveries[0].id).status,'sent');
  assert.equal(networkCalls,0);
  console.log('新消息（100 秒前）| 补偿任务 1 次，模拟回复 1 次，重复扫描/发送无新增');
  console.log('QQ 真实发送 0 次、线上 D1 写入 0 行、真实网络请求 0 次');
}finally{globalThis.fetch=originalFetch;db?.close();rmSync(temp,{recursive:true,force:true});}
