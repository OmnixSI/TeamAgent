# 趟 D · 施工通则（每张施工单都包含本文，先读）

- 设计：/Users/yanghongming/Projects/.agent/releases/D/design.md（§5 接口已冻结，**不许改签名/表结构/返回形状**；觉得要改 → 停下写进交回说明，由主程找架构师）。
  验收清单：/Users/yanghongming/Projects/.agent/releases/D/acceptance.json（只有测试员能改 passes，你别动）。
  真实回放案例：/Users/yanghongming/Projects/.agent/releases/D/replay-cases.md。
- 基线：release/D = origin/main 3adfdf8。你的 worktree 已建好，node_modules 已软链，直接用：`cd <worktree> && git status`。
- 开工仪式：pwd → git log --oneline -3 → 读本施工单 + design.md 里指定的 § → 读 notes/<包名>.md（若有）→ 再写代码。不要整篇读仓库，用 `rg -n` 定位后 `sed -n '起,止p'` 读几十行。
- 进度笔记：每完成一步，往 /Users/yanghongming/Projects/.agent/releases/D/notes/<包名>.md 追加一行（绝对路径，不在 worktree 里）。
- 先写测试再实现。测试命令：单文件 `node --test test/<你的>.test.mjs 2>&1 | tail -40`；全量 `npm test 2>&1 | tail -60`；类型 `npm run check 2>&1 | tail -30`。**交回前全量 npm test 和 npm run check 必须绿**（基线 main 全绿；如果基线本身有失败，写明哪几个）。命令输出一律 tail，不把长日志带进对话。
- 提交：在你自己的包分支上提交，Conventional Commits（feat(records): …），每个逻辑步骤一次提交。**不要 push，不要动 main / release/D，不要改别的包的文件**（文件归属见 design.md §6 表“改动文件（独占）”）。要加到共享文件（如 src/tools/index.ts）只加你那几行，保持字母序。
- 绝对禁止：连线上 D1 / 线上 Worker、往 QQ 群发任何消息、打印或写入任何密钥/令牌。测试一律用本地假 D1（参考 test/learning-accept.mjs 的 env()/browserDb、test/ 里已有的 better-sqlite3 夹具）和 mock 的 fetch。
- 不要把电脑当服务器：不起常驻进程；测试跑完不留临时文件/后台进程。
- 允许的“碰到不确定”处理：设计里已给默认值的按默认；没给的选最保守、最小的做法并在笔记里写一行“假设：…”。真正阻塞才交回提问。
- 交回格式（≤15 行）：分支、最新提交号、改动文件列表、新增/通过的测试数（npm test 的 tests/pass/fail/skipped 四个数字）、done_when 逐条 ✓/✗ + 证据命令、假设与遗留问题、笔记路径。
