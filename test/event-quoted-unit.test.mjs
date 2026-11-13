import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env} from './support.mjs';
const outfile=`.wrangler/event-quoted-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/media/quoted"; export {quoteRef} from "./src/quote"; export {pickImages,annotateTurn,imageNotesFor,applyImageOutcomes} from "./src/vision"; export {viewMessage} from "./src/view";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile),url='https://multimedia.nt.qq.com.cn/preview';
const attachment={url,content_type:'image/png',width:40,height:50};
test('P4 outbound member references expire at 24h and never cross groups',async()=>{
 const e=env(),now=Date.now(),context={latest:{id:'b',group_id:'g'},batch:[{id:'a',sender:'u',mentioned:1},{id:'b',sender:'v'}],groupNewestId:'b'};
 await e.DB.prepare('INSERT INTO message_refs VALUES(?,?,?,?,?)').bind('expired','member','a','g',now-86400001).run();
 assert.equal(await api.quoteRef(e,{target:'a'},context,{}),undefined);
 await e.DB.prepare('DELETE FROM message_refs').run();
 await e.DB.prepare('INSERT INTO message_refs VALUES(?,?,?,?,?)').bind('other','member','a','other',now).run();
 assert.equal(await api.quoteRef(e,{target:'a'},context,{}),undefined);
 await e.DB.prepare('INSERT INTO message_refs VALUES(?,?,?,?,?)').bind('recent','member','a','g',now).run();
 assert.equal(await api.quoteRef(e,{target:'a'},context,{}),'recent');
});
test('P4 bounded quote extraction skips parallel and forwarded images, deduplicates and preserves the nearest owner',()=>{
 const raw={msg_elements:[{message_type:101,attachments:[attachment]},{message_type:102,attachments:[attachment]},
  {message_type:103,author:{id:'a'},attachments:[attachment],msg_elements:[{author:{id:'b'},attachments:[{...attachment,url:url+'/b'},attachment]}]}]};
 const images=api.quotedImages(raw,3);
 assert.deepEqual(images.map(x=>[x.media.url,x.owner]),[[url,'a'],[url+'/b','b']]);
 assert.equal(api.quotedImages(raw,1).length,1);
 assert.equal(api.quotedImages({message_type:101,msg_elements:[{attachments:[attachment]}]},3).length,0);
 assert.equal(api.quotedImages({message_type:103,msg_elements:[{attachments:[attachment]}]},3).length,1);
});
test('P4 quote preview depth and item budgets stop scanning without guessing source message IDs',()=>{
 let node={attachments:[attachment]};for(let i=0;i<5;i++)node={msg_elements:[node]};
 assert.equal(api.quotedImages({message_type:103,msg_elements:[node]},3).length,0);
 const elements=Array.from({length:64},()=>({}));elements.push({attachments:[attachment]});
 assert.equal(api.quotedImages({message_type:103,msg_elements:elements},3).length,0);
 const one=api.quotedImages({message_type:103,msg_elements:[{msg_idx:'NOT-A-MESSAGE-ID',attachments:[attachment]}]},3)[0];
 assert.equal(one.sourceMessageId,undefined);
});
test('P4 a linked quoted image is read from the source cache before any fetch or model call',async()=>{
 const e=env();await e.DB.prepare('INSERT INTO image_notes VALUES(?,?,?,?,?,?)').bind('sha:v1','已缓存的猫','[]',0,'',Date.now()).run();
 await e.DB.prepare('INSERT INTO message_images VALUES(?,?,?)').bind('source',0,'sha:v1').run();
 const source={id:'source',sender:'a',body:'原图',meta:{media:[{kind:'image',url,contentType:'image/png'}]}};
 const latest={id:'ask',body:'这是什么图',meta:{replyTo:{kind:'member',targetId:'source'}}};
 const picks=api.pickImages([latest],latest,new Map([['source',source]]));assert.equal(picks[0].quoted,true);
 const old=globalThis.fetch;globalThis.fetch=()=>assert.fail('cached quoted image must not be fetched');
 try{const outcomes=await api.annotateTurn(e,picks);assert.equal(outcomes[0].status,'ok');assert.equal(outcomes[0].stage,'link');}finally{globalThis.fetch=old;}
});
function preview(own=false){return {id:'ask',sender:'b',body:'这是什么图',ts:'2026-11-13T00:00:00Z',mentioned:1,meta:{replyTo:{kind:'unknown',authorId:'a'},refMsgIdx:'unknown',
 ...(own?{media:[{kind:'image',url:url+'/own',contentType:'image/png'}]}:{}),
 quoted:{authorId:'a',authorName:'甲',text:'原图',media:[{kind:'image',url,contentType:'image/png',width:40,height:50}]}}};}
test('P4 an unavailable original falls back to preview media with its owner and cache slot distinct from own images',()=>{
 const latest=preview(true),picks=api.pickImages([latest],latest,new Map());
 assert.equal(picks.length,2);assert.equal(picks[1].quoted,true);assert.equal(picks[1].owner,'a');
 assert.equal(picks[1].messageId,'ask');assert.equal(picks[1].idx,1);assert.equal(picks[1].media.url,url);
});
test('P4 preview descriptions reach the answer under the quoted author, without persisting a guessed source ID',async()=>{
 const e=env(),latest=preview(),picks=api.pickImages([latest],latest,new Map());
 assert.equal(picks[0].owner,'a');
 const old=globalThis.fetch;globalThis.fetch=async target=>String(target).includes('api.deepseek.com')
  ? Response.json({choices:[{message:{content:'{"desc":"合成猫图","tags":[],"meme":false}'},finish_reason:'stop'}]})
  :new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
 try{assert.equal((await api.annotateTurn(e,picks))[0].status,'ok');}finally{globalThis.fetch=old;}
 const notes=await api.imageNotesFor(e,['ask']);const view=api.viewMessage(latest,new Map([['a','甲']]),new Map(),notes);
 assert.equal(view.material.quote.from,'甲');assert.match(view.material.quote.media[0],/甲.*合成猫图/);
 assert.equal((await e.DB.prepare('SELECT message_id FROM message_images').first()).message_id,'ask');
});
test('P4 a preview 403 yields an explicit failed-evidence placeholder and no invented description',async()=>{
 const e=env(),latest=preview(),picks=api.pickImages([latest],latest,new Map());
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:403});let outcomes;
 try{outcomes=await api.annotateTurn(e,picks);}finally{globalThis.fetch=old;}
 const notes=new Map();api.applyImageOutcomes(notes,outcomes);
 const view=api.viewMessage(latest,new Map([['a','甲']]),new Map(),notes,new Set(['ask:0']));
 assert.match(view.material.quote.media[0],/读取失败.*HTTP 403/);assert.match(view.material.quote.media[0],/请重发/);
 assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM message_images').first()).n,0);
});

test('rework quote budget counts 64 elements independently of their attachments',()=>{
 const elements=Array.from({length:70},(_,i)=>({author:{id:'owner'+i},attachments:[{...attachment,url:url+'/'+i}]}));
 const images=api.quotedImages({message_type:103,msg_elements:elements},100);
 assert.equal(images.length,64);
 assert.deepEqual(images.map(x=>x.owner),elements.slice(0,64).map(x=>x.author.id));
});
test('rework a single quoted element does not spend element budget on attachments',()=>{
 const attachments=Array.from({length:70},(_,i)=>({...attachment,url:url+'/'+i}));
 const raw={message_type:103,msg_elements:[{attachments}]};
 assert.equal(api.quotedImages(raw,100).length,70);
 assert.equal(api.quotedImages(raw).length,3);
});
