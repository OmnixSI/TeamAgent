import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { uploadVoice, sendQQVoice, MAX_VOICE_BYTES } from "../runner/qq-voice.mjs";
import { voiceReply } from "../runner/tts.mjs";

const SILK = Buffer.concat([Buffer.from([0x02]), Buffer.from("#!SILK_V3"), Buffer.alloc(24, 9)]);
const TOKEN = "test-token-abc";

async function mockQQ(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      const reply = await handler(entry, requests.length);
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-voice-"));
  return { dir, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test("sendQQVoice uploads file_type=3 silk then sends msg_type=7 with the returned file_info", async () => {
  const server = await mockQQ((request, count) =>
    count === 1
      ? { body: { file_info: "fi-1", ttl: 3600, code: 0 } }
      : { body: { id: "msg-1", code: 0 } },
  );
  try {
    const result = await sendQQVoice({
      group: "G1",
      silk: SILK,
      token: TOKEN,
      msgId: "m-9",
      msgSeq: 42,
      baseUrl: server.url,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.file_info, "fi-1");
    assert.equal(result.message_id, "msg-1");
    assert.equal(server.requests.length, 2);
    const [upload, send] = server.requests;
    assert.equal(upload.method, "POST");
    assert.equal(upload.url, "/v2/groups/G1/files");
    assert.equal(upload.headers.authorization, `QQBot ${TOKEN}`);
    assert.equal(upload.body.file_type, 3);
    assert.equal(upload.body.srv_send_msg, false);
    assert.deepEqual(Buffer.from(upload.body.file_data, "base64"), SILK);
    assert.equal(send.url, "/v2/groups/G1/messages");
    assert.equal(send.headers.authorization, `QQBot ${TOKEN}`);
    assert.equal(send.body.msg_type, 7);
    assert.deepEqual(send.body.media, { file_info: "fi-1" });
    assert.equal(send.body.msg_id, "m-9");
    assert.equal(send.body.msg_seq, 42);
  } finally {
    await server.close();
  }
});

test("upload failures stop before the message call and carry a typed error", async () => {
  for (const [status, kind, retryable] of [
    [500, "upstream", true],
    [401, "auth", false],
    [413, "too_large", false],
    [302, "upstream", false],
  ]) {
    const server = await mockQQ(() => ({ status, body: { code: 1, message: "no" } }));
    try {
      const result = await sendQQVoice({ group: "G1", silk: SILK, token: TOKEN, baseUrl: server.url });
      assert.equal(result.ok, false, String(status));
      assert.equal(result.error_kind, kind, String(status));
      assert.equal(result.retryable, retryable, String(status));
      assert.equal(result.stage, "upload", String(status));
      assert.equal(server.requests.length, 1, `${status} must not send a message`);
    } finally {
      await server.close();
    }
  }
});

test("message-send failures are typed and include the QQ code", async () => {
  const server = await mockQQ((request, count) =>
    count === 1
      ? { body: { file_info: "fi-2", ttl: 3600, code: 0 } }
      : { status: 400, body: { code: 304082, message: "media info fail" } },
  );
  try {
    const result = await sendQQVoice({ group: "G1", silk: SILK, token: TOKEN, baseUrl: server.url });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "send");
    assert.equal(result.error_kind, "upstream");
    assert.equal(result.code, 304082);
    assert.match(result.reason_text, /304082/);
  } finally {
    await server.close();
  }
});

test("voice replies larger than QQ's 20 MB upload limit are refused without a request", async () => {
  const big = Buffer.alloc(MAX_VOICE_BYTES + 1);
  let called = false;
  const result = await sendQQVoice({
    group: "G1",
    silk: big,
    token: TOKEN,
    fetch: async () => {
      called = true;
      throw new Error("must not fetch");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "too_large");
  assert.equal(called, false);
});

test("a hung QQ endpoint becomes a timeout, not a stuck gateway", async () => {
  const server = await mockQQ(
    () => new Promise((resolve) => setTimeout(() => resolve({ body: { file_info: "late" } }), 300)),
  );
  try {
    const started = Date.now();
    const result = await uploadVoice({
      group: "G1",
      silk: SILK,
      token: TOKEN,
      baseUrl: server.url,
      timeoutMs: 60,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_kind, "timeout");
    assert.ok(Date.now() - started < 1000);
  } finally {
    await server.close();
  }
});

const fakeVoiceBot = () => {
  const calls = [];
  return {
    calls,
    api: { getToken: async () => TOKEN },
    async sendText(target, content) {
      calls.push({ kind: "text", target, content });
      return { id: "t1" };
    },
  };
};

const fakeWav = (dir) => {
  const file = path.join(dir, "reply.wav");
  fs.writeFileSync(file, "RIFF0000WAVEfmt ");
  return file;
};

const fakeSilkResult = {
  ok: true,
  data: SILK,
  duration_ms: 1000,
  sample_rate: 24000,
  bytes: SILK.length,
};

test("voiceReply produces SILK and sends it through the QQ voice uploader", async () => {
  const server = await mockQQ((request, count) =>
    count === 1
      ? { body: { file_info: "fi-voice", ttl: 3600, code: 0 } }
      : { body: { id: "msg-voice", code: 0 } },
  );
  const s = scratch();
  try {
    const bot = fakeVoiceBot();
    const result = await voiceReply({
      bot,
      group: "G1",
      text: "这是语音回复。",
      cfg: { enabled: true, provider: "edge" },
      deps: {
        synthesize: async () => ({ path: fakeWav(s.dir), key: "k", cached: false, provider: "edge" }),
        wavToSilk: async () => fakeSilkResult,
        sendVoice: (args) => sendQQVoice({ ...args, baseUrl: server.url }),
        msgId: "m-1",
        msgSeq: 7,
      },
    });
    assert.equal(result.via, "voice", JSON.stringify(result));
    assert.equal(result.silk_bytes, SILK.length);
    assert.deepEqual(bot.calls, [], "text must not be sent after a voice success");
    assert.equal(server.requests.length, 2);
    assert.deepEqual(Buffer.from(server.requests[0].body.file_data, "base64"), SILK);
    assert.equal(server.requests[1].body.msg_type, 7);
  } finally {
    await server.close();
    s.clean();
  }
});

test("voiceReply falls back to exactly one text message on SILK or upload failure", async () => {
  const s = scratch();
  try {
    const cases = [
      {
        label: "silk",
        deps: {
          synthesize: async () => ({ path: fakeWav(s.dir), key: "k" }),
          wavToSilk: async () => ({ ok: false, error_kind: "tool_not_ready", reason_text: "no silk-wasm" }),
        },
      },
      {
        label: "upload",
        deps: {
          synthesize: async () => ({ path: fakeWav(s.dir), key: "k" }),
          wavToSilk: async () => fakeSilkResult,
          sendVoice: async () => ({ ok: false, error_kind: "upstream", reason_text: "QQ 500" }),
        },
      },
    ];
    for (const item of cases) {
      const bot = fakeVoiceBot();
      const result = await voiceReply({
        bot,
        group: "G1",
        text: "失败就回文字。",
        cfg: { enabled: true, provider: "edge" },
        deps: item.deps,
      });
      assert.equal(result.via, "text", item.label);
      assert.equal(bot.calls.filter((c) => c.kind === "text").length, 1, item.label);
      assert.equal(bot.calls[0].content, "失败就回文字。", item.label);
    }
  } finally {
    s.clean();
  }
});

test("voiceReply obtains the QQ token from the bot instead of requiring a secret in config", async () => {
  const server = await mockQQ((request, count) =>
    count === 1 ? { body: { file_info: "fi-t" } } : { body: { id: "msg-t" } },
  );
  const s = scratch();
  try {
    const bot = fakeVoiceBot();
    const result = await voiceReply({
      bot,
      group: "G1",
      text: "用机器人自己的令牌。",
      cfg: { enabled: true, provider: "edge" },
      deps: {
        synthesize: async () => ({ path: fakeWav(s.dir), key: "k" }),
        wavToSilk: async () => fakeSilkResult,
        sendVoice: (args) => sendQQVoice({ ...args, baseUrl: server.url }),
      },
    });
    assert.equal(result.via, "voice");
    assert.equal(server.requests[0].headers.authorization, `QQBot ${TOKEN}`);
  } finally {
    await server.close();
    s.clean();
  }
});

test("a 20 MB+ silk produced locally also falls back to text", async () => {
  const s = scratch();
  try {
    const bot = fakeVoiceBot();
    const result = await voiceReply({
      bot,
      group: "G1",
      text: "太大的语音不发。",
      cfg: { enabled: true, provider: "edge" },
      deps: {
        synthesize: async () => ({ path: fakeWav(s.dir), key: "k" }),
        wavToSilk: async () => ({ ...fakeSilkResult, data: Buffer.alloc(MAX_VOICE_BYTES + 1) }),
        sendVoice: (args) => sendQQVoice(args),
      },
    });
    assert.equal(result.via, "text");
    assert.equal(bot.calls.length, 1);
  } finally {
    s.clean();
  }
});
