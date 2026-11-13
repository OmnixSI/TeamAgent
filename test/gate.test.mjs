import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';

const {build} = await import('esbuild');
const out = `.wrangler/gate-${process.pid}.mjs`;
process.on('exit',()=>rmSync(out,{force:true}));
await build({entryPoints:['src/gate.ts'],bundle:true,format:'esm',platform:'browser',outfile:out});
const gate = await import('../'+out);

const at = (iso) => Date.parse(iso);
const quiet = {start:'23:00',end:'08:00',utcOffsetMinutes:480};
const base = {
  mode:'proactive', mentioned:false, lastBotTs:null,
  now: at('2026-11-14T10:00:00+08:00'),
  recentBotCount:0, recentHumanCount:3,
  quietHours: quiet,
  config:{cooldownSeconds:120,maxPerHour:4,minHumanMessages:2,humanWindowMinutes:10},
};

test('G1 mentions, commands and direct replies bypass every proactive limit',()=>{
  const blocked = {...base,lastBotTs:base.now-1,recentBotCount:99,recentHumanCount:0,quietHours:{start:'00:00',end:'23:59',utcOffsetMinutes:480}};
  const cases = [
    [{...blocked,mentioned:true}, 'mentioned'],
    [{...blocked,mode:'command'}, 'command'],
    [{...blocked,mode:'direct'}, 'direct'],
    [{...blocked,mentioned:true,mode:'command'}, 'command'],
  ];
  for(const [input,word] of cases){
    const r = gate.shouldSpeak(input);
    assert.equal(r.speak,true,JSON.stringify(input));
    assert.match(r.reason,new RegExp(word));
  }
});

test('G2 proactive speech waits for the group cooldown',()=>{
  assert.equal(gate.shouldSpeak({...base,lastBotTs:base.now-119000}).speak,false);
  assert.match(gate.shouldSpeak({...base,lastBotTs:base.now-119000}).reason,/cooldown/);
  assert.equal(gate.shouldSpeak({...base,lastBotTs:base.now-120000}).speak,true);
  assert.equal(gate.shouldSpeak({...base,lastBotTs:null}).speak,true);
});

test('G3 proactive speech respects the rolling-hour cap',()=>{
  const capped = gate.shouldSpeak({...base,recentBotCount:4});
  assert.equal(capped.speak,false);
  assert.match(capped.reason,/hourly_cap/);
  assert.equal(gate.shouldSpeak({...base,recentBotCount:3}).speak,true);
});

test('G4 proactive speech needs enough recent human activity',()=>{
  const quietGroup = gate.shouldSpeak({...base,recentHumanCount:1});
  assert.equal(quietGroup.speak,false);
  assert.match(quietGroup.reason,/human/);
  assert.equal(gate.shouldSpeak({...base,recentHumanCount:2}).speak,true);
  assert.equal(gate.shouldSpeak({...base,recentHumanCount:0,config:{...base.config,minHumanMessages:0}}).speak,true);
});

test('G5 quiet hours suppress proactive speech but never a mention',()=>{
  const night = at('2026-11-14T23:30:00+08:00');
  const late = gate.shouldSpeak({...base,now:night});
  assert.equal(late.speak,false);
  assert.match(late.reason,/quiet_hours/);
  assert.equal(gate.shouldSpeak({...base,now:at('2026-11-14T07:59:00+08:00')}).speak,false);
  assert.equal(gate.shouldSpeak({...base,now:at('2026-11-14T08:00:00+08:00')}).speak,true);
  assert.equal(gate.shouldSpeak({...base,now:at('2026-11-14T22:59:00+08:00')}).speak,true);
  assert.equal(gate.shouldSpeak({...base,now:night,mentioned:true}).speak,true);
  // 00:30 +08:00 is 16:30 UTC; the group offset decides which one is "night".
  const midnight = at('2026-11-14T00:30:00+08:00');
  assert.equal(gate.shouldSpeak({...base,now:midnight,quietHours:{...quiet,utcOffsetMinutes:0}}).speak,true);
  assert.equal(gate.shouldSpeak({...base,now:midnight}).speak,false);
  // start === end disables the window instead of muting the whole day.
  assert.equal(gate.shouldSpeak({...base,now:night,quietHours:{start:'23:00',end:'23:00',utcOffsetMinutes:480}}).speak,true);
});

test('G6 defaults are applied and bad input cannot crash the gate',()=>{
  const noConfig = {...base,config:undefined,lastBotTs:base.now-121000,recentBotCount:3,recentHumanCount:2};
  assert.equal(gate.shouldSpeak(noConfig).speak,true);
  assert.equal(gate.shouldSpeak({...noConfig,mode:'mystery'}).speak,true);
  assert.equal(gate.shouldSpeak({...base,mode:'mystery',recentBotCount:99}).speak,false);
  assert.equal(gate.shouldSpeak({...base,now:Number.NaN}).speak,false);
  assert.match(gate.shouldSpeak({...base,now:Number.NaN}).reason,/now/);
  assert.equal(gate.shouldSpeak({...base,now:Number.NaN,mentioned:true}).speak,true);
  assert.equal(gate.shouldSpeak({...base,quietHours:{start:'25:00',end:'08:00'}}).speak,true);
  assert.equal(gate.shouldSpeak({...base,recentHumanCount:-5}).speak,false);
  assert.equal(gate.shouldSpeak({...base,recentBotCount:-5}).speak,true);
});

test('G7 the gate is a pure function with no cross-group state',()=>{
  const input = {...base,lastBotTs:base.now-30000};
  Object.freeze(input); Object.freeze(input.config); Object.freeze(input.quietHours);
  const first = gate.shouldSpeak(input), second = gate.shouldSpeak(input);
  assert.deepEqual(first,second);
  assert.equal(first.speak,false);
  // A blocked group does not leak state into the next call (the caller owns group scoping).
  assert.equal(gate.shouldSpeak({...base,lastBotTs:null,recentBotCount:0}).speak,true);
});

test('G8 every decision carries a non-empty trace reason',()=>{
  const inputs = [
    base,
    {...base,mentioned:true},
    {...base,mode:'command'},
    {...base,lastBotTs:base.now-1000},
    {...base,recentBotCount:9},
    {...base,recentHumanCount:0},
    {...base,now:at('2026-11-14T23:30:00+08:00')},
    {...base,now:Number.NaN},
  ];
  for(const input of inputs){
    const r = gate.shouldSpeak(input);
    assert.equal(typeof r.reason,'string');
    assert.ok(r.reason.trim().length > 0,JSON.stringify(input));
  }
});

test('G9 group A limits never leak into group B (caller supplies group-scoped counts)',()=>{
  const groupA = {...base,lastBotTs:base.now-1000,recentBotCount:4,recentHumanCount:0};
  const groupB = {...base,lastBotTs:null,recentBotCount:0,recentHumanCount:5};
  assert.equal(gate.shouldSpeak(groupA).speak,false);
  assert.equal(gate.shouldSpeak(groupB).speak,true);
});
