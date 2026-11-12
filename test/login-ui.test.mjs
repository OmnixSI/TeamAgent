import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const script=readFileSync('web/app.js','utf8');
function ui(){
 const ids=new Map(),requests=[];
 class Node{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attrs={};this.hidden=false;this.isConnected=true;this.textContent='';}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(k,v){this.attrs[k]=v;}focus(){}get value(){return this._value||'';}set value(v){this._value=v;}
 }
 const context=vm.createContext({document:{hidden:false,getElementById:id=>ids.get(id)||ids.set(id,new Node()).get(id),createElement:tag=>new Node(tag),createElementNS:(_ns,tag)=>new Node(tag)},sessionStorage:{getItem:()=>''},location:{hostname:'example.test'},setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},TextEncoder,URL,Date,console,
  fetch:async(path,opts)=>{requests.push({path,opts});return Response.json(context.response);},container:new Node()});
 vm.runInContext(script,context);return {context,requests};
}
const text=n=>[n.textContent,...n.children.map(text)].join(' ');
const all=n=>[n,...n.children.flatMap(all)];
test('browser QR matrix matches independent reference for fixed version 10-L mask 0',()=>{
 const {context}=ui(),fixture=JSON.parse(readFileSync('test/fixtures/login-qr.json'));
 context.qrText=fixture.text;const matrix=vm.runInContext('loginQrMatrix(qrText)',context);
 assert.equal(matrix.length,57);assert.ok(matrix.every(row=>row.length===57));
 const bits=matrix.flat().map(Boolean).map(x=>x?'1':'0').join('');
 assert.equal(createHash('sha256').update(bits).digest('hex'),fixture.matrix_sha256);
});
test('service login UI is owner only and shows offline truth without credential inputs',async()=>{
 const {context,requests}=ui();context.response={online:false,services:{bili:{auth:null,flow:null},x:{auth:null,flow:null}}};
 vm.runInContext("state={who:{role:'member'}}",context);await vm.runInContext('renderServiceLogins(container)',context);assert.equal(requests.length,0);
 vm.runInContext("state={who:{role:'owner'}}",context);await vm.runInContext('renderServiceLogins(container)',context);
 assert.match(text(context.container),/本机服务没在线，请检查/);assert.match(text(context.container),/登录 B 站/);assert.match(text(context.container),/登录 X/);
 assert.ok(!all(context.container).some(n=>['input','iframe','img'].includes(n.tagName)));
});
test('waiting/scanned QR is rendered locally, final and risk states remove it, X reports local window',async()=>{
 const {context,requests}=ui(),fixture=JSON.parse(readFileSync('test/fixtures/login-qr.json'));
 vm.runInContext("state={who:{role:'owner'}}",context);
 for(const phase of ['waiting','scanned','ok','failed']){
  context.container.replaceChildren();context.response={online:true,services:{bili:{auth:{state:'ok'},flow:{id:'flow',service:'bili',phase,qr_url:phase==='waiting'||phase==='scanned'?fixture.text:undefined,reason:phase==='failed'?'risk':undefined,expires_at:Date.now()+300000}},x:{auth:null,flow:{id:'x',service:'x',phase:'waiting',started:true,expires_at:Date.now()+300000}}}};
  await vm.runInContext('renderServiceLogins(container)',context);
  assert.equal(all(context.container).filter(n=>n.tagName==='svg').length,['waiting','scanned'].includes(phase)?1:0);
  assert.match(text(context.container),/已在你的电脑上打开登录窗口/);
  if(phase==='failed')assert.match(text(context.container),/B 站暂时限制，请稍后再试/);
 }
 assert.ok(requests.every(x=>x.path==='/api/team/service-login'));
});
test('login and cancel buttons use the owner API, disabling duplicate starts for an active service',async()=>{
 const {context,requests}=ui();vm.runInContext("state={who:{role:'owner'}}",context);
 context.response={online:true,services:{bili:{auth:null,flow:null},x:{auth:null,flow:null}}};await vm.runInContext('renderServiceLogins(container)',context);
 const start=all(context.container).find(n=>n.tagName==='button'&&n.textContent==='登录 B 站');await start.onclick();
 const posted=requests.find(x=>x.opts.method==='POST');assert.deepEqual(JSON.parse(posted.opts.body),{service:'bili'});
 context.container.replaceChildren();context.response.services.bili.flow={id:'flow',phase:'waiting',expires_at:Date.now()+300000};
 await vm.runInContext('renderServiceLogins(container)',context);
 assert.equal(all(context.container).find(n=>n.tagName==='button'&&n.textContent==='登录 B 站').disabled,true);
 await all(context.container).find(n=>n.tagName==='button'&&n.textContent==='取消登录').onclick();
 assert.deepEqual(JSON.parse(requests.find(x=>x.opts.method==='DELETE').opts.body),{service:'bili',id:'flow'});
});
