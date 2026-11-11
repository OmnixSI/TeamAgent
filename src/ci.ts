import { digest } from "./accounts";
import { activity, promptData, redact } from "./runtime";
import { decodeVoice } from "./voice";
const failed = (c: any) =>
  ["failure", "timed_out", "action_required"].includes(c.conclusion);
const billing = (text: string) =>
  /job was not started[\s\S]*(?:payments|spending limit)/i.test(text);
const url = (check: any) =>
  /^https:\/\/github\.com\/OmnixSI\/[^\s]+\/actions\//.test(
    check.html_url || "",
  )
    ? check.html_url
    : "";
async function descriptor(repo: string, check: any) {
  const ev = check.evidence || {};
  const annotations = Array.isArray(ev.annotations)
    ? ev.annotations
        .map((a: any) => String(a.message || ""))
        .filter(Boolean)
        .sort()
    : [];
  const evidence = annotations.length
    ? annotations.join("\n")
    : [ev.title, ev.summary].filter(Boolean).join("\n");
  const cause = billing(evidence)
    ? "github-actions-billing"
    : evidence
      ? "diagnostic"
      : "unknown";
  const scope =
    cause === "github-actions-billing"
      ? "organization:OmnixSI"
      : repo + ":" + check.name;
  const signature =
    cause === "github-actions-billing"
      ? cause
      : (evidence || "no-evidence:" + check.conclusion)
          .toLowerCase()
          .replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>")
          .replace(/\/(runs|job)\/\d+/g, "/$1/<id>")
          .replace(/\s+/g, " ")
          .trim();
  return {
    id: "cif-" + (await digest(scope + "\0" + signature)).slice(0, 24),
    scope,
    cause,
    repo,
    check,
  };
}
function insertRows(
  e: any,
  table: string,
  columns: string[],
  rows: any[][],
  suffix: string,
) {
  const statements = [],
    size = Math.floor(90 / columns.length);
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    statements.push(
      e.DB.prepare(
        "INSERT INTO " +
          table +
          "(" +
          columns.join(",") +
          ") VALUES " +
          part
            .map(() => "(" + columns.map(() => "?").join(",") + ")")
            .join(",") +
          " " +
          suffix,
      ).bind(...part.flat()),
    );
  }
  return statements;
}
export async function observeChecks(
  e: any,
  repo: string,
  checks: any[],
  previous: any,
  group: string | null,
  enqueue: any,
) {
  if (
    !(await e.DB.prepare(
      "SELECT value FROM settings WHERE key='ci_notifications_v2'",
    ).first())
  )
    await e.DB.batch([
      e.DB.prepare(
        "UPDATE outbox SET status='superseded' WHERE status='pending' AND id LIKE 'ci-%'",
      ),
      e.DB.prepare(
        "UPDATE jobs SET status='done',error=NULL WHERE kind='ci_triage' AND status='pending' AND json_extract(payload,'$.incident_key') IS NULL",
      ),
      e.DB.prepare(
        "INSERT OR IGNORE INTO settings VALUES('ci_notifications_v2','1')",
      ),
    ]);
  if (!checks.length) return;
  // One observation per job name: a new commit/run is not a new problem.
  const incoming = new Map<string, any>();
  for (const check of checks.slice(0, 20))
    if (
      check.name &&
      (!incoming.has(check.name) ||
        Number(check.id) > Number(incoming.get(check.name).id))
    )
      incoming.set(check.name, check);
  const before = (
    await e.DB.prepare(
      "SELECT * FROM ci_observations WHERE repo=? ORDER BY updated_at DESC LIMIT 40",
    )
      .bind(repo)
      .all()
  ).results;
  const latest = [...incoming.values()].filter((c) => {
    const old = before.find((o: any) => o.check_name === c.name);
    return !old || Number(c.id || 0) >= Number(old.check_id || 0);
  });
  const descriptors = await Promise.all(
    latest.filter(failed).map((c) => descriptor(repo, c)),
  );
  const unique = [...new Map(descriptors.map((d) => [d.id, d])).values()];
  const keys = [
    ...new Set([
      ...before.map((o: any) => o.incident_id).filter(Boolean),
      ...unique.map((d) => d.id),
    ]),
  ];
  const known = keys.length
    ? (
        await e.DB.prepare(
          "SELECT * FROM ci_incidents WHERE id IN (" +
            keys.map(() => "?").join(",") +
            ")",
        )
          .bind(...keys)
          .all()
      ).results
    : [];
  const seeded = new Set<string>();
  if (unique.some((d) => !known.some((k: any) => k.id === d.id))) {
    const legacy = (
      await e.DB.prepare(
        "SELECT id,body FROM outbox WHERE status IN ('sent','unknown') AND id LIKE 'ci-%' ORDER BY created_at DESC LIMIT 100",
      ).all()
    ).results;
    const old = await Promise.all(
      (Array.isArray(previous.checks) ? previous.checks : [])
        .filter(failed)
        .slice(0, 20)
        .map((c: any) => descriptor(repo, c)),
    );
    for (const d of unique) {
      if (known.some((k: any) => k.id === d.id)) continue;
      if (
        (d.cause === "github-actions-billing" &&
          legacy.some(
            (o: any) =>
              billing(o.body) || /账单|付款|计费策略|支出限额/.test(o.body),
          )) ||
        old.some(
          (o) =>
            o.id === d.id &&
            legacy.some((n: any) =>
              n.id.startsWith(
                "ci-" + repo + "-" + o.check.id + "-" + o.check.head_sha,
              ),
            ),
        )
      )
        seeded.add(d.id);
    }
  }
  const now = Date.now();
  const observations = latest.map((c) => [
    repo,
    c.name,
    descriptors.find((d) => d.check.name === c.name)?.id ||
      before.find((o: any) => o.check_name === c.name)?.incident_id ||
      null,
    c.conclusion || c.status || "unknown",
    String(c.id || ""),
    c.head_sha || "",
    now,
  ]);
  const rows = unique.map((d) => [
    d.id,
    d.scope,
    d.cause,
    repo,
    d.check.name,
    JSON.stringify(promptData(d.check)),
    now,
    seeded.has(d.id) ? 1 : 0,
  ]);
  const writes = [
    ...insertRows(
      e,
      "ci_observations",
      [
        "repo",
        "check_name",
        "incident_id",
        "conclusion",
        "check_id",
        "head_sha",
        "updated_at",
      ],
      observations,
      "ON CONFLICT(repo,check_name) DO UPDATE SET incident_id=excluded.incident_id,conclusion=excluded.conclusion,check_id=excluded.check_id,head_sha=excluded.head_sha,updated_at=excluded.updated_at WHERE CAST(excluded.check_id AS INTEGER)>=CAST(ci_observations.check_id AS INTEGER)",
    ),
    ...insertRows(
      e,
      "ci_incidents",
      [
        "id",
        "scope",
        "cause",
        "repo",
        "check_name",
        "check_json",
        "updated_at",
        "notified_cycle",
      ],
      rows,
      "ON CONFLICT(id) DO UPDATE SET cycle=CASE WHEN ci_incidents.state!='open' THEN ci_incidents.cycle+1 ELSE ci_incidents.cycle END,state='open',repo=excluded.repo,check_name=excluded.check_name,check_json=excluded.check_json,updated_at=excluded.updated_at",
    ),
  ];
  if (writes.length) await e.DB.batch(writes);
  const current = keys.length
    ? (
        await e.DB.prepare(
          "SELECT i.*,(SELECT COUNT(*) FROM ci_observations o WHERE o.incident_id=i.id AND o.conclusion IN ('failure','timed_out','action_required')) AS active,(SELECT COUNT(*) FROM ci_observations o WHERE o.incident_id=i.id) AS observed,(SELECT COUNT(*) FROM ci_observations o WHERE o.incident_id=i.id AND o.conclusion!='success') AS unfinished FROM ci_incidents i WHERE i.id IN (" +
            keys.map(() => "?").join(",") +
            ")",
        )
          .bind(...keys)
          .all()
      ).results
    : [];
  const endings: any[] = [],
    notices: any[] = [];
  for (const incident of current) {
    if (!incident.active && incident.state === "open") {
      if (incident.observed && incident.unfinished) continue;
      const recovered = incident.observed > 0 && incident.unfinished === 0;
      endings.push({
        id: incident.id,
        state: recovered ? "resolved" : "superseded",
      });
      if (recovered && group && incident.notified_cycle === incident.cycle) {
        const text =
          (incident.cause === "github-actions-billing"
            ? "此前关联的 GitHub Actions 检查已恢复通过。"
            : repo + " 的 " + incident.check_name + " 已恢复通过。") +
          "详情已同步工作台。";
        notices.push(
          e.DB.prepare(
            "INSERT OR IGNORE INTO outbox SELECT ?,?,NULL,?,'pending',? FROM ci_incidents WHERE id=? AND cycle=? AND state='open' AND NOT EXISTS(SELECT 1 FROM ci_observations o WHERE o.incident_id=ci_incidents.id AND o.conclusion!='success')",
          ).bind(
            "ci2-recovered-" + incident.id + "-" + incident.cycle,
            group,
            text,
            now,
            incident.id,
            incident.cycle,
          ),
        );
      }
    } else if (incident.active && incident.state === "open") {
      if (group && incident.notified_cycle < incident.cycle)
        await enqueue(
          "ci2-" + incident.id + "-c" + incident.cycle,
          "ci_triage",
          { incident_key: incident.id, cycle: incident.cycle },
        );
      else if (incident.notified_cycle === incident.cycle) {
        const check = JSON.parse(incident.check_json);
        const summary =
          incident.summary ||
          (incident.cause === "github-actions-billing"
            ? "GitHub Actions未启动，已有annotation说明账户付款或支出限额受限。"
            : "相同检查问题继续存在，沿用此前结论；未重新发送群通知。");
        await e.DB.prepare(
          "INSERT INTO discoveries(id,repo,title,body,urls,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,urls=excluded.urls,created_at=excluded.created_at",
        )
          .bind(
            "ci2-" + incident.id,
            incident.repo,
            "CI跟踪 · " + incident.check_name,
            redact(
              summary +
                "\n\n最新检查：" +
                (check.head_sha || "未知提交") +
                "；相同问题只更新看板。",
            ),
            JSON.stringify(url(check) ? [url(check)] : []),
            new Date(now).toISOString(),
          )
          .run();
      }
    }
  }
  if (endings.length) {
    notices.push(
      e.DB.prepare(
        "UPDATE ci_incidents SET state=CASE id " +
          endings.map(() => "WHEN ? THEN ?").join(" ") +
          " END,updated_at=? WHERE id IN (" +
          endings.map(() => "?").join(",") +
          ") AND state='open' AND NOT EXISTS(SELECT 1 FROM ci_observations o WHERE o.incident_id=ci_incidents.id AND o.conclusion IN ('failure','timed_out','action_required'))",
      ).bind(
        ...endings.flatMap((x) => [x.id, x.state]),
        now,
        ...endings.map((x) => x.id),
      ),
    );
    await e.DB.batch(notices);
  }
}
export async function triageCI(e: any, p: any, services: any) {
  if (!p.incident_key) return; // An old queued alert must not bypass incident deduplication.
  const incident = await e.DB.prepare(
    "SELECT * FROM ci_incidents WHERE id=? AND cycle=? AND state='open' AND notified_cycle<cycle",
  )
    .bind(p.incident_key, p.cycle)
    .first();
  if (!incident) return;
  const check = JSON.parse(incident.check_json),
    link = url(check);
  let analysis: string, text: string;
  if (incident.cause === "github-actions-billing") {
    analysis =
      "GitHub Actions 没能启动。官方 annotation 表明账户付款或支出限额受限，尚未执行构建和测试，不能归因为代码失败。请管理员核对账户设置；不自动更改账单或提高限额。";
    text =
      "GitHub Actions 被账户付款或支出限额拦住了，构建和测试还没开始，需要管理员核对账户设置。同一个阻塞之后只更新看板。";
  } else if (incident.cause === "unknown") {
    analysis =
      incident.repo +
      " 的 " +
      check.name +
      " 未通过，目前没有具体错误证据；不猜测根因。";
    text = analysis + "详情已放工作台。";
  } else {
    const evidence =
      check.evidence?.annotations?.[0]?.message ||
      check.evidence?.summary ||
      check.evidence?.title ||
      "尚无具体错误";
    analysis =
      incident.repo +
      " 的 " +
      check.name +
      " 未通过；实际证据：" +
      String(evidence).slice(0, 800);
    try {
      analysis = await services.analyse({ repo: incident.repo, check });
    } catch {}
    text = analysis.slice(0, 300) + "。详情已放工作台。";
    try {
      text = decodeVoice(
        await services.voice({
          facts: analysis,
          sourceUrls: link ? [link] : [],
          instruction:
            "CI只读初查。合并成一次简短通知，说关键证据与一步建议，不复述提醒、不声称已修复；详情在工作台。",
        }),
      ).text;
    } catch {}
  }
  if (link && !text.includes(link)) text += "\n" + link;
  const group = (
    await e.DB.prepare(
      "SELECT value FROM settings WHERE key='group_id'",
    ).first()
  )?.value;
  if (!group) return;
  const id = "ci2-" + incident.id + "-c" + p.cycle;
  await e.DB.batch([
    e.DB.prepare(
      "INSERT OR IGNORE INTO outbox SELECT ?,?,NULL,?,'pending',? FROM ci_incidents WHERE id=? AND cycle=? AND state='open' AND notified_cycle<cycle",
    ).bind(id, group, redact(text), Date.now(), incident.id, p.cycle),
    e.DB.prepare(
      "UPDATE ci_incidents SET notified_cycle=cycle,summary=? WHERE id=? AND cycle=? AND state='open' AND EXISTS(SELECT 1 FROM outbox WHERE id=?)",
    ).bind(redact(analysis), incident.id, p.cycle, id),
    e.DB.prepare(
      "INSERT INTO discoveries(id,repo,title,body,urls,created_at) SELECT ?,?,?,?, ?,? FROM ci_incidents WHERE id=? AND cycle=? AND notified_cycle=cycle ON CONFLICT(id) DO UPDATE SET body=excluded.body,urls=excluded.urls,created_at=excluded.created_at",
    ).bind(
      "ci2-" + incident.id,
      incident.repo,
      "CI跟踪 · " + check.name,
      redact(analysis),
      JSON.stringify(link ? [link] : []),
      new Date().toISOString(),
      incident.id,
      p.cycle,
    ),
  ]);
  await activity(
    e,
    "ci.triaged",
    incident.repo,
    "Bot",
    "CI问题按根因和恢复状态去重；相同问题仅更新看板",
    id,
  );
}
