import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

test("extra registry: defs resolve back to tools, unknown tool is an error", async () => {
  const k = await load();
  const defs = k.extraToolDefs();
  assert.ok(defs.length > 0);
  for (const def of defs) {
    const tool = k.findExtraTool(def.function.name);
    assert.ok(tool, "missing tool for " + def.function.name);
    assert.equal(tool.def, def);
    assert.ok(k.extraUntrustedNames().includes(def.function.name) === !!tool.untrusted);
  }
  assert.equal(k.findExtraTool("nope"), undefined);
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});
