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
    if (!snapshot.online) panel.append(el('p', '本机服务没在线，请检查', 'error'));
    const cards = el('div', undefined, 'grid');
    for (const service of ['bili', 'x']) {
      const label = service === 'bili' ? 'B 站' : 'X', entry = snapshot.services[service], flow = entry.flow;
      const active = flow && ['waiting', 'scanned'].includes(flow.phase) && flow.expires_at > Date.now() && !(service === 'bili' && qrExpired);
      const card = el('article', undefined, 'card');
      card.append(el('h3', label));
      let status = ({ok:'已登录',missing:'未登录',expired:'已过期',risk:'登录需要验证'})[entry.auth?.state] || '未登录';
      if (flow) status = ({waiting:'等待本机服务领取',scanned:'已扫码待确认',ok:'已登录',expired:'已过期',failed:'登录失败',cancelled:'已取消'})[flow.phase];
      if (service === 'bili' && flow && ['waiting','scanned'].includes(flow.phase) && !active) status = '已过期';
      if (active && service === 'bili' && localQr) status = flow.phase === 'scanned' ? '已扫码待确认' : '等待扫码';
      if (active && service === 'x' && flow.started) status = '已在你的电脑上打开登录窗口';
      else if (active && flow.claimed && (service === 'x' || !localQr)) status = service === 'x' ? '正在电脑上打开登录窗口' : '正在获取二维码';
      if (flow?.reason === 'risk') status = 'B 站暂时限制，请稍后再试';
      const message = el('p', status); message.setAttribute('role', 'status'); card.append(message);
      if (service === 'x') card.append(el('p', '登录时会在这台 Mac 上弹出一个 Chrome 窗口。请在弹出的 Chrome 中，确认是真实的 x.com 页面后登录。不要在本网页里输入密码；本网页不会也不需要你的密码。', 'note'));
      card.append(el('small', '最近检查：' + date(entry.auth?.checked_at)));
      const qr = active && service === 'bili' && localQr ? loginQr(localQr) : null;
      if (qr) card.append(qr);
      const actions = el('div', undefined, 'actions');
      const start = button(service === 'bili' && status === '已过期' ? '重新获取二维码' : '登录 ' + label, () => startServiceLogin(panel, service, flow), 'primary');
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
