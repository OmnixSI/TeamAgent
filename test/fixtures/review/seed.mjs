// D-3 hand-written seed fixture (D-1 not delivered yet). Same interface D-1 will replace:
// seedReviewDb() -> { DB, raw, log, addMessage, addOutbox, ... }
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);
const SCHEMA = readFileSync(new URL("schema.sql", ROOT), "utf8");
const REVIEW_MIGRATION = readFileSync(new URL("migrations/0008_review.sql", ROOT), "utf8");
const GROUP = "GROUP000001";
const BASE = Date.parse("2026-11-13T00:00:00.000Z");
const ms = (x) => typeof x === "number" ? x : x.includes("T") ? Date.parse(x) : Date.parse(t(x));

export const t = (hhmmss) => {
  const [h, m, s = "0"] = hhmmss.split(":").map(Number);
  return new Date(BASE + ((h * 60 + m) * 60 + s) * 1000).toISOString();
};

function wrap(raw) {
  const log = [];
  const database = {
    executed: 0,
    prepare(sql) {
      log.push(sql);
      const make = (args = []) => ({
        sql,
        bind(...values) { return make(values); },
        async first() { database.executed++; return raw.prepare(sql).get(...args) ?? null; },
        async all() { database.executed++; return { results: raw.prepare(sql).all(...args) }; },
        async run() { database.executed++; return raw.prepare(sql).run(...args); },
      });
      return make();
    },
    async batch(statements) {
      database.executed += statements.length;
      return Promise.all(statements.map((s) => (/\b(SELECT|WITH)\b/i.test(s.sql) ? s.all() : s.run())));
    },
  };
  return { DB: database, log };
}

const insertMessage = (raw, { id, body, ts, mentioned = 0, sender = "member1", processed = 0 }) =>
  raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,?)")
    .run(id, GROUP, sender, body, ts, mentioned, processed);

const insertOutbox = (raw, { id, msgId, body, status = "sent", at }) =>
  raw.prepare("INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(id, GROUP, msgId, body, status, ms(at));

const insertDecision = (raw, { id, latestId, batchIds = null, action = "reply", gate = "direct", spokenKind = "direct", reason = null, outboxId = null, modelMs = 120, at }) =>
  raw.prepare(
    "INSERT INTO chat_decisions(id,group_id,latest_id,batch_ids,mentioned,forced,waited,gate,action,spoken_kind,target_id,wait_seconds,reason,outbox_id,policy,model_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, GROUP, latestId, JSON.stringify(batchIds || [latestId]), 1, 0, 0, gate, action, spokenKind, null, null, reason, outboxId, "live", modelMs, ms(at));

const insertJob = (raw, { id, status = "done", error = null, at }) =>
  raw.prepare("INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,error,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, "chat", "{}", status, 1, 0, error, ms(at));

function seedScenario(raw) {
  // #13 / message 95: four bot segments inside 3 minutes, no user turn between them.
  insertMessage(raw, { id: "90", body: "晚上好", ts: t("09:00:00") });
  insertMessage(raw, { id: "94", body: "在吗", ts: t("09:02:00") });
  insertMessage(raw, { id: "95", body: "@小助手 今天有什么安排", ts: t("09:02:30"), mentioned: 1 });
  for (const [i, body] of ["今天先把群里的问题清一清。", "下午看仓库索引。", "晚上整理记忆。", "有变化我再更新。"].entries())
    insertOutbox(raw, { id: i ? `chat-95~${i}` : "chat-95", msgId: "95", body, at: t(`09:02:${40 + i * 10}`) });
  insertDecision(raw, { id: "d-95", latestId: "95", outboxId: "chat-95", at: t("09:02:39") });
  insertJob(raw, { id: "chat-95", at: t("09:02:30") });

  // outbox 145 / 149: same answer three times inside 30 minutes.
  const repeated = "分支我也看不到，抱歉。";
  for (const [id, at] of [["140", "10:00:00"], ["145", "10:05:00"], ["149", "10:10:00"]]) {
    insertMessage(raw, { id, body: id === "140" ? "帮我看看仓库分支" : id === "145" ? "那远端分支呢" : "再看看 main", ts: t(at) });
    insertOutbox(raw, { id: `chat-${id}`, msgId: id, body: repeated, at: t(at.slice(0, 6) + "10") });
    insertDecision(raw, { id: `d-${id}`, latestId: id, outboxId: `chat-${id}`, at: t(at.slice(0, 6) + "09") });
    insertJob(raw, { id: `chat-${id}`, at: t(at) });
  }

  // #20 / outbox 233: proactive long answer within 15 minutes of two S3 corrections.
  insertMessage(raw, { id: "230", body: "这个回答不对", ts: t("11:00:00") });
  insertMessage(raw, { id: "231", body: "怎么又这样", ts: t("11:03:00") });
  insertMessage(raw, { id: "233", body: "@小助手 帮我看看 B 站那个视频", ts: t("11:05:00"), mentioned: 1 });
  insertOutbox(raw, {
    id: "chat-233", msgId: "233", at: t("11:05:30"),
    body: "这个视频讲的是三体动画的幕后制作，时长 12 分钟，评论区在讨论改编。",
  });
  insertDecision(raw, { id: "d-233", latestId: "233", spokenKind: "proactive", outboxId: "chat-233", at: t("11:05:29") });
  insertJob(raw, { id: "chat-233", at: t("11:05:00") });

  // #3 / messages 338-339: the second answer repeats the previous answer verbatim.
  const weather = "明天悉尼多云，22 度，可能有阵雨。";
  insertMessage(raw, { id: "335", body: "今天天气怎么样", ts: t("12:00:00") });
  insertOutbox(raw, { id: "chat-335", msgId: "335", body: "今天悉尼晴，20 度，适合出门。", at: t("12:00:10") });
  insertDecision(raw, { id: "d-335", latestId: "335", outboxId: "chat-335", at: t("12:00:09") });
  insertJob(raw, { id: "chat-335", at: t("12:00:00") });
  insertMessage(raw, { id: "338", body: "明天呢", ts: t("12:05:00") });
  insertOutbox(raw, { id: "chat-338", msgId: "338", body: weather, at: t("12:05:10") });
  insertDecision(raw, { id: "d-338", latestId: "338", outboxId: "chat-338", at: t("12:05:09") });
  insertJob(raw, { id: "chat-338", at: t("12:05:00") });
  insertMessage(raw, { id: "339", body: "那后天呢", ts: t("12:10:00") });
  insertOutbox(raw, { id: "chat-339", msgId: "339", body: weather, at: t("12:10:10") });
  insertDecision(raw, { id: "d-339", latestId: "339", outboxId: "chat-339", at: t("12:10:09") });
  insertJob(raw, { id: "chat-339", at: t("12:10:00") });

  // #17 / messages 428-432: one decision batch, first addressed message 428, reply 21 minutes later.
  insertMessage(raw, { id: "425", body: "随便聊聊", ts: t("13:00:00") });
  const mentions = [
    ["428", "20:49:36", "@小助手 说话", 1],
    ["429", "20:50:37", "这不会 mausbot 给我改坏了吧", 0],
    ["430", "20:50:43", "改的下线了", 0],
    ["431", "21:03:13", "666", 0],
    ["432", "21:03:20", "", 1],
  ];
  for (const [id, at, body, mentioned] of mentions) insertMessage(raw, { id, body, ts: t(at), mentioned });
  insertOutbox(raw, {
    id: "chat-432", msgId: "432", at: t("21:11:15"),
    body: "在呢，没被改坏也没掉线，刚才那几条我都没看见。",
  });
  insertDecision(raw, {
    id: "d-432", latestId: "432", batchIds: ["428", "429", "430", "431", "432"],
    outboxId: "chat-432", at: t("21:11:14"),
  });
  insertJob(raw, { id: "chat-432", at: t("20:49:36") });

  // #2 / message 434: capability self-description.
  insertMessage(raw, { id: "434", body: "@小助手 你能做什么", ts: t("21:12:55"), mentioned: 1 });
  insertOutbox(raw, {
    id: "chat-434", msgId: "434", at: t("21:13:10"),
    body: "我能帮你查仓库提交、看 B 站视频、搜网页，也可以帮你整理文件。",
  });
  insertDecision(raw, { id: "d-434", latestId: "434", outboxId: "chat-434", at: t("21:13:09") });
  insertJob(raw, { id: "chat-434", at: t("21:12:55") });

  // Health samples: one per hour, plus the 13:40 sample nearest to message 434.
  for (const [at, gateway, runner] of [
    ["09:00:00", 1, 1], ["10:00:00", 1, 1], ["11:00:00", 1, 0],
    ["12:00:00", 0, 1], ["13:00:00", 1, 1], ["13:40:00", 1, 1],
  ])
    raw.prepare("INSERT INTO health_samples VALUES(?,?,?,?,?)").run(Date.parse(t(at)), gateway, runner, 0, 0);
}

export function seedReviewDb({ review = false, seed = true } = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  if (review) raw.exec(REVIEW_MIGRATION);
  if (seed) seedScenario(raw);
  const { DB, log } = wrap(raw);
  const addMessage = (row) => insertMessage(raw, { sender: "member1", processed: 0, ...row, ts: row.ts || t(row.at) });
  const addOutbox = (row) => insertOutbox(raw, row);
  const addDecision = (row) => insertDecision(raw, row);
  const addJob = (row) => insertJob(raw, row);
  return { DB, raw, log, addMessage, addOutbox, addDecision, addJob, GROUP };
}

export { GROUP };
