import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

test("extra tool registry is consistent and unknown tools are an error", async () => {
  const k = await load();
  const defs = k.extraToolDefs();
  assert.ok(Array.isArray(defs));
  for (const def of defs) {
    assert.equal(def.type, "function");
    assert.equal(typeof def.function?.name, "string");
    assert.ok(def.function.name.length > 0);
    assert.ok(k.findExtraTool(def.function.name), def.function.name + " must resolve back to a tool");
  }
  assert.equal(k.findExtraTool("nope"), undefined);
  const untrusted = k.extraUntrustedNames();
  assert.ok(Array.isArray(untrusted));
  for (const name of untrusted) assert.ok(k.findExtraTool(name)?.untrusted === true, name);
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});
