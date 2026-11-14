# TeamAgent vD 侦察：夜间自省闭环 + 仓库可见性

- 基线：`origin/main` **8762214**（2026-11-14 00:30 Sydney 拉取）。
- 方式：只读。临时 clone 在 `/tmp/ta-recon`；未改 TeamAgent 仓库、未写 D1、未发群消息、未调用线上 repo 工具。
- **路径更正**：brief 里的 `/Users/yanghongming/Projects/TeamAgent` **不存在**。本机实际是三类副本：
  - `~/.inkboard-team/repos/TeamAgent`：runner 的 clone，`origin/main` 8762214，repo_index 最近一次上报 `2026-11-14 00:26:55`；
  - `/Users/yanghongming/Projects/.worktrees/TeamAgent-*`：各包独立 clone，很多提交未 push；
  - `/Users/yanghongming/Downloads/TeamAgent`：旧 clone，停在 8180fec。

## 结论（6 条）

1. **夜间复盘看不到 bot 自己说过什么。** `analyse()` 只读 `messages`，从不读 `outbox`；dream job 也只把 `messages.id` 传进去（`src/semantic.ts:46-52`、`src/worker.ts:515-526`）。所以“哪些没答上、哪里答错”没有原料。
2. **现有反思是 8 段各 300 字，互相覆盖，没有汇总。** prompt 写“最多300字”（`src/semantic.ts:101`），每批 `s.set("team_reflection", ...)` 覆盖上一批（`src/semantic.ts:201-202`）；`dreams` 只存当批 reflection（`src/semantic.ts:203-216`）。没有跨天/跨批复审，也没有工具调用记录。
3. **repo 工具不是没实现，是看不到团队正在干的分支。** 本机索引只跟踪 `origin` 的 default + `agent/*` + `team/*`（`runner/repo_index.py:109-113`）；`pkg/*`、`release/*` 即使 push 也被过滤；远端目前只有 main + 11 个 agent + 1 个 team，没有任何 `pkg/release`（2026-11-14 00:35 实测 `git ls-remote --heads origin`）。`Projects/.worktrees` 也不在扫描根（`runner/repo_index.py:272`）。
4. **D1 有成对数据的底子，但缺工具明细。** `messages` + `outbox` + `chat_decisions` + `jobs` 可按 `group_id`/`msg_id` join；但没有表保存工具参数/结果，也没有“答不上”的结构化原因。详见第 3 节。
5. **bot 现在没有“自己提需求到开发版”的自动通道。** `prepare_project_task` 需要群成员原话 + `direct=true`（`src/semantic.ts:1122-1130`、`src/authz.ts:113-122`）；夜间 prompt 明确“不能创建…任何旧任务”（`src/semantic.ts:102`）；仓库没有 GitHub issue 创建代码；本机 runner 只写 `~/.inkboard-team/work`（`runner/execute.py:139-151`）。
6. **独立评审放 Worker cron 最合适。** 已有每分钟 cron（`wrangler.toml:9-10`）、03–06 夜间窗口（`config/team.json:26-29`）、D1 和任务表；本机 runner 未接入且依赖 Mac 常开（`docs/c3-runner.md:1-3`、`runner/bridge.py:292-294`）；V-B delegate 还没进 main（`src/subagent.ts` 不存在，设计见 `.agent/releases/V-B-capability/design.md:84`）。

## 1. 现有夜间整理全貌

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 谁触发 | Cloudflare Cron，每分钟一次；`scheduled()` 里判断是否进入夜间整理 | `wrangler.toml:9-10`、`src/worker.ts:1100`、`src/worker.ts:2414-2416` |
| 几点 | Sydney 03:00–06:00，且群安静 ≥20 分钟 | `config/team.json:26-29`、`src/worker.ts:1135-1140` |
| 批量 | 每批最多 60 条，每晚最多 8 批；从全局 `processed=0` 取，**不按群过滤** | `config/team.json:30-31`、`src/worker.ts:1142-1153` |
| 用哪个模型 | `deepseek-flash`，`memory` 档 = `max`，超时 540s，`max_tokens=65536` | `config/team.json:4,11,21`、`src/worker.ts:444-470`、`src/policy.ts:3-8` |
| 读哪些数据 | 新消息（最多 60）、同群最近 30 条、`facts` 最近 60、`message_meta`、`repo_cache` 目录、上一版 `self_note`/`team_reflection` | `src/semantic.ts:46-57,59-67,80-95,108-117` |
| 不读什么 | `outbox`（bot 回复）、`chat_decisions`、`jobs`、`activity`、`stage_timings` | `src/semantic.ts` 全文无 outbox 查询；dream payload 只有 `messages`（`src/worker.ts:515-526`） |
| 产出 | `facts` ≤8、`expressions` ≤8、`settings.self_note`、`settings.team_reflection`、`dreams` 一行、`activity` 一行 | `src/semantic.ts:144-202,203-224` |
| 反思长度 | prompt 300 字；`team_reflection` 存 1200；`dreams.body` 存 3000 | `src/semantic.ts:101,202,208-211` |
| 谁读 | 白天参与判定注入 `self_note` + `team_reflection`；嘴替用 `self_note`；看板显示最近 7 条 `dreams` + `self_note` | `src/semantic.ts:842-857`、`src/voice.ts:116-122`、`src/worker.ts:2054,2123-2131`、`web/app.js:967-981` |
| 有没有传给团队 | **没有主动传**：不推群、不建任务、不写 `.agent`；只有看板被动可见 + 一条 `memory.consolidated` 活动 | `src/worker.ts:1128`（注释：never emits group replies）、`src/guide.ts:74`（不半夜往群里发日记）、`src/semantic.ts:217-224` |

### 1.1 触发细节

- `wrangler.toml` 只有一个 cron：`* * * * *`（`wrangler.toml:9-10`）。没有单独的“夜间 3 点”cron，全部由 `scheduled()` 每分钟判断。
- `scheduled()` 先算 Sydney 的日期和小时（`src/worker.ts:1129-1134`），然后检查 `hour >= 3 && hour < 6` 且最后一条消息距今超过 20 分钟（`src/worker.ts:1135-1140`）。
- 满足后取 `processed=0` 的消息 60 条，确认没有正在跑的 `dream` job、当晚批次数 <8，才入队 `kind='dream'`（`src/worker.ts:1142-1163`）。`dream_batches_<date>` 在入队时先 +1（`:1162`）。
- dream job 走 `WORK` 队列（`src/lanes.ts:1-12` 的默认分支），由 `processJob()` 消费（`src/worker.ts:498-526`）。

### 1.2 输入细节（决定它能不能自省）

- `analyse()` 的 `previous` 只查 `messages` 表：`SELECT ... FROM messages WHERE group_id=? ORDER BY ts DESC LIMIT 30`（`src/semantic.ts:46-52`）。
- `newMessages` 是 `p.messages`，来自 `messages` 表（`src/worker.ts:515-525`）。
- `message_meta` 只用来补 `meta`（引用、转发、direct 等），不是 bot 回复（`src/semantic.ts:59-67`）。
- **没有任何一处把 `outbox.body` 放进夜间 prompt。** 白天 `agentAnswer()` 会查最近 10 条 outbox 作为 `recentBot`（`src/semantic.ts:812-818`），夜间没有这段。
- `tainted()` 检查在 dream 里也会执行；一旦这批消息里有引用/转发/外部资料，整轮直接 `return`（`src/semantic.ts:68-70`）。但 `processJob()` 随后仍会把 `p.messages` 全部标成 `processed=1`（`src/worker.ts:526-532`）——**整批静默丢失且不再重试**。这是现有夜间流程的 P1 可靠性问题。
- dream 过滤会丢掉 `meta.direct === false` 和含密钥/密码模式的消息（`src/semantic.ts:71-79`）；过滤后为空也直接 return，同样会被标成 processed（`src/worker.ts:526-532`）。

### 1.3 产出与去向

- `facts` 写入 `facts` 表，最多 8 条，必须有逐字原文 evidence（`src/semantic.ts:144-194`）。
- `expressions` 经 `consolidateExpressions()` 写入，最多 8 条（`src/semantic.ts:195`、`src/learning.ts:46-96`）。
- `self_note` 写 `settings`，切片 1000（`src/semantic.ts:196-200`）。
- `team_reflection` 写 `settings`，切片 1200（`src/semantic.ts:201-202`）。
- `dreams` 一行：id=`dream-<首条消息id>`、date、body=当批 reflection（≤3000）、sources=消息 id 数组、message_count（`src/semantic.ts:203-216`）。
- `activity` 一行 `memory.consolidated`（`src/semantic.ts:217-224`）。
- 看板 `GET /api/team/state` 返回最近 7 条 `dreams`（`src/worker.ts:2053-2054,2131`），前端渲染成“夜间复盘”卡片，可展开来源（`web/app.js:967-981`）。`self_note` 作为“搭子近况”（`src/worker.ts:2123-2126`）。
- **`team_reflection` 本身不在看板上显示**；它只回到下一轮夜间 prompt（`src/semantic.ts:80,113`）和白天参与判定（`:853-857`）。人类只能通过 D1 或看板的 `dreams.body` 间接看到它。

### 1.4 为什么它完不成用户要的自省

1. **没有 bot 侧语料。** 只看用户消息，无法判断“这句话我答错了/没答上/答得敷衍”。
2. **没有决策与工具。** 看不到 `chat_decisions.action/gate/reason`，也看不到 `jobs` 的失败原因，无法定位“为什么没答上”。
3. **没有跨批汇总。** 每晚最多 8 次独立调用，每次 300 字；`team_reflection` 被后一批覆盖，`dreams` 是 8 条互不相关的片段。
4. **没有“问题清单”结构。** 输出只有 facts/expressions/reflection/self_note，没有 `misses[]`、`fix[]`、`priority`，无法直接变成开发项。
5. **全局批次可能混群。** `WHERE processed=0` 不带 `group_id`（`src/worker.ts:1144`），`previous` 却只用 `rows[0].group_id`（`src/semantic.ts:46-52`）；多群时会串群。

## 2. repo_changes / repo_commit / repo_file

### 2.1 实现在哪

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 工具 schema | `src/repo.ts:6-11` | 三个只读工具；`repo` 是字符串，不是 enum |
| 工具分发 | `src/semantic.ts:1222-1224` | `off:repo_tools` 开关；开着走 `runRepoTool()` |
| 云端实现 | `src/github.ts:247-269` | GitHub REST：commits / commit / file |
| 云端门禁 | `src/github.ts:145-149` | 白名单仓库必须有 `GITHUB_TOKEN`，否则 `needs_token` |
| 本地索引读取 | `src/repo.ts:93-118` | 读 D1 `repo_state` + `repo_commits` |
| 本地索引写入 | `src/repo.ts:65-85` | `/api/runner/repo_index` 上报入库 |
| 本机生产者 | `runner/repo_index.py:299-373` | 本机每 60s 扫 clone，POST 到 Worker |
| 本机线程 | `runner/bridge.py:292-294` | 只注册了 `repo_index.loop()`，没有别的 |

### 2.2 数据从哪来（线上 Worker 能不能看到仓库？）

- **云端路径**：Worker 直接调 `api.github.com`。对白名单里的 5 个仓库，`gate()` 要求 `GITHUB_TOKEN`；没有 token 就直接抛 `needs_token`，**不会退化成匿名 GitHub 请求**（`src/github.ts:145-149`）。有 token 时每次工具调用 8s deadline、最多 10 次 GitHub 请求（`src/github.ts:89-100`）。
- **本地索引路径**：Worker 自己不会 git；它读 D1 的 `repo_state`/`repo_commits`，这些由本机 runner 的 `repo_index.py` 每 60s 上报（`runner/repo_index.py:299-373`、`runner/bridge.py:292-294`）。索引只保留最近 90 天、每仓库最多 500 条已推送提交（`src/repo.ts:131-135`）。
- **所以**：线上 Worker 能看 GitHub（有 token 时）和 D1 索引；**看不到本机未 push 的提交、未 push 的分支、`Projects/.worktrees` 里的改动**。这些只有本机 runner 能看，而它现在的扫描范围也不包含 `Projects`。

### 2.3 为什么“问仓库新提交”答不上（按可能性排序）

**P0：团队真正在干的分支不在索引里。**

- `tracked_refs()` 只保留 `refs/remotes/origin` 里的 default 分支、`agent/*`、`team/*`（`runner/repo_index.py:109-113`）。团队约定是 `release/<版本>` 和 `pkg/<版本>-<包>`；这两类**即使 push 了也不会被索引**。
- 2026-11-14 00:35 实测 `git ls-remote --heads origin`：13 个 head，只有 `main`、11 个 `agent/*`、1 个 `team/*`，**没有任何 `pkg/*` 或 `release/*`**。也就是说，团队当前的包分支只在本机 worktree 里，远端根本没有。
- 本机 worktree 确实有未 push 提交：`TeamAgent-fast-lane-F4` 的 `a6641d2`、`TeamAgent-fast-hardening-release` 的 `35b3efa`/`f759f5c` 等，`origin/main..HEAD` 非空。
- 结论：用户问“我们仓库有哪些新提交/改动”时，bot 的索引最多看到 `main` 和 `agent/*`，看不到 `pkg/*`、`release/*`，也看不到本机未 push 的提交。

**P1：`Projects/.worktrees` 不在扫描根。**

- `build()` 的 `worktrees()` 根是 `H/work` 加 `config.index.extra_worktree_roots`（`runner/repo_index.py:272`）。本机 `~/.inkboard-team/config.json` 没有 `index` 段，所以额外根为空。
- 因此 `repo_changes` 返回的 `inProgress` 只覆盖 runner 自己的 `~/.inkboard-team/work`，**不覆盖 `/Users/yanghongming/Projects/.worktrees` 下 45 个团队目录**（`src/repo.ts:116` 的 `inProgress` 字段来自这里）。
- 即使分支名对得上，未提交的文件统计也看不到。

**P1：5 个仓库只 clone 了 1 个。**

- `~/.inkboard-team/repos/` 下只有 `TeamAgent`。
- `~/.inkboard-team/runner.log` 持续输出：`repo index: clone missing OmnixSI/NextThought`、`...NextThought-Website`、`...WhalePartner`、`...peiwan-store-platform-blueprint`。
- `build()` 对缺失 clone 直接返回 None（`runner/repo_index.py:262-264`），不会产生 `repo_state`；`runIndexedRepoTool()` 找不到 `repo_state` 就返回 `not_synced`（`src/repo.ts:107-108`），文案是“本机同步端还没上报过这个仓库，需要本机 runner 在线”（`src/repo.ts:14`）。
- 所以另外 4 个仓库的 `repo_changes`/`repo_commit` 只能走云端；云端又要求 token（见下一条）。

**P1：默认部署没有 `GITHUB_TOKEN`，云端路径对白名单仓库是死的。**

- `Env` 里 `GITHUB_TOKEN` 是可选（`src/worker.ts:64`）。
- 部署脚本的 secret 映射只有 `DEEPSEEK_API_KEY`、`ADMIN_TOKEN`、`RUNNER_TOKEN`、`QQ_APP_ID`、`QQ_APP_SECRET`，**没有 `GITHUB_TOKEN`**（`scripts/sync-runtime-secrets.py:8`）；GitHub Actions 也只传这 5 个（`.github/workflows/check.yml:34-39`）。
- 如果线上没有手工加过这个 secret，5 个白名单仓库的云端路径全部 `needs_token`；`repo_changes`/`repo_commit` 还能回退本地索引，`repo_file` 直接返回 `needs_token`（`src/repo.ts:124-126`）。
- **未确认**：线上 Worker 是否手工加过 `GITHUB_TOKEN`。需要 `wrangler secret list` 或等价只读检查；本次没有执行。

**P2：中文项目代称不被 `parseRepo()` 识别。**

- `parseRepo()` 只匹配 `owner/repo` 或仓库名部分，不查 `TEAM.project_aliases`（`src/github.ts:16-28` vs `src/policy.ts:35-36`）。
- 用户说“面试软件”“群助手”“大肥鱼”时，模型若把中文代称直接传给 `repo_changes`，会得到 `invalid_args`（`src/github.ts:18-19,28-30`）。`policy.command()` 支持这些别名，但那只用于 `/开工`（`src/policy.ts:11-22`）。

**P2：云端只看默认分支/指定 ref，且默认 7 天。**

- `repo_changes` 的 `since` 默认 `7d`，`ref` 可选（`src/repo.ts:8`）。如果用户问“这两周”或某个 `pkg/*` 分支，模型必须显式传 `since`/`ref`；它没有分支清单可参考，因为本地索引把 `pkg/*` 过滤了。

**P2：`repo` 是自由字符串，泛称会直接失败，失败信息也不回列白名单。**

- 三个工具的 `repo` 都是普通 string，不是 enum（`src/repo.ts:8-10`）。
- `parseRepo()` 只认 `owner/repo`、GitHub 链接或仓库名部分（`src/github.ts:16-30`）。用户说“我们自己的仓库”时，模型若原样传 `"我们仓库"`，直接 `invalid_args`；`NEXT.invalid_args` 只说“参数不对，按正确格式再问”，**没有回列 5 个白名单仓库**（`src/repo.ts:14`），模型很难自我纠正。
- 这类失败在群里表现就是“我看不到/查不了”，而不是“你要问哪个仓库”。

**P2：模型可能选错工具，或工具被预算裁掉。**

- `get_project` 返回的是 `repo_cache`（metadata/readme/issues/pulls/head）+ facts，**没有提交列表**（`src/semantic.ts:1201-1220`、`runner/bridge.py:126-138`）。模型若把“仓库怎么样了”理解成“项目现状”，会调 `get_project`，然后答不出“新提交”。
- 工具表只在 `turn < 2 && left(e) >= 32` 时传给模型（`COST.turn*2 + COST.tool + COST.tail = 4+12+16`，`src/semantic.ts:880`、`src/d1.ts:32`）。一个带图/引用/多段上下文的重回合可能把 48 条 D1 预算花到不足 32，模型这轮就**没有 repo 工具**，只能凭旧上下文说“看不到”。

### 2.4 今天实际能看到什么

- `TeamAgent` 的 `main`：能看到。本机索引在 00:26:55 上报过，`origin/main` = 8762214。
- `TeamAgent` 的 `agent/*` / `team/*`：能看到（如果 push 且在索引里）。
- `TeamAgent` 的 `pkg/*` / `release/*`：看不到（远端没有；即使有也被过滤）。
- `TeamAgent` 在 `Projects/.worktrees` 的未提交改动：看不到。
- 另外 4 个仓库：看不到（没 clone；云端默认没 token）。

这和用户说的“我们自己的仓库改动得怎么样了、有哪些新提交，他还是看不到”完全对得上。

### 2.5 只读复现思路（本次未执行线上调用）

1. 看远端分支：`git ls-remote --heads origin`（本次已跑，13 个 head，无 pkg/release）。
2. 看本机未 push：`git -C /Users/yanghongming/Projects/.worktrees/<pkg> log --oneline origin/main..HEAD`（本次已跑）。
3. 看索引过滤：`sed -n '109,113p' runner/repo_index.py`。
4. 看扫描根：`sed -n '268,276p' runner/repo_index.py` + `~/.inkboard-team/config.json` 是否有 `index.extra_worktree_roots`。
5. 看 clone 覆盖：`ls ~/.inkboard-team/repos` + `tail ~/.inkboard-team/runner.log`。
6. 看 token：`npx wrangler secret list`（只读；本次未跑，避免线上访问）。
7. 如果要在本地复现工具行为：用 `test/repo.test.mjs` 的 `setupWith`/`ingestRepoIndex` 注入 `repo_state`，再调 `runRepoTool`；不要往生产 D1 写。

### 2.6 最小修复清单（建议，未实施）

1. `runner/repo_index.py:109-113` 加 `pkg/`、`release/`（或直接取所有 `refs/remotes/origin/*`，展示时再截前 30）。这是让 bot 看见团队当前工作的最低成本改动。
2. `runner/repo_index.py:272` 把 `/Users/yanghongming/Projects/.worktrees` 加进 `index.extra_worktree_roots`；只对 TeamAgent 开，避免 45 个目录全量 stat。
3. 4 个缺失仓库：要么 clone 到 `~/.inkboard-team/repos`，要么线上加 `GITHUB_TOKEN`。云端 token 更省本机，但私有仓库需要只读权限；克隆更符合“本机 runner 才有仓库”的现状。
4. `repo_file` 在无 token 时明确回“本机索引不支持读文件”，不要给 `needs_token` 让模型误以为配一下就能读；`parseRepo` 接 `TEAM.project_aliases`，`invalid_args` 回列 5 个白名单仓库。

## 3. D1 里可供回放的数据

### 3.1 可用表与字段

| 表 | 关键字段 | 能回答什么 | 缺口 |
| --- | --- | --- | --- |
| `messages` | `id, group_id, sender, body, ts, mentioned, processed`（`schema.sql:4`） | 用户消息、时间、群、是否 @ | 不含 bot 回复；`processed` 只是夜间游标，不是“答没答” |
| `message_meta` | `id, json`（`schema.sql:12`） | 引用、转发、direct、mentions、replyTo | 需要解析 JSON；不是每条都有 |
| `outbox` | `id, group_id, msg_id, body, status, created_at`（`schema.sql:9`） | **bot 实际发出的文本**、发送状态、对应源消息 `msg_id` | 多段回复有 `~1` 后缀；`created_at` 是毫秒整数 |
| `outbox_meta` | `id, json`（`schema.sql:58`） | 引用回复的 reference | 只对部分回复有 |
| `chat_decisions` | `latest_id, batch_ids, gate, action, spoken_kind, reason, outbox_id, policy, model_ms, created_at`（`schema.sql:56`） | 当时的 reply/wait/stop、gate、80 字理由、模型耗时 | `reason` 最多 80 字（`src/rhythm.ts:24`）；不是每条 outbox 都有 decision |
| `jobs` | `id, kind, payload, status, attempts, error, created_at`（`schema.sql:8`） | research/plan/dream 等后台任务的成败与 200 字错误 | 没有工具名/参数/结果；`payload` 只有 latestId/batchIds |
| `activity` | `kind, entity, actor, summary, created_at`（`schema.sql:23`） | research.done、job.failed、task.created 等事件 | summary 是给人看的，不是结构化 |
| `dreams` | `id, date, body, sources, created_at, message_count`（`schema.sql:15`） | 每晚每批的 300 字 reflection | 不是评审，不含 bot 回复 |
| `model_runs` / `model_usage` | kind/effort/status/tokens/duration（`schema.sql:25,39`） | 调用次数、token、耗时 | 没有 prompt/response |
| `stage_timings` | `turn_id, stage, at, extra`（`schema.sql:62`） | chat_claimed、model_start/end、research_queued、outbox、sent | 没有 tool 名称/结果 |

**没有 feedback/评分表。** 成员对 bot 的反馈只存在于 `messages` 原文、`tasks.result` 或 `activity`，需要文本/规则提取；没有“这条回复被点赞/被纠正”的结构化信号。

### 3.2 成对查询（按群、最近 N 天）

下面的 SQL 只按 schema 写，**未在生产 D1 执行**；上线前先在只读副本跑：

```sql
SELECT
  m.group_id,
  m.id            AS message_id,
  m.ts            AS message_ts,
  m.sender,
  m.body          AS user_text,
  o.body          AS bot_text,
  o.status        AS send_status,
  d.action, d.gate, d.reason, d.model_ms,
  j.kind          AS job_kind,
  j.status        AS job_status,
  j.error         AS job_error
FROM messages m
LEFT JOIN outbox o
  ON o.msg_id = m.id AND o.group_id = m.group_id
LEFT JOIN chat_decisions d
  ON d.latest_id = m.id AND d.group_id = m.group_id
LEFT JOIN jobs j
  ON j.id = CASE WHEN instr(o.id,'~') > 0
                 THEN substr(o.id, 1, instr(o.id,'~') - 1)
                 ELSE o.id END
WHERE m.group_id = ?1
  AND julianday(m.ts) >= julianday('now', '-3 days')
ORDER BY m.ts;
```

要点：

- `outbox.msg_id` 是触发回复的源消息 id（`src/voice.ts:74-83`；调用方传 `p.latest.id` / `source.id`）。
- `outbox.id` 是 job id（`chat-<msgid>` / `research-<msgid>` / `semantic-<msgid>`），多段回复加 `~1`；`chat_decisions.outbox_id` 存的是同一个 job id（`src/worker.ts:778-780`、`src/rhythm.ts:51-56`）。
- `messages.ts` 是 ISO 字符串；`outbox.created_at`、`chat_decisions.created_at`、`jobs.created_at` 是毫秒整数（`schema.sql:4,8,9,56`）。跨表按时间过滤时不要直接比较，用 `julianday` 或先转毫秒。
- `jobs` 没有 `group_id`；只能通过 `outbox` 或 `payload.latestId` 关联。
- 一个消息可能有多段回复；统计时要 `COUNT(DISTINCT o.id)` 或 `group_concat`，不要直接 join 后数行数。

### 3.3 有没有记录“bot 说了做不到/不知道”的原因？

- **没有结构化字段。** `chat_decisions.reason` 是 gate 模型的一句话（≤80 字，`src/rhythm.ts:24`），不是失败分类。
- `jobs.error` 只记录后台任务异常（≤200 字，`src/worker.ts:937-942`）；`activity` 的 `job.failed` 是固定文案（`src/worker.ts:911-919`）。
- 白天工具失败的 `toolFailure.next_action` 只进模型上下文（`src/repo.ts:14-18`、`src/semantic.ts:1222-1224`），**不落库**。
- bot 最终说的“我看不到/没同步/不知道”只在 `outbox.body` 里是自然语言，没有 `failure_kind` 字段。
- 要做自省，第一步得补观测：每轮记录 `tool_name`、`args`（脱敏）、`error_kind`、`final_action`、`outbox_id`。现在没有任何表能还原“它当时调了什么、为什么失败”。

### 3.4 保留与预算

- `messages`、`outbox`、`chat_decisions` 没有定期清理（`src/worker.ts` 只有 health/model/CI 等清理；`grep DELETE FROM messages|outbox|chat_decisions` 为空）。所以“最近 N 天”随时可取。
- `jobs` 里 `chat`/`research`/`voice_notice`/`scout` 的 `done` 行 7 天后删除（`src/worker.ts:1213-1217`）；`dream`/`plan`/`media` 保留更久。要看 7 天前的工具失败，`jobs` 可能已经没了。
- `repo_commits` 保留 90 天、每仓库 500 条（`src/repo.ts:131-135`）。
- 每次 Worker 调用 D1 预算 48 条语句（`src/d1.ts:10`，`docs/decisions.md:27`）；免费档单次最多 50 查询（`docs/operations.md:22`）。一个评审 job 最多做 3–4 条 SELECT + 1 个 batch INSERT，否则会被 `metered()` 截断。

## 4. 现有“自己提需求给开发版”的通道

### 4.1 有哪些现成东西

| 通道 | 现状 | 证据 |
| --- | --- | --- |
| 共享任务表 `tasks` | `status` 默认 `proposal`；看板“待推进”显示 proposal/queued；可领取、回填、评审 | `schema.sql:5`、`src/tasks.ts:100-127`、`web/app.js:13,312,360` |
| `POST /api/team/task` | 任何登录身份（含 AI token）可建任务；AI token 会被清空 assignee、关闭自动 plan | `src/worker.ts:2295-2303`、`src/accounts.ts:103-120` |
| MCP `teamagent_create_task` | 本机 AI 把建议写成共享待确认任务，不自动开工 | `clients/mcp.mjs:61-70` |
| bot 的 `prepare_project_task` | 需要群成员原话 + `source.meta.direct === true` + `REPOS` 白名单；否则抛“需要明确本群直接交办” | `src/semantic.ts:1117-1130`、`src/authz.ts:113-122` |
| 夜间 prompt | 明确“夜间不能创建、重做或补执行任何旧任务” | `src/semantic.ts:102` |
| GitHub Issue | **没有创建代码**；全仓库 grep 不到 issue create / `gh issue` | `src/`、`runner/`、`clients/` 均无 |
| `discoveries` 表 | 用于 scout 的技术发现和 CI 详情，不是任务/想法收件箱 | `src/semantic.ts:588-626`、`src/ci.ts:290` |

### 4.2 结论：bot 现在不能自己提需求

- 唯一写入 `tasks` 的 bot 工具是 `prepare_project_task`，它把“授权”绑在一条真实的群消息上（`src/semantic.ts:1122-1130`）；夜间没有“当前成员原话”，所以调不了。
- 夜间 prompt 还把“创建任务”直接禁了（`src/semantic.ts:102`），即使模型想提也只会写进 reflection。
- 没有 GitHub issue、没有 inbox 表、没有 `.agent` 写入路径。
- 所以现在只能由人（或 BINI/主程）看板后手动建任务；bot 自己闭环不了。
- **架构缺口**：TeamAgent 没有到本工作室 bot 的消息总线；“反馈到这里”目前只能靠看板任务/活动被 BINI 侧读到。BINI 需要一个每日读板（或读 D1）的例行任务，否则任务建了也没人接。这是跨系统集成，不是 TeamAgent 单仓库能解决的。

### 4.3 本机 runner 能不能写 `/Users/yanghongming/Projects/TeamAgent`？

- 进程以 `yanghongming` 身份跑（launchd `gui/501`），**操作系统权限上能写**。
- 但现有代码没有写这个路径：
  - `runner/execute.py` 只在 `~/.inkboard-team/repos/<repo>` 和 `~/.inkboard-team/work/<key>` 里建 worktree、写结果（`runner/execute.py:139-151`）。
  - `runner/subagent.py` 是只读调查员：工具配置 `write:false, edit:false, applyPatch:false`（`runner/subagent.py:47-48`），prompt 也要求不改文件（`runner/subagent.py:28`）。
  - `runner/repo_index.py` 只读 git，不写仓库（`runner/repo_index.py:92-93` 的 `_git` 全是 read）。
- 而且 `/Users/yanghongming/Projects/TeamAgent` 根本不存在；团队用的是 `.worktrees/TeamAgent-*` 各自独立的 clone（每个有自己的 `.git` 目录，不是同一个仓库的 worktree）。
- 结论：**技术上能，产品上没有通道；要新写一个 job 类型并指定目标目录，风险是弄脏包分支。不建议让 bot 直接写代码目录。**

### 4.4 最小可行闭环（建议，未实现）

1. 新增 `self_reviews` 表（或复用 `dreams`，id=`review-<date>`），存完整评审 JSON/Markdown。
2. 评审 job 内部调用 `createBoardTask(e, {repo:'OmnixSI/TeamAgent', title:'自省：…', detail:'…', plan:false}, {name:'夜间复盘'})`，每条最多 3 个，`status` 自然是 `proposal`（`src/tasks.ts:100-127`）。
3. 写一条 `activity(kind='review.created')`，看板可见。
4. 不自动 `requestPlan`，不自动 `queued`，不发群；由 BINI/主程看板后决定是否写进 `.agent/releases/<version>/next.md`。
5. 这样既符合“项目任务保留为待成员启动的 proposal”（`docs/decisions.md:26`），也不需要给 bot GitHub 写权限。

## 5. 独立评审放哪跑

### 5.1 三种位置对比

| 方案 | 独立模型调用 | 数据可达 | 可靠性 | 成本/约束 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Worker cron + 新 job kind** | 可以：新 job、新 system prompt、全新 context；不需要给工具 | 直接读 D1 的 messages/outbox/decisions/jobs | Cloudflare 常开；已有每分钟 cron 和 03–06 窗口 | 每次调用 48 条 D1 语句；模型 540s 超时；DeepSeek 按量计费 | **推荐** |
| 本机 runner | 可以：`runner/subagent.py` 会起独立 DSH 进程 | 能读本机 git/文件；D1 只能走 HTTP | 依赖 Mac 不睡眠、QQ 网关在线；`subagent.py` 还没接进 bridge（`runner/bridge.py:292-294` 只注册 repo_index） | 用户明确不想把电脑当服务器；离线就断 | 只适合作为补充/复核，不适合每晚主路径 |
| V-B delegate | 设计上有 `delegateTool`/`runDelegate` | 设计为读代码/执行代码，不是评审 | **还没进 main**：`src/subagent.ts` 不存在；`runner/subagent.py` 的 `READER_VERIFIED=False`（`runner/subagent.py:30`），方案 B 只做受限 git 搜索 | 要租约、并发、取消、清理，复杂度高 | 现在不可用，也不适合评审 |

### 5.2 推荐落点

- **触发**：在 `scheduled()` 的夜间块之后加一个 `review` job。条件建议：Sydney `hour === 6`（03–06 窗口结束）、当天有 `dream_batches_<date>`、没有 `dream` job 在跑、`settings.self_review_<date>` 未设置。这样评审能看到前一晚所有 dream 批次的结果。
- **入口**：`processJob()` 加 `if (claim.kind === "review")`，调用新模块 `src/review.ts` 的 `nightlyReview(e)`。不要塞进 `semantic.ts`（V-B 施工单已把它列为冲突热点）。
- **数据**：只读 3 条 SQL：
  1. 最近 3 天 `messages` + `outbox` 成对（上限 200 对，按群分组）；
  2. 同一窗口的 `chat_decisions`（action/gate/reason）和 `jobs`（kind/status/error）；
  3. 统计：每群消息数、bot 回复数、stop 数、`jobs.error` 数、未回复的 @ 数。
  然后 1 个 batch 写 `self_reviews`/`dreams` + 最多 3 个 `tasks` + `activity`。总计 <48 条 D1。
- **评审 prompt**：独立 system：`你是独立评审员，不参与刚才的对话；只根据记录评判。找出：没答上的、答错的、该记住没记住的、该改的代码/提示词。输出 JSON {summary, misses[], memory_requests[], dev_requests[], do_not[]}。每条必须引用 message_id/outbox_id。不得编造用户事实。`
- **模型**：`llm(e, "memory", "max", ...)` 或新增 `review` kind（`src/policy.ts:3-8` 加 `review: "max"`，`config/team.json` 的 `effort_by_kind`/`timeouts_ms` 加一项）。复用 `model()` 的用量记录（`src/runtime.ts:57-96`）。
- **独立性**：这是“独立上下文/独立 job”，不是“独立模型家族”。当前 Worker 只有 `DEEPSEEK_API_KEY`，`model()` 硬编码 `https://api.deepseek.com/chat/completions`（`src/worker.ts:59-66`、`src/runtime.ts:66-84`）。要换家族（Claude/GPT/Gemini）需要新 key + 新 adapter，仓库里没有。
- **不要做的**：不发群、不自动 `queued`、不自动改 `facts`/`self_note`、不写代码目录。评审只产出 proposal 和报告。

### 5.3 成本与免费额度

- Cloudflare：Worker/D1/Queues 都在免费档（`docs/decisions.md:12`、`docs/operations.md:9`）；D1 单次 50 查询上限（`docs/operations.md:22`），代码预算 48（`src/d1.ts:10`）。
- DeepSeek：按团队账户计量，不会自动升级 Cloudflare 付费档（`docs/maintenance.md:50`、`src/guide.ts:85`）。现有夜间最多 8 次 `memory/max` 调用（`config/team.json:30`）；加 1 次评审 = +12.5%，加 3 次（按天摘要+总评）= +37.5%。
- 03:00 Sydney = 00:00 北京时间，落在夜间谷时；具体单价/折扣仓库没有记录，**未确认**。
- 如果一定要“不同家族”且不想加钱：Cloudflare Workers AI 有免费额度，但 `wrangler.toml` 没有 `[ai]` binding，也没有适配代码，**未配置**；要另开一项工作。

## 6. 未确认 / 风险

1. **线上是否有 `GITHUB_TOKEN`**：未查 `wrangler secret list`。如果没有，云端 repo 工具对 5 个白名单仓库全部 `needs_token`；`repo_file` 完全不可用。
2. **线上 `repo_state` 是否有另外 4 个仓库**：未查 D1。按本机日志，4 个 clone 缺失，理论上没有；需要 `SELECT repo, checked_at FROM repo_state` 确认。
3. **`off:repo_tools` 是否被打开**：未查 `settings`。如果被设为 `1`，工具根本不会出现在模型工具表里（`src/semantic.ts:809,1222-1224`）。
4. **具体那次群聊里模型有没有调用 `repo_changes`**：未回放真实消息。可能它压根没调工具，也可能调了拿到 `not_synced` 后如实说看不到。需要拿一条真实消息做本地回放才能区分。
5. **D1 实际数据量/成对覆盖率**：未查线上。`outbox.msg_id` 对多段回复、proactive、research 的覆盖需要用真实数据验证。
6. **`dream` 的 tainted 静默丢批**：代码上确定（`src/semantic.ts:68-70` + `src/worker.ts:526-532`），但线上发生过多少次未统计。这是现有夜间流程的 P1，建议在 V-D 一起修。
7. **多群混批**：`WHERE processed=0` 不带 group（`src/worker.ts:1144`），当前若只有一个群影响不大；多群时必须按群拆批。

## 附：本机实测记录（2026-11-14 00:30–00:40 Sydney）

- `git ls-remote --heads origin`（TeamAgent）：13 个 head；`main` + 11 个 `agent/*` + 1 个 `team/*`；无 `pkg/*`、无 `release/*`。
- `~/.inkboard-team/repos/`：只有 `TeamAgent`；`origin/main` = `8762214`。
- `~/.inkboard-team/runner.log`：持续出现 `repo index: clone missing OmnixSI/NextThought`、`...NextThought-Website`、`...WhalePartner`、`...peiwan-store-platform-blueprint`。
- `~/.inkboard-team/repo-index-state.json`：`OmnixSI/TeamAgent` 的 `sent_at` = 1794576415（2026-11-14 00:26:55），frontier 的 `origin/main` = 8762214。
- `git -C .worktrees/TeamAgent-fast-lane-F4 log --oneline origin/main..HEAD`：`a6641d2`。
- `git -C .worktrees/TeamAgent-fast-hardening-release log --oneline origin/main..HEAD`：`35b3efa`、`f759f5c`、`83626f4`、`288a989`、`b1066da` 等。
- `/Users/yanghongming/Projects/TeamAgent`：不存在（`cd` 失败）。
- 未执行：`npm test`、线上 D1 查询、`wrangler secret list`、真实群消息回放、任何 QQ 发送。
