# C1 PR #23 复审：04ba059（父 a676a24）

结论：打回（不通过；P1 1 条、P2 4 条）。上一轮 P1（source-local http.proxy/sslVerify 外带凭据）和 P2（脱敏误伤）已关闭；但新 fetch 在本机仍无法同步私有 HTTPS 仓库。

## 测试

- `/usr/local/bin/python3` 3.12.3：全量 Python **96/96**；`gitsafe_test` + `repo_index_test` **43/43**。
- 真实私有仓库副本（`~/.inkboard-team/repos/TeamAgent`，`gh repo view` 确认 `isPrivate:true`）：`gitsafe.run(root,'lifecycle','fetch','--prune','origin')` → `GitFailed`；`gitsafe._credential_helpers(env)` → `[]`；`git -c credential.helper=osxkeychain ls-remote https://github.com/OmnixSI/TeamAgent.git HEAD` → rc 0；把 helper 手工注入 `['-c','credential.helper=osxkeychain']` 后 fetch → ok，refs 3→10。
- 本地 MITM：源 repo 的 `http.proxy`、`http.<url>.proxy`、`sslVerify=false`、`sslCAInfo`、`extraHeader`、`url.insteadOf`、`credential.<url>.helper`、`include` 全部不再把 Authorization 送到 attacker（0 连接）。
- 引用同步探针：新增分支/tag 同步；远端删除分支被裁剪；失败 fetch 不改任何 ref；HEAD/工作区不动；临时目录 0 残留。移动/删除 tag 不更新（与旧 fetch 行为一致）。
- P2 脱敏：`{"key":"a"}`、`hotkeys`、`monkey`、`tokenizer` 不再收集；adminToken/runnerToken/sourceKey 仍脱敏。

## P1（已用真实私有仓库复现）

`runner/gitsafe.py:109-124,193`

- `_credential_helpers` 只跑 `git config --system` 和 `--global`。本机 Apple Git 的 system helper 在 `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig`（`credential.helper=osxkeychain`），但 `git config --system` 实际只读 `/etc/gitconfig`：`git config --system --get-regexp '^credential(\..*)?\.helper$'` → rc 1、空输出；`_credential_helpers` 返回 `[]`。
- fetch 的 `PREFIX` 先 `credential.helper=` 清空，之后没有可重放的 helper；私有仓库返回 401，`sync_once` 每轮 catch 后 `continue`，该仓库永远不会被索引。
- 复现：
  1. `cp -a ~/.inkboard-team/repos/TeamAgent /tmp/real-fetch/repo`
  2. `gitsafe._credential_helpers(env)` → `[]`
  3. `gitsafe.run('/tmp/real-fetch/repo','lifecycle','fetch','--prune','origin')` → `GitFailed`，stderr `could not read Username for 'https://github.com'`
  4. `git -c credential.helper=osxkeychain ls-remote https://github.com/OmnixSI/TeamAgent.git HEAD` → rc 0
  5. monkeypatch `_credential_helpers` → `['-c','credential.helper=osxkeychain']`，同一 fetch → ok（refs 3→10）
- 修法：从 `git config --list --show-origin --show-scope` 取 `system` scope（或显式读 `$(git --exec-path)/../../share/git-core/gitconfig`），不要只信 `git config --system`；补一个真实 system helper 的回归，不能只 mock `--system`。

## P2

- `runner/gitsafe.py:168-171`：固定 `http.proxy=`、`http.sslVerify=true`、`http.extraHeader=` 后，system/global 的可信代理、私有 CA、额外头不再被使用；只剩 `https_proxy` 等环境变量可用。本机当前无 proxy/CA，暂不阻塞。
- `runner/gitsafe.py:168`：固定 `remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*`，忽略源 repo 的自定义 refspec；`--prune` 会删掉如 `refs/remotes/origin/pr/*` 的自定义远程跟踪 ref。默认 clone 不受影响。
- `runner/repo_index.py:36-38,76,80`：精确白名单不含通用 `token`/`secret`/`privateKey`/`credential`，且值 <16 不脱敏；生产 config 的 adminToken/runnerToken/sourceKey 已覆盖，暂不阻塞。
- `runner/gitsafe.py:115-116`：`_credential_helpers` 以 `cwd=HOME` 跑 `git config --global --includes`，`includeIf "gitdir:..."` 里的 helper 不会命中；多账号/按 repo 配 helper 的环境会漏。

## 已关闭

- 上一轮 P1：源 repo 的 `http.proxy`/`http.<url>.proxy`/`sslVerify`/`sslCAInfo`/`extraHeader`/`url.insteadOf`/`credential.<url>.helper`/`include` 不再影响临时裸仓库的 fetch；本地 MITM 0 连接；新增 `attacks` 测试覆盖。
- 上一轮 P2：精确键名 + ≥16 字符，`{"key":"a"}`/hotkeys 不误伤；adminToken/runnerToken/sourceKey 仍脱敏。
- 失败回滚/工作区/临时目录：探针通过。

## 未验收/备注

- 真实私有仓库同步在本机仍失败（上述 P1）；修好 Apple system helper 发现后需重跑。
- 新增 tag 能同步；远端移动/删除 tag 不更新（旧 fetch 也如此）。
- `sync_once` 当前串行，未做真实多线程压测；CAS + 临时目录设计上可并发。
- worktree 未改（仅未跟踪 `.agent/`）。
