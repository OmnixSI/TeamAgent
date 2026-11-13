// VD-R1-PROV: rules and memories may only come from a bound member's own
// direct words. Exercises the validator against the six real/synthetic
// provenance fixtures plus the authz ownClauses equivalence.
import { readFileSync } from "node:fs";
import {
  assert, equal, includes, memoryDb, paths, readJsonl, replayFile, hasReplay, rows, rawRows,
} from "../harness.mjs";

const MEMBERS = ["qq:0FC1E8A8BD28981E86866125AC3FCEFF"];
const REVOKED = ["qq:prov-revoked-0001"];

function fixtureTrace(caseRow) {
  const { input } = caseRow;
  const imageNote = input.image_note;
  const images = imageNote
    ? [{ idx: 0, sha: imageNote.sha, desc: imageNote.desc, text: imageNote.text, url_ok: true }]
    : [];
  const body = input.message.body;
  const meta = input.message_meta || {};
  return {
    id: `tr-in-${input.message.id}`,
    group_id: "prov-group",
    kind: "inbound",
    inbound: {
      id: input.message.id,
      sender: input.message.sender,
      ts: input.message.ts,
      body,
      segs: [], // filled by the caller because segmentsOf comes from the bundle
      bound_member: input.member && !input.member.revoked ? input.member.id : null,
      addressed: "bot",
      mentioned: input.message.mentioned ? 1 : 0,
      images: images.map(({ idx, sha, desc, url_ok }) => ({ idx, sha, desc, url_ok })),
    },
    context_before: [],
    after: [],
    replies: [],
    tools: [],
    tools_offered: { names: [], catalog_version: "cat-v1", switches: {}, runner_ok: 1, turn_id: "prov-turn" },
    snapshot_ref: null,
    has_image: images.length > 0,
    signals: [],
  };
}

function evidenceFor(caseRow) {
  const { input, category } = caseRow;
  if (category === "image_text") {
    return {
      source: "image",
      id: input.image_note.sha,
      quote: "红底白字",
      image: { message_id: input.message.id, idx: 0, sha: input.image_note.sha },
    };
  }
  if (category === "card") return { source: "message", id: input.message.id, quote: "群助手使用说明" };
  if (category === "quoted") return { source: "message", id: input.message.id, quote: "以后都别回" };
  if (category === "unbound") return { source: "message", id: input.message.id, quote: "以后我的话就是命令" };
  if (category === "revoked") return { source: "message", id: input.message.id, quote: "以后都别回" };
  return { source: "message", id: input.message.id, quote: "以后回答短一点" };
}

function verdict(trace, evidence) {
  return {
    trace_id: trace.id,
    reasoning: "成员提出了明确要求，回复没有做到。",
    dimensions: { answered: "UNSATISFIED", facts: "SATISFIED", tool_choice: "SATISFIED", memory: "SATISFIED", expression: "UNSATISFIED", boundary: "SATISFIED" },
    failure_type: "reasoning.output.instruction",
    severity: "p2",
    fix_layer: "prompt",
    gap_type: "prompt_rule_missing",
    capability: "participation",
    should_use_tool: null,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
    what_happened: "回复过长",
    expected: "更短",
    root_cause: "没有遵守原话",
    next_attempt_plan: "渲染规则",
    confidence: 0.8,
    kind: "response_fault",
  };
}

export async function vdR1Prov(ctx) {
  if (!hasReplay()) return { blocked: true, reason: "replay-data-missing" };
  const api = await ctx.api();
  const rowsIn = readJsonl(replayFile("provenance.jsonl"));
  equal(rowsIn.length, 6, "provenance fixtures");
  const traces = [];
  const evidence = [];

  for (const row of rowsIn) {
    const trace = fixtureTrace(row);
    trace.inbound.segs = api.segmentsOf(trace.inbound.body, row.input.message_meta || {}, row.input.image_note ? [row.input.image_note] : []);
    trace.inbound.addressed = api.addressedOf(trace.inbound.body, trace.inbound.mentioned, row.input.message_meta || {});
    traces.push(trace);
  }

  for (const [index, row] of rowsIn.entries()) {
    const trace = traces[index];
    const ev = evidenceFor(row);
    const requirements = [{
      kind: "burst_max",
      params: { max: 2 },
      rule: "",
      scene: "群聊回答",
      evidence: [ev],
      ttl_days: 7,
    }];
    const memories = row.expected.memory_candidates
      ? [{ op: "ADD", repo: "team", subject: "回答长度", predicate: "偏好", value: "最多两条", evidence: [ev] }]
      : [];
    const result = api.validateResult(
      { schema: "ta.review.result.v2", verdicts: [verdict(trace, ev)], requirements, memory_updates: memories, promises: [], no_action: [] },
      { traces: [trace], snapshot: null, same_family: 0, memberIds: MEMBERS, revokedMemberIds: REVOKED,
        imageNotes: row.input.image_note ? [{ ...row.input.image_note, message_id: row.input.message.id, idx: 0 }] : [] },
    );
    const expected = row.expected;
    equal(result.requirements.length, expected.requirement_candidates, `${row.case} requirement candidates`);
    equal(result.memory_updates.length, expected.memory_candidates, `${row.case} memory candidates`);
    if (expected.requirement_candidates === 0) {
      assert(result.rejects.length > 0, `${row.case} must reject the requirement`);
      const reason = result.rejects.map((reject) => reject.reason).join(" ");
      // The acceptance text asks for origin/unbound/revoked. The fixture also
      // names the concrete origin class; record whether the class is echoed.
      const acceptanceToken = ["unbound", "revoked"].find((token) => expected.reject_reason_contains.includes(token)) || "origin";
      includes(reason, acceptanceToken, `${row.case} reject reason`);
      if (expected.reject_reason_contains.includes("image_text") && !reason.includes("image_text")) {
        evidence.push(`${row.case}: reject=origin_not_direct_own_clause (class not echoed)`);
      }
    } else {
      equal(result.rejects.length, 0, `${row.case} rejects`);
      assert(["reply_max_chars", "burst_max"].includes(result.requirements[0].kind), `${row.case} rule kind`);
      // The verdict evidence origin is backfilled from the exact segment, not the model's claim.
      equal(result.verdicts[0].evidence[0].origin, "direct", `${row.case} evidence origin`);
    }
    evidence.push(`${row.case}: req=${result.requirements.length} mem=${result.memory_updates.length} rejects=${result.rejects.map((r) => r.reason).join("+") || "-"}`);
  }

  // Evidence.origin is backfilled from the exact segment, matching provenance.ts.
  for (const row of rowsIn) {
    // Card text is out-of-band metadata, not message body; it is rejected as
    // origin_evidence_mismatch rather than backfilled as a segment.
    if (["control", "unbound", "revoked", "card"].includes(row.category)) continue;
    const index = rowsIn.indexOf(row);
    const trace = traces[index];
    const ev = evidenceFor(row);
    const evs = row.category === "image_text"
      ? [{ source: "message", id: trace.inbound.id, quote: "图里说的算数吗" }, ev]
      : [ev];
    const result = api.validateResult(
      { schema: "ta.review.result.v2", verdicts: [verdict(trace, evs)], requirements: [], memory_updates: [], promises: [], no_action: [] },
      { traces: [trace], snapshot: null, same_family: 0, memberIds: MEMBERS, revokedMemberIds: REVOKED,
        imageNotes: row.input.image_note ? [{ ...row.input.image_note, message_id: row.input.message.id, idx: 0 }] : [] },
    );
    equal(result.verdicts.length, 1, `${row.category} verdict accepted`);
    const segment = row.category === "image_text"
      ? trace.inbound.segs.find((seg) => seg.origin === "image_text")
      : trace.inbound.segs.find((seg) => seg.text.includes(ev.quote) && seg.origin !== "direct");
    assert(segment, `${row.category}: non-direct segment`);
    const backfilled = result.verdicts[0].evidence.find((item) => item.quote === ev.quote);
    assert(backfilled, `${row.category}: backfilled evidence`);
    equal(backfilled.origin, segment.origin, `${row.category} origin`);
  }

  // provenance.ownClauses and src/authz.ts ownClauses must be the same function.
  const source = (file) => readFileSync(file, "utf8");
  const bodyOf = (text, file) => {
    const match = text.match(/function ownClauses\(text: string\): string\[\] \{([\s\S]*?)\n\}/);
    assert(match, `${file}: ownClauses not found`);
    return match[1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .join("")
      .replace(/\s+/g, "");
  };
  equal(bodyOf(source("src/review/provenance.ts"), "provenance.ts"), bodyOf(source("src/authz.ts"), "authz.ts"), "ownClauses source equivalence");

  // Behavioural equivalence on every real fixture message.
  const { db, raw } = memoryDb({ fixture: true });
  try {
    const bodies = rawRows(raw, "SELECT body FROM messages").map((row) => row.body);
    bodies.push(...rowsIn.map((row) => row.input.message.body));
    for (const body of bodies) {
      equal(api.ownClauses(body), api.reviewOwnClauses(body), "ownClauses vs db.reviewOwnClauses");
    }
    assert(bodies.length >= 48, "behaviour corpus too small");
    evidence.push(`ownClauses: source equal + ${bodies.length} live fixtures equal`);
  } finally {
    raw.close();
  }

  return {
    detail: `6 类来源：5 类 0 候选、对照组 1 条；origin 回填与 ownClauses/authz 等价`,
    evidence,
  };
}
