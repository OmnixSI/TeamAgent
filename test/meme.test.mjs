// Offline tests for the meme feature: catalogue search, argument checks, command builder, mime choice, and the tool with a fake host.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const M = await import("../src/feat/meme.ts");
const { default: feature, CATALOG, findMemes, pickMeme, checkArgs, coerceOptions, buildCommand, outPattern, mimeOf, parseResult, explainError, GEN_PY } = M;
const keys = q => findMemes(q).map(x => x.meme.key);

describe("catalogue", () => {
  test("has the whole set with sane counts", () => {
    assert.ok(CATALOG.length >= 290);
    assert.equal(new Set(CATALOG.map(m => m.key)).size, CATALOG.length);
    for (const m of CATALOG) { assert.ok(m.minI <= m.maxI && m.minT <= m.maxT, m.key); assert.ok(m.kw.length, m.key); }
    const p = CATALOG.find(m => m.key === "petpet");
    assert.deepEqual([p.minI, p.maxI, p.minT, p.maxT], [1, 1, 0, 0]);
    assert.ok(p.kw.includes("摸头"));
    assert.deepEqual(p.opts.map(o => o.name), ["circle"]);
    assert.equal(CATALOG.find(m => m.key === "raise_sign").dt[0], "大佬带带我");
  });
});

describe("find", () => {
  test("exact keyword first", () => {
    assert.equal(keys("摸头")[0], "petpet");
    assert.equal(keys("举牌")[0], "raise_sign");
    assert.equal(keys("拍")[0], "pat");
    assert.equal(keys("petpet")[0], "petpet");
  });
  test("partial wording", () => {
    assert.ok(keys("结婚").slice(0, 3).includes("marriage"));
    assert.equal(keys("吃掉")[0], "eat");
    assert.equal(keys("我想把他拍一下")[0], "pat");
    assert.ok(keys("想做个喜报").includes("good_news"));
  });
  test("plain wordings through synonyms", () => {
    assert.ok(keys("打人").includes("beat_up"));
    assert.equal(keys("亲吻")[0], "kiss");
  });
  test("character tags and the 12 limit", () => {
    assert.ok(keys("咖波").length > 3);
    assert.ok(findMemes("举", 12).length <= 12);
    assert.equal(findMemes("举牌", 3).length, 3);
  });
  test("no match", () => {
    assert.deepEqual(keys("zzzqqq"), []);
    assert.deepEqual(keys(""), []);
    assert.deepEqual(keys("   "), []);
  });
});

describe("pickMeme", () => {
  test("by key, keyword, near wording", () => {
    assert.equal(pickMeme("petpet").meme.key, "petpet");
    assert.equal(pickMeme(" 摸头 ").meme.key, "petpet");
    assert.equal(pickMeme("结婚申请").meme.key, "marriage");
    assert.equal(pickMeme("结婚").meme.key, "marriage");
  });
  test("errors say what to do", () => {
    assert.match(pickMeme("").error, /find/);
    assert.match(pickMeme("zzzqqq").error, /没有叫「zzzqqq」/);
    const e = pickMeme("举"); // many things start with 举
    assert.ok(e.meme || /不确定是哪个/.test(e.error));
  });
});

describe("checkArgs", () => {
  const g = k => CATALOG.find(m => m.key === k);
  test("fine", () => {
    assert.equal(checkArgs(g("petpet"), 1, []), null);
    assert.equal(checkArgs(g("raise_sign"), 0, ["x"]), null);
    assert.equal(checkArgs(g("kiss"), 2, []), null);
    assert.equal(checkArgs(g("petpet"), 1, [], { circle: true }), null);
  });
  test("too few images says how many", () => {
    assert.match(checkArgs(g("kiss"), 1, []), /要 2 张图，你只给了 1 张/);
    assert.match(checkArgs(g("petpet"), 0, []), /要 1 张图，你只给了 0 张/);
    assert.match(checkArgs(g("captain"), 1, []), /要 2 到 5 张图/);
  });
  test("too many images / pictures for a text-only template", () => {
    assert.match(checkArgs(g("petpet"), 2, []), /最多 1 张图，你给了 2 张/);
    assert.match(checkArgs(g("raise_sign"), 1, ["a"]), /不用图片/);
  });
  test("texts", () => {
    assert.match(checkArgs(g("raise_sign"), 0, []), /要 1 段文字，你只给了 0 段.*大佬带带我/);
    assert.match(checkArgs(g("wangjingze"), 0, ["a", "b"]), /要 4 段文字，你只给了 2 段/);
    assert.match(checkArgs(g("petpet"), 1, ["a"]), /不用文字/);
    assert.match(checkArgs(g("raise_sign"), 0, ["a", "b"]), /最多 1 段文字/);
    assert.equal(checkArgs(g("good_news"), 0, ["喜报内容"]), null);
  });
  test("options", () => {
    assert.match(checkArgs(g("petpet"), 1, [], { nope: 1 }), /没有叫 nope 的选项.*circle/);
    assert.match(checkArgs(g("universal"), 1, ["x"], { position: "left" }), /position 只能是/);
    assert.match(checkArgs(g("universal"), 1, ["x"], { size: 500 }), /size 要在 20 到 100 之间/);
    assert.match(checkArgs(g("universal"), 1, ["x"], { size: "abc" }), /整数/);
    assert.equal(checkArgs(g("universal"), 1, ["x"], { size: 60, position: "top" }), null);
    assert.deepEqual(coerceOptions(g("look_flat"), { ratio: "3" }), { ratio: 3 });
    assert.deepEqual(coerceOptions(g("petpet"), { circle: "true" }), { circle: true });
    assert.deepEqual(coerceOptions(g("universal"), { size: "60.7", bold: 1 }), { size: 60, bold: true });
  });
});

describe("command builder", () => {
  const nasty = ["他说：\"别\"碰我 & it's $HOME `ls` $(rm -rf /)\n第二行 \\ 'x'", "奶蛙 最强", "a'b", ""];
  const job = { id: "ab12", key: "my_friend_say", images: [{ file: "meme_ab12_0.png", name: "奶蛙" }], texts: nasty, options: { circle: true } };
  const cmd = buildCommand(job);
  test("texts survive as base64 and never appear raw in the command", () => {
    const m = cmd.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > job-ab12\.json/);
    assert.ok(m);
    assert.deepEqual(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")), job);
    for (const t of nasty.slice(0, 3)) assert.ok(!cmd.includes(t));
  });
  test("valid bash, one command, working in /work/meme", () => {
    assert.equal(spawnSync("bash", ["-n", "-c", cmd]).status, 0);
    assert.ok(cmd.startsWith("mkdir -p /work/meme && cd /work/meme"));
    assert.match(cmd, /mv -f \.\.\/meme_ab12_0\.png \./);
    assert.match(cmd, /uv pip install -q --python \/opt\/py\/bin\/python meme-generator/);
    assert.match(cmd, /\[ ! -f ready-1 \]/);
    assert.equal(outPattern("ab12"), "meme/out-ab12.*");
  });
  test("the decode step really round-trips through a shell", () => {
    const b64 = cmd.match(/printf %s '([^']+)'/)[1];
    const r = spawnSync("sh", ["-c", "printf %s '" + b64 + "' | base64 -d"]);
    assert.deepEqual(JSON.parse(r.stdout.toString("utf8")).texts, nasty);
  });
  test("the embedded script has no quote problems for the heredoc", () => {
    assert.ok(!GEN_PY.includes("MEME_PY_END"));
    const py = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: GEN_PY });
    assert.equal(py.status, 0, String(py.stderr));
  });
});

describe("results", () => {
  test("mime by extension", () => {
    assert.equal(mimeOf("meme/out-x.gif"), "image/gif");
    assert.equal(mimeOf("out.GIF"), "image/gif");
    assert.equal(mimeOf("out.png"), "image/png");
    assert.equal(mimeOf("out.jpg"), "image/jpeg");
    assert.equal(mimeOf("out.jpeg"), "image/jpeg");
    assert.equal(mimeOf("out.webp"), "image/webp");
    assert.equal(mimeOf("noext"), "image/png");
  });
  test("parse the result line among noise", () => {
    assert.deepEqual(parseResult("Fontconfig warning\nMEME_RESULT {\"ok\": true, \"file\": \"out-a.gif\"}\n"), { ok: true, file: "out-a.gif" });
    assert.equal(parseResult("nothing"), null);
    assert.equal(parseResult("MEME_RESULT {bad"), null);
  });
  test("error words", () => {
    const m = CATALOG.find(x => x.key === "raise_sign");
    assert.match(explainError(m, { err: "TextOverLength", text: "很长" }), /太长/);
    assert.match(explainError(m, { err: "ImageNumberMismatch", min: 2, max: 2, actual: 1 }), /要 2 张图，给了 1 张/);
    assert.match(explainError(m, { err: "ImageDecodeError", error: "x" }), /读不出来/);
    assert.match(explainError(m, { err: "Weird" }), /生成失败/);
  });
});

// ---- the tool with a fake host ----
const fakeHost = (over = {}) => {
  const calls = { computer: [], sent: [], quota: [] };
  const host = {
    now: () => 1700000000000, cfg: k => ({ meme_daily: 80 })[k],
    imageRef: async ref => (ref === "奶蛙" || ref === "g12" || ref === "123-0" ? { label: ref, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), mime: "image/png" } : null),
    quota: async (k, n) => { calls.quota.push([k, n]); return over.quota !== false; },
    computer: async req => { calls.computer.push(req); return over.computer ? over.computer(req) : { ok: true, seconds: 1, steps: [{ exit: 0, stdout: "MEME_RESULT {\"ok\": true, \"file\": \"x\"}", stderr: "", seconds: 1 }], files: [{ name: "meme/out-" + JSON.parse(Buffer.from(req.commands[0].match(/printf %s '([^']+)'/)[1], "base64").toString()).id + ".gif", bytes: new Uint8Array([0x47, 0x49, 0x46, 9]) }] }; },
    sendImage: async (bytes, note, mime, silent) => { calls.sent.push({ note, mime, silent }); return { ok: true, id: "g77" }; },
  };
  return { host, calls };
};
const tool = h => feature.tools({ host: h }).find(t => t.name === "meme");

describe("tool", () => {
  test("feature shape", () => {
    assert.equal(feature.name, "meme");
    assert.equal(feature.tunables.meme_daily.default, 80);
    assert.ok(feature.about.length >= 2 && feature.about.every(l => /[一-鿿]/.test(l)));
    const d = tool(fakeHost().host).description;
    for (const w of ["摸头", "举牌", "结婚申请", "generate_image"]) assert.ok(d.includes(w), w);
  });
  test("find returns up to 12 with counts and defaults", async () => {
    const r = await tool(fakeHost().host).run({ op: "find", query: "举牌" });
    assert.ok(r.ok && r.matches.length >= 3 && r.matches.length <= 12);
    const top = r.matches[0];
    assert.equal(top.key, "raise_sign");
    assert.equal(top.images, 0); assert.equal(top.texts, 1);
    assert.deepEqual(top.default_texts, ["大佬带带我"]);
    assert.equal((await tool(fakeHost().host).run({ op: "find", query: "zzzqqq" })).matches.length, 0);
  });
  test("make: validation does not start the machine or spend quota", async () => {
    const { host, calls } = fakeHost();
    const t = tool(host);
    assert.match((await t.run({ op: "make", template: "亲", images: ["奶蛙"] })).error, /要 2 张图，你只给了 1 张/);
    assert.match((await t.run({ op: "make", template: "举牌" })).error, /要 1 段文字/);
    assert.match((await t.run({ op: "make", template: "摸头", images: ["999-9"] })).error, /图 999-9 找不到/);
    assert.match((await t.run({ op: "make", template: "不存在的模板" })).error, /没有叫/);
    assert.match((await t.run({ op: "nope" })).error, /find 或 make/);
    assert.equal(calls.computer.length, 0); assert.equal(calls.quota.length, 0);
  });
  test("make: daily limit", async () => {
    const { host, calls } = fakeHost({ quota: false });
    const r = await tool(host).run({ op: "make", template: "摸头", images: ["奶蛙"] });
    assert.equal(r.ok, false); assert.match(r.error, /今天做表情包的次数用完了/);
    assert.deepEqual(calls.quota[0], ["meme", 80]); assert.equal(calls.computer.length, 0);
  });
  test("make: gif is sent as gif with one computer call", async () => {
    const { host, calls } = fakeHost();
    const r = await tool(host).run({ op: "make", template: "摸头", images: ["[图片 123-0]"], options: { circle: true } });
    assert.equal(r.ok, true); assert.equal(r.sent, true); assert.equal(r.id, "g77"); assert.equal(r.format, "动图");
    assert.equal(calls.computer.length, 1); assert.equal(calls.computer[0].commands.length, 1);
    assert.equal(calls.computer[0].files[0].name.endsWith(".png"), true);
    assert.deepEqual(calls.sent[0], { note: "表情包：摸", mime: "image/gif", silent: false });
    const job = JSON.parse(Buffer.from(calls.computer[0].commands[0].match(/printf %s '([^']+)'/)[1], "base64").toString());
    assert.equal(job.key, "petpet"); assert.deepEqual(job.options, { circle: true }); assert.equal(job.images[0].name, "123-0");
  });
  test("make: deliver=false keeps it as material", async () => {
    const { host, calls } = fakeHost();
    const r = await tool(host).run({ op: "make", template: "举牌", texts: ["大佬带带我"], deliver: false });
    assert.equal(r.ok, true); assert.equal(r.sent, false); assert.equal(r.id, "g77"); assert.equal(calls.sent[0].silent, true);
  });
  test("make: generator and machine failures become Chinese errors", async () => {
    const mk = (stdout, extra = {}) => fakeHost({ computer: async () => ({ ok: true, seconds: 1, steps: [{ exit: 0, stdout, stderr: "", seconds: 1 }], files: [], ...extra }) });
    let r = await tool(mk("MEME_RESULT {\"err\": \"TextOverLength\", \"text\": \"长\"}").host).run({ op: "make", template: "举牌", texts: ["长"] });
    assert.match(r.error, /太长/);
    r = await tool(mk("MEME_SETUP_FAILED_RESOURCES\n").host).run({ op: "make", template: "举牌", texts: ["x"] });
    assert.match(r.error, /没装成功/);
    r = await tool(fakeHost({ computer: async () => ({ ok: false, seconds: 3, error: "这个月云电脑的额度用到停止线了", steps: [], files: [] }) }).host).run({ op: "make", template: "举牌", texts: ["x"] });
    assert.match(r.error, /额度/);
    r = await tool(fakeHost({ computer: async () => ({ ok: false, seconds: 3, steps: [{ exit: 124, stdout: "", stderr: "", seconds: 3 }], files: [] }) }).host).run({ op: "make", template: "举牌", texts: ["x"] });
    assert.match(r.error, /超时/);
  });
});
