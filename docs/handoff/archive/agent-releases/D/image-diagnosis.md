# 图片读取断点诊断（2026-11-14）

- 诊断时间：2026-11-14 17:24 Sydney（14:24 北京）
- 线上 Worker：`8c768b1`（`/health`，built 2026-11-14T05:15:09Z）
- 代码对照：`8c768b1` 与当前 main `0a16658` 在 `src/vision.ts`、`src/worker.ts`、`src/context.ts`、`src/view.ts`、`src/imagecache.ts`、`config/team.json` 无 diff
- 结论：**4 张图都收到了、都缓存了、URL 现在仍能下载；没有识图结果，是因为识图没有被触发，不是收图/下载/开关/额度问题。** 14:18 引用 499 后识图成功，证明链路和 provider 正常；14:21 再引用 500 时又失败，第二个断点是 `quoted.media` 没有进入 `pickImages`。
- 只读约束：全部 D1 访问为 SELECT（每次 `meta.rows_written=0`）；未调用任何发送接口；未往群里发消息。

---

## 1. 四张图清单（消息 497–500）

| # | rowid | 发送时间（北京） | 发送人 | 段类型/格式 | 尺寸 | 字节 | 接收时下载/缓存 | 识图 job | image_notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 497 | 14:15:46 | t.o.o. | image / jpeg | 80×80 | 1,647 | 14:15:52，data=1,647 | 无 | 无 |
| 2 | 498 | 14:15:47 | t.o.o. | image / jpeg | 80×80 | 1,661 | 14:15:55，data=1,661 | 无 | 无 |
| 3 | 499 | 14:15:47 | t.o.o. | image / jpeg | 80×80 | 1,538 | 14:15:57，data=1,538 | 14:18:17（被引用后） | 有，14:18:17 |
| 4 | 500 | 14:15:48 | t.o.o. | image / jpeg | 80×80 | 1,531 | 14:16:01，data=1,531 | 无 | 无 |

补充：

- **URL 可下载**：17:22 Sydney 复测四条原 URL，均 HTTP 200，返回字节分别 1,647 / 1,661 / 1,538 / 1,531，与缓存 `bytes` 完全一致。
- **不是 GIF**：四条 `content_type=image/jpeg`，不是 gif。
- **段类型**：relay 已归一化为 `media.kind=image`；`message_meta` 没有保存 QQ 原始 `subType`，所以无法从现有数据区分 `image` 还是 `mface`。四条同时被 `stickers` 表收集（`state=0`、`desc` 为空），形态上是 80×80 的表情/头像小图。
- **完整消息 ID**：

```
497  ROBOT1.0_uMj7bSoGmOazRMZniW.yT1Ey0R3ERr6bJ6.R1dxTY22UfE36cK6wyuj92PPjRfO-A52IJuy.ASJdmg3Q89nYaefc9CcD.q-wjum3kSu84kM!
498  ROBOT1.0_uMj7bSoGmOazRMZniW.yTxjsL3EEDQoqjQQl3X2pfmnVbeXq6jv7UW026RTD6swkHJLQGD1WIIuvZB.jNDkENcWcH0kJro5L90MMgcfbEAE!
499  ROBOT1.0_uMj7bSoGmOazRMZniW.yTzopKmDi-o7PcsHBo7XeCknyoyD0d7mVegbyMC5o9CdJZkJUi7W9NyqGc83NOwJrhOfc9CcD.q-wjum3kSu84kM!
500  ROBOT1.0_uMj7bSoGmOazRMZniW.yTxv883V0OpK10HyPEepp0wWv-J1t84vzapdpRn4okY9DoB0.pE6kVXFpGnKCW6Xl0ufc9CcD.q-wjum3kSu84kM!
```

缓存行（`image_cache`，`data` 均非空；`sha` 是 URL 的 sha256）：

| rowid | cache sha（前 12） | 缓存时间 | bytes | data | skipped/error |
|---|---|---|---|---|---|
| 497 | `532f1523c61a` | 14:15:52 | 1,647 | 1,647 | 无 |
| 498 | `532afbb4cc31` | 14:15:55 | 1,661 | 1,661 | 无 |
| 499 | `319b630075c8` | 14:15:57 | 1,538 | 1,538 | 无 |
| 500 | `a358c812a70b` | 14:16:01 | 1,531 | 1,531 | 无 |

---

## 2. 每张图的断点

### 497 / 498：断在「识图触发」，不是收图

- 入站解析成功：`message_meta.media[0].kind=image`，`content_type=image/jpeg`，80×80，URL 完整。
- `image_cache` 成功：14:15:52 / 14:15:55 落库，`length(data)=bytes`，没有 `skipped_reason` / `error_kind`。
- 识图没有发生：`jobs` 表在这两条上只有 `sticker`、`image_cache`、`chat`，**没有 `chat-v-` job**；`message_images` 没有 497/498 的链接，`image_notes` 没有内容。
- 原因：14:16:11 的 `chat_decisions` 批次是 `[497,498,499,500]`，`latest_id=500`，这批四条 `mentioned=0`、`body` 全空、没有 `replyTo`。`pickImages()` 在 latest 上找不到 `mentioned/asksImage/replyTo bot/问句`，`batch` 回扫也因 `mentioned || asksImage` 为 false 而不执行，`picks=[]`；`worker.ts` 没有 `coldPicks` / `annotateTurn`，所以连识图 job 都不会建。

### 499：第一次同样没触发；14:18 被引用后才成功

- 14:16:11 批次里 499 同样没有识图；14:18:10 Souvereign 引用 499 并 @bot（消息 511），`replyTo.kind=member`、`targetId=499`，`refRows` 命中，`pickImages` 从 target 取到 499 的图。
- 14:18:17 `chat-v-...Fbprko612...` job 写入 `imageOutcomes: [{messageId:499, idx:0, stage:"link", status:"ok"}]`；14:18:17 `image_notes` 写入 `sha=a8259fd89265...:deepseek:deepseek-flash:v1`，描述为「圆形黄色表情，弯弯笑眼，粉色脸颊，嘴角伸出红色舌头」。
- 结论：**缓存、URL、DeepSeek 识图、image_notes 链路都正常**；499 只是被引用后才补上识图。延迟约 2 分 30 秒。

### 500：第一次没触发；14:21 再次被引用仍失败

- 14:16:01 缓存成功（1,531 B）。
- 14:16:11 批次里 500 是 `latest`，但 `mentioned=0`、body 空、没有问句、没有 `replyTo`；`pickImages` 不会为「未被点名的 latest 图片」取图，`picks=[]`。
- 14:21:37 Souvereign 引用 500 的同一张图（消息 518，filename `1FB8C0BC...jpg`，80×80，1,531 B），正文「你个蠢货，这是我现在的表情\n你再看看你明明能读图的」；但这条的 `replyTo.kind="unknown"`、`replyTo.text=""`、`media=[]`，图片只在 `quoted.media`（和 `forwarded[0].attachments`）里。
- `pickImages` 不读 `meta.quoted.media` / `meta.forwarded`；`replyTo` 没有 `targetId`，`refRows` 也没有目标。14:21:57 的 `chat_decisions` 批次 `[518,519]`，`mentioned=1`、`action=reply`，但没有 `chat-v-` job；bot 回复「你新发这张我这儿只有下载链接、没识图结果，画面真没进来，不是装瞎」。
- 结论：**第二个断点是引用图（quoted / forwarded）没有接入识图取图。** 499 能读是因为引用带了 `targetId`；500 的引用是 `kind=unknown`，只落在 `quoted.media`，代码没取。

---

## 3. 链路逐步证据

### 3.1 入站与缓存（全部成功）

- `message_meta` 497–500 都有 `attachments[0]` 和 `media[0]`：`kind=image`、`content_type=image/jpeg`、`width=80`、`height=80`、`size` 分别为 1,647 / 1,661 / 1,538 / 1,531。
- `image_cache` 四条都有 `data`，`length(data)=bytes`；`skipped_reason`、`error_kind`、`error_stage` 全为 NULL。说明接收时下载成功，没有 QQ 域名 403、没有超时、没有 1.5MB 超限。
- 四条的 `source_msg` 分别对应 497/498/499/500，`source_idx=0`。

### 3.2 识图触发（断点）

- `jobs` 在 14:15:47–14:16:01 只有 `sticker`、`image_cache`、`chat`；**14:16 没有 `chat-v-` job**。
- 唯一一条相关 `chat-v-` job 是 14:18:17 为消息 511（引用 499）创建的。
- `chat_decisions` 14:16:11：`latest_id=500`，`batch_ids=[497,498,499,500]`，`mentioned=0`，`action=reply`，`model_ms=9118`，outbox 正文「头像收了，但我这边只看到四个80×80的方框，画面完全看不见，等于给我发了四块砖……」。
- `chat_decisions` 14:16:31：`latest_id=502`，`batch_ids=[501,502]`，`mentioned=1`，outbox 正文「画面还是没进来，我这边只有四个80×80的砖……」。
- 14:16:31 这一批没有图片（501/502 都是文字），所以即使 `mentioned=1`，`pickImages` 也没有任何图片可取；图片 497–500 已经在上一批被 cursor 推走，后续批次不会回看。

### 3.3 上下文里模型看到的

- 没有 note 的图片，`src/view.ts:118` 渲染为 `"图片 " + width + "×" + height`，即「图片 80×80」；只有 note 才渲染描述（`src/view.ts:115-116`）。
- 因此模型在 14:16 看到的是四条「图片 80×80」，不是四张图的内容；它说「四个 80×80 的方框/四块砖」与证据一致。
- 如果 picks 有值但识图失败，`src/view.ts:117` 会渲染「图片（未分析：没有可用结果，原因未记录）」；本次没有出现这句，反过来证明 `picks=[]`，不是「识图调用失败」。

### 3.4 为什么 499 能读、500 不能

- 511 引用 499：`replyTo.kind=member`，`targetId=499`；`worker.ts:811-820` 把引用目标放进 `refRows`，`pickImages` 的 `target` 分支取到 499，识图成功。
- 518 引用 500：`replyTo.kind=unknown`，没有 `targetId`；图片只在 `quoted.media`/`forwarded`。`pickImages` 只读 `metaOf(latest).media`、`refRows` 和当前 batch，不读 `meta.quoted.media`，所以 500 仍取不到。
- `src/inbound.ts:68-72` 其实已经解析了 `quoted.media`，但 `src/vision.ts:406-461` 没有使用它；这是第二个可独立修复的断点。

### 3.5 bot 的回复时间线

| 时间（北京） | 事件 | 证据 |
|---|---|---|
| 14:15:46–48 | 4 张图到达 | `messages` 497–500 |
| 14:15:52–14:16:01 | 4 张全部缓存 | `image_cache` 4 行，data=bytes |
| 14:16:11 | bot 说「四个 80×80 的方框/四块砖」 | `outbox` / `chat_decisions` |
| 14:16:31 | bot 重复「画面还是没进来」 | `outbox` |
| 14:18:10 | Souvereign 引用 499 并问「描述一下这是什么」 | `messages` 511，`replyTo.kind=member` |
| 14:18:17 | 499 识图成功并落 note | `chat-v-` job + `image_notes` |
| 14:18:28 | bot 描述 499，并说「剩下仨还是 80×80 的砖」 | `outbox` |
| 14:21:37 | Souvereign 引用 500 的同一张图并说「你明明能读图的」 | `messages` 518，`replyTo.kind=unknown`，`quoted.media` 有图 |
| 14:21:57 | bot 说「只有下载链接、没识图结果」 | `outbox`；无 `chat-v-` job |
| 14:23:50 | t.o.o. 再发 300×300 image/gif（1,038,935 B） | `messages` 523；14:23:54 缓存；14:24:09 `stop`，未识图 |

---

## 4. 根因

**根因是识图取图范围过窄，不是收图、下载、开关或额度。**

### 4.1 只取「当前批次 + replyTo.targetId」，不回看上一批

`src/vision.ts:406-461` 的 `pickImages`：

- 只有 latest 满足 `mentioned`、`asksImage`、`replyTo.kind === "bot"`、或正文含问句时，才取 latest 自己的图片（`src/vision.ts:435-443`）。
- 其他批次图片只有在 `mentioned || asksImage` 时才回扫（`src/vision.ts:455-460`）。
- 任何情况下都不看 `recent`；`src/context.ts:23-32` 的 `loadBatch` 只取当前 cursor 后的全部行，图片被上一批 cursor 推走后，下一批 text 不会把它们带回来。
- 本次 4 张图的批次 `[497-500]` 四条都没有 `mentioned`、没有正文、没有 replyTo；带 @ 的 502 在下一批 `[501-502]`。两批之间没有 carry-over，所以 `picks=[]`。

### 4.2 `quoted.media` / `forwarded` 没有进入 pickImages

- 518 的图片在 `quoted.media`（`src/inbound.ts:68-72` 已解析）和 `forwarded[0].attachments`；`media=[]`，`replyTo.kind=unknown` 没有 targetId。
- `pickImages` 不读 `quoted.media`/`forwarded`，`view.ts:140` 的引用展示也只放 `quoted.text`，图片只以 `quotedUrls` 链接形式出现在上下文（`src/view.ts:145`）。
- 所以 bot 看得到「下载链接」，看不到图；这解释了 14:21:57 的「只有下载链接、没识图结果」。

### 4.3 `turn_max=3` 是次级限制

- `config/team.json:105`：`vision.turn_max = 3`；`worker.ts:835-841` 传给 `pickImages`，`pickImages` 末尾 `slice(0, max)`（`src/vision.ts:461`）。
- 即使 502 和四张图在同一批，`pickImages` 最多取 3 张（按 batch 倒序取 500、499、498），497 仍会被丢掉。当前故障是 `picks=[]`，所以这一条不是本次的直接原因，但修完触发逻辑后必须一起处理，否则「4 张图」永远有一张读不到。

### 4.4 排除项

| 可能原因 | 证据 | 判定 |
|---|---|---|
| 没收图 / URL 过期 / QQ 403 | 4/4 `image_cache` 有 data，bytes 与源一致；17:22 复测 URL 全部 200 | 排除 |
| 识图开关关闭 | `settings` 无 `off:vision`；`config/team.json` `vision.enabled=true` | 排除 |
| 识图额度用尽 | `vision.daily_cap=300`；`budget:vision:2026-11-14=2`；两条成功 note | 排除 |
| provider 不可用 | 499 在 14:18:17 由 `deepseek/deepseek-flash` 成功描述 | 排除 |
| 识图结果没进上下文 | 499 的 note 在 14:18:28 被模型正确使用；`context.ts:120` 会注入 | 排除 |
| bot 看到了却说读不了 | 模型看到的是 `图片 80×80`（`view.ts:118`），没有 note；不是装瞎 | 排除 |

---

## 5. 近 3 天图片消息识别统计

统计范围：2026-11-11 14:00 至 2026-11-14 14:24（北京），`messages` 中 `message_meta.media` 含 `kind=image` 的顶层图片，共 **15 条**。不把 14:21 的引用（消息 518）重复计为新图片。

### 5.1 按天

| 日期 | 图片数 | 有 note（成功） | 成功率 |
|---|---:|---:|---:|
| 2026-11-12 | 4 | 0 | 0% |
| 2026-11-13 | 3 | 0 | 0% |
| 2026-11-14 | 8 | 2 | 25.0% |
| **合计** | **15** | **2** | **13.3%** |

### 5.2 按原因

| 原因 | 数量 | rowid |
|---|---:|---|
| 识图成功 | 2 | 477, 499 |
| 跨批次未触发（图片在前一批、@/问句在后一批；`pickImages` 不回看） | 5 | 304, 475, 497, 498, 500 |
| 识图抓图失败（`stage=fetch, reason=network`） | 1 | 383 |
| 图片单独到达、无人追问（按设计不烧识图） | 7 | 294, 307, 325, 387, 462, 480, 523 |
| **合计** | **15** | |

### 5.3 不同分母下的成功率

| 分母 | 数量 | 成功 | 成功率 |
|---|---:|---:|---:|
| 全部图片消息 | 15 | 2 | 13.3% |
| 有明确 @/引用/问句（addressed） | 8 | 2 | 25.0% |
| 已缓存（`image_cache.data` 非空） | 8 | 2 | 25.0% |
| 实际产生识图 outcome 的 job | 3 | 2 | 66.7% |

补充：

- 已缓存的 8 条全部下载成功（`data=bytes`），**下载失败 0 条**。
- 唯一一次识图抓图失败是 383（11-13 07:50:24，`stage=fetch, reason=network`），发生在 `image_cache` 功能上线前；当前缓存路径已能避免这类 URL 过期。
- 11-12 的两条 `chat-v` job（304/305）`imageOutcomes=[]`，没有真正发起识图调用，因此不计入「实际 outcome」分母；它们对应的是「图片在外层、追问在下一批」的同类问题。
- 14:21 的引用请求（518）不在这 15 条内；如果把它算作一次 addressed 识图请求，addressed 分母是 9，成功率 2/9=22.2%。

### 5.4 近 1 小时内的其他图片（不属于这 4 张）

- **480**：14:09:05，1920×1080 JPEG，118,358 B；14:09:12 缓存成功；14:09:25 `chat_decisions` 判断「刚发了一张图没配文字，也没@我，先等他补说明」→ `stop`；无 note。
- **523**：14:23:50，300×300 `image/gif`，1,038,935 B；14:23:54 缓存成功；14:24:09 `chat_decisions` 判断「最新只发了张表情图，没人点我」→ `stop`；无 note。GIF 识图能力未验证。

---

## 6. 修复建议

### P1（用户可见，建议进 D 版）

1. **跨批次补图**（修 497/498/500、475、304 这一类）
   - 在 `src/vision.ts:406` 的 `pickImages` 增加 `recent` 输入；当 latest 被 @/有问句/是引用追问时，除了当前 batch，还扫描最近 N 条（建议 10 条或 5 分钟）中「有 image_cache、没有 message_images/notes」的图片。
   - 或在 `src/worker.ts:835` 之前，当 `picks=[]` 且 latest addressed 时，补一次 `SELECT ... FROM messages JOIN message_meta ... WHERE rowid > cursor-10` 的轻量回看；只取未标注过的图，避免重复烧识图预算。
2. **引用图接入**（修 518/500 这一类）
   - `pickImages` 增加 `quoted.media` / `forwarded[].attachments` 分支；当 latest 的正文含「图/表情/照片 + 看/读/描述」时，即使 `replyTo.kind=unknown`，也从 `quoted.media` 取图。
   - `message_images` 的 `message_id` 用被引用消息的 id（能从 `refMsgIdx`/`message_refs` 解析时）或 latest.id + 独立 `source_idx`，避免把 note 链到错误消息。
3. **四张上限**（修 `turn_max=3`）
   - 把 `config/team.json:105` 改为 4，或在 `worker.ts` 分两轮：先识 3 张，剩余 1 张再排一个 `chat-v` job。
   - 改大后必须压测 DeepSeek 4 路并发；80×80 小图也可能触发 provider 限流，建议 2 路并发 + 重试，或串行。
4. **回归场景**：新增 `.agent/scenarios/image-followup-mention/`，输入用本次真实消息 497–502、511、518；期望：
   - 502 到达后，497–500 至少 4 条 note（或 3+1 两轮全部覆盖）；
   - 518 到达后，被引用的 500 有 note，bot 能描述；
   - 回放中 `outbox` 新增 0 条（mock 发送），线上 D1 写入 0 行。

### P2（诊断与防回归）

5. **持久化识图事件**：`src/vision.ts:63` 目前只 `console.info("vision", ...)`；建议同时写一条 `activity` 或新建 `vision_events`（stage/status/reason/traceId/messageId/idx），否则下次只能靠 `jobs.payload` 推断。
6. **保存原始段类型**：`message_meta` 只保留归一化后的 `content_type`，没有 `subType`/`msg_elements`；建议至少存 `subType` 和 `is_gif`，否则无法区分 image / mface / 表情。
7. **GIF 策略**：523 是 `image/gif`（300×300，1.0 MB）；当前缓存成功但没有识图。需要确认 provider 是否支持 GIF，若不支持应取首帧或明确标为「表情，不描述」。

---

## 7. 限制与未验证

- 4 张图里只有 499 被真实识图并留下 note；497/498/500 从未送入 vision。它们的缓存字节完整、URL 200，但「单张能否被模型正确描述」未逐张验证。
- 没有留存 14:16 的 Worker `vision` console 日志（当时未开 `wrangler tail`）；识图是否触发的结论来自 `jobs` 表（无 `chat-v`）、`image_notes`（无行）、`message_images`（无链接）和 `chat_decisions`（batch/mentioned）。
- 本机 `qq.log` 最后只到 05:28Z 的网关连接事件，`runner.log` 只有 repo index / bridge 错误，没有图片处理或识图日志；本机日志不能补充这次链路，证据以 D1 为准。
- `subType`、`mface`、`image` 的原始区分无法从现有 D1 还原；4 条按 `content_type=image/jpeg` 计为图片，523 按 `image/gif` 计为 GIF。
- 4 路并发识图的限流/超时未测试；`turn_max=4` 的修复需要单独压测。
- 501/502 为什么落在下一批：`messages.ts` 501=14:15:52，但 `chat` job 到 14:16:01 才入队；14:15:56 的 `chat` job `loadBatch` 只看到 497–500。这是「入库/入队延迟导致分批」的推断，未拿到 relay 原始日志。

---

## 8. 只读与零发送证明

- 所有 D1 查询使用 `wrangler d1 execute ... --command "SELECT ..."`，每条返回 `meta.rows_written=0`、`changed_db=false`；没有 INSERT/UPDATE/DELETE。
- 图片 URL 只用 `curl -sS -L -o /dev/null` GET 复测，未上传、未发送。
- 未调用任何群消息/Outbox 发送接口；诊断窗口内 `outbox` 的新增行都是线上 bot 对群消息的回复（如 14:20:25、14:21:57），不是本次诊断发送。
- 本地证据文件（只读快照）：
  - `.agent/releases/D/raw/msg_490.json`、`meta_490.json`、`msg_517.json`、`meta_517.json`
  - `.agent/releases/D/raw/cache_recent.json`、`cache4.json`、`cache_after.json`、`cache_3d.json`、`cache_523.json`
  - `.agent/releases/D/raw/jobs_recent.json`、`jobs_after.json`、`vision_jobs_3d.json`
  - `.agent/releases/D/raw/decisions_recent.json`、`decisions_after.json`
  - `.agent/releases/D/raw/notes_recent.json`、`msgimg_recent.json`、`stickers_recent.json`
  - `.agent/releases/D/raw/image_msgs_3d_v2.json`
