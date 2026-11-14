# TeamAgent「写好了但没接通」审计

- 审计时间：2026-11-14 00:50–01:00 Sydney（北京 2026-11-13 21:50–22:00，谷时）
- 审计对象：`~/.inkboard-team/repos/TeamAgent` 的 `origin/main` **8762214**（本机工作树停在 37ab49d，落后 109；审计用 `git archive 8762214` 解到 `/tmp`，未 checkout、未改仓库）；`~/Projects/.worktrees/TeamAgent-*` 共 50 个 worktree 的关键未合并分支
- 只读声明：没有改仓库、没有写线上 D1、没有发群消息。跑了三个分支的测试（只产生临时文件，worktree 均 clean）；读了本机 launchd 状态、`gh` 登录状态、`launchctl print`、`/health`
- 线上事实：`/health` 返回 `release=876221409c89ff4fb99ef1a3e8fd5ef62ebb683c`，即 8762214；`~/.inkboard-team/repo-index-state.json` 只有 `OmnixSI/TeamAgent`
- 线上 `settings` 值：本次没能只读查询成功。`wrangler d1 execute --remote` 需要 `CLOUDFLARE_API_TOKEN`；本机 Wrangler OAuth 已过期（API 返回 `Authentication error [code: 10000]`）；用本机 `worker-secrets.json` 的 `ADMIN_TOKEN` 读 `/api/team/state` 返回 403。除 00:42 已有只读快照能证明的 `off:repo_tools` 外，下表线上值均标「未确认」
- 00:42 只读快照（同一 D1）：`repo_commits` 只有 **OmnixSI/TeamAgent**、158 行；`repo_cache` 有 6 个仓库；`settings` 没有 `off:repo_tools`（`TeamAgent-vD-cases-20261114.md:31,33,113`）

## 结论先说

1. **「查仓库新提交」不是模型笨，是数据没接通。** 本机提交索引只有 TeamAgent；白名单另外 4 个仓库没有 clone，`runner.log` 每 30 秒重复 `repo index: clone missing`。Worker 侧 `GITHUB_TOKEN` 没有任何证据存在（Actions Secrets 和本机 `worker-secrets.json` 都没有；Worker secret list 因无 CF token 未能只读列出），按现有证据 4/5 仓库只能走「无索引 → not_synced」；若线上手工配过 token，这条不成立，需要一次只读确认。
2. **代称解析本身也坏了。** 主分支 `parseRepo` 只认 `owner/repo` 或英文短名，不认 `群助手`、`大肥鱼`、`陪玩店`，直接返回 `invalid_args`。修好的分支 `pkg/fast-lane-F5b` 已经写好并通过 745 项测试，但还在本机、没 push、没 PR。
3. **代码调查（C3）是「装好了但没启动」。** `~/.inkboard-team/subagent.py` 存在，`bridge.py` 却没有 `start_daemons()` / `subagent.loop()`；Worker 8762214 也没有 `/api/runner/subagent/*` 路由。对应分支 B1（Worker 侧）测试 42/50，8 个失败；B5（bridge 启动）只过了 3 个 home 测试，且基于旧 main。
4. **失败被吞掉，用户只听到「没拿到」。** 工具结果里的 `error_kind`/`next_action` 没有强制进入最终 brief；真正抛异常时 `semantic.ts:1229-1233` 只回一句「未能获得资料」。research 后台任务三次失败后只写一条 `job.failed` activity，不会给群里发任何消息——用户听到的「结果稍后单独回」永远不会来。
5. **能力卡没有「只读」边界。** 三个 repo 工具全部只读，但系统提示词没有一句「不能改文件/提交/合并」；`repo_commit` 这个名字和 `prepare_project_task` 的「动手开发」描述，加上真实案例里 bot 说「能读仓库、改文件、提变更」，正好构成用户最反感的错位。
6. **已经跑绿的修复没有上线。** F5b（745/745）、F4（746/746）、`release/fast-hardening`（745/745）都在本机；`git ls-remote` 对这些分支为空，全部没有 PR/CI。线上 8762214 仍在犯这些错。

---

## 1. 工具与提示词逐项

### 1.1 工具总表（`src/semantic.ts` + `src/repo.ts`）

| 功能 | 位置 | 依赖 | 现状（默认开关 / 提示词） | 缺什么才能真正可用 | 一句话修法 | 量 |
|---|---|---|---|---|---|---|
| `get_work_status` | 定义 `src/semantic.ts:652-667`；执行 `974-998` | D1 的 `tasks/task_plans/jobs/media_notes/deliveries/messages` | 默认开；系统提示词**没有点名**，只有工具 description 说「被问还没好时先查」 | 模型不会主动调用；也不检查 runner 是否在线 | 在 `config/participation.json` 第 6 条加「进度先 get_work_status」；返回带 `runner_seen` | 1h |
| `remember_correction` | 定义 `668-688`；执行 `999-1006` | D1 `facts` + `authz` 的明确纠正校验 | 默认开；第 5 条明确教了 | 基本可用；只认当前消息的明确纠正 | 保持 | 0 |
| `recall_memory` | 定义 `689-704`；执行 `1007-1009` | D1 `facts` | 默认开；prompt 没点名，但 `agentAnswer` 每轮自动 recall（`821-835`） | 自动召回已覆盖；工具是冗余入口 | 保持，或合并进自动召回 | 0 |
| `create_file_task` | 定义 `705-736`；执行 `1010-1116` | D1 `jobs/deliveries`；本机 media/utility runner；ffmpeg、X-ASR；`bili.media.enabled` | 默认开；第 6 条教「明确要文件才建」；guide 27–31 讲了格式/大小/扫描件限制 | runner 离线也立刻返回 `accepted:true`；没有 pending/failed 的群通知 | 先查 `runner_seen`；返回 `queued/offline`；失败发 outbox | 2h |
| `prepare_project_task` | 定义 `737-772`；执行 `1117-1179` | D1 `tasks/task_plans`；WORK/TOOLS 队列；bridge/execute/DSH | 默认开；第 6 条说「重要方案和开发交后台」；`complex` 直接 `needs_human`（`1140-1144`） | 模型容易把「创建任务」说成「我能改代码」；复杂任务不自动执行；plan 失败只在看板 | prompt 写清「只创建任务，复杂转人工」；返回真实状态 | 3h |
| `search_web` | 定义 `773-784`；执行 `1180-1188` | `DEEPSEEK_API_KEY` + DeepSeek `/v1/tools/search` + TOOLS 队列 | 默认开；第 4/6 条说「确需最新事实才搜」；guide 26 承诺实时搜索 | 非 `LOCAL_TOOLS` 调用会转 research（`886-921`）；失败没有群通知 | 失败发 outbox；加工具审计 | 4h |
| `read_web` | 定义 `785-796`；执行 `1189-1200` | 出站 fetch；Jina（`TEAM.web.jina`）；X/GitHub raw | 默认开；第 4/6 条；guide 26/31 | 失败对象有 `reason/reason_text`，但最终 brief 不强制保留 | 把 `reason_text` 写进 brief；加审计 | 3h |
| `get_project` | 定义 `797-808`；执行 `1201-1221` | D1 `repo_cache`，靠 bridge `sync_repos()` + `gh` 登录 | 默认开；prompt **没点名**；guide 40/70 说会查 issue/PR/最新提交 | `repo_cache` 是 README/issue/PR 快照 + 一个 head，不是逐条提交；取不到只返回 `{unavailable:true}` | prompt 点名；返回逐仓库「取到/没取到/最后同步」 | 4h |
| `repo_changes` | `src/repo.ts:8`；执行 `src/semantic.ts:1222-1225` | Worker `GITHUB_TOKEN`，或本机 `repo_index` + `repo_state/repo_commits`；`off:repo_tools` | 默认开（00:42 快照 settings 无 `off:repo_tools`）；第 6 条**明确教了** | 4/5 仓库没有 clone/index；`repo_commits` 只有 TeamAgent；代称不解析 | 配 token 或 clone 5 仓；合并 F5b | 0.5–1d |
| `repo_commit` | `src/repo.ts:9`；执行同上 | 同上 | 默认开；第 6 条教了 | 同上；名字像「提交变更」，实际只读 | 改名 `repo_commit_diff`，描述加「只读」 | 0.5d |
| `repo_file` | `src/repo.ts:10`；执行同上 | 同上；主分支无本地 patch fallback | 默认开；prompt **只教 changes/commit，没教 file** | 无 token 直接 `needs_token`；本机索引只有 patch 节选 | 合并 F5b；prompt 点名 | 0.5d |

补充：

- **所有工具共用的开关**：`off:repo_tools` 只影响三个 repo 工具；`off:wait` / `off:quote` / `off:sticker_send` / `off:sticker_collect` 不影响上面 11 个工具本身。所有工具都受 `src/semantic.ts:880` 的工具表门控（turn ≥ 2 或预算不足就不传 tools）和 `971` 的每轮 3 次上限影响；这两个门控没有 `off:*` 键，也没有日志。
- `LOCAL_TOOLS` 在 `src/semantic.ts:6`，把三个 repo 工具当「本地工具」，所以它们不走 research 后台，直接在聊天 lane 里跑（最多 8 秒、受聊天预算限制）。这是有意为之，但 `LOCAL_TOOLS` 这个名字会误导后续维护者。
- 工具表在 `src/semantic.ts:652-810`；`...(isOn(sw, "repo_tools") ? repoTools : [])` 在 `809`。
- 每轮最多 3 个工具调用（`src/semantic.ts:971`）；turn ≥ 2 或预算不足时整个工具表被去掉（`880`）。这两个都是「静默关闭」，没有日志。
- `repo_*` 三个工具的只读声明在 `src/repo.ts:1`（`Read-only, bounded index...`）；但系统提示词没有把这句话告诉模型。

### 1.2 系统提示词 / 能力卡核对

| 表面 | 位置 | 说了什么 | 与代码是否一致 | 问题 |
|---|---|---|---|---|
| 参与判定系统提示词第 6 条 | `config/participation.json:2` | 「问代码、提交、分支进度时，先用 repo_changes / repo_commit 查再答，brief 里带 7 位提交号；索引过期就写明最后同步时间，不说不知道」 | 方向正确，但只点名两个工具；没有 `repo_file`、`get_project`、`get_work_status`；没有 `error_kind/next_action` 的写法 | 模型知道「该查」，但不知道「查什么、失败怎么说」 |
| 能力边界 | `config/participation.json:2` | 「只可根据工具的真实结果报告动作」 | 正确，但**没有一句**「repo 工具只读，不能改文件/提交/合并」 | 模型很容易把 `repo_commit` 和「提交变更」混为一谈；真实案例见 `TeamAgent-vD-cases-20261114.md:112` |
| 使用说明「让它动手」 | `src/guide.ts:47` | 「先整理方案，再由家中执行端在独立分支开发、运行验收。通过后生成草稿 PR」 | 只对 `execute_requested=true && complexity=small` 成立；`complex` 直接 `needs_human`（`semantic.ts:1140-1144`）；runner 离线也不执行 | 能力卡读起来像「都能自动开发」，代码只自动跑小活 |
| 使用说明「项目动态」 | `src/guide.ts:70` | 「显示组织项目的最新提交、作者、提交时间和 GitHub 链接，资料约每五分钟同步」 | `repo_cache` 只存一个 `head`（bridge.py:126-154），不是逐条提交；`repo_commits` 只有 TeamAgent | 用户问「最近改了什么」时，只能给一个标题，给不了 N 条 |
| 使用说明「查资料」 | `src/guide.ts:26` | 「可以调用实时搜索和网页读取工具」 | 依赖 `DEEPSEEK_API_KEY`、DeepSeek tools、TOOLS 队列；任一不可用就失败 | 没有写「搜索不可用时会怎样」 |
| 嘴替提示词 | `config/voice.json:2` / `src/voice.ts:110` | 「不要新增事实、承诺或能力」「上游未接受执行任务时，不说我去跑」 | 正确；但嘴替只能基于 brief 说，brief 里的错误能力自述它救不回来 | 需要在参与判定层加只读边界，不能只靠嘴替 |

### 1.3 「说错能力」的具体来源

- 真实案例：2026-11-13 21:15，bot 对用户说「能读仓库、改文件、提变更（repo_changes、repo_commit）」（`TeamAgent-vD-cases-20261114.md:112`）。三个工具实际都只读（`src/repo.ts:1-10`）。
- 这不是提示词直接教的，而是三个因素叠加：
  1. `repo_commit` 这个名字和「提交」二字容易被模型读成「提交变更」；
  2. `prepare_project_task` 的 description 是「明确要求出方案或动手开发时创建任务」（`src/semantic.ts:742`），听起来像模型自己动手；
  3. 系统提示词没有一句否定边界。
- **修法**：在 `config/participation.json` 第 6 条后加一句固定边界：「repo_changes / repo_commit / repo_file 都是只读；你不能改文件、不能 git commit、不能合并或发布。」并把 `repo_commit` 改名为 `repo_commit_diff`。B1 分支已经写了一版「能力卡 + 第 8 条」，但未合并且测试红（见第 5 节）。

---

## 2. 开关与配置

### 2.1 `settings` 里的开关

| 开关 | 代码位置 | 关闭什么 | 默认/现值 | 线上值 | 备注 |
|---|---|---|---|---|---|
| `off:repo_tools` | `src/rhythm.ts:58`；`src/semantic.ts:809,1223` | 从工具表移除三个 repo 工具；执行时返回 `denied` | 键不存在即开 | 00:42 快照无此键 → **开**；本次未重查 | 关掉后第 6 条仍教模型用 `repo_changes`，提示词与工具表矛盾 |
| `off:wait` | `src/rhythm.ts:58`；`src/worker.ts:765`；`src/rhythm.ts:24` | 不允许 `wait`，parseDecision 把它改成 `stop` | 键不存在即开 | 未确认 | prompt 仍说可以 wait，模型不知道被关 |
| `off:quote` | `src/rhythm.ts:58`；`src/quote.ts:11`；`src/worker.ts:1016` | 不引用回复 | 键不存在即开 | 未确认 | 引用连续失败会自动写 `off:quote=1`（`worker.ts:1082`），之后永久静默 |
| `off:sticker_send` | `src/rhythm.ts:58`；`src/stickers.ts:10` | 不发表情 | 键不存在即开 | 未确认 | 但 `config/team.json:115` 的 `stickers.send=false` 让表情发送实际默认关闭 |
| `off:sticker_collect` | `src/rhythm.ts:58`；`src/worker.ts:337` | 不收集表情 | 键不存在即开 | 未确认 | — |
| `sticker_paused_until` | `src/stickers.ts:10,138-142` | 暂停表情发送到指定时间 | 自动写 | 未确认 | 连续失败自动暂停 1 天，只写 activity |
| `runner_pause_until` | `src/worker.ts:1394` | 本机执行端暂停接任务 | 0 | 未确认 | 管理端 pause 后，聊天仍可能说「我去跑」 |
| `auth:bili` / `auth:x` | `src/rhythm.ts:58`；`src/login-flow.ts:16` | 不是开关，是登录态快照 | — | 未确认 | 过期后 B 站/X 能力静默降级；没有「登录过期」的主动群通知 |

### 2.2 不是 `settings`、但会让能力静默关闭的配置

| 配置 | 代码位置 | 关闭什么 | 当前值 | 备注 |
|---|---|---|---|---|
| `stickers.send` | `config/team.json:115` | 表情发送 | **false** | 与 `off:sticker_send` 双重关闭；代码默认就不发 |
| `stickers.collect` / `enabled` | `config/team.json:113-114`；`worker.ts:335`；`stickers.ts:49` | 表情收集/打标 | true | — |
| `vision.enabled` | `config/team.json:82`；`src/vision.ts:400` | 图片理解 | true | 关掉后图片只当附件，不报错 |
| `bili.enabled` | `config/team.json:89`；`src/fetchjobs.ts:40` | B 站抓取 | true | — |
| `bili.media.enabled` | `config/team.json:92`；`src/mediajobs.ts:71` | B 站音轨转写 | true | 关掉后视频只给字幕/评论 |
| `scout.enabled` | `config/team.json:34`；`worker.ts:1117` | 每天 12/19 点主动探索 | true | 关掉后 guide 22 的承诺失效 |
| `web.jina` | `config/team.json:41`；`semantic.ts:473` | Jina 网页读取兜底 | true | 关掉后只剩 DeepSeek fetch |
| 工具表总开关 | `semantic.ts:880` | turn ≥ 2 或预算不足时整个 `tools` 字段不传 | 隐式 | 模型突然「没有工具」，没有日志 |
| 每轮 3 次上限 | `semantic.ts:971` | 第 4 个工具调用抛「本轮工具额度已用完」 | 隐式 | 异常被 `1229-1233` 吞成「未能获得资料」 |

### 2.3 线上值核对与阻塞

- 00:42 的只读快照已证明：`settings` 无 `off:repo_tools`；`repo_commits` 只有 TeamAgent 158 行；`repo_cache` 6 个仓库（`TeamAgent-vD-cases-20261114.md:31,33,113`）。
- 本次 00:53 复核：`/health` 仍是 8762214；`repo-index-state.json` 仍只有 TeamAgent。说明从 00:42 到 00:53 没有新增仓库索引。
- 其他 `off:*` 和 `auth:*` 的线上值未确认。原因：本机无 `CLOUDFLARE_API_TOKEN`；Wrangler OAuth 过期；`ADMIN_TOKEN` 调 `/api/team/state` 返回 403。没有为了拿值去写 D1 或改配置。
- **建议**：把「只读查询 settings 的脚本 + 一个有效期足够的只读 CF token」放进 `.agent/` 的运维工具，否则每次审计都只能看代码默认值。不要用管理员 token 去猜。

---

## 3. 依赖清单

### 3.1 Secret 名称（只列名字，没有读值）

| Secret | 谁需要 | 现在是否见得到 | 证据 |
|---|---|---|---|
| `ADMIN_TOKEN` | Worker owner 登录/管理 | 本机 `worker-secrets.json` 有；线上值是否同步未确认 | `src/worker.ts:61,102`；本机文件键名 |
| `RUNNER_TOKEN` | 本机 bridge → Worker | 本机有；线上未确认 | `src/worker.ts:62,119` |
| `DEEPSEEK_API_KEY` | 聊天、搜索、方案、记忆、文件、开发 | 本机有；Actions Secret 有 | `src/runtime.ts:71`；`gh secret list` |
| `QQ_APP_ID` / `QQ_APP_SECRET` | QQ 收发 | 本机有；Actions Secret 有 | `src/worker.ts:65-66,948` |
| `GITHUB_TOKEN` | Worker 云端读私有仓库 | **没有证据**：本机 `worker-secrets.json` 没有；Actions Secrets 没有；`gh secret list` 没有；Worker secret list 因无 CF token 未取到 | `src/worker.ts:64,397`；`src/github.ts:146` |
| `CLOUDFLARE_API_TOKEN` | 手动部署/D1 查询 | 本机没有；Actions Secrets 没有；CI deploy 长期因此失败 | `TeamAgent-qq-outage-20261114.md:29` |
| `TEAM_*` Actions Secrets | 发布同步 | 6 个：DEEPSEEK、ADMIN、AUTOLOOP_SOURCE、QQ_APP_ID、QQ_APP_SECRET、RUNNER | `gh secret list`（只列名） |

本机 `~/.inkboard-team/config.json` 的键名：`adminToken`、`runnerToken`、`sourceKey`、`url`、`hub`、`repos`、`asr`。没有 `GITHUB_TOKEN`。

### 3.2 本机 launchd / runner

| 服务 | 状态（`launchctl print`，只读） | 用途 |
|---|---|---|
| `com.inkboard.team-runner` | **running**，pid 23954，runs 2，never exited | `bridge.py`：领代码任务、repo_index、续租 |
| `com.inkboard.team-fetch` | **running**，pid 13183 | B 站/X 抓取 |
| `com.inkboard.team-qq` | **running**，pid 11571，last exit 0 | QQ 官方长连接 |
| `com.inkboard.team-owner` | **running**，pid 23957 | 本机 owner 管理代理 |
| `com.inkboard.team-utility` | **running**，pid 23961，last exit 0 | 文件/PDF/视频 |
| `com.inkboard.team-utility-quick` | **running**，pid 23964，last exit 0 | 快速文件 |
| `com.inkboard.team-media` | not running（周期性），runs 51，last exit 0 | B 站音轨/媒体 |
| `com.inkboard.bridge` | running，pid 56046 | 旧 InkBoard autoloop，不是 TeamAgent；不要和 team-runner 混淆 |

结论：TeamAgent 的六个服务都在；runner 日志 00:49 还在写，说明活着。`team-media` 是定时任务，当前不在 running 属正常。服务定义在 `~/Library/LaunchAgents/com.inkboard.team-*.plist`；runner 的实际入口是 `~/.inkboard-team/bridge.py:294`（只启动 `repo_index.loop`）。

### 3.3 本机仓库索引（最关键）

| 项 | 现状 | 证据 |
|---|---|---|
| `~/.inkboard-team/repos` | 只有 `TeamAgent` 一个 clone | `ls` |
| `repo-index-state.json` | 只有 `OmnixSI/TeamAgent`，25 秒前刚上报，frontier 13，acked 0 | 本机文件 |
| `runner.log` | 每 30 秒重复 `repo index: clone missing` × 4（NextThought、NextThought-Website、WhalePartner、peiwan-store-platform-blueprint） | `~/.inkboard-team/runner.log` |
| TeamAgent clone | 工作树 37ab49d，落后 origin/main 109；但 `origin/main` 是 8762214，repo_index 用 origin refs 建索引 | `git log/rev-parse` |
| `repo_commits`（线上） | 00:42 只有 TeamAgent 158 行 | `TeamAgent-vD-cases-20261114.md:31` |
| `repo_cache`（线上） | 6 个仓库都有快照；但只是 README/issue/PR + 一个 head，不是提交索引 | `TeamAgent-vD-cases-20261114.md:33`；`bridge.py:126-154` |
| `gh` 登录 | 已登录 `ooooooomygosh`，scope 含 `repo`；bridge 的 `sync_repos()` 能读 6 个仓库 | `gh auth status` |
| X 登录态 | `~/.inkboard-team/browser/x` 00:39 仍活跃 | 目录 mtime |
| B 站登录态 | `browser/bili` 是空目录（00:12 后无文件）；但 `fetch.log` 23:58 的 B 站 API 仍 200 | `ls`、`fetch.log` |
| 本机 subagent | `~/.inkboard-team/subagent.py` 存在（30 KB），但 `bridge.py` 只 import `repo_index`，没有 import/启动 `subagent` | `bridge.py:5,294`；`subagent.py:759` |

**这条链是「写好了但没接通」的核心：**

1. 本机 `subagent.py` 已有 `loop()`（`subagent.py:759`），默认 `subagent.enabled` 不为 false 就会跑；
2. 但安装的 `bridge.py` 没有 `start_daemons()`，只启动 `repo_index.loop`（`bridge.py:294`），所以 subagent 永远不跑；
3. 即使手动启动，它请求 `/api/runner/subagent/*`（`subagent.py:357`），而 8762214 的 Worker 没有这个路由（`grep subagent src/worker.ts` 无结果）；
4. B1 分支才加 Worker 路由（`pkg/V-B-B1:src/subagent.ts:110-188`），B5 分支才加 bridge 启动（`pkg/V-B-B5:runner/bridge.py:297-303`）；两个都没合并，B1 测试还红。

---

## 4. 被静默吞掉的地方

| # | 位置 | 吞了什么 | 用户实际看到 | 修法 |
|---|---|---|---|---|
| 1 | `src/semantic.ts:1229-1233` | 所有抛出的异常（授权、预算、网络、`tool()` HTTP 错误）统一变成 `{unavailable:true, reason:"未能获得资料，不能据此编造结论"}`；没有 `error_kind`、`next_action`、`detail` | 「没拿到 / 不能瞎编」 | catch 里保留 `error_kind` + `next_action`；至少把 `error.message` 放进 `detail` |
| 2 | `src/repo.ts:129` | `runRepoTool` 的 catch 把所有异常变成 `upstream`，没有具体原因 | 「外部服务失败」 | 记录 `error.name/message` 到 `detail`（已脱敏）；区分 token/网络/参数 |
| 3 | `src/semantic.ts:1220` | `get_project` 没有 cache 时只返回 `{unavailable:true}` | 「查不到」 | 返回 `{unavailable:true, reason:"repo_cache 为空", last_sync:...}` |
| 4 | `src/semantic.ts:924-931` + `src/worker.ts:897-943` | 说了「已开始后台处理，结果稍后单独回这条消息」；research job 三次失败后只写 `job.failed` activity，**不发 outbox** | 永远等不到那条「稍后」 | 失败时往原消息发一条「没查成 + error_kind + next_action」；不要只写看板 |
| 5 | `src/semantic.ts:886-921` | 非 `LOCAL_TOOLS` 调用全部转 research；如果 `!context.mentioned`，直接返回 `[[SILENT]]`，后台失败无人知道 | 群里完全静默 | 转后台时记 `origin message`；失败时补一条 |
| 6 | `src/semantic.ts:1114` | `create_file_task` 在 runner 没接单前就返回 `{accepted:true}` | 「已接，去做」 | 先查 `runner_seen`/`runner_pause_until`；返回 `queued` 或 `offline` |
| 7 | `src/worker.ts:920-936` | plan 三次失败只把 task 改成 `needs_human`，不往群里发 | 用户以为还在做 | 同 #4，发一条失败通知 |
| 8 | `src/semantic.ts:971` | 第 4 个工具调用抛「本轮工具额度已用完」，被 #1 吞掉 | 「未能获得资料」 | 明确说「本轮工具次数用完，下一句再查」 |
| 9 | `src/semantic.ts:880` | turn ≥ 2 或预算不足时整个工具表不传，模型不知道 | 突然「没有工具」 | 在 prompt 里说明「本轮不能再调工具」；或先用低成本工具 |
| 10 | `src/timing.ts:3-5` | 阶段表只有 model/chat/outbox 等 13 种，没有 tool 阶段 | 无法从看板看到调了什么 | 加 `tool_start/tool_end/tool_failed` |
| 11 | `schema.sql:23-25,62-63` | 只有 `activity`、`model_runs`、`stage_timings`，没有 `tool_events` | 复盘只能看模型用量，看不到工具名/参数/返回 | 新增 `tool_events(turn_id, name, args_hash, ok, error_kind, ms, created_at)` |

**工具调用审计的现状：**

- `src/semantic.ts` 里对工具调用只有 4 类 activity：`authz.denied`（637）、`research.queued`（913）、`task.created`（1165）、`research.done`（worker 584）。
- `search_web`、`read_web`、`get_project`、`get_work_status`、`repo_changes/commit/file` 的调用**没有任何一条**记录工具名、参数、耗时、返回码。
- `jobs.error` 只存 200 字符（`worker.ts:937-941`），且失败 research job 不写 outbox。
- 所以真实案例里只能写「线上没有工具调用日志，无法确认是没调还是调失败」（`TeamAgent-vD-cases-20261114.md:104`）。

---

## 5. 未合并分支：哪些能立刻补基本功能

### 5.1 分支总表

| 分支 | 提交/差异 | 合并状态 | 能补什么 | 阻塞点 | 建议 / 量 |
|---|---|---|---|---|---|
| `pkg/fast-lane-F5b` | 2 commits（`f987e28`、`cb25916`）；3 files +139/−14 | **本地，未 push，无 PR** | 代称解析（群助手/大肥鱼/TeamAgent，大小写/空格/歧义）；`toolFailure` 带白名单/候选；`repo_file` 无 token 时用本地 patch 节选；`next_action` 更具体（`pkg/fast-lane-F5b:src/github.ts:17-38`；`src/repo.ts:121-152`） | 4/5 仓库仍无索引；`peiwan-club-saas` 不在白名单，F5b 不会把它算成「陪玩店」候选；没有 push/PR | **先合并**；`npm test` 745/745 通过（本次跑）；0.5d |
| `pkg/fast-lane-F4` | 1 commit（`a6641d2`）；6 files +141/−17 | **本地，未 push，无 PR** | `chat_cursor:<group_id>`，旧全局游标一次性迁移并夹到 `MAX(rowid)`；修复「回放/别的群把真实群卡死」（`pkg/fast-lane-F4:src/worker.ts:99-126`） | 没有 push/PR；与 F5b/release 有测试文件冲突可能 | **先合并**；`node --test test/*.test.mjs` 746/746 通过；0.5d |
| `release/fast-hardening` | 10 commits ahead（含 F2a–F2d）；26 files +535/−112 | **本地，未 push，无 PR** | 本机 unlock 凭据权限；空评论措辞；只含 filler 的 ASR 判 no_speech；表情 302 当失败；本机输入下载 100 MiB 上限（`release/fast-hardening:runner/owner_unlock.py:49-63`；`runner/utility.py:11`；`runner/asr.mjs:8-63`） | 没有 push/PR；与 F4/F5b 有 `semantic.ts/worker.ts` 交叉 | **第三批合并**；`npm test` 745/745 通过；1d |
| `pkg/V-B-B1` | 5 commits（含 B2、B1t 红测试）；11 files +2239 | **本地，未 push** | Worker 侧 `delegate` 工具 + `/api/runner/subagent/{claim,heartbeat,progress,report}`；能力卡 `capabilityCard`；prompt 第 8 条要求把 `error_kind/next_action` 写进 brief；只读子代理租约（`pkg/V-B-B1:src/subagent.ts:110-188`；`src/capabilities.ts:132-140`） | **测试红：50 项 42 过 8 败**（`src/semantic.ts` 未导出 `inlineable`/`createProjectTask` 等，D-24/D-25 失败）；没有 push/PR | **不能合**；先补齐 8 个失败，再和 B5 一起验收；2–3d |
| `pkg/V-B-B5` | 1 commit（`47dfc82`）；20 files +285/−27 | **本地，未 push；基于 df11aa2，落后 main 1** | `bridge.py:start_daemons()` 启动 `subagent.loop`；`team_home` 隔离运行目录；install-local 分发（`pkg/V-B-B5:runner/bridge.py:297-303`） | 依赖 B1 的 Worker 路由；B1 红；C3 `READER_VERIFIED=False`；基于旧 main 有冲突 | **与 B1 绑定**，不能单独合；1d 整合 |
| `pkg/V-B-B1t` | 1 commit；1 file +1315 | 本地，未 push | D-1..D-26 红测试（先写测试；`pkg/V-B-B1t:test/subagent.test.mjs:1`） | 没有实现，单独合就是红 | 不单独合；作为 B1 的测试基线 |
| `pkg/V-B-B2` | 1 commit；7 files +691 | 本地，未 push；已被 B1 合并 | C2 能力层：错误类型、`NEXT_ACTION`、`capabilityCard`（`pkg/V-B-B2:src/capabilities.ts:1`） | 依赖 B1；单独合不生效 | 随 B1 一起 |
| `pkg/V-B-B4r` | 1 commit；2 files +288 | 本地，未 push | runner 每轮任务进度快照（`pkg/V-B-B4r:runner/execute.py:124-189`） | 不是基本功能；测试未跑 | 随 V-B 一起，1d |
| `agent/cap-c3-runner` | 5 commits；5 files +1722 | 未合并（PR #24 已合的是更早版本） | C3 沙箱读规则、/dev/null 写例外、路径/并发边界、rebase 后夹具 | `docs/c3-runner.md:1`「尚未接入 Worker」；`:3,40,149` `READER_VERIFIED=False`；真实 DSH 工具事件未验收 | 不能合；等安全/工具事件验收；2–3d |
| `pkg/V-B-probe` | 1 commit；1 doc | 本地，未 push | 记录隔离 DSH reader 的凭据阻塞（`pkg/V-B-probe:docs/c3-runner.md:1`） | 只是文档 | 随 B1/B5 参考 |
| `agent/event-layer-v2` | 21 ahead / 5 behind | 未合并 | 事件层 v2（大改；未逐文件核行） | 与当前基本功能无关；冲突大 | 不进本轮 |
| `agent/pending-notice-fix` | 7 ahead / 6 behind | 未合并 | 交付回执、并发资料、孤儿清理、100 MiB 预检（`agent/pending-notice-fix:runner/delivery.mjs:44-85`） | 未 rebase、未跑测试 | 第二批；1–2d |
| `pkg/V-C-C5r` | 1 commit | 本地，未 push | B 站抓取唤醒/退避（`pkg/V-C-C5r:runner/fetch-wake.mjs:1-3`） | 不是仓库基本功能 | 排队 |
| `pkg/V-C-C6` | 2 commits | 本地，未 push | 本机登录锁/QR 迟到轮询（`pkg/V-C-C6:runner/local_login_page.py:25-31`） | 不是仓库基本功能 | 排队 |
| `pkg/fast-lane-F5c` | 0 commits（等于 8762214） | 无内容 | — | — | 关闭/删除 |

### 5.2 合并顺序建议

1. **F5b**：先修「代称 + 失败说明 + 本地 patch」，这是用户「查仓库」最直接的一刀。
2. **F4**：再修全局 `chat_cursor`，避免任何回放/多群把真实群卡死。
3. **`release/fast-hardening`**：一批本机/交付硬化，降低后续验收噪声。
4. **B1 + B5 + B4r**：作为 C3「只读代码调查」一组；但必须先把 B1 的 8 个红测试修绿，并通过真实 DSH 工具事件/安全验收，不能为了「看起来能用」硬合。
5. **C3 分支的 5 个提交**：等 B1/B5 合入后，按 `docs/c3-runner.md` 的 v1.5 边界重放；`READER_VERIFIED=False` 之前不启用。

**共同阻塞点：** 本次检查的 `pkg/*`、`release/*` 全部没有 upstream；`git ls-remote --heads origin` 对这些分支为空，GitHub 上没有 PR。代码不是主要问题，**「分支还在本机」才是**。交付员需要 push、开 PR、跑 CI；F5b/F4/release 的本地测试已绿，可以先走。

---

## 6. 本次实际跑过的验证与限制

**跑过：**

- `git -C ~/.inkboard-team/repos/TeamAgent archive 8762214` → `/tmp/ta-audit-8762214`（只读快照，未改仓库）
- `git log` / `git branch -vv` / `git merge-base --is-ancestor` / `git diff --stat` / `git ls-remote`（只读）
- `pkg/fast-lane-F5b`：`npm test` → **745/745 pass**
- `pkg/fast-lane-F4`：`node --test test/*.test.mjs` → **746/746 pass**
- `release/fast-hardening`：`npm test` → **745/745 pass**
- `pkg/V-B-B1`：`node --test test/capabilities.test.mjs test/subagent.test.mjs` → **50 tests, 42 pass, 8 fail**
- `pkg/V-B-B5`：`node --test test/home.test.mjs` → **3/3 pass**；Python `test.team_home_test` 因模块路径 `ModuleNotFoundError` 未跑起来（不计通过）
- `curl /health` → `release=876221409c89ff4fb99ef1a3e8fd5ef62ebb683c`
- `launchctl print gui/$(id -u)/com.inkboard.*`（只读）；`gh auth status`；`gh secret list`（只列名）
- `ls ~/.inkboard-team/repos`、`repo-index-state.json`、`runner.log`、`bridge.py`（只读）

**没做到 / 未确认：**

- 线上 `settings` 的 `off:wait`、`off:quote`、`off:sticker_*`、`auth:bili/x`、`runner_pause_until` 现值未确认；没有 Cloudflare 只读 token，Wrangler OAuth 过期，ADMIN_TOKEN 调 `/api/team/state` 403。只有 00:42 快照能证明 `off:repo_tools` 不存在。
- Worker 是否手工配过 `GITHUB_TOKEN` 未确认；Actions Secrets 和本机 `worker-secrets.json` 都没有，不能据此断定线上一定没有。
- C3 的 `agent/cap-c3-runner` 分支未单独跑测试；以 `docs/c3-runner.md` 的 `READER_VERIFIED=False` 为准。
- `agent/event-layer-v2`、`agent/pending-notice-fix` 未跑测试；只看了提交和 diff 统计。
- 没有改仓库、没有写线上 D1、没有发 QQ 群消息。

---

## 7. 用户最痛 Top 10

| # | 痛点 | 证据（文件:行） | 一句话修法 | 量 |
|---|---|---|---|---|
| 1 | 问「仓库最近提交」时，5 个白名单仓库只有 TeamAgent 有提交索引，另外 4 个根本没 clone；bot 只能「不知道」 | `~/.inkboard-team/runner.log` 的 `clone missing`；`repo-index-state.json` 只有 TeamAgent；`TeamAgent-vD-cases-20261114.md:31`；`src/repo.ts:108` | 配 Worker `GITHUB_TOKEN`，或 clone 5 仓并让 `repo_index` 全量上报；两者选一，不能只写错误提示 | 0.5–1d |
| 2 | 说「群助手/大肥鱼/陪玩店」时，repo 工具直接 `invalid_args`，因为它只认英文短名/owner/repo | `src/github.ts:17-39`（主分支 `parseRepo`）；真实失败 `TeamAgent-vD-cases-20261114.md:103-105` | 合并 F5b 的别名解析；再补 `peiwan-club-saas` 与 `peiwan-store-platform-blueprint` 的真实歧义（现在只认白名单里的一个） | 0.5d |
| 3 | bot 说「能读仓库、改文件、提变更」，实际三个工具全只读；用户以为它能改代码 | `src/repo.ts:1-10`；`config/participation.json:2` 无只读边界；真实原话 `TeamAgent-vD-cases-20261114.md:112` | 在系统提示词加「repo 工具只读，不能改文件/commit/合并/发布」；`repo_commit` 改名 `repo_commit_diff` | 1h |
| 4 | 工具失败只回「没拿到」，不告诉用户是没 token、没索引、参数错还是限流 | `src/semantic.ts:1229-1233`；`src/repo.ts:129`；`TeamAgent-vD-cases-20261114.md:103-105` | F5b 的 `error_kind/next_action` 合并；在 brief 里强制保留；catch 不要吞 `error.message` | 2h |
| 5 | 说了「结果稍后单独回这条消息」，后台 research 三次失败后什么都不发，用户永远等不到 | `src/semantic.ts:924-931`；`src/worker.ts:897-943` | research/job 最终失败时往原消息发一条失败说明；不要只写 `job.failed` activity | 3h |
| 6 | 没有工具调用审计：不知道 bot 调了什么、传了什么、返回什么，复盘只能靠猜 | `src/timing.ts:3-5`；`schema.sql:23-25,62-63`；`semantic.ts` 只有 `authz.denied/research.queued/task.created` | 新增 `tool_events` 表 + `tool_start/tool_end/tool_failed` 阶段；参数只存 hash，返回存 `error_kind` | 1d |
| 7 | 问「任务好了没」时，bot 不查 `get_work_status`，靠上下文猜 | `src/semantic.ts:652-667`；`config/participation.json:2` 未点名 | 系统提示词第 6 条加「进度先 `get_work_status`」；返回值带 `runner_seen` | 1h |
| 8 | 问「我们仓库 issue 分布」只答一个仓库；`get_project` 没被教，repo_cache 缺逐仓库「取到/没取到」 | `src/semantic.ts:797-808,1201-1221`；`src/guide.ts:40`；真实案例 `TeamAgent-vD-cases-20261114.md:43-51` | prompt 点名 `get_project`；返回逐仓库表：数量/最后同步/状态 | 4h |
| 9 | 文件任务 `accepted:true` 但 runner 离线时永远 pending；用户以为在做 | `src/semantic.ts:1114`；`worker.ts` 没有 `runner_seen` 检查 | 先查 `runner_seen` 和 `runner_pause_until`；返回 `queued/offline`；超时发通知 | 2h |
| 10 | F5b/F4/fast-hardening 三个已跑绿的修复还在本机，没 push/PR/merge；线上 8762214 继续犯同样的错 | `git ls-remote` 为空；F5b 745/745、F4 746/746、release 745/745（本次跑）；`/health=8762214` | 交付员 push 三个分支 → 开 PR → 跑 CI → 按 5.2 顺序合并 | 1–2h |
