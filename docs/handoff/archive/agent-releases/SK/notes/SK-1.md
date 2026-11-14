# SK-1 · 生成器 + 清单 + 构建/发布钩子 · 工程师(DeepSeek)

- 2026-11-14 02:35 worktree /Users/yanghongming/Projects/.worktrees/TeamAgent-SK-1，分支 pkg/SK-1，基线 37d454c，工作区干净。
- 2026-11-14 02:36 基线：npm test 1100/1100 pass；npm run check 通过（precheck 会跑 check-config + build-ui）。node_modules 用 `npm ci --cache /tmp/npm-cache-sk1` 装（默认 npm 缓存有 root 文件）。
- 2026-11-14 02:40 侦察结论：baseTools 未从 semantic.ts 导出（681 行内联 const），按施工单走正则抽取 name/description；repoTools 与 EXTRA_TOOLS 可 esbuild 打包导入。工具共 26 个静态注册（11 base + 4 repo + 13 extra），另 mcp_* 动态。switch：EXTRA 取 BotTool.switch（缺省=工具名，见 toolkit.ts:25/48），JSON 工具取 src/capability-card.ts 的 TOOL_SWITCHES。
- 2026-11-14 02:41 表名：messages/outbox 等在 schema.sql，不在 migrations/*.sql；测试要求 tables 含 messages，故 tables 取 schema.sql + migrations/*.sql（记录为决定）。
- 2026-11-14 02:52 先写测试 test/self-card-gen.test.mjs（11 个用例：commit/生图事实/工具覆盖/锚点行号/密钥/ repo_map/幂等 + 4 个负向），先红（生成器不存在）。
- 2026-11-14 03:05 scripts/gen-self-card.mjs 完成：esbuild 导入 EXTRA_TOOLS/repoTools；baseTools 用正则+字面量解析（semantic.ts 未导出）；switch = BotTool.switch → capability-card.ts 的 TOOL_SWITCHES → EXTRA 的 toolkit 默认 off:<工具名>；providers 用 host_file/model_file/evidence_pattern 小扩展（默认回落到 file），正则第 1 个捕获组存在时取捕获组，避免匹配到注释里的旧模型名；tables 迁移优先、schema.sql 兜底；密钥路径白名单 + token 形状 + 进程环境里 KEY/TOKEN 值三项扫描。
- 2026-11-14 03:12 决定（写进交回）：(a) tables 必须含 schema.sql，否则 messages/outbox 不在 migrations 里；(b) MCP 的 off:mcp 是运行时拼接字符串，按施工单 switch 校验规则登记不了，mcp_bridge.switches 为空，只在 how 里说明；(c) 生成器支持 --manifest/--out，负向用例在临时拷贝上跑，不碰真实清单。
- 2026-11-14 03:18 验证：node scripts/gen-self-card.mjs → 24 能力/28 工具；npm run check 通过；node --test test/self-card-gen.test.mjs 11/11；npm test 1111/1111（基线 1100）；npm run check:ui 通过；node --test runner/test_fetcher.mjs 61/61。npm run test:runner 有 8 failures+2 errors，全是 subagent_test.py 的 sandbox-exec 权限问题（本机环境，未改 runner/）。
- 2026-11-14 03:20 风险留给集成：SK-2 新增 describe_self 后不登记 config/self-manifest.json 会让构建失败（设计如此，需在合入时补登记）；SK-1 合入后 /health 还没有 selfCard 字段，verify:release 会按新检查失败，等 SK-2 上线；baseTools/TOOL_SWITCHES 是结构解析，semantic.ts 或 capability-card.ts 大改结构时生成器会带原因失败。
