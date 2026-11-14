// Runner side of read_document: docread jobs are parsed on the operator's machine.
// The cloud only queues them; this module downloads one file, runs runner/docread.py, and reports the
// structured extraction (or the parser's honest failure) back under the tool's media_notes key.
const DOC_LEASE_MS = 180000;
const MAX_RESULT_BYTES = 240000;

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
function list(value: unknown, max: number): any[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function successBody(r: any, filename: unknown): any {
  return {
    ok: true,
    kind: str(r.kind, 20) || "document",
    filename: str(filename, 200),
    bytes: Number.isFinite(r.bytes) && r.bytes >= 0 ? r.bytes : 0,
    text: str(r.text, 60000),
    pages: list(r.pages, 500),
    sheets: list(r.sheets, 50),
    meta: r.meta && typeof r.meta === "object" && !Array.isArray(r.meta) ? r.meta : {},
    warnings: list(r.warnings, 30).map((w) => String(w).slice(0, 300)),
    hits: list(r.hits, 10),
    truncated: r.truncated === true,
  };
}
function noTextWarnings(r: any): boolean {
  const warnings = Array.isArray(r?.warnings) ? r.warnings.map((w: any) => String(w)) : [];
  return warnings.some((w: string) => w.includes("没有可提取的文字层") || w.includes("文档没有可读文字"));
}

/** Claim one pending docread job and put it under a fresh lease. Also retires jobs whose two attempts died. */
export async function claimDoc(e: any, now = Date.now()) {
  await e.DB.prepare(
    "UPDATE jobs SET status='failed',error='expired' WHERE kind='docread' AND status='running' AND attempts>=2 AND lease_until<?",
  )
    .bind(now)
    .run();
  const lease = crypto.randomUUID();
  const row = await e.DB.prepare(
    `UPDATE jobs SET status='running',attempts=attempts+1,lease_until=?,payload=json_set(payload,'$.lease',?)
      WHERE id=(SELECT id FROM jobs WHERE kind='docread' AND attempts<2 AND
        (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 1) RETURNING *`,
  )
    .bind(now + DOC_LEASE_MS, lease, now)
    .first();
  return row ? { ...row, payload: JSON.parse(row.payload) } : null;
}

export async function heartbeatDoc(e: any, id: unknown, lease: unknown, now = Date.now()) {
  if (typeof id !== "string" || typeof lease !== "string") return false;
  return !!(await e.DB.prepare(
    "UPDATE jobs SET lease_until=? WHERE id=? AND kind='docread' AND status='running' AND json_extract(payload,'$.lease')=? AND lease_until>?",
  )
    .bind(now + DOC_LEASE_MS, id, lease, now)
    .first());
}

/** Finish a docread job under the lease fence: success goes to media_notes, failure stays on the job. */
export async function reportDoc(e: any, b: any, now = Date.now()): Promise<Response> {
  if (!b || typeof b.id !== "string" || typeof b.lease !== "string")
    return Response.json({ error: "invalid report" }, { status: 400 });
  const row = await e.DB.prepare("SELECT status,payload,lease_until FROM jobs WHERE id=? AND kind='docread'")
    .bind(b.id)
    .first();
  if (!row) return Response.json({ error: "unknown job" }, { status: 404 });
  const p = JSON.parse(row.payload);
  if (p.lease !== b.lease) return Response.json({ error: "lease conflict" }, { status: 409 });
  const stored = await e.DB.prepare("SELECT body FROM media_notes WHERE id=?").bind(p.key).first();
  if (row.status === "done" && stored) return Response.json({ ok: true, already: true });
  if (row.status === "failed" && (stored || p.failed_at !== undefined))
    return Response.json({ ok: true, already: true });
  if (row.status !== "running" || row.lease_until <= now)
    return Response.json({ error: "lease conflict" }, { status: 409 });

  const guard =
    "id=? AND kind='docread' AND json_extract(payload,'$.lease')=? AND status='running' AND lease_until>?";
  const args = [b.id, b.lease, now];
  // Failures are not content: keep media_notes for successful extractions only, and let the tool
  // retry the same question after a cooldown instead of caching a broken read forever.
  const markFailed = async (errorKind: string, detail: unknown) => {
    const reason = str(errorKind, 40) || "unreadable";
    await e.DB.prepare(
      "UPDATE jobs SET status='failed',error=?,payload=json_set(payload,'$.failed_at',?,'$.failure_detail',?) WHERE " + guard,
    )
      .bind(reason, now, str(detail, 300), ...args)
      .run();
    const committed = await e.DB.prepare(
      "SELECT status FROM jobs WHERE id=? AND json_extract(payload,'$.lease')=? AND status='failed'",
    )
      .bind(b.id, b.lease)
      .first();
    return committed ? Response.json({ ok: true }) : Response.json({ error: "lease conflict" }, { status: 409 });
  };
  if (b.success === false) return markFailed(str(b.reason, 40) || "runner_failed", b.reason);
  const r = b.result;
  if (!r || typeof r !== "object") return Response.json({ error: "invalid result" }, { status: 400 });
  if (r.ok !== true) return markFailed(str(r.error_kind, 40) || "unreadable", r.error);
  if (typeof r.text !== "string") return Response.json({ error: "invalid result" }, { status: 400 });
  if (noTextWarnings(r)) {
    const warning = list(r.warnings, 30).map((w) => String(w)).find((w) => w.includes("没有可提取的文字层") || w.includes("文档没有可读文字"));
    return markFailed("no_text", warning || "没有可提取的文字层，可能是扫描件");
  }
  const body = JSON.stringify(successBody(r, p.filename));
  if (body.length > MAX_RESULT_BYTES) return Response.json({ error: "result too large" }, { status: 413 });
  await e.DB.batch([
    e.DB.prepare(
      "INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE " + guard + ")",
    ).bind(p.key, body, new Date(now).toISOString(), ...args),
    e.DB.prepare("UPDATE jobs SET status='done',error=NULL WHERE " + guard).bind(...args),
  ]);
  const committed = await e.DB.prepare(
    "SELECT status FROM jobs WHERE id=? AND json_extract(payload,'$.lease')=? AND status='done'",
  )
    .bind(b.id, b.lease)
    .first();
  return committed ? Response.json({ ok: true }) : Response.json({ error: "lease conflict" }, { status: 409 });
}

export async function docRoute(e: any, path: string, b: any): Promise<Response> {
  const action = path.slice(path.lastIndexOf("/") + 1);
  if (action === "claim") return Response.json({ job: await claimDoc(e) });
  if (action === "heartbeat") {
    const ok = await heartbeatDoc(e, b?.id, b?.lease);
    return Response.json({ ok }, { status: ok ? 200 : 409 });
  }
  if (action === "report") return reportDoc(e, b);
  return Response.json({ error: "not found" }, { status: 404 });
}
