import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,copyFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {
 XHS_COMMANDS,classifyXhsPage,noteToItems,searchRowsToItems,commentsToItems,
 parseXhsNoteTarget,buildSearchUrl,readXhsPage,validators
} from '../runner/reach-xiaohongshu.mjs';
import {normalizeReachResult} from '../runner/reach-result.mjs';
import {validTarget} from '../src/reach-contract.mjs';

const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/f9-3/'+name,import.meta.url),'utf8'));
const target='https://www.xiaohongshu.com/explore/6371c72a000000001501476b?xsec_token=SIGNED_VALUE&xsec_source=pc_search';
const bare='https://www.xiaohongshu.com/explore/6371c72a000000001501476b';
const request=(action='read',t=target)=>({version:1,channel:'xiaohongshu',action,backend:'local',target:t});

test('note targets require a full signed URL; bare, short and foreign links are rejected',()=>{
 const ok=parseXhsNoteTarget(target);
 assert.equal(ok.ok,true);assert.equal(ok.noteId,'6371c72a000000001501476b');assert.equal(ok.url,target);
 for(const bad of [
  bare,
  'https://xhslink.com/a/abc',
  'http://www.xiaohongshu.com/explore/6371c72a000000001501476b?xsec_token=x',
  'https://www.xiaohongshu.com.evil.test/explore/6371c72a000000001501476b?xsec_token=x',
  'https://evil.test/explore/6371c72a000000001501476b?xsec_token=x',
  'https://www.xiaohongshu.com/explore/not-a-note',
  target.replace('xsec_token','xsec_source'),
 ])assert.equal(parseXhsNoteTarget(bad).ok,false,bad);
});

test('the shared target whitelist accepts only signed xiaohongshu note and comment URLs',()=>{
 assert.equal(validTarget('xiaohongshu','read',target),true);
 assert.equal(validTarget('xiaohongshu','comments',target),true);
 assert.equal(validTarget('xiaohongshu','read',bare),false);
 assert.equal(validTarget('xiaohongshu','comments',bare),false);
 assert.equal(validTarget('xiaohongshu','search','咖啡'),true);
});

test('real 300031 shell never becomes readable material',()=>{
 const page=fixture('note-300031.json');
 assert.equal(classifyXhsPage(page)?.code,'300031');
 const raw=noteToItems(page,target);
 assert.equal(raw.ok,false);
 const env=normalizeReachResult(request(),raw);
 assert.equal(env.ok,false);assert.equal(env.error.error_kind,'insufficient_content');
 assert.equal(env.error.vendor_code,'300031');assert.ok(env.error.next_action);assert.equal(env.items.length,0);
 assert.doesNotMatch(JSON.stringify(env),/SIGNED_VALUE|xsec_token/i);
});

test('login_required tells the member exactly where to sign in, without leaking other channels',()=>{
 const env=normalizeReachResult(request(),{ok:false,error:{code:'NEED_LOGIN'}});
 assert.equal(env.error.error_kind,'login_required');
 assert.match(env.error.next_action,/Edge.*xiaohongshu\.com/);
 const x=normalizeReachResult({...request(),channel:'x'},{ok:false,error:{code:'NEED_LOGIN'}});
 assert.doesNotMatch(x.error.next_action,/Edge.*xiaohongshu/);
});

test('real 300012 network-risk page is a platform block, not content',()=>{
 const page=fixture('search-300012.json');
 const blocked=classifyXhsPage(page);
 assert.equal(blocked?.code,'SECURITY_BLOCK');
 const env=normalizeReachResult(request('search','咖啡'),{ok:false,error:blocked});
 assert.equal(env.ok,false);assert.equal(env.error.error_kind,'platform_blocked');assert.equal(env.items.length,0);
});

test('a normal note yields title, author, body and engagement without leaking the signed token',()=>{
 const page=fixture('note-normal.json');
 const raw=noteToItems(page,target);
 assert.equal(raw.ok,true);
 const env=normalizeReachResult(request(),raw);
 assert.equal(env.ok,true);
 assert.equal(env.items[0].title,'日常咖啡一杯☕️');
 assert.equal(env.items[0].author,'王怡人');
 assert.match(env.items[0].text,/莓果香气/);
 assert.match(env.items[0].text,/点赞 1\.2万/);
 assert.equal(env.content_scope,'post_text');
 assert.equal(env.source_url,bare);
 assert.doesNotMatch(JSON.stringify(env),/SIGNED_VALUE|xsec_token/i);
});

test('an expired token returns insufficient_content with the vendor code, not login_required',()=>{
 const signed=target.replace('SIGNED_VALUE','EXPIRED_SIGNATURE');
 const env=normalizeReachResult(request('read',signed),noteToItems(fixture('note-300031.json'),signed));
 assert.equal(env.ok,false);assert.equal(env.error.error_kind,'insufficient_content');
 assert.equal(env.error.vendor_code,'300031');
 assert.doesNotMatch(JSON.stringify(env),/EXPIRED_SIGNATURE|xsec_token/i);
});

test('search results are capped at ten, labelled search_results and strip every signature',()=>{
 const raw=searchRowsToItems(fixture('search-normal.json').rows);
 assert.equal(raw.ok,true);
 const env=normalizeReachResult(request('search','咖啡'),raw);
 assert.equal(env.ok,true);assert.equal(env.items.length,10);
 assert.equal(env.content_scope,'search_results');
 assert.equal(env.items[0].text,'');assert.ok(env.items[0].title);assert.ok(env.items[0].author);
 assert.ok(env.items.every(i=>i.source_url.startsWith('https://www.xiaohongshu.com/')));
 assert.doesNotMatch(JSON.stringify(env),/SEARCH_SIGNATURE|xsec_token/i);
});

test('loaded comments are capped at twenty, labelled loaded_comments and keep author plus text',()=>{
 const raw=commentsToItems(fixture('comments-normal.json'),target);
 const env=normalizeReachResult(request('comments'),raw);
 assert.equal(env.ok,true);assert.equal(env.items.length,20);
 assert.equal(env.content_scope,'loaded_comments');
 assert.ok(env.items.every(i=>i.text&&i.author));
 assert.doesNotMatch(JSON.stringify(env),/SIGNED_VALUE|xsec_token/i);
});

test('login wall and deleted-note pages stay distinct from risk shells',()=>{
 assert.equal(classifyXhsPage({pageUrl:target,loginWall:true})?.code,'NEED_LOGIN');
 assert.equal(classifyXhsPage({pageUrl:target,notFound:true})?.code,'NOT_FOUND');
 assert.equal(classifyXhsPage({pageUrl:target,securityBlock:true})?.code,'SECURITY_BLOCK');
 assert.equal(classifyXhsPage({pageUrl:target}),null);
});

test('fixed descriptors declare read-only browser commands with the contract scopes',()=>{
 assert.deepEqual(Object.keys(XHS_COMMANDS).sort(),['xiaohongshu:comments:local','xiaohongshu:read:local','xiaohongshu:search:local']);
 for(const [key,scope] of [['xiaohongshu:read:local','post_text'],['xiaohongshu:search:local','search_results'],['xiaohongshu:comments:local','loaded_comments']]){
  const entry=XHS_COMMANDS[key];
  assert.equal(entry.access,'read');assert.equal(entry.resource,'browser');assert.equal(entry.requires_login,true);
  assert.equal(entry.content_scope,scope);
  const argv=entry.argv(key.includes(':search:')?'咖啡':target);
  assert.equal(argv[0],process.execPath);
  assert.ok(argv.slice(0,2).every(x=>typeof x==='string'&&x.length>0));
  assert.ok(argv[1].endsWith('/runner/reach-xiaohongshu.mjs'));
  assert.ok(argv.includes(key.includes(':search:')?'咖啡':target));
  assert.ok(!argv.some(x=>/[;|`$<>]/.test(x)));
 }
});

test('the xiaohongshu validator rejects 300031 shells and authorless bodies',()=>{
 const validate=validators.get('xiaohongshu');
 assert.equal(typeof validate,'function');
 assert.equal(validate({ok:true,items:[{text:'当前笔记暂时无法浏览',author:'作者'}]},request()),'insufficient_content');
 assert.equal(validate({ok:true,items:[{text:'正文',author:''}]},request()),'insufficient_content');
 assert.equal(validate({ok:true,items:[{title:'搜索结果'}]},request('search','咖啡')),null);
 assert.equal(validate({ok:true,items:[{text:'正文',author:'作者'}]},request()),null);
});

test('search URL is fixed and the query is encoded exactly once',()=>{
 assert.equal(buildSearchUrl('咖啡 手冲'),'https://www.xiaohongshu.com/search_result?keyword=%E5%92%96%E5%95%A1%20%E6%89%8B%E5%86%B2&source=web_search_result_notes');
 assert.throws(()=>buildSearchUrl(''),/query/);
});

test('page wiring returns login_required and 300031 without inventing content',async()=>{
 const loginPage={goto:async()=>({status:()=>200}),waitForTimeout:async()=>{},evaluate:async()=>({pageUrl:target,loginWall:true}),url:()=>target};
 const login=await readXhsPage({page:loginPage,action:'read',target});
 assert.equal(login.ok,false);assert.equal(login.error.code,'NEED_LOGIN');
 const shellPage={goto:async()=>({status:()=>200}),waitForTimeout:async()=>{},evaluate:async()=>fixture('note-300031.json'),url:()=>target};
 const shell=await readXhsPage({page:shellPage,action:'read',target});
 assert.equal(shell.ok,false);assert.equal(shell.error.vendor_code,'300031');
 const failed={goto:async()=>{throw Error('page.goto: Timeout 25000ms exceeded calling '+target);},waitForTimeout:async()=>{},evaluate:async()=>({}),url:()=>target};
 const timeout=await readXhsPage({page:failed,action:'read',target});
 assert.equal(timeout.ok,false);assert.equal(timeout.error.code,'TIMEOUT');
});

test('the flat local install can import every reach module without a sibling src directory',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'f9-3-flat-'));
 try{
  for(const name of readdirSync(new URL('../runner',import.meta.url))){
   if(name.startsWith('reach-')&&name.endsWith('.mjs'))copyFileSync(new URL('../runner/'+name,import.meta.url),join(dir,name));
  }
  const adapter=await import(pathToFileURL(join(dir,'reach-adapter.mjs')).href);
  assert.equal(adapter.REACH_COMMANDS['xiaohongshu:read:local'].access,'read');
  assert.equal(adapter.REACH_COMMANDS['weibo:hot:local'].access,'read');
  const publicReader=await import(pathToFileURL(join(dir,'reach-public.mjs')).href);
  const hot=await publicReader.runPublicRead({channel:'weibo',action:'hot',target:'微博热搜'},{fetchImpl:async()=>new Response(JSON.stringify({ok:1,data:{realtime:[{word:'平铺导入测试',num:1}]}}),{status:200,headers:{'content-type':'application/json'}})});
  assert.equal(hot.ok,true);
  assert.equal(hot.items[0].title,'平铺导入测试');
  const job=await import(pathToFileURL(join(dir,'reach-job.mjs')).href);
  assert.equal(typeof job.runReachJob,'function');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('CLI fails closed without a login and never echoes the signed token',()=>{
 const home=mkdtempSync(join(tmpdir(),'f9-3-cli-'));
 try{
  mkdirSync(join(home,'.inkboard-team/state'),{recursive:true});
  writeFileSync(join(home,'.inkboard-team/state/auth-xiaohongshu.json'),JSON.stringify({state:'missing'}));
  const secret=target.replace('SIGNED_VALUE','SUPER_SECRET_VALUE');
  const child=spawnSync(process.execPath,[new URL('../runner/reach-xiaohongshu.mjs',import.meta.url).pathname,'note',secret],{env:{...process.env,HOME:home},encoding:'utf8',timeout:15000});
  const out=JSON.parse(child.stdout);
  assert.equal(out.ok,false);assert.equal(out.error.code,'NEED_LOGIN');
  assert.doesNotMatch(child.stdout+child.stderr,/SUPER_SECRET_VALUE|xsec_token/i);
 }finally{rmSync(home,{recursive:true,force:true});}
});
