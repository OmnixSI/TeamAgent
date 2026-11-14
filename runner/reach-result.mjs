import {CHANNELS,publicSourceUrl,safeReachText,scopeFor} from './reach-contract.mjs';
export const validators=new Map();
export const nextActions=new Map();
export const NEXT_ACTION=Object.freeze({
 tool_not_ready:'读取组件尚未就绪，请维护者检查固定版本安装；本次不自动安装。',
 login_required:'需要本人在该平台官方页面完成登录后再主动读取。',
 platform_blocked:'平台触发验证或风控，停止该站点读取，等待冷却后再由成员主动尝试。',
 rate_limited:'上游限流，等待 retry_after 后再尝试。',timeout:'读取已超时并停止，不要猜测正文。',
 not_found:'平台确认未找到内容，请核对原链接。',unsupported:'此链接或动作不在只读支持范围，请提供支持的链接或明确查询。',
 upstream_unavailable:'上游暂不可用，不能据此判断未登录或内容已删除。',
 insufficient_content:'没有取得可信正文，只能说明读取不足，不能称已读全文。',busy:'读取端正忙，请稍后主动尝试。',
});
const mappings={NEED_SETUP:'tool_not_ready',NEED_LOGIN:'login_required',PLATFORM_BLOCKED:'platform_blocked',SECURITY_BLOCK:'platform_blocked',ACCOUNT_RISK:'platform_blocked',CAPTCHA_REQUIRED:'platform_blocked',RATE_LIMITED:'rate_limited',TIMEOUT:'timeout',NOT_FOUND:'not_found',BAD_INPUT:'unsupported',BUSY:'busy',UPSTREAM_BROKEN:'upstream_unavailable'};
function token(s){return typeof s==='string'&&/^[A-Z0-9_./:-]{1,64}$/i.test(s)&&!/cookie|token|secret/i.test(s)?s:undefined;}
export function normalizeReachResult(req,raw={},options={}){
 req=req&&typeof req==='object'?req:{};
 const channel=Object.hasOwn(CHANNELS,req.channel)?req.channel:'unknown';
 req={...req,channel,action:CHANNELS[channel]?.actions.includes(req.action)?req.action:'unknown',backend:['local','opencli','native','public-web'].includes(req.backend)?req.backend:'local'};
 const e=raw?.error||{},code=e.code||e.vendor_code||raw?.code;
 let kind=Object.hasOwn(NEXT_ACTION,e.error_kind)?e.error_kind:mappings[code];
 const status=Number(e.status||raw?.status||raw?.status_code);
 // Inspect bounded raw payload before dropping unapproved fields. Error shells can hide under data/raw.
 let evidence='';try{evidence=JSON.stringify(raw).slice(0,1024*1024);}catch{}
 if(status===412||code==='SECURITY_BLOCK'||/SECURITY_BLOCK|人机验证|请完成验证码|captcha_required|verify you are human|安全验证/i.test(evidence))kind='platform_blocked';
 else if(req.channel==='xiaohongshu'&&/300031|note.*unavailable/i.test(evidence))kind='insufficient_content';
 const input=Array.isArray(raw?.items)?raw.items:[];
 const items=input.slice(0,20).map(i=>({
  title:safeReachText(i?.title,300),text:safeReachText(i?.text,12000),author:safeReachText(i?.author,100),
  source_url:publicSourceUrl(i?.source_url||i?.url||req.target),
  published_at:Number.isFinite(Date.parse(i?.published_at))?new Date(i.published_at).toISOString():null,
 })).filter(i=>i.text.trim()||(scopeFor(req.action)==='search_results'&&i.title.trim()&&i.source_url));
 if(!kind&&raw?.ok===true){
  const validator=validators.get(req.channel);
  if(validator){try{kind=validator(raw,req)||undefined;}catch{kind='insufficient_content';}}
  if(!items.length)kind='insufficient_content';
  if(req.channel==='xiaohongshu'&&['read','comments'].includes(req.action)&&!items.some(i=>i.text.trim()&&i.author.trim()))kind='insufficient_content';
 }
 if(raw?.ok!==true&&!kind)kind='upstream_unavailable';
 if(kind&&!Object.hasOwn(NEXT_ACTION,kind))kind='insufficient_content';
 const retry=Number(e.retry_after||raw?.retry_after);
 const error=kind?{error_kind:kind,next_action:nextActions.get(req.channel)?.[kind]||NEXT_ACTION[kind],
  ...(token(code)?{vendor_code:code}:{}),...(token(e.stage)?{stage:e.stage}:{}),
  ...(Number.isFinite(retry)&&retry>0?{retry_after:Math.min(86400,Math.ceil(retry))}:{}),
 }:null;
 return {schema_version:1,ok:!kind,channel:req.channel,action:req.action,backend:token(req.backend)||'local',
  items:kind?[]:items,meta:{...(options.output_truncated||raw?.meta?.output_truncated?{output_truncated:true}:{})},error,
  source_url:publicSourceUrl(req.target||req.source_url),fetched_at:new Date().toISOString(),content_scope:scopeFor(req.action),
  // Completeness requires independently verified platform evidence; never trust a backend flag alone.
  completeness_verified:false,attempts:[{backend:token(req.backend)||'local',ok:!kind,...(kind?{error_kind:kind}:{})}]};
}
