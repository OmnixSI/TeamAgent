# TeamAgent 能力边界前沿调研

调研员（DeepSeek）｜2026-11-14 00:51–01:20 Sydney｜**只读调研，未改 TeamAgent 代码**
范围：NoneBot2、AstrBot、Koishi、LangBot、MaiBot、kirara-ai、Mem0、Letta、GitHub MCP Server；对照 TeamAgent 当前 `main` 快照 `35b3efa`（`src/`、`runner/`、`config/`、`schema.sql`）。
配套基线：`TeamAgent-basics-benchmark-20261114.md` 已按 30 项「基本功能」逐项对照（快照 `8762214`）；**本报告不重复那份的 P0/P1 细节，只写它没展开的「下一层能力」**，并在每项里指出与基线的衔接点。

---

## 0. 结论（先看 8 句）

1. 现在最该补的不是「换更强的模型」，而是**可运营的交互面**：提醒、群总结、历史检索、群友画像、文件问答、语音回复、通用工具。用户说「太弱」，多数是这些入口不存在，不是模型不会。
2. 成熟项目里**最值得直接借的是 LangBot（Apache-2.0）**：`ToolManager` + MCP/skill 加载器、`LongTermMemory` 双层记忆、`GroupChatSummary` 群总结，都是可读、可搬、和我们的 Worker+D1+runner 结构接近的 Python 实现。
3. **AstrBot（AGPL-3.0）和 MaiBot（GPL-3.0）只能照思路重写，不能拷代码**；它们最值钱的是 `future_task` 定时任务模型、`get_group_message_history`、`reply_likelihood`/`dynamic_gate`、人物画像分段、`edge-tts` 免费语音链路。
4. 我们的**权限/提示注入防护比开源项目更细**（`authz.ts` 的 taint + 逐字原话、`untrusted.ts`、`github.ts` 的 redact/deny glob）。新增工具必须接进 `UNTRUSTED_TOOLS` 和写工具授权，不能为了「能力」把这条拆了。
5. **免费路径足够跑起来**：D1 已支持 FTS5；Workers AI 每天 10,000 Neurons 免费（bge-m3 嵌入 1,075 Neurons/百万 token）；Edge TTS 免费；Google News RSS 免费；GitHub 公开仓库匿名 60 次/时。不需要先买 Tavily/SerpAPI。
6. **先做四个 1–2 人日的高杠杆项**：定时提醒（#1）、群总结（#2）、历史检索（#3）、主动频率门控（#7）。这四项都不需要新付费 key，且都能用真实群消息回放验收。
7. **画像/情景记忆/文件技能/MCP 是第二梯队**（#4–#6、#8–#10），需要新表和新 runner job，但都是加法，不动现有主链路。
8. **前置 P0 不变**：basics 报告里的「全局 `chat_cursor` + 单群绑定」必须先修（`worker.ts:487`、`:672-680`），否则所有按群功能（画像、提醒、知识库）都会串群；本文所有 schema 都带 `group_id`，但迁移顺序要先做 P0。

---

## 1. 快照、许可证与「能不能搬」

| 项目 | 版本 / commit | 许可证 | 本报告用法 | 能否直接搬代码 |
|---|---|---|---|---|
| [AstrBot](https://github.com/AstrBotDevs/AstrBot/tree/23db1ad08064a8330a09077138ce8ecc05362219) | 4.29.4 · `23db1ad` | [AGPL-3.0](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/LICENSE) | 定时任务、群历史、KB、TTS、技能包 | **否**；照思路重写，SKILL.md 也要重写 |
| [MaiBot](https://github.com/Mai-with-u/MaiBot/tree/03347c9b8f6fa2208e763da3cd4713db22af87bf) | 1.4.3 · `03347c9` | [GPL-3.0](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/LICENSE) | 回复概率、idle backoff、人物画像、表情语义、MCP | **否**；只借特征/结构 |
| [kirara-ai](https://github.com/lss233/kirara-ai/tree/36249e4a0aa8e3d8930acdfe4e14ec2be6484f63) | 3.3.0a2 · `36249e4` | [AGPL-3.0](https://github.com/lss233/kirara-ai/blob/36249e4a0aa8e3d8930acdfe4e14ec2be6484f63/LICENSE) | scope 隔离、memory manager | **否** |
| [NoneBot2](https://github.com/nonebot/nonebot2/tree/2450b67a115916410d67154a8767b8e4c5aeb62f) | `2450b67` | [MIT](https://github.com/nonebot/nonebot2/blob/2450b67a115916410d67154a8767b8e4c5aeb62f/LICENSE) | `to_me()`、`SUPERUSER`、`on_notice` | **可以**，保留版权声明 |
| [Koishi](https://github.com/koishijs/koishi/tree/97d5c395750cec37b772e0b94dc63c427e3bb868) | 4.18.11 · `97d5c39` | [MIT](https://github.com/koishijs/koishi/blob/97d5c395750cec37b772e0b94dc63c427e3bb868/LICENSE) | `Permissions`、`Command`、`Session.stripped` | **可以**，保留版权声明 |
| [LangBot](https://github.com/langbot-app/LangBot/tree/09ef402a03e5dcda704a0992b04adf4cc6a887b6) | 4.11.7 · `09ef402` | [Apache-2.0](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/LICENSE) | `ToolManager`、MCP/skill 加载器、`LongTermMemory`、`GroupChatSummary`、`LangRAG` | **可以**，保留 LICENSE/NOTICE |
| [Mem0](https://github.com/mem0ai/mem0/tree/f1791daa86d469249c9b002f62644d58a1eb96a0) | 2.2.1 · `f1791da` | [Apache-2.0](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/LICENSE) | 记忆抽取 prompt、ADD/UPDATE/DELETE/NONE 四操作 | **可以**，保留 NOTICE |
| [Letta](https://github.com/letta-ai/letta/tree/8816d3a8516893bfdc0fa14bfb1235226012e295) | `8816d3a` | [Apache-2.0](https://github.com/letta-ai/letta/blob/8816d3a8516893bfdc0fa14bfb1235226012e295/LICENSE) | **只有文档**（repo 224 KB，无源码）；引「Memory & dreaming」 | 文档引用 |
| [GitHub MCP](https://github.com/github/github-mcp-server/tree/f66a8d5882cb700c3466026726fe1faf1838c05d) | `f66a8d5` | [MIT](https://github.com/github/github-mcp-server/blob/f66a8d5882cb700c3466026726fe1faf1838c05d/LICENSE) | PR/Issue/commit/code 工具的参数与返回结构 | **可以**，保留版权声明 |
| [edge-tts](https://pypi.org/project/edge-tts/) | 7.3.1 | [LGPL-3.0](https://github.com/rany2/edge-tts/blob/master/LICENSE) | 独立 CLI 调用做 TTS | **不修改、不静态链接**；作为独立进程依赖 |

> 许可证底线：AGPL/GPL 只读设计，不整段复制；MIT/Apache 可复制但保留声明。**「照思路重写」也要写来源**，报告和代码注释里标原项目/commit。

---

## 2. 排序总表（17 项）

期待度：S＝用户一定会问；A＝常用、明显提升；B＝锦上添花。
现状：无 / 部分 / 有但弱。

| # | 能力 | 期待度 | 我们现状 | 最值得看的成熟实现 | 改动量（建议值） | 付费 key |
|---:|---|---|---|---|---|---|
| 1 | 定时提醒 / 待办 / 周期任务 | S | 无 | AstrBot `future_task` + `CronJobManager` | 1–2 人日 | 无 |
| 2 | 群聊总结 / 补课 | S | 无 | LangBot `GroupChatSummary` | 1 人日 | 无（现有模型） |
| 3 | 群消息历史检索 | S | 无 | AstrBot `get_group_message_history` | 0.5 人日 | 无 |
| 4 | 群友画像（记住人） | S | 只有名字 | MaiBot `person_profile` + LangBot L1 profile | 2–3 人日 | 无 |
| 5 | 长期记忆 2.0（情景/去重/时效） | S | 只有 facts + 词法召回 | Mem0 `add` 管线 + LangBot episodic | 2–3 人日 | 无（FTS5）/ 可选 Workers AI |
| 6 | 文件 / 文档技能包 | S | 有文件交付，缺编辑/校验 | AstrBot `pdf`/`documents`/`spreadsheets` SKILL + LangBot skill loader | 2 人日 | 无 |
| 7 | 主动发言频率门控（不吵） | S | 固定节流 | MaiBot `reply_likelihood` + `dynamic_gate` + `idle_backoff` | 1 人日 | 无 |
| 8 | 群内工具层：MCP + 计算器 + 技能 | S | 8 个固定工具 | LangBot `ToolManager` / MaiBot `MCPManager` / AstrBot `MCPClient` | 3–5 人日 | MCP 服务器各异；计算器免费 |
| 9 | 语音回复（TTS） | A | 只有 ASR，没有出站语音 | AstrBot `edge_tts_source` + QQ `sendVoice` | 1 人日 | 无（Edge TTS） |
| 10 | 群知识库（RAG） | A | 无 | AstrBot KB + LangBot `LangRAG` | 3 人日 | 无（FTS5）/ 可选 Workers AI |
| 11 | PR / Issue / 代码检索 | A | 有 commit/file，无 PR/issue | GitHub MCP `pull_request_read`/`issue_read`/`search_code` | 1–2 人日 | 无（公开仓库）/ 免费 PAT |
| 12 | 群管理命令与权限 | A | 只有 `/方案` `/开工` | Koishi `Permissions` + NoneBot `SUPERUSER` + AstrBot `future_task` 权限 | 1–2 人日 | 无 |
| 13 | 最新消息 / 新闻搜索 | A | 有通用搜索，无时效/新闻 | AstrBot `news_search_serpapi` + MaiBot adapter 矩阵 | 0.5 人日 | 无（Google News RSS） |
| 14 | 表情包语义检索 | B | 字符 bigram | MaiBot `EmojiTags` + 向量余弦 | 1–2 人日 | 无（Workers AI 免费额度） |
| 15 | 自省闭环升级 | B | 同模型写反思并回灌 | Letta dreaming + LangBot consolidation + 我的 V-D 报告 | 2–3 人日 | 无（现有模型/本机 Codex） |
| 16 | 工具/插件热加载 | B | 无 | Koishi loader / NoneBot PluginManager | 3–5 人日 | 无 |
| 17 | 文生图 | B | 无 | Workers AI `flux-1-schnell` | 0.5 人日 | 免费额度内；超出按量 |

---

## 3. 第一梯队（用户一定会期待）

### 3.1 定时提醒 / 待办 / 周期任务

**成熟做法**
- AstrBot 的 `FutureTaskTool`：`name = "future_task"`（[`cron_tools.py:56`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/astr_agent_runtime/tools/cron_tools.py#L56)），参数含 `action=create|edit|delete|list`、`cron_expression`、`run_at`（ISO 时间）、`run_once`、`note`、`job_id`（[`:74-100`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/astr_agent_runtime/tools/cron_tools.py#L74)）。编辑只允许创建者；删除允许创建者或本群管理员（[`:296-330`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/astr_agent_runtime/tools/cron_tools.py#L296)）。
- 持久化模型 `CronJob`：`job_type=basic|active_agent`、`cron_expression`、`timezone`、`payload`、`run_once`、`status`、`last_run_at`、`next_run_time`（[`db/po.py:199-229`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/db/po.py#L199)）；`CronJobManager` 启动时 `sync_from_db` 恢复（[`cron/manager.py:106`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/cron/manager.py#L106)、[`:144`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/cron/manager.py#L144)）。
- 到点后 `_run_active_agent_job` 把 `session`、`note`、`run_at` 组进 prompt 唤醒主 agent，角色按创建者是否管理员决定（[`:442-480`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/cron/manager.py#L442)）。

**许可证 / 借用**
AGPL-3.0，不拷代码。借「表结构 + 工具参数 + 创建者/管理员权限」三件事。

**最小改法（Worker + D1，不需要 runner）**
1. `schema.sql` 加：
   ```sql
   CREATE TABLE reminders(
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL,
     creator_id TEXT NOT NULL, creator_name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'reminder',      -- reminder | todo
     text TEXT NOT NULL, due_at INTEGER, repeat TEXT, timezone TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending', done_at INTEGER,
     last_fire INTEGER, created_at INTEGER NOT NULL
   );
   CREATE INDEX reminders_due ON reminders(status, due_at);
   ```
2. `src/semantic.ts` 加 `future_task` 工具（`create/list/edit/delete`）；创建/编辑/删除是写操作，复用 `authz.ts` 的「当前成员逐字原话 + 直接消息」校验，新增一个 `reminder` 写工具分支；`repo` 字段不需要。
3. `src/worker.ts:1105` 的 `scheduled` 已由 `wrangler.toml:10` 的 `* * * * *` 每分钟触发；加一段：查 `due_at<=now AND status='pending'` 最多 20 条，写 `outbox`（`id='rem-'+id+'-'+due_at`，正文 `@创建者 提醒：...`），`run_once` 标 done；周期任务用 5 字段 cron 计算下一次（建议先支持 daily/weekly，避免引入完整 cron 解析）。
4. `/remind`、`/todo add|done|list`、`/reminders` 放 `src/commands.ts`（见 #12）；`/todo` 不排程，只维护 `kind='todo'`。
5. 时区按每条 reminder 存；默认 `TEAM.memory.timezone`（现在是 Australia/Sydney）。用户若说「北京时间」，写 `Asia/Shanghai`，不要靠服务器本地时区。

**付费 key**：无。D1 + 现有 cron 触发即可。

**验收**
- `@bot 1 分钟后提醒我喝水` → 到点群内出现提醒；`list` 能看到；创建者能删，别人删被拒。
- 创建「每天 9:00」→ 连续两天在 9:00±60s 发出；重启/重新部署后仍存在。
- `/todo add 周五前交报告` → `/todo list` 可见；`/todo done` 后不再出现。
- 回放不写生产 D1；用本地 `wrangler dev --local` + 独立 D1 验收（团队回放纪律）。

---

### 3.2 群聊总结 / 补课

**成熟做法**
- LangBot `GroupChatSummary` 插件：支持手动命令、LLM 工具、定时自动总结（[`manifest.yaml`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/misc/GroupChatSummary/manifest.yaml)）；默认 `max_messages=500`、`default_summary_count=100`、`auto_summary_enabled=false`、`auto_summary_threshold=200`。
- `record_message` 维护每群缓冲（[`main.py:207`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/misc/GroupChatSummary/main.py#L207)）；自动总结用 watermark 防重复（[`:251-263`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/misc/GroupChatSummary/main.py#L251)）。
- LLM 工具 `SummarizeGroupChat` 支持 `count`（≤1000）和 `hours`（[`components/tools/summarize_group_chat.py:9`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/misc/GroupChatSummary/components/tools/summarize_group_chat.py#L9)）。
- AstrBot 的 `get_group_message_history` 可做同一链路的取数底座（见 #3）。

**许可证 / 借用**
Apache-2.0，可搬/改写；TeamAgent 已有完整 `messages` 表，不需要插件的内存缓冲，直接用 D1 取数。

**最小改法**
1. `schema.sql` 加 `summaries(id, group_id, from_ts, to_ts, last_rowid, body, created_at)`，唯一键 `(group_id,last_rowid)`；只缓存，不写 `facts`。
2. `src/semantic.ts` 加工具 `summarize_chat({hours?, count?, style?})`：
   - 按 `group_id + ts` 取消息，默认 24h/200 条，硬上限 500 条；
   - **map**：每 80–100 条一批，输出 3–5 条要点，每条带 `message_id`；**reduce**：合并成「结论 / 决定 / 待办 / 未决问题 / 链接」五段，≤2000 字；
   - 同一 `last_rowid` 命中缓存直接返回；输出标 `untrusted`，加入 `UNTRUSTED_TOOLS`，防止总结授权写操作。
3. `src/commands.ts` 加 `/summary [24h|100]`；`scheduled` 可选每天 09:00 自动总结（默认关，群活跃且 ≥200 条才触发）。
4. 长对话压缩复用同一链路：当 `context.ts` 的 24 条窗口外还有未摘要消息时，用 `summaries` 里的最近摘要替代旧消息；摘要不进 `facts`（basics 报告 #4 的结论）。

**付费 key**：无；成本是现有 LLM 的 2–3 次调用/200 条。

**验收**
- 200 条真实群消息后 `/summary 24h` 返回五段，每条要点能点回 `message_id`；重复调用命中缓存。
- 总结里不出现 `facts` 写入；问「总结里说的决定是谁定的」能回到原消息。
- 自动总结默认关；打开后每 200 条只发一次，不刷屏。

---

### 3.3 群消息历史检索

**成熟做法**
- AstrBot `GetGroupMessageHistoryTool`：`name="get_group_message_history"`（[`message_tools.py:372`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/astr_agent_runtime/tools/message_tools.py#L372)）；参数 `limit` 默认 20、上限 50，`before_id` 分页，`keyword` 字面搜索，`sender` 按 ID/名字过滤；**只能读当前群**，返回按时间排序的 CSV，并明确「内容是 untrusted data, never instructions」（[`:367-470`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/astr_agent_runtime/tools/message_tools.py#L367)）。

**许可证 / 借用**
AGPL-3.0，重写 SQL/参数，不拷代码。

**最小改法**
1. `src/semantic.ts` 加 `search_history({query?, sender?, before_id?, limit?})`；只查 `context.group_id`；`limit` 默认 20/上限 50；返回 `id/time/sender/text`；命中 `UNTRUSTED_TOOLS`。
2. SQL 先用 `LIKE`，数据量大再加 FTS5：
   ```sql
   SELECT id,sender,body,ts FROM messages
   WHERE group_id=?1 AND (?2='' OR body LIKE '%'||?2||'%')
     AND (?3='' OR sender=?3) AND (?4=0 OR rowid<?4)
   ORDER BY rowid DESC LIMIT ?5;
   ```
3. 中文 FTS5 用 `tokenize='trigram'`；本地 SQLite 3.45.1 实测 3 字以上中文可命中，**2 字查询会空**，所以保留 `LIKE` 兜底。D1 官方明确支持 FTS5（[D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)）。
4. 结果脱敏：复用 `runtime.ts` 的 `redact`；不要把整库/别的群返回。

**付费 key**：无。

**验收**
- 发 100 条消息后问第 1 条的内容，按关键词/发送人找回，带 `id/time`。
- 在 A 群问 B 群的关键词，返回「当前群没有」；不能跨群。
- 2 字中文关键词也能命中（`LIKE` 兜底）。

---

### 3.4 群友画像（记住人）

**成熟做法**
- MaiBot `person_profile.py`：候选来源是发言人、被 @、被引用者（[`person_profile.py:146`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/maisaka/memory/person_profile.py#L146)）；每次最多取 4 个候选、画像文本上限 900 字（[`:19-20`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/maisaka/memory/person_profile.py#L19)）。
- 画像分段固定为「身份设定 / 关系设定 / 稳定了解 / 相处偏好 / 近期互动 / 不确定信息 / 维护备注」（[`profile_text.py:8`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/A_memorix/core/utils/profile_text.py#L8)）；注入时只取前五段，近期互动最多 2 条，不确定信息单独标「未确认，不可当作确定事实」（[`build_profile_injection_text:170`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/A_memorix/core/utils/profile_text.py#L170)）。
- 维护规则写明「自动画像仅供内部参考；若与当前对话冲突，以当前对话为准」（`PROFILE_MAINTENANCE_NOTE`，同文件头部）。
- LangBot `MemoryStore` 的 L1 是 JSON 核心画像，`_MAX_NOTES_LENGTH=2000`、`_MAX_PROFILE_CACHE_SIZE=256`，traits/preferences 有槽位历史（[`store/memory_store.py:45-56`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/KnowledgeEngine/LongTermMemory/store/memory_store.py#L45)）；`RECALL_POLICY.md` 明确「旧偏好不因时间戳变旧而衰减」。

**许可证 / 借用**
MaiBot GPL-3.0：只借分段/长度/冲突规则，不拷代码。LangBot Apache-2.0：可搬 L1 结构（JSON schema、槽位上限、历史），保留 NOTICE。

**最小改法**
1. `schema.sql` 加：
   ```sql
   CREATE TABLE person_profiles(
     group_id TEXT NOT NULL, member_id TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     profile_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
     PRIMARY KEY(group_id,member_id)
   );
   ```
   `profile_json` 固定七段；每段是 `[{text, source_ids[], confidence}]`，**每条都要能回到消息**。
2. 夜间 `dream` job 追加人物画像阶段：取最近 30 天、发言 ≥5 条的成员；每人取最近 80 条 + 现有画像；用 `memory` 模型输出七段；每段上限：身份 3、关系 5、稳定了解 8、相处偏好 5、近期互动 3、不确定 2、备注 2；每条必须带 `source_id` + 逐字 `quote`，用 `quoteIn()` 校验。
3. 注入：`semantic.ts` 在构建 prompt 时，从 `latest.meta.mentions`、`replyTo`、`quote`、发言人取候选，最多 4 人；拼 `buildProfileText` ≤900 字；加「自动画像仅供内部参考；若与当前对话冲突，以当前对话为准」。
4. 命令：`/profile @某人`（本人或管理员）、`/forget me`（写 `memory_blocks`，并删除该成员画像/事实）；`member_names` 继续做别名，不替代画像。
5. 多群：所有键带 `group_id`；`member_names` 现在没有群作用域，basics 报告已指出，先补。

**付费 key**：无；夜间用现有 `memory` 模型。若做画像检索的 embedding，用 Workers AI 免费额度。

**验收**
- 3 个成员各 20 条消息后，问「我是谁/他喜欢什么」能说出 3 条带原话证据的画像；说错时以当前对话纠正。
- `/forget me` 后，画像和 facts 都不再被召回，且不会在下一晚重建（`memory_blocks` 生效）。
- A 群的画像不出现在 B 群。

---

### 3.5 长期记忆 2.0：情景记忆 + 去重 + 时效

**成熟做法**
- Mem0 `Memory.add` / `_add_to_vector_store`（[`memory/main.py:760`](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/mem0/memory/main.py#L760)、[`:881`](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/mem0/memory/main.py#L881)）是五段式：取最近 10 条上下文 → 取相关旧记忆 top10 → **单次 LLM 抽取**（把旧记忆一起给模型做去重/链接）→ 批量 embedding → 哈希去重。
- `ADDITIVE_EXTRACTION_PROMPT`（[`configs/prompts.py:468`](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/mem0/configs/prompts.py#L468)）要求：每条记忆自包含；相对时间按 **Observation Date** 落成具体日期；与旧记忆同主题时用 `linked_memory_ids` 链接；只在「具体事实已存在」时跳过，不因实体相同就跳过。
- `DEFAULT_UPDATE_MEMORY_PROMPT`（[`:176`](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/mem0/configs/prompts.py#L176)）定义 `ADD/UPDATE/DELETE/NONE` 四操作。
- LangBot `MemoryStore` 的 L2 情景记忆：`add_episode`（[`store/memory_store.py:1215`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/KnowledgeEngine/LongTermMemory/store/memory_store.py#L1215)）、`preview_consolidation:1756`、`apply_consolidation:1837`；`recall.py:96 select_memories` 只取 50–80 个候选、最多返回 20 条、8000 字符；`currently_valid:26` 严格执行 `[valid_from, valid_until)`；`consolidation.py:62 draft_summary` / `:161 apply_summary` / `:262 invalidate_derived` 负责摘要和失效传播。

**我们已有的**
- `semantic.ts:143-195` 已经有「逐条校验 evidence 是新增消息逐字原文 + `supersedes_ids` 关闭旧事实」；`memory.ts:73-115` 已有中文 bigram/英文 token 的词法召回。**不要重写这套**，只补「情景」和「时效/去重/审计」。

**许可证 / 借用**
Mem0 Apache-2.0：可搬 prompt 结构和四操作；LangBot Apache-2.0：可搬 recall/consolidation 的边界策略。保留 NOTICE。

**最小改法**
1. `schema.sql` 加：
   ```sql
   CREATE TABLE episodes(
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL,
     subject TEXT, text TEXT NOT NULL, source_ids TEXT NOT NULL,
     event_at TEXT, valid_from TEXT NOT NULL, valid_to TEXT,
     importance REAL NOT NULL DEFAULT 0.5, hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   );
   CREATE VIRTUAL TABLE episodes_fts USING fts5(text, tokenize='trigram');
   CREATE TABLE memory_audit(
     id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, action TEXT NOT NULL,
     before TEXT, after TEXT, model TEXT, prompt_hash TEXT, created_at INTEGER NOT NULL
   );
   ```
2. 夜间 `dream` 追加情景抽取：每 60 条一批，输出 0–8 条 `{text, subject, event_at, source_ids, importance}`；`hash=sha256(group_id+text)` 去重；对每条取 FTS5 top5 相似旧情景，做 `ADD/UPDATE/DELETE/NONE`；`UPDATE` 写旧 `valid_to`，`DELETE` 同样软删，不物理删。
3. `src/memory.ts` 的 `recall` 改为 `facts + episodes` 两路：FTS5 BM25（或 `LIKE`）+ 0.15 时间新近 + 0.10 importance；最多 8 条/8000 字符；返回带 `event_at`/`source_id`。
4. 可选 embedding：`@cf/baai/bge-m3`（1,075 Neurons/百万 token）或 `@cf/google/embeddinggemma-2`（154 Neurons/百万 token），存 `BLOB`，≤2000 条时暴力余弦即可；不要上 Qdrant/Chroma。
5. `memory_audit` 每次写入记 before/after/model/prompt_hash；`/forget` 按 `source_id` 或成员写 `memory_blocks` 并软删。

**付费 key**：FTS5 免费；Workers AI 免费每天 10,000 Neurons，按 1,075/M token 足够一个小群；Vectorize 可选但不必。

**验收**
- 回放 300 条消息，问「上周二决定的接口是什么」返回带具体日期 + `source_id` 的情景，而不是一句泛泛总结。
- 同一条消息回放两次不产生重复 episode（hash 去重）。
- 纠正旧事实后，旧 `valid_to` 关闭，`recall` 不再返回；`memory_audit` 有 before/after。
- 问「我上次说的偏好」不返回已过期/已删除的记忆。

---

### 3.6 文件 / 文档技能包

**成熟做法**
- AstrBot 内置三个 SKILL.md：
  - `pdf/SKILL.md`：`pypdf` 读/合并/拆分/旋转/加密/表单/校验；`ReportLab` 新建；要求输出后用 `pypdf` 重开校验，能渲染就逐页看裁切/重叠/缺字（[`skills/pdf/SKILL.md`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/builtin_stars/astrbot/skills/pdf/SKILL.md)）。
  - `documents/SKILL.md`：`python-docx` 读写 DOCX，保留样式、表格、图片、页眉页脚、批注、修订；要求重开校验 + LibreOffice 渲染（[`skills/documents/SKILL.md`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/builtin_stars/astrbot/skills/documents/SKILL.md)）。
  - `spreadsheets/SKILL.md`：`openpyxl` 读写 XLSX/XLSM，`xlrd` 读旧 XLS，`pandas` 清洗；脚本 `inspect_workbook.py` / `validate_workbook.py` / `render_workbook.py`（[`skills/spreadsheets/SKILL.md`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/builtin_stars/astrbot/skills/spreadsheets/SKILL.md)）。
- LangBot 的 `ToolLoader` 把 skill 作为工具挂载，`/workspace/.skills/<name>` 是虚拟挂载点，`skill.py` 负责激活/挂载/持久化 revision（[`loaders/skill.py:44`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/src/langbot/pkg/provider/tools/loaders/skill.py#L44)、[`:173`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/src/langbot/pkg/provider/tools/loaders/skill.py#L173)）。

**我们已有的**
- `runner/utility.py:329-333` 已按扩展名/MIME 分 image/video/voice/file；`:509` 的提示词已写「PDF 用 pypdf、XLSX 用 openpyxl」；`delivery.mjs` 负责发文件。缺的是**读入侧的统一 `read_document` + 技能脚本 + 校验/渲染**。

**许可证 / 借用**
AstrBot AGPL：SKILL.md 的**工作流**可以学，文字要重写；LangBot Apache：skill loader 可搬。Python 库本身是 BSD/MIT/Apache，可直接依赖。

**最小改法**
1. `runner/docread.py`：`read_document(path)` 按扩展名分派：
   - `.pdf` → `pypdf` 提取文本 + 页数/元数据；扫描件无文本时用 `pdftoppm` 渲第一页给现有 vision；
   - `.docx` → `python-docx` 读段落/表格/页眉页脚/批注；
   - `.xlsx/.xlsm` → `openpyxl` 读 sheet/公式/合并单元格；`.xls` → `xlrd` 只读；
   - `.pptx` → `python-pptx` 读每页文本/备注；
   - `.csv/.tsv` → `csv` 嗅探编码/分隔符；`.zip` → 列目录，防 zip bomb。
   返回 `{text, pages, sheets, meta, warnings}`，文本上限 60k 字符，路径必须在 `inputs/` 下。
2. 新 job kind `docread`：`src/mediajobs.ts` 或 `src/fetchjobs.ts` 在附件是 file 时入队；`src/semantic.ts` 加 `read_document({message_id, question?})`；结果标 `untrusted`。
3. `runner/skills/pdf|docx|xlsx/SKILL.md` + `scripts/`：照 AstrBot 的「先 inspect → 最小改动 → 重开校验 → 渲染检查」流程重写；技能通过 `skill` 工具激活（#8），脚本在 workspace 内跑，产物放 `outputs/`。
4. 出站复用 `delivery.mjs`；新增 `send_media` 路径校验，只允许 `outputs/`/`file-deliveries/`，拒绝 `~/.ssh`、`.env`、仓库外路径（basics 报告 #30 已建议）。

**付费 key**：无；`pypdf/python-docx/openpyxl/python-pptx` 都免费。扫描件 OCR 用现有 vision，不额外买 OCR。

**验收**
- 上传 10 页 PDF 含表格，问「第 3 页的金额」→ 返回页码 + 原文，不编。
- 上传 XLSX 含公式，问「哪个 sheet 有公式」→ 返回 sheet 名 + 公式列表；导出新 XLSX 用 `openpyxl` 重开校验。
- 生成 DOCX 后用 LibreOffice 打开无乱码/表格错位；产物通过 `send_media` 发回群。
- 拒绝 `../`、`~/.ssh`、`/etc/passwd` 路径。

---

### 3.7 主动发言频率门控（不吵）

**成熟做法**
- MaiBot `estimate_reply_probability`（[`reply_likelihood.py:74`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/maisaka/turn_trigger/reply_likelihood.py#L74)）用 8 个特征：是否 @ bot、是否 @ 别人、是否有问号、是否纯媒体、最近 5 分钟 bot 发言占比、最近 5 分钟消息数、距上次 bot 发言秒数、待处理消息数；权重在 `:22-30`。
- `DynamicReplyGate`（[`dynamic_gate.py:87`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/maisaka/turn_trigger/dynamic_gate.py#L87)）用 1 小时窗口，目标回复数 = 不设门控预计回复数 × `reply_frequency`；低于 20 个样本时用离线阈值表（`:32`）；反馈只收紧不放宽（`:163 evaluate`）。
- `IdleBackoffController`（[`idle_backoff.py:16`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/maisaka/turn_trigger/idle_backoff.py#L16)）：连续空闲 N 轮后指数退避，`base * 2^exponent` 封顶；待处理消息数达到阈值可绕过（`:61`）。
- 我们的现状：`rhythm.ts:2-12` 固定 debounce 1/4/3/2 秒 + 8 秒 cap；`hardRuleHit` 只在 bot 主动发言后没人理时硬停（`:34`）；没有概率模型、没有按群自适应、没有聊天静音时段。

**许可证 / 借用**
MaiBot GPL-3.0：只借 8 个特征和 logistic 形式；**权重不要直接当我们的结论**，用 `chat_decisions` 重新拟合。下面的算例只是说明量级。

**算例（用 MaiBot 权重，非我们数据）**
`@bot` 0.722；普通问句 0.462；普通陈述 0.347；刚说过话 + 普通陈述 0.613；只有表情 0.160；@别人 0.220。这些值说明「@ 必回」不能只靠概率，必须有 forced 旁路。

**最小改法**
1. `src/rhythm.ts` 加：
   - `replyFeatures(row, recent)` 从 `messages`/`outbox`/`chat_decisions` 算 8 特征；
   - `replyProbability(features, weights)`；
   - `DynamicGate`：1h 窗口、`frequency` 默认 0.35、静态阈值表、`recordReply`/`recordForced`；
   - `IdleBackoff`：`base=60s`、`cap=15min`、`start=3`、`bypass_pending=4`；
   - `quietHours`：默认 23:00–08:00（按群时区），静音时段只有 @/引用 bot 才回。
2. `src/worker.ts` 在排 `participation` job 前先过门控；`mention`/`replyTo.kind='bot'` 直接 bypass；`stop` 时写 `chat_decisions`（`gate='dynamic'`, `reason`），不调用模型，省钱。
3. `config/team.json` 加 `rhythm.reply_frequency`、`rhythm.idle_backoff_*`、`rhythm.quiet_hours`；权重放 `config/rhythm-weights.json`，每月用 `chat_decisions` 重拟合一次。
4. 保留现有 `hardRuleHit` 作为最后一道；门控只决定「要不要进入模型」，不改变已决定回复的内容。

**付费 key**：无；门控本身是本地计算，减少模型调用。

**验收**
- 回放 200 条真实消息：主动回复/小时 ≤ `frequency` 目标 + 1；@ 必回；静音时段无主动发言。
- 连续 3 轮「bot 主动但没人理」后，下一次主动延迟明显变长；待处理 ≥4 条时能绕过。
- 群从热闹变冷时，bot 不追着说；群友回来 @ 时立刻恢复。

---

### 3.8 群内工具层：MCP + 计算器 + 技能

**成熟做法**
- LangBot `ToolManager`（[`toolmgr.py:38`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/src/langbot/pkg/provider/tools/toolmgr.py#L38)）统一管理 native/plugin/MCP/skill 四类工具；`ToolLoader` 是抽象基类（[`loader.py:30`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/src/langbot/pkg/provider/tools/loader.py#L30)）；`get_all_tools:112`、`generate_tools_for_openai:392`、`execute_func_call:568`。
- MCP 运行时 `RuntimeMCPSession`（[`loaders/mcp.py:246`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/src/langbot/pkg/provider/tools/loaders/mcp.py#L246)）支持 stdio / HTTP / OAuth、超时、重连；AstrBot `MCPClient` 同样有 `connect_to_server:466`、`list_tools_and_save:654`、`call_tool_with_reconnect:727`、`MCPTool:794`（[`mcp_client.py`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/agent/mcp_client.py)），并对 stdio 命令做 allowlist（`_DEFAULT_STDIO_COMMAND_ALLOWLIST`，`:35`）。
- MaiBot `MCPManager` 把 MCP 工具转成 OpenAI function schema：`_register_tools:233`、`get_openai_tools:433`、`call_tool:518`（[`mcp_module/manager.py`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/mcp_module/manager.py)）。
- AstrBot 的 `astrbot_execute_python` / `astrbot_execute_shell` 是「跑脚本」的边界参考：本地执行前检查 `check_local_execution_permission`、`creator_is_admin`、workspace 读写根、超时上限 300s（[`shell.py:68-190`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/astr_agent_runtime/tools/computer_tools/shell.py#L68)）。

**许可证 / 借用**
LangBot Apache-2.0：`ToolManager`/MCP loader 可搬；AstrBot/MaiBot 只借设计。MCP 官方 SDK `@modelcontextprotocol/sdk` 是 MIT，可直接用。

**最小改法**
1. `config/team.json` 加 `mcp_servers`（name、transport、url/command、allow_tools、timeout、enabled）。默认只放 1–2 个只读服务器（如 GitHub MCP 只读、DeepWiki）。
2. `src/mcp.ts`（Worker）实现远程 Streamable HTTP JSON-RPC：`initialize` → `tools/list` → `tools/call`；15s 超时、256KB 响应上限、每轮最多 3 次；工具名加 `mcp_<server>_<tool>` 前缀；只读工具加入 `UNTRUSTED_TOOLS`，写工具需 `authorize` + 管理员开关。
3. stdio 服务器放 runner：`runner/mcp.mjs` 用官方 SDK spawn，命令 allowlist（`npx`/`node`/`python3`），env 只传 allowlist，cwd 在 `~/.inkboard-team/mcp/`，30s 超时；通过 `/api/runner/mcp/call` 回调。**Worker 不能 spawn 子进程**，这是硬边界。
4. 内置 `calc`：Worker 里用安全表达式解析器（数字、`+ - * / % ( )`，1KB 上限），不做 `eval`；「跑脚本」只走 `skill`（声明式 SKILL.md + 固定脚本），不给群友自由 shell。
5. `tool_calls` 审计表（basics #P1-10）记录 `turn_id/name/args_hash/status/error_kind/latency_ms`；MCP 调用也走这张表。

**付费 key**：MCP 服务器各异；GitHub MCP 用免费 PAT（公开仓库匿名 60 次/时也够轻量查询），计算器/技能免费。不要把「付费 key」当成接 MCP 的前提。

**验收**
- 配置一个只读 MCP（如 GitHub MCP）→ 问「这个仓库最近的 PR」→ 工具出现在一轮里并返回；停用 server 后工具立即消失。
- `calc` 算「(128*3+56)/4」= 110；非法表达式返回可读错误，不执行。
- `skill` 跑 `pdf` 技能读一个 PDF；没有自由 shell 入口。
- 工具失败返回 `{ok:false,error_kind,retryable,next_action}`，不是一句「失败」。

---

### 3.9 语音回复（TTS）

**成熟做法**
- AstrBot `ProviderEdgeTTS`：默认中文女声 `zh-CN-XiaoxiaoNeural`（[`edge_tts_source.py:29-42`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/provider/sources/edge_tts_source.py#L29)）；先生成 MP3，再用 ffmpeg 转 24k 单声道 WAV（`:50-110`）；免费、无需 key，但依赖 Edge 的在线服务。
- QQ 官方 Node SDK 有 `sendVoice(target, {url|buffer|localPath})`（[`@tencent-connect/qqbot-nodejs`](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs) 的 `QQBot.d.ts:540`）和 `sendMedia`（`:500`）；TeamAgent 的 `runner/qq-gateway.mjs:166` 目前只绑了 `sendFile`。

**我们已有的**
- 入站 ASR 已有 X-ASR（`runner/xasr_transcribe.py`）；`voice.ts` 是文字人格/分段，不是 TTS。出站语音是空白。

**许可证 / 借用**
AstrBot AGPL：TTS 封装很小，照思路重写；`edge-tts` 是 **LGPL-3.0**，作为独立 CLI 调用、不修改/不静态链接，保留 LICENSE 即可。

**最小改法**
1. `runner/tts.mjs`（或 `.py`）：调用 `edge-tts --voice zh-CN-XiaoxiaoNeural --text ... --write-media tmp.mp3`；`ffmpeg -i tmp.mp3 -acodec pcm_s16le -ar 24000 -ac 1 tmp.wav`；文本上限 300 字、20s 超时；按 `sha256(text+voice)` 缓存 1h；失败回退文字。
2. 出站：**优先在 gateway 侧生成**（用户机器已有 ffmpeg/edge-tts，不用把音频传回 Worker）。`worker.ts` 给 outbox 写 `meta={voice_text, voice}`；`qq-gateway.mjs` 检测到 `voice_text` 就调 `tts.mjs`，再 `bot.sendVoice({scope:'group',targetId:group},{localPath})`；失败则 `sendText` 原文。
3. `config/team.json` 加 `voice.tts={enabled:false,voice:'zh-CN-XiaoxiaoNeural',max_chars:300,rate:'+0%'}`；先用开关灰度，不要默认全语音。
4. 只对 `mode='care'/'banter'` 且 ≤300 字、无代码/链接的回复生成语音；工作长答案保持文字。

**付费 key**：无（Edge TTS）。备用：Workers AI `@cf/myshell-ai/melotts` 18.63 Neurons/音频分钟，免费额度内；中文质量未验，先不作为主路径。

**实验（本机，2026-11-14 00:59）**
`edge-tts 7.3.1` 生成「明天九点提醒你开评审会。」→ 3.0s、18,000 bytes MP3；ffmpeg 转 24k 单声道 WAV → 144,078 bytes、`pcm_s16le/24000Hz/1ch`、3.0s。**未发 QQ**（会真实发群消息，未授权）。

**验收**
- `/voice on` 后一条 ≤300 字回复以语音到达；转写回来与原文一致。
- TTS 超时/失败时自动回退文字，不阻塞回复。
- 代码/链接/长答案不生成语音；`/voice off` 立即恢复文字。

---

### 3.10 群知识库（RAG）

**成熟做法**
- AstrBot `KnowledgeBaseManager`（[`kb_mgr.py:24`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/knowledge_base/kb_mgr.py#L24)）：递归字符切块（默认 500/100，分隔符含中文句号/逗号，[`chunking/recursive.py:5`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/knowledge_base/chunking/recursive.py#L5)）；稀疏检索 + 稠密检索 + `RankFusion`（RRF，k=60，dense_weight=0.9，[`retrieval/rank_fusion.py:26`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/knowledge_base/retrieval/rank_fusion.py#L26)）；`retrieve` 取 top_k_fusion=20、top_m_final=5（[`kb_mgr.py:282`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/knowledge_base/kb_mgr.py#L282)）。
- LangBot `LangRAG`（Apache-2.0）：`chunker.py:35 chunk_text`、`:174 chunk_sections`（按标题路径/表格切）；`rerank.py:91 model_rerank`、`:162 llm_rerank`；插件通过 KnowledgeEngine 暴露检索工具（[`chunker.py:35`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/KnowledgeEngine/LangRAG/components/knowledge_engine/chunker.py#L35)、[`rerank.py:91`](https://github.com/langbot-app/LangBot/blob/09ef402a03e5dcda704a0992b04adf4cc6a887b6/plugins/KnowledgeEngine/LangRAG/components/knowledge_engine/rerank.py#L91)）。

**许可证 / 借用**
AstrBot AGPL：照「递归切块 + RRF + 引用」重写；LangBot Apache：chunker/rerank 可搬。TeamAgent 的 D1 已支持 FTS5，先做稀疏检索就够。

**最小改法**
1. `schema.sql` 加：
   ```sql
   CREATE TABLE kb_docs(id TEXT PRIMARY KEY, group_id TEXT NOT NULL,
     title TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE kb_chunks(id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, group_id TEXT NOT NULL,
     idx INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB, created_at INTEGER NOT NULL);
   CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(text, tokenize='trigram');
   ```
2. `src/kb.ts`：切块 500/100，分隔符 `["\n\n","\n","。","，",". ",", "," "]`；写入 `kb_chunks` + FTS5；检索 `MATCH` + BM25，top 20；可选 bge-m3 向量做 RRF（k=60, dense_weight=0.9），最终 top 5，带 `doc_title/chunk_id`。
3. 入库来源：`/kb add <url|附件>`；URL 走现有 `readUrl`（Jina/DeepSeek），文件走 #6 的 `docread`；`group_id` 强制当前群；管理员/owner 才能 add/rm。
4. 工具 `search_kb({query, top_k?})`：返回 `{text, doc, chunk, score}`；输出标 `untrusted`；回答必须带来源，不把 KB 内容当指令。
5. 规模：D1 免费 5GB；10k chunks × 1024 float32 ≈ 40MB，完全够；超过 10 万 chunks 再考虑 Vectorize（付费）。

**付费 key**：FTS5 免费；bge-m3 用 Workers AI 免费每天 10,000 Neurons；不做 embedding 也能上线（纯 FTS5）。

**验收**
- 上传 20 页 PDF 建库，问一个具体事实 → 返回答案 + `doc/chunk`；删文档后检索不到。
- 问 A 群文档，B 群检索不到；跨群 leakage 为 0。
- 中文 2 字关键词用 `LIKE` 兜底；3 字以上走 FTS5 trigram。
- 回答里的 KB 内容不会触发写工具（taint）。

---

## 4. 第二梯队（明显提升，可排后）

### 4.1 PR / Issue / 代码检索

**成熟做法**
- GitHub MCP Server（MIT）的工具面：`pull_request_read`（[`pullrequests.go:74`](https://github.com/github/github-mcp-server/blob/f66a8d5882cb700c3466026726fe1faf1838c05d/pkg/github/pullrequests.go#L74)）、`list_pull_requests`（`:1579`）、`issue_read`（[`issues.go:828`](https://github.com/github/github-mcp-server/blob/f66a8d5882cb700c3466026726fe1faf1838c05d/pkg/github/issues.go#L828)）、`search_issues`（`:2028`）、`list_issues`（`:3803`）、`search_code`（[`search.go:289`](https://github.com/github/github-mcp-server/blob/f66a8d5882cb700c3466026726fe1faf1838c05d/pkg/github/search.go#L289)）、`list_commits`/`get_commit`/`get_file_contents`（[`repositories.go:239`](https://github.com/github/github-mcp-server/blob/f66a8d5882cb700c3466026726fe1faf1838c05d/pkg/github/repositories.go#L239)、`:66`、`:1017`）。
- 我们已有 `repo_changes`/`repo_commit`/`repo_file`（`src/repo.ts:7-11`）和 `ghFetch`/`parseRepo`/`redactPatch`（`src/github.ts:87`、`:15`、`:139`）；`get_project` 只对 5 个白名单仓库读缓存 issues/pulls（`semantic.ts:802`、`worker.ts:440-441`），**没有任意仓库的 PR/issue 工具**。

**许可证 / 借用**
MIT，可搬参数/返回结构；TeamAgent 的 `github.ts` 已有认证/限流/脱敏，优先扩展它，而不是新接 MCP。

**最小改法**
1. `src/repo.ts` 的 `repoTools` 加 `repo_pr`/`repo_issue`；`runCloudRepoTool` 加 case。
2. 参数：
   - `repo_pr {repo, number?, state?, action: list|view|files|comments}`；
   - `repo_issue {repo, number?, query?, state?, action: list|view|comments}`。
3. 复用 `parseRepo`（允许 owner/repo 和 GitHub URL）、`ghFetch`（分页/重定向校验/大小 cap）、`readCapped`、`redactPatch`；返回 title/state/author/body(≤8k)/files(≤30)/patch(≤200KB)/comments(≤20)/html_url；标 `untrusted`。
4. 缓存：`repo_cache` 或新 `github_cache(key,json,updated_at)`，PR/issue 5 分钟；匿名 60 次/时，`GITHUB_TOKEN` 5,000 次/时（免费 PAT）。限流时返回 `error_kind='rate_limited'` + `next_action`。
5. 如果 #8 先落地，也可以直接挂 GitHub MCP 的只读工具；两条路不冲突，先做 REST 版更可控。

**付费 key**：无；公开仓库匿名可用，私有仓库需免费 PAT。

**验收**
- 「看看 TeamAgent PR #34 改了什么」→ 返回文件列表 + patch 摘要 + 链接；「搜一下 D1 cursor 相关 issue」→ 返回 issue 号/标题/片段。
- 没有 token 时公开仓库仍可用；私有仓库返回 `needs_token` + 下一步；限流返回 `rate_limited`。

---

### 4.2 群管理命令与权限

**成熟做法**
- Koishi `Permissions`（[`permission.ts:41`](https://github.com/koishijs/koishi/blob/97d5c395750cec37b772e0b94dc63c427e3bb868/packages/core/src/permission.ts#L41)）内建 `authority:(value)`（`:48`），支持 `depends`/`inherits`（`:26-27`）；`Command` 有别名/快捷键（[`command/command.ts:42`](https://github.com/koishijs/koishi/blob/97d5c395750cec37b772e0b94dc63c427e3bb868/packages/core/src/command/command.ts#L42)）。
- NoneBot2 `Permission`/`User`（[`internal/permission.py:15`](https://github.com/nonebot/nonebot2/blob/2450b67a115916410d67154a8767b8e4c5aeb62f/nonebot/internal/permission.py#L15)、`:114`）和 `SUPERUSER`（[`permission.py:111`](https://github.com/nonebot/nonebot2/blob/2450b67a115916410d67154a8767b8e4c5aeb62f/nonebot/permission.py#L111)）。
- AstrBot 用 `admins_id` + `event.is_admin()`；定时任务删除时校验「创建者或本群管理员」（`cron_tools.py:296-330`）。

**我们已有的**
- `authz.ts` 的写工具授权（taint + 逐字原话）比上述项目更细；`members.role`/`who.role==='owner'` 已有；缺的是**群内命令路由**和**群级角色表**。basics 报告 P1-6 已列 `/help` `/status` `/stop` `/set`。

**最小改法**
1. `schema.sql` 加 `group_roles(group_id, member_id, role, granted_by, granted_at, PRIMARY KEY(group_id,member_id))`；role=`owner|admin|member`。bootstrap：绑定群的 `settings.group_id` + `config/owners` 为 owner；**不要假装能读 QQ 群管理员**——QQ 官方 SDK 的 `QQBot.d.ts` 没有 group member role 接口，事件也不带。
2. `src/commands.ts`：LLM 之前的确定性路由；命令表 `{name, args, role, handler, help}`；`/help`、`/status`、`/stop`、`/set`、`/remind`、`/todo`、`/summary`、`/profile`、`/kb`、`/voice`、`/sticker`。
3. `requireRole`：`/set` 仅 owner；`/stop` 创建者或 admin；`/kb add|rm` admin；`/profile` 本人或 admin；`/forget me` 本人。
4. 所有命令写 `activity` 审计；未知命令回 3 行 help，不调用模型；`/help` 动态列启用中的命令。
5. 复用 Koishi 的 `authority` 思路，不搬整套 permission graph；我们只需要 3 级 + 每命令覆盖。

**付费 key**：无。

**验收**
- `/help` 列命令；`/status` 显示绑定群、最近 job、outbox 失败数；`/stop` 取消自己发起的 research/plan；非 owner `/set` 被拒。
- 非创建者删别人的提醒被拒；admin 可以删本群。
- 命令不触发模型调用（看 `model_runs` 不增长）。

---

### 4.3 最新消息 / 新闻搜索

**成熟做法**
- AstrBot 的搜索工具矩阵：`news_search_serpapi`（[`web_search_tools.py:639`](https://github.com/AstrBotDevs/AstrBot/blob/23db1ad08064a8330a09077138ce8ecc05362219/astrbot/core/astr_agent_runtime/tools/web_search_tools.py#L639)）、`image_search_serpapi`（`:741`）、`finance_search_serpapi`（`:834`）、`scholar_search_serpapi`（`:926`）；还有 Bocha/Brave/Baidu/Exa/DeepSeek/Firecrawl；`_KeyRotator` 对 401/403/429/432 换 key（`:83-150`）。
- MaiBot `WebSearchService`（[`src/web_search/service.py:32`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/web_search/service.py#L32)）用 adapter 选择 Tavily/Exa/Firecrawl/AnySearch/DeepSeek/StepSearch；每个 adapter 有超时和 URL 校验。
- 我们的 `search_web` 调 DeepSeek `/v1/tools/search`（`semantic.ts:292-312`），结果只有 4 条 `need_content`，没有 `published_after`/新闻/来源日期/多 provider 回退。

**许可证 / 借用**
AGPL/GPL 只借工具面；免费路径自己写 RSS。

**最小改法**
1. `src/semantic.ts` 加 `news_search({query, hours=24, limit=10})`：请求 Google News RSS `https://news.google.com/rss/search?q=<query>&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`；解析 XML（`fast-xml-parser` MIT，或正则）；返回 title/link/pubDate/source；按 `hours` 过滤；缓存 10 分钟。
2. 兜底 Bing News RSS；再失败回 `search_web`，并在结果里带 `source/date`。
3. 给 `search_web` 加 `published_after` 参数；结果渲染带日期，避免「最新」其实是旧闻。
4. 不需要 SerpAPI/Tavily；如果以后要图片/学术搜索，再按 #8 接 MCP 或付费 provider。

**实验（本机）**
`curl` Google News RSS（q=DeepSeek）→ HTTP 200、99,738 bytes，XML 正常（2026-11-14 00:58）。Worker 出口未测，需在 Worker 里跑一次。

**付费 key**：无（RSS）。SerpAPI/Tavily 只在质量不够时加。

**验收**
- 「今天 AI 圈有什么」→ ≤10 条，全部 ≤24h，带来源 + 时间；没有就直说没有。
- RSS 失败时回退 `search_web`，并说明「新闻源不可用，这是通用搜索结果」。
- 结果不被当指令（untrusted）。

---

### 4.4 表情包语义检索

**成熟做法**
- MaiBot `EmojiTags`：`emotion_tags` ≤5、`content_tags` 1–5（[`semantic_match.py:35`](https://github.com/Mai-with-u/MaiBot/blob/03347c9b8f6fa2208e763da3cd4713db22af87bf/src/emoji_system/semantic_match.py#L35)）；`_score_matches` 做余弦（`:77`）；SQLite 里按 `(config, description, space)` 存向量（`:91`）；`match_emoji_description:244` 按意图匹配。
- 我们 `stickers.ts:72 pickSticker` 是字符 bigram 相似度；`send=false`（`config/team.json`），`min_senders=2`。缺的是语义层。

**许可证 / 借用**
MaiBot GPL-3.0：只借标签维度和「content/emotion 双轴」；向量代码自己写。

**最小改法**
1. `schema.sql` 给 `stickers` 加 `emotion_tags TEXT`、`content_tags TEXT`、`embedding BLOB`（迁移）。
2. `tagSticker` 的 prompt 改为输出 `{desc, emotion_tags:[≤5], content_tags:[1-5], meme}`；现有 `describeBytes` 已能返回 JSON。
3. Embedding：Workers AI `@cf/baai/bge-m3`（多语言，1,075 Neurons/M token）或 `@cf/google/embeddinggemma-2`（154 Neurons/M）；存 1024 float32；`pickSticker` 对 `state=2` 的 ≤200 行做余弦，阈值 0.55，低于阈值回退 bigram。
4. 发图仍走 `enqueueSticker`；保持 `caps.send=20`/24h 冷却；`send=false` 先不开，跑 20 条人工标注查询，top-1 ≥70% 再开。

**付费 key**：无；Workers AI 免费额度足够（每天 10k Neurons）。

**验收**
- 「无语」「震惊」「收到」各 5 条查询，top-1 命中 ≥70%；不合适的返回空而不是乱发。
- 同一表情 24h 内不重复；`send=false` 时只理解不发送。
- 没有 embedding 时 bigram 仍可用，不阻塞。

---

### 4.5 自省闭环升级（trace → judge → apply）

**成熟做法**
- 我们现在的 `analyse()` 一次 LLM 调用同时写 facts/expressions/`reflection`/`self_note`（`semantic.ts:43-110`），`reflection` 写 `settings.team_reflection`（`:202`），第二天注入 system prompt（`:856`）；`dreams` 只有一段文本 + 来源 id（`schema.sql:15`）。这是**同模型、同人格、同上下文**的自评，自偏好最强。
- Letta「Memory & dreaming」：后台 subagent 回看最近对话、巩固经验；可开「Agent reviews before applying」让第二个后台对话再审一遍（[docs](https://docs.letta.com/configuration/memory)）。
- LangBot `MemoryStore` 的 consolidation 是「先 preview 候选 → 再 apply → 可 invalidate 派生记忆」（`memory_store.py:1756`、`:1837`；`consolidation.py:62/161/262`），并且 recall 有 `currently_valid` 和 8000/2000 字符预算（`recall.py:26/96/192`）。
- 我的 V-D 报告 `TeamAgent-vD-research-20261114.md` 已经给出完整方案：`trace`（无模型）→ `judge`（独立上下文/异族）→ `apply`（只写候选/记忆）→ `publish`（写 tasks/backlog）；P0 只写 `review_findings`，不改行为；用 `quoteIn()` 校验逐字证据；TRAIL 三层错误分类；fingerprint 去重。这里不重复 967 行，只给落地切口。

**许可证 / 借用**
Letta 文档引用；LangBot Apache-2.0 可搬 consolidation 的 preview/apply/invalidate 结构；Mem0 Apache-2.0 可搬四操作。TeamAgent 自己的 V-D 报告可直接当施工单。

**最小改法**
1. `schema.sql` 加 `review_runs(id, group_id, cursor_message_id, model, status, created_at)`、`review_findings(id, run_id, turn_id, failure_type, severity, evidence_ids, quote, next_attempt_plan, fingerprint, status, created_at)`、`memory_audit`。
2. `src/semantic.ts` 拆四段：
   - `buildTrace`：确定性拼消息、工具调用、outbox、失败原因；不用模型；
   - `judge`：独立上下文，**不注入** `self_note`/`team_reflection`；只看 trace；要求每条 finding 带 `message_id` + 逐字 quote + `next_attempt_plan`；优先异族模型（本机 Codex/Claude 只读，`runner/subagent.py` 已有 `READER_PROFILE`/`DENY`/租约）；
   - `apply`：只写 `facts/episodes` 候选 + `memory_audit`；行为规则只写 `proposal`，不直接改 prompt；
   - `publish`：把高频 failure 写成 `tasks`/`.agent` backlog，不自动改代码。
3. `config/team.json` 加 `review={enabled:false, model:'codex-readonly', max_findings:20, frequency:'daily'}`；P0 只出 findings，0 行为写入；canary 另开。
4. 用 `quoteIn()` 校验 quote；`fingerprint=sha256(failure_type+evidence_ids+normalized_quote)` 去重；同一 fingerprint 只保留最近 3 条 open（Reflexion 的 memory[-3:] 思路）。

**付费 key**：用本机 Codex/Claude 只读则无新增；用 DeepSeek 则现有额度。不要为 judge 另买模型。

**验收**
- 回放 7 天真实消息：每条 finding 有 `message_id` + 逐字 quote + `next_attempt_plan`；0 次行为写入。
- 用已知的 `chat_cursor` 事故回放，judge 能指出「先判 cursor 再判 @」的根因，而不是泛泛说「要更认真」。
- 同一 fingerprint 不重复；`memory_audit` 可回滚；第二天 prompt 不被未审 reflection 污染。

---

## 5. 锦上添花

### 5.1 工具 / 插件热加载

- **成熟做法**：Koishi `packages/loader/src/index.ts` 负责插件加载/热重载；NoneBot2 `PluginManager`（[`manager.py:35`](https://github.com/nonebot/nonebot2/blob/2450b67a115916410d67154a8767b8e4c5aeb62f/nonebot/plugin/manager.py#L35)）`load_plugin:156`；MaiBot `src/plugin_runtime` + plugin market；LangBot `toolmgr` 的 native/plugin/MCP/skill loader。
- **最小改法**：D1 `tools(id,name,version,manifest,enabled,hash,installed_by,created_at)`；runner `tools/<name>/manifest.json` + entrypoint；Worker 合并 schema；`/tools reload` 仅 owner；hash allowlist；先做声明式 skill，不做任意 Python 插件。
- **许可证**：Koishi/NoneBot MIT 可搬；MaiBot GPL 只借设计。
- **付费 key**：无。
- **验收**：装 hello-world 工具不重启 Worker 就出现；禁用即消失；坏 hash 拒绝；审计有安装人。

### 5.2 文生图

- **成熟做法**：这不是 QQ bot 的默认能力（AstrBot 的 t2i 是 HTML/Markdown 渲染，不是 AI 生图；MaiBot `image_system` 是图片缓存/理解）。Cloudflare Workers AI 提供 `@cf/black-forest-labs/flux-1-schnell`：4.80 Neurons/512 tile + 9.60/step，免费每天 10,000 Neurons（[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)）。
- **最小改法**：`src/semantic.ts` 加 `draw({prompt, size=512, steps=4})`；`env.AI.run(...)` 返回 base64 PNG；存 D1 BLOB 或临时 R2；通过 `send_media` 发图；每用户/天 3 张；中文 prompt 先用现有模型翻成英文；加内容安全关键词。
- **许可证**：Workers AI 服务条款；无代码搬用。
- **付费 key**：免费额度内；超出 $0.011/1k Neurons。
- **验收**：「画一只戴墨镜的鲸鱼」20s 内出图；第 4 张被限流；NSFW 词被拒。

---

## 6. 十个特别关注领域的覆盖结论

| 领域 | 结论 | 对应项 |
|---|---|---|
| 看仓库提交 / PR / 代码 | commit/file/代码片段已经强（`repo_changes/commit/file`，任意 owner/repo）；**PR/Issue 是缺口**，`get_project` 只对白名单读缓存 | #11 |
| 联网搜最新消息 | 通用 `search_web` 有，但走 DeepSeek 搜索、无时效/来源日期/新闻专用；补 RSS + `published_after` 即可 | #13 |
| 记住群友和长期记忆 | 名字/事实/纠错有；**人物画像、情景记忆、时效/去重/审计**没有；这是「记得住人」和「记得住事」的分界 | #4、#5 |
| 主动但不吵 | 固定 debounce + 硬停；**没有概率/频率自适应、没有静音时段、没有 idle backoff** | #7 |
| 图片/表情/语音/文件/链接理解 | 读图/OCR、链接、语音转写、文件交付都在线；**TTS、文档编辑/校验、表情语义**是缺口 | #6、#9、#14 |
| 定时提醒与待办 | 完全没有；`scheduled` 只跑 scout/dream/清理，`tasks` 是项目板不是个人待办 | #1 |
| 群内工具调用（计算/查资料/跑脚本） | 只有 8 个固定工具；**MCP/计算器/技能**没有；自由 shell 不应开放给群友 | #8 |
| 权限与安全 | `authz/taint/quote` 比开源项目强；缺群级角色/命令权限；**新增工具不能绕过现有 taint** | #12（并保留 `authz.ts`） |
| 自我复盘 | 有夜间 dream，但同模型自评且回灌 prompt；按 V-D 报告拆 trace/judge/apply | #15 |
| 多群隔离（前置） | 仍是单群 + 全局 `chat_cursor`；basics 报告 P0；不先修，上面所有按群 schema 都会串 | basics P0 |

---

## 7. 不建议抄 / 走不通

1. **AstrBot 的 APScheduler 直接搬进 Worker**：Worker 没有长驻进程，Cron 触发是每分钟一次；用 D1 `reminders` + `scheduled`，不要引入 Python 调度器。
2. **Worker 里 spawn stdio MCP**：Workers 没有子进程；stdio MCP 必须放 runner，Worker 只做远程 HTTP MCP。
3. **把 A_memorix（AGPL）整包搬进来**：它很大、带自己的 schema/迁移/插件宿主；只借「七段画像 + 双路检索」的设计。
4. **Mem0 全套向量库（Qdrant/Chroma/pgvector）**：小群用 D1 FTS5 + 暴力余弦就够；上 Vectorize 也应在 10 万 chunks 之后。
5. **Letta 代码**：当前 repo 只有 224KB 文档，没有源码；引用其「Memory & dreaming」文档，不要声称读过实现。
6. **Edge TTS 当稳定 SLA**：它是 Edge 在线服务的非官方封装，可能限流/变更；必须文字回退，别把语音当唯一出口。
7. **给群友自由 shell/`eval`**：AstrBot 的 shell 也要 admin + workspace + 超时；我们最多给「声明式 skill + 固定脚本」，不给任意命令。
8. **直接复制 AGPL/GPL 代码**：会把许可证义务带进 TeamAgent；AstrBot/MaiBot/kirara 只照思路重写，MIT/Apache 才搬。
9. **把图片生成当基本功能**：成熟 QQ bot 默认没有 AI 生图；它是锦上添花，不要挤占提醒/总结/历史的工期。
10. **假装能读 QQ 群管理员/撤回/戳一戳**：官方 SDK/事件面窄；basics 报告已确认只接两种 message 事件。没有的能力就明说，不要编。

---

## 8. 建议施工顺序（两周，按依赖排）

**第 1 周：低风险、可回放**
1. 先修 basics P0：`chat_cursor:<group_id>`、mentioned 前置、多群字段。**这是所有按群能力的地基。**
2. #3 历史检索（0.5 人日）→ #2 群总结（1 人日，复用历史取数）。
3. #1 提醒/待办（1–2 人日，D1 + scheduled，不碰 runner）。
4. #7 频率门控（1 人日，先用 MaiBot 特征 + 我们自己的 `chat_decisions` 重拟合）。
5. #12 命令路由 + `/help` `/status` `/stop` `/set`（1–2 人日，和 #1/#2 同批）。

**第 2 周：加表、加 runner job**
6. #4 画像 + #5 情景记忆（2–3 人日；同一夜间 job 扩展，先写 proposal，不直接改行为）。
7. #6 文档技能包（2 人日；`docread` + SKILL.md + 校验/渲染）。
8. #9 TTS（1 人日；先灰度开关，文字回退）。
9. #8 MCP + calc（3–5 人日；先 1 个只读 MCP，再 skills）。
10. #10 KB（3 人日；先 FTS5，后 embedding）。
11. #11 PR/Issue、#13 新闻、#14 表情、#15 自省（按余量排；#15 先做只读 findings）。

**依赖关系**
- #2 依赖 #3 的取数；#10 依赖 #6 的文件解析；#8 是 #11 的替代路径但不是前置；#4/#5 共用夜间 job 和 `memory_audit`；#9 依赖 gateway 的 `sendVoice` 绑定；#15 依赖 `tool_calls`/trace（basics P1-10）。
- 不要并行改 `semantic.ts` 的同一段工具表：先加工具 schema（小冲突），再分别加实现；每个 PR 只动一个能力。

---

## 9. 未验证与风险

- **D1 FTS5 trigram**：本地 SQLite 3.45.1 通过（3 字中文可命中，2 字空），D1 官方说支持 FTS5（[docs](https://developers.cloudflare.com/d1/sql-api/sql-statements/)），但 **D1 上的 trigram tokenizer 未用 wrangler 实测**；上线前用 `wrangler d1 execute --local` 跑一条 `CREATE VIRTUAL TABLE ... tokenize='trigram'`。
- **Workers AI 中文 embedding**：bge-m3 是多语言，价格/额度来自官方文档；**没有在本账号跑过**，质量/延迟未验。
- **QQ `sendVoice`**：SDK 有 `sendVoice(localPath)`，但语音格式/审核/失败码未实测；**没有向真实群发过**（会发真消息，未授权）。先用测试群/本地 mock。
- **Edge TTS**：本机 7.3.1 生成 3s MP3 成功；未测长文本、限流、代理、QQ 上传；Edge 服务可能变更。
- **Google News RSS**：本机 `curl` 200/99KB；Worker 出口可能被地区/网络策略影响；需 Worker 内实测。
- **MaiBot 权重**：0.722/0.462/0.347/0.160/0.220 只是用其权重算的示例，**不是我们群的数据**；必须用 `chat_decisions` 重拟合，否则会系统性偏多/偏少。
- **GitHub 限流**：公开仓库匿名 60 次/时、认证 5,000 次/时来自 GitHub 文档；没有压测；PR/Issue 分页/大 patch 的 CPU 未测。
- **Cron 延迟**：Worker Cron 每分钟触发，提醒最长延迟约 60s；`scheduled` 里一次最多处理 20 条，突发 100 条提醒会排队；需要分批/租约。
- **D1 写放大**：画像/情景/审计每晚批量写，免费 D1 每日 10 万行写；按 60 条/批 × 8 批 × 每批 8 条 ≈ 64 条/晚，远低于限额；但 `memory_audit` 要定期归档。
- **版权**：MIT/Apache 代码搬入需保留 LICENSE/NOTICE；AGPL/GPL 只重写。SKILL.md 文字也受版权保护，AstrBot 的段落不能逐字复制。
- **运行时事实**：TeamAgent 生产是否配 `GITHUB_TOKEN`、runner 是否在线、`chat_cursor` 当前值，本文只读代码，没有读生产 D1；需 `/health`、`/api/team/ops` 另查。

---

## 10. 实验记录（可复现）

| 实验 | 命令/方法 | 结果 |
|---|---|---|
| 成熟项目快照 | `git clone --depth 1` 9 个仓库；`git rev-parse HEAD` | AstrBot `23db1ad`、MaiBot `03347c9`、kirara `36249e4`、Koishi `97d5c39`、NoneBot2 `2450b67`、LangBot `09ef402`、Mem0 `f1791da`、Letta `8816d3a`、GitHub MCP `f66a8d5` |
| D1/SQLite FTS5 | Python `sqlite3` 3.45.1：`CREATE VIRTUAL TABLE ... tokenize='trigram'`；插「明天九点提醒我开评审会」 | 3 字查询「评审会/提醒我/明天九点」命中；2 字「评审」空 → 需 `LIKE` 兜底 |
| MaiBot 概率 | 按其 `reply_likelihood.py:22-30` 权重算 | @bot 0.722；普通问句 0.462；普通陈述 0.347；刚说过话+陈述 0.613；纯表情 0.160；@别人 0.220 |
| Edge TTS | `/tmp/ttsvenv` 安装 `edge-tts 7.3.1`；`--voice zh-CN-XiaoxiaoNeural` 生成 3s 文本；`ffmpeg -ar 24000 -ac 1` | MP3 18,000 bytes/3.0s；WAV 144,078 bytes、`pcm_s16le/24000/1ch`；无 key |
| Google News RSS | `curl 'https://news.google.com/rss/search?q=DeepSeek&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'` | HTTP 200、99,738 bytes、合法 RSS XML；无 key |
| TeamAgent 现状 | 只读 `git show 35b3efa`/`grep` `src/`、`runner/`、`schema.sql` | 8 个工具、无 reminders/episodes/person_profiles/kb/mcp/tts；`wrangler.toml:10` 已 `* * * * *` |

---

## 11. 可直接借用的文件 / 函数（按性价比）

| 优先 | 项目 · 文件 · 函数 | 语言 | 搬过来要改什么 | 许可证 |
|---:|---|---|---|---|
| 1 | LangBot `src/langbot/pkg/provider/tools/toolmgr.py` · `ToolManager` | Python | 改 TS/Python runner 的工具注册表；保留 `get_all_tools`/`generate_tools_for_openai`/`execute_func_call` 三段 | Apache-2.0 |
| 2 | LangBot `plugins/KnowledgeEngine/LongTermMemory/store/memory_store.py` · `add_episode`/`preview_consolidation`/`apply_consolidation` | Python | 改成 D1 表 + Worker/runner 两段；保留 `[valid_from,valid_until)` 和 audit | Apache-2.0 |
| 3 | LangBot `plugins/misc/GroupChatSummary/main.py` · `record_message`/watermark | Python | 去掉内存缓冲，直接用 D1 `messages`；保留 200 条阈值/watermark 防重复 | Apache-2.0 |
| 4 | AstrBot `cron_tools.py` · `FutureTaskTool` | Python | 重写 TS：`reminders` 表 + `future_task` 工具 + 创建者/管理员权限 | AGPL-3.0（重写） |
| 5 | AstrBot `message_tools.py` · `GetGroupMessageHistoryTool` | Python | 重写 TS：`search_history`（当前群、≤50、keyword/sender/before_id） | AGPL-3.0（重写） |
| 6 | MaiBot `turn_trigger/reply_likelihood.py` · `estimate_reply_probability` | Python | 只借 8 特征 + logistic 形式；权重用 `chat_decisions` 重拟合 | GPL-3.0（重写） |
| 7 | MaiBot `turn_trigger/dynamic_gate.py` · `DynamicReplyGate` | Python | 重写 TS：1h 窗口、frequency、静态阈值、只收紧 | GPL-3.0（重写） |
| 8 | MaiBot `turn_trigger/idle_backoff.py` · `IdleBackoffController` | Python | 重写 TS：base/cap/start/bypass_pending | GPL-3.0（重写） |
| 9 | MaiBot `A_memorix/core/utils/profile_text.py` · `build_profile_injection_text` | Python | 重写七段/长度/不确定段/冲突规则 | AGPL-3.0（重写） |
| 10 | Mem0 `mem0/memory/main.py` · `_add_to_vector_store` + `configs/prompts.py` · `ADDITIVE_EXTRACTION_PROMPT` | Python | 只借五段式 + 四操作 + Observation Date；D1 替代向量库 | Apache-2.0 |
| 11 | GitHub MCP `pkg/github/pullrequests.go`/`issues.go`/`search.go` | Go | 照参数/返回重写 TS；接 `github.ts` 的 `ghFetch` | MIT |
| 12 | Koishi `packages/core/src/permission.ts` · `Permissions` | TypeScript | 只借 authority/depends/inherits 三概念；实现 3 级角色 | MIT |
| 13 | NoneBot2 `nonebot/internal/permission.py` · `Permission`/`User` | Python | 借 `SUPERUSER` 语义，接 `members.role` | MIT |
| 14 | AstrBot `provider/sources/edge_tts_source.py` · `ProviderEdgeTTS` | Python | 重写 `tts.mjs`：edge-tts CLI + ffmpeg 24k mono；gateway `sendVoice` | AGPL-3.0（重写）/ edge-tts LGPL |
| 15 | AstrBot `knowledge_base/chunking/recursive.py` · `RecursiveCharacterChunker` | Python | 重写 TS 切块 500/100；中文分隔符 | AGPL-3.0（重写） |

---

## 12. 一句话给主程

**先把「提醒、总结、历史、频率」四个入口做出来，再把画像/情景记忆/文档技能/MCP 作为第二层；所有新工具都走现有 `authz.ts` 的 taint + 逐字原话，所有新表都带 `group_id`，所有代码搬运先看许可证。**
