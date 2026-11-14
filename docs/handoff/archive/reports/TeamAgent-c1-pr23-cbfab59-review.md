# C1 PR #23 第三次复审：cbfab59（父 04ba059）

结论：通过（无 P0/P1；P2 4 条）。前两轮的 P1 均已关闭；本次按修订方案改用 `git credential fill` 在临时空仓库解析 system/global helper，并用临时裸仓库隔离 fetch。

## 测试

- `/usr/local/bin/python3` 3.12.3：全量 Python **104/104**；`gitsafe_test` + `repo_index_test` **51/51**。
- V1 真实私有仓库（`~/.inkboard-team/repos/TeamAgent` 的副本，`isPrivate=true`）：`gitsafe.run(root,'lifecycle','fetch','--prune','origin')` → **成功，1.4s，refs 3→10**；未打印/保存任何令牌，未读写钥匙串文件。
- V2 生产同款 `github.com` HTTPS CONNECT 攻击：源仓库本地写入 `http.proxy`、`http.https://github.com.proxy`、`sslVerify=false`、`sslCAInfo`、`extraHeader`、`url.insteadOf`、`credential.helper`、`credential.https://github.com.helper`、`include.path`、`includeIf.gitdir`、`credential.useHttpPath`、`credential.username`、`core.fsmonitor`、`core.hooksPath`、`core.askPass`、`remote.origin.proxy`；fetch 成功，MITM 代理 **0 CONNECT / 0 Authorization**，evil marker 未生成。同一代理 + 合成 helper 正向对照：**2 CONNECT / 1 Authorization（仅合成凭据）**。
- 单测 T1 Apple system：加固 env 与普通 git 的 `credential.helper` 输出一致，且包含 Apple 内置 `osxkeychain`；加 `GIT_CONFIG_NOSYSTEM=1` 后不再包含。
- T2/T3/T4/T5/T6/T7/T8/T11/T12：global helper 端到端、全部本地攻击项、凭据不进 argv、credential fill 隔离、无凭据快速失败、ssh 不查 HTTP 凭据、预算、get-only、HTTPS CONNECT 攻击均通过。
- 引用同步 T9a–T9d：`refs/pull/*/head -> refs/remotes/origin/pr/*` 不被误删且更新；`^refs/heads/tmp` 生效；`../`、`.lock` 等非法条目跳过不失败；失败 fetch 不改源 refs；临时目录 0 残留。
- 脱敏 T10：adminToken/sourceKey/runnerToken、`token`/`secret`/`privateKey`/`credential` 均收集；`{"key":"a"}`、hotkeys、`tokenizer`、短值不误伤。

## P2

- `runner/gitsafe.py:168-171`：fetch 仍固定 `http.proxy=`、`http.sslVerify=true`、`http.extraHeader=`，system/global 的可信代理、私有 CA、额外头不生效；按方案这是 e659698 以来的既有边界，不算本次回归。空 `http.proxy=` 可能连 `https_proxy` 一起禁用（方案标注未实测），本机无 proxy/CA。
- `runner/gitsafe.py:115-116`：`credential fill` 以临时仓库为 `GIT_DIR`，global `includeIf "gitdir:..."`、`hasconfig:remote.*.url` 不会命中；多账号/按 repo 配 helper 会漏。方案已列为已知限制。
- `runner/repo_index.py:36-38,76,80`：白名单新增四名后仍不含 `credentials`（复数）/`accessKey`/`secretKey`/`passwd`/`auth`；生产 config 字段已覆盖，暂不阻塞。
- `runner/gitsafe.py:168-171`：自定义 refspec 已读取，但源仓库 `remote.origin.fetch` 若写在 `include.path` 不会被读到；若自定义目标恰为 `refs/remotes/origin/HEAD`，发布阶段 `update-ref` 会解引用源仓库的 symbolic ref，可能更新其目标或 CAS 失败。默认 clone 不触发。

## 已关闭

- 第一轮 P1：源仓库本地 `http.proxy`/`sslVerify`/`sslCAInfo`/`extraHeader`/`url.insteadOf`/`credential.<url>.helper`/`include`/`includeIf`/`fsmonitor`/`hooksPath` 均不再影响临时裸仓库的 fetch；V2 与 T3/T12 均为 0 Authorization。
- 第二轮 P1：Apple Git 内置 `osxkeychain` 不再被 `--system` 漏掉，真实私有仓库同步成功（V1）。
- 第二轮 P2：自定义 refspec 保留、负向生效、非法跳过（T9）；脱敏白名单补通用名（T10）；fetch 失败不改 refs；临时目录清理。
- 凭据不进 argv/日志/refspec：T4/T5/T11；一次性 helper 只收到 `get`，fetch 的 `FIXED_HELPER` 对 store/erase 直接退出。

## 未验收/备注

- 钥匙串锁定时 `osxkeychain` 的 `get` 可能弹解锁/允许访问对话框；本次 V1 1.4s 无弹窗，但锁定态未验证（方案 V3 记录项）。未读写钥匙串条目。
- `sync_once` 当前串行；CAS + 临时目录设计上可并发，但未做真实多线程压测。
- 远端移动/删除 tag 不更新（与旧 fetch 行为一致）；新增 tag 可同步。
- worktree 未改（仅未跟踪 `.agent/`）。
