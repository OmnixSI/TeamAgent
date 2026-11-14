# 群 bot 代码可见性 / 能力边界 / 子代理 · 综合报告

综合人：调研员（DeepSeek）｜2026-11-12 核对｜输入：我的 `research-agent-capabilities.md`、Codex 的 `research-capability-codex.md`、工程师 `TeamAgent-recon-bot-capability-20261112.md`（只读现状）。
未登录账号、未读密钥、未改任何项目文件。

## 摘要（8 行）

结论：保留 Worker＋D1＋本机 runner，**代码可见性走本机 checkout 的只读工具**，子代理**复用现有 `execute.py`/DSH**并新增一个 `subagent` job，减少「不知道」靠「能力清单＋工具优先＋可执行错误＋分级确定性」，不靠改提示词喊口号。
1. 代码要分三层看：已推送提交（git log/diff）、工作区未提交（git status/diff）、每次中间编辑（只有写入方记录才可靠）——三层混为一谈是这次最大的分歧来源。
2. 现状远不够：`repo_cache` 只有 metadata/readme/issues 和 5 个固定文件，没有文件树、没有 git 历史、没有 diff（工程师侦察，`src/worker.ts:391-442`、`runner/bridge.py:73-178`）。
3. 子代理不必新起一套：`execute.py` 已在 worktree 里用 `dsh --profile` 改代码、跑测试、开 PR；缺的是群 bot 的 `spawn` 入口和权限/预算/取消。
4. 少说「不知道」是四件事的合力：能力清单动态生成、先查再答、失败给可执行下一步、区分「查证/推断/未验证」；只改提示词不会增加能力。

## 一、两位一致

- **A 方案为主**：本机 runner 保持 checkout，暴露固定参数的只读工具（search/read/log/diff），GitHub API 只做离线备用，R2 仅在需要全天可用时加。[git-log](https://git-scm.com/docs/git-log)、[Contents](https://docs.github.com/en/rest/repos/contents)、[R2 定价](https://developers.cloudflare.com/r2/pricing/)
- **只读 ≠ 读不到密钥**：必须 repo ID 白名单＋realpath/symlink 校验＋排除 `.env`/凭据/家目录，不能只靠提示词。
- **子代理必须设上限**：深度、并发、预算、超时；子代理可再派子代理，不设限会长成树。
- **只改提示词不够**：没有工具就不会增加能力，失败反馈与证据检查要一起做。
- **额度事实**：GitHub 认证 5,000 次/时、匿名 60 次/时；D1 免费每日读 500 万行/写 10 万行、5 GB；R2 免费 10 GB/月。[GitHub 限额](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)

## 二、分歧与核实
**1）代码可见性到哪一层？** 我 → 本机 checkout；Codex → checkout ＋ 变更记录 ＋ D1 任务；工程师 → 现状只有固定文件。
核实：读 `runner/bridge.py` 与 `src/worker.ts:391-442`，现状确实没有文件树/历史/diff；读 git 文档确认三者是不同命令。**结论：Codex 更完整，采纳三层分法**——已推送用 `git log`/`git diff`，未提交用 `git status --porcelain`＋`git diff`（每次现算，不缓存历史），「每次编辑」只能由写入方记，watcher 不保证（[Node fs.watch caveats](https://nodejs.org/api/fs.html#caveats)）。
**2）子代理用 codex exec 还是现有 DSH？** 我 → codex exec/claude -p；Codex → D1 队列＋Codex exec/Claude SDK；工程师 → `execute.py` 已用 DSH。
核实：`runner/execute.py:180-190` 确为 `dsh_program()` ＋ `--profile dsh-team.yml`，且已接 worktree/租约/取消。**结论：默认执行器用 DSH**（已在链路里），`codex exec -s read-only --json` 只当只读调查员（[Codex 非交互](https://developers.openai.com/codex/noninteractive)，本机 `--help` 确认沙箱值为 read-only/workspace-write/danger-full-access）。我原报告把 codex exec 当主力，偏了。
**3）未提交改动怎么覆盖？** 我漏了；Codex 说 watcher 不可靠；工程师说 bridge 只同步固定文件。
核实：Node 官方列明 fs.watch 合批/丢事件。**结论：查询时 `git status`＋`git diff` 现算最准**；要「每个编辑版本」只能由 `execute.py` 在每次成功写入后追加 snapshot 记录，不能承诺 watcher 全覆盖。
**4）权限上限怎么设？** 我 → depth/concurrency/spend；Codex → `allowedTools` 是自动批准列表，不是可用性白名单。
核实：读 Claude 权限文档，`allowedTools` 确为 allow/auto-approve 规则，未列出的工具仍存在、只是要审批。**结论：限权靠「实际提供的工具集＋disallowedTools＋沙箱隔离」，不能靠 allowedTools 清单**（[权限](https://code.claude.com/docs/en/agent-sdk/permissions)、[子代理限额](https://docs.claude.com/en/docs/agent-sdk/subagents)）。
**5）预算数值**：双方都是建议默认值（并发 2、深度 1、单任务超时），均未压测——一致为「建议值，未验证」，不作为已证实结论。

## 三、仅一方查到

- **仅 Codex**：push payload 最多 2,048 commit（我未复核）；Compare API 单次 300 文件（我复核，属实：[Commits](https://docs.github.com/en/rest/commits/commits)）；GitHub 不自动重投失败 webhook、可能乱序；Claude Agent SDK 是商业许可不是 MIT；OpenHands SDK 1,386★、v1.62.0 有委派示例。
- **仅我**：OpenClaw 的 `subagents.allowAgents` 白名单与 `delegationMode` 只是提示（[文档](https://docs.openclaw.ai/concepts/multi-agent)）；`aider --message` 一次性执行（[Aider](https://aider.chat/docs/scripting.html)）。
- **仅工程师（第三方证据，非调研结论）**：现有 8 个工具、工具只在 turn<2 提供且最多 3 turn、`research`/`plan` 在云端 Worker 跑、`media`/`fetch` 在本机跑、`claude`/`codex` 已安装但未被 runner 调用。

## 四、推荐做法

**A. 代码可见性**
1. 已推送：runner `git fetch`，只读工具 `git log/diff/show`，回答带 SHA。
2. 未提交：同一 checkout 现算 `git status --porcelain`＋`git diff`（含 `--cached`），不缓存。
3. 每次中间编辑：不承诺；必须时由 `execute.py` 写 snapshot 日志。
4. 防护：repo ID 白名单、realpath＋symlink 解析、拒 `.env`/`.git/config`/`*.pem`/家目录、单文件与总字节上限、禁自由 shell 与 `--ext-diff`/textconv。
5. 云端备用：GitHub App `Contents: read`（离线也能查已推送内容）；R2 暂不上。

**B. 子代理委派**
1. 新增 `subagent` job kind（复用 `queueFor`/`processJob`），payload：role、repo、snapshot SHA、allowed tools、budget、deadline。
2. 默认执行器 DSH（worktree/PR/取消已具备）；只读调查走 `codex exec -s read-only --json`。
3. 权限：角色白名单（`research_readonly`、`code_exec`）、裁剪实际工具集、depth=1（子代理不能再派）、子代理不得绕过主 bot 的写权限。
4. 并发 2、单任务超时、预算硬上限；取消 = D1 状态位 ＋ runner 杀进程组（`execute.py` 已用 `start_new_session`）。
5. 回收：JSONL 事件→进度序号；最终产物落 `jobs.result`；QQ 先回执再回报，断线靠记录恢复。

**C. 少说「不知道/做不了」的 5 个模式**
1. 能力清单动态生成（工具注册表＋runner 在线状态＋repo/ref/同步时间＋离线原因），不写死。
2. 工具优先门：先查再答，答复带 SHA/文件/行号；「没搜到」≠「不存在」。
3. 可执行失败：error_kind / retryable / next_action / 已试范围，禁止只回「失败」。
4. 分级确定性：查证事实 / 推断 / 未验证分开说；未知时说明还差哪份证据。
5. 先小范围做完再委派；没有 delegate 工具就不要说「我有团队」。

## 五、选型对比（执行器）

| 候选 | 维护/许可 | 与现状契合 | 迁移成本 |
|---|---|---|---|
| 现有 DSH（`execute.py`） | 已在用 | 最高：worktree/PR/租约/取消齐全 | 低（加 job kind） |
| Codex CLI | 0.167.0，Apache-2.0 | 只读调查强，事件流清晰 | 低（子进程） |
| Claude Agent SDK | 商业条款，非 MIT | 原生 subagents 但需另接 QQ/D1 | 中 |
| OpenClaw / OpenHands | MIT，整平台 | 太重，只借协议 | 高 |

## 六、未核实

- push payload 2,048 与 webhook 乱序（仅 Codex 引，我未复核）；DSH 只读档位与输出结构（工程师未展开）。
- 并发 2／深度 1／预算数值未压测；只读工具的路径逃逸（`../`、symlink、git 别名）未做渗透测试。
- 云端模型仍会看到代码片段，「本机执行」不等于「代码不出机」。

## 七、建议下一步

1. 工程师先加 `read_repo_file`/`git_log`/`git_diff` 三个只读工具＋路径白名单，回答带 SHA。
2. 再加 `subagent` job kind（先只读 research 角色、并发 1），最后补能力清单与失败三件套做回归。
