import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,req,qq,msg,runChat} from './support.mjs';
const outfile=`.wrangler/image-redirect-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/vision"; export {mediaOf} from "./src/inbound"; export {mediaViews} from "./src/view";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile),host='multimedia.nt.qq.com.cn',original=`https://${host}/original?signature=synthetic-private`;
const bytes=new Uint8Array([137,80,78,71,1,2,3]);
const image=()=>new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length)}});
async function network(reply,work){
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});return reply(String(url),options,calls);};
 try{return await work(calls);}finally{globalThis.fetch=old;}
}
async function outcome(reply){
 const events=[];
 return network(reply,async calls=>{
  const result=await api.fetchImage(original,new AbortController().signal,5_000_000,e=>events.push(e));
  return {result,events,calls};
 });
}
test('IR1 manual redirect to the observed QQ image host succeeds and keeps one signal',async()=>{
 const {result,events,calls}=await outcome(url=>url===original?new Response(null,{status:302,headers:{location:`https://${host}/cdn/image.png`}}):image());
 assert.deepEqual(result.bytes,bytes);assert.equal(calls.length,2);
 assert.ok(calls.every(c=>c.options.redirect==='manual'));assert.equal(calls[0].options.signal,calls[1].options.signal);
 assert.equal(events.at(-1).hop,1);assert.equal(events.at(-1).status,'ok');
});
for(const target of ['https://evil.example/image.png','http://'+host+'/image.png','https://127.0.0.1/private',
 'https://10.0.0.1/private','https://8.8.8.8/public','https://[::1]/private','https://user:password@'+host+'/image',
 'https://'+host+'.evil.example/image','https://'+host+':8443/image'])
 test('IR2 rejects redirect before requesting unsafe target '+target,async()=>{
  const {result,events,calls}=await outcome(()=>new Response(null,{status:302,headers:{location:target}}));
  assert.equal(result,null);assert.equal(calls.length,1);
  assert.equal(events.at(-1).reason,'blocked');assert.equal(events.at(-1).hop,1);
  assert.doesNotMatch(JSON.stringify(events),/synthetic-private|password|https:/);
 });
test('IR2 initial localhost, private and public IP literals are blocked without requests',async()=>{
 await network(()=>assert.fail('blocked URL requested'),async calls=>{
  for(const url of ['https://localhost/','https://api.localhost/','https://localhost./','https://a.local/',
    'https://192.168.0.1/','https://8.8.8.8/','https://2130706433/','https://0x08080808/','https://[2001:4860:4860::8888]/']){
   const events=[];assert.equal(await api.fetchImage(url,new AbortController().signal,5_000_000,e=>events.push(e)),null,url);
   assert.equal(events.at(-1).reason,'blocked',url);assert.equal(events.at(-1).hop,0,url);
  }
  assert.equal(calls.length,0);
 });
});
for(const blockedHost of ['127.0.0.1.nip.io','10.0.0.1.nip.io','evilqpic.cn','qpic.cn.evil.com','qpic.cn','example.com','multimedia.nt.qq.com.cn.evil.com'])
 test('IR7 initial host outside the QQ allowlist never reaches fetch: '+blockedHost,async()=>{
  await network(()=>image(),async calls=>{
   const events=[];
   assert.equal(await api.fetchImage(`https://${blockedHost}/private.png`,new AbortController().signal,5_000_000,e=>events.push(e)),null);
   assert.equal(calls.length,0);assert.equal(events.at(-1).reason,'blocked');assert.equal(events.at(-1).hop,0);
   const notes=new Map();api.applyImageOutcomes(notes,[{...events.at(-1),messageId:'image',idx:0}]);
   assert.match(notes.get('image')[0],/原始地址.*请重发/);
  });
 });
for(const allowedHost of ['gchat.qpic.cn','m.qpic.cn','a.b.qpic.cn'])
 test('IR8 QQ image subdomain works as initial URL and redirect target: '+allowedHost,async()=>{
  await network(()=>image(),async calls=>{
   const result=await api.fetchImage(`https://${allowedHost}/image.png`,new AbortController().signal,5_000_000,()=>{});
   assert.deepEqual(result.bytes,bytes);assert.equal(calls.length,1);
  });
  const redirected=await outcome(url=>url===original?new Response(null,{status:302,headers:{location:`https://${allowedHost}/image.png`}}):image());
  assert.deepEqual(redirected.result.bytes,bytes);assert.equal(redirected.calls.length,2);assert.equal(redirected.events.at(-1).hop,1);
 });
for(const location of ['/cdn/image','cdn/image','//gchat.qpic.cn/image','?image=1','#image'])
 test('IR9 relative Location is rejected before another fetch: '+location,async()=>{
  const r=await outcome(()=>new Response(null,{status:302,headers:{location}}));
  assert.equal(r.result,null);assert.equal(r.calls.length,1);assert.equal(r.events.at(-1).reason,'blocked');
  assert.equal(r.events.at(-1).detail,'redirect_location');assert.equal(r.events.at(-1).hop,1);
  const notes=new Map();api.applyImageOutcomes(notes,[{...r.events.at(-1),messageId:'image',idx:0}]);
  assert.match(notes.get('image')[0],/绝对HTTPS地址/);assert.match(notes.get('image')[0],/请重发/);
 });
test('IR3 two redirects succeed but a third is refused and all redirect bodies are cancelled',async()=>{
 let cancelled=0;
 const redirect=target=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:302,headers:{location:target}});
 const good=await outcome((_url,_options,calls)=>calls.length<3?redirect(`https://${host}/hop${calls.length}`):image());
 assert.equal(good.result.mime,'image/png');assert.equal(good.calls.length,3);assert.equal(cancelled,2);
 const bad=await outcome((_url,_options,calls)=>redirect(`https://${host}/hop${calls.length}`));
 assert.equal(bad.result,null);assert.equal(bad.calls.length,3);assert.equal(bad.events.at(-1).reason,'redirect_limit');assert.equal(bad.events.at(-1).hop,3);
 assert.equal(cancelled,5);
});
test('IR3 missing or malformed Location is explicit and never makes another request',async()=>{
 for(const location of [undefined,'https://[broken']){
  const r=await outcome(()=>new Response(null,{status:302,headers:location?{location}:{}}));
  assert.equal(r.result,null);assert.equal(r.calls.length,1);assert.equal(r.events.at(-1).reason,'blocked');
  assert.equal(r.events.at(-1).detail,'redirect_location');assert.equal(r.events.at(-1).hop,1);
 }
});
for(const [name,response,reason,http,mime] of [
 ['403',()=>new Response(null,{status:403}),'http',403],
 ['MIME',()=>new Response('not an image',{headers:{'content-type':'text/html; synthetic=never-log'}}),'mime',200,'text/html'],
 ['oversize',()=>new Response(null,{headers:{'content-type':'image/png','content-length':'5000001'}}),'oversize',200],
 ['network',()=>{throw Error(original+' never-log');},'network'],
])test('IR4 '+name+' retains the real reason and hop after redirect',async()=>{
 const r=await outcome(url=>url===original?new Response(null,{status:302,headers:{location:`https://${host}/cdn/image`}}):response());
 assert.equal(r.result,null);assert.equal(r.events.at(-1).reason,reason);assert.equal(r.events.at(-1).hop,1);
 if(http)assert.equal(r.events.at(-1).http,http);if(mime)assert.equal(r.events.at(-1).mime,mime);
 const notes=new Map();api.applyImageOutcomes(notes,[{...r.events.at(-1),messageId:'image',idx:0}]);
 const text=notes.get('image')[0];assert.match(text,new RegExp('reason='+reason));assert.match(text,/第1次跳转/);assert.match(text,/请重发/);
 assert.doesNotMatch(text,/请求被拒|跳转拒绝/);assert.doesNotMatch(JSON.stringify(r.events),/synthetic-private|never-log|https:/);
});
test('IR4 streamed size and timeout limits still apply after redirects',{timeout:1000},async()=>{
 for(const timedOut of [false,true]){
  let cancelled=false;const events=[];
  await network(url=>url===original?new Response(null,{status:302,headers:{location:`https://${host}/cdn/image`}})
   :new Response(new ReadableStream({start(c){if(!timedOut)c.enqueue(new Uint8Array(10));},cancel(){cancelled=true;}}),{headers:{'content-type':'image/png'}}),async()=>{
    assert.equal(await api.fetchImage(original,AbortSignal.timeout(30),3,e=>events.push(e)),null);
   });
  assert.equal(cancelled,true);assert.equal(events.at(-1).reason,timedOut?'timeout':'oversize');assert.equal(events.at(-1).hop,1);
 }
});
for(const mode of ['direct image while replying to bot','quoted member image'])test('IR5 '+mode+' selects and links the redirected image',async()=>{
 const e=env(),media=api.mediaOf([{url:original,content_type:'image/png',width:600,height:800}]);
 e.AI={async run(){return {response:'{\"desc\":\"合成图片\",\"tags\":[],\"meme\":false}'};}};
 const source={id:'source',body:'图片',meta:{media}};
 const latest=mode.startsWith('direct')?{id:'ask',body:'',meta:{media,replyTo:{kind:'bot',targetId:'bot-old'}}}
  :{id:'ask',body:'图里是什么',meta:{replyTo:{kind:'member',targetId:'source'}}};
 const picks=api.pickImages([source,latest],latest,new Map([['source',source]]));
 assert.equal(picks[0].messageId,mode.startsWith('direct')?'ask':'source');
 await network(url=>url===original?new Response(null,{status:302,headers:{location:`https://${host}/cdn/image`}})
  :url.includes('api.deepseek.com')?Response.json({choices:[{message:{content:'{"desc":"合成图片","tags":[],"meme":false}'},finish_reason:'stop'}]}):image(),async()=>{
   const outcomes=await api.annotateTurn(e,picks.slice(0,1));assert.equal(outcomes[0].stage,'link');assert.equal(outcomes[0].status,'ok');
  });
 assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM message_images').first()).n,1);
});
test('IR6 actual chat continuation receives network reason, redirect hop and a resend step',async()=>{
 const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
 await qq(e,{...msg('network-image','这张图是什么'),attachments:[{url:original,content_type:'image/jpeg',width:600,height:800}],mentions:[{member_openid:'bot',is_you:true}]});
 const prompts=[];
 await network((url,init)=>{
  if(url===original)return new Response(null,{status:302,headers:{location:`https://${host}/cdn/image`}});
  if(url.startsWith('https://'+host))throw Error('synthetic transport failure');
  prompts.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:'{"action":"stop","kind":"direct","brief":"按已记录的图片下载失败原因说明"}'},finish_reason:'stop'}]});
 },()=>runChat(e,'chat-network-image'));
 const saved=JSON.parse((await e.DB.prepare("SELECT payload FROM jobs WHERE id='chat-v-network-image'").first()).payload).imageOutcomes[0];
 assert.equal(saved.reason,'network');assert.equal(saved.hop,1);
 const text=JSON.stringify(prompts);assert.match(text,/reason=network/);assert.match(text,/第1次跳转/);assert.match(text,/请重发/);
 assert.doesNotMatch(text,/网络请求失败（含可能的跳转拒绝）/);
});
