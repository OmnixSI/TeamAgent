# 事件层 v2 对照代码核查（2026-11-13）

结论：**打回，需改方案；P0 无，P1 四项，P2 六项。** 主干方向可保留，但当前不能直接按合同开工。
基线：`68ef1c393ca169dbd41ce210ef7af710332fcf37`；方案 `plan-event-layer-v2.md` 216 行。源码行号均指这个固定提交，不指随后漂移的 worktree。
方法：用 `git archive` 生成临时副本；先读交付员 `.agent/image-fetch-baseline.md`（647 项主测试通过），未重复全量构建。自己复跑 `test/fastlinks-budget.test.mjs` 19/19，并运行下述离线探针；全部请求用合成数据和 fetch 桩，没有真实 QQ、D1、媒体、账号或密钥访问。临时副本仅为暴露私有 sendOutbox 加 export，活跃工作区未改。

## 现状断言逐条核对

| 方案位置与断言 | 判定 | 正确事实与依据 |
|---|---|---|
| :12 gateway 群 message→spool→签名转发 | 成立 | `runner/qq-gateway.mjs:107–116`；签名转发 :65–76；入口 `worker.ts:1360`→receive :178。 |
| :12 receive 只接两种群消息 | 成立 | `worker.ts:200–201`；非绑定群 :227；其他事件直接 op12。 |
| :12 author.bot 过滤 :229 | 成立，行号需校正 | 实际 `worker.ts:228`；目前这里没有另加“自身 id”判断。 |
| :12 messages INSERT OR IGNORE 去重 :266 | 成立，但非整条链路提前返回 | 实际 SQL :267；只有 last_message/full_message_verified 用 inserted 围栏（:351–353），metadata、表情候选、job 与队列仍走；:124–135 的 job 每次都会发队列。合成同事件投两次，队列新增 2 次，job 行仍 1 行。不能把“行去重”当作“所有副作用只执行一次”。 |
| :13 msg_elements 一律当 quoted，103 取 msg_idx | 成立 | `inbound.ts:69–78`；未递归展开转发。 |
| :13 face 不解析 | 部分不成立 | parseInbound 本身保留正文标签，但真实展示链已在 `view.ts:26–46` 解析 face ext 并渲染名字；授权证据另用 :48–63 去掉表情语义。应复用这条信任边界，不能把新解码名字并回成员原话。 |
| :14 member/bot message_refs 写入、入站解析 | 成立 | `worker.ts:313` / :1071 / :258–265；schema.sql:48 无自动 TTL。出站 quoteRef 实际查询 `quote.ts:14–16`，不是 :6–9。 |
| :15 取 5、sending CAS、attempts、4000 截断、240 秒、稳定哈希 | 成立 | `worker.ts:951,1018,1024,1040–1042`；`voice.ts:148`；400/422 去引用恢复需 reference 且有可解析响应体（:1050；quote.ts:20–23）。 |
| :15 5xx/空响应 unknown，无 429 退避/额度/群串行 | 成立 | `worker.ts:1056–1061,1088–1091`；现有取行与 CAS 都无群级条件。 |
| :16 fragments 仅拆闲聊、最多三段 | 成立 | `voice.ts:33–57`；首段 id 是根 id，后续才是 `~1/~2`（:77），不是 `~0/~1/~2`。 |
| :16 worker 三处直接写 outbox；表情有独立 240 秒 | 成立但写入点不全 | `worker.ts:379,841,2183`；`stickers.ts:99–126`，240 秒实际在 :100。还有 semantic.ts:527、ci.ts:264/:386、fetchjobs.ts:232（见 P1-1）。 |
| :17 COST 和 48 条计量 | 成立 | `d1.ts:9–24,32`。每条 batch 子语句都加计数；meter 记录但不会硬阻止越界，靠调用方 left(e) 预留。 |
| :18 迁移显式列表全重跑，编号 SQL 需幂等 | 成立，需补例外 | `scripts/migrate.mjs:24–27`；现有 ALTER 由 `scripts/migrate-video-waits.mjs:2–6` 先 PRAGMA 判列后执行，不是“一切 ALTER 均禁止”。0005 在该提交实际空闲，只有 0002–0004；外部规划保留不等于已落库。 |
| :19 两条活跃线的文件范围 | 不成立，已漂移 | image `e595981` 改 vision 和 5 个测试，非“仅 vision 和一个测试”；pending 当前 `371c617` 对本基线改 worker、delivery、utility 和 6 个测试，无 inbound/fetchjobs/fetcher 源差异。方案 :208 又写旧 image SHA 8d3eb66。 |
| :20 fastlinks P2 / C3 / SIDE_EFFECT_FOREGROUND 未实现 | 成立（就本树） | 没有 prefetchLinks、inlineable、read_x、SIDE_EFFECT_FOREGROUND；C3 Worker 工具派发亦未见。 |

## 必须改的 P1

**P1-1：全局出站接线遗漏，且与“不能动”自相矛盾。** 方案 :25/:98–99/:125 只替换 voice 与三个 worker 写入点，却宣称所有入队走 enqueueText；实际 `semantic.ts:527`（`worker.ts:604–605` 可执行 links job）、`ci.ts:264/:386`、`fetchjobs.ts:232` 仍旁路。CI 两处及 failVideoWait 的 INSERT 与状态更新带同事务/租约条件，不能简单先调无条件 helper 再更新。方案 :178 禁改 semantic.ts 又挡住修复；同样 E40“规划看到 sending”只改 context.ts 不成立：recentBot 的真实查询在 `semantic.ts:811–816`，目前只取 sent/pending 且未按 group 过滤；`rhythm.ts:39` 也漏 sending。**改法：**列全调用方、负责人和带条件入队接口，开放 semantic.ts 这两个窄点以及 ci/fetchjobs/rhythm；保留其事务围栏、按群取 sent/pending/sending，并测长 CI/links 回复和在途重说。

**P1-2：只在 SELECT 排除同群 sending 不保证并发串行，额度和 seq 的持久提交也没有事务合同。** 方案 :127 是取行规则，旧实际 CAS `worker.ts:1018` / `stickers.ts:104` 只锁本行；两个 invocation 先读后锁两行，SQLite 探针得到同群 **2 个 sending**。文本和表情必须用同一群级原子围栏。:129 仅说明 used 自增 RETURNING，没有规定与 outbox_send 落盘同事务；若中断，重试可能再占额度、拿另一 seq。**改法：**给出原子 claim SQL/事务次序（群级无 sending 条件在认领时再次生效）、组内先后条件和同一原子提交中的 ledger/seq；补双调用交错、used 更新后中断、表情与文本竞争、旧响应不能覆盖新状态的探针。

**P1-3：“5 行全部取满且调用 ≤48”与预算本身矛盾。** 方案 :91–94/:171；真实 `d1.ts:32` send_row=10，`worker.ts:1010` 会按剩余数停止；queue 在 :2380 已跑 processJob，cron 在 :1165–1237 已花维护预算，不能从 0 给发送算。仅用方案每行9条：1次取行+5×9=46，加开关1=47，加两种尾写2=49；若采用其允许的 send_row=12，取满需至少61。原 sender 合成5条带引用成功实测37；完整现有 B3-answer 已45、research-handoff39、cron无发送20/21，新增开销没有普遍余量。**改法：**取消“每调用必发满5条”，用完整入口共享 meter、按最坏错误/熔断/表情/借用成本动态截断，剩余持久等待；重新给各入口上界，测试初始预算非48、部分发送后的恢复、cron与两条尾写。尾写可丢，但不得靠它掩盖必需语句超额。

**P1-4：回滚仅 schema 兼容，发送语义不兼容。** 方案 :9/:95/:172/:187；旧 `worker.ts:951,1041–1042` 完全不读 outbox_send，不认 not_before、borrowed msg_id 或已定 seq，也不检查兄弟段 unknown。真实旧 sender 离线重放：根段 unknown，次段 pending、账本 not_before=未来120秒、借用msg=borrowed/seq=2；它**立即发送次段，未带 msg_id，seq=38119**。这会破坏额度、去重、顺序和禁发群保护，非“不需反向迁移”能解决。**改法：**增加停发/在途收敛与持久隔离的回滚步骤，或明确一个能读账本的回滚兼容版本；把以上组合及 muted/active_rejected 纳入回滚断言，不能只断言旧版“能发出去”。

## P2：合同与可执行性缺口

1. **SDK notice 已能核实，不能遇到困难就按通道无跳过。** 方案 :123/:195。本机 SDK 1.0.5 的 `dist/protocol/gateway/event-dispatcher.js:150–153` 将四类事件全部转 raw，`QQBot.js:335–337` 发 `rawEvent`，`QQBot.d.ts:216–224` 给明确订阅签名；四种合成事件 dispatch 探针全部 action=raw。应明确 `bot.on('rawEvent', ctx)` 适配 `{eventType,data}`、绑定群过滤、notice 的稳定 spool key（不能沿用 messageId=undefined 的哈希），以及 notice 缺 actor/id 时的类型规则。真实平台是否投递各通知本次未验证。
2. **入站兼容承诺需缩小并补持久映射。** 方案 :24/:27–28/:118/:169/:179；唯一生产 parseInbound 调用确在 worker:252，但该函数之后 worker:256、282–308 仍读取原始 message_type/msg_elements/attachments 并仅存旧字段；新的 forward/owner/origin/animated 不自动进入模型。`context.ts:145` 最终调用 `view.ts:105–140`，ViewMsg.material 无 forward 字段（:6），mediaViews :89–102 也不渲染 animated。请列出 ne→旧 ib→message_meta→viewMessage→模型字段表，明确新字段如何持久化/渲染、保留原始授权正文；别要求执行者猜“只改薄壳即可”。第8组之外的引用深层图等语义新增也要列 golden 例外，而非无条件逐字段相等。
3. **重复事件不是在 receive 提前返回。** 方案 :195 的未确认项已核；上述重复事件实测2次队列唤醒，数据库行不重复。EV17只数行无法证明全链路副作用幂等；应补入库后中断、重放恢复与队列唤醒次数断言，明确哪一步幂等/哪一步允许重复唤醒，不能盲加 inserted=false 即返回而丢掉中断恢复。
4. **上传属于重复造轮子。** 方案 :77/:99/:123。gateway:166–167 已调用 bot.sendFile；SDK `QQBot.js:759–766`→sendMedia :721–727→uploadMedia :683–707，对 localPath ≥5 MiB 自动调用现成 ChunkedMediaApi；阈值在 `protocol/utils/file-utils.js:15`，已有 prepare/part_finish/complete 实现。应复用 SDK、补10MiB文件与失败交付测试，删除未经证据需要的自建 qq-upload；真实上传权限和服务端额度未验证。
5. **锁定前置 SHA 与文件后重新编号，不照旧行号机械替换。** 方案 :19/:106/:177/:208–209 与当前两线不同；实际重叠是 image 的 vision+fastlinks/rhythm/stickers/vision测试，pending 的 worker/delivery/utility+inbound/integration/delivery等测试。先合并再写 M1 可避免同时编辑冲突，但合同需更新前置 SHA/结果；bili“原文执行” :102/:132/:210 还须给出已关闭此前审查问题的修订版与接线结果，不可把依赖完成写成既成事实。本次未重审整份 bili 方案或X-ASR真机。
6. **开关、时间与终态需补登记。** 方案 :30/:129–131/:198；`rhythm.ts:58–60` 是固定 SWITCH_KEYS，本版四个新 off 开关和 qq:active_rejected/qq:muted_until 要明确批读登记或独立查询成本；消息时间实际是 schema.sql:4 的 TEXT ts，生产 worker:274 直接存 m.timestamp，未找到所谓 messages.ts；应固定 ts→毫秒转换/无效值不认领，以及已有seq在被动窗口过期后的unknown/重试终态，避免无限pending或换pair重发。已有 superseded/skipped 状态（ci.ts:94/stickers.ts:102），idle 仅数sending（worker:1385）、看板异常列表仅failed/unknown/sending（:2011）；若保留全部旧状态则兼容成立，新增行为不要暗中改其口径。

## 验证与边界

- 已跑：19项现有预算测试全过；基线 sender5行37条；完整 B3-answer45、research39、无发送cron20/21；双选择/双CAS模拟同群2sending；真实旧sender回滚错序与忽略账本；重复事件2次唤醒；SDK四通知分派。
- 新方案尚无实现，原子锁探针是对其“仅取行排除sending”规则的反例，不声称测过不存在的新 sender。新预算为合同算术反例，不冒充新代码实测。
- 未跑真实QQ发送、线上D1导出、真实上传、X-ASR或部署；消息字段是否仍保留face原文无法从代码保证，需真实脱敏样本。没有更改任何项目源码、分支或服务；临时探针与副本用完删除。无相关监控自动化。
