import { quoteIn } from "../view";
import { DENY_WORDS } from "./constants";
import { capabilityNeeds, switchKeysFor } from "./catalog";
import { CAPABILITIES, DIMENSIONS, FAILURE_TYPES, FIX_LAYERS, GAP_TYPES, SEVERITIES, VERDICT,
  type Evidence, type JudgeMemoryUpdate, type JudgePromise, type JudgeRequirement, type JudgeVerdict,
  type Snapshot, type Trace } from "./types";

export type ValidateContext = {
  traces: readonly Trace[]; snapshot: Snapshot; same_family: 0 | 1;
  memberIds: readonly string[]; names?: Map<string, string>;
  /** Optional audited rows; Trace.tools itself has no audit-row id. Never resolve an id across traces. */
  toolRows?: readonly { id: string; trace_id: string; name: string; ok: boolean; error_kind: string; ms: number }[];
};
export type ReviewReject = { kind: "result" | "verdict" | "requirement" | "memory_update" | "promise";
  id: string; reason: string; detail?: string };
export type ValidatedResult = { verdicts: JudgeVerdict[]; requirements: JudgeRequirement[];
  memory_updates: JudgeMemoryUpdate[]; promises: JudgePromise[]; rejects: ReviewReject[] };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const nullableText = (v: unknown, max: number) => v === null || text(v, max);
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v);
const quote = (v: unknown): v is string => text(v, 60);

function messages(t: Trace) { return [t.inbound, ...t.context_before, ...t.after]; }
function scalarAt(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.split(".")) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" ||
      !value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return ["string", "number", "boolean"].includes(typeof value) || value === null ? value : undefined;
}
function evidenceOK(e: unknown, t: Trace, ctx: ValidateContext): e is Evidence {
  if (!record(e) || !text(e.id, 300) || !quote(e.quote)) return false;
  if (e.source === "message") {
    const row = messages(t).find(m => m.id === e.id);
    return !!row && quoteIn(row, e.quote, ctx.names);
  }
  if (e.source === "outbox") return t.replies.some(r => r.outbox_id === e.id && r.body.includes(e.quote));
  if (e.source === "snapshot") {
    const value = scalarAt(ctx.snapshot, e.id);
    return value !== undefined && String(value) === e.quote;
  }
  if (e.source === "tool") {
    const audited = ctx.toolRows?.find(r => r.id === e.id && r.trace_id === t.id);
    const rows = audited ? [audited] : t.tools === "unrecorded" ? [] : t.tools.filter(r => r.name === e.id);
    return rows.some(r => (["name", "ok", "error_kind", "ms"] as const).some(k => e.quote === `${k}=${r[k]}`));
  }
  return false;
}
const cleanEvidence = (es: Evidence[]): Evidence[] => es.map(({ source, id, quote }) => ({ source, id, quote }));
function allEvidence(es: unknown, t: Trace, ctx: ValidateContext): es is Evidence[] {
  return Array.isArray(es) && es.length > 0 && es.length <= 20 && es.every(e => evidenceOK(e, t, ctx));
}
function sourceTrace(es: unknown, ctx: ValidateContext): Trace | undefined {
  // Proposals also require all evidence to belong to one trace, never a stitched conversation.
  return ctx.traces.find(t => allEvidence(es, t, ctx));
}
function verdictShape(v: Record<string, any>): boolean {
  return text(v.trace_id, 300) && text(v.reasoning, 300) && record(v.dimensions) &&
    DIMENSIONS.every(d => oneOf(v.dimensions[d], VERDICT)) &&
    (v.failure_type === null || oneOf(v.failure_type, FAILURE_TYPES)) && oneOf(v.severity, SEVERITIES) &&
    oneOf(v.fix_layer, FIX_LAYERS) && (v.gap_type === null || oneOf(v.gap_type, GAP_TYPES)) &&
    (v.capability === null || oneOf(v.capability, CAPABILITIES) || typeof v.capability === "string" && /^other:\S.{0,79}$/u.test(v.capability)) &&
    nullableText(v.should_use_tool, 100) &&
    [v.what_happened, v.expected, v.root_cause, v.next_attempt_plan].every(s => text(s, 2000)) &&
    typeof v.confidence === "number" && Number.isFinite(v.confidence) && v.confidence >= 0 && v.confidence <= 1;
}
function correctedGap(v: JudgeVerdict, t: Trace, ctx: ValidateContext): JudgeVerdict["gap_type"] {
  const names = v.should_use_tool ? [v.should_use_tool] : t.tools === "unrecorded" ? [] : t.tools.filter(r => !r.ok).map(r => r.name);
  const tools = ctx.snapshot.tools_catalog.filter(r => names.includes(r.name));
  const switches = [...switchKeysFor(v.capability ?? ""), ...(tools.some(r => r.name.startsWith("repo_")) ? ["off:repo_tools"] : [])];
  // off:* is a disable toggle: "on" means that the capability is disabled.
  if (switches.some(k => ctx.snapshot.switches[k] === (k.startsWith("off:") ? "on" : "off"))) return "switch_or_policy_off";
  if ((tools.some(r => r.needs.includes("runner")) || capabilityNeeds(v.capability ?? "").includes("runner")) && t.snapshot_ref?.runner_ok === 0) return "capability_offline";
  return v.gap_type;
}

/** Pure validation: rejected entries never suppress other independent entries. No persistence. */
export function validateResult(raw: unknown, ctx: ValidateContext): ValidatedResult {
  const out: ValidatedResult = { verdicts: [], requirements: [], memory_updates: [], promises: [], rejects: [] };
  const reject = (kind: ReviewReject["kind"], id: string, reason: string, detail?: string) =>
    out.rejects.push({ kind, id, reason, ...(detail ? { detail } : {}) });
  if (!record(raw) || raw.schema !== "ta.review.result.v1" ||
    ![raw.verdicts, raw.requirements, raw.memory_updates, raw.promises, raw.no_action].every(Array.isArray)) {
    reject("result", "", "invalid_schema"); return out;
  }
  const seen = new Set<string>();
  for (const value of raw.verdicts) {
    const id = record(value) && typeof value.trace_id === "string" ? value.trace_id : "";
    const t = ctx.traces.find(t => t.id === id);
    if (!record(value) || !verdictShape(value) || !t || seen.has(id)) { reject("verdict", id, "invalid_verdict"); continue; }
    if (!allEvidence(value.evidence, t, ctx) || !value.evidence.some(e => e.source === "message" || e.source === "outbox")) {
      reject("verdict", id, "evidence_mismatch"); continue;
    }
    if (value.severity === "p0" && value.dimensions.boundary !== "UNSATISFIED" && value.dimensions.facts !== "UNSATISFIED") {
      reject("verdict", id, "p0_without_boundary_or_facts"); continue;
    }
    const v = value as JudgeVerdict, gap = correctedGap(v, t, ctx);
    if (gap !== v.gap_type) reject("verdict", id, "gap_snapshot_conflict", `${v.gap_type}->${gap}`);
    out.verdicts.push({ trace_id: v.trace_id, reasoning: v.reasoning,
      dimensions: Object.fromEntries(DIMENSIONS.map(d => [d, v.dimensions[d]])) as JudgeVerdict["dimensions"],
      failure_type: v.failure_type, severity: v.severity, fix_layer: v.fix_layer, gap_type: gap,
      capability: v.capability, should_use_tool: v.should_use_tool, evidence: cleanEvidence(v.evidence),
      what_happened: v.what_happened, expected: v.expected, root_cause: v.root_cause,
      next_attempt_plan: v.next_attempt_plan, confidence: Math.min(v.confidence, ctx.same_family === 1 ? 0.7 : 0.95) });
    seen.add(id);
  }
  for (const [i, r] of raw.requirements.entries()) {
    const t = record(r) ? sourceTrace(r.evidence, ctx) : undefined;
    const bound = t && r.evidence.every((e: Evidence) => e.source === "message" &&
      messages(t).some(m => m.id === e.id && ctx.memberIds.includes(m.sender)));
    if (!record(r) || !text(r.rule, 80) || !text(r.scene, 300) || !bound ||
      DENY_WORDS.some(w => r.rule.toLowerCase().includes(w.toLowerCase())) || !Number.isInteger(r.ttl_days) || r.ttl_days < 1) {
      reject("requirement", String(i), "invalid_requirement"); continue;
    }
    out.requirements.push({ rule: r.rule, scene: r.scene, evidence: cleanEvidence(r.evidence), ttl_days: Math.min(30, r.ttl_days) });
  }
  for (const [i, m] of raw.memory_updates.entries()) {
    const t = record(m) ? sourceTrace(m.evidence, ctx) : undefined;
    if (!record(m) || !oneOf(m.op, ["ADD", "UPDATE", "DELETE", "NONE"]) || !t ||
      !m.evidence.every((e: Evidence) => e.source === "message") ||
      ![m.repo, m.subject, m.predicate, m.value].every(s => text(s, 2000))) {
      reject("memory_update", String(i), "invalid_memory_update"); continue;
    }
    out.memory_updates.push({ op: m.op, repo: m.repo, subject: m.subject, predicate: m.predicate, value: m.value, evidence: cleanEvidence(m.evidence) });
  }
  for (const [i, p] of raw.promises.entries()) {
    if (!record(p) || !text(p.outbox_id, 300) || !quote(p.quote) || !text(p.what, 2000) ||
      !nullableText(p.due, 80) || p.due !== null && !Number.isFinite(Date.parse(p.due)) || !nullableText(p.recurring, 100) ||
      !ctx.traces.some(t => t.replies.some(r => r.outbox_id === p.outbox_id && r.body.includes(p.quote)))) {
      reject("promise", String(i), "invalid_promise"); continue;
    }
    out.promises.push({ outbox_id: p.outbox_id, quote: p.quote, what: p.what, due: p.due, recurring: p.recurring });
  }
  return out;
}
