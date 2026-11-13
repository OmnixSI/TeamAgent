# C3 本机只读调查 runner（尚未接入 Worker）

> 当前状态（V-B / B-0）：临时 HOME 下真实 DSH 配置转储、帮助启动通过；原生模型探针在请求前以 `MISSING_CREDENTIAL` 退出，实际模型调用 0 次。真实工具/read 事件未通过，`READER_VERIFIED=False`，本版采用方案 B。逐项结论见文末 B-0；下列 v1.3/v1.4/v1.5 是历史记录。

> v1.5 后续修复：仅给 `/dev/null` 增加 literal 写例外，读规则与六读根未改；见文末“空设备写例外”。

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
| 模型返回的真实工具表、未知工具探针、README read 事件 | **不通过（B-0）**：`MISSING_CREDENTIAL`，没有产生模型工具事件；配置转储不能替代 |
| 原生空文件/空白文件事件 S-26(g)(h) | **不通过（B-0）**：同一凭据前置条件阻断，没有原生 read 事件；未添加手工夹具 |
| 网络仅 TCP 443 + DNS | 规则已生成；**真实模型连通性不通过验证（B-0）**：请求前即缺凭据，不能推断网络是否可达 |

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

## v1.4：原文规则与真实读根行为冲突（未提交）

本轮以 `cb949f0c503261acf6797015e2644ad6593725de` 为父版本，按 v1.4 增加 `install_root/sandbox_roots/SENSITIVE/SandboxUnsafe/repo_git_clean`，生成唯一 HOME `file-read-data` deny、5 个目录读根及 1 个 literal 配置读根；不再使用敏感文件名列表或正则生成 .sb。子进程 TMPDIR 移到临时 HOME 的 `tmp/`（0700）。读根覆盖 HOME 或已知凭据、remote URL 内含用户名/密码、或存在 extraheader 时，在 Popen 前拒绝为 `runner_unsupported`。

测试先红（51 项、15 个错误），再实现。S-27 精确正文/顺序（含无 Node 读根）、S-28 不安全读根、S-29 安装前缀、S-30 remote 凭据拦截，单独运行 **4/4 通过**。所有本机测试运行 **51 项、0 skip，8 个失败断言、1 个错误**：HOME 内合法读根无法读，导致 S-3/正常 read/symlink 对照和假 DSH 成功案例失败；假 DSH 环境测试因没有成功答案而出现 JSONDecodeError。未放宽这些断言，没有把失败改成跳过。

### 最小复现（与项目封装无关）

在系统 TMPDIR 建合成 HOME `T`，其中 `T/allowed/ok.txt` 是普通合成文本；直接执行下列方案同款规则：

```scheme
(version 1)
(allow default)
(deny file-read-data (subpath "<T>"))
(allow file-read* (subpath "<T>/allowed"))
```

实际结果：`cat T/allowed/ok.txt` **exit 1 / Operation not permitted**，`stat T` exit 0，`ls T` exit 1。S-27 证明实现正文与方案相同；不能凭“后写规则生效”的假设认定目录内容已被放行。未另试更宽规则，也未增加任何读根。

### 步骤 0：真实 HOME、真实安装

子进程只用临时 HOME/DSH_HOME/TMPDIR 与合成仓库，生产凭据不在环境中，模型调用 0 次：

- 对 SENSITIVE 的 **12 项**逐一在沙箱内 `cat`：均 exit 1；stdout/stderr 全部丢弃，只记录路径与退出码，无凭据内容进入终端或日志。
- 按方案创建 4 个独占、0600、随机金丝雀：OS `cat` 全部 exit 1，finally 已删除全部本轮新文件；未覆盖已有文件。
- 对真实 `.openmausbot`、`.openmausbot/tools`、H 做 stat：3 项均 exit 0；对真实 `.openmausbot`、H、HOME 做 ls：3 项均 exit 1。
- 临时 worktree 的符号链接指向 HOME 内金丝雀：OS `cat` exit 1。DSH 层金丝雀/symlink 的 read 事件未运行，因为入口已被拒；不能用 OS 结果冒充 tool_result。
- `repo_git_clean` 对合成仓库和当前项目 worktree 均为 True。
- 同一 .sb 下真实 DSH 的 `--dump-config` 和 `--help` **均 exit 1**，`open/readFileSync` 的 EPERM 路径是 `/Users/yanghongming/.openmausbot/tools/npm/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`；该文件已在读根 1 中。祖先 lstat 不再是此次报错位置。

证据：`.agent/c3-v14-red.log`、`.agent/c3-v14-current.log`、`.agent/c3-v14-minimal.json`、`.agent/c3-v14-step0.json`，均不提交。后两个 JSON 的 `root` 定位仅含合成数据/启动诊断的临时文件。真实凭据探针从未保存输出。

依据“方案与代码对不上停下交回”及 v1.4 失败处理，保留 `READER_VERIFIED=False` 和方案 B；未移除 HOME deny、未新增读根、未改放行操作类型、未运行干净 worktree 六项验收、未新增提交、未 push/部署。需要架构师确认 SBPL 中具体操作 `file-read-data` 与操作族 `file-read*` 的优先级，以及如何使既定读根的允许内容读取实际生效；是否要使用同操作类型逐根放行，由方案决定，本轮未自行实现或试验。

## v1.5：选择 W1，真实 DSH 启动恢复，工具事件仍待验

本批父提交为 `cb949f0c503261acf6797015e2644ad6593725de`，包含上轮未提交的 v1.4 读根计算、自检、remote 凭据检查与临时 HOME/TMPDIR 实现，并按 v1.5 替换读规则。生产代码只实现 W1，没有 W2/W3 开关或候补分支：单条 `deny file-read-data`，`require-all` 内限定真实 HOME，并用 `require-not` 逐项排除 5 个目录读根与 1 个 literal 配置读根。未新增/扩大读根，未使用 `allow file-read*`。

### 先跑的独立 SBPL 语义矩阵

系统 TMPDIR 下的合成 T 全部经 realpath；使用随机合成文本、literal 配置对照、子目录、上跳路径和指向拒读文件的符号链接，无生产数据。脚本 `.agent/c3-v15-matrix.py`，逐命令退出码与完整规则 `.agent/c3-v15-matrix.json`，均不提交。

| 写法 | m1 合法内容 | m2 私密/上跳 | m3 symlink | m4 stat | m5a HOME 列表 | m5b 读根列表 | m6 xattr | m7 编译 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0 v1.4 原文（诊断） | 失败 | 符合拒绝 | 符合拒绝 | 通过 | 符合拒绝 | 失败 | exit 1，只记录 | 通过 |
| M1/W1 | 通过 | 符合拒绝 | 符合拒绝 | 通过 | 符合拒绝 | 通过 | exit 1，只记录 | 通过 |
| M2/W2 | 通过 | 符合拒绝 | 符合拒绝 | 通过 | 符合拒绝 | 通过 | exit 1，只记录 | 通过 |
| M3/W3 | 通过 | 符合拒绝 | 符合拒绝 | 通过 | 符合拒绝 | 通过 | exit 1，符合拒绝 | 通过 |
| M4 allow 操作族移到前面（诊断） | 失败 | 符合拒绝 | 符合拒绝 | 通过 | 符合拒绝 | 失败 | exit 1，只记录 | 通过 |

W1 是按 W1→W2→W3 顺序第一个通过矩阵、S-3/S-27–S-31、OS 凭据边界及真实 DSH 启动检查的写法，因此仅接入 W1；不声称它已经通过尚未运行的真实模型工具事件。

### 测试与字符串边界

更新 S-3 加深层文件、合法读根列目录、敏感文件 stat 与上跳拒绝；更新 S-27 逐行比对 W1、缺 Node 的少一行情况，全文不得出现 `allow file-read*`。S-28 对读根、HOME、sub、系统 TMPDIR、临时 HOME 的原始/解析后路径拒绝双引号、反斜杠、换行和 NUL；正常 symlink 解析为真实目录。S-29 安装前缀和 S-30 remote/extraheader 拦截保留。新增 S-31 把 W1 的 m1–m7 作为真沙箱回归，从 `/var/folders/...` 别名调用 `sandbox_roots`，确认输出为 `/private/var/folders/...` 并实际读写边界成立。

v1.5 测试先红（53 项、13 个失败断言、2 个错误），实现 W1 和路径检查后 **53/53 通过、0 skip**。S-3/S-30/S-31 在运行前先探测嵌套 sandbox；本次宿主机无探测失败，未借 skip 掩盖问题。M0/M4 不进入回归测试。

### 第 0 步实测（真实 HOME 策略、真实安装，无生产 key）

- DSH 安装读根为 `/Users/yanghongming/.openmausbot/tools/npm`；Node 读根为 realpath `/opt/homebrew/Cellar/node/26.0.0`，其余读根仅合成仓库 `.git`、本次 worktree、临时 HOME 和专用 reader patch。
- 同一 W1 .sb 下，真实 DSH `--dump-config`、headless `--help` 均 **exit 0，stderr 无 EPERM，报错路径为空**。没有临时增加读根或改动网络规则。
- SENSITIVE 的 **12 项**真实路径 `cat` 均 exit 1，stdout/stderr 均丢弃，只记退出码；4 个独占 0600 金丝雀的 OS `cat` 均 exit 1，finally 已清理。
- 真实 `.openmausbot`、`.openmausbot/tools`、H 的 stat 均 exit 0；真实 HOME、`.openmausbot`、H 的 ls 均 exit 1；worktree 指向 HOME 金丝雀的 symlink OS `cat` exit 1。
- `repo_git_clean` 对当前项目为 True。
- **未完成项**：模型返回工具表、未知工具探针、真实 read tool_result、DSH 层金丝雀与 symlink read 事件、S-26(g)(h) 原生结果。尝试仅在 localhost:443 启动合成 Messages 端点以避免生产凭据，但绑定端口得到 `PermissionError`，请求数为 0；未改网络端口/策略，未尝试生产 key，不把合成 OS 检查算作模型事件。

证据：`.agent/c3-v15-startup.json`、`.agent/c3-v15-step0.json`、`.agent/c3-v15-native-read.json`；JSON 中的 `root` 定位临时输出，真实凭据探针无任何内容日志。根据“第 0 步全过才能启用”的约定，`READER_VERIFIED=False` 保持不变；当前方案 B 仍负责确定性搜读，Worker/bridge 接入与真实模型验收继续留待后续，不推送或部署。

宿主机最终验证（本机 Python 3.14.5，满足项目 ≥3.12）：`npm run check`、`npm test`、`npm run test:runner`、`npm test --prefix clients`、`npm run check:ui`、`npm run config:check` 全部 exit 0；主测试 464、Python 112（原基线 53 + 共享 gitsafe 6 + C3 53）、Node fetcher 51、clients 2，共 629 项，0 skip；`git diff --check` 干净。相对 cb949f0 本批新增 8 项 C3 测试。日志 `.agent/c3-v15-{check,test,runner,clients,ui,config}.log` 不提交。

## 空设备写例外（父提交 aa248225）

按 BINI 拍板，在全局 `deny file-write*` 后只加 `(allow file-write* (literal "/dev/null"))`。未增加任何其他设备或目录；W1 读规则、六个读根与 HOME 内容拒读全部保持原样。用相同路径重新生成新旧 .sb，读规则部分逐字一致。

测试先行：S-27 的逐行期望增加这一行；S-31 增加真实沙箱下读取合成合法文件并重定向至 `/dev/null` 的正例，以及在写根以外新建、截断合成文件均被拒的反例。测试的系统 TMPDIR 单独放在合成 HOME 之外，避免 TMPDIR 写例外意外罩住整个合成 HOME，使反例有效。修复前两项测试均失败，其中真实重定向明确报 `/dev/null: Operation not permitted`；修复后全部通过，原文件内容未被覆盖。

复核 P2-1 的重跑：修改前宿主机 Python 3.14.5 下 `subagent_test.py` 为 **53/53，0 skip**，没有复现报告中的 1 failure/1 error。报告没有附这两项堆栈，本次不猜测它们与 `/dev/null` 或解释器的因果关系，也未为未复现的问题更改无关代码。修改后再次 **53/53，0 skip**。本次扩充既有 S-27/S-31，没有新增测试函数。

完整宿主机回归：check、主测试、Python/Node runner、clients、check:ui、config:check 均 exit 0；计数维持 **464 + 112 + 51 + 2 = 629**，无跳过；`git diff --check` 干净。真实 DSH 配置转储仍 **exit 0，stderr 无 EPERM**，没有报错路径；`READER_VERIFIED=False`、方案 B 不变。真实模型工具事件仍未验收，未推送或部署。

证据均不提交：`.agent/c3-devnull-baseline.log`、`c3-devnull-red.log`、`c3-devnull-green.log`、`c3-devnull-{check,test,runner,clients,ui,config}.log`、`c3-devnull-dsh.json`。最后的 JSON 同时记录读规则一致性和 DSH 启动结果。


## V-B / B-0：隔离 HOME 的真实模型探针未通过

2026-11-13（悉尼时间），基于 `df11aa2`，真实安装的 DSH、既有 W1 沙箱及原样 reader patch；未改变读根、网络规则或权限模式。仅生成临时 HOME / DSH_HOME、合成 git 仓库、README、空文件、空白文件与仓库外合成 canary / symlink。没有读取真实凭据文件，也没有调用 `runner.settings.api_key()`。启动环境没有可继承的 `DEEPSEEK_API_KEY`；headless 合成配置中的 `credentials` 与 `deepseek-account` 均禁用，不能假设它会自动读取桌面端已有凭据。

| 本次探针项 | 结论与证据 |
| --- | --- |
| 真实 DSH 配置转储 | 通过：exit 0，stderr 0 字节；只读 patch 组合成功 |
| 真实 DSH headless 帮助启动 | 通过：exit 0，stderr 0 字节 |
| fs 包版本 | 通过：安装包元数据为 `0.2.2-rc.1` |
| 模型实际工具表 | 不通过：模型请求前 `MISSING_CREDENTIAL`；没有工具表，不能把插件配置当实际工具表 |
| 未知工具 `b0_unknown_tool` 拒绝 | 不通过：同一凭据前置条件阻断，未产生 tool_call / tool_result；不推断拒绝行为 |
| `README.md` 原生 read | 不通过：同上，没有 read 证据 |
| S-26(g) 空文件原生 read | 不通过：同上，没有原生空文件事件，不加入夹具 |
| S-26(h) 空白文件原生 read | 不通过：同上，没有原生空白文件事件，不加入夹具 |
| 仓库外 canary / symlink 原生 read | 不通过：同上，未执行到工具阶段；不能用已有 OS 沙箱测试代替 DSH 事件 |
| 真实模型网络连通性 | 不通过验证：没有发起模型请求，不能判断连接成败 |
| 临时目录与沙箱清理 | 通过：两个探针临时根目录与生成的 `.sb` 均已删除；无后台进程 |

原生任务只启动 1 次 DSH，exit 1；stdout 仅有 session、4 条 status、final，final.reason.kind 为 `error`、error.code 为 `MISSING_CREDENTIAL`、text 为空，stderr 同样报告缺失 `deepseek-official` API key。实际模型请求 **0 / 10 次**；配置/帮助转储不调用模型。没有为了获取事件而放开真实 HOME 或改用合成服务冒充真实模型。

结论：本次启用门槛不通过，保持 `READER_VERIFIED=False`，V-B 使用方案 B。若后续重跑，需要由安全启动环境向临时 HOME 内 DSH 提供既有 key，仅由 DSH 使用，且继续遵守不读真实凭据的限制；本包不修改凭据加载路径。

证据（不提交）：包 worktree 的 `.agent/B-0-{startup,native-result}.json`、`B-0-{config,help}.txt`、`B-0-native-stdout.jsonl`、`B-0-native-stderr.txt`。这些报告只包含合成环境信息和缺凭据错误。相关基线 `subagent_test.py` 为 54 项通过、0 skip；最终全量结果记录于下文。

最终验证：`npm run check && npm test && npm run test:runner` 整链 exit 0；主测试 **739/739**，Python runner **204 项、0 失败、1 skip**，Node runner **61/61**。唯一跳过项为既有可选 `XasrChunks.test_R12_real_chinese_english_and_multichunk`（未设置 `XASR_REAL_TEST=1`，需显式提供真实音频样本），与 B-0 无关；未开启或改写该测试。`git diff --check` 通过。没有功能实现变更，故未新增红绿单测；没有真实 read 事件，故未补原生事件夹具。
