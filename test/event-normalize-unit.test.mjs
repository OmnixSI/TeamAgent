import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const outfile=`.wrangler/event-normalize-unit-${process.pid}.mjs`;
await build({entryPoints:['src/event/normalize.ts'],bundle:true,platform:'browser',format:'esm',outfile});
const {normalize}=await import('../'+outfile);
const image='https://multimedia.nt.qq.com.cn/image';
const base={id:'m',group_openid:'g',author:{member_openid:'u',username:'成员'},timestamp:'2026-11-13T00:00:00Z'};
test('P1 identifiers, actor, timestamp and padded reference indices survive normalization',()=>{
 const ne=normalize('GROUP_MESSAGE_CREATE',{...base,content:'原话',message_scene:{ext:['msg_idx=I==','ref_msg_idx=R==']}});
 assert.equal(ne.id,'m');assert.equal(ne.groupId,'g');assert.deepEqual(ne.actor,{id:'u',name:'成员',bot:false});
 assert.equal(ne.ts,Date.parse(base.timestamp));assert.equal(ne.msgIdx,'I==');assert.equal(ne.refIdx,'R==');assert.equal(ne.kind,'message');
 assert.equal(ne.segments[0].text,'原话');
});
test('P1 protocol mentions stay ordered and is_you and AT events wake the bot',()=>{
 const ne=normalize('GROUP_MESSAGE_CREATE',{...base,content:'A<@BOT>B<@!other>C',mentions:[{member_openid:'BOT',nickname:'机器人',is_you:true},{id:'other',username:'别人'}]});
 assert.deepEqual(ne.segments.slice(0,5).map(s=>s.type),['text','mention','text','mention','text']);
 assert.equal(ne.segments[1].self,true);assert.equal(ne.segments[3].self,false);assert.equal(ne.mentionsBot,true);
 assert.equal(normalize('GROUP_AT_MESSAGE_CREATE',base).mentionsBot,true);
 assert.equal(normalize('GROUP_MESSAGE_CREATE',{...base,content:'<@other>原话',mentions:[{id:'other'}]}).mentionsBot,false);
});
test('P1 101 elements become current prose and media rather than a reply preview',()=>{
 const ne=normalize('GROUP_MESSAGE_CREATE',{...base,message_type:101,msg_elements:[{content:'正文A'},{text_element:{content:'正文B'},attachments:[{url:image,content_type:'image/png'}]}]});
 assert.equal(ne.segments.filter(s=>s.type==='text').map(s=>s.text).join(''),'正文A正文B');
 assert.equal(ne.segments.find(s=>s.type==='image').origin,'own');assert.equal(ne.segments.some(s=>s.type==='reply'),false);
});
test('P1 102 records remain forward nodes with authors and 103 remains a reply',()=>{
 const forward=normalize('GROUP_MESSAGE_CREATE',{...base,message_type:102,msg_elements:[{author:{id:'a',username:'甲'},content:'转发原话'}]});
 assert.equal(forward.segments[0].type,'forward');assert.equal(forward.segments[0].nodes[0].authorId,'a');
 assert.equal(forward.segments[0].nodes[0].authorName,'甲');assert.equal(forward.segments[0].nodes[0].segments[0].text,'转发原话');
 const reply=normalize('GROUP_MESSAGE_CREATE',{...base,message_type:103,msg_elements:[{msg_idx:'quoted==',author:{id:'a',username:'甲'},content:'引用原话',attachments:[{url:image,content_type:'image/png'}]}]});
 const s=reply.segments.find(s=>s.type==='reply');assert.equal(s.refIdx,'quoted==');assert.equal(s.preview.authorId,'a');
 assert.equal(s.preview.segments.find(s=>s.type==='image').owner,'a');assert.equal(s.preview.segments.find(s=>s.type==='image').origin,'quote');
 assert.equal(reply.segments.some(s=>s.type==='text'),false);
});
test('P1 mixed typed elements keep 101 prose separate from 103 material',()=>{
 const ne=normalize('GROUP_MESSAGE_CREATE',{...base,msg_elements:[{message_type:101,content:'新正文'},{message_type:103,content:'旧原话',msg_idx:'r'}]});
 assert.equal(ne.segments.find(s=>s.type==='text').text,'新正文');
 assert.equal(ne.segments.find(s=>s.type==='reply').preview.segments[0].text,'旧原话');
});
test('P1 all media preserve their type, origin, owner and available attributes',()=>{
 const ne=normalize('GROUP_MESSAGE_CREATE',{...base,attachments:[
  {content_type:'image/gif',url:image,width:32,height:48,size:200},
  {content_type:'audio/ogg',url:image+'/voice',asr_refer_text:'语音原话',wav_url:image+'/wav'},
  {content_type:'video/mp4',url:image+'/video',filename:'v.mp4',size:300},
  {content_type:'application/pdf',url:image+'/file',filename:'f.pdf',size:400}]});
 assert.deepEqual(ne.segments.map(s=>s.type),['image','voice','video','file']);
 assert.ok(ne.segments.every(s=>s.owner==='u'&&s.origin==='own'));assert.equal(ne.segments[0].animated,true);
 assert.equal(ne.segments[0].w,32);assert.equal(ne.segments[1].asr,'语音原话');assert.equal(ne.segments[1].wavUrl,image+'/wav');
 assert.equal(ne.segments[2].filename,'v.mp4');assert.equal(ne.segments[3].size,400);
});
test('P1 face tags are structured material and keep their position',()=>{
 const ne=normalize('GROUP_MESSAGE_CREATE',{...base,content:'前[<face,id=1/>]后<faceType=6,faceId=2,ext="x">'});
 assert.deepEqual(ne.segments.map(s=>s.type),['text','face','text','face']);assert.equal(ne.segments[1].id,'1');assert.equal(ne.segments[3].id,'2');
});
for(const [type,notice] of [['GROUP_ADD_ROBOT','bot_added'],['GROUP_DEL_ROBOT','bot_removed'],['GROUP_MSG_REJECT','active_rejected'],['GROUP_MSG_RECEIVE','active_allowed']])
 test('P1 rawEvent '+type+' normalizes as a notice, including missing actor',()=>{
  const ne=normalize(type,{group_openid:'g',timestamp:base.timestamp});
  assert.equal(ne.kind,'notice');assert.equal(ne.notice,notice);assert.equal(ne.groupId,'g');assert.equal(ne.actor.id,'');assert.equal(ne.actor.bot,false);
  assert.deepEqual(ne.segments,[]);
  assert.equal(normalize(type,{group_openid:'g',op_member_openid:'actor'}).actor.id,'actor');
 });
test('P1 bot actors are marked for ingress filtering without promoting quoted actors',()=>{
 assert.equal(normalize('GROUP_MESSAGE_CREATE',{...base,author:{id:'bot',bot:true}}).actor.bot,true);
 assert.equal(normalize('GROUP_MESSAGE_CREATE',{...base,author:{id:'u',bot:'false'}}).actor.bot,false);
 assert.equal(normalize('GROUP_MESSAGE_CREATE',{...base,message_type:103,msg_elements:[{author:{id:'bot',bot:true},content:'旧话'}]}).actor.bot,false);
});
test('P1 malformed optional payload pieces and invalid timestamp do not throw',()=>{
 const ne=normalize('UNKNOWN',{mentions:[null,4],attachments:[null],msg_elements:[null],message_scene:{ext:[null,3]}});
 assert.equal(ne.type,'UNKNOWN');assert.ok(Number.isNaN(ne.ts));assert.deepEqual(ne.segments,[]);
});

for(const kind of [0,101])for(const source of ['both','element','content'])
 test(`rework 101 content priority (${kind}, ${source}) keeps images and mentions`,()=>{
  const content='大家早上好呀 <@bot>',raw={...base,message_type:kind,
   content:source==='element'?'':content,mentions:[{id:'bot',is_you:true}],
   msg_elements:[{message_type:101,content:source==='content'?'':content,mentions:[{id:'bot',is_you:true}],attachments:[{url:image,content_type:'image/png'}]}]};
  const ne=normalize('GROUP_MESSAGE_CREATE',raw);
  assert.equal(ne.segments.filter(s=>s.type==='text').map(s=>s.text).join(''),'大家早上好呀 ');
  assert.equal(ne.segments.filter(s=>s.type==='mention').length,1);
  assert.equal(ne.segments.find(s=>s.type==='mention').self,true);
  assert.equal(ne.segments.filter(s=>s.type==='image').length,1);
 });

for(const content of [' ', '\n', '', '真正的正文'])
 test('rework2 101 treats trimmed blank content as absent '+JSON.stringify(content),()=>{
  const ne=normalize('GROUP_MESSAGE_CREATE',{...base,content,message_type:101,
   msg_elements:[{message_type:101,content:'大家早上好呀',attachments:[{url:image,content_type:'image/png'}]}]});
  assert.equal(ne.segments.filter(s=>s.type==='text').map(s=>s.text).join('').trim(),content.trim()||'大家早上好呀');
  assert.equal(ne.segments.filter(s=>s.type==='image').length,1);
 });
