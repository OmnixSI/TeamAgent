# 链接提速 P0a：读取准确性与计时

基线 `0f67b28`，分支 `agent/fastlinks-p0a`；仅实现方案 v3.2 的 P0a，不包含分 P、失败模板、预读、内联读取、最新推文或本机唤醒。

## 运行与信任边界

- `readUrl` 接受 purpose 与绝对 deadline。默认 research 15 秒、inline 3 秒、prefetch 4 秒；请求和响应体共用 signal，剩余不足 300 ms 时跳过来源。
- 单条推文按 Fx → syndication → oEmbed 兜底；HTTP/内容失败返回结构化 reason。Jina 检查错误页、挑战页、登录墙和去导航后的 500 字门槛。
- 公共 GitHub 仓库首页先读取 HEAD README；私有仓库仍由既有 repoContext 处理。
- 读取正文与失败结果进入 materials、read_web 工具消息之前都经 untrusted() 包装；不修改 tainted() 或写工具授权。

## 阶段与存储

新增 `stage_timings(turn_id,stage,at,extra)`，迁移登记在 scripts/migrate.mjs，并同步 schema.sql。迁移和 schema 连跑两遍通过。

stage() 仅写 metered() 创建的共享 tail；cache 最多 5 条资源与 3 条 msgref，先于最多 22 个计时点落库。每类最多一条 SQL，绑定参数分别不超过 24/88；余量不足直接丢弃，写入或序列化失败不影响主流程。

队列中间消息处理后 flush，最后一条在 sendOutbox 后 flush；cron 与 fetch 路由亦 flush。模型记录 start/end，视频事件按 waiter 的消息 ID 关联；每小时第 0 分钟清理 7 天前的计时。心跳仍执行一条 SQL，但 30 秒内不更新原值。

```sql
SELECT stage, at, extra FROM stage_timings WHERE turn_id = ? ORDER BY at;
```

## 离线验收

主测试 508/508（基线 464，新增 44）；Python 53、runner Node 51、clients 2；check / check:ui / config:check / git diff --check 全绿。

`test/fastlinks-readers.test.mjs` 覆盖识别、内容质量、长推文、子预算、响应体取消、公开 README 和 untrusted 边界。`test/fastlinks-budget.test.mjs` 覆盖 P0a 路径、计数相等、两段送出、tail 降级、心跳节流、整点清理、租约拒绝和多消息顺序。原 B3–B7 均通过；B3 回答上限由 44 同步为 45（新增一条发送后的计时 SQL），48 上限未放宽。

| P0a 路径 | 实测 D1 语句数 |
| --- | --- |
| P0a-B3-image | 29 |
| P0a-B3-answer | 45 |
| P0a-bili-wait | 21 |
| P0a-fetch-claim | 5 |
| P0a-fetch-report | 7 |
| P0a-video-reply | 36 |
| P0a-bili-cache-hit | 38 |
| P0a-fetch-lease-rejected | 1 |
| P0a-research-work-status | 26 |
| P0a-heartbeat-insert | 1 |
| P0a-heartbeat-no-write | 1 |
| P0a-heartbeat-write | 1 |
| P0a-cron-minute-one | 21 |
| P0a-cron-minute-zero | 20 |
| P0a-research-handoff | 39 |

计数原件：`.agent/fastlinks-counts.json`；汇总：`.agent/fastlinks-p0a-verification.json`；初始失败：`.agent/fastlinks-p0a-red.log`（旧响应体挂起测试已终止，夹具随后加入安全兜底），其余针对性先红后绿证据在同目录。

## 后续批次与未验收

- R1 L1–L9 属 P0b；本批不修改 runner 或协议。
- R8-1–3 和完整 msgref 来源查询属 P1；本批覆盖 R8-4 的零 tail 余量丢弃与现有状态查询不报错。
- 预读 33 条门槛、真实链接 cache 写回、内联读取与最新推文属 P2；本批只提供共用 tail 和 purpose 截止时间，不把未来路径当作已运行。
- inline_read、prefetch_start/end 阶段名已预留，其消费者随 P2 接入。
- 未调用真实模型或 QQ；未测公开来源实时可用性、端到端 P50/P90，也未执行远端 D1 迁移。

## 接口依据

- [FxEmbed API v2 主仓库定义](https://github.com/FxEmbed/FxEmbed/blob/main/docs/specs/fxtwitter-openapi.json)：单条 status 的 id/text/created_timestamp。
- [react-tweet 主仓库 syndication 实现](https://github.com/vercel/react-tweet/blob/main/packages/react-tweet/src/api/fetch-tweet.ts)：固定 token 计算；测试锁定独立 ID 的输出。
