// D8 工作台只读页的前端渲染：入口、账本、技能、日程、收件箱标签。
// 在 vm 里跑真实 web/app.js，用最小 DOM 桩，不发网络请求。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync("web/app.js", "utf8");
const html = readFileSync("web/index.html", "utf8");
const css = readFileSync("web/style.css", "utf8");
const NOW = Date.parse("2026-11-14T18:00:00+11:00");

function makeUi(options = {}) {
  const ids = new Map();
  const requests = [];
  const storage = new Map();
  const events = [];
  const listeners = {};
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [NOW]));
    }
    static now() {
      return NOW;
    }
  }
  class Node {
    constructor(tag = "div") {
      this.tagName = tag;
      this.children = [];
      this.attrs = {};
      this.hidden = false;
      this.textContent = "";
      this.className = "";
      this.value = "";
      this.disabled = false;
      this.open = false;
      this.parent = null;
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key === "class") this.className = String(value);
    }
    getAttribute(key) {
      return this.attrs[key];
    }
    focus() {}
    click() {
      events.push(["click", this.tagName]);
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    get options() {
      return this.children;
    }
    get classList() {
      return {
        add: (...names) => {
          const set = new Set(String(this.className).split(/\s+/).filter(Boolean));
          for (const name of names) set.add(name);
          this.className = [...set].join(" ");
        },
        remove: (...names) => {
          const set = new Set(String(this.className).split(/\s+/).filter(Boolean));
          for (const name of names) set.delete(name);
          this.className = [...set].join(" ");
        },
        contains: (name) => String(this.className).split(/\s+/).includes(name),
      };
    }
  }
  const toolbar = new Node("div");
  const body = new Node("body");
  const document = {
    hidden: false,
    body,
    activeElement: body,
    getElementById: (id) => {
      if (!ids.has(id)) ids.set(id, new Node("div"));
      return ids.get(id);
    },
    createElement: (tag) => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    createTextNode: (text) => {
      const node = new Node("#text");
      node._text = String(text);
      node.textContent = String(text);
      return node;
    },
    querySelector: (selector) => (selector === ".toolbar" ? toolbar : null),
  };
  const context = vm.createContext({
    document,
    sessionStorage: {
      getItem: (key) => storage.get(key) || "",
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    location: { origin: "https://team.example", hostname: "team.example", hash: options.hash || "", pathname: "/", search: "" },
    history: { replaceState: (_state, _title, url) => { events.push(["replace", url]); } },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    navigator: { clipboard: { writeText: async () => {} } },
    URL: Object.assign(URL, {
      createObjectURL: () => "blob:desk",
      revokeObjectURL: () => {},
    }),
    Blob,
    Response,
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || "GET" });
      if (options.fetch) return options.fetch(String(url), init);
      return Response.json({ error: "not_found" }, { status: 404 });
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { if (options.immediate) fn(); return 1; },
    clearTimeout: () => {},
    AbortController,
    AbortSignal,
    TextEncoder,
    Date: Clock,
    console,
    Node,
  });
  vm.runInContext(script, context);
  return { context, ids, requests, storage, events, listeners, toolbar, document };
}

const walk = (node) => [node, ...(node.children || []).flatMap(walk)];
const text = (node) => [node.textContent, ...(node.children || []).map(text)].join(" ");
const byClass = (node, name) =>
  walk(node).filter((item) => String(item.className || "").split(/\s+/).includes(name));
const buttons = (node) => walk(node).filter((item) => item.tagName === "button");
const labels = (node) => buttons(node).map((item) => text(item));
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

const ledgerType = {
  id: "rt-ledger", name: "报销额度", kind: "ledger", visibility_default: "group", status: "active",
  owner_name: "卡特龙", count: 3, created_at: Date.parse("2026-11-12T09:30:00+11:00"), updated_at: Date.parse("2026-11-14T17:49:00+11:00"),
};
const listType = {
  id: "rt-list", name: "购物清单", kind: "list", visibility_default: "group", status: "active",
  owner_name: "小红", count: 2, created_at: Date.parse("2026-11-12T09:30:00+11:00"), updated_at: Date.parse("2026-11-14T17:40:00+11:00"),
};
const ledgerRecord = {
  id: "r-000001", short: "#000001", person: "小明", title: "打车", amount: "¥360.00", amount_cents: 36000,
  occurred_at: Date.parse("2026-11-14T17:00:00+11:00"), created_at: Date.parse("2026-11-14T17:00:00+11:00"),
  creator_name: "小明", visibility: "group",
};
const ledgerData = {
  type: ledgerType,
  schema: { fields: [
    { key: "person", label: "人名", type: "person" },
    { key: "amount", label: "金额", type: "money" },
    { key: "title", label: "事项", type: "text" },
    { key: "occurred_at", label: "时间", type: "date" },
    { key: "cat", label: "类别", type: "text" },
  ] },
  rows: [
    ledgerRecord,
    { ...ledgerRecord, id: "r-000002", short: "#000002", person: "小红", title: "退款", amount: "-¥10.00", amount_cents: -1000 },
    { ...ledgerRecord, id: "r-000003", short: "#000003", person: "小明", title: "餐费", amount: "¥120.00", amount_cents: 12000 },
  ],
  hiddenPrivate: 2,
  mine_private: 0,
  summary: {
    groups: [
      { key: "小明", sum_cents: 48000, count: 2 },
      { key: "小红", sum_cents: -1000, count: 1 },
    ],
    total_cents: 47000,
    count: 3,
  },
};
const skillsData = {
  skills: [
    { id: "sk-1", name: "日结", triggers: ["日报", "结算"], steps: [{ action: "records_summary", type: "报销额度", group_by: "person", period: "this_month" }], note: "第一行说明\n第二行说明", owner_name: "小明", status: "active", uses: 3, last_used_at: Date.parse("2026-11-14T09:00:00+11:00") },
    { id: "sk-2", name: "旧例", triggers: [], steps: [{ action: "text", text: "固定的一句话" }], note: "", owner_name: "小红", status: "disabled", uses: 0, last_used_at: null },
  ],
};
const schedulesData = {
  limit: 10,
  schedules: [
    { id: "s-1", kind: "agent_task", tz: "Asia/Shanghai", spec: { cadence: "daily", time: "00:00", title: "每日余额", steps: [{ action: "quota" }] }, status: "active", next_run_at: Date.parse("2026-11-15T00:00:00+08:00"), fail_count: 0, last_error: null, owner_name: "小明", created_at: NOW - 1000, last_run: { status: "sent", at: NOW - 86400000 } },
    { id: "s-2", kind: "agent_task", tz: "Australia/Sydney", spec: { cadence: "monthly", time: "09:00", month_days: [1], title: "月度账本", steps: [{ action: "records_summary", type: "报销额度" }] }, status: "paused", next_run_at: null, fail_count: 9, last_error: "连续失败", owner_name: "小红", created_at: NOW - 2000, last_run: { status: "failed", at: NOW - 7200000, error: "发送失败" } },
    { id: "s-3", kind: "reminder", tz: "Australia/Sydney", spec: { cadence: "once", run_at: NOW - 10000, text: "交报告" }, status: "done", next_run_at: null, fail_count: 0, last_error: null, owner_name: "小明", created_at: NOW - 3000, last_run: null },
  ],
};

function setDesk(ui, patch) {
  const base = {
    tab: "ledger", types: [ledgerType, listType], typeId: "rt-ledger", showArchived: false,
    records: ledgerData, skills: skillsData.skills, schedules: schedulesData.schedules,
    loading: false, error: null, errorAt: 0, fatal: null,
    loadedAt: { ledger: NOW, skills: NOW, schedules: NOW },
    filters: { person: "", text: "", status: "", private: false },
    more: false, showEnded: false,
  };
  const desk = { ...base, ...patch };
  ui.context.__desk = desk;
  vm.runInContext("desk = __desk", ui.context);
  return desk;
}

function render(ui, tab) {
  vm.runInContext(`desk.tab=${JSON.stringify(tab)};renderDesk()`, ui.context);
  return ui.ids.get("desk-body");
}

test("入口：标签、工具栏隐藏与页面骨架", async () => {
  assert.match(html, /id="desk-view"/);
  assert.match(html, /id="desk-seg"/);
  assert.match(html, /登录后会直接打开群里发来的那一页。/);
  assert.match(css, /\/\* D8 · 账本与自动化 \*\//);
  const ui = makeUi();
  assert.match(text(ui.ids.get("tabs")), /账本与自动化/);
  setDesk(ui, {});
  vm.runInContext('state={who:{name:"hongming",role:"owner"}};selectView("desk")', ui.context);
  assert.equal(ui.toolbar.hidden, true, "进入 desk 隐藏全局工具栏");
  assert.equal(ui.ids.get("repo").hidden, true);
  assert.equal(ui.ids.get("search").hidden, true);
  assert.equal(ui.ids.get("person").hidden, true);
  assert.match(text(ui.ids.get("desk-seg")), /账本\/清单/);
  assert.match(text(ui.ids.get("desk-seg")), /技能/);
  assert.match(text(ui.ids.get("desk-seg")), /日程/);
});

test("账本页：头部、汇总、私有计数、表格与负数", async () => {
  const ui = makeUi();
  setDesk(ui, {});
  const body = render(ui, "ledger");
  const all = text(body);
  assert.match(all, /报销额度/);
  assert.match(all, /账本 · 建本人 卡特龙/);
  assert.match(all, /下载 CSV/);
  assert.match(all, /最多 500 行；不含私有记录。/);
  assert.match(all, /按人汇总/);
  assert.match(all, /共 3 笔/);
  assert.match(all, /合计/);
  assert.match(all, /另有 2 条私有记录（仅记录人在群里可用「撤销\/修改」处理）/);
  assert.match(all, /时间/);
  assert.match(all, /人名/);
  assert.match(all, /事项/);
  assert.match(all, /金额/);
  assert.match(all, /创建人/);
  assert.match(all, /编号/);
  assert.match(all, /#000001/);
  assert.ok(byClass(body, "desk-neg").length >= 1, "负数金额用 desk-neg");
  assert.equal(byClass(body, "desk-private").length, 0, "私有行不下发也不渲染");
  const table = byClass(body, "desk-records")[0];
  assert.ok(table, "有记录表");
  const cells = walk(table).filter((n) => n.tagName === "td");
  assert.ok(cells.every((n) => n.attrs["data-label"]), "每个 td 都有 data-label");
  assert.ok(byClass(body, "desk-sum-row").length >= 3, "两行人和一行合计");
});

test("账本页：筛选 chip 与搜索走后端", async () => {
  const ui = makeUi({
    fetch: async (url) => {
      if (url.startsWith("/api/records?")) return Response.json({ ...ledgerData, type: { ...ledgerType, kind: "list", id: "rt-list", name: "购物清单" }, rows: [ledgerRecord], summary: undefined, status_counts: { todo: 1, done: 1 } });
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  setDesk(ui, { typeId: "rt-list", records: { ...ledgerData, type: { ...ledgerType, kind: "list", id: "rt-list", name: "购物清单" }, status_counts: { todo: 1, done: 1 }, summary: undefined } });
  const body = render(ui, "ledger");
  const todo = buttons(body).find((b) => text(b).includes("待办 · 1"));
  assert.ok(todo, "待办 chip 存在");
  await todo.onclick();
  await settle();
  assert.ok(ui.requests.some((r) => r.url.includes("status=todo")), "点 chip 后请求带 status=todo");
  assert.equal(ui.ids.get("desk-body").children.length > 0, true);
});

test("账本页：CSV 下载走 api 且 toast 正确", async () => {
  const ui = makeUi({
    fetch: async () => Response.json({ filename: "报销额度-2026-11-14.csv", csv: "\uFEFF记录号\r\n", rows: 2, truncated: false }),
  });
  setDesk(ui, {});
  const body = render(ui, "ledger");
  const download = buttons(body).find((b) => text(b) === "下载 CSV");
  assert.ok(download);
  await download.onclick();
  await settle();
  assert.ok(ui.requests[0].url.startsWith("/api/records/export?type=rt-ledger"));
  assert.equal(ui.ids.get("toast").textContent, "已下载 2 行");
  assert.equal(ui.ids.get("toast").hidden, false);
});

test("技能页：统计、步骤摘要、使用与空状态", async () => {
  const ui = makeUi();
  setDesk(ui, {});
  const body = render(ui, "skills");
  const all = text(body);
  assert.match(all, /启用中 1/);
  assert.match(all, /已停用 1/);
  assert.doesNotMatch(all, /待确认 0/);
  assert.match(all, /本群最多 20 个/);
  assert.match(all, /「日结」/);
  assert.match(all, /报销额度汇总·按人（本月）/);
  assert.match(all, /3 次/);
  assert.match(all, /上次/);
  assert.match(all, /还没用过/);
  assert.match(all, /启用中/);
  assert.match(all, /已停用/);
  assert.match(all, /固定文字「固定的一句话」/);
  assert.ok(!all.includes("固定的一句话」…"), "不足 16 字不加省略号");
  assert.ok(byClass(body, "desk-skills")[0], "技能表");
  assert.ok(walk(body).filter((n) => n.tagName === "th").every((n) => n.attrs.scope === "col"));
});

test("日程页：双时区、暂停高亮、失败次数与已结束开关", async () => {
  const ui = makeUi();
  setDesk(ui, {});
  let body = render(ui, "schedules");
  let all = text(body);
  assert.match(all, /运行中 1/);
  assert.match(all, /已暂停 1/);
  assert.match(all, /本群 2 \/ 10 个/);
  assert.match(all, /显示已结束（1）/);
  assert.match(all, /每天 00:00（北京）/);
  assert.match(all, /11月15日 周日 00:00 北京/);
  assert.match(all, /悉尼 03:00/);
  assert.match(all, /已暂停，不会发送/);
  assert.match(all, /暂停原因：连续失败/);
  assert.match(all, /连续失败满 9 次会自动暂停/);
  assert.match(all, /9/);
  assert.doesNotMatch(all, /交报告/, "默认不显示已结束");
  assert.ok(byClass(body, "is-paused").length >= 1, "暂停行有 is-paused");
  const chip = buttons(body).find((b) => text(b).includes("显示已结束（1）"));
  assert.ok(chip);
  chip.onclick();
  await settle();
  body = ui.ids.get("desk-body");
  all = text(body);
  assert.match(all, /交报告|提醒：交报告/);
});

test("空状态文案", async () => {
  const ui = makeUi();
  setDesk(ui, { types: [], typeId: "", records: null });
  let body = render(ui, "ledger");
  assert.match(text(body), /还没有账本或清单。/);
  assert.match(text(body), /记账 报销额度 我¥360/);
  setDesk(ui, { skills: [] });
  body = render(ui, "skills");
  assert.match(text(body), /还没有技能。/);
  setDesk(ui, { schedules: [] });
  body = render(ui, "schedules");
  assert.match(text(body), /还没有日程。/);
});

test("任务看板 repo=inbox 显示收件箱", async () => {
  const ui = makeUi();
  vm.runInContext(`
    state = {
      who: { name: "hongming", role: "owner" },
      repos: ["OmnixSI/TeamAgent"], projects: [], members: [], teammates: [],
      configuration: { model: { effort_by_kind: {}, quick_effort: "high", important_effort: "max" } },
      connection: {}, project: { version: "test" }, revision: 1,
      tasks: [{ id: "t1", repo: "inbox", title: "群里临时交办", detail: "", status: "proposal", version: 1, assignee: "", result: "", updated_at: ${NOW} }],
      activity: [], discoveries: [], facts: [], dreams: [], expressions: [], utilities: []
    };
    view = "tasks";
    renderTasks();
  `, ui.context);
  assert.match(text(ui.ids.get("board")), /收件箱/);
  assert.equal(vm.runInContext('repoLabel("inbox")', ui.context), "收件箱");
  assert.equal(vm.runInContext('repoLabel("OmnixSI/TeamAgent")', ui.context), "TeamAgent");
});
