import { tainted } from "./authz";
import { NEXT_ACTION, redactPatch, toolFailure, type ErrorKind } from "./capabilities";
import { REPOS } from "./policy";
import { isOn } from "./rhythm";
import { enqueueVoice, speakBrief } from "./voice";

const TOTAL = 10 * 60_000;
const MIN_RUN = 330_000;
const LEASE = 60_000;
const GRACE = 30_000;

export const SIDE_EFFECT_FOREGROUND = new Set<string>(["delegate"]);
export const delegateTool: any = {
  type: "function",
  function: {
    name: "delegate",
    description: "派本机只读子代理去读代码并作答（1–3 分钟，结果回这条消息）。看具体代码、实现细节、未提交改动时用；只问最近改了什么用 repo_changes。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["start", "cancel", "status"] },
        role: { type: "string", enum: ["code_reader"] },
        repo: { type: "string", enum: REPOS },
        question: { type: "string", maxLength: 500 },
        ref: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,80}$" },
        id: { type: "string" },
      },
      required: ["op"],
      additionalProperties: false,
    },
  },
};

const json = (body: any, status = 200) => Response.json(body, { status });
const fail = (kind: ErrorKind, detail?: string) => toolFailure("delegate", null, { kind, detail });
const parse = (value: string | null) => {
  try { return JSON.parse(value || "null"); } catch { return null; }
};

export async function runDelegate(e: any, a: any, context: any, messages: any[]): Promise<any> {
  if (context.origin === "subagent") return fail("denied", "子代理不能再派任务");
  if (!isOn(context.switches || {}, "delegate")) return fail("denied", "该功能已被管理员关闭");
  const latest = context.latest;
  const requester = latest?.sender;
  if (typeof requester !== "string" || !requester) return fail("unauthorized");
  if (!a || !["start", "cancel", "status"].includes(a.op) ||
      (a.id !== undefined && (typeof a.id !== "string" || !a.id))) return fail("invalid_args");
  const now = Date.now();

  if (a.op === "cancel") {
    // Identity always comes from the gateway's message, never model arguments.
    const row = await e.DB.prepare(a.id
      ? `UPDATE subagent_runs SET status='cancelled', finished_at=?1
         WHERE id=?2 AND requester=?3 AND status IN ('queued','running') RETURNING id`
      : `UPDATE subagent_runs SET status='cancelled', finished_at=?1 WHERE id=(
           SELECT id FROM subagent_runs WHERE requester=?2 AND status IN ('queued','running')
           ORDER BY created_at DESC, id DESC LIMIT 1) RETURNING id`)
      .bind(...(a.id ? [now, a.id, requester] : [now, requester])).first();
    return row ? { ok: true, id: row.id, status: "cancelled", message: "已停" } : fail("not_found");
  }
  if (a.op === "status") {
    const row = await e.DB.prepare(a.id
      ? "SELECT id,status,created_at,progress FROM subagent_runs WHERE id=? AND requester=?"
      : "SELECT id,status,created_at,progress FROM subagent_runs WHERE requester=? ORDER BY created_at DESC,id DESC LIMIT 1")
      .bind(...(a.id ? [a.id, requester] : [requester])).first();
    if (!row) return fail("not_found");
    const minutes = Math.max(0, Math.floor((now - row.created_at) / 60_000));
    return { ok: true, id: row.id, status: row.status,
      ago: minutes < 1 ? "刚刚" : minutes + " 分钟前", files: parse(row.progress)?.files ?? 0 };
  }

  if (!(context.mentioned || context.decisionOut?.kind === "direct")) return fail("unauthorized");
  const ref = a.ref ?? "origin/HEAD";
  const question = typeof a.question === "string" ? a.question.trim() : "";
  if (a.role !== "code_reader" || !REPOS.includes(a.repo) || !question || [...question].length > 500 ||
      typeof ref !== "string" || !/^[A-Za-z0-9._/-]{1,80}$/.test(ref) ||
      typeof latest.id !== "string" || !latest.id || typeof latest.group_id !== "string" || !latest.group_id)
    return fail("invalid_args");

  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a.repo + "\n" + ref + "\n" + question));
  const h8 = [...new Uint8Array(hash)].slice(0, 4).map(n => n.toString(16).padStart(2, "0")).join("");
  const id = "sub-" + latest.id + "-" + h8;
  // Quotas and insertion share a statement; the batch also identifies replays
  // even when the original start has already exhausted the requester's quota.
  const [inserted, existing] = await e.DB.batch([
    e.DB.prepare(`INSERT INTO subagent_runs(id,role,repo,ref,question,tainted,requester,group_id,source_msg,status,created_at,deadline)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,'queued',?10,?11
      WHERE (SELECT COUNT(*) FROM subagent_runs WHERE requester=?7 AND created_at>?10-3600000) < 3
        AND (SELECT COUNT(*) FROM subagent_runs WHERE group_id=?8 AND created_at>?10-86400000) < 30
        AND (SELECT COUNT(*) FROM subagent_runs WHERE source_msg=?9) < 2
      ON CONFLICT(id) DO NOTHING RETURNING id`)
      .bind(id, a.role, a.repo, ref, question, tainted(context, messages) ? 1 : 0,
        requester, latest.group_id, latest.id, now, now + TOTAL),
    e.DB.prepare("SELECT id,status FROM subagent_runs WHERE id=?").bind(id),
  ]);
  if (inserted.results?.length) return { accepted: true, id, eta: "1–3 分钟" };
  if (existing.results?.length) return { accepted: true, id, duplicate: true, status: existing.results[0].status };
  return toolFailure("delegate", null, { kind: "budget", tried: "每人每小时 3 次、每群每天 30 次、每条来源消息最多 2 次" });
}

/** Caller must check identity().role === 'owner' before entering. */
export async function cancelByOwner(e: any, id: string): Promise<Response> {
  if (typeof id !== "string" || !id) return json({ error: "invalid id" }, 400);
  const row = await e.DB.prepare(`UPDATE subagent_runs SET status='cancelled',finished_at=?
    WHERE id=? AND status IN ('queued','running') RETURNING id`).bind(Date.now(), id).first();
  return row ? json({ ok: true, id, status: "cancelled", message: "已停" }) : json(fail("not_found"), 404);
}

/** Worker authenticates runner requests and applies the quiesce gate first. */
export async function subagentRoute(e: any, request: Request, path: string): Promise<Response | null> {
  const name = path.match(/^\/api\/runner\/subagent\/(claim|heartbeat|progress|report)$/)?.[1];
  if (!name) return null;
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid body" }, 400);
  const now = Date.now();
  if (name === "claim") {
    const run = await e.DB.prepare(`UPDATE subagent_runs SET status='running',lease=?1,lease_until=?2,started_at=?3
      WHERE id=(SELECT id FROM subagent_runs WHERE status='queued' AND deadline>?4 ORDER BY created_at,id LIMIT 1)
        AND (SELECT COUNT(*) FROM subagent_runs WHERE status='running') < 2
      RETURNING id,role,repo,ref,question,tainted,deadline,lease,lease_until`)
      .bind(crypto.randomUUID(), now + LEASE, now, now + MIN_RUN).first();
    return json({ run: run ?? null });
  }
  if (typeof body.id !== "string" || !body.id || typeof body.lease !== "string" || !body.lease)
    return json({ error: "id and lease required" }, 400);
  if (name === "heartbeat") {
    const row = await e.DB.prepare(`UPDATE subagent_runs SET lease_until=?
      WHERE id=? AND lease=? AND status='running' AND deadline>=? RETURNING id`)
      .bind(now + LEASE, body.id, body.lease, now).first();
    return row ? json({ ok: true }) : json({ error: "lease invalid or expired" }, 409);
  }
  if (name === "progress") {
    const files = Number.isSafeInteger(body.files) && body.files >= 0 ? body.files : null;
    // Persist the notification with the progress flag. A stable outbox id makes
    // retries safe, including a lost HTTP response or a simultaneous progress.
    const [updated] = await e.DB.batch([
      e.DB.prepare(`UPDATE subagent_runs SET progress=json_set(COALESCE(progress,'{}'),
        '$.files',COALESCE(?1,json_extract(progress,'$.files'),0),
        '$.sent',CASE WHEN started_at<?2-120000 THEN 1 ELSE COALESCE(json_extract(progress,'$.sent'),0) END)
        WHERE id=?3 AND lease=?4 AND status='running' AND deadline>=?2 RETURNING id`)
        .bind(files, now, body.id, body.lease),
      e.DB.prepare(`INSERT OR IGNORE INTO outbox(id,group_id,msg_id,body,status,created_at)
        SELECT 'subprog-'||id,group_id,source_msg,'还在读代码，结果回来后回复这条消息。','pending',?1
        FROM subagent_runs WHERE id=?2 AND lease=?3 AND status='running' AND deadline>=?1
          AND json_extract(progress,'$.sent')=1`).bind(now, body.id, body.lease),
      e.DB.prepare(`INSERT OR IGNORE INTO outbox_meta(id,json)
        SELECT 'subprog-'||id,json_object('reference',source_msg) FROM subagent_runs
        WHERE id=?1 AND lease=?2 AND status='running' AND deadline>=?3 AND json_extract(progress,'$.sent')=1`)
        .bind(body.id, body.lease, now),
    ]);
    return updated.results?.length ? json({ ok: true }) : json({ error: "lease invalid or expired" }, 409);
  }

  if (!["done", "failed"].includes(body.status)) return json({ error: "invalid status" }, 400);
  const sha = typeof body.sha === "string" && /^[0-9a-f]{40}$/.test(body.sha) ? body.sha : null;
  if (body.status === "done" && !sha) return json({ error: "resolved 40-character sha required" }, 400);
  const errorKind = body.status === "failed"
    ? (typeof body.error_kind === "string" && Object.hasOwn(NEXT_ACTION, body.error_kind) ? body.error_kind : "unknown") : null;
  const result = JSON.stringify({
    answer: redactPatch(typeof body.answer === "string" ? body.answer : "").slice(0, 3500),
    citations: safeValue(body.citations, []),
    workspaceCitations: safeValue(body.workspaceCitations, []),
    unverifiedCitations: safeValue(body.unverifiedCitations, []),
    read: safeValue(Array.isArray(body.read) ? body.read : [], []),
  });
  const [, , state] = await e.DB.batch([
    e.DB.prepare(`UPDATE subagent_runs SET status=?1,result=?2,error_kind=?3,finished_at=?4,resolved_sha=?7
      WHERE id=?5 AND lease=?6 AND status='running' AND ?4<=deadline+${GRACE}`)
      .bind(body.status, result, errorKind, now, body.id, body.lease, sha),
    e.DB.prepare(`INSERT OR IGNORE INTO jobs(id,kind,payload,created_at)
      SELECT 'subrep-'||id,'subagent_reply',json_object('id',id),?1
      FROM subagent_runs WHERE id=?2 AND lease=?3 AND status IN ('done','failed')`)
      .bind(now, body.id, body.lease),
    e.DB.prepare("SELECT status,lease=?2 AS mine FROM subagent_runs WHERE id=?1").bind(body.id, body.lease),
  ]);
  const row = state.results?.[0];
  if (!row?.mine || !["done", "failed"].includes(row.status)) return json({ error: "lease invalid or expired" }, 409);
  // D1 is authoritative; the scanner can recover a failed queue wakeup.
  try { await (e.CHAT || e.WORK)?.send({ id: "subrep-" + body.id }); } catch {}
  return json({ ok: true });
}

function safeValue(value: any, fallback: any) {
  return value == null ? fallback : JSON.parse(JSON.stringify(value), (_key, item) =>
    typeof item === "string" ? redactPatch(item) : item);
}

export async function expireSubagents(e: any, now: number): Promise<void> {
  await e.DB.batch([
    e.DB.prepare(`UPDATE subagent_runs SET status='expired',error_kind='runner_offline',finished_at=?1
      WHERE status='queued' AND deadline<=?1+${MIN_RUN}`).bind(now),
    e.DB.prepare(`UPDATE subagent_runs SET status='failed',error_kind='timeout',finished_at=?1
      WHERE status='running' AND (?1>deadline+${GRACE} OR ?1>lease_until+120000)`).bind(now),
    e.DB.prepare(`INSERT OR IGNORE INTO jobs(id,kind,payload,created_at)
      SELECT 'subrep-'||id,'subagent_reply',json_object('id',id),?1 FROM subagent_runs
      WHERE finished_at=?1 AND status IN ('expired','failed')`).bind(now),
    e.DB.prepare("DELETE FROM subagent_runs WHERE created_at<?1-30*86400000").bind(now),
  ]);
}

export async function deliverSubagent(e: any, id: string): Promise<void> {
  const run = await e.DB.prepare(`SELECT s.*,m.body AS source_body FROM subagent_runs s
    LEFT JOIN messages m ON m.id=s.source_msg WHERE s.id=?`).bind(id).first();
  if (!run || !["done", "failed", "expired"].includes(run.status)) return;
  const result = parse(run.result) || {};
  const sha7 = run.resolved_sha?.slice(0, 7);
  const workspace = result.workspaceCitations || [];
  const facts = run.status === "done" ? {
    kind: "subagent_result", status: run.status, ...(sha7 ? { sha7 } : {}),
    answer: result.answer || "", citations: result.citations || [],
    workspaceCitations: workspace, unverifiedCitations: result.unverifiedCitations || [],
    filesRead: Array.isArray(result.read) ? result.read.length : 0, untrusted: true,
    ...(workspace.length ? { note: "这些引用来自未提交的工作区" + (sha7 ? "，不在提交 " + sha7 + " 里" : "，未经提交核实") } : {}),
  } : toolFailure("delegate", null, {
    kind: run.error_kind || "unknown", tried: "在 " + run.repo + " 的 " + run.ref + " 读取代码并作答",
  });
  const spoken = await speakBrief(e, { kind: "direct", target: run.source_msg, facts }, {
    latest: { id: run.source_msg, group_id: run.group_id, sender: run.requester, body: run.source_body || run.question },
    switches: {}, recentViews: [],
  });
  await enqueueVoice(e, "subrep-" + id, run.group_id, run.source_msg, spoken, { reference: run.source_msg });
}
