import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load() {
  const out = await build({ entryPoints: ["src/toolkit.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

// The registry is no longer empty once F7 tools land; keep this test about the
// extension-point contract instead of assuming zero registrations.
test("registry defs resolve via findExtraTool and unknown tool is an error", async () => {
  const k = await load();
  const defs = k.extraToolDefs();
  assert.ok(Array.isArray(defs));
  for (const def of defs) assert.equal(k.findExtraTool(def.function.name)?.name, def.function.name);
  assert.deepEqual(
    k.extraUntrustedNames().sort(),
    defs.filter((d) => k.findExtraTool(d.function.name).untrusted).map((d) => d.function.name).sort(),
  );
  assert.equal(k.findExtraTool("nope"), undefined);
  assert.deepEqual(await k.runExtraTool({ DB: {} }, "nope", {}, { context: {}, messages: [], isTainted: () => false }), { error: "unknown tool" });
});

test('default async discovery preserves synchronous definitions without touching DB or network', async () => {
  const k = await load(), context = { latest: { id: 'empty', group_id: 'A' } };
  const e = { DB: { prepare() { throw Error('default discovery must not query DB'); } } };
  assert.deepEqual(await k.extraToolDefs(e, context), k.extraToolDefs());
  assert.deepEqual(k.extraUntrustedNames(context), k.extraUntrustedNames());
  assert.equal(k.findExtraTool('calc', context).untrusted, false);
});
