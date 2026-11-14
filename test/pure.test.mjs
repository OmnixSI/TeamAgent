// Offline tests for the pure helpers: text, time, QQ event parsing, image sizes, prices, config, pages.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitReply, cleanReply, nextDaily, zonedToUtc, decodeFaces, clip, tzOffset, fmtFull, BJ, SYD } from "../src/util.ts";
import { parseEvent } from "../src/qq.ts";
import { fitSize } from "../src/draw.ts";
import { isPeak, flashUsage, PRICE } from "../src/meter.ts";
import { checkTunable, TUNABLES } from "../src/config.ts";
import { buildPage } from "../src/show.ts";
import { bookHtml } from "../src/book.ts";

const iso = ts => new Date(ts).toISOString();

describe("util", () => {
  test("splitReply", () => {
    assert.deepEqual(splitReply(""), []);
    assert.deepEqual(splitReply("  \n "), []);
    assert.deepEqual(splitReply("哈哈"), ["哈哈"]);
    assert.deepEqual(splitReply("第一句\n\n第二句\n第三句"), ["第一句", "第二句", "第三句"]);
    assert.deepEqual(splitReply("一\n二\n三\n四"), ["一\n二\n三\n四"], "more than three lines stay whole");
    assert.deepEqual(splitReply("1. 先这样\n2. 再那样"), ["1. 先这样\n2. 再那样"], "lists stay whole");
    assert.deepEqual(splitReply("· 一\n· 二"), ["· 一\n· 二"]);
    const longLine = "长".repeat(71);
    assert.deepEqual(splitReply(longLine + "\n短"), [longLine + "\n短"]);
    const long = "字".repeat(141);
    assert.deepEqual(splitReply(long), [long]);
  });

  test("cleanReply strips Markdown decoration", () => {
    assert.equal(cleanReply("**粗体**和*斜体*"), "粗体和斜体");
    assert.equal(cleanReply("## 标题\n正文"), "标题\n正文");
    assert.equal(cleanReply("用 `npm run check`"), "用 npm run check");
    assert.equal(cleanReply("看[这里](https://a.b/c)"), "看这里 https://a.b/c");
    assert.equal(cleanReply("- 一\n* 二"), "· 一\n· 二");
    assert.equal(cleanReply("```js\nlet a = 1\n```"), "let a = 1");
    assert.equal(cleanReply("上\n---\n下"), "上\n\n下");
    assert.equal(cleanReply("a\n\n\n\n\nb"), "a\n\nb");
  });

  test("clip", () => {
    assert.equal(clip("abcdef", 3), "abc…");
    assert.equal(clip("abc", 3), "abc");
    assert.equal(clip(null, 3), "");
    assert.equal(clip(undefined, 3), "");
    assert.equal(clip(12345, 2), "12…");
  });

  test("decodeFaces", () => {
    const ext = Buffer.from(JSON.stringify({ text: "流泪" })).toString("base64");
    assert.equal(decodeFaces(`哭了<faceType=1,faceId="5",ext="${ext}">`), "哭了[表情:流泪]");
    const noText = Buffer.from(JSON.stringify({ id: 1 })).toString("base64");
    assert.equal(decodeFaces(`<faceType=1,faceId="5",ext="${noText}">`), "[表情]");
    assert.equal(decodeFaces(`<faceType=2,faceId="",ext="!!notbase64">`), "[表情]");
    assert.equal(decodeFaces("没有表情"), "没有表情");
  });

  test("zonedToUtc for Beijing and Sydney (both sides of DST)", () => {
    assert.equal(zonedToUtc("2026-11-15", "08:00", BJ), Date.UTC(2026, 10, 15, 0, 0));
    assert.equal(zonedToUtc("2026-01-10", "09:00", SYD), Date.UTC(2026, 0, 9, 22, 0));   // AEDT +11
    assert.equal(zonedToUtc("2026-07-10", "09:00", SYD), Date.UTC(2026, 6, 9, 23, 0));   // AEST +10
    assert.equal(zonedToUtc("2026-11-15", "0:5", BJ), Date.UTC(2026, 10, 14, 16, 5));
    assert.equal(tzOffset(Date.UTC(2026, 0, 1), SYD), 11 * 3600000);
    assert.equal(tzOffset(Date.UTC(2026, 6, 1), SYD), 10 * 3600000);
  });

  test("nextDaily with days of the month", () => {
    const nov15 = Date.UTC(2026, 10, 15, 0, 0);
    assert.equal(nextDaily("12:00", BJ, nov15, undefined, [1]), Date.UTC(2026, 11, 1, 4, 0));
    assert.equal(nextDaily("12:00", BJ, Date.UTC(2026, 11, 1, 3, 0), undefined, [1, 15]), Date.UTC(2026, 11, 1, 4, 0));
    assert.equal(nextDaily("12:00", BJ, Date.UTC(2026, 11, 1, 5, 0), undefined, [1, 15]), Date.UTC(2026, 11, 15, 4, 0));
  });

  test("nextDaily in Beijing, strictly after, with weekday filter", () => {
    const sundayNine = Date.UTC(2026, 10, 15, 1, 0); // Sun 2026-11-15 09:00 Beijing
    assert.equal(nextDaily("10:00", BJ, sundayNine), Date.UTC(2026, 10, 15, 2, 0));
    assert.equal(nextDaily("08:00", BJ, sundayNine), Date.UTC(2026, 10, 16, 0, 0));
    assert.equal(nextDaily("09:00", BJ, sundayNine), Date.UTC(2026, 10, 16, 1, 0), "an exact match is not 'after'");
    assert.equal(nextDaily("08:00", BJ, sundayNine, [1]), Date.UTC(2026, 10, 16, 0, 0));  // Monday
    assert.equal(nextDaily("08:00", BJ, sundayNine, [3]), Date.UTC(2026, 10, 18, 0, 0));  // Wednesday
    assert.equal(nextDaily("10:00", BJ, sundayNine, [0]), Date.UTC(2026, 10, 15, 2, 0));  // Sunday, today
    assert.equal(nextDaily("08:00", BJ, sundayNine, [0]), Date.UTC(2026, 10, 22, 0, 0));  // Sunday, next week
  });

  test("nextDaily in Sydney across both DST changes", () => {
    // DST starts Sun 2026-10-04 02:00 → 03:00. Sat 09:30 AEST → Sun 09:00 AEDT.
    assert.equal(iso(nextDaily("09:00", SYD, Date.UTC(2026, 9, 2, 23, 30))), "2026-10-03T22:00:00.000Z");
    assert.equal(iso(nextDaily("09:00", SYD, Date.UTC(2026, 9, 2, 22, 0))), "2026-10-02T23:00:00.000Z");
    // DST ends Sun 2026-04-05 03:00 → 02:00. Sat 09:30 AEDT → Sun 09:00 AEST.
    assert.equal(iso(nextDaily("09:00", SYD, Date.UTC(2026, 3, 3, 22, 30))), "2026-04-04T23:00:00.000Z");
    // A time that does not exist on the DST start day still lands that morning, after the jump.
    const skipped = nextDaily("02:30", SYD, Date.UTC(2026, 9, 3, 10, 0));
    assert.ok(skipped > Date.UTC(2026, 9, 3, 15, 0) && skipped < Date.UTC(2026, 9, 3, 17, 0), iso(skipped));
    assert.match(fmtFull(Date.UTC(2026, 9, 3, 22, 0), SYD), /10-04 周日 09:00/);
  });
});

describe("qq.parseEvent", () => {
  const base = (extra = {}) => ({
    id: "m1", group_openid: "G1", author: { member_openid: "U1", username: "小王" },
    content: "你好", timestamp: "2026-11-15T10:00:00+08:00", ...extra,
  });

  test("group @ message: bot mention removed, counts as mentioned", () => {
    const e = parseEvent("GROUP_AT_MESSAGE_CREATE", base({ content: "<@BOT> 帮我查下天气", mentions: [{ member_openid: "BOT", is_you: true }] }));
    assert.deepEqual(e, {
      id: "m1", conv: "g:G1", sender: "U1", name: "小王", text: "帮我查下天气",
      ts: Date.parse("2026-11-15T10:00:00+08:00"), mentioned: true, meta: undefined,
    });
  });

  test("other members' mentions become @nickname; plain chatter is not mentioned", () => {
    const e = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "<@U2> 看这个", mentions: [{ member_openid: "U2", nickname: "老李" }] }));
    assert.equal(e.text, "@老李 看这个");
    assert.equal(e.mentioned, false);
    const anon = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "<@U2abcd> 嗯", mentions: [{ member_openid: "U2abcd" }] }));
    assert.equal(anon.text, "@成员abcd 嗯");
  });

  test("saying bot / 奶蛙 in plain group text counts as mentioned, robot does not", () => {
    for (const text of ["这个bot好笨", "Bot 你在吗", "@机器人 来", "奶蛙出来", "boat呢"]) {
      assert.equal(parseEvent("GROUP_MESSAGE_CREATE", base({ content: text })).mentioned, true, text);
    }
    for (const text of ["robot 很酷", "今天吃什么", "about it", "bottle"]) {
      assert.equal(parseEvent("GROUP_MESSAGE_CREATE", base({ content: text })).mentioned, false, text);
    }
  });

  test("aliases match case-insensitively", () => {
    assert.equal(parseEvent("GROUP_MESSAGE_CREATE", base({ content: "小蛙在吗" }), ["小蛙"]).mentioned, true);
    assert.equal(parseEvent("GROUP_MESSAGE_CREATE", base({ content: "hi NaiWa" }), ["naiwa"]).mentioned, true);
    assert.equal(parseEvent("GROUP_MESSAGE_CREATE", base({ content: "随便聊聊" }), ["小蛙", ""]).mentioned, false);
  });

  test("attachments: image, voice, video, file", () => {
    const e = parseEvent("GROUP_MESSAGE_CREATE", base({
      content: "",
      attachments: [
        { content_type: "image/png", url: "https://img/1", width: 10, height: 20 },
        { content_type: "voice", url: "https://v/1", asr_refer_text: "你好呀" },
        { content_type: "audio/silk", url: "https://v/2" },
        { content_type: "video/mp4", url: "https://vid/1" },
        { content_type: "application/pdf", url: "https://f/1", filename: "a.pdf" },
      ],
    }));
    // A recording without QQ's own transcript is marked for the Hub to listen to before the turn runs.
    assert.equal(e.text, "[语音] 你好呀 [语音 …]");
    assert.deepEqual(e.meta.voice, [{ url: "https://v/2" }]);
    assert.equal(e.meta.videoUrl, "https://vid/1");
    assert.deepEqual(e.meta.images, [{ url: "https://img/1", w: 10, h: 20 }]);
    assert.equal(e.meta.video, true);
    assert.deepEqual(e.meta.files, [{ url: "https://f/1", name: "a.pdf" }]);
  });

  test("an image-only message is kept; an empty one is dropped; bot authors and other types are ignored", () => {
    const img = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "", attachments: [{ content_type: "image/jpeg", url: "u" }] }));
    assert.equal(img.text, "");
    assert.equal(img.meta.images.length, 1);
    assert.equal(parseEvent("GROUP_MESSAGE_CREATE", base({ content: "  " })), null);
    assert.equal(parseEvent("GROUP_MESSAGE_CREATE", base({ author: { member_openid: "B", bot: true } })), null);
    assert.equal(parseEvent("GUILD_MESSAGE_CREATE", base()), null);
  });

  test("quoted message from msg_elements", () => {
    const e = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "同意", msg_elements: [{ content: "明天开会", author: { username: "老李" } }] }));
    assert.deepEqual(e.meta.quote, { name: "老李", text: "明天开会", bot: false });
    assert.equal(e.mentioned, false);
    const toBot = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "你说啥", msg_elements: [{ content: "我说的", author: { username: "Bot", bot: true } }] }));
    assert.equal(toBot.mentioned, true, "replying to the bot counts as talking to it");
    const pic = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "这图", msg_elements: [{ content: "", attachments: [{ content_type: "image/png", url: "q1" }] }] }));
    assert.equal(pic.meta.quote.text, "[图片]");
    assert.deepEqual(pic.meta.images, [{ url: "q1" }]);
  });

  test("share card from ark_data", () => {
    const ark = { prompt: "[QQ小程序]哔哩哔哩", fields: [{ key: "title", value: "视频标题" }, { key: "qqdocurl", value: "https%3A%2F%2Fb23.tv%2Fabc" }] };
    const e = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "", ark_data: JSON.stringify(ark) }));
    assert.equal(e.text, "[分享卡片 [QQ小程序]哔哩哔哩 / 视频标题 https://b23.tv/abc]");
    const objFields = parseEvent("GROUP_MESSAGE_CREATE", base({ content: "看", ark_data: { prompt: "文章", fields: { title: "文章", url: "https://x.y/z" } } }));
    assert.equal(objFields.text, "看 [分享卡片 文章 https://x.y/z]");
  });

  test("inline faces are decoded", () => {
    const ext = Buffer.from(JSON.stringify({ text: "笑" })).toString("base64");
    const e = parseEvent("GROUP_MESSAGE_CREATE", base({ content: `好<faceType=1,faceId="1",ext="${ext}">` }));
    assert.equal(e.text, "好[表情:笑]");
  });

  test("C2C message: private conversation, always mentioned", () => {
    const e = parseEvent("C2C_MESSAGE_CREATE", { id: "c1", author: { user_openid: "UO" }, content: "私聊", timestamp: "2026-11-15T00:00:00Z" });
    assert.equal(e.conv, "u:UO");
    assert.equal(e.sender, "UO");
    assert.equal(e.mentioned, true);
  });
});

describe("draw.fitSize", () => {
  const dims = s => s.split("x").map(Number);
  test("named sizes, 4k / 2k, defaults", () => {
    assert.equal(fitSize("square"), "1024x1024");
    assert.equal(fitSize("Portrait"), "1024x1536");
    assert.equal(fitSize("landscape"), "1536x1024");
    assert.equal(fitSize(""), "1024x1024");
    assert.equal(fitSize(undefined), "1024x1024");
    assert.equal(fitSize("胡说八道"), "1024x1024");
    assert.equal(fitSize("4K"), "3840x2160");
    assert.equal(fitSize("要 2k 的"), "2048x2048");
  });

  test("explicit sizes snap to multiples of 16 and respect the limits", () => {
    assert.equal(fitSize("1920x1080"), "1920x1088");
    assert.equal(fitSize("1920×1080"), "1920x1088");
    assert.equal(fitSize("1920*1080"), "1920x1088");
    assert.equal(fitSize("3840x2160"), "3840x2160");
    assert.equal(fitSize("4000x4000"), "2880x2880");   // total pixels capped at 8,294,400
    assert.equal(fitSize("500x500"), "816x816");       // grown up to at least 655,360
    assert.equal(fitSize("3000x500"), "3008x1008");    // aspect clamped to 3:1
    assert.equal(fitSize("1000x4000"), "1280x3840");   // longest edge 3840
    assert.equal(fitSize("4096x2160"), "3840x2032");
  });

  test("ratios become a normal-sized picture of that shape", () => {
    assert.equal(fitSize("16:9"), "1584x880");
    assert.equal(fitSize("9:16"), "880x1584");
    assert.equal(fitSize("21:9"), "1808x768");
    assert.equal(fitSize("1：1"), "1184x1184");
    assert.equal(fitSize("10:1"), "3744x1248");
  });

  const inputs = ["16:9", "9:16", "21:9", "3:1", "1:3", "2:3", "1920x1080", "500x500", "3000x500", "4000x4000", "1000x4000", "256x256", "3840x3840", "4096x2160", "10:1", "1:10"];
  test("documented limits hold for typical inputs", () => {
    for (const s of inputs) {
      const [w, h] = dims(fitSize(s));
      assert.equal(w % 16, 0, s); assert.equal(h % 16, 0, s);
      assert.ok(Math.max(w, h) <= 3840, s);
      assert.ok(w * h >= 655_360 && w * h <= 8_294_400, s + " pixels " + w * h);
      assert.ok(Math.max(w, h) / Math.min(w, h) <= 3, s + " aspect");
    }
  });

  test("documented limits hold for small 3:1 inputs",
    () => {
      for (const s of ["300x900", "999x333"]) {
        const [w, h] = dims(fitSize(s));
        assert.ok(w * h >= 655_360, s + " pixels " + w * h);
        assert.ok(Math.max(w, h) / Math.min(w, h) <= 3, s + " aspect");
      }
    });
});

describe("meter", () => {
  // 2026-11-16 is a Monday.
  const bj = (d, h, m = 0) => Date.UTC(2026, 10, d, h - 8, m);
  test("isPeak: Beijing weekdays 09-12 and 14-18", () => {
    assert.equal(isPeak(bj(16, 9)), true);
    assert.equal(isPeak(bj(16, 8, 59)), false);
    assert.equal(isPeak(bj(16, 11, 59)), true);
    assert.equal(isPeak(bj(16, 12)), false);
    assert.equal(isPeak(bj(16, 13, 59)), false);
    assert.equal(isPeak(bj(16, 14)), true);
    assert.equal(isPeak(bj(16, 17, 59)), true);
    assert.equal(isPeak(bj(16, 18)), false);
    assert.equal(isPeak(bj(20, 10)), true);   // Friday
    assert.equal(isPeak(bj(21, 10)), false);  // Saturday
    assert.equal(isPeak(bj(15, 10)), false);  // Sunday
  });

  test("flashUsage cost arithmetic, peak doubling, server tools, cache fallbacks", () => {
    const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, completion_tokens: 100 };
    const off = flashUsage(usage, bj(15, 10));
    assert.deepEqual({ ...off, usd: undefined }, { inTok: 1000, cachedTok: 400, outTok: 100, usd: undefined });
    const expected = 400 * PRICE.flash.hit + 600 * PRICE.flash.miss + 100 * PRICE.flash.out;
    assert.ok(Math.abs(off.usd - expected) < 1e-12);
    assert.ok(Math.abs(off.usd - 151.2e-6) < 1e-12);
    const peak = flashUsage(usage, bj(16, 10));
    assert.ok(Math.abs(peak.usd - 2 * expected) < 1e-12);
    const tools = flashUsage({ ...usage, server_tool_use: { tool_search: 2, tool_image_search: 1, tool_fetch: 1 } }, bj(16, 10));
    assert.ok(Math.abs(tools.usd - (2 * expected + 3 * PRICE.dsSearch + PRICE.dsFetch)) < 1e-12, "server tools are not doubled");
    assert.equal(flashUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 7 } }).cachedTok, 7);
    assert.deepEqual(flashUsage(undefined), { inTok: 0, cachedTok: 0, outTok: 0, usd: 0 });
  });
});

describe("config.checkTunable", () => {
  test("numeric bounds, rounding", () => {
    assert.deepEqual(checkTunable("wait_called_ms", 1000), { ok: true, value: 1000 });
    assert.deepEqual(checkTunable("wait_called_ms", "0"), { ok: true, value: 0 });
    assert.deepEqual(checkTunable("wait_called_ms", 5000), { ok: true, value: 5000 });
    assert.deepEqual(checkTunable("reply_split_max", 2.6), { ok: true, value: 3 });
    assert.deepEqual(checkTunable("wait_called_ms", 5001), { ok: false, error: "要在 0 到 5000 之间" });
    assert.deepEqual(checkTunable("wait_chat_ms", 499), { ok: false, error: "要在 500 到 15000 之间" });
    assert.equal(checkTunable("image_daily", "abc").ok, false);
    assert.equal(checkTunable("image_daily", Infinity).ok, false);
    assert.equal(checkTunable("image_daily", undefined).ok, false);
  });

  test("options", () => {
    assert.deepEqual(checkTunable("talkative", "chatty"), { ok: true, value: "chatty" });
    assert.deepEqual(checkTunable("image_quality", "high"), { ok: true, value: "high" });
    assert.deepEqual(checkTunable("talkative", "loud"), { ok: false, error: "只能是 quiet / normal / chatty" });
  });

  test("unknown key lists the valid ones", () => {
    const r = checkTunable("nope", 1);
    assert.equal(r.ok, false);
    assert.ok(r.error.startsWith("没有这个参数"));
    for (const k of Object.keys(TUNABLES)) assert.ok(r.error.includes(k));
  });

  test("every default passes its own check", () => {
    for (const [k, t] of Object.entries(TUNABLES)) assert.equal(checkTunable(k, t.default).ok, true, k);
  });

  test("a missing or blank value is rejected rather than read as 0",
    () => {
      assert.equal(checkTunable("image_daily", "").ok, false);
      assert.equal(checkTunable("image_daily", null).ok, false);
    });
});

describe("show.buildPage", () => {
  test("doc (default kind)", () => {
    const p = buildPage("doc", "周报 / 11月", "## 进展\n- 做完了 </script><b>", "11-15 周日 10:00");
    assert.equal(p.file.name, "周报-11月.md");
    assert.equal(p.file.text, "# 周报 / 11月\n\n## 进展\n- 做完了 </script><b>");
    assert.ok(p.html.includes("做完了 \\u003c/script>\\u003cb>"), "content is embedded without breaking out of the script");
    assert.ok(!p.html.includes("</script><b>"));
    assert.ok(p.html.includes("11-15 周日 10:00"));
    assert.equal(p.full, true);
    assert.equal(p.width, 820);
  });

  test("doc keeps an existing top heading", () => {
    const p = buildPage("doc", "T", "# 自己的标题\n正文", "w");
    assert.equal(p.file.text, "# 自己的标题\n正文");
  });

  test("mindmap", () => {
    const p = buildPage("mindmap", "学习计划", "## 数学\n## 英语", "w");
    assert.equal(p.file.name, "学习计划.md");
    assert.equal(p.file.text, "# 学习计划\n## 数学\n## 英语");
    assert.ok(p.html.includes("markmap"));
    assert.ok(p.html.includes("## 数学"));
    const tricky = buildPage("mindmap", "x", "# a\n</script>", "w");
    assert.ok(tricky.html.includes("<\\/script>"));
  });

  test("diagram", () => {
    const p = buildPage("diagram", "流程 <A>", "graph TD; A-->B", "w");
    assert.equal(p.file.name, "流程-A.mmd");
    assert.equal(p.file.text, "graph TD; A-->B");
    assert.ok(p.html.includes("<h1>流程 &lt;A&gt;</h1>"));
    assert.ok(p.html.includes("graph TD; A--&gt;B"));
    assert.equal(p.selector, "#wrap");
  });

  test("html: fragments are wrapped, whole documents kept", () => {
    const frag = buildPage("html", "卡片", "<div>你好</div>", "w");
    assert.equal(frag.file.name, "卡片.html");
    assert.ok(frag.html.startsWith("<!doctype html>"));
    assert.ok(frag.html.includes("<body><div>你好</div></body>"));
    assert.equal(frag.file.text, frag.html);
    const whole = "<html><body><p>整页</p></body></html>";
    assert.equal(buildPage("html", "整页", whole, "w").html, whole);
  });

  test("empty or symbol-only titles fall back to doc", () => {
    assert.equal(buildPage("doc", "", "x", "w").file.name, "doc.md");
    assert.equal(buildPage("doc", "///", "x", "w").file.name, "doc.md");
    assert.equal(buildPage("doc", "长".repeat(60), "x", "w").file.name, "长".repeat(40) + ".md");
  });
});

describe("book.bookHtml", () => {
  const plan = {
    title: "奶蛙<历险>", subtitle: "第一卷", style: "s", ending: "完 & 续", cover: "c",
    cast: [{ name: "奶蛙", look: "green" }],
    pages: [{ text: "第一页 a<b", art: "x" }, { text: "第二页", art: "y" }, { text: "第三页", art: "z" }],
  };
  test("one section per page plus cover and back, images or placeholders", () => {
    const html = bookHtml(plan, new Uint8Array([1, 2, 3]), [new Uint8Array([4]), null, null], "群友出品");
    assert.equal((html.match(/<section class="page/g) || []).length, plan.pages.length + 2);
    assert.equal((html.match(/<section class="page">/g) || []).length, plan.pages.length);
    assert.ok(html.includes('<section class="page cover"><img src="data:image/jpeg;base64,AQID">'));
    assert.ok(html.includes("data:image/jpeg;base64,BA=="));
    assert.equal((html.match(/class="blank"/g) || []).length, 2);
    assert.ok(html.includes('<span class="no">3</span>'));
    assert.ok(html.includes("<h2>第一卷</h2>"));
  });

  test("text is escaped", () => {
    const html = bookHtml(plan, null, [], "by <me>");
    assert.ok(html.includes("第一页 a&lt;b"));
    assert.ok(!html.includes("a<b"));
    assert.ok(html.includes("奶蛙&lt;历险&gt;"));
    assert.ok(html.includes("完 &amp; 续"));
    assert.ok(html.includes("by &lt;me&gt;"));
    assert.ok(!html.includes("<h2></h2>"));
  });

  test("zoom is applied", () => {
    assert.ok(bookHtml(plan, null, [], "x", 0.5).includes("zoom:0.5"));
  });
});
