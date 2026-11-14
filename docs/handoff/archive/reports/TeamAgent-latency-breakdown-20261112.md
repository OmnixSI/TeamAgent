# TeamAgent 群内 @ → 回复延迟拆解（最近 24 小时真实记录）

生成：2026-11-12 23:10 Sydney
窗口：2026-11-11 22:55 – 2026-11-12 22:55 Sydney
数据：Cloudflare D1 `inkboard-team`（远程只读，184 条入站消息、15 条 @、5 条链接/卡片）、本机 `~/.inkboard-team/fetch.log`、`wrangler deployments list`。
约束：未改代码、未部署、未往群里发消息、未读取或输出任何 Cookie/密钥值。

## 0. 结论（≤15 行）

- **24h 内 @→首次回复：15 条，中位 19.9s，P90 26.0s，最大 40.6s；@→最终答复中位 20.9s，P90 42.3s，最大 79.3s。没有观察到 50s 或 119s 的 @ 回复。**
- **50s 只有一条真实样本**：00:06:51 的 HuggingFace 链接，50.2s；其中 **research 执行 35.1s**，不是视频 30s 等待。
- **119s 不是实测**，是 no-report 视频路径的合成上界；按现有 P90 组件可到约 120–145s，119 不是硬上界。
- @ 分阶段（中位 / P90）：入库→建 chat 任务 1.5 / 1.8s；队列等待 3.3 / 11.1s（含 1s 防抖）；领到→首次模型 2.6 / 3.1s；模型+收尾 7.6 / 12.1s；outbox→发送 2.6 / 3.0s。
- **最大单段是模型+收尾**（7.6s 中位）；**最大可变段是队列等待**（1.0–19.5s，含 1s 防抖，P90 11.1s），不是抓取或 30s 等待。
- 冷 B 站成功路径（用实测组件拼）：入站 1.5 + 队列 3.3 + 预处理 2.6 + 本机领取 8.9 + 抓取 13.6 + 视频回复队列 3–11 + 模型/语音 8 + 发送 2.6 ≈ **44–52s**；30s due 在成功路径上不参与，A1 有 7.5s 余量。
- 30s 等待不是固定 sleep：`reportFetch` 会 `ready=1` 并立即 `wakeVideoWait`；cron 只兜底。**假设 A 成立**（代码 + 42 项测试通过），线上 24h 无 fetch 回报样本可验证。
- **假设 B 不成立**：A1 的领取 8.9s + 抓取 13.6s = 22.5s < 30s，余量 7.5s；只有本机离线、登录阻塞或抓取 >30s 才会耗满。
- **假设 C**：本机领取 0–10s，A1 实测 8.9s，占冷路径约 20%，且成功路径上是串行相加；24h 内无 fetch 任务样本，无法给真实分布。
- **24h 内视频/fetch 真实样本为 0**：`jobs` 无 `fetch`，`video_waits` 为空；唯一 B 站冷链接在窗口外 1.7h，唯一 B 站卡片走的是 research，不是 fetch。
- B 站卡片：12:24 样本的 `biliCard` 为 null、`bili: []`，发生在旧 release；当前 release `0f67b28` 已有卡片修复，但 22:12 部署后没有新卡片样本，未验证。
- 真实长尾不是视频：19:42 的文本问答在 TOOLS 队列等了 51s，最终 79.3s；16:08 的“总结全部消息”40.6s。
- 缺埋点：`jobs` 无 claimed_at/finished_at；`video_waits` 无 ready_at/woken_at 且终态被删；`chat_decisions` 无 queue_ms/preprocess_ms；`model_runs` 无 turn_id；fetcher 日志无时间戳；Worker 日志未落盘。
- 优化顺序：@ 快车道/队列并发 > 单次模型/跳过参与模型 > 本机唤醒或 2s 轮询 > due 用延迟队列替代 cron > 抓取并行/缓存 > 发送。
- 以上“估算/模型”均单独标注；没有标注的数值来自 D1 或本机日志的直接时间戳。

## 1. 口径与算法

- **T0 入站**：`messages.ts`，QQ 事件自带时间（+08:00 文本，已换算成 Sydney）。
- **T1 建 chat 任务**：`jobs.created_at`，id 为 `chat-<message id>`。
- **T2 本机/云端领到任务**：`jobs.lease_until - 660000ms`（`processJob` 领取时写 `now+660s`）。D1 没有 claimed_at，这是推断值；chat 任务没有 heartbeat，推断可靠。fetch 任务的租约是 120s，但 24h 内没有 fetch 行。
- **T3 首次模型调用**：`model_runs.created_at`（`runtime.ts` 在请求前写 start），按 claim 之后最近的一条 `participation|chat` 匹配。
- **T4 回复写入 outbox**：`outbox.created_at`；`chat_decisions.outbox_id` 优先，缺失时用 `outbox.msg_id = message id`。
- **T5 发出**：`outbox_attempts.started_at`（发送开始时写）；`http_status=200` 表示 QQ 接受。
- **模型+收尾**：T3→T4，包含参与模型、工具调用、嘴替模型、写 outbox；不再拆成“模型时长/收尾时长”，避免多轮模型把账算错。
- **50s/119s 的重建**：用实测组件 + 代码固定值拼装，明确标“模型”，不冒充观测。

## 2. @ → 首次回复：24h 分阶段实测

15 条 @（含 12:24 卡片后的“总结一下”），单位秒。

| 阶段 | n | 中位 | P90 | 最大 | 说明 |
|---|---:|---:|---:|---:|---|
| 入库 → 建 chat 任务 | 15 | 1.5 | 1.8 | 4.7 | 网关/Worker 落库；不含 1s 防抖 |
| 建任务 → 领到（队列） | 15 | 3.3 | 11.1 | 19.5 | 含 1s 防抖 + 队列投递/积压；最大是 12:24 的 @ 任务，领到后未产出 outbox |
| 领到 → 首次模型 | 14 | 2.6 | 3.1 | 6.7 | 上下文/图片预处理；`videoTarget` 本身 <0.1s |
| 模型 + 收尾 → outbox | 14 | 7.6 | 12.1 | 25.2 | 参与模型 + 工具 + 嘴替 |
| outbox → 发送开始 | 15 | 2.6 | 3.0 | 3.5 | 含 QQ token/HTTP |
| **@ → 首次回复** | **15** | **19.9** | **26.0** | **40.6** | T0→T5 |
| @ → 最终答复 | 15 | 20.9 | 42.3 | 79.3 | tool 轮次取 research outbox |

逐条（Sydney）：

| 时间 | 队列 | 预处理 | 首次回复 | 最终答复 | 动作 | 内容 |
|---|---:|---:|---:|---:|---|---|
| 11-11 23:43 | 3.3 | 2.6 | 16.4 | 16.4 | reply | 没跟你说话哦 |
| 11-11 23:49 | 1.2 | 2.6 | 13.1 | 13.1 | reply | 你看看…反应的问题 |
| 11-11 23:59 | 2.2 | 2.7 | 20.9 | 20.9 | reply | 总结刚才聊啥 |
| 11-12 00:04 | 3.0 | 2.4 | 20.8 | 20.8 | reply | 你别在这插话了 |
| 11-12 00:12 | 2.8 | 2.6 | 17.9 | 17.9 | reply | 余承东/余大嘴 |
| 11-12 00:19 | 1.1 | 2.2 | 13.0 | 13.0 | reply | 查华为 5G |
| 11-12 01:44 | 1.0 | 2.6 | 19.5 | 19.5 | reply | 去 X/Ins 调查 |
| 11-12 12:24 | 19.5 | — | 18.2 | 26.3 | tool | 总结一下（B 站卡片后） |
| 11-12 16:02 | 8.6 | 3.1 | 20.2 | 33.3 | tool | 看下看板 |
| 11-12 16:06 | 1.7 | 6.7 | 18.1 | 18.1 | reply | 能看到我的表情吗 |
| 11-12 16:08 | 7.6 | 3.0 | 40.6 | 40.6 | reply | 总结昨天和今天全部消息 |
| 11-12 19:42 | 7.6 | 2.7 | 19.9 | 79.3 | tool | 极客湾招人吗 |
| 11-12 20:46 | 11.2 | 3.1 | 26.5 | 26.5 | reply | 查 API 额度 |
| 11-12 21:07 | 10.0 | 2.8 | 23.6 | 23.6 | reply | 大肥鱼那个项目 |
| 11-12 22:54 | 11.0 | 2.6 | 25.1 | 43.4 | tool | AI 中转站是否合法 |

12:24 这行的“首次回复 18.2s”来自卡片那条消息先启动的 chat job；@ 自己的任务排队 19.5s 后才领到，且没有产出 outbox。该行保留在 e2e 统计里，但不参与“预处理/模型”中位数。

## 3. 50s 与 119s 到底花在哪

### 3.1 唯一一条 50s 真实样本：HuggingFace 链接（50.2s）

00:06:51 发 `taobao-mnn/MNN-Pocket-0.3B` + `Cactus-Compute/mirage`，00:07:41 发送，50.2s：

| 阶段 | 秒 | 证据 |
|---|---:|---|
| 入库 → chat 任务 | 1.6 | 00:06:51 → 00:06:52.6 |
| chat 队列 | 2.8 | 00:06:52.6 → 00:06:55.4 |
| chat 处理（预处理+参与模型+工具交接） | 4.4 | 00:06:55.4 → 00:06:59.8 |
| research 队列 | 5.3 | 00:06:59.8 → 00:07:05.1 |
| **research 执行（模型+工具+嘴替）** | **35.1** | 00:07:05.1 → 00:07:40.2 |
| outbox → 发送 | 1.1 | 00:07:40.2 → 00:07:41.2 |
| **合计** | **50.2** | |

**50s 的主因是 research 执行 35.1s，不是 30s 视频等待，也不是抓取。** 这条是链接消息（非 @），走的是通用研究/工具路径，不是 B 站 light fetch。

### 3.2 冷 B 站成功路径（模型，不是实测）

用 24h 实测的 chat 组件 + `TeamAgent-live-read-test.md` 的 A1 抓取组件拼：

| 阶段 | 秒 | 来源 |
|---|---:|---|
| 入库 → chat 任务 | 1.5 | 24h 中位 |
| chat 队列 | 3.3（高负载 11.1） | 24h 中位/P90 |
| 预处理 + 选视频目标 | 2.6 | 24h 中位；`videoTarget` 同步 <0.1s |
| 建 video_wait + fetch 任务 | <0.3 | 代码 |
| 本机领取 | 0–10，A1 8.9 | `fetcher.mjs:208` 10s 轮询；A1 实测 |
| B 站抓取 | 13.6 | A1 实测（短链 302→view→player→字幕→热评） |
| 回调 + ready/wake | <0.3 | `fetchjobs.ts` reportFetch |
| 视频回复队列 | 3–11 | 无视频样本，借用 chat 队列中位/P90 |
| 参与+嘴替模型 | 8 | 24h 模型+收尾中位 7.6 |
| 发送 | 2.6 | 24h 中位 |
| **合计** | **44–52** | 低队列 ~44，高队列 ~52 |

关键：**30s due 不在成功路径上。** `reportFetch` 在 22.5s（8.9+13.6）就把 waiter 标 ready 并立即 `wakeVideoWait`，比 30s 早 7.5s；`sweepVideoWaits` 只在没有回报时兜底。所以 50s ≠ 30+10+14+5，这个加法把并行的等待和抓取重复计算了。

### 3.3 119s no-report 路径（模型）

当本机离线、登录阻塞（单次最多 5 分钟）或抓取失败没有 report 时：

| 阶段 | 秒 | 说明 |
|---|---:|---|
| 入库 → 建 wait | ~7.4 | 1.5+3.3+2.6 |
| 等 due | 30 | 固定 `bili.wait_seconds` |
| cron 扫到期 | 0–60 | 每分钟一次，相位随机 |
| 视频回复队列 | 0–19.5 | CHAT 并发 1；24h 队列 P90 11.1，最大 19.5 |
| 模型+嘴替 | 8–25 | 24h 中位 7.6，最大 25.2 |
| 发送 | 2.6 | 24h 中位 |
| **合计** | **48–145** | 中位组合约 75–95；119 是其中一个组合，不是硬上界 |

**119 = 60+30+10+14+5 的写法不成立**：10s 领取和 14s 抓取发生在 30s 等待之内，不是之后；如果根本没有 report，这两段也不会发生。真实的 no-report 成本是“30s due + 0–60s cron + 队列 + 模型 + 发送”。

## 4. 链接/卡片轮次

24h 内共 5 条链接/卡片，全部不是 @（12:24 卡片后有一条“总结一下” @）。其中 5 条都得到了回复，全部走 research/工具路径，没有一条走 B 站 light fetch。

| 时间（Sydney） | 内容 | 回复发出 | 总耗时 | 主要阶段 |
|---|---|---|---:|---|
| 11-11 22:57:15 | `inkboard-team...workers.dev` | 22:57:46 | 32.0 | chat 队列 4.7 + research 执行 13 |
| 11-12 00:06:51 | HuggingFace ×2 | 00:07:41 | **50.2** | research 执行 35.1 |
| 11-12 00:22:57 | GitHub MaiBot | 00:23:23 | 26.4 | research 执行 12 |
| 11-12 00:27:40 | GitHub TeamAgent | 00:28:16 | 36.3 | chat 队列 10.0 + research 执行 15 |
| 11-12 12:24:43 | B 站卡片（+12:24:52 总结一下） | 12:25:18 | 35.0（从卡片）/ 26.3（从 @） | chat 队列 11.3 + research 执行 13.8 |

- 中位 35.0s，最大 50.2s；**research 执行 12–35s 是主因**，其次是 chat/research 队列。
- 这 5 条没有一条产生 `fetch-bili-*` 任务；B 站卡片那条也没有 `video_wait`。
- 12:24 卡片在旧 release 上 `biliCard=null`、`bili=[]`，所以没有进入标题检索/light fetch；回答是 research 模型通过搜索/网页读到的。当前 release `0f67b28` 已包含 `22854b4 fix: 递归识别 B站卡片链接并按标题严格回退检索`（15:02 Sydney），但 22:12 部署后没有新卡片样本。

## 5. 三个假设

### A. 回调是否立即唤醒回复，而不是等 cron

**成立（代码 + 测试），线上无样本。**
`reportFetch` 在 `src/fetchjobs.ts` 里：写 `video_waits.ready=1` → `wakeVideoWait` → `queueFor("video_reply").send`；`sweepVideoWaits` 只在 due/租约过期时兜底。`node --test test/fetchjobs.test.mjs` 42 项全过；W2 明确验证“report 后原问题在 due 前被回答”，W3 验证“cron 只有到期才回退”。24h 内 `jobs` 没有 `fetch` 行，无法用线上时间戳复验。

### B. 固定 30s 等待是否经常被耗满

**不成立（成功路径），频率无法从 24h 数据算。**
A1：领取 8.9s + 抓取 13.6s = 22.5s，距 30s 还有 7.5s；即使领取撞到 10s 上限，23.6s 仍不到 30s。A2 失败 11.7s、标题检索 6.2s 也都不到 30s。只有本机离线、登录阻塞或单次抓取 >30s 才会耗满。`video_waits` 终态行已被清空，无法统计真实耗满比例。

### C. 本机领任务的延迟占多少

**A1 实测 8.9s，占冷路径约 20%；24h 无 fetch 样本。**
`runner/fetcher.mjs:206-208`：claim 无任务就 `sleep(10000)`，所以是 0–10s 均匀；A1 实测 8.9s。成功路径上它是串行相加（report 立即唤醒），不是被 30s 掩盖。把 10s 降到 2s，中位约省 3s，尾部最多省 8s，并降低 due 被错过的概率。

## 6. 缺失埋点（按重要性）

1. `jobs` 没有 `claimed_at` / `finished_at`。现在只能靠 `lease_until - 租约` 反推；fetch 有 heartbeat 会续租，反推会偏早。
2. `video_waits` 没有 `ready_at` / `woken_at` / `done_at`，而且终态行被清空；无法算“等待实际耗了多久”“report 到 wake 多久”。
3. `chat_decisions` 没有 `queue_ms` / `preprocess_ms` 字段；`last_chat_timing` 只保留最后一条。
4. `model_runs` 没有 `turn_id` / `job_id`；现在只能按时间窗口匹配，多个 turn 重叠时会错配。
5. fetcher 的 `fetch.log` 只有 `fetcher start <hash>` 和 `fetch ... status=200`，没有时间戳；无法从日志恢复每次 claim/report 的时刻。
6. Worker 的 `console.log` 没有落到 D1；`wrangler tail` 只能看实时，历史日志没有保存。需要 Logpush/Workers Logs，或新增 `latency_events` 表。
7. `outbox_attempts` 有 `started_at`，但没有 `finished_at` / QQ 响应耗时；发送阶段只能算到“开始发送”。

建议的最小事件表（一行一个 turn）：
`turn_id, group_id, message_id, qq_received_at, persisted_at, chat_enqueued_at, chat_claimed_at, model_started_at, video_target_at, fetch_created_at, fetch_claimed_at, fetch_reported_at, wait_woken_at, outbox_at, send_started_at, send_finished_at`。
没有这些，50s/119s 只能继续用“组件拼接”，无法做真正的分位数。

## 7. 优化指向（按实测贡献排序）

1. **@ 快车道**：队列等待 3.3s 中位、11.1s P90、19.5s 最大（其中 1s 是故意防抖），是最大可变段。给 @ 单独一条 `CHAT_FAST` 队列（concurrency ≥2，`max_batch_timeout=1`），不要让 @ 和普通群聊挤在同一条 concurrency=1 的 CHAT 队列。预期收益 2–10s；这是最便宜的一刀。
2. **单次模型/跳过参与模型**：模型+收尾 7.6s 中位、12.1s P90、25.2s 最大，是最大单段；强制回复的 @ 不需要“参与判定”再“嘴替”两次。短回复合并成一次模型调用，预期省 2–4s。
3. **本机唤醒或 2s 轮询**：A1 领取 8.9s，占冷路径 20%。用 QQ 网关的 wake hint 或 2s 轮询（空闲退避到 10s），预期省 3s 中位、8s 尾部。
4. **due 用延迟队列替代 cron**：`startVideoWait` 时直接发一个 `delaySeconds=30` 的 `video_reply` job，`sweepVideoWaits` 只做恢复。这样 no-report 路径不再吃 0–60s 的 cron 相位；这是 119s 的最大一刀。
5. **抓取并行/缓存**：A1 抓取 13.6s 串行（view→player→字幕→热评）。view 之后并行 player/字幕，评论只用剩余预算；重复请求先查 `bili:<BV>` / 别名缓存。预期省 3–5s；重复请求省 13.6s。
6. **链接/卡片走确定性读取**：现在 5 条链接/卡片全靠 research，执行 12–35s；如果卡片能稳定识别成 `biliCard`，可以先建 fetch、边抓边答，把 35s 的 research 执行换成 13.6s 的抓取 + 8s 模型。前提是卡片识别在当前 release 上真的生效（需要一条新卡片样本验证）。
7. **发送**：2.6s，占比小，暂不动。

## 8. 限制

- 24h 窗口内没有真实的 `fetch` 任务 / `video_waits` 行；视频路径的所有分位数都是“组件拼接 + 代码”，不是观测。
- 唯一 B 站冷链接（`b23.tv/UIm520q`）在 2026-11-11 21:16 Sydney，比窗口早 1.7h；它的 `media_notes` 里现有 `bili:UIm520q` 是 19:30 的测试缓存（`fetched_at=11:30:00.783Z`），不是这次群消息。
- `chat_decisions` 只有 39 行，从 12:25 Sydney 开始；更早的 @ 没有 model_ms，只能用 `model_runs` 按时间匹配，14/15 条匹配成功，12:24 那条的 chat job 没有模型（模型在卡片那条 job 上）。
- 12:24 的 @ 任务排队 19.5s 且未产出 outbox；用户看到的 18.2s ack 来自卡片 job。该行计入 e2e，不计入 pre/model 中位数。
- `messages.ts` 是 QQ 事件时间，不是 Worker 落库时间；网关到 Worker 的时钟偏差没有单独测量。
- 当前 release 只有 22:54 一条 @ 样本（25.1s），其余样本跨多个 release；跨版本比较只能看量级，不能当同一版本的 SLA。
- 群里 24h 内没有 X/Twitter 链接或单推样本，X 路径不评价。
