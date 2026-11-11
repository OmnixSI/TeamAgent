import { REPOS } from "./policy";
import { activity, redact } from "./runtime";
import { quoteIn } from "./view";

export async function rememberCorrection(e: any, input: any, source: any) {
  if (
    !source?.id ||
    source.meta?.direct !== true ||
    ![...REPOS, "team"].includes(input.repo) ||
    typeof input.quote !== "string" ||
    input.quote.length < 2 ||
    !quoteIn(source, input.quote) ||
    typeof input.value !== "string" ||
    !input.value.trim() ||
    !input.subject?.trim() ||
    !input.predicate?.trim()
  )
    throw Error("需要当前发言中的逐字纠正依据");
  if (
    redact(input.quote) !== input.quote ||
    redact(input.value) !== input.value
  )
    throw Error("凭据不能记忆");
  const subject = String(input.subject).slice(0, 100),
    predicate = String(input.predicate).slice(0, 100);
  const id = "correction:" + source.id + ":" + subject + ":" + predicate;
  const blocked = await e.DB.prepare(
    "SELECT 1 FROM memory_blocks WHERE source_id=?",
  )
    .bind(source.id)
    .first();
  if (blocked) throw Error("成员已删除这条记忆");
  if (await e.DB.prepare("SELECT id FROM facts WHERE id=?").bind(id).first())
    return { remembered: true, id };
  const statements = [];
  for (const oldId of Array.isArray(input.supersedes_ids)
    ? input.supersedes_ids.slice(0, 8)
    : []) {
    statements.push(
      e.DB.prepare(
        "UPDATE facts SET valid_to=? WHERE id=? AND repo=? AND valid_to IS NULL AND valid_from<=?",
      ).bind(source.ts, oldId, input.repo, source.ts),
    );
  }
  statements.push(
    e.DB.prepare(
      "INSERT OR IGNORE INTO facts VALUES(?,?,?,?,?,?,?,?,?,NULL)",
    ).bind(
      id,
      input.repo,
      subject,
      predicate,
      input.value.slice(0, 2000),
      input.quote,
      source.id,
      "confirmed",
      source.ts,
    ),
  );
  await e.DB.batch(statements);
  await activity(
    e,
    "memory.corrected",
    id,
    source.sender,
    "已按群内原话保存纠正",
    id,
  );
  return { remembered: true, id };
}

/** Bounded Chinese/Latin lexical recall. Facts remain evidence-backed D1 records. */
export async function recall(e: any, query: string, repo?: string) {
  if (repo && ![...REPOS, "team"].includes(repo))
    throw Error("unknown project");
  const terms = [
    ...new Set(
      (query.match(/[A-Za-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) || []).flatMap(
        (t) =>
          /[\p{Script=Han}]/u.test(t)
            ? Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))
            : [t.toLowerCase()],
      ),
    ),
  ].slice(0, 20);
  const rows = (
    await e.DB.prepare(
      "SELECT * FROM facts WHERE valid_to IS NULL AND (? IS NULL OR repo=? OR repo='team') ORDER BY valid_from DESC LIMIT 500",
    )
      .bind(repo || null, repo || null)
      .all()
  ).results;
  return rows
    .map((r: any) => ({
      ...r,
      score: terms.reduce(
        (n, t) =>
          n +
          (String(
            r.subject + " " + r.predicate + " " + r.value + " " + r.evidence,
          )
            .toLowerCase()
            .includes(t)
            ? 1
            : 0),
        0,
      ),
    }))
    .filter((r: any) => r.score > 0)
    .sort(
      (a: any, b: any) =>
        b.score - a.score || b.valid_from.localeCompare(a.valid_from),
    )
    .slice(0, 10);
}
