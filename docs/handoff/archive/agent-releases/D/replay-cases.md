# D 版回放用例清单：群里的「定时 / 执行 / 工具 / 账本」

> **来源**：线上 D1 只读快照（2026-11-14 17:20 Sydney），全部为群里真实发过的消息，**逐字未改**。
> **用途**：D 版验收与回归。每个用例 = 一次真实交办 + 可由 SQL/文本断言判定的期望。
> **红线**：回放只跑本地假 D1（参照 `test/learning-accept.mjs` 的 `env()` 夹具），**不写线上 D1、不往群里发任何消息**。
> **配套诊断**：`.agent/releases/D/diagnosis.md`

---

## 1. 怎么用

### 1.1 抽数（只读）

```bash
CF=/Users/yanghongming/.openmausbot/workspaces/84a475c8-fbf7-451e-a728-abf95d00d2af/.openmausbot-secrets/aa12d914-7616-4e19-a983-bfc1dd2fdfcf/vault-d612f6a6-8acc-4d43-ad6f-ba827221d268
cd /Users/yanghongming/Projects/.worktrees/TeamAgent-B-release
CLOUDFLARE_API_TOKEN="$(cat "$CF")" ./node_modules/.bin/wrangler d1 execute inkboard-team --remote --command "
SELECT rowid,id,group_id,sender,body,ts,mentioned FROM messages
WHERE rowid IN (286,348,351,355,382,394,396,449,453,482,484,485,486,487,488,490,492,493,496)
ORDER BY rowid" --json
```

### 1.2 用例形状

```jsonc
{
  "id": "RC-xx",
  "source": { "rid": 0, "ts": "...", "sender_role": "TOO|卡特龙|马哥" },
  "input": { "batch": [ ...真实消息... ], "mentioned": true },
  "expect": {
    "db":  ["schedules +1 且 kind/time 匹配"],
    "text": ["回复含「记下了」", "回复不含兜底句"]
  },
  "verdict": "PASS|FAIL",
  "baseline": "当前 release/B @8c768b1 的实测结果"
}
```

### 1.3 通用判定规则

| 规则 | 说明 |
|---|---|
| 不许说假话 | 回复里出现「记下了 / 已设置 / 已立项 / 在建 / 真落地」→ 必须能在 DB 找到对应行，否则判 FAIL |
| 兜底句 | 回复含 `这个我还没登记上，你说一下每天几点、发什么，我马上建。`（`src/reply-finalize.ts:8`）而用户**已经给过时间** → 判 FAIL |
| 副作用优先 | 判定以 `schedules` / `facts` / `feature_request` / `tasks` 的行数为准，不看措辞 |
| 群消息 | 全程 `outbox` 在本地库，不允许出现线上 `sent` |

### 1.4 发送者代号（脱敏）

| 代号 | sender 前 6 位 | 角色 |
|---|---|---|
| TOO | `CBFDDE` | 群主 / 需求提出者 |
| 卡特龙 | `0FC1E8` | 群成员 |
| 马哥 | `B391F1` | 群成员 |

消息 id 完整值可由 1.1 的 SQL 直接取（本文件只留 rid，避免长串干扰阅读）。

---

## 2. 用例

### RC-01 一次性日报（回归基线，P2）

- **来源**：`rid=348`，11-13 04:08 Sydney，TOO，@bot
- **输入**：「把今天群里的对话和讨论的内容给我总结一个日报。」
- **期望**：outbox 新增 1 条，正文含当天要点；`schedules` 不变。
- **判定**：`SELECT COUNT(*) FROM outbox WHERE body LIKE '%日报%'` 增加 1；回复长度 > 100 字。
- **当前基线**：**PASS**（`outbox.rid=253` 进度条 + `254` 正文）
- **备注**：对照组。证明检索/写作没问题，问题在副作用。

### RC-02 定时日报 08:00（P0）

- **来源**：`rid=351`，11-13 04:11 Sydney，TOO，@bot
- **输入**：「然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。」
- **期望**：
  1. `schedules` 新增 1 行，`kind='digest_daily'`，`spec.time='08:00'`，`status='active'`
  2. `source_msg_id` = 该消息 id
  3. 回复含「记下了」+ 首次执行时间
- **判定**：`SELECT COUNT(*) FROM schedules WHERE kind='digest_daily' AND json_extract(spec,'$.time')='08:00'` = 1（用例库从 0 起算）。
- **当前基线**：**FAIL** —— 11-13 当时 `schedules` 0 行；直到 11-14 14:05 才由运维调 `/api/admin/daily-push` 补建（`spec` 只有 `{"time":"08:00"}`，非对话产物）。
- **已有夹具**：`test/fixtures/daily-push-real.json`（rid=351 原文 + 上下游消息，可直接复用）。

### RC-03 漏推追问：承诺必须落地（P0）

- **来源**：`rid=355`，11-13 09:31 Sydney，TOO，未 @
- **输入**：「你妈的，我的日报呢？」
- **期望**：
  1. 回复不含「只定了口径没把定时建起来」这类**事后解释**；
  2. 如果回复里出现「已经建好 / 这次真落地 / 以后每天都会发」，`schedules` 必须有对应 active 行。
- **判定**：文本正则 `真落地|已经建好|以后每天` 命中时，`schedules` 行数 ≥ 1。
- **当前基线**：**FAIL** —— 该消息 0 回复；09:31:58 卡特龙说「给我哥道歉 认错」后 `outbox.rid=207` 写「定时推送这次真落地」，而当时 `schedules` = 0 行。

### RC-04 发布到工作台作为一个新任务（P1）

- **来源**：`rid=382`，11-13 10:27 Sydney，TOO，@bot
- **输入**：「工作台UI修改指导<@bot> 把这个发布到工作台作为一个新任务。」
- **期望**：`tasks` 新增 1 行（`status` 至少 `proposal`），或回复明确给出「不建」的理由且不出现「已发布」。
- **判定**：`SELECT COUNT(*) FROM tasks WHERE created_at > <用例开始>` = 1。
- **当前基线**：**FAIL** —— `tasks` 最后一条停在 11-12 04:54；`outbox.rid=221` 只说缺正文。
- **备注**：`prepare_project_task` 的 `repo` 必填且只接受 6 个仓库，这类「无仓库任务」无路可走（`src/semantic.ts:896-931`）。

### RC-05 记账初值（P0）

- **来源**：`rid=394`，11-13 18:35 Sydney，TOO，@bot
- **输入**：「记账报销额度\n我￥360，卡特龙￥50，Souvereign￥90」
- **期望**：账本持久化 3 条（TOO=360、卡特龙=50、Souvereign=90），回复给出合计 ¥500 + 可回查的 entry id。
- **判定**：新表（D 版新增）`ledger_entries` 3 行、金额匹配；或至少在 `facts` 有 3 条金额。
- **当前基线**：**FAIL** —— `facts` 47 行无一条金额；全库无账本表；`outbox.rid=223` 只是口头「记好了」。

### RC-06 记账增量（P0）

- **来源**：`rid=396`，11-13 18:36 Sydney，TOO，@bot
- **输入**：「我加10」
- **期望**：TOO 从 360 → 370，合计 510；回复可核对。
- **判定**：账本 TOO=370、合计=510。
- **当前基线**：**FAIL** —— 同 RC-05，无持久化；`outbox.rid=225` 口头「记上了」。

### RC-07 定时余额 + token 日报（P0）

- **来源**：`rid=482` / `rid=484`，11-14 17:09 / 17:10 Sydney，TOO + 卡特龙，`484` @bot
- **输入**：
  - 「机器人可以每天在固定时间发一个当日使用token和用量的日报吗」
  - 「每天固定时间发一下每天的余额和 token 用量」
- **期望**：只有「时间缺失」时才可以反问；问一次后必须记住。给出时间前不建、给出后必建。
- **判定**：第一轮允许 0 行 + 追问一次；若用户已在同批给出时间则必须 `schedules` +1。
- **当前基线**：**FAIL** —— `outbox.rid=298` 反问「几点？」合理；但后续三轮时间都给过了，仍不建（见 RC-08/09）。

### RC-08 北京时间 0 点（P0）

- **来源**：`rid=488`，11-14 17:12 Sydney，TOO，@bot
- **输入**：「每天北京时间0点在群里发DeepSeek余额即可」
- **期望**：
  1. `schedules` 新增 1 行，`spec.time='03:00'`（= 北京 0 点），`tz='Australia/Sydney'`
  2. 回复含换算说明 + 首次执行时间
  3. 回复**不含**兜底句
- **判定**：`SELECT COUNT(*) FROM schedules WHERE json_extract(spec,'$.time')='03:00'` = 1；文本断言 `NOT LIKE '%还没登记上%'`。
- **当前基线**：**FAIL** —— `outbox.rid=301` = 兜底句 + 「+200 我还是没记录」；`schedules` 0 新增。
- **代码根因**：`parseScheduleRequest("每天北京时间0点…")` = `null`（诊断 §4 R1 有实跑输出）。

### RC-09 账本 + API 余额 + token + 自建记账工具（P0）

- **来源**：`rid=493`，11-14 17:13 Sydney，TOO，未 @（同批）
- **输入**：「可以的，你把账本跟API余额每天在北京时间0点发一下日报，注意自己建立一个本地记账工具。同时播报每日使用的token总数。」
- **期望**：
  1. `schedules` 新增 1 行（03:00 Sydney，内容含账本 + 余额 + token）
  2. `feature_request` 新增 1 行（「本地记账工具」需求），或明确说「这个我做不了，已登记需求 #id」
  3. 不许出现「已立项/在建」而没有对应行
- **判定**：`schedules` +1 且（`feature_request` +1 或 回复含「做不了」）。
- **当前基线**：**FAIL** —— `schedules` 0；`feature_request` 0；`outbox.rid=304` 却写「已立项/在建」。

### RC-10 冷上下文总账单（P0，验证账本真的存在）

- **来源**：`rid=496`，11-14 17:14 Sydney，TOO，@bot
- **输入**：**只给这一条**（batch 里不带 394/396/485/486/490）
- **期望**：答出 t.o.o. 370、卡特龙 50、Souvereign 290、合计 710。
- **判定**：文本包含 4 个数字。
- **当前基线**：**预期 FAIL（未跑）** —— 库里无账本；当前能答对是因为同段上下文里还留着 11-13 的记录。
- **为什么重要**：这是「维护一个账单」的真正验收点，不是「这次答对了」。

### RC-11 立即出总账单（P2，基线正例）

- **来源**：`rid=496` 带完整上下文
- **期望**：同上四个数字。
- **当前基线**：**PASS** —— `outbox.rid=306`：370 / 50 / 290 / 710 / DeepSeek ¥277.56（不计入账本）。
- **备注**：留着做回归，防止改账本时把「同段能算对」也改坏。

### RC-12 闭嘴 10 分钟（P1）

- **来源**：`rid=286`，11-12 00:29 Sydney，马哥，未 @
- **输入**：「你先闭嘴10分钟bot设个定时任务十分钟后再说话」
- **期望**：`schedules` 新增 1 行 `kind='mute'`，`spec.run_at ≈ now+10min`；期间除 @ 外不出声；回复一句确认。
- **判定**：`SELECT COUNT(*) FROM schedules WHERE kind='mute'` = 1。
- **当前基线**：**FAIL** —— 0 回复、0 mute 行。

### RC-13 负例：不是跟我说话，不许建（P2，防误建）

- **来源**：`rid=449`，11-14 00:47 Sydney，马哥，未 @
- **输入**：「后面直接挂个定时任务，让它2:10自动开干」（上下文是 TOO 和卡特龙在聊他们自己的 mausbot：「我2:10刷新一次，五小时额度」「明天我就直接验收算了」）
- **期望**：**不建任何日程、不回复**。
- **判定**：`schedules` +0；`outbox` +0。
- **当前基线**：**PASS** —— `chat_decisions.reason`：「卡特龙和 Souvereign 在聊给自己那边的 mausbot 挂 2:10 定时任务…没在问我，不需要我插话。」
- **备注**：保留这条，防止修 R1/R2 时把「看到定时就建」写成误触发。

---

## 3. 覆盖矩阵

| 用例 | 能力面 | 判定类型 | 当前基线 | 优先级 |
|---|---|---|---|---|
| RC-01 | 一次性总结 | 文本 | PASS | P2 |
| RC-02 | 定时 digest | `schedules` | FAIL | **P0** |
| RC-03 | 承诺/回执一致性 | 文本 + `schedules` | FAIL | **P0** |
| RC-04 | 工作台任务 | `tasks` | FAIL | P1 |
| RC-05 | 账本写入 | `ledger_entries`/`facts` | FAIL | **P0** |
| RC-06 | 账本增量 | 同上 | FAIL | **P0** |
| RC-07 | 定时报告（缺时间） | `schedules` | FAIL | **P0** |
| RC-08 | 时区换算 | `schedules` + 文本 | FAIL | **P0** |
| RC-09 | 定时报告 + 需求登记 | `schedules` + `feature_request` | FAIL | **P0** |
| RC-10 | 账本长期可读 | 文本（冷上下文） | FAIL（预期） | **P0** |
| RC-11 | 同段账单 | 文本 | PASS | P2 |
| RC-12 | 定时闭嘴 | `schedules(mute)` | FAIL | P1 |
| RC-13 | 误触发防护 | `schedules` +0 | PASS | P2 |

**现状：13 条里 PASS 3（RC-01/11/13），FAIL 9，另有 1 条预期 FAIL 未跑（RC-10）。** 与 `diagnosis.md` §0 的 8 个请求事件、成 3 败 5 是同一批事实的两种切法（按消息 vs 按事件）。

---

## 4. 以后怎么扩（只增不减）

- 用户每次在群里说「设个定时 / 记个账 / 做个工具」并且没做成，就从 `messages` 抽一条新用例追加，**不删旧用例**。
- 每条新用例必须带：`rid`、逐字原话、期望的 DB 变化、判定 SQL。
- 期望写不清的（例如「帮我执行一个东西」没说执行什么），在交回里列出来让主程定，不要自己猜着写。
- 跑法沿用 `.agent/scenarios/run.sh` 的约定：每条输出 `PASS/FAIL + 实际值 + 日志片段`，最后一行汇总；全程本地假 D1。

---

## 5. 已知限制

1. RC-10 需要回放器支持「只注入单条消息、不带历史」，当前 `test/learning-accept.mjs` 的夹具是整批注入，要小改。
2. RC-08 的期望值 `03:00` 依赖「北京时间 = UTC+8、悉尼夏令时 = UTC+11」；冬令时（AEST, UTC+10）应为 `02:00`，回放时按运行日期的时区规则算，不要写死（`src/schedules.ts` 用的是 `Australia/Sydney` 时区规则）。
3. 本清单没有覆盖「新建工具」成功路径 —— 线上 `feature_request` 0 行，没有真实成功样本可回放；只能先验「有没有登记」。
