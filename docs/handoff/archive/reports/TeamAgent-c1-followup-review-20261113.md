# C1 followup 中间审查（复核员 · DeepSeek）

结论：打回（P1 1 条、P2 1 条）
测试：审 be9ecbc（61fb8cf..be9ecbc），worktree 未改。临时副本 /usr/local/bin/python3 3.12.3：gitsafe 31、repo_index 35、全量 119 全绿；npm test 555/555、check、test:runner（Python 119 + Node 51）、clients 2/2、check:ui、build-ui、git diff --check 均通过；followup 5 例连跑 3 次稳定。
问题：
P1 安全/回归 runner/repo_index.py:34：sid/session 长值只匹配 `=`，JSON/YAML 的 `:` 形式不再脱敏（61fb8cf 会脱敏；settings.json/auth.json 不在 DENY）。已复现：临时仓库提交含 `{"session":"<40位>"}` 的 settings.json，`commit_record` 返回的 patch 含明文，且会经 sync_once 上报云端；同一输入在 61fb8cf 为 [REDACTED]。修法：该分支 `\s*=\s*` 改为 `\s*[:=]\s*`（保留 32 位下限，`const sid = 42` 仍不误伤），补 JSON/YAML 断言。
P2 崩溃 runner/gitsafe.py:38 + runner/repo_index.py:189：`-c color.ui=false` 覆盖不了显式 `color.diff=always`，patch 头带 ANSI 时按 `^diff --git` 拆不出段，`zip(..., strict=True)` 抛 ValueError；sync_once 只接 GitFailed/TimeoutError/OSError，整轮索引停摆。已复现（61fb8cf 同样崩，非新引入；应用自建 clone 当前不设 color.diff）。修法：加 `-c color.diff=false`（或 show/diff 传 --no-color），补 color.diff 用例。
备注：1) 进程组：实测 child pid==pgid、父 pgid 不变；真实 credential helper 后代在 0.3s 超时后被清掉，0.9s 后无落盘；但字节上限路径只 kill 主进程且 communicate 无超时（show 不派生子进程，暂无残留）。2) src/repo.ts:17 redactPatch 仍只认 ghp_，与 runner 新前缀不同步（patch 已由 runner 先脱敏，未发现实际泄露）。3) filter 跳过全链路探针：payload 仅 label+固定码，未含过滤命令。
