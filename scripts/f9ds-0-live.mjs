#!/usr/bin/env node
/**
 * F9DS DS-0 live evidence: one minimal real request per purpose.
 * The key is read from DEEPSEEK_API_KEY_FILE (never printed); all files live in
 * /tmp/f9ds-0-live and are removed after the run. Total spend must stay ≤ $0.01.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callDs } from "../runner/deepseek-client.mjs";

const OCR_PNG_B64 = "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";
const DIR = "/tmp/f9ds-0-live";

function wavSilence(seconds = 1) {
  const sampleRate = 16000;
  const bytes = sampleRate * 2 * seconds;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(bytes, 40);
  return buffer;
}

const sha = (data) => createHash("sha256").update(data).digest("hex").slice(0, 16);
const money = (micro) => "$" + (micro / 1_000_000).toFixed(4) + ` (${micro} µUSD)`;

function describe(name, result) {
  if (!result.ok) return {};
  if (name === "ASR") {
    return {
      text: String(result.data?.text ?? "").slice(0, 40),
      duration_ms: result.data?.duration_ms,
    };
  }
  if (name === "TTS") {
    const header = result.bytes
      ? Buffer.from(result.bytes.slice(0, 4)).toString("ascii")
      : "";
    return { audio_bytes: result.bytes?.length ?? 0, header };
  }
  if (name === "OCR") {
    return {
      page_count: result.data?.page_count,
      chars: (result.data?.pages || []).reduce(
        (n, page) =>
          n +
          (typeof page?.text === "string"
            ? page.text.length
            : Number(page?.chars) || 0),
        0,
      ),
    };
  }
  if (name === "SEARCH") return { results: result.data?.results?.length ?? 0 };
  return {
    title: String(result.data?.title ?? "").slice(0, 40),
    chars: String(result.data?.content ?? result.data?.text ?? "").length,
  };
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY_FILE) {
    console.error("DEEPSEEK_API_KEY_FILE is not set; refusing to run.");
    process.exit(2);
  }
  mkdirSync(DIR, { recursive: true });
  const wav = wavSilence(1);
  const png = Buffer.from(OCR_PNG_B64, "base64");
  writeFileSync(join(DIR, "silence.wav"), wav, { mode: 0o600 });
  writeFileSync(join(DIR, "ocr.png"), png, { mode: 0o600 });
  console.log(
    `fixtures silence.wav ${wav.length}B sha=${sha(wav)} · ocr.png ${png.length}B sha=${sha(png)}`,
  );

  const asrForm = new FormData();
  asrForm.append("file", new Blob([wav], { type: "audio/wav" }), "silence.wav");
  const ocrForm = new FormData();
  ocrForm.append("purpose", "text_recognition");
  ocrForm.append("file", new Blob([png], { type: "image/png" }), "ocr.png");

  const outcomes = [];
  outcomes.push([
    "ASR",
    await callDs("asr", { form: asrForm, timeoutMs: 60_000 }),
  ]);
  const tts = await callDs("tts", {
    json: { text: "你好", voice_id: "stella", format: "wav", filter_markdown: true },
    expect: "bytes",
    timeoutMs: 60_000,
  });
  if (tts.ok && tts.bytes)
    writeFileSync(join(DIR, "tts.wav"), tts.bytes, { mode: 0o600 });
  outcomes.push(["TTS", tts]);
  outcomes.push(["OCR", await callDs("ocr", { form: ocrForm, timeoutMs: 120_000 })]);
  outcomes.push([
    "SEARCH",
    await callDs("search", {
      json: { query: "ping", count: 1 },
      timeoutMs: 30_000,
    }),
  ]);
  outcomes.push([
    "FETCH",
    await callDs("fetch", {
      json: { url: "https://api-docs.deepseek.com" },
      timeoutMs: 30_000,
    }),
  ]);

  let total = 0;
  let ok = 0;
  for (const [name, result] of outcomes) {
    const micro = result.ok ? Number(result.est_cost_micro_usd || 0) : 0;
    total += micro;
    if (result.ok) ok++;
    if (!result.ok) {
      console.log(
        `${name.padEnd(6)} FAIL kind=${result.error_kind} status=${result.status ?? "-"} ${result.reason_text}`,
      );
      continue;
    }
    console.log(
      `${name.padEnd(6)} ok ${String(result.latency_ms).padStart(5)}ms bytes=${result.body_bytes ?? 0} ${JSON.stringify(describe(name, result))} ${money(micro)}`,
    );
  }
  console.log(`TOTAL estimated ${money(total)} · ${ok}/${outcomes.length} ok`);
  if (ok !== outcomes.length) process.exitCode = 1;
  if (total > 10_000) {
    console.error("spend above $0.01 — refusing to continue");
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  rmSync(DIR, { recursive: true, force: true });
}
