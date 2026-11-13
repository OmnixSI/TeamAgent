import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

// F7 packages add their tools to src/tools/index.ts over time, so this checks the
// registry contract instead of the original "no tools yet" placeholder state.
test("registry defs stay consistent and unknown tools are an error", async () => {
  const k = await load();
  const defs = k.extraToolDefs();
  assert.ok(defs.length > 0);
  const names = defs.map((d) => d.function.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  for (const name of names) {
    const t = k.findExtraTool(name);
    assert.ok(t);
    assert.equal(t.def.function.name, t.name);
    assert.equal(t.untrusted, k.extraUntrustedNames().includes(name));
  }
  assert.equal(k.findExtraTool("nope"), undefined);
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});

test("an admin switch disables a registered tool", async () => {
  const k = await load();
  const name = k.extraToolDefs()[0].function.name;
  const db = { prepare: () => ({ bind: () => ({ first: async () => ({ value: "1" }) }) }) };
  const result = await k.runExtraTool({ DB: db }, name, {}, { context: {}, messages: [], isTainted: () => false });
  assert.equal(result.unavailable, true);
  assert.equal(result.error_kind, "denied");
});
