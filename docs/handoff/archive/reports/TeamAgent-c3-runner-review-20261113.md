结论：打回（P1 2 条；P2 3 条）

测试：`npm run check` 0；`npm test` 464/464；`npm run check:ui` 0；`gitsafe_test.py` 6/6；`subagent_test.py` 40 项 34 过 6 败——6 项均因复核容器外层 sandbox 拦嵌套 `sandbox-exec`（`sandbox_apply: Operation not permitted`）或 `ps`（EPERM），非断言回归，作者 `.agent` 日志 99/99 未独立复跑；另用合成 HOME 生成 `.sb` 复现下面两条 P1；`body_chars/read_evidence` 的空文件、纯空白、BOM/零宽、合法数字开头、绝对路径越界用例均符合方案。

问题：
- P1 安全 `runner/subagent.py:478-482`：只把 `~/.openmausbot` 的一级子目录写进 deny；实机一级还有 0600 的 `bots.json`、`bot-api.json`、`browser-engine-key`、`config.json`，这些在 `(allow default)` 下没有 deny 规则，`read` 走绝对路径即可读（已用合成 HOME 生成 profile 复现“无 deny 行”；真实读取因复核环境 EPERM 未跑，属规则推演）。同类漏项：`~/.dsh/.credentials.yaml`（0600）、`~/.inkboard-team/qq-session.json`。后果：仓库/问题里的注入内容可让子代理读凭据并写进 answer，`scrub` 只覆盖已知 key 和正则。修法：整目录 deny `~/.openmausbot` 后再 allow `tools/npm`；补 `.dsh/.credentials.yaml`、`qq-session.json` 和浏览器 profile，或改成只 allow 工作区 + DSH 安装目录的读白名单。
- P1 功能 `runner/subagent.py:483`：`H/.*(?i:cookie|bili|x-).*` 对 `H` 下任意深度匹配，合法工作区文件 `src/prefix-sum.ts`、`box-shadow.css`、`bilingual.md` 都会命中（已用生成的正则复现）；DSH 启用后这些文件读不到，核心看代码能力失效。修法：只匹配 `H` 一级目录/文件名，另加 `(subpath H/browser)` 与 `(subpath H/x-browser)`；去掉递归的 `x-`/`bili`。
- P2 证据边界 `runner/subagent.py:403-421`：`file_path` 以 `~` 开头时 `sub / raw` 不展开，`~/notes.txt` 会被当成 `sub/~/notes.txt` 计入证据（已用合成事件复现：返回 `['~/notes.txt']`，实际 `sub/~/notes.txt` 不存在）；DSH 的 fs 会把 `~` 展开到临时 HOME，因此读一个 HOME 文件也能让 `classify_events` 判 done。修法：`~` 一律视为工作区外，或从 `tool_result` 的 `<path>` 取实际绝对路径再判。
- P2 并发 `runner/subagent.py:448-450,560-562`：`reader_profile()` 每次 execute 都用 `O_TRUNC` 重写共享 `H/dsh-reader.yml`；并发 2 时第二个进程可能截断第一个 DSH 正在读的 patch，导致启动失败或关闭项未套用（未复现，推断）。修法：启动时写一次，或 tmp + `os.replace`。
- P2 重载 `runner/subagent.py:470-471`、`runner/reload_runtime.py:6-7`：`glob` 与 `stat` 之间 marker 被 cleanup 删除会抛 `FileNotFoundError`，重载脚本中断（未复现，推断）。修法：逐个 `try/except FileNotFoundError`。

备注：① 的真实工具表/未知工具探针与 S-26(g)(h) 原生事件仍未跑（docs:30-31）；`dsh-reader.yml` 与方案逐行一致、0600，`READER_VERIFIED=False` 保持方案 B 是对的，第 0 步四项未过前不要翻 True。方案 B 的 `search_read` 目前返回 `status:'done'` + 原始材料（:239-242），Worker 接入时必须转 research，不能直接 `deliverSubagent`。

---

# C3 v1.5 沙箱复核（aa24822，2026-11-13 02:45）

结论：打回（P1 1 条；P2 2 条）。
测试：danger-full-access 下真实 `sandbox-exec`；最小 `(allow default)` 正常；W1 无重定向探针：`stat ~/.zshrc` 0、`cat ~/.zshrc` 1、`stat ~/.ssh` 0、`ls ~/.ssh` 1；六个读根（DSH/Node/sub/.git/temp HOME/reader）`cat` 全 0；`subagent_test` 53 项 0 skip、1 failure/1 error。
P1 `runner/subagent.py:570-575`：`(deny file-write* (subpath "/"))` 后只 allow sub/TMPDIR/home，未放行 `/dev/null`；`cat ~/.zshrc >/dev/null` → `/dev/null: Operation not permitted`。修法：`(allow file-write* (literal "/dev/null"))`（或 file-write-data），S-31 加入重定向用例。
P2-1：本机 `subagent_test` 53 项 0 skip 但 1 failure/1 error；作者 53/53 未独立复现，与 `/dev/null`/环境有关，需宿主复跑。
P2-2：W1 其余符合：无 `allow file-read*`、HOME 内容/列目录拒绝、stat 放行、读根仅 6 个、路径 realpath；`READER_VERIFIED=False`；上轮 P2（~、reader patch、marker）测试全过。
未验收：真实模型工具事件、S-26(g)(h)、完整 629。

---

# C3 /dev/null 修复复核（bb92f8b，2026-11-13 02:50）

结论：通过（P1 已关闭；P2 1 条）。
`git diff aa248225..bb92f8b` 仅 `runner/subagent.py`、`test/subagent_test.py`、`docs/c3-runner.md`；生产 diff 只加 `(allow file-write* (literal "/dev/null"))`，W1 读规则、六读根、HOME deny 未改。
真沙箱（danger-full-access）：`cat ~/.zshrc >/dev/null` → `cat: /Users/…/.zshrc: Operation not permitted`（读拒绝，不再是 `/dev/null` 写错误）；读根 `sub/ok.txt >/dev/null` → 0；写 repo 外 `blocked-new.txt` → 1；`.sb` 无 `allow file-read*`。
`subagent_test`：Python 3.9.6 下 53 项 0 skip，仍是 1 failure/1 error（与上轮同）：ERROR `test_report_409_is_fenced_and_network_retry_uses_same_lease`（3.9 `HTTPError.close()` → `tempfile KeyError: 'file'`）；FAIL `test_S7_heartbeat_conflict_fences_process_and_suppresses_report`（`execute` 返回 done 而非 None，heartbeat/进程时序）。
P2：作者 3.14.5 为 53/53，项目要求 ≥3.12；本机 3.9.6 低于要求，两项非本次 `/dev/null` 修复引入。建议用 3.12+ 复跑；若 CI 也跑 3.9，需修 `HTTPError.close` 与 fencing 兼容。
未验收：真实模型工具事件、S-26(g)(h)、完整 629。
