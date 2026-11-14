# V-D-learning L9 验收报告（测试员）

日期：2026-11-14 15:10 Sydney（周六，谷时）
被测：`release/B @ 2f642fb`（已含 L0–L8 + L7 预算返工；B-l9 夹具在 `ff95b56` 已合入）
验收分支：`tmp/accept-l9 @ 7221c17`（未提交到 `release/B`；由主程合入测试文件）
命令：`node --test test/learning-accept.mjs`（TAP：`replay/out/learning-accept.tap`）

## 结论

- **VL-1 … VL-20：19 通过，1 失败（VL-6）**；测试文件 27 项 / 26 通过 / 1 失败。
- 失败是 **P1**：`promiseGuard` 把两条真实受保护回复（`outbox.rid=245`、`254`）里“每天早 8 点推送…吗？”误判成口头承诺，整句替换为“这个我还没登记上…”，并非“草” scrub 的问题。
- 门槛复核：`npm run check` 0 错；`npm test` 1894 项 / 1884 过 / 0 败 / 10 跳过（与主程给的基线一致）。
- 零发送/零写：24 次网络调用全部 `api.deepseek.com`；`qq=0`、`cloudflare=0`；`stats.qq_real_sends=0`、`stats.online_d1_rows_written=0`；日志固定行“QQ 真实发送 0 次、线上 D1 写入 0 行”。
- 模型：judge/rewrite/tool-call 用确定性桩；`replay/fixtures/deepseek-recorded.json` 仍 `pending`。本验收证明管线与投递行为，不证明真实模型成稿质量。

## VL 逐条

| VL | 结果 | 关键证据 |
|---|---|---|
| VL-1 | PASS | p1 真实片段 → report ready（≤12 行、无 DENY）→ 08:40 入 outbox `reflection-report:2026-11-15` 1 条；再 10 tick 仍 1 条 |
| VL-2 | PASS | 真实空窗夜 → `skipped/nothing_to_say`，outbox 0 |
| VL-3 | PASS | shadow 成稿含“我发现/我打算记住”，无“已经改/已修复/已经记住” |
| VL-4 | PASS | 真实 rid=134 + 18 条含草回复 → learning；本人“1 可以”→ canary 规则 + `learn-ack:ans-owner`；非本人→0 规则 + 提示 |
| VL-5 | PASS | 非本人“1 不要”→ `disputed`，0 规则 |
| **VL-6** | **FAIL** | 10 条 standalone 草删除、8 条草稿/引用未因草改动；但 full finalize 改写 rid=245/254（见 P1-1） |
| VL-7 | PASS | address_as 仅 B391 在批时注入；member≠sender → null；真实形状 member=requester 通过 |
| VL-8 | PASS | 真实 rid=351 → schedule_create(topic) 建 08:00 日程；回复“记下了…”；08:00 出 1 条 5 行推送 |
| VL-9 | PASS | 2027-04-04 08:00→`2027-04-03T22:00Z`；2027-10-03 08:00→`2027-10-02T21:00Z` |
| VL-10 | PASS | owner 回推送“不用再发了”→ cancelled + sched-cancel；非 owner→active + 提示 |
| VL-11 | PASS | learn-ack 回“不对”→ rule retired / schedule cancelled + learn-undo |
| VL-12 | PASS | 停机 2h5m→skipped/expired、outbox 0；同日 dedup 两次→1 条 |
| VL-13 | PASS | 第 6 个 schedule_create→invalid_args；6 条已发后到点→skipped/cap、outbox 0 |
| VL-14 | PASS | 扫描列出 rid=351；dry-run 0 写；apply 建 morning-report + sched-ack；08:00 出 1 条 ≤5 行；周报/草进 proposed 且晨报 asks |
| VL-15 | PASS | 无日程“每天8点”→ learning 且晨报 asks；同时间 active 日程→covered，0 learning |
| VL-16 | PASS | renderDigest.schedules：ok/late/skipped/failed 各 1，items 4 条 |
| VL-17 | PASS | network 24 全 DeepSeek；qq=0、cloudflare=0；qq_real_sends=0、online_d1_rows_written=0 |
| VL-18 | PASS | off:review_report→skipped/off；learn:mode=off→不拦截；off:review_rules→prompt 无块、0 次读 |
| VL-19 | PASS | 真实 chat-drain-350 承诺→建 08:00 日程 + “记下了”；解析不出时间→“还没登记上”、0 日程 |
| VL-20 | PASS | canary 草规则进 prompt 1 次，回复 scrub 掉草；0 规则时 prompt 无 groupRules/reflection 字段 |

## P1-1 promiseGuard 误伤“讨论定时推送”的正常回复

- 触发：`src/reply-finalize.ts:127-136` 的 `promiseSentence` 只按“每/天 + 时点 + 发/推/出”匹配，不判断疑问/否定/从句；`:161-181` 命中后若 `parseScheduleRequest(userText)` 解析不出（或没传 `userText`）就把整句换成“这个我还没登记上…”。
- 真实数据：`replay/fixtures/outbox-cao-18.json` 的 `rid=245` 结尾“另外确认一下：这份日报和每天早 8 点推送用同一套模板吗？”；`rid=254` “日报模板和每日早 8 点推送是不是同一套…”。两条都是受保护（草稿/引用）行，均被整句替换。
- 最小复现：
  ```js
  finalizeSpoken(JSON.stringify({ mode: "work", text: cao.rows.find(r => r.rid === 245).body }), { avoid: ["草"] })
  // 第 606 字节起：“另外确认一下：…同一套模板吗？” → “这个我还没登记上，你说一下每天几点、发什么，我马上建。”
  ```
  断言在 `test/learning-accept.mjs` VL-6；TAP 第 13 项 not ok。独立复现：`node replay/vl6-repro.mjs`（当前退出码 1，打印 rid=245/254 的 before/after）。
- 影响：任何普通回复只要提到“每天 8 点推送”就会被换掉一句，用户会看到无关的“还没登记上”。不是草 scrub 的回归。
- 建议修法（供主包）：命中句先排除疑问/否定（`吗|是不是|是否|要不要|怎么|同一套` 或句末 `？`），或要求承诺句是第一人称/无插入语。修完重跑 VL-6；其余 19 条已通过。

## 顺带核对（主程四问）

1. **seed-437 vs daily-push-real 的 `sk_`/`sk-`**：`sk-` 是真实 D1 值；`sk_` 是导出脚本的脱敏产物。`scripts/review-export.py:160-184` 只在 id 字段把 `sk-` 换成 `sk_`，`seed-437` 和 `replay/fixtures` 继承了后者；`test/fixtures/daily-push-real.json` 由另一条导出链保留原值。按 `body`/`rid` 匹配不受影响；按 `id` 跨夹具比对会不一致（现在没有生产逻辑依赖这个 id 比对）。
2. **L5 缺口（muted 跳过、10:00 后 expired）是否影响验收**：不影响 VL 结论，但确是与设计 §投递 的缺口。`src/review-report.ts:76-160` 只处理窗口/开关/上限/禁词，没有 `muted(e, group)` 检查和 `expired(late)` 落库；`sendOutbox`（`src/worker.ts:1062-1076`）也不查 mute。后果：08:40 恰好 mute 的群仍会收到晨报；10:00 后进程才恢复时 ready 行永远不标 expired（不会补发，但状态脏）。VL-1/2/12/18 都没覆盖这两条，建议作为 P2 进 next.md，或按设计补。
3. **L2 的 say 对 mute/reminder 也加文案**：`src/semantic.ts:1487` 对所有成功的 schedule_create 都返回同一句“记下了，…，第一次是…。不想要了回那条推送说「不用再发了」。”；`src/reply-finalize.ts:151-156` 无条件前置。reminder 有推送，没问题；mute 没有出站（`src/schedules.ts:738` body=null），说“回那条推送”会误导。VL-8/13 只覆盖 digest，不阻塞验收，P2。
4. **address_as 严格 `qq:` 比对在真实形状下是否被拒**：不会。真实发送者是 `ib.senderId`（`src/inbound.ts:101` 取 `member_openid`/`id`，无 `qq:`），`src/worker.ts:397` 原样传入；L4 `seedOf` 把 `params.member` 收敛成同一条消息的 `sender`（`src/review/learnings.ts:113-117`），L6 `applyLearning` 的 `params.member !== row.requester`（`src/learning-confirm.ts:174-176`）两侧同值，通过。只有手工/回填把 `params.member` 写成 `qq:` 前缀、requester 仍是裸值时会被拒；`renderRule` 自身是归一化的（`src/review/rules.ts:39,64`），所以回填入口会接受，随后确认会静默不写、不回执。VL-7 里有这条反例断言，建议 P2：`applyLearning` 也走 `normMember`。

## 未验证

- 真实 DeepSeek 评分/改写/tool call 未跑（录制 fixture 仍 pending）；所有模型输出为明确标注的确定性桩。
- 未发 QQ、未写线上 D1；VL-17 只证明回放进程无外联。
- `npm run test:runner` 未跑（Python/runner 套件，与本版改动无关；沙箱已知 8F/2E）。

## 文件

- 测试：`test/learning-accept.mjs`（提交 `7221c17`，分支 `tmp/accept-l9`）
- 溯源自检：`replay/check-acceptance.py --post` → entries 20 / passes true 19 / false 1 / rid 38 / 逐字 13 / errors 0
- 验收清单：`.agent/releases/V-D-learning/acceptance.json`（20 条；VL-6 `passes=false`，其余 true）
- 证据：`replay/out/learning-accept.tap`、`replay/out/latest.json`、`replay/out/learning-accept-*.log`
