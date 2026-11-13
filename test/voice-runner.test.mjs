import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectVoiceFormat,
  runVoiceJob,
  runVoiceCycle,
  wavDurationMs,
} from "../runner/voice.mjs";

function makeWav(ms, rate = 16000) {
  const samples = Math.max(1, Math.round((rate * ms) / 1000));
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

function temporary() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f9ds-voice-"));
  return {
    home,
    clean() {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const job = (id = "voice-m1-0", payload = {}) => ({
  id,
  kind: "voice_runner",
  payload: {
    message: "m1",
    group: "G1",
    sender: "U1",
    idx: 0,
    url: "https://multimedia.nt.qq.com.cn/download?file=a.silk",
    contentType: "voice",
    ...payload,
  },
});

const okFetch = (bytes, headers = {}) => async () => new Response(bytes, { status: 200, headers });

test("R1 detectVoiceFormat reads magic bytes before trusting the MIME label", () => {
  assert.equal(detectVoiceFormat(Buffer.from("\x02#!SILK_V3xxxx"), "audio/ogg", "a.ogg"), "silk");
  assert.equal(detectVoiceFormat(Buffer.from("#!SILK_V3"), "voice"), "silk");
  assert.equal(detectVoiceFormat(Buffer.from("RIFFxxxxWAVEfmt "), "application/octet-stream"), "wav");
  assert.equal(detectVoiceFormat(Buffer.from("OggS...."), "application/octet-stream"), "ogg");
  assert.equal(detectVoiceFormat(Buffer.from("#!AMR\n...."), "application/octet-stream"), "amr");
  assert.equal(detectVoiceFormat(Buffer.from("\xff\xfb...."), "audio/mpeg"), "mp3");
  assert.equal(detectVoiceFormat(Buffer.from("xxxx"), "application/octet-stream", "a.m4a"), "m4a");
});

test("R2 silk is decoded, normalised to 16 kHz and truncated with an explicit flag", async () => {
  const t = temporary();
  const calls = [];
  try {
    const result = await runVoiceJob(job(), {
      home: t.home,
      fetch: okFetch(Buffer.from("\x02#!SILK_V3" + "x".repeat(64))),
      decodeSilk: async () => ({ ok: true, wav: makeWav(130000, 24000), duration_ms: 130000 }),
      normalize: async (src, dst) => {
        assert.ok(fs.existsSync(src));
        fs.writeFileSync(dst, makeWav(110000));
        return { code: 0 };
      },
      probeDuration: async () => 130000,
      callDs: async (purpose, options) => {
        calls.push({ purpose, options });
        return { ok: true, data: { text: "这段语音说的是明天的安排。", duration_ms: 110000 } };
      },
    });
    assert.equal(result.report.success, true);
    assert.equal(result.report.text, "这段语音说的是明天的安排。");
    assert.equal(result.report.truncated, true);
    assert.equal(result.report.duration_ms, 110000);
    assert.equal(calls[0].purpose, "asr");
    assert.ok(calls[0].options.form.get("file"), "ASR form carries the WAV file");
    assert.equal(result.cleanup.residue, 0);
    assert.deepEqual(fs.readdirSync(t.home), []);
  } finally {
    t.clean();
  }
});

test("R3 AMR and plain WAV go through ffmpeg normalisation, not silk decode", async () => {
  const t = temporary();
  let decoded = 0;
  try {
    const result = await runVoiceJob(
      job("voice-m2-0", {
        url: "https://multimedia.nt.qq.com.cn/download?file=a.amr",
        contentType: "audio/amr",
      }),
      {
        home: t.home,
        fetch: okFetch(Buffer.from("#!AMR\n" + "x".repeat(32)), { "content-type": "audio/amr" }),
        decodeSilk: async () => {
          decoded++;
          throw Error("must not decode silk");
        },
        normalize: async (_src, dst) => {
          fs.writeFileSync(dst, makeWav(60000));
          return { code: 0 };
        },
        probeDuration: async () => 60000,
        callDs: async () => ({ ok: true, data: { text: "一分钟的语音。", duration_ms: 60000 } }),
      },
    );
    assert.equal(result.report.success, true);
    assert.equal(result.report.truncated, false);
    assert.equal(decoded, 0);
  } finally {
    t.clean();
  }
});

test("R4 an expired attachment reports expired and leaves no temporary files", async () => {
  const t = temporary();
  try {
    const result = await runVoiceJob(job(), {
      home: t.home,
      fetch: async () => new Response("gone", { status: 410 }),
      callDs: async () => {
        throw Error("must not call ASR");
      },
    });
    assert.equal(result.report.success, false);
    assert.equal(result.report.error_kind, "expired");
    assert.equal(result.cleanup.residue, 0);
    assert.deepEqual(fs.readdirSync(t.home), []);
  } finally {
    t.clean();
  }
});

test("R5 oversized downloads are refused from content-length without buffering", async () => {
  const t = temporary();
  try {
    const result = await runVoiceJob(job(), {
      home: t.home,
      fetch: async () => new Response("x", { status: 200, headers: { "content-length": String(21 * 1024 * 1024) } }),
      callDs: async () => {
        throw Error("must not call ASR");
      },
    });
    assert.equal(result.report.success, false);
    assert.equal(result.report.error_kind, "too_large");
    assert.equal(result.cleanup.residue, 0);
  } finally {
    t.clean();
  }
});

test("R6 ASR failures keep the error kind and the plain reason", async () => {
  const t = temporary();
  try {
    const result = await runVoiceJob(
      job("voice-m3-0", {
        url: "https://multimedia.nt.qq.com.cn/download?file=a.wav",
        contentType: "audio/wav",
      }),
      {
        home: t.home,
        fetch: okFetch(makeWav(2000), { "content-type": "audio/wav" }),
        normalize: async (_src, dst) => {
          fs.writeFileSync(dst, makeWav(2000));
          return { code: 0 };
        },
        probeDuration: async () => 2000,
        callDs: async () => ({
          ok: false,
          error_kind: "quota",
          retryable: false,
          reason_text: "DeepSeek 请求太频繁或额度不足",
          next_action: "稍后重试",
        }),
      },
    );
    assert.equal(result.report.success, false);
    assert.equal(result.report.error_kind, "quota");
    assert.match(result.report.reason_text, /额度不足/);
  } finally {
    t.clean();
  }
});

test("R7 runVoiceCycle claims one job, reports the transcript, then stops on an empty queue", async () => {
  const t = temporary();
  const reports = [];
  let claims = 0;
  try {
    const cloud = async (pathName, body) => {
      if (pathName === "claim") {
        claims++;
        return {
          status: 200,
          data: {
            job: claims === 1 ? { ...job(), payload: { ...job().payload, lease: "lease-1" } } : null,
          },
        };
      }
      if (pathName === "report") {
        reports.push(body);
        return { status: 200, data: { ok: true } };
      }
      if (pathName === "heartbeat") return { status: 200, data: { ok: true } };
      throw Error("unexpected cloud call " + pathName);
    };
    const result = await runVoiceCycle({
      cloud,
      deps: {
        home: t.home,
        fetch: okFetch(makeWav(2000), { "content-type": "audio/wav" }),
        normalize: async (_src, dst) => {
          fs.writeFileSync(dst, makeWav(2000));
          return { code: 0 };
        },
        probeDuration: async () => 2000,
        callDs: async () => ({ ok: true, data: { text: "本机回报的转写。", duration_ms: 2000 } }),
      },
    });
    assert.equal(result.reports.length, 1);
    assert.equal(reports[0].success, true);
    assert.equal(reports[0].text, "本机回报的转写。");
    assert.equal(reports[0].lease, "lease-1");
  } finally {
    t.clean();
  }
});

test("R8 wavDurationMs reads canonical 16 kHz mono headers", () => {
  assert.equal(wavDurationMs(makeWav(2880)), 2880);
  assert.equal(wavDurationMs(new Uint8Array([1, 2, 3])), 0);
});
