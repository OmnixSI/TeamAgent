// D-10b1 pipeline checks: promises (M3), proposal tasks (M5) and F5 dedupe.
// Every run uses the real Worker, the real seed and the fake golden judge.
import { assert, equal } from "../harness.mjs";
import { goldenRun } from "../golden-run.mjs";

function parsed(row, key, fallback) {
  try { return JSON.parse(row[key]); } catch { return fallback; }
}

export async function vdM3(ctx, item) {
  const run = await goldenRun({ mode: "full", extraNights: 1 });
  const { db } = run;
  const promises = db.prepare("SELECT * FROM promises ORDER BY created_at,id").all();
  assert(promises.length > 0, "M3: no promise was stored");
  const promise = promises.find((row) => /^daily\s+\d{1,2}:\d{2}$/i.test(String(row.recurring || "")));
  assert(promise, `M3: no recurring promise (got ${promises.map((row) => row.recurring).join(",")})`);
  assert(["broken", "cannot"].includes(promise.status), `M3: promise status=${promise.status}, expected broken/cannot`);
  const outbox = db.prepare("SELECT body FROM outbox WHERE id=?").get(promise.outbox_id);
  assert(outbox && String(outbox.body).includes(promise.quote), "M3: promise quote is not verbatim in the outbox");
  const gap = db.prepare("SELECT * FROM capability_gaps WHERE capability='scheduling' AND gap_type='tool_missing' LIMIT 1").get();
  assert(gap, "M3: scheduling/tool_missing gap missing");
  assert(Number(gap.occurrences) >= 1, "M3: scheduling gap occurrences=0");
  return {
    detail: `M3：承诺 recurring=${promise.recurring} 原文逐字、第 2 晚 checkPromises=${promise.status}；scheduling/tool_missing gap occurrences=${gap.occurrences}（证据 outbox ${promise.outbox_id.slice(0, 16)}）`,
    evidence: [],
  };
}

export async function vdM5(ctx, item) {
  const run = await goldenRun({ mode: "propose" });
  const { db, e } = run;
  const after = db.prepare("SELECT * FROM tasks ORDER BY id").all();
  const created = after.filter((row) => String(row.source_id || "").startsWith("review:"));
  assert(created.length > 0, "M5: no proposal task was created");
  for (const task of created) {
    assert(task.status === "proposal", `M5: task ${task.id} status=${task.status}`);
    assert(String(task.title).startsWith("[复盘]"), `M5: task ${task.id} title=${task.title}`);
    assert(/^review:[0-9a-f]{16}$/.test(String(task.source_id)), `M5: task ${task.id} source_id=${task.source_id}`);
  }
  for (const before of run.before.tasks) {
    const current = after.find((row) => row.id === before.id);
    assert(current, `M5: existing task ${before.id} disappeared`);
    equal(current.status, before.status, `M5: existing task ${before.id} status changed`);
    equal(current.updated_at, before.updated_at, `M5: existing task ${before.id} updated_at changed`);
  }
  const updates = (e.DB.calls || []).filter((sql) => /^\s*UPDATE\s+tasks\b/i.test(String(sql)));
  equal(updates, [], "M5: worker executed UPDATE tasks");
  const jobsAfter = db.prepare("SELECT kind,COUNT(*) AS n FROM jobs WHERE kind IN ('plan','code','research') GROUP BY kind ORDER BY kind").all();
  const beforeJobs = run.before.jobs.filter((row) => ["plan", "code", "research"].includes(row.kind));
  equal(jobsAfter, beforeJobs, "M5: jobs gained plan/code/research rows");
  equal(db.prepare("SELECT COUNT(*) AS n FROM task_plans").get().n, run.before.taskPlans, "M5: task_plans changed");

  // Re-run apply+publish for the last night. Consumed judgments must not
  // duplicate findings; existing tasks must keep their source ids.
  const review = await ctx.api();
  const last = db.prepare("SELECT id,group_id,gen FROM review_runs ORDER BY date DESC LIMIT 1").get();
  const now = Date.parse(run.sim.nights.at(-1).utc);
  const beforeCount = after.length;
  const findingsBefore = db.prepare("SELECT COUNT(*) AS n FROM review_findings").get().n;
  for (const judgment of db.prepare("SELECT id FROM review_judgments WHERE state='ok'").all()) {
    await review.applyJudgment({ DB: e.DB }, { id: last.id, group_id: last.group_id, gen: last.gen, now }, judgment.id);
  }
  await review.proposeTasks({ DB: e.DB }, { id: last.id, group_id: last.group_id, gen: last.gen, now });
  equal(db.prepare("SELECT COUNT(*) AS n FROM review_findings").get().n, findingsBefore, "M5: rerun duplicated findings");
  equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, beforeCount, "M5: rerun duplicated tasks");
  return {
    detail: `M5：propose 三晚新增 ${created.length} 条任务全 proposal、[复盘]、review:<fp>；无 UPDATE tasks / 新 jobs；重跑 apply+publish 后 findings=${findingsBefore}、tasks=${beforeCount} 不变；既有 ${run.before.tasks.length} 条任务状态不变`,
    evidence: [],
  };
}

export async function vdF5(ctx, item) {
  const run = await goldenRun({ mode: "full", variant: "f5" });
  const { db } = run;
  const gap = db.prepare("SELECT * FROM capability_gaps WHERE external_ref='F5' LIMIT 1").get();
  assert(gap, "F5: preset F5 gap disappeared");
  assert(gap.fingerprint === run.presetFingerprint, "F5: fingerprint changed");
  assert(Number(gap.occurrences) >= 2, `F5: occurrences=${gap.occurrences}, expected >=2 (#1/#3)`);
  assert(gap.task_id == null, `F5: task_id=${gap.task_id}, expected NULL`);
  const task = db.prepare("SELECT id FROM tasks WHERE source_id=?").get(`review:${gap.fingerprint}`);
  assert(!task, `F5: a [复盘] task was created: ${task?.id}`);
  const findings = db.prepare("SELECT trace_id,capability FROM review_findings WHERE capability='repo_visibility'").all();
  assert(findings.length >= 2, `F5: repo_visibility findings=${findings.length}, expected #1/#3`);
  return {
    detail: `F5：预置 external_ref=F5 的 repo_visibility gap 只增加 occurrences 到 ${gap.occurrences}，task_id=NULL、无 review:<fp> 任务；#1/#3 两条 finding 均命中`,
    evidence: [],
  };
}
