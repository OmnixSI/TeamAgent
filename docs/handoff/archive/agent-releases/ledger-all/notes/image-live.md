# 生图线上有界自测（2026-11-14 19:06–19:22 Sydney）

执行：交付员（DeepSeek）· 线上 Worker `20220a1`（D-emoji2 之后、C2 已含 F8 生图）· D1 `42e95fb2-16f8-46d9-bf32-34f3e88a4443`
边界：只读核对 + 一次 owner 自检（真实 OpenAI 调用）+ 一次 settings 修正；未写 `outbox`、`generated_images`、`image_gen_log`、`openai_usage`、`quota_reservations`，未发群、未部署、未动游标/入站记录。


## 19:22 更新（并发直连会话完成发送；真实入站路径发现 P0）

- **发送已完成（不是本线程插的行）。** 另一条直连会话在 19:17:00 / 19:20:04 各插了一条手工自测图：
  - `selftest:image:2026-11-14~g` → `sent`，`attempts.http_status=200`（19:17:18）
  - `selftest:image:portrait-2026-11-14~g` → `sent`，`attempts.http_status=200`（19:20:28）
  - `generated_images` 2 行，均 768×768 / 28,273 B、29,721 B，`sender_id=selftest`；没有 `image_gen_log` / `openai_usage` / `quota_reservations` 行（**三表未 +1**，手工路径绕过了工具审计）。
- **公告已发两条**：`release-notice:image-gen`（19:18:39，正文「我现在可以画图了，直接说『画一张……』」）和 `release-notice:image-gen-portrait`（19:21:24，正文「我会画画。」）。两条都**没写真实限额**（5 张/人/天、20 张/群/天、全局 $3/天），与主程要求的「文案按真实限额」不符；消息已发出，无法编辑。
- **监视器已按要求写好并启动一次**：`/Users/yanghongming/Projects/.agent/releases/ledger-all/notes/image-watch.mjs`（从 `.agent/tmp` 运行）。它有 15s 只读轮询、240s 窗口判断、只插一次、行内最多等 5 分钟、4 小时硬上限；启动后先查去重键，发现 `selftest:image:2026-11-14~g` 已 `sent`，立即退出 0，**没有留后台进程**。停止方法：若以后后台运行，`pkill -f image-watch.mjs`，或等 4 小时上限；本轮无 PID（已退出）。
- **真实入站「画一张…」的 P0（比模型默认值严重）**：19:18:54「画一个卡特龙吃子弹」、19:19:17「你来画一个你认为的卡特龙形象」都走了正常 `chat-*` 任务并 `done`，但：
  - `turn_tools` 没有任何 `generate_image` 调用；
  - `image_gen_log` 0、`openai_usage` 0；
  - 机器人在 19:19:18 用一条**纯文字**回「[图片] 画好了…」，随后自己在群里承认「上一轮我只甩了字，图没真出，我的锅」「图确实没发出去，这次还是只走了文字」。
  - 结论：**代码路径是对的（`generate_image` → `src/imagegen.ts`），但模型没有调用工具**；用户会被告知「画好了」却收不到图。这是 P0，需要主程/测试员从工具调用/提示词/模型行为修，不是改 `imagegen:model` 能解决。
- **模型默认值确认（主程问的）**：真实路径 `src/imagegen.ts:7 IMAGE_MODEL='gpt-image-2.5-flare'`，且读 `settings.imagegen:model`（现已同值）；`generate_image` 工具在 `20220a1` 的 `src/tools/index.ts` 已注册、`extraToolDefs` 无条件下发。**不存在真实路径回退到已下线的 `gpt-image-1`**；`gpt-image-1` 只出现在 `src/imagegen-selftest.ts:10` 的自检默认值，本轮已用 settings 覆盖。故这不是 P0 的根因。

## 结论

1. **线上 `OPENAI_API_KEY` 有效。** `GET /api/team/imagegen/selftest`（owner）HTTP 200：
   `{"ok":true,"latency_ms":4622,"bytes":38456,"width":1024,"height":1024,"model":"gpt-image-2.5-flare"}`。
   `wrangler secret list` 7 个名字齐全（含 `OPENAI_API_KEY`，只看名字）。
2. **自检第一次 502 的根因是模型默认值陈旧，不是密钥。** 线上没有 `imagegen:model`，`src/imagegen-selftest.ts:10` 的 `DEFAULT_MODEL='gpt-image-1'`（已下线），真实生成路径 `src/imagegen.ts:7` 用的是 `gpt-image-2.5-flare`。已把线上 settings `imagegen:model` 置为 `gpt-image-2.5-flare`（与代码默认一致），第二次自检通过。这是一次线上 settings 写，已读回。
3. **19:12 当时真群「发一张生成图」无法完成，卡在 QQ 被动回复 240 秒窗口，不是密钥/生图代码。**（后续并发直连会话在 19:17/19:20 完成发送，见上。）
   - `src/stickers.ts:113`：`passive = source && o.msg_id && now - source.ts < 240000`；不满足直接 `skipped`，不会发。
   - `src/worker.ts:1195`：Worker 定时扫 `~g` 行时，用 `outbox.msg_id` 去 `messages` 找源消息 ts；找不到或超 4 分钟即跳过。
   - 19:12 核对：群里最后一条真实消息是 `2026-11-14T16:02:20+08:00`（= 19:02:20 Sydney），已过 9 分 46 秒，超出窗口。
   - 因此现在插 `selftest:image:2026-11-14` 只会在一分钟内被标 `skipped`，既发不出去，也会留下假成功/垃圾行；按要求**没有插**。
4. **图片由 Worker 发出，`~/.inkboard-team/qq.log` 不会出现发图记录。** qq.log 只记本机 QQ 网关；`sendGeneratedImage` 在 Worker 的 outbox cron 里直接调 QQ API（`src/worker.ts:1245`），证据应看 `outbox.status=sent` + `outbox_attempts.http_status=200`，不能等 qq.log。
5. **19:12 时未发公告**（符合「验证通过才发」）；后续并发直连会话在 19:18/19:21 已发两条，见上。

## 线上状态（19:12）

| 项 | 值 |
|---|---|
| `/health` release | `20220a1ea570cef215abc5f98c5bafc2fe3e06ec` |
| `settings.off:image_gen` | `0`（功能开） |
| `settings.off:openai` | 无行（总开关未关） |
| `settings.imagegen:model` | `gpt-image-2.5-flare`（本轮写入） |
| `generated_images` / `image_gen_log` / `openai_usage(image_gen)` | 0 / 0 / 0（本轮未写） |
| `outbox` 里 `selftest:image*` / `release-notice:image-gen` | 0 / 0 |
| 游标 | `chat_cursor=450`，群游标 `659` = 消息总数，未变 |
| 最新群消息 | `16:02:20+08:00`（19:02:20 Sydney），id `ROBOT1.0_uMj7bSoGmOazRMZniW.yT...` |

## 已试过的两条路

- **A. 直接插 outbox 指向最新真实消息**：会被 `passive()` 立刻判 `skipped`（9 分 > 4 分）；改 `messages.ts` 既污染入站记录，也不解决 QQ 侧按真实消息时间判被动回复的时限。
- **B. 用自检端点拿图再入队**：自检只返回尺寸/字节数，不返回 JPEG；且自检刻意不写 DB。要拿图必须另做一次真实生成（约 $0.012），仍绕不过 A 的 240 秒窗口。
- 未采用的近路：往 `messages` 插一条伪造入站再发——QQ 侧 `msg_id` 不是真实用户消息会被拒，且违反「不动入站记录」。

## 修法（需要主程/架构师定，不是本轮能部署的）

1. **产品修法（推荐）**：`sendRichMedia` 对 `~g` 行在被动窗口错过时，允许改为主动消息（不带 `msg_id`，受 QQ 主动消息日配额限制），或至少给请求者回一条文字说明「图生成好了但超出回复窗口，请再说一句」；现在是静默 `skipped`，用户永远不知道。
2. **流程修法（不改代码）**：真实群里下一条消息出现后的 4 分钟内，再跑一次「生成 → `generated_images`/`outbox_meta` 入队 → Worker 发送」，并核对 `outbox.status=sent`、`attempts.http_status=200`、三表各 +1。需要有人在消息到达时触发；本机无人值守时可用一次性的谷时/消息后检查，但不能预插一条注定 `skipped` 的行。
3. **P2 代码债**：`src/imagegen-selftest.ts:10` 的 `DEFAULT_MODEL` 应改为引用 `imagegen.ts` 的 `IMAGE_MODEL`，避免 settings 被清后自检再次 502（本轮已用 settings 绕过）。

## 花费

- 自检一次：代码估 `estCostMicroUsd=11000–16000`（low 1024²），约 **$0.011–0.016**；自检按设计不写 `openai_usage`，实际账单以 OpenAI 为准。
- 没有第二次生图、没有重试、没有群消息。
- 自检端点每小时 2 次：本轮已用 2/2（一次 502 模型错、一次 200），下一次自检要等下一个小时或重新部署。

## 下一步（给主程）

- 若同意「主动发送兜底」，我按 release-ship 开一个最小 PR（`stickers.ts`/`imagegen.ts` + 测试），走一次集成后上线，再用 `selftest:image:2026-11-14` 完成真群发图并把公告 `release-notice:image-gen` 发出。
- 若不改代码，等真实群消息后 4 分钟内叫我一次，我用同一去重键完成 sent + 三表 +1，再发公告。
