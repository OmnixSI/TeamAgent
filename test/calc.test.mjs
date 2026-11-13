import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const out = await build({entryPoints:['src/tools/calc.ts'],bundle:true,format:'esm',platform:'neutral',write:false});
const {calcTool} = await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const run = expression => calcTool.run({}, {expression}, {context:{},messages:[],isTainted:()=>false});

test('calc respects precedence, decimals, unary signs and remainder', async()=>{
  for(const [input,want] of [['(128*3+56)/4',110],['2+3*4',14],['-(2 + .5)*+4',-10],['10%3',1],['1.25 / 0.5',2.5],['1--2',3]]){
    const result=await run(input); assert.equal(result.ok,true,input); assert.equal(result.value,want,input);
  }
});
test('calc rejects code, identifiers, malformed arithmetic and non-finite results without execution',async()=>{
  globalThis.__calcInjection=0;
  for(const input of ['globalThis.__calcInjection=1','1;globalThis.__calcInjection=1','Math.random()','2**3','1e10','1 2','()','1+','(1+2','1/0','1%0', '9'.repeat(310)]){
    const result=await run(input); assert.equal(result.ok,false,input); assert.equal(typeof result.reason_text,'string'); assert.ok(result.reason_text.length>0);
  }
  assert.equal(globalThis.__calcInjection,0); delete globalThis.__calcInjection;
});
test('calc bounds bytes and nesting including long unary chains',async()=>{
  for(const input of ['1'.repeat(1025),'('.repeat(80)+'1'+')'.repeat(80),'-'.repeat(100)+'1',null,{},'']) assert.equal((await run(input)).ok,false);
  assert.equal((await run('('.repeat(20)+'1'+')'.repeat(20))).value,1);
});
