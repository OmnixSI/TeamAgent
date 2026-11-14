# F6 上线交付记录（交付员）

时间：2026-11-14 01:43–01:52 Sydney（周六，谷时）

## 1. PR

- PR **#39** https://github.com/OmnixSI/TeamAgent/pull/39
- 标题：`release: F6 基础能力补齐（仓库发现/看图通道/@必回/日程提醒/命令/文件重试/工具审计）`
- 源分支 `release/F6` @ `49c7784`（推送 `c1a6c9d..49c7784`，快进，未 force）
- **合并方式：squash，已合入** `main` = **`c612431e21e81c1dc8851afde40eb252bbf5bf7e`**（2026-11-13T14:42:56Z）
- ⚠️ 过程偏差：私有仓库未开通分支保护，`gh pr merge --auto` 没有 required checks，因此**立即合并、未等 CI**（PR CI run 43445346440 合并时仍在跑）。主程已在同一 tree 上本地验证（check 干净 / npm test 858 / check:ui OK / Python 221），但这次合并本身不是 CI 门禁通过的证据。

## 2. 部署

- 干净 worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-F6-deploy` @ `c612431`（detached）
- `npm ci` → `npm run deploy`（`wrangler deploy --var RELEASE:c612431`）
- **新 Worker 版本：`2a00b9db-fb45-46a1-8ded-7db55f0bd5d4`**
- 绑定确认：`env.DB`, **`env.AI`（新增 AI binding 已生效）**, `env.WORK/CHAT/TOOLS`，cron `* * * * *`，三个 queue producer/consumer 正常
- `/health` → `{"ok":true,"service":"team-agent","release":"c612431e21e81c1dc8851afde40eb252bbf5bf7e"}`；`npm run verify:release` → `Live release verified: c612431`
- 迁移：`npm run db:migrate` 幂等执行 —— schema.sql 64 statements、0002 1、0003 2、0004 3、0009 5
  - 注：`scripts/migrate.mjs` 只显式列到 0009；0010/0011 的表（turn_tools / delivery_retries）由 `schema.sql` 覆盖（`CREATE TABLE IF NOT EXISTS`），线上已实测存在。属可接受的冗余，建议下版清理 migrate 列表。
- **回滚点：`c515af4f-74d6-4078-a049-a223a6a6e810`**（release `2b22b39`）
  - `npx wrangler rollback c515af4f-74d6-4078-a049-a223a6a6e810 --name inkboard-team`
- 未设置 `GITHUB_TOKEN_FILE`，线上 `GITHUB_TOKEN` 未被覆盖。

## 3. 本机

- `python3 scripts/install-local.py --apply` ✅（首次因沙箱拒写 `~/.inkboard-team` 失败，提权重跑成功）
- `launchctl kickstart -k com.inkboard.team-{qq,fetch,runner}` ✅ 三个 state=running

## 4. 只读冒烟（rows_written 全程 0）

| 检查 | 结果 |
|---|---|
| `/health` | 200，release=`c612431` |
| 新表存在 | `schedules`, `turn_tools`, `delivery_retries` 均在 |
| 列数 | turn_tools 10 / schedules 13 / delivery_retries 5 |
| `chat_cursor` 分群键 | `chat_cursor:9968A0…` = 455（旧全局 `chat_cursor`=450 保留） |
| outbox failed | 全库仅 1 条，`created_at`=1794386441467（约 54 小时前，部署前既有），本版未新增失败 |
| 群消息 | 0 条（未写 outbox、未触发出站、未回放） |

## 5. 看图通道：AI binding 生效，但模型被许可条款挡住

用账户 token 直接调 `@cf/meta/llama-3.2-11b-vision-instruct`（与 Worker 同一模型）一次：

```
AiError: Model Agreement: Prior to using this model, you must submit the prompt 'agree'.
code 5016
```

- 这不是 binding 失败，也不需要回滚：`env.AI` 已绑定，Worker 正常上线。
- 按 F6-7 施工记录，代码把 5016/许可类错误归类为 `runner_unsupported` + `next_action`，会向用户解释而不是崩。
- **待办（需杨鸿明本人操作，交付员未代为接受）**：在 Cloudflare 控制台 Workers AI 里首次调用该模型并输入 `agree` 接受 Meta Llama 3.2 社区许可；之后 `/api/team/vision/selftest`（owner 登录，GET 一次）即可验收。
- 未执行 selftest：本机没有 owner 登录会话，Works on 关闭，无法登录。

## 6. 未验证 / 遗留

- PR CI（run 43445346440）与 main push CI（43445368661）在交付时仍 queued/in_progress；main CI 的 Deploy 步骤按既有情况会因缺 secret 变红，以 check/test 步为准。
- 真实 QQ 图片识别质量、日程提醒实际触发、`/help /status /stop` 群内实际响应未在本轮验证（需线上被动运行与群内操作）。
- 本轮未删除 worktree / 远程 `release/F6`，等 CI 结果后再清，便于出问题时修复。
