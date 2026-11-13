#!/usr/bin/env node
// V-D acceptance runner: one command, one line per item.
//   node scripts/review-accept.mjs [--only ID[,ID]] [--list] [--json]
// Exit code = number of runnable FAILs. Blocked items never count as a pass.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ITEMS, ITEM_BY_ID, RUNNABLE, BLOCKED } from "./review-accept/registry.mjs";
import { loadReview } from "./review-accept/load.mjs";
import { paths, writeEvidence, cleanupEvidenceTmp } from "./review-accept/harness.mjs";
import { renderMatrix } from "./review-accept/matrix.mjs";
import {
  vdGate, vdRMig, vdD0,
} from "./review-accept/checks/gate.mjs";
import { vdR1Prov } from "./review-accept/checks/provenance.mjs";
import { vdRule, vdR1Free, vdR2Mem } from "./review-accept/checks/rules.mjs";
import { vdR3Cover, vdSnapSw, vdSnapRun } from "./review-accept/checks/trace.mjs";
import { vdRIso, vdIso, vdRGolden, vdRBudget, vdRTrunc, vdRCap, vdRInj, vdRDual } from "./review-accept/checks/judge.mjs";
import { vdBlocked } from "./review-accept/checks/blocked.mjs";

const CHECK = {
  "VD-GATE": vdGate,
  "VD-R-MIG": vdRMig,
  "VD-D0": vdD0,
  "VD-R1-PROV": vdR1Prov,
  "VD-RULE": vdRule,
  "VD-R1-FREE": vdR1Free,
  "VD-R2-MEM": vdR2Mem,
  "VD-R3-COVER": vdR3Cover,
  "VD-SNAP-SW": vdSnapSw,
  "VD-SNAP-RUN": vdSnapRun,
  "VD-R-ISO": vdRIso,
  "VD-ISO": vdIso,
  "VD-R-GOLDEN": vdRGolden,
  "VD-R5-BUDGET": vdRBudget,
  "VD-R6-TRUNC": vdRTrunc,
  "VD-R7-CAP": vdRCap,
  "VD-INJ": vdRInj,
  "VD-R-DUAL": vdRDual,
};

function parseArgs(argv) {
  const args = { only: null, list: false, json: false, matrix: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") args.only = (argv[++i] || "").split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--list") args.list = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--no-matrix") args.matrix = false;
    else if (arg === "--matrix") { args.matrix = true; args.matrixPath = argv[++i]; }
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
  }
  return args;
}

function matrixPath() {
  const release = paths().release;
  if (release) return join(release, "replay/accept-matrix.md");
  return join(process.cwd(), "accept-matrix.md");
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node scripts/review-accept.mjs [--only ID[,ID]] [--list] [--json] [--no-matrix]");
    return 0;
  }
  if (args.list) {
    for (const item of ITEMS) console.log(`${item.mode === "run" ? "RUN    " : "BLOCKED"} ${item.id} ${item.mode === "run" ? "" : "blocked_by:" + item.blockedBy}`);
    console.log(`TOTAL ${ITEMS.length} RUNNABLE ${RUNNABLE.length} BLOCKED ${BLOCKED.length}`);
    return 0;
  }
  const selected = args.only ? args.only.map((id) => {
    const item = ITEM_BY_ID.get(id);
    if (!item) throw new Error(`unknown acceptance id: ${id}`);
    return item;
  }) : ITEMS;

  const ctx = { loadReview, api: () => loadReview(), paths };
  const startedAt = new Date();
  const results = [];
  for (const item of selected) {
    let result;
    try {
      if (item.mode === "block") {
        const blocked = await vdBlocked(ctx, item);
        result = {
          status: "BLOCKED",
          blockedBy: blocked.blockedBy || item.blockedBy,
          detail: blocked.detail,
          preflight: blocked.preflight,
          evidence: blocked.evidence || [],
        };
      } else {
        const check = CHECK[item.id];
        if (!check) throw new Error(`no check registered for ${item.id}`);
        const out = await check(ctx, item);
        if (out && out.blocked) {
          result = { status: "BLOCKED", blockedBy: out.blockedBy || "data", detail: out.reason || out.detail, preflight: out.preflight };
        } else {
          result = { status: "PASS", detail: out.detail, evidence: out.evidence || [] };
        }
      }
    } catch (error) {
      if (item.mode === "block") {
        result = { status: "BLOCKED", blockedBy: item.blockedBy, detail: `${item.id}: ${error.message}`, preflight: "FAIL" };
      } else {
        result = { status: "FAIL", detail: error.message };
      }
    }
    const line = result.status === "BLOCKED"
      ? `BLOCKED ${item.id} blocked_by:${result.blockedBy} ${result.detail}${result.preflight === "FAIL" ? " | preflight FAIL" : ""}`
      : `${result.status} ${item.id} ${result.detail}`;
    console.log(line);
    results.push({ item, id: item.id, ...result });
  }

  const fails = results.filter((result) => result.status === "FAIL");
  const passes = results.filter((result) => result.status === "PASS");
  const blocked = results.filter((result) => result.status === "BLOCKED");
  const preflightFails = results.filter((result) => result.preflight === "FAIL");
  console.log(`SUMMARY total=${results.length} runnable=${passes.length + fails.length} pass=${passes.length} fail=${fails.length} blocked=${blocked.length} preflight_fail=${preflightFails.length} exit=${fails.length}`);
  if (preflightFails.length) {
    console.log(`PREFLIGHT FAIL: ${preflightFails.map((result) => `${result.id}(${result.blockedBy})`).join(" ")}`);
  }

  const log = results.map((result) => `${result.status} ${result.id} ${result.detail}`).join("\n");
  const evidence = writeEvidence("review-accept-last.log", log + "\n");
  writeEvidence("review-accept-last.json", JSON.stringify(results.map(({ item, ...rest }) => ({ id: item.id, ...rest })), null, 2));
  if (args.matrix) {
    const file = args.matrixPath || matrixPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderMatrix(results, startedAt));
    console.log(`matrix ${file}`);
  }
  if (args.json) console.log(JSON.stringify({ pass: passes.length, fail: fails.length, blocked: blocked.length, preflightFail: preflightFails.length, evidence }));
  cleanupEvidenceTmp();
  return fails.length;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`review-accept failed: ${error.stack || error.message}`);
  process.exit(2);
});
