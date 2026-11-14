# SK-2 进度笔记（工程师）
- 2026-11-14 02:3x：开工仪式完成。worktree …/TeamAgent-SK-2，分支 pkg/SK-2 @37d454c，工作区干净。基线：npm run check 绿；npm test 1100/1100 全绿。SK-1 未合入（release/SK 无 src/self-card.generated.ts），按施工单用样例夹具 + 本地不提交 stub 开发。
- 先写测试：新增 test/self-card.test.mjs（S1–S9 共 9 例），首次运行红（Could not resolve "./src/self-card"）。
- 实现 src/self-card.ts（readLive/capabilityState/renderSelf/vendorSummary）与 src/tools/describe-self.ts；tools/index 注册；capability-card 加 selfSummary+SELF_HINT、CARD_MAX 1200→1800；semantic 注入摘要；worker /health 加 selfCard。
- 改用本地不提交 stub src/self-card.generated.ts（样例夹具转 TS，未 git add）。
- 回归发现：semantic 多一次 D1 查询打红 rhythm B3/B4（D1 每回合预算）。改为 loadSwitches 同一条 SQL 顺带取 off:* 并缓存 e.selfSwitches，readLive 优先复用；查询数回到基线，B3/B4 恢复绿。
- 验证：npm run check 绿；self-card+capability-card 18/18；全量 npm test 1109/1109（基线 1100）。CARD_MAX=1800；capability-card.test C1-4 只改数字与 frame 断言。
- 提交：pkg/SK-2 @ 6c5ee70（9 文件，+627/−11），工作区仅有未跟踪的本地 stub src/self-card.generated.ts。
- 复核：npm run check 绿；self-card+capability-card 18/18；npm test 1109/1109；CARD_MAX=1800；rhythm B3/B4 绿。
- 待 SK-1 合入 release/SK 后：删本地 stub，merge release/SK，用真实生成卡重跑 check + 全量。
