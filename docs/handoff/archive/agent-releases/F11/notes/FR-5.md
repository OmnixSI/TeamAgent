# FR-5 进度笔记（测试员）

- 2026-11-14 02:50 开工：worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-F11-FR-5` @ `aefc32e`；读施工单 FR-5、`design.md`、`src/feature-request-types.ts`、core 桩。
- 02:53 搭回放底座：`scripts/fr-accept.mjs` + `scripts/fr-accept/{harness,fixture,scenarios}.mjs`。用 `test/support.mjs` 的 `env()` 建本地库并跑全部 `migrations/*.sql`（0070 合入后自动带上）；462 条真实夹具只读入库；`globalThis.fetch` 全 stub；三个零计数逐次打印并写进报告。
- 02:54 桩上跑通：`FR5-ENV` PASS（8 项：fixture sha256/462 条/rid 连续/迁移/core 6 个导出/零计数）；S1–S17 与 N462 全部 PENDING（FR-1/2/3/4 未合入）。报告 `.agent/releases/F11/replay/fr-accept-latest.json`；acceptance.json 未改。
- 02:55 `npm run check` 无错；`npm test` 1100/1100 通过（未改 `src/`、未改 acceptance）。
- 回放假设：OWNER=`0FC1E8A8BD28981E86866125AC3FCEFF`（夹具 223 条、口吻是用户），以 `members(id=0FC1…, role=owner)` 表达；**线上 members 里哪个 id 是 owner 仍是待 BINI 只读确认的遗留项**。
- 适配层假设（FR-1/2/3 合入后按实际签名改 `harness.mjs` 一处）：`createRequest(e,{title,detail,request_quote,source_id})`；`authorizeFeature(e,{source_id,quote,…}) → {ok}`；FR-3 走 HTTP；超时扫描优先 `src/feature-request-api.ts` 的 `sweepStale(e,now)`；出站用 `worker.queue({messages:[]},e)` 触发现有 tick 末尾的 `sendOutbox`。
- ref_idx：`rid 141` 没有 `meta.msgIdx`，S8/S15 用造的 `REFIDX_FR5_SYN_141` 并在证据里注明；S9 用 `rid 375` 夹具里的真实 `msgIdx`。S12 专门测无 ref_idx。
- 规格冲突待主程定：① S2 用 `rid 59`（`mentioned=0`、`direct=true`）期望 needs_human，但施工单 §4 说 `mentioned=0` 必须 `ok:false`；N462 两种读法都统计，主判据先用 `meta.direct!==true`。② S14 说 shipped 再 report 应 409，design 说 `reply_outbox_id` 非空时重复 report 200 幂等；S14 用「shipped 后 report failed」测 409，S8 只断言不重复入队。
- 合入后：在本 worktree `git merge release/F11`，跑 `node scripts/fr-accept.mjs`，按 FAIL 清单只改适配层/场景接线（不改 `src/`），跑通后把 S1–S17 的 passes/evidence 写实，再补 S16 的 FR-4 脚本参数。

## 2026-11-14 03:04 正式回放（release/F11 74a0f99 已合入）

- 合并 `release/F11`（74a0f99）到 `pkg/F11-FR-5`；按真实签名改适配层：`createRequest(e,{source,sender_name,quote,title,detail,tainted},{now?})`、`authorizeFeature(quote,source,context,messages)`（authz.ts）、`sweepFeatureRequests(e,now)`、`worker.queue({messages:[]})` 触发出站。
- `node scripts/fr-accept.mjs`：19/19 PASS（S1–S17 + FR5-ENV + N462），FAIL 0；acceptance.json S1–S17 全部 passes=true，S18 保持 false；证据含 owner 假设「待 BINI 只读确认」。
- N462：462 条全跑；非直接@ 44 条全部 ok:false；直接@ 418 条（其中 mentioned=1 的 64 条）；含敏感/污染 9 条，抽 5 条真实建单全部 mode=proposal；authorize 放行 306 条。
- 两个 1 行小修（施工单允许 ≤10 行，已注明）：
  1. `src/rhythm.ts:58` SWITCH_KEYS 加 `"off:feature_request"`。原因：`featureRequestEnabled(sw)` 读这个键，但 `loadSwitches` 不加载它，文档里的 settings 开关永远不生效（S17 触发）。
  2. `src/worker.ts:1312` sweep 前加 `if (left(e) >= 3)`。原因：B7 cron 预算 48，FR-3 在 scheduled 里无条件 sweep 固定多 2 条查询 → `cron 50,47,47,47` 失败；加预算保护后 48。
- 门禁：`npm run check` 无错；`npm test` 1164/1164（修前 1163/1164，B7 红）。
- 报告：`.agent/releases/F11/replay/fr-accept-20261114-030402.json` 与 `fr-accept-latest.json`。
- 2026-11-14 03:04 最终提交 `405965f`（工作树干净）：`node scripts/fr-accept.mjs` 19/19 PASS，acceptance S1–S17 true、S18 false；报告 `fr-accept-20261114-030446.json` / `fr-accept-latest.json`（git 405965f、dirty=false）；`npm run check` 无错、`npm test` 1164/1164。
