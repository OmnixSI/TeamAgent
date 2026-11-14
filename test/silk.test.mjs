import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  wavToSilk,
  decodeSilkToWav,
  isSilkData,
  SILK_MAGIC,
  SILK_SAMPLE_RATE,
} from "../runner/silk.mjs";

const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silk-test-"));
  return {
    dir,
    wav: path.join(dir, "in.wav"),
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

const canonicalWav = (() => {
  const pcm = Buffer.alloc(24000 * 2 * 0.2);
  for (let i = 0; i < pcm.length / 2; i += 1)
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(24000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
})();

const fakeSilk = ({ fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    encode: async (input, sampleRate) => {
      calls.push({ input, sampleRate });
      if (fail) throw new Error("encoder exploded");
      return {
        data: Buffer.concat([Buffer.from([0x02]), Buffer.from(SILK_MAGIC), Buffer.alloc(32, 7)]),
        duration: 200,
      };
    },
    decode: async () => ({ data: Buffer.alloc(2400, 1), duration: 50 }),
  };
};

const fakeFfmpeg = ({ fail = false, out = canonicalWav } = {}) => async (command, args) => {
  assert.equal(path.basename(command), "ffmpeg");
  assert.ok(path.isAbsolute(command));
  if (fail) return { code: 2, stderr: "boom" };
  fs.writeFileSync(args.at(-1), out);
  return { code: 0, stdout: "", stderr: "" };
};

test("wavToSilk reports tool_not_ready when silk-wasm is absent and leaves no temp files", async () => {
  const s = scratch();
  try {
    fs.writeFileSync(s.wav, canonicalWav);
    const result = await wavToSilk(
      s.wav,
      { tmpDir: s.dir },
      {
        loadSilk: async () => null,
        runCommand: async () => assert.fail("must not run ffmpeg without the encoder"),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error_kind, "tool_not_ready");
    assert.match(result.reason_text, /silk-wasm/);
    assert.deepEqual(fs.readdirSync(s.dir), ["in.wav"]);
  } finally {
    s.clean();
  }
});

test("wavToSilk normalizes to 24 kHz mono and encodes without leaving .work directories", async () => {
  const s = scratch();
  try {
    fs.writeFileSync(s.wav, canonicalWav);
    const silk = fakeSilk();
    const result = await wavToSilk(
      s.wav,
      { tmpDir: s.dir },
      { loadSilk: async () => silk, runCommand: fakeFfmpeg() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.sample_rate, SILK_SAMPLE_RATE);
    assert.equal(result.duration_ms, 200);
    assert.equal(result.bytes, result.data.length);
    assert.ok(isSilkData(result.data));
    assert.equal(silk.calls.length, 1);
    assert.equal(silk.calls[0].sampleRate, 24000);
    assert.ok(silk.calls[0].input instanceof Uint8Array);
    assert.deepEqual(Buffer.from(silk.calls[0].input), canonicalWav);
    assert.deepEqual(fs.readdirSync(s.dir), ["in.wav"]);
  } finally {
    s.clean();
  }
});

test("wavToSilk fails cleanly for missing/undecodable WAV and encoder errors", async () => {
  const s = scratch();
  try {
    const missing = await wavToSilk(path.join(s.dir, "gone.wav"), { tmpDir: s.dir }, { loadSilk: async () => fakeSilk() });
    assert.equal(missing.ok, false);
    assert.equal(missing.error_kind, "invalid_audio");

    fs.writeFileSync(s.wav, canonicalWav);
    const undecodable = await wavToSilk(
      s.wav,
      { tmpDir: s.dir },
      { loadSilk: async () => fakeSilk(), runCommand: fakeFfmpeg({ fail: true }) },
    );
    assert.equal(undecodable.ok, false);
    assert.equal(undecodable.error_kind, "invalid_audio");

    const broken = await wavToSilk(
      s.wav,
      { tmpDir: s.dir },
      { loadSilk: async () => fakeSilk({ fail: true }), runCommand: fakeFfmpeg() },
    );
    assert.equal(broken.ok, false);
    assert.equal(broken.error_kind, "encode_failed");
    assert.deepEqual(fs.readdirSync(s.dir), ["in.wav"]);
  } finally {
    s.clean();
  }
});

test("decodeSilkToWav rebuilds a canonical 24 kHz mono WAV from SILK", async () => {
  const silk = Buffer.concat([Buffer.from([0x02]), Buffer.from(SILK_MAGIC), Buffer.alloc(32, 3)]);
  const result = await decodeSilkToWav(
    silk,
    { sampleRate: 24000 },
    { loadSilk: async () => ({ decode: async () => ({ data: Buffer.alloc(4800, 0), duration: 100 }) }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.duration_ms, 100);
  assert.equal(Buffer.from(result.wav.subarray(0, 4)).toString(), "RIFF");
  assert.equal(Buffer.from(result.wav.subarray(8, 12)).toString(), "WAVE");
  const wav = Buffer.from(result.wav);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 4800);
  const silent = await decodeSilkToWav(silk, {}, { loadSilk: async () => null });
  assert.equal(silent.ok, false);
  assert.equal(silent.error_kind, "tool_not_ready");
});

// The runner dependency is installed by the lead; when it is present this runs for real.
let realSilk = null;
try {
  realSilk = await import("silk-wasm");
} catch {}

test(
  "real silk-wasm round trip: 200 ms WAV -> SILK -> 200 ms WAV",
  { skip: realSilk ? false : "silk-wasm not installed in this worktree" },
  async () => {
    const s = scratch();
    try {
      fs.writeFileSync(s.wav, canonicalWav);
      const encoded = await wavToSilk(s.wav, { tmpDir: s.dir }, {});
      assert.equal(encoded.ok, true, JSON.stringify(encoded));
      assert.ok(isSilkData(encoded.data));
      // SILK pads very short clips to whole 20 ms frames, so allow one frame
      // of encoder padding around the 200 ms source.
      assert.ok(encoded.duration_ms >= 200 && encoded.duration_ms <= 260, String(encoded.duration_ms));
      const decoded = await decodeSilkToWav(encoded.data, {}, {});
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.ok(
        Math.abs(decoded.duration_ms - encoded.duration_ms) <= 40,
        `${decoded.duration_ms} vs ${encoded.duration_ms}`,
      );
      assert.equal(Buffer.from(decoded.wav).readUInt32LE(24), 24000);
    } finally {
      s.clean();
    }
  },
);
