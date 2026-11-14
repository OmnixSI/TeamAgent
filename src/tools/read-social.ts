import type {BotTool} from '../toolkit';
import {CHANNELS,REACH_BOUNDARY_TEXT,validTarget} from '../reach-contract.mjs';
import {requestReach,reachSettings} from '../reachjobs';
export {REACH_BOUNDARY_TEXT};
const inputKeys=new Set(['url','channel','action','target']);
const X_RESERVED=new Set(['home','explore','search','notifications','messages','i','settings','login','logout','signup','tos','privacy','compose','intent','share','hashtag','lists','bookmarks','jobs','premium','verified','account','about','help']);
function checkedUrl(value:string){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||![...Object.values(CHANNELS)].some((c:any)=>[...c.hosts,...c.short].includes(u.hostname)))throw Error('unsupported');
 return u;
}
export async function resolveSocialTarget(args:any):Promise<{channel:string;action:string;target:string}>{
 if(!args||typeof args!=='object'||Object.keys(args).some(k=>!inputKeys.has(k)))throw Error('unsupported');
 if(args.url){
  if(typeof args.url!=='string'||args.url.length>4096||args.target||args.channel||args.action)throw Error('unsupported');
  let u=checkedUrl(args.url);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),3000);
  try{
   for(let i=0;i<6;i++){
    const info=Object.values(CHANNELS).find((c:any)=>c.short.includes(u.hostname)&&!c.hosts.includes(u.hostname));
    if(!info)break;
    const r=await fetch(u.href,{method:'HEAD',redirect:'manual',signal:controller.signal});await r.body?.cancel();
    const location=r.headers.get('location');if(![301,302,303,307,308].includes(r.status)||!location)throw Error('unsupported');
    u=checkedUrl(new URL(location,u).href);
   }
  }finally{clearTimeout(timer);}
  const channel=Object.keys(CHANNELS).find(c=>CHANNELS[c].hosts.includes(u.hostname));if(!channel)throw Error('unsupported');
  let action='read';
  if(channel==='x'){
   const status=u.pathname.match(/^\/(?:i\/(?:web\/)?status|[A-Za-z0-9_]{1,15}\/status)\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/);
   if(status){action='thread';return {channel,action,target:'https://x.com'+u.pathname.replace(/\/(?:photo|video)\/\d+\/?$/,'').replace(/\/$/,'')};}
   const profile=u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
   if(profile&&!X_RESERVED.has(profile[1].toLowerCase()))return {channel,action:'profile',target:profile[1]};
   throw Error('unsupported');
  }
  if(channel==='xueqiu'){if(!/^\/S\/[A-Z0-9.]+\/?$/i.test(u.pathname))throw Error('unsupported');action='quote';}
  if(channel==='weibo'){const m=u.pathname.match(/^\/u\/(\d+)\/?$/);if(m)return {channel,action:'profile',target:m[1]};}
  if(!validTarget(channel,action,u.href))throw Error('unsupported');
  return {channel,action,target:u.href};
 }
 if(!validTarget(args.channel,args.action,args.target))throw Error('unsupported');
 return {channel:args.channel,action:args.action,target:args.target};
}
export const readSocialTool:BotTool={
 name:'read_social',switch:'reach',untrusted:true,
 def:{type:'function',function:{name:'read_social',description:'按成员主动请求，只读社交平台链接或搜索；长读取进入本机队列，未取得结果不能声称已读。X 登录后的推文串、用户资料/最近推文、搜索走本机登录会话；B站和公开单条推文优先使用原有读取。'+REACH_BOUNDARY_TEXT,
  parameters:{type:'object',properties:{url:{type:'string'},channel:{type:'string',enum:Object.keys(CHANNELS)},action:{type:'string',enum:['read','search','hot','quote','profile','thread','tweets','comments']},target:{type:'string'}},additionalProperties:false}}},
 async run(e,args,ctx){
  const latest=ctx?.context?.latest,source=ctx?.source||latest;
  const fail=(kind:string)=>({ok:false,error_kind:kind,next_action:'需要成员主动提供支持的链接或明确查询；目前不能声称读过内容。'});
  if(!latest?.group_id||!source?.id)return fail('unsupported');
  // Member-authored text is the only trigger. Quoted/web content cannot schedule a social crawl.
  const body=typeof source.body==='string'?source.body:'';
  if(!(typeof args?.url==='string'&&body.includes(args.url))&&!(typeof args?.target==='string'&&body.includes(args.target)&&/搜|查|读|看|分析|search|read|quote/i.test(body)))return fail('unsupported');
  // Check switches before short-link expansion, so disabling Reach makes zero platform requests.
  let channel=args?.channel;
  if(args?.url){try{const host=checkedUrl(args.url).hostname;channel=Object.keys(CHANNELS).find(c=>[...CHANNELS[c].hosts,...CHANNELS[c].short].includes(host));}catch{return fail('unsupported');}}
  if(!(await reachSettings(e,channel||'')).on)return {ok:false,error_kind:'tool_not_ready',next_action:'该平台读取尚未开启。'};
  let r;try{r=await resolveSocialTarget(args);}catch{return fail('unsupported');}
  return requestReach(e,r,latest.group_id,source.id);
 },
};
