import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const outfile=`.wrangler/event-split-${process.pid}.mjs`;
await build({entryPoints:['src/send/split.ts'],bundle:true,platform:'browser',format:'esm',outfile});
const {splitForQQ}=await import('../'+outfile),marker='…（太长，已截断）';
test('P6 empty text produces no segment and short text stays unchanged',()=>{
 assert.deepEqual(splitForQQ(''),[]);assert.deepEqual(splitForQQ('短文本'),['短文本']);
});
test('P6 paragraph boundaries take precedence over later sentence boundaries',()=>{
 const text='a'.repeat(40)+'\n\n'+'b'.repeat(30)+'。'+'c'.repeat(40);
 const result=splitForQQ(text,{max:100,parts:3});assert.equal(result[0],'a'.repeat(40)+'\n\n');assert.equal(result.join(''),text);
});
test('P6 sentence boundaries take precedence over a hard cut',()=>{
 const text='a'.repeat(30)+'。'+'b'.repeat(120),result=splitForQQ(text,{max:100,parts:3});
 assert.equal(result[0],'a'.repeat(30)+'。');assert.equal(result.join(''),text);
});
test('P6 unpunctuated text uses bounded hard cuts without losing characters',()=>{
 const text='x'.repeat(250),result=splitForQQ(text,{max:100,parts:3});
 assert.deepEqual(result.map(s=>s.length),[100,100,50]);assert.equal(result.join(''),text);
});
test('P6 a URL including parentheses stays whole across an otherwise convenient cut',()=>{
 const url='https://example.com/long_(path)/'+'u'.repeat(20),text='a'.repeat(80)+' '+url+' '+'b'.repeat(80);
 const result=splitForQQ(text,{max:100,parts:4});
 assert.equal(result.join(''),text);assert.equal(result.filter(s=>s.includes(url)).length,1);assert.ok(result.every(s=>s.length<=100));
});
test('P6 code fences and their internal paragraphs remain in one segment',()=>{
 const block='```js\nconst value=1;\n\nreturn value;\n```',text='a'.repeat(50)+'\n'+block+'\n'+'b'.repeat(100);
 const result=splitForQQ(text,{max:80,parts:5});
 assert.equal(result.join(''),text);assert.equal(result.filter(s=>s.includes(block)).length,1);
 assert.ok(result.every(s=>(s.match(/```/g)||[]).length%2===0));
});
test('P6 default limit is three 1800-unit segments with the complete truncation marker',()=>{
 const result=splitForQQ('长'.repeat(8000));assert.equal(result.length,3);
 assert.ok(result.every(s=>s.length<=1800));assert.ok(result[2].endsWith(marker));
});
test('P6 an indivisible oversized URL or code block is omitted whole at truncation',()=>{
 for(const atom of ['https://example.com/'+'x'.repeat(200),'```js\n'+'x'.repeat(200)+'\n```','```js\n'+'x'.repeat(200)]){
  const result=splitForQQ('前言 '+atom,{max:50,parts:3});assert.ok(result.at(-1).endsWith(marker));
  assert.ok(result.every(s=>s.length<=50));assert.doesNotMatch(result.join(''),/https:|```/);
 }
});
test('P6 hard cuts and truncation never split a Unicode surrogate pair',()=>{
 const text='😀'.repeat(100),result=splitForQQ(text,{max:51,parts:5});
 assert.equal(result.join(''),text);assert.ok(result.every(s=>s.isWellFormed()&&s.length<=51));
 const capped=splitForQQ(text,{max:51,parts:2});assert.ok(capped.every(s=>s.isWellFormed()&&s.length<=51));assert.ok(capped[1].endsWith(marker));
});
test('P6 truncated last segment still does not split a URL or a fenced block',()=>{
 const atom='https://example.com/'+'u'.repeat(15),text='x'.repeat(90)+' '+atom+' '+'y'.repeat(100);
 const result=splitForQQ(text,{max:60,parts:2});assert.equal(result.length,2);assert.ok(result[1].endsWith(marker));
 assert.equal(result.some(s=>s.includes('https:')&&!s.includes(atom)),false);
});
