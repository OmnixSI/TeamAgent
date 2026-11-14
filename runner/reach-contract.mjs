/** TeamAgent-owned contract. No third-party runtime or setup is executed. */
export const REACH_BOUNDARY_TEXT='这些平台的读取有服务条款和账号受限风险；只在成员主动给链接或明确提问时只读访问，不批量或定时抓取。';
const scopes={read:'post_text',thread:'post_text',search:'search_results',hot:'search_results',quote:'quote',profile:'post_text',comments:'loaded_comments'};
export const CHANNELS=Object.freeze({
 xiaohongshu:{hosts:['www.xiaohongshu.com','xiaohongshu.com'],short:['xhslink.com'],actions:['read','search','comments','profile']},
 x:{hosts:['x.com','www.x.com','twitter.com','www.twitter.com'],short:['t.co'],actions:['thread','search','profile']},
 xueqiu:{hosts:['xueqiu.com','www.xueqiu.com'],short:[],actions:['quote','search','hot']},
 weibo:{hosts:['weibo.com','www.weibo.com','m.weibo.cn'],short:['weibo.cn'],actions:['read','search','hot','profile','comments']},
 zhihu:{hosts:['www.zhihu.com','zhihu.com'],short:['zhihu.com'],actions:['read','search','hot','profile']},
 douyin:{hosts:['www.douyin.com','douyin.com'],short:['v.douyin.com'],actions:['read']},
 weixin:{hosts:['mp.weixin.qq.com'],short:[],actions:['read','search']},
});
export function scopeFor(action){return scopes[action]||'post_text';}
export function publicSourceUrl(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')return '';const identity=new URLSearchParams();for(const key of ['__biz','id','idx','mid']){const v=u.searchParams.get(key);if(v&&/^[A-Za-z0-9+/_=-]{1,128}$/.test(v))identity.set(key,v);}return u.origin+u.pathname+(identity.size?'?'+identity.toString():'');}catch{return '';}
}
export function safeReachText(value,max=12000){
 if(typeof value!=='string')return '';
 return value.replace(/(?:cookie|set-cookie|authorization)\s*[:=][^\r\n]*/gi,'[已过滤]')
  .replace(/(?:xsec_token|auth_token|access_token|api[_-]?key|password|sessionid)\s*[=:]\s*[^\s&"'<>]+/gi,'[已过滤]')
  .replace(/https?:\/\/[^\s<>"']+/g,s=>publicSourceUrl(s)||'[链接已过滤]').slice(0,max);
}
export function validTarget(channel,action,target){
 if(!Object.hasOwn(CHANNELS,channel)||!CHANNELS[channel].actions.includes(action)||typeof target!=='string'||target.length>4096)return false;
 let decoded=target;try{for(let n=0;n<3;n++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}}catch{return false;}
 if(/[;|`$<>\\\u0000-\u001f\u007f]/.test(decoded))return false;
 if(/^https:\/\//.test(target)){
  try{
   const u=new URL(target);
   if(u.username||u.password||(u.port&&u.port!=='443')||!CHANNELS[channel].hosts.includes(u.hostname))return false;
   // Xiaohongshu detail pages only resolve with the signature returned by search or the original link.
   if(channel==='xiaohongshu'&&['read','comments'].includes(action)&&!u.searchParams.get('xsec_token')?.trim())return false;
   return true;
  }catch{return false;}
 }
 if(['read','thread','comments'].includes(action))return false;
 if(action==='quote')return /^(?:SH|SZ|HK|US)?[A-Z0-9.]{1,12}$/i.test(target);
 if(action==='profile')return /^[\w-]{1,80}$/.test(target);
 return !!target.trim()&&target.length<=200&&!/[&]/.test(decoded)&&!target.startsWith('-');
}
