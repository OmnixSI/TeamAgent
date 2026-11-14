# TeamAgent 发布清单（2026-11-13 08:4x Sydney）

## 目标版本

- main HEAD：`71deb11e922ea088b15d614bfa0b2a2dfd2c31ca`（C3 合并，PR #24）
- 本次包含：PR #23（C1 仓库索引，`61fb8cf`）、PR #22（链接失败如实告知，`dfc778c`）、PR #24（C3 本机侧，`71deb11`）
- 线上当前 release：`384b420`（/health 已确认）

## 前置条件

- **`npx wrangler whoami` 当前未登录**：token 已过期且无法刷新，部署前必须由用户完成一次浏览器授权。
- 远端 D1 迁移 **0004 尚未执行**（C1 的 `repo_state` 等表）。
- 本机 fetcher 仍是旧版：`~/.inkboard-team/fetcher.mjs` 哈希 `3d00d48ac212d555…`，main 为 `4354449e2c5cf891…`，发布前需 `scripts/install-local.py --apply`。

## 回滚点

- Worker 上一版：Cloudflare version **`d29cb0f5-8f23-466d-aa31-24f2578637b4`**（release `384b420`）。
- 再往前：`46d237d0-2af8-4393-a143-8a2103dbef7b`（`0f67b28`）、`ca76d810-aed1-4b1b-9eab-bbc245ebe11e`（`0039e5f`）。
- fetcher 回滚：更新前的 `~/.inkboard-team/fetcher.mjs`（哈希 `3d00d48a…`）；建议安装前先复制为 `fetcher.mjs.bak`。
- 迁移 0004 只新增表，代码回滚可保留。

## 发布步骤

1. 用户完成 `wrangler login`（浏览器点 Allow）。
2. `npm run db:migrate`（应用 0004；schema 51 条 + 0002 + 0003 + 0004）。
3. `npm run deploy`（Worker）。
4. `node scripts/verify-release.mjs`，核对 `/health` = `71deb11…`。
5. `python3 scripts/install-local.py --apply`（更新 runner / 重建桌面入口）。
6. 重启 `com.inkboard.team-owner`、`com.inkboard.team-fetch`。
7. 只读检查 `repo_state` 有行；设 `off:repo_tools=0`/清除开关。
8. 群内验收：最近改了什么 / `0f67b28` 改了什么 / bridge 停 15 分钟后回复「N 分钟前状态」。

## 本次不执行

- 不部署、不登录 Cloudflare、不改 secrets、不发群消息。
