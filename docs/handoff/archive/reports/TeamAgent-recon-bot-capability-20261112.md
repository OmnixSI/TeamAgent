# TeamAgent 群 bot 能力侦察（main 954aa99，只读）

## 1. 现在能读到仓库什么
- Worker `repoContext()` 直取 GitHub API 时只取 metadata、readme、open issues（8）、open pulls（5）；若本机 bridge 刚同步过，会原样返回缓存里的固定文件/最新 head/checks，但仍没有文件树、逐次历史或 diff。`src/worker.ts:391-442`，缓存分支 `:396`，字段 `:408-412`。
- 本机 `bridge.py` 每 30 秒循环、但 `sync_repos()` 有 300 秒节流；用本机已登录的 `gh` 取上述字段，另取固定文件 `AGENTS.md`、`CONTRIBUTING.md`、`package.json`、`docs/MEMORY_ARCHITECTURE.md`、`docs/PERSONALITY.md`（每个截 10000 字），以及默认分支最新一次 commit 和最近 20 个 check-runs；没有 git 历史和逐次 diff。`runner/bridge.py:45-47, 73-100, 101-121, 122-178`；结果 POST 到 `/context`：`:222`。
- 存放：D1 `repo_cache(repo,json,updated_at)`；`schema.sql:10`。`get_project` 直接回读该行并附 facts；`src/semantic.ts:1166-1188`。
- 私库：本机同步靠 `gh` 的本机登录；Worker 直取靠 `GITHUB_TOKEN`，无 token 时只用旧缓存并标 stale；`src/worker.ts:398-401`。
- 聊天上下文里的项目目录只放 metadata/readme 前 2500 字/issues/pulls，不放 head/checks/files；`src/semantic.ts:77-90`。所以“看得到每一次修改和具体代码”目前**不成立**。

## 2. 工具清单与执行位置
- 共 8 个：`get_work_status`（任务/媒体结果，`:622`）、`remember_correction`（`:637`）、`recall_memory`（`:658`）、`create_file_task`（明确文件交办，`:674`）、`prepare_project_task`（明确开发/方案，`:706`）、`search_web`（4 条，`:742`）、`read_web`（`:754`）、`get_project`（`:766`）。
- 工具只在 turn<2 且 D1 预算足够时提供，最多 3 turn；`src/semantic.ts:843-845, 936`。写工具还要原话、直接交办、authz；`create_file_task` 建 `media` job（`:976-1080`），`prepare_project_task` 建 task + `plan` job（`:1083-1140`）。
- 非只读工具一旦被调用且当前不是 background，会转成 `research` job 后结束当前轮；`src/semantic.ts:850-895`。该 job 在 **云端 Worker** 的 `processJob` 执行 `agentAnswer`，模型 `deepseek-flash` / effort `high` / 180s；`src/worker.ts:555-579`、`config/team.json:3-22`。
- `plan` job 也在云端 Worker，`deepseek-flash`，high 方案 high、复杂方案 max，540s；`src/worker.ts:759-775`。`media` 在**本机 Python runner** `utility.py` 领取执行（`:171-176`）；B 站 fetch 在 `fetcher.mjs` 本机循环（`:187-199`）。`qq-gateway.mjs` 只转发 QQ，不跑模型（`:1-2`）。

## 3. 为什么爱说“不知道/做不了”
- `config/participation.json:11`：“拿不准就选 stop，不要用 wait 拖延”；`config/voice.json:2`：“不懂的梗短问一句即可，不装懂”。这是保守发言规则，不是能力说明。
- 工具失败被统一降成固定话术：`src/semantic.ts:1191-1194` `unavailable:true, reason:"未能获得资料，不能据此编造结论"`；`get_project` 无缓存返回 `{unavailable:true}`（`:1185`）。没有“先查文件/git 再回答”的正向指令。
- 结构限制：没有读代码工具；`get_project` 只有固定文件/最新 head；Worker 5 分钟缓存过期且无 token 就 stale（`src/worker.ts:396-401`）；`read_web` 只读 URL、没有仓库文件读取。
- 写/开发要求逐字原话和 `source.meta.direct`，否则报“需要明确本群直接交办”；`src/semantic.ts:976-1000, 1083-1110`。

## 4. 本机 runner 能做什么
- 已有 subprocess/agent 执行：`execute.py` 用 `dsh --profile headless`（不是 claude/codex）在独立 worktree 改代码、跑测试、commit/push/开 PR（`runner/execute.py:50-59, 120-152, 184-203`）；`utility.py` 跑文件/视频处理（`:171-176`）；`bridge.py` 只跑 `gh` 同步并轮询任务（`:226-278`）。
- `which` 实测：`claude=/Users/yanghongming/.nvm/versions/node/v26.13.0/bin/claude`、`codex=.../codex`、`dsh=/Users/yanghongming/.openmausbot/tools/npm/bin/dsh`、`git=/usr/bin/git`、`gh=/opt/homebrew/bin/gh`、`node=.../node`、`python3=/usr/bin/python3`。
- 结论：有本机命令/子进程能力，也有 DSH 编码 agent；但群 bot 的工具清单没有“执行命令”或“派子代理”入口，claude/codex 只是装了，没被 runner 代码调用。

## 5. “bot 派子代理”的雏形与缺口
- 雏形：`research` 是同一 agent 的后台续跑（不是独立角色）；`media` 是本机文件 job；`plan` 是云端方案 job；`execute.py` 是独立 DSH 编码进程。队列分工见 `src/lanes.ts:3-10`。
- 缺口：没有 `spawn_agent(role,prompt,repo,scope)` 工具/ job 类型；没有子代理模型选择、独立上下文、权限上限、并发/预算、取消与结果回收；`research` 只复用当前对话，不能指定 Claude/Codex/其他角色。
- 成员侧 `clients/mcp.mjs` 有任务/项目工具（`:19-75`），但那是成员自己的 AI 接入，不是群 bot 自派。

## 6. 最小改动三个落点
1. `runner/bridge.py sync_repos()` 增补 `git fetch` + `git log --oneline -N` + `git diff --stat`/文件树快照写入 `repo_cache`；`src/semantic.ts get_project` 暴露只读 `files/commits/diff`。
2. `src/semantic.ts` 工具表加 `read_repo_file`/`git_log`（只读、路径白名单、大小上限），把“不知道”前的最后一步变成真实读取，而不是只读 5 分钟缓存。
3. `src/worker.ts` 增 `subagent` job kind（复用 `queueFor`/`processJob`），payload 带 role/model/read-only/budget；先支持只读 research，再放开 DSH 编码，结果走现有 `research` 回传路径。
