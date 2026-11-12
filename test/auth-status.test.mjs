import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,req,worker,qq,msg} from './support.mjs';
await build({entryPoints:['src/fetchjobs.ts'],bundle:true,format:'esm',platform:'browser',outfile:`.wrangler/auth-status-${process.pid}.mjs`});
const {authReminder}=await import(`../.wrangler/auth-status-${process.pid}.mjs`);
await build({entryPoints:['src/voice.ts'],bundle:true,format:'esm',platform:'browser',outfile:`.wrangler/auth-voice-${process.pid}.mjs`});
const {enqueueVoice}=await import(`../.wrangler/auth-voice-${process.pid}.mjs`);
const status=(e,service,state)=>req(e,'/api/runner/fetch/auth-status',{service,state,checked_at:new Date().toISOString(),cookie:'never-copy-private-cookie'},'runner-secret');
const marker=e=>e.DB.prepare("SELECT value FROM settings WHERE key='auth-reminded:bili'").first();
test('auth reminders require prior ok, throttle per service for 24h and clear on recovery',async()=>{
 const e=env();await status(e,'bili','missing');assert.equal(await authReminder(e,'bili'),null);
 await status(e,'bili','expired');assert.equal(await authReminder(e,'bili'),null);
 await status(e,'bili','ok');await status(e,'bili','expired');const text=await authReminder(e,'bili');assert.match(text,/B 站.*登录过期/);assert.ok(!text.includes('never-copy-private-cookie'));
 assert.equal(await authReminder(e,'bili'),null);assert.ok(await marker(e));await e.DB.prepare("UPDATE settings SET value=? WHERE key='auth-reminded:bili'").bind(String(Date.now()-86400001)).run();assert.ok(await authReminder(e,'bili'));
 await status(e,'bili','ok');assert.equal(await marker(e),null);assert.equal(await authReminder(e,'bili'),null);
 await status(e,'bili','risk');assert.ok(await authReminder(e,'bili'));await status(e,'bili','missing');assert.equal(await authReminder(e,'bili'),null);
 const row=await e.DB.prepare("SELECT value FROM settings WHERE key='auth:bili'").first();assert.ok(!row.value.includes('never-copy-private-cookie'));
});
test('concurrent reminders for one service reserve only one notification',async()=>{
 const e=env();await status(e,'x','ok');await status(e,'x','risk');const out=await Promise.all([authReminder(e,'x'),authReminder(e,'x')]);assert.equal(out.filter(Boolean).length,1);
});
test('auth status route keeps runner auth and works after pause gate without enabling claims',async()=>{
 const e=env();await e.DB.prepare("INSERT INTO settings VALUES('runner_pause_until',?)").bind(String(Date.now()+60000)).run();
 assert.equal((await status(e,'bili','ok')).status,200);assert.equal((await req(e,'/api/runner/fetch/auth-status',{service:'bili',state:'ok'},'')).status,401);
 assert.equal((await status(e,'evil','ok')).status,400);assert.equal((await req(e,'/api/runner/fetch/claim',{},'runner-secret')).status,200);
});
test('normal reply actually appends reminder once; silent and replayed replies do not consume it',async()=>{
 const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});await status(e,'bili','ok');await status(e,'bili','expired');
 await qq(e,msg('auth-reply','说点什么'),'GROUP_AT_MESSAGE_CREATE');const old=globalThis.fetch;
 globalThis.fetch=async(_url,o)=>{const body=JSON.parse(o.body);return Response.json({choices:[{message:{content:body.messages[0].content.includes('最后的嘴替模块')?'{"mode":"work","text":"正常回答。"}':'{"should_reply":true,"kind":"direct","brief":"正常回答"}'}}]});};
 try{await worker.queue({messages:[{body:{id:'chat-auth-reply'},ack(){}}]},e);}finally{globalThis.fetch=old;}
 const row=await e.DB.prepare("SELECT body FROM outbox WHERE id='chat-auth-reply'").first();assert.match(row.body,/正常回答。\n.*B 站.*登录过期/);assert.ok(await marker(e));
 const before=row.body;await worker.queue({messages:[{body:{id:'chat-auth-reply'},ack(){}}]},e);assert.equal((await e.DB.prepare("SELECT body FROM outbox WHERE id='chat-auth-reply'").first()).body,before);
});
test('silent and pre-existing outbox messages leave reminder reservations untouched',async()=>{
 const e=env();await status(e,'bili','ok');await status(e,'bili','expired');
 await enqueueVoice(e,'silent','GROUP000001','m','{"mode":"work","text":"[[SILENT]]"}');assert.equal(await marker(e),null);
 await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('existing','GROUP000001','m','旧回答','sent',Date.now()).run();
 await enqueueVoice(e,'existing','GROUP000001','m','{"mode":"work","text":"重试"}');assert.equal(await marker(e),null);
});
test('two expired services append only safe text within the D1 invocation budget',async()=>{
 const e=env();for(const service of ['bili','x']){await status(e,service,'ok');await status(e,service,'risk');}
 const before=e.DB.executed;
 await enqueueVoice(e,'both','GROUP000001','m','{"mode":"work","text":"回答"}');
 assert.ok(e.DB.executed-before<=48);const row=await e.DB.prepare("SELECT body FROM outbox WHERE id='both'").first();assert.match(row.body,/B 站.*登录过期/);assert.match(row.body,/X.*登录过期/);
 assert.ok(!row.body.includes('never-copy-private-cookie'));
});
