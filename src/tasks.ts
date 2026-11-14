import { queueFor } from "./lanes";
import { activity, redact } from "./runtime";
import { REPOS, validStatus } from "./policy";
const iso = () => new Date().toISOString();

export async function requestPlan(
  e: any,
  t: any,
  actor: string,
  important = true,
) {
  const id = "plan-" + t.id + "-v" + t.version;
  await e.DB.batch([
    e.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
    ).bind(
      id,
      "plan",
      JSON.stringify({
        task: t.id,
        version: t.version,
        effort: important ? "max" : "high",
      }),
      Date.now(),
    ),
    e.DB.prepare(
      "INSERT INTO task_plans VALUES(?,?,'pending','',?) ON CONFLICT(task_id) DO UPDATE SET job_id=excluded.job_id,state='pending',updated_at=excluded.updated_at WHERE task_plans.job_id!=excluded.job_id",
    ).bind(t.id, id, iso()),
  ]);
  const lane = queueFor(e, "plan", { effort: important ? "max" : "high" });
  if (lane) await lane.send({ id });
  await activity(
    e,
    "plan.queued",
    t.id,
    actor,
    important ? "重要方案已进入 max 队列" : "方案整理已进入 high 队列",
    id,
  );
  return id;
}

export async function updateTask(e: any, b: any, who: any) {
  const t = await e.DB.prepare("SELECT * FROM tasks WHERE id=?")
    .bind(b.id)
    .first();
  if (!t || t.version !== b.version)
    return { error: "任务已被更新，请刷新后重试", status: 409 };
  if (b.action === "plan") {
    if (t.status === "running")
      return { error: "执行中的任务先接手再改方案", status: 409 };
    await requestPlan(e, t, who.name, b.important !== false);
    return { ok: true };
  }
  let status = b.status ?? t.status;
  if (!validStatus(status) || (status === "running" && t.status !== "running"))
    return { error: "请选择成员执行；自动执行状态由执行端维护", status: 400 };
  if (t.status === "running" && status === "running") status = "in_progress";
  const title =
    b.title === undefined ? t.title : String(b.title).trim().slice(0, 500);
  if (!title) return { error: "任务目标不能为空", status: 400 };
  const row = await e.DB.prepare(
    "UPDATE tasks SET title=?,detail=?,status=?,assignee=?,result=?,lease=NULL,lease_until=NULL,version=version+1,updated_at=? WHERE id=? AND version=? RETURNING id",
  )
    .bind(
      title,
      b.detail === undefined
        ? t.detail
        : redact(String(b.detail)).slice(0, 30000),
      status,
      b.assignee === undefined
        ? t.assignee || who.name
        : String(b.assignee).slice(0, 100),
      b.result === undefined
        ? t.result
        : redact(String(b.result)).slice(0, 60000),
      iso(),
      t.id,
      t.version,
    )
    .first();
  if (!row) return { error: "任务已被更新，请刷新后重试", status: 409 };
  // Explicit human edits make this the approved plan; old model output remains a separate draft.
  if (b.detail !== undefined || status === "queued")
    await e.DB.prepare(
      "UPDATE task_plans SET state='ready',updated_at=? WHERE task_id=? AND state IN ('conflict','failed')",
    )
      .bind(iso(), t.id)
      .run();
  await activity(
    e,
    "task.updated",
    t.id,
    who.name,
    t.status + " → " + status + " · " + title,
  );
  return { ok: true };
}

/** RC-04: repo-less workbench tasks go to the inbox instead of being refused. */
export const BOARD_INBOX = "inbox";

export async function createBoardTask(e: any, b: any, who: any) {
  if ((b.repo !== BOARD_INBOX && !REPOS.includes(b.repo)) || !String(b.title || "").trim()) return null;
  const id = crypto.randomUUID();
  await e.DB.prepare(
    "INSERT INTO tasks(id,repo,title,detail,status,assignee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      b.repo,
      redact(String(b.title)).slice(0, 500),
      redact(String(b.detail || b.title)).slice(0, 30000),
      "proposal",
      String(b.assignee || "").slice(0, 100),
      iso(),
      iso(),
    )
    .run();
  await activity(
    e,
    "task.created",
    id,
    who.name,
    "创建任务：" + String(b.title),
  );
  if (b.plan === true)
    await requestPlan(e, { id, version: 1 }, who.name, b.important !== false);
  return id;
}
