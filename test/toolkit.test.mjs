import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// The real registry gains one entry per F7 package; this test keeps checking the extension point
// itself by stubbing src/tools/index.ts with an empty registry.
const emptyRegistry = {
  name: "empty-tool-registry",
  setup(builder) {
    builder.onResolve({ filter: /^\.\/tools\/index$/ }, () => ({ path: "empty-registry", namespace: "empty" }));
    builder.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export const EXTRA_TOOLS = [];", loader: "js" }));
  },
};
async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false, plugins: [emptyRegistry] });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

test("empty registry: no extra defs, unknown tool is an error", async () => {
  const k = await load();
  assert.deepEqual(k.extraToolDefs(), []);
  assert.equal(k.findExtraTool("nope"), undefined);
  assert.deepEqual(k.extraUntrustedNames(), []);
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});
