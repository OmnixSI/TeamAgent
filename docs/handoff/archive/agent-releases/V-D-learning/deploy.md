# V-D-learning（趟 B）上线记录

- 时间：2026-11-14 16:13–16:2x Sydney（周六，谷时）· 交付员
- 分支/提交：`release/B @ 8c768b10e94a18f3d040c4ddc8451db0eb79e25d`（worktree `.worktrees/TeamAgent-B-release`，已含 main `eb2a6d2`）
- 方式：本机手动部署（CI 额度用尽，不等 CI）

## 1. 结论

| 项 | 值 |
|---|---|
| 线上 release | `8c768b10e94a18f3d040c4ddc8451db0eb79e25d` |
| `/health.release` | 同值 |
| `selfCard.commit` | 同值（built_at 05:15:09Z） |
| 主 Worker 版本 | `d119a5ad-66e1-489f-acee-5b91969b5ee4` |
| review Worker 版本 | `73358bb9-ea91-4690-a28b-4e8ac0925335`（`--var RELEASE:8c768b1`） |
| 回滚点（旧主 Worker） | `ead62cca-0164-478f-a6d7-08e6fbf1ec2f`（release `c830efa`） |
| main merge commit | `3a90a3d`（`--no-ff`，`eb2a6d2..3a90a3d` 已 push） |
| 合并后复跑 | `npm test` 2089 / 2079 pass / 0 fail / 10 skip（33.1 s） |

## 2. D1 迁移（幂等）

`npm ci` 后 `npm run db:migrate`：schema.sql 107 条 + 0002/0003/0004/0008/0009/0020/0021/0022/0023/0025/0026/0040/0041/0042/0043/0044/0060/0061/0070/0080 全部 applied。
0080 三张表已在线上：`review_learnings`、`review_reports`、`learning_acks`（迁移后各 0 行，符合预期）。

## 3. 本机运行时

- 逐文件对比 `~/.inkboard-team/{*.py,*.mjs,package*.json,sdk/*,shared/deny_globs.json}` 与 release/B：**无差异**，runner 代码在 `eb2a6d2..8c768b1` 之间未变，未跑 `install-local.py --apply`、未重启服务（未打断群里进行中的任务）。
- 6 个服务 `state = running`：qq / fetch / runner / owner / utility / utility-quick。
- `qq.log` 末行 `04:28:32Z QQ gateway resumed`，`TTS toolchain ready: /opt/homebrew/bin/ffmpeg`。

## 4. 只读冒烟（全部 SELECT，rows_written=0）

| 项 | 值 | 判定 |
|---|---|---|
| `messages` / `MAX(rowid)` | 479 / 479 | — |
| 群游标 `chat_cursor:9968…` | 479 | = max rowid，无回放 |
| `outbox` pending+sending | 0（sent 294 / failed 1 旧行） | 无堆积 |
| 5 分钟内未处理 mention | 0（历史未处理 6 条都在游标之前） | 通过 |
| `off:image_gen` | `1` | 生图仍关 |
| `off:review_report` | 不存在 | 夜间复盘按设计保持开启，未设 |
| 新表三张 | 均在 | 通过 |

## 5. 自测（真实消息回放，只读；不往群里发）

脚本 `.agent/releases/V-D-learning/live/b-live-replay.mjs`（D1 快照 `live/*.json`，内存 SQLite，只调 DeepSeek 余额接口；qq=0、线上 D1 写入=0）。

- 额度：真实 owner 原话 `messages.rowid=467`「DeepSeek 还有多少余额」→ 给具体余额 ¥78.86、较上次（−16.01 元 / +7 次）、OpenAI 每日预算与「账户余额查不到」、无「OpenAI 还剩」、无生图行：7/7。
- 承诺：真实 `messages.rowid=351`「悉尼时间每天早上 8 点在群里推送昨日聊天内容总结」+ 一句「以后每天 8:00 都会给你推」的回复 → promiseGuard 建 `digest_daily 08:00` 并加「记下了…第一次是 2026-11-15 08:00」前缀；「每天早 8 点推送，要吗？」原样不动。
- VL-6 真实数据复现：`node replay/vl6-repro.mjs` → rid=245/254 原句保留，退出 0。
- 定向测试：`test/reply-finalize.test.mjs` 12/12、`test/learning-accept.mjs` 27/27。
- 语音：`selftest:voice:2026-11-14d`（outbox rowid 295）→ `outbox_attempts.code=voice:sent:voice`、`tool_calls.tts_reply status=ok (5648 ms)`，silk-wasm 未回归。

## 6. 公告

- `release-notice:B`：outbox **rowid 296**，16:19:49 入队，16:20:13 `sent`、HTTP 200、同键 1 行。
- 正文：「我开始在夜里自己复盘群里白天的聊天：哪里答得不好、有什么该记住的。夜间复盘每天早上会在群里说结果；要是它想记住一条约定，或者替你们设个定时推送，会先问一句，你们点头才算数。想取消的时候直接说「不用再发了」就行。」
- 含指定句「夜间复盘每天早上会在群里说结果」；未写「能生图」。

## 7. 每日 08:00 晨报

- 线上 `schedules` 已有 active 的 `digest_daily`：tz `Australia/Sydney`、`spec={"time":"08:00"}`、`next_run_at=1794690000000`（2026-11-15 08:00 悉尼）、`source_msg_id` = 真实 `messages.rowid=351`（TOO 原话）。
- 该日程 14:05 已由 `/api/admin/daily-push` 接上并公告（`release-notice:morning-report` rowid 269），本次无需重复创建。
- **ADMIN_TOKEN 路径**：deploy-runbook 与团队记忆只记了「Worker secret 名 ADMIN_TOKEN」与 `Authorization: Bearer` 用法，没有可读的令牌文件路径；本次没有猜令牌、没有用它。

## 8. 回滚

- 主 Worker：`npx wrangler rollback ead62cca-0164-478f-a6d7-08e6fbf1ec2f`（release `c830efa`）。
- review Worker：重新 `wrangler deploy --config wrangler.review.toml --var RELEASE:c830efa`（上一版 `88ab4e46`）。
- 本机运行时未动，无需回滚；D1 0080 只加表，不回滚数据库。
