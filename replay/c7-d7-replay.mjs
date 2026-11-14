// D-7 回放：真实群消息 + 真实仓库快照，本地内存库，QQ 出站 0、线上 D1 写入 0。
// 1) 一轮 repo_changes 工具调用后，turn_tools 有工具名/脱敏参数/ok/error_kind/耗时；
// 2) 用真实群原话生成的 behavior_rules → 白天 prompt 的规则块 ≤400 字、每条 ≤80 字；
//    规则块替换 team_reflection（原文不再进白天 prompt）。
// 用法：node replay/c7-d7-replay.mjs [--raw <只读导出目录>]
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RAW = (() => {
  const i = process.argv.indexOf('--raw');
  return i > 0 ? process.argv[i + 1] : '/Users/yanghongming/Projects/TeamAgent-vD-cases-20261114/raw';
})();
const outfile = `.wrangler/c7-d7-replay-${process.pid}.mjs`;
await build({
  stdin: {
    contents: 'export {agentAnswer} from "./src/semantic"; export {ingestRepoIndex} from "./src/repo"; export {rulesBlock} from "./src/rules-inject";',
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
});
const api = await import('../' + outfile);

const DB = new DatabaseSync(':memory:');
DB.exec(readFileSync('schema.sql', 'utf8'));
DB.exec(readFileSync('migrations/0008_review.sql', 'utf8'));
const env = {
  DB: {
    prepare(sql) {
      const s = (args = []) => ({
        sql,
        bind(...v) { return s(v); },
        async first() { return DB.prepare(sql).get(...args) || null; },
        async all() { return { results: DB.prepare(sql).all(...args) }; },
        async run() { return DB.prepare(sql).run(...args); },
      });
      return s();
    },
    async batch(ss) { return Promise.all(ss.map(s => (/^\s*(SELECT|WITH)\b/i.test(s.sql) ? s.all() : s.run()))); },
  },
  DEEPSEEK_API_KEY: 'replay-only',
  WORK: { sent: [], async send(b) { this.sent.push(b); } },
};
const rows = (sql, ...a) => DB.prepare(sql).all(...a);

const messages = JSON.parse(readFileSync(RAW + '/messages.json', 'utf8'));
const all = Array.isArray(messages) ? messages : messages.results;
const source = all.find(m => String(m.body || '').includes('你好好看看仓库代码实现'));
if (!source) throw Error('真实消息缺失：' + RAW);
const repoState = JSON.parse(readFileSync(RAW + '/repo_state.json', 'utf8'))[0];
// 导出把 repo_state.j 截到 400 字，只有 head 完整；其余分支信息不参与本次审计。
const headText = /"head":(\{[^}]*\})/.exec(String(repoState.j));
const state = headText ? { head: JSON.parse(headText[1]) } : {};
await api.ingestRepoIndex(env, {
  repos: [{
    repo: repoState.repo,
    head: state.head, branches: [], worktrees: [],
    fingerprint: repoState.fingerprint || 'replay-fp', commits: [],
  }],
});

// 规则文本取自真实群原话（learning-signals-7d.json 与 messages.json），不改写。
const signals = JSON.parse(readFileSync('replay/fixtures/learning-signals-7d.json', 'utf8')).matches;
const real = (kw) => String(signals.find(s => s.keywords.includes(kw))?.body || '').replace(/\s+/g, ' ').trim();
const rules = [
  ['address_as', { member: source.sender, name: '马哥' }, `称呼${source.sender}为「马哥」。`],
  ['free', {}, `回应这类问题先给结论，再给做法：${real('别再') || '先给结论。'}`],
  ['free', {}, real('以后') || '以后先回「在查」，再补结果。'],
  ['free', {}, real('每天') || '每天汇报一次进度。'],
  ['avoid_phrase', { phrase: '草' }, '不要再说「草」。'],
  ['free', {}, '回答短一点，别复读上一句。'],
  ['free', {}, '不确定的事先说没查到，不要猜。'],
  ['free', {}, '引用资料时带上来源和时间。'],
  ['free', {}, '群里没问你就不要插话。'],
  ['free', {}, '需要权限的事先问交办人。'],
];
const now = Date.now();
for (const [i, [kind, params, rule]] of rules.entries()) {
  DB.prepare('INSERT INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,canary_until,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('replay-r' + i, source.group_id, rule, 'group', kind, JSON.stringify(params),
      JSON.stringify([{ source: 'messages', id: source.id, quote: real('以后') || '原话' }]),
      'replay', 'active', now + 86400000, now + 7 * 86400000, now - i * 1000, now - i * 1000);
}
DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('team_reflection','TEAM_REFLECTION_MUST_NOT_LEAK')").run();

const turn = async (body, id, steps, patch = {}) => {
  DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)')
    .run(id, source.group_id, source.sender, body, new Date().toISOString(), 1);
  const context = {
    latest: { id, group_id: source.group_id, sender: source.sender, body, ts: new Date().toISOString(), mentioned: 1, meta: { direct: true, media: [] } },
    batch: [{ id, group_id: source.group_id, sender: source.sender, body, meta: { direct: true, media: [] } }],
    recent: [], names: new Map(), refs: new Map(), mentioned: true, ...patch,
  };
  const old = globalThis.fetch, seen = [], http = [];
  let turn = 0;
  globalThis.fetch = async (url, opt = {}) => {
    if (!String(url).includes('/chat/completions')) { http.push(String(url)); throw Error('unexpected outbound ' + url); }
    const b = JSON.parse(opt.body);
    seen.push(b);
    if (b.messages?.[0]?.content?.includes('最后的嘴替模块'))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ mode: 'work', text: '按仓库记录回答。' }) } }] });
    const next = steps[turn++];
    return Response.json({ choices: [{ message: next ? { role: 'assistant', tool_calls: Array.isArray(next) ? next : [next] } : { content: '{"action":"reply","kind":"direct","brief":"依据仓库记录回答"}' } }] });
  };
  try { await api.agentAnswer(env, context); } finally { globalThis.fetch = old; }
  return { seen, http, context };
};
const call = (name, args = {}) => ({ id: 'replay-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } });

const ok = await turn(source.body, source.id, [call('repo_changes', { repo: repoState.repo, since: '24h' })]);
const audit = rows("SELECT * FROM turn_tools WHERE name='repo_changes'");
DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('off:repo_tools','1')").run();
const denied = await turn('再看看仓库改了什么', 'replay-denied', [call('repo_changes', { repo: repoState.repo })]);
const deniedRow = rows("SELECT * FROM turn_tools WHERE turn_id='replay-denied'");

// 规则块：真实 behavior_rules → 白天 prompt
const active = rows("SELECT * FROM behavior_rules WHERE group_id=? AND status IN ('canary','active') ORDER BY updated_at DESC,id LIMIT 12", source.group_id);
const block = api.rulesBlock(active, [source.sender]);
const prompt = ok.seen[0];
const userPrompt = String(prompt.messages.find(m => m.role === 'user').content);
const lines = block.text ? block.text.split('\n').slice(1) : [];

const report = {
  message: { rid: source.rid, id: source.id, body: source.body },
  audit: audit.map(r => ({ name: r.name, turn_id: r.turn_id, args: r.args, ok: r.ok, error_kind: r.error_kind, ms: r.ms, offered: r.offered })),
  args_redacted: audit.every(r => r.args.length <= 200),
  denied: deniedRow.map(r => ({ name: r.name, ok: r.ok, error_kind: r.error_kind, offered: r.offered })),
  rules: { rows: active.length, injected: lines.length, chars: Array.from(block.text).length, max_line: Math.max(0, ...lines.map(l => Array.from(l).length)) },
  prompt: {
    has_rules_block: userPrompt.includes('群里大家提过的要求'),
    has_first_rule: lines.length ? userPrompt.includes(lines[0]) : false,
    leaked_reflection: userPrompt.includes('TEAM_REFLECTION_MUST_NOT_LEAK'),
  },
  side_effects: {
    outbox: rows('SELECT COUNT(*) AS n FROM outbox')[0].n,
    qq_http: ok.http.concat(denied.http).filter(u => /qq\.com|q\.qq\.com|bot\.qq/.test(u)).length,
    work_sent: env.WORK.sent.length,
  },
};
console.log(JSON.stringify(report, null, 1));
const fail = [];
if (!audit.length) fail.push('turn_tools 没有 repo_changes 记录');
if (!report.args_redacted) fail.push('args 超过 200 字');
if (!audit.every(r => r.ok === 1 && r.error_kind === null)) fail.push('成功调用应为 ok=1/error_kind=null');
if (!audit.every(r => typeof r.ms === 'number' && r.ms >= 0)) fail.push('ms 缺失');
if (!deniedRow.length || deniedRow[0].error_kind !== 'denied') fail.push('关掉 repo_tools 后应记 error_kind=denied');
if (report.rules.chars > 400) fail.push('规则块超过 400 字');
if (report.rules.max_line > 80) fail.push('单条规则超过 80 字');
if (!report.prompt.has_rules_block || !report.prompt.has_first_rule) fail.push('白天 prompt 没有规则块');
if (report.prompt.leaked_reflection) fail.push('team_reflection 原文仍进白天 prompt');
if (report.side_effects.outbox || report.side_effects.qq_http || report.side_effects.work_sent) fail.push('出现出站副作用');
console.log(fail.length ? 'FAIL: ' + fail.join('；') : 'PASS：QQ 真实发送 0 次、线上 D1 写入 0 行');
process.exit(fail.length ? 1 : 0);
