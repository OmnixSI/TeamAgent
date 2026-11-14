# E1 交付笔记（F11c-solo + F9r + F8 自检模型）

时间：2026-11-14 19:25–19:40 Sydney · 交付员

## 1. 合并与部署

- 集成分支 `release/E1`，基线 `origin/main 25e5094`。
- 本线合并 `pkg/F11c-solo`（fr-consume + MG2 修复）、`pkg/F9r`（read_social 多平台读取），均无冲突。
- 并行交付线同时把同一 release 合入并开了 PR #52（`8f6de37`，含 `pkg/F8-selftest-model`）；本线核对树完全一致后，PR #53 squash 合入 main `750a2e4`（与 `8f6de37` 同树，`git diff --quiet` 为真）。因此 PR #53 是等同内容的空合并，不是额外功能。
- 部署 worktree：`.worktrees/TeamAgent-E1-ship`（detached `750a2e4`）。
- `npm ci` → `npm run db:migrate`（21 个文件，exit 0；本次无 schema 改动）→ `npm run deploy` → `node scripts/verify-release.mjs`。
- 本线部署 Worker 版本：`97cd5696-ccb2-4c60-847e-6a71175a59df`（19:27，`/health` 与 `selfCard=750a2e4`，`verify:release` 通过）。
- 19:29 并行 F8 线部署 PR #54 `d3b8bcc` → Worker `7f56afe4-155e-4251-8061-559e772611e0`，覆盖本线版本；`git merge-base --is-ancestor 750a2e4 d3b8bcc` 为真，E1 仍在线上。当前 `/health = d3b8bcc`。
- E1 之前的回滚点：`38772185-9711-45b2-9d70-3c3cac789a83`（`20220a1`）；当前版本的上一版是 `97cd5696`（E1）。

## 2. 门槛（在 `release/E1` 上）

- `npm run check` 通过；`npm run check:ui` 通过。
- `npm test`：**2210 tests / 2200 pass / 0 fail / 10 skip**（36.7s）。
- `node --test runner/test_browser_auth.mjs runner/test_fetcher.mjs`：**101/101 pass**。
- 包内：`test/fr-consume.test.mjs` 9/9；F9 定向 69/69。

## 3. 本机运行环境

- 并行线已执行 `install-local.py --apply`；`~/.inkboard-team/reach-*.mjs` 与仓库同哈希（`reach-adapter 6daeef95552a`）。
- `com.inkboard.team-fetch` 原进程仍是旧代码（启动日志 `c829984f`）；本线 `launchctl kickstart -k` 后启动日志变为 `005bd01e3a94`，与仓库 `runner/fetcher.mjs` 同哈希。
- `qq / runner / owner / utility / utility-quick / fetch` 全部 `state = running`；fetch 无 error 日志。
- 未再跑 `install-local --apply`，避免二次覆盖 media plist；安装前 plist 备份 `.agent/releases/ledger-all/notes/media.plist.before-E1`。

## 4. 开关

- `reach:mode=on`（并行线 19:26 写入；本线读回确认）。
- `off:reach` / `off:reach:*` 不存在；无 `reach:cooldown:*`。
- `off:feature_request` 保持不设；未创建 `~/.inkboard-team/fr-consume.json`，F11 claim 保持关闭。

## 5. 有界真实读取（全部走线上 jobs → 本机 fetch → report 回写）

| 作业 | 目标 | 结果 |
|---|---|---|
| `selftest:reach:2026-11-14` | 微博热搜 | `done`，`ok=1`，items=10（热度 1097086…221287） |
| `selftest:reach:2026-11-14:weixin` | 公众号「中国信通院郭雪：人工智能+软件」 | `done`，`ok=1`，items=1，正文 2509 字级 |
| `selftest:reach:2026-11-14:zhihu` | 知乎热榜 | `done`，`ok=1`，items=10 |

- 三个作业都插 `waiters: []`，`reportReach` 不会生成 `reach_reply`；实测 `jobs kind='reach_reply'` 0 行、`outbox id LIKE 'reach-reply-%'` 0 行，未往群里发任何测试消息。
- 三项验证在 19:29–19:30 完成，当时线上已是 F8 #54 `d3b8bcc`（包含 E1），所以验证的就是当前线上版本。
- `media_notes` 已写入对应 `selftest:reach:*` 键；`chat_cursor:9968… = 685` 与 `MAX(messages.rowid)=685` 一致。

## 6. 公告

- 去重键 `release-notice:E1`，outbox **rowid 377**，19:30:39 入队（created_at 毫秒），19:31 复核 `status=sent`、HTTP 200；同键仅 1 行。正文：
  「现在可以帮大家读微博热搜、知乎热榜和公众号文章了：发链接或直接问一句就行，只读，不会替你们发帖或点赞。」

## 7. 遗留 / 未验证

- X 登录态已失效、小红书未登录：代码已上线但这两类实际读取未验证，需要用户在本机登录一次；未在公告里承诺。
- 抖音短链被平台安全拦截（`platform_blocked`），未验证成功读取。
- `fr-consume` 只在 main/仓库，本机未开 claim、未装定时；真群 @ 建单仍未验证。
- `/health` 为 `d3b8bcc`（F8 #54，包含 E1）；本线 E1 部署版本 `97cd5696` 已被覆盖，但 E1 代码仍在。
- PR #53 与 #52 内容同树，导致 main 多一个空合并；`release/E1` 分支与临时 worktree 已由清理流程/本线移除，未动 `.worktrees/TeamAgent-F9-reader`。
