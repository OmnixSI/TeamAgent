import { test } from "node:test";
import assert from "node:assert/strict";
import { loadReview } from "../scripts/review-accept/load.mjs";
import { hasReplay, paths } from "../scripts/review-accept/harness.mjs";
import { scoreJudgeResults, assertJudgeReport } from "../scripts/review-accept/score.mjs";

process.env.REVIEW_ACCEPT_IN_TEST = "1";

const ctx = { loadReview, api: () => loadReview(), paths };
const skipReplay = !hasReplay();

async function run(name, check, options = {}) {
  const result = await check(ctx, { id: name });
  assert.equal(result.blocked, undefined, `${name} unexpectedly blocked`);
  assert.ok(result.detail, `${name} detail`);
  return result;
}

test("VD-R-GOLDEN pins the real v2 baseline", async () => {
  const { vdRGolden } = await import("../scripts/review-accept/checks/judge.mjs");
  const result = await run("VD-R-GOLDEN", vdRGolden);
  assert.match(result.detail, /95dcdc/);
});

test("VD-R-ISO and VD-ISO keep private settings out of the request", async () => {
  const { vdRIso } = await import("../scripts/review-accept/checks/judge.mjs");
  const result = await run("VD-R-ISO", vdRIso);
  assert.match(result.detail, /confidence=0.7/);
});

test("VD-R5-BUDGET reserves before the request and settles after it", async () => {
  const { vdRBudget } = await import("../scripts/review-accept/checks/judge.mjs");
  const result = await run("VD-R5-BUDGET", vdRBudget);
  assert.match(result.detail, /cap/);
});

test("VD-R6-TRUNC splits once and never invents a finding", async () => {
  const { vdRTrunc } = await import("../scripts/review-accept/checks/judge.mjs");
  const result = await run("VD-R6-TRUNC", vdRTrunc);
  assert.match(result.detail, /judge_failed/);
});

test("VD-R7-CAP uses historical turn_offers, not the current snapshot", async () => {
  const { vdRCap } = await import("../scripts/review-accept/checks/judge.mjs");
  const result = await run("VD-R7-CAP", vdRCap);
  assert.match(result.detail, /capabilityCard/);
});

test("VD-INJ treats the injection as data and rejects the permission rule", async () => {
  const { vdRInj } = await import("../scripts/review-accept/checks/judge.mjs");
  const result = await run("VD-INJ", vdRInj);
  assert.match(result.detail, /deny-list/);
});

test("VD-R-DUAL selects dual-judge coverage and refuses disputed promotion", async () => {
  const { vdRDual } = await import("../scripts/review-accept/checks/judge.mjs");
  const result = await run("VD-R-DUAL", vdRDual);
  assert.match(result.detail, /disputed/);
});

test("VD-RULE runs the rule lifecycle end to end", async () => {
  const { vdRule } = await import("../scripts/review-accept/checks/rules.mjs");
  const result = await run("VD-RULE", vdRule);
  assert.match(result.detail, /retired/);
});

test("VD-R1-FREE keeps free text at candidate until an admin approves", async () => {
  const { vdR1Free } = await import("../scripts/review-accept/checks/rules.mjs");
  const result = await run("VD-R1-FREE", vdR1Free);
  assert.match(result.detail, /candidate/);
});

test("VD-R2-MEM never writes facts before approval", async () => {
  const { vdR2Mem } = await import("../scripts/review-accept/checks/rules.mjs");
  const result = await run("VD-R2-MEM", vdR2Mem);
  assert.match(result.detail, /候选不进 facts/);
});

test("VD-SNAP-RUN runner offline is capability_offline", async () => {
  const { vdSnapRun } = await import("../scripts/review-accept/checks/trace.mjs");
  const result = await run("VD-SNAP-RUN", vdSnapRun);
  assert.match(result.detail, /capability_offline/);
});

test("VD-R1-PROV blocks quoted/card/image/unbound/revoked sources", { skip: skipReplay }, async () => {
  const { vdR1Prov } = await import("../scripts/review-accept/checks/provenance.mjs");
  const result = await run("VD-R1-PROV", vdR1Prov);
  assert.match(result.detail, /5 类 0 候选/);
});

test("VD-R3-COVER keeps canonical outbox ownership across batch traces", { skip: skipReplay }, async () => {
  const { vdR3Cover } = await import("../scripts/review-accept/checks/trace.mjs");
  const result = await run("VD-R3-COVER", vdR3Cover);
  assert.match(result.detail, /canonical 一次/);
  assert.match(result.detail, /batch/);
});

test("VD-SNAP-SW rewrites a historically disabled tool to switch_or_policy_off", { skip: skipReplay }, async () => {
  const { vdSnapSw } = await import("../scripts/review-accept/checks/trace.mjs");
  const result = await run("VD-SNAP-SW", vdSnapSw);
  assert.match(result.detail, /switch_or_policy_off/);
});

test("blocked items stay blocked and preflight the golden trace", { skip: skipReplay }, async () => {
  const { vdBlocked } = await import("../scripts/review-accept/checks/blocked.mjs");
  const item = { id: "VD-G13", blockedBy: "D-5a" };
  const result = await vdBlocked(ctx, item);
  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "D-5a");
  assert.equal(result.preflight, "FAIL");
  assert.match(result.detail, /S7/);
});

test("failure-mode scorer counts family + gap + one root-cause key", () => {
  const golden = [
    { case: 1, expect_family: "reasoning.decision.*", expect_gap_type: "tool_not_selected", expect_root_cause_keys: ["消歧"], disputed_label: false },
    { case: 2, expect_family: "reasoning.hallucination.*", expect_gap_type: "prompt_rule_missing", expect_root_cause_keys: ["只读"], disputed_label: false },
    { case: 3, expect_family: "reasoning.output.*", expect_gap_type: "prompt_rule_missing", expect_root_cause_keys: ["连发"], disputed_label: true },
  ];
  const byCase = new Map([
    [1, [{ failure_type: "reasoning.decision.problem_id", gap_type: "tool_not_selected", root_cause: "先消歧", evidence: [] }]],
    [2, [{ failure_type: "reasoning.hallucination.tool", gap_type: "tool_missing", root_cause: "只说只读", evidence: [] }]],
    [3, [{ failure_type: "reasoning.output.instruction", gap_type: "prompt_rule_missing", root_cause: "连发", evidence: [] }]],
  ]);
  const report = scoreJudgeResults({ golden, negatives: [], byCase, evidenceCheck: () => true });
  assert.equal(report.denominator, 2);
  assert.equal(report.hits, 1);
  assert.equal(report.disputed.length, 1);
  assert.equal(report.accuracy, 0.5);
  const gate = assertJudgeReport(report);
  assert.equal(gate.ok, false);
  assert.ok(gate.failures.some((failure) => failure.includes("accuracy")));
});
