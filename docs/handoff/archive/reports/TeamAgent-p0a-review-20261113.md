# fastlinks P0a 复核（working tree vs 0f67b28）

结论：通过（无 P0/P1；5 条 P2）。
测试：`npm run check`；临时副本 `npm test` 508/508；`fastlinks-budget` 15/15；`fastlinks-readers` 20/20；`jinaOk`/`slot` 探针。
1) readUrl 绝对截止：`src/semantic.ts:443` + `slot:394`；推文 `:409` 三源、body `readLimited` 同 signal；inline 全挂起 3.3s 内返回 — 改对。
2) 推文 Fx→syndication→oEmbed、3s 内必回、结构化 reason、Fx/synd ID 校验 — 20 条测试通过。
3) Jina：`:399` 覆盖 404/Warning、challenge、login wall、去导航 <500；正常文章引用这些词会误杀（P2-1 已复现）。
4) 计时：`stage` 只 push；`flushTail` 发送后/段末；每类 1 SQL；B3 45、全部 ≤48；心跳 `fetcherSeen` 30s — budget 15 条通过，`meter.used===DB.executed`。
5) 迁移：`0003_stage_timings.sql` 登记 `scripts/migrate.mjs` + `schema.sql`，幂等测试通过；untrusted 覆盖 pages/工具失败，无 URL/Cookie/token 入表。
6) 范围：无 read_x/latest/prefetch/inline 功能；仅 `timing.ts:9` 预留 `inline_read`/`prefetch_*` 名；P0a 其余项齐。测试有效性：新测试依赖 `jinaOk`/`readTweet`/`slot`/`stage`/`flushTail`，旧 0f67b28 无这些导出且 `isTweet` 返回布尔，旧代码会红（未跑完整旧套）。
P2-1 `src/semantic.ts:399` `jinaOk` 误杀正常页：引用「Warning: Target URL returned error 404」→not_found；「Just a moment…」→risk；「Sign in to continue reading」→login_required（探针复现）。建议只认 Jina 首行/错误页整体特征或结合目标 HTTP 状态。
P2-2 `src/semantic.ts:466` DeepSeek short（<500 字）仍返回 ok，而 Jina short 映射 not_found，口径不一。
P2-3 `src/semantic.ts:446` 私有 GitHub 仓库仍走 raw README/Jina；方案说私有仓库交给 repoContext。
P2-4 `src/semantic.ts:409` oEmbed 源未校验返回 id/作者，Fx 与 syndication 都校验。
P2-5 `src/semantic.ts:496` `understandLinks` 三条链接串行、各 15s，无总截止。
未验收：真实 X/Jina/GitHub 实时可用性、端到端 3s、远端 D1 迁移、真实群。
