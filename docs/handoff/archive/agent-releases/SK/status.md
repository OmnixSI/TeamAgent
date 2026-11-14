# SK 上线记录（2026-11-14 03:55 Sydney）

## 版本

- 版本名：SK（自知：能讲清自己的能力、服务商与代码组成）
- release/SK 头：`c212462bfa4627817deb76501a7ab30185b7631a`
- 合并 main：`4c1a954`（把 8390f39 合进 release/SK）
- PR：[#46](https://github.com/OmnixSI/TeamAgent/pull/46) squash 合入 main `88f5aef865e0a2c9829f396a795ac2b96e334863`
- 未等 CI（团队 2026-11-14 政策：本机门槛为准）

## 部署

- Worker：`inkboard-team`
- 新版本 id：`7cb4aa27-f27b-46b5-ae50-391d29234e7a`
- 回滚点：`5ef26443-779d-4018-8792-83701b890a6a`（cf，main 8390f39）；再往前 `d9d27ee0-1af7-40c0-bbcb-b86b999edd72`（trip1）
- 部署命令（干净 worktree @main）：
  `CLOUDFLARE_API_TOKEN="$(cat <vault 文件>)" npm run db:migrate && npm run deploy && node scripts/verify-release.mjs`
- 迁移：schema 95 条 + 0002/0003/0004/0009/0020/0021/0022/0023/0025/0026/0040/0041/0042/0060，全部幂等通过；无 schema 改动
- `/health`：`release=88f5aef…`，`selfCard.commit=88f5aef…`（相同），`verify-release` 通过
- 本机：`install-local.py --apply` 后 kickstart qq/fetch/runner；6 个服务 `state = running`（qq/runner/owner/utility/utility-quick/fetch），`qq.log` 16:48:02Z `QQ gateway resumed`，无 error 日志

## 门槛

- `npm run check`：干净
- `npm test`：1464/1464
- `npm run check:ui`：干净
- `npm run test:runner`：Python 259 条，8 failures + 2 errors（10 项，与 main 基线同数量的本机嵌套沙箱失败，非本版回归）；fetcher 单跑 79/79
- 验收：acceptance.json S1–S8 全 true；review.md「PASS，无 P0/P1」

## 合并处理（4c1a954）

- 冲突 14 个文件 28 处：`schema.sql`/`authz.ts`/`kb.ts`/`tts-policy.ts` 及 3 个测试取 main（仅顺序/上限差异）；`worker.ts`、`rhythm.ts`、`voice.ts`、`tools/index.ts`、`capability-card.ts` 取 main 结构并保留 SK 的 describe_self、vendorSummary/SELF_HINT、selfCard、`off:*` 缓存、`must-keep` 语音约束
- SK 的 manifest 门槛要求登记 main 新工具：已在 `config/self-manifest.json` 登记 `web_search`（联网搜索）、`fetch_page`（网页阅读）、`read_image_text`（OCR，含看图回退），并把 ocr 的 how/状态改为已接入
- 随 main 机械调整 2 处测试：`runWorkersAi` 看图调用点、`wrangler.toml` 新增 `*/5` 兜底 cron

## 冒烟（只读，不往群里发消息）

- 每群游标 `chat_cursor:9968A083…` = `466` = `MAX(messages.rowid)`（全局旧键 450 已停用）
- `outbox` pending：0（公告插入前）
- 最近 5 分钟 `mention-*` 任务：0
- 公告：`outbox` `release-notice:SK` rowid 266，已 `sent`（cron 16:50Z 前后发出）

## 公告

- `release-notice:SK`（rowid 266，group 9968A083…）：正文「现在你问我某个能力是怎么实现的、用的哪家服务，我能讲清楚，也知道自己的代码是怎么组成的。」
- 发送状态：`sent`（2026-11-14 03:51 Sydney 复核；rowid 266）。

## 回滚

- Worker：`npx wrangler rollback 5ef26443-779d-4018-8792-83701b890a6a`，再 `curl /health` 确认 release
- 本机：`git checkout 8390f39 && python3 scripts/install-local.py --apply && launchctl kickstart -k gui/$(id -u)/com.inkboard.team-{qq,runner,fetch}`
- 无 schema 改动，回滚代码不用回滚 D1

## 上线后只读复核（2026-11-14 03:55 Sydney）

| 项 | 结果 |
|---|---|
| 公告行 | `release-notice:SK`，outbox **rowid 266**，status **sent**，同 id **仅 1 行** |
| 公告正文 | 「现在你问我某个能力是怎么实现的、用的哪家服务，我能讲清楚，也知道自己的代码是怎么组成的。」|
| /health release | `88f5aef865e0a2c9829f396a795ac2b96e334863` |
| selfCard.commit | `88f5aef865e0a2c9829f396a795ac2b96e334863`（与 release 相同）|
| selfCard.built_at | `2026-11-13T16:47:36.527Z` |
| 按群游标 `chat_cursor:9968…` | **466**，等于 `MAX(messages.rowid)` **466** |
| outbox 积压（pending/sending/retry/held） | **0** |
| MAX(outbox.rowid) | **266** |
| 部署后（16:48Z 起）outbox 新增 | **1**（仅公告）；除公告外 **0** |
| 部署后针对旧消息的新回复 | **0** |

- 全程只读；未写线上、未发群、未部署、未改代码。
