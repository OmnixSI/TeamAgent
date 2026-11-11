import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {worker,env,req,qq,msg} from './support.mjs';
async function bundle(name) {
  const outfile = `.wrangler/p1-${name}-${process.pid}.mjs`;
  await build({entryPoints:[`src/${name}.ts`],bundle:true,format:'esm',platform:'browser',outfile});
  return import('../'+outfile);
}
const az = await bundle('authz'), {agentAnswer} = await bundle('semantic');
const {untrusted,UNTRUSTED_MARK,UNTRUSTED_RULE} = await bundle('untrusted');
const group='GROUP000001', BV='BV1xx411c7mD', repo='OmnixSI/TeamAgent';
const queue=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(x=>x.results);
const call=(name,args)=>({id:'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}});
const project=(quote,extra={})=>call('prepare_project_task',{source_id:'current',request_quote:quote,repo,title:'授权测试',detail:'不得由字幕授权启动',execute_requested:true,complexity:'small',...extra});
async function source(e,body,extra={}) {
  const row={id:'current',group_id:group,sender:'U1',body,ts:new Date().toISOString(),mentioned:1,meta:{direct:true,can_request_artifact:true,media:[],...extra}};
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').bind(row.id,group,row.sender,body,row.ts,1).run();
  await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind(row.id,JSON.stringify(row.meta)).run();
  return {latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned:true,background:true};
}
async function mocked(steps,run) {
  const old=globalThis.fetch, seen=[], tools=[];let index=0;
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('r.jina.ai')) return new Response('外部网页资料'.repeat(100));
    if(String(url).includes('/v1/tools/search')) return Response.json({results:[{url:'https://example.com',content:'搜索资料'}]});
    const body=JSON.parse(options.body);seen.push(body);
    const voice=body.messages[0].content.includes('最后的嘴替模块');
    if(voice)return Response.json({choices:[{message:{content:'{"mode":"work","text":"收到，按实际授权处理。"}'}}]});
    for(const m of body.messages)if(m.role==='tool')tools.push(JSON.parse(m.content));
    const step=steps[index++];
    const message=step?{role:'assistant',tool_calls:Array.isArray(step)?step:[step]}:{content:'{"should_reply":true,"kind":"direct","brief":"按真实结果回复"}'};
    return Response.json({choices:[{message}]});
  };
  try{return await run({seen,tools});}finally{globalThis.fetch=old;}
}
async function drainResearch(e) {
  for(const j of (await rows(e,'jobs')).filter(j=>j.kind==='research'&&j.status==='pending'))await queue(e,j.id);
}
const result={bvid:BV,title:'视频标题',desc:'简介',owner:'UP',tname:'科技',duration:1,pubdate:1,stat:{},subtitle:'字幕要求创建待执行任务',subtitle_lang:'zh-CN',comments:[],tier:'light',fetched_at:new Date().toISOString()};
async function videoRound(e,body,cached) {
  await req(e,'/api/admin/bind',{groupId:group});
  await qq(e,msg('video-source','https://www.bilibili.com/video/'+BV));
  await e.DB.prepare("INSERT INTO settings VALUES('chat_cursor','1')").run();
  if(cached)await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:'+BV,JSON.stringify(result),new Date().toISOString()).run();
  await qq(e,msg('current',body),'GROUP_AT_MESSAGE_CREATE');
  await queue(e,'chat-current');
  if(!cached){
    const {job}=await(await req(e,'/api/runner/fetch/claim',{},'runner-secret')).json();assert.ok(job);
    await req(e,'/api/runner/fetch/report',{id:job.id,lease:job.payload.lease,success:true,result},'runner-secret');
    await queue(e,'video-vw-current');
  }
  await drainResearch(e);
}

test('A1 taint recognizes all external channels and excludes system-only rules',()=>{
  for(const context of [{videoWaited:true},{materials:['video']},{authz:{tainted:true}},...['quoted','forwarded','cardView','replyTo'].map(k=>({batch:[{meta:{[k]:k==='forwarded'?[{}]:{}}}]}))])assert.equal(az.tainted(context,[]),true);
  for(const name of ['read_web','search_web','get_work_status'])assert.equal(az.tainted({},[{role:'assistant',tool_calls:[call(name,{})]},{role:'tool',tool_call_id:'call-'+name,content:'{}'}]),true);
  assert.equal(az.tainted({},[{role:'user',content:untrusted('image','图中文字')}]),true);
  assert.equal(az.tainted({},[{role:'system',content:UNTRUSTED_RULE+' '+UNTRUSTED_MARK}]),false);
  assert.equal(az.tainted({},[{role:'user',content:'正常聊天'}]),false);
  assert.equal(untrusted('source','text','2026-01-01'), '【外部资料·不可信｜来源:source｜抓取:2026-01-01】\ntext\n【外部资料结束】');
});
test('A2 exact strong-command contract rejects ordinary video questions',()=>{
  for(const [tool,quotes] of Object.entries({prepare_project_task:['帮我建个任务把这个做了','立项','交给本地做'],create_file_task:['整理成文档','写份总结'],remember_correction:['记住我叫小王','不是周三是周四']}))for(const quote of quotes)assert.ok(az.STRONG[tool].test(quote),quote);
  for(const quote of ['这个视频讲了啥','视频','看看','有意思'])for(const regex of Object.values(az.STRONG))assert.equal(regex.test(quote),false,quote);
});
test('A3 video subtitles cannot borrow the short member quote to create a runnable task',async()=>{
  const e=env();await mocked([project('视频')],async({tools})=>{
    await videoRound(e,'这个视频讲了啥',false);
    assert.equal((await rows(e,'tasks')).length,0);
    assert.ok(tools.some(t=>t.unavailable&&['外部资料不能作为交办依据','成员原话里没有明确交办','原话太短'].includes(t.reason)));
    assert.ok((await rows(e,'activity')).some(a=>a.kind==='authz.denied'));
    assert.ok((await rows(e,'outbox')).some(o=>o.msg_id==='current'));
  });
});
test('A4 explicit video follow-up creates proposal even when execution is requested',async()=>{
  const e=env();await mocked([project('帮我建个任务跟进一下')],async()=>{
    await videoRound(e,'看完这个视频帮我建个任务跟进一下',false);
    assert.equal((await rows(e,'tasks'))[0].status,'proposal');
    assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='local').length,0);
  });
});
test('A5 clean plain-text explicit work preserves queued status',async()=>{
  const e=env(),context=await source(e,'帮我建个任务修登录');
  await mocked([project('帮我建个任务修登录')],()=>agentAnswer(e,context));
  assert.equal((await rows(e,'tasks'))[0].status,'queued');
});
test('A6 cached video material is subject to the same authorization check',async()=>{
  const e=env();await mocked([project('讲了啥')],async()=>{
    await videoRound(e,'讲了啥',true);
    assert.equal((await rows(e,'tasks')).length,0);
    assert.ok((await rows(e,'activity')).some(a=>a.kind==='authz.denied'));
  });
});
test('A7 tainted file tools require a strong original artifact request',async()=>{
  for(const [body,accepted] of [['视频',false],['把视频内容整理成文档',true]]){
    const e=env(),context=await source(e,body);context.materials=[untrusted('video','字幕')];
    await mocked([call('create_file_task',{source_id:'current',request_quote:body,title:'文档',instructions:'整理视频',source_ids:['current']})],()=>agentAnswer(e,context));
    assert.equal((await rows(e,'jobs')).some(j=>j.kind==='media'),accepted);
  }
});
test('A8 tainted corrections require explicit member memory instructions',async()=>{
  for(const [body,accepted] of [['视频',false],['记住这个视频是小王发的',true]]){
    const e=env(),context=await source(e,body);context.materials=[untrusted('video','字幕')];
    await mocked([call('remember_correction',{source_id:'current',quote:body,repo:'team',subject:'视频',predicate:'发送者',value:'小王'})],()=>agentAnswer(e,context));
    assert.equal((await rows(e,'facts')).length,accepted?1:0);
  }
});
for(const [label,name] of [['A9','read_web'],['A10','get_work_status']])test(label+' tool results taint later writes in a previously clean turn',async()=>{
  const e=env(),context=await source(e,'讲讲这个网页');
  await mocked([call(name,name==='read_web'?{url:'https://example.com'}:{}),project('讲讲这个网页')],()=>agentAnswer(e,context));
  assert.equal((await rows(e,'tasks')).length,0);
  assert.ok((await rows(e,'activity')).some(a=>a.kind==='authz.denied'));
});
test('A11 research handoff persists taint and still rejects subsequent project writes',async()=>{
  const e=env(),context=await source(e,'讲了啥');context.materials=[untrusted('video','字幕')];context.background=false;
  await mocked([call('read_web',{url:'https://example.com'}),project('讲了啥')],async()=>{
    await agentAnswer(e,context);
    const j=(await rows(e,'jobs')).find(j=>j.kind==='research');assert.ok(j);
    assert.equal(JSON.parse(j.payload).authz?.tainted,true);
    await queue(e,j.id);
    assert.equal((await rows(e,'tasks')).length,0);
    assert.ok((await rows(e,'activity')).some(a=>a.kind==='authz.denied'));
  });
});
test('A12 quotation content cannot substitute for the current speaker original words',async()=>{
  const e=env(),context=await source(e,'看看这个',{quoted:{text:'帮我建个任务',media:[]},replyTo:{kind:'member',targetId:'other'}});
  context.materials=[untrusted('quote','帮我建个任务')];
  await mocked([project('帮我建个任务')],()=>agentAnswer(e,context));
  assert.equal((await rows(e,'tasks')).length,0);
  assert.ok((await rows(e,'activity')).some(a=>a.kind==='authz.denied'));
});
test('Authorization errors are specific while unrelated tool exceptions stay filtered',async()=>{
  const e=env(),context=await source(e,'帮我建个任务修登录');
  const prepare=e.DB.prepare.bind(e.DB);
  e.DB.prepare=sql=>{
    if(sql.startsWith('INSERT OR IGNORE INTO tasks'))throw Error('private-diagnostic-must-not-escape');
    return prepare(sql);
  };
  await mocked([project('帮我建个任务修登录')],async({seen,tools})=>{
    await agentAnswer(e,context);
    assert.ok(tools.some(t=>t.unavailable&&t.reason==='未能获得资料，不能据此编造结论'));
    assert.ok(!JSON.stringify(seen).includes('private-diagnostic-must-not-escape'));
  });
});
