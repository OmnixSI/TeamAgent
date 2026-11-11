import { activity, redact } from "./runtime";
import { queueFor } from "./lanes";
const json = (value: any, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function publicTask(task: any) {
  if (!task) return task;
  const { lease, lease_until, ...shared } = task;
  return shared;
}
export async function claimTask(e: any, b: any, who: any) {
  const task = await e.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(b.id)
    .first();
  if (!task) return json({ error: "任务不存在" }, 404);
  if (task.assignee === who.name && task.status === "in_progress")
    return json({ ok: true, already: true, task: publicTask(task) });
  if (task.version !== b.version)
    return json({ error: "任务已被更新，请刷新后再接手" }, 409);
  if (["done", "cancelled"].includes(task.status))
    return json({ error: "任务已收尾，需要继续时先重新开启" }, 409);
  if (
    task.status === "in_progress" &&
    task.assignee &&
    task.assignee !== who.name
  )
    return json(
      { error: "这项任务已由 " + task.assignee + " 接手，请先确认交接" },
      409,
    );
  const next = task.version + 1,
    at = new Date().toISOString(),
    notice = "claim-" + task.id + "-v" + next;
  const payload = {
    task: task.id,
    member: who.name,
    version: next,
    actorType: who.via === "ai" ? "ai" : "member",
  };
  await e.DB.batch([
    e.DB.prepare(
      "INSERT OR IGNORE INTO task_claims SELECT id,version+1,?,?,?,? FROM tasks WHERE id=? AND version=?",
    ).bind(who.id, who.name, payload.actorType, at, task.id, task.version),
    e.DB.prepare(
      "UPDATE tasks SET status='in_progress',assignee=?,version=version+1,lease=NULL,lease_until=NULL,updated_at=? WHERE id=? AND version=?",
    ).bind(who.name, at, task.id, task.version),
    e.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id,kind,payload,created_at) SELECT ?,'claim_notice',?,? FROM task_claims WHERE task_id=? AND version=? AND member_id=?",
    ).bind(notice, JSON.stringify(payload), Date.now(), task.id, next, who.id),
    e.DB.prepare(
      "INSERT OR IGNORE INTO activity SELECT ?,'task.claimed',?,?,?,? FROM task_claims WHERE task_id=? AND version=? AND member_id=?",
    ).bind(
      notice,
      task.id,
      who.name,
      (payload.actorType === "ai" ? "本机AI代为接手：" : "主动接手：") +
        task.title,
      at,
      task.id,
      next,
      who.id,
    ),
  ]);
  const record = await e.DB.prepare(
    "SELECT member_id FROM task_claims WHERE task_id=? AND version=?",
  )
    .bind(task.id, next)
    .first();
  if (record?.member_id !== who.id)
    return json({ error: "另一位成员刚刚接手了这项任务" }, 409);
  const lane = queueFor(e, "claim_notice");
  if (lane) await lane.send({ id: notice });
  const updated = await e.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(task.id)
    .first();
  return json({ ok: true, task: publicTask(updated) });
}
export async function listTasks(e: any, u: URL, who: any) {
  const assignee = u.searchParams.get("assignee") || "",
    repo = u.searchParams.get("repo") || "",
    status = u.searchParams.get("status") || "";
  const name = assignee === "me" ? who.name : assignee;
  const tasks = (
    await e.DB.prepare(
      "SELECT id,repo,title,status,version,assignee,updated_at FROM tasks WHERE (?='' OR repo=?) AND (?='' OR status=?) AND (?='' OR (?='unassigned' AND COALESCE(assignee,'')='') OR assignee=?) ORDER BY updated_at DESC LIMIT 100",
    )
      .bind(repo, repo, status, status, name, name, name)
      .all()
  ).results;
  return json({ who: { id: who.id, name: who.name }, tasks });
}
export async function reportTask(e: any, b: any, who: any) {
  if (
    !["in_progress", "needs_human", "ready_for_review"].includes(b.status) ||
    !String(b.result || "").trim()
  )
    return json(
      { error: "请回填实际进展、验证结果与下一步；完成验收由成员确认" },
      400,
    );
  const row = await e.DB.prepare(
    "UPDATE tasks SET status=?,result=?,version=version+1,updated_at=? WHERE id=? AND version=? AND assignee=? AND status IN ('in_progress','needs_human','ready_for_review') RETURNING *",
  )
    .bind(
      b.status,
      redact(String(b.result)).slice(0, 60000),
      new Date().toISOString(),
      b.id,
      b.version,
      who.name,
    )
    .first();
  if (!row)
    return json({ error: "版本已变化或任务不属于你，请重新读取任务" }, 409);
  await activity(
    e,
    "task.progress",
    b.id,
    who.name + (who.via === "ai" ? " · 本机AI" : ""),
    "回填进展：" + b.status,
  );
  return json({ ok: true, task: publicTask(row) });
}
