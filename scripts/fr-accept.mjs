#!/usr/bin/env node
/**
 * F11 FR-5 · 一条命令跑完 S1–S17 与真实 462 条负例。
 *
 *   node scripts/fr-accept.mjs                 # 全跑，PASS 的写回 acceptance.json
 *   node scripts/fr-accept.mjs --only S8,S15   # 只跑指定场景
 *   node scripts/fr-accept.mjs --list          # 列场景
 *   node scripts/fr-accept.mjs --no-write-acceptance
 *
 * 退出码 = FAIL 数；PENDING 不算失败（工作包未合入时如实待定）。
 * 每个场景独立本地库；网络全 stub；报告写到 .agent/releases/F11/replay/。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTANCE_PATH,
  Pending,
  REPORT_DIR,
  ROOT,
  fileStamp,
  gitInfo,
  installNetworkStub,
  makeEnv as baseMakeEnv,
  networkCounters,
  restoreNetwork,
  sydneyStamp,
  writeJson,
} from "./fr-accept/harness.mjs";
import { insertMessages, loadFixture } from "./fr-accept/fixture.mjs";
import { SCENARIOS } from "./fr-accept/scenarios.mjs";

function parseArgs(argv) {
  const args = { only: null, list: false, json: false, writeAcceptance: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") args.only = (argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (a === "--list") args.list = true;
    else if (a === "--json") args.json = true;
    else if (a === "--no-write-acceptance") args.writeAcceptance = false;
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new Error("未知参数：" + a);
  }
  return args;
}

const HELP = `node scripts/fr-accept.mjs [--only S1,S8] [--list] [--json] [--no-write-acceptance]
  --only ID[,ID]          只跑指定场景（逗号分隔）
  --list                  列出场景
  --json                  额外打印完整报告 JSON
  --no-write-acceptance   不改 acceptance.json（默认只把 PASS 的 passes 改成 true）`;

function statusLine(r) {
  const name = r.id.padEnd(8);
  if (r.status === "pass") return `PASS    ${name}${r.title}（${r.checks.length} 项检查，${r.ms}ms）`;
  if (r.status === "pending") return `PENDING ${name}${r.title} — ${r.reason}`;
  return `FAIL    ${name}${r.title}`;
}

function errText(err) {
  return String(err?.stack || err?.message || err)
    .split("\n")
    .slice(0, 3)
    .join(" | ")
    .slice(0, 500);
}

function updateAcceptance(results, zeros) {
  if (!existsSync(ACCEPTANCE_PATH))
    return { updated: 0, note: "acceptance.json 不存在：" + ACCEPTANCE_PATH };
  let items;
  try {
    items = JSON.parse(readFileSync(ACCEPTANCE_PATH, "utf8"));
  } catch (err) {
    return { updated: 0, note: "acceptance.json 解析失败：" + err.message };
  }
  const byId = new Map(items.map((x) => [x.id, x]));
  const stamp = sydneyStamp();
  let updated = 0;
  for (const r of results) {
    if (r.status !== "pass") continue;
    const item = byId.get(r.id);
    if (!item) continue; // FR5-ENV / N462 不是验收条目
    item.passes = true;
    item.evidence = `node scripts/fr-accept.mjs --only ${r.id} → PASS（${r.checks.length} 项检查）；零计数 qq_real_sends=${zeros.qq_real_sends} / online_d1_rows_written=${zeros.online_d1_rows_written} / replay_network_calls=${zeros.replay_network_calls}；${stamp} Sydney`;
    updated++;
  }
  if (updated) writeJson(ACCEPTANCE_PATH, items);
  return { updated, note: updated ? "" : "没有新的 PASS，未改动" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.list) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(8)} ${s.title}`);
    console.log(`TOTAL ${SCENARIOS.length}`);
    return 0;
  }

  installNetworkStub();
  const started = Date.now();
  let fixture;
  try {
    fixture = loadFixture();
  } catch (err) {
    console.log("FIXTURE  读不到真实夹具，无法回放：" + (err.message || err));
    return 2;
  }

  const makeEnv = async (opts = {}) => {
    const e = await baseMakeEnv(opts);
    if (opts.fixture) await insertMessages(e, fixture.messages);
    return e;
  };
  const ctx = { fixture, makeEnv, ROOT };

  const all = args.only
    ? SCENARIOS.filter((s) => args.only.includes(s.id))
    : SCENARIOS;
  if (args.only) {
    const unknown = args.only.filter((id) => !SCENARIOS.some((s) => s.id === id));
    if (unknown.length) {
      console.log("未知场景：" + unknown.join(","));
      return 2;
    }
  }

  const results = [];
  try {
    for (const sc of all) {
      const t0 = Date.now();
      try {
        const out = await sc.run(ctx);
        const checks = Array.isArray(out?.checks) ? out.checks : [];
        const failed = checks.filter((c) => !c.ok);
        results.push({
          id: sc.id,
          title: sc.title,
          status: checks.length === 0 ? "fail" : failed.length ? "fail" : "pass",
          checks,
          notes: out?.notes || [],
          stats: out?.stats || null,
          error: checks.length === 0 ? "场景没有返回任何检查" : undefined,
          ms: Date.now() - t0,
        });
      } catch (err) {
        if (err instanceof Pending) {
          results.push({ id: sc.id, title: sc.title, status: "pending", reason: err.message, checks: [], ms: Date.now() - t0 });
        } else {
          results.push({ id: sc.id, title: sc.title, status: "fail", error: errText(err), checks: [], ms: Date.now() - t0 });
        }
      }
    }
  } finally {
    restoreNetwork();
  }

  const zeros = networkCounters();
  const report = {
    tool: "scripts/fr-accept.mjs",
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    sydney: sydneyStamp(started),
    git: gitInfo(),
    fixture: {
      path: fixture.file,
      sha256: fixture.sha256,
      sha256_matches_manifest: fixture.shaOk,
      bytes: fixture.bytes,
      stats: fixture.stats,
    },
    zeros,
    scenarios: results,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      pending: results.filter((r) => r.status === "pending").length,
    },
  };

  const stamped = join(REPORT_DIR, `fr-accept-${fileStamp(started)}.json`);
  writeJson(stamped, report);
  writeJson(join(REPORT_DIR, "fr-accept-latest.json"), report);

  console.log("F11 FR-5 验收回放 · " + report.sydney + " Sydney · " + (report.git.branch || "?") + " @" + (report.git.commit || "?"));
  console.log(
    `夹具 ${fixture.stats.rows} 条（sha256 ${fixture.shaOk ? "匹配" : "不匹配"} manifest，direct=${fixture.stats.direct} mentioned=${fixture.stats.mentioned}）`,
  );
  for (const r of results) {
    console.log(statusLine(r));
    if (r.status === "fail") {
      if (r.error) console.log("        - " + r.error);
      for (const c of r.checks.filter((x) => !x.ok).slice(0, 3))
        console.log(`        - ${c.name}${c.detail ? "：" + c.detail : ""}`);
    }
    if (r.notes?.length) for (const n of r.notes) console.log("        note: " + n);
  }

  const acc = args.writeAcceptance ? updateAcceptance(results, zeros) : { updated: 0, note: "--no-write-acceptance" };
  console.log(
    `TOTAL ${report.summary.total} · PASS ${report.summary.pass} · FAIL ${report.summary.fail} · PENDING ${report.summary.pending}`,
  );
  console.log(
    `零计数 qq_real_sends=${zeros.qq_real_sends} online_d1_rows_written=${zeros.online_d1_rows_written} replay_network_calls=${zeros.replay_network_calls}（stub fetch ${zeros.stub_fetch_calls} 次，其中 QQ 发送 ${zeros.stub_qq_sends} 次）`,
  );
  console.log(`报告 ${stamped}`);
  console.log(`验收 acceptance.json：${acc.updated} 条 PASS 已写回${acc.note ? "（" + acc.note + "）" : ""}`);
  if (args.json) console.log(JSON.stringify(report, null, 1));
  return report.summary.fail;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("fr-accept 崩溃：" + errText(err));
    process.exit(2);
  });
