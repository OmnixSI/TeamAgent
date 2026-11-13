import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const outfile=`.wrangler/event-wake-${process.pid}.mjs`;
await build({entryPoints:['src/event/wake.ts'],bundle:true,platform:'browser',format:'esm',outfile});
const {forceReply}=await import('../'+outfile);
const context={selfId:'bot-a',nicknames:['Bot','小助手'],replyToBot:false};
const event=(segments=[],extra={})=>({kind:'message',type:'GROUP_MESSAGE_CREATE',id:'m',groupId:'g',actor:{id:'member',name:'成员',bot:false},ts:0,segments,mentionsBot:false,...extra});
test('P5 normalized bot mention and self-mention segments force a reply',()=>{
 assert.equal(forceReply(event([],{mentionsBot:true}),context),true);
 assert.equal(forceReply(event([{type:'mention',id:'unknown',self:true}]),context),true);
});
test('P5 configured self ID resolves a protocol mention without trusting display names',()=>{
 assert.equal(forceReply(event([{type:'mention',id:'bot-a',self:false}]),context),true);
 assert.equal(forceReply(event([{type:'mention',id:'other',name:'Bot',self:false}]),context),false);
});
test('P5 the same quoted event wakes only the bot whose identity it references',()=>{
 const ne=event([{type:'reply',refIdx:'ref',preview:{authorId:'bot-a',segments:[]}}]);
 assert.equal(forceReply(ne,context),true);
 assert.equal(forceReply(ne,{...context,selfId:'bot-b'}),false);
});
test('P5 resolved reply identity is supplied by the caller even if the preview is absent',()=>{
 assert.equal(forceReply(event(),{...context,replyToBot:true}),true);
 assert.equal(forceReply(event(),context),false);
});
test('P5 nickname calls at the start accept punctuation, spaces and Chinese continuation',()=>{
 for(const text of ['Bot，在吗','  bot: hello','Bot你好','小助手帮我看一下','Bot'])
  assert.equal(forceReply(event([{type:'text',text}]),context),true,text);
 for(const text of ['Botanical garden','有人说Bot在吗','https://Bot.example/a','只是聊天'])
  assert.equal(forceReply(event([{type:'text',text}]),context),false,text);
});
test('P5 nickname regex characters are literal and empty names do not wake every message',()=>{
 assert.equal(forceReply(event([{type:'text',text:'a+b，帮忙'}]),{...context,nicknames:['a+b']}),true);
 assert.equal(forceReply(event([{type:'text',text:'ab，帮忙'}]),{...context,nicknames:['a+b']}),false);
 assert.equal(forceReply(event([{type:'text',text:'普通原话'}]),{...context,nicknames:['','  ']}),false);
});
test('P5 mentions and names inside quotes, cards and forwards never become a wake command',()=>{
 for(const segment of [
  {type:'reply',refIdx:'r',preview:{authorId:'other',segments:[{type:'mention',id:'bot-a',self:true}]}},
  {type:'forward',nodes:[{segments:[{type:'text',text:'Bot，帮忙'},{type:'mention',id:'bot-a',self:true}]}],truncated:false},
  {type:'card',card:{type:'card',title:'Bot，帮忙'}},
 ])assert.equal(forceReply(event([segment]),context),false);
 assert.equal(forceReply(event([{type:'mention',id:'other',self:false},{type:'text',text:'Bot，帮忙'}]),context),false);
});
test('P5 bot actors, self actors and notices are filtered even if addressed',()=>{
 for(const extra of [{actor:{id:'other-bot',name:'',bot:true}},{actor:{id:'bot-a',name:'',bot:false}},{kind:'notice'}])
  assert.equal(forceReply(event([],{mentionsBot:true,...extra}),context),false);
});
test('P5 wake evaluation is pure and does not rewrite event or context',()=>{
 const ne=event([{type:'text',text:'Bot，帮忙'}]),before=JSON.stringify([ne,context]);
 forceReply(ne,context);assert.equal(JSON.stringify([ne,context]),before);
});
