import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { worker, env, req, qq, msg } from "./support.mjs";

async function bundle(name) {
  const outfile = `.wrangler/p0-${name}-${process.pid}.mjs`;
  await build({ entryPoints: [`src/${name}.ts`], bundle: true, format: "esm", platform: "browser", outfile });
  return import("../" + outfile);
}
const ib = await bundle("inbound"), view = await bundle("view"), context = await bundle("context");
const { redact } = await bundle("runtime"), { extractUrls } = await bundle("policy");
const { rememberCorrection } = await bundle("memory"), { phraseCandidates } = await bundle("learning");
const { agentAnswer, proactiveReply } = await bundle("semantic");
const group = "GROUP000001", names = new Map([["U1", "阿明"], ["U2", "小王"]]);
const card = (title = "T", url = "https://b23.tv/new") => ({ ark_type: "miniapp", ark_name: "哔哩哔哩", fields: { title, jump_url: url } });
async function setup() { const e = env(); await req(e, "/api/admin/bind", { groupId: group }); return e; }
async function meta(e, id) { return JSON.parse((await e.DB.prepare("SELECT json FROM message_meta WHERE id=?").bind(id).first()).json); }
async function queue(e, id) { await worker.queue({ messages: [{ body: { id }, ack() {} }] }, e); }
const row = (id, sender = "U1", body = "原话", extra = {}) => ({ id, sender, body, ts: "2026-11-11T23:00:05+11:00", ordinal: 1, ...extra });
const answer = (content) => Response.json({ choices: [{ message: typeof content === "string" ? { content } : content }] });
async function mocked(run, decide = () => '{"should_reply":true,"kind":"direct","brief":"已核实"}') {
  const original = globalThis.fetch, seen = { participation: [], voice: [] };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/v1/tools/search")) return Response.json({ results: [{ url: "https://example.com", content: "资料" }] });
    const body = JSON.parse(options.body);
    if (body.messages[0].content.includes("最后的嘴替模块")) {
      seen.voice.push(JSON.parse(body.messages[1].content));
      return answer('{"mode":"work","text":"收到资料。"}');
    }
    seen.participation.push(body);
    return answer(await decide(body, seen.participation.length));
  };
  try { await run(seen); } finally { globalThis.fetch = original; }
}

test("A1 body equals legacy expression for twenty inputs; ext retains trailing equals", () => {
  const inputs = [undefined, null, "", " ", "<@BOT> 你好", " <@!BOT> 你好 ", "<@U2> 帮忙", "前面 <@U2> 后面", "sk-abcdefghijklmnopqr", "[<face,id=1/>]", '<faceType=1,faceId=2,ext="x">', "\n多行\n消息\n", "<@BOT><@U2> 你好", "@小王", "<> 文字", "<@x>\n", "https://b23.tv/abc", "中文😀", "密码=abcdef", 123];
  for (const content of inputs) assert.equal(ib.parseInbound("GROUP_MESSAGE_CREATE", { content }).body, redact(String(content || "")).replace(/^\s*<@!?[^>]+>\s*/, "").trim());
  assert.deepEqual(ib.parseExt(["msg_idx=I==", "bad", null]), { msg_idx: "I==" });
  const parsed = ib.parseInbound("GROUP_MESSAGE_CREATE", { message_type: 103, message_scene: { ext: ["ref_msg_idx=old"] }, msg_elements: [{ msg_idx: "new==" }] });
  assert.equal(parsed.refMsgIdx, "new==");
});
test("A2 empty card/image/voice bodies stay empty; placeholders and ASR live in meta", async () => {
  const e = await setup();
  for (const [id, extra, placeholder] of [["card", { ark_data: card() }, "[卡片] 哔哩哔哩：T"], ["image", { attachments: [{ content_type: "image/png", width: 640, height: 480 }] }, "[图片]"], ["voice", { attachments: [{ content_type: "audio/ogg", asr_refer_text: "明天开会" }] }, "[语音]"]]) {
    await qq(e, { ...msg(id, ""), ...extra });
    assert.equal((await e.DB.prepare("SELECT body FROM messages WHERE id=?").bind(id).first()).body, "");
    assert.equal((await meta(e, id)).placeholder, placeholder);
  }
  assert.equal((await meta(e, "voice")).media[0].asr, "明天开会");
});
test("A3 ASR cannot be correction evidence", async () => {
  await assert.rejects(rememberCorrection(env(), { repo: "team", quote: "明天开会", subject: "日程", predicate: "时间", value: "明天" }, { id: "voice", body: "", meta: { direct: true, media: [{ asr: "明天开会" }] } }), /需要当前发言中的逐字纠正依据/);
});
async function taskEvidence(tool, quote, mentionName = "小王") {
  const e = await setup(), source = row("evidence", "U1", "<@U2> 帮我整理成文档", { group_id: group, meta: { direct: true, can_request_artifact: true, mentions: [{ id: "U2", name: mentionName, isBot: false }], placeholder: "[图片]", cardView: card("卡片标题") } });
  await e.DB.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,0)").bind(source.id, group, source.sender, source.body, source.ts, 0).run();
  let toolResult;
  await mocked(async () => { await agentAnswer(e, { latest: source, batch: [source], recent: [source], names, refs: new Map(), background: true }); }, (body, n) => {
    if (n === 1) return { role: "assistant", tool_calls: [{ id: "evidence-tool", type: "function", function: { name: tool, arguments: JSON.stringify({ repo: "OmnixSI/TeamAgent", title: "整理", detail: "整理说明", instructions: "整理说明", source_id: source.id, request_quote: quote, quote, subject: "协作", predicate: "负责人", value: "小王" }) } }] };
    toolResult = JSON.parse(body.messages.find(m => m.role === "tool").content);
    return '{"should_reply":true,"kind":"direct","brief":"结果已核实"}';
  });
  const created = tool === "create_file_task"
    ? await e.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE id='utility-evidence'").first()
    : tool === "remember_correction"
      ? await e.DB.prepare("SELECT COUNT(*) n FROM facts WHERE source_id='evidence'").first()
      : await e.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE id='qq-evidence'").first();
  assert.equal(created.n, toolResult.accepted || toolResult.remembered ? 1 : 0);
  return toolResult;
}
test("A4 create_file_task accepts rendered mention only; rejects synthetic material", async () => {
  assert.equal((await taskEvidence("create_file_task", "@小王 帮我整理成文档")).accepted, true);
  for (const quote of ["[图片]", "卡片标题"]) assert.equal((await taskEvidence("create_file_task", quote)).unavailable, true);
});
test("A5 prepare_project_task accepts rendered mention and rejects card evidence", async () => {
  const accepted = await taskEvidence("prepare_project_task", "@小王 帮我整理成文档");
  assert.equal(accepted.accepted, true);
  assert.equal((await taskEvidence("prepare_project_task", "卡片标题")).unavailable, true);
});
test("A6 expression mining never sees placeholders or ASR", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: String(i), sender: String(i % 2), body: "", meta: { placeholder: i % 2 ? "[语音]" : "[图片]", media: [{ asr: "明天开会" }] } }));
  assert.deepEqual(phraseCandidates(rows), []);
  assert.equal(view.quoteIn(rows[0], "明天开会"), false);
});
test("A7 source API keeps the original empty body", async () => {
  const e = await setup(); await qq(e, { ...msg("source-card", ""), ark_data: card() });
  assert.equal((await (await req(e, "/api/team/source?id=source-card")).json()).body, "");
});
const quotedEvent = () => ({ ...msg("quoted", "看看这个"), message_type: 103, msg_elements: [{ content: "https://b23.tv/old", author: { id: "U1", username: "阿明" } }] });
test("B1 quoted video URLs are material and create no automatic media job", async () => {
  const e = await setup(); await qq(e, quotedEvent());
  assert.equal(await e.DB.prepare("SELECT id FROM jobs WHERE id='media-quoted'").first(), null);
  assert.deepEqual((await meta(e, "quoted")).quotedUrls, ["https://b23.tv/old"]);
});
test("B2 top-level card triggers only its own new URL", async () => {
  const e = await setup(); await qq(e, { ...quotedEvent(), ark_data: card() });
  assert.deepEqual(JSON.parse((await e.DB.prepare("SELECT payload FROM jobs WHERE id='media-quoted'").first()).payload).urls, ["https://b23.tv/new"]);
});
test("B3 directly pasted video URL still triggers processing", async () => {
  const e = await setup(); await qq(e, msg("video", "https://www.bilibili.com/video/BV1234567890"));
  assert.ok(await e.DB.prepare("SELECT id FROM jobs WHERE id='media-video'").first());
});
test("B4 ownUrls equal legacy extraction; Bili parsing is domain bounded", () => {
  for (const d of [quotedEvent(), { ...quotedEvent(), ark_data: card() }, msg("video", "https://b23.tv/a")]) {
    const p = ib.parseInbound("GROUP_MESSAGE_CREATE", d);
    assert.deepEqual(p.ownUrls, extractUrls(p.body + " " + JSON.stringify(d.ark_data || {})));
  }
  assert.equal(ib.extractBili(["https://evil.test/BV1234567890"], "BV1234567890").length, 0);
  assert.equal(ib.extractBili(["https://www.bilibili.com/video/BV1234567890", "https://b23.tv/abc", "https://bilibili.com/video/av123"], "").length, 3);
});
async function memberReply(e, filler = 0, body = "A 的原文") {
  await qq(e, { ...msg("A", body), author: { member_openid: "U1", username: "阿明" }, message_scene: { ext: ["msg_idx=I1"] } });
  for (let i = 0; i < filler; i++) await qq(e, msg("filler-" + i, "背景"));
  await qq(e, { ...msg("B", "说 <@U2> 你觉得呢"), author: { member_openid: "U3", username: "小李" }, mentions: [{ member_openid: "U2", nickname: "小王" }], message_type: 103, message_scene: { ext: ["msg_idx=I2", "ref_msg_idx=I1"] }, msg_elements: [{ msg_idx: "I1", content: "A 的原文" }] });
}
test("C1 reply author outranks mention and links member IDs in a thread", async () => {
  const e = await setup(); await memberReply(e);
  const reply = (await meta(e, "B")).replyTo;
  assert.equal(reply.kind, "member"); assert.equal(reply.targetId, "A"); assert.equal(reply.authorId, "U1");
  await mocked(async seen => {
    await queue(e, "chat-B");
    const conversation = JSON.parse(seen.participation[0].messages[1].content).conversation;
    const b = conversation.find(v => v.id === "B"), a = conversation.find(v => v.id === "A");
    assert.equal(b.to, "阿明"); assert.equal(b.re, "A"); assert.equal(b.th, a.th); assert.ok(b.th);
    assert.ok(!("sortAt" in b)); assert.ok(!("ord" in b));
  });
});
test("C2 out-of-window reference is batch loaded with author and original quote", async () => {
  const e = await setup(), original = "A 的原文" + "长引用".repeat(100); await memberReply(e, 30, original);
  const ctx = await context.loadChatContext(e, { groupId: group, cursor: 30 });
  const b = context.buildViews(ctx, []).latestView;
  assert.equal(b.re, "A"); assert.equal(b.material.quote.from, "阿明"); assert.equal(b.material.quote.text, original.slice(0, 200));
});
async function sendBot(e, withRef) {
  e.QQ_APP_ID = "p0-test";
  await e.DB.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)").bind("bot-original", group, null, "机器人的原话", "pending", Date.now()).run();
  const original = globalThis.fetch;
  globalThis.fetch = async url => Response.json(String(url).includes("getAppAccessToken") ? { access_token: "mock", expires_in: 300 } : { id: "x", ...(withRef ? { ext_info: { ref_idx: "R9" } } : {}) });
  try { await worker.queue({ messages: [] }, e); } finally { globalThis.fetch = original; delete e.QQ_APP_ID; }
}
test("C3 bot references persist and force a response with matching b: view IDs", async () => {
  const e = await setup(); await sendBot(e, true);
  await qq(e, { ...msg("reply-bot", "继续说"), message_scene: { ext: ["ref_msg_idx=R9"] } });
  assert.equal((await meta(e, "reply-bot")).replyTo.kind, "bot");
  await mocked(async seen => {
    await queue(e, "chat-reply-bot");
    const conv = JSON.parse(seen.participation[0].messages[1].content).conversation, reply = conv.find(v => v.id === "reply-bot");
    assert.equal(reply.to, "你"); assert.equal(reply.re, "b:bot-original"); assert.ok(reply.flags.includes("quotesYou"));
    assert.ok(conv.find(v => v.id === reply.re)); assert.equal(seen.voice.length, 1);
  }, () => '{"should_reply":false,"kind":"proactive","brief":""}');
});
test("C4 send response without ref_idx remains compatible", async () => {
  const e = await setup(); await sendBot(e, false);
  assert.equal((await e.DB.prepare("SELECT * FROM message_refs").all()).results.length, 0);
  assert.equal((await e.DB.prepare("SELECT status FROM outbox").first()).status, "sent");
});
test("C5 unresolved quoted author still supplies an addressee", async () => {
  const e = await setup(); await qq(e, { ...quotedEvent(), message_scene: { ext: ["ref_msg_idx=missing"] } });
  const m = await meta(e, "quoted"); assert.equal(m.replyTo.kind, "unknown"); assert.equal(view.addressee(m, names), "阿明");
});
test("C6 mention edges connect only to the latest preceding speaker; isolated rows have no thread", () => {
  const rows = [row("a1"), row("a2", "U1", "第二句", { ordinal: 2 }), row("c", "U3", "@你", { ordinal: 3, meta: { mentions: [{ id: "U1", name: "阿明" }] } }), row("alone", "U4", "@没出现", { ordinal: 4, meta: { mentions: [{ id: "U9" }] } })];
  const result = view.buildConversation(rows.map(r => view.viewMessage(r, names, new Map())), []);
  assert.equal(result[0].th, undefined); assert.equal(result[1].th, result[2].th); assert.ok(result[1].th); assert.equal(result[3].th, undefined);
});
test("D1 midnight ordering uses milliseconds and dates are display-only", () => {
  const a = view.viewMessage(row("a", "U1", "前", { ts: "2026-11-11T23:59:30+11:00" }), names, new Map());
  const b = view.botView({ id: "b", body: "中", created_at: Date.parse("2026-11-11T23:59:50+11:00") });
  const c = view.viewMessage(row("c", "U2", "后", { ts: "2026-11-12T00:01:10+11:00" }), names, new Map());
  const result = view.buildConversation([c, a], [b]);
  assert.deepEqual(result.map(v => v.id), ["a", "b:b", "c"]); assert.match(result[0].at, /^11-11 /); assert.match(result[1].at, /^11-11 /); assert.equal(result[2].at, "00:01");
});
test("D2 same-minute ordering preserves seconds", () => {
  const members = [5, 40].map(n => view.viewMessage(row(String(n), "U1", "", { ts: `2026-11-12T10:00:${n === 5 ? "05" : n}+11:00` }), names, new Map()));
  const bot = view.botView({ id: "20", body: "", created_at: Date.parse("2026-11-12T10:00:20+11:00") });
  assert.deepEqual(view.buildConversation(members, [bot]).map(v => v.id), ["5", "b:20", "40"]);
});
test("D3 equal-time members precede bot; rowid breaks member ties; limit follows sorting", () => {
  const members = [2, 1].map(ordinal => view.viewMessage(row(String(ordinal), "U1", "", { ordinal }), names, new Map()));
  const bot = view.botView({ id: "bot", body: "", created_at: members[0].sortAt });
  assert.deepEqual(view.buildConversation(members, [bot]).map(v => v.id), ["1", "2", "b:bot"]);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...members[0], id: String(i), sortAt: i }));
  assert.deepEqual(view.buildConversation(many.reverse(), []).map(v => v.sortAt), Array.from({ length: 32 }, (_, i) => i + 8));
});
async function researchFixture(check, resume) {
  const e = await setup(); await qq(e, { ...msg("research", "问 <@U2> 最新资料"), mentions: [{ id: "U2", nickname: "小王" }] }, "GROUP_AT_MESSAGE_CREATE");
  await mocked(async seen => {
    await queue(e, "chat-research");
    const job = await e.DB.prepare("SELECT * FROM jobs WHERE id='research-research'").first(); assert.ok(job);
    if (resume) await queue(e, job.id);
    await check(seen, e);
  }, (_body, n) => n === 1 ? { role: "assistant", tool_calls: [{ id: "search", type: "function", function: { name: "search_web", arguments: '{"query":"资料"}' } }] } : '{"should_reply":true,"kind":"direct","brief":"查到资料"}');
}
function structuredVoice(v) { assert.ok(v.recent.length); for (const m of v.recent) { assert.ok(m.from); assert.equal(m.metadata, undefined); assert.equal(m.sortAt, undefined); } }
test("E1 background handoff voice receives structured recent context", async () => researchFixture(seen => { assert.equal(seen.voice.length, 1); structuredVoice(seen.voice[0]); }, false));
test("E2 research resume voice retains views and rendered mentions", async () => researchFixture(seen => { assert.equal(seen.voice.length, 2); structuredVoice(seen.voice[1]); assert.equal(seen.voice[1].latest, "问 @小王 最新资料"); }, true));
test("E3 voice_notice uses view text", async () => {
  const e = await setup(); await qq(e, { ...msg("notice", "问 <@U2>"), mentions: [{ id: "U2", nickname: "小王" }] });
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)").bind("notice-job", "voice_notice", JSON.stringify({ message: "notice", result: "已处理" }), Date.now()).run();
  await mocked(async seen => { await queue(e, "notice-job"); assert.equal(seen.voice[0].latest, "问 @小王"); });
});
test("E4 proactive reply uses structured conversation", async () => {
  const e = await setup(); await qq(e, msg("proactive", "分享资料"));
  await mocked(async seen => { await proactiveReply(e, { source: "proactive", context: "资料" }, {}); const c = JSON.parse(seen.participation[0].messages[1].content).conversation; assert.ok(c.length); assert.ok(c.every(v => v.from)); });
});
test("F1 schema can replay twice over old data without changing positional inserts", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8"), old = schema.replace(/CREATE TABLE IF NOT EXISTS (?:message_refs|member_names)\([^;]+;/g, ""), d = new DatabaseSync(":memory:");
  try {
    d.exec(old); d.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("old", group, "U1", "原文", "2026-11-11", 0, 0);
    d.exec(schema); d.exec(schema);
    d.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("new", group, "U1", "新原文", "2026-11-12", 0, 0);
    d.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)").run("old-bot", group, null, "原话", "pending", 1);
    assert.equal(d.prepare("SELECT body FROM messages WHERE id='old'").get().body, "原文");
    assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='message_refs'").get());
  } finally { d.close(); }
});
test("F2 manual member names survive QQ refresh while QQ names update", async () => {
  const e = await setup();
  for (const [id, source] of [["U1", "manual"], ["U2", "qq"]]) await e.DB.prepare("INSERT INTO member_names VALUES(?,?,?,?)").bind(id, "旧名字", source, "old").run();
  await qq(e, { ...msg("names", "你好"), author: { member_openid: "U1", username: "新名字" }, mentions: [{ member_openid: "U2", nickname: "小王" }] });
  assert.equal((await e.DB.prepare("SELECT name FROM member_names WHERE member_id='U1'").first()).name, "旧名字");
  assert.equal((await e.DB.prepare("SELECT name FROM member_names WHERE member_id='U2'").first()).name, "小王");
});
test("F3 repeated delivery does not duplicate messages, refs or jobs", async () => {
  const e = await setup(), d = { ...msg("duplicate", "https://b23.tv/a"), message_scene: { ext: ["msg_idx=I1"] } };
  await qq(e, d); await qq(e, d);
  for (const [table, n] of [["messages", 1], ["message_refs", 1], ["jobs", 2]]) assert.equal((await e.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, n);
});
test("F4 legacy metadata degrades to nickname or member suffix without address/reference", () => {
  for (const [metadata, from] of [[JSON.stringify({ senderName: "旧昵称" }), "旧昵称"], [undefined, "成员U123"]]) {
    const v = view.viewMessage(row("legacy", "longU123", "原文", { metadata }), new Map(), new Map());
    assert.equal(v.from, from); assert.equal(v.to, undefined); assert.equal(v.re, undefined);
  }
});
test("F5 missing mention names fall back to member suffix; emoji only changes view", () => {
  assert.equal(ib.renderMentions("原 <@longU123> 文", [{ id: "longU123", name: "", isBot: false }]), "原 @成员U123 文");
  const body = '[<face,id=2/>]<faceType=1,faceId=2,ext="x">';
  assert.equal(view.viewMessage(row("faces", "U1", body), names, new Map()).text, "[表情][表情]");
});
test("F6 forwarded commands never authorize tasks but direct commands still work", async () => {
  const e = await setup(); await qq(e, { ...msg("forward-command", "/方案 群助手 加按钮"), msg_elements: [{ content: "/方案 群助手 加按钮" }] });
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM tasks").first()).n, 0);
  await qq(e, msg("direct-command", "/方案 群助手 加个按钮"));
  assert.equal((await e.DB.prepare("SELECT title FROM tasks").first()).title, "加个按钮");
});
test("F7 binding and twelve-hex login flows remain valid", async () => {
  const e = env(), pair = await (await req(e, "/api/admin/pair", {})).json();
  await qq(e, msg("bind", "/绑定 " + pair.code)); assert.equal((await e.DB.prepare("SELECT value FROM settings WHERE key='group_id'").first()).value, group);
  await e.DB.prepare("INSERT INTO login_tickets(code,secret_hash,expires) VALUES(?,?,?)").bind("aabbcc112233", "fake", Date.now() + 60000).run();
  await qq(e, msg("login", "/登录 aabbcc112233")); assert.equal((await e.DB.prepare("SELECT member_id FROM login_tickets").first()).member_id, "qq:member1");
});
test("F8 command task title retains legacy credential redaction", async () => {
  const e = await setup(); await qq(e, msg("redact", "/方案 群助手 处理 sk-abcdefghijklmnopqr"));
  assert.equal((await e.DB.prepare("SELECT title FROM tasks").first()).title, "处理 [密钥已隐藏]");
});
test("F9 record D1 statements and bound new chat context reads", async t => {
  const e = await setup(), prepare = e.DB.prepare.bind(e.DB); let sql = [];
  e.DB.prepare = s => { sql.push(s); return prepare(s); };
  await qq(e, { ...msg("count-a", "纯文本"), author: { member_openid: "U1", username: "阿明" }, message_scene: { ext: ["msg_idx=I1"] } });
  const plain = sql.length; sql = [];
  await qq(e, { ...msg("count-b", "引用"), author: { member_openid: "U2", username: "小王" }, message_scene: { ext: ["msg_idx=I2", "ref_msg_idx=I1"] } });
  const quoted = sql.length; sql = [];
  await context.loadChatContext(e, { groupId: group, cursor: 0 });
  const extra = sql.filter(s => /member_names|FROM messages WHERE id IN|FROM outbox WHERE id IN/.test(s)).length;
  assert.ok(extra <= 4);
  sql = [];
  await mocked(async () => { await queue(e, "chat-count-b"); });
  const chatExtra = sql.filter(s => /member_names|FROM messages WHERE id IN|FROM outbox WHERE id IN/.test(s)).length;
  assert.ok(chatExtra <= 4);
  t.diagnostic(`D1 statements: plain=${plain}, quoted=${quoted}, added context reads=${extra}, added chat reads=${chatExtra}`);
});

test("P2-1 ARK field names preserve card identity, source label and legacy compatibility", async () => {
  const parsed = ib.parseCard(card());
  assert.equal(parsed.type, "miniapp");
  assert.equal(parsed.name, "哔哩哔哩");
  assert.equal(ib.parseCard({ type: "legacy", name: "旧卡片" }).name, "旧卡片");
  const canonical = ib.parseCard({ ...card(), type: "legacy", name: "旧名" });
  assert.equal(canonical.type, "miniapp"); assert.equal(canonical.name, "哔哩哔哩");
  const e = await setup(), ark = { ...card(), ark_name: "miniapp", fields: { ...card().fields, source: "哔哩哔哩" } };
  await qq(e, { ...msg("ark-fields", ""), ark_data: ark });
  const m = await meta(e, "ark-fields");
  assert.equal(m.placeholder, "[卡片] 哔哩哔哩：T");
  assert.equal(m.cardView.type, "miniapp"); assert.equal(m.cardView.name, "miniapp");
  assert.equal((await e.DB.prepare("SELECT body FROM messages WHERE id='ark-fields'").first()).body, "");
});

test("P2-2 voice attachment without ASR renders as voice rather than file", async () => {
  const e = await setup();
  for (const [id, attachment] of [["voice-no-asr", { content_type: "voice" }], ["voice-empty-asr", { content_type: "voice", asr_refer_text: "" }]]) {
    await qq(e, { ...msg(id, ""), attachments: [attachment] });
    const m = await meta(e, id);
    assert.equal(m.media[0].kind, "voice"); assert.equal(m.placeholder, "[语音]");
    const v = view.viewMessage(row(id, "U1", "", { meta: m }), names, new Map());
    assert.equal(v.text, "[语音]"); assert.deepEqual(v.material.media, ["语音"]);
    assert.equal((await e.DB.prepare("SELECT body FROM messages WHERE id=?").bind(id).first()).body, "");
  }
});

test("P2-3 cached mention names match view evidence for correction, file and project tools", async () => {
  const source = row("names-evidence", "U1", "<@U2> 帮我整理成文档", { meta: { mentions: [{ id: "U2", name: "", isBot: false }], placeholder: "[图片]", cardView: { title: "卡片标题" }, media: [{ kind: "voice", asr: "转写内容" }] } });
  const v = view.viewMessage(source, names, new Map());
  assert.equal(v.text, "@小王 帮我整理成文档");
  assert.equal(view.quoteIn(source, v.text, names), true);
  assert.equal(view.quoteIn(source, source.body, names), true);
  assert.equal(view.quoteIn(source, "@其他人 帮我整理成文档", names), false);
  for (const quote of ["[图片]", "卡片标题", "转写内容"]) assert.equal(view.quoteIn(source, quote, names), false);
  for (const tool of ["create_file_task", "prepare_project_task", "remember_correction"]) {
    const result = await taskEvidence(tool, v.text, "");
    assert.equal(tool === "remember_correction" ? result.remembered : result.accepted, true, tool);
    assert.equal((await taskEvidence(tool, "[图片]", "")).unavailable, true, tool);
  }
});

test("P2-4 forwarded material without ref_msg_idx never sets replyTo or addressee", async () => {
  const e = await setup(), d = { ...quotedEvent(), message_type: 0 };
  await qq(e, d);
  const m = await meta(e, d.id);
  assert.equal(m.refMsgIdx, undefined); assert.equal(m.replyTo, undefined);
  assert.equal(m.quoted.authorName, "阿明"); assert.deepEqual(m.quotedUrls, ["https://b23.tv/old"]);
  const v = view.viewMessage(row(d.id, "U3", d.content, { meta: m }), names, new Map());
  assert.equal(v.to, undefined); assert.equal(v.re, undefined);
  assert.equal(v.material.quote.from, "阿明"); assert.equal(v.material.quote.text, "https://b23.tv/old");
  assert.equal(await e.DB.prepare("SELECT id FROM jobs WHERE id='media-quoted'").first(), null);
});
