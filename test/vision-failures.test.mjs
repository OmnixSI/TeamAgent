import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { env, msg, qq, req, runChat } from './support.mjs';

const load = async name => {
  const outfile = `.wrangler/vision-fix-${name}-${process.pid}.mjs`;
  await build({entryPoints:[`src/${name}.ts`],bundle:true,format:'esm',platform:'browser',outfile});
  return import('../'+outfile);
};
const vision = await load('vision'), view = await load('view');
const jpeg = {kind:'image',contentType:'image/jpeg',width:519,height:1271,size:275673,url:'https://multimedia.nt.qq.com.cn/example?signature=private-signature'};
const face = '<faceType=6,faceId="0",ext="%7B%22text%22%3A%22%22%7D">';
async function mocked(fetcher, run) {
  const old=globalThis.fetch;
  globalThis.fetch=fetcher;
  try { return await run(); } finally { globalThis.fetch=old; }
}

test('VF1 explicit QQ face image enters the bounded sticker candidate path without treating the marker as prose',async()=>{
  const e=env(); await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
  await qq(e,{...msg('qq-face-image',face),attachments:[{...jpeg,content_type:jpeg.contentType}]});
  const jobs=(await e.DB.prepare("SELECT payload FROM jobs WHERE kind='sticker'").all()).results;
  assert.equal(jobs.length,1);
  assert.equal(vision.looksLikeSticker(jpeg,false,true),true);
  assert.equal(vision.looksLikeSticker({...jpeg,size:400001},false,true),false);
  assert.equal(vision.looksLikeSticker(jpeg,true,true),false);
  await qq(e,{...msg('qq-face-with-prose',face+' 这是正文'),attachments:[{...jpeg,content_type:jpeg.contentType}]});
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='sticker'").first()).n,1);
});

test('VF2 face names survive encoded and escaped ext.text, empty or malformed names are explicit',()=>{
  for (const ext of ['%7B%22text%22%3A%22%E6%95%AC%E7%A4%BC%22%7D','{\\"text\\":\\"敬礼\\"}']) {
    assert.equal(view.displayText(`<faceType=6,faceId="0",ext="${ext}">`,[]),'[表情：敬礼]');
  }
  assert.equal(view.displayText(face,[]),'[超级表情]');
  assert.equal(view.displayText('<faceType=6,faceId="0",ext="broken">',[]),'[超级表情]');
  assert.equal(view.displayText('<faceType=6,faceId="0",ext="{\\"text\\":\\"100%赞同\\"}">',[]),'[表情：100%赞同]');
});

test('VF3 explicit image question without @ selects an earlier image in the current batch',()=>{
  const image={id:'image',body:face,meta:{media:[jpeg]}};
  const ask={id:'ask',body:'你能看到我的表情吗',meta:{}};
  assert.equal(vision.pickImages([image,ask],ask,new Map())[0]?.messageId,'image');
  assert.deepEqual(vision.pickImages([image,{...ask,body:'今天吃什么？'}],{...ask,body:'今天吃什么？'},new Map()),[]);
});

test('VF3 latest attachment is selected before older images for a plain image request',()=>{
  const older={id:'older',body:face,meta:{media:[jpeg]}},latest={id:'latest',body:'看看这张图',meta:{media:[jpeg]}};
  assert.deepEqual(vision.pickImages([older,latest],latest,new Map(),1).map(p=>p.messageId),['latest']);
});

test('VF4 HTTP, MIME, oversize, empty and network failures retain safe phase results',async()=>{
  const cases=[
    [()=>new Response('denied',{status:403}),'http',403],
    [()=>new Response('not an image',{headers:{'content-type':'text/html; private=never-log'}}),'mime'],
    [()=>new Response(null,{headers:{'content-type':'image/jpeg','content-length':'6000000'}}),'oversize'],
    [()=>new Response(new Uint8Array(),{headers:{'content-type':'image/jpeg'}}),'empty'],
    [()=>{throw Error(jpeg.url+' QQ=123456789');},'network'],
  ];
  for(const [response,reason,http] of cases){
    const events=[];
    const result=await mocked(async()=>response(),()=>vision.fetchImage(jpeg.url,new AbortController().signal,5_000_000,event=>events.push(event)));
    assert.equal(result,null);
    assert.equal(events.at(-1)?.reason,reason);
    if(http)assert.equal(events.at(-1).http,http);
    assert.doesNotMatch(JSON.stringify(events),/private-signature|123456789|never-log|https:/);
  }
});

test('VF5 deadline cancels a stalled body even when the stream ignores the fetch signal',{timeout:1000},async()=>{
  let cancelled=false;
  const events=[];
  const started=Date.now();
  const result=await mocked(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'image/jpeg'}}),()=>
    vision.fetchImage(jpeg.url,AbortSignal.timeout(25),5_000_000,event=>events.push(event)));
  assert.equal(result,null);
  assert.equal(events.at(-1)?.stage,'body');
  assert.equal(events.at(-1)?.reason,'timeout');
  assert.equal(cancelled,true);
  assert.ok(Date.now()-started<500);
});

test('VF6 annotate distinguishes attempted download from linked note and preserves the failure for the answering job',async()=>{
  const e=env();
  const outcomes=await mocked(async()=>new Response('denied',{status:403}),()=>vision.annotateTurn(e,[{messageId:'m',idx:0,media:jpeg,hint:''}],100));
  assert.equal(outcomes[0].status,'failed');
  assert.equal(outcomes[0].stage,'fetch');
  assert.equal(outcomes[0].http,403);
  const notes=new Map(); vision.applyImageOutcomes(notes,outcomes);
  assert.match(view.mediaViews({media:[jpeg]},'m',notes,new Set(['m:0']))[0],/未取得.*HTTP 403/);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM message_images').first()).n,0);
});

test('VF7 cache, budget, model, and database failures are distinguishable; aborted work never creates a note',async()=>{
  const bytes=new Uint8Array([1,2,3]);
  for(const mode of ['cache','budget','describe','store']){
    const e=env(), events=[];
    e.AI={async run(){return {response:mode==='describe'?'bad-json':'{\"desc\":\"敬礼\",\"tags\":[],\"meme\":true}'};}};
    if(mode==='budget'){
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:vision.TEAM.memory.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('budget:vision:'+day,'300').run();
    }
    if(mode==='cache'||mode==='store'){
      const prepare=e.DB.prepare.bind(e.DB);
      e.DB.prepare=sql=>{
        if((mode==='cache'&&sql.startsWith('SELECT sha'))||(mode==='store'&&sql.startsWith('INSERT OR IGNORE INTO image_notes')))throw Error(jpeg.url);
        return prepare(sql);
      };
    }
    const result=await mocked(async()=>Response.json({choices:[{message:{content:mode==='describe'?'bad-json':'{"desc":"敬礼","tags":[],"meme":true}'},finish_reason:'stop'}]}),()=>
      vision.describeBytes(e,bytes,'image/jpeg','',new AbortController().signal,'v1',event=>events.push(event)));
    assert.equal(result,null);
    assert.equal(events.at(-1)?.stage,mode);
    assert.doesNotMatch(JSON.stringify(events),/private-signature|https:/);
  }
  const e=env(),controller=new AbortController();controller.abort();
  assert.equal(await vision.describeBytes(e,bytes,'image/jpeg','',controller.signal),null);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n,0);
});

test('VF8 @ followup receives the actual download failure instead of unviewed',async()=>{
  const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
  await qq(e,{...msg('real-shape',face),attachments:[{...jpeg,content_type:jpeg.contentType}]});
  await qq(e,{...msg('followup','你能看到我的表情吗'),mentions:[{member_openid:'bot',is_you:true}]});
  let prompt;
  await mocked(async(url,init)=>{
    if(String(url).includes('multimedia.nt.qq.com.cn'))return new Response('denied',{status:403});
    const body=JSON.parse(init.body);
    prompt=body;
    return Response.json({choices:[{message:{content:'{"action":"stop","kind":"banter","brief":"图片下载失败"}'},finish_reason:'stop'}]});
  },()=>runChat(e,'chat-followup'));
  const next=await e.DB.prepare("SELECT payload FROM jobs WHERE id='chat-v-followup'").first();
  assert.equal(JSON.parse(next.payload).imageOutcomes[0].status,'failed');
  await mocked(async(_url,init)=>{
    const body=JSON.parse(init.body);
    if(!String(body.messages?.[0]?.content).includes('最后的嘴替模块'))prompt=body;
    return Response.json({choices:[{message:{content:String(body.messages?.[0]?.content).includes('最后的嘴替模块')?'分辨不了，图片下载返回 HTTP 403。':'{"action":"reply","kind":"banter","brief":"图片下载 HTTP 403"}'},finish_reason:'stop'}]});
  },()=>runChat(e,'chat-v-followup'));
  assert.match(JSON.stringify(prompt),/未取得.*HTTP 403/);
  assert.doesNotMatch(JSON.stringify(prompt),/图片（未查看）/);
});

test('VF9 model request timeout remains distinct from an invalid model description',async()=>{
  const e=env(),events=[];
  e.AI={async run(){throw new DOMException('never-log '+jpeg.url,'AbortError');}};
  const result=await mocked(async()=>{throw new DOMException('never-log '+jpeg.url,'AbortError');},()=>
    vision.describeBytes(e,new Uint8Array([1,2,3]),'image/jpeg','',new AbortController().signal,'v1',event=>events.push(event)));
  assert.equal(result,null);
  assert.equal(events.at(-1).stage,'describe');
  assert.equal(events.at(-1).reason,'timeout');
  assert.doesNotMatch(JSON.stringify(events),/never-log|private-signature/);
});

test('VF10 a synthetic image of the real JPEG size completes download, description and message association',async()=>{
  const e=env(),logs=[],old=console.info;
  e.AI={async run(){return {response:'{\"desc\":\"一张敬礼表情图\",\"tags\":[\"敬礼\"],\"meme\":true}'};}};
  console.info=(...args)=>logs.push(args.join(' '));
  let outcomes;
  try {
    outcomes=await mocked(async url=>String(url).includes('api.deepseek.com')
      ? Response.json({choices:[{message:{content:'{"desc":"一张敬礼表情图","tags":["敬礼"],"meme":true}'},finish_reason:'stop'}]})
      : new Response(new Uint8Array(275673),{headers:{'content-type':'image/jpeg','content-length':'275673'}}),()=>
      vision.annotateTurn(e,[{messageId:'member-private-id',idx:0,media:jpeg,hint:'QQ=123456789'}]));
  } finally {console.info=old;}
  assert.equal(outcomes[0].status,'ok');
  assert.equal(outcomes[0].stage,'link');
  assert.match(outcomes[0].traceId,/^[0-9a-f-]{36}$/);
  const notes=await vision.imageNotesFor(e,['member-private-id']);
  assert.match(notes.get('member-private-id')[0],/图片：一张敬礼表情图/);
  assert.match(logs.join('\n'),/"stage":"fetch","status":"attempt"/);
  assert.match(logs.join('\n'),/"stage":"link","status":"ok"/);
  assert.doesNotMatch(logs.join('\n'),/https:|signature|123456789|member-private-id/);
});

test('VF11 quoted image failure is visible even when references were built before outcomes arrived',()=>{
  const target={id:'quoted',from:'成员',text:'',media:['语音','图片（未分析：没有可用结果，原因未记录）','文件 x','图片']};
  const notes=new Map();
  vision.applyImageOutcomes(notes,[{messageId:'quoted',idx:0,stage:'fetch',status:'failed',reason:'http',http:403},{messageId:'quoted',idx:1,stage:'body',status:'failed',reason:'timeout'}]);
  const message=view.viewMessage({id:'ask',sender:'member',ts:new Date().toISOString(),body:'这张图是什么',meta:{replyTo:{kind:'member',targetId:'quoted'}}},new Map(),new Map([['quoted',target]]),notes);
  assert.match(message.material.quote.media[1],/未取得.*HTTP 403/);
  assert.match(message.material.quote.media[3],/未取得.*超时/);
  assert.equal(message.material.quote.media[0],'语音');
  assert.equal(message.material.quote.media[2],'文件 x');
});
