# 施工单 · D · D3b 日程 v2（用户最痛，优先；Claude 主程带队，改由 DeepSeek 施工）
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-D-D3b   分支：pkg/D-D3b   施工者：工程师
先读：_common.md；design.md §5.5 全文（含 runSchedules 段）、§5.2/5.1 的 schedules 与 pending_actions、§4 第 1/2/3/6/8 条、§6 D3b 行、§10 第 1 行；src/schedules.ts 全文（它是你的主战场，约 800 行：先 `rg -n "^export|^async function|^function" src/schedules.ts` 列函数，再按需读）；src/semantic.ts:974-997 旧 schedule_create 定义（只读，D4 负责删）。
依赖：D0（表）、D2（parseWhen/parseContent/describeWhen——还没合时先在测试里按 §5.5 类型 stub，D2 合并后 rebase）、D3a（runSteps/validateSteps/composeWithNote——同样先 stub）。
## 文件（独占）
src/schedules.ts、新 src/tools/schedule-tools.ts、config/team.json（仅 schedules 段：max_active_per_group 5→10 等）、src/config.ts（如需）、新 test/schedules-v2.test.mjs。src/tools/index.ts 只加你的注册行。
## 要点
1. ScheduleSpec/ScheduleKind 按 §5.5；旧行缺 cadence 时按 kind 推断（digest_daily→daily 等），**旧日程行为不变**（回归测试）。
2. nextRun：daily/weekly 保持；monthly 逐月找（≤13 个月，-1=当月最后一天，2 月 30 日这种跳过）；every 对齐 window 与 until；once=run_at；一律用 zonedToUtc 求值（DST）。
3. 工具（BotTool，在 src/tools/schedule-tools.ts）：schedule_create / schedule_update / schedule_list / schedule_cancel，参数与返回照 §5.5 **逐字段**。关键规则：when_text/原话经 parseWhen 的结果**优先于**模型填的 time/tz（不一致用解析结果，并经 onViolation 记录）；content_text/原话经 parseContent 得 steps，与模型 steps 合并去重；有 steps 且非纯聊天总结 → kind=agent_task。缺时间 → 返回 need:"time" + pending_id，写 pending_actions（tool='schedule_create'，30 分钟过期；同一人同一群再次给时间时用它补建，RC-07）。成功回执 next_run_text 要双时区（用 describeWhen）。
4. 授权：schedule_update/cancel 只有 owner 或管理员（isAutoSender，rg src/feature-request-core.ts:162），mute 任何人可取消自己的；非 owner → {ok:false,error_kind:"denied"}（S-16）。
5. runSchedules 对 agent_task：validateSteps → runSteps(purpose:"schedule") → 有 note 则 composeWithNote；**每 tick 最多 2 个需要模型的任务**（其余顺延，仍在 MAX_MISSED_AGE 内）；outbox id 仍用 outboxIdFor；每群每天 agent_task 运行 ≤24 次（数 schedule_runs）；失败 fail_count+1，≥9 → status=paused 并发一条 outbox `sched-paused:<id>`（S-17）；spec 里被注入的非只读 action 在 validateSteps 被拒，run 记 error_kind=denied（S-15）。
6. `off:schedules_cron` 开关：runSchedules 开头读 settings（沿用现有 `off:*` 读取方式，rg -n "off:" src/ 看写法），为 1 直接 return。
7. schedule_list：每行 id、title、双时区下次时间、最近一次 schedule_runs.status（sent/failed/none）、fail_count、status（RC 里“我的日报呢”要靠它）。
## 测试（假 D1）
nextRun monthly/every/once/DST（2026-11-15、2027-05-15）；agent_task 运行与 ≤2/tick、≤24/日；fail≥9 暂停+通知；cancel/update 归属；pending 写入/过期/补建；list 带最近状态；开关；RC-02/07/08/09/12 与 S-01..04/15/16/17 的日程层断言（解析用 D2 的真函数，D2 未合则 stub）。
## 不要做
不改 semantic.ts / reply-finalize.ts（D4）；不改 worker.ts。
## done_when
design §6 D3b 行 + 上述测试；全量 npm test 绿。
