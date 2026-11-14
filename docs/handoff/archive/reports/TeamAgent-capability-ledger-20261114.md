# TeamAgent 能力对账 · 2026-11-14

> 仅只读核对。线上 D1 全部 SELECT：脚本对每条结果断言 `meta.rows_written=0`、`meta.changes=0`；结束时复核 `messages=450`（max rowid 450）、`settings.chat_cursor=450`、`outbox=243`（242 sent / 1 failed）均未变。**未写线上 D1，未往 QQ 群发任何消息。**
>
> 时间：表内为 D1 原始北京时间（UTC+8）；悉尼时间 = 表内 +3 小时。当前 2026-11-14 00:56 悉尼 = 21:56 北京。
>
> 记号：`msg#` = `messages.rowid`；`outbox#` = `outbox.rowid`。代码基线：线上 `/health` release `8762214`，与 `repo_state` head 一致；各包分支单独标注。Worker secret 只列名字，不读值。

## 0. 先看结论

1. **13 条里 A=1、B=10、C=2**（原#5 的“表情包发送”部分另算 C）。唯一按“线上真实可用”能判 A 的是联网搜索；其余多数是“代码/分支有，线上没生效或不可靠”。若按“代码 + 本地回放”放宽，第 4、11 条可算 A−，但线上没有生产证据，不升 A。
2. **用户这次发火的直接触发不是“没写代码”，是三个最基本动作同时断了**：
   - 21:17 问“读一下最新的陪玩店那个项目”（`msg#436`），21:18 回复“没拿到 repo_changes / repo_commit 的返回”（`outbox#242`）；那一轮 `stage_timings` 只有 `participation` + `voice`，**没有任何 tool 调用**。
   - 21:40 / 21:43 报“登记在册 5 个仓库”（`outbox#243/244`），实际 GitHub 组织有 **6 个**：`OmnixSI/peiwan-club-saas` 于 2026-11-13 20:53 北京创建、21:50 最后推送；`config/team.json` 与 `~/.inkboard-team/config.json` 都只有 5 个，且“陪玩店”别名指向旧的 `peiwan-store-platform-blueprint`（最后推送 11-06）。
   - 20:49 被 @“说话”（`msg#428`），直到 21:11 才回（`outbox#239`），**22 分钟静默**；根因是全局 `settings.chat_cursor` 被回放推高，真实消息被当成已处理跳过。
3. **修复已经在路上，但都没上线**：F5c `f6bcaba`（仓库问题强制走 repo 工具、预算下限 16、失败原样转述，00:52 提交）、F5b `f987e28`（别名/失败解释，00:50）、F4 `a6641d2`（`chat_cursor` 按群隔离，00:15）。三者都在包分支，main `8762214` 没有；部署前用户仍会复现。
4. **第二类“最基本但没有”**：定时日推/提醒（t.o.o. 01:11 要求，bot 01:12 答应，06:31 漏推，06:32 认账“定时任务没真落地”）、看图（11-12 13:06、11-13 07:50 两次失败）、文件交付（11-11 CSV 生成后 `outbox#19 failed`，用户没收到）、撤回/改已发消息（`outbox#78` 自己说“撤回键不在我手上”）。
5. **仓库读取的真实边界**：`repo_changes` / `repo_commit` / `repo_file` 是**只读**工具，支持任意 `owner/repo` + `GITHUB_TOKEN`；但 `get_project` 的 enum 只有 config 里 5 个仓库；本地 `~/.inkboard-team/repos` 只 clone 了 TeamAgent；`repo_commits` 只有 TeamAgent 158 条，其余 4 个 0 条。所以“有运行环境、能看每个项目每次修改”目前**只对 TeamAgent 成立**；`outbox#241` 说“能改文件、提变更”是错误声明（`outbox#171` 自己说“仓库我只读”）。

---

## 1. 13 条逐条对账（按用户痛感排序）

| 痛感序 | 原# | 要求（用户原话/台账） | 状态 | 线上现状与证据（rowid） | 卡点 | 一句话修复 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | 1 | bot 能看到仓库每次修改和具体代码（有运行环境，不能只在云端调用）；问“有哪些新提交/改动怎么样”必须答得上 | **B** | 11-12 17:47 能读 WhalePartner：main `a1cfc82`、PR #154–#161 开着（`outbox#190/191`）→ 工具可用。但 11-11 22:45 也出现“大肥鱼仓库我读取失败”（`outbox#176`）；11-13 21:17 问“最新的陪玩店”（`msg#436`）→ 21:18“没拿到 repo_changes / repo_commit 的返回”（`outbox#242`）；`stage_timings` 该轮只有 `participation` + `voice`。21:40/21:43 报 5 个仓库（`outbox#243/244`），实际 6 个：`peiwan-club-saas` 20:53 创建、21:50 推送。`repo_state`/`repo_commits` 只有 TeamAgent（158 条）；`~/.inkboard-team/repos` 只有 TeamAgent。 | ① 21:17 那轮 D1 预算低，工具被 `src/semantic.ts:880` 的 `left(e) >= COST.turn*2+COST.tool+COST.tail` 关掉；F5c `f6bcaba` 已改，未合并。② 新仓库不在 `config/team.json`/本地 config，别名“陪玩店”指旧 blueprint。③ 没有 org repo 列表工具，数量只能读静态配置。 | 把 `peiwan-club-saas` 加进两份 config，别名指向新仓库；加 `GET /orgs/OmnixSI/repos` 的只读工具；合并 F5b/F5c。 | **P0** |
| 2 | 8 | 群里平时安静，只在真正干活/有新想法时说话；插话时机要对；要知道谁在跟谁说话 | **B** | participation 规则与 115 条 `chat_decisions` 大量 `stop` 理由正确（如 15:37–15:40 连续判定两人对话不插话）。但 15:41:47 把 Souvereign 对 t.o.o. 说的“我之前发的…”（`msg#413`）接成对自己说，`outbox#226` 接单；15:42:45 才认错“接错人了”（`outbox#229`）。21:27 卡特龙原话“他都无法判断到底我再跟谁说话”（`msg#281`）。20:49 被 @“说话”（`msg#428`）后 22 分钟无回复，21:11 才回（`outbox#239`）。 | 对象判定/身份映射；全局 `chat_cursor`（`src/worker.ts:487/672`）被回放推高；F4 `a6641d2` 未合并。 | 部署 `chat_cursor` 按群隔离；@ 必回硬保证；把 `msg#413` 这类“对别人说”做成回归场景。 | **P0/P1** |
| 3 | 4 | 识别 B 站小程序卡片和链接，看到视频内容（无 CC 字幕也能总结：本机 X-ASR 转写 + 画面关键帧） | **B** | `bili.media.enabled=true`；V1/V2/V5 本地回放通过（951s 中文无 CC、224s 英文、728MB/19025 字、`residue=0`；`TeamAgent-bili-media-acceptance-20261113/acceptance.json`）。但 06:37/06:39/06:42/06:47 四条真实视频请求全部 `jobs.kind=media` failed（`outbox#212/213/215`）；15:45 `b23.tv/F1DkQFC` 只拿到标题（`outbox#231/232`；“你真是个废物 b 站短链接都读不了”`msg#419`）。C-2 卡片解析 `81bbbac` 在 `release/V-C`，未部署；画面关键帧没有代码（`runner/media.mjs:65` `-vn`，无 frames）。 | media 开关 23:14 才上线，失败发生在之前；C-2/短链修复未部署；无画面抽帧。 | 部署 C-2，真群跑一条无 CC 中文视频；补短链回归；画面关键帧要么做，要么在说明里删掉。 | **P1** |
| 4 | 5 | 能看图、能用表情包 | **B（看图）/ C（表情包发送）** | `vision.enabled=true`、`daily_cap=300`，但 `src/vision.ts:349` 走 `model("vision")` → `src/runtime.ts:68` 只有 `api.deepseek.com`；模型 key 只有 `DEEPSEEK_API_KEY`，没有视觉 key。11-11 18:08 面试软件 logo 原图拿不到、二进制没法提交（`outbox#95/96`）；11-12 13:06 问“你能看到我的表情吗”（`msg#305`）→ `outbox#183`“看不到，图片（未查看）”；11-13 07:50 图片（`msg#383/384`）→ `outbox#222`“图没抓到，请求直接被拒了”。`image_notes` 只有 1 条（红方块测试图）；11 条带附件的消息。`stickers.send=false`（`config/team.json:115`），`stickers` 表只有 1 张红方块。 | DeepSeek 文本 API 不接受图片；无 OPENAI/多模态 key；表情发送关闭、库空；QQ face 解码 `c9cb31c` 在 `pkg/V-A-A2` 未合并。 | 接真实视觉通道（或转多模态员）；先用一条真实群图验收；表情包要么打开 send 并收集，要么明确不做。 | **P1（看图）/ P2（表情）** |
| 5 | 9 | 工作台：捕获的待办拆出来，每条带初步方案和原话，本地 AI 能开工；这个开发平台要真用在他项目开发里 | **B** | `tasks` 7 条：4 条从 QQ 创建、带 `source_id` 和完整方案（如 WhalePartner 验收清单）；2 条 `ready_for_review`。07:27“工作台UI修改指导…发布到工作台”（`msg#382`）→ `outbox#221`“没法声称已发布到工作台”，任务未创建；11-12 04:54Z 之后无新任务。`ai_tokens=3`、`sessions=12`，平台有人用，但没形成持续开发流。 | `create_task` 靠模型自愿调用；小红书正文抓不到就整单放弃，没建“待补正文”的草稿任务。 | @bot 明确交办即建 proposal（原话+初步方案+待补项）；07:27 这条补建。 | **P1** |
| 6 | 3 | 能自己指挥子代理干活 | **C** | `runner/subagent.py` 在 main，但 `src/worker.ts` 没有 `/api/runner/subagent` 路由、没有 `spawn_agent` 工具（grep src 全无）；B-1t 26 条 D 测试全红；B-1 `fe6ef73` 只有 18/26，`READER_VERIFIED=False`。 | Worker job/tool/route 未接；B-3/B-4w 未完成。 | 合并 B-1，补 B-3/B-4w，D-1..D-26 全绿后上线。 | **P1** |
| 7 | 2 | 不要动不动说“不知道/做不了”，尽量扩大能力边界 | **B** | 部署代码有 `toolFailure.next_action`；C2 能力层 `28a2d66`（capabilityCard、15 种 ErrorKind、eval Q1–Q10）已验收 763/763，但只在 `pkg/V-B-B2`，main 没有。线上 243 条回复里仍有 12 条含“拿不到/抓不到/没找到”（`outbox#212/213/221/222/231/232/235/237` 等）；21:18 原话“没拿到返回”。 | C2 未合并；真正的缺口是图/B站/X 工具失败，不是措辞。 | 先修工具，再合并 B-2；prompt 加“工具失败原样转述 error_kind/next_action”。 | **P1** |
| 8 | 11 | 语音转文字只用本机 X-ASR；视频只下载音频；用完清理，不占内存 | **B** | X-ASR venv 53MB、`--check=0`；launchd `com.inkboard.team-media` `StartInterval=60`、`Nice=10`、`runs=25`、`last exit=0`；V1/V2/V5 回放通过，`residue=0`、峰值 728MB < 1300MB；`runner/media.mjs:65` `-vn` 只下音频。V3/V4/V-CC 失败/P2；`media.log` 0 字节，23:14 开关后没有一条真实群视频。 | 没有生产 E2E；V4 已删除/付费视频未测；B 站登录态 risk。 | 真群发一条无 CC 中文视频，跑完查 `media-tmp`/`residue`/进程；补 V4/V-CC。 | **P1** |
| 9 | 13 | 回复要聪明，不能像现在这样“不聪明” | **B** | 好：`outbox#201` 日报具体到 job/PR 编号；`outbox#230` 补头衔；`outbox#213` 诚实说明无字幕。坏：`outbox#241` 说“能改文件、提变更”（repo tools 只读，`outbox#171` 自己说“仓库我只读”，`outbox#95/96` 又说“二进制没法提交”），2 分 18 秒后 `outbox#242` 又说没拿到返回；`outbox#243/244` 5 个仓库 vs 实际 6 个；`outbox#212` 把 `b23.tv/MV29F7r` 当成截断的 BV；`outbox#226` 接错人。 | 无质量门禁/真实回放评测；能力声明不受工具表约束。 | 上线能力卡（B-2）+ 真实群回放 eval；禁止声明未提供的工具。 | **P1** |
| 10 | 7 | 能接推特（用本机登录态） | **C** | `auth:x` `state=ok`（13:39Z），但 `login-flow:x` `phase=failed`；没有 `read_x`/timeline 工具；`readTweet` 只读单条公开推（fxtwitter/syndication/oembed），不用本机登录态。06:33“马斯克最新 x 内容和回复”→ `outbox#208`“在查”后无结果；15:41“黄仁勋辞职 x 反应”→ `outbox#230` 是媒体汇总，不是 X 原帖。 | 缺 timeline/search reader；本机浏览器登录流程失败。 | 加 `read_x`（时间线/单推/回复），用本机登录态；先让用户重登一次。 | **P1/P2** |
| 11 | 12 | 每晚反思由独立子代理评判、自我迭代、整改项反馈开发版 | **B** | `dreams` 6 条，最后 2026-11-12T17:33Z（11-13 04:33 悉尼）；11-13 的 dream 已抓到“定时日报/昨日推送”要求。但 `analyse` 用同一模型，不是独立子代理；dream 不创建任务/issue；`facts` 最后 11-13 01:12 后无新增。 | 独立评判和整改项落开发版都没接。 | dream → 独立 critic（子代理）→ 生成 proposal 任务到工作台；跟踪验收。 | **P2** |
| 12 | 10 | 每次大版本上线后 bot 发一句“这次自己新加了什么” | **B** | 部署 main 没有 `src/release-note.ts`；A-4 `fa44a42`“per-group one-time release note on passive replies”在 `pkg/V-A-A4`，未并入 `release/V-A`（`53a9aeb` 不含它）。线上只有 15:44 首次接入的“团队开发台已上线”（`outbox#1`），之后没有版本说明。 | A-4 未合并/未部署；`docs/releases/V-A.md` 需更新。 | 合并 A-4，部署后每个大版本每群附一次；`verify-release` 检查。 | **P2** |
| 13 | 6 | 能联网搜最新新闻 | **A** | `search_web` + Jina；scout 5 次、`discoveries` 12 条（如 11-13 16:00“用稳定 workId 和租约防止队列重复发送”）；真实回答有来源（`outbox#167` 梁文锋、`outbox#168` MaiBot、`outbox#230` 媒体汇总）。18:14/18:40“没找到成规模帖子”是如实说明，不是没搜。 | 搜索覆盖/新鲜度有限；没有第二来源。 | 加一个搜索源/时间过滤；保留“查不到就说查不到”。 | **P2** |

**状态口径**：A = 线上真实可用且见过真实成功证据；B = 代码/分支有，线上没生效或不可靠；C = 没有可用的线上路径（哪怕本机/分支有零件）。原#5 的“表情包发送”是 C，单独在表 2/3 展开。

---

## 2. 线上补全：用户/群友提过、但不在 13 条台账里的要求

| # | 来源与原话（rowid） | 要求 | 状态 | 证据 | 卡点 | 修复 | 优先级 |
|---|---|---|---|---|---|---|---|
| A1 | t.o.o. `msg#348` 01:08“把今天群里的对话…总结一个日报”；`msg#351` 01:11“悉尼时间每天早上8点在群里推送昨日总结，一定要精简”；`msg#355` 06:31“我的日报呢？” | 每天 8:00 悉尼推昨日总结 + 周报（周日起算） | **C** | bot 01:12 答应“明早 8:00 出第一份”（`outbox#203/204`）；06:32 认账“定时任务没真落地”（`outbox#206/207`）。`src/worker.ts:1100` 的 `scheduled()` 只有 scout + dream，没有用户日程表；`facts` 只存了“日报需求/周起始日”，没存“每天 8:00 推送”的可执行项。 | 没有 schedules 表/定时任务；承诺只停在对话。 | 新增 `schedules` 表 + 每日 08:00 Sydney 任务 + 周报；漏跑要在群里可见；支持 `@bot 每天8点…`。 | **P0** |
| A2 | Souvereign `msg#129` 18:05“你每次干活的时候，给人说一下，说你正在干，你不要装死”；`msg#141` 18:15“以后去做耗时任务的时候能不能先回答一下”；`msg#428` 20:49“说话” | 被 @/被催必须回；长任务先回“在做” | **B** | 74 条直接 @bot，67 条有回复或 tool（`chat_decisions` 30 条 `mentioned=1` 全部 reply/tool，0 条 stop）。但 `msg#428` 20:49 → `outbox#239` 21:11，22 分钟；`msg#424` 18:40“你人呢 查到哪里去了” → 18:40:35 才回（`outbox#237`）。 | `chat_cursor` 全局游标；长任务只在开始/结束说话，没有中间回执。 | 部署 F4；@ 时决策 `stop` 直接改 `reply`；任务超过 60 秒发一次“在做”。 | **P0** |
| A3 | Souvereign `msg#34` 11-11 16:37“把这些示例数据整理成 UTF-8 CSV 文件发回群里” | 生成文件并真的发回群 | **B** | 16:37:40 `jobs.kind=media` done（payload 标题“项目状态示例数据 CSV”）；16:37:37 `outbox#18`“生成好直接发群里”；16:40:41 `outbox#19` **failed**；`deliveries` 表 **0 行**；没有重试记录。用户没收到 CSV。 | 附件交付记录为空；正文说“已生成”但文件没发出；失败无重试/无提示。 | `files.length=0` 时禁止说“已生成文件”；失败进工作台“待核对”并重试一次；验收重放 16:37。 | **P1** |
| A4 | 卡特龙 `msg#97` 11-11 17:15“你赶紧把它回复改了” | 改/撤回已发消息 | **C** | `outbox#78`“改不了，发出去的话泼出去的水，撤回键又不在我手上”；全仓 grep 无 recall/withdraw（只有 memory recall）。 | 没有 QQ 撤回/编辑接口封装。 | 接官方撤回（如 SDK 支持）或发一条“更正上条”；至少给用户明确说明。 | **P2** |
| A5 | 卡特龙 `msg#286` 11-11 21:29“你先闭嘴10分钟，bot 设个定时任务十分钟后再说话” | 用户可设定的定时闭嘴/免打扰 | **C** | 没有用户日程表；`rhythm` 只有 5–45 秒 `wait`；21:29 后没有 outbox 记录（不是定时器，只是没被触发）。 | 没有 mute 状态/定时器。 | 加 `settings` 级 `mute_until` + `scheduled` 检查；@ 时是否豁免要写清。 | **P2** |
| A6 | 卡特龙 `msg#337` 11-12 17:46“查下你的api额度” | 查 API 额度/用量 | **C** | `outbox#189`“额度我这儿查不到，没有能读 token/账单的工具”；`model_usage` 只记 token/耗时，不查余额。 | 没有 provider 余额接口。 | 加只读 usage/余额命令；没有 key 权限就明说。 | **P2** |
| A7 | Souvereign `msg#415` 15:42“这个没和你说，我是和 t.o.o. 说的”；卡特龙 `msg#281` 21:27“无法判断到底我再跟谁说话” | 认清谁在跟谁说话，不接错人 | **B** | `outbox#226` 接错 `msg#413`，`outbox#229` 认错；其余 115 条 `chat_decisions` 大量正确 `stop`（如 15:37–15:40 两人对话）。 | 对象判定不稳；QQ 身份与登录名未打通。 | 加 `to` 字段约束 + 真实回放“对别人说”场景；见 A9。 | **P1** |
| A8 | 卡特龙 `msg#437` 21:40“公司里面现在有几个仓库”；`msg#438` 21:43“应该还有一个新的仓库才对” | 动态发现组织仓库，不能只读登记表 | **C** | `outbox#243/244` 报 5 个；`gh repo list OmnixSI` 实际 6 个，`peiwan-club-saas` 20:53 创建、21:50 推送；`config/team.json`/本地 config 都只有 5 个；没有 org list 工具。 | 静态登记表；“陪玩店”别名指旧 blueprint。 | 同上表 1 第 1 条：加新仓库 + org list + 别名修正。 | **P0** |
| A9 | 卡特龙 `msg#381/382` 07:27 小红书“工作台UI修改指导…发布到工作台作为一个新任务” | 小红书链接解析 + 发布任务 | **C** | `outbox#221` 只拿到标题和短链 `xhslink.cn/o/79Ta4C6dKMS`，正文/图片没抓到，任务未创建；没有小红书解析器。 | 缺 xhs 解析；缺“内容不全也先建草稿任务”。 | 接 xhs 正文/图片；抓不到时建 `proposal`，detail 写“待补正文”。 | **P2** |
| A10 | Souvereign `msg#394/396` 15:35–15:37“记账报销额度…我加10” | 记账，@bot 加/减并回新余额 | **B** | `outbox#223/224/225` 当场算对（¥360/¥50/¥90 → ¥370+50+90=510）；但 `facts` 表 0 条含 360/510/报销/记账，只有对话，没有持久账本。 | 没有 ledger 表；重启/隔天可能忘。 | 加 `ledger` 表（人/金额/已充/待充/来源消息），每次变更写一行。 | **P2** |
| A11 | t.o.o. `msg#348` 01:08“把今天群里的对话和讨论的内容给我总结一个日报” | 手动群聊日报 | **A** | `outbox#201` 5 条要点，带 job/PR 编号和“我被点名”改进项；内容与当天消息对得上。 | 只在被叫时出；没有存档（用户没点头）。 | 保留；接 A1 的定时版。 | **P2** |
| A12 | 全群 | 引用回复 | **A** | `src/quote.ts`；`outbox_meta` 3 条 `REFIDX_*`（`outbox#206/208/239`）；`message_refs` 229 条。 | 只对 member 引用生效，用得少。 | 保持；在“被引用续问”场景加回归。 | **P2** |
| A13 | 全群 | CI 失败推送 | **A** | `outbox#15/16` 11-11 16:31 报 NextThought macOS/selftest failure；`ci_incidents` 9 条；`ci_notifications_v2=1`。 | 只报有证据的失败，已做去重。 | 保持；别把旧失败反复播报。 | **P2** |
| A14 | Souvereign 11-11 16:24“监控所有项目、最新科技动态和项目仓库” | 主动技术侦察 | **A**（工作台）/ **B**（群可见） | `scout` 5 次、`discoveries` 12 条（如 workId/租约、addressee 判定）；但群里没有主动播报，只进工作台。 | 发现不落群；用户不一定看工作台。 | 可选：每天一条“值得看”摘要；默认安静。 | **P2** |
| A15 | 卡特龙 `msg#287` 11-11 22:44“去 x，ins 上调查当下流行趋势，以我们会议软件和大肥鱼项目的完成度做参考” | 用 X/Ins 趋势做变现方向调研 | **B** | `outbox#175`“后台已经在扒”；`outbox#176`“X/Ins 的登录态我爬不了，下面这些是公开检索到的市场数据…大肥鱼仓库我读取失败”。给了公开数据，但不是 X/Ins 实时趋势，也没用上大肥鱼完成度。 | X/Ins 登录态读不了；大肥鱼仓库读取失败；没有 timeline reader。 | 先修 X/Ins 登录态读取 + 仓库读取，再重跑这条调研；没有登录态就明说“公开数据”。 | **P1** |
| A16 | Souvereign `msg#133` 11-11 18:08“把这个作为我们面试软件项目的新 logo，你直接帮我改进去” | 接收图片附件并改仓库 | **B** | `outbox#93` 说预览图看到了；`outbox#95` 又说“logo 只在 QQ 附件里，我拿不到原图文件，二进制资源也没法提交”；`outbox#96` 要正方形 PNG/矢量图。原图没拿到，仓库也没改。 | 附件下载/图片落盘没打通；repo tools 只读不能提交二进制。 | 先把 QQ 附件原图落到本机并确认；改仓库走开发任务，不假装能直接提交。 | **P2** |

**已当场完成的一次性请求（不单列）**：11-11 16:47 把 5 个 ID 贴在对话里（`outbox#22`）；17:59 查 MausBot 角色分工（`outbox#94`）；11-12 13:08 总结昨天+今天（`outbox#184`，先声明记录不全）；17:47 看大肥鱼现状（`outbox#190`）；19:54 AI 中转站合规（`outbox#201/206` 有结论）。

---

## 3. 最基本却没有的功能候选

| 功能 | 状态 | 证据 | 缺口 | 建议 | 优先级 |
|---|---|---|---|---|---|
| 被 @ 必回 | **B** | 74 条直接 @，67 条有回复/tool；30 条 `mentioned=1` 决策全部 reply/tool、0 stop；但 `msg#428` 20:49 → `outbox#239` 21:11 22 分钟。 | 全局 `chat_cursor`；没有“@ 必回”硬闸门。 | 部署 F4；`mentioned=1` 时禁止 `stop`；60 秒未完成先发“在做”。 | **P0** |
| 引用回复 | **A** | `src/quote.ts`；3 条 `REFIDX`。 | 用得少，但能用。 | 保持，补回归。 | P2 |
| 撤回 / 改已发消息 | **C** | `outbox#78`“撤回键不在我手上”；无 recall 代码。 | 没有 QQ 撤回封装。 | 接官方撤回或发更正；别让用户等“编辑权限”。 | P2 |
| 定时提醒 / 日推 | **C** | `outbox#203/204` 答应；`outbox#206` 认账没落地；`scheduled()` 只有 scout/dream。 | 没有用户日程表。 | `schedules` 表 + 每日/每周任务 + 漏跑可见。 | **P0** |
| 读文件 / 附件 | **B** | 11 条带附件消息；`image_notes` 1 条；`deliveries` 0；CSV `outbox#19 failed`；`utility.failed` 5 次。 | 图片视觉通道坏；文件交付无记录；重活超时。 | 修视觉；交付记录/重试；文件任务先回执。 | **P1** |
| 群成员认识 / 身份映射 | **B** | `member_names` 3 人 + Bot；`members` 有 `qq:Souvereign` 与 `name:hongming/jinxiang/jinyi`，**没有映射**；`role` 全 `member`；`/方案` 任务 assignee `jinxiang`。 | QQ 身份 ↔ 登录名/权限没打通。 | 加 `member_links(qq_id, name, role)`；@ 时用映射。 | **P1** |
| 报错说清原因 + 下一步 | **A** | `toolFailure.next_action`；`outbox#212/231/235` 给了“补完整链接/截图/题面”的下一步；`outbox#242` 没编造。 | 工具失败时措辞有时像“没拿到”，但方向对。 | 保留；配合 B-2 的 `error_kind` 原样转述。 | P2 |
| 状态查询 | **B** | `get_work_status` 11-12 13:03 列出 5 个任务（`outbox#182`）；但 API 额度 `outbox#189` 查不到；仓库数量 `outbox#243/244` 静态。 | 任务状态可用；额度/仓库列表没有工具。 | 加 usage + org repo 两个只读查询。 | **P1** |
| 新仓库发现 / 项目动态 | **C** | `gh` 6 个 vs config 5 个；`peiwan-club-saas` 未登记；`repo_state` 只有 TeamAgent。 | 没有 org 列表；本地只 clone 一个。 | 加 org list + 定期刷新 + 新仓库提醒。 | **P0** |
| 文件送达回执 / 重试 | **B** | `outbox#19 failed`；`outbox_attempts` 无该条；`deliveries` 0；`file-deliveries` 3 个旧 `.sent`。 | 新交付链路没有成功记录；失败不重试。 | 交付表 + 失败重试 + 工作台可见。 | **P1** |
| 长任务进度 | **B** | `outbox#181/208` 有“后台处理/在查”；`msg#424` 18:40 仍“你人呢”；06:33 马斯克无结果。 | 只有开始/结束，没有中间进度。 | 任务心跳 + 60 秒回执 + 完成/失败都回原消息。 | **P1** |
| 群成员权限分级 | **C** | `members.role` 全 `member`；UI 只有 `owner` 才看管理；没有“谁能派活/谁能改仓库”的规则。 | 没接角色；卡特龙 20:57 说“bot 就是传话筒，不能给实际权限”。 | 加 owner/member 两级 + 工具白名单；默认只读。 | **P2** |
| 定时闭嘴 / 免打扰 | **C** | 无 `mute_until`；`rhythm.wait` 只 5–45 秒。 | 没有用户级静音。 | 加 `mute_until`，@ 是否豁免写清。 | P2 |
| 表情包发送 | **C** | `stickers.send=false`；`stickers` 表 1 张红方块；`off:sticker_collect=0`。 | 发送关闭、库空。 | 要么打开并收集到 ≥2 人来源，要么明说不发。 | P2 |

---

## 4. 最该立刻修的前 8 项

| # | 修什么 | 具体动作 | 证据/验收 | 建议负责人 |
|---|---|---|---|---|
| 1 | **新仓库发现 + 陪玩店别名** | `config/team.json` 和 `~/.inkboard-team/config.json` 加 `OmnixSI/peiwan-club-saas`；把“陪玩店/最新的陪玩店”指向它，旧的 `peiwan-store-platform-blueprint` 改叫“陪玩店蓝图”；加 `GET /orgs/OmnixSI/repos` 只读工具（或每日同步）。 | 重放 `msg#436`：回答带 `9fa6a12` / 最新提交；重放 `msg#437/438`：回答 6 个仓库并列出 `peiwan-club-saas`。 | 工程师 |
| 2 | **部署 F5b/F5c 仓库工具修复** | 合并 `pkg/fast-lane-F5c` `f6bcaba`（repo activity 强制工具、预算下限 16、失败原样转述）+ `pkg/fast-lane-F5b` `f987e28`/`cb25916`（别名、ambiguous、失败解释）；跑 `npm test`；部署。 | 本地回放 `msg#436`：`stage_timings` 出现 `tool`，`repo_changes` 被调用；失败时回复含 `error_kind` + `next_action`，不再说“没拿到返回”。 | 程序员 + 交付员 |
| 3 | **部署 F4 `chat_cursor` 按群隔离 + @ 必回** | 合并 `pkg/fast-lane-F4` `a6641d2`；`scheduled`/inbound 用 `chat_cursor:<group_id>`；`mentioned=1` 的决策禁止 `stop`；60 秒未完成先发“在做”。 | 两个群交错回放，互不推高游标；`msg#428` 重放 60 秒内回复；`chat_cursor` 不再是全局单键。 | 工程师 + 交付员 |
| 4 | **定时日推/周报/提醒** | 新增 `schedules` 表（群、类型、cron/时间、时区、启停、last_run）；`scheduled()` 每日 08:00 Sydney 出昨日总结，周日周报；支持 `@bot 每天8点…`、`闭嘴10分钟`；漏跑在群/工作台可见。 | 连续两天 08:00 有 `outbox`；`msg#351` 的要求被满足；06:31 那种漏推不再发生。 | 工程师 |
| 5 | **看图通道** | 把 `vision` 从 DeepSeek 文本 API 切到真正的多模态 provider（OpenAI/多模态员），或明确“本机没有视觉通道，不接图”；保留 300 张/天预算和失败原因。 | 重放 `msg#305`（QQ face）和 `msg#383/384`（图片）：`image_notes` 有描述，回复不再“看不到/请求被拒”。 | 工程师 + 多模态员 |
| 6 | **B 站短链/卡片 + 真群验收** | 合并/部署 `release/V-C` 的 C-2 `81bbbac`（卡片 BV 解析）和 C-6；用一条真实群里的无 CC 中文视频跑完整 `bili_media`：确认语→转写→回答→`media-tmp` 空/`residue=0`；补 V4（已删除/付费）和 V-CC（重登 B 站）。 | `jobs.kind=media` done；`outbox` 有“根据音轨转写（没有 CC 字幕）”+ 覆盖时间；`outbox#231/232` 的短链失败不再复现。 | 前端工程师 + 测试员 |
| 7 | **文件交付失败可见 + 重试** | `deliveries` 表记录每次附件；`outbox` 失败进工作台“待核对”；失败重试一次；`files.length=0` 时禁止说“已生成文件”。 | 重放 11-11 16:37 CSV：`deliveries` 有 `sent`，用户真收到；失败时回复明确“附件未送达，已保留”。 | 工程师 |
| 8 | **工作台任务捕获** | @bot 明确交办（如“发布到工作台”）即建 `proposal`，`source_id` 存原话，`detail` 用模板（目标/背景/初步方案/待补/验收）；内容抓不到也建“待补正文”，不要整单放弃。 | 重放 `msg#382`：任务存在、detail 有原话和待补；`msg#436` 的能力回答不再虚报“能改文件”。 | 工程师 + 前端工程师 |

**紧接着第 9–13**：B-1 子代理接线（`fe6ef73` + B-3/B-4w，D 测试全绿）；B-2 能力层合并（`28a2d66`）；A-4 版本说明合并（`fa44a42`）；`read_x` 时间线；表情包发送开关/收集。这些是 P1/P2，不阻塞前 8 项。

---

## 5. 证据索引

### 5.1 关键消息与回复

| 时间（北京） | 用户消息 | bot 回复 | 说明 |
|---|---|---|---|
| 11-13 01:08 / 01:11 | `msg#348` 要日报；`msg#351` 要每天 8:00 推送 | `outbox#201` 日报；`outbox#203/204` 答应 | 手动日报 A；定时 C |
| 11-13 06:31 | `msg#355`“我的日报呢？” | `outbox#206/207` 认账“定时任务没真落地” | 漏推证据 |
| 11-13 06:37/06:39/06:42/06:47 | `msg#368/374/375/378` 四条 B 站视频 | `outbox#212/213/215` | `jobs.kind=media` 全 failed |
| 11-13 07:27 | `msg#382` 小红书 + 发布工作台 | `outbox#221` 只拿到标题，未建任务 | 工作台捕获失败 |
| 11-13 07:47/07:50 | `msg#383/384` 图片 + “真是服” | `outbox#222`“图没抓到，请求直接被拒了” | 看图失败 |
| 11-12 13:06 | `msg#305`“你能看到我的表情吗” | `outbox#183`“看不到，图片（未查看）” | QQ face/图失败 |
| 11-13 15:41 | `msg#413`“我之前发的…”（对 t.o.o.） | `outbox#226` 接错；`outbox#229` 认错 | 对象判定失败 |
| 11-13 15:42 | `msg#415`“这个没和你说，我是和 t.o.o. 说的” | `outbox#229` | 同上 |
| 11-13 15:45/15:46 | `msg#417` b23 短链；`msg#419`“你真是个废物” | `outbox#231/232` 只拿到标题 | 短链/卡片失败 |
| 11-13 18:40 | `msg#424`“你人呢 查到哪里去了” | `outbox#237` 18:40:35 才回 | 长任务无中间回执 |
| 11-13 20:49 | `msg#428`“说话” | `outbox#239` 21:11:15 | 22 分钟静默 |
| 11-13 21:12/21:17 | `msg#434` 能力清单；`msg#436` 陪玩店 | `outbox#241` 虚报“能改文件”；`outbox#242`“没拿到返回” | 自相矛盾 + 未调工具 |
| 11-13 21:40/21:43 | `msg#437/438` 仓库数量/新仓库 | `outbox#243/244` 报 5 个 | 实际 6 个 |
| 11-11 16:37 | `msg#34` CSV 发群 | `outbox#18` ack；`outbox#19` failed | 文件未送达 |
| 11-11 17:15 | `msg#97`“把回复改了” | `outbox#78`“撤回键不在我手上” | 无撤回 |
| 11-11 21:29 | `msg#286`“闭嘴10分钟定时” | 21:29–21:40 无 outbox | 只是沉默，不是定时 |
| 11-12 17:46 | `msg#337`“查下你的api额度” | `outbox#189`“没有能读 token/账单的工具” | 额度查询 C |
| 11-13 15:35–15:37 | `msg#394/396` 记账 | `outbox#223/224/225` 算对 | 未落库 |

### 5.2 运行时/配置核对

| 项 | 事实 | 来源 |
|---|---|---|
| 线上 release | `8762214`；`/health` 与 `repo_state.head` 一致 | `GET /health`；D1 `repo_state` |
| Worker secrets（仅名字） | `ADMIN_TOKEN`、`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`QQ_APP_ID`、`QQ_APP_SECRET`、`RUNNER_TOKEN` | Cloudflare Worker secrets API |
| 没有的 key | 没有 `OPENAI_API_KEY`/视觉专用 key；所有模型调用走 `api.deepseek.com` | secret 名单；`src/runtime.ts:68` |
| 本地仓库 | `~/.inkboard-team/repos` 只有 `TeamAgent`；`repo_state`/`repo_commits` 只有 TeamAgent（158 条） | 本机目录；D1 |
| 组织仓库 | 6 个：TeamAgent、peiwan-club-saas、WhalePartner、NextThought、NextThought-Website、peiwan-store-platform-blueprint | `gh repo list OmnixSI --limit 30`（只读） |
| 新仓库 | `peiwan-club-saas` private，`created_at=2026-11-13T12:53:25Z`，`pushed_at=13:50:53Z`，默认 `main`，最新 `9fa6a12` | `gh api repos/OmnixSI/peiwan-club-saas`（只读） |
| 配置仓库 | 5 个，缺 `peiwan-club-saas`；别名“陪玩店”指 `peiwan-store-platform-blueprint` | `config/team.json:49-55,71`；本地 config |
| launchd | 核对时：`team-qq` running（pid 11571）；`team-fetch` running（13183）；`team-runner` running（23954）；`team-media` `StartInterval=60`、`runs=25`、`last exit=0`、`state=not running`（间隔任务，正常） | `launchctl print` |
| 媒体日志 | `media.log` 0 字节；`media-error.log` 84 字节（“已清理，残留 0”×4） | 本机日志 |
| D1 计数 | `messages=450`；`chat_cursor=450`；`outbox=243`（242 sent/1 failed）；`tasks=7`；`deliveries=0`；`image_notes=1`；`stickers=1`；`dreams=6`；`discoveries=12`；`ai_tokens=3`；`sessions=12` | D1 只读 |
| 分支状态 | main `8762214`；`release/V-C` `d26078b`（C-2/C-5r/C-6，未合并）；`release/fast-hardening` `35b3efa`（F2a-d，未合并）；`pkg/V-B-B1` `fe6ef73`（子代理核心，未合并）；`pkg/V-A-A4` `fa44a42`（版本说明，未合并）；`pkg/fast-lane-F4` `a6641d2`（chat_cursor，00:15）；`pkg/fast-lane-F5b` `f987e28`/`cb25916`（00:50）；`pkg/fast-lane-F5c` `f6bcaba`（00:52） | `git log`/`git branch --contains` |

### 5.3 零写入审计

```
SELECT (SELECT COUNT(*) FROM messages) messages,
       (SELECT MAX(rowid) FROM messages) max_msg_rowid,
       (SELECT value FROM settings WHERE key='chat_cursor') chat_cursor,
       (SELECT COUNT(*) FROM outbox) outbox_rows,
       (SELECT MAX(rowid) FROM outbox) max_outbox_rowid,
       (SELECT COUNT(*) FROM outbox WHERE status='sent') outbox_sent;
-- messages 450 | max_msg_rowid 450 | chat_cursor 450 | outbox_rows 243 | max_outbox_rowid 244 | outbox_sent 242
```

所有线上查询都是 `SELECT`；脚本在每条结果上断言 `rows_written=0`、`changes=0`。没有 `INSERT/UPDATE/DELETE`，没有调用 QQ 发送接口，`outbox` 行数未变。

---

## 6. 未验证与局限

- **没有在线上 Worker 里实际触发一次 `repo_changes` 去读 `peiwan-club-saas`**。结论来自：`parseRepo` 允许任意 `owner/repo`、`GITHUB_TOKEN` 存在、`gh` 账号可读该私有库；但 Worker token 的实际 scope 未独立验证。若 token 是 fine-grained 且未授权新仓库，仍会 `needs_token`。
- **没有重跑 V3/V4/V-CC**。V3/V4/V-CC 的失败/P2 来自 `TeamAgent-bili-media-acceptance-20261113/acceptance.json`，是 23:17 的记录；本次只读，不重放。
- **没有发真实群消息做 B 站/图片/文件验收**。按铁律，所有验收只能本地独立库回放；本次台账没有跑回放，只核对已有证据。生产 E2E 仍是空白。
- **没有跑 `npm test`/`npm run check`**。本次是只读对账，不验证分支代码；F5b/F5c/F4 的测试状态以分支提交和施工记录为准，未独立复跑。
- **`chat_cursor` 事故的 22 分钟静默**：D1 只记录到 20:49 的消息和 21:11 的回复；中间没有 `chat_decisions`，与“游标跳过”一致。事故报告见 `/Users/yanghongming/Projects/TeamAgent-qq-outage-20261114.md`；本次未改线上游标。
- **用户最新发火的原话不在 D1**（D1 最后一条 `msg#450` 21:47:47“明天我就直接验收算了”），来自 BINI 转述；本台账以 21:12–21:48 的线上记录为最近证据。
- **时间换算**：表内为 D1 北京时间；悉尼 +3 小时。若要和用户口述的“昨晚 9 点多/刚才”对齐，请按 +3 小时换算。
- **隐私**：台账只写 rowid、时间、摘要和 secret 名字；没有写任何 token、cookie、session、密码或完整私密配置值。

---

*台账生成：2026-11-14 00:56 悉尼（21:56 北京）。只读核对，未写线上 D1，未发群消息。*
