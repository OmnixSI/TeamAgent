# D3b 进度笔记（工程师 · pkg/D-D3b）

## 进度
- 17:55 开工仪式：worktree /Users/yanghongming/Projects/.worktrees/TeamAgent-D-D3b，分支 pkg/D-D3b，基线 3adfdf8，干净。D0/D2/D3a 分支都还停在 3adfdf8（未提交），依赖接口按 design §5.4/§5.5 在测试里用 esbuild alias 注入 stub。
- 18:05 先红后绿：nextRun monthly/every/once/DST（A1–A10）→ 实现 cadenceOf/nextMonthly/nextEvery。
- 18:10 planSchedule agent_task（B1–B5）→ runSchedules agent_task/限流/暂停/开关（C1–C9）。首次全量 2162 例，3 红（config 上限、T7 上限、W-14 预算）。
- 18:20 tools 四件（D1–D13）→ 37 例全绿。
- 18:25 全量红：`tool-names-unique` 与 `self-card-gen` 因 semantic.ts 旧同名定义未删；改为暂不注册（见下）。
- 18:30 磁盘满（ENOSPC）中断，未提交。
- 18:15（恢复后）config 只保留 max_active_per_group 5→10，代码里 2/24/9 用默认值，不再加 config 键；W-14 的根因是 runSchedules 在 cron 开头多花 1 次 D1 查询，挤掉了末尾 cleanupRepoIndex 的预算 → 把 `off:schedules_cron` 检查挪到「确实有到期行」之后。
- 18:40 `git merge release/D`（D0/D1/D4 守卫，无冲突）。D0 已把 schema.sql 的 schedules 改成 v2 并建 pending_actions，测试夹具直接用它，不再自建表。
- 18:50 补 RC-09/RC-12/S-03 日程层断言（D14–D16），共 40 例。
- 18:58 自查发现「只改时间的 update 会把日报改成 agent_task」（原话里的兜底 text 步骤），补 D17 并修掉。
- 19:05 终态：`npm test` 2208/2198/0/10、`npm run check` 绿；HEAD f272810，worktree 干净，.wrangler 已删（790MB）。

## 改动
- `src/schedules.ts`：ScheduleKind/ScheduleSpec/Cadence、cadenceOf、dualText、nextRun（monthly/every/once）、normalizeTiming、planSchedule(agent_task)、runSchedules(agent_task/≤2 模型/≤24 每日/失败 9 次暂停/off:schedules_cron)、listSchedules 带 last_run_status、describeSchedule 覆盖新类型与双时区。
- 新 `src/tools/schedule-tools.ts`：schedule_create / update / list / cancel。
- `config/team.json`：schedules.max_active_per_group 5→10（其余三个上限走代码默认 2/24/9，不加 config 键，避免动 learning-types 的整块断言）。
- `test/schedules-v2.test.mjs`：40 例（A cadence/DST、B 计划校验、C 运行与限流、D 工具与 pending、RC/S 日程层）。
- `test/learning-types.test.mjs`、`test/schedules-topic.test.mjs`：上限 5→10 的期望值。
- `src/tools/index.ts`：只加注释，**没有注册**四件工具（原因见下）。

## 集成注意（重要）
1. `src/schedule-parse.ts`（D2）与 `src/actions.ts`（D3a）是本包为单独可构建/可 check 放的**占位**：只有 §5.4/§5.5 类型，调用即抛错。合并顺序必须先 D2/D3a 后 D3b；冲突时整文件取真实现，删掉文件头说明。
2. 四件工具**尚未注册**：semantic.ts 里还有旧的 schedule_create/list/cancel 定义（D4 阶段 2 未合），注册会让 `test/tool-names-unique.test.mjs`、`test/self-card-gen.test.mjs` 变红。D4 删旧定义后，在 `src/tools/index.ts` 加 4 行 import + 4 个数组项（字母序），并把 `config/self-manifest.json` 的 schedules.tools 加 `schedule_update`。工具本身已有 13 例工具测试。
3. 归属校验用 `isAutoSender`（owner 或管理员）；mute 例外（任何人可取消自己的）。
4. 违规记录：`schedule_create/update` 把模型时间字段与 parseWhen 的不一致放进返回的 `overrides`，并调用可注入的 `setScheduleViolationHook`（默认不落库；D4 要落 tool_calls 时接上）。
5. `off:schedules_cron` 检查放在「有到期行」之后：cron 的 background 200 次 D1 预算末尾还有 cleanupRepoIndex（`optionalCron(...,2)`），开头多 1 次查询会让 W-14 红。

## 验证命令
- `npm test 2>&1 | tail -20` → tests 2208 / pass 2198 / fail 0 / skipped 10（已验证）
- `npm run check` → tsc 无输出（已验证）
- `node --test test/schedules-v2.test.mjs` → 41/41（已验证）
