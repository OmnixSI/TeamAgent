import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbes, compareGapRows } from "../scripts/review-probes.mjs";

const REPOS = JSON.parse(readFileSync(new URL("../config/team.json", import.meta.url), "utf8")).repositories;
const REQUIRED = [
  ...REPOS.map((repo) => `repo_changes:${repo}`),
  "repo_file",
  "bili_shortlink",
  "bili_video_no_cc",
  "xhs_note",
  "attachment_send",
  "capability_self_report",
  "image_route",
];

test("D-9 probes cover every required class with tool-layer evidence", async () => {
  const result = await runProbes({ write: false });
  assert.equal(result.schema, "ta.review.probes.v1");
  assert.equal(result.probes.length, REQUIRED.length);
  for (const name of REQUIRED) {
    const probe = result.probes.find((item) => item.name === name);
    assert.ok(probe, `missing probe ${name}`);
    assert.equal(probe.kind, "capability");
    assert.equal(typeof probe.detail, "string");
    assert.ok(probe.detail.length > 0, `${name} detail`);
    assert.equal(typeof probe.tool, "string");
    assert.ok(probe.tool.length > 0, `${name} tool`);
    assert.ok(probe.error_kind === null || typeof probe.error_kind === "string", `${name} error_kind`);
    assert.ok(["pass", "fail", "needs_model", "synthetic"].includes(probe.status), `${name} status`);
    assert.ok(typeof probe.passed === "boolean" || probe.passed === null, `${name} passed`);
  }
  const selfReport = result.probes.find((item) => item.name === "capability_self_report");
  assert.equal(selfReport.status, "needs_model");
  assert.equal(selfReport.passed, null);
  assert.match(selfReport.detail, /repo_\* readonly=true/);
  const image = result.probes.find((item) => item.name === "image_route");
  assert.equal(image.status, "synthetic");
  assert.match(image.detail, /has_image=1/);
  assert.match(image.detail, /provider=openai/);
  assert.equal(result.safety.qq_real_sends, 0);
  assert.equal(result.safety.online_d1_rows_written, 0);
  assert.equal(result.safety.paid_model_calls, 0);
  assert.equal(result.safety.unexpected_network_hits, 0);
  assert.ok(Array.isArray(result.findings));
  assert.equal(result.findings.length, result.probes.filter((probe) => probe.status === "fail").length);
  assert.ok(result.safety.fetch_hits > 0);
  assert.ok(result.safety.https_hits > 0);
  assert.ok(result.elapsed_ms < 15 * 60_000);
});

test("layer 2 uses the recorded turn_offers and never backfills from the snapshot", async () => {
  const result = await runProbes({ write: false });
  const verdict = new Map(result.gap_check.gaps.map((gap) => [gap.fingerprint, gap.verdict]));
  assert.equal(verdict.get("fp-repo-open"), "unknown_switch_or_policy_off");
  assert.equal(verdict.get("fp-xhs-fixed"), "consistent");
  assert.equal(verdict.get("fp-xhs-not-offered"), "unknown_tool_not_offered");
  assert.equal(verdict.get("fp-attach-open"), "probe_fail_gap_open");
  assert.equal(verdict.get("fp-attach-fixed"), "gap_fixed_probe_fail");
  assert.equal(verdict.get("fp-bili-open"), "unknown_no_turn_offer");
  assert.equal(verdict.get("fp-bili-fixed"), "consistent");
  assert.equal(verdict.get("fp-bili-pass-open"), "probe_pass_gap_open");
  assert.equal(result.gap_check.selftest.probe_pass_gap_open, true);
  assert.equal(result.gap_check.selftest.gap_fixed_probe_fail, true);
});

test("gap comparison distinguishes every unknown and regression path", () => {
  const probe = (capability, status) => ({ capability, status });
  const gap = (fingerprint, capability, status, id = "m1") => ({
    fingerprint, capability, gap_type: "tool_missing", status,
    evidence_json: id ? JSON.stringify([{ source: "message", id }]) : "[]",
  });
  const offer = (inbound, { names = [], switches = {}, runner_ok = 1 } = {}) => ({
    turn_id: "t-" + inbound, inbound_id: inbound, names: JSON.stringify(names),
    switches: JSON.stringify(switches), runner_ok,
  });

  let compared = compareGapRows(
    [probe("xhs_note", "pass")],
    [gap("g-pass", "xhs_note", "open")],
    [offer("m1", { names: ["read_web"] })],
  );
  assert.deepEqual(compared.flags.probe_pass_gap_open, ["g-pass"]);

  compared = compareGapRows(
    [probe("xhs_note", "fail")],
    [gap("g-regress", "xhs_note", "fixed")],
    [],
  );
  assert.deepEqual(compared.flags.gap_fixed_probe_fail, ["g-regress"]);

  compared = compareGapRows(
    [probe("xhs_note", "pass")],
    [gap("g-no-offer", "xhs_note", "open")],
    [],
  );
  assert.deepEqual(compared.flags.unknown_no_turn_offer, ["g-no-offer"]);

  compared = compareGapRows(
    [probe("repo_visibility", "pass")],
    [gap("g-switch", "repo_visibility", "open")],
    [offer("m1", { names: ["repo_changes"], switches: { "off:repo_tools": "on" } })],
  );
  assert.deepEqual(compared.flags.unknown_switch_or_policy_off, ["g-switch"]);

  compared = compareGapRows(
    [probe("attachment_send", "pass")],
    [gap("g-offline", "attachment_send", "open")],
    [offer("m1", { names: ["create_file_task"], runner_ok: 0 })],
  );
  assert.deepEqual(compared.flags.unknown_capability_offline, ["g-offline"]);

  compared = compareGapRows(
    [probe("xhs_note", "pass")],
    [gap("g-not-offered", "xhs_note", "open")],
    [offer("m1", { names: [] })],
  );
  assert.deepEqual(compared.flags.unknown_tool_not_offered, ["g-not-offered"]);

  compared = compareGapRows([probe("repo_read", "needs_model")], [gap("g-model", "repo_read", "open")], []);
  assert.deepEqual(compared.flags.unknown_needs_model, ["g-model"]);

  compared = compareGapRows([probe("image_read", "synthetic")], [gap("g-image", "image_read", "open")], []);
  assert.deepEqual(compared.flags.unknown_synthetic, ["g-image"]);

  compared = compareGapRows([], [gap("g-none", "ci_logs", "open")], []);
  assert.deepEqual(compared.flags.unknown_no_probe, ["g-none"]);
});

test("the probe JSON is written to replay/probes-<date>.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-probes-"));
  try {
    const result = await runProbes({ write: true, outDir: dir });
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^probes-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    assert.equal(data.schema, "ta.review.probes.v1");
    assert.equal(data.probes.length, REQUIRED.length);
    assert.deepEqual(Object.keys(data.capabilities).sort(), [
      "attachment_send", "bili_shortlink", "bili_video", "image_read",
      "repo_read", "repo_visibility", "xhs_note",
    ]);
    assert.equal(data.safety.qq_real_sends, 0);
    assert.equal(data.safety.online_d1_rows_written, 0);
    assert.ok(data.path.endsWith(files[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
