# V-D v2 · D-3 真实夹具的信号偏差

本文件记录 D-1 脱敏子集在 D-3 v2 上的**实际**结果，避免为了通过旧断言改真实数据。
阈值和词表仍用 `src/review/constants.ts`；没有为任何案例调低。

| 案例 | 真实行 | v2 实际结果 | 说明 |
|---|---|---|---|
| #17 22 分钟无回复 | messages 428–432；outbox 239 | 5 条 inbound trace 全部 S1 | 428–432 是同一个 `chat_decisions` batch（d-432）；S1 从 batch 起点 20:49:36 算到 21:11:15 |
| #13「收敛一点」 | message 95；outbox 76 | **S7 不成立** | 95 只有 1 条 outbox 回复；93–96 是同一发送者的入站消息，不是 bot 连发。S7 只数 outbound 回复，不能拿入站 4 条冒充 |
| #2 正式上线能力自述 | message 434；outbox 241（`msg_id=435`） | **S8 不成立** | 434 的 decision 是 tool、没有 outbox；241 配对到 435，正文只有「正式上线」，S8 词表是「上线了/我能/可以帮你/支持/能力」，不能为一个案例改词表 |
| #3 马哥改大肥鱼 | messages 338/339；outbox 190/191 | **S10 不成立** | 190/191 的 3-gram Jaccard=0.17，远低于 0.8；S10 不降低阈值 |
| #20 b23 后 Queues 长文 | outbox 233（`msg_id=NULL`） | `tr-out-fx-o-233` 存在；**S9 不成立** | 233 现在有独立 outbound trace，能进 judge；但真实数据没有 decision/`spoken_kind`，S9 需要 proactive/research。等 D-7 写 `turn_offers`/job kind 后再判，不拿当前快照补 |
| M4 记忆工具矛盾 | outbox 145 / 149 | `tr-in-fx-m-219` 带 S10 | 149 先复述「之前不可用」，后说「remember_correction 保存成功」；按最后 stance 识别为 memory_write 正反矛盾 |
| 负样本 | message 437；outbox 243 | 无 S1/S4/S5；只有弱 S6 | 不判为失败 |

建议（与主程倾向一致）：

1. proactive outbox **不挂到最近入站**，各自成 `tr-out-*`；这样 233 的正文不会污染 419 的 trace，覆盖账也能单独记 `outbound_traces`。
2. S7–S10 阈值与词表**不改**；上面的偏差写进本文件，judge 看到的是真实信号，不是为金标造出来的信号。
3. 真实 #2/#3/#13 的旧金标期望应改成「INSUFFICIENT/由 judge 结合上下文判」，不能要求 D-3 强行打 S8/S10/S7。
4. 等 D-7 落地 `turn_offers`/`turn_tools` 和 job kind 后，S9 可以从当轮记录取 `spoken_kind`；在那之前 outbound trace 的 `tools_offered="unknown"`、`decision` 缺省是正确行为。
