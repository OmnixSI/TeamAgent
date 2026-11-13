import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

async function bundle(name) {
  const outfile = `.wrangler/c2-${name}-${process.pid}.mjs`;
  await build({ entryPoints: [`src/${name}.ts`], bundle: true, format: "esm", platform: "browser", outfile });
  return import("../" + outfile);
}
const links = await bundle("bili-links");
const ib = await bundle("inbound");
const fixture = JSON.parse(readFileSync("test/fixtures/bili-card-encoded.json", "utf8"));

test("C2-D1 safeDecode resolves at most two layers and keeps the last good value", () => {
  assert.equal(links.safeDecode("a%20b"), "a b");
  assert.equal(links.safeDecode("a%2520b"), "a b");
  assert.equal(links.safeDecode("a%252520b"), "a%20b");
  assert.equal(links.safeDecode("100%25"), "100%");
  assert.equal(links.safeDecode("bad%2"), "bad%2");
  assert.equal(links.safeDecode("%E0%A4%A"), "%E0%A4%A");
});

test("C2-D2 parseBiliTarget reads BV, av, short links, page and player bvid without changing shape", () => {
  const bv = { kind: "bv", base: "BV1xx411c7mD", page: 3 };
  assert.deepEqual(links.parseBiliTarget("https://www.bilibili.com/video/BV1xx411c7mD?p=3"), bv);
  assert.deepEqual(links.parseBiliTarget("BV1xx411c7mD?p=3"), bv);
  assert.deepEqual(links.parseBiliTarget("//www.bilibili.com/video/BV1xx411c7mD?p=3#reply"), bv);
  assert.deepEqual(links.parseBiliTarget("https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&p=3"), bv);
  assert.deepEqual(links.parseBiliTarget("https://www.bilibili.com/video/AV170001?p=2"), { kind: "aid", base: "av170001", page: 2 });
  assert.deepEqual(links.parseBiliTarget("av170001"), { kind: "aid", base: "av170001", page: 1 });
  assert.deepEqual(links.parseBiliTarget("https://b23.tv/AbCd12"), { kind: "short", base: "AbCd12", page: 0 });
  assert.deepEqual(links.parseBiliTarget("b23.tv/AbCd12"), { kind: "short", base: "AbCd12", page: 0 });
  assert.deepEqual(links.parseBiliTarget("https://bili2233.cn/Ab-Cd_12"), { kind: "short", base: "Ab-Cd_12", page: 0 });
  assert.deepEqual(links.parseBiliTarget("https://www.bilibili.com/video/BV1xx411c7mD?p=0"), { kind: "bv", base: "BV1xx411c7mD", page: 1 });
  assert.deepEqual(links.parseBiliTarget("https://www.bilibili.com/video/BV1xx411c7mD?p=abc"), { kind: "bv", base: "BV1xx411c7mD", page: 1 });
});

test("C2-D3 parseBiliTarget decodes percent and double encoding, rejects foreign hosts and credentials", () => {
  const url = "https://www.bilibili.com/video/BV1xx411c7mD?p=3";
  assert.deepEqual(links.parseBiliTarget(encodeURIComponent(url)), { kind: "bv", base: "BV1xx411c7mD", page: 3 });
  assert.deepEqual(links.parseBiliTarget(encodeURIComponent(encodeURIComponent(url))), { kind: "bv", base: "BV1xx411c7mD", page: 3 });
  for (const value of [
    "https://evil.test/BV1xx411c7mD",
    "https://bilibili.com.evil.test/video/BV1xx411c7mD",
    "https://user:pass@www.bilibili.com/video/BV1xx411c7mD",
    "https://www.bilibili.com/video/",
    "javascript:alert(1)",
    "",
    "hello",
  ]) assert.equal(links.parseBiliTarget(value), null, value);
});

test("C2-D4 scanBiliPayload decodes qqdocurl/jumpUrl/pcJumpUrl and still skips preview and logo", () => {
  assert.match(fixture.provenance, /合成/);
  const scanned = links.scanBiliPayload(fixture.event);
  assert.equal(scanned.biliUrls.length, 3);
  assert.ok(scanned.biliUrls.includes("https://www.bilibili.com/video/BV1xx411c7mD?p=3"));
  assert.ok(scanned.biliUrls.includes("https://b23.tv/AbCd12"));
  assert.ok(scanned.biliUrls.includes("https://www.bilibili.com/video/av170001?p=2"));
  for (const skipped of fixture.expected.skipped) assert.ok(!scanned.biliUrls.some(url => url.includes(skipped)), skipped);
  const previewArray = links.scanBiliPayload({ ark_data: { fields: [
    { key: "preview", value: encodeURIComponent("https://www.bilibili.com/video/BV1xx411c7mD") },
    { key: "source_logo", value: JSON.stringify({ url: "https://b23.tv/AbCd12" }) },
  ] } });
  assert.deepEqual(previewArray.biliUrls, []);
});

test("C2-D5 extractBili keeps bvid/aid/short and adds page from ?p=", () => {
  const got = ib.extractBili([
    "https://www.bilibili.com/video/BV1xx411c7mD?p=3",
    "https://www.bilibili.com/video/AV170001?p=2",
    "https://b23.tv/AbCd12",
  ], "");
  assert.deepEqual(got[0], { url: "https://www.bilibili.com/video/BV1xx411c7mD?p=3", bvid: "BV1xx411c7mD", page: 3 });
  assert.deepEqual(got[1], { url: "https://www.bilibili.com/video/AV170001?p=2", aid: "av170001", page: 2 });
  assert.deepEqual(got[2], { url: "https://b23.tv/AbCd12", short: "AbCd12", page: 0 });
  assert.equal(ib.extractBili(["https://evil.test/BV1xx411c7mD"], "BV1xx411c7mD").length, 0);
  const parsed = ib.parseInbound("GROUP_MESSAGE_CREATE", { content: "分P https://www.bilibili.com/video/BV1xx411c7mD?p=3" });
  assert.equal(parsed.bili[0].page, 3);
});
