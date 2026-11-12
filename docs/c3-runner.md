# C3 本机只读调查 runner（尚未接入 Worker）

基线固定 `0f67b289b2af019572e091254e1b42a9cbaac75a`。本批只实现本机侧，不启动真实服务，不注册 bridge 线程，不改 Worker、schema、CI 或依赖。

## 接口与取材

- `runner/subagent.py` 提供 `loop/claim/prepare/context_pack/execute/search_read/report/cleanup/recover_orphans`。
- `runner/gitsafe.py` 与 `test/gitsafe_test.py` 原样取自 C1 提交 `6e047a3`，未另写 git 防护。
- `loop()` 默认开启（本机 config 的 `subagent.enabled=false` 时立即返回），最多占两个本机槽位；未来由 bridge 的独立 daemon 线程调用。
- claim 只接受响应中的 `run`；lease 始终使用服务端返回值。进程运行每 20 秒心跳，409 或 90 秒无续租杀掉进程组并禁止回报；取材阶段也续租并抑制失效结果。
- report 网络失败最多重试 3 次，每次间隔 5 秒，始终同一个 lease；409 不重试。未进行真实 HTTP/QQ 调用。
- ref 解析顺序为 `<ref>^{commit}`、`origin/<ref>^{commit}`，保存完整 SHA；detached worktree 仅在 `H/sub`。每仓库 fetch 最密 60 秒。
- DSH 运行时才生成权限 0600 的 `H/dsh-reader.yml`，只读与搜索配置与方案逐行一致；临时 HOME 为 0700。进程只获得既有执行器的环境白名单与模型 key，不获得 runnerToken/GitHub token。
- marker 在 prepare 前写空 PID，Popen 后立即原子补 PID/PGID/lstart。回收先核 ps 启动时间和命令行中的 `dsh-reader.yml`；空 PID、无关进程、坏 JSON 均不会触发信号。逐项清理，单个失败不阻塞后续 marker。
- `reload_runtime.py` 在两处检查 mtime 距今小于 900 秒的 marker；quiesce 后发现新任务会 resume，再退出。

## 步骤 0 的实际结果

实测仅使用合成仓库/文件和临时 HOME；没有读取真实 `.env`、凭据、Cookie 或 Edge 配置，没有调用真实模型或线上服务。

使用最终实现生成的沙箱与配置，离线检查结果：

| 探针 | 结果 |
| --- | --- |
| 合成 `worker-secrets.json`、SSH 文件、`.openmausbot` 私有子目录 | `cat` exit 1，Operation not permitted |
| 合成 DSH 安装目录文件、README | exit 0，内容匹配 |
| 真实安装的 DSH + 精简 patch，`--dump-config` | exit 0，没有退出 71 |
| 工具配置 | 组合配置中派生/workflow/shell/web 均禁用，fs write/edit/applyPatch 为 false |
| `dsh-tool-fs` | `0.2.2-rc.1` |
| 模型返回的真实工具表、未知工具探针、README read 事件 | **待现场核**，配置转储不能替代这些事件 |
| 原生空文件/空白文件事件 S-26(g)(h) | **待现场核**，没有用手工夹具冒充原生事件 |
| 网络仅 TCP 443 + DNS | 规则已生成；真实模型连通性未验收 |

详细离线证据：`.agent/c3-step0-result.json`（不提交），临时原始输出目录记录在该文件中。单测还使用真实 `sandbox-exec` 检查合成 cookie/gh/aws/codex/claude/Keychains 等目录，阻止真实 HOME/仓库外写入，允许子 worktree 和临时 HOME 写入。

由于真实工具/read 事件尚未通过步骤 0，`READER_VERIFIED=False`，保持方案 B；不把 DSH 配置加载成功当作可启用证明。方案 B 直接用受限 git 对固定 SHA 搜索，选命中最多的三文件，逐文件最多 8000 UTF-8 字节；DENY 过滤后脱敏，零命中/全拒绝/纯空白返回 failed/not_found、answer 为空。成功的 `answer` 是带 UNTRUSTED 边界的资料片段，尚不是回答用户的结论。

`body_chars/read_evidence` 使用 v1.3 编号行规则，封套/EOF/分页提示/空白/BOM/零宽字符不算读到。单测覆盖 S-26(a–f,z) 的格式与内容块，以及 S-13/S-19 的空搜索、错误 read、上下文自读与越界路径。S-26(g)(h) 等真实事件可用后再补入夹具；判据不放宽。

## Worker 阶段待接入与待测

- D-1–D-26 全部：start/配额/稳定 id、claim/lease/deadline、取消、report 原子幂等、progress 去重、owner/runner 鉴权、过期与恢复、resolved SHA、D1 每次 ≤48。
- S-10 的服务端第三次 claim 拒绝、S-14 的方案 B research 工具表及 resume 深度闸。当前只验证本机槽位上限。
- 方案 B 的资料要创建 `research`，payload 保持 `origin:'subagent'`，不得直接投递资料片段冒充最终答案；report/任务路由集成在该阶段完成。
- bridge 注册 `subagent.loop()`、安装文件分发、Worker idle/quiesce busy 计数与开关；本批不启用服务。真实模型探针全过前不可启用 DSH 路径。
- fastlinks 合并后的三态派发、入口 allowedNames、origin 防递归、嘴替无工具与引用回复、真实 QQ 取消/超时/离线验收。

范围解释：沙箱明确规则允许临时 HOME 写入；S-4 的禁止写 HOME 按真实 HOME 验证，未将这条解释为禁止 DSH 在临时 HOME 保存状态。

## 2026-11-13 复核返工：步骤 0 阻断，停止提交

针对 `TeamAgent-c3-runner-review-20261113.md` 的 2 项 P1、3 项 P2，新增 5 项测试先红（15 个子断言失败、2 个错误）后绿；本机 `subagent_test.py` 为 45/45，无跳过。原有 40 项全部通过，包含复核容器中受嵌套 sandbox/ps EPERM 影响的那 6 项。

已写入但**尚未提交**的修复：

- 拒绝整个真实 HOME 下的 `.openmausbot`，仅放行 `tools/npm`；补 `.dsh/.credentials.yaml`、`qq-session.json`、实际浏览器/秘密目录与精确凭据文件名。
- 删除递归匹配 `cookie|bili|x-` 的正则，合成 `prefix-sum.ts`、`box-shadow.css`、`bilingual.md` 均可读，敏感名称仍不可读。
- read 输入先 `expanduser()` 再校验实际路径在 worktree 内，HOME 文件不再充当读到代码的证据。
- 共享 reader patch 使用每次独立的 0600 临时文件，fsync 后 `os.replace` 原子发布；并发调用不再截断共享文件。
- subagent 与 reload 脚本都忽略 glob 之后已被删除的 marker。

**真实启动探针失败，按返工简报 P1-1 停止，未放宽规则。** 本次使用真实 HOME 生成 deny/allow 路径，仅把子进程 HOME/DSH_HOME/TMPDIR 放到临时目录；未读取生产凭据、未调用模型或真实服务。真实安装的 DSH 分别执行 `--dump-config` 和 headless `--help`，均 exit 1：

```text
Error: EPERM: operation not permitted, lstat '/Users/yanghongming/.openmausbot'
at Object.realpathSync (node:fs:2760:29)
at toRealPath (node:internal/modules/helpers:65:13)
```

祖先目录的 metadata 检查仍受整个目录的 `file-read*` deny 约束，放行后代 `tools/npm` 不足以让 Node 的入口路径解析通过。此处没有自行放行祖先 metadata、删 deny 或扩大安装目录例外。

上轮成功的配置加载探针使用合成 HOME 生成沙箱；真实安装路径当时不在该合成 HOME 的 deny 内，不能替代本次“真实安装 + 真实 HOME 规则”的交叉检查。上文历史结果保留为原探针记录。

证据：`.agent/c3-review-red.log`、`.agent/c3-review-green.log`、`.agent/c3-review-step0.json`（均不提交）。步骤 0 原始输出目录由 JSON 的 `root` 字段记录。`READER_VERIFIED=False` 保持不变。触发停止条件时 HEAD 是 `4579d7ae5e8a5400e6219cd6341d3570fcd02b79`，当时未启动全量验收或提交。

BINI 后续要求先交边界简述，并完成独立修复的验证和新增提交；这不表示 P1-1 的真实启动问题已关闭。边界简述：`/Users/yanghongming/Projects/TeamAgent-c3-sandbox-boundary-20261113.md`。不放宽当前 deny，不推送或部署，等待架构师修订规则后再收尾。
