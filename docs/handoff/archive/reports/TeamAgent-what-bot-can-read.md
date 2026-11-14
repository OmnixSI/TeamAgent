结论：这次表情图已经收到，随后 @ 追问也触发了看图流程，但没有得到任何视觉注释；机器人实际拿到的是「图片（未查看）」。不是「QQ 只推 @」、未触发或日预算耗尽。表情库候选筛选另有确定的过滤问题。视觉注释失败的具体网络/读取原因没有留痕，尚未确认。

核查时间：2026-11-12 悉尼 16:08–16:22；全部只读，不改代码、不重发、不执行模型自检。线上 `/api/team/state` 返回版本 **057bb8f4c4f5537ff57d7674b764e182080c5147**，不是简报中的 954aa99；源码按该版本核对。指定 `/Users/yanghongming/Projects/TeamAgent` 当前不存在，因此从现有仓库 Git 对象导出隔离快照 `/tmp/teamagent-readable-audit-j4sii3dk`，未切换任何分支。

**真实消息与处理断点**

证据来自只读 `/api/runner/inputs`、`/api/team/state` 和远程 D1 SELECT；以下只保留时间、字段、尺寸和消息 ID 的 SHA-256 前十位，不含 QQ 号、群号、签名链接或凭据。

- **E1｜16:06:23，消息摘要 `47497ff513`**：`mentioned=0`；正文是 `<faceType=6,faceId="0",ext="…">`，ext 解码仅为 `{"text":""}`。有一张真实图片附件：`content_type=image/jpeg`，519×1271，275673 字节（约269 KiB）。附件字段为 `content/content_type/filename/height/size/url/width`；URL 是 **https://multimedia.nt.qq.com.cn**，含查询参数，原串不展示。`metadata.media[0].kind=image`，`forwarded=[]`、`card=null`、`mentions=[]`。这不是 GIF，也不是“完全没有图片”；不能仅凭 faceType=6 断言商城来源。
- 原附件已在本机限量下载验证 **HTTP 200、image/jpeg、275673字节**，禁止跳转时也返回200；目视为白底敬礼人像。该结果只证明本机现在可下载，不证明 Worker 当时也成功。没有把图片交给额外模型。
- **E2｜16:06:34，摘要 `9d664718be`**：同一发言人 @ 追问「做得好呀 你能看到我的表情吗」。`chat_decisions` 同一批包含 E1/E2，`mentioned=1, forced=1, action=reply`；因此本次不能归因于“没 @、没提问所以不看”。
- **E3｜16:06:36–16:06:49**：原聊天任务及 `annotated=true` 后续任务均为 done；但 E1 的 `message_images JOIN image_notes` 为 **0行**，按原图字节 SHA+`:v1` 查注释也为0。最终 outbox 为 sent，回复明确说这边显示「图片（未查看）」；与 `src/view.ts:70–73` 的未查看降级一致。`chat-v` 创建只表示尝试过，并不表示看图成功（`src/worker.ts:697–701`）。
- **E4｜预算/开关**：线上 `vision.enabled=true`、日上限300、每轮3张/12秒；当日 `budget:vision:2026-11-12=1`，本时段 `model_runs(kind=vision)` 为0。`image_notes` 全库只有另一张红色方块的注释；本条并未进入视觉模型的记录链。`stickers` 全库0行，收集配置开启且 `off:sticker_collect=0`；发送配置为 false。
- **E5｜表情收集的确定断点**：`src/worker.ts:314` 把原始 face 标签算作“有正文”，`src/vision.ts:146` 因此直接拒绝 JPEG 候选；即使去掉标签，该图也超过300×300和200KiB启发式阈值（`:148–149`）。独立重放真实脱敏结构，两个条件下 `looksLikeSticker=false`。它没有进入表情收集任务；400000字节的收集下载上限本身并非这张图的障碍。
- **E6｜未能细分的失败点**：图片已被正确归类，并执行过视觉注释尝试，但未写缓存，也没有本时段 vision 调用记录。`fetchImage`/`describeImage`/`describeBytes` 及 `annotateTurn` 把下载、读字节、截止、查询/描述异常合并为 null/忽略（`src/vision.ts:118–140、289–338、359–385`）；日志没有 HTTP 状态或阶段错误。不能据此宣称已确认 CDN 封锁、协议错误、MIME错误或模型不收图。

补充：16:12:30 又有一条未 @ 的 PNG（1414×1234、2050825字节，摘要 `07c37bbbd4`）到达，未有注释；它晚于本次投诉派单，不与 E1 混为一条。原始长连接封包成功转发后会从 spool 删除；D1 留的是处理后的 attachments/card/forwarded 等，并未完整保存事件 t 和 message_type，不能伪称恢复了完整原封包。

**现在实际能读什么**

“已验证”只覆盖括号内已发生的阶段，不能把收到附件等同于理解内容。“仅单元测试”均使用合成事件、假图片或模拟 HTTP/模型响应。

| 消息形态 | 机器人收到什么 | 进入模型的是什么 | 核实状态与依据 |
|---|---|---|---|
| 纯文本 | content、发言人、时间 | 结构化文本与上下文 | **已验证**：真实 D1 多条文本和已发送回复；`src/inbound.ts:65`、`src/view.ts:101–109`。 |
| @ 文本 | 正文、mentions/事件提及信号 | mentionsYou、正文、被叫到的语境 | **已验证**：E2及对应强制回复决策。 |
| 普通图片 | image/jpeg/png 附件、QQ下载URL、尺寸 | 注释成功才有描述/OCR；否则尺寸或“未查看” | **已验证入站、本次看图失败**：E1/E3；不是已验证能理解所有群图片。 |
| 表情图／QQ商城表情 | 本条是 face 标签＋JPEG；商城来源未确认 | face 标签变“[表情]”；有附件才可能取像素 | **已验证本条过滤/未查看**：E3/E5；其他商城/超级表情形态**未验证**。无素材/名称的 ID 本身不足以读出画面。 |
| 动画 GIF | MIME为image/gif时按图处理 | 整份图像字节送视觉；没有逐帧解析流程 | **仅单元测试**：`test/stickers.test.mjs`、`src/vision.ts:41–46、145`；真实库附件无GIF，完整动画理解未验证。 |
| 语音 | voice/audio附件；可能有asr_refer_text | 有ASR才是转写，否则仅“语音” | **仅单元测试**：`test/inbound.test.mjs:116、363`；当前无真实语音附件样本。没有ASR时自动理解音轨**已知不支持**。 |
| 文件 | filename/size/url等 | 默认文件名/类型；明确交办后才进入本机资料任务 | **已验证收到ZIP，文件内容读取未验证**：16:00:26真实文件；`src/view.ts:61–68`、`runner/utility.py:215–229`。 |
| 视频附件 | video/mp4等 | 默认“视频”；媒体任务可能另行抽帧/取字幕 | **已验证收到，但历史真实媒体任务失败**：D1有1条MP4及failed任务；完整观看/音轨理解未验证（`runner/utility.py:232–273`）。 |
| 引用消息 | msg_elements、引用索引/目标 | 引用原话；定位成功时含目标图片注释 | **已验证引用结构，完整关系/图片链仅单测**：历史D1有引用元素；`src/inbound.ts:69–77`、`src/view.ts:79–90`、`test/inbound.test.mjs`。 |
| 合并转发 | 若平台提供msg_elements，则留作引用资料 | 转发原话/卡片摘要，不是执行授权 | **仅单元测试；真实合并转发未验证**。D1的17条forwarded包含引用，不能全算合并转发；任意转发包完整递归阅读未证实。 |
| B站卡片带链接 | ARK中可提取的BV/b23链接 | 触发轻档后应有标题、UP、简介、热评和字幕状态 | **仅单元测试，真实完整成功未验证**：`src/bili-links.ts`、`src/fetchjobs.ts:35–51、105–118`；当前D1无bili缓存。 |
| B站卡片无链接 | 真实ARK的preview/source/source_logo/title | 卡片标题/来源；新卡片可尝试按标题检索并注明不确定 | **已验证此种入站；标题找视频正向未验证**：12:24:43真实卡片摘要 `37e44b311a`。旧记录未含biliCard，不能拿新方案冒充旧卡已重解析。 |
| 纯文本B站链接 | 文本中的b23.tv/BV链接 | 链接＋成功轻档的元数据/热评/可用字幕 | **已验证真实收到2条；现版解析闭环未验证**：D1无bili缓存；`runner/fetcher.mjs:141–156`。无字幕时应明确未读，未提供AI总结接口或完整画面/音轨理解。 |
| 网页链接 | URL | Jina正文→DeepSeek回退后的受限资料 | **已验证收到GitHub链接；真实正文抓取本次未核验**；回退/大小/安全规则**仅单元测试**，`src/semantic.ts:388–453`、`test/web.test.mjs`。 |
| X单条推文 | 公共tweet/status URL | 公开oEmbed中的作者和文字，不含视频理解 | **仅单元测试**：`src/semantic.ts:396–421`、`test/web.test.mjs`；真实群X链接0条。X登录窗口存在不代表已实现登录态阅读。 |

**是否只有 @ 才能收信**

对这一个账号/群，结论是 **不是**。E1和16:12的PNG均已入D1且 `mentioned=0`；生产 `receive` 只处理 GROUP_MESSAGE_CREATE/GROUP_AT_MESSAGE_CREATE，后一种必把mentioned设1（`src/worker.ts:195、248`），因此这些确为非@群消息路径。`fullMessageVerified` 也在最近更新（`:347–348`）。
腾讯官方SDK 1.0.5同时派发两种事件（`dist/protocol/gateway/event-dispatcher.js:120–146`）；其[官方源码说明](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/middleware/mention-gate.ts)明确区分：GROUP_AT表示确实@，部分自托管/私域场景也收到GROUP_MESSAGE_CREATE。普通权限/其他账号可能只有@事件，不能推广为本账号的限制。本机网关转发原始 m.raw，不使用OneBot（`runner/qq-gateway.mjs:107–115`）。
若某种消息的原事件只给表情ID、无图片/名称/可用素材接口，本通道不能凭空取得像素；需要有证据的ID映射或附图。没有证据证明“所有商城表情官方都不给图”，不能把整个类别判死。

**最小修复建议（未实施）**

1. **先修真实取图链的可观测性与降级**：`src/vision.ts:118、289、304、359` 返回脱敏阶段结果（HTTP状态/MIME/超限/超时/数据库/描述失败），不要全部null；保留“尝试”与“成功”之分。若确认Worker不能取QQ-CDN，再走本机受限下载降级，仍校验域名、协议、MIME、大小与跳转。验收用同一真实图：必须产生关联的message_images/image_notes和可核对描述，而非仅job=done。不能靠改提示词解决未取到像素。
2. **修表情候选与正文判断**：`src/worker.ts:314` 先区分QQ face标签和真人正文；`src/vision.ts:143–150` 对明确表情图增加受400KB上限约束的候选入口，避免仅靠“小于200KB/300像素”。仍保留meme确认与收集/发送分离；`src/stickers.ts:35–44` 目前要至少两位成员使用才打标签，不能宣称单人发图已自动加入可用表情库。发送false不是本次看图失败原因，不擅自开启。
3. **保留原生表情语义与失败可见性**：`src/view.ts:25–27` 对有ext.text的标签保留名称/类型，空名称如实标未知；失败时展示“图片未取得/未分析”的真实原因。继续保留纯图不强制插话的策略，但 @/引用/明确问图必须能完成受预算保护的取图。本条已触发，不能把“再@一次”当成修复。

验证：真实只读API、D1查询和本机QQ日志已核对；隔离快照重放真实脱敏结构，并跑inbound/vision/stickers/web/fetchjobs相关测试 **144/144通过**。这些测试多数模拟网络/模型，不能抵消本条真实失败。未发群消息、未重试线上任务、未改任何开关或代码、未调用付费模型；私密下载图已删除。
