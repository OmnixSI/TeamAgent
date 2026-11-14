# P1 增量 + P2 表情包复核

## A. P1 增量（bcace2e..81ac3f5）：打回（2 P1）

测试：A worktree `npm run check`、`npm test` 227/227、`npm run test:runner` 16/16、`npm run check:ui` 全绿；未改 worktree、未提交。B8 的计数差与夜间缺失用代码与 B 的 c31dc90 对照，未在 A 上另造夜间 mock。

- ① **无 @ 明确交办先分类：通过（P2 见下）。** `src/engagement.ts` 新增 `isDirectRequest`，`worker.ts:673` 的 `hardStop` 加 `!preloaded.some(isDirectRequest)`；新测试“explicit assignment survives”证明 `create_file_task` 仍走 research/工具链，“ordinary followup”仍 `hard_unanswered` 且 0 模型调用。
- ② **放行后 authz 仍生效：通过。** 新测试“explicit-request routing cannot authorize a different tool from polluted quoted material”构造 `meta.quoted`，`prepare_project_task` 作为不同工具被 `authz` 拒（tasks=0、`authz.denied`=1）；`isDirectRequest` 只做路由，`authorizeWrite` 仍在工具执行前。
- ③ **夜间反思拒绝污染回合：不通过（P1-1）。** A 的 `src/semantic.ts:61-64` `analyse` 读完元数据后**没有** `tainted` 检查，直接把 `rows`（含 `meta.quoted/replyTo/cardView`）交给夜间 LLM；受污染回合可写 facts/expressions/self_note/reflection。B 分支 c31dc90 已加 `if (tainted({...p, batch: rows}, rows.map(...))) return;`，并有 `legacy-context` 测试通过；A 分支需带上该修复。误伤检查：该检查按整轮 rows，正常反思（无引用/转发/卡片/工具结果）不命中，未见误伤。
- ④ **D1 计数断言：不通过（P1-2）。** A 的 `test/rhythm.test.mjs:182` 是 `assert.equal(imageEnv.meter.used, base.DB.executed - before - 3)`，把 meter 与真实执行数**放宽了 3 条**，不能证明“相等”；B c31dc90 已把三次 cursor/count/job 查询移到比较之后，B8 改为直接相等。A 分支需带上。B3/B4 的 `≤30/≤44/≤48` 断言本身有效。
- ⑤ **成对测试：部分通过。** assignment/ordinary 一对能证明修复（修前 assignment 会被 hardStop 吞掉）；polluted 一条证明 authz。但 ④ 的 `-3` 使 D1 配对不成立。

**A 结论：打回。** 两条 P1 均已在 B 的 c31dc90 修复（夜间 tainted + B8 相等）；合并 B 或把 c31dc90 cherry-pick 到 A 后即可复跑。

## B. P2 表情包（c31dc90）：通过

测试：B worktree `npm run check`、`npm test` 265/265、`npm run test:runner` 16/16、`npm run check:ui` 全绿；`test/stickers.test.mjs` 22/22（S1–S18）。

- ① **≥2 成员才可用：通过。** 首人入 state=0 候选，第二人 `senders` 追加后 promote `state=1`；S2/S3 含并发；手动 owner import 走 state=1 的显式例外。P2：表里仍有单人 state=0 候选行（按“可用”语义成立，若“入库”按物理行则需澄清）。
- ② **预算/开关：通过。** tag 40/天、send 20/天；`send` 默认 false 且严格 `=== true`；`off:sticker_send` 与 `sticker_paused_until`；`worker.ts` 在 **取 token 前**（sticker 块在 942 行 token 之前）和**每次上传前**（965 行）复查；S15/S15b/S16/S17。
- ③ **失败/熔断：通过。** 上传失败不重试；连续 3 次写 `sticker_paused_until` 24h；S11/S11b/S12。
- ④ **表情不计 bot 发言：通过。** `~s` 段不进 `recentBot`/conversation；`unansweredProactive` 的 `lastout` 排除 `%~s`；S18。
- ⑤ **图片不可信：通过。** `describeBytes` 的标签只用于匹配，不触发写工具；S4/S8。
- ⑥ **POST /api/team/stickers 限额/鉴权：通过。** `worker.ts:1199` 只对该路由放宽到 `4*ceil(max_bytes/3)+1024`，其他路由仍 262144；owner 鉴权、解码后 `max_bytes` 严格检查；S13。
- ⑦ **D1 ≤48：通过。** 新增 import/receive/collect/tag/retry 的计数测试均 ≤48；S 组通过。
- ⑧ **只新增表：通过。** `schema.sql` 只追加 `stickers`（`CREATE TABLE IF NOT EXISTS`），无 ALTER；`messages.body` 未改；S14。
- ⑨ **日志/回报无密钥/整串签名 URL/base64：通过（P2 备注）。** `activity`/outbox meta/attempts 不含；P2：sticker job 的 `payload.url` 仍带附件签名 URL 存在 D1（不是日志/回报），与 P4b media job 同类；若要更严可只存 message id/idx。

**B 结论：通过。** P2 不阻塞；A 的两条 P1 由 B 的 c31dc90 覆盖。

未验收：真实群/QQ 富媒体上传、D1 线上 48 条计数、真实模型；B 的 owner 手动导入真机未跑。

---

# A 重审（2026-11-12 06:20，HEAD 81ac3f5d71e5e776482df6d1997c69c2db275c67）

**核对**：worktree `git fetch origin` 后 HEAD = origin/agent/p1-engage = 81ac3f5d71…，`git status` 仅 `.agent/` 未跟踪；`npm test` 233/233、`test:runner` 16/16、`check`/`check:ui` 全绿（233 与交付员一致）。但**两条 P1 在这个提交的树里仍存在**：

- **A-P1-1 未消除**：`git show 81ac3f5:src/semantic.ts` 的 `analyse`（61-64）没有 `tainted` 检查；`tainted` 只出现在 import、`:865` research payload、`:1103` prepare 的 proposal 判定。夜间仍可把带 `meta.quoted/replyTo/cardView` 的整轮交给 LLM 写 facts/self_note。修复在 **B 的 c31dc90**（`if (tainted(...)) return;` + legacy-context 测试）。
- **A-P1-2 未消除**：`git show 81ac3f5:test/rhythm.test.mjs:182` 仍是 `assert.equal(imageEnv.meter.used, base.DB.executed - before - 3)`；B c31dc90 把三次查询移到比较之后，改成严格相等。81ac3f5 的 stat 只有 `engagement.ts/worker.ts/test/rhythm.test.mjs`（47 行），没有 semantic/rhythm 的这两处修复；**233 项来自 81ac3f5 新增的 direct-request 测试与既有测试，不是这两处修复的证据**。

**A 结论：仍打回。** 把 c31dc90 cherry-pick 到 A（或合并 B 的 P1 修复）后复跑；A 自身两处 P1 未消除。

**A-P2（过去时/记住类命中 STRONG）仍在**：`engagement.isDirectRequest` 用的是 `STRONG` 全表。例：`上次我交给本地做了，效果不错` 命中 prepare 的 `交给(本地|AI|你)(去)?(做|干|实现|处理)`，`hardStop` 被跳过并调用模型。**后果不止多一次模型调用**：该回合若没有 external（clean），`authz.authorize` 在 `tainted=false` 时直接返回 ok，不要求强交办；若模型把过去时误当交办并调 `prepare_project_task`，现有 `direct + quoteIn` 仍可通过并建 `queued` 任务。概率取决于模型，但路径存在；建议 `isDirectRequest` 排除 `了|过|上次|已经` 等过去时，或只在 latest 上判断并保留 hardStop 默认。

---

# A 最终重审（8a93c9b，2026-11-12 06:40）

**A 结论：通过。** 上一轮在 81ac3f5 上的两处 P1 与 A-P2 已在 8a93c9b 消除。
测试：`check`；`npm test` 241/241；`test:runner` Python 17 + fetcher 16；`check:ui`；`clients` 2 → 276（与主程一致）。B：`npm test` 270/270、test:runner 17+16、check/check:ui 全绿；`git diff 8a93c9b..3f733e2` 只有 stickers/配置/voice/docs/schema/support + 2 行 `recentBot` 的 `~s` 过滤，P1 的 tainted、B8 严格相等、explicit 授权都在。

- P1-1：`git show 8a93c9b:src/semantic.ts` 在 `analyse` 61-66 有 `if (tainted(...)) return;`；`legacy-context` 覆盖 quote/forward/card/reply/materials/inherited/marker（calls=0、无 facts/dreams）与 clean 两条，9/9 通过。
- P1-2：`git show 8a93c9b:test/rhythm.test.mjs` 的 B8 是 `assert.equal(imageEnv.meter.used, base.DB.executed-before)`，`-3` 已移除。
- A-P2：`authz.ts` 新增 `explicitCommand`/`explicitWriteRequest`，路由与授权共用；去引号/代码，排过去式、否定、引述；`isDirectRequest` 只查 create/prepare（不含 remember）；`authorize` 不再对 clean 回合直接放行，要求 quote 与整条 source 同时命中。测试覆盖 6 条历史闲聊硬闸 0 模型、5 条 clean 截取/引述拒、4 条 clean 写配对、4 条过去式+5 条真交办。
- 回退验证（worktree 外副本）：恢复旧 clean 放行 → 3 条 authz 测试红；删夜间 tainted → night 测试红；恢复旧 any-STRONG 路由 → historical 测试红；还原后 16/9/58 全绿。
- P2 3f733e2：B 270；diff 只多表情包内容与 `~s` 过滤，P1 修复未丢。P2 备注仍为：单人 state=0 候选语义、sticker job payload 的签名 URL 存 D1（非日志/回报）。
未验收：真实模型/群、D1 线上计数、QQ 富媒体真机。

---

# P1 15aba68 快速复审（2026-11-12 06:45）

**结论：打回（2 P1 + 3 P2）。** 门禁全绿，但放行/拒绝清单有两个可复现缺口。

**测试**：`check`；`npm test` 248/248；`test:runner` Python 17 + fetcher 16；`clients` 2；`check:ui` → **283**（与主程一致）。用 `esbuild` 打包 `src/authz.ts` 直接调 `authorize` 复现下列行。

- **P1-1（allow 只在 prepare 成立）**：`帮我出一份 WhalePartner 的开发方案`、`麻烦你把这个 README 整理一下` 在 `prepare_project_task` 下 `ok`，但在 `create_file_task` 下均 `DENY（成员原话里没有明确交办）`：clean 的 `REQUEST_TONE+DEVELOPMENT_ACTION` 只给 prepare；`create_file` 仍用 strict 正则（前者被“WhalePartner 的开发”隔断，后者没有文件名词）。若模型按文件任务选 `create_file`（自然选择），用户拿不到文件；新增测试用 `project`（prepare）掩盖了这一点。修法：把 clean 的文件动作同样接到 `create_file`（README/文档/方案等），并测试两个工具。
- **P1-2（remember 陈述仍可入库）**：应拒绝的 `记住 WhalePartner 的登录有 bug`，用 `remember_correction` + 整句 quote 时 `authorize` 返回 **ok**（探针 ALLOW）；hard gate 只在未 @ 时挡住，@ 回合模型仍可把它写成长期 fact。修法：`remember` 的 explicitCommand 要求“纠正/不是…是/叫/名字”等纠正语气，排除“X 有 bug”陈述。
- **P2-1**：`DEVELOPMENT_ACTION` 未含「看看/查一下/检查」；`帮我看看登录错误`、`帮我查一下登录错误` 被判闲聊拒（false negative）。
- **P2-2**：`请问帮我修复登录错误` 被 `commentQuestion` 当疑问拒（礼貌请求误伤）。
- **P2-3**：`isDirectRequest` 按单行 taint、`authorize` 按整批 taint；一条干净开发请求与另一条引用同批时 hardStop 被跳过调模型，写工具再被拒（多一次模型调用，不建任务，低风险）。

**未回退**：`git show 15aba68:src/semantic.ts` 仍有夜间 `tainted` 整轮拒绝；`test/rhythm.test.mjs` 的 B8 仍是严格 `meter.used === DB.executed - before`。过去式/否定/转述/引述/短 quote/污染回合的 `帮我修复…` 均按预期拒绝。

---

# P1 886a053 复审（2026-11-12 07:00）

**结论：打回（1 P1；上轮 2 P1 + 3 P2 已修）。**
**测试**：`check`；`npm test` 255/255；`test:runner` Python 17 + fetcher 16；`clients` 2；`check:ui` → **290**。P2 d59eaa2：`npm test` 284/284；`git diff 886a053..d59eaa2` 14 文件仅表情包 + `~s`，P1 的夜间 tainted、B8 严格相等都在。

- **P1-1 已修**：`cleanWorkRequest` 同时给 `prepare_project_task`/`create_file_task`；四个 allow 在两工具下都 ALLOW（探针）。
- **P1-2 已修**：`remember_correction` 改用 `CORRECTION`；`记住 WhalePartner 的登录有 bug` clean+dirty 都 DENY；`记住我叫小王` DENY；`不是小李是小王`/`应该叫小王` ALLOW；dirty `纠正这个视频是小王的` ALLOW。
- **P2-1 已修**：`帮我看看/查一下/检查` 两工具 ALLOW；**P2-2**：`请问帮我修复登录错误` ALLOW，`帮我修复登录错误有必要吗` DENY；**P2-3**：`isDirectRequest(own,{batch:[own]})` true、`{batch:[other,own]}` false，worker 传 batch。
- **P1（新过宽）**：`把登录错误修好了`、`把 README 整理好了`、`把视频内容整理成文档了` 两工具都 **ALLOW**。`REQUEST_TONE` 新增 `把`，`statementTail` 只挡紧邻的 `了/过/...`，挡不住后缀 `好了/完了/成了`；过去陈述会被当交办，模型可据此建任务。修法：`statementTail` 补 `好了|完了|成了|…`，或 `把` 只在无 `了/好` 时放行；补测试。
- **P2**：`记住我叫小王` 现在也 DENY（remember 已收窄为纠正语气；若这是有意的产品决定，在工具说明/文档写明）。
- **回退验证**：15aba68 上 create_file 两例 DENY、remember `记住…` ALLOW、`isDirectRequest` 忽略 batch；本轮新增测试在这三处会红，886a053 全过。
**未回退**：夜间 tainted、B8 严格相等（`git show 886a053` 均为现版本）。未验收：真实模型/群、D1 线上计数、QQ 富媒体真机。

---

# bafae10 复审（2026-11-12 07:10）

**结论：通过（上轮 P1 已消除；2 条 P2 只记录）。**
**测试**：`check`；`npm test` 308/308（含 authz-completion 26 条）；`test:runner` Python 17 + fetcher 16；`clients` 2；`check:ui`。
**完成态**：D01–D14 与变体（搞定了/弄好了/已经…/改成了/上次…过/我把它…）在 prepare/create 两工具都 DENY；`authz-completion` 26/26。
**真交办**：A01–A12 两工具 ALLOW；另测 12 条反向（帮我把…一下、请你把…做成文档、麻烦把…、你把…、请问帮我检查、整批含引用）均 ALLOW；`isDirectRequest(own,{batch:[own]})` true、mixed false。
**未回退**：remember 纠正语气 ALLOW（不是…是/应该叫）、`记住 WhalePartner 的登录有 bug` DENY；`git show bafae10` 的夜间 tainted（:66）与 B8 严格相等（:178）仍在；回退 886a053 时「把登录错误修好了」ALLOW，新 26 条会红。
**P2-1（过严）**：`COMPLETED_WORK = /[了过]|已经|搞定|弄好/` 整句拒绝，真请求「帮我看看有没有问题了」「帮我检查一下过期的日志」「帮我修复已经存在的登录错误」「帮我搞定登录错误」「帮我把资料弄好」「帮我查一下上次过期的 token」「帮我把已经失效的登录重构一下」全 DENY；建议把「过」限定为动词后完成态、排除“过期/过程”，搞定/弄好按动词位置判断。
**P2-2**：裸「把…」D13/D14 按合同 DENY；自然的「把登录错误修一下」也被拒。若合同接受则可，否则放开裸把或只在其后无了/过时放行。
**未验收**：真实模型/群、D1 线上计数；26 条 fixture 只覆盖单条消息，整批 taint 由 rhythm 测试覆盖。
