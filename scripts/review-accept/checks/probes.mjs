// D-9: run the local capability probes and read back the JSON record.
// A failed capability probe is a finding, not a check failure: the acceptance
// item covers coverage + the gap/regression comparison, not a perfect product.
import { runProbes } from "../../review-probes.mjs";
import { assert } from "../harness.mjs";

let cached = null;

export async function probeEvidence() {
  if (!cached) cached = await runProbes({ write: true });
  return cached;
}

export async function vdProbe() {
  const result = await probeEvidence();
  const required = [
    "repo_file", "bili_shortlink", "bili_video_no_cc", "xhs_note",
    "attachment_send", "capability_self_report", "image_route",
  ];
  assert(result.probes.length >= 12, `probe count ${result.probes.length}`);
  for (const name of required) assert(result.probes.some((probe) => probe.name === name), `missing probe ${name}`);
  assert(result.probes.filter((probe) => /^repo_changes:/.test(probe.name)).length >= 5, "repo_changes per repository");
  assert(result.probes.every((probe) => probe.kind === "capability" && typeof probe.detail === "string" && probe.detail), "probe record shape");
  assert(result.gap_check.selftest.probe_pass_gap_open === true, "gap selftest: probe pass + gap open");
  assert(result.gap_check.selftest.gap_fixed_probe_fail === true, "gap selftest: fixed gap + probe fail");
  assert(result.gap_check.flags.unknown_no_turn_offer?.length > 0, "gap selftest: missing turn_offers stays unknown");
  assert(result.safety.qq_real_sends === 0 && result.safety.online_d1_rows_written === 0 && result.safety.paid_model_calls === 0, "probe safety counters");
  const pass = result.probes.filter((probe) => probe.status === "pass").length;
  const fail = result.probes.filter((probe) => probe.status === "fail");
  const needs = result.probes.filter((probe) => probe.status === "needs_model").length;
  const synthetic = result.probes.filter((probe) => probe.status === "synthetic").length;
  const failure = fail.length ? `；失败 ${fail.map((probe) => `${probe.name}(${probe.error_kind})`).join(",")}（作为 gap 证据）` : "";
  return {
    detail: `D-9 探针 ${result.probes.length} 条：tool-layer pass ${pass}、fail ${fail.length}、needs_model ${needs}、synthetic ${synthetic}${failure}；gap 对照 ${result.gap_check.gaps.length} 条 + selftest 双标记；JSON ${result.path}`,
    evidence: [result.path],
  };
}
