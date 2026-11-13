import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeFileSync,mkdirSync} from 'node:fs';
import {setupWith} from './support.mjs';
mkdirSync('.agent',{recursive:true});
const outfile=`.wrangler/send-cron-budget-unit-${process.pid}.mjs`;
await build({stdin:{contents:'export {metered} from "./src/d1";export {SWITCH_KEYS} from "./src/rhythm";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const cronCounts={};
const {metered,SWITCH_KEYS}=await import('../'+outfile);
test('M1-R event-v2 registers exactly five supported settings after the legacy keys',()=>{
 assert.deepEqual(SWITCH_KEYS.slice(10,15),['off:passive_borrow','off:unknown_resend','off:forward_expand','qq:active_rejected','qq:muted_until']);
 assert.deepEqual(SWITCH_KEYS.slice(15),['off:release_note']);
});
for(const [name,at] of [['night-and-sticker-retry',Date.UTC(2026,10,12,16,7)],['daily-cleanup',Date.UTC(2026,10,13,0,0)]])test(`M1-S W-14 all switches enabled: ${name} stays within 48 statements`,async()=>{
 const NativeDate=Date,oldFetch=globalThis.fetch;
 class Clock extends NativeDate{constructor(...args){if(args.length)super(...args);else super(at);}static now(){return at;}}
 const base=await setupWith({stickers:{send:true},scout:{enabled:true,hours:[3,11]},memory:{start_hour:3,end_hour:6,quiet_minutes:1}});
 base.QQ_APP_ID='cron-v2-'+name;
 for(const key of SWITCH_KEYS)if(key.startsWith('off:'))await base.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(key,'0').run();
 await base.DB.prepare("INSERT OR REPLACE INTO settings VALUES('group_id','GROUP000001')").run();
 await base.DB.prepare("INSERT OR REPLACE INTO settings VALUES('last_message',?)").bind(new NativeDate(at-3600000).toISOString()).run();
 await base.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').bind('cron-source','GROUP000001','member','合成问题',new NativeDate(at).toISOString(),1,0).run();
 await base.DB.prepare('INSERT INTO passive_claims VALUES(?,?,?,0)').bind('cron-source','GROUP000001',at).run();
 await base.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('cron-pending','GROUP000001','cron-source','合成回复','pending',at).run();
 globalThis.Date=Clock;globalThis.fetch=async url=>{assert.ok(String(url).includes('api.bot.qq.com'));return Response.json(String(url).includes('getAppAccessToken')?{access_token:'synthetic',expires_in:300}:{id:'sent'});};
 try{const e=metered(base),before=base.DB.executed;let task;await base.testWorker.scheduled({},e,{waitUntil(p){task=p;}});await task;assert.equal(e.meter.used,base.DB.executed-before);assert.ok(e.meter.used<=48,name+' '+e.meter.used);assert.ok(e.meter.used>20);cronCounts[name]=e.meter.used;writeFileSync('.agent/m1-s-cron-counts.json',JSON.stringify(cronCounts,null,2));}finally{globalThis.Date=NativeDate;globalThis.fetch=oldFetch;}
});
