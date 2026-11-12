/** Short-lived QR capability shared only with the guarded loopback owner process. */
import {mkdir,chmod,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validLoginQr} from './login-url.mjs';
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(id);
function pathOf(home,id){if(!validId(id))throw Error('invalid local login');return resolve(home,'state/login-qr','bili-'+id+'.json');}
export async function publishLocalQr(home,login,qr){
 if(login.service!=='bili'||!validLoginQr(qr)||!Number.isFinite(login.expires_at))throw Error('invalid local QR');
 const path=pathOf(home,login.id),directory=resolve(home,'state/login-qr');
 await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
 const temp=path+'.tmp-'+randomUUID();
 try{
  await writeFile(temp,JSON.stringify({id:login.id,service:'bili',qr_url:qr,expires_at:login.expires_at}),{mode:0o600,flag:'wx'});
  await chmod(temp,0o600);await rename(temp,path);
 }finally{await unlink(temp).catch(()=>{});}
}
export async function clearLocalQr(home,id){if(validId(id))await unlink(pathOf(home,id)).catch(()=>{});}
