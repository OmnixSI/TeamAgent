import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { worker, env, qq, msg, req } from "./support.mjs";

const outfile = `.wrangler/voice-asr-${process.pid}.mjs`;
await build({
  entryPoints: ["src/voice-asr.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile,
});
const voice = await import("../" + outfile);
const viewFile = `.wrangler/voice-view-${process.pid}.mjs`;
await build({
  entryPoints: ["src/view.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: viewFile,
});
const view = await import("../" + viewFile);

const voiceMsg = (id, attachments, content = "") => ({
  ...msg(id, content),
  attachments,
});
const metaOf = async (e, id) => {
  const row = await e.DB.prepare("SELECT json FROM message_meta WHERE id=?")
    .bind(id)
    .first();
  return row ? JSON.parse(row.json) : null;
};
async function setup() {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  return e;
}
const voiceJobs = async e =>
  (await e.DB.prepare("SELECT id,kind,payload,status FROM jobs WHERE kind LIKE 'voice%' ORDER BY id").all()).results;
const quotaRows = async e =>
  Number((await e.DB.prepare("SELECT COUNT(*) AS n FROM quota_reservations").first())?.n || 0);

async function viewOf(e, id) {
  const row = await e.DB.prepare(
    "SELECT m.rowid AS ordinal,m.*,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.id=?",
  )
    .bind(id)
    .first();
  return view.viewMessage(row, new Map(), new Map());
}

test("V1 planning prefers QQ text and routes only what the Worker can post", () => {
  assert.deepEqual(
    voice.planVoice({ kind: "voice", url: "https://x/a.silk", asr: "明天开会" }),
    { route: "qq", text: "明天开会" },
  );
  for (const bad of ["", "   ", "[语音]", "。。。", "嗯", "😂😂", "aaaaaaa"]) {
    assert.equal(voice.usableVoiceText(bad), null, JSON.stringify(bad));
    assert.notEqual(voice.planVoice({ kind: "voice", url: "https://x/a.ogg", asr: bad }).route, "qq");
  }
  assert.equal(voice.planVoice({ kind: "voice", url: "https://x/a.ogg", contentType: "audio/ogg" }).route, "cloud");
  assert.equal(voice.planVoice({ kind: "voice", url: "https://x/a.wav", contentType: "audio/wav", size: 1024 }).route, "cloud");
  assert.equal(voice.planVoice({ kind: "voice", url: "https://x/a.wav", contentType: "audio/wav", size: 9 * 1024 * 1024 }).route, "runner");
  for (const [contentType, filename] of [
    ["voice", undefined],
    ["audio/silk", undefined],
    ["audio/amr", undefined],
    ["audio/mpeg", undefined],
    ["audio/mp4", undefined],
    ["application/octet-stream", "a.m4a"],
  ])
    assert.equal(voice.planVoice({ kind: "voice", url: "https://x/a.bin", contentType, filename }).route, "runner", contentType);
  assert.equal(voice.planVoice({ kind: "voice", url: "http://x/a.ogg" }).reason, "bad_url");
  assert.equal(voice.planVoice({ kind: "voice" }).reason, "no_url");
  assert.equal(voice.planVoice({ kind: "voice", url: "https://x/a.ogg", size: 21 * 1024 * 1024 }).reason, "too_large");
});

test("V2 format detection uses content type, filename and URL suffix", () => {
  const cases = [
    [{ contentType: "voice" }, "silk"],
    [{ contentType: "audio/silk" }, "silk"],
    [{ filename: "a.SILK" }, "silk"],
    [{ contentType: "audio/ogg; codecs=opus" }, "ogg"],
    [{ url: "https://x/a.opus" }, "ogg"],
    [{ contentType: "audio/x-wav" }, "wav"],
    [{ contentType: "audio/amr-wb" }, "amr"],
    [{ url: "https://x/a.mp3" }, "mp3"],
    [{ contentType: "audio/mp4" }, "m4a"],
    [{ contentType: "application/octet-stream" }, "unknown"],
  ];
  for (const [media, expected] of cases)
    assert.equal(voice.voiceFormat(media), expected, JSON.stringify(media));
});

test("V3 transcript text carries the marker and the not-verbatim warning", () => {
  const note = voice.voiceNote("明天下午三点开会。");
  assert.match(note, /^\[语音转写\] 明天下午三点开会。/);
  assert.match(note, /自动转写，可能有误/);
  assert.match(voice.voiceNote("很长", { truncated: true }), /只转写了前 110 秒/);
  assert.match(voice.voiceFailureNote({ error_kind: "expired", reason_text: "语音链接已过期", next_action: "请重新发一次语音" }), /转写失败：语音链接已过期/);
});

test("V4 text messages add no voice statement; QQ ASR costs no statement either", async () => {
  const text = await setup();
  await qq(text, msg("plain", "你好"));
  const textCount = text.DB.executed;

  const asr = await setup();
  await qq(asr, voiceMsg("qq-asr", [{ content_type: "audio/ogg", asr_refer_text: "明天开会" }]));
  assert.equal(asr.DB.executed, textCount, "voice with usable QQ ASR must match a text message");
  assert.equal((await voiceJobs(asr)).length, 0);
  assert.equal(await quotaRows(asr), 0);

  const statements = [];
  const plain = await setup();
  const prepare = plain.DB.prepare.bind(plain.DB);
  plain.DB.prepare = sql => {
    statements.push(sql);
    return prepare(sql);
  };
  await qq(plain, msg("plain-2", "今天怎么样"));
  assert.deepEqual(statements.filter(sql => /voice|ds_usage|quota_reservations/i.test(sql)), []);
});

test("V5 a new voice WITHOUT QQ text enqueues exactly one job and reserves quota", async () => {
  const e = await setup();
  await qq(e, voiceMsg("v-silk", [{ content_type: "voice", url: "https://multimedia.nt.qq.com.cn/download?file=a.silk" }]));
  const jobs = await voiceJobs(e);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "voice-v-silk-0");
  assert.equal(jobs[0].kind, "voice_runner");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.message, "v-silk");
  assert.equal(payload.idx, 0);
  assert.equal(payload.url, "https://multimedia.nt.qq.com.cn/download?file=a.silk");
  assert.equal(await quotaRows(e), 2, "one user and one group reservation");

  const cloud = await setup();
  await qq(cloud, voiceMsg("v-ogg", [{ content_type: "audio/ogg", url: "https://multimedia.nt.qq.com.cn/download?file=a.ogg" }]));
  const cloudJobs = await voiceJobs(cloud);
  assert.equal(cloudJobs.length, 1);
  assert.equal(cloudJobs[0].kind, "voice_asr");

  const big = await setup();
  await qq(big, voiceMsg("v-wav", [{ content_type: "audio/wav", url: "https://multimedia.nt.qq.com.cn/download?file=a.wav", size: 9 * 1024 * 1024 }]));
  assert.equal((await voiceJobs(big))[0].kind, "voice_runner");
});

test("V6 replaying the same voice event does not add a job or consume quota twice", async () => {
  const e = await setup();
  const event = voiceMsg("v-replay", [{ content_type: "voice", url: "https://multimedia.nt.qq.com.cn/download?file=a.silk" }]);
  await qq(e, event);
  const first = await quotaRows(e);
  await qq(e, event);
  assert.equal((await voiceJobs(e)).length, 1);
  assert.equal(await quotaRows(e), first);
});

test("V7 dsGuard refusal is reported as a voice failure and creates no job", async () => {
  const e = await setup();
  await e.DB.prepare("INSERT INTO settings VALUES('ds:asr:user_daily','0')").run();
  await qq(e, voiceMsg("v-quota", [{ content_type: "voice", url: "https://multimedia.nt.qq.com.cn/download?file=a.silk" }]));
  assert.equal((await voiceJobs(e)).length, 0);
  const meta = await metaOf(e, "v-quota");
  assert.equal(meta.media[0].asrError.error_kind, "quota");
  const v = await viewOf(e, "v-quota");
  assert.match(v.text, /转写失败：.*次数用完了/);
  assert.match(v.material.media[0], /转写失败/);
});

test("V8 off:ds_asr is reported, not silently ignored", async () => {
  const e = await setup();
  await e.DB.prepare("INSERT INTO settings VALUES('off:ds_asr','1')").run();
  await qq(e, voiceMsg("v-off", [{ content_type: "audio/ogg", url: "https://multimedia.nt.qq.com.cn/download?file=a.ogg" }]));
  assert.equal((await voiceJobs(e)).length, 0);
  assert.equal((await metaOf(e, "v-off")).media[0].asrError.error_kind, "denied");
});

test("V9 Worker cloud path stores a cloud transcript and records usage", async () => {
  const e = await setup();
  await e.DB.prepare(
    "CREATE TABLE IF NOT EXISTS ds_usage(id TEXT PRIMARY KEY,purpose TEXT,group_id TEXT,sender_id TEXT,status TEXT,error_kind TEXT,latency_ms INTEGER,units INTEGER,est_cost_micro_usd INTEGER,created_at INTEGER)",
  ).run();
  await qq(e, voiceMsg("v-cloud", [{ content_type: "audio/ogg", filename: "voice.ogg", url: "https://multimedia.nt.qq.com.cn/download?file=a.ogg" }]));
  const job = (await voiceJobs(e))[0];
  assert.equal(job.kind, "voice_asr");

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith("https://multimedia.nt.qq.com.cn/"))
      return new Response(new Uint8Array([79, 103, 103, 83, 1, 2, 3, 4]), {
        headers: { "content-type": "audio/ogg" },
      });
    if (target === "https://api.deepseek.com/v1/tools/asr")
      return Response.json({ text: "云端转写成功", duration_ms: 2100 });
    throw Error("unexpected fetch " + target);
  };
  try {
    await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.filter(url => url.includes("api.deepseek.com")).length, 1);
  const meta = await metaOf(e, "v-cloud");
  assert.equal(meta.media[0].asr, "云端转写成功");
  assert.equal(meta.media[0].asrSource, "cloud");
  const v = await viewOf(e, "v-cloud");
  assert.match(v.text, /^\[语音转写\] 云端转写成功/);
  assert.match(v.text, /自动转写，可能有误/);
  assert.equal(v.material.media[0], "语音（已转写）");
  const usage = await e.DB.prepare("SELECT status,units,purpose FROM ds_usage").first();
  assert.equal(usage.status, "ok");
  assert.equal(usage.purpose, "asr");
  assert.equal(usage.units, 2100);
});

test("V10 cloud failure is reported in the message text with a next step", async () => {
  const e = await setup();
  await qq(e, voiceMsg("v-fail", [{ content_type: "audio/ogg", url: "https://multimedia.nt.qq.com.cn/download?file=a.ogg" }]));
  const job = (await voiceJobs(e))[0];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.startsWith("https://multimedia.nt.qq.com.cn/"))
      return new Response(new Uint8Array([79, 103, 103, 83]), { headers: { "content-type": "audio/ogg" } });
    return new Response("Request body exceeds 8388608 bytes", { status: 413 });
  };
  try {
    await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = original;
  }
  const meta = await metaOf(e, "v-fail");
  assert.equal(meta.media[0].asrError.error_kind, "too_large");
  const v = await viewOf(e, "v-fail");
  assert.match(v.text, /太大/);
});

test("V11 expired attachment URL is distinguished from a recognition failure", async () => {
  const e = await setup();
  await qq(e, voiceMsg("v-expired", [{ content_type: "audio/ogg", url: "https://multimedia.nt.qq.com.cn/download?file=old.ogg" }]));
  const job = (await voiceJobs(e))[0];
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("expired", { status: 403 });
  try {
    await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal((await metaOf(e, "v-expired")).media[0].asrError.error_kind, "expired");
});

test("V12 runner claim + report stores a transcript with a lease, and rejects a stale lease", async () => {
  const e = await setup();
  await qq(e, voiceMsg("v-runner", [{ content_type: "voice", url: "https://multimedia.nt.qq.com.cn/download?file=a.silk" }]));
  const claimed = await req(e, "/api/runner/voice/claim", {}, "runner-secret");
  assert.equal(claimed.status, 200);
  const { job } = await claimed.json();
  assert.equal(job.id, "voice-v-runner-0");
  assert.equal(job.payload.message, "v-runner");
  assert.ok(job.payload.lease);

  const stale = await req(e, "/api/runner/voice/report", {
    id: job.id,
    lease: "not-the-lease",
    success: true,
    text: "不该写入",
  }, "runner-secret");
  assert.equal(stale.status, 409);

  const report = await req(e, "/api/runner/voice/report", {
    id: job.id,
    lease: job.payload.lease,
    success: true,
    text: "本机 silk 转写结果",
    duration_ms: 2880,
    units: 2880,
  }, "runner-secret");
  assert.equal(report.status, 200);
  const meta = await metaOf(e, "v-runner");
  assert.equal(meta.media[0].asr, "本机 silk 转写结果");
  assert.equal(meta.media[0].asrSource, "runner");
  const row = await e.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(job.id).first();
  assert.equal(row.status, "done");
});

test("V13 runner failure report carries error_kind and a next step", async () => {
  const e = await setup();
  await qq(e, voiceMsg("v-runner-fail", [{ content_type: "voice", url: "https://multimedia.nt.qq.com.cn/download?file=a.silk" }]));
  const { job } = await (await req(e, "/api/runner/voice/claim", {}, "runner-secret")).json();
  const report = await req(e, "/api/runner/voice/report", {
    id: job.id,
    lease: job.payload.lease,
    success: false,
    error_kind: "expired",
  }, "runner-secret");
  assert.equal(report.status, 200);
  const meta = await metaOf(e, "v-runner-fail");
  assert.equal(meta.media[0].asrError.error_kind, "expired");
  const v = await viewOf(e, "v-runner-fail");
  assert.match(v.text, /语音链接已过期/);
});
