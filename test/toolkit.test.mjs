import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

test("registry is well-formed and unknown tools are an error", async () => {
  const k = await load();
  const names = k.extraToolDefs().map((d) => d.function.name);
  assert.equal(new Set(names).size, names.length, "tool names are unique");
  for (const def of k.extraToolDefs()) {
    const tool = k.findExtraTool(def.function.name);
    assert.ok(tool, def.function.name + " has a runnable entry");
    assert.equal(tool.def, def);
    assert.equal(typeof tool.run, "function");
  }
  assert.deepEqual(
    k.extraUntrustedNames().sort(),
    k.extraToolDefs()
      .map((d) => d.function.name)
      .filter((name) => k.findExtraTool(name).untrusted)
      .sort(),
  );
  assert.equal(k.findExtraTool("nope"), undefined);
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});
