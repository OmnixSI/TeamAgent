import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runAsr,parseAsrOutput,SCRIPT,expandHome,childEnv} from './asr.mjs';
import {isAbsolute} from 'node:path';
const good={type:'result',segments:[{start:0,end:2,text:'这是超过十个汉字的完整转写结果。'}],audio_s:2,max_rss_mb:300};
function fake(exit=0,{data=JSON.stringify(good)+'\n',error,hold=false}={}){
 const calls=[],kills=[],priorities=[],intervals=[];
 const spawn=(command,args,options)=>{calls.push({command,args,options});const c=new EventEmitter();c.pid=43210;c.stdout=new EventEmitter();c.stderr=new EventEmitter();queueMicrotask(()=>{if(error)c.emit('error',Object.assign(Error(error),{code:error}));else if(!hold){for(const chunk of Array.isArray(data)?data:[Buffer.from(data)])c.stdout.emit('data',chunk);c.emit('close',exit)}});return c};
 return {calls,kills,priorities,intervals,spawn,kill:(...a)=>kills.push(a),setPriority:(...a)=>priorities.push(a),getPriority:()=>15,setInterval:fn=>{intervals.push(fn);return fn},clearInterval(){},rss:async()=>200};
}
test('R5 ASR child is unbuffered, detached, low priority, and receives only PATH HOME LANG',async()=>{
 const d=fake(),progress=[];const r=await runAsr('/tmp/a.wav',{python:'/python',modelDir:'/models',memCapMb:1300,timeoutMs:500,onProgress:p=>progress.push(p)},d);
 assert.deepEqual(d.calls[0].args,['-u',SCRIPT,'/tmp/a.wav','--model-dir','/models','--max-rss-mb','1300']);
 assert.equal(d.calls[0].options.detached,true);assert.notEqual(d.calls[0].options.shell,true);
 assert.deepEqual(Object.keys(d.calls[0].options.env).sort(),['HOME','LANG','PATH']);assert.deepEqual(d.priorities,[[43210,15]]);assert.equal(r.segments[0].text,good.segments[0].text);
});
test('R5 ASR exit reasons, missing runtime and no speech are distinct',async()=>{
 for(const [code,reason] of [[2,'asr_unavailable'],[5,'asr_unavailable'],[6,'mem_limit'],[3,'asr_failed'],[4,'asr_failed']])await assert.rejects(runAsr('a',{timeoutMs:100},fake(code)),e=>e.reason===reason);
 await assert.rejects(runAsr('a',{timeoutMs:100},fake(0,{error:'ENOENT'})),e=>e.reason==='asr_unavailable');
 await assert.rejects(runAsr('a',{timeoutMs:100},fake(0,{data:JSON.stringify({...good,segments:[{start:0,end:1,text:'短'}]})})),e=>e.reason==='no_speech');
 const d=fake(0,{hold:true});await assert.rejects(runAsr('a',{timeoutMs:5},d),e=>e.reason==='asr_failed');assert.deepEqual(d.kills,[[-43210,'SIGKILL']]);
});
test('R11 progress is consumed but only a final valid result can finish recognition',()=>{
 assert.equal(parseAsrOutput('{"type":"progress","done":1,"total":2}\n'+JSON.stringify(good)+'\n').audio_s,2);
 for(const data of [JSON.stringify(good)+'\n{broken',JSON.stringify({type:'result'}),JSON.stringify({...good,segments:[{start:'0',end:1,text:'x'}]})])assert.throws(()=>parseAsrOutput(data),e=>e.reason==='asr_failed');
});
test('R11 UTF-8 Chinese transcript survives a 64KiB child stdout split inside a character',async()=>{
 const result={...good,segments:[{start:0,end:2,text:'中文转写。'.repeat(6000)}]};
 const bytes=Buffer.from(JSON.stringify({type:'progress',done:1,total:1})+'\n'+JSON.stringify(result)+'\n');
 const split=65536;assert.ok((bytes[split]&0xc0)===0x80,'split must be inside a UTF-8 character');
 const progress=[],actual=await runAsr('a',{timeoutMs:500,onProgress:p=>progress.push(p)},fake(0,{data:[bytes.subarray(0,split),bytes.subarray(split)]}));
 assert.deepEqual(actual.segments,result.segments);assert.doesNotMatch(actual.segments[0].text,/�/);assert.equal(progress.length,1);
});
test('R13 script path survives flat installation and home expansion is explicit',()=>{
 assert.ok(isAbsolute(SCRIPT));assert.ok(SCRIPT.endsWith('/runner/xasr_transcribe.py'));assert.equal(expandHome('~/x','/temporary-home'),'/temporary-home/x');assert.equal(expandHome('/x','/temporary-home'),'/x');
 assert.deepEqual(Object.keys(childEnv({PATH:'p',HOME:'h',LANG:'l',SECRET:'never'})).sort(),['HOME','LANG','PATH']);
});
const speech=(text,audio_s)=>({...good,segments:[{start:0,end:audio_s,text}],audio_s});
test('V3 filler-only pure music is no_speech even when raw characters exceed ten',async()=>{
 const fixture=speech('嗯 嗯 嗯 嗯 嗯 嗯 嗯 嗯 嗯 嗯 嗯 嗯',10),data=JSON.stringify(fixture);
 assert.ok(fixture.segments[0].text.trim().length>=10);
 await assert.rejects(runAsr('a',{timeoutMs:100},fake(0,{data})),e=>e.reason==='no_speech');
});
test('V3 sparse lyrics below eight effective characters per minute are no_speech',async()=>{
 const data=JSON.stringify(speech('月光，洒在河面上。风吹过山岗……',120));
 await assert.rejects(runAsr('a',{timeoutMs:100},fake(0,{data})),e=>e.reason==='no_speech');
});
test('V3 normal speech over ten characters and eight per minute is transcribed',async()=>{
 const data=JSON.stringify(speech('今天我们聊聊这个项目的背景、目标和接下来的计划。',30));
 const r=await runAsr('a',{timeoutMs:100},fake(0,{data}));
 assert.equal(r.segments[0].text,'今天我们聊聊这个项目的背景、目标和接下来的计划。');
});
test('R20 ASR RSS watchdog kills the entire group and reports mem_limit',async()=>{
 const d=fake(0,{hold:true});d.rss=async()=>1400;const promise=runAsr('a',{memCapMb:1300,timeoutMs:500},d);await Promise.resolve();await d.intervals[0]();await assert.rejects(promise,e=>e.reason==='mem_limit');assert.deepEqual(d.kills,[[-43210,'SIGKILL']]);
});
