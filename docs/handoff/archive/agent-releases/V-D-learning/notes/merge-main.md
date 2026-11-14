# Merge main into release/B — 2026-11-14 15:4x Sydney

- worktree: /Users/yanghongming/Projects/.worktrees/TeamAgent-B-release
- merge commit: 3a09249 (parents aa1fec6 release/B + eb2a6d2 main)
- main moved past the pinned e6edc94: pkg/A-ttspath, A2, A-silkdep are included (main fully contained; `git rev-list --count main ^release/B` = 0).

## Conflict resolutions
- config/validate.mjs: union — B schedules block + main feature_requests block.
- schema.sql: union — main feature_request/image_cache/ds_balance_snapshots + B 0080 review_learnings/review_reports/learning_acks; all CREATE ... IF NOT EXISTS.
- scripts/migrate.mjs: main's guarded CLI + ensureImageNotesProvider kept; migration list union ends ...0043,0044,0060,0061,0070,0080.
- src/review/publish.ts: union — B schedules/learnings digest + main quota field and quota:morning read.
- src/rhythm.ts: SWITCH_KEYS union, 25 keys (B: off:review*, learn:mode; main: off:feature_request, vision:openai_model/per_image_deadline_ms/turn_deadline_ms/daily_cap, docread:enabled).
- src/timing.ts: main's TIMING_EVENTS_PER_TURN=60 + 24-row batching; B's ruleActivities INSERT OR IGNORE kept after send (budget guard left(e)<6 unchanged).
- src/tools/cron-jobs.ts: both quotaMorningJob and reviewReportJob imported and registered (alphabetical).

## Gates (on the resolved tree, tree a72ceac)
- npm run check: PASS (config valid, UI build, self-card regenerated, tsc 0 errors)
- npm run check:ui: PASS
- npm test: 2087 tests / 2077 pass / 0 fail / 10 skipped
- node --test test/learning-accept.mjs: 27/27 pass
- node --test test/rules-inject.test.mjs test/reply-finalize.test.mjs: 25/25 pass
- node --test test/rhythm.test.mjs test/fastlinks-budget.test.mjs test/repo.test.mjs: 111/111 pass (budget baselines untouched)

## Leftovers
- timing.ts 里 B 的注释仍写「留 3 句」，main 把 60 事件按 24 行分批后 timing 最多 3 条语句；代码行为未改，注释待主程决定是否改。
- migration 0043 的 UNIQUE INDEX image_notes_provider_model 只在迁移里，schema.sql 未列（main 原样）；image_notes 的 provider/model 列已在 schema.sql。
- 未 push、未部署。
