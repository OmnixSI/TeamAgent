// D-3 acceptance checks: coverage over the three simulated nights, standalone
// outbound traces and the switch/runner snapshot rewriting contract.
import {
  assert, equal, includes, memoryDb, rows, readJsonl, replayFile, hasReplay,
  traceRun, seedGroup,
} from "../harness.mjs";

const SNAP = () => ({
  at: 1000, switches: {}, runner: { seen_age_s: 0, ok_ratio_24h: 1 },
  gateway: { ok_ratio_24h: 1 }, repo: [], jobs_24h: [], tools_catalog: [], catalog_version: "cat-v1", release: "test",
});

function traceWithOffers(switches, runnerOk, capability = "repo_read", tool = "repo_changes") {
  const body = "仓库最近改了什么";
  return {
    id: "tr-in-snap", group_id: "g", kind: "inbound",
    inbound: {
      id: "m-snap", sender: "qq:s1", ts: "2026-11-13T00:00:00Z", body,
      segs: [{ origin: "direct", text: body }], bound_member: "qq:s1", addressed: "bot", mentioned: 1, images: [],
    },
    context_before: [], after: [], replies: [{ outbox_id: "o-snap", body: "我看看", status: "sent", at: 1000, link: "reply_to" }],
    tools: [], tools_offered: { names: [tool], catalog_version: "cat-v1", switches, runner_ok: runnerOk, turn_id: "turn-snap" },
    snapshot_ref: { health_at: 1000, gateway_ok: 1, runner_ok: runnerOk }, has_image: false, signals: [],
  };
}
function verdict(trace, gap = "tool_missing") {
  return {
    trace_id: trace.id, reasoning: "当轮提供了仓库工具却没有用。", kind: "capability_gap",
    dimensions: { answered: "SATISFIED", facts: "SATISFIED", tool_choice: "UNSATISFIED", memory: "SATISFIED", expression: "SATISFIED", boundary: "SATISFIED" },
    failure_type: "reasoning.decision.tool_selection", severity: "p1", fix_layer: "tool_impl",
    gap_type: gap, capability: "repo_read", should_use_tool: "repo_changes",
    evidence: [{ source: "message", id: trace.inbound.id, quote: "仓库最近改了什么" }],
    what_happened: "没有查仓库", expected: "查仓库后回答", root_cause: "没用工具", next_attempt_plan: "用 repo_changes", confidence: 0.8,
  };
}
const result = (v) => ({ schema: "ta.review.result.v2", verdicts: [v], requirements: [], memory_updates: [], promises: [], no_action: [] });
const ctx = (traces) => ({ traces, snapshot: SNAP(), same_family: 0, memberIds: ["qq:s1"] });

export async function vdR3Cover(ctxIn) {
  if (!hasReplay()) return { blocked: true, reason: "replay-data-missing" };
  const api = await ctxIn.api();
  const run = await traceRun(ctxIn.loadReview);
  equal(run.pages.length, 3, "three simulated nights");
  const evidence = [];
  for (const [index, page] of run.pages.entries()) {
    const c = page.coverage;
    equal(c.messages, c.inbound_traces + c.skipped_by_rule, `night ${index + 1} messages accounting`);
    equal(c.outbox, c.outbox_paired + c.outbox_standalone, `night ${index + 1} outbox accounting`);
    equal(c.outbound_traces, c.outbox_standalone, `night ${index + 1} outbound traces`);
    equal(c.unaccounted, 0, `night ${index + 1} unaccounted`);
    evidence.push(`night${index + 1}: msg=${c.messages} in=${c.inbound_traces} skip=${c.skipped_by_rule} out=${c.outbox} paired=${c.outbox_paired} standalone=${c.outbox_standalone} unacc=${c.unaccounted}`);
  }

  const standalone = readJsonl(replayFile("standalone-outbox.jsonl"));
  equal(standalone.length, 24, "standalone fixture rows");
  const missing = [];
  for (const row of standalone) {
    const trace = run.traces.find((item) => item.kind === "outbound" && item.replies[0]?.outbox_id === row.id);
    if (!trace) missing.push(row.id);
  }
  equal(missing, [], "every standalone outbox has an outbound trace");
  const rid233 = standalone.find((row) => row.rid === 233);
  assert(rid233, "rid 233 present");
  assert(run.traces.some((trace) => trace.kind === "outbound" && trace.replies[0]?.outbox_id === rid233.id), "rid 233 outbound trace");
  // Outbox whose msg_id points outside the snapshot also becomes outbound.
  const outside = run.traces.find((trace) => trace.kind === "outbound" && trace.replies[0]?.outbox_id.startsWith("chat-") && trace.replies[0]?.outbox_id.includes("1-FEcP1"));
  assert(outside, "row 244 (target outside snapshot) is an outbound trace");

  // Every outbox must be audited exactly once. Batch replies currently appear
  // in every batch member's trace, so count appearances and report them.
  const seen = new Map();
  for (const trace of run.traces) {
    for (const reply of trace.replies) {
      const list = seen.get(reply.outbox_id) || [];
      list.push(`${trace.id.split("!")[0].slice(0, 24)}/${reply.link}`);
      seen.set(reply.outbox_id, list);
    }
  }
  equal(seen.size, 243, "all outbox rows appear in some trace");
  // A decision batch can cover several inbound traces; the reply is shared
  // context with link=batch, while exactly one trace owns it (reply_to/none).
  const duplicates = [...seen.entries()].filter(([, list]) => list.length > 1);
  const bad = duplicates.filter(([, list]) => {
    const canonical = list.filter((item) => item.endsWith("/reply_to") || item.endsWith("/none"));
    return canonical.length !== 1 || list.some((item) => !/\/(reply_to|none|batch)$/.test(item));
  });
  equal(bad, [], "batch replies have exactly one canonical owner and only batch context copies");
  const canonical = [...seen.values()].filter((list) => list.filter((item) => item.endsWith("/reply_to") || item.endsWith("/none")).length === 1).length;
  equal(canonical, 243, "each outbox has exactly one canonical link");
  // Cross-night overlap is deduped by trace id (design.md:204).
  const traceIds = run.traces.map((trace) => trace.id);
  equal(new Set(traceIds).size, traceIds.length, "trace ids are unique across the three nights");
  // Cursors never touch rowid, chat_cursor or processed.
  for (const sql of run.db.log) {
    assert(!/rowid/i.test(sql), `rowid used by trace SQL: ${sql.slice(0, 120)}`);
    assert(!/chat_cursor|messages\.processed/i.test(sql), `forbidden cursor column in trace SQL: ${sql.slice(0, 120)}`);
  }
  return {
    detail: `三晚覆盖账平；24 条独立外发 + 233 全部有 outbound trace；跨晚 trace id 0 重复；每条 outbox canonical 一次（${duplicates.length} 条 batch 回复作为共享上下文出现在多条 trace）；游标用 (ts,id)/(created_at,id)`,
    evidence,
  };
}

export async function vdSnapSw(ctxIn) {
  const api = await ctxIn.api();
  const { raw, db } = memoryDb({ fixture: true });
  try {
    raw.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('off:repo_tools','1')").run();
    const snapshot = await api.capabilitySnapshot({ DB: db });
    const trace = traceWithOffers({ ...snapshot.switches }, 1);
    const got = api.validateResult(result(verdict(trace, "tool_missing")), ctx([trace]));
    const gap = got.verdicts[0]?.gap_type;
    if (gap !== "switch_or_policy_off") {
      throw new Error(
        `VD-SNAP-SW FAIL (D-3): settings off:repo_tools=1 → capabilitySnapshot switches=${JSON.stringify(snapshot.switches)}；` +
        `校验后 gap=${gap}（期望 switch_or_policy_off），rejects=${JSON.stringify(got.rejects)}。` +
        `D-3 快照把「禁用」编码成 'off'，D-4 校验器按 prompt「off:*值on表示禁用」只认 'on'。`,
      );
    }
    assert(got.rejects.some((reject) => reject.reason === "gap_historical_conflict"), "switch rewrite must be recorded as reject");
    return { detail: `off:repo_tools=1 → ${JSON.stringify(snapshot.switches)} → switch_or_policy_off + reject`, evidence: ["capabilitySnapshot + validateResult"] };
  } finally { raw.close(); }
}

export async function vdSnapRun(ctxIn) {
  const api = await ctxIn.api();
  const { raw, db } = memoryDb({ fixture: true });
  try {
    const seen = Date.now() - 11 * 60_000;
    raw.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('runner_seen',?)").run(new Date(seen).toISOString());
    raw.prepare("DELETE FROM health_samples").run();
    raw.prepare("INSERT OR REPLACE INTO health_samples(at,gateway_ok,runner_ok,pending,failed) VALUES(?,1,0,0,0)").run(Date.now() - 60_000);
    const snapshot = await api.capabilitySnapshot({ DB: db });
    assert(snapshot.runner.seen_age_s >= 600, `runner_seen age ${snapshot.runner.seen_age_s}s`);
    equal(snapshot.runner.ok_ratio_24h, 0, "runner health is offline");
    const trace = traceWithOffers({}, 0);
    trace.snapshot_ref = { health_at: Date.now() - 60_000, gateway_ok: 1, runner_ok: 0 };
    trace.tools_offered.names = ["create_file_task"];
    const v = verdict(trace, "tool_missing");
    v.should_use_tool = "create_file_task";
    v.capability = "scheduling";
    const got = api.validateResult(result(v), ctx([trace]));
    equal(got.verdicts[0].gap_type, "capability_offline", "runner offline → capability_offline");
    return { detail: `runner_seen=${snapshot.runner.seen_age_s}s、runner_ok=0 → capability_offline（不改写成 tool_missing）`, evidence: ["capabilitySnapshot + validateResult"] };
  } finally { raw.close(); }
}
