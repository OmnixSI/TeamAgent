# F9-reader 重复 worktree 清理（2026-11-14 19:49 Sydney）

## 结论

`/Users/yanghongming/Projects/.worktrees/TeamAgent-F9-reader`（分支 `pkg/F9-reader`，tip `2c41b0c`）是 PR #57 的重复移植，4 个提交（85450cb、4859aa8、1a882dd、2c41b0c）已全部随 squash 进入 `origin/main` `bf0a2c3`，没有独有改动。

## 证据

- `git diff cc7efc3 2c41b0c | git patch-id --stable` = `c740c0f37dd5fea7fbc90ebc28176433a44bea9f`
- `git diff 5122f3f bf0a2c3 | git patch-id --stable` = `c740c0f37dd5fea7fbc90ebc28176433a44bea9f`
- 两个 patch-id 完全相同；`bf0a2c3` 的父提交就是 `5122f3f`，改动 12 文件 +378/−33，与分支一致。
- `git diff origin/main pkg/F9-reader` 只剩 F11fix 的 5 个文件差异（origin/main 多出 #56），不含 F9 代码的独有改动。

## 操作

- `git worktree remove .worktrees/TeamAgent-F9-reader` 成功；`git branch -D pkg/F9-reader`（was 2c41b0c）。
- 未触碰 `TeamAgent-F9-reader-release`（detached `bf0a2c3`）：它是本次线上部署/冒烟的源目录，当时仍有 shell 进程在其中等待；19:50 部署线程自行清理了该 worktree。

## 同批清理（已合并、干净、无进程占用，tree 与 origin/main 相同）

- `TeamAgent-C-d7` / `pkg/C-d7`（f1a3d0b）
- `TeamAgent-C-f11pre` / `pkg/C-f11pre`（8f1e79d）
- `TeamAgent-C-f6p` / `pkg/C-f6p`（420863e）
- `TeamAgent-C-f8verify` / `pkg/C-f8verify`（e2e7d6f）

## 保留

- 有未提交改动：D-D4、D-release、event-v2-fix、F8-2、F8-3、login-fix、maincheck、V-B-B6。
- 正在跑测试：`TeamAgent-maincheck`（npm test 全套，cwd 98955）、`TeamAgent-D-D8`（cwd 99197）。
- 太新（<2h）或部署在用：F9-reader-release、D-D8、D-D3a、D-D5、F11c-solo 等。
- 受保护：`TeamAgent-fr-ops`。

## 进程

- `~/.inkboard-team/browser/x` 的 SingletonLock 曾指向 66934、12561、12721，均为 dead；12721 是本地 GitHub runner 的 `npm run test:runner` 短命测试 Edge（native-x-browser 测试），无持续占用。未杀，未删 profile 登录态。
- `login-open.mjs`（node 11834）正在用真实 Edge 打开小红书/微博/知乎/抖音扫码窗口，属于用户当前登录任务，保留。
- 用户日常 Edge（51461）与 runner 主进程未动。

## 缓存

- 删除 `.npm-cache`（71 MB）、`.agent/npm-cache`（75 MB）、`.agent/tmp/login-edge` 下 13 个探针 profile 目录（约 214 MB），共约 361 MB；保留 login-edge 的 .mjs/日志作证据。
- `/Users/yanghongming/Projects/.wrangler/logs` 当时仍在写入（19:44），未删。
