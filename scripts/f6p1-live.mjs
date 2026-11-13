// F6P-1 live evidence: run the real vision chain (auto → DeepSeek first) on real group images.
// Read-only: images come from the local QQ cache / an evidence manifest; nothing is written to
// production D1 and nothing is sent to any group. The key is read from DEEPSEEK_API_KEY only.
//
// Usage:
//   DEEPSEEK_API_KEY=... node scripts/f6p1-live.mjs --manifest <json> --out <json>
//
// Manifest: {"cases":[{"msg":305,"imageFile":"/abs/path.jpg","mime":"image/jpeg","note":"..."}]}
// Prices default to the off-peak deepseek-flash token rates checked 2026-11-14
// ($0.15/M input, $0.60/M output). Pass --price-in/--price-out to override.
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf("--" + name);
  return at >= 0 ? args[at + 1] : fallback;
};
const manifestPath = arg("manifest");
const outPath = arg("out");
const priceIn = Number(arg("price-in", "0.15"));
const priceOut = Number(arg("price-out", "0.6"));
if (!manifestPath) throw Error("--manifest is required");
if (!process.env.DEEPSEEK_API_KEY)
  throw Error("DEEPSEEK_API_KEY is missing from the process environment (never pass it on the command line).");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const cases = manifest.cases || [];
if (cases.length < 3) throw Error("need at least 3 real image cases, got " + cases.length);

const bundle = ".wrangler/f6p1-live-vision.mjs";
await build({
  entryPoints: ["src/vision.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: bundle,
});
const v = await import("../" + bundle);

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const started = Date.now();
  const response = await realFetch(url, init);
  const captured = { url: String(url), status: response.status, ms: Date.now() - started, usage: null, content: null };
  calls.push(captured);
  try {
    const data = await response.clone().json();
    captured.usage = data.usage || null;
    captured.content = data.choices?.[0]?.message?.content ?? null;
  } catch {}
  return response;
};

const provider = v.visionProvider({
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  // No DB in this process: the switch snapshot is what the turn normally supplies.
  switches: { "vision:provider": "auto" },
});
if (!provider) throw Error("vision is disabled");

const started = Date.now();
const results = [];
for (const item of cases) {
  const bytes = new Uint8Array(readFileSync(item.imageFile));
  const sha = await v.sha256(bytes);
  const before = calls.length;
  const began = Date.now();
  let note = null;
  let error = null;
  try {
    note = await provider.describe(bytes, item.mime, item.note || "", AbortSignal.timeout(30000));
  } catch (failure) {
    error = {
      error_kind: v.visionErrorFailure(failure).error_kind,
      detail: v.visionErrorFailure(failure).detail,
    };
  }
  const ms = Date.now() - began;
  const modelCalls = calls.slice(before);
  const usage = modelCalls.find((c) => c.usage)?.usage || { prompt_tokens: 0, completion_tokens: 0 };
  const costUsd =
    (Number(usage.prompt_tokens || 0) * priceIn + Number(usage.completion_tokens || 0) * priceOut) / 1_000_000;
  results.push({
    msg: item.msg,
    source: item.source || item.imageFile,
    bytes: bytes.byteLength,
    sha256: sha,
    ms,
    modelCalls: modelCalls.map((c) => ({
      host: new URL(c.url).host,
      status: c.status,
      ms: c.ms,
      usage: c.usage,
    })),
    usage,
    costUsd: Number(costUsd.toFixed(6)),
    ok: !!note,
    note,
    ...(error ? { error } : {}),
  });
  console.log(
    `msg#${item.msg} ${note ? "OK" : "FAIL"} ${ms}ms ` +
      `tokens=${usage.prompt_tokens || 0}/${usage.completion_tokens || 0} $${costUsd.toFixed(6)} ` +
      (note ? JSON.stringify(note) : JSON.stringify(error)),
  );
}

const evidence = {
  package: "F6P-1",
  checkedAt: new Date().toISOString(),
  chain: "vision:provider=auto → deepseek → workers-ai",
  model: "deepseek-flash",
  pricePerMillionTokens: { input: priceIn, output: priceOut, note: "off-peak deepseek-flash, checked 2026-11-14" },
  totalMs: Date.now() - started,
  totalCostUsd: Number(results.reduce((n, r) => n + r.costUsd, 0).toFixed(6)),
  passed: results.every((r) => r.ok),
  results,
};
const text = JSON.stringify(evidence, null, 2);
if (outPath) writeFileSync(outPath, text + "\n");
console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} images described, ` +
    `total ${evidence.totalMs}ms, $${evidence.totalCostUsd}`,
);
globalThis.fetch = realFetch;
if (!evidence.passed) process.exitCode = 1;
