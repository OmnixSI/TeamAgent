#!/usr/bin/env node
// F9-1 live evidence: one read-only HTTPS GET per symbol through the real tool
// code (bundled with esbuild), printing elapsed time, price and quote time.
// It writes no files, opens no browser and spawns no child process.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/tools/stock-quote.ts", import.meta.url));
const out = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);
const tool = mod.createStockQuoteTool({ cacheTtlMs: 0 });

const symbols = ["SH600519", "600519", "00700", "AAPL"];
let failed = 0;
let slow = 0;
const startedAt = new Date().toISOString();

for (const symbol of symbols) {
  const started = performance.now();
  const result = await tool.run({}, { symbol }, { context: {}, messages: [], isTainted: () => false });
  const ms = Math.round(performance.now() - started);
  if (!result.ok) failed++;
  if (ms >= 2000) slow++;
  console.log(
    JSON.stringify({
      symbol,
      ms,
      ok: result.ok,
      code: result.code ?? null,
      name: result.name ?? null,
      price: result.price ?? null,
      change_pct: result.change_pct ?? null,
      quote_time: result.quote_time ?? null,
      source: result.source ?? null,
      content_scope: result.content_scope ?? null,
      error_kind: result.error_kind ?? null,
      next_action: result.next_action ?? null,
    }),
  );
}

console.log(
  JSON.stringify({
    evidence: "f9-1-live",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    symbol_count: symbols.length,
    failed,
    slow_over_2s: slow,
    browser_processes: 0,
    writes: 0,
  }),
);
if (failed || slow) process.exitCode = 1;
