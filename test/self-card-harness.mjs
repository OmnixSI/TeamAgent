/**
 * SK-3 replay harness shared by npm test and the manual report script.
 * It only drives the real describe_self runtime when SK-1/SK-2 have landed;
 * until then callers can still use the independent fact reader and the corpus.
 */
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, repoPath } from "./self-card-facts.mjs";

let apiPromise = null;

export function replayAvailability() {
  const generated = fs.existsSync(repoPath("src/self-card.generated.ts"));
  const runtime = fs.existsSync(repoPath("src/self-card.ts"));
  const toolsIndex = fs.existsSync(repoPath("src/tools/index.ts"))
    ? fs.readFileSync(repoPath("src/tools/index.ts"), "utf8")
    : "";
  const toolFile = fs.existsSync(repoPath("src/tools/describe-self.ts")) ||
    fs.existsSync(repoPath("src/tools/describe_self.ts"));
  const registered = /describe[-_]self/.test(toolsIndex) && toolFile;
  return {
    generated,
    runtime,
    toolFile,
    registered,
    ready: generated && runtime && registered,
    touched: generated || runtime || toolFile || /describe[-_]self/.test(toolsIndex),
  };
}

/** Bundle the real extension-tool dispatcher plus the runtime and import it. */
export async function loadReplayApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const outfile = `.wrangler/self-card-replay-${process.pid}.mjs`;
      await build({
        stdin: {
          contents: 'export { runExtraTool } from "./src/toolkit";',
          resolveDir: REPO_ROOT,
          loader: "ts",
        },
        bundle: true,
        platform: "browser",
        format: "esm",
        outfile,
        logLevel: "silent",
      });
      return import(pathToFileURL(path.join(REPO_ROOT, outfile)).href + "?t=" + Date.now());
    })();
  }
  return apiPromise;
}

export function readCardCommit() {
  const file = repoPath("src/self-card.generated.ts");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/["']?commit["']?\s*:\s*["']([0-9a-f]{7,40})["']/i);
  return match ? match[1] : null;
}

/** Build a fake-DB env for one replay state. Base env comes from test/support.mjs. */
export async function prepareEnv(baseEnv, { settings = {}, env = {}, removeEnv = [], release = null } = {}) {
  const e = baseEnv;
  // Present-by-default sentinel keeps capability questions about implementation
  // from degenerating into "not configured"; S6 removes it explicitly.
  if (!("OPENAI_API_KEY" in env) && !removeEnv.includes("OPENAI_API_KEY"))
    e.OPENAI_API_KEY = "present-for-replay";
  Object.assign(e, env);
  for (const key of removeEnv) delete e[key];
  if (release !== null) e.RELEASE = release;
  for (const [key, value] of Object.entries(settings)) {
    await e.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
      .bind(key, String(value))
      .run();
  }
  return e;
}

export function contextFor(question) {
  const latest = {
    id: "self-replay-" + question.id,
    group_id: "GROUP000001",
    sender: "U1",
    body: question.text,
    ts: new Date().toISOString(),
    mentioned: 1,
    meta: { direct: true, media: [] },
  };
  return {
    context: { latest, mentioned: true },
    source: latest,
    messages: [],
    isTainted: () => false,
  };
}

export function outputText(out) {
  if (typeof out === "string") {
    // agentAnswer returns a JSON string: {"mode":"work","text":"群里说的话"}.
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed.text === "string") return parsed.text;
    } catch {}
    return out;
  }
  if (out && typeof out.text === "string") return out.text;
  if (out && typeof out.content === "string") return out.content;
  return JSON.stringify(out);
}

/** Ask the real tool for one question. Returns the user-visible text. */
export async function renderQuestion(api, e, question, group = {}, state = null) {
  const topic = state?.topic ?? question.topic ?? group.topic;
  const query = state?.query ?? question.query ?? group.query;
  const out = await api.runExtraTool(e, "describe_self", { topic, query }, contextFor(question));
  return outputText(out);
}

export function redactSecrets(text, values = []) {
  let out = String(text);
  for (const value of values) {
    if (typeof value === "string" && value.length >= 8) out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted]");
}

export function loadQuestions() {
  return JSON.parse(fs.readFileSync(repoPath("test/fixtures/self-questions.json"), "utf8"));
}
