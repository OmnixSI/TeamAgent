# P1 插话时机复核（9332e50，基线 f16c96d）

结论：通过（无 P0/P1）。2 条 P2 与 1 条顺序备注见文末，不影响合并。

测试：worktree 复跑 `npm run check`、`npm test`（227/227）、`npm run test:runner`（Python + fetcher 10/10）、`npm run check:ui` 全绿；未改 worktree、未提交。计数用现有 `measured` 包装实际执行的 D1 语句；未跑真实模型、真实群/Queue/launchd。

1. **authz（A1–A12）：通过。** A3 视频字幕诱导 `prepare_project_task`（`request_quote="视频"`）被拒，`tasks=0`、`activity authz.denied`、原 @ 消息仍有回复；A4 显式视频跟办在污染回合强制 `proposal` 且无 `local` job；A5 未污染仍 `queued`；A6 cached、A7 file、A8 correction、A9/A10 工具污染、A11 research payload `authz.tainted`、A12 引用原话均通过；污染标记随 background payload 带到恢复。
2. **D1 ≤48（B0–B9）：通过。** B3 三冷图拆 `chat`/`chat-v` 两段，实测断言 `image≤30`、`answer≤44`；B4 工具回合 `answer≤48`；B5 research 第 3 次模型请求不带 tools；B6 fetch/report 与 3 个 waiter ≤48；B7 cron 重投 ≤48；B1/B9 校验 meter 与 batch 语句计数；B0 校验 batch 返回 SELECT results；B2 固定 f16c96d 快照。`namesFor`、`imageNotesFor`、refs 均 `chunks(90)`，单次参数 ≤100。
3. **防抖：通过。** I1 落 `notBefore` 并按 `delaySeconds` 投递；提前到达的队列消息领取被 `notBefore` 挡住；I2 cron 不投未来任务、到期再投；I1/I2 在 0 秒配置下仍走真实时间门槛，没有用 0 掩盖。`oldest_ts` 边界见 P2-1。
4. **三态 reply/wait/stop：通过。** I 组覆盖 wait 不推进游标、第二次 wait 降为 stop、@/引用 bot/`videoWaited` 强制 reply；`chat_decisions` gate/action 落表。
5. **硬规则：通过。** I10 各状态；`hard_unanswered` 命中时不调模型并记 gate；视频接管的 `ref` 会绕过 stop。计算顺序的备注见文末。
6. **引用发送：通过。** Q1/Q2/Q2b–Q2e：仅 400/422 且 JSON body 才去引用重发一次；连续 3 次确认失败 `off:quote=1` 并写 `activity quote.disabled`，同一次 send 后续行不再引用；401/403/429/5xx/无 JSON 不累计，去引用后仍失败也不累计；运行时开关读 D1。
7. **新表/body：通过。** schema 只追加 `chat_decisions`、`outbox_meta` 与索引（`CREATE TABLE IF NOT EXISTS`，无 ALTER）；`messages.body` 表达式未改（`inbound.ts` 只导出 `mediaOf` 并补 `content_type="voice"`）。
8. **§2 七项：通过。** W6（第二提问人共享 deadline 并拿视频资料）、W6b（3 人等/第 4 人普通）、W6c（重复投递不重复 wait/waiter）、W6d（迟到 waiter 到期恢复）、W6e（并发 report 前两个 waiter 同批）、W7/W8；W1–W5、F1–F3、R1–R4 原样绿；`vision.ts` 的 `coldPicks`/`annotateTurn` 拆分，W 测试不断言字幕；P4b 的 N10（6to4/Teredo）也绿。

## P2（不阻塞）

- **P2-1｜`src/worker.ts` 的 `oldest_ts` 解析失败用 `Date.now()`**：最早待处理消息会被当成“刚到”，`cap_ms` 永不触发；若 `ts` 异常，最早一条可能被饿死。方案 §8 的退路是“解析失败按 0 条处理”，建议 `Date.parse(head.oldest_ts) || 0`（或直接允许处理）。
- **P2-2｜P4b 的 `videoWaitExists`/`transferred` 仍按重跑时的 `latest.id`**：中断后若已有新消息把 `latest` 推后，原 wait 的 `latest_id` 可能不在键上；原 wait 仍会答原问题，普通回合可能答新消息。属边界，建议按 `latest_id IN (batch)` 或 `m.id` 查。

## 备注

- `hardStop` 的“计算”在 `needsVideo` 之前，但只用于跳过 `picks`/vision；实际 stop 在视频判定之后，行为等价，代码顺序与方案“视频接管之后、看图之前判断”字面不同。
- 未验收：真实 DeepSeek 模型、真实群、Cloudflare Queues 延迟投递、D1 线上 48 条计数；方案 §4 的 `scripts/evaluate-timing.mjs` 合成集 90%/规则 100% 需要真实模型，本次未跑。
