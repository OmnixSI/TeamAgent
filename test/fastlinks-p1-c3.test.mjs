import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,worker,req,qq,msg} from './support.mjs';
const outfile=`.wrangler/fastlinks-p1-c3-${process.pid}.mjs`;
await build({stdin:{contents:'export {loadChatContext} from "./src/context"; export {viewMessage} from "./src/view"; export {metered} from "./src/d1"; export {titleRef} from "./src/bilititle";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const {loadChatContext,viewMessage,metered,titleRef}=await import('../'+outfile);
const BV='BV1xx411c7mD', BV2='BV1yy411c7mE', group='GROUP000001';
const iso=()=>new Date().toISOString();
const light={bvid:BV,title:'测试视频标题',desc:'视频简介',owner:'UP 主',tname:'科技',duration:60,pubdate:1,stat:{},subtitle:'字幕正文',subtitle_lang:'zh-CN',subtitle_status:'ok',comments:[{uname:'观众',message:'热评'}],tier:'light',fetched_at:iso()};
const light2={...light,bvid:BV2,title:'第二个视频',owner:'另一位 UP 主'};
const queue=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const notes=e=>e.DB.prepare('SELECT * FROM media_notes').all().then(x=>x.results);
const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(x=>x.results);
const put=(e,id,value)=>e.DB.prepare('INSERT OR REPLACE INTO media_notes VALUES(?,?,?)').bind(id,typeof value==='string'?value:JSON.stringify(value),iso()).run();
/** C-1 will write these three notes from reportFetch; R8 reads the same keys. */
async function seed(e,ref,result={...light},bvid=BV,page=1){
  await put(e,'resource:v1:bili:'+bvid+':p:'+page,result);
  await put(e,'alias:v1:bili:'+ref,{bvid,page});
  await put(e,'bili:'+ref,result);
}
async function setup(){const e=env();await req(e,'/api/admin/bind',{groupId:group});return e;}
async function modelFixture(run,toolCalls){
 const old=globalThis.fetch,state={sent:[],models:0,tools:[]};
 globalThis.fetch=async(target,opt)=>{
  const u=String(target);if(u.includes('getAppAccessToken'))return Response.json({access_token:'test-token',expires_in:300});
  const b=JSON.parse(opt.body);if(u.includes('api.bot.qq.com/')){state.sent.push(b);return Response.json({id:'sent-'+state.sent.length});}
  assert.ok(u.endsWith('/chat/completions'),u);
  if(b.messages[0].content.includes('最后的嘴替模块'))return Response.json({choices:[{message:{content:'{"mode":"work","text":"按实际资料回答。"}'}}]});
  for(const m of b.messages)if(m.role==='tool')state.tools.push(JSON.parse(m.content));
  const calls=toolCalls?.(++state.models);return Response.json({choices:[{message:calls?{role:'assistant',tool_calls:calls}:{content:'{"action":"reply","kind":"direct","brief":"按实际资料回答"}'}}]});
 };
 try{return await run(state);}finally{globalThis.fetch=old;}
}
async function measured(base,label,run){const e=metered(base),before=base.DB.executed,out=await run(e);assert.equal(e.meter.used,base.DB.executed-before,label);assert.ok(e.meter.used<=48,label+' '+e.meter.used);return out;}
async function status(e,id){
 const job='research-status-'+id;
 await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind(job,'research',JSON.stringify({latestId:id,batchIds:[id],mentioned:true,background:true}),Date.now()).run();
 let materials;
 await modelFixture(async state=>{await queue(e,job);const tool=state.tools.find(t=>Array.isArray(t.materials));assert.ok(tool,'get_work_status ran');materials=tool.materials;},n=>n===1?[{id:'status',type:'function',function:{name:'get_work_status',arguments:JSON.stringify({source_id:id})}}]:null);
 return materials;
}
test('R8-1 a cached Bili message records msgref and reports its own light result',async()=>{
 const e=await setup();await seed(e,BV);
 await qq(e,msg('r8-hit','再看这个 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE');
 await measured(e,'C3-chat-cache-hit',x=>modelFixture(()=>queue(x,'chat-r8-hit')));
 const msgref=(await notes(e)).find(n=>n.id==='msgref:v1:r8-hit');
 assert.ok(msgref,'msgref is written on a cache hit');
 assert.deepEqual(JSON.parse(msgref.body),{ref:BV,match:'id'});
 assert.equal((await rows(e,'video_waits')).length,0,'cache hit must not start a wait');
 const materials=await measured(e,'C3-status-msgref',x=>status(x,'r8-hit'));
 assert.equal(materials.length,1);
 assert.equal(materials[0].source_id,'r8-hit');
 assert.match(materials[0].result,/测试视频标题/);
 assert.match(materials[0].result,/UP 主/);
});
test('R8-2 a miss records msgref when a wait starts and when the group already has three waits',async()=>{
 const e=await setup();
 await qq(e,msg('r8-miss','看看 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE');
 await measured(e,'C3-chat-wait-start',x=>queue(x,'chat-r8-miss'));
 assert.equal((await rows(e,'video_waits')).length,1);
 assert.deepEqual(JSON.parse((await notes(e)).find(n=>n.id==='msgref:v1:r8-miss').body),{ref:BV,match:'id'});
 for(let i=0;i<3;i++)await e.DB.prepare('INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,ready,due_at,status,created_at) VALUES(?,?,?,?,?,1,0,?,?,?)').bind('busy-'+i,group,BV,'busy-'+i,'[]',Date.now()+60000,'waiting',Date.now()).run();
 await qq(e,msg('r8-full','这个也看看 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE');
 await measured(e,'C3-chat-waits-full',x=>modelFixture(()=>queue(x,'chat-r8-full')));
 assert.equal((await rows(e,'video_waits')).length,4,'the fourth wait must not start');
 assert.deepEqual(JSON.parse((await notes(e)).find(n=>n.id==='msgref:v1:r8-full').body),{ref:BV,match:'id'});
});
test('R8-3 a title card records match title and get_work_status marks the result',async()=>{
 const e=await setup();
 const title='测试卡片标题';
 const ref=titleRef(title);
 await seed(e,ref);
 await qq(e,{...msg('r8-title','这个视频讲了啥'),ark_data:{fields:{source:'哔哩哔哩',title}}},'GROUP_AT_MESSAGE_CREATE');
 await measured(e,'C3-chat-title-card',x=>modelFixture(()=>queue(x,'chat-r8-title')));
 const msgref=(await notes(e)).find(n=>n.id==='msgref:v1:r8-title');
 assert.deepEqual(JSON.parse(msgref.body),{ref,match:'title'});
 const materials=await measured(e,'C3-status-title',x=>status(x,'r8-title'));
 assert.equal(materials.length,1);
 assert.match(materials[0].result,/（按标题匹配，未必是同一视频）/);
 assert.match(materials[0].result,/测试视频标题/);
});
test('R8-6 get_work_status and context keep different messages apart',async()=>{
 const e=await setup();await seed(e,BV,{...light});await seed(e,BV2,{...light2},BV2);
 await qq(e,msg('r8-a','看看 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE');
 await measured(e,'C3-chat-two-a',x=>modelFixture(()=>queue(x,'chat-r8-a')));
 await qq(e,msg('r8-b','看看 https://www.bilibili.com/video/'+BV2),'GROUP_AT_MESSAGE_CREATE');
 await measured(e,'C3-chat-two-b',x=>modelFixture(()=>queue(x,'chat-r8-b')));
 const a=await status(e,'r8-a'),b=await status(e,'r8-b');
 assert.equal(a.length,1);assert.match(a[0].result,/测试视频标题/);assert.doesNotMatch(a[0].result,/第二个视频/);
 assert.equal(b.length,1);assert.match(b[0].result,/第二个视频/);assert.doesNotMatch(b[0].result,/测试视频标题/);
 const context=await loadChatContext(e,{groupId:group,latestId:'r8-a',batchIds:['r8-a']});
 const row=context.recent.find(r=>r.id==='r8-a');
 const view=viewMessage(row,context.names,context.refs);
 assert.match(view.material.analysed,/标题：测试视频标题/);
 assert.match(view.material.analysed,/UP主：UP 主/);
});
test('C3-intent only a Bili read request reaches the light fetch chain; no media job for Bili or YouTube',async()=>{
 const e=await setup();
 await qq(e,msg('intent-link','https://www.bilibili.com/video/'+BV),'GROUP_MESSAGE_CREATE');
 await qq(e,msg('intent-ask','看下这个视频讲了啥 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE');
 assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='media').length,0,'inbound links must not build media- tasks');
 await measured(e,'C3-chat-intent-ask',x=>queue(x,'chat-intent-ask'));
 assert.equal((await rows(e,'video_waits')).length,1,'the read request keeps the existing light wait');
 await qq(e,msg('intent-youtube','https://youtu.be/abcdefghijk'),'GROUP_MESSAGE_CREATE');
 assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='media').length,0,'YouTube behavior is unchanged');
});
