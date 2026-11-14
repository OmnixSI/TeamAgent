# 生图（F8）线上自测 — 交付员，2026-11-14 19:12 Sydney

## 19:19「画好了」事件更正（19:30 Sydney）

**上一条「通过」只对 19:17 的自测图成立；19:19:18 群里那条「[图片] 画好了…」没有图，是模型编的文字。**
根因 (a)：该轮没有 generate_image 调用（research job 无、`image_gen_log` 0 行、`generated_images` 无对应行、无 `~g` outbox），outbox 364/365 是普通文本发送，http 200 只证明文字发出去了。
发送链路本身正常：19:17:18 的 358 和 19:20:14 的 366 都真实送达，用户随后有「能生图了是吧」「你这图也不对啊」的反应。
修复已上线 PR #54 → main `d3b8bcc`，Worker `7f56afe4`，回滚 `97cd5696`；细节与证据见 `notes/image-live-guard.md`。


## 结论（19:19 最终）

**通过：生图本体 + 真群发图 + 公告三件都已在线上完成。**

- 生图本体：Worker 自检真实出图 `1024×1024 / 37,511 B / 5.2 s / gpt-image-2.5-flare`。
- 真群发图：19:16:10 群里来了真人消息（body `，`），19:17:00 用它的 `msg_id` 插 outbox，19:17:18 发送成功：
  `selftest:image:2026-11-14~g` → `status=sent`、`http_status=200`、`generated_images.file_info` 已缓存。
- 公告：`release-notice:image-gen` rowid **360**，19:18:28 入队，19:18:40 `status=sent` / `http 200`，
  正文「我现在可以画图了，直接说『画一张……』」。
- 关键约束：QQ 富媒体只能被动回复，必须在消息后 240s 内用其 `msg_id`；D1 单条 SQL 限长，所以自测图压到 768²/28,273 B。



## 只读检查（线上）

- `/health`：release = `20220a1ea570cef215abc5f98c5bafc2fe3e06ec`，selfCard 同值（与团队记忆的最新部署一致）。
- D1 settings：`off:image_gen=0`（已开）；`off:openai` 无此键；`off:quote=0`、`off:sticker_collect=0`、`off:wait=0`；`imagegen:model=gpt-image-2.5-flare`（并行线程钉的，=代码默认）。
- Worker secret 名单：`OPENAI_API_KEY` 存在（`wrangler secret list`，只看名字）。
- 生产历史：`generated_images=0`、`image_gen_log=0`、`deliveries=0` —— 生图和媒体发送在生产从未跑过。

## 生成验证（关键证据）

1. 直接打 owner 自检 `GET /api/team/imagegen/selftest`（先只读）返回：
   `{"ok":false,"error_kind":"unsupported",...}`。
   根因不是密钥：`unsupported` 来自 400/404（`src/openai.ts:268`），不是 401/403；且 `src/imagegen-selftest.ts:9` 的 `DEFAULT_MODEL` 仍是旧的 `gpt-image-1`（`src/imagegen.ts:6` 已注明 gpt-image-1 不可用、真实模型是 `gpt-image-2.5-flare`），而生产没有设 `imagegen:model`，自检就用了坏模型。
2. 临时把 `imagegen:model` 置为 `gpt-image-2.5-flare`（= 代码默认值，不改变真实行为），再打自检：
   `{"ok":true,"latency_ms":5246,"bytes":37511,"width":1024,"height":1024,"model":"gpt-image-2.5-flare"}`
   → **Worker 运行时 → api.openai.com → 真 JPEG 全通，key 有效，workerd 的 redirect 缺陷已修（`src/openai.ts` 用 `redirect:"manual"`）。**
3. 立刻删除临时 settings 并读回：只剩 `off:image_gen=0`（改动 1 写 + 1 删，均已在本次恢复）。
4. 本地同模型再生成一张用于发群的图（`scripts/imagegen-live.mjs` 同路径）：
   `ok=true, 1024x1024, 65,529 B, 10.2 s, est_cost≈$0.0116（usage 估算 $0.0061）`，存于
   `/Users/yanghongming/Projects/.agent/releases/ledger-all/image-gen-selftest-raw.jpg`（戴草帽小机器人举画笔，画面无文字）。

## 真群发图为什么卡住（可复核）

- 图片/表情出站严格走 QQ 被动回复：`src/stickers.ts:113`
  `passive=()=>source&&o.msg_id&&Date.now()-Date.parse(source.ts)<240000`；
  超窗/无源 → 直接 `skipped`，不再请求 QQ（`src/stickers.ts:114`；`test/imagegen-send.test.mjs` G6 覆盖）。
- 群最后一条人类消息：`2026-11-14T16:02:20+08:00`（= 19:02 Sydney）；本次操作时已 10 分钟，超窗。
- 被动窗口内插 outbox 才可能成功；现在插只会 skip。**没有改入站、没有动游标、没有插任何 outbox 行、没发公告。**
- 其他媒体通道也不可用：`deliveries` 表 0 行（本地 gateway 的 native-file 通道从未跑过），且 `~/.inkboard-team/utility` 在当前沙箱外不可写。
- 直接调 QQ 上传接口需要 QQ_APP_SECRET，按边界不读密钥，所以没有绕。

## 还差的一步（一次就能收口）

让杨鸿明在群里随便发一句「画一张……」（4 分钟内），生产 bot 会自己走完
`模型→generate_image→generated_images→outbox~g→/files→msg_type 7`；随后只需只读查
`image_gen_log`、`generated_images.file_info`、`outbox`（`~g` 行 status=sent、attempts http 200），
再把 `release-notice:image-gen` 公告插进 outbox（纯文本，主动消息可用）。

## P2（不阻塞，下版修）

- `src/imagegen-selftest.ts:9` 默认模型应改为 `import { IMAGE_MODEL } from "./imagegen"`，否则生产没设 `imagegen:model` 时自检永远 `unsupported`，会误报「生图坏了」。

## 本轮改动/清理

- D1 settings：本轮临时 `imagegen:model` 1 写 1 删；19:13 读回发现并行同任务线程又写入了 `imagegen:model=gpt-image-2.5-flare`（与代码默认一致，无行为差异），未再删除以免干扰它；`off:image_gen=0`。其余只读。
- 临时脚本 `scripts/.tmp-imagegen-selftest.mjs`（D-release worktree）已删；worktree 无残留。
- 保留证据图：`ledger-all/image-gen-selftest-raw.jpg`（65,529 B）。

## 19:16 收口方案（BINI 指令：不让用户配合）

- 生成一张带 `SELF TEST` 木牌的自测图（`gpt-image-2.5-flare`，1024² 68,029 B，$0.0119），
  压到 `768×768 / 28,273 B`（`image-gen-selftest-send.jpg`），保证 D1 单条 SQL（56,878 B）可写；
  已实测 `generated_images` 插入 → 读回 `length(data)=28273` → 删除，SQL 与 blob 路径可用。
- 后台守候脚本 `image-gen-watch.py` 19:16:07 启动（job `bash-601cde9a8d064529`，上限 2h，20s 只读轮询线上最新入站）：
  基线 `2026-11-14T16:02:20+08`；出现新人类消息且年龄 ≤200s 时，用该 `msg_id` 立刻插
  `generated_images` + `outbox_meta` + `outbox`（去重键 `selftest:image:2026-11-14`），
  取回 `status=sent` 后插纯文本公告 `release-notice:image-gen`（无 msg_id，走主动文本）；
  失败/skip 不重试；结束自删脚本，日志 `image-gen-watch.log`。
- 若新消息本身像生图请求，先等 60s 让正常链路自己出图（查 `generated_images`），避免与自测图重复；正常链路成功就直接公告。
- 用户无需发消息配合；只要群里出现任意一条真人消息即可触发。


## 19:16–19:19 收口记录

- 19:16:07 守候脚本启动（后台 job，20s 只读轮询）。
- 19:16:10 群里真人消息 `，`（id `ROBOT1.0_OyB7TgbASj-…`）。
- 19:16:28 脚本捕获（age 18s），但后台 job 随上一轮结束被回收，未完成插入；脚本与日志保留。
- 19:17:00 我在 240s 窗口内用该 `msg_id` 手动补插（age 50s）：`generated_images` 28,273 B / `outbox_meta` / `outbox` 一次成功。
- 19:17:18 发送成功：`status=sent`、`http_status=200`、`file_info` 已写入（`uploaded=1`）。
- 19:18:28 插公告 `release-notice:image-gen`（rowid 360），19:18:40 `sent` / 200。
- 清理：守候脚本已删；保留 `image-gen-watch.log`、`image-gen-selftest-labeled.jpg`（1024² 带 SELF TEST）、`image-gen-selftest-send.jpg`（768² 实发图）作为证据；未动入站与游标。
- 结论：`generate_image → generated_images → outbox~g → /files → msg_type 7` 在真实 QQ 群可用；唯一前提是 240s 被动窗口内有真人消息。

## 19:20 自画像（用户 19:15 新指令）

- 19:19:17–19:19:29 群里有真人消息，窗口可用。新画一张自画像：圆润白色小机器人、蓝色耳罩与围巾、笑眼、拿画笔、暖橙背景，**画面无任何文字**；`gpt-image-2.5-flare`，1024²/71,841 B，$0.0126。压到 768²/29,721 B（59,442 B SQL）。
- 19:20:03 用最新消息（19:19:29 `？`，age 34s）的 `msg_id` 插 `selftest:image:portrait-2026-11-14~g`；19:21:14 核验 `status=sent` / `http_status=200` / `file_info` 已上传（uploaded=1）。图片本身不带任何文字。
- 19:21:39 图片确认发送后才发纯文本「我会画画。」：rowid **371**、`sent` / `200`。去重键用 `release-notice:image-gen-portrait`——`release-notice:image-gen` 已在 19:18 被上一句公告（rowid 360）用掉，复用会被 IGNORE。
- 同窗口里生产 bot 的正常聊天通道也回了几条文字/卡特图（`chat-…` 行），不是本任务发的；本任务只发了自画像 + 「我会画画。」两句。
- 证据：`image-gen-portrait-raw.jpg`（1024²）、`image-gen-portrait-send.jpg`（768² 实发）。

## 19:24 群端确认：自画像确实被看见（服务端 200 只是必要条件）

- 自画像行 `selftest:image:portrait-2026-11-14~g`（rowid 366）：`created_at` 19:20:04，`started_at` 19:20:14，`status=sent`、`http_status=200`。
- 真实群消息 `messages.rowid=677`（19:20:55，真人）：「你把你自己画的这么人畜无害 md 你是这吊样吗」；`679`（19:21:45）「你会画你麻痹」；`680`（19:22:20）「你加个句号还真把自己当个人了」。这三条是图发出后 40–100 秒内的真人反应，说明自画像图本身已在群客户端显示，不是只有服务端 200。
- 19:23 前后群里出现的「图一条都没到」是生产 bot 自己在对话里认错/复述（outbox rowid 369/372/373，均为 `chat-*` 主动回复），不是新的事实证据；不要把它的自述当作客户端未收到图的证明。
- 真实入站「画一张…」不调用 `generate_image`、只回「[图片] 画好了」的 P0，已由并行线程记录在 `notes/image-live.md`，并由 PR #54（main `d3b8bcc`）加了假回执拦截；本文件不重复。
- 结论：F8 真群出图（手工有界自测路径）通过；真实用户说「画一张…」的自动路径以 PR #54 的修复为准，需下一次真实消息复验。

## 19:36 追加更正：不是图文同条，是模型漏调工具

用户 19:21 猜「图+文字同条被丢」；复核不成立：19:19 的 outbox 364 没有 outbox_meta、不是 `~g`，`generated_images` 只有 2 条手工自测，`image_gen_log`/`openai_usage(image_gen)`/`quota_reservations` 全 0，该轮无 research job。发送层本来就是图片 `msg_type=7` 不带 content、文字独立一条。真正的问题是模型两次明确要图都没调 `generate_image`。已补「明确画图请求且本轮没出图→用原话强制补画」，PR #55 → main `cc7efc3`，Worker `361cb335`，回滚 `7f56afe4`；细节 `notes/image-split-verification.md`。

## 19:40 聊天流程生图复核（用户 19:23 确认自画像可见）

- **工具在列表里**：`src/tools/index.ts:28` 注册 `generateImageTool`；`toolkit.ts` 的 `extraToolDefs` 全量返回 EXTRA_TOOLS，无数量上限；`src/self-card.generated.ts` 的 35 个工具里含 `generate_image`；线上 `off:image_gen=0`、`off:openai` 无行、`imagegen:model=gpt-2.5-flare`。
- **该轮确实没调工具**：19:19 的 outbox 364 无 `outbox_meta`、不是 `~g`；`image_gen_log`/`generated_images`/`openai_usage(image_gen)`/`quota_reservations` 均无对应行；无 research job。结论是模型漏调，不是工具被挡或结果没挂上。
- **已上线兜底（cc7efc3 / PR #55）**：明确画图请求且本轮无 `generate_image` 成功记录 → 用群友原话强制补调；成功后图片走独立 `~g` 消息，文字只留「画好了，图单独发。」；已尝试失败不重复花钱；假回执仍改成实话。
- **本机真实消息回放**：原话「画一个会数学的奶娃」→ 强制补图 1 张、文字改为回执、QQ 发送 0 次；「你把你的奶娃形象画出来发群里」同样通过；`别画了/画饼/画个屁` 0 次。
- **真群聊天流程自测未完成**：部署 19:36 完成，用户最后一条绘图请求 19:35:22 已被旧 Worker 处理，之后没有新的真人绘图请求；被动窗口 19:39:22 已过。没有手插 outbox，也没有往群里发任何东西。下一条真人绘图请求到达后，应出现 `image_gen_log` 成功行 + `~g` outbox + `outbox_attempts.code=id:…`。
- **更正公告未发**：`release-notice:image-chat-fixed` 还没入队；按交办必须等真群聊天流程出图成功后再发「刚才直接叫我画图会失败，现在修好了」。
