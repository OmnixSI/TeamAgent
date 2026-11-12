/** Local-only QR capability. Neither this URL nor success/cross-domain URLs may reach the cloud. */
export function validLoginQr(raw){
 if(typeof raw!=='string'||raw.length>240||!/^https:\/\//.test(raw))return false;
 try{
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return false;
  if(u.hostname==='b23.tv')return /^\/[A-Za-z0-9]{4,12}$/.test(u.pathname)&&!u.search;
  if(!['passport.bilibili.com','www.bilibili.com','account.bilibili.com'].includes(u.hostname))return false;
  if(!['/h5-app/passport/login/scan','/qrcode/h5/login','/h5/account-h5/auth/scan-web'].includes(u.pathname))return false;
  const keys=[...u.searchParams.keys()];
  if(new Set(keys).size!==keys.length||keys.some(k=>!['qrcode_key','oauthKey','navhide','from','callback'].includes(k)))return false;
  if(u.searchParams.has('callback')&&u.searchParams.get('callback')!=='close')return false;
  if(u.searchParams.has('navhide')&&u.searchParams.get('navhide')!=='1')return false;
  if(u.searchParams.has('from')&&u.searchParams.get('from')!=='')return false;
  const key=u.pathname==='/qrcode/h5/login'?'oauthKey':'qrcode_key';
  return /^[a-f0-9]{32}$/.test(u.searchParams.get(key)||'')&&!u.searchParams.has(key==='oauthKey'?'qrcode_key':'oauthKey');
 }catch{return false;}
}
