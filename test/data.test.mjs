// Offline tests for the data warehouse: real SQLite (node:sqlite) behind a Durable-Object-shaped sql, a fake R2
// bucket, fake `stock` / `hot` tools whose outputs have the shape of the live ones (samples captured 2026-11-14).
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const D = await import("../src/feat/data.ts");
const feature = D.default;

// ---------- real samples ----------
const STOCK = {
  sh000001: { symbol: "sh000001", name: "上证指数", code: "000001", price: "3634.35", change: "-21.48", change_pct: "-0.59%", prev_close: "3655.83", open: "3658.72", high: "3669.44", low: "3623.84", volume: "472293657", amount: "77061417", turnover_pct: "0.97", pe: "16.55", market_cap: "638206.59", time: "20261113161427" },
  hk00700: { symbol: "hk00700", name: "腾讯控股", code: "00700", price: "386.600", change: "-12.200", change_pct: "-3.06%", prev_close: "398.800", open: "393.000", high: "395.200", low: "385.600", volume: "31493353.0", amount: "12251162809.622", turnover_pct: "0", pe: "14.12", market_cap: "35152.1649", time: "2026/11/13 16:08:22" },
  usNVDA: { symbol: "usNVDA", name: "英伟达", code: "NVDA.OQ", price: "162.85", change: "-3.34", change_pct: "-2.01%", prev_close: "166.19", open: "169.91", high: "170.00", low: "158.39", volume: "365796552", amount: "59248648156", turnover_pct: "1.51", pe: "20.59", market_cap: "39323.38950", time: "2026-11-13 16:00:01" },
};
const mk = (symbol, name, price, pct, time) => ({ ...STOCK.sh000001, symbol, name, price, change_pct: pct + "%", time });
const BY_NAME = {
  "上证指数": STOCK.sh000001, "腾讯控股": STOCK.hk00700, "英伟达": STOCK.usNVDA,
  "深证成指": mk("sz399001", "深证成指", "10968.79", "-0.4", "20261113161451"),
  "创业板指": mk("sz399006", "创业板指", "2426.08", "-0.7", "20261113161406"),
  "贵州茅台": mk("sh600519", "贵州茅台", "1435.26", "0.3", "20261113161455"),
  "特斯拉": mk("usTSLA", "特斯拉", "390.22", "1.2", "2026-11-13 16:00:01"),
  "苹果": mk("usAAPL", "苹果", "356.27", "0.5", "2026-11-13 16:00:01"),
  "阿里巴巴": mk("usBABA", "阿里巴巴", "94.38", "-1.1", "2026-11-13 16:03:12"),
};
// Tencent raw lines (qt.gtimg.cn), cut after the fields we read.
const QT = {
  usIXIC: 'v_usIXIC="200~纳斯达克~.IXIC~25136.27~25366.09~25408.00~7740442365~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-11-13 17:15:59~-229.82~-0.91~25423.09~24872.41~USD~7740442365~1945";',
  hkHSI: 'v_hkHSI="100~恒生指数~HSI~23637.600~24008.550~23871.910~19585700.7140~0~0~23637.600~0~0~0~0~0~0~0~0~0~23637.600~0~0~0~0~0~0~0~0~0~0.0~2026/11/13 18:31:15~-370.950~-1.55~23930.130~23595.360~23637.600";',
  hkHSTECH: 'v_hkHSTECH="100~恒生科技指数~HSTECH~3813.190~3931.930~3918.210~6628641.3699~0~0~3813.190~0~0~0~0~0~0~0~0~0~3813.190~0~0~0~0~0~0~0~0~0~0.0~2026/11/13 16:08:40~-118.740~-3.02~3938.390~3802.840~3813.190";',
  whUSDCNY: 'v_whUSDCNY="310~美元人民币~USDCNY~6.6710~0~20261114030002~6.6700~6.6690~6.6741~6.6672~6.6710~6.6726~0.0010~0.01~-0.02~0.26~-0.22~-1.07~-4.52~7.1181~6.6449~2026-11-13";',
  hf_XAU: 'v_hf_XAU="3879.92,0.06,3879.92,3880.28,3922.99,3867.55,05:55:00,3877.43,3877.21,0,0,0,2026-11-14,伦敦金（现货黄金）";',
  hf_CL: 'v_hf_CL="88.98,0.28,88.92,88.94,89.64,87.80,05:59:59,88.74,88.79,0,9,2,2026-11-14,纽约原油";',
};
const idx = (sym, name, code, price, prev, time, chg, pct, hi, lo) => {
  const f = Array(40).fill("0"); f[0] = "200"; f[1] = name; f[2] = code; f[3] = price; f[4] = prev; f[30] = time; f[31] = chg; f[32] = pct; f[33] = hi; f[34] = lo;
  return "v_" + sym + '="' + f.join("~") + '";';
};
QT.usINX = idx("usINX", "标普500", ".INX", "7561.67", "7592.40", "2026-11-13 16:43:19", "-30.73", "-0.40", "7621.78", "7499.40");
QT.usDJI = idx("usDJI", "道琼斯", ".DJI", "52347.55", "52297.09", "2026-11-13 16:43:26", "50.46", "0.10", "52521.48", "52017.86");
const HOT = {
  weibo: ["1. 八冠神罚（399323）", "2. 小寒梦游（236496）", "3. 数读向新向优向好的中国经济（221309）"],
  douyin: ["1. BLG对阵GEN（12111082）", "2. 国足2:0马来西亚（11669692）"],
  bilibili: ["1. 产品行，刀恶心！Mate 90Pro Max典藏版一个月深度测评 — 机拍朱老师，播放 73165，BV1a4s36DERi", "2. 在公司修了个地铁… — 老师好我叫何同学，播放 3863688，BV1AcWG6eE1V"],
  zhihu: ["1. 多地网约车司机称被特惠车、一口价订单逼「疯」，怎样才能让乘客打车实惠？（508 万热度）", "2. Faker 采访称「我们不可能一直是冠军」，为什么今年 GEN 评价如此高？（319 万热度）"],
  baidu: ["1. 习近平主席妙论亚太合作之道", "2. 多地中小学宣布调整作息", "3. 两天17款新车 车企年底扎堆冲量"],
  github: ["1. backnotprop/plannotator [TypeScript] 今日+412 — The workspace to stay in the loop and on top of agents", "2. GoogleChrome/modern-web-guidance-src [TypeScript] 今日+1,225 — Keep your coding agent up to date", "3. someone/no-lang-repo 今日+9"],
  hackernews: ["1. FAA issues national ground stop – lifted 4.5 hours later（1621 分，1250 评） https://www.nbcnews.com/news/us-news/faa-orders-nationwide-ground-stop-departing-flights-reasons-safety-rcna609247", "2. Terminal borders that don't cost a cell（383 分，165 评） https://www.joshka.net/cell-borders/"],
};

// ---------- fakes ----------
function fakeBucket() {
  const m = new Map(), ops = { put: 0, del: 0 };
  return {
    m, ops,
    async put(k, v) { ops.put++; m.set(k, String(v)); },
    async get(k) { return m.has(k) ? { text: async () => m.get(k) } : null; },
    async delete(ks) { for (const k of [].concat(ks)) { ops.del++; m.delete(k); } },
    async list({ prefix = "" } = {}) { const objects = [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({ key, size: m.get(key).length })); return { objects, truncated: false }; },
  };
}
function fakeHub(opts = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);");
  db.exec(feature.schema);
  const waits = [], used = {}, calls = { stock: [], hot: [] };
  const hub = {
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA|WITH)/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    env: { FILES: opts.noR2 ? undefined : fakeBucket() },
    ctx: { waitUntil: p => waits.push(p) },
    plan: { used, fits: (n, a = 0) => (used[n] || 0) + a <= (hub.cap ?? 1e9), take(n, a) { if (!this.fits(n, a)) return false; used[n] = (used[n] || 0) + a; return true; } },
    get: k => { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? String(r.v) : null; },
    set: (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
    shadow: conv => (conv.startsWith("t:") ? hub.get("main") || "" : ""),
    failSources: new Set(), failAllHot: false, calls, db, waits,
    tools: () => [
      { name: "stock", run: async ({ query }) => { calls.stock.push(query); const q = BY_NAME[query]; if (!q) throw new Error("没找到这只股票，换个名字或直接给代码"); return { quotes: [q] }; } },
      { name: "hot", run: async ({ source }) => { calls.hot.push(source); if (hub.failAllHot || hub.failSources.has(source)) throw new Error("知乎热榜要登录后才能看"); return { note: "外部资料", list: HOT[source] }; } },
    ],
    async settle() { while (waits.length) await waits.shift(); },
  };
  hub.set("main", "g:main");
  return hub;
}
const makeTool = (hub, conv = "g:main") => {
  const kept = [];
  const host = { now: () => hub.now ?? Date.now(), keepFile: async (name, bytes) => { kept.push({ name, text: new TextDecoder().decode(bytes) }); return "f" + (11 + kept.length); }, quota: async () => !hub.noQuota };
  return { tool: feature.tools({ hub, conv, askers: [], host })[0], kept };
};
const BJ = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm);   // Beijing wall clock to UTC ms
const qtFor = codes => codes.map(c => QT[c]).filter(Boolean).join("\n");
D.NET.text = async url => qtFor(decodeURIComponent(url.split("q=")[1]).split(","));

// ---------- tests ----------
describe("slots", () => {
  const none = () => false;
  const ids = (now, marked = none) => D.dueSlots(now, marked).map(s => s.slot.id + "@" + s.day);
  const cn = (now, marked = none) => ids(now, marked).filter(s => s.startsWith("q-cnhk"));

  test("A-share/HK slot opens at 16:30 Beijing, not before", () => {
    assert.deepEqual(cn(BJ(2026, 11, 13, 16, 29)), []);
    assert.deepEqual(cn(BJ(2026, 11, 13, 16, 31)), ["q-cnhk@2026-11-13"]);
    assert.equal(Date.UTC(2026, 10, 13, 8, 30), BJ(2026, 11, 13, 16, 30), "16:30 Beijing is 08:30 UTC");
  });
  test("US slot at 06:10 Beijing belongs to the Beijing date even though UTC is still the day before", () => {
    const now = Date.UTC(2026, 10, 14, 22, 10);   // 2026-11-15 06:10 Beijing
    assert.deepEqual(ids(now), ["q-us@2026-11-15"]);
    assert.deepEqual(ids(Date.UTC(2026, 10, 14, 22, 9)), [], "22:09 UTC is 06:09 Beijing");
  });
  test("hot slots at 09:00 and 21:00 Beijing, each with a limited catch-up window", () => {
    assert.deepEqual(ids(Date.UTC(2026, 10, 15, 1, 0)).filter(s => s.startsWith("h-")), ["h-am@2026-11-15"]);
    assert.ok(!ids(Date.UTC(2026, 10, 15, 4, 1)).some(s => s.startsWith("h-am")), "12:01 Beijing is too late for the morning snapshot");
    assert.deepEqual(ids(Date.UTC(2026, 10, 15, 13, 0)).filter(s => s.startsWith("h-")), ["h-pm@2026-11-15"]);
  });
  test("just after Beijing midnight nothing is due (UTC date has not changed yet)", () => {
    assert.deepEqual(ids(Date.UTC(2026, 10, 15, 16, 30)), []);   // 00:30 on 11-16 Beijing
  });
  test("a marked slot is not due again that day but is due the next day", () => {
    const marked = (id, day) => id === "q-cnhk" && day === "2026-11-13";
    assert.deepEqual(cn(BJ(2026, 11, 13, 17), marked), []);
    assert.deepEqual(cn(BJ(2026, 11, 14, 17), marked), ["q-cnhk@2026-11-14"]);
  });
  test("tick runs each slot once per day, in waitUntil", async () => {
    const hub = fakeHub(), now = BJ(2026, 11, 13, 17);
    await feature.tick(hub, now);
    const n = hub.waits.length;
    assert.equal(n, 2, "the slot itself and the daily prune");
    await feature.tick(hub, now + 20000);
    assert.equal(hub.waits.length, n, "claimed before the work finished: no second run");
    await hub.settle();
    await feature.tick(hub, now + 40000);
    assert.equal(hub.waits.length, 0);
    assert.equal(hub.get("data:mark:q-cnhk:2026-11-13"), "1");
  });
  test("tick does nothing without a main group", async () => {
    const hub = fakeHub(); hub.db.exec("DELETE FROM kv WHERE k='main'");
    await feature.tick(hub, BJ(2026, 11, 13, 17));
    assert.equal(hub.waits.length, 0);
  });
});

describe("parsing real shapes", () => {
  test("stock tool output", () => {
    const q = D.quoteFromStock(STOCK.sh000001);
    assert.deepEqual([q.symbol, q.name, q.price, q.pct, q.prev, q.date], ["sh000001", "上证指数", 3634.35, -0.59, 3655.83, "2026-11-13"]);
    assert.equal(D.quoteFromStock(STOCK.hk00700).date, "2026-11-13", "2026/11/13 16:08:22");
    assert.equal(D.quoteFromStock(STOCK.usNVDA).pct, -2.01);
    assert.equal(D.quoteFromStock({ ...STOCK.usNVDA, price: "" }), null);
    assert.equal(D.quoteFromStock({ ...STOCK.usNVDA, time: "" }), null);
  });
  test("Tencent raw: indices, FX, metals", () => {
    const q = Object.fromEntries(D.parseQt(Object.values(QT).join("\n")).map(x => [x.symbol, x]));
    assert.deepEqual([q.usIXIC.price, q.usIXIC.pct, q.usIXIC.date], [25136.27, -0.91, "2026-11-13"]);
    assert.deepEqual([q.hkHSI.price, q.hkHSI.pct, q.hkHSI.date], [23637.6, -1.55, "2026-11-13"]);
    assert.deepEqual([q.whUSDCNY.price, q.whUSDCNY.pct, q.whUSDCNY.date], [6.671, 0.01, "2026-11-13"]);
    assert.deepEqual([q.hf_XAU.price, q.hf_XAU.pct, q.hf_XAU.date], [3879.92, 0.06, "2026-11-14"]);
    assert.equal(q.hf_CL.price, 88.98);
    assert.equal(D.parseQt('v_pv_none_match="1";').length, 0, "unknown codes are skipped");
  });
  test("hot lines for every source", () => {
    const p = (s, i = 0) => D.parseHot(s, HOT[s][i], i);
    assert.deepEqual(p("weibo"), { rank: 1, title: "八冠神罚", heat: "399323" });
    assert.deepEqual(p("douyin", 1), { rank: 2, title: "国足2:0马来西亚", heat: "11669692" });
    assert.deepEqual(p("bilibili"), { rank: 1, title: "产品行，刀恶心！Mate 90Pro Max典藏版一个月深度测评", heat: "播放 73165", x: "机拍朱老师 BV1a4s36DERi" });
    assert.deepEqual(p("zhihu", 1), { rank: 2, title: "Faker 采访称「我们不可能一直是冠军」，为什么今年 GEN 评价如此高？", heat: "319 万热度" });
    assert.deepEqual(p("baidu", 2), { rank: 3, title: "两天17款新车 车企年底扎堆冲量", heat: "" });
    assert.deepEqual(p("github"), { rank: 1, title: "backnotprop/plannotator", heat: "今日+412", x: "TypeScript The workspace to stay in the loop and on top of agents" });
    assert.equal(p("github", 1).heat, "今日+1,225");
    assert.deepEqual(p("github", 2), { rank: 3, title: "someone/no-lang-repo", heat: "今日+9" });
    const hn = p("hackernews");
    assert.deepEqual([hn.rank, hn.title, hn.heat], [1, "FAA issues national ground stop – lifted 4.5 hours later", "1621 分"]);
    assert.ok(hn.x.startsWith("https://www.nbcnews.com"));
    assert.equal(D.parseHot("weibo", "", 0), null);
  });
  test("a title that itself ends in brackets keeps them out of the heat", () => {
    assert.deepEqual(D.parseHot("weibo", "5. 某某（回应）事件（88）", 4), { rank: 5, title: "某某（回应）事件", heat: "88" });
  });
});

describe("storage", () => {
  let hub;
  beforeEach(() => { hub = fakeHub(); });
  const q = (date, symbol, price, pct) => ({ symbol, name: symbol, price, pct, date });
  const dp = () => hub.sql.exec("SELECT * FROM datapoint ORDER BY day, symbol").toArray();

  test("a later snapshot of the same (day, symbol) replaces the earlier one", () => {
    D.saveQuotes(hub, [q("2026-11-13", "usNVDA", 160, -1)]);
    D.saveQuotes(hub, [q("2026-11-13", "usNVDA", 162.85, -2.01), q("2026-11-14", "usNVDA", 170, 4)]);
    const r = dp();
    assert.equal(r.length, 2);
    assert.deepEqual([r[0].close, r[0].change_pct], [162.85, -2.01]);
  });
  test("hot: later snapshot replaces the day's earlier one for that source only", () => {
    D.saveHot(hub, "2026-11-13", "weibo", [{ rank: 1, title: "早上的", heat: "1" }, { rank: 2, title: "只在早上", heat: "1" }]);
    D.saveHot(hub, "2026-11-13", "baidu", [{ rank: 1, title: "百度", heat: "" }]);
    D.saveHot(hub, "2026-11-13", "weibo", [{ rank: 1, title: "晚上的", heat: "9" }]);
    const w = hub.sql.exec("SELECT rank, title FROM hotitem WHERE source='weibo'").toArray();
    assert.deepEqual(w, [{ rank: 1, title: "晚上的" }]);
    assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM hotitem WHERE source='baidu'").toArray()[0].n, 1);
    assert.equal(D.saveHot(hub, "2026-11-13", "weibo", []), 0);
    assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM hotitem WHERE source='weibo'").toArray()[0].n, 1, "an empty list never wipes the day");
  });
  test("hot keeps the top 30 only", () => {
    D.saveHot(hub, "2026-11-13", "weibo", Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, title: "t" + i, heat: "" })));
    assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM hotitem").toArray()[0].n, 30);
  });
  test("retention: two years of quotes, 180 days of hot items", () => {
    const now = BJ(2026, 11, 15, 12);
    D.saveQuotes(hub, [q("2024-11-15", "a", 1, 0), q("2024-11-16", "a", 1, 0), q("2026-11-14", "a", 1, 0)]);   // 2024-11-15 is 730 days back
    D.saveHot(hub, "2026-05-19", "weibo", [{ rank: 1, title: "old", heat: "" }]);   // 180 days back
    D.saveHot(hub, "2026-05-18", "baidu", [{ rank: 1, title: "older", heat: "" }]);
    D.retain(hub, now);
    assert.deepEqual(dp().map(r => r.day), ["2024-11-15", "2024-11-16", "2026-11-14"]);
    D.saveQuotes(hub, [q("2024-11-14", "a", 1, 0)]);
    D.retain(hub, now);
    assert.ok(!dp().some(r => r.day === "2024-11-14"));
    const h = hub.sql.exec("SELECT day FROM hotitem").toArray().map(r => r.day);
    assert.deepEqual(h, ["2026-05-19"]);
  });
  test("R2 pruning removes only old snapshots and keeps count of bytes", async () => {
    const b = hub.env.FILES;
    for (const k of ["data/quotes/2024-01-01.json", "data/quotes/2026-11-13.json", "data/quotes/2026-11-13-us.json", "data/hot/weibo/2026-01-01-09.json", "data/hot/weibo/2026-11-13-09.json"]) b.m.set(k, "{}");
    const n = await D.pruneR2(hub, BJ(2026, 11, 15, 12));
    assert.equal(n, 2);
    assert.deepEqual([...b.m.keys()].sort(), ["data/hot/weibo/2026-11-13-09.json", "data/quotes/2026-11-13-us.json", "data/quotes/2026-11-13.json"]);
  });
});

describe("history facts", () => {
  const pts = [
    ["2026-10-01", 100, 0.5], ["2026-10-02", 103, 3], ["2026-10-03", 99, -3.88], ["2026-10-04", 90, -9.09], ["2026-10-05", 95, 5.56], ["2026-10-06", 110, 15.79], ["2026-10-07", 108, -1.82],
  ].map(([day, close, pct]) => ({ day, close, pct }));
  test("period change, high/low with dates, biggest moves", () => {
    const f = D.factsOf(pts);
    assert.deepEqual(f.first, { date: "2026-10-01", close: 100 });
    assert.deepEqual(f.last, { date: "2026-10-07", close: 108 });
    assert.equal(f.change_pct, 8);
    assert.deepEqual(f.high, { date: "2026-10-06", close: 110 });
    assert.deepEqual(f.low, { date: "2026-10-04", close: 90 });
    assert.equal(f.from_high_pct, -1.82);
    assert.deepEqual(f.biggest_up[0], { date: "2026-10-06", pct: 15.79 });
    assert.deepEqual(f.biggest_down.map(m => m.date), ["2026-10-04", "2026-10-03", "2026-10-07"]);
    assert.deepEqual([f.up_days, f.down_days], [4, 3]);
  });
  test("missing change_pct is derived from consecutive closes", () => {
    const f = D.factsOf([{ day: "a", close: 100, pct: null }, { day: "b", close: 110, pct: null }, { day: "c", close: 99, pct: null }]);
    assert.deepEqual(f.biggest_up, [{ date: "b", pct: 10 }]);
    assert.deepEqual(f.biggest_down, [{ date: "c", pct: -10 }]);
  });
  test("empty series gives null", () => assert.equal(D.factsOf([]), null));

  test("quotes_history through the tool: names, aliases, codes, unknowns, window", async () => {
    const hub = fakeHub();
    hub.now = BJ(2026, 10, 10, 12);
    D.saveQuotes(hub, pts.map(p => ({ symbol: "usIXIC", name: "纳斯达克指数", price: p.close, pct: p.pct, date: p.day })));
    D.saveQuotes(hub, [{ symbol: "usNVDA", name: "英伟达", price: 162.85, pct: -2.01, date: "2026-10-07" }, { symbol: "hk00700", name: "腾讯控股", price: 386.6, pct: -3.06, date: "2026-10-07" }]);
    const { tool } = makeTool(hub);
    const r = await tool.run({ op: "quotes_history", symbols: ["纳指", "NVDA", "00700", "不存在的东西"], days: 30 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.symbols.map(s => s.symbol), ["usIXIC", "usNVDA", "hk00700"]);
    assert.equal(r.symbols[0].facts.change_pct, 8);
    assert.equal(r.symbols[0].series.length, 7);
    assert.deepEqual(r.symbols[0].series[0], ["2026-10-01", 100, 0.5]);
    assert.deepEqual(r.not_found, ["不存在的东西"]);
    assert.equal(r.history_starts, "2026-10-01");
    const narrow = await tool.run({ op: "quotes_history", symbols: ["纳斯达克指数"], days: 3 });
    assert.equal(narrow.symbols[0].facts.points, 1, "10-10 minus 3 days leaves only 10-07");
  });
  test("long series is thinned for display but facts use everything", async () => {
    const hub = fakeHub(); hub.now = BJ(2026, 11, 15, 12);
    const rows = Array.from({ length: 200 }, (_, i) => ({ symbol: "usINX", name: "标普500", price: 100 + i, pct: 1, date: new Date(Date.UTC(2026, 4, 1) + i * 86400000).toISOString().slice(0, 10) }));
    D.saveQuotes(hub, rows);
    const { tool } = makeTool(hub);
    const r = await tool.run({ op: "quotes_history", symbols: ["标普500"], days: 400 });
    assert.ok(r.symbols[0].series.length <= 70);
    assert.equal(r.symbols[0].facts.points, 200);
    assert.deepEqual(r.symbols[0].series.at(-1)[0], rows.at(-1).date);
  });
  test("empty history says so", async () => {
    const hub = fakeHub(), { tool } = makeTool(hub);
    const r = await tool.run({ op: "quotes_history", symbols: ["纳指"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /snapshot_now/);
    assert.equal((await tool.run({ op: "hot_history" })).ok, false);
  });
});

describe("hot history", () => {
  let hub, tool;
  beforeEach(() => {
    hub = fakeHub(); hub.now = BJ(2026, 11, 15, 12);
    ({ tool } = makeTool(hub));
    const put = (day, source, titles) => D.saveHot(hub, day, source, titles.map((t, i) => ({ rank: i + 1, title: t, heat: String(100 - i) })));
    put("2026-11-09", "weibo", ["世界杯预选赛", "某明星离婚", "台风登陆"]);
    put("2026-11-10", "weibo", ["世界杯预选赛", "台风登陆", "新手机发布"]);
    put("2026-11-11", "weibo", ["台风登陆", "世界杯预选赛"]);
    put("2026-11-13", "weibo", ["世界杯预选赛", "股市大涨"]);   // gap on 11-12
    put("2026-11-13", "baidu", ["世界杯预选赛集锦", "天气"]);
  });
  test("topics: days on list and longest consecutive streak", async () => {
    const r = await tool.run({ op: "hot_history", source: "weibo", days: 14 });
    const wc = r.sources.weibo.stayed_longest.find(t => t.title === "世界杯预选赛");
    assert.deepEqual([wc.days_on_list, wc.longest_streak_days, wc.best_rank, wc.first, wc.last], [4, 3, 1, "2026-11-09", "2026-11-13"]);
    assert.equal(r.sources.weibo.stayed_longest[0].title, "世界杯预选赛");
    assert.ok(!r.sources.weibo.stayed_longest.some(t => t.title === "某明星离婚"), "one-day topics are not 'stayed'");
    assert.equal(r.sources.weibo.days_with_data, 4);
    assert.equal(r.sources.weibo.daily_top.at(-1).date, "2026-11-13");
    assert.match(r.sources.weibo.daily_top[0].top[0], /^1\. 世界杯预选赛/);
  });
  test("keyword filter spans sources and is case-insensitive", async () => {
    const r = await tool.run({ op: "hot_history", keyword: "世界杯", days: 14 });
    assert.equal(r.matches, 2);
    assert.deepEqual(r.topics.map(t => t.source + ":" + t.title), ["weibo:世界杯预选赛", "baidu:世界杯预选赛集锦"]);
    assert.equal(r.topics[0].appearances.length, 4);
    assert.match(r.topics[0].appearances[0], /^11-09 第1名/);
    const none = await tool.run({ op: "hot_history", keyword: "不存在", days: 14 });
    assert.equal(none.matches, 0);
  });
  test("days window and source validation", async () => {
    const r = await tool.run({ op: "hot_history", source: "weibo", days: 3 });
    assert.equal(r.sources.weibo.days_with_data, 1, "11-12 back to 11-15 holds only 11-13");
    assert.equal((await tool.run({ op: "hot_history", source: "tieba" })).ok, false);
    assert.deepEqual(Object.keys((await tool.run({ op: "hot_history", days: 14 })).sources).sort(), ["baidu", "weibo"]);
  });
  test("digest: week-over-week changes and new topics", async () => {
    D.saveQuotes(hub, [{ symbol: "usNVDA", name: "英伟达", price: 100, pct: 0, date: "2026-11-07" }, { symbol: "usNVDA", name: "英伟达", price: 110, pct: 1, date: "2026-11-14" }]);
    D.saveHot(hub, "2026-11-05", "weibo", [{ rank: 3, title: "世界杯预选赛", heat: "" }]);
    const r = await tool.run({ op: "digest" });
    assert.equal(r.quotes[0].vs_week_ago_pct, 10);
    assert.ok(r.hot_new_this_week.weibo.some(s => s.startsWith("股市大涨")));
    assert.ok(!r.hot_new_this_week.weibo.some(s => s.startsWith("世界杯")), "a topic that was already on the list last week is not new");
  });
});

describe("watchlist", () => {
  let hub, tool;
  beforeEach(() => { hub = fakeHub(); ({ tool } = makeTool(hub)); });
  test("default list for the main group; a test room sees the main group's", async () => {
    const r = await tool.run({ op: "watchlist" });
    assert.deepEqual(r.watchlist, D.DEFAULT_WATCHLIST);
    assert.ok(r.watchlist.includes("纳斯达克指数") && r.watchlist.includes("美元兑人民币"));
    const t = makeTool(hub, "t:room").tool;
    assert.deepEqual((await t.run({ op: "watchlist" })).watchlist, D.DEFAULT_WATCHLIST);
    await t.run({ op: "watchlist", action: "remove", names: ["特斯拉"] });
    assert.ok(!(await tool.run({ op: "watchlist" })).watchlist.includes("特斯拉"), "stored under the main group's key");
    assert.ok(hub.get("data:watchlist:g:main"));
  });
  test("a new name is validated through stock before it is added", async () => {
    const bad = await tool.run({ op: "watchlist", action: "add", names: ["不存在的股"] });
    assert.equal(bad.ok, false);
    assert.equal(bad.rejected[0].name, "不存在的股");
    assert.ok(!bad.watchlist.includes("不存在的股"));
    BY_NAME["比亚迪"] = mk("sz002594", "比亚迪", "300", "1", "20261113150000");
    const good = await tool.run({ op: "watchlist", action: "add", names: ["比亚迪", "苹果"] });
    delete BY_NAME["比亚迪"];
    assert.deepEqual(good.added.map(a => a.name), ["比亚迪"]);
    assert.match(good.added[0].resolved_to, /sz002594/);
    assert.equal(good.rejected[0].why, "已经在清单里");
    assert.ok(good.watchlist.includes("比亚迪"));
  });
  test("alias names validate through the quote source, not stock", async () => {
    await tool.run({ op: "watchlist", action: "remove", names: ["布伦特原油"] });
    const r = await tool.run({ op: "watchlist", action: "add", names: ["布伦特原油"] });
    assert.equal(r.ok, false, "no sample for hf_OIL in the fake source: rejected, not guessed");
    assert.deepEqual(hub.calls.stock, []);
  });
  test("remove, and removing something absent", async () => {
    const r = await tool.run({ op: "watchlist", action: "remove", names: ["苹果", "英伟达"] });
    assert.deepEqual(r.removed, ["英伟达", "苹果"].sort((a, b) => D.DEFAULT_WATCHLIST.indexOf(a) - D.DEFAULT_WATCHLIST.indexOf(b)));
    assert.equal((await tool.run({ op: "watchlist", action: "remove", names: ["苹果"] })).ok, false);
  });
  test("size cap", async () => {
    hub.set("data:watchlist:g:main", JSON.stringify(Array.from({ length: 30 }, (_, i) => "x" + i)));
    const r = await tool.run({ op: "watchlist", action: "add", names: ["苹果"] });
    assert.match(r.rejected[0].why, /最多/);
  });
});

describe("export", () => {
  test("quotes CSV: header, rows, escaping, filter, file id returned", async () => {
    const hub = fakeHub(); hub.now = BJ(2026, 11, 15, 12);
    D.saveQuotes(hub, [{ symbol: "usIXIC", name: "纳斯达克指数", price: 25136.27, pct: -0.91, date: "2026-11-13" }, { symbol: "hk00700", name: '腾讯,"控股"', price: 386.6, pct: null, date: "2026-11-13" }, { symbol: "usIXIC", name: "纳斯达克指数", price: 25366.09, pct: 0.4, date: "2026-11-12" }]);
    const { tool, kept } = makeTool(hub);
    const r = await tool.run({ op: "export", kind: "quotes", days: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.file, "f12");
    assert.equal(r.rows, 3);
    assert.equal(kept[0].text, 'date,symbol,name,close,change_pct\n2026-11-13,hk00700,"腾讯,""控股""",386.6,\n2026-11-12,usIXIC,纳斯达克指数,25366.09,0.4\n2026-11-13,usIXIC,纳斯达克指数,25136.27,-0.91\n');
    const one = await tool.run({ op: "export", kind: "quotes", symbols: ["纳指"], days: 30 });
    assert.equal(one.rows, 2);
    assert.equal((await tool.run({ op: "export", kind: "quotes", symbols: ["没有"], days: 30 })).ok, false);
  });
  test("hot CSV", async () => {
    const hub = fakeHub(); hub.now = BJ(2026, 11, 15, 12);
    D.saveHot(hub, "2026-11-13", "weibo", [{ rank: 1, title: "八冠神罚", heat: "399323" }]);
    D.saveHot(hub, "2026-11-13", "baidu", [{ rank: 1, title: "天气", heat: "" }]);
    const { tool, kept } = makeTool(hub);
    const r = await tool.run({ op: "export", kind: "hot", source: "weibo", days: 7 });
    assert.equal(r.rows, 1);
    assert.equal(kept[0].text, "date,source,rank,title,heat\n2026-11-13,weibo,1,八冠神罚,399323\n");
    assert.equal((await tool.run({ op: "export", kind: "hot", days: 7 })).rows, 2);
  });
});

describe("snapshots", () => {
  const BJ_FRI_EVENING = BJ(2026, 11, 13, 17);
  const q = hub => hub.sql.exec("SELECT day, symbol, name, close FROM datapoint ORDER BY symbol").toArray();

  test("A-share/HK slot stores only A-share/HK symbols, with the quote's own trading date", async () => {
    const hub = fakeHub();
    await feature.tick(hub, BJ_FRI_EVENING);
    await hub.settle();
    const rows = q(hub);
    assert.deepEqual(rows.map(r => r.symbol).sort(), ["hk00700", "hkHSI", "hkHSTECH", "sh000001", "sh600519", "sz399001", "sz399006"].sort());
    assert.ok(rows.every(r => r.day === "2026-11-13"));
    assert.equal(rows.find(r => r.symbol === "hkHSI").name, "恒生指数");
    const keys = [...hub.env.FILES.m.keys()];
    assert.deepEqual(keys, ["data/quotes/2026-11-13.json"]);
    const obj = JSON.parse(hub.env.FILES.m.get(keys[0]));
    assert.equal(obj.quotes.length, 7);
    assert.ok(hub.env.FILES.m.get(keys[0]).length < 4000, "a few KB");
    assert.equal(hub.plan.used.r2_writes, 1);
  });
  test("US slot stores US stocks, indices, FX and metals, dated by their own session", async () => {
    const hub = fakeHub();
    await feature.tick(hub, Date.UTC(2026, 10, 14, 22, 10));
    await hub.settle();
    const rows = q(hub);
    assert.deepEqual(rows.map(r => r.symbol).sort(), ["hf_CL", "hf_XAU", "usAAPL", "usBABA", "usDJI", "usIXIC", "usINX", "usNVDA", "usTSLA", "whUSDCNY"].sort());
    assert.equal(rows.find(r => r.symbol === "usIXIC").day, "2026-11-13");
    assert.equal(rows.find(r => r.symbol === "hf_XAU").day, "2026-11-14");
    assert.ok(hub.env.FILES.m.has("data/quotes/2026-11-15-us.json"));
    assert.equal(rows.find(r => r.symbol === "usIXIC").name, "纳斯达克指数", "not the Nasdaq Inc. stock that stock('纳斯达克') would return");
  });
  test("hot slot: all sources saved to SQLite and R2; one source failing does not stop the rest", async () => {
    const hub = fakeHub(); hub.failSources.add("zhihu");
    await feature.tick(hub, BJ(2026, 11, 15, 9, 1));
    await hub.settle();
    const per = hub.sql.exec("SELECT source, COUNT(*) n FROM hotitem GROUP BY source ORDER BY source").toArray();
    assert.deepEqual(per.map(r => r.source), ["baidu", "bilibili", "douyin", "github", "hackernews", "weibo"]);
    assert.ok([...hub.env.FILES.m.keys()].includes("data/hot/weibo/2026-11-15-09.json"));
    assert.ok(![...hub.env.FILES.m.keys()].some(k => k.includes("zhihu")));
    assert.equal(hub.get("data:mark:h-am:2026-11-15"), "1");
    const o = D.overview(hub);
    assert.equal(o.last_snapshots.hot.failed[0].source, "zhihu");
    assert.equal(o.recent_failures.at(-1).what, "热榜 zhihu");
    const obj = JSON.parse(hub.env.FILES.m.get("data/hot/bilibili/2026-11-15-09.json"));
    assert.deepEqual(obj.items[0], { r: 1, t: "产品行，刀恶心！Mate 90Pro Max典藏版一个月深度测评", h: "播放 73165", x: "机拍朱老师 BV1a4s36DERi" });
  });
  test("one failing watchlist name does not stop the others", async () => {
    const hub = fakeHub();
    hub.set("data:watchlist:g:main", JSON.stringify(["上证指数", "没这个股", "腾讯控股"]));
    const r = await D.snapshotQuotes(hub, "g:main", BJ_FRI_EVENING, "cnhk", "q-cnhk");
    assert.equal(r.saved, 2);
    assert.equal(r.failed[0].entry, "没这个股");
    assert.match(D.overview(hub).recent_failures[0].what, /没这个股/);
  });
  test("quote source down: alias entries fail, stock entries still saved", async () => {
    const hub = fakeHub(), keep = D.NET.text;
    D.NET.text = async () => { throw new Error("network"); };
    try {
      const r = await D.snapshotQuotes(hub, "g:main", Date.UTC(2026, 10, 14, 22, 10), "us", "q-us");
      assert.equal(r.saved, 4);   // 英伟达 特斯拉 苹果 阿里巴巴
      assert.ok(r.failed.some(f => f.entry === "纳斯达克指数"));
    } finally { D.NET.text = keep; }
  });
  test("a total failure is retried later (up to 3 tries), not marked done", async () => {
    const hub = fakeHub(); hub.failAllHot = true;
    const t0 = BJ(2026, 11, 15, 9, 1);
    await feature.tick(hub, t0); await hub.settle();
    assert.match(hub.get("data:mark:h-am:2026-11-15"), /^r1:/);
    await feature.tick(hub, t0 + 60000);
    assert.equal(hub.waits.length, 0, "not retried before 15 minutes");
    hub.set("data:mark:h-am:2026-11-15", "r1:" + (t0 - 1));
    await feature.tick(hub, t0 + 20 * 60000); await hub.settle();
    assert.match(hub.get("data:mark:h-am:2026-11-15"), /^r2:/);
    hub.failAllHot = false;
    hub.set("data:mark:h-am:2026-11-15", "r2:" + (t0 - 1));
    await feature.tick(hub, t0 + 40 * 60000); await hub.settle();
    assert.equal(hub.get("data:mark:h-am:2026-11-15"), "1");
    assert.ok(hub.sql.exec("SELECT COUNT(*) n FROM hotitem").toArray()[0].n > 0);
  });
  test("R2 allowance exhausted: SQLite still gets the data", async () => {
    const hub = fakeHub(); hub.cap = 0;
    const r = await D.snapshotHot(hub, "g:main", BJ(2026, 11, 15, 9, 1));
    assert.equal(r.ok.length, 7);
    assert.equal(hub.env.FILES.m.size, 0);
    assert.ok(hub.sql.exec("SELECT COUNT(*) n FROM hotitem").toArray()[0].n >= 7);
  });
  test("no R2 bucket at all is fine", async () => {
    const hub = fakeHub({ noR2: true });
    const r = await D.snapshotQuotes(hub, "g:main", BJ_FRI_EVENING, "all");
    assert.ok(r.saved > 10);
  });
  test("snapshot_now through the tool, then history works; admin route", async () => {
    const hub = fakeHub(); hub.now = BJ(2026, 11, 13, 17);
    const { tool } = makeTool(hub);
    const r = await tool.run({ op: "snapshot_now" });
    assert.equal(r.ok, true);
    assert.ok(r.quotes_saved >= 16, "every watchlist name the fake sources know");
    assert.equal(r.hot_saved.length, 7);
    const h = await tool.run({ op: "quotes_history", symbols: ["上证指数"], days: 7 });
    assert.equal(h.symbols[0].facts.last.close, 3634.35);
    const res = await feature.admin(hub, new Request("http://x/admin/data"), new URL("http://x/admin/data"), null);
    const o = await res.json();
    assert.equal(o.hot.total_days, 1);
    assert.ok(o.quotes.symbols >= 16);
    assert.ok(o.last_snapshots.quotes.at);
    assert.equal(await feature.admin(hub, new Request("http://x/admin/other"), new URL("http://x/admin/other"), null), null);
    hub.noQuota = true;
    assert.equal((await tool.run({ op: "snapshot_now" })).ok, false);
  });
  test("tool schema and text are sane", () => {
    const t = makeTool(fakeHub()).tool;
    assert.equal(t.name, "data");
    assert.deepEqual(t.parameters.properties.op.enum, ["quotes_history", "hot_history", "digest", "watchlist", "export", "snapshot_now"]);
    assert.match(t.description, /stock/);
    assert.ok(feature.about.length >= 4 && feature.about.every(l => /[一-鿿]/.test(l)));
  });
});
