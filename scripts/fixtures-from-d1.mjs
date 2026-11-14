#!/usr/bin/env node
/**
 * Read-only D1 export for event-layer v2 fixtures.
 *
 *   CLOUDFLARE_API_TOKEN=... node scripts/fixtures-from-d1.mjs [--limit 500] [--out /tmp/ev-raw]
 *
 * Rules enforced here:
 * - exactly one SELECT (never INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/PRAGMA/ATTACH);
 * - the token is only read from the environment, never printed, logged or written;
 * - output goes to /tmp/ev-raw by default and contains sanitized samples only;
 * - openids, names, group ids, message ids, REFIDX values and media query tokens are replaced
 *   with stable synthetic values; Bilibili and ordinary web URLs are kept;
 * - every other run of text is replaced with an equal-length "测试文本" run, while <@...>
 *   mention tokens and <faceType=...> / [<face,id=.../>] tags stay verbatim.
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

const args=process.argv.slice(2);
const value=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const limit=Number(value('--limit','500'));
const out=resolve(value('--out','/tmp/ev-raw'));
if(!Number.isInteger(limit)||limit<1||limit>2000)throw Error('--limit must be an integer in 1..2000');
if(!process.env.CLOUDFLARE_API_TOKEN)throw Error('CLOUDFLARE_API_TOKEN is required');

const SQL=`SELECT m.id AS id,m.group_id AS group_id,m.sender AS sender,m.body AS body,m.ts AS ts,
 m.mentioned AS mentioned,mm.json AS meta
 FROM messages m JOIN message_meta mm ON mm.id=m.id ORDER BY m.rowid LIMIT ${limit}`;
if(!/^\s*(SELECT|WITH)\b/i.test(SQL)||/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|PRAGMA|VACUUM|REINDEX)\b/i.test(SQL))
 throw Error('refusing non read-only SQL');

function query(sql){
 let stdout='';
 try{
  stdout=execFileSync('npx',['wrangler','d1','execute','inkboard-team','--remote','--json','--command',sql],
   {encoding:'utf8',stdio:['ignore','pipe','pipe'],env:process.env,maxBuffer:64*1024*1024});
 }catch(error){
  // Never echo the command environment or the token.
  const detail=String(error?.stderr||error?.message||'').split('\n').filter(line=>/ERROR|error|✘/.test(line)).slice(0,3).join(' | ');
  throw Error('wrangler d1 execute failed'+ (detail?': '+detail.replace(/\b[A-Za-z0-9_-]{30,}\b/g,'<redacted>'):''));
 }
 const start=stdout.indexOf('[');
 if(start<0)throw Error('wrangler returned no JSON array');
 return JSON.parse(stdout.slice(start));
}

// Stable fake identities across the whole export.
const ids=new Map(),names=new Map(),refs=new Map(),urls=new Map();
const next=(map,key,make)=>{if(!map.has(key))map.set(key,make(map.size+1));return map.get(key);};
const uid=v=>next(ids,String(v||''),n=>'u'+n);
const pname=v=>next(names,String(v||''),n=>'成员'+String.fromCharCode(64+n));
const ref=v=>next(refs,String(v||''),n=>'REFIDX_SYNTH_'+String(n).padStart(4,'0'));
const media=v=>next(urls,String(v||''),n=>n);

const FACE=/<faceType=(?:ext="\{(?:[^{}"]|"(?:\\.|[^"\\])*")*\}"|"(?:\\.|[^"\\])*"|[^">])*>|\[<face,id=\d+\/>\]/;
const PROTECTED=new RegExp(`https?://[^\\s<>"'\\u3000-\\u303f]+|${FACE.source}|<@!?[^>]+>`,'g');
function masked(run){
 const unit='测试文本';
 let text=unit.repeat(Math.ceil(run.length/unit.length)).slice(0,run.length);
 if(/[\ud800-\udbff]$/.test(text))text=text.slice(0,-1)+'文';
 return text;
}
function maskText(input){
 const text=String(input??'');let result='',cursor=0;
 for(const match of text.matchAll(PROTECTED)){
  result+=masked(text.slice(cursor,match.index));
  result+=match[0];
  cursor=match.index+match[0].length;
 }
 result+=masked(text.slice(cursor));
 return result;
}
function fakeUrl(raw,contentType){
 const n=media(raw);
 if(contentType.startsWith('image/'))return `https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=synth-${n}&rkey=synthetic`;
 if(contentType.startsWith('video/'))return `https://multimedia.nt.qq.com.cn/video/synth-${n}.mp4`;
 if(contentType==='voice'||contentType.startsWith('audio/'))return `https://multimedia.nt.qq.com.cn/voice/synth-${n}`;
 return `https://hkc-download.ftn.qq.com/ftn_handler/synth-${n}?fname=synth-${n}`;
}
const fileNames=new Map();
function fileOf(name){
 const key=String(name||'');
 if(!fileNames.has(key)){
  const ext=/\.[A-Za-z0-9]{1,8}$/.exec(key)?.[0]||'';
  fileNames.set(key,`fixture-${fileNames.size+1}${ext.toLowerCase()}`);
 }
 return fileNames.get(key);
}
function sanitizeAttachment(a){
 if(!a||typeof a!=='object')return a;
 const contentType=String(a.content_type||'');
 return {...a,
  url:fakeUrl(a.url,contentType),
  ...(a.filename!==undefined?{filename:fileOf(a.filename)}:{}),
  ...(a.content!==undefined?{content:maskText(a.content)}:{}),
  ...(a.asr_refer_text!==undefined?{asr_refer_text:'语音转写文本'}:{}),
 };
}
const PLATFORM=/哔哩哔哩|bilibili|B站|小程序|群公告|QQ/i;
function imageFor(value){return /^https?:\/\//.test(String(value||''))?`https://multimedia.nt.qq.com.cn/card/synth-${media(value)}.png`:value;}
function sanitizeArk(ark){
 if(typeof ark==='string'){try{ark=JSON.parse(ark);}catch{return maskText(ark);}}
 if(!ark||typeof ark!=='object')return ark;
 const field=(key,value)=>{
  if(typeof value!=='string')return value;
  if(key==='jump_url')return value;
  if(key==='preview')return imageFor(value);
  if(key==='source_logo')return imageFor(value);
  if(key==='source'&&PLATFORM.test(value))return value;
  return maskText(value);
 };
 const fields=Array.isArray(ark.fields)
  ? ark.fields.map(f=>({...f,value:field(f.key,f.value)}))
  : ark.fields&&Object.fromEntries(Object.entries(ark.fields).map(([k,v])=>[k,field(k,v)]));
 return {...ark,...(fields===undefined?{}:{fields}),
  ...(ark.name!==undefined&&PLATFORM.test(String(ark.name))?{}:{...(ark.name!==undefined?{name:maskText(ark.name)}:{})}),
  ...(ark.ark_name!==undefined&&PLATFORM.test(String(ark.ark_name))?{}:{...(ark.ark_name!==undefined?{ark_name:maskText(ark.ark_name)}:{})}),
  ...(ark.prompt!==undefined?{prompt:maskText(ark.prompt)}:{})};
}
function sanitizeElement(el,depth=0){
 if(!el||typeof el!=='object'||depth>8)return el;
 return {...el,
  ...(el.author?{author:{id:uid(el.author.member_openid??el.author.id),username:pname(el.author.username)}}:{}),
  ...(el.content!==undefined?{content:maskText(el.content)}:{}),
  ...(el.text!==undefined?{text:maskText(el.text)}:{}),
  ...(el.attachments?{attachments:el.attachments.map(sanitizeAttachment)}:{}),
  ...(el.msg_elements?{msg_elements:el.msg_elements.map(x=>sanitizeElement(x,depth+1))}:{}),
  ...(el.ark_data?{ark_data:sanitizeArk(el.ark_data)}:{}),
  ...(el.msg_idx?{msg_idx:ref(el.msg_idx)}:{}),
  ...(el.mentions?{mentions:el.mentions.map(sanitizeMention)}:{}),
 };
}
function sanitizeMention(m){
 return {id:uid(m.member_openid??m.id),nickname:pname(m.nickname??m.username),... (m.is_you===undefined?{}:{is_you:!!m.is_you})};
}
function messageType(meta,elements){
 if(elements.some(el=>el?.message_type===102||el?.msg_elements))return 102;
 if(elements.some(el=>el?.message_type===103||el?.msg_idx))return 103;
 if(elements.some(el=>el?.message_type===101))return 101;
 return undefined;
}
function reconstruct(row,index){
 const meta=JSON.parse(row.meta||'{}'),elements=Array.isArray(meta.forwarded)?meta.forwarded:[];
 const usable=elements.every(el=>el&&typeof el==='object'&&el.message_type!==undefined)
  && !elements.some(el=>/^===\s*消息/.test(String(el.content||'')));
 const type=messageType(meta,elements);
 const ext=[meta.msgIdx?`msg_idx=${ref(meta.msgIdx)}`:null,meta.refMsgIdx?`ref_msg_idx=${ref(meta.refMsgIdx)}`:null].filter(Boolean);
 const d={
  id:'m'+String(index+1).padStart(4,'0'),
  group_openid:'GROUP000001',
  timestamp:'2026-11-13T00:00:00.000Z',
  author:{id:uid(row.sender),username:pname(meta.senderName||row.sender),bot:false},
  content:maskText(row.body),
  ...(type?{message_type:type}:{}),
  ...(ext.length?{message_scene:{ext}}:{}),
  ...(meta.attachments?.length?{attachments:meta.attachments.map(sanitizeAttachment)}:{}),
  ...(elements.length?{msg_elements:elements.map(e=>sanitizeElement(e))}:{}),
  ...(meta.card?{ark_data:sanitizeArk(meta.card)}:{}),
  ...(meta.mentions?.length?{mentions:meta.mentions.map(sanitizeMention)}:{}),
 };
 return {d,features:{
  hasElements:elements.length>0,type:type||null,quoted:!!meta.quoted,msgIdx:!!meta.msgIdx,refMsgIdx:!!meta.refMsgIdx,
  images:(meta.attachments||[]).filter(a=>String(a.content_type||'').startsWith('image/')).length,
  faces:/<faceType|\[<face,id=/.test(String(row.body||''))||elements.some(el=>/<faceType/.test(String(el?.content||''))),
  mentions:(meta.mentions||[]).length,card:!!meta.card,bili:!!meta.bili?.length,
 },usable};
}

const payload=query(SQL);
const rows=payload[0]?.results||[];
const samples=[];
rows.forEach((row,index)=>{
 const rebuilt=reconstruct(row,index);
 if(rebuilt.usable&&(rebuilt.d.content||rebuilt.d.msg_elements?.length||rebuilt.d.attachments?.length||rebuilt.d.ark_data))
  samples.push({source:'d1',originId:index+1,...rebuilt});
});
mkdirSync(out,{recursive:true});
const stats={
 generatedAt:new Date().toISOString(),rows:rows.length,samples:samples.length,
 withElements:samples.filter(s=>s.features.hasElements).length,
 types:samples.reduce((all,s)=>{const key=String(s.features.type);all[key]=(all[key]||0)+1;return all;},{}),
 quoted:samples.filter(s=>s.features.quoted).length,
 images:samples.reduce((n,s)=>n+s.features.images,0),
 faces:samples.filter(s=>s.features.faces).length,
 mentions:samples.filter(s=>s.features.mentions).length,
 cards:samples.filter(s=>s.features.card).length,
 bili:samples.filter(s=>s.features.bili).length,
};
writeFileSync(join(out,'live.json'),JSON.stringify({source:'d1',stats,samples},null,2));
writeFileSync(join(out,'manifest.json'),JSON.stringify({source:'d1',stats,ids:ids.size,names:names.size,refs:refs.size,media:urls.size},null,2));
console.log(JSON.stringify({out,stats}));
