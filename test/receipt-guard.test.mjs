// D4 阶段 1：回执守卫 6 个 family × {成功保留, 补建, 替换, 不重复}，外加
// 一句多 family、失败原因、existing 状态句、RC-13 负例（纯单测，不碰 D1）。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/receipt-guard.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const api = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);
const { guardReceipts, honest, CLAIMS } = api;

// 每个 family 一句只命中自己、不误伤别的 family 的承诺句。
const CASES = {
  schedule: { tool: "schedule_create", claim: "以后每天 8 点都会发日报。" },
  record: { tool: "records_write", claim: "记好了，我 360，卡特龙 50。" },
  feature: { tool: "request_feature", claim: "已立项，单号 #123。" },
  task: { tool: "prepare_project_task", claim: "已发布到工作台，标题是 L2。" },
  skill: { tool: "skill_save", claim: "这个工具做好了，以后说「查账」就行。" },
  job: { tool: "run_task", claim: "在跑了，马上好。" },
};

const FAMILIES = ["schedule", "record", "feature", "task", "skill", "job"];
const accepted = (family, extra = {}) => ({
  tool: CASES[family].tool,
  family,
  id: extra.id ?? "row-1",
  ok: true,
  ...extra,
});

test("CLAIMS keeps the frozen six-family table and order", () => {
  assert.deepEqual(CLAIMS.map((c) => c.family), FAMILIES);
  for (const c of CLAIMS) assert.ok(c.re instanceof RegExp);
});

test("each family: a successful accepted action keeps the claim sentence untouched", async () => {
  for (const family of FAMILIES) {
    const text = CASES[family].claim;
    const result = await guardReceipts({ text, accepted: [accepted(family)], failures: [] });
    assert.equal(result.text, text, family);
    assert.deepEqual(result.violations, [], family);
  }
});

test("each family: an unbacked claim is replaced with that family's honest wording", async () => {
  for (const family of FAMILIES) {
    const result = await guardReceipts({ text: CASES[family].claim, accepted: [], failures: [] });
    assert.equal(result.text, honest(family, [], 1), family);
    assert.equal(result.violations.length, 1, family);
    assert.deepEqual(result.violations[0], {
      family,
      sentence: CASES[family].claim,
      fixed: "replaced",
    });
  }
});

test("each family: an identical sentence in lastBotText switches to the second wording", async () => {
  for (const family of FAMILIES) {
    const first = honest(family, [], 1);
    const second = honest(family, [], 2);
    assert.notEqual(first, second, family);
    assert.match(second, /直接回我/, family);
    const result = await guardReceipts({
      text: CASES[family].claim,
      accepted: [],
      failures: [],
      lastBotText: "上一条：" + first,
    });
    assert.equal(result.text, second, family);
    assert.equal(result.violations[0].fixed, "replaced", family);
  }
});

test("schedule: autoLand re-creates the row, keeps the sentence and appends id + next run", async () => {
  const claim = CASES.schedule.claim;
  const seen = [];
  const result = await guardReceipts({
    text: claim,
    accepted: [],
    failures: [],
    autoLand: async (family) => {
      seen.push(family);
      return accepted("schedule", { id: "sched-123", next_run_text: "2026-11-15 08:00（悉尼）" });
    },
  });
  assert.deepEqual(seen, ["schedule"]);
  assert.equal(result.text, "以后每天 8 点都会发日报（#sched-123，下次 2026-11-15 08:00（悉尼））。");
  assert.deepEqual(result.violations, [{ family: "schedule", sentence: claim, fixed: "landed" }]);
});

test("schedule: autoLand returns null (no time in the member's words) still replaces", async () => {
  const result = await guardReceipts({
    text: CASES.schedule.claim,
    accepted: [],
    failures: [],
    autoLand: async () => null,
  });
  assert.equal(result.text, honest("schedule", [], 1));
  assert.equal(result.violations[0].fixed, "replaced");
});

test("autoLand is consulted for schedule and record claims only", async () => {
  for (const family of ["schedule", "record"]) {
    let called = 0;
    const result = await guardReceipts({
      text: CASES[family].claim,
      accepted: [],
      failures: [],
      autoLand: async () => {
        called++;
        return null;
      },
    });
    assert.equal(called, 1, family);
    assert.equal(result.text, honest(family, [], 1), family);
  }
  for (const family of ["feature", "task", "skill", "job"]) {
    let called = 0;
    const result = await guardReceipts({
      text: CASES[family].claim,
      accepted: [],
      failures: [],
      autoLand: async () => {
        called++;
        return null;
      },
    });
    assert.equal(called, 0, family);
    assert.equal(result.text, honest(family, [], 1), family);
  }
});

test("one sentence may hit several families; any satisfied family keeps it", async () => {
  const claim = "记下了，每天 8 点发日报，账也记好了。";
  const result = await guardReceipts({
    text: claim,
    accepted: [accepted("record")],
    failures: [],
  });
  assert.equal(result.text, claim, "record landed, so the schedule part must not rewrite the sentence");
  assert.deepEqual(result.violations, []);
});

test("the short 已记：… claim (outside the frozen table) is still reconciled", async () => {
  const claim = "已记：TOO 的报销额度从 ¥360 改成 ¥370，记录 #493a67。";
  const replaced = await guardReceipts({ text: claim, accepted: [], failures: [] });
  assert.equal(replaced.text, honest("record", [], 1));
  const kept = await guardReceipts({ text: claim, accepted: [accepted("record")], failures: [] });
  assert.equal(kept.text, claim);
});

test("a record claim is replaced by the real ledger receipt when autoLand lands", async () => {
  const say = "记好了（报销额度）：TOO ¥370.00，合计 ¥510.00。记录号 #abc123。";
  const claim = "已记：TOO +10，报销额度已更新。";
  const result = await guardReceipts({
    text: claim,
    accepted: [],
    failures: [],
    autoLand: async (family) => {
      assert.equal(family, "record");
      return { tool: "records_write", family: "record", id: "r1", ok: true, say };
    },
  });
  assert.equal(result.text, say);
  assert.deepEqual(result.violations, [{ family: "record", sentence: claim, fixed: "landed" }]);
});

test("ledger result phrasings outside the frozen table still trigger record reconciliation", async () => {
  for (const claim of ["加上了，TOO 现在 ¥370。", "按这笔记：TOO 370，卡特龙 50。", "鸡蛋标好了。"]) {
    const result = await guardReceipts({ text: claim, accepted: [], failures: [] });
    assert.equal(result.text, honest("record", [], 1), claim);
  }
});

test("a failed action's reason is quoted instead of a generic sentence", async () => {
  const claim = "记好了，我 360，卡特龙 50。";
  const result = await guardReceipts({
    text: claim,
    accepted: [],
    failures: [{ tool: "records_write", family: "record", ok: false, reason: "金额没说清。" }],
  });
  assert.equal(result.text, "没记上：金额没说清。");
  assert.equal(result.violations[0].fixed, "replaced");
});

test("a statement about an existing row is kept only when existing() says the row is there", async () => {
  const text = "已经建好了。";
  const calls = [];
  const kept = await guardReceipts({
    text,
    accepted: [],
    failures: [],
    existing: async (family) => {
      calls.push(family);
      return true;
    },
  });
  assert.equal(kept.text, text);
  assert.deepEqual(calls, ["schedule"]);
  assert.deepEqual(kept.violations, [{ family: "schedule", sentence: text, fixed: "kept" }]);

  const missing = await guardReceipts({
    text,
    accepted: [],
    failures: [],
    existing: async () => false,
  });
  assert.equal(missing.text, honest("schedule", [], 1));
  assert.equal(missing.violations[0].fixed, "replaced");
});

test("a future promise is not excused by existing()", async () => {
  let calls = 0;
  const result = await guardReceipts({
    text: "以后每天都会发。",
    accepted: [],
    failures: [],
    existing: async () => {
      calls++;
      return true;
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.text, honest("schedule", [], 1));
});

test("RC-03: 0 rows and a mention-only follow-up cannot say 真落地/已经建好/以后每天", async () => {
  const text = "定时推送这次真落地了，已经建好，以后每天都会发。";
  const result = await guardReceipts({
    text,
    accepted: [],
    failures: [],
    existing: async () => false,
    autoLand: async () => null,
  });
  assert.equal(result.text, honest("schedule", [], 1));
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].fixed, "replaced");
});

test("RC-13: chat about someone else's 2:10 schedule never auto-lands", async () => {
  let called = 0;
  for (const text of [
    "后面直接挂个定时任务，让它2:10自动开干。",
    "他们的 mausbot 我 2:10 刷新一次，五小时额度。",
  ]) {
    const result = await guardReceipts({
      text,
      accepted: [],
      failures: [],
      autoLand: async () => {
        called++;
        return accepted("schedule");
      },
    });
    assert.equal(result.text, text);
    assert.deepEqual(result.violations, []);
  }
  assert.equal(called, 0);
});

test("repeated claim sentences inside one reply alternate wording", async () => {
  const result = await guardReceipts({
    text: "记好了，我 360。记好了，卡特龙 50。",
    accepted: [],
    failures: [],
  });
  assert.equal(result.text, honest("record", [], 1) + honest("record", [], 2));
});

test("an accepted action without a failing reason is not replaced by a failure of another family", async () => {
  const claim = CASES.skill.claim;
  const result = await guardReceipts({
    text: claim,
    accepted: [accepted("skill")],
    failures: [{ tool: "records_write", family: "record", ok: false, reason: "金额没说清" }],
  });
  assert.equal(result.text, claim);
});

test("empty text and [[SILENT]] are returned byte-identical", async () => {
  for (const text of ["", "[[SILENT]]"]) {
    const result = await guardReceipts({ text, accepted: [], failures: [] });
    assert.equal(result.text, text);
    assert.deepEqual(result.violations, []);
  }
});
