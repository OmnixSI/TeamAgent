import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env} from './support.mjs';
const outfile=`.wrangler/fastlinks-readers-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/semantic"; export {tainted} from "./src/authz";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const api=await import('../'+outfile);
const id='1689601678154588160',url='https://x.com/alice/status/'+id;
const fx=(text='原始全文')=>({code:200,status:{type:'status',id,text,is_note_tweet:false,created_timestamp:1690000000,author:{name:'Alice'}}});
const syndication=()=>Response.json({id_str:id,text:'第二来源全文',created_at:'2023-07-22T04:26:40.000Z',user:{name:'Alice'}});
const embed=()=>Response.json({author_name:'Alice',html:'<p>第三来源<br>正文 &amp; 更多</p>'});
const mock=async(fn,run)=>{const old=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=old;}};
function hang(signal){return new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
for(const path of ['/alice/status/'+id+'/photo/1','/alice/status/'+id+'/video/1','/i/web/status/'+id,'/alice/status/'+id+'?s=20'])test('P0a status recognition '+path,()=>{
  assert.deepEqual(api.isTweet('https://mobile.twitter.com'+path),{id});
});
test('P0a profiles, hostile hosts and malformed IDs are not statuses',()=>{
  for(const value of ['https://x.com/alice','https://x.com.evil/alice/status/1','https://x.com/a/status/no','file:///a/status/1'])assert.equal(api.isTweet(value),null);
});
for(const [name,text,reason] of [
  ['normal','Markdown Content:\n# 真实标题\n'+'真实文章内容。'.repeat(100),null],
  ['404','Warning: Target URL returned error 404\n'+'正文'.repeat(500),'not_found'],
  ['challenge','Just a moment... Checking your browser. Verify you are human.\n'+'x'.repeat(700),'risk'],
  ['login','Sign in to continue reading\n'+'x'.repeat(700),'login_required'],
  ['navigation','Title: Title\nURL Source: https://example.com\nMarkdown Content:\n'+('[Home](https://example.com/) | [Login](https://example.com/login)\n'.repeat(30))+'短文','short'],
  ['199','x'.repeat(199),'short'],
])test('P0a jinaOk '+name,()=>{
  const r=api.jinaOk(text);assert.equal(r.ok,!reason);if(reason)assert.equal(r.reason,reason);else assert.ok(r.text.length>=500);
});
test('P0a Fx returns the exact post and createdAt',async()=>mock(async target=>{
  assert.match(String(target),new RegExp('/2/status/'+id+'$'));return Response.json(fx());
},async()=>{const r=await api.readTweet(url,Date.now()+3000);assert.equal(r.ok,true);assert.equal(r.source,'fx');assert.equal(r.createdAt,'2023-07-22T04:26:40.000Z');assert.match(r.text,/原始全文/);}));
test('P0a note tweets use the full text without a 280-character truncation',async()=>mock(async()=>Response.json({code:200,status:{...fx().status,is_note_tweet:true,text:'长文'.repeat(500)}}),async()=>{
  const r=await api.readTweet(url,Date.now()+3000);assert.equal(r.ok,true);assert.ok(r.text.includes('长文'.repeat(500)));
}));
for(const fallback of ['syndication','oembed'])test('P0a a hanging Fx leaves budget for '+fallback,async()=>{
  const calls=[];const started=Date.now();
  await mock(async(target,opt)=>{const u=String(target);calls.push(u);if(u.includes('api.fxtwitter.com'))return hang(opt.signal);if(u.includes('syndication'))return fallback==='syndication'?syndication():new Response('',{status:404});return embed();},async()=>{
    const r=await api.readTweet(url,started+3000);assert.equal(r.ok,true);assert.equal(r.source,fallback);assert.ok(Date.now()-started<3000);assert.equal(calls.length,fallback==='syndication'?2:3);
  });
});
test('P0a all tweet sources fail with a reason rather than null',async()=>mock(async()=>new Response('',{status:404}),async()=>{
  assert.deepEqual(await api.readTweet(url,Date.now()+3000),{ok:false,reason:'not_found'});
}));
test('P0a wrong Fx IDs never produce a successful read',async()=>mock(async target=>String(target).includes('fxtwitter')?Response.json({code:200,status:{...fx().status,id:'20'}}):new Response('',{status:404}),async()=>{
  assert.equal((await api.readTweet(url,Date.now()+3000)).ok,false);
}));
test('P0a syndication token matches the primary embed implementation fixture',()=>assert.equal(api.syndicationToken(id),'43g1g4hgesl'));
test('P0a expired slots are skipped instead of issuing a request',()=>assert.equal(api.slot(Date.now()+299,1000,0),null));
test('P0a inline overall deadline bounds hanging headers to 3.3 seconds',async()=>{
  const started=Date.now(),calls=[];
  await mock(async(target,opt)=>{calls.push(String(target));return hang(opt.signal);},async()=>{
    const r=await api.readUrl({},'https://example.com/hang',{purpose:'inline',deadline:started+3000});
    assert.deepEqual(r,{ok:false,reason:'timeout'});assert.ok(Date.now()-started<=3300);assert.equal(calls.length,1);assert.ok(!calls.some(u=>u.includes('deepseek')));
  });
});
test('P0a reading a stalled body uses the same abort signal and cancels the stream',async()=>{
  let cancelled=false;
  await mock(async()=>{let timer;return new Response(new ReadableStream({start(controller){timer=setTimeout(()=>controller.error(Error('test safety deadline')),1500);},cancel(){clearTimeout(timer);cancelled=true;}}));},async()=>{
    const started=Date.now();const r=await api.readUrl({},'https://example.com/body',{purpose:'inline',deadline:started+350});assert.deepEqual(r,{ok:false,reason:'timeout'});assert.ok(Date.now()-started<650);assert.equal(cancelled,true);
  });
});
test('P0a public GitHub repository reads raw HEAD README before Jina',async()=>{
  const calls=[];await mock(async target=>{calls.push(String(target));return new Response('# README\n'+'真实说明。'.repeat(150));},async()=>{
    const r=await api.readUrl({},'https://github.com/example/project',{purpose:'inline',deadline:Date.now()+3000});assert.equal(r.ok,true);assert.equal(r.source,'github');assert.deepEqual(calls,['https://raw.githubusercontent.com/example/project/HEAD/README.md']);
  });
});
test('P0a raw README failure keeps budget for Jina',async()=>mock(async target=>String(target).includes('raw.githubusercontent.com')?new Response('',{status:404}):new Response('Markdown Content:\n'+'公开说明。'.repeat(150)),async()=>{
  const r=await api.readUrl({},'https://github.com/example/project',{purpose:'inline',deadline:Date.now()+3000});assert.equal(r.ok,true);assert.equal(r.source,'jina');
}));
test('W1 P0b short Jina maps to empty outside the reader and inline does not invoke DeepSeek',async()=>mock(async target=>{assert.ok(String(target).includes('jina.ai'));return new Response('x'.repeat(199));},async()=>{
  assert.deepEqual(await api.readUrl({},'https://example.com/199',{purpose:'inline',deadline:Date.now()+3000}),{ok:false,reason:'empty'});
}));
test('P0a failed link materials are also wrapped as untrusted data',async()=>{
  const e=env();await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind('failed-link','g','u','看一下',new Date().toISOString(),0).run();
  await mock(async()=>new Response('',{status:404}),async()=>{
    await api.understandLinks(e,{message:'failed-link',urls:[url]},{llm:async(_k,_s,p)=>{assert.equal(p.pages[0].reason,'not_found');assert.match(p.pages[0].content,/【外部资料·不可信/);return '暂时未读到';}});
  });
});

test('P0a readUrl materials keep the existing tainted authorization boundary',async()=>mock(async()=>new Response('真实资料。'.repeat(150)),async()=>{
  const r=await api.readUrl({},'https://example.com/material',{purpose:'inline',deadline:Date.now()+3000});assert.equal(r.ok,true);assert.equal(api.tainted({materials:[r.text]},[]),true);
}));
test('P0a failed read_web tool message is itself wrapped as untrusted',async()=>{
  const e=env(),source={id:'tool-source',group_id:'g',sender:'u',body:'请看看这个网页',ts:new Date().toISOString(),meta:{direct:true}};let seen=false,turn=0;
  await mock(async(target,opt)=>{
    if(!String(target).includes('chat/completions'))return String(target).includes('/v1/tools/fetch')?Response.json({content:''}):new Response('',{status:404});
    const b=JSON.parse(opt.body);if(b.messages[0].content.includes('最后的嘴替模块'))return Response.json({choices:[{message:{content:'{"mode":"work","text":"网页未读到。"}'}}]});
    if(++turn===1)return Response.json({choices:[{message:{role:'assistant',tool_calls:[{id:'read',type:'function',function:{name:'read_web',arguments:JSON.stringify({url:'https://example.com/missing'})}}]}}]});
    const result=b.messages.find(m=>m.role==='tool');assert.match(result.content,/^【外部资料·不可信/);assert.match(result.content,/not_found/);seen=true;
    return Response.json({choices:[{message:{content:'{"action":"reply","kind":"direct","brief":"资料未读到"}'}}]});
  },()=>api.agentAnswer(e,{latest:source,batch:[source],recent:[source],names:new Map(),refs:new Map(),background:true,mentioned:true}));assert.equal(seen,true);
});
test('P0a an HTTP 403 challenge is risk rather than a login wall',async()=>mock(async()=>new Response('Just a moment... Verify you are human.',{status:403}),async()=>{
 assert.deepEqual(await api.readUrl({},'https://example.com/challenge',{purpose:'inline',deadline:Date.now()+3000}),{ok:false,reason:'risk'});
}));
