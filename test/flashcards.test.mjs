// Offline tests for flashcards: real SQLite behind a fake hub, scripted model, and the study page's script run against a hand-made DOM.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import feature, {
  deps, schedule, bjMidnight, dueText, norm, similarity, duplicateOf, grounded, cloze, parseCards, vet, chunkText, ankiText, studyPage,
  findDeck, dueCards, dueCount, runReminders, DAY, LIMITS,
} from "../src/feat/flashcards.ts";

const MIN = 60000, H = 3600000;
const T0 = Date.parse("2026-11-15T02:00:00Z");   // 10:00 Beijing, Sunday
const MID = bjMidnight(T0);

// ---------- fakes ----------
let hub, said, now, cfgs, quotaLeft, modelCalls, modelScript, published, sentFiles, kept, tools;

function makeHub() {
  const db = new DatabaseSync(":memory:");
  db.exec(feature.schema);
  db.exec("CREATE TABLE doc(id INTEGER PRIMARY KEY, conv TEXT, title TEXT, text TEXT, status TEXT)");
  const kv = new Map();
  const h = {
    env: {},
    sql: { exec: (q, ...b) => { const r = db.prepare(q).all(...b); return { toArray: () => r }; } },
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => void kv.set(k, String(v)),
    shadow: () => "",
    edit: { cfg: (_c, k) => cfgs[k] },
    say: async (conv, text) => void said.push({ conv, text }),
    tools: () => tools,
    db,
  };
  return h;
}

function makeCtx(conv, askers) {
  const host = {
    now: () => now,
    cfg: k => cfgs[k],
    quota: async () => quotaLeft-- > 0,
    keepFile: async (name, bytes) => { kept.push({ name, text: new TextDecoder().decode(bytes) }); return "f" + kept.length; },
    sendFile: async (name, bytes) => { sentFiles.push({ name, bytes }); return { ok: true }; },
  };
  return { hub, conv, askers, host };
}
const tool = (conv = "t:a", askers = [P1]) => feature.tools(makeCtx(conv, askers))[0];
const P1 = { id: "u1", name: "小明" }, P2 = { id: "u2", name: "小红" };

const MATERIAL = [
  "TCP 是面向连接的可靠传输协议，通过三次握手建立连接。",
  "UDP 是无连接的传输协议，不保证数据一定到达，但开销小，延迟低。",
  "拥塞控制的目标是避免网络过载，常见的算法包括慢启动、拥塞避免、快重传和快恢复。",
  "HTTP/2 使用二进制分帧，并且支持多路复用，一个连接上可以同时传输多个请求。",
].join("\n");

beforeEach(() => {
  now = T0; said = []; published = []; sentFiles = []; kept = []; modelCalls = [];
  cfgs = { cards_make_daily: 6, cards_deck_max: 300, cards_new_daily: 10 };
  quotaLeft = 100;
  modelScript = () => "[]";
  deps.model = async (_h, system, user) => { modelCalls.push({ system, user }); return modelScript(modelCalls.length); };
  tools = [
    {
      name: "publish", run: async a => {
        published.push(a);
        if (a.op === "list") return { ok: true, sites: published.filter(p => p.op === "create").map((_p, i) => ({ id: "site" + (i + 1), url: "https://x/p/site" + (i + 1) + "/" })) };
        if (a.op === "create") return { ok: true, id: "site1", url: "https://x/p/site1/" };
        if (a.op === "update") return { ok: true, id: a.id, url: "https://x/p/" + a.id + "/?v=1" };
        return { ok: true };
      },
    },
    { name: "read_attachment", run: async a => (a.url.includes("bad") ? Promise.reject(new Error("文件下载失败")) : { content: MATERIAL }) },
  ];
  hub = makeHub();
});

const card = (front, back, quote, hint = "") => ({ front, back, hint, quote });
const QA = [
  card("TCP 靠什么建立连接？", "三次握手", "通过三次握手建立连接"),
  card("UDP 为什么延迟低？", "无连接，开销小", "不保证数据一定到达，但开销小，延迟低"),
  card("拥塞控制的目标是什么？", "避免网络过载", "拥塞控制的目标是避免网络过载", "和流量控制不同"),
];

// ---------- scheduling ----------
describe("scheduling", () => {
  const run = (grades, start = T0, gap = DAY) => {
    let s = null, t = start; const out = [];
    for (const g of grades) { s = schedule(s, g, t); out.push(s); t = Math.max(s.due, t) + (gap === DAY ? 0 : gap); }
    return out;
  };
  test("good, good, good: 1 day, 6 days, then interval times ease", () => {
    const o = run(["good", "good", "good", "good"]);
    assert.deepEqual(o.map(s => s.ivl), [1, 6, 15, 38]);
    assert.ok(o.every(s => s.ease === 2.5));
    assert.deepEqual(o.map(s => s.reps), [1, 2, 3, 4]);
  });
  test("a pass is due at the start of a Beijing day, an evening review does not slip a day", () => {
    const evening = Date.parse("2026-11-15T14:30:00Z");   // 22:30 Beijing
    const s = schedule(null, "good", evening);
    assert.equal(s.due, bjMidnight(evening) + DAY);
    assert.equal(s.due, Date.parse("2026-11-15T16:00:00Z"));   // 00:00 on the 16th, Beijing
  });
  test("again: back in ten minutes, chain restarts, ease drops, lapse counted", () => {
    const [a, b, c] = run(["good", "good", "again"]);
    assert.equal(c.due, b.due + 10 * MIN);
    assert.equal(c.ivl, 0); assert.equal(c.reps, 0); assert.equal(c.lapses, 1); assert.equal(c.ease, 2.3);
    const next = schedule(c, "good", c.due);
    assert.equal(next.ivl, 1);
    assert.equal(schedule(next, "good", next.due).ivl, 6);
  });
  test("hard slows growth and lowers ease; easy speeds up and raises it", () => {
    let s = schedule(null, "good", T0); s = schedule(s, "good", s.due); // ivl 6
    const hard = schedule(s, "hard", s.due), good = schedule(s, "good", s.due), easy = schedule(s, "easy", s.due);
    assert.equal(hard.ivl, 7); assert.equal(good.ivl, 15); assert.equal(easy.ivl, 20);
    assert.equal(hard.ease, 2.35); assert.equal(easy.ease, 2.65);
    assert.equal(schedule(null, "easy", T0).ivl, 4);
  });
  test("ease stays within 1.3 and 3.0 and the interval within a year", () => {
    let s = null; for (let i = 0; i < 30; i++) s = schedule(s, "again", T0);
    assert.equal(s.ease, 1.3);
    s = null; for (let i = 0; i < 30; i++) s = schedule(s, "easy", s ? s.due : T0);
    assert.equal(s.ease, 3); assert.equal(s.ivl, 365);
  });
  test("for any state the grades order again < hard <= good < easy", () => {
    for (const reps of [0, 1, 2, 5, 9]) for (const ivl of [0, 1, 3, 6, 20, 100, 300]) for (const ease of [1.3, 2.5, 3]) {
      const s = { ease, ivl, reps, lapses: 0, due: T0, first: T0, last: T0 };
      const d = g => schedule(s, g, T0).due;
      assert.ok(d("again") < d("hard") && d("hard") <= d("good") && d("good") <= d("easy"), JSON.stringify(s));
      if (ivl < 300) assert.ok(d("good") < d("easy") || reps > 5, JSON.stringify(s));
    }
  });
  test("dueText", () => {
    assert.equal(dueText(T0 + 10 * MIN, T0), "10 分钟后");
    assert.equal(dueText(MID + DAY, T0), "明天");
    assert.equal(dueText(MID + 6 * DAY, T0), "6 天后");
    assert.equal(dueText(MID + 60 * DAY, T0), "2 个月后");
  });
});

// ---------- text helpers ----------
describe("duplicates", () => {
  const known = [{ id: 7, norm: norm("TCP 靠什么建立连接？") }, { id: 8, norm: norm("TCP 建立连接时为什么需要三次握手而不是两次？") }];
  test("same question in other punctuation, width and case", () => {
    assert.equal(duplicateOf("tcp靠什么建立连接?", known), 7);
    assert.equal(duplicateOf("ＴＣＰ 靠什么建立连接", known), 7);
  });
  test("near-identical wording", () => assert.equal(duplicateOf("TCP 建立连接为什么需要三次握手而不是两次？", known), 8));
  test("different question about a similar topic is kept", () => {
    assert.equal(duplicateOf("UDP 靠什么建立连接？", known), null);
    assert.equal(duplicateOf("TCP 如何断开连接？", known), null);
    assert.ok(similarity(norm("什么是TCP"), norm("什么是UDP")) < 0.5);
  });
  test("empty front is never a duplicate", () => assert.equal(duplicateOf("？？", known), null));
});

describe("quote grounding", () => {
  const mat = norm(MATERIAL);
  test("found, ignoring punctuation and spaces", () => {
    assert.ok(grounded("通过三次握手建立连接", mat));
    assert.ok(grounded("tcp 是面向连接的 可靠传输协议", mat));
  });
  test("a paraphrase is not", () => assert.ok(!grounded("TCP 先握手三次再通信", mat)));
  test("ellipsis: every piece must occur", () => {
    assert.ok(grounded("不保证数据一定到达……延迟低", mat));
    assert.ok(!grounded("不保证数据一定到达…它很快", mat));
  });
  test("too short or empty is refused", () => { assert.ok(!grounded("三次握手", mat)); assert.ok(!grounded("", mat)); });
  test("vet drops ungrounded and duplicate cards, keeps order, and uses the fallback sentence for cloze", () => {
    const raw = [...QA, card("TCP 是什么？", "x", "这句话资料里根本没有"), card("tcp靠什么建立连接", "握手", "通过三次握手建立连接")];
    const { cards, dropped } = vet(raw, "qa", MATERIAL, []);
    assert.equal(cards.length, 3); assert.deepEqual(dropped, { ungrounded: 1, duplicate: 1, malformed: 0 });
    const c = vet([{ front: "TCP 是{{面向连接}}的可靠传输协议", back: "", quote: "" }, { front: "没有挖空的句子啊啊啊", back: "", quote: "" }, { front: "TCP 是{{无状态}}的可靠传输协议", back: "", quote: "" }], "cloze", MATERIAL, []);
    assert.equal(c.cards.length, 1); assert.equal(c.cards[0].front, "TCP 是____的可靠传输协议"); assert.equal(c.cards[0].back, "面向连接");
    assert.equal(c.dropped.malformed, 1); assert.equal(c.dropped.ungrounded, 1);
  });
  test("vet checks against cards already in the deck", () => {
    const { cards, dropped } = vet(QA, "qa", MATERIAL, [{ id: 1, norm: norm("TCP 靠什么建立连接？") }]);
    assert.equal(cards.length, 2); assert.equal(dropped.duplicate, 1);
  });
});

describe("cloze", () => {
  test("one blank", () => {
    const c = cloze("线粒体是细胞的{{能量工厂}}。");
    assert.deepEqual([c.front, c.back], ["线粒体是细胞的____。", "能量工厂"]);
    assert.equal(c.plain, "线粒体是细胞的能量工厂。");
  });
  test("several blanks are numbered; [[ ]] works too", () => {
    const c = cloze("{{DNA}} 复制是 [[半保留]] 的，由 {{聚合酶}} 完成");
    assert.equal(c.front, "(1)____ 复制是 (2)____ 的，由 (3)____ 完成");
    assert.equal(c.back, "(1) DNA  (2) 半保留  (3) 聚合酶");
  });
  test("no blank, too many blanks, empty or huge answer: refused", () => {
    assert.equal(cloze("没有挖空的一句话"), null);
    assert.equal(cloze("{{a}}{{b}}{{c}}{{d}} 很多空"), null);
    assert.equal(cloze("{{" + "长".repeat(41) + "}} 的一句话来着"), null);
    assert.equal(cloze("{{整句}}"), null);
  });
});

describe("model output parsing and chunking", () => {
  test("plain, fenced, wrapped in prose", () => {
    const arr = JSON.stringify([{ front: "a", back: "b" }]);
    assert.equal(parseCards(arr).length, 1);
    assert.equal(parseCards("```json\n" + arr + "\n```").length, 1);
    assert.equal(parseCards("好的，这是卡片：\n" + arr + "\n完毕").length, 1);
  });
  test("cut-off output keeps the complete objects, even with braces inside strings", () => {
    const t = '[{"front":"TCP 是{{面向连接}}的","back":"","quote":"q1"},{"front":"b","back":"2","quote":"q"},{"front":"cut off';
    const got = parseCards(t);
    assert.equal(got.length, 2); assert.equal(got[0].front, "TCP 是{{面向连接}}的");
  });
  test("garbage gives nothing", () => assert.deepEqual(parseCards("抱歉，我做不到"), []));
  test("chunks respect size and count, keep paragraphs together", () => {
    const text = Array.from({ length: 30 }, (_, i) => "第" + i + "段" + "字".repeat(1000)).join("\n");
    const { chunks, used } = chunkText(text, 9000, 4);
    assert.equal(chunks.length, 4); assert.ok(chunks.every(c => c.length <= 9000));
    assert.ok(used <= 4 * 9000 && used > 3 * 8000);
    assert.equal(chunkText("短短的一段").chunks.length, 1);
    assert.equal(chunkText("字".repeat(25000), 9000, 4).chunks.length, 3);
  });
});

// ---------- Anki export ----------
describe("Anki export", () => {
  const cards = [
    { front: "a\tb", back: "line1\nline2\r\nline3", hint: "", quote: "", kind: "qa" },
    { front: 'He said "hi" & <b>left</b>', back: '"quoted"\t\ttabs', hint: "提示\t含制表符", quote: '摘自 "原文"', kind: "cloze" },
  ];
  const text = ankiText("英语 词汇,第1组", cards);
  const lines = text.split("\n");
  test("header and one physical line per card with exactly three tab-separated columns", () => {
    assert.deepEqual(lines.slice(0, 3), ["#separator:tab", "#html:true", "#tags column:3"]);
    assert.equal(lines.length, 3 + 2 + 1);
    for (const l of lines.slice(3, 5)) assert.equal(l.split("\t").length, 3, l);
    assert.equal(lines[5], "");
  });
  test("tabs, newlines and quotes cannot break fields", () => {
    const [f, b, t] = lines[3].split("\t");
    assert.equal(f, "a b"); assert.equal(b, "line1<br>line2<br>line3"); assert.equal(t, "英语_词汇_第1组 qa");
    const r = lines[4].split("\t");
    assert.equal(r[0], "He said &quot;hi&quot; &amp; &lt;b&gt;left&lt;/b&gt;");
    assert.ok(!r[1].includes('"') && !r[1].includes("\r"));
    assert.ok(r[1].includes("提示：提示 含制表符") && r[1].includes("出处：摘自 &quot;原文&quot;"));
    assert.equal(r[2], "英语_词汇_第1组 cloze");
  });
});

// ---------- tool: make / quiz / answer ----------
const reply = cards => JSON.stringify(cards);
const make = async (args, t = tool()) => t.run({ op: "make", deck: "网络", style: "qa", text: MATERIAL, ...args });

describe("make", () => {
  test("builds a deck, drops what is not in the material, reports counts", async () => {
    modelScript = () => reply([...QA, card("凭空的问题？", "答", "资料里没有这句话的原文")]);
    const r = await make({ n: 10 });
    assert.equal(r.ok, true); assert.equal(r.added, 3); assert.equal(r.dropped.ungrounded, 1); assert.equal(r.total, 3);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM fc_card").get().n, 3);
    assert.ok(modelCalls[0].system.includes("问答卡") && modelCalls[0].user.includes("<<<资料开始>>>"));
  });
  test("adding to a deck does not duplicate, and the model is told what exists", async () => {
    modelScript = () => reply(QA);
    await make({});
    modelScript = () => reply([card("TCP 靠什么建立连接", "握手", "通过三次握手建立连接"), card("HTTP/2 怎么提高并发？", "多路复用", "支持多路复用，一个连接上可以同时传输多个请求")]);
    const r = await make({});
    assert.equal(r.added, 1); assert.equal(r.dropped.duplicate, 1); assert.equal(r.total, 4);
    assert.ok(modelCalls[1].user.includes("TCP 靠什么建立连接？"));
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM fc_deck").get().n, 1);
  });
  test("n defaults to 20 and is capped at 60; the model is asked for a margin", async () => {
    modelScript = () => reply(QA);
    await make({}); assert.match(modelCalls[0].user, /需要 26 张/);
    await make({ deck: "另一套", n: 500 }); assert.match(modelCalls[1].user, /需要 78 张/);
  });
  test("cloze style stores the blanked sentence and the answer", async () => {
    modelScript = () => reply([{ front: "UDP 是{{无连接}}的传输协议", back: "", hint: "", quote: "UDP 是无连接的传输协议" }]);
    const r = await make({ style: "cloze" });
    assert.equal(r.added, 1);
    const c = hub.db.prepare("SELECT * FROM fc_card").get();
    assert.equal(c.front, "UDP 是____的传输协议"); assert.equal(c.back, "无连接"); assert.equal(c.kind, "cloze");
  });
  test("long material is split into pieces, one model call each", async () => {
    const long = Array.from({ length: 20 }, (_, i) => "第" + i + "段：" + "内容".repeat(500)).join("\n");
    modelScript = () => "[]";
    const r = await make({ text: long });
    assert.equal(r.ok, false);
    assert.equal(modelCalls.length, 3);   // 20 * ~1004 chars = 20k chars -> 3 pieces of at most 9000
  });
  test("a saved document and a chat file work as material", async () => {
    hub.db.prepare("INSERT INTO doc(id,conv,title,text,status) VALUES(5,'t:a','网络笔记',?, 'ok')").run(MATERIAL);
    hub.db.prepare("INSERT INTO doc(id,conv,title,text,status) VALUES(6,'t:other','别人的',?, 'ok')").run(MATERIAL);
    modelScript = () => reply(QA);
    assert.equal((await tool().run({ op: "make", deck: "d1", doc: 5 })).added, 3);
    assert.match((await tool().run({ op: "make", deck: "d2", doc: 6 })).error, /没有编号 6/);
    assert.equal((await tool().run({ op: "make", deck: "d3", file: "https://qq/f.pdf" })).added, 3);
    assert.match((await tool().run({ op: "make", deck: "d4", file: "https://qq/bad.pdf" })).error, /文件下载失败/);
  });
  test("refusals: no name, bad style, too short, no material, quota, deck full, model down", async () => {
    assert.match((await tool().run({ op: "make", text: MATERIAL })).error, /名字/);
    assert.match((await make({ style: "zzz" })).error, /style/);
    assert.match((await make({ text: "太短" })).error, /太短/);
    assert.match((await tool().run({ op: "make", deck: "x" })).error, /资料/);
    quotaLeft = 0; assert.match((await make({})).error, /次数用完/);
    assert.equal(modelCalls.length, 0);
    quotaLeft = 5; modelScript = () => reply(QA); await make({});
    cfgs.cards_deck_max = 3; assert.match((await make({})).error, /到上限/);
    cfgs.cards_deck_max = 300; deps.model = async () => { throw new Error("boom"); };
    assert.match((await make({ deck: "新的" })).error, /模型/);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM fc_deck WHERE name='新的'").get().n, 0);
  });
  test("the deck limit shrinks how many cards are added", async () => {
    cfgs.cards_deck_max = 2; modelScript = () => reply(QA);
    const r = await make({}); assert.equal(r.added, 2);
  });
});

describe("quiz and answer: per person", () => {
  beforeEach(async () => { modelScript = () => reply(QA); await make({}); });
  test("quiz returns questions with answers only in the grading field, new cards in order", async () => {
    const r = await tool().run({ op: "quiz" });
    assert.equal(r.ok, true); assert.equal(r.cards.length, 3);
    assert.equal(r.cards[0].question, "TCP 靠什么建立连接？"); assert.equal(r.cards[0].kind, "新卡");
    assert.equal(r.cards[0].answer_for_grading, "三次握手");
    assert.ok(!("answer" in r.cards[0]) && !("back" in r.cards[0]));
    assert.equal(r.cards[2].hint, "和流量控制不同");
    assert.equal((await tool().run({ op: "quiz", count: 2 })).cards.length, 2);
  });
  test("answer schedules the next review and returns the right answer", async () => {
    const id = hub.db.prepare("SELECT id FROM fc_card ORDER BY id").get().id;
    const r = await tool().run({ op: "answer", card: id, grade: "good" });
    assert.equal(r.recorded[0].next_review, "明天"); assert.equal(r.recorded[0].answer, "三次握手"); assert.equal(r.recorded[0].interval_days, 1);
    const again = await tool().run({ op: "answer", card: id, grade: "again" });
    assert.equal(again.recorded[0].next_review, "10 分钟后");
    assert.match((await tool().run({ op: "answer", card: id, grade: "ok" })).error, /again/);
    assert.match((await tool().run({ op: "answer", card: 999, grade: "good" })).error, /没有编号/);
  });
  test("progress belongs to the person who answered", async () => {
    const ids = hub.db.prepare("SELECT id FROM fc_card ORDER BY id").all().map(r => r.id);
    await tool("t:a", [P1]).run({ op: "answer", card: ids[0], grade: "good" });
    await tool("t:a", [P2]).run({ op: "answer", card: ids[1], grade: "easy" });
    const q1 = await tool("t:a", [P1]).run({ op: "quiz" }), q2 = await tool("t:a", [P2]).run({ op: "quiz" });
    assert.deepEqual(q1.cards.map(c => c.id), [ids[1], ids[2]]);
    assert.deepEqual(q2.cards.map(c => c.id), [ids[0], ids[2]]);
    assert.equal(q1.person, "小明");
    // each has their own state row for the same card
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM fc_state").get().n, 2);
  });
  test("the person is told when nothing is due, with the next due time", async () => {
    const ids = hub.db.prepare("SELECT id FROM fc_card").all().map(r => r.id);
    await tool().run({ op: "answer", results: ids.map(card => ({ card, grade: "good" })) });
    const r = await tool().run({ op: "quiz" });
    assert.deepEqual(r.cards, []); assert.match(r.message, /明天到期/);
  });
  test("a review that is due comes before new cards; due again after its interval", async () => {
    const ids = hub.db.prepare("SELECT id FROM fc_card ORDER BY id").all().map(r => r.id);
    await tool().run({ op: "answer", card: ids[2], grade: "good" });
    now = MID + DAY + 3 * H;   // tomorrow
    const r = await tool().run({ op: "quiz" });
    assert.deepEqual(r.cards.map(c => [c.id, c.kind]), [[ids[2], "复习"], [ids[0], "新卡"], [ids[1], "新卡"]]);
  });
  test("no known asker: refused, unless a name is given", async () => {
    assert.match((await tool("t:a", []).run({ op: "quiz" })).error, /认不出/);
    assert.equal((await tool("t:a", []).run({ op: "quiz", as: "小刚" })).person, "小刚");
    assert.equal((await tool("t:a", [P1, P2]).run({ op: "quiz", as: "小红" })).person, "小红");
  });
  test("decks are per conversation", async () => {
    assert.match((await tool("t:b").run({ op: "quiz" })).error, /还没有卡片/);
    assert.equal((await tool("t:b").run({ op: "list" })).decks.length, 0);
  });
});

describe("due selection", () => {
  let d;
  beforeEach(async () => {
    modelScript = () => reply(QA); await make({});
    d = findDeck(hub, "t:a", "网络").deck;
  });
  test("new cards are limited per person per day, shared across quizzes", async () => {
    cfgs.cards_new_daily = 2;
    const ids = hub.db.prepare("SELECT id FROM fc_card ORDER BY id").all().map(r => r.id);
    assert.equal(dueCount(hub, d.id, "u1", now, 2), 2);
    await tool().run({ op: "answer", card: ids[0], grade: "again" });
    // one of today's two new cards is used up; the failed card is not due for ten minutes
    assert.equal(dueCards(hub, d.id, "u1", now, 2).fresh.length, 1);
    now += 11 * MIN;
    const x = dueCards(hub, d.id, "u1", now, 2);
    assert.deepEqual([x.review.length, x.fresh.length], [1, 1]);
    assert.equal(dueCount(hub, d.id, "u2", now, 2), 2);   // someone else is unaffected
  });
  test("tomorrow the allowance is back", async () => {
    const ids = hub.db.prepare("SELECT id FROM fc_card ORDER BY id").all().map(r => r.id);
    await tool().run({ op: "answer", results: [{ card: ids[0], grade: "good" }, { card: ids[1], grade: "good" }] });
    assert.equal(dueCount(hub, d.id, "u1", now, 2), 0);
    assert.equal(dueCount(hub, d.id, "u1", now + DAY, 2), 3);   // 2 reviews + the last new card
  });
  test("list shows the asker's count", async () => {
    const r = await tool("t:a", [P2]).run({ op: "list" });
    assert.equal(r.decks[0].due_for_you, 3); assert.equal(r.decks[0].cards, 3); assert.equal(r.decks[0].reminder, "关");
  });
});

describe("edit, delete, show", () => {
  beforeEach(async () => { modelScript = () => reply(QA); await make({}); });
  test("edit changes a card, refuses an empty or repeated question", async () => {
    const [a, b] = hub.db.prepare("SELECT id FROM fc_card ORDER BY id").all().map(r => r.id);
    assert.equal((await tool().run({ op: "edit", card: a, back: "SYN, SYN-ACK, ACK", hint: "" })).ok, true);
    assert.equal(hub.db.prepare("SELECT back FROM fc_card WHERE id=?").get(a).back, "SYN, SYN-ACK, ACK");
    assert.match((await tool().run({ op: "edit", card: a, front: "" })).error, /空/);
    assert.match((await tool().run({ op: "edit", card: a, front: "UDP 为什么延迟低" })).error, new RegExp("第 " + b + " 张"));
  });
  test("delete removes the card and everyone's progress on it; delete_deck removes all and the page", async () => {
    const [a] = hub.db.prepare("SELECT id FROM fc_card ORDER BY id").all().map(r => r.id);
    await tool().run({ op: "answer", card: a, grade: "good" });
    assert.equal((await tool().run({ op: "delete", card: a })).deleted[0], a);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM fc_state").get().n, 0);
    assert.match((await tool("t:b").run({ op: "delete", card: 999 })).error, /没有/);
    await tool().run({ op: "page", deck: "网络" });
    const r = await tool().run({ op: "delete_deck", deck: "网络" });
    assert.equal(r.deleted, "网络"); assert.deepEqual(published.at(-1), { op: "delete", id: "site1" });
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM fc_card").get().n, 0);
  });
  test("show pages through cards with answers", async () => {
    const r = await tool().run({ op: "show", deck: "网络", limit: 2 });
    assert.equal(r.cards.length, 2); assert.equal(r.total, 3); assert.equal(r.next_offset, 2);
    assert.equal(r.cards[0].back, "三次握手");
    assert.equal((await tool().run({ op: "show", deck: "网络", offset: 2 })).next_offset, undefined);
  });
  test("deck lookup by id, exact name, part of a name, ambiguity", async () => {
    modelScript = () => reply(QA); await make({ deck: "网络二" });
    assert.equal(findDeck(hub, "t:a", "网络").deck.name, "网络");
    assert.equal(findDeck(hub, "t:a", "二").deck.name, "网络二");
    assert.match(findDeck(hub, "t:a", "").error, /哪一套/);
    assert.equal(findDeck(hub, "t:a", "1").deck.name, "网络");
    assert.match(findDeck(hub, "t:a", "没有").error, /没有叫/);
  });
});

describe("export", () => {
  test("keeps the file, sends it, explains the import", async () => {
    modelScript = () => reply(QA); await make({});
    const r = await tool().run({ op: "export", deck: "网络" });
    assert.equal(r.ok, true); assert.equal(r.kept_as, "f1"); assert.equal(r.sent, true); assert.match(r.import_howto, /制表符/);
    assert.equal(kept[0].name, "网络-anki.txt");
    const lines = kept[0].text.trim().split("\n");
    assert.equal(lines.length, 3 + 3);
    assert.ok(lines[5].startsWith("拥塞控制的目标是什么？\t避免网络过载<br><br>提示：和流量控制不同<br><br>出处：拥塞控制的目标是避免网络过载\t网络 qa".replace("网络 qa", "网络 qa")));
  });
});

// ---------- the page ----------
describe("study page", () => {
  const PAGE_CARDS = [
    { id: 11, front: "问题一", back: "答案一", hint: "提示一", quote: "原文一" },
    { id: 12, front: "问题二", back: "答案二", hint: "", quote: "" },
    { id: 13, front: "<script>alert(1)</script>", back: "a & b", hint: "", quote: "" },
  ];
  let clock, store;

  function boot(html, storage) {
    const els = {};
    const hiddenAtStart = {};
    for (const m of html.matchAll(/<(\w+)([^>]*?)\sid="([\w-]+)"([^>]*)>/g)) hiddenAtStart[m[3]] = /\shidden(\s|>|=|$)/.test(m[2] + m[4] + ">");
    for (const id of Object.keys(hiddenAtStart)) {
      els[id] = { id, textContent: "", hidden: hiddenAtStart[id], style: {}, listeners: {},
        addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
        click() { for (const fn of this.listeners.click || []) fn({}); } };
    }
    els.deck.textContent = /<script type="application\/json" id="deck">([\s\S]*?)<\/script>/.exec(html)[1];
    const docListeners = {};
    const document = { getElementById: id => els[id], addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn) };
    const localStorage = { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } };
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    vm.runInNewContext(script, { document, localStorage, location: { pathname: "/p/site1/" }, Date: { now: () => clock }, confirm: () => true });
    return { els, key: ev => (docListeners.keydown || []).forEach(fn => fn({ key: ev })) };
  }
  const html = () => studyPage({ id: 3, name: "网络 <基础>" }, PAGE_CARDS, 2);
  beforeEach(() => { clock = T0; store = {}; });

  test("html is escaped: card text cannot close the data block", () => {
    const h = html();
    assert.ok(!h.includes("<script>alert"));
    assert.ok(h.includes("网络 &lt;基础&gt; - 记忆卡片"));
    assert.ok(!/<(link|script)[^>]+src=|https?:\/\//.test(h), "no external dependencies");
    assert.ok(!/gradient/i.test(h));
  });
  test("shows the first card; tap flips it; the grading buttons appear with their next intervals", () => {
    const p = boot(html(), store);
    assert.equal(p.els.title.textContent, "网络 <基础>");
    assert.equal(p.els.study.hidden, false); assert.equal(p.els.done.hidden, true);
    assert.equal(p.els.text.textContent, "问题一"); assert.equal(p.els.side.textContent, "问题");
    assert.equal(p.els.grades.hidden, true); assert.equal(p.els.hint.hidden, false);
    assert.equal(p.els.stat.textContent, "还剩 2 张");   // two new cards a day
    p.els.card.click();
    assert.equal(p.els.text.textContent, "答案一"); assert.equal(p.els.note.textContent, "出处：原文一");
    assert.equal(p.els.grades.hidden, false);
    assert.deepEqual(["again", "hard", "good", "easy"].map(g => p.els["t-" + g].textContent), ["10 分钟", "明天", "明天", "4 天"]);
    p.els.card.click();
    assert.equal(p.els.text.textContent, "问题一"); assert.equal(p.els.grades.hidden, true);
  });
  test("the hint button shows the hint once", () => {
    const p = boot(html(), store);
    p.els.hint.click();
    assert.equal(p.els.hintText.textContent, "提示：提示一"); assert.equal(p.els.hint.hidden, true);
  });
  test("grading stores progress, moves on, and the same card comes back after 'again'", () => {
    const p = boot(html(), store);
    p.els.card.click(); p.els["g-again"].click();
    assert.equal(p.els.text.textContent, "问题二");
    p.els.card.click(); p.els["g-good"].click();
    assert.equal(p.els.text.textContent, "问题一");   // the missed card returns in the same sitting
    p.els.card.click(); p.els["g-good"].click();
    assert.equal(p.els.study.hidden, true); assert.equal(p.els.done.hidden, false);
    assert.match(p.els.doneText.textContent, /学完了/);
    assert.match(p.els.doneText.textContent, /还有 1 张新卡/); assert.equal(p.els.more.hidden, false);
    const saved = JSON.parse(store["fc1:/p/site1/"]);
    assert.equal(Object.keys(saved.c).length, 2); assert.equal(saved.n.k, 2);
  });
  test("grading before flipping does nothing; keys 1-4 grade a flipped card", () => {
    const p = boot(html(), store);
    p.els["g-good"].click();
    assert.equal(p.els.text.textContent, "问题一");
    p.key("3"); assert.equal(p.els.text.textContent, "问题一");
    p.els.card.click(); p.key("3");
    assert.equal(p.els.text.textContent, "问题二");
  });
  test("progress survives a reload; due cards come back on the day, and 'more' brings extra new cards", () => {
    let p = boot(html(), store);
    p.els.card.click(); p.els["g-good"].click(); p.els.card.click(); p.els["g-easy"].click();
    p = boot(html(), store);
    assert.equal(p.els.done.hidden, false);
    p.els.more.click();
    assert.equal(p.els.text.textContent, "<script>alert(1)</script>"); assert.equal(p.els.done.hidden, true);
    clock = MID + DAY + 2 * H;
    p = boot(html(), store);
    assert.equal(p.els.text.textContent, "问题一");   // reviewed 'good': due tomorrow, ahead of the unseen card
    assert.equal(p.els.stat.textContent, "还剩 2 张");
  });
  test("reset clears the browser's progress", () => {
    const p = boot(html(), store);
    p.els.card.click(); p.els["g-good"].click();
    p.els.reset.click();
    assert.equal(p.els.text.textContent, "问题一");
    assert.deepEqual(JSON.parse(store["fc1:/p/site1/"]).c, {});
  });
  test("works when storage is unavailable", () => {
    const els = boot(html(), new Proxy({}, { get() { throw new Error("blocked"); }, has() { throw new Error("blocked"); } })).els;
    assert.equal(els.text.textContent, "问题一");
  });
  test("the page's interval arithmetic agrees with the server's", () => {
    const seq = ["good", "good", "hard", "good", "again", "good", "easy", "good", "easy", "hard"];
    const one = [{ id: 1, front: "q", back: "a", hint: "", quote: "" }];
    const p = boot(studyPage({ id: 1, name: "x" }, one, 5), store);
    let s = null;
    for (const g of seq) {
      // jump to when the card is next due, as a person would
      const due = JSON.parse(store["fc1:/p/site1/"] || '{"c":{}}').c[1]?.d;
      if (due && due > clock) { clock = due; boot(studyPage({ id: 1, name: "x" }, one, 5), store); }
      const q = boot(studyPage({ id: 1, name: "x" }, one, 5), store);
      q.els.card.click(); q.els["g-" + g].click();
      s = schedule(s, g, clock);
      const got = JSON.parse(store["fc1:/p/site1/"]).c[1];
      assert.deepEqual([got.e, got.i, got.r, got.l, got.d], [s.ease, s.ivl, s.reps, s.lapses, s.due], g);
    }
  });
});

// ---------- the page tool ----------
describe("page tool", () => {
  beforeEach(async () => { modelScript = () => reply(QA); await make({}); });
  test("first call publishes, an unchanged deck reuses the link, a changed deck updates it", async () => {
    const r1 = await tool().run({ op: "page", deck: "网络" });
    assert.equal(r1.ok, true); assert.equal(r1.url, "https://x/p/site1/");
    const created = published.find(p => p.op === "create");
    assert.ok(created.html.includes("<!doctype html>") && created.title === "网络 记忆卡片");
    const n = published.filter(p => p.op === "create" || p.op === "update").length;
    const r2 = await tool().run({ op: "page", deck: "网络" });
    assert.equal(r2.url, "https://x/p/site1/"); assert.match(r2.note, /没有变化/);
    assert.equal(published.filter(p => p.op === "create" || p.op === "update").length, n);
    const id = hub.db.prepare("SELECT id FROM fc_card").get().id;
    await tool().run({ op: "edit", card: id, back: "新答案" });
    const r3 = await tool().run({ op: "page", deck: "网络" });
    assert.match(r3.url, /\?v=/);
    assert.equal(published.at(-1).op, "update"); assert.equal(published.at(-1).id, "site1");
    assert.ok(published.at(-1).html.includes("新答案"));
  });
  test("if the page was deleted elsewhere, a new one is made", async () => {
    await tool().run({ op: "page", deck: "网络" });
    tools[0].run = async a => (a.op === "list" ? { ok: true, sites: [] } : a.op === "create" ? { ok: true, id: "site9", url: "https://x/p/site9/" } : { ok: true });
    assert.equal((await tool().run({ op: "page", deck: "网络" })).url, "https://x/p/site9/");
  });
  test("a refusal from publishing is passed on", async () => {
    tools[0].run = async a => (a.op === "list" ? { ok: true, sites: [] } : { ok: false, error: "今天发布网页的次数用完了，明天再来" });
    assert.match((await tool().run({ op: "page", deck: "网络" })).error, /次数用完/);
  });
});

// ---------- reminders ----------
describe("daily reminder", () => {
  const BJ = h => Date.parse("2026-11-15T00:00:00+08:00") + h * H;
  beforeEach(async () => {
    modelScript = () => reply(QA); await make({});
    now = BJ(10);
  });
  const remindOn = (who, extra = {}) => tool("t:a", [who]).run({ op: "remind", deck: "网络", mode: "on", time: "21:00", ...extra });

  test("off by default: nothing is sent", async () => {
    now = BJ(22); assert.deepEqual(await runReminders(hub, now), []);
    assert.equal(said.length, 0);
  });
  test("one short line at the set time naming each person's due count; once a day", async () => {
    await remindOn(P1); await tool("t:a", [P2]).run({ op: "remind", deck: "网络", mode: "join" });
    now = BJ(20.9); await runReminders(hub, now); assert.equal(said.length, 0);
    now = BJ(21.01);
    await runReminders(hub, now);
    assert.deepEqual(said, [{ conv: "t:a", text: "记忆卡片「网络」今天要复习：小明 3 张，小红 3 张。" }]);
    now = BJ(21.2); await runReminders(hub, now); now = BJ(23); await runReminders(hub, now);
    assert.equal(said.length, 1);
    now = BJ(24 + 21.01); await runReminders(hub, now);
    assert.equal(said.length, 2);
  });
  test("a person with nothing due is left out; when nobody has anything, nothing is said", async () => {
    await remindOn(P1); await tool("t:a", [P2]).run({ op: "remind", deck: "网络", mode: "join" });
    const ids = hub.db.prepare("SELECT id FROM fc_card").all().map(r => r.id);
    await tool("t:a", [P2]).run({ op: "answer", results: ids.map(card => ({ card, grade: "good" })) });
    now = BJ(21.01); await runReminders(hub, now);
    assert.equal(said[0].text, "记忆卡片「网络」今天要复习：小明 3 张。");
    now = BJ(24 + 10);   // next morning both have the cards due and review them: next due in 6 days
    for (const p of [P1, P2]) await tool("t:a", [p]).run({ op: "answer", results: ids.map(card => ({ card, grade: "good" })) });
    now = BJ(24 + 21.01); await runReminders(hub, now);
    assert.equal(said.length, 1);
    assert.equal(hub.db.prepare("SELECT remind_day FROM fc_deck").get().remind_day, "2026-11-16", "the day is marked even when nothing was said");
    now = BJ(24 * 7 + 21.01); await runReminders(hub, now);
    assert.equal(said.length, 2); assert.equal(said[1].text, "记忆卡片「网络」今天要复习：小明 3 张，小红 3 张。");
  });
  test("switching it on after today's time has passed starts tomorrow", async () => {
    now = BJ(22); await remindOn(P1);
    await runReminders(hub, now + 1000); assert.equal(said.length, 0);
    now = BJ(24 + 21.01); await runReminders(hub, now); assert.equal(said.length, 1);
  });
  test("a restart far past the time does not send a stale reminder, but the day is used up", async () => {
    await remindOn(P1);
    now = BJ(21 + 7); await runReminders(hub, now); assert.equal(said.length, 0);
    now = BJ(21 + 8); await runReminders(hub, now); assert.equal(said.length, 0);
  });
  test("off, leave, bad time", async () => {
    await remindOn(P1);
    assert.match((await remindOn(P1, { time: "25:00" })).error, /HH:MM/);
    await tool("t:a", [P1]).run({ op: "remind", deck: "网络", mode: "leave" });
    now = BJ(21.01); await runReminders(hub, now); assert.equal(said.length, 0);
    await remindOn(P1); await tool().run({ op: "remind", deck: "网络", mode: "off" });
    now = BJ(48); await runReminders(hub, now); assert.equal(said.length, 0);
    assert.equal(hub.db.prepare("SELECT remind_time FROM fc_deck").get().remind_time, "");
  });
  test("the tick hook and the admin route use the same rule", async () => {
    await remindOn(P1);
    now = BJ(21.01); await feature.tick(hub, now); await feature.tick(hub, now + 20000);
    assert.equal(said.length, 1);
    const res = await feature.admin(hub, {}, new URL("https://x/admin/flashcards/remind"), { conv: "t:a" });
    assert.equal((await res.json()).sent.length, 1);
    assert.equal(await feature.admin(hub, {}, new URL("https://x/admin/other"), {}), null);
  });
});

describe("shape", () => {
  test("schema, tunables, about, tool parameters", () => {
    for (const k of ["cards_make_daily", "cards_deck_max", "cards_new_daily"]) { const t = feature.tunables[k]; assert.ok(t.min <= t.default && t.default <= t.max && t.what); }
    assert.ok(feature.about.length >= 3);
    const t = tool();
    assert.equal(t.name, "flashcards"); assert.ok(/[一-鿿]/.test(t.description) && t.description.includes("quiz") && t.description.includes("page"));
    assert.ok(t.parameters.properties.op.enum.includes("export"));
    assert.equal(LIMITS.makeMax, 60);
  });
  test("unknown op", async () => assert.match((await tool().run({ op: "x" })).error, /op 只能/));
});
