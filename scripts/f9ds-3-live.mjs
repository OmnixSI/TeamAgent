#!/usr/bin/env node
// F9DS DS-3 live evidence: real DeepSeek OCR on three locally rendered images plus
// the two real group images named in the probe report (#222 news screenshot,
// #183 portrait). Exercises the production read-image-text pipeline
// (extractImageText: guard -> OCR -> loop guard -> vision fallback).
//
// Real inputs only; no group message, no D1 write. Key comes from
// DEEPSEEK_API_KEY_FILE and is never printed or copied into the repository.
//
//   DEEPSEEK_API_KEY_FILE=/private/tmp/f9ds-3-key node scripts/f9ds-3-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "teamagent-test-f9ds-3-live-"));
const EVIDENCE = path.join(ROOT, ".agent", "releases", "F9DS", "notes", "DS-3-live.json");
const OCR_PAGE_MICRO_USD = 225; // $0.225 / 1,000 pages
const CHAT_IN_MICRO_USD_PER_TOKEN = 0.15; // $0.15 / M input tokens
const CHAT_OUT_MICRO_USD_PER_TOKEN = 0.6; // $0.60 / M output tokens
const COST_CAP_MICRO_USD = 30_000;
const MAX_NOTE = 300;

const QQ = path.join(
  os.homedir(),
  "Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/nt_qq_74d065b03c1e15a61800b47344426bfc/nt_data",
);
const REAL_222 = path.join(QQ, "Pic/2026-11/Thumb/512db61278de27dfbca51da495fbce37_720.jpg");
const REAL_183 = path.join(QQ, "Emoji/personal_emoji/Ori/D2CA5B4308698710F717D194B869CE94.jpg");

const IMAGE_PY = String.raw`
import sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
font = ImageFont.truetype("/System/Library/Fonts/STHeiti Light.ttc", 30)
small = ImageFont.truetype("/System/Library/Fonts/STHeiti Light.ttc", 22)

a = Image.new("RGB", (900, 620), "white")
d = ImageDraw.Draw(a)
lines = [
  "采购合同 HT-2026-1114",
  "甲方：星海科技有限公司",
  "乙方：远山供应链有限公司",
  "合同金额：人民币 128,500.00 元",
  "Delivery: 2026-12-31",
  "付款方式：验收后 30 日内",
]
for i, line in enumerate(lines):
    d.text((50, 60 + i * 78), line, fill="black", font=font)
a.save(out + "/A-doc.png")

b = Image.new("RGB", (600, 600), "white")
d = ImageDraw.Draw(b)
d.ellipse((70, 80, 290, 300), fill="#e5484d")
d.rectangle((320, 90, 540, 280), fill="#2f6fed")
d.polygon([(120, 520), (300, 340), (480, 520)], fill="#30a46c")
d.line((60, 560, 540, 560), fill="#111", width=8)
b.save(out + "/B-pattern.png")

c = Image.new("RGB", (800, 400), "white")
d = ImageDraw.Draw(c)
d.text((40, 90), "竖排小字测试 2026-11-14", fill="black", font=small)
d.text((40, 150), "第三行：ABCD 1234", fill="black", font=small)
d.text((40, 210), "合计 9,876.50 元", fill="black", font=small)
c.rotate(90, expand=True).save(out + "/C-vertical.png")
`;

function sha16(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

function mimeOf(file) {
  return file.endsWith(".png") ? "image/png" : "image/jpeg";
}

function keyFromEnv() {
  const file = process.env.DEEPSEEK_API_KEY_FILE;
  if (!file) {
    console.error("DEEPSEEK_API_KEY_FILE is required (private file, never printed)");
    process.exit(2);
  }
  const key = fs.readFileSync(file, "utf8").trim();
  if (!key) {
    console.error("DEEPSEEK_API_KEY_FILE is empty");
    process.exit(2);
  }
  return key;
}

const ocrCalls = [];

function mapStatus(status, data) {
  const message = String(data?.error?.message || data?.error || "");
  if (status === 401) return { error_kind: "auth", reason_text: "DeepSeek 鉴权失败", next_action: "检查 key" };
  if (status === 413) return { error_kind: "too_large", reason_text: "图片太大", next_action: "压缩后再试" };
  if (status === 429) return { error_kind: "quota", reason_text: "DeepSeek 额度或频率限制", next_action: "稍后重试" };
  if (status === 403) return { error_kind: "denied", reason_text: "DeepSeek 拒绝访问", next_action: "不要重试同一请求" };
  if (status >= 500) return { error_kind: "upstream", reason_text: "DeepSeek 服务暂时不可用", next_action: "稍后重试" };
  if (/format|supported|unsupported/i.test(message))
    return { error_kind: "unsupported", reason_text: "识别服务不支持这种文件格式", next_action: "换格式" };
  return { error_kind: "upstream", reason_text: "识别服务返回 " + status, next_action: "稍后重试" };
}

async function callOcr(key, bytes, mime, id = "live") {
  const started = Date.now();
  const form = new FormData();
  form.append("purpose", "text_recognition");
  form.append("file", new Blob([bytes], { type: mime }), "image" + (mime === "image/png" ? ".png" : ".jpg"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65_000);
  try {
    const res = await fetch("https://api.deepseek.com/v1/tools/ocr", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: form,
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const pages = Array.isArray(data?.pages) ? data.pages : [];
    const chars = pages.reduce((sum, p) => sum + String(p?.text || "").length, 0);
    const finish = pages.map((p) => String(p?.finish_reason || "")).filter(Boolean);
    if (res.ok) {
      ocrCalls.push({ id, http: res.status, page_count: data?.page_count || pages.length, chars, finish, ms: Date.now() - started });
      return { ok: true, status: res.status, data, latency_ms: Date.now() - started };
    }
    const mapped = mapStatus(res.status, data);
    ocrCalls.push({ id, http: res.status, chars, finish, ms: Date.now() - started, error: mapped.error_kind });
    return { ok: false, status: res.status, retryable: ["quota", "timeout", "upstream"].includes(mapped.error_kind), ...mapped };
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "AbortError";
    ocrCalls.push({ id, http: 0, chars: 0, finish: [], ms: Date.now() - started, error: timedOut ? "timeout" : "upstream" });
    return {
      ok: false,
      error_kind: timedOut ? "timeout" : "upstream",
      retryable: true,
      reason_text: timedOut ? "识别超时" : "识别请求失败",
      next_action: "稍后重试，或让成员重发更清晰的特写。",
    };
  } finally {
    clearTimeout(timer);
  }
}

const chatUsage = [];

async function visionFallback(key, bytes, mime, hint) {
  const dataUrl = "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64");
  const prompt =
    hint +
    "\n只输出 JSON：{\"text\":\"图中可见文字，原样\"}；没有文字就输出 {\"text\":\"\"}。不要描述人物。";
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "deepseek-flash",
        max_tokens: 400,
        reasoning_effort: "none",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    const body = await res.json().catch(() => null);
    const usage = body?.usage || {};
    chatUsage.push({
      http: res.status,
      prompt_tokens: Number(usage.prompt_tokens || 0),
      completion_tokens: Number(usage.completion_tokens || 0),
      ms: Date.now() - started,
    });
    if (!res.ok) return null;
    const content = String(body?.choices?.[0]?.message?.content || "");
    let text = "";
    try {
      const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      text = String(parsed?.text || "");
    } catch {
      const match = content.match(/"text"\s*:\s*"([\s\S]*)$/);
      text = match ? match[1].replace(/"\}?\s*$/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"') : content;
    }
    text = text.trim().slice(0, MAX_NOTE);
    return { sha: "live", desc: "", text, tags: [], meme: false };
  } catch {
    chatUsage.push({ http: 0, prompt_tokens: 0, completion_tokens: 0, ms: Date.now() - started });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadTool() {
  const out = await build({
    entryPoints: [path.join(ROOT, "src/tools/read-image-text.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

function line(result, ms) {
  const head = String(result.text || "").replace(/\s+/g, " ").slice(0, 80);
  return {
    ok: result.ok,
    via: result.via || null,
    ms,
    chars: result.ok ? result.text.length : 0,
    pages: result.pages ?? null,
    truncated: !!result.truncated,
    head,
    ...(result.ok
      ? {}
      : {
          error_kind: result.error_kind,
          retryable: result.retryable,
          reason_text: result.reason_text,
          next_action: result.next_action,
        }),
  };
}

async function main() {
  const key = keyFromEnv();
  execFileSync("python3", ["-c", IMAGE_PY, OUT], { stdio: "inherit" });
  const api = await loadTool();
  const guard = async () => ({ ok: true, release: async () => {} });

  const cases = [
    { id: "A-doc", file: path.join(OUT, "A-doc.png"), expect: "ocr:128,500" },
    { id: "B-pattern", file: path.join(OUT, "B-pattern.png"), expect: "empty" },
    { id: "C-vertical", file: path.join(OUT, "C-vertical.png"), expect: "text" },
    { id: "qq-222", file: REAL_222, expect: "ocr:黄仁勋" },
    { id: "qq-183", file: REAL_183, expect: "fallback" },
  ];

  const results = {};
  const fullText = {};
  for (const item of cases) {
    if (!fs.existsSync(item.file)) throw new Error("missing input: " + item.file);
    const bytes = new Uint8Array(fs.readFileSync(item.file));
    const mime = mimeOf(item.file);
    const started = Date.now();
    const result = await api.extractImageText(
      {},
      bytes,
      mime,
      {
        group: "live",
        sender: "live",
        deps: {
          guard,
          callDs: (_e, o) => callOcr(key, bytes, mime, item.id),
          describeBytes: (_e, _bytes, _mime, hint) => visionFallback(key, bytes, mime, hint),
        },
      },
    );
    const ms = Date.now() - started;
    fullText[item.id] = result.ok ? result.text : "";
    results[item.id] = { ...line(result, ms), sha256_16: sha16(item.file), bytes: bytes.byteLength, expect: item.expect };
    console.log(
      `${item.id} | ok=${result.ok} via=${result.via || "-"} ${ms}ms chars=${result.ok ? result.text.length : 0} head=${JSON.stringify(String(result.text || "").replace(/\s+/g, " ").slice(0, 80))}`,
    );
  }

  const ocrPages = ocrCalls.reduce((sum, call) => sum + Number(call.page_count || 1), 0);
  const ocrCost = ocrPages * OCR_PAGE_MICRO_USD;
  const chatCost = chatUsage.reduce(
    (sum, call) =>
      sum + call.prompt_tokens * CHAT_IN_MICRO_USD_PER_TOKEN + call.completion_tokens * CHAT_OUT_MICRO_USD_PER_TOKEN,
    0,
  );
  const costMicroUsd = Math.round(ocrCost + chatCost);
  const failures = [];
  const A = results["A-doc"], B = results["B-pattern"], C = results["C-vertical"], Q222 = results["qq-222"], Q183 = results["qq-183"];
  if (!(A.ok && /128,500/.test(fullText["A-doc"]))) failures.push("A did not read the contract amount");
  if (!(C.ok && C.chars > 0)) failures.push("C vertical text returned no text");
  if (!(Q222.ok && Q222.via === "ocr" && /黄仁勋/.test(fullText["qq-222"]))) failures.push("#222 was not recognised via OCR");
  if (!(Q183.ok && Q183.via === "vision_fallback")) failures.push("#183 did not fall back to vision");
  if (!(Q183.ok && /可能有误/.test(fullText["qq-183"]))) failures.push("#183 fallback is missing the 可能有误 marker");
  if (!(B.ok === false || (B.via === "vision_fallback" && B.chars < 500))) failures.push("B returned a long made-up text");
  if (costMicroUsd > COST_CAP_MICRO_USD) failures.push("cost over cap: " + costMicroUsd);

  const q183Raw = ocrCalls.find((call) => call.id === "qq-183") || null;
  const q183Loop = !!(q183Raw && (q183Raw.finish.includes("length") || q183Raw.chars > 8000));
  if (!q183Loop && !(Q183.ok && Q183.via === "vision_fallback"))
    failures.push("#183 neither showed the loop signature nor fell back to vision");
  if (!(Q183.ok && Q183.chars < 1000)) failures.push("#183 fallback text is too long or missing");

  const evidence = {
    run: "F9DS DS-3 read_image_text live",
    at: new Date().toISOString(),
    cost_micro_usd: costMicroUsd,
    cost_cap_micro_usd: COST_CAP_MICRO_USD,
    ocr_calls: ocrCalls,
    q183_loop_signature: q183Loop,
    chat_usage: chatUsage,
    results,
    assertions: failures,
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  console.log("cost_micro_usd=" + costMicroUsd + " cap=" + COST_CAP_MICRO_USD);
  console.log("evidence=" + EVIDENCE);
  if (failures.length) {
    console.error("FAIL\n- " + failures.join("\n- "));
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
  fs.rmSync(OUT, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
