import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CARD_SAMPLE_LIMIT,
  cardSampleUntil,
  isBiliCardEvent,
  sampleCardEvent,
  sanitizeCardEvent,
  sweepCardSamples,
} from "./card-samples.mjs";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "teamagent-test-card-samples-"));
const cardEvent = {
  content: "",
  author: { member_openid: "openid-secret", union_openid: "union-secret", username: "昵称甲", nickname: "昵称乙", uin: "99887766" },
  ark_data: {
    ark_type: "miniapp",
    ark_name: "哔哩哔哩",
    fields: { title: "合成卡片", qqdocurl: "https://www.bilibili.com/video/BV1xx411c7mD", preview: "https://i0.hdslb.com/x.jpg" },
  },
  msg_elements: [{ content: JSON.stringify({ author: { uin: "11223344", nickname: "嵌套昵称" }, ark_data: { fields: { title: "嵌套" } } }) }],
};

test("CS-1 sampling is off by default and writes nothing", () => {
  const root = temporary();
  try {
    const dir = path.join(root, "samples");
    assert.deepEqual(sampleCardEvent(cardEvent, { config: {}, dir, now: NOW }), { sampled: false, reason: "off" });
    assert.equal(fs.existsSync(dir), false);
    assert.equal(cardSampleUntil({}, NOW), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CS-2 an active window stores one desensitized card with 0600 and keeps page data", () => {
  const root = temporary();
  try {
    const dir = path.join(root, "samples");
    const result = sampleCardEvent(cardEvent, { config: { card_sample_until: NOW + 7 * DAY }, dir, now: NOW });
    assert.equal(result.sampled, true);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    const file = path.join(dir, files[0]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const text = fs.readFileSync(file, "utf8");
    const saved = JSON.parse(text);
    assert.ok(saved.ark_data);
    for (const secret of ["99887766", "11223344", "昵称甲", "昵称乙", "嵌套昵称", "openid-secret", "union-secret"]) assert.ok(!text.includes(secret), secret);
    assert.equal(saved.author, undefined);
    assert.equal(isBiliCardEvent(saved), true);
    assert.match(result.file, /\/card-.+\.json$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CS-3 unrelated miniapps and plain messages are not sampled", () => {
  const root = temporary();
  try {
    const dir = path.join(root, "samples");
    const config = { card_sample_until: NOW + DAY };
    assert.deepEqual(sampleCardEvent({ ark_data: { fields: { title: "腾讯视频", source: "腾讯视频", jump_url: "https://v.qq.com/x" } } }, { config, dir, now: NOW }), { sampled: false, reason: "not_bili" });
    assert.deepEqual(sampleCardEvent({ content: "https://www.bilibili.com/video/BV1xx411c7mD" }, { config, dir, now: NOW }), { sampled: false, reason: "not_card" });
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CS-4 at most ten samples are kept and the eleventh is refused", () => {
  const root = temporary();
  try {
    const dir = path.join(root, "samples");
    fs.mkdirSync(dir, { mode: 0o700 });
    for (let i = 0; i < CARD_SAMPLE_LIMIT; i++) fs.writeFileSync(path.join(dir, `card-${i}.json`), "{}");
    const result = sampleCardEvent(cardEvent, { config: { card_sample_until: NOW + DAY }, dir, now: NOW });
    assert.deepEqual(result, { sampled: false, reason: "full" });
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith(".json")).length, CARD_SAMPLE_LIMIT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CS-5 an expired window deletes the sample directory, at start and on the next message", () => {
  const root = temporary();
  try {
    const dir = path.join(root, "samples");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "card-old.json"), "{}");
    assert.equal(sweepCardSamples({ card_sample_until: NOW - 1 }, { dir, now: NOW }), true);
    assert.equal(fs.existsSync(dir), false);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "card-old.json"), "{}");
    assert.deepEqual(sampleCardEvent(cardEvent, { config: { card_sample_until: NOW - 1 }, dir, now: NOW }), { sampled: false, reason: "expired" });
    assert.equal(fs.existsSync(dir), false);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "card-keep.json"), "{}");
    assert.equal(sweepCardSamples({ card_sample_until: NOW + DAY }, { dir, now: NOW }), false);
    assert.equal(fs.existsSync(path.join(dir, "card-keep.json")), true);
    assert.equal(sweepCardSamples({}, { dir, now: NOW }), false);
    assert.equal(fs.existsSync(path.join(dir, "card-keep.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CS-6 timestamps accept epoch milliseconds, epoch seconds and ISO, and malformed values stay off", () => {
  assert.equal(cardSampleUntil({ card_sample_until: NOW + 1000 }, NOW), NOW + 1000);
  assert.equal(cardSampleUntil({ card_sample_until: Math.floor((NOW + 60_000) / 1000) }, NOW), Math.floor((NOW + 60_000) / 1000) * 1000);
  assert.equal(cardSampleUntil({ card_sample_until: new Date(NOW + 5000).toISOString() }, NOW), NOW + 5000);
  assert.equal(cardSampleUntil({ card_sample_until: "not-a-date" }, NOW), null);
  assert.equal(cardSampleUntil({ card_sample_until: NOW - 1 }, NOW), null);
  assert.deepEqual(sanitizeCardEvent({ a: { UIN: "1", Nickname: "n", keep: 2 }, b: [null, "x"] }), { a: { keep: 2 }, b: [null, "x"] });
});
