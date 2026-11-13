let token = sessionStorage.getItem("team-token") || "",
  localSession = sessionStorage.getItem('local-session') || '',
  state,
  view = "tasks",
  loginTimer,
  lastFull = 0,
  loading = false;
const LOCAL_LOCKED = '本机开发台未解锁';
const LOCAL_UNLOCK_HINT = '本机开发台未解锁：双击桌面「TeamAgent-登录」→ 选「打开开发台（B 站扫码）」';
function localOwner() { return location.origin === 'http://127.0.0.1:3391'; }
const $ = (s) => document.getElementById(s),
  names = {
    proposal: "方案待确认",
    queued: "等待自动执行",
    running: "自动执行中",
    in_progress: "成员处理中",
    needs_human: "待成员接手",
    ready_for_review: "待评审",
    done: "已完成",
    failed: "处理失败",
    cancelled: "已停止",
  };
const tabs = {
  tasks: "任务与方案",
  materials: "资料与发现",
  projects: "项目动态",
  memory: "记忆与成长",
  activity: "操作记录",
  system: "运行状态",
};
/* V-D D-12 · 复盘面板 */
const REVIEW_BASE = "https://inkboard-team-review.inkboard-server.workers.dev"; // 占位：D-11 上线后核对；置 "" 即「未配置」
const REVIEW_MODE = { shadow: "影子模式 · 只记录", propose: "提案模式", full: "全面生效" };
const REVIEW_STEP = { done: "完成", failed: "失败", skipped: "跳过", snapshot: "进行中 · 快照", trace: "进行中 · 整理对话", judge: "进行中 · 评判", apply: "进行中 · 归档", publish: "进行中 · 发布" };
const REVIEW_QA = [["failures","哪里没做好"],["requirements","大家提了什么要求"],["memory","该记住 / 不该做什么"],["unanswered","哪些没回答"],["changes","该改什么"]];
const REVIEW_DIMS = [["answered","答到"],["facts","事实"],["tool_choice","工具"],["memory","记忆"],["expression","表达"],["boundary","边界"]];
const REVIEW_VERDICT = { SATISFIED: ["✓","满足","is-ok"], UNSATISFIED: ["✕","不满足","is-bad"], INSUFFICIENT: ["?","资料不足","is-na"] };
const REVIEW_SEVERITY = { p0: ["P0","bad"], p1: ["P1","warn"], p2: ["P2",""] };
const REVIEW_FINDING_STATUS = { open: ["待标注",""], accepted: ["准确","ok"], rejected: ["误判",""], fixed: ["已修复","ok"], wontfix: ["不修",""], regression: ["回归","bad"], disputed: ["待复核","warn"] };
const REVIEW_GAP_TYPE = { tool_missing: "缺工具", tool_not_selected: "有工具没用", tool_failed: "工具出错", capability_offline: "执行端离线", switch_or_policy_off: "开关关着", data_stale_or_coverage: "数据过期/未覆盖", prompt_rule_missing: "缺规则" };
const REVIEW_GAP_STATUS = { open: ["待处理","warn"], proposed: ["已提案",""], fixed: ["已修复","ok"], wontfix: ["不修",""], regression: ["回归","bad"] };
const REVIEW_RULE_STATUS = { candidate: ["候选",""], canary: ["试行中","warn"], active: ["生效中","ok"], frozen: ["已冻结",""], retired: ["已撤销",""] };
const REVIEW_FIX_LAYER = { product: "产品", prompt: "提示词", tool_impl: "工具实现", ops: "运维", permission: "权限", data: "数据", memory: "记忆" };
const REVIEW_SOURCE = { message: "群消息", outbox: "bot 回复", snapshot: "快照", tool: "工具", image: "图片描述" };
const REVIEW_ORIGIN = { direct: "本人原话", quoted: "引用", forwarded: "转发", card: "卡片", attachment_text: "附件文字", image_text: "图片描述", bot: "bot 消息" };
const REVIEW_MEMORY_OP = { ADD: ["新增","ok"], UPDATE: ["修改","warn"], DELETE: ["不再记住","bad"] };
const REVIEW_MEMORY_STATUS = { candidate: ["待批准",""], approved: ["已批准","ok"], applied: ["已写入","ok"], rejected: ["已驳回",""], blocked: ["已阻止","bad"], conflict: ["冲突","bad"], superseded: ["已被替代",""] };
const REVIEW_RULE_PARAM = {
  reply_max_chars: (p) => "最多 " + p.max + " 字",
  burst_max: (p) => "连发最多 " + p.max + " 条",
  mention_only_window: (p) => "仅在被点名后 " + p.minutes + " 分钟内回复",
  language: (p) => "语言 " + p.language,
  format_pref: (p) => "格式 " + p.format,
};
const review = {
  loading: false, loadedAt: 0, error: null, data: null, health: null, healthError: null,
  tab: sessionStorage.getItem("review-tab") || "days",
  filter: "all", showRetired: false, openDays: new Set(), openFindings: new Set(),
  daysInit: false, memory: null, memoryLoading: false, memoryError: null, memoryLoadedAt: 0,
};

const date = (t) =>
  t
    ? new Date(t).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚无记录";
const short = (r) => (r ? r.split("/").pop() : "团队");
function el(tag, text, cls) {
  const x = document.createElement(tag);
  if (text !== undefined) x.textContent = text;
  if (cls) x.className = cls;
  return x;
}
function button(text, fn, cls) {
  const b = el("button", text, cls);
  b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      error(e);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
function link(text, url) {
  const a = el("a", text);
  try {
    const u = new URL(url);
    if (u.protocol === "https:") {
      a.href = u.href;
      a.target = "_blank";
      a.rel = "noreferrer";
    }
  } catch {}
  return a;
}
function localConsoleLink(text) {
  const a = el('a', text);
  a.href = 'http://127.0.0.1:3391/'; a.target = '_blank'; a.rel = 'noreferrer';
  return a;
}
function showLocalLocked() {
  localSession = ''; sessionStorage.removeItem('local-session');
  $('app').hidden = true; $('login').hidden = false; $('nameform').hidden = true;
  $('logincode').textContent = LOCAL_UNLOCK_HINT; $('error').textContent = '';
}
function localLockedError() {
  showLocalLocked();
  const error = Error(LOCAL_LOCKED); error.localLocked = true; return error;
}
function badge(text, kind) {
  return el("span", text, "badge " + (kind || ""));
}
function empty(text) {
  return el("p", text, "empty");
}
function error(e) {
  if (e.localLocked && localOwner()) return;
  $("error").textContent = e.message || String(e);
  if ($("modal").open) toast(e.message || String(e));
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  setTimeout(() => ($("toast").hidden = true), 3500);
}
async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(localOwner() ? {'X-TeamAgent-Session':localSession,'X-TeamAgent-Local':'1'} : {Authorization:"Bearer " + token}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) {
    if (localOwner() && r.status === 401 && j.error === LOCAL_LOCKED) throw localLockedError();
    if (r.status === 401 && state) {
      $("app").hidden = true;
      $("login").hidden = false;
    }
    const error = Error(j.error || "请求失败"); error.status = r.status; throw error;
  }
  return j;
}
async function copy(text) {
  await navigator.clipboard.writeText(text);
  toast("已复制，可交给本机 AI");
}
function show(...nodes) {
  $("detail").replaceChildren(...nodes);
  if (!$("modal").open) $("modal").showModal();
}
function field(name, input) {
  const l = el("label", name);
  l.append(input);
  return l;
}
function input(value = "") {
  const x = el("input");
  x.value = value;
  return x;
}
function textarea(value = "") {
  const x = el("textarea");
  x.value = value;
  return x;
}
function selector(values, value) {
  const s = el("select");
  for (const [key, title] of Object.entries(values)) {
    const o = el("option", title);
    o.value = key;
    s.append(o);
  }
  s.value = value || "";
  return s;
}
function matches(text, repo) {
  return (
    (!$("repo").value || repo === $("repo").value || repo === "team") &&
    String(text || "")
      .toLowerCase()
      .includes($("search").value.trim().toLowerCase())
  );
}
function selectView(next) {
  view = next;
  for (const key of Object.keys(tabs)) {
    $(key + "-view").hidden = key !== view;
    $("tab-" + key).setAttribute("aria-selected", String(key === view));
  }
  $("person").hidden = view !== "tasks";
  $("search").hidden = ["system", "activity"].includes(view);
  $("repo").hidden = ["system", "activity"].includes(view);
  if (view === "system" && !state?.ops) {
    load();
    return;
  }
  render();
}
for (const [key, title] of Object.entries(tabs)) {
  const b = button(title, () => selectView(key));
  b.id = "tab-" + key;
  b.setAttribute("aria-selected", String(key === "tasks"));
  b.setAttribute("role", "tab");
  b.setAttribute("aria-controls", key + "-view");
  $(key + "-view").setAttribute("role", "tabpanel");
  $("tabs").append(b);
}
$("tabs").setAttribute("role", "tablist");
$("tabs").onkeydown = (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const keys = Object.keys(tabs),
    i = keys.indexOf(view),
    next =
      keys[
        (i + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length
      ];
  $("tab-" + next).focus();
  selectView(next);
};
async function load() {
  if (loading) return;
  loading = true;
  try {
    const next = await api(
      "/api/team/state" + (view === "system" ? "?metrics=1" : ""),
    );
    state = next;
    lastFull = Date.now();
    $("login").hidden = true;
    $("app").hidden = false;
    $("logout").hidden = location.hostname === "127.0.0.1";
    $("who").textContent = state.who.name;
    $("who").hidden = false;
    $("localai").hidden = false;
    $("admin").hidden = state.who.role !== "owner";
    $("release").textContent = state.project.version.slice(0, 12);
    $("error").textContent = "";
    if ($("repo").options.length === 1)
      for (const r of [
        ...new Set([...state.repos, ...state.projects.map((p) => p.repo)]),
      ]) {
        const o = el("option", short(r));
        o.value = r;
        $("repo").append(o);
      }
    renderStatus();
    renderTeam();
    render();
  } catch (e) {
    error(e);
  } finally {
    loading = false;
  }
}
function renderTeam() {
  const night = state.configuration?.memory;
  if (night)
    $("nightdesc").textContent =
      night.timezone +
      " " +
      String(night.start_hour).padStart(2, "0") +
      ":00–" +
      String(night.end_hour).padStart(2, "0") +
      ":00 · 安静时整理";
  const members = state.teammates || [];
  $("teamstrip").replaceChildren(el("small", "一起推进"));
  for (const m of members) {
    const count = state.tasks.filter(
      (t) =>
        t.assignee === m.name && ["in_progress", "running"].includes(t.status),
    ).length;
    const b = button(
      m.name + " · 接手 " + count + " 项",
      () => {
        $("person").value = m.name;
        selectView("tasks");
      },
      "member-chip",
    );
    if (m.name === state.who.name) b.classList.add("mine");
    $("teamstrip").append(b);
    if (![...$("person").options].some((o) => o.value === m.name)) {
      const o = el("option", m.name);
      o.value = m.name;
      $("person").append(o);
    }
  }
}
async function takeTask(id, version) {
  const result = await api("/api/team/task/claim", { id, version });
  await load();
  toast(
    result.already ? "这项任务已经是你接手的" : "已接手，群里会同步这条进展",
  );
  return result;
}
function renderStatus() {
  const c = state.connection,
    g = c.gateway,
    gw = g && g.connected && Date.now() - Date.parse(g.at) < 90000,
    run = c.runnerSeen && Date.now() - Date.parse(c.runnerSeen) < 90000;
  $("connection").replaceChildren(
    badge("QQ 网关 · " + (gw ? "在线" : "离线 / 待连接"), gw ? "ok" : "warn"),
    badge("本机执行端 · " + (run ? "在线" : "离线"), run ? "ok" : "warn"),
    badge(
      c.fullMessageVerified ? "全量群消息已实测" : "普通群消息待验证",
      c.fullMessageVerified ? "ok" : "warn",
    ),
    badge(
      "聊天 " +
        (state.configuration?.model.effort_by_kind.participation ||
          state.configuration?.model.quick_effort ||
          "high") +
        " · 重要工作 " +
        (state.configuration?.model.important_effort || "max"),
    ),
  );
  if (g?.blocked) $("connection").append(badge(g.blocked, "bad"));
  if (c.chatTiming)
    $("connection").append(
      badge(
        "最近快聊处理 " +
          Math.round((c.chatTiming.queueMs + c.chatTiming.modelMs) / 1000) +
          " 秒",
      ),
    );
  const counts = [
    [
      "待推进",
      state.tasks.filter((t) => ["proposal", "queued"].includes(t.status))
        .length,
    ],
    ["需要成员", state.tasks.filter((t) => t.status === "needs_human").length],
    [
      "待评审",
      state.tasks.filter((t) => t.status === "ready_for_review").length,
    ],
    [
      "项目",
      new Set([...state.repos, ...state.projects.map((p) => p.repo)]).size,
    ],
  ];
  $("stats").replaceChildren();
  for (const [name, n] of counts) {
    const d = el("div", undefined, "stat");
    d.append(el("small", name), el("b", String(n)));
    $("stats").append(d);
  }
  $("introtext").textContent =
    "最后收到群消息 " +
    date(c.lastMessage) +
    " · 本机离线会暂停 QQ 收信与文件、代码执行。";
}
function render() {
  if (!state) return;
  const fn = {
    tasks: renderTasks,
    materials: renderMaterials,
    projects: renderProjects,
    memory: renderMemory,
    activity: renderActivity,
    system: renderSystem,
  }[view];
  fn();
}
function renderTasks() {
  const person = $("person").value,
    rows = state.tasks.filter(
      (t) =>
        matches(t.title + " " + t.detail + " " + t.result, t.repo) &&
        (!person ||
          (person === "mine" && t.assignee === state.who.name) ||
          (person === "unassigned" && !t.assignee) ||
          person === t.assignee),
    );
  $("board").replaceChildren();
  for (const [title, statuses] of [
    ["待推进", ["proposal", "queued"]],
    ["正在做", ["running", "in_progress"]],
    ["需要接力", ["needs_human", "failed"]],
    ["成果与归档", ["ready_for_review", "done", "cancelled"]],
  ]) {
    const col = el("section", undefined, "column"),
      filtered = rows.filter((t) => statuses.includes(t.status)),
      h = el("h2", title);
    h.append(el("span", String(filtered.length), "pill"));
    col.append(h);
    if (!filtered.length) col.append(empty("这里暂时没有任务"));
    for (const t of filtered) {
      const a = el("article", undefined, "card");
      a.append(
        el("small", short(t.repo)),
        el("h3", t.title),
        badge(
          names[t.status],
          t.status === "ready_for_review"
            ? "ok"
            : t.status === "needs_human"
              ? "warn"
              : "",
        ),
      );
      if (t.plan_state === "pending") a.append(el("small", "方案正在后台整理"));
      if (t.plan_state === "conflict") a.append(badge("AI 草稿待核对", "warn"));
      a.append(el("p", t.detail, "snippet"));
      const info = el("div", undefined, "actions");
      info.append(
        el(
          "small",
          t.assignee
            ? t.assignee +
                (["in_progress", "running"].includes(t.status)
                  ? " · 已接手"
                  : " · 负责人")
            : "待认领",
        ),
        el("small", date(t.updated_at)),
      );
      a.append(info);
      const controls = el("div", undefined, "actions");
      if (
        !["done", "cancelled"].includes(t.status) &&
        !(t.status === "in_progress" && t.assignee)
      )
        controls.append(button("我来接手", () => takeTask(t.id, t.version)));
      controls.append(button("查看 / 接力", () => taskDetail(t.id)));
      a.append(controls);
      col.append(a);
    }
    $("board").append(col);
  }
}
async function source(id, container) {
  if (!id) return;
  try {
    const m = await api("/api/team/source?id=" + encodeURIComponent(id));
    const box = el("div", undefined, "source");
    box.append(
      el("small", "来源 · " + (m.name || m.sender) + " · " + date(m.ts)),
      el("blockquote", m.body),
    );
    container.append(box);
    return m;
  } catch {
    container.append(el("small", "来源 " + id + "（手动修订或来源不可用）"));
  }
}
async function taskDetail(id) {
  const d = await api("/api/team/task?id=" + encodeURIComponent(id)),
    t = d.task;
  const box = el("div");
  box.append(
    el("small", t.repo + " · v" + t.version),
    el("pre", t.detail || "尚未整理方案"),
  );
  const original = await source(t.source_id, box);
  const planState = d.plan?.state;
  if (planState === "conflict") {
    box.append(el("h3", "AI 草稿 · 未覆盖人工内容"), el("pre", d.plan.draft));
    box.append(el("p", "请核对差异，把需要的部分保存到方案中。", "note"));
  }
  const title = input(t.title),
    detail = textarea(t.detail),
    assignee = input(t.assignee || ""),
    result = textarea(t.result || "");
  const statuses = Object.fromEntries(
    Object.entries(names).filter(([k]) => k !== "running"),
  );
  if (t.status === "running") statuses.running = names.running;
  const status = selector(statuses, t.status);
  const row = el("div", undefined, "form-row");
  row.append(field("负责人", assignee), field("任务状态", status));
  const edit = el("details");
  edit.append(
    el("summary", "修改方案与任务信息"),
    field("任务目标", title),
    field("方案 / 验收条件", detail),
  );
  const controls = el("div", undefined, "actions");
  controls.append(
    button(
      "保存更新",
      async () => {
        await api(
          "/api/team/task",
          {
            id: t.id,
            version: t.version,
            title: title.value,
            detail: detail.value,
            status: status.value,
            assignee: assignee.value,
            result: result.value,
          },
          "PATCH",
        );
        $("modal").close();
        await load();
        toast("任务已更新");
      },
      "primary",
    ),
    button(
      t.assignee === state.who.name && t.status === "in_progress"
        ? "我已接手，刷新进展"
        : "我来接手",
      async () => {
        await takeTask(t.id, t.version);
        await taskDetail(t.id);
      },
    ),
    button("重新整理重要方案", async () => {
      await api(
        "/api/team/task",
        { id: t.id, version: t.version, action: "plan", important: true },
        "PATCH",
      );
      $("modal").close();
      await load();
      toast("重要方案已交后台 max");
    }),
    button("复制给本机 AI", () =>
      copy(
        "# " +
          t.title +
          "\n仓库：" +
          t.repo +
          "\n任务：" +
          t.id +
          " · v" +
          t.version +
          "\n项目基线：" +
          (d.repository?.head?.sha || "请先核对远端默认分支") +
          "\n\n原始交办：\n" +
          (original?.body || "由开发台创建，按下列方案核对") +
          "\n\n方案与验收：\n" +
          t.detail +
          "\n\n已有结果与阻塞：\n" +
          (t.result || "暂无执行结果") +
          "\n\n如果已连接 TeamAgent MCP，先用 teamagent_get_task 核对当前版本，再用 teamagent_claim_task 接手，最后用 teamagent_report_task 回填；使用接手后返回的新版本。先核对当前分支和已有内容，在独立分支完成剩余工作并验证。不要自动合并或发布。",
      ),
    ),
  );
  const events = el("div");
  for (const a of d.events || [])
    events.append(
      el("p", date(a.created_at) + " · " + a.actor + " · " + a.summary, "note"),
    );
  show(
    el("h2", t.title),
    box,
    edit,
    row,
    field("进展、验证结果与接力材料", result),
    el(
      "p",
      "成员接手、停止或更新执行中任务，会使旧执行租约失效。旧结果不能覆盖新版本。",
      "note",
    ),
    controls,
    el("h3", "操作记录"),
    events,
  );
}
async function newTask(repo, initial, context) {
  const project = selector(
      Object.fromEntries(state.repos.map((r) => [r, short(r)])),
      repo || $("repo").value || state.repos[0],
    ),
    title = input(initial || ""),
    detail = textarea(context || ""),
    owner = input(""),
    plan = selector(
      {
        none: "先保存为团队任务",
        high: "普通整理 · high",
        max: "重要方案 · max",
      },
      "none",
    );
  const actions = el("div", undefined, "actions");
  actions.append(
    button(
      "创建任务",
      async () => {
        if (!title.value.trim()) throw Error("先写清任务目标");
        await api("/api/team/task", {
          repo: project.value,
          title: title.value,
          detail: detail.value || title.value,
          assignee: owner.value,
          plan: plan.value !== "none",
          important: plan.value === "max",
        });
        $("modal").close();
        selectView("tasks");
        await load();
      },
      "primary",
    ),
  );
  show(
    el("h2", "新任务"),
    field("项目", project),
    field("任务目标", title),
    field("背景、预期行为与验收条件", detail),
    field("负责人", owner),
    field("处理方式", plan),
    el(
      "p",
      "生成方案不会自动开工。明确选择等待自动执行后，执行端才会领取；复杂开发适合成员接力。",
      "note",
    ),
    actions,
  );
}
function renderMaterials() {
  $("utilities").replaceChildren();
  const rows = (state.utilities || []).filter((t) =>
    matches(t.title + " " + t.result),
  );
  if (!rows.length)
    $("utilities").append(
      empty("群里直接交办表格、PDF 或文件整理，进展会出现在这里"),
    );
  for (const t of rows) {
    const a = el("article", undefined, "card");
    a.append(
      el("h3", t.title || "视频 / 资料处理"),
      badge(
        {
          done: "资料处理完成",
          failed: "需要接手",
          running: "处理中",
          pending: "等待处理",
          cancelled: "已停止",
        }[t.status] || t.status,
        t.status === "failed" ? "warn" : "",
      ),
    );
    if (t.delivery_status)
      a.append(
        badge(
          {
            pending: "附件待发送",
            sent: "QQ 附件已发送",
            failed: "附件发送失败",
            unknown: "附件送达待核对",
          }[t.delivery_status],
          t.delivery_status === "sent" ? "ok" : "warn",
        ),
      );
    a.append(
      el("p", t.result || "结果尚未回报", "snippet"),
      button("查看结果 / 接力", () => utilityDetail(t.id)),
    );
    $("utilities").append(a);
  }
  $("discoveries").replaceChildren();
  const found = (state.discoveries || []).filter(
    (d) => matches(d.title + " " + d.body, d.repo) && d.status !== "dismissed",
  );
  if (!found.length)
    $("discoveries").append(empty("尚无新的技术线索；有用的发现才会留下来"));
  for (const d of found) {
    const a = el("article", undefined, "card");
    a.append(
      el("small", short(d.repo) + " · " + date(d.created_at)),
      el("h3", d.title),
      el("p", d.body),
    );
    for (const u of JSON.parse(d.urls)) a.append(link(u, u));
    const actions = el("div", undefined, "actions");
    actions.append(
      button(d.status === "saved" ? "已收藏" : "收藏", async () => {
        await api(
          "/api/team/discovery",
          { id: d.id, status: "saved" },
          "PATCH",
        );
        await load();
      }),
      button("转为团队任务", () =>
        newTask(d.repo, d.title, d.body + "\n" + JSON.parse(d.urls).join("\n")),
      ),
      button("略过", async () => {
        await api(
          "/api/team/discovery",
          { id: d.id, status: "dismissed" },
          "PATCH",
        );
        await load();
      }),
    );
    a.append(actions);
    $("discoveries").append(a);
  }
}
async function utilityDetail(id) {
  const t = await api("/api/team/utility?id=" + encodeURIComponent(id)),
    box = el("div");
  box.append(el("pre", t.instructions || "概括资料并核对与团队项目的关系"));
  const original = await source(t.source_id, box);
  const result = el("pre", t.result || "还没有完成结果");
  if (t.delivery) {
    const d = t.delivery;
    box.append(
      el("h3", "附件交付"),
      el(
        "p",
        {
          pending: "文件已生成，等待发送到 QQ",
          sent: "QQ SDK 已确认发送",
          failed: "发送失败，需成员接手",
          unknown: "发送结果不明，先核对群文件，不会自动重发",
        }[d.status] || d.status,
      ),
    );
    for (const f of JSON.parse(d.files))
      box.append(
        el("small", f.name + " · " + Math.ceil(f.bytes / 1024) + " KB"),
      );
    box.append(
      el(
        "p",
        "已确认 " +
          d.sent_count +
          " 个 / 共 " +
          JSON.parse(d.files).length +
          " 个",
        "note",
      ),
    );
  }
  const actions = el("div", undefined, "actions");
  actions.append(
    button("复制给本机 AI", () =>
      copy(
        "请接手资料任务：" +
          (t.title || "资料整理") +
          "\n原始交办：\n" +
          (original?.body || "请先在QQ群核对原始文件") +
          "\n\n处理要求：\n" +
          (t.instructions || "") +
          "\n\n已有结果：\n" +
          (t.result || "尚未完成") +
          "\n\n请核对输入文件、提取范围与已生成成果，完成后交付真实文件，不要凭空补全缺失资料。",
      ),
    ),
  );
  if (["pending", "running"].includes(t.status))
    actions.append(
      button(
        "停止处理",
        async () => {
          await api(
            "/api/team/utility",
            { id: t.id, action: "cancel" },
            "PATCH",
          );
          $("modal").close();
          await load();
        },
        "danger",
      ),
    );
  show(
    el("h2", t.title || "资料处理"),
    box,
    el("h3", "处理结果"),
    result,
    actions,
  );
}
function renderProjects() {
  $("projects").replaceChildren();
  for (const repo of [
    ...new Set([...state.repos, ...state.projects.map((p) => p.repo)]),
  ].filter((r) => matches(r, r))) {
    const p = (state.projects || []).find((p) => p.repo === repo),
      a = el("article", undefined, "card");
    a.append(
      el("h3", short(repo)),
      link("打开 GitHub 仓库", "https://github.com/" + repo),
      el("small", "最近同步尝试 " + date(p?.updated_at)),
    );
    if (p?.stale_sections && Object.keys(JSON.parse(p.stale_sections)).length)
      a.append(badge("部分资料使用旧缓存", "warn"));
    let head;
    try {
      head = typeof p?.head === "string" ? JSON.parse(p.head) : p?.head;
    } catch {}
    if (head?.sha) {
      const latest = el("div", undefined, "latest-commit");
      latest.append(
        el("small", "最新提交 · " + date(head.at)),
        link(
          head.message || head.sha.slice(0, 7),
          head.url || "https://github.com/" + repo + "/commit/" + head.sha,
        ),
      );
      const author = head.author || {};
      const by = el("div", undefined, "actions");
      by.append(
        el("span", "作者 " + (author.name || author.login || "未知作者")),
      );
      if (author.url)
        by.append(
          link(author.login ? "@" + author.login : "GitHub主页", author.url),
        );
      by.append(
        link(
          head.sha.slice(0, 7),
          head.url || "https://github.com/" + repo + "/commit/" + head.sha,
        ),
      );
      latest.append(by);
      a.append(latest);
    } else a.append(el("small", "最新提交正在同步"));
    const ts = state.tasks.filter(
      (t) => t.repo === repo && !["done", "cancelled"].includes(t.status),
    );
    a.append(
      el(
        "p",
        ts.length +
          " 项未完成 · " +
          ts.filter((t) => t.status === "needs_human").length +
          " 项待接力",
      ),
    );
    let checks = [];
    try {
      checks = JSON.parse(p?.checks || "[]");
    } catch {}
    for (const c of checks.slice(0, 5)) {
      const row = el("div", undefined, "actions");
      row.append(
        badge(
          c.name + " · " + (c.conclusion || c.status),
          c.conclusion === "success" ? "ok" : c.conclusion ? "warn" : "",
        ),
      );
      if (c.html_url) row.append(link("检查详情", c.html_url));
      a.append(row);
    }
    a.append(
      button("查看项目资料", () => projectDetail(repo)),
      button("为此项目建任务", () => newTask(repo)),
    );
    $("projects").append(a);
  }
}
async function projectDetail(repo) {
  const p = await api("/api/team/project?repo=" + encodeURIComponent(repo));
  const box = el("div");
  box.append(el("small", "同步时间 " + date(p.updated_at)));
  for (const [title, value] of [
    ["README", p.context?.readme],
    ["协作说明", p.context?.files?.["AGENTS.md"]],
  ])
    if (value) box.append(el("h3", title), el("pre", value));
  for (const [title, rows] of [
    ["未关闭 Issue", p.context?.issues],
    ["待合并 PR", p.context?.pulls],
  ]) {
    box.append(el("h3", title));
    if (Array.isArray(rows))
      for (const r of rows)
        box.append(
          el("p", "#" + r.number + " " + r.title),
          link("在 GitHub 查看", r.html_url || r.url),
        );
  }
  show(el("h2", short(repo)), box);
}
function renderMemory() {
  $("identity").textContent = state.identity.note;
  $("facts").replaceChildren();
  const facts = state.facts.filter((f) =>
    matches(
      f.subject + " " + f.predicate + " " + f.value + " " + f.evidence,
      f.repo,
    ),
  );
  if (!facts.length)
    $("facts").append(
      empty("明确纠正会即时记录，长期事实在夜间整理；没有依据就不编造"),
    );
  for (const f of facts) {
    const a = el("article", undefined, "card");
    a.append(
      el("small", short(f.repo) + " · " + date(f.valid_from)),
      badge(
        f.status === "confirmed" ? "已确认" : "提议",
        f.status === "confirmed" ? "ok" : "",
      ),
      el("h3", f.subject + " · " + f.predicate),
      el("p", f.value),
      el("blockquote", f.evidence),
    );
    const controls = el("div", undefined, "actions");
    controls.append(
      button("原话 / 版本", async () => {
        const list = await api(
            "/api/team/fact/history?id=" + encodeURIComponent(f.id),
          ),
          box = el("div");
        await source(f.source_id, box);
        for (const x of list.facts)
          box.append(
            badge(x.valid_to ? "历史版本" : "当前版本"),
            el("p", x.value),
            el("small", date(x.valid_from) + " · " + x.evidence),
          );
        show(el("h2", "记忆依据与版本"), box);
      }),
      button("修正", () => {
        const value = textarea(f.value),
          actions = el("div", undefined, "actions");
        actions.append(
          button(
            "保存修正",
            async () => {
              await api(
                "/api/team/fact",
                { id: f.id, value: value.value },
                "PATCH",
              );
              $("modal").close();
              await load();
            },
            "primary",
          ),
        );
        show(
          el("h2", "修正记忆"),
          el("blockquote", f.evidence),
          field("准确的内容", value),
          actions,
        );
      }),
      button(
        "删除",
        async () => {
          if (confirm("删除此记忆？同一原话不会再次自动学习。")) {
            await api("/api/team/fact", { id: f.id }, "DELETE");
            await load();
          }
        },
        "danger",
      ),
    );
    a.append(controls);
    $("facts").append(a);
  }
  $("expressions").replaceChildren();
  if (!state.expressions.length)
    $("expressions").append(empty("还没有学会本群表达，夜间会核对真实用法"));
  for (const v of state.expressions.filter((x) =>
    matches(x.phrase + " " + x.meaning),
  )) {
    const a = el("article", undefined, "card");
    a.append(
      el("h3", v.phrase),
      el("p", v.meaning),
      el(
        "small",
        v.scene + " · " + v.frequency + " 条 / " + v.speakers + " 人",
      ),
      badge(v.enabled === 1 ? "可使用" : v.enabled === 0 ? "已停用" : "待核对"),
    );
    a.append(
      button(v.enabled === 1 ? "停用" : "启用", async () => {
        await api(
          "/api/team/expression",
          { phrase: v.phrase, enabled: v.enabled !== 1 },
          "PATCH",
        );
        await load();
      }),
    );
    $("expressions").append(a);
  }
  $("dreams").replaceChildren();
  if (!state.dreams.length)
    $("dreams").append(empty("尚未完成首次真实夜间复盘"));
  for (const d of state.dreams) {
    const a = el("article", undefined, "card");
    a.append(
      el("small", d.date + " · " + d.message_count + " 条来源"),
      el("p", d.body),
      button("查看来源", async () => {
        const box = el("div");
        for (const id of JSON.parse(d.sources)) await source(id, box);
        show(el("h2", "夜间复盘来源"), box);
      }),
    );
    $("dreams").append(a);
  }
  renderReview();
}
/* V-D D-12 · 复盘面板：数据与渲染 */
const reviewPad = (n) => String(n).padStart(2, "0");
function reviewIsAdmin() {
  return state?.who?.role === "owner";
}
function reviewHost() {
  try {
    return new URL(REVIEW_BASE).host;
  } catch {
    return REVIEW_BASE;
  }
}
function reviewDayKey(d) {
  return String(d.group_id || "") + String(d.date || "");
}
function reviewSortedDays() {
  return [...(review.data?.days || [])].sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")),
  );
}
function reviewLatestDay() {
  return reviewSortedDays()[0] || null;
}
function reviewMode() {
  return review.health?.mode || reviewLatestDay()?.run?.mode || "";
}
function reviewDayLabel(value) {
  const text = new Date(value + "T00:00:00").toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  return text.replace("周", " 周");
}
function reviewDayShort(value) {
  return new Date(value + "T00:00:00").toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
}
function reviewDateShort(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
}
function reviewClock(value) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function reviewNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}
function reviewAgreement(f) {
  if (!f || f.status === "disputed") return null;
  if (f.agreement === "agree") return ["一致", "ok"];
  if (f.agreement === "single") return ["仅单判", ""];
  if (f.agreement === "pending" || f.agreement === "disagree")
    return ["待复核", "warn"];
  return null;
}
function reviewAllFindings() {
  const map = new Map();
  for (const day of review.data?.days || [])
    for (const finding of day.findings || [])
      if (!map.has(finding.id)) map.set(finding.id, finding);
  return [...map.values()];
}
function reviewAllStatusCounts() {
  const counts = { all: 0, open: 0, accepted: 0, rejected: 0 };
  for (const f of reviewAllFindings()) {
    counts.all++;
    if (Object.prototype.hasOwnProperty.call(counts, f.status)) counts[f.status]++;
  }
  return counts;
}
function reviewSevenDayPrecision() {
  let accepted = 0,
    rejected = 0;
  for (const f of reviewAllFindings()) {
    if (f.status === "accepted") accepted++;
    else if (f.status === "rejected") rejected++;
  }
  const total = accepted + rejected;
  return total ? { ratio: accepted / total, accepted, rejected } : null;
}
function reviewPrecision(day) {
  let accepted = 0,
    rejected = 0,
    open = 0;
  for (const f of day?.findings || []) {
    if (f.status === "accepted") accepted++;
    else if (f.status === "rejected") rejected++;
    else if (f.status === "open" || f.status === "disputed") open++;
  }
  const total = accepted + rejected;
  return {
    accepted,
    rejected,
    open,
    rejects: Number(day?.precision?.rejects || 0),
    ratio: total ? accepted / total : null,
  };
}
function reviewBudget(day) {
  const rows = day?.budget?.providers || [];
  const groups = new Map();
  let calls = 0;
  for (const row of rows) {
    const unit = row.unit || "neurons",
      group = groups.get(unit) || { used: 0, cap: 0 };
    group.used += Number(row.used || 0);
    group.cap += Number(row.cap || 0);
    groups.set(unit, group);
    calls += Number(row.calls || 0);
  }
  if (!groups.size) return { text: "—", ratio: 0, cls: "" };
  let ratio = 0;
  const parts = [];
  for (const [unit, group] of groups) {
    const share = group.cap > 0 ? group.used / group.cap : 0;
    ratio = Math.max(ratio, share);
    if (unit === "usd_micros")
      parts.push("$" + (group.used / 1e6).toFixed(2) + " / $" + (group.cap / 1e6).toFixed(2));
    else if (unit === "neurons")
      parts.push(reviewNumber(group.used) + " / " + reviewNumber(group.cap) + " neurons");
    else parts.push(reviewNumber(group.used) + " / " + reviewNumber(group.cap) + " " + unit);
  }
  return {
    text: parts.join(" · ") + " · " + reviewNumber(calls) + " 次调用",
    ratio,
    cls: ratio > 1 ? "is-bad" : ratio >= 0.85 ? "is-warn" : "",
  };
}
function reviewMeter(ratio, cls, label, valueText) {
  const box = el("div", undefined, "review-meter" + (cls ? " " + cls : ""));
  box.setAttribute("role", "meter");
  box.setAttribute("aria-valuemin", "0");
  box.setAttribute("aria-valuemax", "100");
  box.setAttribute("aria-valuenow", String(Math.round(Math.min(1, Math.max(0, ratio || 0)) * 100)));
  box.setAttribute("aria-label", label);
  box.setAttribute("aria-valuetext", valueText);
  box.title = valueText;
  const fill = el("span");
  fill.style.width = (Math.min(100, Math.max(0, (ratio || 0) * 100))).toFixed(1) + "%";
  box.append(fill);
  return box;
}
function reviewMetric(label, right, ratio, cls, extra) {
  const box = el("div", undefined, "review-metric"),
    head = el("div", undefined, "review-metric-label");
  head.append(el("span", label), el("span", right));
  box.append(head, reviewMeter(ratio, cls, label, right));
  if (extra) box.append(extra);
  return box;
}
function reviewState(text, isError, retry) {
  const box = el("div", undefined, "review-state" + (isError ? " is-error" : ""));
  if (isError) box.setAttribute("role", "alert");
  box.append(el("p", text));
  if (retry) box.append(button("重试", () => loadReview(true), "review-mini"));
  return box;
}
function reviewErrorText(e) {
  if (!e) return "";
  if (e.kind === "timeout") return "复盘服务 10 秒内没有响应。";
  if (e.kind === "network")
    return "连不上复盘服务（" + reviewHost() + "）。可能还没上线，或这个看板的网址不在它的允许列表里。";
  if (e.status === 401) return "复盘服务不认这次登录。请点右上角「退出」后重新登录。";
  if (e.status === 403) return "你的账号没有查看复盘的权限。";
  return "复盘服务出错（HTTP " + (e.status || "?") + "）：" + (e.message || "未知错误");
}
function reviewErrorLine(e) {
  const line = el("p", undefined, "review-error");
  line.setAttribute("role", "alert");
  line.append(
    document.createTextNode(
      reviewErrorText(e) + "（显示的是 " + reviewClock(review.loadedAt) + " 的数据）",
    ),
  );
  line.append(button("重试", () => loadReview(true), "review-mini"));
  return line;
}
function reviewStepBadge(step) {
  const text = REVIEW_STEP[step] || step || "未知";
  return badge(text, step === "failed" ? "bad" : step === "done" ? "ok" : "warn");
}
function reviewSourceLabel(ev) {
  return REVIEW_SOURCE[ev.source] || ev.source || "来源";
}
function reviewEvidence(ev) {
  const box = el("div", undefined, "review-quote"),
    head = el("div", undefined, "review-quote-head");
  head.append(el("span", reviewSourceLabel(ev), "pill"));
  if (ev.origin && REVIEW_ORIGIN[ev.origin])
    head.append(el("span", REVIEW_ORIGIN[ev.origin], "pill"));
  if (["snapshot", "tool", "outbox"].includes(ev.source) && ev.id)
    head.append(el("code", ev.id, "review-code"));
  const quote = el("q", ev.quote || ""),
    actions = el("div", undefined, "actions");
  actions.append(button("复制", () => copyQuote(ev.quote || ""), "review-mini"));
  if (ev.source === "message")
    actions.append(
      button(
        ev.rowid ? "原话 #" + ev.rowid : "查看原话",
        () => locateEvidence(ev),
        "review-mini",
      ),
    );
  box.append(head, quote, actions);
  return box;
}
async function locateEvidence(ev) {
  const box = el("div");
  await source(ev.id, box);
  show(
    el("h2", "原话定位"),
    el(
      "p",
      ev.rowid ? "消息序号 #" + ev.rowid + " · id " + ev.id : "id " + ev.id,
      "note",
    ),
    box,
  );
}
async function copyQuote(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制原话");
  } catch {
    toast("复制失败，请手动选中文字");
  }
}
function reviewCopyText(f) {
  const lines = [
    "[复盘发现] " +
      String(f.severity || "").toUpperCase() +
      " " +
      (f.failure_type || ""),
    "能力：" +
      (f.capability || "—") +
      "（" +
      (REVIEW_GAP_TYPE[f.gap_type] || f.gap_type || "—") +
      "，修在 " +
      (REVIEW_FIX_LAYER[f.fix_layer] || f.fix_layer || "—") +
      "）",
    "发生了什么：" + (f.what_happened || "—"),
    "期望答法：" + (f.expected || "—"),
    "根因：" + (f.root_cause || "—"),
    "下次怎么做：" + (f.next_attempt_plan || "—"),
    "证据：",
  ];
  for (const ev of f.evidence || [])
    lines.push(
      "- " +
        reviewSourceLabel(ev) +
        " " +
        (ev.id || "") +
        "：「" +
        (ev.quote || "") +
        "」",
    );
  return lines.join("\n");
}
async function reviewMarkFinding(f, status, note) {
  try {
    await reviewApi(
      "/review/finding/" + encodeURIComponent(f.id),
      { status },
      "PATCH",
    );
    for (const day of review.data?.days || [])
      for (const item of day.findings || [])
        if (item.id === f.id) {
          item.status = status;
          item.reviewed_by = state?.who?.name || "";
          item.reviewed_at = Date.now();
        }
    toast(note);
    renderReview();
  } catch (e) {
    if (e.status === 401 || e.status === 403) toast("只有管理员可以标注");
    else toast("标注没保存：" + (e.message || "未知错误"));
  }
}
function reviewFindingCard(f) {
  const expanded = review.openFindings.has(f.id),
    card = el(
      "article",
      undefined,
      "card review-finding" + (expanded ? " is-open" : ""),
    ),
    head = el("div", undefined, "card-head"),
    tags = el("div", undefined, "review-finding-tags");
  card.dataset.id = f.id;
  const severity = REVIEW_SEVERITY[f.severity],
    status = REVIEW_FINDING_STATUS[f.status] || [f.status || "未知", ""],
    agreement = reviewAgreement(f);
  tags.append(
    badge(severity ? severity[0] : f.severity || "—", severity ? severity[1] : ""),
    el("code", f.failure_type || "—", "review-code"),
  );
  if (agreement) tags.append(badge(agreement[0], agreement[1]));
  head.append(tags, badge(status[0], status[1]));
  card.append(head, el("h3", f.what_happened || "—", "review-finding-title"));

  const dims = el("div", undefined, "review-dims");
  dims.setAttribute("role", "list");
  dims.setAttribute("aria-label", "六个维度");
  for (const [key, name] of REVIEW_DIMS) {
    const verdict = REVIEW_VERDICT[f.dimensions?.[key]] || [
        "?",
        "资料不足",
        "is-na",
      ],
      cell = el("div", undefined, "review-dim " + verdict[2]);
    cell.setAttribute("role", "listitem");
    cell.setAttribute("aria-label", name + "：" + verdict[1]);
    cell.append(el("span", name), el("b", verdict[0]));
    dims.append(cell);
  }
  card.append(dims);

  const meta = [];
  if (f.capability) meta.push(f.capability);
  if (f.gap_type) meta.push(REVIEW_GAP_TYPE[f.gap_type] || f.gap_type);
  if (f.fix_layer) meta.push(REVIEW_FIX_LAYER[f.fix_layer] || f.fix_layer);
  if (f.confidence !== null && f.confidence !== undefined && Number.isFinite(Number(f.confidence)))
    meta.push("置信 " + Number(f.confidence).toFixed(2));
  if (f.created_at) meta.push(reviewDateShort(f.created_at));
  if (meta.length) card.append(el("small", meta.join(" · "), "review-meta"));

  if (f.evidence?.[0]) {
    const evidence = el("div", undefined, "review-evidence");
    evidence.append(reviewEvidence(f.evidence[0]));
    card.append(evidence);
  }

  const detail = el("div", undefined, "review-detail");
  detail.id = "review-detail-" + encodeURIComponent(f.id);
  detail.hidden = !expanded;
  const dl = el("dl", undefined, "review-qa");
  const inbound = f.inbound;
  dl.append(el("dt", "触发消息"));
  const inboundDd = el("dd");
  if (inbound) {
    inboundDd.append(
      document.createTextNode(
        (inbound.sender_name || inbound.sender || "群成员") +
          "：" +
          (inbound.body_excerpt || ""),
      ),
    );
    if (inbound.rowid || inbound.id)
      inboundDd.append(
        button(
          inbound.rowid ? "原话 #" + inbound.rowid : "查看原话",
          () =>
            locateEvidence({
              id: inbound.id,
              rowid: inbound.rowid,
              source: "message",
            }),
          "review-mini",
        ),
      );
  } else inboundDd.textContent = "—";
  dl.append(inboundDd);
  for (const [label, value] of [
    ["期望答法", f.expected],
    ["根因", f.root_cause],
    ["下次怎么做", f.next_attempt_plan],
  ]) {
    dl.append(el("dt", label));
    const dd = el("dd", value || "—");
    if (!value) dd.className = "muted";
    dl.append(dd);
  }
  if (f.should_use_tool && !["none", "n/a"].includes(f.should_use_tool)) {
    dl.append(el("dt", "该用的工具"), el("dd", f.should_use_tool));
  }
  if (f.reviewed_by) {
    dl.append(el("dt", "标注人"));
    dl.append(
      el(
        "dd",
        f.reviewed_by + (f.reviewed_at ? " · " + reviewDateShort(f.reviewed_at) : ""),
      ),
    );
  }
  detail.append(dl);
  if ((f.evidence || []).length > 1) {
    const rest = el("div", undefined, "review-evidence");
    for (const ev of f.evidence.slice(1)) rest.append(reviewEvidence(ev));
    detail.append(rest);
  }
  card.append(detail);

  const actions = el("div", undefined, "actions review-finding-actions"),
    more = button(
      expanded ? "收起" : "展开详情",
      () => {
        if (review.openFindings.has(f.id)) review.openFindings.delete(f.id);
        else review.openFindings.add(f.id);
        renderReview();
      },
      "review-mini review-more",
    );
  more.setAttribute("aria-expanded", String(expanded));
  more.setAttribute("aria-controls", detail.id);
  actions.append(
    more,
    button(
      "复制给 AI",
      async () => {
        try {
          await navigator.clipboard.writeText(reviewCopyText(f));
          toast("已复制，可交给本机 AI");
        } catch {
          toast("复制失败，请手动选中文字");
        }
      },
      "review-mini",
    ),
  );
  if (reviewIsAdmin()) {
    const admin = [];
    if (["open", "accepted", "rejected"].includes(f.status)) {
      admin.push(
        ["准确", "accepted", "已标为准确"],
        ["误判", "rejected", "已标为误判"],
      );
    } else if (f.status === "disputed")
      admin.push(
        ["采纳", "accepted", "已采纳"],
        ["驳回", "rejected", "已驳回"],
      );
    admin.forEach(([label, status, note], index) => {
      const next =
          f.status === status && ["accepted", "rejected"].includes(status)
            ? "open"
            : status,
        nextNote = next === "open" ? "已撤回标注" : note,
        b = button(
          label,
          () => reviewMarkFinding(f, next, nextNote),
          "review-mini" + (index === 0 ? " review-push" : ""),
        );
      b.setAttribute("aria-pressed", String(f.status === status));
      actions.append(b);
    });
  }
  card.append(actions);
  return card;
}
function reviewFindingsTab() {
  const all = reviewAllFindings(),
    counts = reviewAllStatusCounts(),
    chips = [
      ["all", "全部"],
      ["open", "待标注"],
      ["accepted", "准确"],
      ["rejected", "误判"],
    ],
    filters = el("div", undefined, "review-filters");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "按标注筛选");
  for (const [key, label] of chips) {
    const chip = button(
      label + " " + counts[key],
      () => {
        review.filter = key;
        renderReview();
      },
      "review-chip",
    );
    chip.setAttribute("aria-pressed", String(review.filter === key));
    filters.append(chip);
  }
  const box = el("div");
  box.append(filters);
  if (!all.length) {
    box.append(reviewState("这 7 天没有发现问题。"));
    return box;
  }
  const visible = all.filter((f) => {
    if (review.filter !== "all" && f.status !== review.filter) return false;
    return matches(
      [
        f.what_happened,
        f.failure_type,
        f.capability,
        f.expected,
        f.root_cause,
        f.next_attempt_plan,
        ...(f.evidence || []).map((e) => e.quote),
      ].join(" "),
      "team",
    );
  });
  if (!visible.length) {
    const emptyBox = reviewState("没有符合条件的发现。");
    emptyBox.append(
      button(
        "看全部",
        () => {
          review.filter = "all";
          renderReview();
        },
        "review-mini",
      ),
    );
    box.append(emptyBox);
    return box;
  }
  const list = el("div", undefined, "review-list");
  visible.sort((a, b) => {
    const rank = { p0: 0, p1: 1, p2: 2 };
    const diff = (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
    return diff || Number(b.created_at || 0) - Number(a.created_at || 0);
  });
  for (const f of visible) list.append(reviewFindingCard(f));
  box.append(list);
  return box;
}
function reviewGapsTab() {
  const gaps = [...(review.data?.gaps || [])], box = el("div");
  if (!gaps.length) return reviewState("暂时没有能力缺口。");
  const rank = { regression: 0, open: 1, proposed: 2 };
  gaps.sort((a, b) => {
    const diff = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    return diff || Number(b.occurrences || 0) - Number(a.occurrences || 0);
  });
  const visible = gaps.filter((g) =>
    matches(
      [g.capability, g.gap_type, g.proposed_action, g.owner, g.task_title].join(" "),
      "team",
    ),
  );
  if (!visible.length) return reviewState("没有符合条件的缺口。");
  const wrap = el("div", undefined, "table-wrap"),
    table = el("table", undefined, "table review-gaps"),
    thead = el("thead"),
    headRow = el("tr"),
    tbody = el("tbody");
  for (const [label, cls] of [
    ["能力", ""],
    ["类型", ""],
    ["次数", "num"],
    ["最近出现", ""],
    ["状态", ""],
    ["关联", ""],
    ["建议", ""],
  ]) {
    const th = el("th", label);
    if (cls) th.className = cls;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  for (const g of visible) {
    const tr = el("tr");
    const cell = (label, cls) => {
      const td = el("td");
      td.dataset.label = label;
      if (cls) td.className = cls;
      return td;
    };
    const capability = cell("能力");
    capability.append(el("code", g.capability || "—", "review-code"));
    tr.append(capability);
    const type = cell("类型");
    type.append(
      el("span", REVIEW_GAP_TYPE[g.gap_type] || g.gap_type || "—"),
      el("small", g.gap_type || "", "muted"),
    );
    tr.append(type);
    const count = cell("次数", "num");
    count.textContent = reviewNumber(g.occurrences);
    tr.append(count);
    const lastSeen = cell("最近出现");
    lastSeen.textContent = g.last_seen ? reviewDateShort(g.last_seen) : "—";
    tr.append(lastSeen);
    const status = cell("状态");
    const info = REVIEW_GAP_STATUS[g.status] || [g.status || "未知", ""];
    status.append(badge(info[0], info[1]));
    tr.append(status);
    const related = cell("关联");
    if (g.task_id) {
      const line = el("div"),
        a = el("a", g.task_title || "查看任务");
      a.href = "#";
      a.onclick = (event) => {
        event.preventDefault();
        taskDetail(g.task_id);
      };
      line.append(a);
      related.append(line);
    }
    if (g.external_ref) {
      const line = el("div"),
        pill = el("span", g.external_ref, "pill");
      pill.title = "已有工单 " + g.external_ref;
      line.append(pill);
      related.append(line);
    }
    if (!g.task_id && !g.external_ref) related.append(el("span", "—", "muted"));
    tr.append(related);
    const advice = cell("建议");
    advice.append(
      el("span", g.proposed_action || "—"),
      el("small", "负责：" + (g.owner || "—"), "muted"),
    );
    tr.append(advice);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);
  return box;
}
function reviewRuleParams(rule) {
  if (!rule || rule.kind === "free" || !rule.params) return "";
  let params;
  try {
    params = typeof rule.params === "string" ? JSON.parse(rule.params) : rule.params;
  } catch {
    return "";
  }
  const formatter = REVIEW_RULE_PARAM[rule.kind];
  if (!formatter) return "";
  try {
    return formatter(params) || "";
  } catch {
    return "";
  }
}
function reviewRuleSource(source) {
  const value = String(source || "");
  if (value.startsWith("member:")) return "来自成员原话";
  if (value.startsWith("review:")) return "来自复盘发现";
  return value ? "来源：" + value : "来源：—";
}
function reviewRuleCard(rule) {
  const card = el(
      "article",
      undefined,
      "card review-rule" + (rule.status === "retired" ? " is-retired" : ""),
    ),
    head = el("div", undefined, "card-head"),
    info = REVIEW_RULE_STATUS[rule.status] || [rule.status || "未知", ""];
  head.append(badge(info[0], info[1]), el("small", "更新于 " + reviewDateShort(rule.updated_at)));
  card.append(head, el("h3", rule.rule || "—"));
  card.append(el("small", "适用：" + (rule.scene || "—"), "muted"));
  const stats = el("div", undefined, "review-rule-stats");
  const expiry =
    rule.status === "canary"
      ? "试行至 " + reviewDateShort(rule.canary_until)
      : "到期 " + reviewDateShort(rule.expires_at);
  stats.append(el("span", expiry), document.createTextNode(" · "));
  stats.append(el("span", "命中 " + reviewNumber(rule.hits)), document.createTextNode(" · "));
  const corrections = el(
    "span",
    "纠正 " + reviewNumber(rule.corrections),
    Number(rule.corrections || 0) > 0 ? "review-text-bad" : "",
  );
  stats.append(corrections);
  card.append(stats);
  const params = reviewRuleParams(rule);
  if (params) card.append(el("small", "参数：" + params, "muted"));
  card.append(el("small", reviewRuleSource(rule.source), "muted"));
  if (rule.status === "retired" && rule.rollback_reason)
    card.append(el("p", "撤销原因：" + rule.rollback_reason, "review-retire-reason"));
  if (reviewIsAdmin() && rule.status !== "retired") {
    const actions = el("div", undefined, "actions");
    if (rule.status === "candidate" && rule.kind === "free")
      actions.append(
        button(
          "批准试用",
          async () => {
            try {
              await reviewApi(
                "/review/rule/" + encodeURIComponent(rule.id),
                { status: "canary" },
                "PATCH",
              );
              rule.status = "canary";
              rule.updated_at = Date.now();
              toast("已批准试用");
              renderReview();
            } catch (e) {
              if (e.status === 401 || e.status === 403) toast("只有管理员可以批准试用");
              else toast("没批准：" + (e.message || "未知错误"));
            }
          },
          "review-mini",
        ),
      );
    actions.append(
      button("撤销", () => openRetireRule(rule), "review-mini danger"),
    );
    card.append(actions);
  }
  return card;
}
function openRetireRule(rule) {
  const reason = el("textarea");
  reason.className = "review-reason";
  reason.maxLength = 200;
  const label = el("label", "撤销原因（必填，会记进规则历史）");
  label.append(reason);
  const error = el("p");
  error.className = "review-error";
  error.setAttribute("role", "alert");
  const confirm = el("button", "确认撤销");
  confirm.className = "review-danger-solid";
  const cancel = el("button", "取消");
  cancel.onclick = () => $("modal").close();
  const actions = el("div", undefined, "actions");
  actions.append(confirm, cancel);
  confirm.onclick = async () => {
    const text = reason.value.trim();
    if (!text) {
      error.textContent = "请写一句撤销原因";
      reason.focus();
      return;
    }
    if (confirm.disabled) return;
    confirm.disabled = true;
    try {
      await reviewApi(
        "/review/rule/" + encodeURIComponent(rule.id),
        { status: "retired", reason: text },
        "PATCH",
      );
      $("modal").close();
      toast("已撤销，bot 不会再用这条约定");
      rule.status = "retired";
      rule.rollback_reason = text;
      rule.updated_at = Date.now();
      renderReview();
    } catch (e) {
      if (e.status === 401 || e.status === 403)
        error.textContent = "只有管理员可以撤销规则";
      else if (e.status === 404) {
        $("modal").close();
        toast("这条规则已不存在，列表已刷新");
        loadReview(true);
      } else error.textContent = "没撤销成功：" + (e.message || "未知错误");
    } finally {
      confirm.disabled = false;
    }
  };
  show(
    el("h2", "撤销这条约定"),
    el("blockquote", rule.rule || ""),
    el(
      "p",
      "撤销后，bot 从下一次回复起不再使用这条约定；记录会保留，可在『显示已撤销』里查看。",
      "note",
    ),
    label,
    error,
    actions,
  );
  setTimeout(() => reason.focus(), 0);
}
function reviewRulesTab() {
  const rules = [...(review.data?.rules || [])],
    retired = rules.filter((rule) => rule.status === "retired").length,
    box = el("div");
  if (!rules.length) return reviewState("还没有从群里学到的约定。");
  if (retired) {
    const filters = el("div", undefined, "review-filters"),
      chip = button(
        "显示已撤销 " + retired,
        () => {
          review.showRetired = !review.showRetired;
          renderReview();
        },
        "review-chip",
      );
    chip.setAttribute("aria-pressed", String(review.showRetired));
    filters.append(chip);
    box.append(filters);
  }
  const visible = rules.filter(
    (rule) =>
      (review.showRetired || rule.status !== "retired") &&
      matches(
        [rule.rule, rule.scene, rule.source, rule.kind].join(" "),
        "team",
      ),
  );
  if (!visible.length) {
    box.append(reviewState("还没有从群里学到的约定。"));
    return box;
  }
  const rank = { canary: 0, active: 1, candidate: 2, frozen: 3, retired: 4 };
  visible.sort((a, b) => {
    const diff = (rank[a.status] ?? 5) - (rank[b.status] ?? 5);
    return diff || Number(b.updated_at || 0) - Number(a.updated_at || 0);
  });
  const grid = el("div", undefined, "grid two");
  for (const rule of visible) grid.append(reviewRuleCard(rule));
  box.append(grid);
  return box;
}
async function loadReviewMemory(force) {
  if (!review.data || review.memoryLoading) return;
  if (!force && review.memory !== null) return;
  review.memoryLoading = true;
  review.memoryError = null;
  renderReview();
  const days = (review.data.days || []).filter((day) => day.answers?.memory);
  const found = [];
  let failed = null;
  await Promise.all(
    days.map(async (day) => {
      try {
        const digest = await reviewApi(
          "/review/digest?date=" + encodeURIComponent(day.date),
        );
        for (const candidate of digest.questions?.memory?.candidates || [])
          found.push({ ...candidate, date: day.date });
      } catch (e) {
        failed = e;
      }
    }),
  );
  const unique = new Map();
  for (const candidate of found)
    if (candidate?.id && !unique.has(candidate.id))
      unique.set(candidate.id, candidate);
  review.memory = [...unique.values()];
  review.memoryError = failed;
  review.memoryLoadedAt = Date.now();
  review.memoryLoading = false;
  renderReview();
}
async function reviewMemoryAction(candidate, status) {
  try {
    const result = await reviewApi(
      "/review/memory/" + encodeURIComponent(candidate.id),
      { status },
      "PATCH",
    );
    candidate.status =
      status === "approved" ? (result.fact_id ? "applied" : "approved") : "rejected";
    toast(status === "approved" ? "已写入记忆" : "已驳回");
    renderReview();
  } catch (e) {
    if (e.status === 401 || e.status === 403) toast("只有管理员可以处理记忆候选");
    else if (e.status === 409) {
      toast("这条候选已被处理或目标记忆已变化，刷新后再看");
      loadReviewMemory(true);
    } else toast("没保存：" + (e.message || "未知错误"));
  }
}
function reviewMemoryCard(candidate) {
  const card = el("article", undefined, "card review-memory");
  const head = el("div", undefined, "card-head"),
    tags = el("div", undefined, "review-finding-tags");
  const op = REVIEW_MEMORY_OP[candidate.op] || [candidate.op || "未知", ""],
    status = REVIEW_MEMORY_STATUS[candidate.status] || [candidate.status || "未知", ""];
  tags.append(badge(op[0], op[1]), badge(status[0], status[1]));
  head.append(tags, el("small", candidate.date ? reviewDayShort(candidate.date) : ""));
  card.append(head);
  card.append(el("h3", (candidate.subject || "—") + " · " + (candidate.predicate || "—")));
  card.append(el("p", candidate.value || "—"));
  if (candidate.evidence?.[0]?.quote)
    card.append(el("blockquote", candidate.evidence[0].quote));
  else if (candidate.source_msg_id)
    card.append(el("small", "来源消息 " + candidate.source_msg_id, "muted"));
  if (candidate.status === "conflict")
    card.append(
      el("p", "目标记忆已经变化，需要重新核对后再决定。", "review-error"),
    );
  if (candidate.status === "blocked")
    card.append(el("p", "这条候选命中了已删除的记忆，不能重新学习。", "review-error"));
  if (reviewIsAdmin() && candidate.status === "candidate") {
    const actions = el("div", undefined, "actions");
    actions.append(
      button("批准写入", () => reviewMemoryAction(candidate, "approved"), "review-mini"),
      button("驳回", () => reviewMemoryAction(candidate, "rejected"), "review-mini"),
    );
    card.append(actions);
  }
  return card;
}
function reviewMemoryTab() {
  if (review.memoryLoading) return reviewState("正在读取记忆候选…");
  if (review.memoryError && !(review.memory || []).length) {
    const box = reviewState(reviewErrorText(review.memoryError), true, false);
    box.append(button("重试", () => loadReviewMemory(true), "review-mini"));
    return box;
  }
  if (review.memory === null) return reviewState("正在读取记忆候选…");
  const candidates = [...review.memory].sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")),
  );
  const visible = candidates.filter((candidate) =>
    matches(
      [candidate.subject, candidate.predicate, candidate.value, candidate.op].join(" "),
      "team",
    ),
  );
  if (!candidates.length) return reviewState("还没有待批准的记忆候选。");
  if (!visible.length) return reviewState("没有符合条件的记忆候选。");
  const list = el("div", undefined, "review-list");
  for (const candidate of visible) list.append(reviewMemoryCard(candidate));
  return list;
}
function reviewDayBlock(day) {
  const key = reviewDayKey(day),
    details = el("details", undefined, "review-day");
  details.open = review.openDays.has(key);
  details.ontoggle = () => {
    if (details.open) review.openDays.add(key);
    else review.openDays.delete(key);
  };
  const summary = el("summary"),
    dateBox = el("div", undefined, "review-day-date"),
    tags = el("div", undefined, "review-day-tags"),
    mini = el("div", undefined, "review-day-mini"),
    chevron = el("span", "›", "review-chevron");
  chevron.setAttribute("aria-hidden", "true");
  dateBox.append(el("b", reviewDayLabel(day.date)));
  const groupCount = new Set(reviewSortedDays().map((item) => item.group_id)).size;
  if (groupCount > 1) dateBox.append(el("small", day.group_label || day.group_id || ""));
  summary.append(dateBox);
  if (day.run?.step && day.run.step !== "done")
    tags.append(reviewStepBadge(day.run.step));
  tags.append(el("span", "发现 " + reviewNumber((day.findings || []).length), "pill"));
  if (Number(day.new_gaps || 0) > 0)
    tags.append(el("span", "新缺口 " + reviewNumber(day.new_gaps), "pill"));
  if ((day.promises_broken || []).length)
    tags.append(
      el(
        "span",
        "未兑现承诺 " + reviewNumber(day.promises_broken.length),
        "pill",
      ),
    );
  summary.append(tags);
  const budget = reviewBudget(day),
    precision = reviewPrecision(day);
  mini.append(
    reviewMeter(budget.ratio, budget.cls, "评判预算", budget.text),
    reviewMeter(
      precision.ratio || 0,
      precision.ratio === null
        ? ""
        : precision.ratio >= 0.7
          ? "is-ok"
          : precision.ratio >= 0.6
            ? "is-warn"
            : "is-bad",
      "精度",
      precision.ratio === null
        ? "— · 还没有人工标注 · 待标注 " + precision.open
        : precision.ratio.toFixed(2) +
          " · 准确 " +
          precision.accepted +
          " · 误判 " +
          precision.rejected +
          " · 待标注 " +
          precision.open,
    ),
  );
  summary.append(mini, chevron);
  details.append(summary);

  const body = el("div", undefined, "review-day-body");
  if (day.run?.step === "skipped")
    body.append(el("p", "这晚没有需要复盘的对话。", "muted"));
  else {
    const dl = el("dl", undefined, "review-qa");
    for (const [key, label] of REVIEW_QA) {
      const value = day.answers?.[key] || "";
      dl.append(el("dt", label));
      const dd = el("dd", value || "—");
      if (!value) dd.className = "muted";
      dl.append(dd);
    }
    body.append(dl);
  }
  const metrics = el("div", undefined, "review-metrics"),
    small = el("small", undefined, "muted"),
    notes = [];
  if (precision.rejects > 0) notes.push("校验丢弃 " + precision.rejects + " 条");
  if (Number(day.run?.same_family) === 1)
    notes.push("同家族回退，置信度已截到 0.7");
  if (notes.length) small.textContent = notes.join(" · ");
  metrics.append(
    reviewMetric("评判预算", budget.text, budget.ratio, budget.cls),
    reviewMetric(
      "精度",
      precision.ratio === null
        ? "— · 还没有人工标注 · 待标注 " + precision.open
        : precision.ratio.toFixed(2) +
          " · 准确 " +
          precision.accepted +
          " · 误判 " +
          precision.rejected +
          " · 待标注 " +
          precision.open,
      precision.ratio || 0,
      precision.ratio === null
        ? ""
        : precision.ratio >= 0.7
          ? "is-ok"
          : precision.ratio >= 0.6
            ? "is-warn"
            : "is-bad",
      notes.length ? small : null,
    ),
  );
  body.append(metrics);
  if ((day.promises_broken || []).length) {
    const promises = el("div", undefined, "review-promises");
    promises.append(el("h3", "没兑现的承诺"));
    for (const promise of day.promises_broken) {
      const statusText =
        { broken: "没做到", cannot: "做不到（缺能力）", expired: "已过期" }[
          promise.status
        ] || promise.status || "未知";
      promises.append(el("blockquote", promise.quote || ""));
      promises.append(
        el(
          "small",
          (promise.what || "—") + " · " + statusText,
          "muted",
        ),
      );
    }
    body.append(promises);
  }
  if (day.run?.step === "failed")
    body.append(
      el(
        "p",
        "这晚的复盘失败了：" + (day.run.error || "未知错误") + "。第二晚会自动重来。",
        "review-error",
      ),
    );
  details.append(body);
  return details;
}
function reviewDaysTab() {
  if (!review.data?.days?.length)
    return reviewState(
      "还没有复盘日报。评审每晚 04:00–07:30（悉尼时间）运行，上线后第二天早上会出现第一份。",
    );
  const list = el("div", undefined, "review-list");
  for (const day of reviewSortedDays()) list.append(reviewDayBlock(day));
  return list;
}
function reviewTabs() {
  const tabs = el("div", undefined, "review-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "复盘内容");
  const days = review.data?.days?.length,
    counts = reviewAllStatusCounts(),
    open = counts.open,
    gaps = (review.data?.gaps || []).filter((gap) =>
      ["open", "regression"].includes(gap.status),
    ).length,
    rules = (review.data?.rules || []).filter((rule) =>
      ["canary", "active"].includes(rule.status),
    ).length,
    memory = review.memory
      ? review.memory.filter((item) => item.status === "candidate").length
      : null,
    items = [
      ["days", "日报", days ?? "·"],
      ["findings", "发现", days === undefined ? "·" : open],
      ["gaps", "缺口", days === undefined ? "·" : gaps],
      ["rules", "规则", days === undefined ? "·" : rules],
      ["memory", "记忆", memory ?? "·"],
    ];
  for (const [key, label, count] of items) {
    const tab = button(
      "",
      () => {
        review.tab = key;
        sessionStorage.setItem("review-tab", key);
        if (
          key === "memory" &&
          review.data &&
          review.memory === null &&
          !review.memoryLoading
        )
          loadReviewMemory();
        else renderReview();
      },
      "review-tab",
    );
    tab.id = "review-tab-" + key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(review.tab === key));
    tab.setAttribute("aria-controls", "review-body");
    tab.append(
      document.createTextNode(label),
      el("span", String(count), "review-count"),
    );
    tabs.append(tab);
  }
  tabs.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const keys = ["days", "findings", "gaps", "rules", "memory"],
      index = keys.indexOf(review.tab),
      next =
        keys[
          (index + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length
        ];
    review.tab = next;
    sessionStorage.setItem("review-tab", next);
    renderReview();
    setTimeout(() => $("review-tab-" + next)?.focus(), 0);
  };
  return tabs;
}
function renderReview() {
  const host = $("review");
  if (!host) return;
  if (
    REVIEW_BASE &&
    !localOwner() &&
    !review.loading &&
    !review.error &&
    (!review.loadedAt || Date.now() - review.loadedAt > 300000)
  ) {
    loadReview();
    return;
  }
  if (
    review.tab === "memory" &&
    review.data &&
    review.memory === null &&
    !review.memoryLoading
  ) {
    loadReviewMemory();
    return;
  }
  const focusId =
    document.activeElement && document.activeElement.id
      ? document.activeElement.id
      : "";
  host.replaceChildren();
  host.setAttribute("aria-busy", String(review.loading && !review.data));

  const head = el("div", undefined, "review-head"),
    status = el("div", undefined, "review-status"),
    actions = el("div", undefined, "actions");
  if (REVIEW_BASE) {
    const mode = reviewMode();
    if (review.health?.off === true) status.append(badge("已暂停 · off:review", "bad"));
    else if (mode && REVIEW_MODE[mode]) status.append(badge(REVIEW_MODE[mode], mode === "propose" ? "warn" : mode === "full" ? "ok" : ""));
    if (review.healthError) status.append(badge("健康检查失败", "warn"));
    else if (review.health?.last_run) {
      const last = review.health.last_run,
        step = REVIEW_STEP[last.step] || last.step || "未知";
      status.append(
        badge(
          "最近一次 · " + reviewDayShort(last.date) + " · " + step,
          last.step === "done" ? "ok" : last.step === "failed" ? "bad" : "warn",
        ),
      );
    }
    const precision = reviewSevenDayPrecision();
    status.append(
      badge(
        precision
          ? "7 天精度 " + precision.ratio.toFixed(2)
          : "7 天精度 —",
        !precision
          ? ""
          : precision.ratio >= 0.7
            ? "ok"
            : precision.ratio >= 0.6
              ? "warn"
              : "bad",
      ),
    );
    status.append(badge(reviewIsAdmin() ? "管理员" : "只读", ""));
  }
  const refresh = button(
    review.loading ? "刷新中…" : "刷新复盘",
    () => loadReview(true),
  );
  refresh.id = "review-refresh";
  refresh.disabled = review.loading || !REVIEW_BASE || localOwner();
  actions.append(refresh);
  head.append(status, actions);
  host.append(head);

  const note = el("p", undefined, "note review-role");
  let noteText = reviewIsAdmin()
    ? "你可以把发现标为准确或误判（用来算精度），也可以撤销规则。"
    : "你可以查看全部复盘。标注发现、撤销规则需要管理员。";
  if (reviewMode() === "shadow")
    noteText += " 现在是影子模式：只记录，不建任务、不改规则。";
  note.textContent = noteText;
  host.append(note);

  if (review.data) {
    const latest = reviewLatestDay();
    if (latest) {
      const strip = el("div", undefined, "review-strip"),
        coverage = latest.coverage || {},
        budget = reviewBudget(latest),
        failed = Number(latest.judge_failed || 0);
      strip.append(
        badge(
          coverage.balanced === false
            ? "覆盖账 不平" + (Number(coverage.unaccounted || 0) ? " · " + coverage.unaccounted + " 条未归账" : "")
            : "覆盖账 平",
          coverage.balanced === false ? "bad" : "ok",
        ),
        badge("judge_failed " + reviewNumber(failed), failed > 0 ? "warn" : ""),
        badge("当日预算 " + budget.text, budget.cls === "is-bad" ? "bad" : budget.cls === "is-warn" ? "warn" : ""),
      );
      host.append(strip);
    }
  }

  if (review.error && review.data) host.append(reviewErrorLine(review.error));
  host.append(reviewTabs());
  const body = el("div", undefined, "review-body");
  body.id = "review-body";
  body.setAttribute("role", "tabpanel");
  body.setAttribute("aria-labelledby", "review-tab-" + review.tab);
  if (!REVIEW_BASE) body.append(reviewState("复盘服务地址还没配置。"));
  else if (localOwner()) {
    const stateBox = reviewState("本机开发台不连复盘服务。");
    stateBox.append(
      link("去线上工作台查看", "https://inkboard-team.inkboard-server.workers.dev"),
    );
    body.append(stateBox);
  } else if (review.loading && !review.data)
    body.append(reviewState("正在读取复盘…"));
  else if (review.error && !review.data)
    body.append(reviewState(reviewErrorText(review.error), true, true));
  else if (!review.data) body.append(reviewState("正在读取复盘…"));
  else if (review.tab === "findings") body.append(reviewFindingsTab());
  else if (review.tab === "gaps") body.append(reviewGapsTab());
  else if (review.tab === "rules") body.append(reviewRulesTab());
  else if (review.tab === "memory") body.append(reviewMemoryTab());
  else body.append(reviewDaysTab());
  host.append(body);

  if (focusId.startsWith("review-") && $(focusId)) $(focusId).focus();
}
async function reviewApi(path, body, method) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(REVIEW_BASE + path, {
      method: method || "GET",
      mode: "cors",
      credentials: "omit",
      signal: ctl.signal,
      headers: {
        Authorization: "Bearer " + token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = Error(j.error || "未知错误");
      e.status = r.status;
      throw e;
    }
    return j;
  } catch (e) {
    if (e.name === "AbortError") e.kind = "timeout";
    else if (e instanceof TypeError) e.kind = "network";
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
async function loadReview(force) {
  if (!REVIEW_BASE || localOwner() || review.loading) return;
  if (!force && review.loadedAt && Date.now() - review.loadedAt < 300000) return;
  review.loading = true;
  review.error = null;
  renderReview();
  const [health, digest] = await Promise.allSettled([
    reviewApi("/review/health"),
    reviewApi("/review/digest?days=7"),
  ]);
  if (health.status === "fulfilled") {
    review.health = health.value;
    review.healthError = null;
  } else {
    review.health = null;
    review.healthError = health.reason;
  }
  if (digest.status === "fulfilled") {
    review.data = digest.value;
    review.loadedAt = Date.now();
    review.error = null;
    review.memory = null;
    review.memoryLoadedAt = 0;
    if (!review.daysInit) {
      review.daysInit = true;
      const first = reviewSortedDays()[0];
      if (first) review.openDays.add(reviewDayKey(first));
    }
  } else review.error = digest.reason;
  review.loading = false;
  renderReview();
}
function renderActivity() {
  $("activity").replaceChildren();
  if (!state.activity.length)
    $("activity").append(empty("尚无新的任务操作记录"));
  for (const a of state.activity) {
    const row = el("div", undefined, "event");
    row.append(
      el("small", date(a.created_at)),
      el("small", a.actor),
      el("p", a.summary),
    );
    $("activity").append(row);
  }
}
function table(headers, rows) {
  const box = el("div", undefined, "table-wrap"),
    t = el("table", undefined, "table"),
    h = el("tr");
  for (const x of headers) h.append(el("th", x));
  t.append(h);
  for (const row of rows) {
    const tr = el("tr");
    for (const x of row) tr.append(el("td", String(x)));
    t.append(tr);
  }
  box.append(t);
  return box;
}
// Version 10-L, byte mode, mask 0: sufficient for the validated (<=240 byte) scan URL.
// Matrices are checked against the independent Nayuki QR reference implementation.
function loginQrMatrix(text) {
  const bytes = new TextEncoder().encode(text), bits = [];
  if (bytes.length > 240) throw Error('二维码内容过长，请重新登录');
  const push = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(4, 4); push(bytes.length, 16);
  for (const byte of bytes) push(byte, 8);
  push(0, 4); while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, bit) => v * 2 + bit, 0));
  for (let pad = 0; data.length < 274; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const multiply = (a, b) => {
    let value = 0;
    for (; b; b >>>= 1) { if (b & 1) value ^= a; a <<= 1; if (a & 256) a ^= 0x11d; }
    return value;
  };
  let divisor = [1], root = 1;
  for (let i = 0; i < 18; i++) {
    const next = Array(divisor.length + 1).fill(0);
    divisor.forEach((n, j) => { next[j] ^= n; next[j + 1] ^= multiply(n, root); });
    divisor = next; root = multiply(root, 2);
  }
  let offset = 0;
  const blocks = [68, 68, 69, 69].map(length => {
    const block = data.slice(offset, offset += length), parity = Array(18).fill(0);
    for (const byte of block) {
      const factor = byte ^ parity.shift(); parity.push(0);
      for (let j = 0; j < 18; j++) parity[j] ^= multiply(divisor[j + 1], factor);
    }
    return { block, parity };
  });
  const codewords = [];
  for (let i = 0; i < 69; i++) for (const b of blocks) if (i < b.block.length) codewords.push(b.block[i]);
  for (let i = 0; i < 18; i++) for (const b of blocks) codewords.push(b.parity[i]);
  const size = 57, matrix = Array.from({ length: size }, () => Array(size).fill(false)), reserved = matrix.map(row => row.slice());
  const mark = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { matrix[y][x] = !!dark; reserved[y][x] = true; } };
  for (let i = 0; i < size; i++) { mark(6, i, i % 2 === 0); mark(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [53, 3], [3, 53]]) {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) { const d = Math.max(Math.abs(x), Math.abs(y)); mark(cx + x, cy + y, d !== 2 && d !== 4); }
  }
  for (const cx of [6, 28, 50]) for (const cy of [6, 28, 50]) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === 50) || (cx === 50 && cy === 6)) continue;
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) mark(cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
  }
  let rem = 8;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((8 << 10) | rem) ^ 0x5412, bit = (value, n) => (value >>> n) & 1;
  for (let i = 0; i < 6; i++) mark(8, i, bit(format, i));
  mark(8, 7, bit(format, 6)); mark(8, 8, bit(format, 7)); mark(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) mark(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i, bit(format, i));
  mark(8, size - 8, true);
  rem = 10;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const version = (10 << 12) | rem;
  for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, b = Math.floor(i / 3); mark(a, b, bit(version, i)); mark(b, a, bit(version, i)); }
  let index = 0;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - step : step;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!reserved[y][x]) { const dark = bit(codewords[index >>> 3] || 0, 7 - (index & 7)); index++; matrix[y][x] = !!(dark ^ ((x + y) % 2 === 0)); }
      }
    }
  }
  return matrix;
}
function loginQr(text) {
  const matrix = loginQrMatrix(text), ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 65 65'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'B 站登录二维码，请用 B 站手机 App 扫描并确认');
  svg.setAttribute('class', 'login-qr'); svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS(ns, 'rect');
  background.setAttribute('width', '65'); background.setAttribute('height', '65'); background.setAttribute('fill', '#fff');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', '#000');
  path.setAttribute('d', matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? ['M' + (x + 4) + ',' + (y + 4) + 'h1v1h-1z'] : [])).join(''));
  svg.append(background, path); return svg;
}
let loginRefreshBusy = false, lastLoginRefresh = 0, loginSnapshot, loginQrDeadline;
const loginStartBusy = new Set();
async function startServiceLogin(panel, service, flow) {
  if (service === 'bili' && localOwner()) {
    try {
      const response = await fetch('/api/local/open-login', {
        method: 'POST',
        headers: {'X-TeamAgent-Local': '1', ...(localSession ? {'X-TeamAgent-Session': localSession} : {})},
      });
      if (response.ok && (await response.json()).opened === true) return;
    } catch {}
  }
  if (loginStartBusy.has(service)) return;
  loginStartBusy.add(service);
  try {
    if (flow && ['waiting','scanned'].includes(flow.phase)) {
      try { await api('/api/team/service-login', {service,id:flow.id}, 'DELETE'); }
      catch (e) {
        if (e.localLocked) throw e;
        if (e.status !== 409) throw Error('取消旧登录失败，请稍后重试；尚未创建新的登录。');
        let latest;
        try { latest = await api('/api/team/service-login'); }
        catch (e) {
          if (e.localLocked) throw e;
          throw Error('无法确认旧登录是否已结束，请刷新后重试；尚未创建新的登录。');
        }
        const current = latest.services[service].flow;
        if (current && ['waiting','scanned'].includes(current.phase))
          throw Error('登录流程已变化，请刷新后重试；尚未创建新的登录。');
      }
    }
    await api('/api/team/service-login', {service});
  } finally {
    loginStartBusy.delete(service); panel.loginSignature = ''; await refreshServiceLogins(panel);
  }
}
function tickLoginCountdown(panel) {
  const clock = panel.loginCountdown;
  if (!clock) return;
  if (!panel.isConnected) { panel.loginCountdown = null; return; }
  const seconds = Math.max(0, Math.ceil((clock.expiresAt - Date.now()) / 1000));
  clock.label.textContent = '二维码剩余有效时间：' + seconds + ' 秒';
  if (seconds === 0) {
    clock.message.textContent = '已过期'; clock.qr.remove(); clock.cancel.remove();
    clock.start.textContent = '重新获取二维码'; clock.start.disabled = false;
    panel.loginCountdown = null; panel.loginSignature = '';
  }
}
async function localServiceQr(id) {
  const response = await fetch('/api/local/service-login/qr?id=' + encodeURIComponent(id), {
    headers: {'X-TeamAgent-Local':'1',...(localOwner()?{'X-TeamAgent-Session':localSession}:{})}, cache:'no-store', referrerPolicy:'no-referrer', signal:AbortSignal.timeout(3000),
  });
  if (response.status === 404) return null;
  if (localOwner() && response.status === 401 && (await response.json()).error === LOCAL_LOCKED) throw localLockedError();
  if (!response.ok) throw Error('无法取得本机二维码，请检查本机管理员开发台。');
  const qr = await response.json();
  return qr.id === id && qr.expires_at > Date.now() && typeof qr.qr_url === 'string' ? qr.qr_url : null;
}
async function renderServiceLogins(box) {
  if (state?.who.role !== 'owner') return;
  const panel = el('section', undefined, 'panel'); panel.id = 'service-logins';
  panel.setAttribute('aria-label', '本机服务登录'); box.append(panel);
  await refreshServiceLogins(panel);
}
async function refreshServiceLogins(panel) {
  if (loginRefreshBusy) return;
  loginRefreshBusy = true;
  try {
    const snapshot = await api('/api/team/service-login');
    if (!panel.isConnected || state?.who.role !== 'owner') return;
    const isLocalOwner = localOwner();
    const biliFlow = snapshot.services.bili.flow;
    if (loginQrDeadline?.id !== biliFlow?.id || !['waiting','scanned'].includes(biliFlow?.phase)) loginQrDeadline = null;
    const qrExpired = !!loginQrDeadline && loginQrDeadline.expiresAt <= Date.now();
    const localQr = isLocalOwner && snapshot.online && biliFlow && ['waiting','scanned'].includes(biliFlow.phase) && biliFlow.expires_at > Date.now() && !qrExpired
      ? await localServiceQr(biliFlow.id) : null;
    if (localQr && !loginQrDeadline) loginQrDeadline = {id:biliFlow.id,expiresAt:Math.min(biliFlow.expires_at, Date.now() + 180000)};
    loginSnapshot = snapshot; lastLoginRefresh = Date.now();
    // Keep focused buttons and the same QR in place while only the heartbeat timestamp changes.
    const visual = JSON.stringify({online:snapshot.online,services:snapshot.services,localQr,qrExpired,starting:[...loginStartBusy]}, (key, value) => key === 'updated_at' ? undefined : value);
    if (panel.loginSignature === visual) return;
    panel.loginSignature = visual;
    panel.loginCountdown = null;
    panel.replaceChildren(el('h2', '本机服务登录'));
    panel.append(el('p', '用 B 站 App 扫码确认；X 在这台电脑弹出的窗口中登录。', 'note'));
    if (!isLocalOwner) panel.append(localConsoleLink('在这台电脑上打开本机开发台扫码（先双击桌面「TeamAgent-登录」）'));
    if (!snapshot.online) panel.append(el('p', '本机服务没有运行。请双击桌面的 TeamAgent-登录；仍不行就重启 Mac 上的 TeamAgent 服务。', 'error'));
    const cards = el('div', undefined, 'grid');
    for (const service of ['bili', 'x']) {
      const label = service === 'bili' ? 'B 站' : 'X', entry = snapshot.services[service], flow = entry.flow;
      const riskNotice = service === 'bili' && (flow?.reason === 'risk' || entry.auth?.state === 'risk');
      const active = flow && ['waiting', 'scanned'].includes(flow.phase) && flow.expires_at > Date.now() && !(service === 'bili' && qrExpired);
      const card = el('article', undefined, 'card');
      card.append(el('h3', label));
      let status = ({ok:'已登录',missing:'未登录',expired:'已过期',risk:'登录需要验证'})[entry.auth?.state] || '未登录';
      if (flow) status = ({waiting:'等待本机服务领取',scanned:'已扫码待确认',ok:'已登录',expired:'已过期',failed:'登录失败',cancelled:'已取消'})[flow.phase];
      if (service === 'bili' && flow && ['waiting','scanned'].includes(flow.phase) && !active) status = '已过期';
      if (active && service === 'bili' && localQr) status = flow.phase === 'scanned' ? '已扫码待确认' : '等待扫码';
      if (active && service === 'x' && flow.started) status = '已在你的电脑上打开登录窗口';
      else if (active && flow.claimed && (service === 'x' || !localQr)) status = service === 'x' ? '正在电脑上打开登录窗口' : '正在获取二维码';
      if (flow?.reason === 'risk' || (riskNotice && !active)) status = 'B 站暂时限制，请稍后再试';
      const message = el('p', status); message.setAttribute('role', 'status'); card.append(message);
      if (service === 'x') card.append(el('p', '登录时会在这台 Mac 上弹出一个 Chrome 窗口。请在弹出的 Chrome 中，确认是真实的 x.com 页面后登录。不要在本网页里输入密码；本网页不会也不需要你的密码。', 'note'));
      card.append(el('small', '最近检查：' + date(entry.auth?.checked_at)));
      const qr = active && service === 'bili' && localQr ? loginQr(localQr) : null;
      if (qr) card.append(qr);
      const actions = el('div', undefined, 'actions');
      const start = button(service === 'bili' && status === '已过期' ? '重新获取二维码' : service === 'x' && status === '已登录' ? '重新登录 X' : '登录 ' + label, () => startServiceLogin(panel, service, flow), 'primary');
      start.disabled = !!active || !snapshot.online || loginStartBusy.has(service) || (service === 'bili' && !isLocalOwner); actions.append(start);
      const cancel = active ? button('取消登录', async () => { await api('/api/team/service-login', {service,id:flow.id}, 'DELETE'); panel.loginSignature = ''; await refreshServiceLogins(panel); }) : null;
      if (cancel) actions.append(cancel);
      if (qr) {
        const countdown = el('p', undefined, 'note'); countdown.setAttribute('role', 'timer'); card.append(countdown);
        panel.loginCountdown = {label:countdown,message,qr,start,cancel,expiresAt:loginQrDeadline.expiresAt};
        tickLoginCountdown(panel);
      }
      card.append(actions); cards.append(card);
    }
    panel.append(cards);
  } catch (e) {
    panel.loginCountdown = null;
    panel.loginSignature = '';
    panel.replaceChildren(el('h2', '本机服务登录'), el('p', e.message, 'error'));
  } finally { loginRefreshBusy = false; }
}
setInterval(async () => {
  if (document.hidden || $('app').hidden || view !== 'system' || state?.who.role !== 'owner' || loading) return;
  const panel = $('service-logins'); if (!panel) return;
  tickLoginCountdown(panel);
  if (loginRefreshBusy) return;
  const active = Object.values(loginSnapshot?.services || {}).some(s => s.flow && ['waiting','scanned'].includes(s.flow.phase));
  if (Date.now() - lastLoginRefresh >= (active ? 2000 : 30000)) await refreshServiceLogins(panel);
}, 1000);

async function renderSystem() {
  const box = $("system");
  box.replaceChildren();
  await renderServiceLogins(box);
  const model = el("section", undefined, "panel");
  model.append(
    el("h2", "最近 24 小时 · 模型调用"),
    el("p", "统计真实调用次数、耗时与 API 返回的 Token；未估算账单。", "note"),
  );
  model.append(
    table(
      ["用途", "档位", "结果", "调用", "平均耗时", "输入 / 输出 Token"],
      state.ops.models.map((m) => [
        m.kind,
        m.effort,
        m.status,
        m.n,
        Math.round(m.duration_ms / 100) / 10 + " 秒",
        m.input_tokens + " / " + m.output_tokens,
      ]),
    ),
  );
  box.append(model);
  const queues = el("section", undefined, "panel");
  queues.append(
    el("h2", "后台任务"),
    table(
      ["通道", "状态", "数量"],
      state.ops.queues.map((q) => [q.kind, q.status, q.n]),
    ),
  );
  box.append(queues);
  const samples = state.ops.samples || [],
    online = samples.filter((s) => s.gateway_ok && s.runner_ok).length,
    health = el("section", undefined, "panel");
  health.append(
    el("h2", "连续运行观察"),
    el(
      "p",
      samples.length
        ? "已记录 " +
            samples.length +
            " 个五分钟采样，其中网关与执行端同时在线 " +
            online +
            " 次。"
        : "采样刚开始，尚不能判断长期在线情况。",
    ),
    el(
      "p",
      "采样用于发现断连，不代替真实消息、故障恢复和开发任务验收。当前使用本机 QQ 网关，电脑需登录、联网且保持唤醒。",
      "note",
    ),
    el(
      "p",
      "夜间素材：" +
        state.ops.memory
          .map(
            (m) =>
              (m.processed === 0
                ? "待整理"
                : m.processed === 1
                  ? "已整理"
                  : "整理失败") +
              " " +
              m.n +
              " 条",
          )
          .join(" · "),
      "note",
    ),
  );
  box.append(health);
  const issues = el("section", undefined, "panel");
  issues.append(el("h2", "需要核对的工作"));
  box.append(issues);
  try {
    const o = await api("/api/team/ops");
    if (!o.failures.length && !o.deliveries.length && !o.notices.length)
      issues.append(empty("当前没有待核对的后台任务"));
    for (const j of o.failures) {
      const a = el("div", undefined, "card");
      a.append(
        el("p", j.kind + " · " + j.status + " · " + j.attempts + " 次尝试"),
        el("small", j.id + " · " + date(j.created_at)),
      );
      if (
        state.who.role === "owner" &&
        j.status === "failed" &&
        ["plan", "research", "dream"].includes(j.kind)
      )
        a.append(
          button("人工重试", async () => {
            await api("/api/admin/retry-job", { id: j.id });
            await load();
            toast("已重新排队");
          }),
        );
      issues.append(a);
    }
    for (const n of o.notices)
      issues.append(
        el(
          "p",
          "群消息 " + n.status + " · " + date(n.created_at) + " · " + n.id,
          "note",
        ),
      );
    for (const d of o.deliveries)
      issues.append(
        el(
          "p",
          "附件 " +
            d.status +
            " · 已确认 " +
            d.sent_count +
            " 个 · " +
            date(d.updated_at),
          "note",
        ),
      );
  } catch (e) {
    issues.append(el("p", e.message));
  }
}
$("guide").onclick = async () => {
  try {
    const r = await api("/api/team/guide");
    show(el("h2", "使用说明"), el("pre", r.guide));
  } catch (e) {
    error(e);
  }
};
$("nameform").onsubmit = async (event) => {
  event.preventDefault();
  const b = $("namelogin");
  if (b.disabled) return;
  b.disabled = true;
  $("logincode").textContent = "";
  try {
    const r = await api("/api/team/login-name", {
      password: $("membername").value,
    });
    token = r.token;
    sessionStorage.setItem("team-token", token);
    $("membername").value = "";
    await load();
  } catch (e) {
    $("logincode").textContent = e.message;
  } finally {
    b.disabled = false;
  }
};
$("logout").onclick = async () => {
  await api("/api/team/logout", {});
  sessionStorage.removeItem("team-token");
  location.reload();
};
$("refresh").onclick = load;
$("repo").onchange = render;
$("search").oninput = render;
$("person").onchange = render;
$("close").onclick = () => $("modal").close();
$("new").onclick = () => newTask();
$("who").onclick = () => {
  const box = el("div");
  box.append(
    el("p", "当前身份：" + state.who.name),
    el(
      "p",
      "大家查看同一份工作台；领取后任务显示你的名字，进展也同步给其他成员。",
      "note",
    ),
    button("只看我接手的工作", () => {
      $("modal").close();
      $("person").value = "mine";
      selectView("tasks");
    }),
    button("连接我的本机AI", showLocalAI),
  );
  show(el("h2", state.who.name), box);
};
$("localai").onclick = () => showLocalAI();
async function showLocalAI() {
  const result = await api("/api/team/ai-tokens"),
    box = el("div"),
    label = input("我的本机AI");
  box.append(
    el(
      "p",
      "让你电脑上的 Claude、Codex 或其他支持 MCP 的助手读取方案、接手任务、回填结果。动作会记在你的名字下。",
    ),
    el(
      "p",
      "每台电脑可用独立、可撤销的接入凭证。不要把凭证发到群里或写进仓库。",
      "note",
    ),
    field("这台AI的名字", label),
  );
  const actions = el("div", undefined, "actions");
  actions.append(
    button(
      "生成我的接入配置",
      async () => {
        const key = await api("/api/team/ai-tokens", { label: label.value });
        const url = "https://inkboard-team.inkboard-server.workers.dev";
        const config = {
          mcpServers: {
            teamagent: {
              command: "node",
              args: ["/你的本机路径/TeamAgent/clients/mcp.mjs"],
              env: { TEAM_AGENT_URL: url, TEAM_AGENT_TOKEN: key.token },
            },
          },
        };
        const text = JSON.stringify(config, null, 2);
        const details = el("div");
        details.append(
          el("h3", "仅本次显示 · 请保存在自己的AI配置中"),
          el(
            "p",
            "先克隆团队仓库，在clients目录运行npm ci；把下方路径换成自己电脑上的实际路径。凭证90天有效，可随时撤销。",
            "note",
          ),
          el("pre", text),
          button("复制MCP配置", () => copy(text)),
          link(
            "完整接入说明",
            "https://github.com/OmnixSI/TeamAgent/blob/main/docs/local-ai.md",
          ),
        );
        box.append(details);
      },
      "primary",
    ),
  );
  box.append(actions, el("h3", "已有连接"));
  for (const t of result.tokens) {
    const row = el("div", undefined, "card");
    row.append(
      el("p", t.label + " · " + (t.revoked ? "已撤销" : "可使用")),
      el(
        "small",
        "上次使用 " + date(t.last_used) + " · 到期 " + date(t.expires),
      ),
    );
    if (!t.revoked)
      row.append(
        button("撤销这把凭证", async () => {
          await api("/api/team/ai-tokens", { id: t.id }, "DELETE");
          await showLocalAI();
        }),
      );
    box.append(row);
  }
  show(el("h2", "我的本机AI接入"), box);
}
$("admin").onclick = () => {
  const box = el("div");
  box.append(
    el(
      "p",
      "团队使用三人名字登录。管理员可以暂停或恢复访问；暂停时会撤销该成员的会话和本机AI凭证。",
      "note",
    ),
  );
  box.append(el("h3", "成员访问"));
  for (const m of state.members.filter((m) => m.id.startsWith("name:"))) {
    const row = el("div", undefined, "actions");
    row.append(
      el("p", m.name + (m.revoked ? " · 已撤销" : "")),
      button(m.revoked ? "恢复" : "撤销", async () => {
        await api("/api/admin/" + (m.revoked ? "restore" : "revoke"), {
          id: m.id,
        });
        $("modal").close();
        await load();
      }),
    );
    box.append(row);
  }
  const connection = el("details");
  connection.append(
    el("summary", "QQ 接入维护"),
    el("p", "回调地址：" + location.origin + "/api/qq/events", "note"),
    button("生成目标群绑定码", async () => {
      const r = await api("/api/admin/pair", {});
      box.append(el("pre", "请群主在目标群发送：/绑定 " + r.code));
    }),
  );
  box.append(connection);
  show(el("h2", "管理接入"), box);
};
async function startLocalOwner() {
  const fragment = location.hash || '';
  if (fragment.startsWith('#unlock=')) {
    const code = fragment.slice(8);
    // Erase the one-time code before any exchange or other network request.
    history.replaceState(null, '', '/');
    try {
      const response = await fetch('/api/local/session', {
        method:'POST', headers:{'Content-Type':'application/json','X-TeamAgent-Local':'1'},
        body:JSON.stringify({code}), cache:'no-store', referrerPolicy:'no-referrer',
      });
      if (!response.ok) { showLocalLocked(); return; }
      const data = await response.json();
      if (typeof data.session !== 'string' || !data.session) { showLocalLocked(); return; }
      localSession = data.session; sessionStorage.setItem('local-session', localSession);
      $('nameform').hidden = true;
      // The desktop entry opens directly on the Bilibili/X login controls.
      selectView('system');
    } catch { showLocalLocked(); }
  } else if (localSession) await load();
  else showLocalLocked();
}
if (localOwner()) startLocalOwner();
else if (token) load();
setInterval(async () => {
  if (document.hidden || $("app").hidden || $("modal").open || loading) return;
  try {
    const p = await api("/api/team/pulse");
    Object.assign(state.connection, p.connection);
    renderStatus();
    if (
      p.revision !== state.revision ||
      Date.now() - lastFull > 300000 ||
      (view === "system" && Date.now() - lastFull > 60000)
    )
      await load();
  } catch (e) {
    error(e);
  }
}, 30000);
