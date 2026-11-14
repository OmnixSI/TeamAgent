# F11fix · 为什么 @ 提需求没建单（表情 / 修仙腔两例）

- 2026-11-14 19:21 Sydney 开工；worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-F11fix`，分支 `pkg/F11fix`，基线 `pkg/F11c-solo` `5aa08e3`。
- 提交：`203cee6`（5 files, +79/−4）。未 push、未部署、未写线上 D1、未发群。

## 1. 根因（一句话）

不是建单接口或授权坏了，是**模型没选 `request_feature`**，而代码又把这个工具当成「后台检索工具」：选了也会先回一句「以后…」的占位承诺，登记要等后台任务——正是线上那两条「口头答应、没登记」的形状。

两层：

1. **工具描述只举了「你应该加个…」**（`src/semantic.ts:883` 原文）和能力卡同一句（`src/capability-card.ts:46`）。「以后回复加些表情」「能不能用这本书的梗和腔调说话」是**改说话方式**，模型读成「现在就能照做的闲聊」，于是 18:52 那轮只调了 `web_search` 两次、直接入戏；18:24 那轮干脆没调工具。
2. **`request_feature` 不在 `LOCAL_TOOLS`**（`src/semantic.ts:12`）。它只写 D1、不碰外网，却被当成非本地工具：`semantic.ts:1122` 的 `!LOCAL_TOOLS.has(...)` 把它甩进 `research-*` 后台任务，当场先回「已开始后台处理」的占位。FR-2 §7 明确要求回执走 `acceptedActions`、不另发第二条；实际实现把「答应」和「登记」拆成了两条消息。

证据：测试员 19:11 只读盘点 `ledger-all/live-state.md` §3 —— 线上 `feature_request` 0 行、`turn_tools` 无 `request_feature`；18:52 那轮 `turn_tools` 只有 `web_search` 两次（`offered=1`，说明 35 个工具都在，包括 request_feature）。

## 2. 改动

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/semantic.ts:12` | `LOCAL_TOOLS` 加 `request_feature` | 就地执行：一次 @ 回合内建单并在同一条回复里给回执，不再转后台任务、不再多一条占位消息 |
| `src/semantic.ts:883` | `request_feature` 描述：加入「以后…」「改说话方式/人设」「每次都先…」等触发例，写明「登记不等于马上生效，不要先答应、也不要先照做」 | 让模型把「长期改行为」当需求而不是当场照做 |
| `src/semantic.ts:815` | `remember_correction` 描述：新的行为要求改用 `request_feature` | 修前模型会误选它（回放里被 authz 以「成员原话里没有明确交办」拒掉，然后仍然口头答应） |
| `src/capability-card.ts:46` | 能力卡 request_feature 一行补「以后…」「能不能…」「含改说话方式」 | 能力卡是系统提示里最显眼的工具介绍，原来只写了「加个…」 |
| `src/reply-finalize.ts:175` | 新增 ①b：request_feature 成功后，若回复没提「已记下/已立项/已登记」，代码补一句「收到，已记下，做好了告诉你。」 | 模型可能只回「行，以后…」；由代码保证用户看到登记的事实 |

测试：`test/feature-request-intake.test.mjs` S18（描述覆盖 + remember_correction 让路）、S19（就地执行：0 个 research job、1 行 feature_request、回复以「已记下」开头）；`test/reply-finalize.test.mjs` F1b（回执只补一次）。

## 3. 判定：这两条属不属于 F11

属。F11 设计 FR-2 原文是「加功能、**改行为**」，「以后回复加表情」「以后用这本书的腔调说话」就是长期改行为，而且用户第二天还会期待它生效——必须有登记，否则就是永久丢失。它们不属于 `remember_correction`：那个工具只接受「不是…是 / 应该叫 / 名字改成 / 纠正」这类**对既有事实的纠正**，回放里它把这两条都拒了（`unauthorized`）。所以在描述里把两者分工写死：纠正 → remember_correction，新的行为要求 → request_feature。

## 4. 回放（真实原话、真实 DeepSeek 模型、本地 D1）

两条消息原文（`ledger-all/notes/d1/msg_mentioned.json`，`WHERE mentioned=1`）：

- emoji：`你以后给我们回复文字的时候，还可以加一些各种表情来表达你的情绪，各种搞怪的 emoji 或者贴吧表情`（2026-11-14 15:24:25 +08:00）
- xianxia：`我最近喜欢看 没钱修什么仙 这本书，能不能用这书里面的梗和台词描述和设定等等来和我说话`（15:52:42 +08:00）

脚本：`/Users/yanghongming/Projects/.agent/releases/ledger-all/notes/f11fix-replay.mjs`（真实 `api.deepseek.com` 只放行 chat/completions，QQ 与检索全 stub，本地 `node:sqlite`；每条消息独立库；会 drain 后台任务）。密钥从 `~/.inkboard-team/secrets/deepseek-api-key` 读，不打印。

受控 A/B（同一脚本，修前=stash 掉三个 src 改动，各 2 轮）：

| 状态 | 建单 | research 后台任务 | 立即回复 |
|---|---|---|---|
| 修前 | 4/4 行（1 条/次） | **4/4 都有 1 个** | 「行，那我以后不当面瘫了…另外刚才那事儿还在后台跑着」——先答应、后登记 |
| 修后 | 4/4 行（1 条/次） | **0** | 只有一句「收到，已记下，做好了告诉你。」 |

早期非受控回放（修前、原始代码）：xianxia 只调 `web_search`×2、0 单，回复直接入戏——**与线上 18:52 那轮完全同形**；emoji 只调 `remember_correction` 被拒、0 单，然后回「收到！以后我讲话就多点表情包」。这两次说明模型选择本身不稳定，所以「修前必然不建单」无法稳定复现；能稳定复现并修掉的是**执行路径与回执**（上表 4/4 vs 0）。

原始输出：`f11fix-before-final-{1,2}.json`、`f11fix-after-final-{1,2}.json`（同目录）。xianxia 修后有 1/4 次因模型自己在 detail 里写「由管理员确认生效范围」命中 `permission` 敏感词变成 proposal/needs_human（仍建单，只是要人工确认）；这是 FR-1 正则保守的既有行为，未改。

## 5. 验证

| 命令 | 结果 |
|---|---|
| `npm run check` | 退出 0 |
| `npm test` | tests 2142 / pass 2132 / fail 0 / skipped 10 |
| `node scripts/fr-accept.mjs --no-write-acceptance`（临时 acceptance/replay 路径） | TOTAL 19 · PASS 19 · FAIL 0；零计数 qq_real_sends=0、online_d1_rows_written=0、replay_network_calls=0 |
| 真实模型回放 | 见 §4 |

## 6. 与 D4 回执守卫的关系（别重做）

- D4 在 `release/D` 新增 `src/receipt-guard.ts`，`CLAIMS.feature = /已立项|在建|已(登记|记录)(需求|下需求)|排进(计划|开发)/`。它**不匹配**「以后说话带表情 / 用修仙腔」这种承诺句式，所以 D4 也拦不住这两条原话留下的假回执。
- 建议给 D4 的 feature 词表加一条：`/以后.{0,8}(都|就|一直|每)|从现在起|长期.{0,4}(这样|这么)/`（或在 `record` family 另立「行为」组），并把 `familyOfTool("request_feature")` 归到该 family。这条我没在 F11fix 做——`receipt-guard.ts` 不在本分支，做了会与 D4 重复。
- 冲突面（`git merge-tree HEAD release/D` 实测）：`src/semantic.ts`、`src/reply-finalize.ts` 两处 CONFLICT。合并时：① semantic.ts 只冲突在 `LOCAL_TOOLS`/import 行——把 `"request_feature"` 加进 D 版集合；② reply-finalize.ts 冲突在 ① 之后——把 ①b 这 10 行插到 D 版 ①（`schedule_create` 回执）之后、`guardReceipts` 之前。若 D4 的守卫已经覆盖登记回执，也可以只保留 `LOCAL_TOOLS` 与描述改动，删 ①b + F1b。

## 7. 未验证 / 限制

- 线上真实群 @ 一次仍未做（要用户本人发）；本包只到「本地真实模型回放 + 线上只读证据」。
- 模型选择仍有波动：修后 4/4 建单，但不能保证 100%；确定性保证来自 `LOCAL_TOOLS`（不再转后台）与 ①b（回执必出现），不来自模型。
- 敏感词正则会把「管理员确认生效范围」这类 detail 判成 proposal；未改分类器。
- `npm run test:runner` / `check:ui` 未跑（不在施工单验收内；改动只涉及 TS 提示词与回复收口）。
