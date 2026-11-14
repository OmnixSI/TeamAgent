import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {env,req} from './support.mjs';

// SK-2: the runtime half of the self-knowledge card. The generated card is a
// build-time artifact (SK-1); every test here injects the sample fixture instead,
// so this file never depends on the generator having run.
const outfile=`.wrangler/self-card-${process.pid}.mjs`;
await build({stdin:{contents:'export {readLive,capabilityState,renderSelf,vendorSummary,SELF_TOPICS} from "./src/self-card"; export {runExtraTool,extraToolDefs} from "./src/toolkit"; export {agentAnswer} from "./src/semantic"; export {capabilityCard,CARD_MAX,SELF_HINT} from "./src/capability-card"; export {SELF_CARD} from "./src/self-card.generated";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile);

const card=JSON.parse(readFileSync(new URL('./fixtures/self-card.sample.json',import.meta.url),'utf8'));
const ENV_NAMES=[...new Set(card.capabilities.flatMap(c=>c.requires_env||[]))];
const sha7=value=>String(value||'').slice(0,7);
const live=(over={})=>({
  release:sha7(card.commit),
  switches:{},
  envPresent:Object.fromEntries(ENV_NAMES.map(name=>[name,true])),
  ...over,
});
const cap=(id)=>card.capabilities.find(c=>c.id===id);

// S1: a member asks how image generation works.
test('S1 生图问法命中 OpenAI/gpt-image-1/文件:行/限额',()=>{
  for(const query of ['生图','画图','generate_image']){
    const out=api.renderSelf(card,live(),'capability',query);
    for(const want of ['OpenAI','gpt-image-1','src/imagegen.ts:100','每人每天 5 张'])
      assert.ok(out.includes(want),`${query} 缺少 ${want}\n${out}`);
    assert.ok(!out.includes('自知卡里没有这个能力'),`${query} 不应落空\n${out}`);
  }
});

// S2: the voice path is local and the cloud must not pretend it can verify it.
test('S2 语音识别是本机 X-ASR，不说成云端识别',()=>{
  const out=api.renderSelf(card,live(),'capability','语音识别');
  for(const want of ['X-ASR','runner/asr.mjs','本机']) assert.ok(out.includes(want),`缺少 ${want}\n${out}`);
  assert.ok(!out.includes('云端识别'),`不得说成云端识别\n${out}`);
  assert.match(out,/状态：.*(未核实|云端无法确认)/,out);
});

// S3: kill switches and missing bindings are reported as unusable, never as usable.
test('S3 开关关闭/环境变量缺失如实说已关闭或未配置',()=>{
  for(const sw of ['off:image_gen','off:openai']){
    const out=api.renderSelf(card,live({switches:{[sw]:'1'}}),'capability','生图');
    assert.ok(/当前已关闭|已写好未启用/.test(out),`${sw} 没有如实说明\n${out}`);
    assert.ok(!out.includes('可以直接'),`${sw} 不得说可以直接用\n${out}`);
  }
  const missing=live({envPresent:{...live().envPresent,OPENAI_API_KEY:false}});
  const out=api.renderSelf(card,missing,'capability','生图');
  assert.ok(out.includes('未配置'),out);
  assert.ok(out.includes('OPENAI_API_KEY'),`要点名环境变量\n${out}`);

  assert.equal(api.capabilityState(cap('image_generation'),live({switches:{'off:image_gen':'1'}})).state,'switched_off');
  assert.equal(api.capabilityState(cap('image_generation'),missing).state,'not_configured');
  assert.equal(api.capabilityState(cap('image_generation'),live()).state,'enabled');
  assert.equal(api.capabilityState(cap('voice_asr'),live()).state,'local_unverified');
  const offByDefault={...cap('image_generation'),default_state:'off_by_default',requires_env:[],switches:[]};
  assert.equal(api.capabilityState(offByDefault,live()).state,'off_by_default');
  assert.equal(api.capabilityState({...offByDefault,switches:['image_gen']},live({switches:{'off:image_gen':'0'}})).state,'enabled');
  // Any switch value other than 0/false counts as off, same rule as toolkit.toolSwitchedOff.
  assert.equal(api.capabilityState(cap('image_generation'),live({switches:{'off:image_gen':'yes'}})).state,'switched_off');
  assert.equal(api.capabilityState(cap('image_generation'),live({switches:{'off:image_gen':'false'}})).state,'enabled');
});

// S4: a card built from another commit must never be presented as the deployed truth.
test('S4 版本不一致时说明，一致或 development 时不说',()=>{
  const mismatch=api.renderSelf(card,live({release:'abc1234'}),'overview');
  assert.ok(mismatch.includes('自知卡版本与线上不一致'),mismatch);
  const same=api.renderSelf(card,live({release:sha7(card.commit)}),'overview');
  assert.ok(!same.includes('自知卡版本与线上不一致'),same);
  const dev=api.renderSelf(card,live({release:'development'}),'overview');
  assert.ok(!dev.includes('自知卡版本与线上不一致'),dev);
});

// S5: unknown capabilities are refused and the real titles are listed instead.
test('S5 无匹配时说明没有这个能力并列出全部标题',()=>{
  const out=api.renderSelf(card,live(),'capability','量子计算');
  assert.ok(out.includes('自知卡里没有这个能力'),out);
  for(const title of card.capabilities.map(c=>c.title)) assert.ok(out.includes(title),`缺少标题 ${title}\n${out}`);
});

// S6: no env value may ever reach a rendered answer or /health.
test('S6 所有输出与 /health 都不含环境变量值',async()=>{
  const FAKE_OPENAI='sk-test-FAKE0123456789012345678901234567890';
  const FAKE_DEEPSEEK='sk-test-FAKE0987654321098765432109876543210';
  const e=env();
  e.OPENAI_API_KEY=FAKE_OPENAI;
  e.DEEPSEEK_API_KEY=FAKE_DEEPSEEK;
  const state=await api.readLive(e,undefined,card);
  for(const [name,present] of Object.entries(state.envPresent)) assert.equal(typeof present,'boolean',name);
  assert.equal(state.envPresent.OPENAI_API_KEY,true);
  assert.equal(state.envPresent.DEEPSEEK_API_KEY,true);
  assert.ok(!JSON.stringify(state).includes(FAKE_OPENAI),'readLive leaked a value');
  assert.ok(!JSON.stringify(state).includes(FAKE_DEEPSEEK),'readLive leaked a value');

  // The turn's already-loaded switch map must be reused instead of a second D1 query.
  const cached=await api.readLive({...e,DB:undefined,selfSwitches:{'off:image_gen':'1',self_note:'n'}},undefined,card);
  assert.equal(cached.switches['off:image_gen'],'1');
  assert.equal(cached.envPresent.OPENAI_API_KEY,true);

  const outputs=[];
  for(const topic of api.SELF_TOPICS)
    outputs.push(api.renderSelf(card,state,topic,topic==='capability'?'生图':undefined));
  assert.ok([...outputs[0]].length<=1500,'overview > 1500');
  for(const out of outputs) assert.ok([...out].length<=1800,`segment ${[...out].length} > 1800`);
  outputs.push(api.vendorSummary(card,state));
  const health=await req(e,'/health');
  const body=await health.json();
  assert.equal(health.status,200);
  assert.ok(body.selfCard&&typeof body.selfCard.commit==='string',JSON.stringify(body));
  assert.equal(body.selfCard.commit.length,40,'selfCard.commit is the full generated commit');
  assert.equal(typeof body.selfCard.built_at,'string');
  outputs.push(JSON.stringify(body));
  const all=outputs.join('\n');
  assert.ok(!all.includes(FAKE_OPENAI),'an output leaked OPENAI_API_KEY');
  assert.ok(!all.includes(FAKE_DEEPSEEK),'an output leaked DEEPSEEK_API_KEY');
  assert.ok(all.includes('OPENAI_API_KEY'),'env names (not values) may appear');
});

// S7: the prompt summary stays small and marks disabled capabilities.
test('S7 底层服务摘要 ≤400 字，关闭的能力带标记',()=>{
  const summary=api.vendorSummary(card,live({switches:{'off:openai':'1'}}));
  assert.ok([...summary].length<=400,`${[...summary].length} > 400`);
  assert.ok(summary.startsWith('底层服务'),summary);
  assert.ok(summary.includes('OpenAI'),summary);
  assert.ok(summary.includes('当前已关闭'),summary);
  const plain=api.vendorSummary(card,live());
  assert.ok([...plain].length<=400,`${[...plain].length} > 400`);
  assert.ok(plain.includes('DeepSeek deepseek-flash'),plain);
});

// S8: describe_self is a registered read-only tool and honours its kill switch.
test('S8 describe_self 注册、可调用、可被 off:describe_self 关闭',async()=>{
  const defs=api.extraToolDefs();
  assert.ok(defs.some(d=>d.function.name==='describe_self'),'describe_self missing from EXTRA_TOOLS');
  const ctx={context:{},messages:[],isTainted:()=>false};
  const e=env();
  const ok=await api.runExtraTool(e,'describe_self',{topic:'overview'},ctx);
  assert.equal(ok.ok,true,JSON.stringify(ok));
  assert.equal(typeof ok.text,'string');
  assert.ok(ok.text.includes('自知卡'),ok.text);
  assert.equal(typeof ok.card_commit,'string');
  assert.equal(typeof ok.release,'string');

  const map=await api.runExtraTool(e,'describe_self',{topic:'repo_map'},ctx);
  assert.equal(map.ok,true,JSON.stringify(map));
  assert.match(map.text,/仓库：\S+/);
  assert.match(map.text,/repo_file/);
  const firstTitle=api.SELF_CARD.capabilities?.[0]?.title||'生图';
  const one=await api.runExtraTool(e,'describe_self',{topic:'capability',query:firstTitle},ctx);
  assert.equal(one.ok,true,JSON.stringify(one));
  assert.match(one.text,/【.+】/);

  await e.DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind('off:describe_self','1').run();
  const denied=await api.runExtraTool(e,'describe_self',{topic:'overview'},ctx);
  assert.equal(denied.ok,false);
  assert.equal(denied.error_kind,'denied');
});

// S9: the prompt still carries the card and now also the automatic vendor line + hint.
test('S9 系统提示含 SELF_HINT 与底层服务行',async()=>{
  const e=env();
  const row={id:'current',group_id:'GROUP000001',sender:'U1',body:'你都能干啥',ts:new Date().toISOString(),mentioned:1,meta:{direct:true,media:[]}};
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').bind(row.id,row.group_id,row.sender,row.body,row.ts,row.mentioned).run();
  const ctx={latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned:true};
  const old=globalThis.fetch,seen=[];
  globalThis.fetch=async(_url,opt)=>{
    const b=JSON.parse(opt.body);seen.push(b);
    if(b.messages?.[0]?.content?.includes('最后的嘴替模块'))
      return Response.json({choices:[{message:{content:'{"mode":"work","text":"我先核对工具。"}'}}]});
    return Response.json({choices:[{message:{content:'{"action":"reply","kind":"direct","brief":"按能力卡回答"}'}}]});
  };
  try{await api.agentAnswer(e,ctx);}finally{globalThis.fetch=old;}
  assert.ok(seen.length,`no model request\n${JSON.stringify(seen)}`);
  const system=seen[0].messages[0].content;
  assert.ok(system.includes(api.SELF_HINT),'SELF_HINT missing from the system prompt');
  assert.ok(system.includes('底层服务'),'vendor summary line missing from the system prompt');
  assert.ok(system.includes('能力卡'),'capability card missing');
  assert.ok(system.includes('我对代码仓库只读'),'read-only boundary missing');
});

// S9: docread is a positive gate (`docread:enabled`), not an `off:*` kill switch.
test('S9 docread 默认关，按 docread:enabled 正向开关判断', async()=>{
  const doc={...cap('voice_asr'),id:'docread',title:'文档阅读',switches:['docread'],default_state:'off_by_default',requires_env:[],runs_on:'local'};
  assert.equal(api.capabilityState(doc,live()).state,'off_by_default');
  assert.match(api.capabilityState(doc,live()).reason,/docread:enabled/);
  assert.equal(api.capabilityState(doc,live({switches:{'docread:enabled':'1'}})).state,'local_unverified');
  assert.equal(api.capabilityState(doc,live({switches:{'docread:enabled':'0'}})).state,'off_by_default');
  assert.equal(api.capabilityState(doc,live({switches:{'docread:enabled':'1','off:docread':'1'}})).state,'switched_off');

  const themed={...card,capabilities:[...card.capabilities,doc]};
  const off=api.renderSelf(themed,live(),'switches');
  assert.match(off,/docread：已关闭（未设置）/);
  const on=api.renderSelf(themed,live({switches:{'docread:enabled':'1'}}),'switches');
  assert.match(on,/docread：开启（docread:enabled=1）/);

  const e=env();
  await e.DB.prepare("INSERT INTO settings VALUES('docread:enabled','1')").run();
  const state=await api.readLive(e,undefined,card);
  assert.equal(state.switches['docread:enabled'],'1');
});
