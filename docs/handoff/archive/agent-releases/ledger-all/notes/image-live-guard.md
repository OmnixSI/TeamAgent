# 生图假回执根因与修复（2026-11-14 19:20–19:30 Sydney）

## 结论（先看这 4 行）

1. **根因是 (a) 模型编文字，不是发送没投递。** 19:19:18 的「[图片] 画好了…」是 outbox `chat-v-…665` 的纯文本（msg_type 0），本轮没有 generate_image 调用。
2. **证据链：** 该轮没有 research job；`image_gen_log` 0 行；`generated_images` 0 行；没有 `~g` outbox；`tool_calls` 无 generate_image。`image_gen_log` 只在工具被调用时先写 pending，空表即工具没跑。
3. **图片发送链路正常。** 19:17:18 自测图、19:20:14 自画像都真实发出（outbox `~g` sent、attempts http 200），用户随后说「你现在能生图了是吧」「你这图也不对啊」「你把你自己画的这么人畜无害」。
4. **修复已上线。** PR #54 squash → main `d3b8bcc`；Worker `7f56afe4-155e-4251-8061-559e772611e0`；回滚点 `97cd5696-ccb2-4c60-847e-6a71175a59df`（`750a2e4`）。

## 关键证据（只读 D1，19:25 查询）

| 项 | 值 |
|---|---|
| 入站 665 | `2026-11-14T16:18:33+08:00`「你自己拟定卡特龙的形象」 |
| 入站 666 | `2026-11-14T16:18:54+08:00`「画一个卡特龙吃子弹」 |
| 假文本行 364 | `chat-v-ROBOT1.0_…665`，body 以 `[图片] 画好了` 开头，status `sent` |
| 假文本行 365 | `chat-drain-666`，body「上面那张就是我的印象版…」，status `sent` |
| 这两个 id 的 attempts | http 200、code 空（普通文本通道，不是 msg_type 7） |
| 同轮 research job | 无（jobs 里 665/666 只有 chat/chat-drain） |
| `image_gen_log` | 0 行 |
| `generated_images` | 只有两条 selftest 手工行（rowid 1、2） |
| `~g` outbox | 只有 358、366 两条 selftest |
| 真图 358 | 19:17:18 sent，http 200；用户 19:17:49 问「你现在能生图了是吧」 |
| 真图 366 | 19:20:14 sent，http 200；用户 19:20:55 说「你把你自己画的这么人畜无害」 |

## 修复内容（7 files, +190/−6）

- `src/reply-finalize.ts`：新增第 ④ 道收口。文本出现 `[图片]/画好了/这张补上/上面那张就是` 且本轮 `imageGenerated=false` 时：
  - 群友原话是明确画面请求 → 用原话直接补调 `generate_image`；
  - 补图成功 → 保留原话（此时图是真的）；
  - 补图失败 → 改成「刚才那句不算：这一轮没有真的把图发出去（原因）。你再说一句要画什么，我重画。」
  - 「画饼/图表/架构图/你单独发图」不会误触发生图。
- `src/semantic.ts`：`finalizeOptions` 传入 `acceptedActions` 里 generate_image 的成功状态，以及确定性重做回调；直答和工具两条路径都接上。
- `src/tools/generate-image.ts`：`queued()` 返回 `accepted:true`，让收口能识别「本轮真的排了图」。
- `src/stickers.ts` + `src/imagegen.ts`：生成图发送成功时把 QQ 返回的消息 id 写进 `outbox_attempts.code`（`id:…`），冒烟可核对「id 存在、无错误码」；表情/文本通道不变。

## 验证

- `npm run check` 绿。
- `node --test test/reply-finalize.test.mjs` 17/17；图片/表情/发送套件 42/42。
- 真实消息回放：`你自己拟定卡特龙的形象` + 模型只回 `[图片]画好了` → 代码补 1 张图、生成 `~g` outbox、QQ 发送 0 次。
- 合并后 main 全量：**2215 tests / 2205 pass / 0 fail / 10 skip**（`d3b8bcc`）。
- 上线 `verify:release`：Live release `d3b8bcc0ca9a929b9a57e8f14437555b48be5a76`，`/health` 与 selfCard 同值。

## 真群复验（待 240s 被动窗口）

- 部署完成 19:29:23；最后一条真人消息 16:24:34+08（19:24:34），19:29:41 已 307 秒，超窗。
- 计划：下一条真人消息出现后的 240 秒内，只发一张图（新去重键 `selftest:image:portrait-2026-11-14b`，复用已缓存的 768² 自画像，不再花钱），核对 `outbox.status=sent`、`outbox_attempts.http_status=200`、`outbox_attempts.code=id:…`；通过后再发 `release-notice:image-gen-2`「我会画画。」，并补一条口语更正。
- 没有在超窗时插注定 skipped 的行，没有发任何群消息。

## 回滚

```bash
export CLOUDFLARE_API_TOKEN="$(cat <vault 文件>)"
cd /Users/yanghongming/Projects/.worktrees/TeamAgent-maincheck
node_modules/.bin/wrangler rollback 97cd5696-ccb2-4c60-847e-6a71175a59df
```

## 真群复验结果（19:31 Sydney）

- 19:29:48 真人消息 rowid 685（小红书链接），19:30:14 在窗口内插入 `selftest:image:portrait-2026-11-14b~g`，复用已缓存的 768² 自画像（不再花钱）。
- 19:31:13 发送完成：`status=sent`、`http_status=200`、`outbox_attempts.code=id:ROBOT1.0_KEXCpSHwpI7Cy8muYXjfhEaCha.wT17EdXY4tLcpMiDFandYaUV2v.xjziwcJethPeY015Ojj4eLxfYcxDze3g!!`。
- **核验口径：QQ 返回的消息 id 存在且没有错误码。** 这次不是拿 sent/200 当通过。
- 按交办追发 `release-notice:image-gen-2`「我会画画。」（纯文本，无 msg_id，主动消息）。
- 没有发更正：「我现在可以画图了」这条公告本身是真的（图确实能画、能发）；不实的是 19:19 那条具体的「画好了」回执，已由代码拦截。
- 19:31:35 `release-notice:image-gen-2`「我会画画。」发送完成：`status=sent`、`http_status=200`。未发更正（公告本身为真）。
