import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {build} from 'esbuild';
import {env,qq,req} from './support.mjs';

const outfile=`.wrangler/event-replay-${process.pid}.mjs`;
await build({stdin:{contents:'export {normalize} from "./src/event/normalize";export {toInbound} from "./src/inbound";export {renderEvidence} from "./src/view";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile);
const legacyOut=`.wrangler/event-replay-legacy-${process.pid}.mjs`;
await build({entryPoints:['test/fixtures/legacy/inbound-68ef1c3.ts'],bundle:true,platform:'browser',format:'esm',outfile:legacyOut});
const legacy=await import('../'+legacyOut);

const dir='test/fixtures/events';
const fixtures=readdirSync(dir).filter(name=>name.endsWith('.json')).flatMap(name=>{
 const value=JSON.parse(readFileSync(dir+'/'+name,'utf8'));
 return Array.isArray(value)?value:[];
});
const snap=value=>JSON.parse(JSON.stringify(value,(_k,x)=>x===undefined?{$undefined:true}:x));
const count=(e,table)=>e.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first().then(r=>r.n);
const expectedGroups={G1:3,G2:8,G3:6,G4:6,G5:5,G6:6,G7:3,G8:6,G9:10,G10:4,G13:5,G14:4,G15:3,G16:4,G17:4,G21:4,G22:2,G23:5};
const byGroup=Object.fromEntries(Object.keys(expectedGroups).map(g=>[g,fixtures.filter(f=>f.group===g).length]));

test('event fixture manifest matches the acceptance table (88 fixtures)',()=>{
 assert.equal(fixtures.length,88);
 assert.deepEqual(byGroup,expectedGroups);
 const ids=fixtures.map(f=>f.id);
 assert.equal(new Set(ids).size,ids.length,'fixture ids are unique');
 for(const item of fixtures.filter(f=>f.skip))assert.ok(item.skip.length>10,item.id+' skip reason');
});

for(const item of fixtures){
 if(item.kind==='todo'){test.todo(`${item.id} ${item.note} — ${item.skip}`);continue;}
 if(item.kind==='evidence'){
  test(`${item.id} ${item.note}`,()=>{
   const rendered=api.renderEvidence('图片',item.evidence);
   assert.equal(rendered,item.evidenceText,item.id+' placeholder');
   if(item.noGuess)assert.doesNotMatch(rendered,/图中是|看起来是|内容为|画的是/,item.id+' no guessing');
  });
  continue;
 }
 if(item.skip){test(`${item.id} ${item.note}`,{skip:item.skip},()=>{});continue;}
 test(`${item.id} ${item.note}`,async()=>{
  const t=item.event.t,d=item.event.d,ne=api.normalize(t,d),actual=api.toInbound(ne,d);
  assert.deepEqual(snap(actual),item.expect.inbound,item.id+' inbound golden');
  if(item.expect.normalized)assert.deepEqual(snap(ne),item.expect.normalized,item.id+' normalized');
  if(item.expect.golden!=='v2'){
   // Independent golden: the frozen 68ef1c3 parser, not the implementation under test.
   assert.deepEqual(snap(actual),snap(legacy.parseInbound(t,d)),item.id+' legacy equivalence');
  }else{
   assert.ok(item.expect.difference,item.id+' v2 difference note');
  }

  const e=env();
  for(const key of Object.keys(item.expect.env||{}))e[key]=item.expect.env[key];
  if(item.expect.bind!==false)await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
  for(const s of item.setup||[])await e.DB.prepare(s.sql).bind(...(s.args||[])).run();
  const before=e.DB.executed;
  const response=await qq(e,d,t);
  const used=e.DB.executed-before;
  assert.equal(response.status,200,item.id+' HTTP');
  assert.equal((await response.json()).op,item.expect.op??12,item.id+' op');
  if(item.expect.maxStatements!==undefined)assert.ok(used<=item.expect.maxStatements,`${item.id} statements ${used}>${item.expect.maxStatements}`);

  const first=item.expect.rows||{};
  for(const [table,n] of Object.entries(first))assert.equal(await count(e,table),n,`${item.id} ${table}`);
  if(item.expect.mentioned!==undefined&&first.messages===1){
   const row=await e.DB.prepare('SELECT mentioned FROM messages WHERE id=?').bind(d.id).first();
   assert.equal(row.mentioned,item.expect.mentioned,item.id+' mentioned');
  }
  for(const [table,n] of Object.entries(item.expect.absent||{}))assert.equal(await count(e,table),n,`${item.id} absent ${table}`);
  for(const [key,value] of Object.entries(item.expect.settings||{})){
   const row=await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
   assert.equal(row?.value,value,`${item.id} setting ${key}`);
  }
  if(item.expect.activity){
   const row=await e.DB.prepare('SELECT COUNT(*) n,MAX(summary) s FROM activity WHERE kind=?').bind(item.expect.activity.kind).first();
   assert.equal(row.n,item.expect.activity.count,item.id+' activity count');
   if(item.expect.activity.summary)assert.equal(row.s,item.expect.activity.summary,item.id+' activity summary');
  }
  for(const [id,name] of Object.entries(item.expect.names||{})){
   const row=await e.DB.prepare('SELECT name FROM member_names WHERE member_id=?').bind(id).first();
   assert.equal(row?.name,name,`${item.id} name ${id}`);
  }
  if(item.expect.meta){
   const row=await e.DB.prepare('SELECT json FROM message_meta WHERE id=?').bind(d.id).first();
   const meta=row?JSON.parse(row.json):{};
   for(const [key,value] of Object.entries(item.expect.meta))assert.ok(isDeepStrictEqual(meta[key],value),`${item.id} meta.${key}`);
  }

  for(let round=1;round<(item.expect.replay||1);round++){
   for(const s of item.between||[])await e.DB.prepare(s.sql).bind(...(s.args||[])).run();
   const next={...d,...(item.expect.seconds?{timestamp:new Date(Date.parse(d.timestamp)+item.expect.seconds*1000).toISOString()}:{})};
   await qq(e,next,item.expect.ret||t);
  }
  if(item.expect.replay){
   for(const [table,n] of Object.entries(first))assert.equal(await count(e,table),n,`${item.id} ${table} after replay`);
  }
 });
}
