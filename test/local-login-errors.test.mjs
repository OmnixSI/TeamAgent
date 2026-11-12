import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const page=readFileSync('runner/local_login_page.py','utf8'),script=page.match(/<script>([\s\S]*)<\/script>/)[1];
async function ui(startError){
 const nodes=new Map(),timers=new Map();let counter=0;
 class Node{constructor(){this.textContent='';this.hidden=true;this.children=[];}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(){}}
 const get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const context=vm.createContext({document:{getElementById:get,createElementNS:()=>new Node()},sessionStorage:{getItem:()=> 'synthetic-session',setItem(){}},location:{hash:'',pathname:'/login'},history:{replaceState(){}},TextEncoder,Date,
  setInterval:(fn,ms)=>{const id=++counter;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),
  fetch:async path=>Response.json(path==='/api/local/bili/start'?{error:startError}:{phase:'debug_unavailable',error:'浏览器调试端口不可用',metadata:{title:'Something went wrong',http:403,auth_token_present:null}},{status:path==='/api/local/bili/start'?502:200})});
 vm.runInContext(script,context);await new Promise(setImmediate);return {context,nodes,timers};
}
test('local page shows classified certificate, HTTP, business and pause errors verbatim as text',async()=>{
 for(const error of ['B 站连接证书校验失败','B 站请求失败（HTTP 403）','B 站请求未成功（业务码 -400）','B 站风控暂停至 17:30，请稍后再试','本机风控状态文件损坏或不可读']){
  const f=await ui(error);assert.equal(f.nodes.get('bili-status').textContent,error);
 }
});
test('X CDP fallback displays confirmation and safe page metadata without claiming login',async()=>{
 const f=await ui('证书错误');await vm.runInContext('watchX()',f.context);
 assert.equal(f.nodes.get('x-confirm').hidden,false);
 assert.match(f.nodes.get('x-status').textContent,/调试端口不可用/);
 assert.match(f.nodes.get('x-diagnostic').textContent,/Something went wrong.*HTTP：403.*auth_token：未知/);
 await f.nodes.get('x-confirm').onclick();assert.doesNotMatch(f.nodes.get('x-status').textContent,/X 已登录/);
});
