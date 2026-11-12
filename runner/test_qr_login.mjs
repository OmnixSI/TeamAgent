import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFetchClient} from './fetcher.mjs';
import {runLoginFlow} from './qr-login.mjs';
const values={SESSDATA:'FAKE-SESSION-PRIVATE',bili_jct:'FAKE-CSRF-PRIVATE',DedeUserID:'FAKE-USER-PRIVATE',buvid3:'FAKE-BUVID-PRIVATE'};
const key='a'.repeat(32),url='https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key='+key+'&from=';
async function fixture(t,codes=[86101,86090,0],extra={}){
 const home=await mkdtemp(join(tmpdir(),'team-qr-'));t.after(()=>rm(home,{recursive:true,force:true}));
 let time=10000,idx=0;const calls=[],states=[],auth=[],logs=[];
 const client=createFetchClient({now:()=>time,sleep:async ms=>time+=ms,random:()=>0,log:x=>logs.push(x),lookup:(_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4}]),request:(options,callback)=>{
  const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{
   calls.push(options);const res=new EventEmitter();res.statusCode=200;res.headers={};let body;
   if(options.path.includes('generate'))body={code:0,data:{qrcode_key:key,url:extra.url||url}};
   else if(options.path.includes('/spi')){res.statusCode=extra.spiRisk?412:200;body={code:0,data:{b_3:values.buvid3}};}
   else{const code=codes[Math.min(idx++,codes.length-1)];res.statusCode=code===412?412:200;body={code:0,data:{code,url:code===0?'https://passport.biligame.com/crossDomain?SESSDATA='+values.SESSDATA:'',refresh_token:'FAKE-REFRESH-PRIVATE'}};
    if(code===0)res.headers['set-cookie']=Object.entries(values).filter(([name])=>name!=='buvid3').map(([name,value])=>name+'='+value+'; Domain=.bilibili.com; Expires=Mon, 18 Jan 2038 00:00:00 GMT; Path=/; Secure');}
   callback(res);queueMicrotask(()=>{res.emit('data',Buffer.from(JSON.stringify(body)));res.emit('end');});
  };return req;
 }});
 const cloud=async(path,body)=>{assert.equal(path,'login-state');states.push(body);if(extra.cancel&&states.length>=extra.cancel){const e=Error('conflict');e.status=409;throw e;}return {ok:true};};
 const options={home,client,now:()=>time,sleep:async ms=>time+=ms,auth:{withLoginLock:async(_service,run)=>run(),record:async(service,state)=>auth.push({service,state}),login:extra.xLogin},cloud};
 return {home,client,calls,states,auth,logs,options,login:{id:'flow',service:'bili',expires_at:310000},get time(){return time;}};
}
test('QR waiting/scanned/ok saves exactly four private fields, fills buvid anonymously and exports no credentials',async t=>{
 const f=await fixture(t),wait=f.options.sleep,local=[];
 f.options.sleep=async ms=>{
  const file=join(f.home,'state/login-qr/bili-flow.json');
  local.push(JSON.parse(await readFile(file,'utf8')));
  assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal((await stat(join(f.home,'state/login-qr'))).mode&0o777,0o700);
  await wait(ms);
 };
 assert.equal(await runLoginFlow(f.login,f.options),'ok');assert.equal(local[0].qr_url,url);
 await assert.rejects(readFile(join(f.home,'state/login-qr/bili-flow.json')));
 const file=join(f.home,'secrets/bili-cookie.json'),saved=JSON.parse(await readFile(file,'utf8'));
 assert.deepEqual(Object.keys(saved).sort(),Object.keys(values).sort());for(const [name,value] of Object.entries(values))assert.equal(saved[name].value,value);
 assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(join(f.home,'secrets'))).mode&0o777,0o700);
 assert.deepEqual(f.states.map(x=>x.phase),['waiting','waiting','scanned','scanned','ok']);assert.ok(f.states.every(x=>!('qr_url' in x)));
 assert.deepEqual(f.auth,[{service:'bili',state:'ok'}]);assert.equal(f.states.at(-1).qr_url,undefined);
 const spi=f.calls.find(x=>x.host==='api.bilibili.com');assert.ok(spi.path.startsWith('/x/frontend/finger/spi'));assert.equal(spi.headers.Cookie,undefined);
 assert.ok(f.calls.filter(x=>x.path.includes('/qrcode/')).every(x=>x.host==='passport.bilibili.com'&&!x.headers.Cookie));
 for(const secret of [...Object.values(values),'FAKE-REFRESH-PRIVATE',key,url,encodeURIComponent(url),Buffer.from(url).toString('base64')])assert.ok(!JSON.stringify([f.states,f.logs,f.auth]).includes(secret));
 assert.ok(!f.client.sanitize(Object.values(values).join(' ')).includes('PRIVATE'));
});
test('QR expiry and five-minute timeout finish without credential files or QR',async t=>{
 for(const [codes,deadline] of [[[86038],310000],[[86101],13000]]){
  const f=await fixture(t,codes);f.login.expires_at=deadline;
  assert.equal(await runLoginFlow(f.login,f.options),'expired');assert.equal(f.states.at(-1).qr_url,undefined);
  await assert.rejects(readFile(join(f.home,'secrets/bili-cookie.json')));
   await assert.rejects(readFile(join(f.home,'state/login-qr/bili-flow.json')));
 }
});
test('QR cancellation stops polling and prevents credential persistence',async t=>{
 const f=await fixture(t,[0],{cancel:2});assert.equal(await runLoginFlow(f.login,f.options),'cancelled');
 assert.equal(f.calls.filter(x=>x.path.includes('/poll')).length,1);await assert.rejects(readFile(join(f.home,'secrets/bili-cookie.json')));
 await assert.rejects(readFile(join(f.home,'state/login-qr/bili-flow.json')));
});
test('passport risk stops immediately and shares the fetch pause; unsafe generation URL never leaves local process',async t=>{
 const f=await fixture(t,[412]);assert.equal(await runLoginFlow(f.login,f.options),'failed');assert.equal(f.client.isPaused(),true);
 assert.equal(f.calls.length,2);assert.equal(f.states.at(-1).reason,'risk');assert.equal(f.states.at(-1).qr_url,undefined);
 await assert.rejects(f.client.biliApi('/x'));assert.equal(f.calls.length,2);
 const bad=await fixture(t,[0],{url:'https://evil.example/scan'});assert.equal(await runLoginFlow(bad.login,bad.options),'failed');assert.ok(!JSON.stringify(bad.states).includes('evil.example'));
});
test('risk during optional buvid fill keeps successful credentials, empty buvid and successful login',async t=>{
 const f=await fixture(t,[0],{spiRisk:true});assert.equal(await runLoginFlow(f.login,f.options),'ok');
 const saved=JSON.parse(await readFile(join(f.home,'secrets/bili-cookie.json'),'utf8'));
 assert.equal(saved.SESSDATA.value,values.SESSDATA);assert.equal(saved.buvid3.value,'');assert.equal(f.client.isPaused(),true);
 assert.equal(f.calls.filter(x=>x.path.includes('/spi')).length,1);assert.equal(f.states.at(-1).phase,'ok');
});
test('X delegates to local browser auth and reports only waiting and final state without QR',async t=>{
 const f=await fixture(t,[],{xLogin:async(service,control)=>{assert.equal(service,'x');assert.ok(control.signal);await control.onOpened();return 'ok';}});
 f.login.service='x';assert.equal(await runLoginFlow(f.login,f.options),'ok');assert.equal(f.calls.length,0);
 assert.ok(f.states.every(x=>!x.qr_url));assert.equal(f.states.at(-1).phase,'ok');
 assert.equal(f.states[0].phase,'waiting');
});
