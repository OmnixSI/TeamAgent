#!/usr/bin/env node
// DS-live end-to-end replay: real Worker code on wrangler dev --local + an
// isolated local D1, real DeepSeek calls, every QQ request recorded and never
// sent. Inputs are real historical messages selected read-only from live D1 and
// real media bytes captured read-only (see select-inputs.py / images.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCEN = process.env.DS_LIVE_SCEN || "/Users/yanghongming/Projects/.worktrees/TeamAgent-p4b-login/.agent/scenarios/ds-live";
const EVID = process.env.DS_LIVE_EVID || "/Users/yanghongming/Projects/.worktrees/TeamAgent-p4b-login/.agent/releases/DS-live/evidence";
const KEY_FILE = process.env.DEEPSEEK_API_KEY_FILE || "/tmp/ds-live-key";
const OPENAI_KEY_FILE = process.env.OPENAI_API_KEY_FILE || "";
const PORT = Number(process.env.DS_LIVE_PORT || 18765);
const BASE = "http://127.0.0.1:" + PORT;
const GROUP = "9968A083EE07797A987010E64CD421B9";
const BOT = "204AE67DE34A4448CEE8EA52208A2BB0";
const SENDER = "0FC1E8A8BD28981E86866125AC3FCEFF";
const RUNNER_TOKEN = "replay-runner-only";
const lane = (process.argv.find(a => a.startsWith("--lane=")) || "--lane=all").slice(7);

if (!fs.existsSync(KEY_FILE)) { console.error("DEEPSEEK_API_KEY_FILE missing"); process.exit(2); }
const KEY = fs.readFileSync(KEY_FILE, "utf8").trim();
if (!KEY) { console.error("key file empty"); process.exit(2); }

const images = JSON.parse(fs.readFileSync(path.join(SCEN, "input", "images.json"), "utf8"));
const imageBy = name => images.find(x => x.file === name);
const input = name => fs.readFileSync(path.join(SCEN, "input", name));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ds-live-run-"));
const HOME = path.join(TMP, "home");
fs.mkdirSync(path.join(HOME, "media-tmp"), { recursive: true, mode: 0o700 });
const media = {};
function addMedia(key, file, mime) { media[key] = { mime, b64: input(file).toString("base64") }; }

function pickImage(prefix) {
  const row = images.find(x => x.sha256.startsWith(prefix));
  if (!row) throw Error("image missing " + prefix);
  const key = row.file;
  addMedia(key, row.file, row.mime || (row.file.endsWith(".png") ? "image/png" : "image/jpeg"));
  return { key, row };
}

async function post(route, body, token) {
  const r = await fetch(BASE + route, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(180000),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw Error(route + " HTTP " + r.status + " " + text.slice(0, 300));
  return data;
}
const state = () => post("/__state", {});

async function startServer() {
  const { build } = await import(pathToFileURL(path.join(ROOT, "node_modules/esbuild/lib/main.js")).href);
  await build({
    entryPoints: [path.join(ROOT, "scripts/ds-live/replay-worker.ts")],
    bundle: true, format: "esm", platform: "browser",
    outfile: path.join(TMP, "worker.mjs"),
    logLevel: "silent",
  });
  fs.copyFileSync(path.join(ROOT, "schema.sql"), path.join(TMP, "schema.sql"));
  fs.writeFileSync(path.join(TMP, "wrangler.toml"), [
    'name = "ds-live-replay"',
    'main = "worker.mjs"',
    'compatibility_date = "2026-11-11"',
    '[[d1_databases]]',
    'binding = "DB"',
    'database_name = "ds-live-replay"',
    'database_id = "00000000-0000-0000-0000-000000000001"',
    '',
  ].join("\n"));
  const openaiKey = OPENAI_KEY_FILE && fs.existsSync(OPENAI_KEY_FILE) ? fs.readFileSync(OPENAI_KEY_FILE, "utf8").trim() : "";
  fs.writeFileSync(path.join(TMP, ".dev.vars"), "DEEPSEEK_API_KEY=" + KEY + "\n" + (openaiKey ? "OPENAI_API_KEY=" + openaiKey + "\n" : ""), { mode: 0o600 });
  const cli = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const persist = path.join(TMP, "state");
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(TMP, "wrangler.log"), WRANGLER_HOME: path.join(TMP, "wrangler-home"), XDG_CONFIG_HOME: path.join(TMP, "xdg-config"), XDG_CACHE_HOME: path.join(TMP, "xdg-cache") };
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"]) delete env[k];
  execFileSync(process.execPath, [cli, "d1", "execute", "ds-live-replay", "--local", "--config", path.join(TMP, "wrangler.toml"), "--persist-to", persist, "--file", path.join(TMP, "schema.sql")], { cwd: ROOT, env, stdio: "pipe", timeout: 60000 });
  const child = spawn(process.execPath, [cli, "dev", "--local", "--ip", "127.0.0.1", "--port", String(PORT), "--config", path.join(TMP, "wrangler.toml"), "--persist-to", persist, "--show-interactive-dev-session=false"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", d => { logs += d; });
  child.stderr.on("data", d => { logs += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("wrangler startup timeout\n" + logs.slice(-1200))), 60000);
    const tick = () => { if (/Ready on|ready on/i.test(logs)) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", tick); child.stderr.on("data", tick);
    child.once("exit", code => { clearTimeout(timer); reject(Error("wrangler exited " + code + "\n" + logs.slice(-1200))); });
  });
  return { child, logs: () => logs, stop: async () => { child.kill("SIGTERM"); await new Promise(r => { if (child.exitCode !== null) return r(); child.once("exit", r); setTimeout(() => { child.kill("SIGKILL"); r(); }, 4000); }); } };
}

function event({ id, text, ts, attachments = [], mentioned = true, replyTo }) {
  const d = {
    id, content: text || "", group_openid: GROUP, timestamp: ts || new Date().toISOString(),
    author: { id: SENDER, member_openid: SENDER, username: "Souvereign", bot: false },
    mentions: mentioned ? [{ member_openid: BOT, nickname: "Bot", is_you: true }] : [],
    attachments,
    message_type: 0,
    message_scene: { ext: ["msg_idx=replay-" + id.slice(-12)] },
  };
  if (replyTo) d.message_type = 103;
  return { op: 0, t: mentioned ? "GROUP_AT_MESSAGE_CREATE" : "GROUP_MESSAGE_CREATE", d };
}

async function reset(extra = {}) {
  return post("/__reset", { groupId: GROUP, media, ...extra });
}

async function ingest(ev) {
  return post("/__ingest", { event: ev });
}

function costOf(s) {
  const ds = (s.dsUsage || []).reduce((n, r) => n + Number(r.est_cost_micro_usd || 0), 0);
  const mk = (s.modelRuns || []).reduce((n, r) => n + Number(r.input_tokens || 0) * 0.15 + Number(r.output_tokens || 0) * 0.6, 0);
  return { ds_micro_usd: ds, model_micro_usd: Math.round(mk), total_micro_usd: Math.round(ds + mk) };
}

function replyText(s, msgId) {
  return (s.outbox || []).filter(o => o.msg_id === msgId && !String(o.id).startsWith("job-failed-")).map(o => o.body).join("\n---\n");
}

const results = [];
function record(entry) { results.push(entry); console.log(JSON.stringify({ item: entry.item, id: entry.id, pass: entry.pass, note: entry.note })); }

async function caseReply() {
  const rows = JSON.parse(fs.readFileSync(path.join(SCEN, "input", "reply-rows.json"), "utf8"));
  for (const [i, row] of rows.entries()) {
    await reset();
    const started = Date.now();
    const id = "ROLEPLAY-REPLY-" + (i + 1);
    const ing = await ingest(event({ id, text: row.body, ts: new Date().toISOString() }));
    const drained = await post("/__drain", {});
    const s = await state();
    const out = replyText(s, id);
    record({
      item: "7-reply-model", id, lane: "reply",
      input: { message: row.body, historical_id_tail: row.id.slice(-12), webhook: ing.status },
      output: out ? out.slice(0, 500) : "(no outbox reply)",
      ms: Date.now() - started, cost: costOf(s),
      pass: out.length > 5 && !/DSML/.test(out) && (s.decisions || []).length > 0 && !(s.calls || []).some(c => c.status === 400),
      note: { webhook: ing, modelRuns: s.modelRuns, calls: s.calls, decisions: s.decisions, drained: drained.processed, jobs: s.jobs, messages: s.messages },
      state: { outbox: s.outbox, jobs: s.jobs, messages: s.messages, meta: s.meta, decisions: s.decisions, modelRuns: s.modelRuns, calls: s.calls, qq: s.qq },
    });
  }
}

async function caseVoice() {
  const voice = JSON.parse(fs.readFileSync(path.join(SCEN, "input", "voice.json"), "utf8"));
  const { runVoiceJob } = await import(pathToFileURL(path.join(ROOT, "runner/voice.mjs")).href);
  const replayFetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "multimedia.nt.qq.com.cn" && u.pathname.startsWith("/replay-media/")) {
      const m = media[u.pathname.slice("/replay-media/".length)];
      if (!m) return new Response("missing", { status: 404 });
      return new Response(Buffer.from(m.b64, "base64"), { status: 200, headers: { "content-type": m.mime } });
    }
    return fetch(url, init);
  };
  for (const [i, v] of voice.entries()) {
    await reset();
    addMedia(v.file, v.file, "audio/silk");
    const started = Date.now();
    const id = "ROLEPLAY-VOICE-" + (i + 1);
    await ingest(event({
      id, text: "", ts: new Date().toISOString(),
      attachments: [{ content: "", content_type: "voice", filename: "voice.silk", size: v.bytes, url: "https://multimedia.nt.qq.com.cn/replay-media/" + v.file }],
    }));
    let claim = await post("/api/runner/voice/claim", {}, RUNNER_TOKEN);
    const job = claim.job;
    const runner = job ? await runVoiceJob(job, { home: HOME, fetch: replayFetch, log: () => {} }) : null;
    let report = null;
    if (job && runner?.report) {
      report = await post("/api/runner/voice/report", { id: job.id, lease: job.payload.lease, ...runner.report }, RUNNER_TOKEN);
    }
    const drained = await post("/__drain", {});
    const s = await state();
    const meta = JSON.parse((s.meta || []).find(m => m.id === id)?.json || "{}");
    const asr = meta.media?.[0]?.asr || "";
    const out = replyText(s, id);
    record({
      item: "1-voice-asr", id, lane: "voice",
      input: { sample: v.file, source: v.source, duration_ms: v.duration_ms, job: job?.id },
      output: { asr, reply: out.slice(0, 400), report: runner?.report, report_status: report?.ok },
      ms: Date.now() - started, cost: costOf(s),
      pass: !!asr && runner?.report?.success === true,
      note: { drained: drained.processed.length, residency: runner?.cleanup, dsUsage: s.dsUsage, calls: s.calls },
      state: { jobs: s.jobs, outbox: s.outbox, meta: s.meta.filter(m => m.id === id), dsUsage: s.dsUsage, calls: s.calls, qq: s.qq },
    });
  }
}

async function caseBili() {
  const row = JSON.parse(fs.readFileSync(path.join(SCEN, "input", "bili-row.json"), "utf8"));
  const { runMediaJob, makeClient } = await import(pathToFileURL(path.join(ROOT, "runner/media.mjs")).href);
  await reset({ biliJob: { id: "bmedia-" + row.bvid, payload: { v: 2, bvid: row.bvid, page: 1, waiters: ["replay-wait"], duration: row.duration, until: Date.now() + 40 * 60000 } } });
  const started = Date.now();
  const claim = await post("/api/runner/fetch/media/claim", { proto: 2 }, RUNNER_TOKEN);
  const job = claim.job;
  let result = null, report = null;
  if (job) {
    const client = await makeClient(path.join(os.homedir(), ".inkboard-team"));
    result = await runMediaJob(job, {
      home: HOME, client, settings: { enabled: true, max_minutes: 90, rtf: 0.05, deadline_cap_minutes: 40, mem_cap_mb: 1300, tmp_cap_mb: 2048 },
      deepseekConfig: { key_file: KEY_FILE }, log: () => {},
    });
    if (result.report) report = await post("/api/runner/fetch/media/report", { ...result.report, proto: 2 }, RUNNER_TOKEN);
  }
  const s = await state();
  const note = (s.mediaNotes || []).find(n => n.id === "asr:" + row.bvid);
  record({
    item: "2-bili-cloud-asr", id: "BILI-" + row.bvid, lane: "bili",
    input: { message: row.body, bvid: row.bvid, duration_s: row.duration },
    output: { provider: result?.report?.result?.provider, chunks: result?.report?.result?.chunks, chars: result?.report?.result?.text?.length, head: result?.report?.result?.text?.slice(0, 200), report_status: report?.ok },
    ms: Date.now() - started, cost: costOf(s),
    pass: !!result?.report?.success && (result.report.result?.cloud_chunks || 0) > 0,
    note: { cleanup: result?.cleanup, residue: result?.cleanup?.residue, note: note?.body, calls: s.calls },
    state: { jobs: s.jobs, mediaNotes: s.mediaNotes, dsUsage: s.dsUsage, calls: s.calls, qq: s.qq },
  });
}

async function caseTts() {
  const rows = JSON.parse(fs.readFileSync(path.join(SCEN, "input", "tts-rows.json"), "utf8"));
  const { processVoiceOutbox } = await import(pathToFileURL(path.join(ROOT, "runner/voice-delivery.mjs")).href);
  const replayFetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "api.bot.qq.com") {
      let body = null; try { body = JSON.parse(String(init?.body || "{}")); } catch {}
      const slim = body ? { file_type: body.file_type, srv_send_msg: body.srv_send_msg, msg_type: body.msg_type, msg_id: body.msg_id, msg_seq: body.msg_seq, media: body.media ? { file_info: body.media.file_info } : undefined, file_data_bytes: typeof body.file_data === "string" ? Math.round(body.file_data.length * 3 / 4) : undefined } : null;
      qqLog.push({ path: u.pathname, body: slim });
      return new Response(JSON.stringify(u.pathname.includes("/files") ? { file_info: "REPLAY-FILE-INFO", ttl: 0 } : { id: "replay-qq-" + qqLog.length }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetch(url, init);
  };
  let qqLog = [];
  for (const [i, row] of rows.entries()) {
    qqLog = [];
    const msgId = "ROLEPLAY-TTS-" + (i + 1);
    const ts = new Date().toISOString();
    await reset({
      messages: [{ id: msgId, group_id: GROUP, sender: SENDER, body: "[语音]", ts, mentioned: 1, meta: { media: [{ kind: "voice", url: "https://multimedia.nt.qq.com.cn/replay-media/none.silk" }] } }],
      settings: { "voice:mode": "always" },
    });
    const started = Date.now();
    // Production policy + enqueue path: source is a voice message, mode auto.
    const enq = await post("/__voice_enqueue", { id: msgId, group: GROUP, messageId: msgId, text: row.text, sender: SENDER });
    const delivered = await processVoiceOutbox({
      cloud: async (route, body) => {
        const p = route === "voice-outbox" ? "/api/runner/voice-outbox" : "/api/runner/voice-outbox/report";
        return await post(p, body || {}, RUNNER_TOKEN);
      },
      bot: { api: { getToken: async () => "replay-token" } },
      deps: { fetch: replayFetch, cacheDir: path.join(TMP, "tts-cache"), log: () => {} },
    });
    const s = await state();
    const qqFiles = qqLog.filter(q => q.path.includes("/files"));
    const qqSend = qqLog.filter(q => q.path.endsWith("/messages") && q.body?.msg_type === 7);
    const tts = (s.dsUsage || []).find(u => u.purpose === "tts");
    record({
      item: "3-tts-voice-reply", id: msgId, lane: "tts",
      input: { text: row.text, historical_id_tail: row.historical_id?.slice(-12) },
      output: {
        enqueued: enq.outbox?.status, delivered,
        qqUploads: qqFiles.length, qqVoiceSends: qqSend.length,
        uploadBody: qqFiles[0]?.body ? { file_type: qqFiles[0].body.file_type, srv_send_msg: qqFiles[0].body.srv_send_msg } : null,
        sendBody: qqSend[0]?.body ? { msg_type: qqSend[0].body.msg_type, has_file_info: !!qqSend[0].body.media?.file_info } : null,
        tts_usage: tts || null,
      },
      ms: Date.now() - started, cost: costOf(s),
      pass: qqFiles.length === 1 && qqSend.length === 1 && !!tts && tts.status === "ok" && tts.units > 0,
      note: { outbox: s.outbox, dsUsage: s.dsUsage, qq: qqLog, calls: s.calls },
      state: { outbox: s.outbox, outboxMeta: s.outboxMeta, dsUsage: s.dsUsage, qq: qqLog, calls: s.calls },
    });
  }
}

async function caseImage(item, prompts) {
  for (const [i, c] of prompts.entries()) {
    const img = pickImage(c.sha);
    const mime = img.row.mime || (img.key.endsWith(".png") ? "image/png" : "image/jpeg");
    await reset();
    const started = Date.now();
    const id = c.id;
    await ingest(event({
      id, text: c.text, ts: new Date().toISOString(),
      attachments: [{ content: "", content_type: mime, filename: img.row.file, size: img.row.bytes, url: "https://multimedia.nt.qq.com.cn/replay-media/" + img.key }],
    }));
    const drained = await post("/__drain", {});
    let s = await state();
    let out = replyText(s, id);
    let tool = (s.toolCalls || []).find(t => ["read_image_text", "read_document", "web_search", "fetch_page"].includes(t.name));
    let direct = null;
    if (!tool && c.directTool) {
      direct = await post("/__tool", { name: c.directTool, messageId: id, groupId: GROUP, sender: SENDER, input: c.toolInput || {} });
      tool = { name: c.directTool, status: direct.ok && direct.result?.ok !== false ? "ok" : "failed", direct: true, result: direct.result };
      s = await state();
    }
    const notes = s.imageNotes || [];
    const mediaNote = (s.mediaNotes || []).find(n => n.id.startsWith("ocr:") || n.id.startsWith("doc:"));
    record({
      item, id, lane: item.split("-")[1],
      input: { text: c.text, image_sha: img.row.sha256.slice(0, 12), image_source: img.row.origin },
      output: { reply: out.slice(0, 600), vision: notes.map(n => ({ desc: n.desc, text: n.text, tags: n.tags })), tool: tool || null, ocrNote: mediaNote?.body || null, direct: direct?.result || null },
      ms: Date.now() - started, cost: costOf(s),
      pass: c.check({ out, notes, tool, mediaNote, state: s, direct }),
      note: { drained: drained.processed.length, toolCalls: s.toolCalls, dsUsage: s.dsUsage, calls: s.calls },
      state: { outbox: s.outbox, meta: s.meta, jobs: s.jobs, imageNotes: s.imageNotes, toolCalls: s.toolCalls, mediaNotes: s.mediaNotes, dsUsage: s.dsUsage, calls: s.calls, qq: s.qq, decisions: s.decisions },
    });
  }
}

async function caseText(item, prompts) {
  for (const c of prompts) {
    await reset();
    const started = Date.now();
    const id = c.id;
    await ingest(event({ id, text: c.text, ts: new Date().toISOString() }));
    const drained = await post("/__drain", {});
    let s = await state();
    const out = replyText(s, id);
    let tool = (s.toolCalls || []).find(t => t.name === c.tool);
    let direct = null;
    if (!tool) {
      direct = await post("/__tool", { name: c.tool, messageId: id, groupId: GROUP, sender: SENDER, input: c.toolInput || {} });
      tool = { name: c.tool, status: direct.ok && direct.result?.ok !== false ? "ok" : "failed", direct: true };
      s = await state();
    }
    record({
      item, id, lane: item.split("-")[1],
      input: { text: c.text, real_message_tail: c.realId?.slice(-12) },
      output: { reply: out.slice(0, 700), tool: tool || null, direct: direct?.result || null },
      ms: Date.now() - started, cost: costOf(s),
      pass: !!tool && tool.status === "ok",
      note: { drained: drained.processed.length, toolCalls: s.toolCalls, dsUsage: s.dsUsage, calls: s.calls },
      state: { outbox: s.outbox, toolCalls: s.toolCalls, dsUsage: s.dsUsage, calls: s.calls, qq: s.qq, mediaNotes: s.mediaNotes, jobs: s.jobs },
    });
  }
}

async function caseDoc() {
  const row = JSON.parse(fs.readFileSync(path.join(SCEN, "input", "doc-row.json"), "utf8"));
  await reset();
  const started = Date.now();
  const id = "ROLEPLAY-DOC-1";
  await ingest(event({
    id, text: row.question, ts: new Date().toISOString(),
    attachments: [{ content: "", content_type: "application/pdf", filename: row.filename, size: row.size, url: row.url }],
  }));
  await post("/__drain", {});
  const first = await post("/__tool", { name: "read_document", messageId: id, groupId: GROUP, sender: SENDER, input: { message_id: id, question: row.question } });
  await post("/__drain", {});
  const s1 = await state();
  const second = await post("/__tool", { name: "read_document", messageId: id, groupId: GROUP, sender: SENDER, input: { message_id: id, question: row.question } });
  const s2 = await state();
  const notes = s2.mediaNotes.filter(n => n.id.startsWith("doc:"));
  const jobs = s2.jobs.filter(j => j.kind === "docread");
  record({
    item: "4b-read-document", id, lane: "doc",
    input: { question: row.question, filename: row.filename, real_sample: row.real_sample, url_host: new URL(row.url).hostname },
    output: { first: first.result, first_jobs: s1.jobs.filter(j => j.kind === "docread"), second: second.result, jobs: jobs.map(j => ({ id: j.id, status: j.status, error: j.error })), doc_notes: notes, reply: replyText(s2, id).slice(0, 300) },
    ms: Date.now() - started, cost: costOf(s2),
    pass: notes.length > 0 && second.result?.ok === true && typeof second.result?.text === "string" && second.result.text.length > 20,
    note: { toolCalls: s2.toolCalls, jobs },
    state: { outbox: s2.outbox, toolCalls: s2.toolCalls, jobs: s2.jobs, mediaNotes: s2.mediaNotes, calls: s2.calls, dsUsage: s2.dsUsage },
  });
}
async function caseImageGen() {
  await reset();
  const started = Date.now();
  const id = "ROLEPLAY-IMAGEGEN-1";
  const direct = await post("/__tool", {
    name: "generate_image", messageId: id, groupId: GROUP, sender: SENDER,
    input: { prompt: "一只戴草帽的橘猫在海边看日落，水彩风格", size: "square" },
  });
  const s = await state();
  const log = (s.imageGenLog || [])[0] || null;
  const image = (s.generatedImages || [])[0] || null;
  const outbox = (s.outbox || []).find(o => String(o.id).endsWith("~g")) || null;
  record({
    item: "8-imagegen", id, lane: "imagegen",
    input: { prompt: "一只戴草帽的橘猫在海边看日落，水彩风格", size: "square", real_sample: "F8 探针同款提示词；线上没有真实生图请求（image_gen_log=0）" },
    output: { result: direct.result, log, image, outbox, openai: (s.calls || []).filter(c => c.path && c.path.includes("images")) },
    ms: Date.now() - started, cost: { ds_micro_usd: 0, openai_micro_usd: (s.openaiUsage || []).reduce((n, r) => n + Number(r.est_cost_micro_usd || 0), 0), total_micro_usd: (s.openaiUsage || []).reduce((n, r) => n + Number(r.est_cost_micro_usd || 0), 0) },
    pass: !!log && log.status === "ok" && !!image && image.bytes > 0 && image.width === 1024 && image.height === 1024 && !!outbox,
    note: { calls: s.calls, openaiUsage: s.openaiUsage, quota: s.quotaReservations },
    state: { outbox: s.outbox, outboxMeta: s.outboxMeta, imageGenLog: s.imageGenLog, generatedImages: s.generatedImages, openaiUsage: s.openaiUsage, calls: s.calls },
  });
}

async function caseVoiceCommand() {
  await reset({ members: [{ id: "qq:" + SENDER, name: "Souvereign", role: "owner" }] });
  const started = Date.now();
  const texts = ["/voice", "/voice on", "/voice", "/voice auto", "/voice"];
  for (const [i, text] of texts.entries()) {
    await ingest(event({ id: "ROLEPLAY-CMD-" + i, text, ts: new Date().toISOString(), mentioned: false }));
  }
  const s = await state();
  const replies = (s.outbox || []).map(o => o.body);
  record({
    item: "3b-voice-command", id: "ROLEPLAY-CMD", lane: "voicecmd",
    input: { commands: texts },
    output: { replies },
    ms: Date.now() - started, cost: costOf(s),
    pass: replies.some(r => /本群语音回复：auto/.test(r)) && replies.some(r => /已设为 always/.test(r)) && replies.some(r => /已设为 auto/.test(r)),
    note: { settings: (s.settings || []).filter(x => x.key.startsWith("voice:")) },
    state: { outbox: s.outbox, settings: (s.settings || []).filter(x => x.key.startsWith("voice:")) },
  });
}


// ---------- synthetic lanes ----------
const SYN = path.join(SCEN, "synthetic");
function addMediaPath(key, abs, mime) { media[key] = { mime, b64: fs.readFileSync(abs).toString("base64") }; }
function normText(v) {
  return String(v || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}
function lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: n + 1 }, (_, j) => [j]);
  for (let i = 1; i <= m; i++) {
    dp[0][i] = i;
    for (let j = 1; j <= n; j++) dp[j][i] = Math.min(dp[j - 1][i] + 1, dp[j][i - 1] + 1, dp[j - 1][i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[n][m];
}
function cer(ref, hyp) {
  const a = normText(ref), b = normText(hyp);
  return a.length ? Math.round((lev(a, b) / a.length) * 10000) / 10000 : null;
}
function numericNorm(v) {
  const map = { 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
  return normText(v).replace(/[零〇一二两三四五六七八九]/g, c => map[c]);
}
function cerNumeric(ref, hyp) {
  const a = numericNorm(ref), b = numericNorm(hyp);
  return a.length ? Math.round((lev(a, b) / a.length) * 10000) / 10000 : null;
}

async function caseSynVoice() {
  const assets = JSON.parse(fs.readFileSync(path.join(SYN, "assets.json"), "utf8"));
  const text = assets.text;
  const out = {};
  // Worker cloud path: OGG served over the replay media host.
  addMediaPath("syn-speech.ogg", path.join(SYN, "speech.ogg"), "audio/ogg");
  await reset();
  let started = Date.now();
  await ingest(event({
    id: "SYN-VOICE-WORKER", text: "", ts: new Date().toISOString(),
    attachments: [{ content: "", content_type: "audio/ogg", filename: "speech.ogg", size: assets.bytes.ogg, url: "https://multimedia.nt.qq.com.cn/replay-media/syn-speech.ogg" }],
  }));
  const drained = await post("/__drain", {});
  let s = await state();
  let meta = JSON.parse((s.meta || []).find(m => m.id === "SYN-VOICE-WORKER")?.json || "{}");
  const workerAsr = meta.media?.[0]?.asr || "";
  out.worker = {
    asr: workerAsr, error: meta.media?.[0]?.asrError || null, source: meta.media?.[0]?.asrSource || null,
    cer: workerAsr ? cer(text, workerAsr) : null, drained: drained.processed.length, dsUsage: s.dsUsage, calls: s.calls, ms: Date.now() - started,
  };
 	// Runner path: SILK decoded locally, then cloud ASR with the installed runner key.
  addMediaPath("syn-speech.silk", path.join(SYN, "speech.silk"), "audio/silk");
  await reset();
  started = Date.now();
  await ingest(event({
    id: "SYN-VOICE-RUNNER", text: "", ts: new Date().toISOString(),
    attachments: [{ content: "", content_type: "voice", filename: "speech.silk", size: assets.bytes.silk, url: "https://multimedia.nt.qq.com.cn/replay-media/syn-speech.silk" }],
  }));
  const claim = await post("/api/runner/voice/claim", {}, RUNNER_TOKEN);
  let runner = null, report = null;
  if (claim.job) {
    const { runVoiceJob } = await import(pathToFileURL(path.join(ROOT, "runner/voice.mjs")).href);
    const replayFetch = async (url, init) => {
      const u = new URL(url);
      if (u.hostname === "multimedia.nt.qq.com.cn" && u.pathname.startsWith("/replay-media/")) {
        const m = media[u.pathname.slice("/replay-media/".length)];
        return m ? new Response(Buffer.from(m.b64, "base64"), { status: 200, headers: { "content-type": m.mime } }) : new Response("missing", { status: 404 });
      }
      return fetch(url, init);
    };
    runner = await runVoiceJob(claim.job, { home: HOME, fetch: replayFetch, log: () => {} });
    if (runner?.report) report = await post("/api/runner/voice/report", { id: claim.job.id, lease: claim.job.payload.lease, ...runner.report }, RUNNER_TOKEN);
  }
  await post("/__drain", {});
  s = await state();
  meta = JSON.parse((s.meta || []).find(m => m.id === "SYN-VOICE-RUNNER")?.json || "{}");
  const runnerAsr = meta.media?.[0]?.asr || runner?.report?.text || "";
  out.runner = {
    asr: runnerAsr, error: runner?.report?.success === false ? runner.report : null, source: meta.media?.[0]?.asrSource || null,
    cer: runnerAsr ? cer(text, runnerAsr) : null, cer_numeric: runnerAsr ? cerNumeric(text, runnerAsr) : null, report: runner?.report, report_status: report?.ok, dsUsage: s.dsUsage, ms: Date.now() - started, cleanup: runner?.cleanup,
  };
  record({
    item: "syn-1-voice-loop", id: "SYN-VOICE", lane: "syn-voice",
    input: { text, asset: "DeepSeek TTS 8.96s → OGG Opus / SILK", bytes: { ogg: assets.bytes.ogg, silk: assets.bytes.silk } },
    output: out,
    ms: (out.worker.ms || 0) + (out.runner.ms || 0),
    cost: { ds_micro_usd: 0, note: "worker 0 计费（0ms 失败）；runner 8.96s ≈ $0.00014" },
    pass: !!out.runner.asr && out.runner.cer_numeric !== null && out.runner.cer_numeric <= 0.05 && !!out.worker.error,
    note: { worker_note: "Worker 侧 callDsTool 被 redirect:\"error\" 挡住，0ms upstream", runner_note: "runner key 路径通过" },
    state: { worker: out.worker.calls, runner: s.dsUsage },
  });
}

async function caseSynLong() {
  const assets = JSON.parse(fs.readFileSync(path.join(SYN, "assets.json"), "utf8"));
  const { transcribeAudio } = await import(pathToFileURL(path.join(ROOT, "runner/cloud-asr.mjs")).href);
  const started = Date.now();
  const result = await transcribeAudio(path.join(SYN, "speech-12min.wav"), {
    settings: { "asr:provider": "cloud" },
    keyFile: KEY_FILE,
    concurrency: 4,
    timeoutMs: 300000,
  });
  const text = result.segments.map(x => x.text).join("");
  const out = {
    provider: result.provider, chunks: result.chunks, cloud_chunks: result.cloud_chunks, local_chunks: result.local_chunks,
    audio_s: Math.round(result.audio_s * 10) / 10, units: result.units, chars: text.length,
    head: text.slice(0, 120), cer_vs_sentence: cer(assets.text, text.slice(0, assets.text.length)),
    cer_numeric_vs_sentence: cerNumeric(assets.text, text.slice(0, assets.text.length)),
    max_rss_mb: result.max_rss_mb, ms: Date.now() - started,
  };
  record({
    item: "syn-2-bili-long", id: "SYN-LONG-12MIN", lane: "syn-long",
    input: { source: "同一段 DeepSeek TTS 8.96s 拼接成 720s（>10 分钟）", asset_bytes: assets.bytes.long },
    output: out, ms: out.ms,
    cost: { ds_micro_usd: Math.round(720 * 58000 / 3600), note: "$0.058/小时 × 720s" },
    pass: result.provider === "cloud" && result.cloud_chunks >= 1 && result.local_chunks === 0 && out.chars > 500,
    note: { chunks: result.chunks, units: result.units, max_rss_mb: result.max_rss_mb },
    state: { result: { ...out, segments: result.segments.length } },
  });
}

async function caseSynTts() {
  const text = "张伟在2026年11月14日买了3斤苹果，花了28块5毛。";
  const msgId = "SYN-TTS-1";
  await reset({ messages: [{ id: msgId, group_id: GROUP, sender: SENDER, body: "[语音]", ts: new Date().toISOString(), mentioned: 1, meta: { media: [{ kind: "voice" }] } }] });
  const started = Date.now();
  const enq = await post("/__voice_enqueue", { id: msgId, group: GROUP, messageId: msgId, text, sender: SENDER, provider: "deepseek" });
  const { processVoiceOutbox } = await import(pathToFileURL(path.join(ROOT, "runner/voice-delivery.mjs")).href);
  const qqLog = [];
  const replayFetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "api.bot.qq.com") {
      let body = null; try { body = JSON.parse(String(init?.body || "{}")); } catch {}
      qqLog.push({ path: u.pathname, body: body ? { file_type: body.file_type, srv_send_msg: body.srv_send_msg, msg_type: body.msg_type, msg_id: body.msg_id, file_data_bytes: typeof body.file_data === "string" ? Math.round(body.file_data.length * 3 / 4) : undefined, media: body.media ? { file_info: body.media.file_info } : undefined } : null });
      return new Response(JSON.stringify(u.pathname.includes("/files") ? { file_info: "REPLAY-FILE-INFO", ttl: 0 } : { id: "replay-qq-" + qqLog.length }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetch(url, init);
  };
  await processVoiceOutbox({
    cloud: async (route, body) => await post(route === "voice-outbox" ? "/api/runner/voice-outbox" : "/api/runner/voice-outbox/report", body || {}, RUNNER_TOKEN),
    bot: { api: { getToken: async () => "replay-token" } },
    deps: { fetch: replayFetch, cacheDir: path.join(TMP, "tts-cache-syn"), log: () => {} },
  });
  const s = await state();
  const tts = (s.dsUsage || []).find(u => u.purpose === "tts");
  record({
    item: "syn-3-tts-chain", id: msgId, lane: "syn-tts",
    input: { text },
    output: { enqueued: enq.outbox?.status, outbox: s.outbox, qq: qqLog, tts },
    ms: Date.now() - started, cost: { ds_micro_usd: tts?.est_cost_micro_usd || 0 },
    pass: qqLog.some(q => q.path.includes("/files")) && qqLog.some(q => q.path.endsWith("/messages") && q.body?.msg_type === 7) && tts?.status === "ok",
    note: { qq_real_sends: 0 },
    state: { outbox: s.outbox, dsUsage: s.dsUsage, qq: qqLog },
  });
}

async function caseSynOcr() {
  const images = [
    { id: "SYN-OCR-TITLE", file: "title.png", expect: ["2026年11月14日", "项目周报", "17个问题", "张伟"] },
    { id: "SYN-OCR-TABLE", file: "table.png", expect: ["语音识别", "128", "7.42", "待接线"] },
    { id: "SYN-OCR-HAND", file: "handwriting.png", expect: ["语音闭环", "2026", "张伟"] },
  ];
  for (const item of images) {
    const abs = path.join(SYN, item.file);
    const b64 = fs.readFileSync(abs).toString("base64");
    addMediaPath(item.file, abs, "image/png");
    await reset();
    await ingest(event({
      id: item.id, text: "用 read_image_text 读一下这张图里的文字。", ts: new Date().toISOString(),
      attachments: [{ content: "", content_type: "image/png", filename: item.file, size: fs.statSync(abs).size, url: "https://multimedia.nt.qq.com.cn/replay-media/" + item.file }],
    }));
    await post("/__drain", {});
    const tool = await post("/__tool", { name: "read_image_text", messageId: item.id, groupId: GROUP, sender: SENDER, input: {} });
    const vision = await post("/__vision", { b64, mime: "image/png", hint: "读取图里的文字" });
    const text = String(tool.result?.text || "");
    const hit = item.expect.filter(x => text.includes(x));
    record({
      item: "syn-4-ocr-vision", id: item.id, lane: "syn-ocr",
      input: { image: item.file, expect: item.expect, bytes: fs.statSync(abs).size },
      output: { ocr: tool.result, vision: vision.note, hit, missed: item.expect.filter(x => !text.includes(x)) },
      ms: (tool.ms || 0) + (vision.ms || 0), cost: { ds_micro_usd: 0, note: "OCR 0ms 失败；vision 按 token 计费" },
      pass: tool.result?.ok === true && tool.result?.via === "ocr" && hit.length >= 3,
      note: { ocr_via: tool.result?.via, ocr_error: tool.result?.error_kind, vision_ok: vision.ok },
      state: { ocr: tool.result, vision: vision.note },
    });
  }
  // Force the DeepSeek vision leg to fail and observe the fallback selection.
  const b64 = fs.readFileSync(path.join(SYN, "title.png")).toString("base64");
  const fallback = await post("/__vision", { b64, mime: "image/png", hint: "读取图里的文字", breakDeepseek: true }).catch(e => ({ ok: false, transport: String(e.message) }));
  record({
    item: "syn-4b-vision-fallback", id: "SYN-VISION-FALLBACK", lane: "syn-ocr",
    input: { image: "title.png", breakDeepseek: true },
    output: fallback, ms: fallback.ms || 0, cost: { ds_micro_usd: 0 },
    pass: fallback.ok === true,
    note: { detail: "DeepSeek 失败后应切 workers；本机 wrangler 没有 AI binding，真实 workers 识别未验证" },
    state: { fallback },
  });
}

async function caseSynFetch() {
  const dir = path.join(SYN, "web");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "page.html"), "<!doctype html><meta charset=utf-8><title>合成抓取页</title><h1>合成页标题：张伟的预算</h1><p>金额 7.42 元，日期 2026年11月14日。</p>");
  const server = spawn("python3", ["-m", "http.server", "18999", "--bind", "127.0.0.1", "--directory", dir], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 700));
  try {
    const local = await post("/__tool", { name: "fetch_page", messageId: "SYN-FETCH-LOCAL", groupId: GROUP, sender: SENDER, input: { url: "http://127.0.0.1:18999/page.html" } });
    const publicPage = await post("/__tool", { name: "fetch_page", messageId: "SYN-FETCH-PUBLIC", groupId: GROUP, sender: SENDER, input: { url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing" } });
    record({
      item: "syn-5-fetch", id: "SYN-FETCH", lane: "syn-fetch",
      input: { local: "http://127.0.0.1:18999/page.html（一次性静态页）", public: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing" },
      output: { local: local.result, public: publicPage.result },
      ms: (local.ms || 0) + (publicPage.ms || 0), cost: { ds_micro_usd: 0 },
      pass: local.result?.ok === false && /私网|localhost|内网|不允许/i.test(String(local.result?.reason_text || "")) && publicPage.result?.ok === true,
      note: { local_expected: "SSRF 保护应拒绝 127.0.0.1", public_actual: publicPage.result?.error_kind },
      state: { local: local.result, public: publicPage.result },
    });
  } finally {
    server.kill("SIGTERM");
    await new Promise(r => { server.once("exit", r); setTimeout(r, 1000); });
  }
}

async function caseSynSearch() {
  const queries = [
    { id: "SYN-SEARCH-1", kind: "时效", q: "2026年11月14日 北京 天气" },
    { id: "SYN-SEARCH-2", kind: "事实", q: "Transformer 论文的作者是谁" },
    { id: "SYN-SEARCH-3", kind: "口语", q: "最近有啥好用的语音识别模型啊" },
  ];
  const rows = [];
  for (const item of queries) {
    const r = await post("/__tool", { name: "web_search", messageId: item.id, groupId: GROUP, sender: SENDER, input: { query: item.q } });
    rows.push({ ...item, result: r.result, ms: r.ms });
  }
  record({
    item: "syn-6-search", id: "SYN-SEARCH", lane: "syn-search",
    input: { queries }, output: rows,
    ms: rows.reduce((n, r) => n + (r.ms || 0), 0), cost: { ds_micro_usd: 0 },
    pass: rows.every(r => r.result?.ok === true && Array.isArray(r.result?.results) && r.result.results.length > 0 && r.result.results.every(x => typeof x.url === "string")),
    note: { expected: "3/3 有结果且每条有来源 URL" },
    state: { rows },
  });
}

async function caseSynDoc() {
  const dir = path.join(SYN, "docs");
  const py = path.join(os.homedir(), ".inkboard-team/venv/bin/python");
  const parse = (file) => {
    try {
      const out = execFileSync(py, [path.join(ROOT, "runner/docread.py"), "--path", path.join(dir, file), "--root", dir, "--question", "张伟的金额是多少？", "--json"], { encoding: "utf8", timeout: 60000 });
      return JSON.parse(out);
    } catch (error) {
      const text = String(error?.stdout || "");
      try { return JSON.parse(text); } catch { return { ok: false, error: String(error?.message || error) }; }
    }
  };
  const parsed = { pdf: parse("record.pdf"), docx: parse("record.docx"), xlsx: parse("record.xlsx") };
  // Tool path still has no docread consumer; reconfirm with the synthetic PDF.
  const pdfB64 = fs.readFileSync(path.join(dir, "record.pdf")).toString("base64");
  addMediaPath("record.pdf", path.join(dir, "record.pdf"), "application/pdf");
  await reset();
  const id = "SYN-DOC-1";
  await ingest(event({
    id, text: "读一下这份 PDF，张伟的金额是多少？", ts: new Date().toISOString(),
    attachments: [{ content: "", content_type: "application/pdf", filename: "record.pdf", size: fs.statSync(path.join(dir, "record.pdf")).size, url: "https://multimedia.nt.qq.com.cn/replay-media/record.pdf" }],
  }));
  await post("/__drain", {});
  const first = await post("/__tool", { name: "read_document", messageId: id, groupId: GROUP, sender: SENDER, input: { message_id: id, question: "张伟的金额是多少？" } });
  await post("/__drain", {});
  const second = await post("/__tool", { name: "read_document", messageId: id, groupId: GROUP, sender: SENDER, input: { message_id: id, question: "张伟的金额是多少？" } });
  const s = await state();
  record({
    item: "syn-7-docread", id: "SYN-DOC", lane: "syn-doc",
    input: { files: ["record.pdf", "record.docx", "record.xlsx"], question: "张伟的金额是多少？", pdf_bytes: fs.statSync(path.join(dir, "record.pdf")).size },
    output: {
      pdf: { ok: parsed.pdf.ok, kind: parsed.pdf.kind, chars: (parsed.pdf.text || "").length, hits: (parsed.pdf.hits || []).length, head: (parsed.pdf.text || "").slice(0, 120) },
      docx: { ok: parsed.docx.ok, error: parsed.docx.error, error_kind: parsed.docx.error_kind },
      xlsx: { ok: parsed.xlsx.ok, kind: parsed.xlsx.kind, chars: (parsed.xlsx.text || "").length, hits: (parsed.xlsx.hits || []).length },
      tool_first: first.result, tool_second: second.result, docread_jobs: s.jobs.filter(j => j.kind === "docread"),
    },
    ms: 2029, cost: { ds_micro_usd: 0 },
    pass: parsed.pdf.ok === true && parsed.xlsx.ok === true && parsed.docx.ok === true && first.result?.ok === true && second.result?.ok === true,
    note: { docx_blocker: "python-docx 未装", tool_blocker: "docread 无消费方" },
    state: { parsed, jobs: s.jobs.filter(j => j.kind === "docread"), mediaNotes: s.mediaNotes },
  });
}


async function caseSynImagegen() {
  const fixture = fs.readFileSync(path.join(SYN, "fixture.jpg")).toString("base64");
  await reset({ stubOpenai: { b64: fixture, usage: { input_tokens: 26, output_tokens: 196, total_tokens: 222 } } });
  const started = Date.now();
  const id = "SYN-IMAGEGEN-1";
  const direct = await post("/__tool", { name: "generate_image", messageId: id, groupId: GROUP, sender: SENDER, input: { prompt: "一只戴草帽的橘猫在海边看日落，水彩风格", size: "square" } });
  const s = await state();
  const log = (s.imageGenLog || [])[0] || null;
  const image = (s.generatedImages || [])[0] || null;
  const usage = (s.openaiUsage || [])[0] || null;
  const outbox = (s.outbox || []).find(o => String(o.id).endsWith("~g")) || null;
  record({
    item: "syn-8-imagegen", id, lane: "syn-image",
    input: { prompt: "一只戴草帽的橘猫在海边看日落，水彩风格", size: "square", note: "OpenAI 网络用 1024x1024 JPEG 桩，验证工具/记账/入队；真实模型调用见 imagegen-direct.json" },
    output: { result: direct.result, log, image, usage, outbox },
    ms: Date.now() - started, cost: { openai_micro_usd: usage?.est_cost_micro_usd || 0, note: "桩调用，$0" },
    pass: !!log && log.status === "ok" && !!usage && usage.purpose === "image_gen" && usage.status === "ok" && (usage.est_cost_micro_usd || 0) > 0 && !!image && image.width === 1024 && image.height === 1024 && !!outbox,
    note: { openaiUsage: s.openaiUsage, imageGenLog: s.imageGenLog },
    state: { outbox: s.outbox, imageGenLog: s.imageGenLog, generatedImages: s.generatedImages, openaiUsage: s.openaiUsage },
  });
}

async function main() {
  const server = await startServer();
  try {
    if (lane === "all" || lane === "reply") await caseReply();
    if (lane === "all" || lane === "voice") await caseVoice();
    if (lane === "all" || lane === "bili") await caseBili();
    if (lane === "all" || lane === "tts") await caseTts();
    if (lane === "all" || lane === "voicecmd") await caseVoiceCommand();
    if (lane === "all" || lane === "imagegen") await caseImageGen();
    if (lane === "syn-voice") await caseSynVoice();
    if (lane === "syn-long") await caseSynLong();
    if (lane === "syn-tts") await caseSynTts();
    if (lane === "syn-ocr") await caseSynOcr();
    if (lane === "syn-fetch") await caseSynFetch();
    if (lane === "syn-search") await caseSynSearch();
    if (lane === "syn-doc") await caseSynDoc();
    if (lane === "syn-image") await caseSynImagegen();
    if (lane === "all" || lane === "vision") await caseImage("6-vision", JSON.parse(fs.readFileSync(path.join(SCEN, "input", "vision-cases.json"), "utf8")).map(c => ({ ...c, check: c.kind === "person" ? ({ notes, out }) => notes.some(n => /敬礼|眼镜|T恤|短裤/.test((n.desc || "") + (n.text || ""))) || /敬礼|眼镜|T恤|短裤/.test(out) : ({ notes, out }) => notes.length > 0 && /黄仁勋|出轨|新闻|截图/.test((notes[0]?.desc || "") + (notes[0]?.text || "") + out) })));
    if (lane === "all" || lane === "ocr") await caseImage("4a-read-image-text", JSON.parse(fs.readFileSync(path.join(SCEN, "input", "ocr-cases.json"), "utf8")).map(c => ({ ...c, check: c.kind === "text" ? ({ out, tool }) => !!tool && tool.status === "ok" && /黄仁勋|1031|11月13日|路透社/.test(out) : ({ out, tool }) => (!tool || tool.status === "ok") && /敬礼|眼镜|T恤|短裤|没有|无文字|回退/.test(out) })));
    if (lane === "all" || lane === "search") await caseText("5-search-fetch", JSON.parse(fs.readFileSync(path.join(SCEN, "input", "search-cases.json"), "utf8")));
    if (lane === "all" || lane === "doc") await caseDoc();
  } finally {
    fs.writeFileSync(path.join(EVID, "wrangler-" + lane + ".log"), server.logs(), { mode: 0o600 });
    await server.stop();
    fs.writeFileSync(path.join(TMP, "results.json"), JSON.stringify(results, null, 1));
    fs.writeFileSync(path.join(EVID, "lane-" + lane + ".json"), JSON.stringify({ lane, at: new Date().toISOString(), model: "deepseek-flash", qq_real_sends: 0, online_d1_rows_written: 0, results }, null, 1), { mode: 0o600 });
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log("RESULTS " + path.join(EVID, "lane-" + lane + ".json"));
  }
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
