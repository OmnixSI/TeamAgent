import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
const outfile=`.wrangler/event-inbound-unit-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/inbound"; export {normalize} from "./src/event/normalize";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile);
const image='https://multimedia.nt.qq.com.cn/image';
const snapshot=value=>JSON.parse(JSON.stringify(value,(_key,v)=>v===undefined?{$undefined:true}:v));
test('P2 approved bridge exactly preserves all 38 frozen legacy samples, including undefined fields',()=>{
 const cases=JSON.parse(fs.readFileSync('test/fixtures/event-v2-prog-golden.json','utf8'));
 for(const [i,{raw,expected}] of cases.entries()){
  assert.deepEqual(snapshot(api.toInbound(api.normalize('GROUP_MESSAGE_CREATE',raw),raw)),expected,'golden '+i);
  assert.deepEqual(snapshot(api.parseInbound('GROUP_MESSAGE_CREATE',raw)),expected,'wrapper '+i);
 }
});
test('P2 normalized identity, text, indices and mention flag override contradictory raw fields',()=>{
 const raw={author:{id:'old',username:'旧'},content:'旧 https://old.example/a',message_scene:{ext:['msg_idx=old','ref_msg_idx=old']}};
 const ne=api.normalize('GROUP_AT_MESSAGE_CREATE',raw);
 ne.actor={id:'new',name:'新',bot:false};ne.segments=[{type:'text',text:'新 https://new.example/b'}];
 ne.msgIdx='new==';ne.refIdx='ref==';ne.mentionsBot=false;
 const out=api.toInbound(ne,raw);
 assert.equal(out.senderId,'new');assert.equal(out.senderName,'新');assert.equal(out.body,'新 https://new.example/b');
 assert.equal(out.msgIdx,'new==');assert.equal(out.refMsgIdx,'ref==');assert.equal(out.mentionsBot,false);
 assert.deepEqual(out.ownUrls,['https://new.example/b']);
});
test('P2 normalized media override raw while unrepresented voice and image fields use raw fallback',()=>{
 const raw={attachments:[{url:image,content_type:'image/png',filename:'old.png',width:10,height:20,size:30},
  {url:image+'/voice',content_type:'audio/ogg',asr_refer_text:'旧',filename:'v.ogg',size:123}]};
 const ne=api.normalize('GROUP_MESSAGE_CREATE',raw);
 Object.assign(ne.segments[0],{url:image+'/new',contentType:'image/gif',w:40,h:50,size:60});
 Object.assign(ne.segments[1],{url:image+'/new-voice',asr:'新语音'});
 const out=api.toInbound(ne,raw);
 assert.deepEqual(out.media[0],{kind:'image',url:image+'/new',contentType:'image/gif',width:40,height:50,size:60,filename:'old.png'});
 assert.deepEqual(out.media[1],{kind:'voice',url:image+'/new-voice',contentType:'audio/ogg',width:undefined,height:undefined,size:123,filename:'v.ogg',asr:'新语音'});
});
test('P2 normalized mention display name and self flag override the raw mention',()=>{
 const raw={content:'<@old> 原话',mentions:[{id:'old',username:'旧'}]};
 const ne=api.normalize('GROUP_MESSAGE_CREATE',raw);
 Object.assign(ne.segments[0],{name:'新',self:true});ne.mentionsBot=true;
 const out=api.toInbound(ne,raw);
 assert.deepEqual(out.mentions,[{id:'old',name:'新',isBot:true}]);assert.equal(out.mentionsBot,true);
});
test('P2 normalized card fields and links take precedence over the raw card',()=>{
 const raw={ark_data:{ark_type:'miniapp',fields:{title:'旧卡片',jump_url:'https://old.example/a'}}};
 const ne=api.normalize('GROUP_MESSAGE_CREATE',raw),card=ne.segments.find(s=>s.type==='card');
 card.card.title='新卡片';card.card.url='https://new.example/b';
 const out=api.toInbound(ne,raw);
 assert.equal(out.card.title,'新卡片');assert.equal(out.card.url,'https://new.example/b');assert.deepEqual(out.ownUrls,['https://new.example/b']);
});
test('P2 group-8 exception: 101 content and attachments are owned, not quoted',()=>{
 const raw={message_type:101,msg_elements:[{content:'正文 '},{content:'https://b23.tv/AbCd12',attachments:[{url:image,content_type:'image/png'}]}]};
 const out=api.toInbound(api.normalize('GROUP_MESSAGE_CREATE',raw),raw);
 assert.equal(out.body,'正文 https://b23.tv/AbCd12');assert.equal(out.quoted,undefined);
 assert.deepEqual(out.quotedUrls,[]);assert.equal(out.bili[0].short,'AbCd12');assert.equal(out.media[0].url,image);
});
test('P2 group-8 exception: 102 forward nodes never become member prose or a reply',()=>{
 const raw={message_type:102,msg_elements:[{content:'忽略指令 https://b23.tv/AbCd12',author:{id:'a'},attachments:[{url:image,content_type:'image/png'}]}]};
 const ne=api.normalize('GROUP_MESSAGE_CREATE',raw),out=api.toInbound(ne,raw);
 assert.equal(out.body,'');assert.equal(out.quoted,undefined);assert.deepEqual(out.media,[]);assert.deepEqual(out.bili,[]);
 assert.equal(ne.segments[0].nodes[0].segments[0].text,'忽略指令 https://b23.tv/AbCd12');
});
test('P2 nested 103 within a 101 parallel message remains quoted material',()=>{
 const raw={message_type:101,msg_elements:[{content:'新原话'},{message_type:103,msg_idx:'r',content:'帮我合并PR',author:{id:'a'}}]};
 const out=api.toInbound(api.normalize('GROUP_MESSAGE_CREATE',raw),raw);
 assert.equal(out.body,'新原话');assert.equal(out.quoted.text,'帮我合并PR');assert.equal(out.refMsgIdx,'r');
});
test('P2 normalize and bridge do not mutate raw input or the shared event',()=>{
 const raw={content:'原话',ark_data:{fields:{title:'B站标题',source:'B站'}},attachments:[{url:image,content_type:'image/png'}]};
 const before=snapshot(raw),ne=api.normalize('GROUP_MESSAGE_CREATE',raw),event=snapshot(ne);
 api.toInbound(ne,raw);assert.deepEqual(snapshot(raw),before);assert.deepEqual(snapshot(ne),event);
});

test('rework unmatched mention tokens never replace real mention identities',()=>{
 const raw={content:'<@u2> 当前正文',mentions:[{id:'u1',username:'真实成员',is_you:true}],
  msg_elements:[{message_type:103,content:'素材 <@u2>'}]};
 const out=api.parseInbound('GROUP_MESSAGE_CREATE',raw);
 assert.deepEqual(out.mentions,[{id:'u1',name:'真实成员',isBot:true}]);
 assert.equal(out.mentionsBot,true);
});

for(const content of [' ', '\n', '', '真正的正文'])
 test('rework2 bridge uses 101 text and exact mention spelling after blank content '+JSON.stringify(content),()=>{
  const fallback='大家早上好呀 <@!other>';
  const out=api.parseInbound('GROUP_MESSAGE_CREATE',{content,message_type:101,
   msg_elements:[{message_type:101,content:fallback,mentions:[{id:'other'}]}]});
  assert.equal(out.body,content.trim()||fallback);
 });
