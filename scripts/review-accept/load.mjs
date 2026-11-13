// One esbuild bundle per process. The review modules use extensionless TS
// imports, so plain node cannot import them directly.
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let cached = null;

export async function loadReview() {
  if (cached) return cached;
  const out = join(".wrangler", `review-accept-${process.pid}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: out,
    logLevel: "silent",
  });
  cached = await import(`${process.cwd()}/${out}?v=${Date.now()}`);
  if (!process.env.REVIEW_ACCEPT_KEEP) await rm(out, { force: true });
  return cached;
}
