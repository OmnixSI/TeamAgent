# TeamAgent · Cloudflare 免费档「砍掉 / 降级 / 绕路」盘点

> 只读盘点：未改代码、未写线上 D1、未发群消息、未使用任何账号凭据。  
> 代码基线：`/Users/yanghongming/Projects/.worktrees/TeamAgent-F11-release`（`release/F11` @ `cc223f8`；邻近 main `f5e39c6`、`release/trip1` @ `fac8e5a`）。历史设计取自 `.worktrees/TeamAgent-p4b-login/.agent/releases/`、`/Users/yanghongming/Projects/.agent/releases/`、`TeamAgent-*.md` 与 `plan-*.md`。行号供定位，合并后可能偏移。  
> 额度来源：`/Users/yanghongming/Projects/TeamAgent-cf-paid-plan-20261114.md`（2026-11-14 03:02 生成）+ 我按官方页逐项复核（2026-11-14，见 §8）。两处官方文档冲突按更具体页取值：Cron/Queue CPU 取 Limits/Queues 页；Vectorize 标记「待确认」。  
> 关键词：免费额度、free plan、CPU 10ms/50ms、subrequest、子请求、Cron、请求数 100k、D1 行数、Queues、Durable Objects、Workers AI、KV 写、Time Travel、日志保留、绕路、降级、本机代跑、runner、分片、轮询、拆小、限流、节流、批大小、定时间隔。

## 0. 结论（8 行）

1. **真正驱动过设计改动的免费档限制只有 4 类**：D1 单次 50 查询（代码按 48 条语句算）、D1 写 10 万行/天、Workers 10 万请求/天、D1 Time Travel 7 天；付费后分别到 1,000 查询、5,000 万写/月、1,000 万请求/月、30 天。
2. **48 不是平台查询数**：官方明确 `db.batch()` 只算 1 次查询；`src/d1.ts:10` 却按每条语句计数，所以 48 是自设的保守「语句预算」。付费后不要全局开到 1,000，建议聊天/HTTP 先保持 48（实测工具被预算饿死就提到 64），`scheduled` 与后台队列放到 200。
3. **大量「免费档绕路」其实是误判或无关**：DO/R2 免费档本来可用；Workers AI 10k neurons/天付费不变；CPU 10ms 主要卡 HTTP/Cron，Queue consumer 本来就默认 30 秒；Cron 最小仍是 1 分钟；`delaySeconds` 仍最多 24 小时。
4. **B 站本机 X-ASR、看画面、Workers AI judge、GitHub Actions 都不是 CF 免费档造成的**，不要混进这次改造（详见 §5）。
5. **最值得做且风险最低**：文档真值重置、花费上限 $1 + Time Travel 30 天、Workers AI 神经预算硬闸、D1 按入口分层、outbox/视频扫描每 tick 上限。
6. **分趟**：趟 1 只做零/低行为变更的文档、配置与账户动作；趟 2 做 D1 预算分层、发送/扫描上限、视频等待改延迟消息、队列批处理；趟 3 做存储上限、夜间批量、事件驱动与评估项。
7. **不建议现在做**：常驻 DO、Containers 跑 ASR、R2 迁移、Workers AI judge 回主路、Cron 想小于 1 分钟、Logpush 全量。
8. 本文件只盘点，不包含任何已执行的代码或线上变更。

## 1. 口径：付费套餐到底多了什么

> 本节数字回填自配套报告，并与官方页核对；只列与 TeamAgent 相关的项。完整 B 类收费表见配套报告 §3–§4。

| 维度 | Free | Workers Paid（$5/月，自带） | 超出 | 对 TeamAgent 的判断 |
|---|---|---|---|---|
| Workers 请求 | 100,000/天 | 10,000,000/月 | +$0.30/百万 | 当前 cron 43,200/月 + fetcher 8,640/天，远低；2 秒轮询约 1.3M/月，仍低 |
| CPU（HTTP） | 10 ms/次 | 默认 30 秒，最大 5 分钟；30,000,000 ms/月 | +$0.02/百万 ms | 真正质变；但 128 MB 内存不变 |
| 子请求 | 50/次 | 10,000/次 | — | 不是当前瓶颈；同时连接仍 6 个 |
| D1 单次查询 | 50 | 1,000 | — | **最大解锁**；`batch()` 算 1 次，不是每条语句 1 次 |
| D1 读行 | 5M/天 | 25B/月 | +$0.001/百万行 | 全表扫描仍要防；当前量级远低 |
| D1 写行 | 100k/天 | 50M/月 | +$1.00/百万行 | 心跳/批量不再需要 30 秒节流 |
| D1 存储 | 5 GB 总量 / 单库 500 MB | 5 GB 包含 / 单库 10 GB / 账户 1 TB | +$0.75/GB-month | 表情库 400 MB 的天花板可抬到 2 GB |
| D1 Time Travel | 7 天 | 30 天 | — | 只改 runbook + 做一次恢复演练 |
| Queues | 10k 操作/天，保留 24h | 1M 操作/月，保留 4–14 天 | +$0.40/百万 | 只涨约 3.3 倍；批大小/并发可调，但 ops 按消息计 |
| Durable Objects | 100k 请求/天，13k GB-s/天 | 1M 请求/月，400k GB-s/月 | +$0.15/百万；+$12.50/百万 GB-s | **请求额度反而更低**；不要因升级而上常驻 DO |
| Workers AI | 10k neurons/天 | **仍是 10k/天** | +$0.011/1k neurons | 付费只把「硬停」变「计费」；必须加硬预算 |
| Workers Logs | 200k/天，3 天 | 20M/月，7 天 | +$0.60/百万 | 加 `[observability]` + 0.1 采样即可免费用 |
| Cron | 5 条/账户 | 250 条/账户 | — | 最小仍 1 分钟；250 条每分钟会打爆 10M 请求，别开满 |
| Containers | 无 | 25 GiB-h / 375 vCPU-min / 200 GB-h 每月 | 按秒计费 | 只能 burst；不能 24/7，也不适合 90 分钟 ASR |
| Browser Run | 10 分钟/天 | 10 小时/月 | +$0.09/小时 | 可评估替代本机 Playwright；忘记 close 会烧额度 |
| Workflows | 3k 步/天 | 500k 步/月 | +$0.80/10 万步 | 可评估替代「cron 轮询」；不是当前必需 |
| R2 | 10 GB 免费层（独立） | 同左，独立计费 | $0.015/GB-month | **不是 $5 套餐带来的**；需要时本来就能用 |
| KV | 1k 写/天 | 1M 写/月 | +$5.00/百万 | 可做热配置，但不要做秒级心跳 |

## 2. 全量盘点表

> 归因口径：**确认** = 原文明确说免费档；**确认（自设）** = 免费档是背景，但具体数字是项目自己加的保守值；**疑似** = 很可能，但没有直接文字；**无关** = 与 CF 免费档无关；**误判** = 把别的限制误套到免费档。  
> 「超额」列只判断是否会触发 Cloudflare 账单；DeepSeek/OpenAI/QQ 的费用另计。  
> 表内 `F7/...`、`V-D-reflection-loop/...`、`F6P/...` 均相对 `.worktrees/TeamAgent-p4b-login/.agent/releases/`；`plan-fastlinks-v3.md` 在 `V-C-links/ref/`（归档 `TeamAgent-archive-20261113/TeamAgent-fastlinks-p0b/.agent/plans/` 同文）；`plan-bot-capability-v1.md` 在 `V-B-capability/ref/`（归档 `TeamAgent-archive-20261113/TeamAgent-cap-c1/.agent/plans/` 同文）。

### A. D1 查询预算（最大的连锁源）

| ID | 位置 | 原文摘录 | 归因 | 付费后可以怎么做 | 量 | 风险 / 超额 |
|---|---|---|---|---|---|---|
| A01 | `src/d1.ts:10`；`docs/decisions.md:27` | `metered(e, limit = 48)`；「每次调用的 D1 语句预算为 48，`batch` 按其中的语句条数计」 | 确认（自设） | 默认 48 不动；`scheduled`/后台队列另开 200；聊天/HTTP 保持 48 | 中 | 聊天延迟、D1 单线程；无超额（<1,000 查询） |
| A02 | `src/worker.ts:1168` | 「维护查询会花掉 48 次 D1 预算，放到末尾会永远轮不到」 | 确认 | cron 单独 200 预算，日程/维护/发送不再互相饿死 | 小 | 需重排调用顺序；无超额 |
| A03 | `src/worker.ts:1011` | `... WHERE o.status='pending' ... LIMIT 5` | 确认 | 每次发送 5 → 10（`COST.send_row=10`，5×10=50 正卡 48） | 小 | QQ 限流/乱序；无超额 |
| A04 | `src/worker.ts:1239` | `... ORDER BY ... LIMIT 9` | 确认 | 每 tick 9 → 20；每个 job 独立预算，仍受 15 分钟墙钟 | 小 | 单 tick 变长；无超额 |
| A05 | `src/fetchjobs.ts:278,283` | `LIMIT 5`；`if (left(e) < 4) break;` | 确认 | 每 tick 5 → 15；`left(e)<4` 保留不变（给故障路径留余量） | 小 | 重复唤醒；无超额 |
| A06 | `src/fetchjobs.ts:348,358` | `waiters.slice(0, 3)`（只截 `stage()` 诊断，实际 wake 在下一行遍历全部） | 无关（诊断截断） | 不是 D1 上限；要看全部等待者就把 3 去掉，或保留 3 以免 `stage_timings` 太吵 | XS | 无；不要误当预算 |
| A07 | `src/mediajobs.ts:135` | `waiters.slice(0,3)` + `left(e)<4` | 确认 | 3 → 10 | 小 | 本机 ASR 并发；无超额 |
| A08 | `src/timing.ts:22` | `tail.timing.splice(0).slice(0, 22)` | 确认（自设） | 22 → 60–100；诊断更完整 | 小 | D1 多写几行；无超额 |
| A09 | `src/schedules.ts:328` | `if (left(e) < 24) return;` | 确认 | cron 200 后不再被摘要饿死；保留 24 作为单任务门槛 | 小 | 同 tick 多摘要；无超额 |
| A10 | `src/kb.ts:112`；`F7/notes/F7-10.md:15,36` | 「400-chunk document stays under the 50-query invocation budget (25 + 20 + 1 statements)」；「400 块按 D1 的 100 参数上限合并成 25+20+1 条语句」 | 确认 | 单文档 400 → 2,000 块；单群 20,000 → 50,000 块；按 100 参数分批 | 中 | 大文档入库变长；5 GB 存储内无超额 |
| A11 | `F7/notes/F7-3.md:8` | 「500 条 = 10 次 rowid 查询（每批 50）… 仍低于 D1 50 查询上限」 | 确认 | 单次历史 500 → 2,000 条；摘要 map 仍 100/批 | 中 | 上下文/模型 token；无 CF 超额 |
| A12 | `F7/notes/F7-9.md:55` | 「低于 D1 单次 50 查询上限」 | 确认 | 语音 outbox `LIMIT 5` → 20 | 小 | QQ 语音发送限流；无超额 |
| A13 | `docs/verification.md:50` | 「20项独立检查及恢复均在单次免费D1的50查询以内」 | 确认 | 保留 48 作为回归上限，不强行放大；新增后台路径单独测 | 小 | 无；作为回归门槛 |
| A14 | `docs/maintenance.md:28`；`config/team.json:31-32` | 「批大小受免费D1查询预算约束」；`batches_per_night: 8`、`messages_per_batch: 60` | 确认 | 每批 60 → 120（先测 `rows_read`/token）；夜批仍 8 | 小 | 模型 token/上下文；无 CF 超额 |
| A15 | `docs/maintenance.md:105-109` | 「上限 48 为故障路径保留两条」；「不准通过调高 48 或调低常量掩盖超限」 | 确认 | 改成「按入口分层，聊天 48（实测不够可 64）/ 后台 200；仍不准用调常量掩盖慢查询」 | 小 | 文档与测试同步；无超额 |
| A16 | `TeamAgent-capability-ledger-20261114.md:26`；`src/semantic.ts:982`（旧 880） | 「21:17 那轮 D1 预算低，工具被 `src/semantic.ts:880` 的 `left(e) >= COST.turn*2+COST.tool+COST.tail` 关掉；F5c `f6bcaba` 已改，未合并」 | 确认 | 真实用户可见后果：问「最新陪玩店」时 repo 工具被预算关掉，只回「没拿到 repo_changes」。F5c 的 `REPO_ASK_FLOOR=16` 已在 F11-release；付费后建议聊天 48→64 做 A/B，确认工具不再被饿死 | 小 | 聊天延迟；无超额 |

### B. Workers 请求、轮询与队列

| ID | 位置 | 原文摘录 | 归因 | 付费后可以怎么做 | 量 | 风险 / 超额 |
|---|---|---|---|---|---|---|
| B01 | `plan-fastlinks-v3.md:18`（归档 `TeamAgent-fastlinks-p0b`） | 「按 Cloudflare 免费档计算：Workers 10 万请求/天，D1 写入 10 万行/天，Queues 1 万次操作/天，每次调用最多 50 条查询」 | 确认 | 这份预算表整体作废；按 10M 请求/50M 写/1M ops 重算 | 小 | 重新测算；无超额 |
| B02 | `plan-fastlinks-v3.md:209` | 「每天写入从 8,640 行降到 2,880 行（免费档上限 10 万行）」 | 确认 | 可以恢复 10 秒心跳；但 30 秒已够 120 秒离线阈值，收益低 | 小 | 无；P3 |
| B03 | `plan-fastlinks-v3.md:472,492-495` | 「Queues 用量（免费档 1 万次操作/天）」；「空闲时每天 8,640 次请求，占 10 万的 8.6%」 | 确认 | 事件驱动替轮询；保留 10 秒退避兜底 | 中 | 无超额；Queue ops 仍按消息计 |
| B04 | `plan-bot-capability-v1.md:1204` | 「Cloudflare 保持免费档：不上 R2、DO、KV 新资源」 | 疑似 / 部分无关 | 不要为了「用满」而上；DO 只在 per-group 串行化/租约有明确收益时评估，必须 Hibernation | 中 | DO duration 最易超额；见 §6 |
| B05 | `plan-bot-capability-v1.md:1218` | 「Workers 免费额度（每天 10 万次请求）… 加上 fastlinks P3 的 2 秒轮询（约 4.3 万次），仍在额度内」 | 确认 | 2 秒主动轮询可以开；但更优是 Queue/DO 事件唤醒 | 小 | CPU/请求上升；无超额（1.3M/月） |
| B06 | `runner/fetcher.mjs:240` | `if(!job){await sleep(10000);continue;}` | 确认 | 活跃期 2 秒、空闲 10 秒；或 Queue/DO 唤醒 | 小 | B 站风控；无超额 |
| B07 | `runner/bridge.py:289,305` | `time.sleep(30)` / `time.sleep(15)` | 疑似 | 15 秒 → 5 秒，仅在有任务时；空闲保持 30 秒 | 小 | 本机 CPU；无超额 |
| B08 | `wrangler.toml:10` | `crons = ["* * * * *"]` | 无关 | 可拆成多条 cron（视频 5 分钟、夜间 03:00、日常 1 分钟）；但最小仍 1 分钟 | 小 | 250 条每分钟 = 10.8M/月，会超额；只用几条 |
| B09 | `wrangler.toml:16-18,26-28,39-41` | `max_batch_size = 1`；`max_concurrency = 1/2` | 无关 | WORK/TOOLS 批 5–10、并发 3–4；CHAT 保持 1 保延迟 | 中 | D1 单线程/15 分钟墙钟；无超额 |
| B10 | `docs/operations.md:9` | 「三条免费队列；聊天消费者并发1，工具消费者并发2，深度工作消费者并发2，batch size1」 | 确认 | 同上；队列本身免费档就有，付费只抬 ops/保留期 | 小 | 无 |

### C. CPU、内存与视觉

| ID | 位置 | 原文摘录 | 归因 | 付费后可以怎么做 | 量 | 风险 / 超额 |
|---|---|---|---|---|---|---|
| C01 | `TeamAgent-luna-vision-research-20261114.md:53-56` | 「Workers Free 10 ms CPU/调用、128 MB 内存、50 subrequests/调用」；「若真是 10 ms 上限，5 MB 图必挂 1102；若是 30 s consumer，则没事」 | 误判（部分） | 付费后 HTTP 30 秒/Queue 30 秒；5 MB 图 CPU 可行；但 128 MB 不变，3 张并行仍要串行/降上限 | 小 | 内存 1102；无超额 |
| C02 | `TeamAgent-c1b-cloud-read-plan-review.md:6` | 「误套HTTP的10ms到群聊：真实入口…为Queue消费者，官方免费/付费消费者默认CPU为30秒。须按入口分开验收」 | 误判 | 把这条写进评审规则：CPU 按入口（HTTP/Queue/Cron）分别验收，不再用 10 ms 一刀切 | 小 | 无；文档/测试口径 |
| C03 | `src/vision.ts:389`；`:142-143` | `if (bytes.length > 5_000_000) throw new VisionFault("oversize")`；`b64` 已按 32 KB 分块 | 确认（自设） | 5 MB 上限可保留；若要三图并行，降到 1.5–2 MB 或串行；不要因付费放松 128 MB | 小 | OOM；无超额 |
| C04 | `TeamAgent-image-gen-probe-20261114.md:288,303-307` | 「单次 fetch 要 30–90 s（现有 20 s 超时必须放大）」「1.4 MB 图 base64 约 1.9 MB 内存（Workers 128 MB 够）」「Queue 消息保留：付费版最多 14 天，免费版 24 h」 | 无关（主要是外部 API 时长） | 生图仍走 Worker 直调 OpenAI；付费套餐不改变 OpenAI 账单；Queue 保留期可放宽但 `delaySeconds` 仍 24h | 中 | OpenAI $3/日预算；无 CF 超额 |
| C05 | `docs/maintenance.md:101` | 「QQ 拒绝引用的真实码型、外部请求与 D1 子请求配额仍需线上日志核验」 | 确认（待核） | 付费后子请求 10,000，不再是风险；引用码型仍需线上核验 | 小 | 无；可删这条旧顾虑 |

### D. Workers AI

| ID | 位置 | 原文摘录 | 归因 | 付费后可以怎么做 | 量 | 风险 / 超额 |
|---|---|---|---|---|---|---|
| D01 | `V-D-reflection-loop/notes/D-0.md:11,19` | 「当前 Free 7000 neurons…若未来是 Paid，降至 6000，但…6000 本身不保证零费用」；「Paid 同样有免费额度，超出以 $0.011/1000 neurons 计费」 | 确认 | 保留 10k/天硬预算；不要把 10k 当「付费后变大」；judge/OCR 与 vision 共用 | 小 | **最容易静默计费**；见 §6 |
| D02 | `V-D-reflection-loop/design.md:805` | 「Workers AI 免费额度不够、计费或权限不足 … v2：已不在主路」 | 确认 | 不因付费切回主路；如要复测，先做质量门禁 + 6k/天预算 | 中 | 质量不合格 + 计费；不建议 |
| D03 | `V-D-reflection-loop/design.md:524` | 「Workers AI 质量不合格（D-0）；改为首判 DeepSeek + 复核 OpenAI…Workers AI 留作复测后的兜底」 | 无关（质量） | 付费不改变质量结论；保持 DeepSeek 首判 | 小 | 无 |
| D04 | `F6P/orders/F6P-1.md:5` | 「贴纸/表情（meme 粗分类、低价值图）仍先 Workers AI（免费），失败再走链」 | 确认 | 继续用，但加 neurons 日预算；超了返回 `budget`，不要落到付费 | 小 | 计费；见 §6 |
| D05 | `F6/notes/F6-7.md:18-20` | 「免费档保持，不新增 key、不升付费档」；「budget 等免费额度恢复」 | 确认 | 删除「免费档保持」；改成「Paid 10k/天硬预算，超了不调用」 | 小 | 无 |
| D06 | `config/team.json:95` | `"daily_cap": 300` | 确认（自设） | 300 张/天与 10k neurons 可能擦边；改成 neurons 预算（如 8k/天）+ 张数双闸 | 小 | 计费；见 §6 |
| D07 | `TeamAgent-capability-frontier-20261114.md:15,64,558-561` | 「Workers AI 每天 10,000 Neurons 免费」；「文生图 … flux-1-schnell … 免费额度内；超出按量」 | 确认 | 可作为 OpenAI 生图的低成本替代（质量待验）；仍受 10k/天限制 | 中 | 质量/计费；非本版 |

### E. 存储、保留期与日志

| ID | 位置 | 原文摘录 | 归因 | 付费后可以怎么做 | 量 | 风险 / 超额 |
|---|---|---|---|---|---|---|
| E01 | `docs/operations.md:15` | 「D1免费档另有7天Time Travel」 | 确认 | runbook 改 30 天；做一次恢复演练（10 次/10 分钟限制） | 小 | 无 |
| E02 | `docs/maintenance.md:128`；`config/team.json:131` | 「总量最多 1000 行、单张最多 400000 字节」；`"max_rows": 1000` | 疑似（强） | 1,000 → 5,000 行（约 2 GB）；仍受单库 10 GB / 账户 5 GB 包含 | 中 | 超 5 GB 才收费；需清理策略 |
| E03 | `TeamAgent-image-gen-probe-20261114.md:307` | 「Queue 消息保留：付费版最多 14 天，免费版 24 h」 | 确认 | 可把长重试/积压保留到 4 天；但 `delaySeconds` 仍最多 24h，不能排 3 天后的任务 | 小 | 无；别误解保留期 |
| E04 | `wrangler.toml`（无 `[observability]`）；`docs/operations.md:74` | 采样最多 7 天、模型指标 30 天；当前无 Workers Logs 配置 | 无关（没开） | 加 `[observability] enabled=true, head_sampling_rate=0.1`；`invocation_logs=false`；7 天免费 | 小 | 日志含 PII/密钥；必须脱敏；20M/月内无超额 |
| E05 | `README.md:70` | 「创建 D1、三条免费档 Queues」 | 确认 | 改成「三条 Queues（Paid 自带 1M ops/月）」 | 小 | 无 |

### F. 文档真值（跨条目，必须一起改）

| ID | 位置 | 原文摘录 | 归因 | 付费后可以怎么做 | 量 | 风险 / 超额 |
|---|---|---|---|---|---|---|
| F01 | `AGENTS.md:16` | 「Cloudflare 保持免费档；D1 每次调用最多 50 查询…不得自动购买服务或升档」 | 确认 | 改成「Cloudflare Workers Paid（$5/月）已购；只用自带额度，不开附加项；D1 按入口 48/200 预算」 | 小 | 所有 agent 的行为前提；无 |
| F02 | `docs/decisions.md:12` | 「Cloudflare 免费档优先；不新购云主机、不自动升级费用」 | 确认 | 改成「Workers Paid 已购；不新购其他云主机、不开附加项/不自动升到更高档」 | 小 | 无 |
| F03 | `docs/review.md:10` | 「保持免费档，不自动升档；模型 API 另计」 | 确认 | 同上；补一句「模型 API 与 CF 分开计费」 | 小 | 无 |
| F04 | `docs/maintenance.md:50` | 「Cloudflare保持免费档…没有更改组织账单或提高预算」 | 确认 | 改成「2026-11-14 已升级 Workers Paid $5/月；未开附加项」 | 小 | 无 |
| F05 | `docs/operations.md:22` | 「保留免费档，不运行付费升级命令。D1单次调用最多50查询…」 | 确认 | 改成「已购 Paid；D1 单次 1,000 查询，但应用按入口 48/200；Time Travel 30 天」 | 小 | 无 |
| F06 | `deploy-runbook.md:223` | 「D1 免费档额度…不要执行任何升档/付费命令」 | 确认 | 改成「已购 Paid；不要开附加项/更高档；部署命令不变」 | 小 | 无 |
| F07 | `src/guide.ts:86` | 「免费额度内没有额外云主机账单…不会自动升级 Cloudflare 付费档」 | 确认 | 用户可见文案改成「Cloudflare 已用 $5/月套餐；只含自带额度，不会自动加购」 | 小 | 无 |
| F08 | `docs/review.md:52` | 「分散查询可能超过免费 D1 每次50查询…避免以付费升档掩盖问题」 | 确认 | 改成「按入口 48/200；仍不允许用放大预算掩盖慢查询」 | 小 | 无 |

> 未进前 10 的条目怎么放：F 组全部随 CF-0 进趟 1；A13 是回归门槛，不改行为；A06 只是诊断，不必改；B02/B10/E03 收益低，放 P3/观察；W 组不进趟；其余按 §4 的趟 2/3 归并。

## 3. 前 10：按「对用户价值高、风险低」排序

> 趟号按现有 `trip0/trip1` 顺延：**趟 1 = `release/trip1`（审查中）**；**趟 2 = F11 及其后的下一趟**；**趟 3 = 再下一趟**。若 BINI 的编排不同，按内容挪，不按编号锁死。

### 1. CF-0 文档真值重置（趟 1，XS，零风险）

- **为什么**：现在 `AGENTS.md:16` 还写着「保持免费档、50 查询、不得升档」，每个 agent 开工都会按 48/50 设计；不改这条，后面所有改造都会被旧规则拉回去。
- **改哪里**：`AGENTS.md:16`、`docs/decisions.md:12,27`、`docs/review.md:10,52`、`docs/maintenance.md:28,50,105,109`、`docs/operations.md:9,15,22`、`docs/verification.md:50`、`README.md:70`、`src/guide.ts:86`、`deploy-runbook.md:223`；`docs/c3-runner.md:46` 的「D1 每次 ≤48」也改成「按入口」。
- **怎么改**：保留「不自动加购/不开附加项」；把「免费档」换成「Workers Paid $5/月，2026-11-14 起」；把「50 查询」换成「平台 1,000/次，应用聊天 48、后台 200」；把「7 天 Time Travel」换成 30 天。
- **done_when**：`rg -n "免费档|免费额度|50 查询|每次 50|保持免费"` 在 `AGENTS.md`/`docs`/`README`/`src/guide.ts` 里只剩「历史记录」或「已升级」的说明；`npm run check` 绿。
- **风险/超额**：无。唯一风险是文档与测试口径不一致；先改文档，再改预算。

### 2. CF-8 账户护栏：花费上限 $1 + Time Travel 30 天 + 告警（趟 1，XS，零代码）

- **为什么**：$5 套餐是「自带额度 + 超额按量」，不是无限；最容易超的是 Workers AI、DO duration、Containers、Logs 全量。先上护栏，再改代码。
- **做什么**：Cloudflare Dashboard → Workers spending limit 设 **$1**（不含 $5 月费）+ email alert；DO 单独设上限；D1 读/写、Queues ops、Workers AI neurons、Logs GB 各开 50%/80% 告警。`docs/operations.md:15` 改 30 天，做一次 D1 恢复演练。
- **注意**：spending limit 不是精确封顶，达到后会拒绝新 invocation（HTTP 1103），可能中断生产；先在低峰测试。它只覆盖 Workers 请求+CPU，不覆盖 D1/Queues/DO/KV/R2/AI/Browser。
- **done_when**：dashboard 截图/记录上限与告警；恢复演练记录；runbook 更新。
- **风险/超额**：这是防超额动作；本身无费用。

### 3. CF-AI Workers AI 神经预算硬闸（趟 1/2，S，防超额）

- **为什么**：付费后 10k neurons/天**没有变多**，只是从「硬停」变成「计费」。当前 `config/team.json:95` 是 300 张/天，`src/vision.ts:494` 只按张数扣 `budget(e,"vision",300)`，没有 neurons 预算；贴纸/表情还优先走 Workers AI（`F6P/orders/F6P-1.md:5`）。300 张接近 10k/天，付费后会静默扣费。
- **怎么做**：在 `src/vision.ts` 的 `describeBytesOnce` 前增加 `budget(e, "workers_ai_neurons", 8000)`（复用 `src/budget.ts:13` 的原子日计数器）；按模型单价估算每次 neurons（vision 约 20–35/张；70B judge 约 200/次），预扣、失败退回；超了返回 `provider_cap`/`budget`，不调用模型。把 `daily_cap` 从 300 降到与 neurons 预算匹配的值（或保留 300 作为上限，neurons 先到先停）。
- **注意**：`budget()` 本身是 1 次 D1 写，不要在每个热路径请求前都调用；按图/按批调用，或用内存+定期落库。
- **done_when**：单测覆盖「第 N 张后返回 budget，不调用 AI」；真实 10 张图跑一遍，`model_usage`/`budget` 计数与 API 返回的 `neurons` 误差 <10%；超限时群回复「今天看图额度用完了」，不是报错。
- **风险/超额**：防止超额；若预算设得太低会提前停止看图，可调。

### 4. CF-1 D1 按入口分层：聊天 48 / 后台 200（趟 2，M）

- **为什么**：`src/d1.ts:10` 的 48 是全局默认；但真正卡住的是 outbox（5×10=50）、视频扫描（5 条）、pending（9 个）、KB（400 块=46 条）。平台已给 1,000 查询/次，后台没必要继续 48；聊天路径继续 48 可以保住延迟。A16 是真实事故：21:17 问「最新陪玩店」时 repo 工具被 `left(e)` 关掉，用户只看到「没拿到 repo_changes」。
- **怎么做**：`metered(e, limit=48)` 不改；在 `src/worker.ts:2501` 的 `queue()` 里按 `batch.queue` 选 48/200（`inkboard-team-chat` 48，`inkboard-team`/`team-agent-tools` 200，避免每条消息多查一次 job kind）；`scheduled()` 用 200；`fetch()` 保持 48。聊天队列先 48，若回放仍出现工具被预算关掉（A16），提到 64。`sendOutbox(e, limit=5)` 增加参数，scheduled 传 10；`sweepVideoWaits`/`pending` 的 LIMIT 用参数，scheduled 传 15/20。`src/kb.ts` 的 `KB_MAX_CHUNKS_PER_DOC` 400 → 2,000，`KB_MAX_CHUNKS_PER_GROUP` 20,000 → 50,000（配置可调）。
- **测试**：保留 `test/fastlinks-budget.test.mjs` 的 ≤48 聊天断言；新增 `test/background-budget.test.mjs` 断言 scheduled/后台 ≤200；用 462 条真实夹具回放，比较改前/改后 `rows_read`、`rows_written`、P50/P95。
- **done_when**：聊天 B3/B4 仍 ≤48；scheduled 全路径 ≤200；outbox 一次发 10 条不重复；视频 15 条/ tick 不重复唤醒；`npm test` 全绿；真实回放 QQ 发送 0、线上 D1 写 0。
- **风险/超额**：D1 单线程，200 条语句可能让单次 invocation 变慢；先加 `meta.rows_read` 日志，分批观察。无超额（<1,000 查询；读行远低于 25B/月）。

### 5. CF-2 outbox / pending / 视频扫描每 tick 上限（趟 2，S/M）

- **为什么**：`src/worker.ts:1011` 的 `LIMIT 5` 与 `COST.send_row=10` 正好 50 条，是 48 预算的直接产物；积压时每秒只发 5 条，用户会看到延迟。`src/fetchjobs.ts:278,283` 每次只扫 5 条，视频等待在高峰会排队。
- **怎么做**：`sendOutbox(e, 10)`；`pending` 9 → 20；`sweepVideoWaits` 5 → 15；`src/mediajobs.ts:135` 的 media waiters 3 → 10。`src/fetchjobs.ts:348,358` 的 `slice(0,3)` 只是诊断事件，不要当预算改。保留 `left(e)` 检查与幂等键；不要一次发 50 条（QQ 限流/乱序）。
- **done_when**：积压 50 条时 5 个 tick 内发完（改前 10 个）；视频 30 条等待在 3 个 tick 内唤醒；无重复发送；QQ 真实发送计数与 outbox 一致。
- **风险/超额**：QQ 限流；D1 语句数上升但在 200 内；无 CF 超额。

### 6. CF-3 视频等待改 Queue 延迟消息 + 独立 5 分钟 video cron（趟 2，M）

- **为什么**：现在 `startVideoWait` 只写 `video_waits`，靠 `wrangler.toml:10` 的每分钟 cron 扫表；30 秒的等待可能变成 60–90 秒才回。付费后 Queue `delaySeconds` 可以精确到 `due_at`，cron 只做 orphan/lease 清理。
- **怎么做**：`src/fetchjobs.ts:97` 的 `startVideoWait` 在插入 `video_waits` 后，向 `WORK` 发一条 `{kind:"video_deadline", wait:id}` 的延迟消息（`delaySeconds = ceil((due_at-now)/1000)`，范围 1–86400）；`wakeVideoWait` 加 `video_deadline` 分支；`sweepVideoWaits` 只保留 lease/orphan 清理。**不要直接把唯一的主 cron 改成 5 分钟**（会影响聊天发送）；新增一条 `*/5 * * * *` 的 video cron，主 cron 保持 1 分钟，按 `controller.cron` 分支。
- **测试**：30 秒等待 P95 ≤ 45 秒；重复唤醒 0；消息丢失时 cron 兜底；`video_waits` 仍是权威。
- **done_when**：真实 B 站视频回放，`bili_wait_start → fetch_claimed` P50 ≤ 5 秒、P95 ≤ 45 秒；视频扫描的 cron 工作量降 5×（主 cron 仍 1 分钟）；QQ 发送 0、线上 D1 写 0。
- **风险/超额**：Queue ops 每条等待约 3 次；100 条/天=300 ops，远低 1M/月；无超额。注意 `delaySeconds` 上限仍是 24h。

### 7. CF-5 Queues 批处理 + 并发 + DLQ（趟 2，S/M）

- **为什么**：`wrangler.toml` 三条队列全是 `max_batch_size=1`、并发 1/2；每条消息一次 invocation，Worker 请求/CPU 被放大。付费后可以批 5–10、并发 3–4，但 D1 单线程要防过载。
- **怎么做**：`WORK`/`TOOLS` 改 `max_batch_size=5`、`max_concurrency=3`；`CHAT` 保持 1（延迟优先）；加 DLQ（`max_retries=2` 后进 DLQ，不无限重试）；保留 4 天。`queue()` 已按每条消息独立 `metered`，批处理不会共享 48/200 预算。
- **测试**：批 5 时 5 个 job 都处理、`sendOutbox` 只一次；重试不重复发送；15 分钟墙钟内完成；D1 `rows_read` P95 不升。
- **done_when**：积压 100 条时清空时间减半；无重复；DLQ 有告警；`npm test` 全绿。
- **风险/超额**：D1 并发升高可能 overloaded；先 3 并发观察。Queue ops 不因批大小减少（按消息计），1M/月内无超额。

### 8. CF-4 Workers Logs + 0.1 采样（趟 1，S）

- **为什么**：`wrangler.toml` 没有 `[observability]`；现在排障靠 `wrangler tail`（实时，断开就没），事故复盘缺 7 天记录。付费后 20M 事件/月、7 天，免费档只有 3 天/200k/天。
- **怎么做**：`wrangler.toml` 加：
  ```toml
  [observability]
  enabled = true
  head_sampling_rate = 0.1
  [observability.logs]
  invocation_logs = false
  ```
  只打结构化关键字段；`console.log` 不打印 payload/密钥/完整异常。
- **done_when**：部署后 Workers Logs 能查 invocation/error；月条数 <2M；`rg` 日志样本无 token/手机号/群原文。
- **风险/超额**：0.1 采样下 10M 请求约 2M 日志/月，低于 20M；若开 1.0，10M×2=20M 正好打满，3 条/请求就超。无超额（按 0.1）。

### 9. CF-6 表情库 / KB 容量（趟 3，M）

- **为什么**：`docs/maintenance.md:128` 表情库 1,000 行 × 400 KB = 400 MB，已经接近免费单库 500 MB；`src/kb.ts:112` 400 块/文档是 50 查询预算的直接产物。付费后单库 10 GB、账户 5 GB 包含、单次 1,000 查询，可以抬到 5,000 行 / 2,000 块。
- **怎么做**：`config/team.json:131` `max_rows` 1,000 → 5,000；`KB_MAX_CHUNKS_PER_DOC` 400 → 2,000，`KB_MAX_CHUNKS_PER_GROUP` 20,000 → 50,000；入库仍按 100 参数分批；加「库满清理 30 天前单人候选」的同样策略。
- **done_when**：5,000 行表情库导入不超时；2,000 块文档一次入库 ≤200 条语句；D1 存储 <5 GB；查询 P95 不升。
- **风险/超额**：5,000×400 KB=2 GB + 现有消息/KB 按约 1 GB 估，仍在 5 GB 包含内；超过 5 GB 才 $0.75/GB-month。BLOB 读取内存要逐张，不能一次全取。

### 10. CF-7 夜间批次 60 → 120 + timing 22 → 60（趟 3，S）

- **为什么**：`config/team.json:31-32` 夜批 8×60=480 条/夜，是 `docs/maintenance.md:28` 明说的「受免费 D1 查询预算约束」；`src/timing.ts:22` 只留 22 条阶段事件，长回合的工具轨迹会被截。付费后 200/1,000 查询可以放宽。
- **怎么做**：`messages_per_batch` 60 → 120（先跑 3 晚，测 `rows_read` 和 DeepSeek token）；`batches_per_night` 保持 8；`timing` 22 → 60；`stage_timings` 清理仍 7 天。
- **done_when**：3 晚回放无重复/漏批；每批 `rows_read` < 1M；`stage_timings` 能覆盖完整工具链；D1 写 <50M/月。
- **风险/超额**：模型 token 成本上升（DeepSeek，不是 CF）；D1 写在额度内；无 CF 超额。

### 候补（不进前 10，先评估）

- **CF-9 fetcher 活跃期 2 秒轮询**：`runner/fetcher.mjs:240` 现在固定 10 秒；付费后 10M 请求/月够 2 秒轮询（约 1.3M/月），可把 B 站 `fetch_claimed` 的 P50 从 ≤10 秒降到 ≤2 秒。风险是 B 站风控/CPU；先只在一个群灰度。量 S，趟 3。
- **CF-10 Workflows / Browser Run / Containers 评估**：Workflows 可把 `video_wait`/轮询改成 `step.sleep`（500k 步/月）；Browser Run 可替代本机 Playwright 做登录态检查（10 小时/月，必须 `finally close`）；Containers 只能 burst（25 GiB-h/375 vCPU-min，约 6.25 小时 4 GiB 容器/月），**不够跑 90 分钟 ASR 的日常量**。三项都先写评估，不直接施工。量 M/L，趟 3。
- **CF-11 短语音/短音频走 Workers AI Whisper**：`@cf/openai/whisper-large-v3-turbo` 46.63 neurons/分钟，10k/天约 214 分钟/天；只适合短语音/短片段，90 分钟 B 站音频仍需本机 ffmpeg + X-ASR。先验证 Workers AI 是否接受 QQ 语音的 OGG/Opus、单次输入上限与计费；不替代本机主路。量 M，待验证。

## 4. 分趟建议

| 趟 | 内容 | 为什么现在/不现在 |
|---|---|---|
| **趟 1**（`release/trip1`，审查中） | CF-0 文档真值重置；CF-8 花费上限/Time Travel/告警；CF-4 Workers Logs（只加 config）；CF-AI 预算硬闸（若测试简单，放趟 2 更稳） | 零/低行为变更，不会打乱 trip1 的 F9DS/F6P/V-C 审查；先把「所有人按 50 查询设计」的前提拆掉 |
| **趟 2**（F11 之后） | CF-1 D1 按入口 48/200；CF-2 outbox/扫描上限；CF-3 视频等待延迟消息；CF-5 队列批处理/并发/DLQ；CF-AI 预算硬闸（若趟 1 未做） | 都需要回放与并发测试，放在 trip1 合并后、F11 施工前/并行更安全 |
| **趟 3**（再下一趟） | CF-6 表情/KB 容量；CF-7 夜批 120 / timing 60；CF-9 fetcher 2 秒活跃轮询；CF-10 Workflows/Browser/Containers 评估 | 收益偏体验/容量，风险中等；等趟 2 的预算分层稳定后再做 |
| **不进趟** | 常驻 DO、Containers 跑 ASR、R2 迁移、Workers AI judge 回主路、Logpush 全量、Cron 小于 1 分钟、开 AI Gateway 预付/附加项 | 要么不是 CF 免费档问题，要么额度/账单风险高，见 §5–§6 |

**趟 1 的具体文档清单（可直接派给工程师，XS）**：

1. `AGENTS.md:16`：改「免费档/50 查询/不得升档」→「Workers Paid $5/月已购；只用自带额度，不开附加项；D1 聊天 48、后台 200」。
2. `docs/decisions.md:12,27`：同上；27 条保留「48 是聊天路径预算」，加「后台 200」。
3. `docs/review.md:10,52`：同上；52 条改成「按入口预算，仍不允许用放大预算掩盖慢查询」。
4. `docs/maintenance.md:28,50,101,105,109`：删「批大小受免费 D1 约束」「没有提高预算」「不准调高 48」的旧口径；保留「先测再调」。
5. `docs/operations.md:9,15,22`：三条队列改「Paid 1M ops/月」；Time Travel 30 天；D1 1,000 查询/次但应用 48/200。
6. `docs/verification.md:50`：把「免费 D1 50 查询」改为「聊天 48 / 后台 200 的回归上限」。
7. `README.md:70`、`src/guide.ts:86`、`deploy-runbook.md:223`：用户可见/部署口径同步。
8. `docs/c3-runner.md:46`、`docs/fastlinks-p0a.md:28`、`docs/fastlinks-p0b.md:19`：把「D1 每次 ≤48」改成「聊天 ≤48；后台 ≤200」。

## 5. 不因付费而改的清单（白改/误判）

> 这一节是为了防止「升级了就把所有旧绕路都翻一遍」造成无谓改动。每条都给出原文。

| ID | 事项 | 为什么不是 CF 免费档 | 出处 | 结论 |
|---|---|---|---|---|
| W01 | B 站本机 X-ASR 转写 | 本机 CDN 567/403 是 UA/Range 问题，修完后本机可下；Worker 出口未实测；X-ASR 是本机 1.3 GB 模型，Worker 装不下；用户明确偏好 X-ASR | `TeamAgent-bili-asr-local-handoff-20261113.md:6-8`；`bili-asr-cdn-fixed-20261113.md:3`；`plan-bili-video-v1.md:7,19,23` | 继续本机；付费不改变。**配套报告「Worker 出口 403/567」在仓库里找不到实测，不能当结论** |
| W02 | B 站「看画面」 | 方案里是 DeepSeek 视觉 token 成本（约 0.003 澳元/视频，约 $0.002 美元，共用 300 张/天），不是 CF 额度；用户默认选 B（必须免费） | `plan-bili-video-v1.md:479-542`；`TeamAgent-inventory-docs-20261113.md:16` | 保持不做；要做先问用户模型预算；付费套餐不覆盖 DeepSeek |
| W03 | Workers AI 当 judge | V-D D-0 的结论是**质量不合格**，不是额度不够；付费不改变模型质量 | `V-D-reflection-loop/design.md:524,805`；`V-D-reflection-loop/notes/D-0.md:11,19` | 继续 DeepSeek 首判 + OpenAI 复核；Workers AI 只做兜底 |
| W04 | GitHub Actions / CI | 是 GitHub 私有仓库 Actions 额度/账单问题，不是 Cloudflare；$5 套餐不会恢复 GitHub Actions | `docs/verification.md:22`；`deploy-runbook.md:7` | 与 CF 无关。若要用 CF，另评 Workers Builds（6,000 分钟/月），不是免费档修复 |
| W05 | QQ 官方网关必须本机 | 官方 SDK 长连接、本机 spool、session 恢复；Worker 不能持常驻 Node 进程 | `docs/operations.md:24-40`；`docs/review.md:9` | 不是 CF 限制；付费不改变 |
| W06 | D1 单条 100 个绑定参数 | 平台硬限制，付费不变 | `src/d1.ts:1-5`；D1 Limits | 继续 90/批；与免费档无关 |
| W07 | Workers 128 MB 内存 | 付费不变 | Workers Limits | 视觉 5 MB×3 仍要串行/降上限；不要因 CPU 放宽而忽略内存 |
| W08 | 同时 6 个出站连接 | 付费不变 | Workers Limits | 3 张图=6 连接，已到顶；更多图要串行 |
| W09 | Cron 最小 1 分钟 | 付费不变；只是条数 5→250 | Cron Triggers | 不能靠 Cron 做 30 秒精度；用 Queue `delaySeconds` 或 DO alarm |
| W10 | Queue `delaySeconds` 最多 24 小时 | 付费不变；保留期 4–14 天不等于可延迟 14 天 | Queues Limits | 3 天后的提醒只能用 D1 `due_at` + cron，不能发 3 天延迟消息 |
| W11 | R2 / DO 免费档本来可用 | R2 有独立 10 GB 免费层；DO 免费档支持 SQLite；付费 DO 请求额度反而更低（1M/月 vs 100k/天） | R2 Pricing；DO Pricing | 不要为了「用满」而上；只有明确收益才评估 |
| W12 | 生图用 OpenAI | OpenAI 账单，不是 CF；Workers AI flux 可做低成本替代，但质量待验 | `TeamAgent-image-gen-probe-20261114.md:27,307`；`TeamAgent-capability-frontier-20261114.md:64,558` | 不是免费档问题；可另做成本优化，不混进本次 |
| W13 | Meta Llama 许可 5016 | 账户未接受许可，不是套餐额度；付费不自动接受 | `F6P/orders/F6P-1.md:3`；团队记忆 | 要 Workers AI 主路先接受许可；否则保持 DeepSeek |
| W14 | Vectorize「only paid」矛盾 | 官方同页表格又有 Free 额度；未实测 | 配套报告 §3.10 | 标记待确认；不要据此设计 |

## 6. 护栏：只用自带额度、不产生超额账单

> 用户硬约束：只用 $5 套餐自带额度，不开附加项，不做会产生超额账单的设计。以下按「最容易超」排序。

| 风险 | 为什么会超 | 硬护栏 |
|---|---|---|
| Workers AI neurons | 10k/天不变；300 张/天可能擦边；judge/OCR 再加就超 | `budget(e,"workers_ai_neurons",8000)`；按模型单价预扣；超了返回 `budget` 不调用；`config/team.json:95` 与 neurons 双闸 |
| Durable Objects duration | 1 个 128 MB DO 7×24 = 331,776 GB-s，占 400k 的 83% | 不上常驻 DO；必须 Hibernation/alarm；每群短命 DO；月度 GB-s 预算 |
| Containers | 25 GiB-h/月；1 GiB 常驻 25 小时就用完 | 只做 burst；用完 sleep；不跑 24/7 ASR；先算 vCPU-min/GB-h |
| Workers Logs | 10M 请求×2 条=20M，正好打满；3 条/请求就超 | `head_sampling_rate=0.1`；`invocation_logs=false`；只打结构化关键字段 |
| Queue ops | 1M/月≈333k 消息；每条 3 ops；重试另算 | 批处理不减少 ops；只在状态变化入队；DLQ；月度 ops 告警 |
| D1 读行 | 全表扫描按扫描行数；1 分钟 cron×大表会爆 | 索引/游标/LIMIT；每 tick 记 `meta.rows_read`；`EXPLAIN QUERY PLAN` |
| D1 写行 | 每 tick 心跳/每条消息多写；索引额外写 | `INSERT OR IGNORE`/UPSERT；批量；只写变化；30 秒节流保留 |
| Workers 请求 | 10M/月≈3.86/秒；4 个客户端 1 秒轮询就超 | 事件驱动/退避；2 秒轮询只在活跃期；不要 250 条每分钟 cron |
| CPU | 30M ms/月；10M 请求×3 ms 正好打满 | 监控 CPU p95；重活放 Queue/DO alarm；不要在大请求里做全量解析 |
| Browser Run | 10 小时/月；200 并发×3 分钟=10 小时 | 一次一个；`finally browser.close()`；`keep_alive` 最短 |
| R2 Class A | 1M/月；每小时 list 1,000=72 万 | 游标/缓存；不在热路径 list |
| KV 写 | 1M/月≈0.39/秒；1 秒轮询写=260 万 | 只在状态变化写；不做秒级心跳 |

**账户动作（只有用户/交付员能做）**：

1. Dashboard → Workers & Pages → Plans 确认 Workers Paid $5/月已生效；看 Billable Usage 当前用量。
2. Workers spending limit 设 $1 + email alert；DO 单独上限；D1/Queues/AI/Logs/Browser 各开 50%/80% 告警。
3. 每月复核一次官方价格页（Workers Logs 2026-12-01 换计价；R2/Containers 价格会变）。

## 7. 未核实与局限

- 没有登录 Cloudflare 账户，所有额度来自官方文档与配套报告；没有实际账单/用量，无法证明「当前用量远低于额度」的精确数字。
- 没有改代码/跑测试；行号基于 `TeamAgent-F11-release` @ `cc223f8`，合并到 trip1/F11 后可能偏移。
- 没有压测 D1 200 条语句、Queue 批 5/并发 3、视频延迟消息；这些需要趟 2 的测试员用真实夹具验证。
- B 站 CDN 对 Worker 出口的行为**未实测**；仓库里只有本机 curl/Node 的 567/403 记录（后修复为 206）。配套报告把它写成「Worker 出口 403/567」，我找不到对应证据，标为未核实。
- Workers AI 的 neurons/张是估算（按官方单价与 1k 输入/200–400 输出 token）；没有在账户上实测，不能当账单。
- `TeamAgent-cf-paid-plan-20261114.md` 的个别行号有误（如把 `video_waits` 扫描写成 `src/fetchjobs.ts:134`，实际 `sweepVideoWaits` 在 `:274`，`LIMIT 5` 在 `:278/:283`）；本文件已按当前基线校正。
- Vectorize「only paid」与 Free 表格矛盾，未实测；不要据此设计。
- 没有评估 Workers Builds 替代 GitHub Actions 的迁移成本；只作为「不是 CF 免费档」的附加机会列出。

## 8. 官方额度与来源（2026-11-14 核对）

> 完整 B 类收费表见 `/Users/yanghongming/Projects/TeamAgent-cf-paid-plan-20261114.md` §3–§4。以下只列本盘点用到的关键数字。

| 项 | Free | Paid 自带 | 超出 | 官方页 |
|---|---|---|---|---|
| Workers 请求 | 100k/天 | 10M/月 | +$0.30/M | [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers CPU | 10 ms/次（HTTP/Cron） | 30 秒默认，5 分钟最大；30M ms/月 | +$0.02/M ms | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 子请求 | 50/次 | 10,000/次 | — | 同上 |
| D1 单次查询 | 50 | 1,000（`batch()` 算 1 次） | — | [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 读/写 | 5M 读/天；100k 写/天 | 25B 读/月；50M 写/月 | $0.001/M；$1.00/M | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 存储/单库 | 5 GB；500 MB | 5 GB 包含；10 GB 单库；1 TB 账户 | +$0.75/GB-month | 同上 / D1 Limits |
| D1 Time Travel | 7 天 | 30 天 | — | D1 Limits |
| Queues | 10k ops/天；24h | 1M ops/月；4–14 天 | +$0.40/M | [Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| DO | 100k 请求/天；13k GB-s/天 | 1M 请求/月；400k GB-s/月 | +$0.15/M；+$12.50/M GB-s | [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Workers AI | 10k neurons/天 | **10k/天** | +$0.011/1k neurons | [Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Workers Logs | 200k/天；3 天 | 20M/月；7 天 | +$0.60/M | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Cron | 5 条/账户 | 250 条/账户 | — | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| Containers | 无 | 25 GiB-h / 375 vCPU-min / 200 GB-h | 按秒 | [Containers Pricing](https://developers.cloudflare.com/containers/platform/pricing/) |
| Browser Run | 10 分钟/天 | 10 小时/月 | +$0.09/小时 | [Browser Run Pricing](https://developers.cloudflare.com/browser-run/pricing/) |
| Workflows | 3k 步/天 | 500k 步/月 | +$0.80/10 万步 | [Workflows Pricing](https://developers.cloudflare.com/workflows/reference/pricing/) |
| R2 | 10 GB 免费层（独立） | 同左，独立 | $0.015/GB-month | [R2 Pricing](https://developers.cloudflare.com/r2/pricing/) |
| KV | 100k 读/天；1k 写/天 | 10M 读/月；1M 写/月 | +$0.50/M；+$5.00/M | [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |

**两处官方文档冲突（照实记）**：

- Cron/Queue CPU：Pricing 页写「15 分钟/次」，Limits 页写 Cron「30 秒（<1 小时间隔）/15 分钟（≥1 小时）」、Queues 页写 consumer「可配到 5 分钟」。本盘点按更具体的 Limits/Queues 页取值，长任务按 5 分钟设计。
- Vectorize：页面开头写「only paid」，同页表格又有 Free 额度（30M 查询维度/5M 存储/100 索引）。标为待确认，不要据此设计。

## 9. 证据索引（可直接打开）

> 历史设计路径相对 `/Users/yanghongming/Projects/.worktrees/`；归档相对 `/Users/yanghongming/Projects/`；专项报告与配套报告相对 `/Users/yanghongming/Projects/`。

- 代码/配置：`src/d1.ts`、`src/timing.ts`、`src/worker.ts:1007-1013,1163-1169,1237-1243,2501-2517`、`src/fetchjobs.ts:97-127,144,185,274-288,348-358`、`src/mediajobs.ts:135`、`src/schedules.ts:328`、`src/kb.ts:7-10,112`、`src/vision.ts:140-145,389`、`src/stickers.ts`、`config/team.json:31-32,95,102,131`、`wrangler.toml:9-45`。
- 文档：`AGENTS.md:16`、`docs/decisions.md:12,27`、`docs/review.md:10,52`、`docs/operations.md:9,15,22,74`、`docs/maintenance.md:28,50,101,105-109,128`、`docs/verification.md:50`、`README.md:70`、`src/guide.ts:86`、`deploy-runbook.md:223`。
- 历史设计：`TeamAgent-archive-20261113/TeamAgent-fastlinks-p0b/.agent/plans/plan-fastlinks-v3.md:18,209,472,492-495`；`TeamAgent-archive-20261113/TeamAgent-cap-c1/.agent/plans/plan-bot-capability-v1.md:1204,1218,1224`；`TeamAgent-p4b-login/.agent/releases/F7/notes/F7-3.md:8`、`F7-9.md:55`、`F7-10.md:15,36`；`TeamAgent-p4b-login/.agent/releases/V-D-reflection-loop/notes/D-0.md:11,19`、`TeamAgent-p4b-login/.agent/releases/V-D-reflection-loop/design.md:524,805`；`TeamAgent-p4b-login/.agent/releases/F6P/orders/F6P-1.md:5`、`TeamAgent-p4b-login/.agent/releases/F6/notes/F6-7.md:18-20`。
- 专项报告：`TeamAgent-luna-vision-research-20261114.md:53-56`；`TeamAgent-c1b-cloud-read-plan-review.md:6`；`TeamAgent-image-gen-probe-20261114.md:288,303-307`；`TeamAgent-capability-frontier-20261114.md:15,64,558-561`；`TeamAgent-bili-asr-local-handoff-20261113.md:6-8`；`bili-asr-cdn-fixed-20261113.md:3`；`plan-bili-video-v1.md:7,19,23,479-542`；`TeamAgent-inventory-docs-20261113.md:16`。
- 配套额度报告：`/Users/yanghongming/Projects/TeamAgent-cf-paid-plan-20261114.md`（§2–§4 额度，§5 红线，§6 旧绕路，§10 来源）。
