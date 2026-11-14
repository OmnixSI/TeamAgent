# 施工单 · D · D3a 动作层 actions.ts
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-D-D3a   分支：pkg/D-D3a   施工者：前端工程师（DeepSeek，纯 TS 后端模块）
先读：_common.md；design.md §5.4（签名冻结）、§5.3（records 签名，你按它**打桩**）、§6 D3a 行；src/quota.ts:724 renderQuota；src/schedules.ts:580 digestText；schema.sql:54 model_usage；semantic.ts 里 get_work_status 的 SQL（rg -n "get_work_status" src/）。
目标：新 src/actions.ts：群里“执行”的唯一入口。只读白名单动作 + runSteps/joinResults/composeWithNote/validateSteps。
## 文件（独占）
- 新 src/actions.ts；新 test/actions.test.mjs。
- 依赖 records：D1 还没合。你 `import` 自 "./records"（summarizeRecords/queryRecords/findType）按 §5.3 签名；测试里用 `node:test` 的 mock 或在测试夹具里提供一个假的 records 模块实现（不要创建 src/records.ts，那是 D1 的文件——tsc 过不了就在 test 里 stub，并在笔记说明“待 D1 合并后 check 才会全绿”；你自己的 `npm run check` 只要求你的文件无新增类型错误）。
## 要点
1. validateSteps：≤6 步；action 不在 READ_ONLY_ACTIONS → {ok:false, reason}；text 步 ≤300 字；records_query.limit ≤20。
2. runSteps：顺序执行，单步失败转成 {ok:false,error_kind} 不影响后续；每步 text ≤800 字。
3. records_summary/records_query：viewer 在 purpose="schedule" 时强制 isAdmin=false，且 **private 行一律排除**（群发场景不得泄露）；period 按 ctx.tz 的自然日/月折算起止。数字只来自 SQL，不由模型算。
4. quota：调 renderQuota(e,{group,sender:viewer.sender,now})，ok 取 .text，否则 reason_text；不要重写余额逻辑。
5. token_usage：model_usage 表按 ctx.tz 的自然日（today/yesterday）求 SUM(input_tokens+output_tokens) 与 SUM(n)，文案“今日 token：输入 x / 输出 y，共 n 次调用”。先 `sed -n` 读 schema.sql 里 model_usage 的列再写。
6. chat_digest：复用 digestText（D0 已加 export；D0 没合时你在测试里 stub）。
7. work_status：同 get_work_status 的 SQL（tasks+jobs 最近 5 条）。
8. joinResults：无 note 的确定性成文：标题 + 每段一块，≤1800 字。composeWithNote：1 次 DeepSeek 调用，无工具，max_tokens 1200，结果当资料包用现有 UNTRUSTED_MARK 包裹（rg -n UNTRUSTED_MARK src/）；失败回退 joinResults。调用 DeepSeek 的方式照 src 里现有一次性无工具调用（如 digest 总结）复用，别新写 client。
## 测试
每个 action 一例（假 D1）；token_usage 在 Asia/Shanghai 与 Sydney 的“昨天”边界不同；private 行不进群发汇总；composeWithNote 抛错回退 joinResults；validateSteps 拒绝写入类 action 与 >6 步。
## 不要做
不写工具文件（D6 做 run_steps 工具）；不改 schedules.ts（只读用 digestText）。
## done_when
design §6 D3a 行 + 上述测试；S-11 的动作层部分；全量 npm test 绿。
