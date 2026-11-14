# TeamAgent QQ bot 「重发旧消息」事故报告

- 报告时间：2026-11-14 01:58 Sydney（2026-11-13 14:58Z）
- 事故时线上版本：Worker `2a00b9db-fb45-46a1-8ded-7db55f0bd5d4`，release `c612431e21e81c1dc8851afde40eb252bbf5bf7e`（F6，PR #39，2026-11-14 01:44:20 Sydney 部署）
- 当前线上版本（01:53:01 Sydney 起）：Worker `22f3370b-49d3-4459-aa35-eadfd32f1e69`，release `b0557fd8af564199ad11921d9d62999d2d6a3998`（PR #40，并行 fast-lane 修复，**不涉及** `src/mention-guard.ts`，不改变本次重发行为）
- 事故窗口：2026-11-14 01:45:02 – 01:48:24 Sydney（14:45:02 – 14:48:24Z）
- 结论：**已定位、已停止；未回滚，未改数据。** 触发源是 F6 新增的 `sweepMentions()` 首次运行，把 4 条历史 @ 消息当成「漏回」补发，产生 4 条「在做：…」回执 + 4 条完整回复，共 8 条。每条只发 1 次（HTTP 200），不是重试风暴，也不是定时任务或游标回退。

## 1. 用户看到的是什么

用户在 01:50 反馈「QQ bot 抽风了，发了一堆之前的消息」。实际是 01:45–01:48 的 8 条出站消息，逐条对应 4 条 1–3 天前的群消息：

| # | 发送时间（Sydney） | outbox id（前缀） | 内容（截断） | 对应的历史消息 | 该消息原始时间（+08） |
|---|---|---|---|---|---|
| 1 | 01:45:02 | `mention-receipt:…OyB7…` | 在做：这是面试软件的 logo | rowid 131 | 2026-11-11 18:06:11 |
| 2 | 01:45:23 | `mention-recovery:…OyB7…:1` | 哦，那是我上条看走眼了：这是 NextThought 的 logo… | rowid 131 | 2026-11-11 18:06:11 |
| 3 | 01:46:02 | `mention-receipt:…uMj7…` | 在做：你别管这个logo，我让你去搜MAUS bot… | rowid 132 | 2026-11-11 18:06:19 |
| 4 | 01:46:21 | `mention-recovery:…uMj7…:1` | 搜了，query 就是 MausBot，8 条上限… | rowid 132 | 2026-11-11 18:06:19 |
| 5 | 01:47:02 | `mention-receipt:…t1tA…` | 在做：这条消息 | rowid 153（空正文） | 2026-11-11 18:47:07 |
| 6 | 01:47:26 | `mention-recovery:…t1tA…:1` | 日报得有材料。今天群聊里我这边只看得到刚才这几条… | rowid 153 | 2026-11-11 18:47:07 |
| 7 | 01:48:02 | `mention-receipt:…uMj7…` | 在做：把今天群里的对话和讨论的内容给我总结一个日报。 | rowid 348 | 2026-11-13 01:08:38 |
| 8 | 01:48:24 | `mention-recovery:…uMj7…:1` | 今日日报（精简版）：1) 仓库核对：登记表上共 5 个… | rowid 348 | 2026-11-13 01:08:38 |

同一窗口内还有对**当前**新消息的正常回复（01:45:58 回复 rowid 456「？」、01:47 回复日报请求等），所以群里看起来像「新旧混在一起刷屏」。

## 2. 触发源与根因

### 2.1 直接触发

- 14:44:20Z 部署 F6（版本 `2a00b9db…`，上一版 `c515af4f…`）。`src/mention-guard.ts` 是 F6 提交 `c612431` **首次引入**的文件。
- 14:45:02Z 是部署后第一个 cron tick，`scheduled()` 开头调用 `sweepMentions()`（`src/worker.ts:1160`），第一次扫描历史消息。
- 此后每个 tick（约 60 秒）补发一条，直到 14:48:24Z 第 4 条补完。时间间隔与 cron 每分钟一次完全吻合。

### 2.2 代码根因（部署版 `c612431`，`src/mention-guard.ts`）

```ts
// L60-70（部署版行号）
export async function sweepMentions(e: any, now = Date.now()): Promise<void> {
  const rows = await e.DB.prepare(`WITH candidates AS (...
    WHERE ${addressed} AND m.ts<=? AND ${noOutbox} AND ${noTerminal}
      ...
    ) SELECT * FROM candidates WHERE ts<=? OR active ORDER BY ts LIMIT 1`)
    .bind(new Date(now-45000).toISOString(), now-90000, new Date(now-90000).toISOString())
```

1. **只设了下界，没有上界。** 条件只有 `m.ts <= now-45s`（以及 `now - ts >= 90s`），即「只要够旧就行」，没有「只补最近 N 分钟」或「只补本次部署之后」的水位。首次部署时把 2026-11-11 的历史消息全部算作候选。
2. **历史消息没有 terminal 记录。** 判重依赖 `noOutbox` / `noTerminal`：查 `outbox.msg_id`、`chat_decisions.latest_id/batch_ids`。rowid 131/132/153（11-11）是合批回复，outbox 的 `msg_id` 指向批次尾部，这三条自己既没有 outbox 行、也没有可匹配的 decision；rowid 348（11-13 01:08）的回复合批记在了下一条 349 上，而 349 的 `batch_ids` 只有 349 自己，348 漏记。于是 4 条都被判成「从未回复」。
3. **候选按 `ORDER BY ts LIMIT 1` 每 tick 一条。** 所以表现为每分钟稳定补一条，而不是一次性爆发；4 条正好 4 分钟。
4. **时间比较还有隐藏缺陷。** `messages.ts` 存的是带 `+08:00` 的 ISO 字符串（如 `2026-11-13T22:50:34+08:00`），而绑定参数是 `toISOString()` 的 UTC `Z` 字符串。SQLite 字符串比较按字典序，不按真实时刻；`22:50+08` 会被判成晚于 `14:50Z`。这次事故里它反而「帮」着排除了当天下午之后的消息，但它不是正确的时间窗口判断，修的时候必须一起改。

### 2.3 已排除的嫌疑

| 嫌疑 | 核查结果 |
|---|---|
| F6-6 定时提醒/日推批量触发 | `schedules` 0 行、`schedule_runs` 0 行；窗口内无 schedule 类 outbox |
| F6-8 文件交付重试 | `deliveries` 0 行、`delivery_retries` 0 行 |
| F4 游标回退 | 群游标 `chat_cursor:<group>` = 457，等于当时最大 rowid 457；全局 `chat_cursor`=450 是旧版遗留键，F4 后按群分键，未被新代码读取 |
| outbox 重试风暴 | 8 条各自 `status=sent`、`http_status=200`、`outbox_attempts` 各 1 次；同一内容没有重复发送 |
| 迁移 0009/0010/0011 把旧 outbox 重新置 pending | 窗口前 outbox `pending=0`；8 条都是新插入的 `mention-*` 行，不是旧行复活 |

## 3. 是否仍在持续

**没有。** 判定依据：

- 最后一条旧消息补发：`2026-11-13 14:48:24Z`（`mention-recovery:…:1`，HTTP 200）。
- 之后 `outbox` 只有新消息的正常回复：
  - 14:50:50Z 回复 rowid 457「看看ds的最新文章…」；
  - 14:51:02Z research lane 回复同一条；
  - 14:52:23Z 回复 rowid 458「有没有可能使用官方api…」。
- 用部署版同一套判重条件重算，剩余可补发的历史候选 = **0**；不带时间窗的全量判重也是 **0**（即现有历史消息不会再被补发）。
- 14:53:27Z（= 01:53:27 Sydney）复核：最后一条 mention 发送为 14:48:24Z，已过 **303 秒**，期间 `mention-receipt` / `mention-recovery` 新增行 = 0。
- 14:53:01Z 并行线程部署了 PR #40（`b0557fd`，与本次事故无关，未改 `mention-guard.ts`）。14:54:03Z 再次复核：最后一条 mention 仍是 14:48:24Z，已过 **344 秒**；新版本部署后 mention 新增行 = 0，全量候选仍为 0。
- 14:57:43Z 最终复核：最后一条 mention 仍是 14:48:24Z，已过 **561 秒（9 分 21 秒）**；`mention-*` 新增行 = 0，`jobs`/`outbox` pending = 0，全量候选 = 0。done_when 的「最近 5 分钟不再新增旧消息」已满足，且跨过一次部署仍成立。

## 4. 止血动作与结果

- **未回滚。** 没有持续重发，回滚会丢掉 F6 且无收益；事故版本 `c612431` / `2a00b9db…` 保持到 01:53:01 的正常 fast-lane 发布，当前线上为 `b0557fd` / `22f3370b…`（PR #40，不含 `mention-guard.ts` 改动）。
- **未改数据、未改配置。** 没有删除/取消任何 outbox 行，没有动 messages、settings 或游标。
- 8 条已发出的消息无法撤回（QQ 侧也不支持），但每条只发一次，后续不会再补。
- 服务状态：`com.inkboard.team-qq/-runner/-owner/-utility/-utility-quick/-fetch` 均 running；01:51:49 Sydney 时 `/health.release=c612431`，01:53:01 起 `/health.release=b0557fd`（正常 fast-lane 发布）；`qq_gateway.connected=true`（01:51:49 Sydney）；`runner_seen` 心跳正常（01:52:00 Sydney）。`team-media` 未运行（`media worker unavailable`），与本次重发无关，另行处理。

## 5. 需要补的修复（给主程，按 P1 处理）

详细补丁、测试和上线核对清单见：`/Users/yanghongming/Projects/.agent/incidents/2026-11-14-resend/fix-package.md`。摘要：

文件：`src/mention-guard.ts`（部署版行号）

1. **加上界 + 部署水位（根因修复）**
   - `sweepMentions` 只允许「最近 15 分钟内」且「不早于本次进程/版本首次运行水位」的消息进入候选。
   - 建议新增 setting `mention_recovery_since`：每次 Worker 版本切换后的第一个 tick 写入 `now`（不存在才写），候选条件加 `julianday(m.ts) >= julianday(?)`。
   - 这样首次上线新扫描器时历史积压不会补发；真正的「刚漏回」仍能在 15 分钟内补上。
2. **修正时间比较（必须一起改）**
   - L66/L69/L70 的 `m.ts<=?`、`ts<=?` 改成 `julianday(m.ts) <= julianday(?)`，或统一把 `messages.ts` 存成 epoch ms。不要再用 `+08:00` 字符串和 `Z` 字符串做字典序比较。
3. **发送前的旧任务拒发（防再发第二道闸）**
   - `sendOutbox` 发送前按 outbox id 前缀（`mention-receipt:` / `mention-recovery:`）识别 mention 行（不能只看 `outbox_meta.kind`，因为 recovery 回复走的是普通 chat outbox）；对应 `messages.ts` 超过 15 分钟就不调 QQ 接口，把该行置 `skipped`（沿用现有 sticker 旧库存的处理方式，见 `src/worker.ts:1018-1027`），并保留 body 备份。
   - 非 mention 类旧任务（例如重试的媒体/文件）也建议按「超过 N 分钟不自动补发」处理，落 `needs_attention` 而不是直接发。
4. **在线开关（下次不必回滚）**
   - `sweepMentions` 开头读 `off:mention_recovery`，为 `1` 时直接 return；运维可一条 settings 写入即时暂停。
5. **补测试（红→绿）**
   - 历史消息（2 天前）`mentioned=1` 且无 outbox/decision：跑 `sweepMentions` 后断言 `jobs` / `outbox` 均无新增。
   - 2 分钟前漏回：断言生成 1 条 recovery，且只生成 1 次。
   - 带 `+08:00` 的 `ts` 与 UTC now 混用：断言年龄判断正确（这是本次隐藏缺陷的回归测试）。
   - `off:mention_recovery=1`：断言 no-op。
   - 集成回放：灌 4 条历史 addressed 消息 + 当前新消息，跑 5 个 tick，断言只回复当前消息。
6. **数据侧建议（可选）**
   - 为 `messages` 增加 `replied_at` 或在 recovery 成功后写 `processed=1`，让「是否回过」不再依赖 outbox/decision 的间接推断。
   - 若担心未来还有漏网的历史行，可在修复上线前先执行一次只读盘点：`addressed AND noOutbox AND noTerminal`，当前已为 0。

## 6. 防再发检查清单

- [ ] 修复包合入后，先在本机 D1 副本回放 4 条历史消息 + 1 条当前消息，确认只发当前回复。
- [ ] 部署前写入 `mention_recovery_since`（或确认新版本首个 tick 自动写）。
- [ ] 部署后 10 分钟内只读核对：`outbox` 无 `mention-recovery` 指向 >15 分钟前的消息。
- [ ] 把 `off:mention_recovery` 写进运维手册的「一键暂停」清单。
- [ ] 下次大版本上线前，凡新增「扫描历史表」的功能，必须自带水位/上界和时间比较测试。

## 7. 证据

- `/health`：01:51Z 事故版本 `release=c612431e21e81c1dc8851afde40eb252bbf5bf7e`；01:53Z 起当前版本 `release=b0557fd8af564199ad11921d9d62999d2d6a3998`。
- 部署记录：`wrangler deployments list` 显示 14:44:20Z 部署 `2a00b9db-fb45-46a1-8ded-7db55f0bd5d4`（事故版本），上一版 `c515af4f-74d6-4078-a049-a223a6a6e810`（14:22:21Z）；14:53:01Z 并行线程部署 `22f3370b-49d3-4459-aa35-eadfd32f1e69`（PR #40 `b0557fd`，diff 仅 `authz.ts`/`worker.ts` + 测试，不含 `mention-guard.ts`）。
- `outbox`：8 条 mention 行，时间 14:45:02–14:48:24Z，全部 `sent`，`outbox_attempts` 各 1 次、HTTP 200。
- `activity`：4 条 `mention.recovered`，created_at 14:45:02.401Z / 14:46:02.526Z / 14:47:02.646Z / 14:48:02.787Z。
- `messages`：rowid 131/132/153 原始时间 2026-11-11 18:06–18:47+08；rowid 348 原始时间 2026-11-13 01:08:38+08；均为 `mentioned=1`。
- `schedules` / `schedule_runs` / `deliveries` / `delivery_retries`：0 行。
- 本机 `qq.log`：`2026-11-13T14:45:22.079Z QQ gateway resumed`（部署后本机服务重启）。
- 只读原始快照与查询输出：`/Users/yanghongming/Projects/.agent/incidents/2026-11-14-resend/`（见同目录 evidence.md）。

## 8. 未验证 / 局限

- 没有在群里发任何测试消息；「新消息仍能正常回复」是用 01:50–01:52 的真实新消息（rowid 457/458）及其 HTTP 200 回复证明的，不是主动注入的测试。
- 8 条已发出的旧回复无法撤回；如果用户要求，只能在群里补一句说明（需要用户自己发或授权代发）。
- 未做 Worker 回滚演练；本次不需要回滚。
- 01:53:01 Sydney 有一个并行 fast-lane 线程把 PR #40（`b0557fd`）部署上线；它不涉及 `mention-guard.ts`，但确实改变了线上版本号。事故报告的「事故版本」仍按 `c612431` / `2a00b9db…` 记录，「当前版本」按 `b0557fd` / `22f3370b…` 记录。
- `team-media` 服务未运行是独立问题，本次未处理。
