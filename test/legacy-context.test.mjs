import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env} from './support.mjs';
async function bundle(name) {
  const outfile=`.wrangler/legacy-${name}-${process.pid}.mjs`;
  await build({entryPoints:[`src/${name}.ts`],bundle:true,format:'esm',platform:'browser',outfile});
  return import('../'+outfile);
}
const d1=await bundle('d1'), view=await bundle('view'), ctx=await bundle('context'), vision=await bundle('vision');
const {analyse}=await bundle('semantic'), {needsVideo}=await bundle('fetchjobs');
const group='GROUP000001', iso=new Date().toISOString();
const row=(id,sender,body,meta={})=>({id,group_id:group,sender,body,ts:iso,ordinal:1,meta});
async function message(e,r){
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)').bind(r.id,group,r.sender,r.body,r.ts).run();
  await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind(r.id,JSON.stringify(r.meta)).run();
}
test('2.5 chunks and 130 image-note ids stay within D1 binding limit',async()=>{
  assert.deepEqual(d1.chunks([],90),[]);
  assert.deepEqual(d1.chunks([1,2,3],2),[[1,2],[3]]);
  const e=env(),ids=Array.from({length:130},(_,i)=>'image-'+i);
  for(const i of [0,129]){
    await e.DB.prepare('INSERT INTO image_notes VALUES(?,?,?,?,?,?)').bind('sha'+i,'图'+i,'[]',0,null,Date.now()).run();
    await e.DB.prepare('INSERT INTO message_images VALUES(?,?,?)').bind(ids[i],0,'sha'+i).run();
  }
  const prepare=e.DB.prepare.bind(e.DB);
  e.DB.prepare=sql=>{const s=prepare(sql),bind=s.bind;s.bind=(...args)=>{assert.ok(args.length<=100);return bind(...args);};return s;};
  const before=e.DB.executed,notes=await vision.imageNotesFor(e,ids);
  assert.equal(e.DB.executed-before,2);
  assert.equal(notes.size,2);assert.match(notes.get(ids[129])[0],/图129/);
});
test('2.1 displayed face markers and rendered mentions are valid original evidence',()=>{
  const r=row('r','U1','<@U2> 好的[<face,id=1/>]',{mentions:[{id:'U2',name:''}],media:[]}),names=new Map([['U2','张三']]);
  assert.equal(view.displayText(r.body,[{id:'U2',name:'张三'}]),'@张三 好的[表情]');
  assert.equal(view.quoteIn(r,'好的[表情]',names),true);
  assert.equal(view.quoteIn(r,'@张三 好的[表情]',names),true);
  assert.equal(view.quoteIn(r,'坏的[表情]',names),false);
  assert.equal(r.body,'<@U2> 好的[<face,id=1/>]');
});
test('2.2 legacy metadata restores media, urls, quotes and Bilibili refs without overriding new data',()=>{
  const old={attachments:[{content_type:'image/png',width:20,height:30}],urls:['https://www.bilibili.com/video/BV1xx411c7mD'],forwarded:[{content:'转发原文'}]};
  const meta=view.metaOf({metadata:JSON.stringify(old)});
  assert.deepEqual(view.mediaViews(meta,'old'),['图片 20×30']);
  assert.deepEqual(meta.ownUrls,old.urls);assert.equal(meta.quoted.text,'转发原文');
  assert.equal(needsVideo([],row('old','U1','视频讲了啥',meta),[],{bili:{enabled:true}}),'BV1xx411c7mD');
  const modern={...old,media:[],ownUrls:['https://example.com'],quoted:{text:'新引用',media:[]}};
  assert.deepEqual(view.withLegacy(modern),modern);
  assert.equal(view.withLegacy({attachments:[]}).media,undefined);
});
test('L1 modern forwarded metadata without quoted remains unquoted',()=>{
  const m={media:[],forwarded:[{content:'别人的话'}]};
  assert.equal(view.withLegacy(m).quoted,undefined);
  assert.deepEqual(view.metaOf({meta:m}),m);
});
test('2.3 names are fetched by ids beyond 600 unrelated members, including reference authors',async()=>{
  const e=env();
  await e.DB.batch(Array.from({length:600},(_,i)=>e.DB.prepare('INSERT INTO member_names VALUES(?,?,?,?)').bind('noise'+i,'无关'+i,'qq',iso)));
  for(const [id,name] of [['target','目标成员'],['ref-author','引用作者'],['mention','张三']])await e.DB.prepare('INSERT INTO member_names VALUES(?,?,?,?)').bind(id,name,'qq',iso).run();
  await message(e,row('quoted','ref-author','引用原文',{media:[]}));
  for(let i=0;i<25;i++)await message(e,row('filler'+i,'target','填充',{media:[]}));
  await message(e,row('latest','target','<@mention> 好的',{media:[],mentions:[{id:'mention',name:''}],replyTo:{kind:'member',targetId:'quoted'}}));
  const context=await ctx.loadChatContext(e,{groupId:group,latestId:'latest',batchIds:['latest']});
  const views=ctx.buildViews(context,[]);
  assert.equal(views.latestView.from,'目标成员');
  assert.equal(views.latestView.text,'@张三 好的');
  assert.equal(context.refs.get('quoted').from,'引用作者');
  const ids=Array.from({length:130},(_,i)=>'noise'+i),before=e.DB.executed;
  assert.equal((await ctx.namesFor(e,ids)).size,130);
  assert.equal(e.DB.executed-before,2);
});
test('2.4 fact extraction recognizes names rendered from member_names',async()=>{
  const e=env(),r=row('fact','U1','<@U2> 明天交',{mentions:[{id:'U2',name:''}],media:[]});
  await message(e,r);await e.DB.prepare('INSERT INTO member_names VALUES(?,?,?,?)').bind('U2','张三','qq',iso).run();
  const services={setting:async()=>undefined,set:async()=>{},job:async()=>{},llm:async()=>JSON.stringify({facts:[{repo:'team',subject:'张三',predicate:'交付',value:'明天',evidence:'@张三 明天交',source_id:'fact',status:'confirmed'}],expressions:[]})};
  await analyse(e,{messages:[r]},services);
  const facts=(await e.DB.prepare("SELECT * FROM facts WHERE source_id='fact'").all()).results;
  assert.equal(facts.length,1);assert.equal(facts[0].evidence,'@张三 明天交');
});
