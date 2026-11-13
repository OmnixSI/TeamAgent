// D-10b1 golden/negative checks. The judge is a fake label source: it feeds
// the golden v2 family/gap/capability into the real Worker, which still runs
// prompt building, validation, apply, publish and the rule/promise ledgers.
// These checks prove the pipeline contract, not real-model accuracy.
import { assert, equal, includes } from "../harness.mjs";
import { goldenRun, GOLDEN_CASES } from "../golden-run.mjs";

const HISTORICAL_GAPS = new Set(["tool_missing", "tool_not_selected", "switch_or_policy_off", "capability_offline"]);

function caseOf(id) {
  if (id === "VD-M4" || id === "VD-R7-M4") return "M4";
  const match = id.match(/^VD-(?:R1-)?G(\d{2})$/);
  return match ? Number(match[1]) : null;
}

function familyMatches(type, pattern) {
  if (!type || !pattern) return false;
  if (!pattern.endsWith(".*")) return type === pattern;
  return type.startsWith(pattern.slice(0, -1));
}

function findingFor(db, traceId) {
  return db.prepare("SELECT * FROM review_findings WHERE trace_id=? ORDER BY created_at,id LIMIT 1").get(traceId);
}

function parsed(row, key, fallback) {
  try { return JSON.parse(row[key]); } catch { return fallback; }
}

function effectiveGap(spec) {
  const offered = spec.trace?.tools_offered;
  const unknown = !offered || offered === "unknown";
  return HISTORICAL_GAPS.has(spec.gap) && unknown ? null : spec.gap;
}

function rejectReason(db, traceId, reasons) {
  const rows = db.prepare("SELECT raw FROM review_rejects").all();
  for (const row of rows) {
    if (!String(row.raw).includes(traceId)) continue;
    for (const reason of reasons) if (String(row.raw).includes(reason)) return reason;
  }
  return null;
}

function anyReject(db, reasons) {
  const rows = db.prepare("SELECT raw FROM review_rejects").all();
  for (const row of rows) {
    for (const reason of reasons) if (String(row.raw).includes(reason)) return reason;
  }
  return null;
}

function auditEvidence(api, db, finding) {
  const evidence = parsed(finding, "evidence_json", []);
  assert(Array.isArray(evidence) && evidence.length > 0, `${finding.trace_id} evidence is empty`);
  let checked = 0;
  for (const item of evidence) {
    if (item.source === "message") {
      const row = db.prepare("SELECT body FROM messages WHERE id=?").get(item.id);
      assert(row, `evidence message ${item.id} missing`);
      assert(api.quoteIn({ body: row.body }, item.quote), `evidence quote does not pass quoteIn: ${item.quote}`);
      checked++;
    } else if (item.source === "outbox") {
      const row = db.prepare("SELECT body FROM outbox WHERE id=?").get(item.id);
      assert(row, `evidence outbox ${item.id} missing`);
      assert(String(row.body).includes(item.quote), `evidence quote not in outbox ${item.id}: ${item.quote}`);
      checked++;
    }
  }
  assert(checked > 0, `${finding.trace_id} has no message/outbox evidence`);
  return checked;
}

export async function vdGolden(ctx, item) {
  const run = await goldenRun({ mode: "full", extraNights: 1 });
  const { db, e } = run;
  const api = await ctx.api();
  const id = caseOf(item.id);
  assert(id !== null, `not a golden item: ${item.id}`);
  const spec = id === "M4" ? run.specs.get([...run.specs.entries()].find(([, s]) => s.m4Role === "primary")?.[0]) : [...run.specs.values()].find((s) => s.row.case === id);
  assert(spec, `no trace mapping for golden case ${id}`);
  const trace = spec.trace;
  const finding = findingFor(db, trace.id);
  assert(finding, `${item.id}: no finding on ${trace.id}`);

  const row = spec.row;
  assert(familyMatches(finding.failure_type, row.expect_family), `${item.id}: family ${finding.failure_type} does not match ${row.expect_family}`);
  if (spec.capability) assert(finding.capability === spec.capability, `${item.id}: capability ${finding.capability} != ${spec.capability}`);
  if (spec.tool) assert(finding.should_use_tool === spec.tool, `${item.id}: should_use_tool ${finding.should_use_tool} != ${spec.tool}`);
  assert(finding.severity === spec.severity, `${item.id}: severity ${finding.severity} != ${spec.severity}`);

  const gap = effectiveGap(spec);
  assert(finding.gap_type === gap, `${item.id}: gap ${finding.gap_type} != effective ${gap}`);
  const dimensions = parsed(finding, "dimensions_json", parsed(finding, "dimensions", {}));
  const dimensionText = typeof dimensions === "string" ? dimensions : JSON.stringify(dimensions);
  let gapNote = "";
  if (gap === null && spec.gap !== null) {
    assert(/"tool_choice":"INSUFFICIENT"/.test(dimensionText), `${item.id}: historical gap must set tool_choice=INSUFFICIENT, got ${dimensionText}`);
    const reason = rejectReason(db, trace.id, ["gap_historical_conflict", "historical_capability_unknown"]);
    assert(reason, `${item.id}: missing historical gap reject`);
    gapNote = `；期望 gap=${spec.gap}，无 turn_offers 按 D-4 R7-CAP → null/INSUFFICIENT（${reason}）`;
  } else {
    gapNote = `；gap=${gap}`;
  }
  const evidenceCount = auditEvidence(api, db, finding);

  let extra = "";
  if (id === 13) {
    assert(/"expression":"UNSATISFIED"/.test(dimensionText), `${item.id}: expression must be UNSATISFIED`);
    const rule = db.prepare("SELECT * FROM behavior_rules WHERE kind='burst_max' ORDER BY created_at,id LIMIT 1").get();
    if (rule) {
      const params = parsed(rule, "params", {});
      const ttlDays = (Number(rule.expires_at) - Number(rule.created_at)) / 86_400_000;
      assert(params.max === 1, `${item.id}: burst_max max=${params.max}, expected 1`);
      assert(ttlDays <= 7.0001, `${item.id}: burst_max ttl=${ttlDays} days, expected <=7`);
      extra = `；burst_max(max=1, ttl=${Math.round(ttlDays)}d)=${rule.status}`;
    } else {
      const reason = anyReject(db, ["not_addressed_to_bot", "origin_not_direct_own_clause", "not_explicit_request"]);
      assert(reason, `${item.id}: no burst_max rule and no requirement reject`);
      extra = `；规则 INSUFFICIENT：message 95 未被 @/回复，D-5b 准入 ${reason} 拒绝（fail-closed）`;
    }
    extra += `；S7=${trace.signals.includes("S7") ? "present" : "absent(v2 真实数据)"}`;
  }
  if (id === 20) {
    assert(finding.gap_type === null, `${item.id}: gap must be null`);
    assert(finding.evidence_json.includes("outbox"), `${item.id}: evidence must cite outbox 233`);
    extra = `；S9=${trace.signals.includes("S9") ? "present" : "absent(v2 真实数据，judge 结合上下文)"}`;
  }
  if (id === 17) {
    const inboundIds = row.inbound_rowids.map((rowid) => run.idOf("messages", rowid));
    const traces = inboundIds.map((messageId) => run.traces.find((t) => t.inbound?.id === messageId)).filter(Boolean);
    assert(traces.length === row.inbound_rowids.length, `${item.id}: missing inbound traces`);
    assert(traces.every((t) => t.signals.includes("S1")), `${item.id}: not all 5 inbound traces carry S1`);
    assert(/"answered":"UNSATISFIED"/.test(dimensionText), `${item.id}: answered must be UNSATISFIED`);
    extra = `；${traces.length} 条 inbound 全 S1，answered=UNSATISFIED`;
  }

  return {
    detail: `假 judge 金标 #${id} 三晚：family=${finding.failure_type}${gapNote}；capability=${finding.capability ?? "null"}；evidence=${evidenceCount} 条逐字${extra}`,
    evidence: [],
  };
}

const NEGATIVES = {
  "VD-N01": [{ outbox: 52 }],
  "VD-N02": [{ outbox: 56 }],
  "VD-N03": [{ outbox: 64 }],
  "VD-N04": [{ outbox: 91 }],
  "VD-N05": [{ outbox: 130 }],
  "VD-N06": [{ outbox: 195 }, { outbox: 198 }],
  "VD-N07": [{ inbound: 437, outbox: 243 }],
};

export async function vdNegative(ctx, item) {
  const run = await goldenRun({ mode: "full", extraNights: 1 });
  const { db } = run;
  const spec = NEGATIVES[item.id];
  assert(spec, `no negative mapping for ${item.id}`);
  const traceIds = [];
  for (const entry of spec) {
    if (entry.inbound) {
      const messageId = run.idOf("messages", entry.inbound);
      const trace = run.traces.find((t) => t.inbound?.id === messageId);
      assert(trace, `${item.id}: no inbound trace for ${entry.inbound}`);
      traceIds.push(trace.id);
    }
    if (entry.outbox) {
      const outboxId = run.idOf("outbox", entry.outbox);
      const trace = run.traces.find((t) => t.replies.some((reply) => reply.outbox_id === outboxId));
      assert(trace, `${item.id}: no outbox trace for ${entry.outbox}`);
      traceIds.push(trace.id);
    }
  }
  const bad = [];
  for (const traceId of traceIds) {
    const findings = db.prepare("SELECT id,severity FROM review_findings WHERE trace_id=?").all(traceId);
    for (const finding of findings) {
      if (item.id === "VD-N07" || ["p0", "p1"].includes(finding.severity)) bad.push(`${traceId.slice(0, 18)}/${finding.severity}`);
    }
  }
  equal(bad, [], `${item.id}: negative trace has p1+ finding`);
  return { detail: `${item.id} 负样本 trace ${traceIds.length} 条无 p1+ finding（假 judge 同批仍有 issue 标签，验证 trace 隔离）`, evidence: [] };
}

export async function vdR7M4(ctx, item) {
  const run = await goldenRun({ mode: "full", extraNights: 1 });
  const { db } = run;
  const m4 = run.golden.find((row) => row.case === "M4");
  assert(m4, "M4 golden row missing");
  const t145 = run.traces.find((t) => t.replies.some((reply) => reply.outbox_id === run.idOf("outbox", m4.outbox_rowids[0])));
  const t149 = run.traces.find((t) => t.replies.some((reply) => reply.outbox_id === run.idOf("outbox", m4.outbox_rowids[1])));
  assert(t145 && t149, "M4 traces missing");
  assert(!t145.signals.includes("S10"), "M4: 145 must not carry S10 in the real data");
  assert(t149.signals.includes("S10"), "M4: 149 must carry S10 in the real data");
  const f145 = findingFor(db, t145.id);
  assert(f145, "M4: 145 finding missing");
  assert(f145.severity === "p2", `M4: 145 severity ${f145.severity}, expected p2 INSUFFICIENT probe`);
  const dimensions = parsed(f145, "dimensions", {});
  assert(dimensions.facts === "INSUFFICIENT", `M4: 145 facts=${dimensions.facts}`);
  assert(dimensions.tool_choice === "INSUFFICIENT", `M4: 145 tool_choice=${dimensions.tool_choice}`);
  assert(!findingFor(db, t149.id), "M4: 149 must not receive a finding");
  return {
    detail: `M4：145 无 S10、facts/tool_choice=INSUFFICIENT（p2 探针）；149 有 S10 且无 finding（成功自纠）；证据逐字 ${auditEvidence(await ctx.api(), db, f145)} 条`,
    evidence: [],
  };
}
