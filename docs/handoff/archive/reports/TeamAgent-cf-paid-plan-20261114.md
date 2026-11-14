# Cloudflare Workers Paid（$5/月）额度核对与 TeamAgent 影响清单

> 核对日期：2026-11-14（悉尼）· 只读调研：未登录 Cloudflare 账户、未改代码、未动线上、未使用任何账号凭据。
> 口径：全部来自 `developers.cloudflare.com` 官方文档；每页的 `Last updated` 与我的读取日期见 §10。金额均为美元。
> 结论先行：$5 是「账户级月费 + 自带额度 + 超额按量」，不是无限量；TeamAgent 当前用量远低于额度，真正的风险在新设计（常驻 DO、每 tick 发 Queue、D1 全表扫描、Workers AI、日志全量、Browser 忘记关）。

---

## 0. 给用户看的结论（8 行内）

1. **$5 是账户级月费，不是无限量**：自带额度 + 超额按量；Workers 请求 1,000 万/月、CPU 3,000 万 ms/月、D1 读 250 亿行/月、写 5,000 万行/月、Queues 100 万操作/月、DO 100 万请求 + 40 万 GB-s/月。
2. **真正变强的是「单次能力」**：CPU 10ms→5min（默认 30s）、子请求 50→10,000、D1 单次查询 50→1,000、Cron 5→250、Queue 保留 24h→4–14 天。
3. **TeamAgent 现在离额度很远**：每分钟 cron 一个月 43,200 次，只占 1,000 万请求的 0.43%；按几百条消息的量级，D1/Queues 也远低于额度。
4. **最容易产生账单的**：常驻 DO（1 个 7×24 就用掉 83% 的 40 万 GB-s）、每 tick 发 Queue、D1 全表扫描、Workers AI 神经元、Logs 全量、Browser 忘记关。
5. **B 类（要加钱）单列在 §4 的 B 类表，默认全部不用**；建议把 Workers 花费上限设到 $1 + 邮件告警，DO 另设上限。
6. **TeamAgent 有 4 类「免费档前提」已过期**：`AGENTS.md:16`、`docs/decisions.md:27` 的 48 查询预算；1 分钟 cron 扫 `video_waits`；fastlinks/subagent 轮询；Workers AI「免费」假设（`F6P-1.md:5`）。
7. **B 站本机 X-ASR 不是免费档导致**（B 站 CDN 403/567），付费后不用改；看画面也不是（DeepSeek token 成本）。
8. 报告：`/Users/yanghongming/Projects/TeamAgent-cf-paid-plan-20261114.md`；依据页全部带官方链接和读取日期。

---

## 1. 读法与三类定义

- **A 类**：Workers Paid 套餐自带额度内可直接用，不产生额外费用。
- **B 类**：需要另行加钱（超额按量、独立付费产品、附加项）。默认全部不用，只列出。
- **C 类**：免费档也有，只是上限提高；用来判断「付费后哪些旧限制松了」。
- **计费单位**：1 KB = 1,000 bytes；1 GB = 1,000,000,000 bytes（Cloudflare 计费口径，不是 GiB）；1 GB-month = 1 GB 存 30 天。[DO-P]
- **重置**：Free 的日额度 00:00 UTC 重置；Paid 的月度自带额度按订阅续费日重置。[D1-P]
- **「额度」≠「你的账户实际可用量」**：我没有登录账户，所有数字是文档额度；实际以 dashboard → Workers plans / Billable Usage 为准。
- **文档冲突**：Cron/Queue 的 CPU 单次上限在 Pricing 页与 Limits/Queues 页写法不一致，见 §3.1 脚注；Vectorize 页面开头写「only paid」但同页表格又给 Free 额度，见 §3.10。两处都按更具体的 Limits/表格页取值，并保留原文。

---

## 2. Workers Paid 总览（vs Free）

| 维度 | Workers Free | Workers Paid 自带 | 超出单价 | 类别 | 来源 |
|---|---|---|---|---|---|
| 月费 | $0 | **$5/账户/月**（最低消费） | — | A | [W-P] |
| 请求 | 100,000/天 | **10,000,000/月**（无硬上限，超出计费） | +$0.30/百万 | C→A | [W-P][W-L] |
| CPU/次 | 10 ms | **5 分钟**（HTTP，默认 30 秒） | — | C | [W-L] |
| CPU/月 | 无月度包 | **30,000,000 ms/月** | +$0.02/百万 ms | A→B | [W-P] |
| Duration | 不收费 | 不收费、无硬上限 | — | C | [W-P] |
| 子请求/次 | 50 | **10,000**（可配到 10,000,000） | — | C | [W-L] |
| 内存/isolate | 128 MB | 128 MB（不变） | — | C | [W-L] |
| 环境变量/Secret | 64/Worker | **128/Worker**，每个 5 KB | — | C | [W-L] |
| Worker 体积 | 64 MiB | 64 MiB（不变，未压缩） | — | C | [W-L] |
| Workers/账户 | 100 | **500** | — | C | [W-L] |
| Cron Triggers/账户 | 5 | **250** | — | C | [W-L] |
| 静态资源/版本 | 20,000 | **100,000**，单文件 25 MiB | — | C | [W-L] |
| Cache API 调用/请求 | 50 | **1,000** | — | C | [W-L] |
| 同时出站连接/请求 | 6 | 6（不变） | — | C | [W-L] |
| Worker 启动时间 | 1 秒 | 1 秒（不变） | — | C | [W-L] |

**一句话**：请求只涨约 3.3 倍（100k/天≈3M/月 → 10M/月），不是 100 倍；真正质变的是 CPU、子请求、D1 单次查询数、Cron 数量和 Queue 保留期。

---

## 3. 各产品自带额度与单价

### 3.1 Workers / Cron / Logs / Logpush / Builds

| 项目 | Free | Paid 自带 | 超出/单价 | 备注 | 来源 |
|---|---|---|---|---|---|
| 入站请求 | 100,000/天 | 10,000,000/月（无硬上限，超出计费） | +$0.30/百万 | 静态资源请求免费且不限；WebSocket 只按 Upgrade 计 1 次请求 | [W-P][W-L] |
| CPU 时间 | 10 ms/次 | 30,000,000 ms/月；单次 HTTP 最大 5 分钟（默认 30 秒） | +$0.02/百万 ms | 等待网络 I/O 不计 CPU；Cron 间隔 <1h 为 30s、≥1h 为 15min；Queue consumer 可配到 5 分钟 | [W-P][W-L][Q-L] |
| Duration | 不收费 | 不收费、无硬上限 | — | HTTP 无硬上限；Cron/Queue/DO alarm 的 wall time 15 分钟 | [W-L] |
| 子请求 | 50/次 | 10,000/次（可配到 10,000,000） | — | 对 Cloudflare 内部服务默认也是 10,000 | [W-L] |
| 环境变量 | 64/Worker | 128/Worker | — | 每个 5 KB；账户总量不限 | [W-L] |
| Worker 体积 | 64 MiB | 64 MiB | — | 只算未压缩 bundle；无压缩后上限 | [W-L] |
| Workers 数 | 100/账户 | 500/账户 | — | 更多用 Workers for Platforms | [W-L] |
| Cron Triggers | 5/账户 | 250/账户 | — | 最小粒度 1 分钟（支持 `* * * * *`）；UTC；变更最多 15 分钟传播 | [W-L][W-CRON] |
| 静态资源 | 20,000/版本 | 100,000/版本 | — | 单文件 25 MiB；Wrangler ≥4.34.0 | [W-L] |
| Cache API | 50 次/请求 | 1,000 次/请求 | — | 与子请求共用配额 | [W-L] |
| Workers Logs | 200,000 事件/天，保留 3 天 | 20,000,000/月，保留 7 天 | +$0.60/百万事件 | **2026-12-01 起改用 Observability 计价**（见下） | [W-LOG] |
| Workers Logpush | 不可用 | 10,000,000 请求/月 | +$0.05/百万请求 | 仅 Paid；按到达终点的请求日志计费 | [W-P] |
| Workers Builds | 3,000 分钟/月，1 并发 | 6,000 分钟/月，6 并发 | +$0.005/分钟 | 4 vCPU / 8 GB / 20 GB 磁盘 | [W-BUILD] |
| Pages Functions | 同 Workers | 同 Workers | 同 Workers | 所有 Pages Functions 按 Workers 计费 | [W-P] |

**Workers Logs 的 2026-12-01 变更**（这条很关键，TeamAgent 如果开日志要看）：

| 项目 | 现在（至 2026-11-30） | 2026-12-01 起（Observability 计价） | 来源 |
|---|---|---|---|
| 自带量 | 20,000,000 事件/月 | **50 GB 摄入/账期 + 10 GB-month 存储** | [W-LOG][OBS-P] |
| 超出 | +$0.60/百万事件 | **+$0.25/GB 摄入；+$0.10/GB-month 存储** | [OBS-P] |
| 保留 | 7 天 | 7 天（默认；官方计划加 30/90/365 天） | [W-LOG][OBS-P] |
| 硬上限 | 5,000,000,000 条/天；单条 256 KB | 同左 | [W-LOG] |

> 换算：如果一条日志约 1 KB，20M 事件≈20 GB；新计价 50 GB 摄入更宽。但如果你一条请求打 3 条日志、一个月 2,000 万请求，就是 6,000 万条≈60 GB，会进入 B 类。

**Cron 补充**：Cron Triggers 支持五段式 + Quartz 扩展（`L`、`W`、`#`）；最小间隔就是 1 分钟；Cron Events 只保留最近 100 次执行记录。[W-CRON]

**CPU 文档冲突（照实记）**：Pricing 页写「Max of 15 minutes of CPU time per Cron Trigger or Queue Consumer invocation」；Limits 页写 Cron「30 seconds (<1 hour interval) / 15 min (>=1 hour interval)」；Queues limits 页写 consumer「Configurable to 5 minutes」。**取值以 Limits/Queues 页为准**；如果要做长任务，按 5 分钟设计，不要按 15 分钟。[W-P][W-L][Q-L]

### 3.2 D1

| 项目 | Free | Paid 自带 | 超出/单价 | 备注 | 来源 |
|---|---|---|---|---|---|
| 读行数 | 5,000,000/天 | **25,000,000,000/月** | +$0.001/百万行 | 全表扫描按扫描行数算，不是返回行数 | [D1-P] |
| 写行数 | 100,000/天 | **50,000,000/月** | +$1.00/百万行 | INSERT/UPDATE/DELETE 都算；索引会多写 1 行 | [D1-P] |
| 存储 | 5 GB 总量 | 前 5 GB 包含 | +$0.75/GB-month | 表和索引都算 | [D1-P] |
| 数据库数 | 10 | 前 100,000 包含 | +$0.10/库/月 | 上限 1,000,000 库 | [D1-L] |
| 单库上限 | 500 MB | **10 GB** | 不可再提高 | 官方建议按 10 GB 水平分库 | [D1-L] |
| 账户存储上限 | 5 GB | 1 TB | 可申请提高 | — | [D1-L] |
| Time Travel | 7 天 | **30 天** | 包含 | 每库 10 次恢复/10 分钟 | [D1-L] |
| 单次 Worker 调用查询数 | 50 | **1,000** | — | `batch()` 算 1 次查询（不是每条语句 1 次） | [D1-L] |
| 单条 SQL 最长 | 30 秒 | 30 秒 | — | 整个 batch 也受 30 秒限制 | [D1-L] |
| 单条结果上限 | — | 50 MB（2026-11-04 起） | — | 超过报错；REST 导入导出不受此限 | [D1-L] |
| 单行/字符串/BLOB | 2 MB | 2 MB | — | 列数最多 100；绑定参数最多 100 | [D1-L] |
| Egress | 免费 | 免费 | — | 无数据传输费 | [D1-P] |

**计费陷阱**：`SELECT * FROM table` 在 5,000 行表上就是 5,000 行读；在未建索引的列上过滤，即使只返回几行，也要扫描更多行。索引会减少读行数，但写入索引列时会多 1 行写。[D1-P]

### 3.3 Queues

| 项目 | Free | Paid 自带 | 超出/单价 | 备注 | 来源 |
|---|---|---|---|---|---|
| 标准操作 | 10,000/天 | **1,000,000/月** | +$0.40/百万操作 | 每 64 KB 写入/读取/删除各算 1 次操作；一条消息通常 3 次 | [Q-P] |
| 队列数 | 10,000 | 前 10,000 包含 | +$0.10/队列/月 | 默认上限 10,000 | [Q-L] |
| 消息大小 | 128 KB | 128 KB | — | 约 100 bytes 内部元数据计入 | [Q-L] |
| 保留期 | 24 小时（不可配） | **4 天默认，可配到 14 天** | — | 到期自动删除 | [Q-P][Q-L] |
| 重试次数 | 100 | 100 | — | 每次重试算 1 次读操作 | [Q-L] |
| 消费批大小 | 100 | 100 | — | `sendBatch` 最多 100 条或 256 KB | [Q-L] |
| 单队列吞吐 | 5,000 消息/秒 | 5,000 消息/秒 | — | 超过会 429 | [Q-L] |
| 单队列积压 | 25 GB | 25 GB | — | 超过 `Storage Limit Exceeded` | [Q-L] |
| 并发消费者 | 250 | 250 | — | 仅 push-based | [Q-L] |
| 消费者 wall time | 15 分钟 | 15 分钟 | — | CPU 可配到 5 分钟 | [Q-L] |
| 死信队列 | 支持 | 支持 | 写入 DLQ 按 64 KB 算写操作 | 重试到上限后写 DLQ；重试本身算读操作 | [Q-P] |

**计费算例**：一条消息正常「写 + 读 + 删」= 3 次操作；100 万条/月 = 300 万次操作，其中 100 万包含，超出 200 万 × $0.40 = **$0.80/月**。如果每条消息重试 3 次才进 DLQ，读操作会变成 5 次，成本约翻倍。[Q-P]

### 3.4 Durable Objects

| 项目 | Free | Paid 自带 | 超出/单价 | 备注 | 来源 |
|---|---|---|---|---|---|
| 请求 | 100,000/天 | **1,000,000/月** | +$0.15/百万 | HTTP、RPC session、WebSocket 消息、alarm 都算；WS 入站按 20:1 计费 | [DO-P] |
| Duration | 13,000 GB-s/天 | **400,000 GB-s/月** | +$12.50/百万 GB-s | 按 wall-clock；可 hibernation 的空闲不计 | [DO-P] |
| SQLite 读行 | 5,000,000/天 | **25,000,000,000/月** | +$0.001/百万行 | 与 D1 同价 | [DO-P] |
| SQLite 写行 | 100,000/天 | **50,000,000/月** | +$1.00/百万行 | `setAlarm()` 算 1 行；删除也算写 | [DO-P] |
| SQLite 存储 | 5 GB 总量 | **5 GB-month 包含** | +$0.20/GB-month | 计费目标日 2026-01-07（官方原文：no earlier） | [DO-P] |
| KV 后端存储 | 不可用 | 仅老账户；读 1M/写 1M/删 1M/存 1 GB 包含 | +$0.20/M 读；+$1.00/M 写；+$1.00/M 删；+$0.20/GB-month | 新账户只能用 SQLite 后端 | [DO-P] |
| 单对象存储 | 1 GB（Free） | **10 GB** | 不可再提高 | 超限写入报 `SQLITE_FULL`，读/删仍可用 | [DO-L] |
| DO 类数量 | 100/账户 | 500/账户 | — | 对象数量不限 | [DO-L] |
| 单对象请求速率 | 约 1,000/秒（软限） | 约 1,000/秒（软限） | — | 超了会排队/overloaded | [DO-L] |
| Key/Value 大小 | — | key+value ≤8 MB；WS 消息 32 MiB；SQL 行 8 MB | — | — | [DO-L] |
| CPU/请求 | 30 秒默认 | 30 秒默认，可配到 5 分钟 | — | 每个入站请求重置 30 秒 | [DO-L] |

**反直觉的一条**：DO 的付费自带请求量是 **1,000,000/月**，而免费档是 **100,000/天**（×30≈3,000,000/月）。所以付费在 DO 请求上不是「额度更大」，而是「不硬停、可超额、可用 KV 后端」。Duration 也几乎持平（13k GB-s/天≈390k/月 vs 400k/月）。**不要因为升级了就把 DO 当免费资源用。** [DO-P]

**常驻成本算例**：一个 128 MB 的 DO 7×24 跑一个月 = 2,592,000 秒 × 0.128 GB = **331,776 GB-s**，占 400,000 GB-s 的 **83%**；两个就超。必须用 WebSocket Hibernation 或 alarm，不要常驻。[DO-P]

### 3.5 KV / Hyperdrive

| 项目 | Free | Paid 自带 | 超出/单价 | 备注 | 来源 |
|---|---|---|---|---|---|
| KV 读 | 100,000/天 | 10,000,000/月 | +$0.50/百万 | 批量读按 key 数计 | [W-P] |
| KV 写 | 1,000/天 | 1,000,000/月 | +$5.00/百万 | 同一 key 每秒最多 1 次写 | [W-P][KV-L] |
| KV 删 | 1,000/天 | 1,000,000/月 | +$5.00/百万 | — | [W-P] |
| KV list | 1,000/天 | 1,000,000/月 | +$5.00/百万 | — | [W-P] |
| KV 存储 | 1 GB | 1 GB 包含 | +$0.50/GB-month | 账户/命名空间各 1 GB 上限（Free） | [W-P][KV-L] |
| KV 命名空间 | 1,000 | 1,000 包含 | +$0.10/命名空间/月 | 默认上限 1,000 | [W-P] |
| KV key/value | 512 B / 25 MiB | 同左 | — | metadata 1,024 B；单次调用最多 1,000 次操作 | [KV-L] |
| Hyperdrive 查询 | 100,000/天 | **不限量** | — | 包含在 Workers Paid | [W-P] |

### 3.6 R2

| 项目 | Free | Standard | Infrequent Access | 来源 |
|---|---|---|---|---|
| 存储 | 10 GB-month/月 | $0.015/GB-month | $0.01/GB-month + $0.01/GB 取回 | [R2-P] |
| Class A 操作 | 1,000,000/月 | $4.50/百万 | $9.00/百万 | [R2-P] |
| Class B 操作 | 10,000,000/月 | $0.36/百万 | $0.90/百万 | [R2-P] |
| Egress | 免费 | 免费 | 免费 | [R2-P] |
| 桶数量 | 前 100,000 包含 | 同左 | 同左 | [R2-P] |
| 最短存储期 | — | 无 | 30 天 | [R2-P] |

**关键**：R2 的 10 GB 免费层是**独立于 Workers Paid** 的，和 $5 套餐无关；免费层只适用于 Standard，不适用于 Infrequent Access。不要把 R2 当「$5 套餐里的大硬盘」。[R2-P]

### 3.7 Workers AI

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 每日免费 neurons | 10,000/天 | **10,000/天（不变）** | [AI-P] |
| 超出 | 不可用（硬停） | **$0.011/1,000 neurons** | [AI-P] |
| 速率限制（ASR） | 720 请求/分钟 | 720 请求/分钟 | [AI-L] |
| 速率限制（文本生成） | 300 请求/分钟 | 300 请求/分钟 | [AI-L] |
| 付费专用模型 | — | 20 请求/分钟（标准计费）；50/分钟（AI Gateway 预付额度） | [AI-L] |
| 需要付费计划的模型示例 | — | `@cf/deepseek-ai/deepseek-v4.1-flash-1017`、`@cf/zai-org/glm-5.3`、`@cf/moonshotai/kimi-k2.6` 等 | [AI-P] |

**结论**：每日免费神经元额度**没有变**；付费只是把「超过 10k 就失败」变成「超过 10k 按 $0.011/1k 计费」。不要以为升级后 neurons 变多了。[AI-P]

**粗算**：`@cf/meta/llama-3.1-8b-instruct-fp8-fast` 是 4,119 neurons/百万输入 token、34,868 neurons/百万输出 token；10k neurons ≈ 243 万输入 token 或 28.7 万输出 token/天。视觉模型 `@cf/meta/llama-3.2-11b-vision-instruct` 输出 61,493 neurons/百万 token，10k neurons ≈ 16.3 万输出 token/天。[AI-P]

### 3.8 Browser Run（旧名 Browser Rendering）

| 项目 | Free | Paid 自带 | 超出/单价 | 来源 |
|---|---|---|---|---|
| Browser hours | 10 分钟/天 | **10 小时/月** | +$0.09/小时 | [BR-P] |
| 并发浏览器上限（Browser Sessions） | 3 | **200/账户** | — | [BR-L] |
| 计费包含并发 | — | 月均前 10 个包含 | +$2.00/个 | [BR-P] |
| 新浏览器实例 | 1 次/20 秒 | 3 次/秒 | — | [BR-L] |
| Quick Actions 请求 | 1 次/10 秒 | 30 次/秒 | — | [BR-L] |
| 空闲超时 | 60 秒 | 60 秒；`keep_alive` 可到 20 分钟 | — | [BR-L] |

**注意**：Browser Run 的「10 小时/月」是浏览器小时，不是请求数；忘记 `browser.close()` 会一直烧到空闲超时。200 并发跑 3 分钟就等于 10 小时额度。[BR-P][BR-L]

### 3.9 Workflows

| 项目 | Free | Paid 自带 | 超出/单价 | 来源 |
|---|---|---|---|---|
| 请求 | 100,000/天（与 Workers 共享） | 10,000,000/月 | +$0.30/百万 | [WF-P] |
| CPU | 10 ms/次 | 30,000,000 ms/月 | +$0.02/百万 ms | [WF-P] |
| 存储 | 1 GB-month | 1 GB-month 包含 | +$0.20/GB-month | [WF-P] |
| 步数 | 3,000/天 | **500,000/月** | +$0.80/10 万步 | [WF-P] |
| 单 Workflow 最大步数 | 1,024 | **10,000**（可配到 25,000） | — | [WF-L] |
| 并发实例/账户 | 100 | **50,000** | — | [WF-L] |
| 单实例最大状态 | 100 MB | **1 GB** | — | [WF-L] |
| 完成实例保留 | 3 天 | **7 天默认**（可配到 30 天） | 存储按 GB-month 计 | [WF-L] |
| 实例创建速率 | 100/秒 | 300/秒/账户，100/秒/Workflow | — | [WF-L] |

**计费开始时间**：Workflows 的 step 和 storage 计费从 **2026-08-10** 起生效（现在已经在计费）；requests/CPU 与 Workers 共用额度，不是另送 10M。[WF-P]

### 3.10 Vectorize

| 项目 | Free | Paid 自带 | 超出/单价 | 来源 |
|---|---|---|---|---|
| 查询向量维度 | 30,000,000/月 | **50,000,000/月** | +$0.01/百万 | [VEC-P] |
| 存储向量维度 | 5,000,000 | **10,000,000** | +$0.05/亿 | [VEC-P] |
| 索引数 | 100 | **50,000** | +$0.10/索引/月 | [VEC-P] |

**文档自相矛盾**：页面开头写「Vectorize is currently only available on the Workers paid plan」，但同页表格有 Free 列（30M queried / 5M stored / 100 indexes），FAQ 也说「Workers free tier 会一直包含 Vectorize 原型能力」。**按表格/FAQ 取值**；如果你要在 Free 上用，先在 dashboard 确认。[VEC-P]

### 3.11 Containers（附带，不在 BINI 清单里但 $5 套餐包含）

| 项目 | Free | Paid 自带 | 超出/单价 | 来源 |
|---|---|---|---|---|
| 内存 | 无 | **25 GiB-hours/月** | +$0.0000025/GiB-s | [CONT-P] |
| CPU | 无 | **375 vCPU-minutes/月** | +$0.000020/vCPU-s | [CONT-P] |
| 磁盘 | 无 | **200 GB-hours/月** | +$0.00000007/GB-s | [CONT-P] |
| Egress（北美/欧洲） | — | 1 TB/月 | +$0.025/GB | [CONT-P] |
| Egress（大洋洲/韩国/台湾） | — | 500 GB/月 | +$0.05/GB | [CONT-P] |

**不要把它当 24/7 服务器**：一个 1 GiB 的容器常驻一天就是 24 GiB-hours，25 GiB-hours 的额度约 25 小时就用完；而且容器还会另算 Workers 和 DO 的费用。[CONT-P]

---

## 4. A / B / C 三类清单

### A 类：套餐自带额度内可直接用（不产生额外费用）

> 口径说明：A 表按「在付费额度内可直接用」列。其中 **R2 的 10GB 是独立免费层，不算 $5 套餐**；**Workers AI 的 10k neurons/天是 Free/Paid 都有的免费额度**，超出即进入 B 类。

| 场景 | 自带额度 | 注意 | 来源 |
|---|---|---|---|
| Worker HTTP / API | 10M 请求/月 | 静态资源请求免费；WebSocket 只算 Upgrade | [W-P] |
| 每分钟 Cron | 250 个/账户 | 最小 1 分钟；UTC；变更最多 15 分钟传播 | [W-L][W-CRON] |
| CPU 较重解析 | 30M ms/月；单次 5 分钟 | 默认 30 秒；等待 I/O 不计 CPU | [W-P][W-L] |
| 一次抓多个页面 | 10,000 子请求/次 | 但同时只有 6 个连接在等响应头 | [W-L] |
| D1 主库 | 25B 读/50M 写/5GB/100k 库/10GB 单库/30 天 Time Travel | 单次 1,000 查询；单条 SQL 30 秒 | [D1-P][D1-L] |
| Queues 异步 | 1M 操作/月；4–14 天保留 | 批大小 100；重试算读操作 | [Q-P][Q-L] |
| Durable Objects | 1M 请求/400k GB-s/5GB + SQLite 行数 | 必须 Hibernation；1 个常驻就用 83% | [DO-P] |
| KV 热配置/缓存 | 10M 读/1M 写/1GB | 同一 key 写 1 次/秒；写 $5/M 很贵 | [W-P][KV-L] |
| Workers Logs | 20M 事件/月，7 天（12-01 后 50GB/10GB-month） | 开采样；默认每个请求 1 条 invocation log | [W-LOG][OBS-P] |
| Workflows 长任务 | 500k 步/月；10k 步/实例；50k 并发 | step/storage 已计费；sleep 不计 CPU | [WF-P][WF-L] |
| Workers AI 轻量分类 | 10k neurons/天 | 超过即 B 类；视觉/大模型很快烧完 | [AI-P] |
| Browser Run | 10 小时/月；200 并发 | 必须 `finally { browser.close() }` | [BR-P][BR-L] |
| Workers Builds | 6,000 分钟/月；6 并发 | 4 vCPU / 8 GB / 20 GB | [W-BUILD] |
| Hyperdrive | 不限查询 | 包含在 Paid | [W-P] |
| R2 标准存储 | 10GB/1M A/10M B 免费层（独立） | 只 Standard；IA 不免费 | [R2-P] |
| Vectorize | 50M 查询维度/10M 存储维度/50k 索引 | 页面说 only paid，表格有 Free，先确认 | [VEC-P] |
| Containers | 25 GiB-h/375 vCPU-min/200 GB-h | 不能 24/7；另算 Workers+DO | [CONT-P] |

### B 类：要另行加钱（默认全部不用，只列出）

| 项目 | 触发 | 单价 | 备注 | 来源 |
|---|---|---|---|---|
| Workers 请求超额 | >10M/月 | +$0.30/百万 | 静态资源不计 | [W-P] |
| Workers CPU 超额 | >30M ms/月 | +$0.02/百万 ms | 单次 5 分钟是上限，不是额度 | [W-P] |
| Workers Logs 超额（现在） | >20M 事件/月 | +$0.60/百万事件 | 12-01 前 | [W-LOG] |
| Workers Logs 超额（12-01 后） | >50 GB 摄入 或 >10 GB-month 存储 | +$0.25/GB；+$0.10/GB-month | 新计价 | [OBS-P] |
| Workers Logpush 超额 | >10M 请求/月 | +$0.05/百万请求 | 仅 Paid | [W-P] |
| Workers Builds 超额 | >6,000 分钟/月 | +$0.005/分钟 | — | [W-BUILD] |
| D1 读超额 | >25B 行/月 | +$0.001/百万行 | 全表扫描最容易 | [D1-P] |
| D1 写超额 | >50M 行/月 | +$1.00/百万行 | 索引额外写 | [D1-P] |
| D1 存储超额 | >5 GB | +$0.75/GB-month | — | [D1-P] |
| D1 库数超额 | >100,000 | +$0.10/库/月 | 空库也收 | [D1-P] |
| Queues 操作超额 | >1M 操作/月 | +$0.40/百万操作 | 重试/DLQ 都算 | [Q-P] |
| Queues 队列数超额 | >10,000 | +$0.10/队列/月 | — | [Q-L] |
| DO 请求超额 | >1M/月 | +$0.15/百万 | — | [DO-P] |
| DO Duration 超额 | >400k GB-s/月 | +$12.50/百万 GB-s | 最容易爆的一项 | [DO-P] |
| DO SQLite 行/存储超额 | >25B 读 / >50M 写 / >5GB-month | +$0.001/M；+$1.00/M；+$0.20/GB-month | 与 D1 同价 | [DO-P] |
| DO KV 后端 | 老账户 | 读 $0.20/M；写/删 $1.00/M；存 $0.20/GB-month | 新账户不可用 | [DO-P] |
| KV 读/写/删/list 超额 | >10M 读 / >1M 写/删/list | +$0.50/M；+$5.00/M | 写最贵 | [W-P] |
| KV 存储/命名空间超额 | >1 GB / >1,000 | +$0.50/GB-month；+$0.10/个/月 | — | [W-P] |
| R2 存储/操作超额 | >10GB / >1M A / >10M B | $0.015/GB-month；$4.50/M A；$0.36/M B | 独立计费 | [R2-P] |
| R2 IA | 主动选择 | $0.01/GB-month；$9/M A；$0.90/M B；$0.01/GB 取回 | 30 天最短存储 | [R2-P] |
| Workers AI 超额 | >10k neurons/天 | +$0.011/1k neurons | 付费专用模型另有限速 | [AI-P] |
| Browser hours 超额 | >10 小时/月 | +$0.09/小时 | — | [BR-P] |
| Browser 并发超额 | 月均 >10 个 | +$2.00/个 | 200 并发是硬上限，不是免费 | [BR-P][BR-L] |
| Workflows 步数超额 | >500k/月 | +$0.80/10 万步 | — | [WF-P] |
| Workflows 存储超额 | >1 GB-month | +$0.20/GB-month | — | [WF-P] |
| Vectorize 超额 | >50M 查询 / >10M 存储 / >50k 索引 | +$0.01/M；+$0.05/亿；+$0.10/个/月 | — | [VEC-P] |
| Containers 超额 | >25 GiB-h / >375 vCPU-min / >200 GB-h | 见 §3.11 | 另算 Workers+DO | [CONT-P] |
| AI Gateway 预付额度 | 主动购买 | 另计 | 不是套餐自带 | [AI-P] |
| 提高配额（Enterprise/limit increase） | 主动申请 | 联系销售 | 不是自助 | [W-L] |

### C 类：免费档也有，只是上限提高

| 项目 | Free | Paid | 变化 | 来源 |
|---|---|---|---|---|
| 请求 | 100,000/天（≈3M/月） | 10M/月 | ≈3.3× | [W-P][W-L] |
| CPU/次 | 10 ms | 5 分钟 | 30,000× | [W-L] |
| 子请求/次 | 50 | 10,000 | 200× | [W-L] |
| 环境变量 | 64 | 128 | 2× | [W-L] |
| Workers | 100 | 500 | 5× | [W-L] |
| Cron | 5 | 250 | 50× | [W-L] |
| 静态资源 | 20,000 | 100,000 | 5× | [W-L] |
| Cache API | 50 | 1,000 | 20× | [W-L] |
| D1 库数 | 10 | 100,000 | 10,000× | [D1-L] |
| D1 单库 | 500 MB | 10 GB | 20× | [D1-L] |
| D1 Time Travel | 7 天 | 30 天 | 4.3× | [D1-L] |
| D1 读行 | 5M/天（≈150M/月） | 25B/月 | ≈167× | [D1-P] |
| D1 写行 | 100k/天（≈3M/月） | 50M/月 | ≈16.7× | [D1-P] |
| Queues 操作 | 10k/天（≈300k/月） | 1M/月 | ≈3.3× | [Q-P] |
| Queue 保留 | 24h | 4–14 天 | 4–14× | [Q-P] |
| DO 请求 | 100k/天（≈3M/月） | 1M/月 | **反而更低**（Free 超了硬停；Paid 可超额，超出 $0.15/M） | [DO-P] |
| DO Duration | 13k GB-s/天（≈390k/月） | 400k/月 | 基本持平 | [DO-P] |
| KV 读 | 100k/天（≈3M/月） | 10M/月 | ≈3.3× | [W-P] |
| KV 写 | 1k/天（≈30k/月） | 1M/月 | ≈33× | [W-P] |
| Logs | 200k/天，3 天 | 20M/月，7 天 | ≈3.3× | [W-LOG] |
| Browser | 10 分钟/天（≈5 小时/月） | 10 小时/月 | 2× | [BR-P] |
| Workflows 步数 | 3k/天（≈90k/月） | 500k/月 | ≈5.6× | [WF-P] |
| Workflows 并发 | 100 | 50,000 | 500× | [WF-L] |
| Hyperdrive | 100k 查询/天 | 不限 | ∞ | [W-P] |
| Vectorize 查询维度 | 30M/月 | 50M/月 | 1.67× | [VEC-P] |

---

## 5. 安全红线表（最容易超额 + 不超的设计）

> 这一节是给施工用的：左边是「为什么会超」的算例，右边是「怎么设计才不超」。所有算例按 30 天/月、当前 TeamAgent 每分钟 1 次 cron（43,200 次/月）估算。

| # | 红线 | 算例（为什么容易超） | 设计约束 | 监控/告警 | 来源 |
|---|---|---|---|---|---|
| 1 | **常驻 Durable Object** | 1 个 128 MB DO 7×24 = 331,776 GB-s，占 40 万额度的 **83%**；2 个就超 | 用 WebSocket Hibernation；用 alarm 而不是常驻；每个群/会话一个短命 DO；禁止「一个全局 DO 处理所有事」 | dashboard DO duration；超 60% 告警 | [DO-P] |
| 2 | **每分钟 Cron + D1 全表扫描** | 43,200 次 × 50 万行 = **216 亿行/月**，占 250 亿的 86%；每次扫 57.9 万行就正好用满 | 建索引；用游标增量；`LIMIT`；禁止 `SELECT *`；`EXPLAIN QUERY PLAN` 过一遍；每 tick 记录 `meta.rows_read` | 每日 D1 读行；单次 `rows_read` p95 | [D1-P] |
| 3 | **每 tick 发 Queue** | 1M 操作 / 43,200 = **23 次操作/tick**；8 条消息 × 3 次 = 24 次，一个月就超 | 合并发送；只在状态变化时入队；批大小 10–100；延迟消息代替轮询；DLQ 兜底 | Queue ops/day；队列积压 | [Q-P] |
| 4 | **D1 写入放大** | 50M 写 / 43,200 = **1,157 行/tick**；每条消息/每次轮询都写，很快用满；索引还会多写 | `INSERT OR IGNORE` / UPSERT；批量 `batch()`；只写变化字段；30 秒节流；不要每 tick 写「心跳」 | 每日写行；每 tick 写行 | [D1-P] |
| 5 | **Workers AI 神经元** | 10k/天免费；8B 模型 4,119 neurons/M 输入 → 约 **243 万输入 token/天**；视觉模型输出 61,493/M → 只有 **16.3 万输出 token/天**；超了 $0.011/1k | 硬日预算 10k；缓存结果；只做便宜分类/embedding；judge/长文总结不要放 Workers AI；按模型单价预估 | dashboard neurons；budget() 计数 | [AI-P] |
| 6 | **Workers Logs 全量** | 10M 请求 × 2 条日志 = **20M**，正好用满；3 条/请求 = 30M，约 **$6/月** | `head_sampling_rate=0.1`；`invocation_logs=false`；只打结构化关键字段；不要 `console.log` 整个 payload | 每日日志条数/GB；12-01 后看 GB | [W-LOG] |
| 7 | **KV 热写** | 1M 写/月 = **33k/天 ≈ 0.39 次/秒**；1 秒轮询写 KV = **260 万/月**，约 **$13/月** | 只在状态变化时写；内存缓存；不要用 KV 做计数器/锁；同一 key 1 次/秒 | KV 写次数；单 key 写速率 | [W-P][KV-L] |
| 8 | **Browser 忘记关** | 10 小时/月 = **600 分钟**；200 并发 × 3 分钟 = 600 分钟，额度直接没；默认 60 秒空闲才关 | `try/finally { await browser.close() }`；`keep_alive` 尽量短；复用 session；限制并发；失败也关 | `X-Browser-Ms-Used`；Browser 页面会话关闭原因 | [BR-P][BR-L] |
| 9 | **Workflows 步数** | 500k 步/月；100 步 × 5,000 实例 = **500k**；每个 item 一步最容易爆 | 一个 step 里批量处理多个 item；用 `step.sleep` / `waitForEvent` 代替轮询；限制实例数 | 每日步数；实例并发 | [WF-P][WF-L] |
| 10 | **R2 List** | 1M Class A/月；每小时 list 1,000 个对象 = **72 万/月**；SDK 分页会多次 list | 用游标/缓存；不要在热路径 `ListObjects`；对象 key 可预测 | R2 Class A/day | [R2-P] |
| 11 | **Workers 请求** | 10M/月 = **3.86 次/秒**平均；4 个客户端 1 秒轮询 = **1,040 万/月**，就超 | 事件驱动（Queues/Workflows）；退避；不要固定 1 秒轮询；用 `waitUntil` 做收尾 | 每日请求数；每路由 p95 | [W-P] |
| 12 | **子请求风暴** | 10,000/次是上限，但同时只有 **6 个连接**在等响应头；1,000 个 fetch 串行会拖死 CPU/wall time | 并发池 6；每个 fetch 超时/abort；按 job 限额；不要在一个 invocation 里抓整个站 | 子请求数/错误率；超时率 | [W-L] |
| 13 | **Containers 常驻** | 25 GiB-hours/月；1 GiB 容器 7×24 = **24 GiB-hours/天**，约 25 小时就用完 | 只做 burst；用完 sleep；不要当服务器；优先 Worker/Queues | 容器运行时长 | [CONT-P] |

**兜底建议**：
- Workers 花费上限：覆盖 Workers 请求 + CPU，**不含 $5 月费**；设到 **$1**，并开 email alert。达到上限会拒绝新 invocation（HTTP 1103），但**不是精确上限**，用量还会继续一会儿。[SPEND]
- DO 花费上限：单独设，覆盖 requests/duration/storage 操作；**存储费不在暂停范围内**。[DO-P]
- D1 / Queues / KV / R2 / Workers AI / Browser 没有「一个总开关」；只能在代码里做日预算 + dashboard 告警。TeamAgent 已有 `src/budget.ts:13` 的原子日计数器，可以复用（`budget(e, "workers_ai", cap)`），但每次 `budget()` 本身也是一次 D1 写，别在热路径每请求调用。[BUDGET]

### 5.1 代码护栏（可直接复用 `src/budget.ts`）

```ts
// 不要新建计数器；复用 src/budget.ts:13 的原子日计数器。
// 每次调用会写 1 行 D1，所以只在“每次模型调用/每次入队/每次开浏览器”这种粒度调用。
import { budget } from "./budget";

// 例 1：Workers AI 每天最多 200 次调用（示例值；按模型实测 neurons 调整，10k neurons/天是硬上限）
if (!(await budget(e, "cf:workers_ai_calls", 200))) {
  return fallbackWithoutAI(); // 超预算降级，不要继续烧
}

// 例 2：Queues 每天最多 500 条 wake 消息（≈1,500 操作/天，月 45k，远低于 1M）
if (!(await budget(e, "cf:queue_wake", 500))) {
  return; // 本轮不唤醒，等下一个 cron/重试
}

// 例 3：Browser Run 每天最多 20 次会话（按 60 秒/次估算 ≈20 分钟/天）
if (!(await budget(e, "cf:browser_sessions", 20))) {
  return; // 不开浏览器
}
```

> 注意：`budget()` 的 key 按悉尼日切分，和 Cloudflare 的 UTC 日/月度账单不对齐；它是「应用级护栏」，不是账单上限。真正的账单上限用 §8 的 Workers/DO spending limit。

---

## 6. TeamAgent 现状对照：哪些「免费档降级/绕路」现在能改

> 基线：`/Users/yanghongming/Projects/.worktrees/TeamAgent-p4b-login`，HEAD `58e640b`。只读核对，未改代码。
> 当前量级：`wrangler.toml:10` 是 `crons = ["* * * * *"]`，即 **43,200 次/月**；线上游标在几百条的量级（团队记忆 466、后续 status 450，取不同时间点）。按这个量级，Workers 请求只占 0.43%；以几百条消息的量级看，D1/Queues 也不太可能接近额度（准确值以 dashboard 为准）。按现有量级估算，月度账单应就是 $5 基费；**升级后真正要改的不是「额度不够」，而是「旧设计为了省额度而绕路」。**

| # | 旧做法/决定 | 出处 | 旧前提 | 付费后能做什么 | 建议（可直接施工） | 量 | 去处 |
|---|---|---|---|---|---|---|---|
| 1 | D1 每次调用只给 48 条语句预算 | `src/d1.ts:10`；`docs/decisions.md:27`；`AGENTS.md:16`；`docs/operations.md:22`；`docs/review.md:52` | Free 每次调用最多 50 查询 | Paid 1,000 查询/次 | 默认 48→**200**（先别直接拉到 1,000），保留每 job 的 `COST` 预算；加 `meta.rows_read` 日志；同步改 4 个文件（6 行） | S | next.md P1 |
| 2 | 「Cloudflare 保持免费档」写成项目规则 | `AGENTS.md:16`；`docs/decisions.md:12`；`docs/review.md:10` | Free plan | Paid $5/月 | 改成「Workers Paid，仅用自带额度，不开附加项；其他服务不自动升档」；记录升级日期；保留「不自动买别的」 | XS | 文档 PR |
| 3 | 每分钟 cron 扫 `video_waits`，每次最多 5 条 | `wrangler.toml:10`；`src/fetchjobs.ts:134`；`config/team.json:90`（wait 30 秒） | Free 请求额度 + 没有 Queue 延迟消息 | Queue `delaySeconds` 最长 24h；保留 4–14 天 | 每个 wait 在 `due_at` 发一条延迟消息；cron 改成 5 分钟只做 orphan/lease 清理；延迟 30s 不变，请求降 5× | M | next.md P1 |
| 4 | fastlinks 2 秒/10 秒轮询；subagent 15 秒轮询 | `.agent/releases/V-C-links/ref/plan-fastlinks-v3.md:18`；`.agent/releases/V-B-capability/ref/plan-bot-capability-v1.md:1376` | Free 100k 请求/天，只能靠调间隔 | 10M/月，但仍不该轮询 | 改事件驱动：Queue 延迟消息 / Workflows `waitForEvent`；保留 10 秒退避作为兜底；subagent 用 Workflow 等待 | M | V-C/V-E |
| 5 | 「不上 R2、DO、KV 新资源」 | `.agent/releases/V-B-capability/ref/plan-bot-capability-v1.md:1362` | Free plan | DO 1M 请求/400k GB-s/5GB；KV 10M 读/1M 写；R2 独立 10GB 免费层 | DO 只做 per-group 串行化/租约，**必须 Hibernation**；KV 做热配置/缓存；R2 只放媒体/大文件（Standard） | M | 架构评审 |
| 6 | Workers AI 只敢用「免费」额度；贴纸仍先走 Workers AI | `.agent/releases/F6P/orders/F6P-1.md:5`；`.agent/releases/V-D-reflection-loop/notes/D-0.md:19`；`.agent/releases/V-D-reflection-loop/design.md:524` | Free 10k neurons/天，超了硬停 | Paid 仍 10k/天免费，超了 $0.011/1k | 贴纸/表情/embedding 可以继续用，但加 `budget()` 硬日预算；**judge 不要切回 Workers AI**（D-0 结论是质量不合格，不是额度不够） | S | V-D/F6P 文档 |
| 7 | Queues `max_batch_size = 1`；保留期按 24h 设计 | `wrangler.toml` 三条 queue 的 `max_batch_size = 1`；`docs/operations.md:9` | Free 24h 保留、10k 操作/天 | 4–14 天；批大小 100 | 批大小 10；`max_concurrency` 4；加 DLQ；延迟重试；保留 4 天 | S | next.md P2 |
| 8 | 没有开 Workers Logs / 没采样 | `wrangler.toml`（无 `[observability]`）；`docs/operations.md` | Free 200k/天、3 天 | 20M/月、7 天；12-01 后 50GB/10GB-month | 加 `[observability] enabled=true, head_sampling_rate=0.1`；`invocation_logs=false`；用它查问题，不要往 D1 写 debug 行 | S | next.md P2 |
| 9 | 夜间整理每批最多 60 条、最多 8 批 | `docs/maintenance.md:28` | 受 Free D1 查询预算约束 | 1,000 查询/次 | 试 120–200 条/批（先测 `rows_read`）；减少 Queue invocation；保持幂等 | S | next.md P3 |
| 10 | D1 Time Travel 按 7 天写 runbook | `docs/operations.md:15` | Free 7 天 | Paid 30 天 | runbook 改 30 天；做一次恢复演练；记住 10 次恢复/10 分钟限制 | XS | runbook |
| 11 | 只有一条「万能 cron」 | `wrangler.toml:10` | Free 最多 5 条 | 250 条 | 把 maintenance/scout/nightly 拆成独立 cron，各自 schedule；避免一条 cron 里塞所有逻辑 | S | next.md P2 |
| 12 | 没有用 Workflows | 现码无 `workflows` 绑定 | Free 1,024 步/100 并发 | 10,000 步/50k 并发/1GB 状态 | 把 `wake`/轮询改成 Workflow：`step.sleep` 到 `due_at`，`waitForEvent` 等抓取结果；sleep 不计 CPU | M | 架构评审 |

### 6.1 不因付费而改的四件事（避免误伤）

| 事项 | 为什么不是 CF 免费档的锅 | 出处 | 结论 |
|---|---|---|---|
| B 站本机 X-ASR 转写 | B 站 CDN 对 Worker 出口返回 403/567；本机才能带登录态/UA/Range 下载 | `/Users/yanghongming/Projects/TeamAgent-bili-asr-local-handoff-20261113.md:1-8` | 继续本机；CF 付费不改变 |
| B 站「看画面」 | 方案里是 DeepSeek 视觉 token 成本（约 $0.003/视频，共用 300 张/天），不是 CF 额度 | `.agent/releases/TeamAgent-inventory-docs-20261113.md:16` | 保持不做；要做先问用户模型预算 |
| Workers AI 当 judge | V-D D-0 的结论是 Workers AI 质量不合格，不是额度不够 | `.agent/releases/V-D-reflection-loop/design.md:524` | 继续 DeepSeek 首判 + OpenAI 复核；Workers AI 只做兜底 |
| GitHub Actions | 是 GitHub 私有仓库 Actions 额度/账单问题，不是 Cloudflare | `docs/verification.md:22`；团队记忆「上线不等 CI」 | 与 CF 套餐无关；要换也是换 Workers Builds（§3.1） |

> **一句话**：付费套餐解决的是「Cloudflare 侧的额度/硬停」，不解决「B 站 CDN 封锁」「模型 token 成本」「Workers AI 质量」「GitHub Actions 账单」。这四件不要混进本次改动。

---

## 7. 建议落到「下一个版本」的施工条目（可直接粘给主程/BINI）

> 下面是建议，不是我已经改的代码。优先级按「省钱 + 降风险 + 少改动」排。

| ID | 标题 | 建议施工者 | 改什么 | done_when | 量 |
|---|---|---|---|---|---|
| CF-1 | D1 预算 48→200 + 文档去「免费档」 | 工程师 | `src/d1.ts:10` 默认值改 200（最好做成 settings 可调）；`AGENTS.md:16`、`docs/decisions.md:12/27`、`docs/operations.md:22`、`docs/review.md:10/52` 同步改口径 | `npm test` 全绿；真实回放 D1 `rows_read` 不升反降；4 个文件无「免费档」残留 | S |
| CF-2 | `video_wait` 改 Queue 延迟消息 | 工程师 | `src/fetchjobs.ts:80` 的 `wakeVideoWait` 发延迟消息（`delaySeconds` 到 `due_at`）；`sweepVideoWaits` 只清 orphan/lease；`wrangler.toml:10` cron 改 `*/5 * * * *` | 30 秒等待场景延迟 ≤60 秒；cron 请求降 5×；重复 wake 0；回放全过 | M |
| CF-3 | 轮询改事件驱动 | 工程师/主程 | fastlinks 10 秒轮询改 Queue/Workflow；subagent 15 秒轮询改 `waitForEvent`；保留退避兜底 | 空闲时 0 轮询；有事件时 p95 延迟 ≤10 秒；请求数降 80% | M |
| CF-4 | 开 Workers Logs + 采样 | 交付员 | `wrangler.toml` 加 `[observability] enabled=true, head_sampling_rate=0.1`；`invocation_logs=false`；部署后看 7 天 | 日志能查 invocation/error；日条数 <2M；无 PII/密钥 | S |
| CF-5 | Queues 批处理 + DLQ | 工程师 | 三条 queue `max_batch_size=10`、`max_concurrency=4`；加 DLQ；保留 4 天 | 积压不增；重试不放大；回放 0 重复发送 | S |
| CF-6 | DO 设计评审（不急着写） | 架构师 | 只评估「per-group 串行化/租约」是否值得上 DO；必须 Hibernation；估算 GB-s | 给出「用/不用」结论 + 月度 GB-s 上限；不写常驻 DO | M |
| CF-7 | Workers Builds 替代 GitHub Actions | 交付员 | 评估 `.github/workflows` 迁移到 Workers Builds；6,000 分钟/6 并发够不够 | 本机门禁不变；PR 能跑；不依赖 GitHub Actions 额度 | M |
| CF-8 | runbook：Time Travel 30 天 + 花费上限 | 交付员/BINI | `docs/operations.md:15` 改 30 天；dashboard 设 Workers spending limit $1 + email alert；DO 单独上限 | runbook 更新；上限截图/记录；恢复演练 1 次 | XS |

**不建议现在做的**：
- 不要为了「用满额度」而上 DO/R2/Containers；TeamAgent 目前没有必须用它们的场景。
- 不要把 Workers AI 切回 judge；质量结论没有变。
- 不要开 AI Gateway 预付额度、R2 IA、Containers 常驻；Logpush 只在有明确日志外送需求时开，并设 10M/月采样上限（超出 $0.05/M）。

---

## 8. 账户侧需要做的 3 件事（我做不了，需用户/交付员）

1. **确认 Paid 生效**：dashboard → Workers & Pages → Plans（[Workers plans](https://dash.cloudflare.com/?to=/:account/workers/plans)），确认显示 Workers Paid $5/月；Billable Usage 看当前请求/CPU/D1/Queues 用量。我没有登录账户，无法核实。[W-P]
2. **设花费上限**：Workers spending limit 设 **$1**（不含 $5 月费），开 email alert；DO 单独设上限。注意上限不是精确封顶，且会中断生产 Worker，先在低峰测试。[SPEND][DO-P]
3. **设用量告警**：D1 读/写、Queues ops、Workers AI neurons、Logs GB、Browser hours 各开 dashboard 告警；阈值建议 50%/80%。这些产品没有统一的「一键硬上限」。[D1-P][Q-P][AI-P][W-LOG][BR-P]

> 另外：D-0 之前用 `GET /accounts/{id}/subscriptions` 返回 `[]` 判定 Free；**这个推断未必可靠**——`subscriptions` 为空不一定代表没有 Workers Paid（Paid 是套餐，不一定是 add-on subscription）。现在用户说已升级，应以 dashboard → Workers plans 为准，不要再用那个接口反推。[D-0 证据：`.agent/releases/V-D-reflection-loop/notes/D-0.md:15`]

---

## 9. 未核实与局限

- **没有登录 Cloudflare 账户**：所有额度/单价来自官方文档，不是你账户的实际账单或实际可用量；实际以 dashboard 为准。
- **没有跑代码/测试**：TeamAgent 的行号基于 `TeamAgent-p4b-login` HEAD `58e640b`；其他 worktree 可能不同。
- **D-0 的 `subscriptions=[]` 推断未必可靠**：见 §8；不要用它判断 Free/Paid。
- **文档冲突已标两处**：Cron/Queue CPU（§3.1）、Vectorize Free/Paid（§3.10）。
- **价格/额度会变**：Workers Logs 2026-12-01 换计价；R2/Containers 价格以页面为准；建议每月复核一次。
- **没有测量 TeamAgent 实际 D1/Queue/Logs 用量**：建议上线前从 dashboard/GraphQL 拉 7 天，按 §5 的算例对一遍。
- **「自带额度」不等于「不限速」**：还有 6 个同时连接、1,000 次 KV 操作/调用、单条 SQL 30 秒、单条日志 256 KB、5,000 msg/s/队列等硬限制，超额前可能先撞到这些。
- **B 类表只列官方单价**：没有算税费、汇率、Cloudflare 其他产品（Images、Stream、Email 等）的费用；本报告只覆盖 BINI 清单里的产品 + Containers。

---

## 10. 来源清单

| 代码 | 页面 | URL | 页面 Last updated | 本次读取 |
|---|---|---|---|---|
| [W-P] | Workers Pricing | https://developers.cloudflare.com/workers/platform/pricing/ | 2026-11-13 | 2026-11-14 |
| [W-L] | Workers Limits | https://developers.cloudflare.com/workers/platform/limits/ | 2026-11-13 | 2026-11-14 |
| [W-CRON] | Cron Triggers | https://developers.cloudflare.com/workers/configuration/cron-triggers/ | 2026-11-12 | 2026-11-14 |
| [W-LOG] | Workers Logs | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ | 2026-11-12 | 2026-11-14 |
| [OBS-P] | Observability Pricing | https://developers.cloudflare.com/observability/pricing/ | 2026-11-11 | 2026-11-14 |
| [W-BUILD] | Workers Builds Limits & Pricing | https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ | 2026-10-28 | 2026-11-14 |
| [D1-L] | D1 Limits | https://developers.cloudflare.com/d1/platform/limits/ | 2026-10-30 | 2026-11-14 |
| [D1-P] | D1 Pricing | https://developers.cloudflare.com/d1/platform/pricing/ | 2026-10-30 | 2026-11-14 |
| [Q-L] | Queues Limits | https://developers.cloudflare.com/queues/platform/limits/ | 2026-10-30 | 2026-11-14 |
| [Q-P] | Queues Pricing | https://developers.cloudflare.com/queues/platform/pricing/ | 2026-10-30 | 2026-11-14 |
| [DO-L] | Durable Objects Limits | https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-11-13 | 2026-11-14 |
| [DO-P] | Durable Objects Pricing | https://developers.cloudflare.com/durable-objects/platform/pricing/ | 2026-11-13 | 2026-11-14 |
| [KV-L] | KV Limits | https://developers.cloudflare.com/kv/platform/limits/ | 2026-10-30 | 2026-11-14 |
| [R2-P] | R2 Pricing | https://developers.cloudflare.com/r2/pricing/ | 2026-10-30 | 2026-11-14 |
| [AI-P] | Workers AI Pricing | https://developers.cloudflare.com/workers-ai/platform/pricing/ | 2026-11-12 | 2026-11-14 |
| [AI-L] | Workers AI Limits | https://developers.cloudflare.com/workers-ai/platform/limits/ | 2026-09-17 | 2026-11-14 |
| [BR-P] | Browser Run Pricing | https://developers.cloudflare.com/browser-run/pricing/ | 2026-04-21 | 2026-11-14 |
| [BR-L] | Browser Run Limits | https://developers.cloudflare.com/browser-run/limits/ | 2026-10-14 | 2026-11-14 |
| [WF-P] | Workflows Pricing | https://developers.cloudflare.com/workflows/reference/pricing/ | 2026-11-04 | 2026-11-14 |
| [WF-L] | Workflows Limits | https://developers.cloudflare.com/workflows/reference/limits/ | 2026-11-10 | 2026-11-14 |
| [VEC-P] | Vectorize Pricing | https://developers.cloudflare.com/vectorize/platform/pricing/ | 2026-10-30 | 2026-11-14 |
| [CONT-P] | Containers Pricing | https://developers.cloudflare.com/containers/platform/pricing/ | 2026-11-13 | 2026-11-14 |
| [SPEND] | Workers Spending Limits | https://developers.cloudflare.com/workers/platform/spend-management/ | 2026-11-13 | 2026-11-14 |
| [BUDGET] | TeamAgent `src/budget.ts:13` | 本地文件（只读） | — | 2026-11-14 |

---

## 11. 给 BINI 的一句话

**建议先做 CF-1（D1 预算 + 文档去「免费档」）和 CF-2（video_wait 改延迟消息）**；这两件直接拆掉「48 查询」和「每分钟扫表」两个旧绕路，改动小、可回放。CF-3/CF-5/CF-4 随后；CF-6/CF-7 先评审不施工。**B 站本机 ASR、看画面、Workers AI judge、GitHub Actions 不要混进这次改动**——它们不是 CF 免费档造成的。

<!-- 官方链接引用定义：让正文里的 [W-P] 等短码可直接点击 -->
[W-P]: https://developers.cloudflare.com/workers/platform/pricing/
[W-L]: https://developers.cloudflare.com/workers/platform/limits/
[W-CRON]: https://developers.cloudflare.com/workers/configuration/cron-triggers/
[W-LOG]: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
[OBS-P]: https://developers.cloudflare.com/observability/pricing/
[W-BUILD]: https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
[D1-L]: https://developers.cloudflare.com/d1/platform/limits/
[D1-P]: https://developers.cloudflare.com/d1/platform/pricing/
[Q-L]: https://developers.cloudflare.com/queues/platform/limits/
[Q-P]: https://developers.cloudflare.com/queues/platform/pricing/
[DO-L]: https://developers.cloudflare.com/durable-objects/platform/limits/
[DO-P]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[KV-L]: https://developers.cloudflare.com/kv/platform/limits/
[R2-P]: https://developers.cloudflare.com/r2/pricing/
[AI-P]: https://developers.cloudflare.com/workers-ai/platform/pricing/
[AI-L]: https://developers.cloudflare.com/workers-ai/platform/limits/
[BR-P]: https://developers.cloudflare.com/browser-run/pricing/
[BR-L]: https://developers.cloudflare.com/browser-run/limits/
[WF-P]: https://developers.cloudflare.com/workflows/reference/pricing/
[WF-L]: https://developers.cloudflare.com/workflows/reference/limits/
[VEC-P]: https://developers.cloudflare.com/vectorize/platform/pricing/
[CONT-P]: https://developers.cloudflare.com/containers/platform/pricing/
[SPEND]: https://developers.cloudflare.com/workers/platform/spend-management/
[BUDGET]: ./.worktrees/TeamAgent-p4b-login/src/budget.ts
