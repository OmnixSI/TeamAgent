# D 版 · D8 界面规格：账本与自动化（工作台只读页）+ 收件箱

> 设计师 · 2026-11-14 · 基线 worktree `TeamAgent-D-D8` @ 3adfdf8（`web/index.html` / `web/app.js` / `web/style.css`）
> 数据依据：`design.md` §5.3（PublicRecord、可见性）、§5.5（日程 spec、双时区）、§5.7（技能）、§6 D8 行。
> 施工者：前端工程师。**照做即可，不需要自己判断。** 遇到本文没写到的情况，交回主程，不要自创样式。

---

## 0. 方向

- **模式：操作 + 阅读**（查账、看自动化有没有在跑）。不是展示页，不需要任何「好看」的装饰。
- **三个词：账房、清楚、安静。** 数字右对齐、等宽数字（`font-variant-numeric: tabular-nums`），状态只用现有四种 badge 颜色，一屏能看完。
- **沿用现有工作台**：白色 `.panel`、`.table`、`.badge`（ok/warn/bad）、`.empty`、`toast()`、`button()`、`el()`、`api()`、分段切换沿用「自省复盘」`.review-tabs` 的视觉（复制数值，换类名）。
- **不要**：渐变、阴影卡片堆叠、图标字体、emoji、彩色头像、图表库、骨架屏动画、新的颜色。全页没有新的 primary 按钮（`＋ 新任务` 仍是唯一 primary）。

## 1. Token（全部来自现有 `:root` 和复盘面板，不新增色值以外的东西）

| 用途 | 值 | 来源 |
|---|---|---|
| 正文 | `#20283b` | `:root color` |
| 次要文字 | `var(--muted)` = `#6d768b` | `:root` |
| 线 | `var(--line)` = `#e2e6ee` | `:root` |
| 强调（选中、链接） | `var(--accent)` = `#4b4bd6` | `:root` |
| 选中底 / 字 / 边 | `#efefff` / `#4545ae` / `#aaa9ee` | `.member-chip.mine` |
| 成功 | `var(--green)` `#16735a`，底 `#e6f3ee` | `.badge.ok` |
| 警告 | `#996120`，底 `#fff1df` | `.badge.warn` |
| 错误 / 负数 | `var(--red)` `#a84245`，底 `#fae9e9` | `.badge.bad` |
| 轨道（分段底、进度条底） | `#eef0f6` | `.review --track` |
| 私有行底 | `#fafaff` | 新（选中底再淡一级） |
| 暂停行底 | `#fffaf2` | 新（警告底再淡一级） |
| 字号 | 页面标题 h2 18px / 区块标题 15px 600 / 表格 13px / 辅助 12px | 现有 |
| 圆角 | 面板 12px、表内小块 8px、chip 20px | 现有 |
| 动效 | 只有展开箭头 `transform 160ms cubic-bezier(0.2,0,0,1)`，`prefers-reduced-motion` 下为 0 | 复盘面板 |

新增 CSS 全部放在 `web/style.css` 末尾，以注释 `/* D8 · 账本与自动化 */` 开头，类名统一前缀 **`desk-`**。

## 2. 入口与导航

### 2.1 顶部标签
`web/app.js` 的 `tabs` 对象在 `materials` 之后插入：

```js
desk: "账本与自动化",
```
顺序变成：任务与方案 · 资料与发现 · **账本与自动化** · 项目动态 · 记忆与成长 · 操作记录 · 运行状态。

`web/index.html` 在 `#materials-view` 后加：
```html
<section id="desk-view" hidden>
  <div id="desk-seg" class="desk-seg" role="tablist" aria-label="账本与自动化"></div>
  <div id="desk-body"></div>
</section>
```
`render()` 的映射加 `desk: renderDesk`。

### 2.2 进入本标签时隐藏全局工具栏
`selectView()` 里：`view === "desk"` 时 `#repo`、`#search`、`#person` 都 `hidden = true`；并给 `.toolbar` 容器 `hidden = view === "desk"`（避免留下空的 18px 间距）。三页各自有自己的筛选。

### 2.3 分段切换（三个子页）
`#desk-seg` 内三个按钮（`role="tab"`、`aria-selected`、`aria-controls="desk-body"`，左右方向键切换，同顶部 tabs 写法）：

| key | 文案 | 计数（灰色小字 `.desk-count`） |
|---|---|---|
| `ledger` | 账本/清单 | 类型数（不含已归档） |
| `skills` | 技能 | 技能数（不含已停用） |
| `schedules` | 日程 | 运行中 + 已暂停 数；**有暂停时**计数后追加 `· N 暂停`，这一段用 `#996120` |

样式 `.desk-seg` = 复制 `.review-tabs`（`display:inline-flex; gap:4px; padding:4px; background:#eef0f6; border-radius:10px; margin-bottom:18px`）；按钮 = 复制 `.review-tabs button` 与 `[aria-selected="true"]`（白底、`#20283b`、600、`box-shadow:0 1px 2px #20283b14`）。计数 `.desk-count { margin-left:6px; font-size:12px; color:#58627a; font-variant-numeric:tabular-nums }`。

当前子页记在 `sessionStorage["desk-tab"]`，默认 `ledger`。

### 2.4 链接直达（S-07 群里发的「工作台链接」）
- 地址格式：`<工作台域名>/#desk/ledger/<type_id>`、`#desk/skills`、`#desk/schedules`。后端拼链接时用这个格式（写进给 D1/D6 的说明）。
- `load()` 第一次成功后、以及 `hashchange` 时：若 `location.hash` 以 `#desk` 开头 → `selectView("desk")`，取第二段为子页，第三段为要选中的类型 id。
- 用户在页内切换子页或选类型时，用 `history.replaceState(null, "", "#desk/...")` 同步地址（不产生历史记录）。离开本标签时 `replaceState` 去掉 hash。
- **未登录打开链接**：登录面板 `#login` 的 `<p>` 下方加一行 `.note`（只在 hash 以 `#desk` 开头时显示）：
  > 登录后会直接打开群里发来的那一页。
- 类型 id 不存在或无权看：正常进入账本页，选中第一个类型，并 `toast("没找到这个账本，可能已归档或被删除")`。

### 2.5 加载与刷新
- 首次进入某子页才请求（懒加载），结果缓存在 `desk` 对象：`{ tab, types, typeId, records, summary, skills, schedules, loadedAt, error }`。
- 顶部 `刷新` 按钮：现有逻辑之外，若 `view === "desk"` 再重拉当前子页。
- 再次切回已加载的子页不重拉（除非距上次 > 60 秒）。

## 3. 通用状态（三页一致）

| 状态 | 表现 | 文案 |
|---|---|---|
| 加载中（首次） | `#desk-body` 里一个 `.empty` | `正在读取…` |
| 加载中（已有数据刷新） | 不清空，数据照旧显示；分段控件右侧不加任何东西 | — |
| 错误（无数据） | `.desk-state.is-error`：居中红字 + `重试` 按钮（`.review-mini` 尺寸） | `读取失败：<错误信息>` |
| 错误（有旧数据） | 列表上方一行 `.desk-error`（红字 13px）+ 行尾 `重试` 按钮 | `刷新失败：<错误信息>（显示的是 HH:MM 的数据）` |
| 401 | 走现有 `api()` 的回登录页逻辑，不另写 | — |
| 403 | 同错误（无数据），信息用后端返回的 `error` | — |

`.desk-state` / `.desk-error` 直接复制 `.review-state` / `.review-error` 的规则。

## 4. 账本/清单页（`ledger`）

### 4.1 布局
- **≥1100px**：两栏 `display:grid; grid-template-columns: 260px minmax(0,1fr); gap:18px; align-items:start`（类 `.desk-split`）。左栏类型列表，右栏内容。
- **651–1099px**：同上，左栏 220px。
- **≤650px**：单栏。左栏换成一个全宽 `<select id="desk-type-select" aria-label="选择账本">`（选项文案 `<名字> · <种类> · N 条`），放在右栏内容最上面。

### 4.2 左栏：类型列表 `.desk-types`
外层 `.panel`，`padding:8px`。内部每个类型一个 `<button class="desk-type">`（整行可点，`min-height:56px`，`width:100%`，左对齐，`border:1px solid transparent; border-radius:9px; padding:10px 12px; display:grid; gap:2px; background:transparent`）：

```
报销额度                 ← 14px 600，单行省略号
账本 · 12 条 · 11/14 17:49   ← 12px muted；最后是 updated_at，用现有 date()
```
- 名字后如果 `visibility_default === "private"`：同一行右侧小 badge `默认私有`（`.badge`，灰）。
- hover：`background:#f7f7ff`。选中：`background:#efefff; border-color:#aaa9ee; color:#4545ae`，`aria-current="true"`。
- 种类文案：`ledger → 账本`，`list → 清单`，`log → 日志`。
- 排序：`updated_at` 倒序。
- 已归档（`status === "archived"`）默认不显示；列表底部有一行文字按钮 `显示已归档（N）`（N=0 时不渲染），点开后已归档类型排在最后，名字 muted，种类行末加 `· 已归档`。按钮文案变成 `收起已归档`。
- 进入时默认选中：hash 指定的 → 否则上次选中的（`sessionStorage["desk-type"]`）→ 否则第一个。

**空状态（本群一个类型都没有）**：两栏都不渲染，整页一个 `.panel` 居中 `.empty`：
> 还没有账本或清单。
> 在群里说「记账 报销额度 我¥360」或「建一个购物清单」，就会出现在这里。

### 4.3 右栏头部 `.desk-head`
`display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:16px`
- 左：`<h2>` 类型名（18px）；下方 `<small>`：`账本 · 建本人 卡特龙 · 建于 11/12 09:30`（种类、`owner_name`、`created_at`）。
- 右：按钮 `下载 CSV`（普通按钮，不是 primary）。按钮下方 12px muted 一行（右对齐，≤650px 左对齐）：
  > 最多 500 行；含你自己的私有记录，不含别人的。

**下载交互**（不要用 `<a href>`，因为要带登录头）：
1. 点击 → 按钮 `disabled`，文案变 `正在导出…`。
2. `const r = await api("/api/records/export?type=" + encodeURIComponent(typeId))`，返回 `{ filename, csv, rows, truncated }`。
3. `new Blob([r.csv], { type: "text/csv;charset=utf-8" })` → `URL.createObjectURL` → 临时 `<a download=filename>` 点击 → `revokeObjectURL`。csv 已带 BOM，前端不要再加。
4. 成功 toast：`truncated ? "已下载前 " + rows + " 行（超过上限，可在群里让 bot 按时间段导出）" : "已下载 " + rows + " 行"`。
5. 失败 toast：`导出失败：<错误信息>`。按钮恢复。
6. `rows === 0` 时按钮照常可点，toast `这个账本还没有记录，下载的是空表`。

### 4.4 按人汇总 `.desk-summary`（只在 `kind === "ledger"` 且 `summary.groups.length > 0` 时显示）
外层 `.panel`，标题行 `<h3>按人汇总</h3>`（15px 600）+ 右侧 12px muted `共 N 笔`。
每人一行 `.desk-sum-row`：`display:grid; grid-template-columns: minmax(80px,160px) minmax(0,1fr) 64px 110px; gap:14px; align-items:center; min-height:36px; border-bottom:1px solid var(--line)`

| 列 | 内容 | 样式 |
|---|---|---|
| 人名 | `key`（空 → `未写人名`） | 13px，单行省略 |
| 条 | 横条：宽度 = `|sum_cents| / max(|sum_cents|)`，最小 2px | 高 6px、圆角 3px、轨道 `#eef0f6`；正数 `var(--accent)`，负数 `var(--red)` |
| 笔数 | `N 笔` | 12px muted，右对齐，tabular |
| 金额 | `formatCents(sum_cents)` | 14px 600，右对齐，tabular；负数红色 |

最后一行合计 `.desk-sum-total`：无边框、`padding-top:10px`，人名列写 `合计`（600），条列空，笔数 `N 笔`，金额 `formatCents(total_cents)`（16px 700）。
合计下方 12px muted 说明（按条件逐条显示，多条用 `；` 连起来，都没有就不渲染）：
- `mine_private > 0`：`含你的私有记录 N 条（只有你看得到）`
- `hiddenPrivate > 0`：`另有 N 条别人的私有记录，不显示、不计入`

排序：金额绝对值倒序。≤650px：列改为 `1fr 96px`，横条和笔数移到第二行（`grid-column:1/-1`，笔数并入人名后 `· N 笔`）。

金额格式（全页统一，写成一个函数）：
```js
function formatCents(c) {
  const v = Math.abs(Number(c || 0)) / 100;
  return (c < 0 ? "−" : "") + "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
```
负号用 `−`（U+2212），不用连字符。表格里优先用后端给的 `amount` 字符串；需要正负颜色时看 `amount_cents < 0`。

### 4.5 筛选条 `.desk-filters`
`display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:18px 0 12px`
- `<select aria-label="按人筛选">`：`全部人` + 汇总里出现过的人名（list/log 用已加载行里的 person 去重）。宽 `max-width:200px`。
- `<input type="search" placeholder="搜事项或人名" aria-label="搜索记录">`：`flex:1; min-width:160px`。输入停 300ms 后请求。
- 只在 `mine_private > 0` 时显示 chip 按钮 `只看我的私有 · N`（样式复制 `.review-chip`，`aria-pressed`）。
- 清单（`list`）额外一组 chip：`全部` / `待办 · N` / `已完成 · N`（单选，`aria-pressed`），默认 `全部`。
- 筛选全部走后端：`/api/records?type=&person=&text=&status=&private=1&cursor=`，换筛选时清空旧行重拉。

### 4.6 记录表 `.desk-records`
用现有 `.table-wrap` + `.table`，自己写表头（不要用现有 `table()` 助手，它不支持单元格样式）。行数大时外层不限高，靠「加载更多」。

**列（按种类）**：

| kind | 列（从左到右） |
|---|---|
| ledger | 时间 · 人名 · 事项 · 金额 · 创建人 · 编号 |
| list | 状态 · 事项 · 负责人 · 创建人 · 创建时间 · 编号 |
| log | 时间 · 事项 · 数值 · 创建人 · 编号 |

- **时间**：`date(occurred_at ?? created_at)`（浏览器本地时区，即悉尼；账本不做双时区）。宽 96px，tabular，12px muted。
- **人名 / 负责人**：`person`，空显示 `—`（muted）。
- **事项**：`title`，空显示 `—`。允许换行，`overflow-wrap:anywhere`。
- **金额**：`amount`，右对齐（表头也右对齐，类 `num`），tabular，600；`amount_cents < 0` 红色。
- **数值（log）**：后端给的 `amount` 原样，右对齐 tabular，不加 ¥。
- **状态（list）**：`todo → 待办`（`.badge`），`done → 完成`（`.badge.ok`）；其他值原样灰 badge。完成行的事项文字用 muted，不加删除线。
- **创建人**：`creator_name`，12px。
- **编号**：`short`（如 `#a1b2c3`），`font-family: ui-monospace,"SF Mono",Menlo,monospace; font-size:12px; color:var(--muted)`。
- **扩展字段**（schema 里模板以外的字段，后端放在 `extra: {label: value}`）：前 3 个各占一列，插在「事项」后面，表头用 label；第 4 个起合并成一列 `其他`，内容 `label：value；label：value`。值为空显示 `—`。

**私有行**（`visibility === "private"`，此时一定是本人的）：
- 整行 `background:#fafaff`。
- 事项单元格最前面一个 badge `仅我可见`（`.badge.desk-private`：`background:#efefff; color:#4545ae`），与文字间距 6px。

**别人的私有行**：不出现，不占位。数量只在汇总说明（4.4）和表格下方提示里出现：表格最后一行之后 12px muted：`另有 N 条别人的私有记录未显示`（`hiddenPrivate > 0` 时）。

**排序**：后端给什么顺序就什么顺序（ledger/log：时间倒序；list：待办在前，再按创建时间倒序）——前端不重排。

**分页**：后端返回 `next` 时，表格下方居中按钮 `加载更多`（普通按钮，`min-height:44px`，点击中文案 `正在加载…`）；没有 `next` 不显示。

**无记录**：
- 类型本身没有记录：表格不渲染，`.empty`：`这个账本还没有记录。在群里说「记账 <类型名> 我加10」就能记一笔。`（list 换成 `这个清单还是空的。在群里说「<类型名> 加一项 xxx」就能添加。`；log 用 ledger 那句，把「账本」换成「日志」）
- 有记录但筛选后为空：`.empty`：`没有符合条件的记录` + 下方 `清除筛选` 按钮（`.review-mini` 尺寸），点后恢复默认筛选。

**≤650px**：表格变卡片列表，照搬 `.review-gaps` 的手机写法——`thead` 隐藏，`tr` 变块（`padding:12px 0; border-bottom:1px solid var(--line)`），每个 `td` 变 `grid-template-columns:72px 1fr`，`td::before { content: attr(data-label) }` 显示列名。所以每个 `td` 必须写 `data-label="列名"`。金额在手机上左对齐。

## 5. 技能页（`skills`）

### 5.1 顶部
一行 `.desk-strip`（复制 `.review-strip`）：badge `启用中 N`（ok）、`待确认 N`（warn，N=0 不显示）、`已停用 N`（灰，N=0 不显示）；行尾 12px muted `本群最多 20 个`。

### 5.2 表格 `.panel` > `.table-wrap` > `.table.desk-skills`

| 列 | 宽 | 内容 |
|---|---|---|
| 名字 | 140px | `「日结」`（14px 600，用全角括号包起来）；下方 12px muted `owner_name` |
| 触发词 | 180px | 每个触发词一个 `.pill`（现有类），间距 4px，可换行；没有 → `—` muted |
| 步骤 | 自适应 | 第一行：步骤摘要（见 5.3），13px，步骤之间用 ` → `（前后空格，`→` 为 muted 色）；第二行：`note` 12px muted，最多 2 行省略（`-webkit-line-clamp:2`），`title` 属性放全文；点击说明文字切换展开（类 `.is-open` 取消截断），`cursor:pointer` |
| 使用 | 96px，右对齐 | `N 次`（tabular）；下方 12px muted `上次 11/14 09:00`；从未用过 → 只显示 `0 次`，下方 `还没用过` |
| 状态 | 88px | `active → 启用中`（ok）、`proposed → 待确认`（warn）、`disabled → 已停用`（灰） |

- 已停用行：名字和步骤文字 muted。
- 排序：启用中 → 待确认 → 已停用；同组内按使用次数倒序，再按名字。
- 空状态（`.empty` 放在 `.panel` 里）：
  > 还没有技能。
  > 在群里说「以后我说『日结』你就出账本和余额」，bot 会把这套步骤存下来，以后说一声就跑。
- ≤650px：同 4.6 的手机卡片写法，`data-label` 分别为 名字/触发词/步骤/使用/状态。

### 5.3 步骤摘要文案（技能页和日程页共用，写成 `stepLabel(step)`）

| action | 文案 | 例 |
|---|---|---|
| `records_summary` | `<type>汇总` + （`group_by` 有值时 `·按人`）+ （`period` 不是 all/缺省时 `（今天/昨天/本月/上月）`） | `报销额度汇总·按人（本月）` |
| `records_query` | `查<type>` + （有 `filter.person` 时 `·<person>`）+ （有 `limit` 时 `·前N条`） | `查购物清单·前10条` |
| `quota` | `API 余额` | |
| `token_usage` | `period === "yesterday"` ? `昨日 token 用量` : `今日 token 用量` | |
| `chat_digest` | `days === 7` ? `近 7 天聊天总结` : `昨日聊天总结`；有 `topic` 追加 `·<topic>` | `昨日聊天总结·论文` |
| `work_status` | `工作进展` | |
| `text` | `固定文字「<前 16 字>…」`（不足 16 字不加省略号） | |
| 其他 | `未知步骤 <action>`，红色（`var(--red)`） | |

period 映射：`today 今天`、`yesterday 昨天`、`this_month 本月`、`last_month 上月`。

## 6. 日程页（`schedules`）

### 6.1 顶部
`.desk-strip`：badge `运行中 N`（ok）、`已暂停 N`（warn，N=0 不显示）、行尾 12px muted `本群 N / 10 个`（N = 运行中 + 已暂停）。
下方 chip `显示已结束（N）`（`.review-chip`，`aria-pressed`，N=0 不渲染），默认关：只列 `active` 与 `paused`。

### 6.2 表格 `.panel` > `.table-wrap` > `.table.desk-schedules`

| 列 | 宽 | 内容 |
|---|---|---|
| 标题 | 自适应（最小 200px） | 第一行 14px 600：标题（见 6.3）；第二行 12px muted：`<种类> · <owner_name>`；`agent_task` 第三行 12px muted：步骤摘要（5.3，` → ` 连接） |
| 节奏 | 160px | 见 6.4，13px |
| 下次 | 170px | 见 6.5 双时区，两行 |
| 最近一次 | 150px | 见 6.6 |
| 失败次数 | 72px，右对齐 | `fail_count`，tabular；0 → muted；1–8 → `#996120` 600；≥9 → `var(--red)` 600 |
| 状态 | 80px | `active → 运行中`（ok）、`paused → 已暂停`（warn）、`done → 已完成`（灰）、`cancelled → 已取消`（灰） |

**暂停行高亮**（`status === "paused"`）：
- 整行 `background:#fffaf2`；第一个单元格 `box-shadow: inset 3px 0 0 #996120`（左侧 3px 竖条，不用 border 以免表格错位）。
- 「下次」列显示 `—` + 第二行 12px `#996120`：`已暂停，不会发送`。
- 若 `last_error` 有值，标题列最后加一行 12px 红字，单行省略，`title` 放全文：`暂停原因：<last_error>`。
- 表格下方 12px muted 说明（有暂停行时才显示）：
  > 连续失败满 9 次会自动暂停。在群里对 bot 说「恢复<标题>」即可重新启用。

**排序**：已暂停 → 运行中（按 `next_run_at` 升序）→ 已结束（按 `created_at` 倒序）。

**空状态**（没有任何运行中/已暂停的日程；已结束的照样藏在 chip 后面）：
> 还没有日程。
> 在群里说「每天北京时间 0 点发 DeepSeek 余额」或「明天下午 3 点提醒我交报告」，就会出现在这里。

### 6.3 标题
`spec.title` 有值用它；否则按种类：

| kind | 种类文案 | 默认标题 |
|---|---|---|
| `agent_task` | 定时动作 | 步骤摘要的第一步 + （多于 1 步时）`等 N 项` |
| `reminder` | 提醒 | `提醒：<spec.text 前 20 字>` |
| `digest_daily` | 日报 | `每日聊天总结` |
| `digest_weekly` | 周报 | `每周聊天总结` |
| `mute` | 静音 | `安静 <spec.minutes> 分钟` |

### 6.4 节奏（`cadenceText(spec, tz)`）
tz 简称：`Asia/Shanghai → 北京`、`Australia/Sydney → 悉尼`、`UTC → UTC`、其他 → 原 tz 字符串。
`cadence` 缺省时：`digest_daily/reminder(有 time 无 run_at)` 视为 `daily`，`digest_weekly` 视为 `weekly`，有 `run_at` 视为 `once`，`mute` 视为 `once`。

| cadence | 文案 | 例 |
|---|---|---|
| daily | `每天 HH:MM（<tz简称>）` | `每天 00:00（北京）` |
| weekly | `每周<日>` + ` HH:MM（tz）`；`[1,2,3,4,5]` → `工作日`，`[0,6]` → `周末`，否则 `一、三、五`（0=日，1=一 … 6=六，按 1→6→0 顺序列） | `每周一、三 09:00（悉尼）` |
| monthly | `每月<日>` + ` HH:MM（tz）`；数字 `1日、15日`，`-1` → `月末` | `每月1日 09:00（悉尼）` |
| every | `每 N 分钟`（N≥60 且整除 60 → `每 N 小时`）；有 `window` 加 `，HH:MM–HH:MM`；有 `until` 加 `，到 M月D日` | `每 30 分钟，09:00–18:00` |
| once | `一次性` | |

### 6.5 下次时间：双时区（`nextText(ms, tz)`）
- `next_run_at` 为空或状态非 active → 显示 `—`（muted）；暂停见 6.2。
- 主时区 = 日程自己的 `tz`；副时区：主是北京 → 悉尼；主是悉尼 → 北京；主是 UTC 或其他 → 悉尼。
- 第一行（13px 600 tabular）：`11月15日 周日 00:00 北京`——用 `Intl.DateTimeFormat("zh-CN", { timeZone: tz, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })` 的各部分拼成 `M月D日 周X HH:MM`，再接空格 + tz 简称。
- 第二行（12px muted tabular）：`悉尼 03:00 · 9 小时后`。副时区的日期与主时区不同时插入日期：`悉尼 11月14日 21:00 · 3 小时后`。
- 相对时间：`<1 分钟 → 马上`；`<60 分钟 → N 分钟后`；`<24 小时 → N 小时后`（向下取整）；否则 `N 天后`。已过期（`ms < now`）→ `等待发送`（`#996120`）。
- 每分钟不用自动刷新；切回本页或点刷新时重算。

### 6.6 最近一次（后端字段 `last_run: { status, at, error } | null`）

| status | 第一行 | 第二行（12px muted） |
|---|---|---|
| `sent` | badge ok `已发送` | `date(at)` |
| `failed` | badge bad `失败` | `date(at)`；有 `error` 时第三行 12px 红字单行省略，`title` 放全文 |
| `pending` / `running` | badge `发送中` | `date(at)` |
| `null` 或 `none` | 12px muted `还没发过` | — |

### 6.7 ≤650px
同 4.6 的手机卡片写法；`data-label` 为 标题/节奏/下次/最近一次/失败次数/状态。暂停卡片：`tr` 背景 `#fffaf2`，左竖条改到 `tr` 上（`box-shadow: inset 3px 0 0 #996120; padding-left:12px`）。

## 7. 任务列表里的「收件箱」（RC-04）

新增一个函数，所有显示 repo 的地方都换成它：
```js
const repoLabel = (r) => (r === "inbox" ? "收件箱" : short(r));
```
| 位置（当前代码） | 改成 |
|---|---|
| `renderTasks` 卡片 `el("small", short(t.repo))`（约 app.js:409） | `el("small", repoLabel(t.repo))` |
| `taskDetail` 顶部 `el("small", t.repo + " · v" + t.version)`（约 :470） | `el("small", repoLabel(t.repo) + " · v" + t.version)`；若 `t.repo === "inbox"`，紧跟一行 `.note`：`群里直接交办、还没指定项目的任务。` |
| `taskDetail`「复制给本机 AI」里 `"\n仓库：" + t.repo` | inbox 时写 `"\n仓库：未指定（收件箱任务，先确认要改哪个项目）"` |
| `#repo` 筛选下拉 | 若 `state.tasks` 里有 `repo === "inbox"`，在选项最后追加 `<option value="inbox">收件箱</option>`（只加一次） |
| `matches()` | 不改：选「全部项目」时 inbox 任务正常显示；选「收件箱」时只显示 inbox |
| `newTask` 的项目下拉、项目动态页、统计「项目」数 | **不加** inbox |

卡片其他部分（状态 badge、按钮）与普通任务完全一样，不加额外颜色。

## 8. 前端依赖的 API 形状（后端在 D8 里按此返回；与 design §5 冲突以 §5 为准并告知设计师）

所有接口走现有 `api()`（Bearer / 本机会话头），只读 GET。

```ts
GET /api/records/types
→ { types: { id, name, kind: "ledger"|"list"|"log", visibility_default, status: "active"|"archived",
             owner_name, count /* 本人可见条数 */, created_at: ms, updated_at: ms }[] }

GET /api/records?type=<id>&person=&text=&status=&private=1&cursor=
→ { type: <同上一项>, schema: NormalizedSchema,
    rows: { id, short, person?, title?, amount?, amount_cents?, status?, occurred_at: ms|null, created_at: ms,
            creator_name, visibility: "group"|"private", extra?: Record<label,string> }[],
    next?: string, hiddenPrivate: number, mine_private: number,
    summary?: { groups: {key, sum_cents, count}[], total_cents, count },   // 仅 ledger，第一页带；随筛选变化
    status_counts?: { todo: number, done: number } }                     // 仅 list

GET /api/records/export?type=<id>   → { filename, csv, rows, truncated }

GET /api/skills
→ { skills: { id, name, triggers: string[], steps: Step[], note, owner_name,
              status: "proposed"|"active"|"disabled", uses, last_used_at: ms|null }[] }

GET /api/schedules
→ { schedules: { id, kind, tz, spec: ScheduleSpec, status, next_run_at: ms|null, fail_count, last_error,
                 owner_name, created_at: ms,
                 last_run: { status: "sent"|"failed"|"pending"|"running", at: ms, error?: string } | null }[],
    limit: 10 }
```

- 私有行由后端按登录者过滤；前端只认 `visibility === "private"` 就当作「本人的」显示，不自己判断身份。
- 金额 `amount` 是后端格式化好的字符串（`¥370.00`）；前端只在汇总里用 `formatCents`。

## 9. 可访问性

- 分段控件、类型列表、chip 都是 `<button>`，有可见焦点（沿用全局 `outline-offset:3px`）。
- 点击区域：类型行 ≥56px，`加载更多` ≥44px，chip ≥32px 且间距 ≥6px（与复盘面板一致）。
- 颜色不单独承载信息：私有有文字 badge、暂停有 badge + 文字、负数有 `−` 号。
- 表格用真实 `<table>`/`<th scope="col">`；手机卡片靠 `data-label` 补列名。
- 横条 `.desk-bar` 加 `aria-hidden="true"`（金额文字已表达）。

## 10. 新增 CSS（全部，照抄到 style.css 末尾）

```css
/* D8 · 账本与自动化 */
.desk-seg { display: inline-flex; gap: 4px; padding: 4px; background: #eef0f6; border-radius: 10px; margin-bottom: 18px; max-width: 100%; overflow-x: auto; }
.desk-seg button { border: 0; background: transparent; min-height: 34px; padding: 6px 14px; border-radius: 7px; color: #58627a; white-space: nowrap; }
.desk-seg button:hover { background: #ffffff99; }
.desk-seg button[aria-selected="true"] { background: #fff; color: #20283b; font-weight: 600; box-shadow: 0 1px 2px #20283b14; }
.desk-count { margin-left: 6px; font-size: 12px; color: #58627a; font-variant-numeric: tabular-nums; }
.desk-count .is-warn { color: #996120; }
.desk-state { display: grid; gap: 12px; justify-items: center; text-align: center; padding: 28px 10px; color: var(--muted); font-size: 13px; }
.desk-state.is-error { color: var(--red); }
.desk-error { color: var(--red); font-size: 13px; line-height: 1.6; margin-bottom: 12px; }
.desk-split { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 18px; align-items: start; }
.desk-types { padding: 8px; display: grid; gap: 2px; }
.desk-type { width: 100%; min-height: 56px; display: grid; gap: 2px; text-align: left; border: 1px solid transparent; border-radius: 9px; padding: 10px 12px; background: transparent; }
.desk-type:hover { background: #f7f7ff; border-color: transparent; }
.desk-type[aria-current="true"] { background: #efefff; border-color: #aaa9ee; color: #4545ae; }
.desk-type b { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; gap: 6px; align-items: center; justify-content: space-between; }
.desk-type small { font-size: 12px; }
.desk-type.is-archived b { color: var(--muted); }
.desk-more { border: 0; background: transparent; color: var(--accent); font-size: 12px; min-height: 36px; text-align: left; padding: 6px 12px; }
.desk-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.desk-head-side { display: grid; gap: 6px; justify-items: end; }
.desk-head-side small { font-size: 12px; text-align: right; }
.desk-summary h3 { font-size: 15px; font-weight: 600; }
.desk-summary-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.desk-sum-row { display: grid; grid-template-columns: minmax(80px, 160px) minmax(0, 1fr) 64px 110px; gap: 14px; align-items: center; min-height: 36px; border-bottom: 1px solid var(--line); font-size: 13px; }
.desk-sum-row > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desk-sum-total { border-bottom: 0; padding-top: 10px; font-weight: 600; }
.desk-sum-total .desk-amt { font-size: 16px; font-weight: 700; }
.desk-bar { height: 6px; border-radius: 3px; background: #eef0f6; overflow: hidden; }
.desk-bar > span { display: block; height: 100%; min-width: 2px; background: var(--accent); border-radius: inherit; }
.desk-bar.is-neg > span { background: var(--red); }
.desk-n { font-size: 12px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.desk-amt { font-size: 14px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.desk-neg { color: var(--red); }
.desk-note { font-size: 12px; color: var(--muted); line-height: 1.7; margin-top: 8px; }
.desk-filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 18px 0 12px; }
.desk-filters select { max-width: 200px; }
.desk-filters input { flex: 1; min-width: 160px; }
.desk-chip { min-height: 32px; padding: 5px 12px; border-radius: 20px; font-size: 12px; font-variant-numeric: tabular-nums; }
.desk-chip[aria-pressed="true"] { background: #efefff; color: #4545ae; border-color: #aaa9ee; }
.desk-records td, .desk-skills td, .desk-schedules td { overflow-wrap: anywhere; }
.table th.num, .table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.desk-time { white-space: nowrap; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.desk-id { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); white-space: nowrap; }
.desk-records tr.is-private td { background: #fafaff; }
.badge.desk-private { background: #efefff; color: #4545ae; margin-right: 6px; }
.desk-done { color: var(--muted); }
.desk-loadmore { display: flex; justify-content: center; margin-top: 14px; }
.desk-loadmore button { min-height: 44px; min-width: 140px; }
.desk-strip { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 14px; }
.desk-strip .badge { font-variant-numeric: tabular-nums; }
.desk-strip small { margin-left: auto; font-size: 12px; }
.desk-sub { display: block; font-size: 12px; color: var(--muted); line-height: 1.6; margin-top: 2px; }
.desk-sub.is-bad { color: var(--red); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
.desk-sub.is-warn { color: #996120; }
.desk-arrow { color: var(--muted); }
.desk-clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
.desk-clamp.is-open { display: block; }
.desk-schedules tr.is-paused td { background: #fffaf2; }
.desk-schedules tr.is-paused td:first-child { box-shadow: inset 3px 0 0 #996120; }
.desk-fail-warn { color: #996120; font-weight: 600; }
.desk-fail-bad { color: var(--red); font-weight: 600; }
.desk-sum-n-inline { display: none; }
#desk-type-select { display: none; }
@media (max-width: 1100px) {
  .desk-split { grid-template-columns: 220px minmax(0, 1fr); }
}
@media (max-width: 650px) {
  .desk-seg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: visible; width: 100%; }
  .desk-seg button { padding: 6px 4px; font-size: 13px; }
  .desk-count { margin-left: 3px; font-size: 11px; }
  .desk-split { grid-template-columns: 1fr; }
  .desk-types-col { display: none; }
  #desk-type-select { display: block; width: 100%; margin-bottom: 14px; }
  .desk-sum-n-inline { display: inline; font-size: 12px; color: var(--muted); font-weight: 400; }
  .desk-head-side { justify-items: start; }
  .desk-head-side small { text-align: left; }
  .desk-sum-row { grid-template-columns: 1fr 96px; gap: 6px 12px; padding: 8px 0; }
  .desk-sum-row .desk-bar { grid-column: 1 / -1; grid-row: 2; }
  .desk-sum-row .desk-n { display: none; }
  .desk-filters select { max-width: 100%; flex: 1; }
  .desk-strip small { margin-left: 0; width: 100%; }
  .desk-records thead, .desk-skills thead, .desk-schedules thead { display: none; }
  .desk-records, .desk-records tbody, .desk-records tr,
  .desk-skills, .desk-skills tbody, .desk-skills tr,
  .desk-schedules, .desk-schedules tbody, .desk-schedules tr { display: block; }
  .desk-records tr, .desk-skills tr, .desk-schedules tr { padding: 12px 0; border-bottom: 1px solid var(--line); }
  .desk-records td, .desk-skills td, .desk-schedules td { display: grid; grid-template-columns: 72px 1fr; gap: 12px; padding: 4px 0; border: 0; text-align: left; }
  .desk-records td.num, .desk-skills td.num, .desk-schedules td.num { text-align: left; }
  .desk-records td::before, .desk-skills td::before, .desk-schedules td::before { content: attr(data-label); color: var(--muted); font-size: 12px; }
  .desk-records tr.is-private { background: #fafaff; padding-left: 8px; }
  .desk-records tr.is-private td { background: transparent; }
  .desk-schedules tr.is-paused { background: #fffaf2; box-shadow: inset 3px 0 0 #996120; padding-left: 12px; }
  .desk-schedules tr.is-paused td, .desk-schedules tr.is-paused td:first-child { background: transparent; box-shadow: none; }
  .desk-sub.is-bad { max-width: 100%; }
}
```

结构约定：左栏外层 `<div class="desk-types-col">` 包住 `.desk-types` 面板（手机隐藏）；`#desk-type-select` 放在右栏最上面（桌面隐藏）。汇总行人名 `<span>` 内写成 `名字<small class="desk-sum-n-inline"> · N 笔</small>`（只在手机显示）。

## 11. 文案总表（照抄，不要改写）

| 位置 | 文案 |
|---|---|
| 顶部标签 | 账本与自动化 |
| 分段 | 账本/清单 · 技能 · 日程 |
| 加载 | 正在读取… |
| 读取失败 | 读取失败：<信息> ／ 刷新失败：<信息>（显示的是 HH:MM 的数据） ／ 重试 |
| 登录页提示 | 登录后会直接打开群里发来的那一页。 |
| 找不到类型 | 没找到这个账本，可能已归档或被删除 |
| 账本空 | 还没有账本或清单。／在群里说「记账 报销额度 我¥360」或「建一个购物清单」，就会出现在这里。 |
| 归档开关 | 显示已归档（N） ／ 收起已归档 |
| 默认私有 | 默认私有 |
| 下载 | 下载 CSV ／ 正在导出… ／ 最多 500 行；含你自己的私有记录，不含别人的。 |
| 下载结果 | 已下载 N 行 ／ 已下载前 N 行（超过上限，可在群里让 bot 按时间段导出） ／ 这个账本还没有记录，下载的是空表 ／ 导出失败：<信息> |
| 汇总 | 按人汇总 ／ 共 N 笔 ／ 合计 ／ 未写人名 ／ 含你的私有记录 N 条（只有你看得到） ／ 另有 N 条别人的私有记录，不显示、不计入 |
| 筛选 | 全部人 ／ 搜事项或人名 ／ 只看我的私有 · N ／ 全部 ／ 待办 · N ／ 已完成 · N |
| 表头 ledger | 时间 · 人名 · 事项 · 金额 · 创建人 · 编号 |
| 表头 list | 状态 · 事项 · 负责人 · 创建人 · 创建时间 · 编号 |
| 表头 log | 时间 · 事项 · 数值 · 创建人 · 编号 |
| 私有 | 仅我可见 ／ 另有 N 条别人的私有记录未显示 |
| 清单状态 | 待办 ／ 完成 |
| 无记录 | 这个账本还没有记录。在群里说「记账 <类型名> 我加10」就能记一笔。 ／ 这个清单还是空的。在群里说「<类型名> 加一项 xxx」就能添加。 |
| 筛选空 | 没有符合条件的记录 ／ 清除筛选 |
| 分页 | 加载更多 ／ 正在加载… |
| 技能顶部 | 启用中 N ／ 待确认 N ／ 已停用 N ／ 本群最多 20 个 |
| 技能表头 | 名字 · 触发词 · 步骤 · 使用 · 状态 |
| 技能使用 | N 次 ／ 上次 MM/DD HH:MM ／ 还没用过 |
| 技能状态 | 启用中 ／ 待确认 ／ 已停用 |
| 技能空 | 还没有技能。／在群里说「以后我说『日结』你就出账本和余额」，bot 会把这套步骤存下来，以后说一声就跑。 |
| 日程顶部 | 运行中 N ／ 已暂停 N ／ 本群 N / 10 个 ／ 显示已结束（N） |
| 日程表头 | 标题 · 节奏 · 下次 · 最近一次 · 失败次数 · 状态 |
| 日程状态 | 运行中 ／ 已暂停 ／ 已完成 ／ 已取消 |
| 暂停 | 已暂停，不会发送 ／ 暂停原因：<last_error> ／ 连续失败满 9 次会自动暂停。在群里对 bot 说「恢复<标题>」即可重新启用。 |
| 最近一次 | 已发送 ／ 失败 ／ 发送中 ／ 还没发过 |
| 相对时间 | 马上 ／ N 分钟后 ／ N 小时后 ／ N 天后 ／ 等待发送 |
| 日程空 | 还没有日程。／在群里说「每天北京时间 0 点发 DeepSeek 余额」或「明天下午 3 点提醒我交报告」，就会出现在这里。 |
| 收件箱 | 收件箱 ／ 群里直接交办、还没指定项目的任务。 ／ 仓库：未指定（收件箱任务，先确认要改哪个项目） |

## 12. 给施工队的提醒（最容易做错的 5 处）

1. **下载 CSV 不能用 `<a href="/api/...">`**：没有登录头会 401。必须 `api()` 拿 JSON → Blob → 临时 `<a download>`。也不要再往 csv 前面加 BOM。
2. **私有行只看 `visibility`**，前端不判断「是不是本人」；别人的私有行后端根本不返回，前端只显示 `hiddenPrivate` 计数。不要做「模糊显示/打码」行。
3. **双时区用 `Intl.DateTimeFormat` + `timeZone`**，不要手算偏移（悉尼有夏令时）。主时区是日程自己的 tz，不是浏览器时区。
4. **暂停高亮用 `inset box-shadow`**，不要给 `td` 加 `border-left`（会让整列错位）；手机卡片时竖条挪到 `tr`。
5. **收件箱只改显示**：`repoLabel()` 替换 3 处显示 + 下拉加一项；不要把 inbox 塞进新建任务下拉、项目动态或「项目」统计。

## 13. 验收截图（给视觉验收员）

1440×900 与 390×844 各一套：
1. 账本页：报销额度（≥4 人、含 1 条负数、含 1 条本人私有、他人私有 ≥1 → 两条说明都出现）。
2. 清单页：购物清单（待办 + 完成混合，「待办」chip 选中态）。
3. 账本空状态（无任何类型）。
4. 技能页：≥2 个技能（1 启用 1 停用，1 个带多行说明）。
5. 日程页：≥3 条（1 条北京时间 daily、1 条悉尼 monthly、1 条 paused 带 last_error）。
6. 任务看板：一张 repo=inbox 卡片显示「收件箱」；详情弹窗顶部。
7. 直达链接 `#desk/ledger/<id>`：未登录 → 登录页提示句；登录后直接停在该账本。
8. 下载 CSV 后的 toast。
