// D-10b1: run the real review Worker over the real three-night seed with a
// label-driven fake judge. The fake judge carries the golden v2 labels into
// prompt -> validate -> apply -> publish. It never calls a paid model and
// never sends to QQ; the only network endpoints are the two provider URLs,
// and every request is answered in-process.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJsonl, replayFile, simNights } from "./harness.mjs";
import { loadReview } from "./load.mjs";
import { setup, finish } from "../../test/review-worker-fixture.mjs";

const DAY = 86_400_000;
const CACHE = new Map();
const TEMP = [];

// One entry per numbered golden case. `gap` is the acceptance-level gap; the
// effective gap after D-4's historical rule is computed in checks/golden.mjs.
export const GOLDEN_CASES = {
  1: { family: "reasoning.decision.tool_selection", gap: "data_stale_or_coverage", capability: "repo_disambiguation", tool: "repo_changes", severity: "p0", fixLayer: "tool_impl", dims: { facts: "UNSATISFIED" } },
  2: { family: "reasoning.hallucination.tool", gap: "prompt_rule_missing", capability: "repo_read", tool: "none", severity: "p1" },
  3: { family: "reasoning.decision.problem_id", gap: "tool_not_selected", capability: "repo_read", tool: "repo_changes", severity: "p0", fixLayer: "tool_impl", dims: { facts: "UNSATISFIED" } },
  4: { family: "reasoning.information.poor_retrieval", gap: "tool_not_selected", capability: "repo_read", tool: "get_project", severity: "p1", fixLayer: "tool_impl" },
  5: { family: "planning.task.goal_deviation", gap: "tool_missing", capability: "scheduling", tool: "none", severity: "p1", fixLayer: "tool_impl", promise: true },
  6: { family: "reasoning.decision.tool_selection", gap: "switch_or_policy_off", capability: "bili_video", tool: "bili_transcript", severity: "p1", fixLayer: "tool_impl" },
  7: { family: "reasoning.information.poor_retrieval", gap: "tool_failed", capability: "bili_shortlink", tool: "read_web", severity: "p1", fixLayer: "tool_impl" },
  8: { family: "reasoning.output.instruction", gap: "prompt_rule_missing", capability: "bili_shortlink", tool: "none", severity: "p1" },
  9: { family: "reasoning.information.poor_retrieval", gap: "prompt_rule_missing", capability: "web_search", tool: "search_web", severity: "p1" },
  10: { family: "planning.context.handling", gap: "prompt_rule_missing", capability: null, tool: "none", severity: "p1" },
  11: { family: "reasoning.decision.problem_id", gap: null, capability: null, tool: "none", severity: "p1" },
  12: { family: "planning.context.handling", gap: "prompt_rule_missing", capability: "addressee", tool: "none", severity: "p1" },
  13: { family: "reasoning.output.instruction", gap: "prompt_rule_missing", capability: "participation", tool: "none", severity: "p1", dims: { expression: "UNSATISFIED" }, requirement: true },
  14: { family: "reasoning.output.instruction", gap: "prompt_rule_missing", capability: "participation", tool: "none", severity: "p1" },
  15: { family: "reasoning.hallucination.tool", gap: "data_stale_or_coverage", capability: "repo_read", tool: "repo_file", severity: "p1" },
  16: { family: "reasoning.hallucination.language", gap: "tool_missing", capability: "health_selfcheck", tool: "none", severity: "p1", fixLayer: "ops" },
  17: { family: "planning.context.handling", gap: null, capability: "health_selfcheck", tool: "none", severity: "p1", fixLayer: "ops", dims: { answered: "UNSATISFIED" } },
  18: { family: "planning.task.goal_deviation", gap: "tool_failed", capability: "attachment_send", tool: "create_file_task", severity: "p1", fixLayer: "tool_impl" },
  19: { family: "reasoning.hallucination.tool", gap: "tool_missing", capability: "xhs_note", tool: "read_web", severity: "p1", fixLayer: "tool_impl" },
  20: { family: "planning.context.handling", gap: null, capability: null, tool: "none", severity: "p1", outbound: 233 },
  M4: { family: "reasoning.information.tool_misread", gap: null, capability: "memory_write", tool: "none", severity: "p2", dims: { facts: "INSUFFICIENT", tool_choice: "INSUFFICIENT" } },
};

const ALL_SATISFIED = {
  answered: "SATISFIED", facts: "SATISFIED", tool_choice: "SATISFIED",
  memory: "SATISFIED", expression: "SATISFIED", boundary: "SATISFIED",
};

function quoteOf(body) {
  const text = String(body ?? "");
  const match = text.match(/[\u4e00-\u9fa5]{4,30}/);
  if (match) return match[0];
  return text.replace(/\s+/g, " ").trim().slice(0, 20);
}

function evidenceOf(trace) {
  if (trace.inbound?.body) {
    return { source: "message", id: trace.inbound.id, quote: quoteOf(trace.inbound.body) };
  }
  const reply = (trace.replies || []).find((item) => item.body);
  if (reply) return { source: "outbox", id: reply.outbox_id, quote: quoteOf(reply.body) };
  const context = [...(trace.context_before || []), ...(trace.after || [])].find((item) => item.body);
  if (context) return { source: "message", id: context.id, quote: quoteOf(context.body) };
  return null;
}

function makeSpecs({ golden, negatives, idOf, traces, variant }) {
  const byOutbox = new Map();
  for (const trace of traces) {
    for (const reply of trace.replies || []) byOutbox.set(reply.outbox_id, trace);
  }
  const traceForInbound = (rowid) => {
    const id = idOf("messages", rowid);
    return id ? traces.find((trace) => trace.inbound?.id === id) : null;
  };
  const traceForOutbox = (rowid) => {
    const id = idOf("outbox", rowid);
    return id ? byOutbox.get(id) : null;
  };
  const specs = new Map();
  for (const row of golden) {
    if (typeof row.case !== "number") continue;
    const base = GOLDEN_CASES[row.case];
    if (!base) continue;
    const trace = base.outbound
      ? traceForOutbox(base.outbound)
      : traceForInbound(row.inbound_rowids?.[0]);
    if (!trace) continue;
    const spec = { ...base, row, trace };
    if (variant === "f5" && (row.case === 1 || row.case === 3)) {
      spec.family = "reasoning.decision.tool_selection";
      spec.capability = "repo_visibility";
      spec.gap = "data_stale_or_coverage";
    }
    if (row.case === 13) {
      spec.requirement = { messageId: trace.inbound.id, quote: "收敛一点" };
    }
    if (row.case === 5) {
      const outboxRowid = row.outbox_rowids?.[0];
      const outboxId = outboxRowid ? idOf("outbox", outboxRowid) : null;
      const outbox = outboxId ? byOutbox.get(outboxId)?.replies.find((reply) => reply.outbox_id === outboxId) : null;
      if (outbox) spec.promise = { outboxId, quote: quoteOf(outbox.body), what: "每天 08:00 发日报", recurring: "daily 08:00" };
    }
    specs.set(trace.id, spec);
  }
  // M4: 145 may be INSUFFICIENT; 149 is a successful self-correction and must
  // not receive a finding. Both traces are bound to their real message turns.
  const m4 = golden.find((row) => row.case === "M4");
  if (m4) {
    const t145 = traceForOutbox(m4.outbox_rowids[0]);
    const t149 = traceForOutbox(m4.outbox_rowids[1]);
    if (t145) specs.set(t145.id, { ...GOLDEN_CASES.M4, row: m4, trace: t145, m4Role: "primary" });
    if (t149) specs.set(t149.id, { row: m4, trace: t149, m4Role: "pass" });
  }
  // Negatives stay pass in the fake run; their checks assert no finding.
  for (const row of negatives) {
    if (row.kind !== "negative" && row.kind !== "positive") continue;
    // No spec means pass.
  }
  return { specs, byOutbox, traceForInbound, traceForOutbox };
}

function passVerdict(trace, evidence, second) {
  if (second) {
    return {
      trace_id: trace.id, verdict: "pass", failure_type: null, gap_type: null,
      severity: "p2", dimensions: { ...ALL_SATISFIED }, evidence: [evidence],
      reason: "假 judge：金标之外/正确边界，无问题", confidence: 0.8,
    };
  }
  return {
    trace_id: trace.id, kind: "none", reasoning: "假 judge：金标之外/正确边界，无问题",
    dimensions: { ...ALL_SATISFIED }, failure_type: null, severity: "p2", fix_layer: "prompt",
    gap_type: null, capability: null, should_use_tool: null, evidence: [evidence],
    what_happened: "未发现问题", expected: "保持", root_cause: "无", next_attempt_plan: "无", confidence: 0.8,
  };
}

function issueVerdict(spec, trace, evidence, second) {
  const dims = { ...ALL_SATISFIED, answered: "UNSATISFIED", ...(spec.dims || {}) };
  if (second) {
    return {
      trace_id: trace.id, verdict: "issue", failure_type: spec.family, gap_type: spec.gap,
      severity: spec.severity, dimensions: dims, evidence: [evidence],
      reason: `假 judge 金标标签：#${spec.row.case}`, confidence: 0.9,
    };
  }
  return {
    trace_id: trace.id, kind: "response_fault", reasoning: `假 judge 金标标签：#${spec.row.case}`,
    dimensions: dims, failure_type: spec.family, severity: spec.severity,
    fix_layer: spec.fixLayer || "prompt", gap_type: spec.gap, capability: spec.capability,
    should_use_tool: spec.tool, evidence: [evidence],
    what_happened: spec.row.expect_points?.[0] || "与金标期望不符",
    expected: spec.row.expect_points?.join("；") || "按金标要点回答",
    root_cause: spec.row.expect_root_cause_keys?.[0] || "未按当轮事实回答",
    next_attempt_plan: "按金标要点修正", confidence: 0.9,
  };
}

function fakeFetch({ specs }) {
  return async (url, init = {}) => {
    const target = String(url);
    if (!["https://api.deepseek.com/chat/completions", "https://api.openai.com/v1/chat/completions"].includes(target)) {
      throw new Error(`disallowed network: ${target}`);
    }
    const wire = JSON.parse(init.body);
    const data = JSON.parse(wire.messages[1].content);
    const second = target.includes("openai.com");
    const verdicts = [];
    for (const trace of data.traces) {
      const spec = specs.get(trace.id);
      const evidence = evidenceOf(trace);
      if (!evidence) continue;
      if (!spec || spec.m4Role === "pass") {
        verdicts.push(passVerdict(trace, evidence, second));
        continue;
      }
      verdicts.push(issueVerdict(spec, trace, evidence, second));
    }
    const requirements = second ? [] : data.traces.flatMap((trace) => {
      const spec = specs.get(trace.id);
      if (!spec?.requirement) return [];
      return [{
        kind: "burst_max", params: { max: 1 }, rule: "", scene: "群聊", ttl_days: 7,
        evidence: [{ source: "message", id: spec.requirement.messageId, quote: spec.requirement.quote }],
      }];
    });
    const promises = second ? [] : data.traces.flatMap((trace) => {
      const spec = specs.get(trace.id);
      if (!spec?.promise) return [];
      return [{
        outbox_id: spec.promise.outboxId, quote: spec.promise.quote,
        what: spec.promise.what, due: null, recurring: spec.promise.recurring,
      }];
    });
    const result = second
      ? { schema: "ta.review.second.v1", verdicts }
      : { schema: "ta.review.result.v2", verdicts, requirements, memory_updates: [], promises, no_action: [] };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 100 },
    });
  };
}

function snapshotBefore(db) {
  return {
    tasks: db.prepare("SELECT id,status,updated_at FROM tasks ORDER BY id").all().map((row) => ({ ...row })),
    jobs: db.prepare("SELECT kind,COUNT(*) AS n FROM jobs GROUP BY kind ORDER BY kind").all().map((row) => ({ ...row })),
    taskPlans: db.prepare("SELECT COUNT(*) AS n FROM task_plans").get().n,
  };
}

/**
 * Run one pipeline variant. `mode` is shadow|propose|full; `variant` is base|f5.
 * `extraNights` adds verification nights after the three sim nights (the M3
 * promise check needs one more night; no new messages are in that window).
 */
export async function goldenRun({ mode = "full", variant = "base", extraNights = 0 } = {}) {
  const key = `${mode}:${variant}:${extraNights}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const dir = mkdtempSync(join(tmpdir(), "review-golden-"));
  TEMP.push(dir);
  const file = join(dir, "seed-437.sqlite");
  copyFileSync(replayFile("seed-437.sqlite"), file);
  const seed = new DatabaseSync(replayFile("seed-437.sqlite"), { readOnly: true });
  const golden = readJsonl(replayFile("golden.jsonl"));
  const negatives = readJsonl(replayFile("negatives.jsonl"));
  const sim = simNights();
  const group = seed.prepare("SELECT group_id,COUNT(*) AS n FROM messages GROUP BY group_id ORDER BY n DESC LIMIT 1").get().group_id;
  const idOf = (table, rowid) => seed.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(rowid)?.id ?? null;
  const review = await loadReview();
  const { e, db } = setup(mode, file);
  const before = snapshotBefore(db);

  let presetFingerprint = null;
  if (variant === "f5") {
    presetFingerprint = await review.fingerprintOf(group, {
      failure_type: "reasoning.decision.tool_selection",
      capability: "repo_visibility",
      gap_type: "data_stale_or_coverage",
    });
    db.prepare(`INSERT OR REPLACE INTO capability_gaps
      (fingerprint,gap_type,capability,occurrences,first_seen,last_seen,evidence_json,proposed_action,owner,status,task_id,external_ref)
      VALUES(?,?,?,0,?,?,'[]','F5 已覆盖该能力','工程师','open',NULL,'F5')`)
      .run(presetFingerprint, "data_stale_or_coverage", "repo_visibility", Date.parse(sim.nights[0].utc), Date.parse(sim.nights[0].utc));
  }

  // Build the same traces the Worker will judge, so the fake judge can bind
  // labels by trace id rather than by position in a batch.
  const traces = [];
  for (const night of sim.nights) {
    const page = await review.buildTraces({ DB: e.DB }, {
      group_id: group, window_start: night.window_start, window_end: night.window_end,
    });
    traces.push(...page.traces);
  }
  const { specs } = makeSpecs({ golden, negatives, idOf, traces, variant });
  const fetch = fakeFetch({ specs });

  const counts = [];
  for (const night of sim.nights) {
    counts.push(...await finish(e, Date.parse(night.utc), { fetch }, 1000));
  }
  for (let index = 0; index < extraNights; index++) {
    const at = Date.parse(sim.nights.at(-1).utc) + (index + 1) * DAY;
    counts.push(...await finish(e, at, { fetch }, 1000));
  }

  const result = {
    mode, variant, group, seed, db, e, golden, negatives, sim, traces, specs,
    counts, presetFingerprint, before, file, dir, idOf,
  };
  CACHE.set(key, result);
  return result;
}

export function cleanupGoldenRuns() {
  for (const dir of TEMP.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  CACHE.clear();
}
