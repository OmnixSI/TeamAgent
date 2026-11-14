# F9 收尾补丁 · 上线记录（2026-11-14 19:39–19:52 Sydney）

## 结论：已上线；1 项验收未过（超时偶发遗留 Edge，P1 已交回）

- PR **#57** squash → main **bf0a2c3**（父提交 `5122f3f`，F11fix）。
- Worker 部署版本 **21a6ea53-246e-4f12-8d7c-9665c32bb413**；`/health` 与 selfCard 均为 `bf0a2c3`。
- 回滚点：Worker **d6ec48ab-cb4d-42bf-b665-ead5297e6b8e**（`5122f3f`）。
- 已同步本机 runner 并重启 `com.inkboard.team-fetch`（pid 22440 → 98799）。

## 合入与验证

- 集成分支 `release/F9-reader`（从 `origin/main` 建），先 ff 到 `2c41b0c`，再合 `5122f3f` 成 `1da5c65`；PR #57 以新 head 重跑后 squash。
- `npm run check` 通过；`npm run precheck` 通过（29 能力 / 36 工具）。
- `npm test`：2227 例 / 2217 通过 / 0 失败 / 10 跳过（合入 F11fix 后重跑）。
- `node --test runner/test_fetcher.mjs`：80/80。
- 私有仓库 Actions 额度不可用，PR 内已注明以本机全量结果合并。

## 本机 runner

- `python3 scripts/install-local.py --apply` 成功（需工作区外写权限）。
- 哈希一致：`x-reader.mjs 552ad26a…`、`reach-adapter.mjs f3593465…`、`reach-xiaohongshu.mjs 019582de…`、`x-graphql.mjs 394c4744…`（仓库 = `~/.inkboard-team`）。
- `launchctl kickstart -k gui/501/com.inkboard.team-fetch`：pid 22440 → 98799，日志新增 `fetcher start 005bd01e3a94`（fetcher.mjs 未改，哈希不变）。
- 未打断 19:38 打开的 `browser/xiaohongshu` 登录窗（9 个 Edge 进程仍在）。

## 线上冒烟（真实读取，不发群、不写线上 D1）

| 项 | 结果 |
|---|---|
| 雪球 `https://xueqiu.com/S/SH600519` | ✅ 贵州茅台 1435.26，+24.99（+1.77%），来源腾讯行情，911 ms |
| X thread（本机登录） | ✅ 20 条，8.5 s / 单跑 5.4 s |
| X profile | ✅ 1 条，author=`elonmusk`、source_url 有值，6.4 s |
| 成功读取后遗留 Edge | ✅ 0（读取返回后 2 s / 5 s 均为 0） |
| 2.5 s 强制超时 · 第 1 次 | ❌ 4250 ms 返回 timeout，遗留 **8** 个 `browser/x` Edge 进程（随后手动清理） |
| 2.5 s 强制超时 · 后续 3 次 | ✅ 2578 / 2586 / 2527 ms，遗留 0 |

19:54 在 `bf0a2c3` 临时 worktree 复跑三例：雪球 ✅（592 ms）；X thread / profile 均为 `upstream_unavailable`——连续多次读取后平台侧限流，读取器如实报错；此前 19:47 同一链接成功 20 条、profile 1 条。该次复跑后遗留 Edge = 0。证据 JSON 保留这次结果。

## P1 交回：超时清理存在竞态

- 复现：从 `browser/x` 零进程基线运行 `node /tmp/f9-timeout.mjs`（仓库内 `runner/reach-adapter.mjs`，`AbortSignal.timeout(2500)`，X thread）。
- 4 次中 1 次遗留 8 个 Edge（父 Edge pid 已 ppid=1）。表现分两类：清理快（≈2.5 s）→ 0；清理慢（≈4.25 s）→ 遗留。
- 推测：SIGTERM 在 `x-reader` 安装处理器之前/`live` 赋值之前到达，Node 默认退出；适配器 1500 ms 后只 SIGKILL `x-reader` 进程组，而 Edge 以 `detached:true` 自成一个组，于是成为孤儿。
- 建议修法（供工程师）：① `x-reader` 在任何 spawn 之前安装 SIGTERM/SIGINT，或在 spawn 后立刻把 child pid 写入固定文件；② 适配器在子进程退出后按 profile 兜底清理自己启动的浏览器组；③ 或不要把 Edge 放独立进程组，让它随 `x-reader` 组一起被杀。
- 该缺陷是既有问题的残余，不是本补丁引入的回归；线上旧版每次更严重，故未回滚。`off:reach=1` 可立即停全部读取。

## 其他

- 部署命令（不变）：`npm ci && npm run db:migrate && npm run deploy && npm run verify:release`，令牌只从 vault 文件读入环境变量。
- 线上设置核对：`reach:mode=on`，无 `off:reach` / `off:reach:xueqiu`。
- 回放输出：`.agent/releases/ledger-all/f9-postdeploy-20261114.json`。
- 未发群公告、未发任何 QQ 消息。
