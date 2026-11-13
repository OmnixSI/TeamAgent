import {wbiSign} from './fetcher.mjs';
const BV=/^BV[0-9A-Za-z]{10}$/;
export const VOUCHER_PAUSE_MS=30*60*1000;
export const VOUCHER_PAUSE_LONG_MS=60*60*1000;
// Search challenges are cheap to recover from: 30 minutes, or an hour after three a day.
export function createVoucherPause(now=Date.now){
 let day='',count=0;
 return ()=>{
  const date=new Date(now()),key=[date.getFullYear(),date.getMonth()+1,date.getDate()].join('-');
  if(key!==day){day=key;count=0;}
  count+=1;
  return count>=3?VOUCHER_PAUSE_LONG_MS:VOUCHER_PAUSE_MS;
 };
}
const vouchers=new WeakMap();
function voucherPause(client){
 let pause=vouchers.get(client);
 if(!pause){pause=createVoucherPause();vouchers.set(client,pause);}
 return pause();
}
export const normTitle=s=>s.normalize('NFKC').replace(/\s+/gu,' ').trim();
export function stripHl(value){
 const names={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
 return String(value).replace(/<\/?em\b[^>]*>/gi,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(raw,key)=>{
  if(key[0]!=='#')return names[key.toLowerCase()];
  const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
  return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):raw;
 });
}
export function pickByTitle(results,title){
 const list=results.filter(x=>x?.type==='video'&&BV.test(x.bvid)&&typeof x.title==='string');
 const hits=[...new Map(list.filter(x=>normTitle(stripHl(x.title))===normTitle(title)).map(x=>[x.bvid,x])).values()];
 return hits.length===1?hits[0]:{miss:!list.length?'none':hits.length>1?'multiple':'near'};
}
export async function biliByTitle(client,title){
 if(client.isPaused())throw Error('风控');
 if(client.isSearchPaused())throw Object.assign(Error('风控'),{scope:'search'});
 const keys=await client.prepare(true);if(!keys)throw Error('抓取失败');
 const response=await client.biliApi('/x/web-interface/wbi/search/type',wbiSign({search_type:'video',keyword:title,page:1,order:'totalrank'},...keys),{anonymous:true});
 // A successful HTTP/code response may carry a verification challenge, not search results.
 if(response.data?.v_voucher){client.pauseSearch(voucherPause(client));throw Object.assign(Error('风控'),{scope:'search'});}
 if(response.code!==0||!Array.isArray(response.data?.result)&&response.data?.numResults!==0)throw Error('抓取失败');
 const picked=pickByTitle(response.data?.result||[],title);
 return picked.bvid?client.biliLight(picked.bvid):picked;
}
