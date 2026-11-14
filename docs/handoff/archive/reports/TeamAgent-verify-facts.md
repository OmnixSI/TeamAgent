# TeamAgent QQ 事实核查

核查时间：2026-11-12 悉尼时间（北京时间 2026-11-11）；仓库 HEAD `76855aa25791f4be1f4144df46e00f9e33db9078`。
依据：已读 research-qqbot.md、recon-teamagent.md、项目约定、实际调用链，以及内置浏览器打开的 QQ 官方文档。
路径约定：下文仓库路径均相对本文件所在目录的 `TeamAgent/`；`SDK/` 指 `/Users/yanghongming/.inkboard-team/sdk/node_modules/@tencent-connect/qqbot-nodejs/`（实际安装版本 1.0.5，与 runner/sdk/package.json 一致）。

## 1. B 站小程序卡片：部分成立（官方结构成立，本群实收未确认）

- [官方群消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) 明列 `ark_data`；其中 `ark_type=miniapp` 包含哔哩哔哩，`fields` 常见键为 `title/desc/jump_url/preview/source` 等，均不是保证每条必填。嵌套卡片还可出现在 `msg_elements[].ark_data`。
- `src/worker.ts:242` 写入 message_meta，`:251` 的 `card` 是 `m.ark_data || null`，经 `src/runtime.ts:15` 的 promptData 脱敏序列化；所以普通卡片会保留对象，不转换成 OneBot 的 `meta.detail_1`。
- `SDK/dist/protocol/types.d.ts:233` 的 GroupMessageEvent **没有声明 ark_data**，RawMsgElement 也未完整声明递归卡片（`:195`）；但 `SDK/dist/protocol/gateway/event-dispatcher.js:143` 原样保留 `raw: ev`，JS 运行时不会按类型删除额外字段。类型缺项不等于实际收不到。
- 检索仓库 test/docs 及可见 JSON/日志/fixture 文件，未找到真实 B 站卡片样本；侦察报告的构造事件只能证明代码处理能力。未读取线上 D1、实际群消息缓冲或私人日志，不能给出“已存卡片的真实内容”。
- 结构示意（非真实抓包）：`{"card":{"ark_type":"miniapp","fields":{"title":"示例","jump_url":"https://b23.tv/示例","preview":"…"}}}`；无 ark_data 时 `card:null`。
- 影响：可以按官方字段实现卡片解析，但不能承诺本群必定收到完整卡片；验收需捕获一条脱敏真实群事件并核对 D1 中对应 card，覆盖嵌套卡片与缺字段。

## 2. 引用关系：部分成立（SDK 已解析，网关并未丢原始字段）

- [发送群消息的 MessageReference](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html#schema-messagereference)：出站字段名是 `message_reference.message_id`，**值是引用索引**。引用成员消息取其入站 `message_scene.ext` 的 `msg_idx`；引用机器人消息取发送响应的 `ext_info.ref_idx`。这与被动回复 `msg_id=d.id` 是两套字段，不能混用。
- [群消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) 定义 `ext` 为 `key=value` 字符串数组，含当前消息 `msg_idx` 和被引用消息 `ref_msg_idx`。
- `SDK/dist/protocol/gateway/event-dispatcher.js:12` 已按首个 `=` 切分，保留值尾部的 `==`；`:37` 在 message_type=103 时优先取元素 msg_idx；`:123`、`:137`、`:138` 输出 refMsgIdx/msgIdx。
- **“qq-gateway.mjs:110 丢弃引用字段”不成立。** 它不单独转发 SDK 的 camelCase 字段，但转发完整 `m.raw`；原始 message_scene/msg_elements 仍在。真正缺口是 `src/worker.ts:246` 的入库白名单没有 scene、msgIdx/refMsgIdx，也没有建立索引到消息 ID 的映射。
- `src/worker.ts:873` 出站仅传文本、msg_id、msg_seq，无 message_reference；且未保存回执 ext_info.ref_idx。SDK 的 `SendMessageOptions.messageReference` 类型仅接受 `{message_id:string}`（`SDK/src/QQBot.ts:98`），其 send() 直接透传（`:718`），不会替调用方把 d.id 转成引用索引。
- 影响：在 Worker 解析/持久化原始引用索引、保存机器人发送索引并构建 replyTo 关系；不必为了“救回已被网关删除的数据”改网关协议。组装出站时使用 `message_reference:{message_id:目标msg_idx或ref_idx}`。

## 3. PNG/GIF 图片与原生表情：部分成立（流程成立，限制与实测须分开）

- [群上传接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html) 支持 `POST /v2/groups/{group_openid}/files`、`file_type:1`、`srv_send_msg:false` 获取 file_info；再经[发送群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)以 `msg_type:7,media:{file_info}` 发送。`SDK/dist/protocol/api/media.js:60`、`:92` 实现相同流程。
- [富媒体总览](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html) 列 jpg/png/gif/webp/bmp；图片软限制 20 MB、硬限制 200 MB，超软限制降为文件。群上传页格式说明只列 png/jpg，存在文档粒度差异；没有核实 GIF 动画是否完整播放、帧数/尺寸限制，不将格式支持等同于本租户实测成功。
- 群上传页写直接 file_data 在 5M 内，较大文件走 URL 或分片；SDK 1.0.5 的单次上传常量却为 20 MiB、图片上限 30 MiB（`SDK/src/protocol/utils/file-utils.ts:13`、`:23`），与当前官方限制并不一致。URL 与 fileData 的路由也不同（`SDK/USAGE.md:391`）；不要把 SDK 常量当平台保证。
- 频率：[群上传接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html) 标 50 QPS，[群发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html) 标 100 QPS；[消息收发规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)另列群被动回复 5 分钟内最多 5 次；群主动消息已认证 Bot 60 次/分钟、未认证 30 次/分钟，单群 20 次/分钟、1000 条/日。接口 QPS 不能替代消息配额。
- 同一群上传接口还列文件日容量耗尽错误 `40093002`，未公布该页对应容量数值；本 Bot 认证状态、权限与实际配额未确认。`srv_send_msg:true` 占主动消息频次；file_info 按返回 ttl 复用，不跨单聊/群聊场景。
- [消息类型总览](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)及群发送接口均没有 OneBot 的 face/mface 消息段；频道“表情表态”不是群聊原生表情发送能力。能有依据承诺的是图片/GIF 表情包与文本 Unicode emoji；content 中原生 face 标记能否渲染未确认，需单独协议实测。
- 影响：保留官方 API，增加图片富媒体发送并控制文件大小、引用时效及配额；用本群 PNG/GIF 收发验收，不承诺原生商城表情。另须避免“官方只能发 0/2/7”这一绝对说法：群发送页还列 8 图文卡片，与总览不同。

## 4. messageView 与昵称根因：部分成立（参与判定丢字段成立，“所有 prompt 都没有”不成立）

- **messageView 丢 card/senderName 成立**：`src/semantic.ts:572` 至 `:592` 仅保留 sender、body、direct、addressedOther、forwarded、附件文件名/MIME、urls；`context.latest/batch` 使用它（`:608`），conversation 也只有 sender OpenID，无昵称或卡片（`:636`）。纯卡片顶层正文为空时，参与判定缺失主要语义。
- `src/worker.ts:236` sender 取 member_openid/id，`:249` senderName 取 author.username，`:251` card 取 ark_data。卡片 URL 会参与后台视频任务抽取（`:263`），但 meta.urls 只从文本生成（`:257`）；故“卡片完全没有任何处理”不准确。
- **“prompt 里发言人确实只用 OpenID”应限定到参与判定的消息投影**：`src/worker.ts:612` 查询 recent 时含原始 metadata JSON；`src/semantic.ts:742` 把原 context 交给 speakBrief；`src/voice.ts:98` 原样序列化 recent 最后 6 条。因此嘴替可能看到 metadata 字符串中的 senderName/card，不能说全链路彻底不可见，但其上游是否开口的判定已缺信息。
- 官方当前[群消息 User 定义及事件示例](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)明确含 `author.username` 昵称；`SDK/dist/protocol/types.d.ts:239` 将其定义为可选，dispatcher `:130` 映射 senderName。不是“官方不提供昵称”；本群是否实际填充仍需脱敏事件验证。
- 影响：统一参与判定与嘴替的显式消息结构，带稳定 senderId、可选显示名、卡片摘要和关系边。昵称缺失时可用成员主动绑定/已确认别名映射，兜底稳定匿名标识；不要由模型猜 OpenID 对应真人，昵称也不作为唯一身份。

## 验证与未确认

- 已运行无文件落地的临时 Node assert 探针：调用实际 SDK 1.0.5 dispatchEvent，确认 msgIdx/refMsgIdx（含末尾 `==`）、senderName 均解析；按网关原表达式序列化后 scene 与 ark_data 完整保留。合成事件验证通过，不是实群验收。
- 未复跑构建/全套测试：本任务是事实核查，侦察报告已有基线结果；未安装依赖、修改代码、提交、push 或发送群消息。仓库 git status 核查前后均干净。
- 未确认事项及完成办法已逐项写明：真实 B 站卡片与昵称抓包、PNG/GIF 上传及动画展示、原生 face 标记出站行为、当前租户权限/认证和文件日容量；均不可用静态代码或构造事件替代。
