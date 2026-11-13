import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

// F7 tools register through EXTRA_TOOLS, so this checks dispatch shape, not an empty registry.
test("registry dispatch: defs are well formed and an unknown tool is an error", async () => {
  const k = await load();
  const defs = k.extraToolDefs();
  assert.ok(Array.isArray(defs));
  for (const def of defs) {
    assert.equal(def.type, "function");
    assert.equal(typeof def.function?.name, "string");
    assert.equal(k.findExtraTool(def.function.name)?.name, def.function.name);
  }
  assert.equal(k.findExtraTool("nope"), undefined);
  assert.ok(!k.extraUntrustedNames().includes("nope"));
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});
