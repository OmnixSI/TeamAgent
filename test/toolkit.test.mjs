import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

test("registry: every extra def resolves to its tool, unknown tool is an error", async () => {
  const k = await load();
  for (const def of k.extraToolDefs()) {
    const tool = k.findExtraTool(def.function.name);
    assert.ok(tool, "extra def without tool: " + def.function.name);
    assert.equal(tool.def.function.name, tool.name);
    assert.equal(typeof tool.untrusted, "boolean");
  }
  assert.equal(k.findExtraTool("nope"), undefined);
  assert.equal(k.extraUntrustedNames().length, k.extraToolDefs().filter((def) => k.findExtraTool(def.function.name).untrusted).length);
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});
