# TeamAgent 接手包

> **2026-11-14 21:15（悉尼）更新：群里的 Bot 已切到 v2，整套跑在 Cloudflare（Worker `teamagent`），不再依赖任何本机进程。先读 [`v2/README.md`](v2/README.md)。**
>
> - 旧 Worker `inkboard-team` 只剩团队开发台网页：它的 QQ 发信密钥和定时触发已撤掉，不再往群里说话。
> - 群主 Mac 上的 TeamAgent 常驻服务（QQ 网关、执行器、抓取、媒体、GitHub runner 等 11 个）已 `launchctl disable`，文件原样保留在 `~/.inkboard-team/`。
> - `.github/workflows/check.yml` 已在 GitHub 上停用（它只能跑在群主 Mac 的自托管 runner 上）。发布改为 `npx wrangler deploy -c v2/wrangler.toml`。
> - 下面是 v1 时期的接手说明，留作历史参考；其中“先修自动发布”“未兑现需求”等条目对 v2 已不适用。

---

## v1 接手说明（2026-11-14 20:00，历史）

> 这份文档是接手 TeamAgent 的第一入口。到 2026-11-14 为止，项目一直由 OpenMausBot 多代理编队（BINI 总指挥 + DeepSeek/Codex/Claude 成员）开发。该编队已于 2026-11-14 晚停用，之后由人或单个编码助手（Claude Code、Codex 等）直接在本仓库维护。
>
> 先读这一页，再按需读 [README](README.md)、[维护手册](docs/maintenance.md)、[运维与恢复](docs/operations.md)、[产品决定](docs/decisions.md)、[不再采用的做法](docs/declined.md)。

## 1. 它是什么

常驻「做 AI 高手」QQ 群的项目搭子机器人，加一个团队开发台网页。能聊天接梗、看图/表情、读 B 站/X/知乎/雪球等链接、听写语音、发语音、生图、记住团队决定、建定时任务、读文档、查仓库，并把复杂开发接力给成员。

```
QQ 群 ──(官方长连接)──> 本机 QQ 网关（用户 Mac，launchd 常驻）
                              │
                              ▼
               Cloudflare Worker `inkboard-team`（主逻辑、开发台网页）
               D1 `inkboard-team`（持久权威） + 5 条 Queues（唤醒）
                              │
                              ▼
       本机执行器：文件/视频/开发任务、B 站/X/小红书登录与读取、语音转写
```

模型：DeepSeek（主力，`deepseek-flash`，high/max 两档）；OpenAI（识图 Luna、生图 `gpt-image-2.5-flare`、语音）；Workers AI（每天免费额度内识图，超额硬闸回退）。

## 2. 东西都在哪

| 东西 | 位置 | 备注 |
|---|---|---|
| 源码 | GitHub `OmnixSI/TeamAgent`（私有），默认分支 `main` | 所有代码、配置、提示词、文档 |
| 线上 Worker | `inkboard-team`，网址 https://inkboard-team.inkboard-server.workers.dev | `/health` 返回线上提交号 |
| 复盘 Worker | `inkboard-team-review`（`wrangler.review.toml`） | **尚未部署**，缺 DeepSeek/OpenAI 密钥与价格变量，见第 5 节 |
| D1 | `inkboard-team`，id `42e95fb2-16f8-46d9-bf32-34f3e88a4443` | 群消息、记忆、任务、发送记录，全部持久数据 |
| Queues | `inkboard-team`、`inkboard-team-chat`、`team-agent-tools`，死信 `inkboard-team-dlq`、`team-agent-tools-dlq` | |
| Cloudflare 套餐 | Workers Paid $5/月（2026-11-14 起） | 只用套餐自带额度，不开附加项；要加钱先问群主 |
| 本机运行目录 | 群主 Mac `~/.inkboard-team/`（0700） | 密钥、QQ session、spool、日志、浏览器登录、GitHub runner |
| 本机服务（launchd） | `com.inkboard.team-qq` / `-runner` / `-owner` / `-utility` / `-utility-quick` / `-fetch`（可选 `-media`） | 重启：`launchctl kickstart -k gui/$(id -u)/<服务名>`，别在处理中途重启 |
| 本机管理页 | http://127.0.0.1:3391/ | 先双击桌面「TeamAgent-登录.command」解锁；B 站扫码、X 登录在这里 |
| 自动发布 | `.github/workflows/check.yml`，跑在群主 Mac 上的自托管 runner（标签 `teamagent`，名字 `hongming-teamagent`） | push 到 `main` → 检查 → 同步密钥 → D1 迁移 → 部署 → 更新本机服务 |
| GitHub Actions Secrets | `DEEPSEEK_API_KEY`、`TEAM_ADMIN_TOKEN`、`TEAM_RUNNER_TOKEN`、`TEAM_QQ_APP_ID`、`TEAM_QQ_APP_SECRET`、`TEAM_AUTOLOOP_SOURCE_KEY`（待加 `CLOUDFLARE_API_TOKEN`，见下） | 值不进仓库、日志、群聊 |
| Worker 密钥 | `ADMIN_TOKEN`、`RUNNER_TOKEN`、`DEEPSEEK_API_KEY`、`QQ_APP_ID`、`QQ_APP_SECRET`、`GITHUB_TOKEN`、`OPENAI_API_KEY` | 由 `scripts/sync-runtime-secrets.py` 从本机 `~/.inkboard-team/worker-secrets.json` 同步 |
| 编队留下的工作笔记 | [`docs/handoff/archive/`](docs/handoff/archive/) | 每个版本的 design/status/next、用户需求总账、线上盘点、调研与评审报告 |
| 未合并的工作 | 16 个分支 + 归档分支 `archive/2026-11-14`，见第 4 节 | |

## 3. 现在的状态（2026-11-14 20:00 悉尼）

### 3.1 先修这一个：自动发布坏了

`main` 最近两次 push（`bf0a2c3` #57、`a3c9c95` #58）的 Check 都在「Deploy shared team service」失败：

```
In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.
```

原因：发布靠群主 Mac 上 `wrangler login` 的 OAuth 会话，它过期了。**所以线上很可能停在 `5122f3f`（F11fix，19:43 手动上线），#57、#58 还没上线**，以 `/health` 为准。

修法（二选一，推荐 A）：

- **A. 换成长期 API Token（一劳永逸）**
  1. 在 Cloudflare 后台 → My Profile → API Tokens → Create Token，用「Edit Cloudflare Workers」模板，再给 D1 Edit 权限，账户限定为本账户。
  2. 在 GitHub 仓库 Settings → Secrets and variables → Actions 新建 `CLOUDFLARE_API_TOKEN`。
  3. 本 PR 已经让发布步骤读取这个 Secret；为空时自动退回本机 wrangler 登录，不影响现状。
  4. Actions → Check → Run workflow 重新发布 `main`，然后看 `/health`。
- **B. 临时**：在群主 Mac 的终端运行 `cd ~/.inkboard-team/github-runner/_work/TeamAgent/TeamAgent && npx wrangler login`，再 Run workflow。几周后还会过期。

另外 runner 上还挂着一个一直 `in_progress` 的 PR 检查（`release/F9-reader` 1da5c65）。如果新任务一直排队，在 Actions 页面取消它。

### 3.2 线上已有的能力

见 [`docs/handoff/archive/agent-releases/ledger-all/live-state.md`](docs/handoff/archive/agent-releases/ledger-all/live-state.md)（19:10 只读盘点）和 [`ledger-all/status.md`](docs/handoff/archive/agent-releases/ledger-all/status.md)。

已上线并有真实证据：B 站短链/无字幕转写、语音收发、看图和表情、读文档、余额查询、联网搜索/OCR、自知卡（问「这个能力怎么实现的」能答）、F11 @提需求登记（`5122f3f`）、生图「画好了」假回执拦截（#54/#55）。

### 3.3 用户提过但还没兑现的（优先级从高到低）

完整原话、日期和验收标准在 [`user-asks.md`](docs/handoff/archive/agent-releases/ledger-all/user-asks.md)（80 条）。没兑现的主要是：

1. **每天悉尼 8:00 推送昨日聊天总结**：承诺过两次，两个早上都没发。唯一的 schedule 14:05 才建，首跑 11-15 08:00，要亲眼确认那天发出来了。
2. **每天北京时间 0 点发 DeepSeek 余额**：用户 17:12 明说了时间，bot 还在反问几点，`schedules` 没有这一行。
3. **群账本**：没有持久表，「合计 ¥710」是对话里现算的。代码在 `release/D` / `wip/pkg-D-D4-20261114`（账本工具 + 定时 v2 + 自建工具），D4 阶段 2 回放 16 过 7 败，未上线。
4. **生图真实闭环**：开关已开，但线上从没被真实请求触发过一次成功出图；手工自测图已发。下一条真实「画一个…」请求要盯日志（`image_gen_log`、`generated_images`）。
5. **夜间自省/复盘**：影子模式已上线，`review_reports` 还是 0 行；复盘 Worker 没部署（见 3.1 表格与第 5 节）。
6. **受控执行 / 自建技能 / 子代理真跑**：在 `release/D`、`wip/pkg-V-B-B6-20261114`，未上线。

### 3.4 已知小问题（不挡上线）

- `test/mention-guard.test.mjs` MG2：D1 语句预算断言依赖整点，悉尼 19:00 左右实测 50 > 48，`main` 本身也红。修法：把时钟 mock 到非整点。
- 模型偶尔把工具调用写成正文（`<｜｜DSML｜｜ calls>` 残片），`src/voice.ts` 出口只丢弃含 DSML 的行，上游根因未修。
- 代码位置类问题（「在哪个文件」）偶尔被转成后台任务。
- `test/docread_test.py` 需要 reportlab，本机 venv 没装，直接跑会全 ERROR。

## 4. 未合并的工作（都已推上 GitHub）

编队留下了 150 多个本地分支和工作副本。处理方式：

- **全部** 145 条有 `main` 没有的提交的本地分支，都挂在归档分支 `archive/2026-11-14` 的一个归档提交下（内容和 `main` 一样，只是把这些提交留在 GitHub 上）。原分支名和提交号的对照在 [`docs/handoff/archive-branches.md`](docs/handoff/archive-branches.md)。恢复某条：`git fetch origin archive/2026-11-14 && git switch -c <新分支> <提交号>`。**不要合并 `archive/2026-11-14` 本身。**
- 最近还在做的 16 条推成了分支，见下表。
- 7 个工作副本里有**没提交的改动**，原样快照成 `wip/*` 分支（未审查、未测试）。提交说明里写了来自哪个副本。

很多 `pkg/*` 其实已经通过 PR #48–#58 以 squash 方式合进 `main`，git 看不出来。**合任何一条之前，先 `git diff origin/main...<分支>` 看还剩什么**，别整条硬合。

| 分支 | 最后提交（悉尼） | 最后一条提交说明 | 相对 merge-base 的改动 |
|---|---|---|---|
| `release/D` | 11-14 19:31 | merge: D4 stage 2 (intent wiring, schedule v2, ledger tools) | 96 文件, +17420 −452 |
| `release/V-D` | 11-14 10:15 | fix(authz): whitelist full task labels before splitting at a colon | 82 文件, +17848 −21 |
| `release/B-f9` | 11-14 14:51 | fix: detect the flat reach CLI through symlinked paths | 60 文件, +4398 −16 |
| `pkg/F9r` | 11-14 19:15 | fix: read the zhihu hot list from the public web feed | 54 文件, +3872 −17 |
| `pkg/F9-reader-timeout` | 11-14 19:58 | fix(reach): reap the reader's browser on a hard timeout | 4 文件, +57 −11 |
| `pkg/C-f91` | 11-14 17:37 | feat: port Tencent stock quote tool to main (F9-1) | 12 文件, +737 |
| `pkg/D-emoji` | 11-14 17:47 | feat(vision): add opt-in vision event log | 30 文件, +2053 −84 |
| `pkg/DS-live-verify` | 11-14 14:09 | test(ds-live): allow custom synthetic TTS text without long audio | 6 文件, +1363 |
| `pkg/cleanup-at-source` | 11-14 18:59 | chore(test): 测试与回放临时目录统一 teamagent-test- 前缀 | 47 文件, +715 −60 |
| `wip/pkg-D-D4-20261114` | 11-14 20:04 | 快照：pkg/D-D4（账本/定时 v2 阶段 2，施工中） | 100 文件, +18063 −466 |
| `wip/release-F7m-20261114` | 11-14 20:04 | 快照：release/F7m | 89 文件, +12278 −42 |
| `wip/agent-event-v2-g4-20261114` | 11-14 20:04 | 快照：agent/event-v2-g4（事件层 v2 G4 回放夹具） | 90 文件, +15370 −379 |
| `wip/agent-login-fix-20261114` | 11-14 20:04 | 快照：agent/login-fix（B 站/X 本机登录） | 6 文件, +281 −32 |
| `wip/pkg-F8-2-20261114` | 11-14 20:04 | 快照：pkg/F8-2（生图） | 70 文件, +10247 −7 |
| `wip/pkg-F8-3-20261114` | 11-14 20:04 | 快照：pkg/F8-3（生图） | 70 文件, +9772 −8 |
| `wip/pkg-V-B-B6-20261114` | 11-14 20:04 | 快照：pkg/V-B-B6（子代理执行器） | 30 文件, +659 −142 |

建议的接续顺序：

1. 修好 3.1 的自动发布，让 #57、#58 上线。
2. 从 `release/D` 拆出**定时 v2 + 账本**单独上线（解决 3.3 的 1–3），设计和验收在 [`agent-releases/D/`](docs/handoff/archive/agent-releases/D/)。
3. 部署复盘 Worker（第 5 节）。
4. 其余按 [`user-asks.md`](docs/handoff/archive/agent-releases/ledger-all/user-asks.md) 的优先级逐条做，每条都要有真实群消息的证据才算完成。

## 5. 复盘 Worker（`inkboard-team-review`）怎么上线

代码在 `main`（`src/review/`），配置 `wrangler.review.toml`，`REVIEW_MODE = "shadow"`（只出报告，不自动改行为）。上线前需要：

```sh
npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.review.toml   # 交互输入，不要写进命令行历史
npx wrangler secret put OPENAI_API_KEY   --config wrangler.review.toml   # 可选
# 在 wrangler.review.toml 填 DEEPSEEK_INPUT_USD_MICROS / DEEPSEEK_OUTPUT_USD_MICROS（每 token 的美元微分，按 DeepSeek 官方价）
npx wrangler deploy --config wrangler.review.toml
```

价格变量为空时该模型不会被调用。日/月花费上限已在文件里（DeepSeek 每天 $0.10、整体每月 $10）。

## 6. 日常维护

### 改代码的流程（不再有编队后）

```sh
git switch -c feat/<名字> origin/main
npm ci
# 改代码
npm run config:check && npm run check && npm test && npm run test:runner && npm run check:ui
git push -u origin feat/<名字>   # 开 PR，Check 只做检查
# 合进 main 后自动发布（需要 3.1 修好）
```

- 推荐用一个编码助手（Claude Code / Codex）直接在仓库里干，它会读 `AGENTS.md`。一次只开一个分支，做完合进去再开下一个。
- **一次做一个完整的功能再上线**，不要修一点上线一次。
- 本地回放和测试**绝不写线上 D1**（2026-11-14 凌晨的掉线事故就是回放写了线上游标）；也不往真群发测试消息。
- 发布后看 `/health` 提交号、开发台「运行状态」、`qq.log`。

### 回滚

- 代码：`git revert <坏提交>` 推到 `main`，自动发布回滚版本。
- 急救：Cloudflare 控制台 → Workers → `inkboard-team` → Deployments 回滚到上一个版本，再补 revert 让源码和线上一致。
- D1 不靠删表回滚；Workers Paid 有 30 天 Time Travel。

### 不用部署的紧急开关（写 D1 `settings`）

```sql
-- 停插话等待 / 停引用 / 停发表情 / 停读表情 / 停生图
INSERT INTO settings(key,value) VALUES('off:wait','1') ON CONFLICT(key) DO UPDATE SET value='1';
INSERT INTO settings(key,value) VALUES('off:quote','1') ON CONFLICT(key) DO UPDATE SET value='1';
INSERT INTO settings(key,value) VALUES('off:sticker_send','1') ON CONFLICT(key) DO UPDATE SET value='1';
INSERT INTO settings(key,value) VALUES('off:emoji_read','1') ON CONFLICT(key) DO UPDATE SET value='1';
INSERT INTO settings(key,value) VALUES('off:image_gen','1') ON CONFLICT(key) DO UPDATE SET value='1';
-- 恢复：DELETE FROM settings WHERE key='<键>';
```

执行方式：`npx wrangler d1 execute inkboard-team --remote --command "<SQL>"`。

### 本机（群主 Mac）

- 电脑要登录、联网、不睡眠，否则 QQ 收信、文件和开发任务全停（网页和数据在云端不受影响）。
- QQ 断线先看 `~/.inkboard-team/qq.log`；`READY`/`RESUMED` 即恢复。
- B 站/X 登录过期：双击桌面「TeamAgent-登录.command」→ 扫码。
- 更新本机运行文件：确认没有运行中的任务后 `python3 scripts/install-local.py`。

### 花钱的地方（都要盯）

| 服务 | 规则 |
|---|---|
| Cloudflare | Workers Paid $5/月，只用自带额度。D1 每次调用：聊天/HTTP ≤48 条语句、后台 ≤200 |
| DeepSeek | 按量计费，余额在开发台「运行状态」（11-14 约 ¥277） |
| OpenAI | 识图、生图、语音按量；生图约 $0.011–0.016/张 |
| Workers AI | 每天 10k neurons 免费，超出计费，代码里有硬闸回退 DeepSeek |

### 硬盘

编队时期每个任务开一个 worktree（各带 250–400MB `node_modules`），曾把硬盘塞满（11-14 清掉约 20G）。以后：

- 工作副本统一在 `~/Projects/.worktrees/`，合并后 `git worktree remove <路径>` 并 `git worktree prune`。
- 主克隆目前在 `~/Projects/.worktrees/TeamAgent-p4b-login`（名字是历史遗留）。建议重新 `git clone` 到 `~/Projects/TeamAgent` 作为主目录。
- `scripts/clean-local.sh`（默认 dry-run，`--apply` 才删）清理本机开发残留。

## 7. 编队留下的资料怎么用

[`docs/handoff/archive/`](docs/handoff/archive/) 是编队的工作笔记原样归档（只收了 Markdown，没有收 D1 原始导出、群消息回放、截图和日志）：

- `agent-releases/<版本>/`：每个版本的 `design.md`（方案）、`status.md`（进度流水）、`next.md`（遗留问题）、`orders/`（施工单）、`notes/`。
- `agent-releases/ledger-all/`：线上能力盘点 `live-state.md`、用户需求总账 `user-asks.md`、总进度 `status.md`。
- `reports/`：调研、方案评审、事故复盘（如 `TeamAgent-qq-outage-20261114.md`、`TeamAgent-resend-incident-20261114.md`）。

里面的「已完成」都要以 `/health`、D1 和真实群消息为准，编队多次出现过「说做了但没生效」。

## 8. 接手第一小时清单

- [ ] 打开 `/health`，记下线上提交号；对比 `git log origin/main`。
- [ ] 按 3.1 修好自动发布，重跑 Check，确认 #57、#58 上线。
- [ ] Actions 里取消卡住的 `release/F9-reader` 检查。
- [ ] 开发台「运行状态」看 QQ 网关、队列积压、错误任务、DeepSeek 余额。
- [ ] 11-15 08:00 看群里有没有发出昨日总结；没发就先修它。
- [ ] 读 `user-asks.md` 的未兑现项，定下一个要上的版本。
