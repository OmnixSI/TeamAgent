// Blocked acceptance items. Each item keeps its full assertion in the matrix
// and runs the preflight that can run today. The result is always BLOCKED,
// never a synthetic pass; a failed precondition is reported separately.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assert, equal, includes, memoryDb, paths, readJsonl, replayFile, hasReplay,
  rowidId, seedGroup, traceRun,
} from "../harness.mjs";
import { staticGuard, secretScanText, seedSecretScan, fakeKeyScan } from "./guard.mjs";

let goldenCache = null;
async function goldenInfo(ctx) {
  if (goldenCache) return goldenCache;
  if (!hasReplay()) return null;
  const run = await traceRun(ctx.loadReview);
  const golden = readJsonl(replayFile("golden.jsonl"));
  const negatives = readJsonl(replayFile("negatives.jsonl"));
  const traceForOutbox = (id) => run.traces.find((trace) => trace.replies.some((reply) => reply.outbox_id === id));
  const traceForMessage = (id) => run.traces.find((trace) => trace.inbound?.id === id);
  goldenCache = { run, golden, negatives, traceForOutbox, traceForMessage };
  return goldenCache;
}

function goldenByCase(info, id) {
  if (id === "VD-M4" || id === "VD-R7-M4") return info.golden.find((row) => row.case === "M4") || null;
  const match = id.match(/^VD-(?:R1-)?G(\d{2})$/);
  if (!match) return null;
  const number = Number(match[1]);
  return info.golden.find((row) => row.case === number) || null;
}

function tracePreflight(info, row) {
  const problems = [];
  const inboundIds = row.inbound_rowids.map((rowid) => rowidId(info.run.raw, "messages", rowid));
  const outboxIds = row.outbox_rowids.map((rowid) => rowidId(info.run.raw, "outbox", rowid));
  if (inboundIds.some((id) => !id)) problems.push(`inbound rowid missing: ${row.inbound_rowids.filter((rowid, i) => !inboundIds[i]).join(",")}`);
  if (outboxIds.some((id) => !id)) problems.push(`outbox rowid missing: ${row.outbox_rowids.filter((rowid, i) => !outboxIds[i]).join(",")}`);
  const traces = inboundIds.filter(Boolean).map((id) => info.traceForMessage(id));
  const missing = inboundIds.filter(Boolean).filter((id, i) => !traces[i]).map((id) => id.slice(0, 16));
  if (missing.length) problems.push(`no inbound trace: ${missing.join(",")}`);
  const outboxTraces = outboxIds.filter(Boolean).map((id) => info.traceForOutbox(id));
  const missingOut = outboxIds.filter(Boolean).filter((id, i) => !outboxTraces[i]).map((id) => id.slice(0, 16));
  if (missingOut.length) problems.push(`no outbox trace/reply: ${missingOut.join(",")}`);
  return { problems, traces: traces.filter(Boolean), outboxTraces: outboxTraces.filter(Boolean), inboundIds, outboxIds };
}

async function goldenPreflight(ctx, item) {
  const info = await goldenInfo(ctx);
  if (!info) return { ok: false, detail: "replay-data-missing" };
  const row = goldenByCase(info, item.id);
  if (!row) return { ok: false, detail: `golden case missing for ${item.id}` };
  const pf = tracePreflight(info, row);
  const problems = [...pf.problems];
  if (item.id === "VD-G13" || item.id === "VD-R1-G13") {
    const trace = pf.traces[0];
    if (!trace?.signals.includes("S7")) problems.push("D-3: message 95 trace has no S7 (only one reply is paired to it; 77–82 are paired to 96–101)");
    if (row.expect_rule && (row.expect_rule.kind !== "burst_max" || row.expect_rule.params?.max !== 1 || row.expect_rule.ttl_days_max > 7)) {
      problems.push("golden case 13 expect_rule is not burst_max max=1 ttl<=7");
    }
  }
  if (item.id === "VD-G20") {
    const out = pf.outboxTraces[0];
    if (!out?.signals.includes("S9")) problems.push("D-3: outbound 233 trace has no S9 (scout outbox has no decision/spoken_kind; prior S3 window not applied)");
  }
  if (item.id === "VD-M4" || item.id === "VD-R7-M4") {
    const a = pf.outboxTraces[0], b = pf.outboxTraces[1];
    if (!a?.signals.includes("S10")) problems.push("D-3: outbox 145 trace has no S10 (contradiction is with 149, a later turn)");
    if (!b?.signals.includes("S10")) problems.push("D-3: outbox 149 trace has no S10");
  }
  return {
    ok: problems.length === 0,
    detail: `golden #${row.case}: ${pf.traces.length}/${row.inbound_rowids.length} inbound trace、${pf.outboxTraces.length}/${row.outbox_rowids.length} outbox trace` +
      (problems.length ? `；${problems.join("；")}` : ""),
  };
}

async function negativePreflight(ctx, item) {
  const info = await goldenInfo(ctx);
  if (!info) return { ok: false, detail: "replay-data-missing" };
  const byId = {
    "VD-N01": { outbox: [52] }, "VD-N02": { outbox: [56] }, "VD-N03": { outbox: [64] },
    "VD-N04": { outbox: [91] }, "VD-N05": { outbox: [130] }, "VD-N06": { outbox: [195, 198] },
    "VD-N07": { inbound: 437, outbox: [243] },
  }[item.id];
  const problems = [];
  for (const rowid of byId.outbox || []) {
    const id = rowidId(info.run.raw, "outbox", rowid);
    if (!id) problems.push(`outbox rowid ${rowid} missing`);
    else if (!info.traceForOutbox(id)) problems.push(`outbox ${rowid} has no trace`);
  }
  if (byId.inbound) {
    const id = rowidId(info.run.raw, "messages", byId.inbound);
    if (!id) problems.push(`inbound rowid ${byId.inbound} missing`);
    else if (!info.traceForMessage(id)) problems.push(`inbound ${byId.inbound} has no trace`);
  }
  return { ok: problems.length === 0, detail: `${item.id} 输入行存在${problems.length ? "；" + problems.join("；") : ""}` };
}

function missingFile(file) {
  return !existsSync(file);
}

async function idempotencySubcheck(ctx) {
  const api = await ctx.api();
  const { raw, db } = memoryDb();
  try {
    const now = Date.parse("2026-11-14T00:00:00Z");
    raw.prepare("INSERT INTO members(id,name,token_hash) VALUES('qq:s1','成员','x')").run();
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m1','g','qq:s1','以后请只给结论',?,1)").run(new Date(now).toISOString());
    raw.prepare("INSERT INTO message_meta(id,json) VALUES('m1','{}')").run();
    raw.prepare(`INSERT INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,status,created_at)
      VALUES('f1','night1','tr-m1','reasoning.output.instruction','p1','prompt','{}',?,'x','y','z','w',0.9,'agree','open',?)`)
      .run(JSON.stringify([{ source: "message", id: "m1", quote: "以后请只给结论" }]), now);
    const [rule] = await api.applyRequirements({ DB: db }, { id: "night1", group_id: "g", now }, [{
      kind: "burst_max", params: { max: 1 }, rule: "", scene: "群聊", evidence: [{ source: "message", id: "m1", quote: "以后请只给结论", origin: "direct" }], ttl_days: 7,
    }]);
    const ruleText = raw.prepare("SELECT rule FROM behavior_rules WHERE id=?").get(rule).rule;
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m2','g','qq:s1',?,?,1)")
      .run(`纠正：不要${ruleText}`, new Date(now + 86_400_000).toISOString());
    raw.prepare(`INSERT INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,status,created_at)
      VALUES('f2','night2','tr-m2','reasoning.output.instruction','p1','prompt','{}',?,'x','y','z','w',0.9,'agree','open',?)`)
      .run(JSON.stringify([{ source: "message", id: "m2", quote: `不要${ruleText}` }]), now + 86_400_000);
    await api.advanceRules({ DB: db }, { id: "night2", group_id: "g", now: now + 86_400_000 });
    const first = raw.prepare("SELECT corrections FROM behavior_rules WHERE id=?").get(rule).corrections;
    await api.advanceRules({ DB: db }, { id: "night2", group_id: "g", now: now + 86_400_000 });
    const second = raw.prepare("SELECT corrections FROM behavior_rules WHERE id=?").get(rule).corrections;
    equal(first, second, "correction ledger is idempotent");
    const task = {
      sql: "INSERT OR IGNORE INTO tasks(id,repo,title,detail,status,source_id,created_at,updated_at) VALUES('rv-abc','OmnixSI/TeamAgent','[复盘] 测试','detail','proposal','review:abc',?,?)",
      params: [new Date(now).toISOString(), new Date(now).toISOString()],
    };
    await api.reviewBatch({ DB: db }, [task]);
    await api.reviewBatch({ DB: db }, [task]);
    equal(raw.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='rv-abc'").get().n, 1, "task replay is idempotent");
    return `rules.corrections=${first} 重跑不变、rv-abc 重放 1 行（apply/pipeline 属 D-5a）`;
  } finally { raw.close(); }
}

const WORKER_BLOCKED = ["VD-NIGHT", "VD-SWITCH", "VD-DST", "VD-API", "VD-BUDGET", "VD-R-SHADOW-LOCAL"];
const PIPELINE_BLOCKED = ["VD-M2", "VD-M3", "VD-M5", "VD-F5"];

export async function vdBlocked(ctx, item) {
  const id = item.id;
  const pkg = item.blockedBy;
  let detail = `等待 ${pkg} 合入`;
  let ok = true;

  if (/^VD-G\d{2}$/.test(id) || /^VD-N\d{2}$/.test(id) || id === "VD-GOLD-SUM" || id === "VD-M4" || id === "VD-R7-M4" || id === "VD-R1-G13" || id === "VD-R-JUDGE") {
    if (id === "VD-GOLD-SUM" || id === "VD-R-JUDGE") {
      const info = await goldenInfo(ctx);
      if (!info) { ok = false; detail = "replay-data-missing"; }
      else {
        const numbered = info.golden.filter((row) => typeof row.case === "number");
        const disputed = info.golden.filter((row) => row.disputed_label);
        const score = existsSync("scripts/review-accept/score.mjs");
        ok = numbered.length === 20 && info.negatives.length === 8 && score;
        detail = `golden=${info.golden.length}（编号 ${numbered.length}，disputed ${disputed.length}）negatives=${info.negatives.length} scorer=${score}；真实首判/复核属 D-10b`;
      }
    } else if (/^VD-N\d{2}$/.test(id)) {
      const pf = await negativePreflight(ctx, item);
      ok = pf.ok; detail = pf.detail;
    } else {
      const pf = await goldenPreflight(ctx, item);
      ok = pf.ok; detail = pf.detail;
    }
  } else if (id === "VD-M1" || id === "VD-M1b") {
    const info = await goldenInfo(ctx);
    const jobs = info ? info.run.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='dream'").get().n : "no-replay";
    ok = !existsSync("src/review/dream.ts") && !existsSync("src/review/night.ts");
    detail = `dream jobs=${jobs}；D-7 尚无 dream/turn_offers 写入代码`;
  } else if (PIPELINE_BLOCKED.includes(id)) {
    ok = missingFile("src/review/apply.ts") && missingFile("src/review/publish.ts");
    detail = `apply.ts/publish.ts 未合入；${ok ? "确认等待 D-5a" : "文件已出现，需重跑本项"}`;
  } else if (WORKER_BLOCKED.includes(id)) {
    ok = missingFile("wrangler.review.toml") && missingFile("src/review/worker.ts");
    detail = `review Worker/cron 未合入（wrangler.review.toml=${existsSync("wrangler.review.toml")}）`;
  } else if (id === "VD-PULL") {
    ok = missingFile("scripts/review-pull.mjs");
    detail = "scripts/review-pull.mjs 未合入（D-8）";
  } else if (id === "VD-PROBE" || id === "VD-EXPLORE") {
    ok = missingFile("scripts/review-probes.mjs");
    const info = await goldenInfo(ctx);
    const gaps = info ? info.run.raw.prepare("SELECT COUNT(*) AS n FROM capability_gaps").get().n : "no-replay";
    detail = `scripts/review-probes.mjs 未合入；种子 capability_gaps=${gaps}（D-9）`;
  } else if (id === "VD-UI") {
    const spec = paths().release && join(paths().release, "ui-spec.md");
    ok = true; // D-12 owns the spec; absence is recorded, not a script failure.
    detail = `ui-spec.md ${spec && existsSync(spec) ? "已存在" : "未在资料目录"}；看板实现属 D-12`;
  } else if (id === "VD-SHADOW" || id === "VD-R-SHADOW-PROD") {
    ok = missingFile("wrangler.review.toml");
    detail = "线上 review Worker 未部署（D-11）";
  } else if (id === "VD-R-D0B") {
    const note = paths().release && join(paths().release, "notes/D-0b.md");
    ok = true;
    detail = `notes/D-0b.md ${note && existsSync(note) ? "已存在" : "未产出"}；需 D-0b 实测`;
  } else if (id === "VD-R-KEY") {
    const api = await ctx.api();
    staticGuard();
    secretScanText();
    seedSecretScan();
    fakeKeyScan(api);
    ok = missingFile("wrangler.review.toml");
    detail = `静态脱敏/种子/夹具 0 命中；整晚假密钥 401/超时需 D-6（toml=${existsSync("wrangler.review.toml")}）`;
  } else if (id === "VD-R-GUARD") {
    staticGuard();
    const info = await goldenInfo(ctx);
    const before = info ? info.run.raw.prepare("SELECT COUNT(*) AS n FROM outbox").get().n : null;
    ok = true;
    detail = `静态扫描通过；三晚运行 outbox 行数（种子 ${before}）不变需 D-6`;
  } else if (id === "VD-SAFE") {
    staticGuard();
    secretScanText();
    seedSecretScan();
    ok = true;
    detail = "静态扫描与导出 0 命中；缺三晚回放日志首行与 D-6 守卫测试";
  } else if (id === "VD-R4-IDEM") {
    const sub = await idempotencySubcheck(ctx);
    ok = missingFile("src/review/apply.ts");
    detail = `${sub}；中断/并发/迟到旧代需 D-5a`;
  } else if (id === "VD-R-IMG") {
    const info = await goldenInfo(ctx);
    const images = info ? info.run.raw.prepare("SELECT COUNT(*) AS n FROM message_images").get().n : "no-replay";
    const notes = info ? info.run.raw.prepare("SELECT COUNT(*) AS n FROM image_notes WHERE text IS NOT NULL").get().n : "no-replay";
    ok = true;
    detail = `线上 message_images=${images}、有文字 image_notes=${notes}，无真实带图样本；探针属 D-9`;
  } else if (id === "VD-GATE" || id === "VD-R-MIG" || id === "VD-D0") {
    // These are runnable; reaching here means the registry drifted.
    ok = false; detail = "registry marks this runnable";
  } else {
    ok = true;
  }

  return {
    blocked: true,
    blockedBy: pkg,
    detail,
    preflight: ok ? "PASS" : "FAIL",
  };
}
