# TeamAgent 部署与回滚手册

更新时间：2026-11-13 17:25（Sydney）· 编写：交付员 · 对应线上 commit `7cc3d8d`

## 0.1 上线铁律（2026-11-14 02:23 起，用户明确；优先于本手册其余所有关于 CI 的说法）

私有仓库 GitHub Actions 额度已用尽，CI 必然红或排队不跑。**一律本机上线，不等 CI、不看 CI 状态。**

- **门槛在本机：** 上线前在待发布的 commit 上本机跑 `npm run check && npm test && npm run check:ui`（有 Python 改动再跑 `python3 -m unittest discover -s test -p '*_test.py'`），再加该版本验收场景的真实消息回放（本地独立库，QQ 真实发送 0、线上 D1 写入 0）。全绿才上线。
- **GitHub 只做三件事：** 推送代码、开 PR（留记录）、合并进 main。不用 `gh run watch`、不用 `gh pr merge --auto`、不把 CI 状态当合并或上线条件，也不因 CI 红/排队而停下、返工或重试。
- **合并方式：** PR 能合就 `gh pr merge <N> --squash`（无分支保护，CI 红也能合）；若分支保护要求 CI，用管理员权限合并（`--admin`），仍不行就本地合并并 `git push origin main`。
- **部署：** 合并后在干净 worktree @main 按 §4 手动部署（`npm ci && npm run deploy && npm run db:migrate && npm run verify:release`，Cloudflare 令牌直接用本机文件 `/Users/yanghongming/.openmausbot/workspaces/84a475c8-fbf7-451e-a728-abf95d00d2af/.openmausbot-secrets/5749bcc8-0a0a-4c2e-aded-a3e19f5e84a4/vault-d612f6a6-8acc-4d43-ad6f-ba827221d268`（`CLOUDFLARE_API_TOKEN="$(cat 路径)"`，只读入命令，不打印/不落盘），WRANGLER_LOG_PATH 指 worktree 内；GitHub 只读令牌与 OpenAI 令牌同目录（`vault-1edf10b3-…`、`vault-73970260-…`）；**直接读文件，不再弹 request_credential 卡片、不等用户**），然后按 §5 重启本机服务（`python3 scripts/install-local.py --apply` + kickstart `com.inkboard.team-{qq,fetch,runner}`），最后 §6 只读冒烟。
- **上线检查表（逐项打勾，写进交付笔记）：**
  1. [ ] 本机 check / test / check:ui（/Python）全绿，数字写进交付笔记
  2. [ ] 验收场景真实回放通过（QQ 真实发送 0、线上 D1 写入 0）
  3. [ ] 已记下回滚点（`npx wrangler deployments list` 当前版本 id）
  4. [ ] PR 已开并合入 main（不等 CI）
  5. [ ] 手动部署 + `/health` release == main 提交
  6. [ ] 本机服务 running，fetch 服务 state=running（§9 竞态）
  7. [ ] 只读冒烟：新表存在、关键 settings 默认值、游标正常；不发群
  8. [ ] 自知卡版本核对（SK 上线后生效）：`curl /health` 的 `selfCard.commit` == `release` == 本次提交（`npm run verify:release` 已内置此项）；`npm run build` 过程里生成器无「未登记工具/失效 pattern」报错；本趟新增或下线的能力已在 config/self-manifest.json 登记。
- main push 后 GitHub 上的 Check run 红或 queued **忽略**，不影响线上，也不需要处理。

## 0.2 凭据文件（本机，24 小时有效，BINI 2026-11-14 交接）

- Cloudflare 部署：`/Users/yanghongming/.openmausbot/workspaces/84a475c8-fbf7-451e-a728-abf95d00d2af/.openmausbot-secrets/5749bcc8-0a0a-4c2e-aded-a3e19f5e84a4/vault-d612f6a6-8acc-4d43-ad6f-ba827221d268`（2026-11-14 16:40 实测可用）
- OpenAI：`/Users/yanghongming/.openmausbot/workspaces/84a475c8-fbf7-451e-a728-abf95d00d2af/.openmausbot-secrets/c1613f5d-894e-4534-a9f3-840eb5d66a8c/vault-73970260-31e0-4bbc-b281-40a36246fb2f`
- GitHub 只读：2026-11-14 16:40 核对，本机已无 `vault-1edf10b3-*` 文件；需要时重新申请。
- 全部 `0600`，只允许 `VAR="$(cat 路径)"` 形式进命令环境；不打印、不写入仓库/PR/日志/报告/聊天。失效先找 BINI，不找用户。

## 0. 结论先行

- 线上 Worker 当前 release = `7cc3d8d2949f725e326460192bb77404ee6c71ba`（PR #30 B 站回答字段，2026-11-13 17:23 Sydney，手动 `npm run deploy`，无 schema 改动；0003/0004 幂等重跑），Cloudflare 版本 **`f7cb76c8-dc63-4b30-a324-d9a15a7e4e31`**。
- 回滚点：`ca1a42db-cdd9-4ec9-a593-1ac28aff31d1`（release `cd222c4`，PR #28+#29）；再往前 `d14e069c-fe7b-4181-ab2b-768429bed2dc`（release `9707610`）。回滚 P2 前先按 §7.1 把待发的 `%~s` 行标记 skipped。
- 回滚链：`82539a1b-9d37-4239-8be4-cef1985864ec`（PR #11 B 站卡片，`057bb8f`）→ `2104da34-be16-4ad5-b7e6-b9a4d085e3b2`（B 站扫码 / X 登录，`954aa99`）→ `9c860bc1-2451-4960-801b-40bfa1fff123`（412 修复，`9b62fb6`）→ `fd434f24-1efe-4818-bc46-3466c6a88605`（P4b，`f16c96d`）→ `a3a3789f-6918-4fc3-8655-0a8aa8cd6b96`（P4a/P4c，`bd47d28`）→ `b4d796f7-3112-4364-aad6-581ca910dd0a`（P0，`803a3a6`）。手册更新于 2026-11-12 15:45：PR #11 合并后 6 个本机服务全部 running（含 team-fetch，PID 79087，runs=2），127.0.0.1:3391 返回 200；owner 服务 PID 92716、桌面入口 `~/Desktop/TeamAgent-登录.command` 不变。
- PR #11 发布后核对（15:30–15:45）：`/health` release = 合并提交 `057bb8f`；`fetch.log` / `fetch-error.log` 中 `卡片标题`、`SESSDATA`、`buvid3`、`BV`/`b23.tv`、疑似密钥命中 0；`runner.log` 为空、`runner-error.log` 不存在，无启动报错。QQ 群实测（无链接卡片、BV 链接两条真实消息）仍需用户发消息后观察。
- P1 实测：`chat_decisions` / `outbox_meta` 已建；`off:quote`、`off:wait` 写入 1 读回 1、恢复 0 读回 0；本机 6 服务 running；本地日志与 tail 中 `buvid3`/`SESSDATA`/密钥/base64/`sign=` 命中 0。合批、引用、图片预算待真实群消息。
- P2 实测（07:38–07:41，发图全程关闭）：a 非 owner `POST /api/team/stickers` 403、owner 导入 8×8 PNG 返回 `state=1`、706 KB 请求体在 owner 代理 413；b 当日 `budget:sticker_tag` 改 40 后再导入，计数 40→41、`state` 停在 1、`desc` 为空（未调看图）；c `off:sticker_collect` 写 1 读回 1、恢复 0 读回 0（窗口内无群消息，未实测拦截图片）；d `outbox` 无 `%~s` 行、`sticker_fail` / `sticker_paused_until` 不存在；e `wrangler tail` 28 个事件全 `ok`、无异常、无密钥/`buvid3`/`SESSDATA`/额度告警。测试行已全删。
- 线上实测（04:00）：`/api/team/vision/selftest` owner 返回 `ok:true`、1.05s、正确描述自检图；匿名 401；Jina 抓取与 X oEmbed 均可用；`wrangler tail` 3 条事件无密钥/无 base64/无签名 URL。
- 部署主路径是 **push 到 main → 自托管 runner 的 Check workflow 自动完成 migrate / deploy / verify / 本机热更新 / 重启桥**，不需要人工登服务器。
- 本机 5 个 launchd 服务全部 `state = running`；QQ 网关最后一条日志 15:29Z（= 02:29 Sydney）`resumed`。
- wrangler 登录已于 03:47 恢复（`whoami` 正常，账户 `fadeed4822ac4e4e518ed6eddc8d35ce`）；CI 于 03:48 用同一份 OAuth 配置完成 migrate / deploy / verify / 本机重启，链路已实测通过。

## 0.5 发布方式（2026-11-12 起）

- **2026-11-14 起 CI 不再使用，见 §0.1。** 旧记录：**自动部署已不可靠，默认手动发布**：私有仓库 Actions 额度/排队异常时，push 到 main 的 Check run 会长期停在 `queued`，migrate / deploy / 本机重启都不会执行。
- 合并后按 §4「手动部署」执行，最后必须 `node scripts/verify-release.mjs` 并核对 `/health` 的 `release` 等于合并提交，再按 §5 重启本机服务。
- 实例：2026-11-12 07:31 的两个 Check run（`43096524330`、`43096516318`）持续 `queued`，GitHub 取消接口返回 409「尚未真正入队」。
- **2026-11-12 15:27 起恢复（已实测）**：PR #11 合并后 Check run `43154913571` 正常入队并在 41 秒内跑完 `db:migrate` → `npm run deploy` → `verify-release` → `queue-runtime-reload`，新版本 `82539a1b-9d37-4239-8be4-cef1985864ec`、`/health` release `057bb8f`。仍按「先看 CI 是否真的跑起来，卡住则改走 §4」处理。

## 1. 现状快照（只读核对结果）

| 项 | 值 |
|---|---|
| 仓库 / 分支 | `OmnixSI/TeamAgent` · `main` = `76855aa` |
| Worker | `inkboard-team` · `https://inkboard-team.inkboard-server.workers.dev` |
| Cloudflare account | `fadeed4822ac4e4e518ed6eddc8d35ce` |
| D1 | `inkboard-team` / `42e95fb2-16f8-46d9-bf32-34f3e88a4443` |
| Queues | `inkboard-team`、`inkboard-team-chat`、`team-agent-tools`（各 batch=1） |
| Cron | `* * * * *` |
| wrangler.toml | 仓库根目录；与 runner 检出目录中的副本逐字一致 |
| CI 执行机 | 本机自托管 runner `actions.runner.OmnixSI-TeamAgent.hongming-teamagent`（launchd running） |
| 本机运行时 | `~/.inkboard-team/`（由 `scripts/install-local.py` 从 CI 检出目录复制，不是 git 工作区） |
| 本机服务 | `com.inkboard.team-qq` / `-runner` / `-owner` / `-utility` / `-utility-quick` 全部 running；`com.teamagent.runtime-reload` 每 30 秒轮询一次（空闲时应用新版本） |
| 日志 | `~/.inkboard-team/qq.log`、`runner.log`、`owner.log`、`utility.log`、`utility-quick.log`、`reload.log`（+ 同名 `-error.log`） |
| 私密配置 | `~/.inkboard-team/config.json`、`worker-secrets.json`（0600，**只看名字，不读值**） |
| Worker secret 名 | `ADMIN_TOKEN`、`RUNNER_TOKEN`、`DEEPSEEK_API_KEY`、`QQ_APP_ID`、`QQ_APP_SECRET` |

本机仓库副本（供执行成员改代码）：

```
/Users/yanghongming/Projects/.worktrees/TeamAgent-teamagent-p0   # 分支 agent/teamagent-p0，HEAD 76855aa
```

## 2. 部署前检查（每条都应通过）

```bash
cd <worktree>
git status --short                 # 必须干净（deploy.mjs 拒绝未提交改动）
git fetch origin && git log --oneline -1
node --version                     # v26.13.0（要求 >=24）
npx wrangler --version             # 4.159.0（要求 >=3）
npm ci && npm ci --prefix clients
npm run check && npm test && npm run test:runner && npm run check:ui
npm test --prefix clients
```

基线（2026-11-12 02:44 在 `76855aa` 实跑）：全部通过 —— `check` 0、`test` 50/50、`test:runner` 10/10、`clients` 2/2、`check:ui` 0。

## 3. （已停用，保留作参考）CI 自动部署

> 2026-11-14 起 CI 额度用尽，本节不再使用，按 §0.1 与 §4 本机部署。

`.github/workflows/check.yml` 在 `main` 的 push 上，于自托管 runner 依次执行：

```bash
python3 scripts/sync-runtime-secrets.py   # 用 GitHub secrets 同步 Worker secrets（不打印值）
npm run db:migrate                        # schema.sql + migrations/0002，--remote
npm run deploy                            # wrangler deploy --var RELEASE:<sha>，失败按 deploy-policy 重试
node scripts/verify-release.mjs           # 拉 /health，要求 release == 本 commit
python3 scripts/install-local.py          # 暂存到 ~/.inkboard-team/runtime-staging/<sha>
python3 scripts/queue-runtime-reload.py   # 写 pending-restart.json，等空闲再应用
```

操作就是普通的 PR 合并（本仓库 CI 对 main 的 push 自动发布，不需要人工 SSH）：

```bash
gh pr merge <PR号> --squash --delete-branch     # 或按用户要求手动合并
gh run watch $(gh run list -R OmnixSI/TeamAgent --limit 1 --json databaseId -q '.[0].databaseId')
```

注意：**不要在 PR 分支上跑 `npm run deploy`**——workflow 里部署步骤带 `if: github.ref == 'refs/heads/main'`，PR 只跑测试。

## 4. 手动部署（现行唯一方式）

前提：本机 `wrangler whoami` 是登录态（见 §7）。

```bash
cd <worktree> && git status --short          # 必须干净
npm run db:migrate                            # 只增表/索引，可重复执行
npx wrangler queues create inkboard-team-dlq        # 死信队列，已存在即视为成功
npx wrangler queues create team-agent-tools-dlq     # 死信队列，已存在即视为成功
npm run deploy                               # 自动写入 RELEASE=<sha>
node scripts/verify-release.mjs              # 失败即表示线上不是这个 commit
npx wrangler deployments list                # 记下新版本 id，供下次回滚
```

迁移脚本只执行 `schema.sql`（40 处 `IF NOT EXISTS`）与 `migrations/0002_plan_authority.sql`（`INSERT OR IGNORE`），可重复跑，不删历史数据。

两条死信队列（DLQ）必须先在账号里存在，否则 `wrangler deploy` 因 `dead_letter_queue` 校验失败。2026-11-14 14:25（Sydney）已创建：`inkboard-team-dlq`（id `b31a66760fa84c13af222d91cb5cd18c`）、`team-agent-tools-dlq`（id `979b8c3d81b84e4f88936f37208eedd1`）。`queues create` 对已存在的队列返回错误，按成功处理，不要重试或删除重建。

## 5. 重启本机桥 / runner

正常情况不用手动：CI 最后一步把 `pending-restart.json` 排进队列，`com.teamagent.runtime-reload` 每 30 秒查一次 `/api/runner/idle`，**确认没有 running 任务**后才 `install-local.py --apply` 并 `launchctl kickstart -k` 五个服务。留意 `~/.inkboard-team/reload.log` 出现「已在空闲时启用新版本本机服务」。

需要手动时（确认群里没有进行中的任务再动）：

```bash
cd <worktree>
python3 scripts/install-local.py            # 暂存到 runtime-staging（不动运行中的服务）
python3 scripts/queue-runtime-reload.py     # 交给空闲协调器
# 或对单个服务直接重启：
launchctl kickstart -k gui/$(id -u)/com.inkboard.team-qq
```

服务清单：`com.inkboard.team-qq`（QQ 长连接）、`-runner`（任务领取/执行）、`-owner`（127.0.0.1:3391 管理代理）、`-utility` / `-utility-quick`（文件与媒体处理）、`-fetch`（P4b 的 B 站只读抓取，`fetch.log` 启动行带 `fetcher.mjs` 的 SHA-256 前 12 位）。移除它：`python3 scripts/install-local.py --remove-fetch`。

## 6. 验证

```bash
# 1) 线上版本必须是本次 commit
curl -s https://inkboard-team.inkboard-server.workers.dev/health
#   期望 {"ok":true,"service":"team-agent","release":"<sha>"}

# 2) CI 结论
gh run list -R OmnixSI/TeamAgent --limit 5

# 3) 本机服务
for s in qq runner owner utility utility-quick; do
  launchctl print gui/$(id -u)/com.inkboard.team-$s | grep -m1 'state ='
done

# 4) 网关与日志
tail -20 ~/.inkboard-team/qq.log              # READY / RESUMED 即正常
tail -20 ~/.inkboard-team/reload.log

# 5) 群里实测（P0 验收）
#    发 @小王 后查最新一条 message_meta：
npx wrangler d1 execute inkboard-team --remote \
  --command "SELECT json FROM message_meta ORDER BY rowid DESC LIMIT 1"
```

失败判定：`/health.release` 与目标 commit 不一致、CI 红、任一服务非 running、`qq.log` 出现 4914/4915（平台拒绝连接，不要反复重启）。

## 7. 回滚

### 7.1 Worker 代码回滚（首选，秒级，不动数据）

**P2 回滚前置（必须先做）**：回到 `596ef25e-32fa-468d-bd5e-0601ce694021`（release `b40189d`，P2 之前）之前，如果还有待发（`status='pending'`）的表情行，先执行：

```bash
npx wrangler d1 execute inkboard-team --remote \
  --command "UPDATE outbox SET status='skipped' WHERE status='pending' AND id LIKE '%~s'"
```

原因：`%~s` 是 P2 专用的表情 outbox 行，P2 之前的代码不认识此后缀，会把 `[表情]` 当成普通发言发出去。先跳过再回滚，或回滚后立刻执行同一条。

```bash
# 回到 P2 之前的线上版本（596ef25e，release b40189d）
npx wrangler rollback 596ef25e-32fa-468d-bd5e-0601ce694021

# 或者回到上一个版本
npx wrangler rollback 618a8173-f09b-4dad-aa59-57b862fb24d5
# 不带参数则回滚到上一个部署
npx wrangler rollback

# 回滚后确认
curl -s https://inkboard-team.inkboard-server.workers.dev/health
```

D1 迁移是加表加索引、`message_meta` 新键旧代码不读，**回滚代码不需要回滚数据库**；不要反向删列删表。

### 7.2 本机运行时回滚

```bash
cd <worktree> && git checkout <上一个可用 sha>
python3 scripts/install-local.py && python3 scripts/queue-runtime-reload.py
# 若 P4b 要一起回退，先移除抓取服务再重启：
python3 scripts/install-local.py --remove-fetch
# 紧急时直接重启到当前已安装文件：
launchctl kickstart -k gui/$(id -u)/com.inkboard.team-qq
```

`~/.inkboard-team/backups/before-TeamAgent-20261111.json` 是 2026-11-11 21:40 的 D1 导出备份（412 KB），只在数据被改坏时用，普通代码回滚不要碰它。

### 7.3 完全回滚到部署前

```bash
git revert <merge commit> && git push origin main     # 触发 CI 重新部署，/health 会变成新的 revert commit
```

## 8. 需要用户本人做的事

1. **wrangler 部署令牌（2026-11-14 16:40 核对可用，不必再登录）**：`export CLOUDFLARE_API_TOKEN="$(cat /Users/yanghongming/.openmausbot/workspaces/84a475c8-fbf7-451e-a728-abf95d00d2af/.openmausbot-secrets/5749bcc8-0a0a-4c2e-aded-a3e19f5e84a4/vault-d612f6a6-8acc-4d43-ad6f-ba827221d268)"`；只读入命令，不打印、不落盘。旧路径 `/Users/yanghongming/.openmausbot/workspaces/a079e8c4-a847-4c53-8c57-ba0e803e5a45/...` 已失效（No such file）。
2. **QQ 平台侧**：若 `qq.log` 出现 4914/4915，是腾讯侧应用状态/额度问题，需要用户去 QQ 开放平台处理，重试无效。
3. **Cloudflare Workers Paid（$5/月，已购）**：只用套餐自带额度，不开任何附加项、不做会产生超额账单的设计；确实需要额外付费先问用户。D1 只读查询与迁移都在套餐内。

## 9. 已知限制（本次核对）

- **2026-11-12 07:31 起 CI 队列卡死**：PR #7 合并后 push / ready_for_review / workflow_dispatch 触发的 Check run 全部停在 `queued`，`jobs.total_count=0`（连 job 都没创建）；自托管 runner `online`、`busy=false`、重启 runner 与 GitHub 侧状态页均正常。P2 因此改走 §4 手动部署（release `31d0c2c`，版本 `fd402a51`）。CI 恢复后 main push 仍会自动部署，无需改流程。2026-11-12 15:27 PR #11 合并后的 main push 已正常自动部署完成（见 §0.5）。
- 本机 runtime 未随本次升级：`install-local.py` 写 `~/.inkboard-team` 被沙箱拒绝；P2 的 diff 不含 `runner/`、`scripts/`、`clients/` 文件，本机桥代码无需更新，六个服务保持原版本 running。
- 我的 shell 受沙箱限制：`ps` 不可用（进程状态改用 `launchctl print` 判断）。`wrangler whoami` 的失败已排除权限因素：wrangler 日志显示 `failed to fetch auth token: 400 Bad Request`，是 Cloudflare 侧拒绝刷新令牌。
- `wrangler deployments list` 需要登录态，本次未跑；上面的版本 id 取自 wrangler 部署日志（`Current Version ID: d410c228…`）并与 `/health` 的 release 交叉核对。
- 本机没有一份「用户日常开发用」的 TeamAgent 检出：`~/Projects` 下只有 `.worktrees/…`。CI 的检出在 `~/.inkboard-team/github-runner/_work/TeamAgent/TeamAgent`（HEAD 76855aa，wrangler.toml 与仓库一致）。
- **2026-11-13 00:54 部署发现 fetcher 重载竞态**：CI 空闲重载调用 `install-local.py --apply` 时，若 fetcher plist 内容变化（CI 的 node 24 与 nvm node 26 路径来回切换），脚本 bootout 后立即 bootstrap 会失败（`reload.log` 出现「警告：team-fetch 加载失败」），fetcher 停在未加载状态。本次已用 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.inkboard.team-fetch.plist` 恢复，并把 plist 固定在 nvm node `v26.13.0`；以后每次部署后都要核对 `com.inkboard.team-fetch` 的 `state = running`。

## 10. OpenAI 密钥与生图/识图上线

F8 起，生图与 OpenAI 识图增强共用 Worker secret `OPENAI_API_KEY`（原 Workers AI binding 那条通道不需要它）。**密钥只在部署机内存里过一遍：不进仓库、不进日志、不进 PR、不写笔记。**

### 10.1 部署员取密钥（保险库 → wrangler stdin）

1. 用安全卡片取保险库「OpenAI-api」的私有文件路径：`request_credential(label:'OpenAI-api', delivery:'file')`。（已保存过的凭据会立即返回路径，不再弹卡。）
2. 直接把文件喂给 wrangler，不 `echo`、不 `cat`、不放进命令行参数或 shell 历史：

```bash
npx wrangler secret put OPENAI_API_KEY < "$OPENAI_KEY_FILE"
```

3. 确认 `wrangler secret list` 里出现该名字后，按需删除临时文件；不要把它复制进仓库目录。

### 10.2 CI 路径（GitHub secrets）

仓库 Settings → Secrets and variables → Actions 增加 `TEAM_OPENAI_API_KEY`（值与保险库一致）。CI 的 `python3 scripts/sync-runtime-secrets.py` 会把它映射为 Worker 的 `OPENAI_API_KEY`；**未配置时只打印「未设置 TEAM_OPENAI_API_KEY，跳过 OPENAI_API_KEY」，不报错，也不影响其余 6 个必需 secret**（`scripts/sync-runtime-secrets.py:7,33-37`）。CI 日志只出现名字，不出现值。

### 10.3 部署前核对（7 个名字）

```bash
npx wrangler secret list
```

期望恰好包含：`ADMIN_TOKEN`、`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`OPENAI_API_KEY`、`QQ_APP_ID`、`QQ_APP_SECRET`、`RUNNER_TOKEN`。少一个都先补齐再部署；该命令只显示名字和类型，不显示值。

### 10.4 部署后只读冒烟（一次，约 $0.01）

用 owner 会话（`ADMIN_TOKEN` 作为 Bearer）调一次：

```bash
curl -s -H "Authorization: Bearer $TEAM_ADMIN_TOKEN" \
  https://inkboard-team.inkboard-server.workers.dev/api/team/imagegen/selftest
```

期望 HTTP 200：`{"ok":true,"latency_ms":<数字>,"bytes":<正数>,"width":1024,"height":1024,"model":"gpt-image-1"}`。

- 只允许 owner：匿名 401、已登录的非 owner 403；每小时最多 2 次，第 3 次返回 429 且 `error_kind:"quota"`。
- 自检把 DB 置空：不写 `openai_usage`、不写图片日志、不往群里发消息。
- 失败只返回 `{ok:false,error_kind,next_action}`；不回显密钥、prompt 或上游原文。若 `error_kind:"auth"`，先按 10.3 核对名字，再核对 10.1/10.2 的值来源。

### 10.5 回滚（二选一，立即全关）

```bash
# A. 删 secret：代码保留，所有 OpenAI 调用得到 auth 失败
npx wrangler secret delete OPENAI_API_KEY

# B. 不动代码：总开关，所有 OpenAI 用途直接拒绝（settings 主键为 key）
npx wrangler d1 execute inkboard-team --remote \
  --command "INSERT INTO settings(key,value) VALUES('off:openai','1') ON CONFLICT(key) DO UPDATE SET value='1'"

# 恢复总开关
npx wrangler d1 execute inkboard-team --remote \
  --command "DELETE FROM settings WHERE key='off:openai'"
```

### 10.6 价格 / 限额默认值

| 项 | 默认值 | 位置 / 说明 |
|---|---|---|
| 模型 | `gpt-image-1` | settings `imagegen:model` 可覆盖；最终以生图探针结论为准 |
| 尺寸 / 质量 | `1024x1024` / `low` | 生图默认；尺寸可 `1024x1536`、`1536x1024`，质量可 `low`/`medium`/`high` |
| 输出 | JPEG，压缩 80 | `output_format:'jpeg'`、`output_compression:80`，Worker 不转码 |
| 单次估价 | 约 $0.01（low 1024²） | 按 OpenAI 公开价目估算，实际以账单为准；自检也按这一档计 |
| 每人每天 | 5 张 | settings `imagegen:user_daily` |
| 每群每天 | 20 张 | settings `imagegen:group_daily` |
| 全局每天 | $3（3,000,000 µUSD） | settings `openai:daily_cap_micro_usd` |
| 自检频率 | 2 次/小时 | 端点内存计数，重新部署后清零 |
| 生图超时 | 100 s | 调 OpenAI Images API |

价格数字只是预算锚点，不是报价；调档先改 settings，不改代码常量。

## 11. 每趟上线的群公告（用户 2026-11-14 02:18 固定要求，从趟 0 起每趟都带）

上线检查表（每趟必须按顺序走完，缺一项不算上线完成；**合并门槛与 CI 政策以 §0.1 为准**）：

0. 本机全量测试 + 真实回放通过；**不等 CI、不把 CI 状态当条件**（见 §0.1）。
1. 记录回滚点（当前线上 Worker 版本号）→ 写入 status.md 该趟记录。
2. 部署前只读确认线上正常：入站（最新消息时间在近期）、出站（无 pending/sending 积压）、入站游标（`/api/team/state` connection）。
3. 部署（§6 的命令）。
4. 只读冒烟通过：/health.release 等于目标 commit，且 /health.selfCard.commit 同值（SK 上线后）；入站/出站/游标正常；该趟特有检查（如 mention-* 无新增）。
5. 发群公告（下面规则），发完把出站行号写回 status.md。
6. 更新 status.md、开发室 ≤6 行、回报 BINI（含公告原文）。

公告规则：

- 一趟只发**一条纯文字**，口语、直白说这趟新增了什么能力；不出现版本号、PR、接口、报错等技术词。只写**已上线并验证过**的能力，没验证的不写。
- 文案**先写进 status.md 该趟记录**（字段「群公告」），由交付员在冒烟通过后发出。
- **唯一去重键**：出站行 id 固定为 `release-notice:<趟名>`（如 `release-notice:trip0`），用 `INSERT OR IGNORE`；发之前先 `SELECT` 该 id，已存在（无论状态）就**绝不再发**。失败只记录原因，**不重试、不换 id 重发**，不影响上线结论。
- 只写出站队列（outbox 一行，msg_type 0 文本，群为唯一群）：不碰入站游标、不改入站记录、不写别的表。
- 公告是用户明确授权的一条；除此之外回放、验收、冒烟仍一律不得往群里发。
- 发完只读确认：该行 status 变 sent（或如实记失败），且 outbox 里没有第二条同类行。

## 12. 凭据获取方式（2026-11-14 起）

- 用户已存好的 Cloudflare 部署令牌、OpenAI 密钥、GitHub 只读令牌，由 BINI 生成为私有文件（24 小时后自动删除，到期 BINI 重新生成并发新路径）；施工成员**直接用文件路径，不再弹卡、不再让用户手点**。
- 用法：只在命令里读，例如 `CLOUDFLARE_API_TOKEN="$(cat <路径>)" npx wrangler ...`；不打印、不写进仓库/PR/日志/报告/聊天；路径值只在 BINI→主程→成员的派单里传，不写进本文件。
- 凭据缺失或路径失效：找 BINI，不要找用户。出现的 xAI key、1Password 令牌卡片与本项目无关，直接忽略。
