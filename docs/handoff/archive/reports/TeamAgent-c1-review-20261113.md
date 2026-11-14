# C1 仓库索引复核（0fb46dc / gitsafe 6e047a3）

结论：打回（P1 ×2；P2 ×5）。
测试：临时副本（含 `.agent`）`node --test test/repo.test.mjs` 18/18；`python3 -m unittest test.gitsafe_test test.repo_index_test` 23/23；另跑 gitsafe `core.sshCommand` 探针、敏感 patch 探针。

P1-1（已复现）`runner/gitsafe.py:18,89`：`fetch` 继承 repo-local `core.sshCommand`。临时 repo 设 `origin ssh://localhost/nonexistent` + `core.sshCommand='touch /tmp/gitsafe-pwn-$$; false'`，`gitsafe.run(root,'lifecycle','fetch','--prune','origin')` 生成 `/tmp/gitsafe-pwn-*`（PWNED）——恶意仓库配置可执行命令。修法：`-c core.sshCommand=`、`-c credential.helper=`、`protocol.ext.allow=never`（或受控 `GIT_SSH_COMMAND`），加回归。
P1-2（代码可证）`src/semantic.ts:1235-1240`：`repo_changes`/`repo_commit` 的 tool 消息仅 `JSON.stringify`，未 `untrusted()`；`repo_commit` 的 `untrusted:true` 字段不算（方案 R9）。提交 subject/body/patch 可注入。修法：repo 结果与失败统一 `untrusted()`。
P2-1 `runner/repo_index.py:54,164`：denied 文件（`.env` 等）仍以 `path+hidden` 上传；patch 已排除。若“不上传”要连 path 一起去掉；R4 测试当前只断 path。
P2-2 `runner/repo_index.py:43-52`：`_load_known` 读 `worker-secrets.json`/`secrets/bili-cookie.json` 的值；实现报告“未读真实 .env、Cookie”与代码不符；值仅内存 redact、未上传。
P2-3 `runner/gitsafe.py:18`：`safe.directory=*` 放宽 ownership；P2。
P2-4 `runner/repo_index.py:79`：`_default_ref` 依赖 `refs/remotes/origin/HEAD`，缺失时 `build/sync` 抛错、索引不前进；P2。
P2-5 `runner/gitsafe.py:35-50`：read 允许 `diff --no-index`、`config --get include.path`、`cat-file --batch`；内部调用固定，但白名单本身可越 repo 读文件；P2。
未验收：真实 D1 远端迁移、真实 GITHUB_TOKEN/群、Windows runner；未跑完整 550（C1 的 repo.test 18/18、Python 23/23 已复跑）。

---

# C1 返工复核（5b07417，2026-11-13 02:05）

结论：通过（2 P1 已关闭；5 P2 中 4 关闭，P2-1 符合方案原文；新增 1 P2）。
测试：临时副本（含 `.agent`）`node --test test/repo.test.mjs` 20/20；`python3 -m unittest test.gitsafe_test test.repo_index_test` 30/30；`core.sshCommand` 探针 NO_PWN；credential/ext 单测通过。
P1-1 关：`gitsafe.py:21-25` PREFIX 固定 `core.sshCommand=/usr/bin/ssh -F /dev/null …`、`credential.helper=`、`core.askPass=`、`protocol.ext.allow=never`；`:104 safe.directory=<root canonical>`；`SSH_ASKPASS`/`GIT_SSH_COMMAND` 清掉；探针未生成 marker。
P1-2 关：`semantic.ts:1237-1239` 把 `repo_changes`/`repo_commit` 纳入 `read_web` 的 `untrusted()` 分支；`repo.test` 覆盖 success/invalid/denied/exception，伪造结束标记被转义。
P2-2 关：`_load_known` 删除，不再读 `worker-secrets.json`/`bili-cookie.json`；但 `redact` 现在只有正则（方案 K2 要求“正则+已知密钥值”），runnerToken/cookie 值若出现在提交里不再被替换——新增 P2，建议只传已知值清单或补正则，不读 cookie 文件。
P2-3 关：`safe.directory` 只信当前 root；P2-4 关：`origin/HEAD` 缺失回退 `origin/main`/`origin/master`；P2-5 关：`diff --no-index`/`--no-ind`、`config include.*`、`cat-file --batch*` 在 spawn 前 `GitDenied`，测试覆盖。
P2-1 说明：方案 K2/C1/R-4（line 413）原文要求 DENY 文件“`files` 里保留 `path+hidden`、payload 搜不到内容”；当前代码正是 path+hidden、patch 排除，符合原文，不算缺陷。
未验收：真实 D1 远端迁移、GITHUB_TOKEN/群、Windows runner；未跑完整 550。

---

# C1 redact 小修复复核（8e647e9，2026-11-13 02:10）

结论：通过（上次新增 P2 已关闭；另记 2 条 P2）。
测试：临时副本（含 `.agent`）`node --test test/repo.test.mjs` 20/20；`python3 -m unittest test.gitsafe_test test.repo_index_test` 34/34；合成 known 值探针 subject/body/patch 均无 known、出现 `[REDACTED]`；token/cookie 探针全 `[REDACTED]`。
① 调用方 `known_values` 经 `sync_once/build/commit_record` 贯穿 author/subject/body/patch，最长优先、`re.escape`、字面替换；② `PATTERN`+`TOKEN_PATTERN` 覆盖 JWT、Bearer、Cookie/Set-Cookie/Authorization、runnerToken/access_token/api_key/client_secret/SESSDATA 等；③ 先 `redact` 再 `cut_bytes`（`commit_record` 与 sync 测试的 guarded_cut），密钥不会被截断切开漏出；④ 无 `worker-secrets.json`/`bili-cookie.json`/`.env` 读取，`_load_known` 已删，只读 `config.json` 的 runnerToken 作已知值；⑤ 测试全绿。
P2-1 `TOKEN_PATTERN` 的 `sid/session/sessionid` 过宽：`const sid = 42; // normal code` → `const [REDACTED]; // normal code`（探针复现），正常代码被误脱敏；建议 `sid` 限定为引号/冒号后的值或去掉裸 `sid`。
P2-2 production `loop` 调 `sync_once(now)` 未传 cookie `known_values`，只加 config runnerToken；opaque cookie 值若出现在提交里只能靠 PATTERN，建议 loop 从 bridge 已有内存传入已知值（仍不读文件）。
未验收：真实 D1 远端、GITHUB_TOKEN/群、Windows；完整 550 未跑。

---

# C1 增量复核（e659698，2026-11-13 03:00）

结论：通过（无 P0/P1；2 P2）。
测试：`/usr/local/bin/python3` 3.12.3（`test/` 下 `PYTHONPATH=..:../runner`）37/37；`node --test test/repo.test.mjs` 22/22。
① fetch 隔离：middle repo 抛 `GitFailed`/`TimeoutError` 时，失败仓库 state 不推进、不进 batch、`_fetch_at` 保持、下一轮重试；健康仓库照常推进，日志只记异常类型。测试通过。
② `src/repo.ts`：author/path 有过滤时去掉 SQL LIMIT，过滤后再 `slice(limit)`；查询仍 `repo_state`+`repo_commits` 2 条，W-9 预算通过；`untrusted()` 包装未动。
③ patch：`_patch_paths` 用 `--raw -z` 的路径与 diff 段 `zip(strict=True)`，空格/中文空格/重命名均完整；denied 源跳过、脱敏在 cut 前。测试通过。
P2-1 `runner/repo_index.py:290` 只捕 `GitFailed`/`TimeoutError`；`gitsafe.run` 抛 `OSError`（git 缺失/权限）会冒泡，整轮 sync 中止、健康仓库本轮不报。建议同 except 加 `OSError` 或按 repo 包 try。
P2-2 `src/repo.ts:84` 带 author/path 时无 SQL LIMIT，最多扫 repo 内 500 条再 JS 过滤；当前上限内可接受，记录。
未验收：真实 D1 远端、GITHUB_TOKEN/群；未跑完整 550。

---

# C1 followup 复核（e89d777，2026-11-13 06:10）

结论：通过（无 P0/P1；2 P2）。
测试：`/usr/local/bin/python3` 3.12.3（`test/` 下 `PYTHONPATH=..:../runner`）`repo_index_test`+`gitsafe_test` **68/68**；Node `test/repo.test.mjs` 因该 worktree 无 `node_modules` 未能复跑（环境，不是断言失败）。
① sid/session：`const sid = 42;` 不变；`{"session":"<40 字符>"}`、`sid=<40>`、`session=<40>`、`sid = "<40>"` 均 `[REDACTED]`；但 `{"session":"<含 + / = 的 base64>"}` 未命中（P2）。
② OSError：`repo_index.py:319` 的 fetch except 含 `OSError`，`test_followup_git_oserror_before_fetch_or_during_build_isolated` 通过；失败仓库不推进，健康仓库继续。
③ color：`color.diff=false`、`--ignore-submodules=all`；byte-cap 测试确认 killpg、1.8s 内返回、后代 marker 不存在，均过。
④ gitsafe 两处覆盖：`test_review_byte_cap_cleanup_kills_descendants_holding_stdout`、`test_followup_timeout_kills_git_and_credential_helper_descendants` 均过。
⑤ filter.*：`repo_index.py:252` 写 `skipReason='filters_configured'`，`src/repo.ts:91` 输出“已跳过：仓库配置了过滤器”；Node 用例未跑（同上）。
⑥ 无新增 Cookie/密钥读取：grep 无 `worker-secrets`/`bili-cookie`/`.env`；`sync_once` 只读 `config.json` 的 runnerToken；Python 测试覆盖。
P2-1 `runner/repo_index.py:34` 的 sid/session 值字符集不含 base64 的 `+`/`/`/`=`，这类长值仍不脱敏；建议引号值整体匹配或扩字符集。
P2-2 C1 followup worktree 无 `node_modules`，`node --test test/repo.test.mjs` 直接 `ERR_MODULE_NOT_FOUND`；需在带依赖的检出复跑 Node 2 条新用例。
未验收：真实 D1/群、Windows；完整 556 未在本 worktree 跑。
