# gift-report（V-D-learning）进度

- 2026-11-14 14:00 Sydney：只读查完线上 D1（76 表 / 466 messages / 267 outbox）+ 代码 + 测试；结论写入 `../gift-report-findings.md`。
- 2026-11-14 14:05 Sydney：按 BINI 补充线索扩搜「晨报/早报/礼物/每天8点/悉尼」；`晨报` 字面 0，唯一原话仍是 t.o.o. 11-13 04:11 的「每天 8 点昨日总结」。补 §3.1：`digest_daily` 默认 `Australia/Sydney`，D2 断言 next_run=2026-11-13T08:00:00+11:00；线上只是没有 schedules 行。
- 关键：D1 无「礼物日/早报/晨报/礼」原话；schedules/schedule_runs/behavior_rules/promises 均 0 行；F6 在 11-14 01:42 才合并、01:44 部署，晚于请求 21.5 小时。
- 测试：`node --test test/schedules.test.mjs` 15/15；`node --test test/daily-push.test.mjs` 6/6。
- 未做：未写线上 D1、未发群、未部署（按施工单只读）。
