# FR-3 进度笔记（工程师 · pkg/F11-FR-3）
- 2026-11-14 02:50 Sydney（北京 23:50，谷时）开工：worktree 干净 @aefc32e（types+core stub 已冻结）。读了 design.md 状态机/工作室接口/回复、FR-3 施工单、FR-1/FR-4 单、assembly 契约、claims.ts/worker.ts 关键段。
- 计划：临时 0070 迁移 + core 简版（本地跑测试，交回前移除）→ 先写 test/feature-request-api.test.mjs → 实现 src/feature-request-api.ts → worker.ts 两处接线 + 16KB 上限 → 全量测试。
- 03:2x 实现完成：src/feature-request-api.ts（路由/鉴权/CAS/回复 batch/sweep）、worker.ts 5 行接线（import、16KB、route、sweep）、test/feature-request-api.test.mjs 16 条。
- 测试：新增 16/16 通过；并发 S7 连跑 5 遍全过；全量 npm test 1116/1116（本地临时 0070+core）；npm run check 无错。
- 跨包联跑：用 FR-1 分支真实 0070/core/config 在 /tmp 复制树跑 16/16 + 全量 1116/1116 全过（未改任何 worktree），临时目录已删。
- 交回前按施工单移除临时 0070 与 core 简版：提交只含 3 个文件；分支 pkg/F11-FR-3 @7bf6ac7；未 push。
- 假设：FR-1 只把表放进 0070、schema.sql 未加表 → sweep 对「no such table: feature_request」做窄兜底（仅该错误，防 code-first 部署把整个 tick 打挂）；生产 migrate 0070 后正常。GET 单条/claim/report 统一 {item}；smoke/rollback 失败用 422 reply_invalid；sweep 每 tick 总共最多处理 20 条。
