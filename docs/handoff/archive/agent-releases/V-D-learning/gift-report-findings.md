# 「礼物日早报 / 每天 8 点日推」线上取证与根因

- 调查时间：2026-11-14 14:00 Sydney
- 线上库：D1 `inkboard-team`（database_id `42e95fb2-16f8-46d9-bf32-34f3e88a4443`），只读 SELECT/PRAGMA；**未写线上 D1、未发群、未部署**。
- 当前 Worker：`/health` release `41db2b52ebddd4eb1f46871e9d260ef504da8dc3`（V-D），构建 2026-11-14 10:19 Sydney。
- 唯一群：`9968A083EE07797A987010E64CD421B9`；`messages` 466 条（2026-11-11 15:41 → 2026-11-13 23:13 +08），`outbox` 267 条。`messages` 的 `max(rowid)=466` = `chat_cursor:9968…=466` = 行数 466，历史没有未处理的缺口。

## 0. 结论

1. **D1 里没有「礼物日」「早报」「晨报」「礼」的任何原话。** 76 张业务表全扫，`礼物`/`早报` 命中 0；`messages`/`outbox`/`facts`/`dreams` 里连 `礼` 字都是 0，`晨报` 在 `messages`/`outbox`/`message_meta` 也是 0。群里也没有语音转写缺口（39 条短消息是短句/表情、图片、视频、文件、引用）。
2. 唯一对得上的真实要求是 **t.o.o. 2026-11-13 04:11 Sydney**：「然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。」用户记忆里的「晨报」是这条的转述——`messages`/`outbox`/`message_meta` 里「晨报」字面命中 0。
3. 这条**没有创建定时任务**：`schedules` 0 行、`schedule_runs` 0 行、`behavior_rules` 0 行、`promises` 0 行；不是「创建了没触发」。
4. 根因是**请求发生时线上还没有日程工具**（F6 到 2026-11-14 01:42 Sydney 才合并、01:44 才部署，比请求晚约 21.5 小时），而 bot 没有说明「当前版本还没有定时工具」，改为口头承诺；F6 上线后这条 8:00 要求只留在 `self_note` 的叙述里，没有任何机制把「过去的承诺」变成 `schedule_create`。
5. 同类要求里，**口头禅禁用「草」明确没生效**：facts 里有记录，但排序第 38/47，早已滑出「最新 12 条」注入窗口；禁用后 outbox 仍 18 次出现「草」。称谓「马哥」基本生效；「话多/回复时机」有注入但行为未稳定收敛。

## 1. 原话证据

### 1.1 成员原话（messages，逐字）

| 悉尼时间 | 记录时间(+08) | 谁 | 原话 |
|---|---|---|---|
| 11-13 04:08 | 11-13 01:08:38 | t.o.o. | 把今天群里的对话和讨论的内容给我总结一个日报。 |
| 11-13 04:11 | 11-13 01:11:20 | t.o.o. | 按周吧，每个星期日是一周的开始`<@Bot>` |
| **11-13 04:11** | **11-13 01:11:39** | **t.o.o.** | **然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。`<@Bot>`** |
| 11-13 04:12 | 11-13 01:12:04 | t.o.o. | 这周开始 |
| 11-13 09:31 | 11-13 06:31:32 | t.o.o. | 你妈的，我的日报呢？ |
| 11-14 01:36 | 11-13 22:36:35 | t.o.o. | 给我总结一下今日沟通日报。 |

消息 ID：

- 04:11:39（8 点日推）`ROBOT1.0_uMj7bSoGmOazRMZniW.yT2V5hU3d-j6xzhbCQeAQ6Z.OwSP3g49XjNFz-7MfTy-y7SwXrIDy1.sk-8ujK3u2doyiDiEnBsDjRwFKyBrETjzvJYw94Gf2XvduFhFPmyNe`
- 04:11:20（周日起）`ROBOT1.0_uMj7bSoGmOazRMZniW.yTy.ZpCTQJKtt41LsedQH.sfUY4d9fcJNRpIgddfT7TeHxn7fhf5NgxUP7td6AFw3iIm4OUZVVKsvr3O3aHhAaSINIqrVm3QhC6-bhktADRFg`
- 04:08:38（日报）`ROBOT1.0_uMj7bSoGmOazRMZniW.yTzmV4jDkkWYxwGHZ.Ld-z-rFpM0meAmTjpA.5S-hxix9YEe5EwVkjoHzdOxxWbTILRWHuhCmI3jVYWHzLcp87XUNIqrVm3QhC6-bhktADRFg`
- 04:12:04（这周开始）`ROBOT1.0_uMj7bSoGmOazRMZniW.yTwIu23yQ3zgrdPsSx9K9mlITi0X4hQg9P4.kl71U68AShAjX2vpBLSe-Y0qBuipHH-fc9CcD.q-wjum3kSu84kM!`
- 09:31:32（我的日报呢）`ROBOT1.0_uMj7bSoGmOazRMZniW.yT4V7lFNmHhrdCa8hRANWFrzv3bjyMzh8wdkBozXBqchRK4rkTNb2-iGSJOQkaQMsYOfc9CcD.q-wjum3kSu84kM!`

### 1.2 bot 当时怎么回（outbox，逐字）

| 悉尼时间 | 回复 |
|---|---|
| 11-13 04:11 | 收到，口径按周一到周六？不对，是周日到周六算一周，每周日出上一周汇总……第一份这周日就出，还是从下周开始？ |
| 11-13 04:12 | 收到，不跟你掰扯那句。口径定这样：悉尼每天 8:00（北京 5:00）推昨日总结，3–5 条要点；周报按周日起算，这周日先出第一份，**明早 8:00 出第一份日推**。 |
| 11-13 04:12 | 收到：周报这周日先出第一份、覆盖本周；**明早悉尼 8:00 的日推照常**；存档文件等你点头再做。 |
| 11-13 09:32 | 我的问题，昨晚只定了口径，**定时任务没真落地**，今早才没推。……**每天 8:00 推送我会做成真正的定时安排**，不再只是口头口径。 |
| 11-13 09:32 | 哥，我的锅，昨晚只定了口径没把定时建起来，今早漏推，刚补了总结。**定时推送这次真落地**，不再只嘴上说。 |
| 11-14 01:37 | 今日沟通日报……另外确认一下：这份日报和每天早 8 点推送用同一套模板吗？ |

对应 outbox id：04:11 的周口径回复 `chat-ROBOT1.0_uMj7bSoGmOazRMZniW.yTy.ZpCTQJKtt41LsedQH.sfUY4d9fcJNRpIgddfT7TeHxn7fhf5NgxUP7td6AFw3iIm4OUZVVKsvr3O3aHhAaSINIqrVm3QhC6-bhktADRFg`；04:12 的 8:00 承诺 `chat-drain-350`；09:32 承认没落地 `chat-drain-357`；09:32 补发 `chat-ROBOT…yT4V7lFN…`；11-14 01:37 日报 `chat-ROBOT…yTygAzF-…`。

### 1.3 「礼物日早报」查无此原话

- 全部 76 张业务表按 TEXT 列扫描：`礼物` 0、`早报` 0。
- `messages` / `outbox` / `facts` / `dreams` / `behavior_rules` / `promises` / `memory_blocks`：`礼` 字 0。
- 39 条 `length(trim(body))<3` 的消息逐条看过：短句/表情（？/艹/OK）、图片、视频、文件、引用，没有语音转写占位。
- 按用户补充线索再扩搜 `晨报`/`晨`/`悉尼`/`8点`/`八点`/`每天`：`messages` 只命中 3 条——04:11:39 的日推要求、11-13 15:39「它会在凌晨的时候复盘和做梦」、11-13 21:46「今天凌晨4点把额度跑光」；没有另一条「晨报」。`message_meta`/`outbox_meta` 里这些词也是 0。
- 结论：用户补充线索与 t.o.o. 这条高度吻合（TOO=t.o.o.；每天悉尼 8 点；昨日聊天总结），「礼物日/晨报」应是对这条的转述；本群 D1 没有另一条字面原话。若用户坚持「礼物日早报」是另一个固定栏目，需要给出另一个群/时间才能查那边的记录。

## 2. 有没有被记成规则 / 定时任务

| 载体 | 当前线上值 | 说明 |
|---|---|---|
| `schedules` | **0 行** | 从未创建过任何日推/周报/提醒/静默 |
| `schedule_runs` | **0 行** | 没有执行记录，故不是「创建了没触发」 |
| `behavior_rules` | **0 行** | V-D 的规则表还是空的（review 从未跑过） |
| `promises` | **0 行** | bot 的「明早 8:00」承诺没有被写成 promise |
| `facts` | 3 条相关 | 「群聊日报/需求」「群聊总结的统计周期/周起始日」「群聊总结安排/生效时间」，**没有 8:00、推送、精简任何一条** |
| `self_note` | 有 | 原文：「……之后每天悉尼时间早上8点推送昨日总结，并且要精简；周周期以周日为起点，从本周开始。」只是人格叙述，不是可执行任务 |
| `team_reflection` | 有 | 原文：「这次才明确要定时出日报和昨日推送。以后我会把周期、时区、是否精简拆开记……」只是复盘文字 |
| `review_runs` 及 10 张 `review_*` 表 | **全部 0 行** | 复盘 Worker 从未跑过；`REVIEW_MODE=shadow`，窗口 04:00–07:30，首次可能运行是 11-15 04:00 |
| `turn_tools` | 12 行，0 条 `schedule_create` | 工具审计只覆盖 11-14 01:50–02:13 Sydney（F6 上线后），这段没有建日程调用 |
| `memory_blocks` | 1 行 | 只有「bot 的群内称呼/被要求改为」，与日推无关 |

关键事实：`facts` 里连「每天」「8点」「推送」「精简」这些词都没有；8:00 只存在于 `self_note` 的自然语言里。

## 3. 代码：现在能不能按群成员要求新增「每天 X 点发某某日报」

**能，但只限「昨日群聊总结」这一种内容；不能自定义「某某日报」的正文/主题。**

- `src/semantic.ts:865` 定义 `schedule_create`，`kind` 枚举只有 `digest_daily` / `digest_weekly` / `reminder` / `mute`（`:871`）；`time` 接受悉尼时间 `HH:MM`。
- `src/schedules.ts:189-193`：`digest_daily` 只校验时间，不接受自定义模板；`digestText()`（`:285-335`）固定取「昨天 00:00–今天 00:00」的本群消息，用固定 `DIGEST_PROMPT`（`:32-34`）生成最多 8 行：一句总览 + 3–6 条进展/决定/待办 + 一条最该推进的事。
- `digest_weekly` 取最近 7 天，`weekdays` 指定星期（0=周日）。
- 到期执行：`wrangler.toml` 的 `* * * * *` cron → `src/worker.ts:1241 scheduled()` → `runSchedules()`（`src/schedules.ts:356-438`）；先抢 `schedule_runs`，再写 `outbox`，同一 due 不会重复。**只要有一行 `schedules`，就会发。**
- 另一条入口：owner-only `POST /api/admin/daily-push`（`src/worker.ts:2419-2457`），只建 `digest_daily`，`source_msg_id` 必须是真实消息；支持 `dry_run`。聊天里没有对应命令，只能由模型调 `schedule_create`。
- 还有一条休眠的 `summary_auto:<group>`：每天 09:00（`src/summary.ts:12-13 AUTO_HOUR=9`）自动总结，但本群没有这个 setting；固定 09:00，不能改 8:00，也没有自定义模板。
- 已有回放测试直接覆盖这条真实请求：`test/fixtures/daily-push-real.json` 就是 04:11:39 那条；`test/daily-push.test.mjs` D2/D3 验证「01:11 请求 → 08:00 日推 → 次日再推」，本次实测 **6/6 通过**；`test/schedules.test.mjs` **15/15 通过**。

结论：**「每天 8 点发本群昨日总结」现在可以一条 `createSchedule` 建成；「礼物日早报」如果是另一个固定栏目（需要特定素材/模板），当前 `digest_daily` 做不到，要加模板字段或新 kind。**

### 3.1 8:00 与时区核对（已验证）

- `src/schedules.ts:30` `DEFAULT_TZ = "Australia/Sydney"`；`planSchedule` 未传 `tz` 时用它，`createSchedule` 把 `plan.tz` 写进 `schedules.tz`。
- `parseTime` 只接受 `HH:MM`；`nextRun` 用 `zonedToUtc(..., tz)` 按悉尼墙上时间算，不按 UTC 或 +08。
- 回放测试 `test/daily-push.test.mjs` D2：以 `2026-11-13T04:11:39+11:00` 为 now，`createSchedule(spec.time='08:00')` 的 `next_run_at` 断言为 `2026-11-13T08:00:00+11:00`；08:00 触发一次 outbox，并断言 11-13 08:00 的日推只总结 11-12、不含 11-13 当天。D3 断言次日 08:00 再推；D5 覆盖悉尼夏令时回拨/前拨，每天只推一次。本次 6/6 通过。
- `digestText` 的起止是悉尼当天 00:00（`partsAt` + `zonedToUtc`）；消息 `ts` 是 +08 字符串，SQL `julianday` 按绝对时间比较，不会把 +08 当悉尼本地时间。
- 另一条 `summary_auto` 是硬编码 09:00（`src/summary.ts:12-13 AUTO_HOUR=9`），不是 8:00；本群没有 `summary_auto:<group>` 设置，未启用。
- 结论：**日推机制本身对得上悉尼 08:00；线上没有 `schedules` 行，所以不是「时间算错」，是「根本没建」。**

## 4. 为什么这条没生效（逐项排除）

1. **没识别成定时需求？** 是。04:11 的回复只是在聊天里答应，没有调用任何工具；夜间整理只提炼出「群聊日报/需求」「周日起」「从本周开始」三条 facts，**漏掉了 8:00、推送、精简**。`schedule_create` 的 description 要求「成员明确要求定时推送日报时调用」，但模型把这条当成了普通对话承诺。
2. **没有创建定时的工具？** **请求发生时确实没有。** F6（引入 `schedule_create`、`schedules` 表）的合并提交是 2026-11-14 01:42:55 Sydney（`c612431`，作者时间 +08 22:42:55）；部署记录里 01:44:20 Sydney 有一次发布（与 F6 合并时间吻合）。请求是 2026-11-13 04:11 Sydney，早约 21.5 小时。11-14 01:36 的第二次请求也早于合并 6 分钟、早于该次部署 8 分钟。所以两次都没工具可用。bot 应该直说「现在还没有定时能力」，而不是承诺「这次真落地」。
3. **创建了没触发？** 否。`schedules` 0、`schedule_runs` 0、`turn_tools` 0 条 `schedule_create`（该审计表只有 F6 上线后的 12 行，见 §2）。不是 cron/租约/发送失败。
4. **F6 上线后为什么没补？** 上线后没有新的「建日推」请求；8:00 只留在 `self_note` 的叙述里。没有代码会扫描 `self_note`/旧承诺去补建日程；`promises` 只由复盘判决写入，而复盘从未运行（`review_runs` 0）。
5. **22:36 那次日报请求？** 也早于 F6：合并前 6 分钟、部署前 8 分钟。它只触发了「生成一份日报」，没有触发「建每天任务」。

**一句话：能力缺口撞上请求时点 + 没有把口头承诺变成可执行任务 + 夜间整理漏掉时间字段。不是「建了没触发」。**

## 5. 同类要求清单（谁 / 原话 / 是否记住并生效）

| # | 谁 | 原话（逐字） | 悉尼时间 | 记忆状态 | 是否生效 / 证据 |
|---|---|---|---|---|---|
| 1 | Souvereign | 把你说草的这个口头禅给我改了 | 11-11 21:09 | fact `confirmed`（「bot 的群内口头禅/禁用词」），排序 **38/47**，已滑出最新 12 条注入窗口 | **否**：禁用后 outbox 仍 18 条含「草」，其中 9 条以「草」开头、1 条「work：草」开头；最近到 11-13 22:45 |
| 2 | t.o.o. | 然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。 | 11-13 04:11 | 仅 `self_note` 有；`facts` 无时间字段；`schedules` 0 | **否**：11-13 08:00、11-14 08:00 均无 outbox；11-13 09:31 用户追问「我的日报呢」 |
| 3 | t.o.o. | 按周吧，每个星期日是一周的开始 | 11-13 04:11 | fact `confirmed`（排序 2/47，注入中） | **否**：没有 `digest_weekly` 任务，周报从未出过 |
| 4 | t.o.o. | 这周开始 | 11-13 04:12 | fact `confirmed`（排序 1/47） | **否**：没有可执行的周期任务 |
| 5 | 卡特龙 | 小马是你叫的吗，要叫马哥 | 11-11 23:58 | fact `confirmed`（排序 20/47，已滑出 top12） | **基本是**：纠正后 3 条提到「小马」（20:58、20:59、11-12 13:09），均为规则转述/清单，无直接称呼；日常用「马哥」 |
| 6 | 卡特龙 | 对了对了，你给他汇报的时候要说报告马哥任务完成了 | 11-11 23:55 | fact `confirmed`（排序 22/47） | **未验证**：outbox 仅 2 次提到该句，均为规则讨论；没有一次真实任务汇报按此开头 |
| 7 | 卡特龙 | 第一个话太多 / 第二个他回复时机不对 / 他都无法判断到底我再跟谁说话 | 11-12 00:27 | 3 条 facts `confirmed`（排序 8–10/47，注入中） | **部分**：仍出现连发/左右互搏，11-13 22:45 bot 自认「刷了两条，是我嘴碎」；发言门控默认关 |
| 8 | Souvereign | OK，我把它改改，让他学会如何插话，不要回复每个人的话 | 11-11 20:17 | fact `confirmed`（排序 41/47，未注入） | **未见系统级执行**：F11 发言门控默认关，仍按模型判断回复 |
| 9 | Souvereign | 怎么还不回答 你以后去做耗时任务的时候能不能先回答一下 | 11-11 21:15 | fact `confirmed`（排序 36/47，未注入） | **部分**：有「在做/查了」回执，但非强制 |
| 10 | 卡特龙 | 你可千万别改我的大肥鱼，你马哥正在干活呢 / 别改我issue | 11-12 00:14 | 2 条 facts `confirmed`（排序 13–14/47，刚好在 top12 外） | **未观察到越界**：只读/不改，符合边界 |
| 11 | 卡特龙 | 别写到md里面，你直接写成json文件 | 11-11 21:46 | fact `confirmed`（`agent/rule.json` 路径也记了） | **部分**：仓库用 `config/*.json`；但仓库里没有 `agent/rule.json` |
| 12 | 卡特龙 | 后面直接挂个定时任务，让它2:10自动开干 | 11-14 00:47 | **无 fact、无 schedule**；outbox 2 次提到 2:10，只是转述计划 | **否**：`schedules` 0；没有 2:10 任务 |
| 13 | 卡特龙 | 你自己给自己改名马化腾，以后就叫你马化腾了 | 11-11 19:49 | **未记**（dream 明确当群聊玩笑） | **未生效（有意）** |
| 14 | t.o.o. | 我是你父亲，…是你母亲，…是你儿子。以后请严格按照身份进行称呼 | 11-11 20:10 | **未记**（dream 当越界测试/玩笑） | **未生效（有意）** |

## 6. 与「复盘」的衔接：为什么复盘结果也没有第二天早上说

- V-D 的 review Worker：`wrangler.review.toml` `REVIEW_MODE="shadow"`，cron `*/5 * * * *`；`src/review/worker.ts:31` 窗口 `minute>=240 && minute<450`，即 **04:00–07:30 Sydney**。
- `review_runs` / `review_snapshots` / `review_judgments` / `review_findings` / `capability_gaps` **全部 0 行**：今天 10:20 才部署 V-D，已过当天窗口；首次可能运行是 **11-15 04:00–07:30**。所以「昨晚有复盘结果」目前不存在。
- 更关键：`src/review/*.ts` 只写 `review_*` 表和 Web 看板，**没有写 `outbox`**；主 Worker 里也没有 review 集成（`grep review src/worker.ts` 只有无关的一处）。也就是说，即使 11-15 复盘跑出结果，也不会自动在群里说「复盘结果」——目前只有网页看板。
- `behavior_rules` 的消费端也没接上：`activeRulesFor()` 定义在 `src/review/rules.ts:169`，但全仓库只有测试/验收脚本调用，**聊天路径没有调用**。`src/semantic.ts:690` 的 `context.rules` 只来自 B 站视频资料（`src/worker.ts:640/865`）。所以「复盘学到的规则」就算批准了，也不会进入群聊提示词。
- facts 注入也有限：`src/semantic.ts:693` 取 60 条，`:930` 只把 `facts.slice(0,12)` + 词面召回拼进 prompt；「草」的 fact 排 38/47，日常对话召回不到就永远不进 prompt。这就是「记住了但不说」的机制性原因。

## 7. 建议（给 BINI / 主程，本次未改）

1. **立刻补建**（需写 D1，本次按施工单没做）：`createSchedule({group_id:'9968A083…', owner:'CBFDDE…', kind:'digest_daily', spec:{time:'08:00'}, source_msg_id:'ROBOT1.0_uMj…yT2V5hU3…'})`；或 owner 调 `POST /api/admin/daily-push` 带该 `source_msg_id`。已有 `test/daily-push.test.mjs` 覆盖，建完看 `schedules.next_run_at`、次日 `schedule_runs.status='ok'`、08:00 `outbox`。
2. **P1：把 `activeRulesFor` 接进 `answerWithTools`**，让 `canary/active` 规则每轮进入提示词；或者在 `promptFacts` 里给「禁用词/称呼/日程」类 fact 固定保留位，不只取最新 12 条。
3. **P1：补「承诺 → 日程」的闭环**。至少每天检查 `promises`/`self_note` 里带「每天 HH:MM」的承诺，缺 `schedules` 就补建或提醒；否则 bot 仍会「嘴上答应、第二天忘」。
4. **P1：复盘结果要么自动进群，要么明确产品决定「只看网页」**。现在用户预期的是「第二天早上说复盘结果」，代码没有这条路径。
5. **P2：** 如果「礼物日早报」是需要自定义素材/栏目的日报，给 `schedules.spec` 加 `title/template/topic`，或新增 kind；当前 `digest_daily` 只能发固定模板的昨日群聊总结。

## 8. 复现与验证命令（只读）

- D1：全部为 `SELECT`/`PRAGMA`，经 Cloudflare D1 HTTP API；令牌从 Vault 以文件交付，只在命令环境读取，未打印、未写入本文件。
- 关键查询：`SELECT * FROM schedules`、`SELECT * FROM schedule_runs`、`SELECT * FROM behavior_rules`、`SELECT * FROM promises`、`SELECT * FROM review_runs`、`SELECT ... FROM facts`、`SELECT ... FROM outbox WHERE body LIKE '%草%'`。
- 代码：`git log --format='%h %ci %s' -- src/schedules.ts`；`git show -s --format='%ci' c612431`；`grep -rn activeRulesFor src test scripts`；`sed -n '680,970p' src/semantic.ts`。
- 测试：`node --test test/schedules.test.mjs` → 15/15 pass；`node --test test/daily-push.test.mjs` → 6/6 pass。
- 线上健康：`curl https://inkboard-team.inkboard-server.workers.dev/health` → release `41db2b52…`。

## 9. 结论边界

- 「礼物日早报」在**这个群的 D1** 不存在；不能排除是另一个群/私聊/用户记忆偏差。
- 本次没有写线上 D1、没有发群、没有部署；「补建 8:00 日程」只是建议，未执行。
- V-D 复盘尚未运行，以上关于复盘推送的判断基于代码，不是运行结果。
- 用户本轮还要求「每次新增功能都要在群里说，并补说之前没说的功能」；本次按 BINI 的搜索单只做调查，未发群、未写 `outbox`。功能公告需要另开一个包，由 BINI/主程给文案并确认发送渠道。
