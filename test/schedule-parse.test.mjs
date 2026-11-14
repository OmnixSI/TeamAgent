import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// D2：日程 v2 的时间解析（纯函数）。先红后绿；不碰 D1/Worker/QQ。
const out = await build({
  entryPoints: ["src/schedule-parse.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const { parseWhen, parseContent, describeWhen } = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);

// 2026-11-14 17:48 悉尼（AEDT，UTC+11）。周六。
const NOW = Date.parse("2026-11-14T06:48:00Z");
const SYD = "Australia/Sydney";
const SHA = "Asia/Shanghai";
const UTC = "UTC";

function expectWhen(name, text, when, extra = {}) {
  test(name, () => {
    const r = parseWhen(text, extra.now ?? NOW, extra.defaultTz);
    assert.equal(r && r.ok, true, `${text} -> ${JSON.stringify(r)}`);
    assert.deepEqual(r.when, when, text);
    if ("tzSaid" in extra) assert.equal(r.tzSaid, extra.tzSaid, text);
    if ("matched" in extra) assert.equal(r.matched, extra.matched, text);
  });
}

function expectBad(name, text, want, extra = {}) {
  test(name, () => {
    assert.deepEqual(parseWhen(text, extra.now ?? NOW, extra.defaultTz), want, text);
  });
}

function expectContent(name, text, want) {
  test(name, () => {
    assert.deepEqual(parseContent(text), want, text);
  });
}

function expectDescribe(name, when, want, now = NOW) {
  test(name, () => {
    assert.equal(describeWhen(when, now), want);
  });
}

// ---------- 施工单硬例（真实群聊，一字不差） ----------

expectWhen(
  "硬例：每天北京时间0点发DeepSeek余额",
  "每天北京时间0点在群里发DeepSeek余额即可",
  { cadence: "daily", time: "00:00", tz: SHA },
  { tzSaid: true, matched: "每天北京时间0点" }
);
expectWhen(
  "硬例：悉尼时间每天早上8点推昨日总结",
  "悉尼时间每天早上8点在群里推送昨日聊天内容总结，一定要精简。",
  { cadence: "daily", time: "08:00", tz: SYD },
  { tzSaid: true, matched: "悉尼时间每天早上8点" }
);
expectBad(
  "硬例：每天在固定时间发（缺时间）",
  "每天在固定时间发一下每天的余额和 token 用量",
  { ok: false, missing: "time" }
);
expectWhen(
  "硬例：十分钟后",
  "你先闭嘴10分钟bot设个定时任务十分钟后再说话",
  { cadence: "once", run_at: NOW + 10 * 60000, tz: SYD },
  { tzSaid: false, matched: "十分钟后" }
);
expectWhen("硬例：每月1号早上9点", "每月1号早上9点把上个月报销账单发群里", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1],
  tz: SYD,
});
expectWhen("硬例：月底晚上8点", "月底晚上8点发账单", {
  cadence: "monthly",
  time: "20:00",
  month_days: [-1],
  tz: SYD,
});
expectWhen(
  "硬例：明天下午3点",
  "明天下午3点提醒我交周报",
  { cadence: "once", run_at: Date.parse("2026-11-15T04:00:00Z"), tz: SYD },
  { tzSaid: false, matched: "明天下午3点" }
);
expectWhen(
  "硬例：每周一北京时间9点",
  "每周一北京时间9点发上周聊天总结",
  { cadence: "weekly", time: "09:00", weekdays: [1], tz: SHA },
  { tzSaid: true, matched: "每周一北京时间9点" }
);
expectWhen(
  "硬例：每30分钟到晚上10点为止",
  "每30分钟提醒我喝水，到晚上10点为止",
  {
    cadence: "every",
    every_minutes: 30,
    until: Date.parse("2026-11-14T11:00:00Z"),
    tz: SYD,
  },
  { tzSaid: false, matched: "每30分钟" }
);

// ---------- 钟点：阿拉伯/中文/半点/刻/分/整 ----------

expectWhen("钟点：0点", "每天0点发", { cadence: "daily", time: "00:00", tz: SYD });
expectWhen("钟点：零点", "每天零点发", { cadence: "daily", time: "00:00", tz: SYD });
expectWhen("钟点：午夜", "每天午夜发", { cadence: "daily", time: "00:00", tz: SYD });
expectWhen("钟点：半夜", "每天半夜发", { cadence: "daily", time: "00:00", tz: SYD });
expectWhen("钟点：半夜12点", "每天半夜12点发", { cadence: "daily", time: "00:00", tz: SYD });
expectWhen("钟点：3点半", "每天3点半发", { cadence: "daily", time: "03:30", tz: SYD });
expectWhen("钟点：8点一刻", "每天8点一刻发", { cadence: "daily", time: "08:15", tz: SYD });
expectWhen("钟点：8点三刻", "每天8点三刻发", { cadence: "daily", time: "08:45", tz: SYD });
expectWhen("钟点：8点15分", "每天8点15分发", { cadence: "daily", time: "08:15", tz: SYD });
expectWhen("钟点：8点零5分", "每天8点零5分发", { cadence: "daily", time: "08:05", tz: SYD });
expectWhen("钟点：8点整", "每天8点整发", { cadence: "daily", time: "08:00", tz: SYD });
expectWhen("钟点：23:15", "每天23:15发", { cadence: "daily", time: "23:15", tz: SYD });
expectWhen("钟点：全角冒号", "每天23：15发", { cadence: "daily", time: "23:15", tz: SYD });
expectWhen("钟点：十点", "每天十点发", { cadence: "daily", time: "10:00", tz: SYD });
expectWhen("钟点：十一点", "每天十一点发", { cadence: "daily", time: "11:00", tz: SYD });
expectWhen("钟点：十二点", "每天十二点发", { cadence: "daily", time: "12:00", tz: SYD });
expectWhen("钟点：二十一点", "每天二十一点发", { cadence: "daily", time: "21:00", tz: SYD });
expectWhen("钟点：二十三点", "每天二十三点发", { cadence: "daily", time: "23:00", tz: SYD });
expectWhen("钟点：廿三点", "每天廿三点发", { cadence: "daily", time: "23:00", tz: SYD });
expectWhen("钟点：两点", "每天两点发", { cadence: "daily", time: "02:00", tz: SYD });
expectWhen("钟点：七点零五分", "每天7:05发", { cadence: "daily", time: "07:05", tz: SYD });
expectWhen("钟点：下午三点", "每天下午三点发", { cadence: "daily", time: "15:00", tz: SYD });
expectWhen("钟点：晚上8点", "每天晚上8点发", { cadence: "daily", time: "20:00", tz: SYD });
expectWhen("钟点：每晚8点", "每晚8点发", { cadence: "daily", time: "20:00", tz: SYD });
expectWhen("钟点：傍晚6点", "每天傍晚6点发", { cadence: "daily", time: "18:00", tz: SYD });
expectWhen("钟点：凌晨1点", "每天凌晨1点发", { cadence: "daily", time: "01:00", tz: SYD });
expectWhen("钟点：凌晨12点", "每天凌晨12点发", { cadence: "daily", time: "00:00", tz: SYD });
expectWhen("钟点：中午12点", "每天中午12点发", { cadence: "daily", time: "12:00", tz: SYD });
expectWhen("钟点：中午1点", "每天中午1点发", { cadence: "daily", time: "13:00", tz: SYD });
expectWhen("钟点：上午11点", "每天上午11点发", { cadence: "daily", time: "11:00", tz: SYD });
expectWhen("钟点：早上12点原样", "每天早上12点发", { cadence: "daily", time: "12:00", tz: SYD });
expectWhen("钟点：下午12点", "每天下午12点发", { cadence: "daily", time: "12:00", tz: SYD });
expectWhen("钟点：夜里11点", "每天夜里11点发", { cadence: "daily", time: "23:00", tz: SYD });
expectWhen("钟点：晚8点", "每天晚8点发", { cadence: "daily", time: "20:00", tz: SYD });
expectWhen("钟点：早8点", "每天早8点发", { cadence: "daily", time: "08:00", tz: SYD });

// ---------- 时区词（前/后都认） ----------

expectWhen("时区：北京0点", "每天北京0点发", { cadence: "daily", time: "00:00", tz: SHA }, { tzSaid: true });
expectWhen("时区：国内时间", "每天国内时间0点发", { cadence: "daily", time: "00:00", tz: SHA }, { tzSaid: true });
expectWhen("时区：中国时间", "每天中国时间0点发", { cadence: "daily", time: "00:00", tz: SHA }, { tzSaid: true });
expectWhen("时区：悉尼时间", "每天悉尼时间8点发", { cadence: "daily", time: "08:00", tz: SYD }, { tzSaid: true });
expectWhen("时区：悉尼", "每天悉尼8点发", { cadence: "daily", time: "08:00", tz: SYD }, { tzSaid: true });
expectWhen("时区：澳洲时间", "每天澳洲时间8点发", { cadence: "daily", time: "08:00", tz: SYD }, { tzSaid: true });
expectWhen(
  "时区：澳大利亚时间",
  "每天澳大利亚时间8点发",
  { cadence: "daily", time: "08:00", tz: SYD },
  { tzSaid: true }
);
expectWhen("时区：UTC", "每天UTC 0点发", { cadence: "daily", time: "00:00", tz: UTC }, { tzSaid: true });
expectWhen("时区：格林威治", "每天格林威治0点发", { cadence: "daily", time: "00:00", tz: UTC }, { tzSaid: true });
expectWhen(
  "时区：节奏词前",
  "北京时间每天0点发",
  { cadence: "daily", time: "00:00", tz: SHA },
  { tzSaid: true, matched: "北京时间每天0点" }
);
expectWhen(
  "时区：defaultTz 参数",
  "每天8点发",
  { cadence: "daily", time: "08:00", tz: SHA },
  { tzSaid: false, defaultTz: SHA }
);
expectWhen("时区：不说默认悉尼", "每天8点发", { cadence: "daily", time: "08:00", tz: SYD }, { tzSaid: false });

// ---------- 每周 ----------

expectWhen("每周：每周一", "每周一早上8点发", { cadence: "weekly", time: "08:00", weekdays: [1], tz: SYD });
expectWhen("每周：每个周一", "每个周一早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1],
  tz: SYD,
});
expectWhen("每周：每星期一", "每星期一早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1],
  tz: SYD,
});
expectWhen("每周：每礼拜天", "每礼拜天早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [0],
  tz: SYD,
});
expectWhen("每周：每周日", "每周日早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [0],
  tz: SYD,
});
expectWhen("每周：周一到周五", "周一到周五早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  tz: SYD,
});
expectWhen("每周：每周一到周五", "每周一到周五早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  tz: SYD,
});
expectWhen("每周：工作日", "工作日早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  tz: SYD,
});
expectWhen("每周：周末", "周末早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [0, 6],
  tz: SYD,
});
expectWhen("每周：每个周末", "每个周末早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [0, 6],
  tz: SYD,
});
expectWhen("每周：和连接", "每周一和周三早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1, 3],
  tz: SYD,
});
expectWhen("每周：顿号连接", "每周一、三、五早上9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1, 3, 5],
  tz: SYD,
});
expectWhen("每周：周六晚上8点", "每周六晚上8点发", {
  cadence: "weekly",
  time: "20:00",
  weekdays: [6],
  tz: SYD,
});
expectWhen("每周：每周一北京时间9点", "每周一北京时间9点发", {
  cadence: "weekly",
  time: "09:00",
  weekdays: [1],
  tz: SHA,
});

// ---------- 每月 ----------

expectWhen("每月：1号", "每月1号早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1],
  tz: SYD,
});
expectWhen("每月：15号晚上8点", "每个月15号晚上8点发", {
  cadence: "monthly",
  time: "20:00",
  month_days: [15],
  tz: SYD,
});
expectWhen("每月：的1号", "每月的1号早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1],
  tz: SYD,
});
expectWhen("每月：一号", "每月一号早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1],
  tz: SYD,
});
expectWhen("每月：月初", "月初早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1],
  tz: SYD,
});
expectWhen("每月：三月末", "月末晚上8点发", {
  cadence: "monthly",
  time: "20:00",
  month_days: [-1],
  tz: SYD,
});
expectWhen("每月：每月底", "每月底晚上8点发", {
  cadence: "monthly",
  time: "20:00",
  month_days: [-1],
  tz: SYD,
});
expectWhen("每月：最后一天", "每月最后一天早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [-1],
  tz: SYD,
});
expectWhen("每月：多个号", "每月1号、15号早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1, 15],
  tz: SYD,
});
expectWhen("每月：和连接", "每月1号和15号早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1, 15],
  tz: SYD,
});
expectWhen("每月：31号", "每月31号早上9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [31],
  tz: SYD,
});
expectWhen("每月：北京时间", "每月1号北京时间9点发", {
  cadence: "monthly",
  time: "09:00",
  month_days: [1],
  tz: SHA,
});

// ---------- 一次性 ----------

expectWhen("一次：今天下午6点", "今天下午6点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-14T07:00:00Z"),
  tz: SYD,
});
expectWhen("一次：后天早上9点", "后天早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-15T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：大后天早上9点", "大后天早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-16T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：今晚8点", "今晚8点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-14T09:00:00Z"),
  tz: SYD,
});
expectWhen("一次：明晚8点", "明晚8点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-15T09:00:00Z"),
  tz: SYD,
});
expectWhen("一次：下周一", "下周一早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-15T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：下周日", "下周日早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-21T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：11月20日", "11月20日下午3点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-20T04:00:00Z"),
  tz: SYD,
});
expectWhen("一次：12月1日", "12月1日早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-30T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：20号", "20号早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-19T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：3号已过", "3号早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-12-02T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：十分钟后", "十分钟后提醒我", {
  cadence: "once",
  run_at: NOW + 10 * 60000,
  tz: SYD,
});
expectWhen("一次：10分钟后", "10分钟后提醒我", {
  cadence: "once",
  run_at: NOW + 10 * 60000,
  tz: SYD,
});
expectWhen("一次：半小时后", "半小时后提醒我", {
  cadence: "once",
  run_at: NOW + 30 * 60000,
  tz: SYD,
});
expectWhen("一次：两个小时后", "两个小时后提醒我", {
  cadence: "once",
  run_at: NOW + 2 * 3600000,
  tz: SYD,
});
expectWhen("一次：2小时后", "2小时后提醒我", {
  cadence: "once",
  run_at: NOW + 2 * 3600000,
  tz: SYD,
});
expectWhen("一次：3天后", "3天后提醒我", {
  cadence: "once",
  run_at: NOW + 3 * 86400000,
  tz: SYD,
});
expectWhen("一次：2周后", "2周后提醒我", {
  cadence: "once",
  run_at: NOW + 14 * 86400000,
  tz: SYD,
});
expectWhen("一次：裸钟点8点（已过）", "8点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-14T21:00:00Z"),
  tz: SYD,
});
expectWhen("一次：裸钟点2:10（已过）", "2:10提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-14T15:10:00Z"),
  tz: SYD,
});
expectWhen("一次：裸周一周一", "周一早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-15T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：本周日", "本周日早上9点提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-14T22:00:00Z"),
  tz: SYD,
});
expectWhen("一次：北京时间明天", "明天下午3点北京时间提醒我", {
  cadence: "once",
  run_at: Date.parse("2026-11-15T07:00:00Z"),
  tz: SHA,
});

// ---------- 每 N 分钟/小时 ----------

expectWhen("间隔：每30分钟", "每30分钟提醒我喝水", {
  cadence: "every",
  every_minutes: 30,
  tz: SYD,
});
expectWhen("间隔：每隔半小时", "每隔半小时提醒我", {
  cadence: "every",
  every_minutes: 30,
  tz: SYD,
});
expectWhen("间隔：每半小时", "每半小时提醒我", {
  cadence: "every",
  every_minutes: 30,
  tz: SYD,
});
expectWhen("间隔：每10分钟", "每10分钟提醒我", {
  cadence: "every",
  every_minutes: 10,
  tz: SYD,
});
expectWhen("间隔：每三十分钟", "每三十分钟提醒我", {
  cadence: "every",
  every_minutes: 30,
  tz: SYD,
});
expectWhen("间隔：每2小时", "每2小时提醒我", {
  cadence: "every",
  every_minutes: 120,
  tz: SYD,
});
expectWhen("间隔：每隔一小时", "每隔一小时提醒我", {
  cadence: "every",
  every_minutes: 60,
  tz: SYD,
});
expectWhen("间隔：每小时", "每小时提醒我", {
  cadence: "every",
  every_minutes: 60,
  tz: SYD,
});
expectWhen("间隔：每90分钟", "每90分钟提醒我", {
  cadence: "every",
  every_minutes: 90,
  tz: SYD,
});
expectWhen("间隔：到22:00", "每30分钟提醒我喝水，到22:00为止", {
  cadence: "every",
  every_minutes: 30,
  until: Date.parse("2026-11-14T11:00:00Z"),
  tz: SYD,
});
expectWhen("间隔：北京时间到22:00", "每30分钟提醒我喝水，到北京时间晚上10点为止", {
  cadence: "every",
  every_minutes: 30,
  until: Date.parse("2026-11-14T14:00:00Z"),
  tz: SHA,
});

// ---------- 缺时间/缺日期/null ----------

expectBad("缺时间：某个时间", "每天某个时间发", { ok: false, missing: "time" });
expectBad("缺时间：定时", "每天定时发", { ok: false, missing: "time" });
expectBad("缺时间：找个时间", "找个时间提醒我", { ok: false, missing: "time" });
expectBad("缺时间：每天发余额", "每天发余额", { ok: false, missing: "time" });
expectBad("缺时间：明天", "明天提醒我", { ok: false, missing: "time" });
expectBad("缺时间：下周一", "下周一提醒我", { ok: false, missing: "time" });
expectBad("缺时间：11月20日", "11月20日提醒我", { ok: false, missing: "time" });
expectBad("缺时间：每周一发", "每周一发", { ok: false, missing: "time" });
expectBad("缺时间：每月1号发", "每月1号发", { ok: false, missing: "time" });
expectBad("缺时间：月底无钟点", "月底", { ok: false, missing: "time" });
expectBad("缺时间：25点", "每天25点发", { ok: false, missing: "time" });
expectBad("缺时间：一会儿", "一会儿提醒我", { ok: false, missing: "time" });
expectBad("缺日期：每周", "每周早上9点发", { ok: false, missing: "date", cadence: "weekly" });
expectBad("缺日期：每月", "每月早上9点发", { ok: false, missing: "date", cadence: "monthly" });
expectBad("缺日期：32号", "每月32号早上9点发", { ok: false, missing: "date", cadence: "monthly" });
expectBad("缺日期：每周无钟点", "每周", { ok: false, missing: "date", cadence: "weekly" });
expectBad("缺日期：每月无钟点", "每月", { ok: false, missing: "date", cadence: "monthly" });
expectBad("null：空串", "", null);
expectBad("null：你好", "你好呀", null);
expectBad("null：2:10无动词", "2:10自动开干", null);
expectBad("null：无时间", "提醒我交周报", null);
expectBad("null：闲聊", "我想吃火锅", null);

// ---------- 中间插入：在/于/的/群里/给我/固定/准时/按时/左右/前后/标点 ----------

expectWhen("插入：空格", "每天 北京时间 0 点 在群里发余额", {
  cadence: "daily",
  time: "00:00",
  tz: SHA,
});
expectWhen("插入：在", "每天在北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：于", "每天于北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：的", "每天的北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：群里", "每天群里北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：给我", "每天给我北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：固定", "每天固定北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：准时", "每天准时北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：按时", "每天按时北京时间0点发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：左右", "每天北京时间0点左右发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：前后", "每天北京时间0点前后发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：标点", "每天，北京时间0点，发余额", { cadence: "daily", time: "00:00", tz: SHA });
expectWhen("插入：换行", "每天\n北京时间0点\n发余额", { cadence: "daily", time: "00:00", tz: SHA });

// ---------- DST 两个日期 ----------

const DST_AEDT = Date.parse("2026-11-14T06:48:00Z"); // 悉尼 2026-11-14 17:48 AEDT
const DST_AEST = Date.parse("2027-05-14T06:48:00Z"); // 悉尼 2027-05-14 16:48 AEST

expectWhen(
  "DST：2026-11-15 AEDT 明天8点",
  "明天早上8点提醒我",
  { cadence: "once", run_at: Date.parse("2026-11-14T21:00:00Z"), tz: SYD },
  { now: DST_AEDT }
);
expectWhen(
  "DST：2027-05-15 AEST 明天8点",
  "明天早上8点提醒我",
  { cadence: "once", run_at: Date.parse("2027-05-14T22:00:00Z"), tz: SYD },
  { now: DST_AEST }
);
expectWhen(
  "DST：AEST 每天北京时间0点",
  "每天北京时间0点发余额",
  { cadence: "daily", time: "00:00", tz: SHA },
  { now: DST_AEST }
);

// ---------- parseContent ----------

expectContent("内容：硬例只出余额", "每天北京时间0点在群里发DeepSeek余额即可", [{ action: "quota" }]);
expectContent("内容：余额+token", "每天在固定时间发一下每天的余额和 token 用量", [
  { action: "quota" },
  { action: "token_usage" },
]);
expectContent("内容：上月报销账单", "每月1号早上9点把上个月报销账单发群里", [
  { action: "records_summary", type: "报销", period: "last_month" },
]);
expectContent(
  "内容：RC-09 三件事（日报是格式词，不额外加聊天总结）",
  "可以的，你把账本跟API余额每天在北京时间0点发一下日报，注意自己建立一个本地记账工具。同时播报每日使用的token总数。",
  [{ action: "records_summary", type: "账本" }, { action: "quota" }, { action: "token_usage" }]
);
expectContent("内容：昨日聊天", "推送昨日聊天内容总结", [{ action: "chat_digest", days: 1 }]);
expectContent("内容：上周聊天", "发上周聊天总结", [{ action: "chat_digest", days: 7 }]);
expectContent("内容：日报", "每天发日报", [{ action: "chat_digest", days: 1 }]);
expectContent("内容：总结", "总结一下", [{ action: "chat_digest", days: 1 }]);
expectContent("内容：token", "播报每日使用的token总数", [{ action: "token_usage" }]);
expectContent("内容：昨日 token", "昨天的token用量", [{ action: "token_usage", period: "yesterday" }]);
expectContent("内容：今天账单", "今天的账单", [
  { action: "records_summary", type: "账本", period: "today" },
]);
expectContent("内容：全部账单", "所有账单", [
  { action: "records_summary", type: "账本", period: "all" },
]);
expectContent("内容：本月账单", "本月账单", [
  { action: "records_summary", type: "账本", period: "this_month" },
]);
expectContent("内容：报销额度", "记账报销额度", [
  { action: "records_summary", type: "报销额度" },
]);
expectContent("内容：装修账单", "装修账单", [
  { action: "records_summary", type: "装修" },
]);
expectContent("内容：兜底 text", "明天下午3点提醒我交周报", [
  { action: "text", text: "明天下午3点提醒我交周报" },
]);
expectContent("内容：空串", "", []);
expectContent("内容：空白", "   ", []);
expectContent("内容：去重", "余额 余额 额度", [{ action: "quota" }]);
expectContent("内容：过长截断", "提醒".repeat(200), [
  { action: "text", text: "提醒".repeat(150) },
]);

// ---------- describeWhen ----------

expectDescribe(
  "文案：每天北京时间",
  { cadence: "daily", time: "00:00", tz: SHA },
  "每天 北京时间 00:00（悉尼 03:00）"
);
expectDescribe("文案：每天悉尼", { cadence: "daily", time: "08:00", tz: SYD }, "每天 08:00");
expectDescribe(
  "文案：每周一北京时间",
  { cadence: "weekly", time: "09:00", weekdays: [1], tz: SHA },
  "每周一 北京时间 09:00（悉尼 12:00）"
);
expectDescribe(
  "文案：每周多日悉尼",
  { cadence: "weekly", time: "09:00", weekdays: [1, 3, 5], tz: SYD },
  "每周一、周三、周五 09:00"
);
expectDescribe(
  "文案：每月1日悉尼",
  { cadence: "monthly", time: "09:00", month_days: [1], tz: SYD },
  "每月1日 09:00"
);
expectDescribe(
  "文案：每月最后一天",
  { cadence: "monthly", time: "09:00", month_days: [-1], tz: SYD },
  "每月最后一天 09:00"
);
expectDescribe(
  "文案：每月多日北京时间",
  { cadence: "monthly", time: "09:00", month_days: [1, 15], tz: SHA },
  "每月1日、15日 北京时间 09:00（悉尼 12:00）"
);
expectDescribe(
  "文案：一次性悉尼",
  { cadence: "once", run_at: Date.parse("2026-11-15T04:00:00Z"), tz: SYD },
  "2026年11月15日 15:00"
);
expectDescribe(
  "文案：一次性北京时间",
  { cadence: "once", run_at: Date.parse("2026-11-15T07:00:00Z"), tz: SHA },
  "2026年11月15日 北京时间 15:00（悉尼 18:00）"
);
expectDescribe("文案：每30分钟", { cadence: "every", every_minutes: 30, tz: SYD }, "每30分钟");
expectDescribe(
  "文案：每30分钟北京时间",
  { cadence: "every", every_minutes: 30, tz: SHA },
  "每30分钟（北京时间）"
);
expectDescribe("文案：每2小时", { cadence: "every", every_minutes: 120, tz: SYD }, "每2小时");
expectDescribe(
  "文案：到22点",
  { cadence: "every", every_minutes: 30, until: Date.parse("2026-11-14T11:00:00Z"), tz: SYD },
  "每30分钟，到 22:00 为止"
);
expectDescribe(
  "文案：UTC",
  { cadence: "daily", time: "00:00", tz: UTC },
  "每天 UTC 00:00（悉尼 11:00）"
);
expectDescribe(
  "文案：AEST 北京时间",
  { cadence: "daily", time: "00:00", tz: SHA },
  "每天 北京时间 00:00（悉尼 02:00）",
  DST_AEST
);

// ---------- 不抛异常 ----------

test("永不抛异常：一批怪输入", () => {
  for (const text of [
    "",
    "   ",
    "每天",
    "每天点",
    "每天99点",
    "每-1分钟",
    "每月99号",
    "明天25点",
    "十分钟后",
    "现在",
    "!@#$%^&*()",
    "每天北京时间",
    "每周星期八",
    "每月三十二号",
  ]) {
    assert.doesNotThrow(() => parseWhen(text, NOW), text);
  }
});
