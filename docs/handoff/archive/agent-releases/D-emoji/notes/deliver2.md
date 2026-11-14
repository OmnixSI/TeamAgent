# D-emoji2 交付笔记（引用图 / 跨批次图片识图 + vision_events 诊断）

时间：2026-11-14 17:56 Sydney · 交付员

## 1. 结论

已上线。main `20220a1ea570cef215abc5f98c5bafc2fe3e06ec`（PR #51 squash，基线 `3adfdf8`，未等 CI）；
线上 Worker `38772185-9711-45b2-9d70-3c3cac789a83`；`/health.release` 与 `selfCard.commit` 均为 `20220a1`。
回滚点：`14347135-0b0f-4c82-9f62-700940cdf043`（`3adfdf8`，C3）。

## 2. 分支与提交

- 干净 worktree：`/Users/yanghongming/Projects/.worktrees/TeamAgent-D-emoji2-release`（`release/D-emoji2`，基于 `origin/main 3adfdf8`）。
- cherry-pick：`e1c2b59` → `18b3e44`、`29bc9ec` → `26de114`、`f81bbe1` → `8f2f047`；无冲突。
- 迁移编号：main 最新为 `0080`，`0081_vision_events.sql` 不冲突。`scripts/migrate.mjs` 使用固定文件清单，未列 0081；但 `schema.sql` 已含 `vision_events` 建表与索引，本次 `db:migrate` 实际已建表（110 条 schema 语句）。

## 3. 本机门槛（在待发布 commit `8f2f047` 上）

- `npm run check`：通过（exit 0）。
- `npm test`：**2130 tests / 2120 pass / 0 fail / 10 skip**（duration 34.3s）。
- `npm run check:ui`：`UI JavaScript parses`，通过。
- 无 Python 改动，未跑 `test:runner`。
- `node replay/emoji-replay.mjs`：11 个用例，输出 `replay/out/emoji-replay.json`：
  - 引用图片 r518：`quotedPick = {idx: 1000}`，引用图片 note 写入引用方独立索引段；
  - 普通图片 r480：`normalNote` 为看板画面描述（非尺寸占位）；
  - 跨批次 r502：`crossBatchPicks = [r500, r499, r498, r497]`，4 张均取到且已识图；
  - `zero = {onlineD1Writes: 0, qqSends: 0, cloudflareCalls: 0}`。
- 证据副本：`/Users/yanghongming/Projects/.agent/releases/D-emoji/replay-out/`（json + md）。

## 4. 合并与部署

- PR：https://github.com/OmnixSI/TeamAgent/pull/51
- `gh pr merge 51 --squash` 直接成功（未用 `--admin`）。
- 合并提交：`20220a1ea570cef215abc5f98c5bafc2fe3e06ec`。
- 部署 worktree：`/Users/yanghongming/Projects/.worktrees/TeamAgent-D-emoji2-main`（detached `20220a1`）。
- `npm ci` → `npm run db:migrate` → `npm run deploy` → `npm run verify:release`。
  - 迁移：schema.sql 110 条 + 0002–0080 全部幂等重跑，无失败。
  - 部署：Current Version ID `38772185-9711-45b2-9d70-3c3cac789a83`。
  - `verify:release`：`Live release verified: 20220a1…`；`/health` release 与 selfCard 同值。

## 5. 本机服务

- 本次三个提交只改 `src/*`、测试、回放、`schema.sql`、迁移 0081 与文档，**没有 `runner/` 文件改动**，因此未执行 `install-local.py --apply`，避免再次覆盖 `com.inkboard.team-media.plist` 的 `DEEPSEEK_API_KEY_FILE`。
- `qq / runner / owner / utility / utility-quick / fetch`：全部 `state = running`。
- `qq.log` 末行 `2026-11-14T06:44:04.503Z QQ gateway resumed`；`fetch.log` 末行 `fetcher start c829984fc17a`。

## 6. 只读冒烟（17:55 Sydney，全部 SELECT）

| 项 | 值 | 判定 |
|---|---|---|
| `vision_events` 表 | 存在，`COUNT(*)=0` | 迁移已加表，默认不写 |
| `off:emoji_read` | 不存在 → 默认开 | 新功能默认开启 |
| `stickers:read_cap` | 不存在 → 默认 40/天 | 有上限 |
| `chat_cursor:9968…`（群游标） | 574 | 与 `MAX(messages.rowid)=574` 一致，未回退 |
| legacy `chat_cursor` | 450 | 不使用（与上一趟记录一致） |
| `messages` / `MAX(rowid)` | 574 | 部署期间有新入站 |
| 最近 outbox | rowid 325 `sent`（14:52 诺基亚问答） | 线上回复正常 |
| 公告入队前 pending+sending | 0 | 无堆积 |

未往群里发测试消息、未写线上 D1（除公告 outbox 一行外）。

## 7. 公告

- 去重键：`release-notice:emoji2`，真实群 `9968A083EE07797A987010E64CD421B9`。
- 正文：**「补一条看图的事：引用或回复里的图片，我现在也能看懂了；隔一条消息才发的图，我也会回头找出来看。」**
- `INSERT OR IGNORE` changes=1；outbox **rowid 326**，入队 17:56 Sydney。
- 17:57 发现 `created_at` 误用秒（出站队列按毫秒判 24h 过期），被发送器标为 `skipped`、未发生任何 HTTP 调用。用同一 rowid、同一去重键把 `created_at` 改成毫秒并恢复 `pending`，未新增第二行、未换 id。
- 17:59 复核：`status=sent`、`outbox_attempts.http_status=200`、`code` 空；同键仅 1 行。
- 只入出站队列；未动游标、未写别的表。

## 8. §0.1 上线检查表

- [x] 1. 本机 check / test / check:ui 全绿（数字见 §3）
- [x] 2. 验收场景真实回放通过（QQ 真实发送 0、线上 D1 写入 0）
- [x] 3. 已记下回滚点 `14347135-0b0f-4c82-9f62-700940cdf043`
- [x] 4. PR #51 已开并 squash 合入 main `20220a1`（未等 CI）
- [x] 5. 手动部署 + `/health` release `20220a1`；`verify:release` 通过
- [x] 6. 本机 6 服务 running，fetch `state=running`
- [x] 7. 只读冒烟完成，未往群发测试消息
- [x] 8. `selfCard.commit` == `release` == `20220a1`；build 无「未登记工具/失效 pattern」报错

## 9. 未验证 / 待查

- **线上真实触发未验证**：部署后还没有新的「引用图片」或「隔一条消息再问图」入站；本次能力依据是本机真实消息回放（r480/r502/r518）。
- 下一条真实引用图到达后，只读查 `message_meta` 的 `quoted.media` 与 `image_notes`（idx 1000+），确认线上链路。
- `vision_events` 只在 `VISION_EVENTS=1` 时写；线上未开，故预期 0 行，不能靠它做线上验收。
