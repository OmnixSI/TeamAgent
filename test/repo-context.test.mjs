import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worker, env, req } from './support.mjs';

// F5e：从 repo_cache 发现的新仓库（不在 config 名单里）也要能生成任务方案。
// repoContext 的名单必须和 list_repos 用同一份登记，不能再只认静态 REPOS。
test('缓存登记的新仓库可以生成任务方案', async () => {
  const e = env();
  await req(e, '/api/admin/bind', { groupId: 'GROUP000001' });
  const repo = 'OmnixSI/peiwan-club-saas';
  await e.DB.prepare('INSERT INTO repo_cache VALUES(?,?,?)').bind(
    repo,
    JSON.stringify({
      repo,
      metadata: { pushed_at: '2026-11-13T13:50:53Z', default_branch: 'main' },
      readme: '陪玩店 SaaS',
    }),
    Date.now(),
  ).run();
  const taskId = 'task-f5e', jobId = 'plan-' + taskId + '-v1';
  await e.DB.prepare('INSERT INTO tasks(id,repo,title,detail,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind(taskId, repo, '增加测试', '增加测试', 'proposal', Date.now(), Date.now()).run();
  await e.DB.batch([
    e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)')
      .bind(jobId, 'plan', JSON.stringify({ task: taskId, version: 1, effort: 'max' }), Date.now()),
    e.DB.prepare("INSERT INTO task_plans VALUES(?,?,'pending','',?)")
      .bind(taskId, jobId, new Date().toISOString()),
  ]);
  const old = globalThis.fetch, seen = [];
  globalThis.fetch = async (_url, opt) => {
    seen.push(JSON.parse(opt.body));
    return Response.json({ choices: [{ message: { content: '## 实施步骤\n跑测试。' } }] });
  };
  try {
    await worker.queue({ messages: [{ body: { id: jobId }, ack() {} }] }, e);
    const plan = await e.DB.prepare('SELECT state,draft FROM task_plans WHERE task_id=?')
      .bind(taskId).first();
    const task = await e.DB.prepare('SELECT detail FROM tasks WHERE id=?').bind(taskId).first();
    assert.equal(plan.state, 'ready');
    assert.match(task.detail, /实施步骤/);
    assert.ok(JSON.stringify(seen[0]).includes(repo), '方案提示里要带上缓存仓库的资料');
  } finally {
    globalThis.fetch = old;
  }
});
