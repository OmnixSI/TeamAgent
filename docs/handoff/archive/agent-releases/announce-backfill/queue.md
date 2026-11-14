# 补发公告清单（announce-backfill）

- 生成：2026-11-14 13:52 Sydney · 调研员（DeepSeek）
- 线上基线：`/health.release = 41db2b52ebddd4eb1f46871e9d260ef504da8dc3`（main，V-D）
- 依据：`/Users/yanghongming/Projects/.agent/releases/{trip0,trip1,SK,F11}/status.md`、`trip1/ds-live-state.md`（交付员 13:50）、main 的 git log、F6/F7 的 acceptance 与证据文件。只读，未写库、未发群、未部署。
- 路径约定：`REPO_AGENT = /Users/yanghongming/Projects/.worktrees/TeamAgent-p4b-login/.agent`。
- 13:50 配置更新：`com.inkboard.team-media` 已加载、runner DeepSeek key 已配、Worker 增加 `OPENAI_API_KEY`；这三项按团队记忆 + `launchctl` 核对，优先于 `ds-live-state.md` 的旧描述。
- 共 **12 条**：前 7 条「已验证且已打开」，写正式草稿；后 5 条标「待验证，不发」。

## 0. 已发公告（不重复，不进队列）

| 去重键 | rowid | 正文 |
|---|---|---|
| `release-notice:trip0` | 264 | 我修好了一个小毛病：以前偶尔会把几个小时前的旧消息又回复一遍，现在不会了。 |
| `release-notice:trip1` | 265 | 又修好一个小毛病：发了 B 站链接后，哪怕紧接着再单独 @ 我，我也能认出刚才的视频。 |
| `release-notice:SK` | 266 | 现在你问我某个能力是怎么实现的、用的哪家服务，我能讲清楚，也知道自己的代码是怎么组成的。 |
| `release-notice:V-D` | 267 | 群里发「接入验收小活：请…」这类带标题冒号的交办，现在能正常识别了。 |

两条边界：trip1 只讲了「短链继承」，**没讲「B 站视频内容总结」**；V-D 只讲了「全角冒号」，**没讲「夜间复盘」**。前者当前执行器没跑（第 9 条），后者是影子期（第 12 条），这次都不发。

## 0.1 2026-11-14 14:05 新建的晨报与首条补发

| 去重键 | outbox rowid | 内容 |
|---|---|---|
| `release-notice:morning-report` | **269** | 从明天起，每天早上 8 点（悉尼时间）我会发一条昨天群里聊了什么的小总结。 |
| `release-notice:backfill-01` | **270** | 群里发的图片我现在能看懂了，问我图里是什么、写了什么字都行。 |

- 日程：`sched-digest_daily-ROBOT1.0_uMj7bSoGmOazRMZniW.yT2V5hU3d-j6xzhbCQeAQ6Z.OwSP3g49XjNFz-7MfTy-y7SwXrIDy1.sk-8ujK3u2doyiDiEnBsDjRwFKyBrETjzvJYw94Gf2XvduFhFPmyNe`，kind=`digest_daily`，tz=`Australia/Sydney`，spec=`{"time":"08:00"}`，status=`active`，next_run_at=`1794690000000` = **2026-11-15 08:00 Sydney**。
- 两行插入时均 `status=pending`；2026-11-14 14:06 Sydney 复核均为 `status=sent`（`msg_id` 为空，与 trip0–V-D 一致），同键各 1 行。

## 1. 可发（7 条，按发送顺序）

> 2026-11-14 15:08 更新：7 条已全部发出（outbox rowid 270/271/272/276/278/279/280，均 `sent`）。本节暂无可发条目；后续追加的新条目写在本文件末尾，格式同上。

### 1. 看图：群里发的图能看懂
- 状态：**已验证且已打开**
- 线上：`config/team.json:94` `vision.enabled=true`；无 `off:vision`；`src/vision.ts:141-155` 主通道 deepseek，失败回 workers。
- 证据：`REPO_AGENT/releases/F6P/evidence/f6p1-live.json` —— msg#305 表情原图、msg#383 新闻截图、msg#325 招聘截图，3/3 成功，合计 6.5 s、$0.000779。真群上线后 0 张图（`trip1/ds-live-state.md` §2 第 8 行）。
- 草稿：**「群里发的图片我现在能看懂了，问我图里是什么、写了什么字都行。」**
- 去重键：`release-notice:backfill-01`
- 已发：outbox rowid **270**（2026-11-14 14:05:56 入队，14:06 复核 `status=sent`；`msg_id` 为空）

### 2. 翻旧消息：找回群里以前说过的话
- 状态：**已验证且已打开**
- 线上：`src/tools/search-history.ts`；`search_history` 已注册；无 `off:search_history`；支持关键词、发送人、最近小时数、翻页。
- 证据：`REPO_AGENT/releases/F7/acceptance.json` S1 —— 12/12，夹具是线上只读导出的 462 条真实群消息（rid 1..462，sha256 `6df7610e…`），含 2 字中文查询。
- 草稿：**「想找群里以前说过的话，告诉我关键词或者是谁说的，我能翻出来。」**
- 去重键：`release-notice:backfill-02`
- 已发：outbox rowid **271**（2026-11-14 14:15:51 入队；14:16:22 复核 `status=sent`，`msg_id` 为空）

### 3. 群聊总结：按结论/决定/待办分好
- 状态：**已验证且已打开**
- 线上：`src/summary.ts` + `summarize_chat`；无 `off:summarize_chat`；手动可用，自动总结默认关。
- 证据：`REPO_AGENT/releases/F7/accA/s2-summary.json` —— 真实 200 条、五段、19 refs 全部按 rowid 回到同群真实 message_id；二次调用 `cached=true`、模型调用 0。回放用 Luna，线上是 deepseek-flash。
- 草稿：**「群里聊得多的时候，喊我总结一下，我会按结论、决定和待办分好给你。」**
- 去重键：`release-notice:backfill-03`
- 已发：outbox rowid **272**（2026-11-14 14:26:03 入队；14:27 复核 `status=sent`，`msg_id` 为空）

### 4. 仓库 / PR / Issue：项目动态直接查
- 状态：**已验证且已打开**
- 线上：`list_repos`、`repo_changes`、`repo_commit`、`repo_file`、`get_project`、`search_pr_issue`、`search_code`；无 `off:repo_tools`。
- 证据：`REPO_AGENT/releases/F6/acceptance.json` F6-A1/A2 —— msg#436「最新的陪玩店」解析到 `OmnixSI/peiwan-club-saas`、head `fdd7b76`；msg#437/438 `list_repos` 均 6 个。PR 侧：`TeamAgent-capability-ledger-20261114.md` 记 11-12 真群回答 WhalePartner main `a1cfc82`、PR #154–161（outbox#190/191）。`search_pr_issue` 的 F7 S10 18/18 是假响应，只作工具接线证据。
- 草稿：**「问我哪个项目最近改了什么、哪个 PR 还开着、哪个 Issue 还没关，我能直接查。」**
- 去重键：`release-notice:backfill-04`
- 已发：outbox rowid **276**（2026-11-14 14:37:16 入队；14:37 复核 `status=sent`，`msg_id` 为空）

### 5. 联网搜索：查最新消息并给来源
- 状态：**已验证且已打开**
- 线上：`src/semantic.ts:1324-1331` 的 `search_web` 与 `src/semantic.ts:563-590` 的 scout 走同一个 `tool(e,"search")`（DeepSeek `/v1/tools/search`）；Worker `DEEPSEEK_API_KEY` 有；无 `off:ds_search`。
- 证据：`trip1/ds-live-state.md` §2 第 6 行 —— `scout-2026-11-14-12` 12:00:44 生成，`discoveries` 有 GitHub/arXiv URL；群里的 outbox#268（12:00:48）带 `github.com/margince/...` 与 `arxiv.org/abs/2609.35588` 两条链接。群内 `web_search` 工具本身 0 次（还没有真人提问）；`news_search` 的 S11 12/12 是本地假响应，不在这句承诺里。
- 草稿：**「想查网上的最新消息，直接问我，我会把看到的来源链接一起给你。」**
- 去重键：`release-notice:backfill-05`
- 已发：outbox rowid **278**（2026-11-14 14:46:19 入队；14:47:27 复核 `status=sent`，`msg_id` 为空，同键 1 行）

### 6. 计算器：算数、算比例直接丢过来
- 状态：**已验证且已打开**
- 线上：`src/tools/calc.ts` + `calc` 工具；无 `off:calc`；支持小数、`+ - * / %` 和括号。
- 证据：`REPO_AGENT/releases/F7/acceptance.json` S7 —— MCP 只读 + calc 22/22（MCP 是本地假服务器；calc 本身是确定性计算）。
- 草稿：**「要算数、算比例，直接丢给我，不用自己按计算器。」**
- 去重键：`release-notice:backfill-06`
- 已发：outbox rowid **279**（2026-11-14 14:56:00 入队；14:57 复核 `status=sent`，`msg_id` 为空，同键 1 行）

### 7. 定时提醒 / 每天固定时间总结
- 状态：**已验证且已打开（能力）**
- 线上：`src/schedules.ts` + `schedule_create/list/cancel`；每分钟 cron 已开；线上 `schedules=0`、`schedule_runs=0`（还没有人建过日程）。
- 证据：`REPO_AGENT/releases/F6/acceptance.json` F6-A6 整体判 ❌ 是因为线上 `schedules=0`，它记录的代码回放是 14/14（S7：msg#351 建 08:00 daily、msg#355 列出、msg#286 mute 10 分钟；S13 cron 真出站）；`REPO_AGENT/releases/F6P/daily-push-replay.log` 用 35 条真实消息 + 假时钟跑过到期、DST、晚到 15 分钟不补。
- 草稿：**「想让我到点提醒你，或者每天固定时间总结群里消息，把时间告诉我就行。」**
- 去重键：`release-notice:backfill-07`
- 已发：outbox rowid **280**（2026-11-14 15:06:22 入队；15:08 复核 `status=sent`，`msg_id` 为空，同键 1 行）
- 注意：**「每天 8:00 日推」本身还没创建**，见 §6 第 3 条；这句只说「可以设」，不说「已经在推」。

## 2. 待验证 / 未打开（5 条，不发）

> 每条都有一句候选文案，但按 BINI 口径标「待验证，不发」；等对应证据齐了再转正。

### 8. 读文档（PDF / Word / Excel / PPT）
- 状态：**未打开（开关未设）**
- 线上：`src/tools/read-document.ts` + `runner/docread.py` 都在 main，但 `src/tools/read-document.ts:182-185` 要求 settings `docread:enabled=1`；线上未设，工具固定返回「本机文档读取端没有开启」；`doc_jobs=0`（`trip1/ds-live-state.md` §2 第 5/12 行）。
- 待验证，不发：「PDF、Word、Excel 发我，我能按页读。」

### 9. B 站无字幕视频
- 状态：**仅代码在线（执行器已恢复，未跑真视频）**
- 线上：基本 B 站读取（标题/字幕/评论）仍由 `fetch` 服务在跑，`media_notes=17`；13:50 配置更新后 `com.inkboard.team-media` 已加载（`StartInterval=60`、`runs=5`、`last exit code=0`），plist 带 `DEEPSEEK_API_KEY_FILE`，runner key 已配；还没有一条真群无字幕视频跑过（media job 最后 09:47 仍是上线前）。
- 待验证，不发：「没字幕的视频我也能听完再给你讲重点。」

### 10. DeepSeek 全家桶：云端语音 / OCR / 网页抓取 / 语音回复
- 状态：**仅代码在线（0 次线上调用）**
- 线上：`ds_usage=0`、`tool_calls=0`；云端 ASR 在 `src/voice-asr.ts`（已接 `worker.ts:20/397`，`off:ds_asr` 未设），0 次触发；OCR `read_image_text` 已注册，0 次；网页抓取 `fetch_page` 已注册，0 次；TTS `voice:mode` 未设 = auto，`voice.ts:79` 强制启用，`runner/qq-gateway.mjs:179` 已接发送，13:50 起 runner key 已配、media 已加载，DeepSeek TTS 备用可用；线上 voice 行仍 0（`trip1/ds-live-state.md` §2 第 1/3/4/7 行 + 13:50 配置更新）。
- 待验证，不发：「发语音、发网页链接、发带字的图，我也能直接处理；需要时还能用语音回你。」

### 11. 群里的记忆和互动：知识库 / 情景记忆 / 群友画像 / 表情包 / 主动接话
- 状态：**未打开 / 数据为空**
- 线上：知识库 `kb_docs=0`、`kb_chunks=0`，`src/kb.ts` 的 `addDoc` 没有生产调用方；情景记忆 `episodes=0`，`src/episodes.ts` 的 `addEpisode` 没有生产调用方；群友画像 `profiles=0`，`src/profiles.ts:347-348` 需要 `profiles_enabled`，线上没设；表情包 `stickers=1`（红方块）、`config/team.json:127` `send=false`；主动接话 `src/gate-wire.ts:28-31` 缺省 `off`，线上没有 `gate:mode`。
- 待验证，不发：「群里说过的事、每个人的习惯、合适的表情和接话时机，我都能记住和把握。」

### 12. V-D 夜间复盘（影子模式）
- 状态：**仅代码在线（影子期，未跑第一晚）**
- 线上：review Worker 已部署 `REVIEW_MODE=shadow`、cron `*/5`；`review_runs=0`；第一晚验收窗口 **2026-11-15 04:00–07:30 Sydney** 还没到；影子期只记录、不改自己、不发群。
- 待验证，不发：「我每晚自己复盘哪里没做好，再慢慢改。」

## 3. 未单列（状态一句话）

- **F9 多平台读取**（小红书/雪球/微博/知乎/抖音/公众号）：**未上线**。main `41db2b5` 没有 `src/tools/` 下的 reach 工具，`grep off:reach|xueqiu|xiaohongshu` 无结果。
- **F11 群内提需求自动立项**：**未上线**。main 没有 `migrations/0070_feature_requests.sql`、没有 `feature_request` 代码；`release/F11 @405965f` 未合。
- **生图**：**仅代码在线（key 已配，未验证）**。`src/tools/generate-image.ts` 已在 main，13:50 起 Worker 有 `OPENAI_API_KEY`（7 个 secret 名），但 `image_gen_log=0`；测试通过前建议设 `off:image_gen=1`，只挡工具、不挡 owner 自检。
- **主动发言门控**：已并入第 11 条。

## 4. 线上实况（引用 `trip1/ds-live-state.md`，只读）

| 指标 | 值 | 说明 |
|---|---|---|
| `messages` max | 466 | 最后一条真人消息 02:13 Sydney；V-D 10:19 上线后 0 条 |
| `outbox` max | 268 | 264–267 是四条公告；268 是 12:00 自动查新（带链接） |
| `ds_usage` | 0 | 走 `callDsTool` 的 DeepSeek 工具 0 次；`search_web` 直连不记账 |
| `tool_calls` | 0 | F7 额外工具 0 次 |
| `schedules` | 0 | 日推、提醒都没建 |
| `kb_docs` / `episodes` / `profiles` | 0 / 0 / 0 | 知识库、情景记忆、画像都空 |
| `stickers` | 1 | 只有红方块 |
| `image_notes` / `message_images` | 1 / 0 | 看图只有 11-11 的旧测试 |
| `doc_jobs` | 0 | 且 `docread:enabled` 未设 |
| `media_notes` | 17 | B 站基本读取有真实使用；media 已加载（60s/runs=5），尚无真视频 |
| `image_gen_log` | 0 | 生图 0 次 |
| `review_runs` | 0 | 影子第一晚未跑 |
| `facts` | 47 | 记忆与纠正一直在用（不是本版新增） |

## 5. 可直接发送的正文（7 条，按序复制）

```text
release-notice:backfill-01
群里发的图片我现在能看懂了，问我图里是什么、写了什么字都行。

release-notice:backfill-02
想找群里以前说过的话，告诉我关键词或者是谁说的，我能翻出来。

release-notice:backfill-03
群里聊得多的时候，喊我总结一下，我会按结论、决定和待办分好给你。

release-notice:backfill-04
问我哪个项目最近改了什么、哪个 PR 还开着、哪个 Issue 还没关，我能直接查。

release-notice:backfill-05
想查网上的最新消息，直接问我，我会把看到的来源链接一起给你。

release-notice:backfill-06
要算数、算比例，直接丢给我，不用自己按计算器。

release-notice:backfill-07
想让我到点提醒你，或者每天固定时间总结群里消息，把时间告诉我就行。
```

发送节奏：一条一条发，间隔至少 30–60 分钟；每条发送前先 `SELECT id FROM outbox WHERE id='release-notice:backfill-0N'`，为空再 `INSERT OR IGNORE`。发完把 rowid 回填到本文件。

## 6. 三条要转给施工侧的状态

1. **读文档要开开关**：`docread:enabled=1`，否则工具永远返回「没有开启」。
2. **B 站无字幕已恢复执行器**：13:50 已加载 `com.inkboard.team-media`（60s，runs=5，exit 0），runner key 已配；还差一条真群无字幕视频验证。
3. **日推已真建**：2026-11-14 14:05 由交付员用 `scripts/create-daily-push.mjs --confirm` 创建 `digest_daily`，tz=`Australia/Sydney`、`08:00`、status=`active`，下次 2026-11-15 08:00（见 §0.1）。


## 7. 额度更正公告（A3 上线后发，覆盖 release-notice:A 里的旧说法）

```text
release-notice:quota-open
更正一下：现在大家问我 DeepSeek 额度，我都会告诉具体数字，也会说比上次多了还是少了。另外我之前说的「OpenAI 还剩 3 美元」说错了，那是我们给自己设的每日预算，不是 OpenAI 账户里的余额，账户余额我查不到，请看 OpenAI 后台。生图我还没开放，开放了再告诉大家。
```

规则：只入出站队列、不动游标；唯一去重键 release-notice:quota-open；直接发，不受补发 10 分钟间隔限制。生图线上是关的（settings off:image_gen=1），在真实验证并打开 off:image_gen 之前，任何公告都不得写「能生图」。

更新 2026-11-14 15:05：文案已加入 OpenAI 数字更正（根因：回复里的「上限/剩」是团队自设的每日预算 $3，被说成账户余额；只说已核实的这一点，不说账户余额具体数）。测试员的只读排查结论（A/openai-quota-findings.md）出来后若有别的核实结果，再按它改措辞；未核实前不得写 OpenAI 账户实际余额。

已发 2026-11-14 15:15 Sydney：outbox rowid **284**，`INSERT OR IGNORE` changes=1，15:15:13 入队；15:15 复核 `status=sent`、`msg_id=null`、`outbox_attempts.http_status=200`，同键仅 1 行。未动游标，未写其他表。

## 8. 读文档（docread）上线公告

- 状态：**已验证且已打开**
- 线上：`main 0a16658`（`pkg/A2-zipguard` 以 `--no-ff` 合并并 push）；本机 `~/.inkboard-team/docread.py` 与仓库同哈希 `733d1825…`；`settings.docread:enabled=1` 已读回；`com.inkboard.team-fetch` 已 kickstart，`state=running`。
- 证据：`/Users/yanghongming/Projects/.agent/releases/A2/docread-live.md` —— PDF/DOCX/XLSX 各一份合成文件走真实 `docread.py` 通路读出正文；公开 https 上三份真实文件走完整 `runDocJob`（下载→临时目录→解析→回传）均 `success=true`，临时目录残留 0；4 MiB 单标签炸弹 → `too_large`，51 MiB 文件 → `too_large`。群里没有文档类文件消息（`message_meta` 0 条 pdf/docx/xlsx/pptx），真实 QQ 附件链接已 400 过期，故未做 QQ 文件回放。
- 草稿：**「群里发的 PDF、Word、Excel 我现在能读了：发上来直接问要哪一页、哪个表，我按原文回答。文件只读，我不会改。」**
- 去重键：`release-notice:docread`
- 发给：真实群 `9968A083EE07797A987010E64CD421B9`
- 规则：只入出站队列、不动游标；唯一去重键 `release-notice:docread`；直接发，不受补发 10 分钟间隔限制。只说 PDF/Word/Excel，不提生图。
- 已发：outbox rowid **297**，2026-11-14 16:43:57 入队；16:47 复核 `status=sent`、`msg_id=null`、`outbox_attempts.http_status=200`；同键仅 1 行。未动游标、未写其他表。

## 9. D-emoji2（引用图 / 跨批次看图）

- 状态：**已验证且已打开**
- 线上：`main 20220a1`（PR #51 squash，基线 `3adfdf8`）；Worker `38772185-9711-45b2-9d70-3c3cac789a83`，`/health` 与 selfCard 同值；回滚 `14347135-0b0f-4c82-9f62-700940cdf043`。
- 证据：`/Users/yanghongming/Projects/.agent/releases/D-emoji/notes/deliver2.md` 与 `replay-out/emoji-replay.json` —— 本机真实消息回放 11 例：引用图片 r518（引用方独立索引 1000+）、普通图片 r480、跨批次 r502 回看 4 张；QQ 真实发送 0、线上 D1 写入 0。
- 草稿：**「补一条看图的事：引用或回复里的图片，我现在也能看懂了；隔一条消息才发的图，我也会回头找出来看。」**
- 去重键：`release-notice:emoji2`
- 发给：真实群 `9968A083EE07797A987010E64CD421B9`
- 规则：只入出站队列、不动游标；唯一去重键 `release-notice:emoji2`；直接发，不受补发 10 分钟间隔限制。线上真实引用图/跨批次触发尚未出现，公告只写本机回放已证实的能力。
- 已发：outbox rowid **326**，2026-11-14 17:56 入队；首插 `created_at` 误用秒被标 `skipped`（无 HTTP 调用），同 rowid 改毫秒恢复 `pending`；17:59 复核 `status=sent`、`outbox_attempts.http_status=200`；同键仅 1 行。未动游标、未写其他表。

## 10. E1（多平台只读读取 + 需求消费端 + 自检模型）

- 状态：**已验证且已打开**
- 线上：main `750a2e46`（PR #53；我部署的 E1 版本 `51f62418-f097-4453-9bf8-29dc7502b4e1`，当前并行部署 `97cd5696-ccb2-4c60-847e-6a71175a59df` 已包含 E1）；`settings.reach:mode=on` 已读回；本机 runner 已刷新，`reach-public.mjs` 真实读取微博热搜 10 条、知乎热榜 10 条（`evidence/E1/*.json`）；F9r 施工时公众号文章 2509 字。
- 草稿：**「现在把公众号文章、微博、知乎的链接丢给我，我能直接读正文和热榜了；要登录才看得到的，我会直说，不瞎编。」**
- 去重键：`release-notice:E1`
- 发给：真实群 `9968A083EE07797A987010E64CD421B9`
- 规则：只入出站队列、不动游标；唯一去重键 `release-notice:E1`；直接发，不受补发 10 分钟间隔限制。只说公众号/微博/知乎读取，不提小红书、抖音和 X（登录态未复验）。
- 已发：outbox rowid **377**（E1 交付时 2026-11-14 19:29 Sydney 入队，11-14 19:45 复核 `status=sent`，同键仅 1 行；本条补记，不是本次补发所发）。
