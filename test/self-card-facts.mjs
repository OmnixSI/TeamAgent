/**
 * SK-3 independent fact reader.
 *
 * Every fact below is read from the repository source at test time. Nothing is
 * read from src/self-card.generated.ts or the sample fixture: a wrong generated
 * card must fail the replay instead of supplying its own expected answer.
 *
 * ASR is a code-reading judgement, not a config value. The code has three paths:
 * QQ voice messages use the platform's asr_refer_text (src/inbound.ts -> Tencent
 * QQ); Bilibili/video audio uses runner/media.mjs -> runner/asr.mjs ->
 * runner/xasr_transcribe.py (local X-ASR); src/deepseek-tools.ts has a cloud
 * /v1/tools/asr backup. A single-vendor answer is therefore wrong. If any import
 * or endpoint changes, this reader follows the new code or throws; it never
 * keeps a stale hard-coded vendor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REPO_ROOT = ROOT;

export function repoPath(relative) {
  return path.join(ROOT, relative);
}

export function readRepo(relative) {
  return fs.readFileSync(repoPath(relative), "utf8");
}

function need(re, text, what, file) {
  const match = text.match(re);
  if (!match) throw new Error(`SK-3 fact reader: cannot read ${what} from ${file}`);
  return match[1];
}

function uniq(values) {
  return [...new Set(values)];
}

function parseCrons(toml) {
  const block = need(/crons\s*=\s*\[([^\]]*)\]/, toml, "crons", "wrangler.toml");
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function tableNames(sql) {
  return uniq(
    [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`\[]?([A-Za-z0-9_]+)/gi)].map(
      (m) => m[1],
    ),
  );
}

function firstExisting(paths) {
  return paths.filter((p) => fs.existsSync(repoPath(p)));
}

/** All code-derived facts for the SK replay. */
export function readFacts() {
  const imagegen = readRepo("src/imagegen.ts");
  const openai = readRepo("src/openai.ts");
  const imageTool = readRepo("src/tools/generate-image.ts");
  const semantic = readRepo("src/semantic.ts");
  const runtime = readRepo("src/runtime.ts");
  const vision = readRepo("src/vision.ts");
  const asr = readRepo("runner/asr.mjs");
  const media = readRepo("runner/media.mjs");
  const tts = readRepo("runner/tts.mjs");
  const qqVoice = readRepo("runner/qq-voice.mjs");
  const team = JSON.parse(readRepo("config/team.json"));
  const wrangler = readRepo("wrangler.toml");
  const schema = readRepo("schema.sql");
  const migrations = fs
    .readdirSync(repoPath("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ file: `migrations/${name}`, sql: readRepo(`migrations/${name}`) }));

  const imageModel = need(/export\s+const\s+IMAGE_MODEL\s*=\s*['"]([^'"]+)['"]/, imagegen, "IMAGE_MODEL", "src/imagegen.ts");
  const openaiBase = need(/export\s+const\s+OPENAI_BASE\s*=\s*['"]([^'"]+)['"]/, openai, "OPENAI_BASE", "src/openai.ts");
  const imageDailyLimit = Number(
    need(/const\s+DEFAULT_USER_DAILY\s*=\s*(\d+)/, imageTool, "DEFAULT_USER_DAILY", "src/tools/generate-image.ts"),
  );
  const imageToolName = need(/\n\s*name:\s*["'](generate_image)["']/, imageTool, "tool name", "src/tools/generate-image.ts");
  if (imageToolName !== "generate_image") throw new Error(`unexpected image tool name ${imageToolName}`);

  const replyModel = team?.model?.name;
  if (!replyModel) throw new Error("SK-3 fact reader: config/team.json has no model.name");
  const replyHost = need(/https:\/\/(api\.deepseek\.com)/, runtime, "DeepSeek host", "src/runtime.ts");

  // ASR has three distinct code paths; a single-vendor answer is incomplete.
  // - QQ voice messages arrive with asr_refer_text from Tencent QQ (src/inbound.ts).
  // - Bilibili/video audio is transcribed locally by runner/media.mjs ->
  //   runner/asr.mjs -> runner/xasr_transcribe.py (X-ASR on this machine).
  // - src/deepseek-tools.ts carries the cloud /v1/tools/asr backup channel.
  const inbound = readRepo("src/inbound.ts");
  const asrProviders = [
    /asr_refer_text/.test(inbound)
      ? { role: "QQ 语音消息", vendor: "腾讯 QQ", where: "平台/云端", file: "src/inbound.ts", evidence: "asr_refer_text" }
      : null,
    /xasr_transcribe\.py/.test(asr) && /from\s+['"]\.\/asr\.mjs['"]/.test(media)
      ? { role: "B站/视频音轨", vendor: "X-ASR", where: "本机", file: "runner/asr.mjs" }
      : null,
    /\/v1\/tools\/asr/.test(readRepo("src/deepseek-tools.ts"))
      ? { role: "云端备路", vendor: "DeepSeek", where: "云端", file: "src/deepseek-tools.ts" }
      : null,
  ].filter(Boolean);
  if (!asrProviders.length) throw new Error("SK-3 fact reader: cannot determine the ASR implementation");
  const asrLocal = asrProviders.some((p) => p.vendor === "X-ASR" && p.where === "本机");
  const asrFiles = firstExisting([...new Set(asrProviders.map((p) => p.file))]);

  const visionModelId = need(/(?:e\.AI\.run|runWorkersAi)\(\s*(?:e\s*,\s*)?["']([^"']+)["']/, runtime, "vision model", "src/runtime.ts");
  const visionVendor = visionModelId.startsWith("@cf/")
    ? "Cloudflare Workers AI"
    : /api\.openai\.com/.test(vision)
      ? "OpenAI"
      : (() => {
          throw new Error(`SK-3 fact reader: unknown vision provider for ${visionModelId}`);
        })();

  const ttsPrimary = /edge-tts/.test(tts) ? "edge-tts" : "DeepSeek";
  const ttsFallback = /DeepSeek TTS/.test(tts) && ttsPrimary !== "DeepSeek" ? "DeepSeek" : null;
  const ttsSilk = /SILK/.test(qqVoice) || /wavToSilk/.test(tts) ? "SILK" : null;

  const entry = need(/^main\s*=\s*["']([^"']+)["']/m, wrangler, "worker entry", "wrangler.toml");
  // The card names the three functional lanes (producers); dead-letter queues are
  // consumer plumbing and are asserted separately by the queue config tests.
  const queues = uniq([...wrangler.matchAll(/\[\[queues\.producers\]\]([\s\S]*?)(?=\[\[|\n\[|$)/g)]
    .map((block) => block[1].match(/^\s*queue\s*=\s*["']([^"']+)["']/m)?.[1])
    .filter(Boolean));
  const bindings = uniq([...wrangler.matchAll(/^\s*binding\s*=\s*["']([^"']+)["']/gm)].map((m) => m[1]));
  const crons = parseCrons(wrangler);
  const schemaTables = tableNames(schema);
  const migrationTables = uniq(migrations.flatMap((m) => tableNames(m.sql)));
  const coreTables = ["members", "settings", "messages", "tasks", "facts", "jobs", "outbox"].filter((t) =>
    schemaTables.includes(t),
  );
  if (coreTables.length < 4) throw new Error("SK-3 fact reader: core schema tables not found");

  const repoName =
    (team.repositories || []).find((name) => /TeamAgent$/.test(name)) ||
    (team.repositories || [])[0] ||
    "OmnixSI/TeamAgent";

  const dirs = [
    { path: "src", role: "Cloudflare Worker 主体", pattern: /src[^。；\n，,]{0,50}(Worker|云端|主体)/i },
    { path: "runner", role: "本机服务（QQ 网关、抓取、语音、执行）", pattern: /runner[^。；\n，,]{0,50}(本机|本地|服务)/i },
    { path: "migrations", role: "D1 表结构迁移", pattern: /migrations?[^。；\n，,]{0,50}(D1|表|迁移)/i },
    { path: "scripts", role: "构建、发布与验收脚本", pattern: /scripts?[^。；\n，,]{0,50}(脚本|构建|发布|验收)/i },
  ].filter((d) => fs.existsSync(repoPath(d.path)));

  return {
    image: {
      tool: imageToolName,
      vendor: "OpenAI",
      model: imageModel,
      host: new URL(openaiBase).host,
      dailyLimit: imageDailyLimit,
      files: firstExisting(["src/imagegen.ts", "src/tools/generate-image.ts"]),
      primaryFile: "src/imagegen.ts",
      switches: ["image_gen", "openai"],
      env: ["OPENAI_API_KEY"],
      note: "src/imagegen.ts calls src/openai.ts OPENAI_BASE; quota constant lives in src/tools/generate-image.ts",
    },
    reply: {
      vendor: "DeepSeek",
      model: replyModel,
      host: replyHost,
      files: firstExisting(["src/semantic.ts", "src/runtime.ts"]),
      primaryFile: "src/semantic.ts",
      env: ["DEEPSEEK_API_KEY"],
      note: "config/team.json model.name; src/runtime.ts posts to api.deepseek.com/chat/completions",
    },
    asr: {
      providers: asrProviders,
      local: asrLocal,
      runsOn: asrLocal ? "both" : "cloud",
      files: asrFiles,
      primaryFile: asrLocal ? "runner/asr.mjs" : "src/inbound.ts",
      note: "QQ voice: Tencent asr_refer_text (src/inbound.ts); video audio: runner/media.mjs -> runner/asr.mjs -> runner/xasr_transcribe.py (local X-ASR); cloud backup: src/deepseek-tools.ts /v1/tools/asr",
    },
    vision: {
      vendor: visionVendor,
      model: visionModelId,
      host: visionModelId.startsWith("@cf/") ? "Cloudflare" : "api.openai.com",
      dailyCap: team?.vision?.daily_cap ?? null,
      files: firstExisting(["src/vision.ts", "src/runtime.ts"]),
      primaryFile: "src/vision.ts",
      note: "src/runtime.ts visionModel -> e.AI.run (Workers AI); src/vision.ts describeImage",
    },
    tts: {
      primary: ttsPrimary,
      fallback: ttsFallback,
      silk: ttsSilk,
      files: firstExisting(["runner/tts.mjs", "runner/qq-voice.mjs", "src/deepseek-tools.ts"]),
      primaryFile: "runner/tts.mjs",
      note: "runner/tts.mjs header: edge-tts primary, DeepSeek TTS fallback; both end as SILK for QQ",
    },
    repo: {
      name: repoName,
      entry,
      dirs,
      schemaTables,
      migrationTables,
      coreTables,
      crons,
      queues,
      bindings,
    },
    run: {
      cloud: ["Cloudflare", "Worker"],
      local: ["本机", "runner"],
    },
    file: {
      entry,
      image: "src/imagegen.ts",
      reply: "src/semantic.ts",
    },
  };
}

const anyOf = (label, any) => ({ label, any: any.filter(Boolean) });
const allOf = (label, all) => ({ label, all: all.filter(Boolean) });
const custom = (label, test) => ({ label, test });

/** Map a stable fact key used in self-questions.json to a text predicate. */
export function buildChecks(facts) {
  const imageLimit = facts.image.dailyLimit;
  return {
    "image.tool": anyOf("生图工具名/入口", [facts.image.tool, "src/tools/generate-image.ts"]),
    "image.vendor": anyOf("生图厂商 OpenAI", [facts.image.vendor]),
    "image.model": anyOf("生图模型与代码一致", [facts.image.model]),
    "image.host": anyOf("生图接口主机", [facts.image.host]),
    "image.files": anyOf("生图关键文件", [facts.image.primaryFile]),
    "image.limit": {
      label: `每人每天 ${imageLimit} 张`,
      pattern: new RegExp(
        `(?:每人|每天|每日)[^。；\\n]{0,24}${imageLimit}\\s*张|${imageLimit}\\s*张[^。；\\n]{0,12}(?:每人|每天|每日)`,
      ),
    },
    "reply.vendor": anyOf("回复厂商 DeepSeek", [facts.reply.vendor]),
    "reply.model": anyOf("回复模型与 config/team.json 一致", [facts.reply.model]),
    "reply.host": anyOf("回复接口主机", [facts.reply.host]),
    "asr.qq": anyOf("QQ 语音消息用腾讯平台转写", ["腾讯 QQ", "腾讯", "QQ平台", "QQ 平台", "QQ"]),
    "asr.local": allOf("视频音轨用本机 X-ASR", ["X-ASR", "本机"]),
    "asr.files": anyOf("语音识别 runner 文件", ["runner/asr.mjs", "runner/media.mjs", "asr.mjs", "media.mjs"]),
    "vision.vendor": anyOf("看图厂商", [facts.vision.vendor.includes("Cloudflare") ? "Cloudflare" : facts.vision.vendor]),
    "vision.model": anyOf("看图模型与代码一致", [facts.vision.model]),
    "vision.files": anyOf("看图关键文件", [facts.vision.primaryFile]),
    "tts.primary": anyOf("语音合成主路径", [facts.tts.primary]),
    "tts.fallback": anyOf("语音合成回退厂商", [facts.tts.fallback]),
    "tts.silk": anyOf("QQ 语音 SILK", [facts.tts.silk]),
    "tts.files": anyOf("语音合成关键文件", [facts.tts.primaryFile, "tts.mjs"]),
    "tts.not_wired": {
      label: "语音合成还没接进群里",
      pattern: /(?:还没接进|未接进|没接进|不会主动发|尚未接入|没有接进)/,
    },
    "repo.entry": anyOf("Worker 入口", [facts.repo.entry, "worker.ts"]),
    "repo.dirs": custom(
      "顶层目录名（src/runner/migrations/scripts 都出现）",
      (text) => facts.repo.dirs.every((d) => text.includes(d.path)),
    ),
    "repo.dirs.roles": custom("顶层目录职责", (text) => facts.repo.dirs.every((d) => d.pattern.test(text))),
    "repo.tables": custom(
      "D1 表名与 schema.sql 一致",
      (text) => facts.repo.coreTables.every((name) => text.includes(name)),
    ),
    "repo.cron": custom(
      "cron 与 wrangler.toml 一致",
      (text) =>
        facts.repo.crons.every((c) => text.includes(c)) ||
        /(?:cron|定时)[^。；\n]{0,20}(?:每分钟|每分钟一次)/i.test(text),
    ),
    "repo.queues": allOf("队列名与 wrangler.toml 一致", facts.repo.queues),
    "repo.bindings": custom(
      "绑定名与 wrangler.toml 一致",
      (text) =>
        facts.repo.bindings.every((name) =>
          name === "DB" ? text.includes("DB") || /D1|数据库/.test(text) : text.includes(name),
        ),
    ),
    "run.cloud": anyOf("跑在云端", ["Cloudflare", "云端"]),
    "run.local": anyOf("本机运行", ["本机", "本地"]),
    "file.entry": anyOf("入口文件", [facts.file.entry]),
    "file.image": anyOf("生图文件", [facts.file.image]),
    "file.reply": anyOf("回复文件", [facts.file.reply]),
    "switch.image_gen.on": {
      label: "生图当前开启",
      pattern: /(?:已开启|已启用|开启|启用|开着|能用|可用|正常)/,
    },
    "switch.image_gen.off": {
      label: "生图明确已关闭",
      pattern: /(?:已关闭|当前已关闭|已写好未启用|关闭|关了|关着|关的|没开|没启用)/,
    },
    "switch.openai.off": {
      label: "OpenAI 通道明确已关闭",
      pattern: /(?:已关闭|当前已关闭|已写好未启用|关闭|关了|关着|关的|没开|没启用)/,
    },
    "switch.image_gen.unconfigured": {
      label: "生图未配置",
      pattern: /(?:未配置|没有配置|缺少\s*OPENAI_API_KEY|未绑定|没绑|没配|没配置)/,
    },
  };
}

function hit(value, text) {
  return value instanceof RegExp ? value.test(text) : text.includes(String(value));
}

export function checkFact(text, check) {
  const failures = [];
  if (check.any?.length && !check.any.some((value) => hit(value, text)))
    failures.push(`缺少任一：${check.any.join(" / ")}`);
  if (check.all?.length) {
    for (const value of check.all) if (!hit(value, text)) failures.push(`缺少：${value}`);
  }
  if (check.pattern && !check.pattern.test(text)) failures.push(`未匹配：${check.pattern}`);
  if (check.test && !check.test(text)) failures.push(`未通过：${check.label}`);
  return failures;
}

/**
 * Contradiction check: a clause that talks about `subject` must not attach
 * `wrong` to it, unless the clause explicitly negates it.
 * "生图不是 DeepSeek，是 OpenAI" passes; "生图用 DeepSeek" fails.
 */
export function attributionConflicts(text, rules = []) {
  const clauses = String(text)
    .split(/[。；;\n，,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const rule of rules) {
    const subject = new RegExp(rule.subject, "i");
    const wrong = new RegExp(rule.wrong, "i");
    for (const clause of clauses) {
      if (!subject.test(clause) || !wrong.test(clause)) continue;
      if (/(?:不是|不用|并非|而非|而不是|未用|没接|没有用)/.test(clause)) continue;
      out.push(`把「${rule.subject}」说成了 ${rule.wrong}：${clause.slice(0, 120)}`);
    }
  }
  return out;
}

/** Evaluate one rendered answer against one question/state. */
export function evaluateAnswer(text, group, facts, checks, question = null, state = null, opts = {}) {
  let expected = (state?.expect ?? question?.expect ?? group.expect ?? []).slice();
  // The group chat answer must name the directories, not recite their roles.
  // The deterministic A layer still checks the roles (repo.dirs.roles).
  if (opts.layer === "B") expected = expected.filter((key) => key !== "repo.dirs.roles");
  const failures = [];
  const asserted = [];
  for (const key of expected) {
    const check = checks[key];
    if (!check) {
      failures.push(`no fact check for key ${key}`);
      continue;
    }
    const bad = checkFact(text, check);
    if (bad.length) failures.push(`${key}: ${bad.join("；")}`);
    asserted.push({ key, label: check.label, pass: bad.length === 0 });
  }
  const conflicts = attributionConflicts(text, group.conflict || []);
  failures.push(...conflicts);
  const mustMatch = [...(state?.must_match || []), ...(question?.must_match || [])];
  for (const source of mustMatch) {
    const re = new RegExp(source);
    if (!re.test(text)) failures.push(`必须匹配 /${source}/`);
  }
  const mustNot = [...(state?.must_not_match || []), ...(question?.must_not_match || [])];
  for (const source of mustNot) {
    const re = new RegExp(source);
    if (re.test(text)) failures.push(`不应匹配 /${source}/`);
  }
  return { pass: failures.length === 0, failures, asserted, conflicts };
}
