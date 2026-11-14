# A2 部署命令与回滚

> 2026-11-14 15:11–15:19 Sydney · 交付员 · worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-A2-release`（release/A2 @ c830efa）

## 1. 部署前

```bash
cd /Users/yanghongming/Projects/.worktrees/TeamAgent-A2-release
git status --porcelain --untracked-files=no     # 空
npm run check && npm run check:ui               # 0 错
npm test                                        # 1949/1939/0/10
```

依赖没变（相对 main 无 package*.json diff），复用 `node_modules`（软链到 TeamAgent-A-release）；没有跑会破坏共享软链的 `npm ci`。

## 2. 部署

Cloudflare 令牌走本机 0600 文件，只进命令环境，不打印、不落盘：

```bash
CF=/Users/yanghongming/.openmausbot/workspaces/84a475c8-fbf7-451e-a728-abf95d00d2af/.openmausbot-secrets/aa12d914-7616-4e19-a983-bfc1dd2fdfcf/vault-d612f6a6-8acc-4d43-ad6f-ba827221d268
export CLOUDFLARE_API_TOKEN="$(cat "$CF")"
export WRANGLER_LOG_PATH="$PWD/.wrangler/logs"

npm run db:migrate        # 102 + 19 条幂等迁移，无新迁移
npm run deploy            # wrangler deploy --var RELEASE:c830efa…
node scripts/verify-release.mjs
```

- 新 Worker：`ead62cca-0164-478f-a6d7-08e6fbf1ec2f`
- 回滚点：`32aa437b-c433-4374-9b84-3184851dedd0`（release `e67743f`）
- review Worker：`git diff a6f34f0 c830efa -- src/review wrangler.review.toml` 为空，不重发；仍 `88ab4e46-71fb-47e8-b0ff-e048d6d7faf3`。

## 3. 本机

```bash
python3 scripts/install-local.py --apply       # 需 full-access
for s in qq fetch runner owner utility utility-quick media; do
  launchctl kickstart -k gui/$(id -u)/com.inkboard.team-$s
done
```

- 6 个常驻服务 running；media 是 60s 定时单次任务（`runs=43`、`last exit 0`，两次之间 not running 正常）。
- 最终运行目录从合并后的 main `e6edc94` 安装，保留另一条语音线程的 `runner/toolchain.mjs`；本机 runner 比线上 Worker 新一个合并提交，差异只在 A-ttspath。

## 4. 回滚

```bash
export CLOUDFLARE_API_TOKEN="$(cat "$CF")"
cd /Users/yanghongming/Projects/.worktrees/TeamAgent-A2-release
node_modules/.bin/wrangler rollback 32aa437b-c433-4374-9b84-3184851dedd0
curl -s https://inkboard-team.inkboard-server.workers.dev/health
```

回滚后本机运行目录需从 `e67743f` 重新 `install-local.py --apply` 并 kickstart；或者直接回滚到 `e67743f` 对应的 worktree（TeamAgent-A-release 需要先 fetch）。

## 5. 备注

- 部署期间未改业务代码；唯一的合并冲突（`src/quota.ts`、`test/quota.test.mjs`）是 main 与 A2 对同一处「生图关闭时隐藏额度行」的重复修复，取 A2 侧，内容与 c830efa 逐字一致。
- 公告 `release-notice:quota-open` 只 INSERT outbox（rowid 284），未动游标、未发测试群消息。
- 自测回放脚本：`.agent/releases/A2/replay-quota-live.mjs`。
