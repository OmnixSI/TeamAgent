# TeamAgent 群聊 AI Bot「基本功能」对照与缺口

- 调研时间：2026-11-14 00:47–00:58 Sydney（谷时）
- TeamAgent：只读快照 `8762214`（2026-11-13，`fix: 兼容无 id 的旧交付回执…`），读 `src/`、`runner/`、`docs/`，未改仓库、未读生产 D1。
- 成熟项目：2026-11-13 前后主分支浅克隆，文件行号以本文所列 commit 为准。
- 判定口径：**有**＝代码有完整入口且默认可用；**部分有**＝有实现但缺关键环节、默认关闭或依赖外部条件；**没有**＝代码里没有入口。
- 本文只写代码里能看到的事实；运行时是否配了 `GITHUB_TOKEN`、本机索引是否新鲜，需要另看 `/health` 和 `/api/team/ops`，本文不猜。正文里 `worker.ts`/`semantic.ts` 等简写均指 `src/` 下同名文件，`repo_index.py`/`subagent.py` 指 `runner/` 下同名文件。

## 结论（先看这 6 句）

1. TeamAgent 不是「什么都没有」：上下文/对话对象、记忆与纠错、读图、文件交付、权限与提示注入防护，代码都比多数开源群 bot 更细。
2. 真正缺的是**可运营的基本面**：单群绑定 + 全局 `chat_cursor`（`worker.ts:487`、`:678`），会让 @ 消息也被跳过；这与 2026-11-14 线上静默的已知根因同型（团队记忆，不是本文件的代码结论），优先级最高。
3. 用户说的「问仓库有哪些新提交都答不上」，代码上有两条路：`GITHUB_TOKEN` 未配 → `needs_token`（`github.ts:146`）；没配 token 且本机索引也没上报 → `not_synced`（`repo.ts:108`）。两条都只回一句原因，没有可直接用的下一步。
4. 第二组硬缺口：**群历史不可检索**（只回看 24 条近期 + 60 条批次，`context.ts:47`、`:26`）、**没有定时提醒/待办**、**没有群内管理命令**、**没有撤回/群事件**、**长任务没有中间进度**。
5. 第三组是「体验」：长对话没有摘要压缩、工具失败没有统一 `next_action`、主动发言只有固定节流没有冷场模型、长回答不会分段。
6. 建议顺序：先修单群/游标（P0），再补仓库问答、历史检索、提醒、管理命令、长任务进度（P1），最后做摘要/频率/分段（P2）。

## 成熟项目快照与可借部分

| 项目 | 快照 | 许可证 | 最值得借 |
|---|---|---|---|
| AstrBot | [`23db1ad`](https://github.com/AstrBotDevs/AstrBot/tree/23db1ad)（2026-11-13） | AGPL-3.0 | 唤醒/限流管线、`future_task` 定时任务、群历史工具、`/help` `/status` `/stop`、后台任务 task_id、搜索多 key 轮换、内容安全 |
| MaiBot | [`03347c9`](https://github.com/Mai-with-u/MaiBot/tree/03347c9)（2026-11-11） | GPL-3.0 | @/提及判定、回复概率与 idle backoff、通知类事件、人物档案、表情包管理、子代理 `status/stop`、上下文压缩、工具调用记录 |
| kirara-ai | [`36249e4`](https://github.com/lss233/kirara-ai/tree/36249e4)（2026-10-22） | AGPL-3.0 | `GroupScope`/`MemberScope` 多群记忆隔离、记忆管理器 |
| NoneBot2 | [`2450b67`](https://github.com/nonebot/nonebot2/tree/2450b67)（2026-11-12） | MIT | `to_me()` 规则、`SUPERUSER` 权限、`on_notice`、单会话互斥 |
| adapter-onebot | [`8e0d114`](https://github.com/nonebot/adapter-onebot/tree/8e0d114)（2026-11-10） | MIT | `GroupRecallNoticeEvent`、`event.to_me` 的 reply/@ 解析、`get_session_id` |
| Koishi | [`97d5c39`](https://github.com/koishijs/koishi/tree/97d5c39)（2026-10-08） | MIT | `Session.stripped`（剥离 @ 自己/引用）、`guildId/channelId`、`Command` |
| GitHub MCP Server | [`f66a8d5`](https://github.com/github/github-mcp-server/tree/f66a8d5) | MIT | `list_commits`、`get_commit`、`get_file_contents`、`search_code` |

> 许可证提醒：AstrBot / MaiBot / kirara-ai 是 AGPL/GPL，直接拷代码会把许可证义务带进 TeamAgent；优先「照思路重写」或只搬 MIT 的 NoneBot/Koishi/GitHub MCP。下面写「怎么借」时已按这个原则区分。

## 总览

| # | 功能 | 我们 | 优先级 |
|---:|---|---|---|
| 1 | 被 @ 必回 | 部分有 | P0 |
| 2 | 被引用/回复必回 | 有 | — |
| 3 | 上下文与「谁在跟谁说话」 | 有 | — |
| 4 | 长对话摘要压缩 | 没有 | P1 |
| 5 | 群消息历史检索 | 没有 | P1 |
| 6 | 联网搜索 | 有 | — |
| 7 | 链接卡片解析（B站/推特/GitHub/网页） | 部分有 | P2 |
| 8 | 读图/OCR | 有 | — |
| 9 | 表情包理解与发送 | 部分有 | P2 |
| 10 | 读群文件/附件/语音 | 有 | — |
| 11 | 仓库与代码问答 | 部分有 | P1 |
| 12 | 定时提醒/待办 | 没有 | P1 |
| 13 | 长任务进度/查询/取消 | 部分有 | P1 |
| 14 | 主动搭话/冷场控制 | 部分有 | P2 |
| 15 | 发言频率/防刷屏 | 部分有 | P2 |
| 16 | 长消息分段/多气泡 | 部分有 | P2 |
| 17 | 群成员与称呼记忆 | 有 | — |
| 18 | 长期事实记忆与纠错 | 有 | — |
| 19 | 自省与复盘 | 有 | P2 |
| 20 | 表达风格/黑话学习 | 有 | — |
| 21 | 群事件（入群/退群/禁言/戳一戳） | 没有 | P1 |
| 22 | 管理员命令（/help、/status、/stop） | 部分有 | P1 |
| 23 | 开关/热配置/灰度 | 部分有 | P2 |
| 24 | 撤回与编辑处理 | 没有 | P1 |
| 25 | 工具失败如实说原因并给下一步 | 部分有 | P1 |
| 26 | 「做不到」时自动换路 | 部分有 | P2 |
| 27 | 可观测性（工具调用日志） | 部分有 | P1 |
| 28 | 安全（提示注入/权限/敏感信息） | 有 | — |
| 29 | 多群隔离 | 没有 | P0 |
| 30 | 文件交付/群文件发送 | 有 | — |

---

## 一、唤醒与对话

### 1. 被 @ 必回 — 部分有（P0）

- **成熟项目**：AstrBot 在唤醒阶段先看结构化 `At`、`@全体`、唤醒词和插件 filter，再决定 `event.is_wake`（[waking_check/stage.py:25](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/waking_check/stage.py#L25)、[:140-157](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/waking_check/stage.py#L140)）。MaiBot 把适配器标记、结构化 `mention_bot`、文本 `@账号`、`@群名片` 合并成 `is_at/is_mentioned`，并在 `inevitable_at_reply` 时把回复概率直接设为 1.0（[scenes/group/mentions.py:15](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/scenes/group/mentions.py#L15)）。NoneBot 用 `to_me()` 规则匹配「@ 我」和「回复我」（[rule.py:738](https://github.com/nonebot/nonebot2/blob/2450b67/nonebot/rule.py#L738)）。
- **我们**：`mentioned` 在入站时记录（`src/worker.ts:270`），`shouldProcessNow` 对 mentioned 直接放行（`src/rhythm.ts:7-9`），`parseDecision` 对被 @ 的轮次强制 `reply`（`src/rhythm.ts:14-24`），`semantic.ts:935-946` 再用 `forced` 兜底。**但** `src/worker.ts:678-680` 在强制判定之前先判 `m.ordinal <= cursor`，命中就 `status='done'` 直接返回；`chat_cursor` 是全局单键（`worker.ts:487`、`:672`）。只要游标被回放/异常 rowid 推大（多群后还会被别的群推大），@ 也会静默跳过。
- **怎么借**：把「mentioned / replyTo.kind=bot」的判断提到 cursor 判断之前（照 AstrBot 的 wake 优先级）；`chat_cursor` 改成 `chat_cursor:<group_id>`，首次从旧全局键初始化并补迁移；再给 `chat_decisions` 加一条 `gate='cursor_skip'`，让运维能看到被跳过的 @，不要静默 done。

### 2. 被引用/回复必回 — 有

- **成熟项目**：AstrBot 把引用保留成 `Reply` 组件（id/sender/chain/message_str，[components.py:725](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/message/components.py#L725)），并用 `QuotedMessageExtractor` 异步补全被引用的文字和图片（[extractor.py:76](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/utils/quoted_message/extractor.py#L76)、[:156](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/utils/quoted_message/extractor.py#L156)、[:189](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/utils/quoted_message/extractor.py#L189)）。NoneBot 的 OneBot 适配器在解析 reply 段时直接置 `event.to_me = True`（[bot.py:45](https://github.com/nonebot/adapter-onebot/blob/8e0d114/nonebot/adapters/onebot/v11/bot.py#L45)）。
- **我们**：`refMsgIdx` → `message_refs` → `replyTo{kind,targetId}` 在入站时落库（`src/worker.ts:275-282`）；`view.ts:69-75` 把 `replyTo.kind==='bot'` 解析成 `to='你'`；`rhythm.ts:26-28` 的 `mayBeForced` 把「引用 bot」列为强制条件；`semantic.ts:937-943` 对 `replyTo.kind==='bot'` 或「转发里含 bot 原话」强制 `reply`。
- **边界**：只有引用 **bot** 的消息才强制；引用成员消息时只是普通上下文，模型仍可 `stop`。如果要做到「引用任何消息问 bot 都必须接」，需要在 `addressee` 里把「引用 + 问句 + 没 @ 别人」也算 direct。
- **怎么借**：保留现有 `message_refs`；补 AstrBot 的「引用内容被删/被撤回时仍能取到快照」——我们目前只存 200 字 `quoted.text`（`view.ts:124`），长引用会截断。

### 3. 上下文与「谁在跟谁说话」 — 有

- **成熟项目**：AstrBot 用 `unified_msg_origin`（platform:type:session）做会话键（[astr_message_event.py:175](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/platform/astr_message_event.py#L175)），会话历史成对写入（[conversation_mgr.py:24](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/conversation_mgr.py#L24)、[:377](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/conversation_mgr.py#L377)）。Koishi 的 `Session.stripped` 会剥掉开头 @自己/引用里的 @，给出 `hasAt/atSelf/appel`（[session.ts:156](https://github.com/koishijs/koishi/blob/97d5c39/packages/core/src/session.ts#L156)）。MaiBot 把「谁 @ 谁、谁引用谁」写进 `SessionMessage` 组件：@ 用群名片优先（[message.py:149](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/chat/message_receive/message.py#L149)），引用会补 `[回复了X的消息: 原文]`（[message.py:461](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/chat/message_receive/message.py#L461)）。
- **我们**：`context.ts:45-53` 取最近 24 条；`context.ts:23-32` 从 cursor 取最多 60 条批次；`view.ts:69-75` 的 `addressee` 把 `to` 解析成「你/某成员」；`view.ts:157-193` 的 `threadize` 按引用和 @ 关系并线程，`buildConversation` 按时间合并成员与 bot。这套比多数开源 bot 细。
- **怎么借**：保持；把 `to`/`th`/`flags` 作为 prompt 的稳定字段（已经在 `toPrompt` 里），不要退回纯文本拼接。

### 4. 长对话摘要压缩 — 没有（P1）

- **成熟项目**：MaiBot 有滚动上下文摘要 `build_context_summary`，把旧消息压成 `ContextSummaryMessage`，保留最近消息，并可带上一版摘要（[context/compaction.py:217](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/context/compaction.py#L217)、[:66](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/context/compaction.py#L66)）。AstrBot 用会话成对历史 + 平台历史表，长会话可由 `/reset` 切新会话（[main.py:44](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/builtin_stars/builtin_commands/main.py#L44)）。
- **我们**：没有摘要/压缩。`context.ts:47` 固定 `LIMIT 24`，`context.ts:26` 固定 `LIMIT 60`；超过窗口的对话只可能变成 `facts`，不会变成「我们刚才聊到哪」的摘要。搜索 `summary|compact|摘要` 在 `src/` 没有对话压缩实现。
- **怎么借**：照 MaiBot 的「上一版摘要 + 最近 N 条 + 新消息」三段式；触发条件用 token/字符预算，不要按固定条数；摘要只进 prompt，不写 `facts`，避免把模型摘要当团队决定。

### 5. 群消息历史检索 — 没有（P1）

- **成熟项目**：AstrBot 有 `get_group_message_history` 工具，支持 `limit`（≤50）、`before_id` 分页、`keyword`、`sender`，并强制只能读当前群（[message_tools.py:367](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/message_tools.py#L367)、[:405](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/message_tools.py#L405)）。
- **我们**：没有 `search_history`/`get_history` 工具。`agentAnswer` 的工具表只有 `get_work_status`、`remember_correction`、`recall_memory`、`create_file_task`、`prepare_project_task`、`search_web`、`read_web`、`get_project`、repo 三件套（`semantic.ts:652-810`）。群历史只在 `context.ts` 的 24/60 窗口里。
- **怎么借**：照 AstrBot 的工具签名加一个 `search_history`：只查当前 `group_id`，`limit≤50`，支持 `keyword`/`sender`/`before_id`；返回 `id/time/sender/text`，标注 `untrusted`；不要返回整库。

### 6. 联网搜索 — 有

- **成熟项目**：AstrBot 的 `web_search_tools.py` 同时接 Tavily/Bocha/Brave/SerpAPI/Firecrawl/Exa 等，`_KeyRotator` 做多 key 轮换，401/403/429/432 自动换 key（[web_search_tools.py:83](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/web_search_tools.py#L83)、[:95](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/web_search_tools.py#L95)）。MaiBot 把搜索封成 `WebSearchService`，走 MCP 调用（[web_search/service.py:32](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/web_search/service.py#L32)）。
- **我们**：有 `search_web` 工具（`semantic.ts:776-783`），执行时调 DeepSeek `/v1/tools/search`（`semantic.ts:300-312`、`:1180-1187`），结果逐条打 `【外部资料·不可信】`（`semantic.ts:494-505`）；`scout` 每天 12/19 点用同一接口做项目相关检索（`semantic.ts:531-632`、`worker.ts:1100-1125`）。
- **怎么借**：保留；补 AstrBot 的「多 provider + key 轮换」只作为可用性兜底，不必现在接五家。更值得补的是**搜索结果缓存**和**引用来源列表**，现在 `search_web` 只返回 4 条 `need_content`。

### 7. 链接卡片解析（B站/推特/GitHub/网页） — 部分有（P2）

- **成熟项目**：AstrBot 把 QQ 卡片原样保留成 `Json` 段（[components.py:877](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/message/components.py#L877)），转发/引用链由 `ReplyChainParser` 解析（[chain_parser.py:455](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/utils/quoted_message/chain_parser.py#L455)）；网页正文用 Firecrawl `_firecrawl_scrape`（[web_search_tools.py:1096](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/web_search_tools.py#L1096)）。MaiBot 把 `ForwardNode` 递归展开成文本（[message.py:503](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/chat/message_receive/message.py#L503)）。
- **我们**：`parseCard` 只抽 `type/name/title/desc/url/preview/source`（`inbound.ts:35-43`）；B 站卡片的短链/BV/卡片 JSON 由 `scanBiliPayload` 递归扫描（`bili-links.ts:4`），无链接时只保留标题（`bilititle.ts:5-6`）；推特走 `readTweet` 的 fx/syndication/oembed 三源（`semantic.ts:423-456`）；GitHub 仓库链接只读 README（`semantic.ts:463-472`）；普通网页走 Jina→DeepSeek fetch（`semantic.ts:473-491`）。
- **缺口**：没有通用 OpenGraph/oEmbed（标题/描述/站点/作者/发布时间）、没有把卡片字段结构化进 prompt、B 站视频正文依赖 `bili_media` 任务、GitHub 只读 README 不读 issue/PR。
- **怎么借**：照 AstrBot 的 `Json` 段保留原始卡片；新增 `unfurl(url)`：先 oEmbed/OpenGraph，失败再 Jina；B 站保留现有 `bili-links`，把 `title/desc/owner/publish_time` 补进 `Card`；GitHub 链接识别 `issues/pull/commit/blob` 四类路径。

### 8. 读图/OCR — 有

- **成熟项目**：AstrBot 有 `Image` 组件（[components.py:636](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/message/components.py#L636)），视觉模型走 provider；MaiBot 有 `resolve_context_image` 按消息 ID + 图片序号取原图（[image_attachment.py:14](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/context/image_attachment.py#L14)），并有 `query_image_memory` 工具（[query_image_memory.py:15](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/builtin_tool/query_image_memory.py#L15)）。
- **我们**：`vision.ts:266-323` 的 `pickImages` 按「@我/问图/引用 bot/问句」挑最多 3 张；`vision.ts:404-423` 的 `describeImage` 走 `deepSeekVision`，输出 `desc/text/tags/meme`，`text` 就是 OCR；`vision.ts:498-545` 的 `annotateTurn` 有 12 秒总 deadline；`config/team.json` 设了 `daily_cap:300`、`turn_max:3`、`turn_deadline_ms:12000`；`worker.ts:701-715` 在聊天 turn 内先标注再重排 job。
- **怎么借**：保留；补「图片被删/过期」的 `blocked` 原因（`vision.ts:69` 已有 `failed` 报告）和「同图哈希缓存」（`vision.ts:424` 已有 sha 缓存）。OCR 文本不要直接当指令，`untrusted` 已经做了。

### 9. 表情包理解与发送 — 部分有（P2）

- **成熟项目**：MaiBot 的 `EmojiManager` 负责收集、描述、入库、按标签/向量匹配（[emoji_manager.py:234](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/emoji_system/emoji_manager.py#L234)、[:269](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/emoji_system/emoji_manager.py#L269)、[:352](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/emoji_system/emoji_manager.py#L352)），语义匹配在 [semantic_match.py:77](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/emoji_system/semantic_match.py#L77)。
- **我们**：`vision.ts:254-265` 的 `looksLikeSticker` 判断表情包；`stickers.ts:22-46` 收集/打标；`stickers.ts:72-98` 按关键词挑图并入队；`stickers.ts:99` 发送。**但** `config/team.json` 的 `stickers.send` 默认 `false`，所以线上只理解、不主动发；`send` 还要求 `min_senders:2`、`max_bytes:400000`。
- **怎么借**：把 `send` 打开前先做「同一表情至少 2 人用过」和「每 10 分钟最多 N 次」的限流（`config/team.json` 已有 caps）；照 MaiBot 的标签/向量检索替代纯关键词 `pickSticker`。

### 10. 读群文件/附件/语音 — 有

- **成熟项目**：AstrBot 有 `File`（[components.py:905](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/message/components.py#L905)）、`Record`（[:270](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/message/components.py#L270)）、`Video`（[:423](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/message/components.py#L423)）组件，语音转写有 MiMo STT（[mimo_stt_api_source.py:24](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/provider/sources/mimo_stt_api_source.py#L24)）和 SenseVoice 自托管（[sensevoice_selfhosted_source.py:26](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/provider/sources/sensevoice_selfhosted_source.py#L26)）。
- **我们**：`inbound.ts:58-64` 的 `mediaOf` 把附件分成 image/video/voice/file，语音带 `asr_refer_text`；`semantic.ts:1010-1115` 的 `create_file_task` 把消息、附件、引用、卡片 URL 收进 payload；`runner/utility.py:90`/`:101` 限 50 MB；`runner/xasr_transcribe.py` 走本机 X-ASR；`src/voice.ts:59` 负责出站语音。
- **怎么借**：保留；补 PDF 文本抽取的失败原因（扫描件要 OCR）和「语音转写失败时不要假装听到」——`guide.ts:31` 已写产品规则，代码里 `mediaOf` 的 `asr` 为空时 `view.ts:91-97` 只显示「语音」，不会编内容。

### 11. 仓库与代码问答 — 部分有（P1）

- **成熟项目**：GitHub 官方 MCP Server 把仓库问答拆成 `list_commits`（[repositories.go:239](https://github.com/github/github-mcp-server/blob/f66a8d5/pkg/github/repositories.go#L239)）、`get_commit`（[:66](https://github.com/github/github-mcp-server/blob/f66a8d5/pkg/github/repositories.go#L66)）、`get_file_contents`（[:1017](https://github.com/github/github-mcp-server/blob/f66a8d5/pkg/github/repositories.go#L1017)）、`search_code`（[search.go:289](https://github.com/github/github-mcp-server/blob/f66a8d5/pkg/github/search.go#L289)）。AstrBot 通过 `MCPClient` 把这类工具挂给模型（[mcp_client.py:393](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/agent/mcp_client.py#L393)）。
- **我们**：有 `repo_changes`/`repo_commit`/`repo_file` 三件套（`repo.ts:7-11`），云端优先 GitHub API（`github.ts:247-269`），失败回退本机索引（`repo.ts:119-130`），索引由 `runner/repo_index.py` 同步、`worker.ts:1378` 接收。**但**：白名单仓库（我们 5 个都在 `config/team.json`）在 `github.ts:146` 被要求必须有 `GITHUB_TOKEN`，否则直接 `needs_token`；没有 token 时回退本地索引，索引没上报就 `not_synced`（`repo.ts:108`）。索引只保留 90 天/每仓 500 条（`repo.ts:131-135`）。
- **怎么借**：三条一起做：① 启动/定时检查 `GITHUB_TOKEN` 存在性和 GitHub rate limit，把结果放进 `/api/team/ops`；② `repo_changes` 返回里带 `source: 'github'|'index'`、`indexAgeMinutes`，让嘴替能说「这是 12 分钟前的索引」；③ 本机 runner 在线时，`repo_changes` 直接 `git log` 当前 worktree，绕开 90 天/500 条限制（照 GitHub MCP 的 `list_commits` 参数：`since/author/path/limit`）。

### 12. 定时提醒/待办 — 没有（P1）

- **成熟项目**：AstrBot 的 `future_task` 工具支持 `cron_expression`、`run_at`、`run_once`、`list`、`edit`、`delete`，任务带 `session` 和 `sender_id`，群成员只能看本群、只能改自己创建的（[cron_tools.py:55](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/cron_tools.py#L55)、[:105](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/cron_tools.py#L105)）；调度器 `CronJobManager` 负责持久化、`DateTrigger`/`CronTrigger`、重启恢复（[cron/manager.py:107](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/cron/manager.py#L107)、[:160](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/cron/manager.py#L160)）。
- **我们**：没有「明早 9 点提醒我」的入口。`policy.ts:9-20` 只解析 `/开工` `/方案` 两个命令；`schema.sql` 没有 reminders/todos 表；`worker.ts:1100` 的 `scheduled` 只跑 scout、dream、清理和重试，不读用户提醒；`tasks.ts` 是项目任务板，不是个人待办。
- **怎么借**：照 AstrBot 的 `future_task` 做一张 `reminders(id, group_id, creator, note, cron, run_at, run_once, status, next_run_at)`；到点复用 `outbox` 发群；群成员只能看/改自己的，owner 可删本群全部；时区用 `TEAM.memory.timezone`（现在 `view.ts:77` 也硬编码 Australia/Sydney）。

### 13. 长任务进度/查询/取消 — 部分有（P1）

- **成熟项目**：AstrBot 把工具声明成 `is_background_task`，执行器立刻返回 `Background task submitted. task_id=...`（[tool.py:62](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/agent/tool.py#L62)、[tool_executor.py:172](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tool_executor.py#L172)）。MaiBot 更进一步：`subagent` 工具返回 `task_id`，另有 `subagent_status`/`subagent_stop` 查看和终止（[subagent.py:40](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/builtin_tool/subagent.py#L40)、[:118](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/builtin_tool/subagent.py#L118)、[:439](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/builtin_tool/subagent.py#L439)），阶段状态另有 `update_stage_status`（[stage_status_board.py:99](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/display/stage_status_board.py#L99)）。
- **我们**：有两段式：工具转后台时立刻回「已开始后台处理，结果稍后单独回这条消息」（`semantic.ts:906-931`），完成时 `research.done`（`worker.ts:584-591`）/`voice_notice`（`worker.ts:639-659`）。**没有中间进度**：`runner/subagent.py:302-305` 每 120 秒 post `/api/runner/subagent/progress`，但 `worker.ts` 没有这个路由；现有 `/claim`、`/heartbeat`、`/report` 是按 task 解析的（`worker.ts:1697-1716`）。取消只有网页对 `media` job（`worker.ts:1998-2015`）；任务状态虽可在网页标 `cancelled`（`tasks.ts:56`），但不会停 research/plan 的 job，聊天里也没有取消命令。
- **怎么借**：先修路由：加 `POST /api/runner/subagent/progress`，写 `jobs.payload.progress` + `stage_timings`；再加两个群内工具 `task_status(id)`、`task_cancel(id)`（照 MaiBot `subagent_status/stop`）；对 research/plan 也允许 owner 取消。

### 14. 主动搭话/冷场控制 — 部分有（P2）

- **成熟项目**：MaiBot 有 `IdleBackoffController`（按空闲时间退避，[idle_backoff.py:16](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/idle_backoff.py#L16)、[:61](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/idle_backoff.py#L61)）和 `DynamicReplyGate`（按回复概率/频率动态开轮，[dynamic_gate.py:87](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/dynamic_gate.py#L87)、[:163](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/dynamic_gate.py#L163)）；回复概率本身是拟合的 logistic 模型（[reply_likelihood.py:74](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/reply_likelihood.py#L74)）。
- **我们**：每条群消息都会排 `chat` job（`worker.ts:382-387`），由 `participation` 判定 `reply/wait/stop`（`engagement.ts:18-25`），重复话术用 `alreadySaid` 拦（`engagement.ts:26-36`），连续主动但没人理用 `hardRuleHit` 硬停（`rhythm.ts:29-49`）。**没有**「冷场 N 分钟主动开话题」的计时器；`scout` 只在 12/19 点分享技术发现（`worker.ts:1100-1125`）。
- **怎么借**：照 MaiBot 的 idle backoff 做一个「群安静 ≥N 分钟 + 最近没有 bot 发言 + 有可聊素材」的触发器；素材优先用 `discoveries`/CI/项目提交，不要凭空找话题；每群每天限 1–2 次。

### 15. 发言频率/防刷屏 — 部分有（P2）

- **成熟项目**：MaiBot 用 `estimate_reply_probability` 对「@我/@别人/问号/纯媒体/最近自发言占比/消息数/距上次发言/待处理数」做加权，再交给 `DynamicReplyGate`（[reply_likelihood.py:74](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/reply_likelihood.py#L74)）。AstrBot 有按 `unified_msg_origin` 的 Fixed Window 限流，可 `stall` 或 `discard`（[rate_limit_check/stage.py:15](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/rate_limit_check/stage.py#L15)、[:43](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/rate_limit_check/stage.py#L43)）。
- **我们**：`rhythm.ts:2-12` 按 mention/image/busy/idle 设 debounce 1/4/3/2 秒和 8 秒 cap；`worker.ts:383-386` 用最近 2 分钟人类消息数判断 busy；`engagement.ts:26-36` 拦完全重复；`rhythm.ts:29-49` 连续主动未获回应时硬停。**没有**概率模型、没有按群的自适应阈值、没有「最近 bot 发言占比」特征。
- **怎么借**：先把 MaiBot 的 8 个特征抄成 TS（不用拟合，先用固定权重），再按群记录 `chat_decisions` 的 `spoken_kind/action` 做在线调整；阈值和 `hard_humans` 放 `config/team.json`，不要写死。

### 16. 长消息分段/多气泡 — 部分有（P2）

- **成熟项目**：AstrBot 的 `RespondStage` 有 `is_seg_reply_required` 和按组件计算间隔的分段回复（[respond/stage.py:44](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/respond/stage.py#L44)、[:155](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/respond/stage.py#L155)）。
- **我们**：`voice.ts:33-57` 的 `fragments` 只对 `mode==='banter'`、≤180 字、不含链接/代码/数字的文本，按句号/空行拆 2–3 条；工作模式不拆。长答案仍然是一条大消息。
- **怎么借**：把分段逻辑从 `banter` 扩展到 `work`，按段落/句子拆，最多 3 条、每条 ≤500 字；含代码/链接/文件路径时不拆；发送端已经支持多 `outbox` 行（`worker.ts:947-1095`）。

## 二、记忆与人格

### 17. 群成员与称呼记忆 — 有

- **成熟项目**：MaiBot 的 `collect_person_profile_candidates` 从发言人、@、引用三个来源收集人物候选（[person_profile.py:146](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/memory/person_profile.py#L146)），`query_person_profile` 工具按名字查档案（[query_person_profile.py:89](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/builtin_tool/query_person_profile.py#L89)）。AstrBot 用 `UmoAutoNameRecorder` 自动记录群名片（[umo_auto_name.py:17](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/waking_check/umo_auto_name.py#L17)）。
- **我们**：入站时把发言人/被 @ 人的名字写 `member_names`（`worker.ts:331-333`），`context.ts:16-22` 的 `namesFor` 批量取；明确纠正走 `rememberCorrection`（`memory.ts:5-70`），保留原话和 `supersedes_ids`。
- **边界**：`member_names` 没有 `group_id`，多群后会串名字；`rememberCorrection` 的 `source.meta.direct !== true` 会拒绝转发/引用里的纠正，这是安全设计，但也让「引用别人话说错了」无法即时纠正。

### 18. 长期事实记忆与纠错 — 有

- **成熟项目**：MaiBot 的 `PersonFactWritebackService` 把人物事实异步写回，带证据和 `_looks_ephemeral` 过滤（[memory_flow_service.py:39](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/services/memory_flow_service.py#L39)、[:480](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/services/memory_flow_service.py#L480)）。kirara-ai 用 `MemoryManager.store/query` + scope 做长期记忆（[memory_manager.py:19](https://github.com/lss233/kirara-ai/blob/36249e4/kirara_ai/memory/memory_manager.py#L19)、[:76](https://github.com/lss233/kirara-ai/blob/36249e4/kirara_ai/memory/memory_manager.py#L76)、[:100](https://github.com/lss233/kirara-ai/blob/36249e4/kirara_ai/memory/memory_manager.py#L100)）。
- **我们**：`semantic.ts:143-195` 逐条校验 `evidence` 是新增消息逐字原文、`repo` 在白名单、`status` 合法才写 `facts`；`supersedes_ids` 会把旧事实 `valid_to` 关闭；`memory.ts:73-115` 的 `recall` 用中文 bigram + 英文 token 做词法召回，取 10 条；`semantic.ts:1007-1009` 有 `recall_memory` 工具。
- **怎么借**：保留；补「同一 subject/predicate 的新旧冲突提示」——现在只有模型主动给 `supersedes_ids` 才关闭旧事实，漏了就会两条并存。可以照 MaiBot 的 `_looks_ephemeral` 过滤掉「今天/刚刚」这类短期话。

### 19. 自省与复盘 — 有（P2 的「怎么做」）

- **成熟项目**：MaiBot 有表达自检 `expression_self_reflect`（[expression_learner.py:192](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/learners/expression_learner.py#L192)、[:479](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/learners/expression_learner.py#L479)）和聊天摘要写回 `ChatSummaryWritebackService`（[memory_flow_service.py:507](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/services/memory_flow_service.py#L507)）；多数开源 bot 没有独立的「自我叙事」。
- **我们**：夜间 `analyse` 产出 `reflection`、`self_note`，写 `dreams` 表（`semantic.ts:80-107`、`:196-225`、`worker.ts:515-535`、`schema.sql:15`）；`self_note`/`team_reflection` 第二天注入 prompt（`semantic.ts:842-857`）。这块比成熟项目完整。
- **风险**：反思和对话是**同一模型、同一上下文**写自由文本，第二天还直接注入回复提示词，自偏好最强。建议照我 2026-11-14 的 V-D 调研拆成 `trace`（不用模型）→ `judge`（独立上下文，优先不同族模型）→ `consolidate`，至少不要把 `reflection` 原样当系统提示。

### 20. 表达风格/黑话学习 — 有

- **成熟项目**：MaiBot 的 `ExpressionLearner` 从会话里学表达，`jargon_context_matcher` 按群/上下文匹配黑话（[expression_learner.py:192](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/learners/expression_learner.py#L192)、[jargon_context_matcher.py:125](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/jargon_context_matcher.py#L125)）。
- **我们**：`learning.ts:2` 的 `phraseCandidates`、`:46` 的 `consolidateExpressions`、`:103` 的 `relevantExpressions`；`semantic.ts:817-820` 按当前消息取相关表达；`schema.sql:17` 的 `expressions` 有 `frequency/speakers/enabled`，至少 3 条原话 + 2 位成员才启用（`semantic.ts:104`）。
- **怎么借**：保留门槛；补「群友说别学了」的一键关闭（现在只有网页 `PATCH /api/team/expression`，`worker.ts:1846`）。

## 三、事件与运营

### 21. 群事件（入群/退群/禁言/戳一戳） — 没有（P1）

- **成熟项目**：MaiBot 的 `handle_notice_message` 明确识别戳一戳、撤回、禁言、入群退群，并让适配器把通知格式化成 `[事件-xxx]` 再走正常链路（[bot.py:765](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/chat/message_receive/bot.py#L765)）。AstrBot 的 aiocqhttp 适配器把 `post_type=notice` 转成 `AstrBotMessage`，并把 poke 转成 `Poke` 组件（[aiocqhttp_platform_adapter.py:168](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py#L168)）。NoneBot 用 `on_notice` 匹配通知（[on.py:189](https://github.com/nonebot/nonebot2/blob/2450b67/nonebot/plugin/on.py#L189)）。
- **我们**：`worker.ts:217-218` 只接受 `GROUP_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`，其余一律 `{op:12,d:0}`；没有 notice 分支、没有成员进出/禁言/戳一戳的处理。`schema.sql` 也没有事件表。
- **怎么借**：加一个 `notice` 归一化层，至少处理 `group_recall`、`group_increase/decrease`、`group_ban`、`poke`；事件写 `activity`，需要模型反应的（如被戳）再排一个轻量 job；不要把所有 notice 都当聊天消息。

### 22. 管理员命令（/help、/status、/stop） — 部分有（P1）

- **成熟项目**：AstrBot 内置 `/help`、`/sid`、`/name`、`/reset`、`/stop`、`/new`、`/stats`、`/provider`、`/set`、`/unset`，并用 `filter.permission_type(ADMIN/SHARED_GROUP_ADMIN)` 控权限（[main.py:28-90](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/builtin_stars/builtin_commands/main.py#L28)）；`HelpCommand.help` 动态列启用中的命令（[help.py:67](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/builtin_stars/builtin_commands/commands/help.py#L67)）。NoneBot 用 `SUPERUSER` 做权限位（[permission.py:111](https://github.com/nonebot/nonebot2/blob/2450b67/nonebot/permission.py#L111)）。
- **我们**：群内只有 `/方案`/`/开工`（`policy.ts:9-20`）和绑定用的 `/绑定`/`/登录`（`worker.ts:220-267`）；`/help` 只有网页静态说明（`guide.ts`，`worker.ts:1261`/`:1336` 提供页面）；`/status` 只有网页 `/api/team/ops`（`worker.ts:2025-2041`）和 `/api/team/state`（`worker.ts:2043`），群里没有命令；`/stop` 没有。
- **怎么借**：先加四个最小命令：`/help`（列命令 + 一句用法）、`/status`（本群绑定、最近 job、outbox 失败数、模型额度）、`/stop`（取消本群当前 research/plan/media，owner 或发起人）、`/set`（开关，见 #23）。权限用现有 `who.role==='owner'`（`worker.ts:102-103`）或 `members.role`，不要新造一套。

### 23. 开关/热配置/灰度 — 部分有（P2）

- **成熟项目**：AstrBot 的 `/set`/`/unset` 写会话变量（[setunset.py:9](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/builtin_stars/builtin_commands/commands/setunset.py#L9)、[:22](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/builtin_stars/builtin_commands/commands/setunset.py#L22)），配置有 WebUI 和热加载。
- **我们**：`rhythm.ts:58-63` 的 `SWITCH_KEYS` 有 `off:wait`、`off:quote`、`off:sticker_send`、`off:sticker_collect`、`sticker_paused_until`、`auth:bili`、`auth:x`、`off:repo_tools`，`loadSwitches` 一次读；`semantic.ts:809`/`:1223` 用 `off:repo_tools` 控制仓库工具。但**群内没有命令**改这些键，只有网页/DB。
- **怎么借**：`/set off:repo_tools 1`、`/set off:sticker_send 0` 这类命令，校验 key 在白名单、value 只允许 0/1；写 `activity` 审计；按群作用域（现在是全局 `settings`）。

### 24. 撤回与编辑处理 — 没有（P1）

- **成熟项目**：MaiBot 的 notice 链路把撤回/禁言等当通知类消息识别（[bot.py:765](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/chat/message_receive/bot.py#L765)）。NoneBot OneBot 适配器定义 `GroupRecallNoticeEvent`（[event.py:365](https://github.com/nonebot/adapter-onebot/blob/8e0d114/nonebot/adapters/onebot/v11/event.py#L365)），可以 `on_notice` 订阅。
- **我们**：只处理两种 message 事件（`worker.ts:217-218`），没有 recall/edit 分支；`messages` 表也没有 `recalled` 字段。被撤回的消息仍留在 `messages`/`message_meta`，后续上下文还可能引用。
- **怎么借**：加 `messages.recalled_at`/`message_meta.recalled`；收到 `group_recall` 时把对应消息标记并从「最近上下文」过滤，但保留原始行供审计；如果被撤回的是 bot 引用过的消息，在下一次回复里注明「原消息已撤回」。QQ 官方接口若不推 recall，就在 OneBot/NapCat 适配器层补；不要假装支持编辑（QQ 群消息本身没有编辑事件）。

### 25. 工具失败如实说原因并给下一步 — 部分有（P1）

- **成熟项目**：MaiBot 的 `ToolExecutionResult` 明确带 `success`/`error_message`，异常统一包成「工具 X 调用失败：…」（[core/tooling.py:215](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/core/tooling.py#L215)、[:219](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/core/tooling.py#L219)、[:221](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/core/tooling.py#L221)、[:439](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/core/tooling.py#L439)）。AstrBot 在工具异常时把 `error: {e}` 追加进 tool result，并给重复调用提示（[tool_loop_agent_runner.py:1653](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/agent/runners/tool_loop_agent_runner.py#L1653)）。
- **我们**：仓库工具已经有 `{ok:false,error_kind,retryable,next_action}`（`repo.ts:14-18`），链接读取有 `webFailText` 分原因（`linkfail.ts:38-44`），`read_web` 会把 `reason_text` 放进结果（`semantic.ts:1189-1199`）。**但**通用 catch 只回一句「未能获得资料，不能据此编造结论」（`semantic.ts:1229-1234`），没有 `next_action`；`search_web` 失败也只抛 HTTP 状态。
- **怎么借**：所有工具统一返回 `{ok:false, error_kind, retryable, next_action}`；`next_action` 要具体到「换哪个来源/缩小哪个参数/稍后再试」；嘴替必须把 `next_action` 说出来，不能只说「失败」。日志里记 `tool_name/args_hash/error_kind/latency`，别记原始参数。

### 26. 「做不到」时自动换路 — 部分有（P2）

- **成熟项目**：AstrBot 搜索多 key 轮换，401/403/429/432 自动换 key（[web_search_tools.py:95](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/web_search_tools.py#L95)、[:137-150](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/web_search_tools.py#L137)）。
- **我们**：`readUrl` 已有链式回退：推特 fx→syndication→oembed（`semantic.ts:423-456`），GitHub README→Jina→DeepSeek fetch（`semantic.ts:463-492`），仓库 cloud→index（`repo.ts:119-130`）。**但**任务层没有通用替代方案：搜不到就结束，读不到就回一句，plan 失败就 `needs_human`。
- **怎么借**：把「换路」写成显式策略表：GitHub → 本机 git → 缓存；网页 → Jina → DeepSeek fetch → 搜索摘要；B 站 → 字幕 → 音轨 → 卡片标题；搜索 → 换关键词 → 换 provider。每次换路写 `activity`，让用户看到「我换了哪条路」。

### 27. 可观测性（工具调用日志） — 部分有（P1）

- **成熟项目**：MaiBot 有 `record_monitor_event` 记录事件，工具调用记录会脱敏大媒体后落库（[monitor/event_store.py:57](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/monitor/event_store.py#L57)、[utils/tool_record_payload.py:1](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/utils/tool_record_payload.py#L1)）。
- **我们**：`schema.sql:23` 的 `activity`、`:56` 的 `chat_decisions`、`:62` 的 `stage_timings`、`:25` 的 `model_runs` 都有；`runtime.ts:25` 写 activity，`timing.ts:12` 写阶段。**没有** `tool_calls` 表：工具名、参数（脱敏）、结果状态、耗时、turn id 都没有落库；`semantic.ts` 的工具循环只在内存里 push `messages`。
- **怎么借**：加 `tool_calls(id, turn_id, group_id, name, args_hash, args_preview, status, error_kind, latency_ms, created_at)`；参数只存脱敏后的前 200 字；网页 `/api/team/ops` 加「最近工具失败」筛选。这样「为什么没答上」能直接看到是哪一步。

### 28. 安全（提示注入/权限/敏感信息） — 有

- **成熟项目**：AstrBot 有独立的内容安全 stage，支持关键词和百度 AIP（[content_safety_check/stage.py:15](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/pipeline/content_safety_check/stage.py#L15)）。NoneBot 用 `SUPERUSER` 把管理员命令和普通消息分开（[permission.py:111](https://github.com/nonebot/nonebot2/blob/2450b67/nonebot/permission.py#L111)）。
- **我们**：`untrusted.ts:3-19` 给所有外部资料打 `【外部资料·不可信】` 标记；`authz.ts:8-22` 的 `tainted` 一旦引入外部资料/引用/卡片，后续写工具不能再洗白；`authz.ts:112-126` 要求写工具必须有当前成员逐字原话 + 意图匹配；`runtime.ts:4-23` 的 `redact` 覆盖 token/私钥/常见 key；`github.ts:129-135` 还会按环境变量值做 redact。
- **缺口**：没有内容安全（违法/有害/自伤等）分类；没有把 `SUPERUSER` 概念显式化（现在是 `members.role`/`owner`）；`member_names`/`facts` 没有群作用域。
- **怎么借**：保留现有 taint/authz；加一个轻量关键词 + 可选分类器 stage（照 AstrBot），命中就拒答并给求助渠道；把 owner/管理员命令统一走一个 `requireRole`。

### 29. 多群隔离 — 没有（P0）

- **成熟项目**：kirara-ai 的 `MemberScope` 用 `member:<group>:<user>`，`GroupScope` 用 `group:<group>`，查询时校验 `group_id`（[builtin_scopes.py:6](https://github.com/lss233/kirara-ai/blob/36249e4/kirara_ai/memory/scopes/builtin_scopes.py#L6)、[:36](https://github.com/lss233/kirara-ai/blob/36249e4/kirara_ai/memory/scopes/builtin_scopes.py#L36)）。AstrBot 用 `unified_msg_origin` 做所有会话/配置键（[astr_message_event.py:175](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/platform/astr_message_event.py#L175)）。Koishi 的 `getChannel` 同时带 `guildId`/`channelId`（[session.ts:235](https://github.com/koishijs/koishi/blob/97d5c39/packages/core/src/session.ts#L235)）。
- **我们**：`settings` 里只有一个 `group_id`（`worker.ts:220-244`），绑定也是单群（`worker.ts:2291`）；`receive` 对 `m.group_openid !== group` 直接丢（`worker.ts:244`）。`chat_cursor` 是全局单键（`worker.ts:487`），`advanceCursor` 只按 `groupId` 查剩余消息但写全局键（`worker.ts:485-497`）。`semantic.ts:811-815` 的 `recentBot` 查 `outbox` 不带 `group_id`，多群后会串 bot 发言。`facts`/`member_names`/`settings` 都没有 `group_id`。
- **怎么借**：按 kirara 的 scope 改造：`settings` 键加 `:<group_id>`，`chat_cursor:<group_id>`，`facts`/`member_names` 加 `group_id`，`recentBot`/`recall`/`expressions` 全部按群过滤；迁移时把旧全局值复制到当前群。先做「单群兼容 + 多群可开」，不要一次性改所有表。

### 30. 文件交付/群文件发送 — 有

- **成熟项目**：AstrBot 的 `send_message_to_user` 支持文本/图片/文件，送本地文件前检查允许根目录（[message_tools.py:36](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/message_tools.py#L36)、[:62](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/message_tools.py#L62)、[:76](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad/astrbot/core/astr_agent_runtime/tools/message_tools.py#L76)）。
- **我们**：`runner/delivery.mjs:107` 的 `deliverFiles` 负责清理输出、保留未确认文件、上报；`:142` 限单文件 50 MB；`schema.sql:27` 的 `deliveries` 记 `files/sent_count/status`；`worker.ts:947-1095` 的 `sendOutbox` 负责 QQ 上传和回执；`guide.ts:30` 写的是「单文件最多 50 MB，每次最多 5 个」。
- **怎么借**：保留；补「发送结果未知」的幂等（`deliveries.status` 已有 `unknown`，`worker.ts:1185` 会把超时标 unknown），以及「超过 5 个文件先打包/拆分」的预检。AstrBot 的允许根目录检查值得照搬，防止模型把 `~/.ssh` 之类路径塞进交付。

---

## 可直接借用的文件/函数（按性价比）

| 优先 | 项目 · 文件 · 函数 | 语言 | 搬过来要改什么 | 许可证 |
|---|---|---|---|---|
| 1 | NoneBot2 `nonebot/rule.py` · `to_me()` | Python | 改成 TS 的 `isAddressedToBot(event)`，保留「reply 也算 to_me」 | MIT |
| 2 | NoneBot2 `nonebot/permission.py` · `SUPERUSER` | Python | 换成 `requireRole('owner' 或 'admin')`，接到现有 `who.role` | MIT |
| 3 | adapter-onebot `event.py` · `GroupRecallNoticeEvent` | Python | 只借字段（group_id/user_id/message_id/operator_id），在 `receive` 加 notice 分支 | MIT |
| 4 | Koishi `packages/core/src/session.ts` · `Session.stripped` | TypeScript | 几乎可直接改成 `stripAddressed(body, selfId, quoteAuthorId)` | MIT |
| 5 | GitHub MCP `pkg/github/repositories.go` · `list_commits` / `get_commit` / `get_file_contents` | Go | 照参数和返回结构重写 TS；我们已有 `github.ts`，补 `since/author/path` 和 `search_code` | MIT |
| 6 | AstrBot `cron_tools.py` · `FutureTaskTool` | Python | 重写 TS：`reminders` 表 + `future_task` 工具（create/list/edit/delete） | AGPL-3.0（照思路重写） |
| 7 | AstrBot `message_tools.py` · `GetGroupMessageHistoryTool` | Python | 重写 TS：`search_history`（group_id、limit≤50、keyword/sender/before_id） | AGPL-3.0（照思路重写） |
| 8 | AstrBot `web_search_tools.py` · `_KeyRotator.get` | Python | 重写 TS：多 key 轮换 + 401/403/429 重试；我们目前只有一个 DeepSeek key | AGPL-3.0（照思路重写） |
| 9 | MaiBot `builtin_tool/subagent.py` · `subagent_status` / `subagent_stop` | Python | 重写 TS：`task_status`/`task_cancel`，复用 `jobs` 表 | GPL-3.0（照思路重写） |
| 10 | MaiBot `context/compaction.py` · `build_context_summary` | Python | 重写 TS：滚动摘要 + 最近 N 条；存 `settings` 或新表 | GPL-3.0（照思路重写） |
| 11 | MaiBot `turn_trigger/reply_likelihood.py` · `estimate_reply_probability` | Python | 只借 8 个特征和 logistic 形式，权重要用我们自己的 `chat_decisions` 重拟合 | GPL-3.0（照思路重写） |
| 12 | kirara-ai `memory/scopes/builtin_scopes.py` · `GroupScope` / `MemberScope` | Python | 重写成 `groupScope(groupId)` / `memberScope(groupId,userId)`，给 facts/member_names 加 group_id | AGPL-3.0（照思路重写） |

> 直接拷 MIT 代码也要保留版权声明；AGPL/GPL 只建议照思路重写，不要把代码整段搬进 TeamAgent。

---

## 缺口优先级前 10

> 排序按「会不会让正常使用失败/丢数据/让用户觉得 Bot 不存在」。P0 先修，P1 本版修，P2 进 next。

### P0-1. 全局 `chat_cursor` + 单群绑定：@ 也会被跳过，未来必串群

- **证据**：`worker.ts:487` 写全局 `chat_cursor`；`worker.ts:672-680` 先判 `m.ordinal <= cursor` 再判 mentioned；`worker.ts:220-244` 只允许一个 `group_id`；`semantic.ts:811-815` 的 `recentBot` 不带 `group_id`。
- **后果**：回放/别的群/异常 rowid 把游标推大后，真实 @ 消息会 `status='done'` 静默跳过；多群后 bot 会把 A 群发言带进 B 群。
- **修法**：`chat_cursor:<group_id>`；mentioned/replyTo 判断前置；`recentBot`/`facts`/`member_names`/`expressions` 加群过滤；补迁移和回放测试。
- **验收**：同一群先回放 10 条旧消息把游标推大，再发一条 @，必须回复；两个群交替发 @，各自只带自己的上下文。

### P1-2. 仓库问答只在「token + 索引」双健康时可用

- **证据**：`github.ts:146` 白名单仓库必须有 `GITHUB_TOKEN`；`repo.ts:108` 无索引回 `not_synced`；`repo.ts:131-135` 索引只留 90 天/500 条；`worker.ts:1378` 接收本机索引。
- **后果**：用户问「仓库有哪些新提交」，得到的是「需要 token」或「本机同步端还没上报」，不是提交列表；这正是用户这次不满的点。
- **修法**：`/status` 显示 token/索引新鲜度；`repo_changes` 带 `source/indexAgeMinutes`；runner 在线时直接 `git log` 当前 worktree；`needs_token`/`not_synced` 的 `next_action` 写成「让 owner 配 token / 启动本机 runner」。
- **验收**：不配 token 但 runner 在线，问「最近 7 天提交」能返回 `git log` 结果；配 token 时返回 GitHub 结果并带 7 位 sha。

### P1-3. 群消息历史不可检索

- **证据**：`context.ts:47` 只取 24 条；`context.ts:26` 批次 60 条；工具表 `semantic.ts:652-810` 没有 history 工具。
- **后果**：用户问「上周谁说的那个接口」只能靠模型猜；跨天上下文直接丢失。
- **修法**：照 AstrBot `GetGroupMessageHistoryTool` 加 `search_history`（当前群、≤50 条、keyword/sender/before_id）。
- **验收**：发 100 条消息后问第 1 条的内容，工具能按关键词/发送人找回，并标注消息 id/时间。

### P1-4. 没有定时提醒/待办

- **证据**：`policy.ts:9-20` 只有 `/方案`/`/开工`；`schema.sql` 无 reminders 表；`worker.ts:1100` 的 scheduled 只跑 scout/dream/清理。
- **后果**：「明早 9 点提醒我」只能靠人记；这是群 bot 最基本的功能之一。
- **修法**：照 AstrBot `future_task` 做 `reminders` 表 + `future_task` 工具（create/list/edit/delete，run_at/cron/run_once）；到点复用 outbox。
- **验收**：创建「1 分钟后提醒」，到点在群里发出；`list` 能看到，创建者能删，别人不能删。

### P1-5. 长任务没有中间进度、不能查询/取消

- **证据**：`semantic.ts:906-931` 只回「已开始」；`worker.ts:584-591` 只在完成时写 activity；`runner/subagent.py:302-305` post `/api/runner/subagent/progress`，`worker.ts` 没有该路由；`worker.ts:1998-2015` 网页也只取消 media job。
- **后果**：用户等几分钟不知道在干什么；失败后只能看到「未完成」。
- **修法**：加 progress 路由写 `jobs.payload.progress`/`stage_timings`；加 `task_status`/`task_cancel` 工具；research/plan/media 都支持 owner 取消。
- **验收**：跑一个 2 分钟任务，中途 `/status` 能看到阶段；`/stop` 能取消并回执；完成后不再显示 running。

### P1-6. 群内没有管理命令

- **证据**：`policy.ts:9-20` 只有两个命令；`/help` 只有网页（`worker.ts:1261`/`:1336`）；`/status` 只有 `/api/team/ops`（`worker.ts:2025-2041`）；没有 `/stop`。
- **后果**：群主在群里没法查状态、停任务、关开关，只能开网页；用户会觉得「这 bot 没有基本操作」。
- **修法**：`/help`、`/status`、`/stop`、`/set` 四个；权限用 `who.role==='owner'` 或 `members.role`；中文文案，和 `guide.ts` 一致。
- **验收**：群里 `/help` 列出命令；`/status` 显示绑定群、最近 job、outbox 失败数；`/stop` 取消当前任务；非 owner 用 `/set` 被拒。

### P1-7. 撤回/编辑/群事件全部没有

- **证据**：`worker.ts:217-218` 只接两种 message 事件；`messages` 无 `recalled` 字段；无 notice 分支。
- **后果**：被撤回的消息还在上下文里，bot 可能引用已撤回内容；入群/退群/禁言/戳一戳完全无感。
- **修法**：加 notice 归一化；`group_recall` 标记并过滤；`group_increase/decrease`、`group_ban`、`poke` 写 activity，必要时排轻量 job；QQ 官方不推的事件在 OneBot/NapCat 层补。
- **验收**：撤回一条被 bot 引用过的消息，下一次回答不再复述原文；新人入群有欢迎/记录；被戳有反应。

### P1-8. 长对话没有摘要压缩

- **证据**：`context.ts:47` 固定 24 条；`context.ts:26` 固定 60 条；`src/` 没有 summary/compact。
- **后果**：长会话只记得最近 24 条，之前的内容要么变 facts，要么丢；token 也可能被长消息撑爆。
- **修法**：照 MaiBot `build_context_summary` 做「上一版摘要 + 最近 N 条 + 新消息」；按 token 预算触发；摘要不进 facts。
- **验收**：连续聊 200 条后问第 10 条的决定，回答能引用摘要里的结论，且不把它当新事实。

### P1-9. 工具失败没有统一 `next_action`

- **证据**：`repo.ts:14-18` 有结构化失败；`semantic.ts:1229-1234` 通用 catch 只有一句「未能获得资料」；`search_web` 失败只抛 HTTP。
- **后果**：用户只听到「失败了」，不知道是没 token、没索引、被风控还是超时；也不知道下一步该做什么。
- **修法**：所有工具统一 `{ok:false,error_kind,retryable,next_action}`；嘴替必须说 `next_action`；日志记 `tool_calls`。
- **验收**：分别制造 token 缺失、索引过期、网页 404、搜索 429，四种回复都能说出不同原因和下一步。

### P1-10. 工具调用不可观测

- **证据**：`schema.sql:23/56/62` 只有 activity/decisions/stage；没有 `tool_calls` 表；`semantic.ts` 工具循环不落库。
- **后果**：用户说「刚才为什么没答上」时，只能翻聊天记录猜；无法统计哪个工具最常失败。
- **修法**：`tool_calls(turn_id, group_id, name, args_hash, args_preview, status, error_kind, latency_ms)`；参数脱敏；`/api/team/ops` 加筛选。
- **验收**：一次回答里调用 3 个工具，数据库有 3 行，能按 turn 串起来；失败行有 error_kind。

### 备选 P2（本版可不做）

- 表情包发送默认关闭（`config/team.json` `stickers.send=false`）：先做限流再开。
- 主动冷场/频率模型：照 MaiBot 的 8 特征 + idle backoff，先固定权重。
- 长回答分段：`voice.ts:33-57` 从 banter 扩到 work。
- 通用链接 unfurl：oEmbed/OpenGraph，补 B 站卡片字段。
- 自省拆模型：trace→judge→consolidate，避免同模型自评。

---

## 附：本次没验证的

- **实验**：浅克隆 AstrBot/MaiBot/kirara-ai/NoneBot2/Koishi 与 GitHub MCP Server，按文件、函数、行号核对；没有启动这些项目跑真实群消息，也没有跑 TeamAgent 的真实回放。
- 生产 Worker 是否配置 `GITHUB_TOKEN`、`runner_seen` 是否新鲜、`chat_cursor` 当前值：本文只读代码，没有读生产 D1；这些要看 `/api/team/ops` 和 `/health`。
- QQ 官方接口是否推送 `group_recall`：代码里只接了两种 message 事件；如果平台不推，需要 OneBot/NapCat 适配器，本文没有实测平台能力。
- 表情包发送、语音转写、B 站音轨的真实线上成功率：本文只对照代码路径，没有跑真实群回放。
- 各成熟项目的许可证义务：AGPL/GPL 项目只建议照思路重写，不直接拷代码；MIT 项目（NoneBot/Koishi/GitHub MCP）可直接借用并保留版权声明。
