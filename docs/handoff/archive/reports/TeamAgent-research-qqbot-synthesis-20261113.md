# TeamAgent 事件层 v2 · 联合调研综合报告

综合人：调研员（DeepSeek）｜2026-11-13｜输入：我的 `TeamAgent-research-qqbot-deepseek-20261113.md`、Codex 的 `TeamAgent-research-qqbot-codex-20261113.md`；未登录、未用 Cookie、未改项目文件。

## 结论

1. **保留 Worker + D1 + Queues 的权威状态，一次做大版本**：统一 NormalizedEvent/Segment 与 EvidenceResult 两个契约，把协议适配、媒体证据、参与决策、工具执行、发送回执串成一条链路；不再按线上症状逐条补字段。
2. **可直接搬运的是 MIT/Apache 的消息编解码、引用/配额、图片与动图预处理、长文本分段**（MaiBot-QQ-Adapter、NoneBot、Koishi、LangBot、memes）；GPL/AGPL 的 MaiBot 核心、AstrBot、kirara、Yunzai 只按行为和验收表重写。
3. **「一次上线」要做的是减少重复的交接/部署/宣布，不是省掉验证**：模块内持续自测，冻结一个 candidate SHA，一次集中验收与合并。

## 一、两位一致

- **官方 QQ 通道的事件面确实窄**：没有戳一戳、撤回、群公告入站事件，也没有 OneBot 的 `get_msg`；这几类只能靠 OneBot 系补，不能用插件清单冒充官方能力。
- **引用要按三类标识分开存**：消息 ID、被动额度 `msg_id`、引用索引 `ref_idx/msg_idx`；缺引用索引时降级展示，不丢正文。
- **图片必须收到即下载 + 内容 hash 缓存**：QQ 媒体 URL 会过期，引用图会错记到引用者名下；失败要独立成结果，不能拖垮文字。
- **发送要区分 pending/sending/sent/failed/unknown**，未知不能自动重发；`msg_seq` 稳定去重。
- **媒体只下音轨、用 X-ASR**（用户已定）：禁止 `/best` 回退到视频，单任务一个音频，`finally` 清理临时目录。
- **C1b 云端读仓库已具备**（`repo_file` read/list/find、固定 commit、私库白名单）；**C3 子代理本机有组件但未接 Worker**——两份报告结论相同。

## 二、分歧与核实

**1）NapCat 主仓现状**：Codex 说「只剩 Ending README」，我说「仓库被清空且无许可证」。
核实（2026-11-13 直接查 GitHub API）：仓库**存在、未归档**，`stargazers 12,764`、最后 push `2026-11-12`、根目录**只有 `README.md`**（正文 `# NapCatQQ ## Ending 到这里告一段落。`）、`license: null`。
→ **两人各对一半**：Codex 的「只剩 README」更准确；我的「无许可证」成立；「清空」应表述为「文件被清到只剩 README」。结论不变：**没有可运行代码，不能当 OneBot 方案底座**（[仓库](https://github.com/NapNeko/NapCatQQ)）。

**2）官方事件面**：两份都认为没有戳一戳/撤回/公告/`get_msg`。
核实：官方文档的事件只有消息类（`C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`GROUP_MESSAGE_CREATE`）、机器人/成员类（`GROUP_ADD_ROBOT` 等）、互动类（`INTERACTION_CREATE`）；发送侧无「取消息」接口（[消息类型](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)、[群消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)）。
→ **一致成立**。补救只有 OneBot sidecar，属条件式后置。

**3）工作量**：我估 B 路线 9–11 人日（2 人并行约 1 周 + 2 验证日）；Codex 估 10–18 人日。
核实：两份区间在 10–11 重叠，差异来自 Codex 把 48 类事件→80–120 个 fixtures 的验收成本也算进去了。
→ **合并估 10–17 人日**；2 人并行约 7–9 个工作日 + 2 天集中验收。A 路线（换框架）两份都落在 10–25 人日，我的 10–20 与 Codex 的 10–20 一致。

**4）C1b / C3 现状**：我写「C1b 已有、C3 本机有未接 Worker」；Codex 写「C1b 已在 main、C3 存在但 `READER_VERIFIED=False`」。
核实：两份独立结论一致；但我**未能在本机找到 main 检出**（`/Users/yanghongming/Projects/TeamAgent` 不存在，只有 worktree），所以**没复跑代码**，标「待审查员按当前 main 复核」。
→ 采信两份一致的说法，不额外加码。

## 三、仅一方查到

- **仅我**：官方通道缺戳/撤回/公告后「只能上 OneBot sidecar」的具体取舍；MaiBot 适配器的 `REFIDX 24h/2000 条`、群 `5 条/300s` 具体数字；MaiBot changelog 里「引用从按时间改为按新消息」「wait 与防抖配合」等回归证据；按我方代码逐条标注的 20 条现状。
- **仅 Codex**：48 类事件与 80–120 fixtures 的验收口径；AstrBot 图像/动图预处理（`prepare_request_images`、`_even_frame_indices`）与 SubAgentService；官方 `101/102/103` 三种 `msg_elements` 的区分；Koishi `sendQueued` 的有序发送；M0–M4 的集中发布流程；A1–D 五条路线的人日表。
- **两边都未实测**：真实 QQ 群回放、X-ASR 真机耗时、发送回执的端到端一致性。

## 四、合并验收表（并集去重，E 编号沿用 Codex，括号内为我方条目）

| # | 场景 | 常见坑 | 成熟做法 | 我们现状 | 优先级 |
|---|---|---|---|---|---|
| 1 | 收信与会话（E01） | 群/私聊 ID 混用 | NoneBot/Koishi 会话映射 | 只服务配置群，够用 | P0 |
| 2 | @与唤醒（E02/E36） | 把「你」都当机器人 | `_check_at_me`、按账号过滤自消息 | mentions 够用，缺自消息过滤 | P0 |
| 3 | 引用与目标（E03–E05） | 回错人、只有 ID 占位 | 决策带 `target_message_id`，嵌入→缓存→取回 | 有 `quote.ts`，无 TTL（我方 #1） | P0 |
| 4 | 引用图归属（E06/E07） | 图记到引用者、重复计费 | 记录原消息/原作者/引用者 + hash 缓存 | 未持久化原图（我方 #4） | P0 |
| 5 | 媒体失败降级（E08–E10） | 图挂了整轮失败 | 媒体独立结果、逐跳校验、资源上限 | `vision.ts` 有预算/SSRF | P1 |
| 6 | 表情/mface（E11/E13） | face/mface/贴纸混为一谈 | face→文字 + VLM 打标 + 语义匹配 | `stickers.ts` 已有 | P1 |
| 7 | 动图（E12） | 只取首帧 | 保留原字节、按预算抽时序帧 | 存 BLOB 原字节，方向对 | P1 |
| 8 | 转发/嵌套（E14/E15） | 压成一句、循环展开 | 限深/限节点，保留作者时间 | 只识别未展开（我方 #3） | P1 |
| 9 | 卡片/B站（E16–E18） | 漏链接、误抓封面 | 递归解析 + 规范化 BV/cid/分P | `bili-links.ts` 32 层递归，强项 | P0 |
| 10 | 字幕/ASR（E19–E21） | 截断冒充全片、无字幕硬编 | 文稿覆盖范围 + 音轨 ASR + 空结果检测 | 字幕已做，ASR 缺（我方 #20） | P0 |
| 11 | 媒体清理（E22） | 留视频/碎片缓存 | `finally` 清理 + 启动补扫 | 需按「只下音频」重写 | P0 |
| 12 | 风控（E23） | 无限重试、谎称版权 | 分阶段状态 + 有限退避 | fetcher 已分类 | P0 |
| 13 | 语音/文件（E24/E25） | MIME 非 audio、路径不共享 | `voice_wav_url`、显式媒体类型 | 只用 `asr_refer_text` | P1 |
| 14 | notice 状态（E26–E28） | 戳一戳/撤回/表情回应当聊天 | 归为状态事件、默认静默 | **官方通道拿不到**（我方 #9–11） | P2 |
| 15 | 成员/权限（E29–E32） | 操作者与对象混淆 | operator/user/target 分开 | 不适用当前单群 | P2 |
| 16 | 其他卡片/元事件（E33/E34） | JSON 原文污染上下文 | 有类型摘要 / 元事件走健康 | 部分有 | P2 |
| 17 | 幂等/重放（E35） | 重复投递重复发言 | 幂等键覆盖收信/任务/分片 | outbox 状态机已有 | P0 |
| 18 | 发送/分片/配额（E37/E38） | 顺序乱、超 5 条/300s 静默失败 | 固定序号、配额计数 | 只 `slice(0,4000)`，**无配额计数**（我方 #12/#13） | P0 |
| 19 | 429/unknown（E39） | 无脑重试双发 | pending/unknown 分开 | 已有 sent/unknown | P0 |
| 20 | 并发/合并（E40/E41） | 补发重复、图文拆两次 | 决策版本绑定出站组、聚合窗口 | 有防抖，缺版本绑定 | P1 |
| 21 | 参与决策（E42） | 固定随机发言 | 动态门控 + 显式交办优先 | 已拒绝固定配额 | P1 |
| 22 | 工具/仓库/X/子代理（E43–E46） | 200 但登录墙、只读 README 冒充查码 | 证据级别 + 固定 commit + 租约/收据 | C1b 已有，C3 未接 Worker | P1 |
| 23 | 资料边界（E47） | 网页里的话当指令 | 引用保持资料身份、子代理继承 | 已有 | P0 |
| 24 | 降级/重启（E48） | 泛化「做不了」 | 区分未接单/失败/材料不足/未送达 | 部分有 | P1 |

合计 24 组覆盖 Codex 的 48 类 + 我的 20 条（我的 1–20 分别落入第 3、4、6、8、11、12、13、18、19；第 9–11 单列为第 14 组）。验收用例数按 Codex 口径约 80–120 条。

## 五、可直接搬运的代码（MIT/Apache 才翻译，GPL/AGPL 只重写）

| 来源 | 文件 / 函数 | 语言 | 改造 | 工时 |
|---|---|---|---|---|
| MaiBot-QQ-Adapter（MIT） | `codec.py::decode_message/encode_message` | Python | 翻 TS，保留版权行 | 1.5d |
| 同 | `plugin.py::_claim_passive_fields`（REFIDX 24h/2000 + 5/300s） | Python | 翻 TS + 进程内计数 | 1d |
| 同 | `plugin.py::_build_attachments/_download_attachment` | Python aiohttp | 换 fetch，白名单/20MB | 1d |
| 同 | `quoted_media.py`（深度 4/64） | Python | 直接翻 | 0.2d |
| MaiBot 核心（GPL） | `turn_trigger/*`（dynamic_gate 等） | Python | **只重写行为** | 1.5d |
| NoneBot2（MIT） | `_check_at_me/_check_reply` 事件模型 | Python | 参考结构 | 0.5d |
| Koishi（MIT） | `sendQueued` 会话队列 | TS | 摘函数 | 0.5d |
| LangBot（Apache-2.0） | `MessageAggregator`、`longtext` | Python | 翻 TS | 1d |
| memes（MIT） | `image_operations`（GIF 拆分） | Python | 可 vendor | 0.5d |
| AstrBot（AGPL） | `prepare_request_images`、`SubAgentService` | Python | **只按行为重写** | 2d |
| NapCat（无许可证） | 无可搬代码 | — | 不用 | 0 |

合计可搬运 6–7 人日，其余为自写与验收。

## 六、路线与工作量

| 路线 | 做法 | 人日（合并） | 一次上线 | 判断 |
|---|---|---|---|---|
| A 换框架 | 部署 MaiBot/AstrBot | 10–20 + 常驻主机 | 否，多阶段迁移 | 不优先 |
| **B 保留架构，事件层 v2** | 统一契约 + 翻译 MIT 模块 + X-ASR | **10–17** | **是** | **推荐** |
| C B + OneBot sidecar | 补戳/撤回/公告 | B + 2–3 | 条件式 | 后置 |
| D 只换协议内核 | Koishi/NoneBot 仅适配层 | 4–8 | 否，不覆盖 ASR/X/C3 | 不选 |

**落地顺序**：M0 固定契约与 fixtures（1–2d）→ M1 并行实现（6–9d）→ M2 冻结 candidate 联调（2d）→ M3 一次集中验收（2d）→ M4 合并发布 + 24h 观察。**中间不合并、不逐 bug 发布**；小提交保留排错价值，但不各自走发布流程。

## 七、出处

- 官方：[消息类型](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)、[群消息（全量）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)
- 仓库：[MaiBot](https://github.com/Mai-with-u/MaiBot)、[MaiBot-QQ-Adapter](https://github.com/Mai-with-u/MaiBot-QQ-Adapter)、[AstrBot](https://github.com/AstrBotDevs/AstrBot)、[LangBot](https://github.com/langbot-app/LangBot)、[NoneBot2](https://github.com/nonebot/nonebot2)、[Koishi](https://github.com/koishijs/koishi)、[NapCat](https://github.com/NapNeko/NapCatQQ)、[memes](https://github.com/MemeCrafters/nonebot-plugin-memes)
- 基线 commit（我的报告）：MaiBot `03347c9`、AstrBot `bb2e467`、LangBot `4625b57`、NoneBot `2450b67/8e0d114`、Koishi `97d5c39`、memes `836d441`、NapCat `105f38e`

## 未核实

- 未在本机找到 TeamAgent main 检出，C1b/C3 的代码现状未复跑（两份说法一致，交审查员核）。
- 真实 QQ 群回放、X-ASR 真机耗时与内存、发送回执端到端一致性均未实测。
- NapCat 的 `12,764★` 与「只剩 README」同时成立，说明 star 是历史存量，不代表可维护性。
