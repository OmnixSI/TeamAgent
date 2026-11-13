import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,req,qq,msg} from './support.mjs';
await build({entryPoints:['src/voice.ts','src/tts-policy.ts','src/rhythm.ts'],bundle:true,format:'esm',platform:'browser',outdir:'.wrangler/ds2b'});
const {enqueueVoice,decodeVoice}=await import('../.wrangler/ds2b/voice.js');
const {voiceSkipReason}=await import('../.wrangler/ds2b/tts-policy.js');
const group='GROUP000001';
const baseEnv=env;
async function voiceEnv(){const e=baseEnv();await e.DB.prepare(`CREATE TABLE IF NOT EXISTS ds_usage(id TEXT PRIMARY KEY,purpose TEXT,group_id TEXT,sender_id TEXT,status TEXT,error_kind TEXT,latency_ms INTEGER,units INTEGER,est_cost_micro_usd INTEGER,created_at INTEGER)`).run();return e;}
const put=(e,k,v)=>e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(k,v).run();
const row=(e,id)=>e.DB.prepare('SELECT * FROM outbox WHERE id=?').bind(id).first();
const pull=e=>req(e,'/api/runner/voice-outbox',{},'runner-secret').then(r=>r.json());
async function seed(e,id='v1',extra={}){
 await e.DB.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,0)').bind('m1',group,'member1','语音',new Date().toISOString(),1).run();
 e.voiceSwitches=extra.switches||{};
 await enqueueVoice(e,id,group,'m1',JSON.stringify({mode:'work',text:'今天测试通过了。',...extra.reply}),{reference:'ref',source:{sender:'member1',meta:{media:[{kind:'voice'}]}},...extra.opts});
}
test('policy auto uses source audio or model flag and preserves safety exclusions',()=>{
 const cases=[ [{sourceVoice:true},'好的','ok'],[{requested:true},'好的','ok'],[{},'好的','mode'],[{mode:'off',sourceVoice:true},'好的','disabled'],[{mode:'always'},'好的','ok'],[{mode:'always'},'运行 `x`','code'],[{mode:'always'},'https://example.com','link'],[{mode:'always'},'字'.repeat(301),'too_long'],[{mode:'always',quota:false},'好的','quota'],[{mode:'always',parts:2},'好的','parts'] ];
 for(const [delivery,text,want] of cases)assert.equal(voiceSkipReason(text,'work',{enabled:true,delivery}),want);
 assert.equal(decodeVoice('{"mode":"work","text":"好的","voice":true}').voice,true);
 assert.equal(decodeVoice('{"text":"好的","voice":"true"}').voice,undefined);
});
test('enqueue preserves text/reference, honors group override, claims once and reports once',async()=>{
 const e=await voiceEnv(); await seed(e);
 assert.equal((await row(e,'v1')).status,'voice');
 const meta=JSON.parse((await e.DB.prepare('SELECT json FROM outbox_meta WHERE id=?').bind('v1').first()).json);
 assert.equal(meta.reference,'ref');assert.equal(meta.voice_text,'今天测试通过了。');
 const a=await pull(e),b=await pull(e);assert.equal(a.items.length,1);assert.equal(b.items.length,0);
 assert.equal(a.items[0].msg_id,'m1');assert.equal(a.items[0].cfg.enabled,true);
 let r=await req(e,'/api/runner/voice/report',{id:'v1',status:'sent',via:'voice'},'runner-secret');assert.equal(r.status,200);
 await req(e,'/api/runner/voice/report',{id:'v1',status:'failed'},'runner-secret');assert.equal((await row(e,'v1')).status,'sent');
 await seed(e,'off',{switches:{'voice:mode':'always',['voice:mode:'+group]:'off'}});assert.equal((await row(e,'off')).status,'pending');
});
test('ordinary text stays text, model voice flag enables explicit request without keywords',async()=>{
 const e=await voiceEnv();await seed(e,'plain',{opts:{source:{meta:{media:[]}}}});assert.equal((await row(e,'plain')).status,'pending');
 await seed(e,'explicit',{reply:{voice:true},opts:{source:{meta:{media:[]}}}});assert.equal((await row(e,'explicit')).status,'voice');
});
test('voice routes require runner auth, reject invalid reports, skip expired and enforce quota with text fallback',async()=>{
 const e=await voiceEnv();assert.equal((await req(e,'/api/runner/voice-outbox',{})).status,401);
 await seed(e);await e.DB.prepare('UPDATE messages SET ts=?').bind(new Date(Date.now()-241000).toISOString()).run();
 assert.equal((await pull(e)).items.length,0);assert.equal((await row(e,'v1')).status,'skipped');
 await e.DB.prepare('UPDATE messages SET ts=?').bind(new Date().toISOString()).run();await seed(e,'cap');await put(e,'ds:tts:user_daily','0');
 assert.equal((await pull(e)).items.length,0);assert.equal((await row(e,'cap')).status,'pending');
 assert.equal((await req(e,'/api/runner/voice/report',{id:'cap',status:'pending'},'runner-secret')).status,400);
});
test('/voice permissions are based on stored member role, never message claims; query and help are public',async()=>{
 const e=await voiceEnv();await req(e,'/api/admin/bind',{groupId:group});
 await qq(e,msg('cmd1','/voice on'));assert.equal(await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('voice:mode:'+group).first(),null);
 await e.DB.prepare("INSERT INTO members(id,name,role,token_hash,revoked) VALUES(?,?,'owner',?,0)").bind('qq:member1','owner','x').run();
 await qq(e,msg('cmd2','/voice on'));
 assert.equal((await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('voice:mode:'+group).first())?.value,'always');
 for(const mode of ['off','auto']){await qq(e,msg('mode-'+mode,'/voice '+mode));assert.equal((await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('voice:mode:'+group).first()).value,mode);}
 for(const [id,text] of [['cmd3','/voice'],['cmd4','/help']])await qq(e,msg(id,text));
 const help=await e.DB.prepare('SELECT body FROM outbox WHERE id=?').bind('cmd-cmd4-0').first();assert.match(help.body,/\/voice/);
});
test('ordinary enqueue uses no extra settings query; switch loading includes group overrides in its one read',async()=>{
 const e=await voiceEnv();let before=e.DB.executed;
 await enqueueVoice(e,'plain-no-source',group,null,'{"mode":"work","text":"普通文字"}');
 assert.equal(e.DB.executed-before,1);
 await put(e,'voice:mode:'+group,'off');
 const {loadSwitches}=await import('../.wrangler/ds2b/rhythm.js');
 before=e.DB.executed;await loadSwitches(e);assert.equal(e.DB.executed-before,1);
 assert.equal(e.voiceSwitches['voice:mode:'+group],'off');
});
test('voice reports account billed characters once and audit delivery without retaining reply text',async()=>{
 const e=await voiceEnv();
 await seed(e);await pull(e);
 const payload={id:'v1',status:'sent',via:'voice',provider:'deepseek',latency_ms:120};
 await Promise.all([req(e,'/api/runner/voice/report',payload,'runner-secret'),req(e,'/api/runner/voice/report',payload,'runner-secret')]);
 const usage=(await e.DB.prepare('SELECT * FROM ds_usage').all()).results;
 assert.equal(usage.length,1);assert.equal(usage[0].units,15);assert.equal(usage[0].est_cost_micro_usd,338);
 assert.equal((await e.DB.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE name='tts_reply'").first()).n,1);
});
test('stale claimed voice is unknown and never returned; concurrent pulls claim once',async()=>{
 const e=await voiceEnv();await seed(e);const pulls=await Promise.all([pull(e),pull(e)]);
 assert.equal(pulls.reduce((n,p)=>n+p.items.length,0),1);
 await e.DB.prepare('UPDATE outbox_attempts SET started_at=?').bind(Date.now()-241000).run();
 assert.equal((await pull(e)).items.length,0);assert.equal((await row(e,'v1')).status,'unknown');
});
