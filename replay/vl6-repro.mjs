// Minimal repro for the VL-6 P1: promiseGuard treats a question about the
// daily 08:00 push as a promise and replaces the sentence.  No network.
import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const out = `.wrangler/vl6-repro-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export * from "./src/reply-finalize";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "esm", platform: "browser", outfile: out, logLevel: "silent",
});
const api = await import(new URL("../" + out, import.meta.url).href + `?${Date.now()}`);
const cao = JSON.parse(readFileSync(new URL("./fixtures/outbox-cao-18.json", import.meta.url), "utf8"));

let failed = 0;
for (const rid of [245, 254]) {
  const row = cao.rows.find((r) => r.rid === rid);
  const before = row.body;
  const after = JSON.parse(await api.finalizeSpoken(JSON.stringify({ mode: "work", text: before }), { avoid: ["草"] })).text;
  if (after === before) {
    console.log(`PASS rid=${rid}: protected reply unchanged`);
    continue;
  }
  failed++;
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  console.log(`FAIL rid=${rid} byte ${i}`);
  console.log("  before:", JSON.stringify(before.slice(Math.max(0, i - 20), i + 70)));
  console.log("  after: ", JSON.stringify(after.slice(Math.max(0, i - 20), i + 70)));
}
rmSync(out, { force: true });
process.exitCode = failed ? 1 : 0;
