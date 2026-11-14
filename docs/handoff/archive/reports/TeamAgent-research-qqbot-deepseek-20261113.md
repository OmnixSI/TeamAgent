# QQ 机器人成熟链路调研与 TeamAgent 一次性大版本路线

调研员（DeepSeek）· 2026-11-13 · 只读调研，未改任何项目文件

方法：`git clone --depth 1` 读取源码（记录 commit），GitHub API 取版本/许可证/issue 数；TeamAgent 主检出 `/Users/yanghongming/Projects/TeamAgent` 已不存在，改读 `.worktrees/TeamAgent-c1b-cloud`（HEAD `e7f52e4`，2026-11-13 10:43）。Star/issue 数为 2026-11-13 抓取。11:02 补充指示后：第四节改为文件/函数级搬运清单，路线 A 按技术可行性重评，许可证只留 NOTICE 记录。

## 结论

1. **不能直接换框架（技术原因，不是协议）。** MaiBot、AstrBot、kirara 都是 Python 单进程常驻宿主；TeamAgent 是 Cloudflare Worker + D1 + Queues + 官方 QQ 长连接 + 本机 runner。换过去要一台 7×24 主机（自己的机器或 VPS），和现在的无服务器形态相反，还会丢掉工作台、记忆、接力这些已验收的产品面。[推断：迁移 2–4 周]
2. **也不该继续“修一点提一点”。** 本机 4 天内 107 个提交、51 个以 `fix:` 开头（`git log --since='4 days ago'`），其中引用、表情、B 站卡片反复出现：`1b748a1`、`3b61328`、`22854b4`、`91b501d`。问题不在单点代码，而在**事件层没有一份验收基线**。
3. **最推荐：保留架构，做一次“事件层 v2”大版本。** 按下面的 20 条验收表一次补齐，用真实事件做回放夹具，全部通过后只发一次。工作量 [推断] 9–11 人日，两人并行约 1 周，另加 2 个验证日。
4. **最值钱的一块可以直接翻译：MaiBot 的 QQ 官方适配器是 MIT。** 独立仓库 `Mai-with-u/MaiBot-QQ-Adapter`（MIT，2026-10-31），内置版 0.4.7 也自带 MIT LICENSE。`codec.py`、`quoted_media.py`、`plugin.py` 里的 REFIDX/配额/上传子集都是纯 Python 标准库或 aiohttp，逐函数翻成 TS 即可（见第四节表）。
5. **许可证只做 NOTICE 记录：** MaiBot 核心 GPL-3.0、AstrBot/kirara AGPL-3.0、Yunzai GPL-3.0、LangBot Apache-2.0、NoneBot2/Koishi/MaiBot-QQ-Adapter MIT。MIT/Apache 的按文件直接翻译并署名；copyleft 的按行为重写、不逐行复制——NOTICE 只能满足 MIT/Apache 的署名，不能满足 GPL/AGPL。NapCat 无代码（仓库已清空），没有可搬的东西。[NapCat README](https://github.com/NapNeko/NapCatQQ/blob/105f38e/README.md)

> 一句话回答“为什么还在原地打转”：成熟项目解决的是“通用单机 bot”，我们解决的是“云端 + 官方 QQ API + 本机执行 + 团队工作台”的异构系统；通用部分（引用、媒体、限流、分段）它们早已做完，但我们没有把它们的做法固化成验收表，于是每个线上现象都被当成新 bug 修。

## 一、事件与场景验收表（可直接当测试用例）

| # | 场景 | 常见坑 | 成熟做法（出处） | TeamAgent 现状 |
|---|---|---|---|---|
| 1 | 发送引用回复 | 引用索引过期后 400/422；重试可能重复发 | MaiBot 按 24h 保留 REFIDX、上限 2000 条（其注释称官方 REFIDX 无与被动回复一致的有效期）；用 `msg_id + msg_seq` 定位；失败去掉引用重发（[MaiBot adapter](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/plugins/built_in/qq_official_adapter/plugin.py)） | `src/quote.ts` 从 `message_refs` 取 ref_idx，**无 TTL**；`worker.ts` 有去掉引用重试 |
| 2 | 取回被引用消息 | 引用段只有摘要；图片 URL 会过期 | OneBot 用 `get_msg` + 递归 forward（AstrBot）；官方 QQ 无 `get_msg`，只能用 `msg_elements` 预览 + 本地存原图（MaiBot adapter） | 只解析 `msg_elements` 内嵌内容；本地未存原图，预览缺图时没有回退 |
| 3 | 合并转发 | 嵌套多层、体积爆炸 | 递归 `get_forward_msg` 限跳；MaiBot 工具用 `path` 逐层展开（[view_forward_message.py](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/builtin_tool/view_forward_message.py)） | 只在 rhythm 里识别 `forwarded`，没有展开 |
| 4 | 图片链接过期/防盗链 | QQ 媒体 URL 带时效；B 站图要 Referer | 收到即下载 → sha 缓存 → TTL 清理（[MaiBot image_cache_cleanup](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/chat/image_system/image_cache_cleanup.py)；[AstrBot image_resolver](https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/utils/quoted_message/image_resolver.py)） | `vision.ts` 有 sha 缓存/预算/SSRF 拦截，但原图不持久化（表情除外） |
| 5 | 表情/mface | face id 无语义；mface URL 会过期 | face→文字映射 + VLM 打标 + 语义匹配（[MaiBot emoji_manager](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/emoji_system/emoji_manager.py)） | `stickers.ts` 已有收集/打标/发送；face 兼容见 `3b61328` |
| 6 | 动图 GIF/WebP | 只取首帧、转存丢帧 | 保留原 mime 与原字节；GIF 拆分/合成（[memes image_operations](https://github.com/MemeCrafters/nonebot-plugin-memes/blob/836d441/nonebot_plugin_memes/matchers/image_operations.py)） | `stickers` 存 BLOB 原字节，方向正确 |
| 7 | JSON/小程序卡片 | 多层转义、嵌套 JSON、缺 jump_url | 递归解析 + 卡片标题回退 | `bili-links.ts` 递归 32 层、反转义、白名单，**这是强项** |
| 8 | @ / @全体 | At 段与文本混排；@bot 判定 | 独立 At/AtAll 组件 + 唤醒检查（[AstrBot waking](https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/waking_check/stage.py)） | `inbound.ts` 有 mentions/mentionsBot，够用 |
| 9 | 戳一戳 | 官方 QQ API 没有入站事件 | OneBot `notice/notify/poke`，AstrBot 已接（[aiocqhttp adapter](https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py)） | **当前通道拿不到**，需 NapCat 才能做 |
| 10 | 撤回 | 官方 API 无入站撤回事件 | OneBot `group_recall`；MaiBot 提供主动撤回工具 | **当前通道拿不到** |
| 11 | 群公告 | OneBot 11 无标准事件，NapCat 有扩展 | 主动查询/扩展事件 | **当前通道拿不到** |
| 12 | 长文本拆分 | 单条 4000 字截断；拆多了触发配额 | AstrBot 按词/正则分段（[result_decorate](https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/result_decorate/stage.py)）；LangBot 可转图片/合并转发（[longtext](https://github.com/langbot-app/LangBot/blob/4625b57/src/langbot/pkg/pipeline/longtext/longtext.py)） | `worker.ts` 只 `slice(0,4000)` 单条，未语义分段 |
| 13 | 被动回复限流 | 群 5 条/300 秒，超了直接失败 | MaiBot 适配器按 `(300s, 5)` 群 / `(3600s, 4)` 单聊控制；AstrBot 固定窗口排队（[rate_limit](https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/rate_limit_check/stage.py)） | **无配额计数**，长回复/多段时可能静默失败 |
| 14 | 重试去重 | 重试导致重复发送 | 稳定 `msg_seq` + outbox 状态机 | `messageSequence(id)` 稳定，做对了 |
| 15 | 语音 | SILK/格式/20MB；平台只给 ASR 文本 | LangBot 有独立 ASR/TTS stage（[speech.py](https://github.com/langbot-app/LangBot/blob/4625b57/src/langbot/pkg/pipeline/speech/speech.py)）；MaiBot 适配器支持语音收发 | **完全没有 ASR**，只用 QQ 的 `asr_refer_text` |
| 16 | 文件 | file_ref/base64、100MB、路径安全 | 分片上传 + 失败原样报错（MaiBot adapter README） | 附件收发有，上传链路未核 |
| 17 | 多模态读图 | 超大图、隐私、费用 | provider 抽象 + 预算 + 缓存 | `vision.ts` 有预算/缓存/失败原因，较成熟 |
| 18 | B 站短链 | b23 多级跳转、追踪参数 | 跟随跳转 + host 白名单 | `runner/fetcher.mjs` 已做，且区分短链 |
| 19 | B 站字幕 | wbi 签名、`need_login_subtitle`、字幕 CDN 防盗链 | wbi + `/x/player/wbi/v2` + hdslb | 已实现，登录态/失败原因也区分 |
| 20 | B 站无字幕总结 | 无字幕、AI 总结要登录、音频大 | 下载音频 → ASR → 临时文件清理；**没有现成开源项目完整做**（bilichat 也不做） | **缺**，且用户硬需求明确 |

补充坑：MaiBot changelog 记过“回复引用从基于时间改为基于新消息”“GIF 表情识别”“表情包重复注册”“图片发送错误处理”（[changelog_old.md#L1686](https://github.com/Mai-with-u/MaiBot/blob/03347c9/changelogs/changelog_old.md#L1686)）；1.4.3 还在“修复 wait 和防抖配合问题”（[changelog.md#L11](https://github.com/Mai-with-u/MaiBot/blob/03347c9/changelogs/changelog.md#L11)）。这些正是我们反复修的同类问题。

## 二、项目对比（全链路分层）

| 项目 | 接入层 | 决策/理解/编排 | 记忆/工具 | 发送/失败兜底 | 维护（2026-11-13） | 许可证 |
|---|---|---|---|---|---|---|
| **MaiBot** | NapCat/SnowLuma/官方 QQ/微信/Telegram 适配器 | Maisaka：`turn_trigger` 概率门控 → Planner → replyer | A_memorix 记忆、表情/图片系统、内置工具 | platform_io 统一发送；适配器按类型拆分、分片上传 | v1.4.3 / 11-08；7.0k star；138 open | GPL-3.0（QQ 官方适配器单独 MIT） |
| **AstrBot** | 18 个平台适配器（含 aiocqhttp、qqofficial） | 9 段 pipeline：唤醒→白名单→会话→限流→安全→预处理→处理→装饰→发送 | 插件 Star、知识库、provider、agent runtime | respond 阶段统一发；限流可排队/丢弃 | v4.29.4 / 10-31；46.8k star；1,199 open | AGPL-3.0 |
| **kirara-ai** | 微信/QQ/Telegram 等 | 工作流（workflow/system blocks）+ 插件 | 多模态、记忆、网页搜索 | 工作流出口统一发送 | v3.2.1 / 10-22；19.3k star；2 open（但已 3 周无推送） | AGPL-3.0 |
| **LangBot** | 12+ 平台，含 aiocqhttp/QQ | pipeline：bansess→cntfilter→resprule→preproc→process→longtext→speech→ratelimit→wrapper→respback | RAG、插件、MCP、agent | 各 stage 明确职责；长文本/语音独立 stage | v4.11.7 / 11-11；18.9k star；140 open | Apache-2.0 |
| **NoneBot2** | 适配器分离（OneBot v11 单独包） | matcher/rule/permission，内核不管“怎么回” | 全靠插件 | 插件自理 | v2.5.0 / 04-01；7.8k star；38 open | MIT |
| **Koishi** | 适配器插件化 | session/middleware/command | 插件生态 | 插件自理 | 4.18.11 / 03-09；6.3k star；113 open | MIT（TypeScript，和我们的栈最近） |
| **Miao-Yunzai** | ICQQ/OneBot | 插件加载器 + 指令 | 插件生态（miao-plugin 1.6k star） | 插件自理 | 1.1k star；11-12 有推送 | GPL-3.0 |
| **NapCat** | OneBot v11 实现（QQ 协议侧） | 不涉及 | 不涉及 | 上报富事件（notice/request） | 12.8k star，但仓库 11-12 被清空为 48 字节 README | **无 LICENSE** |
| **nonebot-plugin-bilichat** | NoneBot 插件 | B 站链接解析/订阅 | 依赖外部 bilichat API 服务 | 卡片渲染 | 263 star；最后推送 2026-01-02；1 open | AGPL-3.0 |
| **nonebot-plugin-memes** | NoneBot 插件 | 表情包生成（Pillow/GIF） | 模板库 | 返回图片 | 312 star；10-06 推送；17 open | MIT |

**分层结论：** 所有成熟项目都是“适配器归一化 → 中间件/管线（限流、唤醒、预处理）→ 决策/模型 → 结果装饰（分段/TTS）→ 平台发送”这条链。差别只在“决策”是规则（AstrBot/LangBot/NoneBot）还是概率模型（MaiBot）。TeamAgent 目前把这条链拆在 `inbound.ts / engagement.ts / voice.ts / worker.ts` 里，**缺少显式的 stage 边界**，所以每个平台差异都会渗进业务代码。

## 三、插话/回复决策对比

- **MaiBot（最成熟）**：`reply_likelihood.py` 用 8 个特征算 logit（是否提 bot、是否 @ 别人、问号、纯媒体、近 5 分钟 bot 发言占比、消息数、距上次发言秒数、待处理条数），再经 `dynamic_gate.py` 按“目标回复频率”动态调阈值，@ 强制放行；窗口不足 20 条时用离线阈值表。[代码](https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/reply_likelihood.py)
- **AstrBot**：纯规则唤醒——@、@全体、引用 bot、`wake_prefix`、私聊、插件 filter；没有“回复意愿”模型，主动消息靠 cron/工具。[代码](https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/waking_check/stage.py)
- **LangBot**：群回复规则四选一（atbot/prefix/random/regexp），不匹配就中断；没有概率模型。[rules](https://github.com/langbot-app/LangBot/tree/4625b57/src/langbot/pkg/pipeline/resprule/rules)
- **TeamAgent**：LLM 参与判定 + 防抖 `rhythm.ts` + 未回应硬规则 + 原句去重。方向接近 MaiBot，但每批都直接问模型，缺一层便宜的特征预门控，也没有“实际回复率贴近目标”的反馈环。

**建议**：保留 LLM 判定（它处理“谁在对谁说话”比规则强），前面加一层 MaiBot 式特征门控，只让可疑批次进模型；用 `chat_decisions` 的实发数据重新拟合权重，不照抄数值。目标写成“每小时主动发言 ≤ N 且被接话率 ≥ M”，不要写死冷却。

## 四、许可证记录与可搬模块清单

**NOTICE 用（每项一行）：**

| 项目 | 许可证 | 版本 / commit | 备注 |
|---|---|---|---|
| MaiBot | GPL-3.0 | v1.4.3 / 03347c9 | 核心不逐行复制；QQ 官方适配器单独 MIT |
| MaiBot-QQ-Adapter | MIT | 0.4.7（内置版）/ 独立仓库 2026-10-31 | 直接翻译，保留版权行 |
| AstrBot | AGPL-3.0 | v4.29.4 / bb2e467 | 按行为重写 |
| kirara-ai | AGPL-3.0 | v3.2.1 / 36249e4 | 按行为重写 |
| LangBot | Apache-2.0 | v4.11.7 / 4625b57 | 可翻译，保留 NOTICE |
| NoneBot2 / adapter-onebot | MIT | v2.5.0 / 2450b67；8e0d114 | 可翻译 |
| Koishi | MIT | 4.18.11 / 97d5c39 | 可读/摘函数 |
| Miao-Yunzai / miao-plugin | GPL-3.0 / MIT | main（2026-11-12 推送） | 核心按行为重写；miao-plugin MIT |
| NapCat | 无许可证 | 105f38e（空仓库） | 无代码可搬 |
| bilichat | AGPL-3.0 | 305b873 | 按行为重写 |
| memes | MIT | 836d441 | 可翻译/可 vendor |

按你的指示，许可证不再是技术否决项；但有两条法律事实要写清：(1) MIT/Apache 只需署名；(2) GPL/AGPL 逐行复制会让 TeamAgent 相应部分也受 GPL/AGPL 约束，NOTICE 不能替代许可证。**如果决定整段复用 copyleft 代码，可行路径是把 TeamAgent 相应部分也改为 GPL-3.0/AGPL-3.0 发布（或拆成独立 GPL 模块）**——这是许可证/产品决策，需要用户拍板；技术方案可以按这个前提重写。下面先把模块分成「直接翻译」和「按行为重写」两类，后者不抄代码。

**NOTICE 片段（直接翻译 MIT/Apache 时）：**「本项目的 QQ 官方平台适配协议部分翻译自 MaiBot QQ 官方适配器（Copyright (c) 2026 MaiBot Team，MIT License，https://github.com/Mai-with-u/MaiBot-QQ-Adapter）；分段策略参考 AstrBot（AGPL-3.0）的行为，未复制其代码。」按 MIT 要求随分发附完整 MIT 文本；Apache-2.0 需附 NOTICE 与变更说明。

**模块级清单（路径均在对应 commit 下）：**

| 来源 / 文件（函数） | 语言 / 依赖 | 作用 | 搬到 TeamAgent 的改造 | 工作量 |
|---|---|---|---|---|
| MaiBot `qq_official_adapter/codec.py`（`decode_message` / `encode_message`，605 行） | Python 标准库 json/base64/re/hashlib | 官方 QQ 事件 ↔ 统一消息段；text/@/face/image/voice/file/video 编解码 | 逐函数翻 TS；hashlib→Web Crypto，base64→atob/Buffer | 1–1.5d（直接翻译） |
| 同 `plugin.py::_claim_passive_fields` L1631–1744（约 110 行） | 标准库 | REFIDX 24h/2000 + 群 5 条/300s + `msg_seq` 分配 | 翻 TS；进程内 dict 改 D1（`message_refs` 加 `expires_at`，新建配额表） | 0.5d（直接翻译） |
| 同 `plugin.py::_build_attachments/_download_attachment/_validate_media_url` L914–1078（约 165 行） | aiohttp | 附件归一化、URL 白名单、20MB 上限 | fetch + AbortSignal；保留 host 白名单 | 0.5d（直接翻译） |
| 同 `plugin.py::_upload_media` L1745–1814（约 70 行） | aiohttp | `upload_prepare`→分片 PUT→`upload_part_finish`→`files` | fetch 分片；纯出站，不碰 R2 | 0.5d（直接翻译） |
| 同 `quoted_media.py`（53 行） | 纯 dict 遍历 | 引用预览取图，深度 4/64 项 | 直接翻 TS | 0.2d（直接翻译） |
| MaiBot `turn_trigger/`（reply_likelihood 88 + dynamic_gate 211 + gates 164 + idle_backoff 84 + scheduler 97） | 纯标准库 math/dataclass | 回复概率、动态阈值、空闲退避 | 翻 TS 纯函数；权重用我们 `chat_decisions` 重拟合，不照抄 | 1–1.5d（直接翻译） |
| MaiBot `quote/counter.py` 80 + `quote/rules.py` 26 | 标准库 random | 引用抽签、窗口计数 | 合并进 `decideQuote` | 0.3d（直接翻译） |
| AstrBot `result_decorate/stage.py` 的分段部分（449 行里约 150） | 标准库 re | 按词/正则分段 | 按行为重写；输出 2–3 条 + `msg_seq` | 0.5d（重写） |
| AstrBot `rate_limit_check/stage.py`（108 行） | 标准库 deque | 固定窗口排队/丢弃 | 按行为重写；接 D1 计数 | 0.2d（重写） |
| AstrBot `stage_order.py` 15 + `waking_check/stage.py` 303 | AstrBot 事件对象 | 9 段顺序与唤醒条件 | 只借结构；把 `engagement.ts`/`rhythm.ts` 改成显式 stage | 0.5d（重写） |
| AstrBot `quoted_message/*`（2032 行） | OneBot `get_msg`/`get_forward_msg`/`get_image` | 引用回取、转发递归、图片重取 | **官方 QQ 没有这些 API，当前架构搬不过来**；只有加 OneBot sidecar 才用，按行为重写 | 2–3d（可选） |
| LangBot `resprule/*`（252 行） | re/random | atbot/prefix/random/regexp 规则 | Apache-2.0，可翻 TS + NOTICE | 0.5d |
| LangBot `longtext/strategies/forward.py`（35 行） | 标准库 | 长文转合并转发 | 官方 QQ 不支持发合并转发；改成分段，只借阈值 | 0.2d |
| bilichat `lib/tools.py` + `base_content_parsing.py`（270 行） | re/httpx | b23 展开、B 站链接识别 | 已有同功能；只对照正则，按行为重写 | 0.2d |
| memes `image_operations.py`（257 行） | Pillow/emoji | 表情包生成/GIF | Worker 无 Pillow；放本机 runner（Python）或换 node-canvas；非核心 | 1–2d（可选） |
| Koishi `session.ts` + `middleware.ts`（832 行） | TypeScript | session/middleware 模型 | MIT；框架耦合强，只摘函数/结构 | 0.3d |
| adapter-onebot `event.py`（595 行） | Python dataclass | OneBot 事件模型 | MIT；翻 TS，仅 sidecar 用 | 0.5d（可选） |

**总量：** 必做（codec、refidx/配额、附件、上传、quoted_media、分段、限流、stage 边界）约 5 人日；加 turn_trigger/resprule 约 2 人日；ASR 1.5–2 人日；夹具与验收 2 人日。合计 **9–11 人日**，两人并行约 1 周。标为“可选”的三项（AstrBot quoted_message、memes、adapter-onebot）不影响首个版本。

**搬运顺序（从依赖少、收益大的开始）：**
1. `codec.py`（事件归一化，所有后续都依赖它）
2. `_claim_passive_fields`（引用/配额，直接消掉线上 400/422）
3. `_build_attachments` + `quoted_media.py` + `_upload_media`（媒体/引用图/发送）
4. `result_decorate` 分段 + `rate_limit`（长文本和限流）
5. `turn_trigger`（插话质量，可后置到 v2.1）
6. ASR / B 站无字幕（独立链路，最后接）

## 五、差距分析

| 能力 | 我们的现状 | 成熟做法 | 结论 |
|---|---|---|---|
| 引用索引生命周期 | `message_refs` 无过期、无上限（`schema.sql:48`，`quote.ts:9`） | 24h / 2000 条（MaiBot adapter） | **真 bug**，线上引用失败很可能来自这里 |
| 被动回复配额 | 只按 `msg_seq` 发，不计数 | 群 5 条/300s，超限排队/降级 | **真缺口**，多段回复会静默失败 |
| 引用图/嵌套转发 | 只读 `msg_elements`，未存引用图原图 | OneBot 走 `get_msg`/`get_forward_msg`；官方 QQ 只能靠引用预览，必须收到即存 | **真缺口**；官方通道无回取 API，预览缺图就永久丢失 |
| 无字幕 B 站 | 只取字幕；无 ASR | 下载音频→ASR→清理 | **硬需求未实现** |
| ASR 基建 | 完全无（只有平台 `asr_refer_text`） | LangBot ASR stage；X-ASR 本机 | **硬需求未实现** |
| 长文本 | 单条 4000 字截断 | 语义分段/转图/转发 | 中缺口 |
| 事件面 | 官方 API 只有 3 类消息事件 | OneBot 有 notice/request/meta | **架构约束**，不是 bug |
| 云端读仓库 | 已有（C1b，`repo.ts`） | — | 已具备 |
| 子代理 | C3 本机侧已有，未接 Worker | — | 半成品 |
| 读图/表情 | vision + stickers 已较完整 | — | 基本具备 |
| 验收基线 | 无统一事件夹具，靠线上现象 | 各项目都有适配器级测试 | **根因** |

**重复修的根因（按影响排序）：**
1. 没有“事件 → 归一化 → 决策 → 发送”的验收表，修的是现象不是层。
2. 官方 QQ 通道的语义（REFIDX、被动配额、引用预览）没有被写成常量/测试，MaiBot 已经交过学费。
3. 平台差异散落在 `inbound.ts`/`worker.ts`，没有 adapter 边界，改一处影响另一处。
4. 每修一个点就提 PR/审查，验证成本摊到每次提交，而不是一次验收。

## 六、路线与建议

| 路线 | 做法 | 工作量 [推断] | 技术风险 | 能否一次做大版本 |
|---|---|---|---|---|
| **A 换框架** | 直接部署 MaiBot/AstrBot，接官方 QQ 或 OneBot | 2–4 周（10–20 人日）+ 一台常驻主机 | 技术可行：MaiBot 有官方 QQ 适配器，AstrBot 有 18 个平台；代价是新主机/月费、双份记忆与身份、工作台要另写桥接 | 否，迁移本身多阶段 |
| **B 保留架构，事件层 v2** | 按 20 条验收表一次补齐；翻译 MIT 适配器模块；重写分段/限流；加 ASR；统一 adapter 边界 | 9–11 人日，2 人并行约 1 周 + 2 验证日 | 官方事件面仍窄；需要真实事件夹具 | **是**，一个版本一次上线 |
| **C B + OneBot sidecar** | 另起本机 OneBot 实现，补戳/撤回/公告事件 | B + 2–3 人日 | NapCat 仓库已清空，没有可运行代码；需另找维护中的 OneBot 实现（未查） | 条件式，可后置 |

**推荐 B。** A 现在没有许可证障碍，但技术账不划算：MaiBot/AstrBot 的强项是插件生态和现成事件覆盖，代价是新增一台常驻主机、两套记忆/身份/权限，以及把工作台、仓库读取、接力重新桥接一遍；迁移期比 B 更长。只有当我们决定放弃 Cloudflare Worker 的无服务器形态、接受一台常驻 VPS 时，A 才值得。C 只在“必须感知戳一戳/撤回”时才做；当前 NapCat 仓库只剩 48 字节 README，得先找到可运行的 OneBot 实现。

**B 的落地顺序（一个分支、一个版本，中间不合并）：**
1. **W1 事件归一化 + 夹具**：把 `inbound.ts` 拆成 `adapter/qq-official`，录入 20 条真实事件 JSON（引用/卡片/转发/表情/语音/文件），做回放测试。
2. **W2 引用与配额**：ref_idx 24h + 2000 条上限；群 5/300s 计数与排队；失败去引用重试；`msg_seq` 保持稳定。
3. **W3 媒体**：收到即下载 + sha 缓存；引用图深度 4/64；过期 URL 用消息内 preview/本地缓存回取（官方通道没有 `get_msg`）；GIF 保留原字节。
4. **W4 ASR**：本机 X-ASR，单任务临时目录、时长/大小上限、`finally` 清理；转写只回文本，不落音频。
5. **W5 B 站无字幕**：字幕缺失 → 音频 → ASR → 总结；失败原因分 `no_subtitle/login_required/too_large/asr_failed`，如实回群。
6. **W6 验收与发布**：20 条用例 + 真实群回放 + 一次本机验证；全绿后合并，之后冻结事件层，不再逐 bug 提交。

**不建议做的：**
- 不要把 AstrBot/MaiBot 整仓 vendor 进来（运行形态和双份状态不匹配，不是许可证问题）。
- 不要为了“事件全”直接上 NapCat（空仓库，没有可运行代码）。
- 不要继续按线上现象逐条修；先把验收表跑红，再一次性修绿。

## 七、风险与未核实

- 官方 QQ API 的事件种类、被动回复配额、REFIDX 有效期，本次是通过 MaiBot 适配器代码反推的，**未直接核对腾讯官方文档**；上线前应拿官方文档/实测各验一次。
- MaiBot-QQ-Adapter 独立仓库只有 6 star、最后推送 2026-10-31，内置版 0.4.7 可能更新；翻译前以实际 tag 的代码为准，函数名/行号可能变。
- NapCat 仓库 2026-11-12 被清空为 48 字节 README，是否有新仓库/分支**未查到**。
- X-ASR 的本机接口、内存占用、并发能力**未实测**；W4 的工期是推断。
- 各项目 star/issue 数是 2026-11-13 的 GitHub API 快照，会变。
- B 站无字幕总结没有现成开源实现可直接拷，W5 属于自研，风险最高。
- A 路线的桥接工作量（工作台/D1/身份/权限）没有做原型，10–20 人日是粗估。
- 整段复用 copyleft 代码需要同步改 TeamAgent 的许可证；改许可证对下游/部署的影响**未评估**。

## 八、出处清单

**项目与代码（commit 固定）**
1. MaiBot v1.4.3 — https://github.com/Mai-with-u/MaiBot/tree/03347c9 ；许可证 https://github.com/Mai-with-u/MaiBot/blob/03347c9/LICENSE
2. MaiBot turn trigger — https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/turn_trigger/reply_likelihood.py ；dynamic_gate.py 同目录
3. MaiBot 引用规则 — https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/quote/rules.py
4. MaiBot 转发展开 — https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/maisaka/builtin_tool/view_forward_message.py
5. MaiBot 表情/图片清理 — https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/emoji_system/emoji_cache_cleanup.py ；https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/chat/image_system/image_cache_cleanup.py
6. MaiBot QQ 官方适配器 — https://github.com/Mai-with-u/MaiBot/blob/03347c9/src/plugins/built_in/qq_official_adapter/plugin.py ；quoted_media.py；codec.py；LICENSE（MIT）
7. MaiBot-QQ-Adapter 独立仓库 — https://github.com/Mai-with-u/MaiBot-QQ-Adapter （MIT）
8. AstrBot v4.29.4 — https://github.com/AstrBotDevs/AstrBot/tree/bb2e467 ；许可证 https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/LICENSE
9. AstrBot pipeline 顺序 — https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/stage_order.py
10. AstrBot 唤醒 — https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/waking_check/stage.py
11. AstrBot 引用消息 — https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/utils/quoted_message/extractor.py
12. AstrBot 组件 — https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/message/components.py
13. AstrBot 限流/分段 — https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/rate_limit_check/stage.py ；https://github.com/AstrBotDevs/AstrBot/blob/bb2e467/astrbot/core/pipeline/result_decorate/stage.py
14. LangBot v4.11.7 — https://github.com/langbot-app/LangBot/tree/4625b57 ；许可证 https://github.com/langbot-app/LangBot/blob/4625b57/LICENSE
15. LangBot pipeline — https://github.com/langbot-app/LangBot/tree/4625b57/src/langbot/pkg/pipeline ；longtext/speech 同目录
16. NoneBot2 v2.5.0 — https://github.com/nonebot/nonebot2/tree/2450b67 ；adapter-onebot https://github.com/nonebot/adapter-onebot/tree/8e0d114
17. Koishi 4.18.11 — https://github.com/koishijs/koishi/tree/97d5c39 ；session https://github.com/koishijs/koishi/blob/97d5c39/packages/core/src/session.ts
18. kirara-ai v3.2.1 — https://github.com/lss233/kirara-ai/tree/36249e4
19. Miao-Yunzai — https://github.com/yoimiya-kokomi/Miao-Yunzai （GPL-3.0）
20. NapCatQQ（已清空）— https://github.com/NapNeko/NapCatQQ/blob/105f38e/README.md
21. nonebot-plugin-bilichat v5.2.0 — https://github.com/Well2333/nonebot-plugin-bilichat/tree/305b873
22. nonebot-plugin-memes — https://github.com/MemeCrafters/nonebot-plugin-memes/tree/836d441

**标准与文档**
23. OneBot 11 事件 — https://github.com/botuniverse/onebot-11/blob/master/event/README.md
24. OneBot 11 消息段 — https://github.com/botuniverse/onebot-11/blob/master/message/segment.md
25. MaiBot changelog — https://github.com/Mai-with-u/MaiBot/blob/03347c9/changelogs/changelog_old.md#L1686 ；https://github.com/Mai-with-u/MaiBot/blob/03347c9/changelogs/changelog.md#L11

**TeamAgent 本机证据（只读）**
26. worktree `e7f52e4`（2026-11-13 10:43），路径 `/Users/yanghongming/Projects/.worktrees/TeamAgent-c1b-cloud`；`git log --since='4 days ago'`：107 commits，51 `fix:`。
27. `schema.sql:48`（message_refs 无 TTL）；`src/quote.ts:6-9`（取 ref_idx 不校验时间）；`src/worker.ts:1040-1044`（`slice(0,4000)`、`msg_seq`）；`src/voice.ts:148`（稳定序列号）；`docs/review.md`（自述无 ASR/OCR/全盘索引）。
