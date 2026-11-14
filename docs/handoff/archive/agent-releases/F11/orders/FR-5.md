# 施工单 · F11 · FR-5 验收回放
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-F11-FR-5   分支：pkg/F11-FR-5   施工者：测试员（DeepSeek）
目标：用真实群消息把整条状态机在**本地独立库**里走完，逐条把 acceptance.json 的 passes/evidence 写实。只有你能改 passes 与 evidence。
前置：FR-1/2/3/4 由我合入集成分支 release/F11 后通知你；此前你先搭框架（用 src/feature-request-types.ts 与桩）。合入后你在 /Users/yanghongming/Projects/.worktrees/TeamAgent-F11-FR-5 里 git merge release/F11 再跑。
要做的：
1. scripts/fr-accept.mjs：用 test/support.mjs 的 env() 建本地库（跑全部迁移含 0070），读真实夹具 /Users/yanghongming/Projects/TeamAgent-f7-2-real-fixture-20261114/messages.json（462 条，只读；不要写回）。网络一律 stub：fetch 被调用就记录并失败；统计 qq_real_sends / online_d1_rows_written / replay_network_calls 必须为 0 并写进证据。
2. 场景（对照 /Users/yanghongming/Projects/.agent/releases/F11/acceptance.json，S1–S17；S18 是用户真群验证，你不碰）：用真实消息的真实原话与真实 sender（夹具里 sender 0FC1E8A8… 说「你以后去做耗时任务的时候能不能先回答一下」、CBFDDE8B… 说「我需要你加一个种族歧视的…」，meta/mentioned 字段按夹具）。**谁是用户本人**：用只读方式确认——先看夹具/代码里有没有 owner 映射；确认不了就在回放里把白名单配成 0FC1E8A8…（夹具里发言最多且口吻是用户的）并在证据里写明这是回放假设，**同时把「线上 members 里哪个 id 是 owner」标为待 BINI 只读确认的遗留项**。
3. 全流程回放（S15）：真实原话 → createRequest → claim → heartbeat → report shipped → 本地 sendOutbox(stub fetch 记录请求体) → 断言 message_reference（给夹具里该消息造一条 message_refs 记录，ref_idx 用夹具 meta 里的真实值，没有就在证据里说明是造的）。
4. 「真实 462 条负例」：对夹具里每一条消息，用 authorizeFeature（FR-2）判断：非直接@（meta.direct 不是 true / mentioned=0）的全部必须 ok:false；统计直接@的条数、其中含敏感词被判 proposal 的条数；写进证据（不要求这些真实消息都建单）。
5. 每个场景跑完把 acceptance.json 对应条目的 passes 改 true 并把 evidence 写成「命令 + 关键输出 + 日期」，失败的留 false 并写失败原因交回，不要硬改成 true。输出报告 /Users/yanghongming/Projects/.agent/releases/F11/replay/fr-accept-<日期时间>.json 与 fr-accept-latest.json。
6. 验证命令：node scripts/fr-accept.mjs 2>&1 | tail -80；再 npm run check && npm test 2>&1 | tail -40。
不要做：不连线上 D1（连只读都不用，夹具已导出）；不往群里发；不改 src/ 下代码（发现缺陷写进交回，给出文件:行、触发输入、期望，由我派返工）；不动 acceptance.json 里「场景/输入/期望」文字，除非场景本身写错（要写明原因）。
done_when：S1–S17 全部 passes=true 且 evidence 非空，三个零计数为 0；或失败项逐条带复现输入交回。

通用（每个包都适用）：
- 开工仪式：pwd → git log --oneline -3 → 读 .agent/releases/F11/design.md（只读「状态机/识别与闸门/工作室接口/回复」几节）和 src/feature-request-types.ts、src/feature-request-core.ts → 读 .agent/releases/F11/notes/<包名>.md（没有就建）。每完成一步在笔记追加一行。
- 接口冻结：src/feature-request-types.ts 与 src/feature-request-core.ts 的签名不许改（FR-1 只许替换 core 的函数体）。需要改接口就交回，别自己改。
- 读代码精准：rg -n 定位后 sed -n 看几十行；不读 lock 文件/node_modules/生成物。命令输出 2>&1 | tail -60。
- 先写测试再实现；提交用 Conventional Commits，在自己的包分支上提交。验证命令：`npm run check` 无错、`npm test` 全过（输出截断）。不 push、不碰 main、不动线上、不往群里发任何消息、不写线上 D1。
- 不确定的地方先 rg 现有代码找同类写法照着来；仍不确定就在笔记里写下假设继续，交回时列出。
- 交回格式（≤15 行）：分支+提交号、改动文件、新增测试数与 npm test 结果、做了什么假设、没做/遗留。
