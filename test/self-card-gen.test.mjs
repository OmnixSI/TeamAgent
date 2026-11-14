// SK-1: the self-knowledge card is generated from code, never hand-written.
// The card must name the real provider/model/limit of each capability, cover every
// registered tool, fail the build when the manifest is stale, and never carry a key value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestFile = join(root, "config/self-manifest.json");
const generatedFile = join(root, "src/self-card.generated.ts");
const read = (name) => readFileSync(join(root, name), "utf8");

/** Run the generator as a build would; extra args/env let negative cases use temp copies. */
function generate(args = [], env = {}) {
  return spawnSync(process.execPath, ["scripts/gen-self-card.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const first = generate();
assert.equal(first.status, 0, first.stderr || first.stdout);
const { SELF_CARD: card } = await import(pathToFileURL(generatedFile).href + "?v=" + Date.now());

const capability = (id) => {
  const found = card.capabilities.find((c) => c.id === id);
  assert.ok(found, `capability ${id} missing; have ${card.capabilities.map((c) => c.id).join(",")}`);
  return found;
};

/** Every statically registered tool, read independently from the registries. */
async function registeredTools() {
  const dir = mkdtempSync(join(tmpdir(), "selfcard-tools-"));
  const outfile = join(dir, "tools.mjs");
  await build({
    stdin: {
      contents:
        'export {EXTRA_TOOLS} from "./src/tools/index"; export {repoTools} from "./src/repo";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
  });
  try {
    const api = await import(pathToFileURL(outfile).href);
    const base = read("src/semantic.ts");
    const start = base.indexOf("const baseTools = [");
    const end = base.indexOf("const allTools = [");
    assert.ok(start > 0 && end > start, "semantic.ts baseTools block not found");
    const baseNames = [...base.slice(start, end).matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(baseNames.length >= 10, `only ${baseNames.length} base tool names`);
    return [
      ...baseNames,
      ...api.repoTools.map((t) => (t.def || t).function.name),
      ...api.EXTRA_TOOLS.map((t) => t.name),
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("S1 card commit is the built commit and every capability id is unique", async () => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.match(card.commit, /^[0-9a-f]{40}$/);
  assert.equal(card.commit, head);
  assert.equal(card.schema, 1);
  assert.ok(!Number.isNaN(Date.parse(card.built_at)), card.built_at);
  const ids = card.capabilities.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "capability ids must be unique");
  for (const id of ["image_generation", "reply_model", "voice_asr", "repo_read"]) capability(id);
});

test("S2 image generation names OpenAI, the code's model and the code's daily limit", () => {
  const image = capability("image_generation");
  const provider = image.providers.find((p) => p.vendor === "OpenAI");
  assert.ok(provider, "image_generation must name OpenAI");
  assert.equal(provider.host, "api.openai.com");
  const code = read("src/imagegen.ts");
  const model = code.match(/export const IMAGE_MODEL = '([^']+)'/);
  assert.ok(model, "IMAGE_MODEL not found in src/imagegen.ts");
  assert.equal(provider.model, model[1], "card model must equal the constant in src/imagegen.ts");
  const limit = read("src/tools/generate-image.ts").match(/DEFAULT_USER_DAILY = (\d+)/);
  assert.ok(limit, "DEFAULT_USER_DAILY not found in src/tools/generate-image.ts");
  assert.match(image.limit, new RegExp(`\\b${limit[1]}\\b`), `limit ${image.limit}`);
  assert.ok(image.tools.includes("generate_image"));
});

test("S3 the card covers every registered tool, and invents none", async () => {
  const registered = await registeredTools();
  const carded = card.tools.map((t) => t.name);
  assert.equal(new Set(carded).size, carded.length, "duplicate tool rows");
  for (const name of registered) assert.ok(carded.includes(name), `registered tool ${name} missing from the card`);
  for (const name of carded) assert.ok(registered.includes(name), `card tool ${name} is not registered`);
  for (const row of card.tools) {
    assert.ok(!row.desc.includes("。第二句"), `tool ${row.name} description must be the first sentence only`);
    assert.ok(row.desc.length > 0 && row.desc.length <= 120, `${row.name}: ${row.desc}`);
  }
});

test("S4 capability files are real, anchored, and give a line number", () => {
  for (const cap of card.capabilities) {
    assert.ok(cap.files.length > 0, `${cap.id} has no files`);
    assert.ok(["cloud", "local", "both"].includes(cap.runs_on), `${cap.id} runs_on=${cap.runs_on}`);
    assert.ok(["on", "off_by_default"].includes(cap.default_state), `${cap.id} default_state=${cap.default_state}`);
    for (const file of cap.files) {
      assert.ok(Number.isInteger(file.line) && file.line > 0, `${cap.id} ${file.path} line=${file.line}`);
      const text = read(file.path);
      assert.equal(text.split("\n").length >= file.line, true, `${cap.id} ${file.path}:${file.line} outside file`);
    }
  }
  for (const provider of card.capabilities.flatMap((c) => c.providers)) {
    assert.ok(provider.evidence.length > 0, `${provider.vendor} provider has no evidence`);
    for (const evidence of provider.evidence)
      assert.ok(evidence.line > 0 && read(evidence.path).split("\n").length >= evidence.line, `${provider.vendor} evidence`);
  }
});

test("S5 the generated card carries no key value, only names", () => {
  const fakeOpenAi = "sk-test-FAKE0123456789012345678901234567890";
  const fakeDeepSeek = "sk-test-FAKEdeepseek012345678901234567890";
  const dir = mkdtempSync(join(tmpdir(), "selfcard-secret-"));
  try {
    const out = join(dir, "card.ts");
    const run = generate(["--out", out], { OPENAI_API_KEY: fakeOpenAi, DEEPSEEK_API_KEY: fakeDeepSeek });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const text = readFileSync(out, "utf8");
    for (const secret of [fakeOpenAi, fakeDeepSeek]) {
      assert.ok(!text.includes(secret), "generated card leaked a key value");
      assert.ok(!text.includes(secret.slice(-20)), "generated card leaked part of a key value");
    }
    assert.ok(text.includes("OPENAI_API_KEY"), "environment variable NAME must be present");
    assert.ok(text.includes("DEEPSEEK_API_KEY"), "environment variable NAME must be present");
    assert.ok(!/sk-[A-Za-z0-9_-]{20,}/.test(text), "a token-shaped value reached the card");
    assert.ok(!text.includes("/Users/"), "local absolute path reached the card");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6 repo_map matches schema.sql, migrations and wrangler.toml independently", () => {
  const map = card.repo_map;
  assert.equal(map.repo, "OmnixSI/TeamAgent");
  const schema = read("schema.sql");
  const messages = schema.match(/CREATE TABLE IF NOT EXISTS (messages)\b/);
  assert.ok(messages, "schema.sql must still create messages");
  const tableNames = map.tables.map((t) => t.name);
  assert.ok(tableNames.includes("messages"), "repo_map.tables must contain messages");
  assert.ok(tableNames.includes("outbox"));
  const migrations = readFileSync(join(root, "migrations/0023_episodes.sql"), "utf8");
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS episodes/);
  assert.ok(tableNames.includes("episodes"));
  assert.equal(map.tables.find((t) => t.name === "episodes").migration, "migrations/0023_episodes.sql");

  const wrangler = read("wrangler.toml");
  const producers = [...wrangler.matchAll(/\[\[queues\.producers\]\]([\s\S]*?)(?=\[\[|\n\[|$)/g)]
    .map((block) => block[1].match(/queue = "([^"]+)"/)?.[1])
    .filter(Boolean);
  assert.deepEqual(map.queues, [...new Set(producers)]);
  const bindings = [...wrangler.matchAll(/binding = "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(map.bindings, bindings);
  assert.ok(map.bindings.includes("DB"));
  assert.deepEqual(map.crons, ["* * * * *", "*/5 * * * *"]);

  for (const point of map.entrypoints.filter((e) => e.path === "src/worker.ts")) {
    const line = read("src/worker.ts").split("\n")[point.line - 1];
    assert.match(line, new RegExp(`async ${point.kind}\\(`), `${point.kind} line ${point.line}: ${line}`);
  }
  assert.ok(map.entrypoints.some((e) => e.kind === "runner" && e.path === "runner/qq-gateway.mjs"));
  assert.ok(map.entrypoints.some((e) => e.kind === "script" && e.path === "scripts/deploy.mjs"));
  for (const module of map.modules) {
    assert.ok(module.lines > 0, module.path);
    assert.ok(module.role.length > 0, `${module.path} has no role`);
  }
});

test("S7 generation is idempotent apart from built_at", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfcard-idem-"));
  try {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    assert.equal(generate(["--out", a]).status, 0);
    assert.equal(generate(["--out", b]).status, 0);
    const strip = (text) => text.replace(/"built_at": "[^"]+"/, '"built_at": "<time>"');
    assert.equal(strip(readFileSync(a, "utf8")), strip(readFileSync(b, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A mutated copy of the manifest; the real config file is never touched. */
function mutant(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "selfcard-bad-"));
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  mutate(manifest);
  const file = join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return { dir, args: ["--manifest", file, "--out", join(dir, "card.ts")], cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function assertRejected(caseName, mutate, reason) {
  const bad = mutant(mutate);
  try {
    const run = generate(bad.args);
    assert.notEqual(run.status, 0, `${caseName}: generator must fail`);
    assert.match(run.stderr + run.stdout, reason, `${caseName}: ${run.stderr}`);
  } finally {
    bad.cleanup();
  }
}

test("N1 a manifest file that does not exist fails the build", () => {
  assertRejected(
    "missing file",
    (m) => m.capabilities[0].files.push({ path: "src/there-is-no-such-file.ts", anchor: "export", role: "不存在" }),
    /src\/there-is-no-such-file\.ts/,
  );
});

test("N2 a stale anchor/pattern fails the build", () => {
  assertRejected(
    "stale provider pattern",
    (m) => {
      const cap = m.capabilities.find((c) => c.id === "image_generation");
      cap.providers[0].host_pattern = "api\\.no-such-openai-host\\.example";
    },
    /api\\.no-such-openai-host|no-such-openai-host/,
  );
});

test("N3 dropping a capability's tools leaves a real tool unregistered and fails", () => {
  assertRejected(
    "unregistered tool",
    (m) => {
      for (const cap of m.capabilities) cap.tools = cap.tools.filter((t) => t !== "generate_image");
    },
    /generate_image/,
  );
});

test("N4 a switch that appears nowhere in the code fails the build", () => {
  assertRejected(
    "unknown switch",
    (m) => m.capabilities.find((c) => c.id === "image_generation").switches.push("no_such_switch"),
    /no_such_switch/,
  );
});

test("S6 document reading is off by default and names its positive gate", () => {
  const doc = capability("document_reading");
  assert.equal(doc.default_state, "off_by_default");
  assert.deepEqual(doc.switches, ["docread"]);
});
