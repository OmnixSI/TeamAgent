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

const unfence=part=>part.replace(/^(```|~~~)[^\n]*\n/,'').replace(/\n?(```|~~~)$/,'');
for(const prefix of ['', '代码如下：\n'])test('rework 2400-character fenced code is retained '+JSON.stringify(prefix),()=>{
 const code=('const 值 = "😀";\n').repeat(150),result=splitForQQ(prefix+'```js\n'+code+'```');
 assert.ok(result.every(s=>s.length<=1800&&s.isWellFormed()));
 const blocks=prefix?result.slice(1):result;
 if(prefix)assert.equal(result[0],prefix);
 assert.ok(blocks.every(s=>/^```js\n[\s\S]*\n```$/.test(s)));
 assert.equal(blocks.map(unfence).join(''),code);
});
test('rework oversized URLs retain all characters and Unicode pairs',()=>{
 const text='https://example.com/'+('a😀'.repeat(800)),result=splitForQQ(text);
 assert.equal(result.join(''),text);assert.ok(result.every(s=>s.length<=1800&&s.isWellFormed()));
});
for(const fence of ['```','~~~'])for(const closed of [false,true])
 test(`rework long unbroken code is hard cut with balanced fences (${fence}, ${closed})`,()=>{
  const code='😀'.repeat(1200),result=splitForQQ(fence+'js\n'+code+(closed?'\n'+fence:''));
  assert.equal(result.map(unfence).join(''),code+(closed?'\n':''));
  assert.ok(result.every(s=>s.startsWith(fence+'js\n')&&s.endsWith('\n'+fence)&&s.length<=1800&&s.isWellFormed()));
 });
test('rework oversized atoms exceeding three parts retain a prefix with a truncation marker',()=>{
 for(const text of ['https://example.com/'+'😀'.repeat(5000),'```js\n'+'😀'.repeat(5000)+'\n```']){
  const result=splitForQQ(text);assert.equal(result.length,3);
  assert.ok(result.join('').includes('😀'));assert.match(result.at(-1),/太长，已截断/);
  assert.ok(result.every(s=>s.length<=1800&&s.isWellFormed()));
  if(text.startsWith('```'))assert.ok(result.every(s=>s.startsWith('```js\n')&&s.endsWith('\n```')));
 }
});
