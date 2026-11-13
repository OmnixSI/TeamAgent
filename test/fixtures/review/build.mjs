import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let cached;
// The review modules use extensionless TS imports, so node:test gets an esbuild bundle.
export async function review() {
  if (cached) return cached;
  const out = fileURLToPath(new URL(`../../../.wrangler/review-test-${process.pid}.mjs`, import.meta.url));
  await build({
    entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  cached = await import(new URL(`../../../.wrangler/review-test-${process.pid}.mjs`, import.meta.url).href + `?${Date.now()}`);
  await rm(out, { force: true });
  return cached;
}
