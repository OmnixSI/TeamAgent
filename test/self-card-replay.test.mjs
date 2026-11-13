import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  readFacts,
  readRepo,
  repoPath,
  buildChecks,
  evaluateAnswer,
} from "./self-card-facts.mjs";
import {
  loadQuestions,
  replayAvailability,
  loadReplayApi,
  readCardCommit,
  prepareEnv,
  renderQuestion,
} from "./self-card-harness.mjs";

const FACTS = readFacts();
const CHECKS = buildChecks(FACTS);
const QUESTIONS = loadQuestions();
const AVAIL = replayAvailability();

const skipReason = AVAIL.ready
  ? false
  : AVAIL.touched
    ? "SK-1/SK-2 文件只合入了一部分，回放不能开始（见失败项）"
    : "SK-1/SK-2 尚未合入 release/SK：样例夹具阶段只校验事实抽取和问法";

function failureText(result, answer) {
  return [
    ...result.failures,
    "--- 实际回答（截断 800 字）---",
    String(answer).slice(0, 800),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Code facts. These are deliberately independent of the generated card.
// ---------------------------------------------------------------------------

test("F1 生图事实：模型、主机、每人每天限额都从源码读出", () => {
  assert.equal(FACTS.image.tool, "generate_image");
  assert.equal(FACTS.image.vendor, "OpenAI");
  assert.equal(FACTS.image.host, "api.openai.com");
  assert.ok(FACTS.image.model.length > 3, "模型名不能为空");
  assert.ok(Number.isInteger(FACTS.image.dailyLimit) && FACTS.image.dailyLimit > 0);
  assert.deepEqual(FACTS.image.files, ["src/imagegen.ts", "src/tools/generate-image.ts"]);
  // The constant, not the prose in capability-card.ts, is the source of truth.
  const constant = readRepo("src/tools/generate-image.ts").match(/DEFAULT_USER_DAILY\s*=\s*(\d+)/)?.[1];
  assert.equal(String(FACTS.image.dailyLimit), constant);
});

test("F2 语音识别事实：QQ 平台转写 + 视频音轨本机 X-ASR（三条路径读代码）", () => {
  assert.equal(FACTS.asr.local, true);
  assert.ok(FACTS.asr.providers.some((p) => p.vendor === "腾讯 QQ"));
  assert.ok(FACTS.asr.providers.some((p) => p.vendor === "X-ASR" && p.where === "本机"));
  assert.ok(FACTS.asr.files.includes("runner/asr.mjs"));
  assert.match(readRepo("runner/media.mjs"), /from\s+['"]\.\/asr\.mjs['"]/);
  assert.match(readRepo("src/inbound.ts"), /asr_refer_text/);
});

test("F3 看图事实：Workers AI 的 @cf 模型，不是 OpenAI", () => {
  assert.equal(FACTS.vision.vendor, "Cloudflare Workers AI");
  assert.match(FACTS.vision.model, /^@cf\//);
  assert.ok(FACTS.vision.files.includes("src/vision.ts"));
  assert.ok(FACTS.vision.files.includes("src/runtime.ts"));
});

test("F4 回复模型事实：config/team.json 的模型名 + api.deepseek.com", () => {
  assert.equal(FACTS.reply.vendor, "DeepSeek");
  assert.equal(FACTS.reply.host, "api.deepseek.com");
  const team = JSON.parse(readRepo("config/team.json"));
  assert.equal(FACTS.reply.model, team.model.name);
});

test("F5 仓库事实：入口、目录、D1 表、cron、队列、绑定都来自仓库文件", () => {
  assert.equal(FACTS.repo.entry, "src/worker.ts");
  for (const dir of ["src", "runner", "migrations", "scripts"])
    assert.ok(FACTS.repo.dirs.some((d) => d.path === dir), dir);
  for (const table of ["messages", "outbox", "settings", "jobs"])
    assert.ok(FACTS.repo.schemaTables.includes(table), table);
  const schemaCount = (readRepo("schema.sql").match(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS/gi) || []).length;
  assert.equal(FACTS.repo.schemaTables.length, schemaCount);
  assert.deepEqual(FACTS.repo.crons, ["* * * * *"]);
  assert.deepEqual(FACTS.repo.queues.sort(), ["inkboard-team", "inkboard-team-chat", "team-agent-tools"].sort());
  for (const binding of ["DB", "WORK", "CHAT", "TOOLS", "AI"])
    assert.ok(FACTS.repo.bindings.includes(binding), binding);
});

test("F6 语音合成事实：edge-tts 主路径 + DeepSeek 回退 + SILK", () => {
  assert.equal(FACTS.tts.primary, "edge-tts");
  assert.equal(FACTS.tts.fallback, "DeepSeek");
  assert.equal(FACTS.tts.silk, "SILK");
  assert.ok(FACTS.tts.files.includes("runner/tts.mjs"));
});

// ---------------------------------------------------------------------------
// Corpus shape and expectation wiring.
// ---------------------------------------------------------------------------

test("Q1 问法库：9 组、每组 2 个口语变体、至少 18 条", () => {
  assert.ok(QUESTIONS.groups.length >= 9);
  let total = 0;
  const ids = new Set();
  for (const group of QUESTIONS.groups) {
    assert.ok(group.questions.length >= 2, `${group.id} 少于 2 条`);
    for (const q of group.questions) {
      assert.ok(q.id && q.text && (q.topic || group.topic), `${group.id} 缺字段`);
      assert.ok(!ids.has(q.id), `重复问法 id ${q.id}`);
      ids.add(q.id);
      total++;
    }
  }
  assert.ok(total >= 18, `只有 ${total} 条`);
  for (const required of ["你这个生图是怎么实现的", "语音识别用的哪家", "你和 OpenAI 还是 DeepSeek 接的", "你的仓库是怎么组成的", "看图用什么模型", "你能发语音吗", "你跑在哪里，本机还是云端", "你的代码在哪个文件"])
    assert.ok([...QUESTIONS.groups.flatMap((g) => g.questions)].some((q) => q.text === required), required);
});

test("Q2 每条期望都能落到一个代码事实检查上", () => {
  for (const group of QUESTIONS.groups) {
    const keys = new Set(group.expect || []);
    for (const q of group.questions) for (const key of q.expect || []) keys.add(key);
    for (const state of group.states || []) for (const key of state.expect || []) keys.add(key);
    assert.ok(keys.size > 0, `${group.id} 没有期望事实`);
    for (const key of keys) assert.ok(CHECKS[key], `${group.id}: 未知事实键 ${key}`);
  }
});

test("Q3 样例夹具只是脚手架：它可能与当前代码不一致，不能当验收卡", () => {
  const sample = JSON.parse(fs.readFileSync(repoPath("test/fixtures/self-card.sample.json"), "utf8"));
  const image = sample.capabilities.find((c) => c.id === "image_generation");
  const sampleModel = image?.providers?.[0]?.model;
  // This test is diagnostic, not a gate: the real card comes from SK-1.
  // If the sample is stale the mismatch is printed so nobody accepts with it.
  if (sampleModel !== FACTS.image.model)
    console.error(`[SK-3] sample fixture model ${sampleModel} != code ${FACTS.image.model}; sample is scaffold only`);
  assert.ok(sample.schema === 1);
});

// ---------------------------------------------------------------------------
// A layer: deterministic replay through the real describe_self tool.
// ---------------------------------------------------------------------------

test("A1 SK-1/SK-2 合入后 describe_self 已注册", { skip: skipReason }, async () => {
  assert.ok(AVAIL.generated, "缺 src/self-card.generated.ts（SK-1 生成器产物）");
  assert.ok(AVAIL.runtime, "缺 src/self-card.ts（SK-2 运行时）");
  assert.ok(AVAIL.toolFile, "缺 src/tools/describe-self.ts（SK-2 工具）");
  assert.ok(AVAIL.registered, "describe_self 没有注册进 src/tools/index.ts 的 EXTRA_TOOLS");
});

test("A2 ≥18 条真实问法在真实卡上逐条核对代码事实", { skip: skipReason }, async (t) => {
  const support = await import("./support.mjs");
  const api = await loadReplayApi();
  const commit = readCardCommit();
  assert.ok(commit, "生成卡里没有 commit");
  let passed = 0;
  for (const group of QUESTIONS.groups) {
    for (const question of group.questions) {
      await t.test(`${question.id} ${question.text}`, async (qt) => {
        const states = group.states?.length ? group.states : [{ id: "default", env: {} }];
        for (const state of states) {
          await qt.test(`state:${state.id}`, async () => {
            const e = await prepareEnv(support.env(), {
              settings: state.settings,
              env: state.env,
              removeEnv: state.removeEnv,
              release: commit,
            });
            const answer = await renderQuestion(api, e, question, group, state);
            assert.ok(answer.trim(), "describe_self 返回空");
            const result = evaluateAnswer(answer, group, FACTS, CHECKS, question, state);
            assert.ok(result.pass, failureText(result, answer));
            passed++;
          });
        }
      });
    }
  }
  assert.ok(passed >= 18, `只跑了 ${passed} 条`);
});

test("S7 假密钥注入后，所有输出、/health 和生成卡里都搜不到密钥值", { skip: skipReason }, async () => {
  const support = await import("./support.mjs");
  const api = await loadReplayApi();
  const fake = "sk-test-FAKE" + "A".repeat(48);
  const values = [fake, "ghp_" + "B".repeat(40), "QQ-" + "C".repeat(40)];
  const e = await prepareEnv(support.env(), {
    env: {
      OPENAI_API_KEY: values[0],
      DEEPSEEK_API_KEY: values[0],
      ADMIN_TOKEN: values[1],
      RUNNER_TOKEN: values[1],
      QQ_APP_SECRET: values[2],
      GITHUB_TOKEN: values[1],
    },
    release: readCardCommit(),
  });
  const outputs = [];
  for (const group of QUESTIONS.groups) {
    const q = group.questions[0];
    outputs.push(await renderQuestion(api, e, q, group));
  }
  outputs.push(await (await support.req(e, "/health")).text());
  const cardText = fs.readFileSync(repoPath("src/self-card.generated.ts"), "utf8");
  outputs.push(cardText);
  for (const value of values) {
    for (const [index, text] of outputs.entries())
      assert.ok(!text.includes(value), `输出 #${index} 泄漏了注入的密钥值`);
  }
  for (const [index, text] of outputs.entries())
    assert.ok(!/sk-test-FAKE|ghp_B{20,}/.test(text), `输出 #${index} 出现测试密钥形状`);
});

test("S8 版本一致：卡 commit = HEAD，/health.selfCard.commit 一致，不同 release 明说不一致", { skip: skipReason }, async () => {
  const support = await import("./support.mjs");
  const api = await loadReplayApi();
  const commit = readCardCommit();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath("."), encoding: "utf8" }).trim();
  assert.equal(commit, head, "生成卡 commit 必须等于构建时 HEAD");
  const e = await prepareEnv(support.env(), { release: head });
  const health = await (await support.req(e, "/health")).json();
  assert.equal(health.selfCard?.commit, commit, "/health.selfCard.commit 与卡不一致");
  const q = QUESTIONS.groups.find((g) => g.id === "S8").questions[0];
  const text = await renderQuestion(api, e, q, { topic: "overview", query: "跑在哪里" });
  assert.ok(text.includes(commit.slice(0, 7)), "回答版本头没有卡 commit 的前 7 位");
  const mismatch = await prepareEnv(support.env(), { release: "deadbee" });
  const mismatchText = await renderQuestion(api, mismatch, q, { topic: "overview", query: "跑在哪里" });
  assert.match(mismatchText, /不一致/, "RELEASE 与卡不同却没有明说不一致");
});
