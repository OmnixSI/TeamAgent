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
  fs.writeFileSync(path.join(TMP, ".dev.vars"), "DEEPSEEK_API_KEY=" + KEY + "\n", { mode: 0o600 });
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

async function main() {
  const server = await startServer();
  try {
    if (lane === "all" || lane === "reply") await caseReply();
    if (lane === "all" || lane === "voice") await caseVoice();
    if (lane === "all" || lane === "bili") await caseBili();
    if (lane === "all" || lane === "tts") await caseTts();
    if (lane === "all" || lane === "voicecmd") await caseVoiceCommand();
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
