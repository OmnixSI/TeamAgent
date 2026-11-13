import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync("web/app.js", "utf8");
const now = Date.parse("2026-11-14T02:00:00+11:00");
const stamp = (day, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+11:00`);

function reviewFixture() {
  const evidence = (source, id, quote, extra = {}) => ({ source, id, quote, ...extra });
  const finding = (over = {}) => ({
    id: "f1",
    trace_id: "tr-in-m1",
    created_at: stamp("2026-11-13"),
    failure_type: "reasoning.decision.tool_selection",
    severity: "p1",
    fix_layer: "prompt",
    gap_type: "tool_not_selected",
    capability: "repo_disambiguation",
    should_use_tool: "repo_search",
    dimensions: {
      answered: "UNSATISFIED",
      facts: "SATISFIED",
      tool_choice: "UNSATISFIED",
      memory: "INSUFFICIENT",
      expression: "SATISFIED",
      boundary: "SATISFIED",
    },
    evidence: [
      evidence("message", "m1", "我们仓库最近有哪些提交", { rowid: 428, origin: "direct" }),
      evidence("outbox", "o1", "我看不到仓库", { origin: "bot" }),
      evidence("image", "m2", "截图里是提交列表", { origin: "image_text" }),
    ],
    inbound: { id: "m1", rowid: 428, ts: stamp("2026-11-13"), sender_name: "杨鸿明", body_excerpt: "我们仓库最近有哪些提交" },
    what_happened: "没有调用仓库工具就回答看不到提交。",
    expected: "先调用 repo_search，再按结果回答。",
    root_cause: "工具选择漏了仓库检索。",
    next_attempt_plan: "先查仓库，再回答。",
    confidence: 0.82,
    agreement: "single",
    status: "open",
    reviewed_by: null,
    reviewed_at: null,
    ...over,
  });
  return {
    health: {
      ok: true,
      release: "test",
      migration: "0008",
      mode: "propose",
      off: false,
      last_run: { date: "2026-11-13", step: "done", updated_at: stamp("2026-11-13", 7) },
    },
    digest: {
      days: [
        {
          date: "2026-11-13",
          group_id: "g1",
          group_label: "做 AI 高手",
          run: {
            step: "done",
            mode: "propose",
            model: "deepseek-flash",
            same_family: 0,
            judge_calls: 4,
            error: null,
            updated_at: stamp("2026-11-13", 7),
            spend: { deepseek: 36000 },
          },
          answers: {
            failures: "漏调仓库工具。",
            requirements: "回答前先查仓库。",
            memory: "待记住：仓库是 OmnixSI/TeamAgent。",
            unanswered: "1 条待回答",
            changes: "补工具选择提示词。",
          },
          precision: { accepted: 1, rejected: 1, open: 2, rejects: 1 },
          new_gaps: 1,
          promises_broken: [{ id: "p1", what: "发日报", quote: "我明天发日报", status: "broken" }],
          findings: [
            finding(),
            finding({ id: "f2", status: "accepted", agreement: "agree", severity: "p2", created_at: stamp("2026-11-13", 10) }),
            finding({ id: "f3", status: "rejected", agreement: "agree", severity: "p0", created_at: stamp("2026-11-13", 9) }),
            finding({ id: "f4", status: "disputed", agreement: "disagree", severity: "p0", created_at: stamp("2026-11-13", 8) }),
            finding({ id: "f5", status: "fixed", agreement: "agree", severity: "p2", created_at: stamp("2026-11-13", 7) }),
          ],
          memory_candidates: [
            {
              id: "mc1", op: "ADD", repo: "OmnixSI/TeamAgent", subject: "TeamAgent", predicate: "仓库",
              value: "OmnixSI/TeamAgent", state: "candidate", status: "candidate", target_version: null,
              created_at: stamp("2026-11-13", 6),
              evidence: [{ source: "message", id: "m20", quote: "以后记住仓库是 OmnixSI/TeamAgent", origin: "direct" }],
            },
            {
              id: "mc2", op: "DELETE", repo: "OmnixSI/TeamAgent", subject: "陪玩店", predicate: "仓库",
              value: "旧仓库", state: "candidate", status: "candidate",
              target_version: "2026-11-10T00:00:00Z", created_at: stamp("2026-11-13", 5),
              evidence: [{ source: "message", id: "m21", quote: "陪玩店那个仓库别再记了", origin: "direct" }],
            },
            {
              id: "mc3", op: "UPDATE", repo: "OmnixSI/TeamAgent", subject: "部署", predicate: "方式",
              value: "手动 runbook", state: "conflict", status: "conflict",
              target_version: "2026-11-12T00:00:00Z", created_at: stamp("2026-11-13", 4),
              evidence: [{ source: "message", id: "m22", quote: "部署改成手动 runbook", origin: "direct" }],
            },
          ],
          coverage: { balanced: true, unaccounted: 0 },
          budget: {
            providers: [
              { day_utc: "2026-11-13", provider: "deepseek", unit: "usd_micros", used: 36000, reserved: 0, cap: 100000, calls: 4 },
            ],
          },
          judge_failed: 1,
          disputed: 1,
          agreement: { agree: 3, disagree: 1, single: 1, pending: 0, rate: 0.75 },
        },
        {
          date: "2026-11-12",
          group_id: "g1",
          group_label: "做 AI 高手",
          run: { step: "failed", mode: "propose", same_family: 1, judge_calls: 1, error: "judge_timeout", updated_at: stamp("2026-11-12", 7) },
          answers: { failures: "", requirements: "", memory: "", unanswered: "", changes: "" },
          precision: { accepted: 0, rejected: 0, open: 1, rejects: 0 },
          new_gaps: 0,
          promises_broken: [],
          findings: [finding({ id: "f6", status: "open", agreement: "single", created_at: stamp("2026-11-12", 9) })],
          memory_candidates: [],
          coverage: { balanced: false, unaccounted: 2 },
          budget: { providers: [] },
          judge_failed: 0,
          disputed: 0,
          agreement: { agree: 0, disagree: 0, single: 1, pending: 0, rate: null },
        },
      ],
      gaps: [
        {
          fingerprint: "g-repo",
          gap_type: "tool_not_selected",
          capability: "repo_disambiguation",
          occurrences: 3,
          first_seen: stamp("2026-11-10"),
          last_seen: stamp("2026-11-13"),
          status: "open",
          owner: "程序员",
          proposed_action: "补仓库检索提示词。",
          task_id: "rv-g-repo",
          task_title: "[复盘] 仓库检索",
          external_ref: null,
        },
        {
          fingerprint: "g-bili",
          gap_type: "tool_missing",
          capability: "bili_video",
          occurrences: 2,
          first_seen: stamp("2026-11-09"),
          last_seen: stamp("2026-11-12"),
          status: "regression",
          owner: "工程师",
          proposed_action: "检查视频工具。",
          task_id: null,
          task_title: null,
          external_ref: "F5",
        },
      ],
      rules: [
        {
          id: "r1",
          rule: "回复短一点。",
          scene: "群聊",
          kind: "free",
          params: "{}",
          status: "candidate",
          source: "member:u1",
          canary_until: null,
          expires_at: stamp("2026-12-13"),
          hits: 0,
          corrections: 0,
          rollback_reason: null,
          created_at: stamp("2026-11-13"),
          updated_at: stamp("2026-11-13"),
        },
        {
          id: "r2",
          rule: "每次连续回复最多1条。",
          scene: "群聊",
          kind: "burst_max",
          params: "{\"max\":1}",
          status: "canary",
          source: "review:f1",
          canary_until: stamp("2026-11-16"),
          expires_at: stamp("2026-12-13"),
          hits: 2,
          corrections: 1,
          rollback_reason: null,
          created_at: stamp("2026-11-13"),
          updated_at: stamp("2026-11-13"),
        },
        {
          id: "r3",
          rule: "优先使用普通段落回复。",
          scene: "群聊",
          kind: "format_pref",
          params: "{\"format\":\"plain\"}",
          status: "active",
          source: "review:f2",
          canary_until: null,
          expires_at: stamp("2026-12-10"),
          hits: 4,
          corrections: 0,
          rollback_reason: null,
          created_at: stamp("2026-11-10"),
          updated_at: stamp("2026-11-12"),
        },
        {
          id: "r4",
          rule: "已经撤销的约定。",
          scene: "群聊",
          kind: "free",
          params: "{}",
          status: "retired",
          source: "member:u2",
          canary_until: null,
          expires_at: stamp("2026-12-01"),
          hits: 1,
          corrections: 1,
          rollback_reason: "误判",
          created_at: stamp("2026-11-01"),
          updated_at: stamp("2026-11-02"),
        },
      ],
    },
    state: {
      who: { name: "杨鸿明", role: "member" },
      repos: ["OmnixSI/TeamAgent"],
      projects: [],
      tasks: [],
      connection: { fullMessageVerified: true, lastMessage: stamp("2026-11-14", 1) },
      project: { version: "d93b0780000000000000" },
      configuration: {
        memory: { timezone: "Australia/Sydney", start_hour: 4, end_hour: 7 },
        model: { effort_by_kind: { participation: "high" }, important_effort: "max" },
      },
      teammates: [],
      identity: { note: "测试身份" },
      facts: [],
      expressions: [],
      dreams: [],
      members: [],
      activity: [],
      utilities: [],
      discoveries: [],
      revision: 1,
    },
  };
}

function makeUi(options = {}) {
  const fixture = reviewFixture();
  const ids = new Map(),
    requests = [],
    storage = new Map([["team-token", "token-1"]]),
    document = { hidden: false, activeElement: null };
  class Node {
    constructor(tag = "div") {
      this.tagName = tag;
      this.children = [];
      this.attrs = {};
      this._text = "";
      this._value = "";
      this.className = "";
      this.style = {};
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.parent = null;
      this.isConnected = true;
    }
    set textContent(value) {
      this._text = String(value);
      this.children = [];
    }
    get textContent() {
      return this._text;
    }
    get value() {
      return this._value;
    }
    set value(value) {
      this._value = String(value);
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      for (const node of this.children) node.parent = null;
      this.children = [];
      this.append(...nodes);
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    }
    getAttribute(key) {
      return this.attrs[key];
    }
    focus() {
      document.activeElement = this;
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
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
  }
  const body = new Node("body");
  document.activeElement = body;
  document.body = body;
  document.getElementById = (id) => {
    if (!ids.has(id)) ids.set(id, new Node("div"));
    return ids.get(id);
  };
  document.createElement = (tag) => new Node(tag);
  document.createElementNS = (_ns, tag) => new Node(tag);
  document.createTextNode = (text) => {
    const node = new Node("#text");
    node._text = String(text);
    return node;
  };
  const context = vm.createContext({
    document,
    sessionStorage: {
      getItem: (key) => storage.get(key) || "",
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    location: { origin: "https://team.example", hostname: "team.example", hash: "" },
    history: { replaceState: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, init = {}) => {
      const text = String(url);
      requests.push({ url: text, method: init.method || "GET", body: init.body });
      if (options.fetch) {
        const custom = await options.fetch(text, init);
        if (custom) return custom;
      }
      if (text === "/api/team/state") return Response.json(fixture.state);
      if (text.endsWith("/review/health")) {
        if (options.health) return options.health;
        return Response.json(fixture.health);
      }
      if (text.includes("/review/digest?days=7")) {
        if (options.digest) return options.digest;
        return Response.json(fixture.digest);
      }
      if (text.includes("/review/digest?date=")) return Response.json(fixture.dayDigest);
      if (text.includes("/review/finding/")) return Response.json({ ok: true });
      if (text.includes("/review/rule/")) return Response.json({ ok: true });
      if (text.includes("/review/memory/")) return Response.json({ ok: true, fact_id: "fact-1" });
      return Response.json({ error: "not_found" }, { status: 404 });
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    AbortController,
    AbortSignal,
    TextEncoder,
    URL,
    Date,
    console,
    Response,
    Node,
  });
  vm.runInContext(script, context);
  return { context, ids, requests, fixture, text: (node) => [node.textContent, ...node.children.map((child) => (child.tagName === "#text" ? child.textContent : makeText(child)))].join(" ") };
}

function makeText(node) {
  return [node.textContent, ...node.children.map((child) => (child.tagName === "#text" ? child.textContent : makeText(child)))].join(" ");
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
const byClass = (node, name) => walk(node).filter((item) => String(item.className || "").split(/\s+/).includes(name));
const buttons = (node) => walk(node).filter((item) => item.tagName === "button");
const buttonLabels = (node) => buttons(node).map((item) => item.textContent);
const settle = async (times = 8) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("复盘面板：非管理员不渲染任何管理按钮", async () => {
  const ui = makeUi();
  await settle();
  vm.runInContext("selectView('memory')", ui.context);
  await settle();
  const review = vm.runInContext('$("review")', ui.context);
  assert.ok(review.children.length > 0);
  assert.match(makeText(review), /只读/);
  assert.match(makeText(review), /7 天精度/);

  for (const card of byClass(review, "review-finding")) {
    const labels = buttonLabels(card);
    assert.ok(!labels.some((label) => ["准确", "误判", "采纳", "驳回"].includes(label)), `发现卡片不该有标注按钮：${labels}`);
  }
  for (const card of byClass(review, "review-rule")) {
    assert.ok(!buttonLabels(card).some((label) => ["撤销", "批准试用"].includes(label)), "规则卡片不该有管理按钮");
  }
  assert.match(makeText(review), /评判失败 1/);
  assert.doesNotMatch(makeText(review), /judge_failed/);
  vm.runInContext("review.tab='memory';renderReview()", ui.context);
  await settle();
  const memoryCards = byClass(review, "review-memory");
  assert.equal(memoryCards.length, 3);
  assert.match(makeText(review), /以后记住仓库是 OmnixSI\/TeamAgent/);
  assert.match(makeText(review), /目标记忆版本：\s*2026-11-12T00:00:00Z/);
  for (const card of memoryCards) {
    assert.ok(!buttonLabels(card).some((label) => ["批准写入", "驳回"].includes(label)), "记忆候选不该有管理按钮");
  }
  assert.equal(ui.requests.filter((request) => request.url.includes("/review/digest?date=")).length, 0);
});

test("复盘面板：管理员看到标注、批准试用、撤销与记忆按钮", async () => {
  const ui = makeUi();
  await settle();
  vm.runInContext("state.who.role='owner';selectView('memory')", ui.context);
  await settle();
  vm.runInContext("review.tab='findings';renderReview()", ui.context);
  const review = vm.runInContext('$("review")', ui.context);
  const findingLabels = byClass(review, "review-finding-actions").flatMap(buttonLabels);
  assert.ok(findingLabels.includes("准确"));
  assert.ok(findingLabels.includes("误判"));
  assert.ok(findingLabels.includes("采纳"));
  assert.ok(findingLabels.includes("驳回"));

  vm.runInContext("review.tab='rules';renderReview()", ui.context);
  const rules = vm.runInContext('$("review")', ui.context);
  const ruleLabels = byClass(rules, "review-rule").flatMap(buttonLabels);
  assert.ok(ruleLabels.includes("撤销"));
  assert.ok(ruleLabels.includes("批准试用"));
  assert.ok(makeText(rules).includes("连发最多 1 条"), "类型化规则要显示参数");

  vm.runInContext("review.tab='memory';renderReview()", ui.context);
  const memory = vm.runInContext('$("review")', ui.context);
  const memoryCards = byClass(memory, "review-memory");
  assert.equal(memoryCards.length, 3);
  assert.ok(memoryCards.flatMap(buttonLabels).includes("批准写入"));
  assert.ok(memoryCards.flatMap(buttonLabels).includes("驳回"));
  assert.ok(byClass(memory, "review-memory").some((card) => makeText(card).includes("目标记忆版本： 2026-11-12T00:00:00Z") || makeText(card).includes("目标记忆版本：2026-11-12T00:00:00Z")));
});

test("复盘面板：批准记忆候选后按钮消失", async () => {
  const ui = makeUi();
  await settle();
  vm.runInContext("state.who.role='owner';selectView('memory');review.tab='memory';renderReview()", ui.context);
  await settle();
  let review = vm.runInContext('$("review")', ui.context);
  const card = byClass(review, "review-memory").find((item) => makeText(item).includes("TeamAgent · 仓库"));
  const approve = buttons(card).find((item) => item.textContent === "批准写入");
  assert.ok(approve);
  await approve.onclick();
  const patch = ui.requests.filter((request) => request.method === "PATCH").at(-1);
  assert.equal(patch.url, "https://inkboard-team-review.inkboard-server.workers.dev/review/memory/mc1");
  assert.deepEqual(JSON.parse(patch.body), { status: "approved" });
  review = vm.runInContext('$("review")', ui.context);
  const updated = byClass(review, "review-memory").find((item) => makeText(item).includes("TeamAgent · 仓库"));
  assert.ok(byClass(updated, "badge").some((item) => item.textContent === "已写入"));
  assert.ok(!buttonLabels(updated).includes("批准写入"));
});

test("复盘面板：再次点已选中的准确会撤回标注", async () => {
  const ui = makeUi();
  await settle();
  vm.runInContext("state.who.role='owner';selectView('memory');review.tab='findings';renderReview()", ui.context);
  await settle();
  const review = vm.runInContext('$("review")', ui.context);
  const accepted = byClass(review, "review-finding").find((card) =>
    byClass(card, "badge").some((item) => item.textContent === "准确"),
  );
  const button = buttons(accepted).find((item) => item.textContent === "准确");
  assert.ok(button);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  await button.onclick();
  const patch = ui.requests.filter((request) => request.method === "PATCH").at(-1);
  assert.equal(JSON.parse(patch.body).status, "open");
  assert.equal(ui.ids.get("toast").textContent, "已撤回标注");
});

test("撤销弹窗：空原因不发请求并显示错误", async () => {
  const ui = makeUi();
  await settle();
  vm.runInContext("state.who.role='owner';selectView('memory');review.tab='rules';renderReview()", ui.context);
  await settle();
  const rule = byClass(vm.runInContext('$("review")', ui.context), "review-rule")[0];
  const retire = buttons(rule).find((item) => item.textContent === "撤销");
  assert.ok(retire);
  await retire.onclick();
  const modal = ui.ids.get("modal");
  assert.equal(modal.open, true);
  const detail = ui.ids.get("detail");
  const confirm = buttons(detail).find((item) => item.textContent === "确认撤销");
  const before = ui.requests.filter((request) => request.method === "PATCH").length;
  await confirm.onclick();
  assert.equal(ui.requests.filter((request) => request.method === "PATCH").length, before);
  assert.ok(makeText(detail).includes("请写一句撤销原因"));
});

test("复盘面板：health.off 与 shadow 模式文案", async () => {
  const ui = makeUi();
  await settle();
  vm.runInContext("state.who.role='owner';selectView('memory')", ui.context);
  await settle();
  vm.runInContext("review.health.off=true;review.health.mode='shadow';renderReview()", ui.context);
  const review = vm.runInContext('$("review")', ui.context);
  const text = makeText(review);
  assert.match(text, /已暂停 · off:review/);
  assert.match(text, /现在是影子模式：只记录，不建任务、不改规则。/);
});

test("复盘服务 401 只在面板里提示，不把看板踢回登录页", async () => {
  const ui = makeUi({
    digest: Response.json({ error: "unauthorized" }, { status: 401 }),
  });
  await settle();
  vm.runInContext("selectView('memory')", ui.context);
  await settle(12);
  const review = vm.runInContext('$("review")', ui.context);
  assert.match(makeText(review), /复盘服务不认这次登录/);
  assert.equal(ui.ids.get("app").hidden, false);
});
