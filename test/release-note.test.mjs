import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {env} from './support.mjs';
// One bundle for both modules so a version change is visible to the reply pipeline, as in a deploy.
await build({stdin:{contents:"export {enqueueVoice} from './src/voice';export {replyReleaseNote,RELEASE_NOTE} from './src/release-note';",resolveDir:'.',loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile:`.wrangler/release-note-${process.pid}.mjs`});
const {enqueueVoice,replyReleaseNote,RELEASE_NOTE}=await import(`../.wrangler/release-note-${process.pid}.mjs`);
const fresh=async()=>{const e=env();await e.DB.prepare("DELETE FROM settings WHERE key='release_seen:GROUP000001'").run();return e;};
const say=(e,id,group='GROUP000001',text='回答。')=>enqueueVoice(e,id,group,'m',JSON.stringify({mode:'work',text}));
const body=async(e,id)=>(await e.DB.prepare('SELECT body FROM outbox WHERE id=?').bind(id).first())?.body;
const seen=async(e,group='GROUP000001')=>(await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('release_seen:'+group).first())?.value;
test('first passive reply appends the note and records the version',async()=>{
 const e=await fresh();await say(e,'rn-1');const row=await body(e,'rn-1');
 assert.match(row,/\n（这次新加了：/);assert.ok(row.endsWith('）'));assert.equal(await seen(e),'V-A');
});
test('the same group is not told twice for one version',async()=>{
 const e=await fresh();await say(e,'rn-2a');await say(e,'rn-2b');
 assert.match(await body(e,'rn-2a'),/这次新加了/);assert.doesNotMatch(await body(e,'rn-2b'),/这次新加了/);assert.equal(await seen(e),'V-A');
});
test('a new version is announced again in the same group',async()=>{
 const e=await fresh();await say(e,'rn-3a');assert.equal(await seen(e),'V-A');
 RELEASE_NOTE.version='V-B';
 try{await say(e,'rn-3b');assert.match(await body(e,'rn-3b'),/这次新加了/);assert.equal(await seen(e),'V-B');}
 finally{RELEASE_NOTE.version='V-A';}
});
test('proactive messages never carry the note',async()=>{
 const e=await fresh();await enqueueVoice(e,'rn-4','GROUP000001',null,JSON.stringify({mode:'work',text:'回答。'}));
 assert.ok(await body(e,'rn-4'));assert.doesNotMatch(await body(e,'rn-4'),/这次新加了/);assert.equal(await seen(e),undefined);
});
test('the off:release_note switch suppresses it without recording a version',async()=>{
 const e=await fresh();await e.DB.prepare("INSERT INTO settings VALUES('off:release_note','1')").run();
 await say(e,'rn-5');assert.doesNotMatch(await body(e,'rn-5'),/这次新加了/);assert.equal(await seen(e),undefined);
});
test('concurrent replies reserve exactly one note',async()=>{
 const e=await fresh();const out=await Promise.all([replyReleaseNote(e,'GROUP000001'),replyReleaseNote(e,'GROUP000001')]);
 assert.equal(out.filter(Boolean).length,1);assert.equal(await seen(e),'V-A');
});
test('announced text matches docs/releases/V-A.md and stays within 60 characters',()=>{
 const line=readFileSync('docs/releases/V-A.md','utf8').split('\n')[0];
 assert.equal(RELEASE_NOTE.version,'V-A');assert.equal(line,RELEASE_NOTE.text);
 const n=Array.from(RELEASE_NOTE.text).length;assert.ok(n<=60,`版本说明 ${n} 字，超过 60`);
});
test('auth reminder and release note both survive the 1800 character cap',async()=>{
 const e=await fresh();await e.DB.prepare("INSERT INTO settings VALUES('auth:bili',?)").bind(JSON.stringify({state:'expired',checked_at:new Date().toISOString(),had_ok:true})).run();
 await say(e,'rn-8','GROUP000001','啊'.repeat(1770));const row=await body(e,'rn-8');
 assert.match(row,/B 站.*登录过期/);assert.match(row,/这次新加了：/);assert.ok(row.length<=1800,`回复 ${row.length} 字，超过 1800`);
});
