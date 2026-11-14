# 「图+文字同条」假设复核 + 强制补画（2026-11-14 19:32–19:38 Sydney）

## 结论

**假设不成立：19:19 那条不是「图被丢、只剩文字」，而是根本没有图片。** outbox rowid 364（`chat-v-…665`）**没有 outbox_meta**，不是 `~g` 行；`generated_images` 只有 2 条手工自测图（rowid 1、2）；`image_gen_log` 0 行；`openai_usage(image_gen)` 0 行；`quota_reservations` 0 行；该轮没有 research job。模型只是写了 `[图片] 画好了…` 这段文字。

**发送层本来就是图文分开的。** 图片走 `msg_type=7` + `media.file_info`，请求体不带 `content`；文字走独立 outbox 行、`msg_type=0`、独立 `msg_seq`。按 `msg_id` 分组检查 40 条出站，`msg_seq` 0 组重复，同一 `msg_id` 最多 2 条回复（QQ 被动回复上限 5）。官方文档：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html>、<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html>。

**真正的问题是模型漏调 generate_image。** 19:32:35 用户明确说「你把你的奶娃形象画出来发群里」，19:35:22 又说「画一个会数学的奶娃」，线上都只回了「没图/没拿到回执」，`image_gen_log` 仍为 0。

## 修复（PR #55，main cc7efc3）

- `src/reply-finalize.ts`：`isImageRequest` 收紧为「画/生成 + 量词」或「画/生成/拟 + 形象/头像/海报…」，排除画饼、图表、架构图、别画、画个屁。
- 本轮没有 `generate_image` 成功记录、且用户明确要图 → 用群友原话直接补调一次；成功后文字只留「画好了，图单独发。」，图片仍走独立 `~g` 消息。
- 本轮已经调过 `generate_image` 但失败 → 不再花第二次钱；模型说「画好了」仍改成实话。
- 新增 semantic 回放：真实原话「你把你的奶娃形象画出来发群里」+ 模型只回「这次还是没图」→ 补 1 张图、文字改成「画好了，图单独发。」；「别画了/画饼/画个屁」0 次；已尝试失败不重复调用。

## 验证与部署

- `npm run check` 绿；`npm test` **2219 / 2209 pass / 0 fail / 10 skip**。
- 合并 `cc7efc3`（PR #55）；Worker `361cb335-0342-45e2-bc61-92d7b4956ac1`；`/health` 与 selfCard = `cc7efc3`。
- 回滚点：`7f56afe4-155e-4251-8061-559e772611e0`（`d3b8bcc`）。
- 发送层肉眼级证据沿用 19:31 自测：`selftest:image:portrait-2026-11-14b~g` sent/200，`outbox_attempts.code=id:ROBOT1.0_KEXC…`，无错误码。

## 未完成

- 强制补画的真群现场验证：部署 19:36 完成，用户最后一条绘图请求 19:35:22 已被旧 Worker 处理；需要下一条真人绘图请求出现后，查 `image_gen_log` 新增行、`~g` outbox 和 `outbox_attempts.code=id:…`。没有伪造入站消息。
