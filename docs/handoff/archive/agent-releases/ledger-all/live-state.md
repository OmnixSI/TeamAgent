# 线上功能总账（只读盘点）

- 盘点：测试员
- 快照：2026-11-14 19:10 Sydney（AEDT，UTC+11）
- 线上：Worker `inkboard-team`，`/health.release = 20220a1ea570cef215abc5f98c5bafc2fe3e06ec`，selfCard 同值
- D1：`inkboard-team` / `42e95fb2-16f8-46d9-bf32-34f3e88a4443`（account `fadeed4822ac4e4e518ed6eddc8d35ce`）
- 边界：全部为 `SELECT`；76 条查询逐条核对 `rows_written=0`、`changed_db=false`（汇总见 `notes/readonly-audit.txt`）；未写 D1、未部署、未碰游标、未发任何群消息
- 原始响应：`.agent/releases/ledger-all/notes/d1/*.json`（含每条 SQL 与完整结果）；查询脚本 `notes/d1query.py`

## 0. 先给结论：哪些是「假回执 / 真未生效」

1. **早上 8 点日报：承诺两次，实际今天 08:00 仍没发。** 11-13 04:11（悉尼）用户明确要求「悉尼时间每天早上 8 点推送昨日总结」；bot 04:11:42 回「明早 8:00 出第一份日推」，08:00 无任何出站；09:32 认错并承诺「定时推送这次真落地」；直到 **11-14 14:05:37** 才建出唯一一条 schedule，首次运行是 **11-15 08:00**，`schedule_runs` 0 行。两个早上都漏了。
2. **每天余额推送：用户给了明确时间，仍没建。** 11-14 17:10 用户说「每天固定时间发余额和 token 用量」，17:12 又明确「每天北京时间 0 点在群里发 DeepSeek 余额即可」；bot 连续两次回「说一下每天几点、发什么，我马上建」。`schedules` 里没有余额任务。
3. **F11 @提需求：表 0 行，两条行为需求只得到口头答应。** 18:24「以后回复加各种表情」→ 18:24:47 回「收到，以后说话自带表情」；18:52「用《没钱修什么仙》的梗说话」→ 18:53 用修仙腔回复。两条都没有 `feature_request` 行，也没有 `request_feature` 调用记录。
4. **生图：17:38 公告「我能画图了」，线上零产出证据。** `image_gen_log` 0、`generated_images` 0、`openai_usage(image_gen)` 0、`tool_calls(generate_image)` 0；群里 659 条消息没有任何一条要求画图。开关 `off:image_gen=0`（已开）只证明门开着，不证明出过图。
5. **账本：没有持久表。** 线上不存在 `records` / `ledger` 表；bot 17:12 还说「群内账这块我确实没捞到记录」，17:13–17:14 又能报「合计 ¥710」。这些数只能从对话上下文现算，没有账本可查。
6. **夜间复盘：`review_reports` 0 行。** `dreams` 最后一行日期 11-13；11-14 03:00/03:01 两个 dream job 都 done，但没有新增 dream 行。

---

## 1. settings 开关当前值

**结论：4 个 `off:*` 全是 0（未关闭），`docread:enabled=1`；`off:feature_request`、`off:openai`、`off:stock_quote`、voice/tts/vision 开关均不存在（按代码默认走开启）。**

证据（`settings_all` 43 行 + `settings_gates` 7 行）：

```sql
SELECT key,value FROM settings WHERE key LIKE 'off:%' OR key LIKE '%:enabled'
  OR key LIKE '%voice%' OR key LIKE '%tts%' OR key LIKE '%vision%'
  OR key LIKE '%docread%' OR key LIKE '%image%' OR key LIKE '%openai%' ORDER BY key;
```

| key | value | 含义 |
|---|---|---|
| `off:image_gen` | `0` | 生图开启（A 报告 14:47 快照仍为 1；C2 上线后置 0，表里无变更时间字段） |
| `off:quote` | `0` | 引用回复开启 |
| `off:sticker_collect` | `0` | 表情收集开启 |
| `off:wait` | `0` | 等待/插话开启 |
| `docread:enabled` | `1` | 文档读取开启 |

不存在的键（`settings` 43 行全表核对）：`off:feature_request`、`off:openai`、`off:stock_quote`、`voice:enabled`、`voice:mode`、`tts:provider`、`off:tts`、`off:vision`、`vision:events`。F11 的开启条件因此落在 `config/team.json`：`feature_requests.enabled=true`（`git show 20220a1:config/team.json`），即 **F11 在线上是开的**。

另有 `budget:vision:2026-11-14=3`（当天识图已用 3 次）、`quota:deepseek:balance.total=277.56 CNY`。

## 2. 生图 F8

**结论：功能已上线且开关已开，但线上从未生成过一张图，群里也从未有人要求画图。17:38 的「我能画图了」目前只有代码与公告，没有真实出图证据。**

证据：

```sql
SELECT (SELECT COUNT(*) FROM image_gen_log) log_n,
       (SELECT COUNT(*) FROM generated_images) gen_n,
       (SELECT COUNT(*) FROM openai_usage WHERE purpose LIKE '%image%') oai_img_n,
       (SELECT COUNT(*) FROM tool_calls WHERE name LIKE '%image%') tool_img_n,
       (SELECT COUNT(*) FROM quota_reservations WHERE kind LIKE '%image%' OR id LIKE '%image%') quota_img_n;
-- log_n=0 gen_n=0 oai_img_n=0 tool_img_n=0 quota_img_n=0
```

- `image_gen_log` / `generated_images` / `openai_usage` 全表各 0 行（`img_recent`、`gen_recent`、`oai_recent` 均 0 行）。
- `messages` 659 条（11-11 15:41 → 11-14 16:02 +08:00，仅一个群 `9968A083…`）里：
  - `body LIKE '%画%'` → **0 条**
  - `画图/画个/画一张/生图/出图/生成图/画一下/帮我画/画张` → **0 条**
  - `图片` 仅 2 条，都是「只能读读图片和语音」「没有，我发的是图片」，不是画图请求。
- 唯一的对外说法：`release-notice:C2`，2026-11-14 17:38:14 `sent`，正文「我能画图了：描述一下想要的画面，我生成好发出来……」
- 代码在 `20220a1:src/tools/generate-image.ts`，`off:image_gen` 判断在 `src/tools/generate-image.ts:274`；门开着，但没有调用。

> 说明：用户记忆里的「让你生图」不在这 659 条群消息里，可能来自 1:1 或更早渠道；本库无法证明。

## 3. @提需求 F11

**结论：`feature_request` 表 0 行，`request_feature` 调用 0 次，没有 claimed/shipped。两条明确的行为需求被口头答应，但没有登记。**

证据：

```sql
SELECT status,mode,COUNT(*) FROM feature_request GROUP BY status,mode;   -- 0 行
SELECT id,created_at,sender_name,mode,status,auto,risk_tags FROM feature_request
  ORDER BY created_at DESC LIMIT 10;                                     -- 0 行
SELECT name,status,COUNT(*) FROM tool_calls GROUP BY name,status;        -- 只有 tts_reply
SELECT name,ok,error_kind,COUNT(*) FROM turn_tools GROUP BY name,ok,error_kind; -- 无 request_feature
```

- 表存在（migration 已跑），`feature_request` **0 行**；`claimed/shipped` 自然为 0。
- `tool_calls` 只有 `tts_reply`（8 ok / 2 failed），因为该表只在 `calc` / `mcp_*` 时写（`src/toolkit.ts:52`），**不能用来统计 request_feature**；`turn_tools`（26 行，F6 工具审计）也没有 `request_feature`。
- 群消息里没有任何「你应该加个…/能不能加…/希望你能…」式的能力需求；唯一命中「加个」的是 11-11 20:05（悉尼）的玩笑「我需要你加一个种族歧视的……」，不是功能单。
- 真正的行为需求两条，均未入表：
  - 18:24:25「你以后给我们回复文字的时候，还可以加一些各种表情……」→ 18:24:47 出站「收到，以后说话自带表情：[滑稽]😎🫡」；`feature_request` 无行。
  - 18:52:42「能不能用这书里面的梗和台词描述和设定等等来和我说话」→ 18:53 用修仙腔回复；`feature_request` 无行。
- 另有 17:10/17:12（悉尼）的「每天余额推送」属于定时能力需求，见 §7：也没有 schedule 行。

## 4. 读取器（read_social / stock_quote / read_url）

**结论：`tool_calls` 里这三个名字都是 0 行，但该表根本不记这类工具；真实审计在 `turn_tools`（26 行，覆盖 11-13 起）：stock_quote 2 次全成功，read_web 2 次全超时，fetch_page 1 次被拒，read_social / read_url 在覆盖范围内 0 次。**

证据：

```sql
SELECT name,ok,error_kind,COUNT(*) n,MAX(created_at) FROM turn_tools GROUP BY name,ok,error_kind;
```

| 工具 | 结果 | 次数 | 最后时间（Sydney） |
|---|---|---|---|
| `stock_quote` | ok | 2 | 2026-11-14 18:01:05（NOK） |
| `read_web` | timeout | 2 | 2026-11-14 02:08:08（b23.tv / BV1piWJ6XEWu） |
| `fetch_page` | denied | 1 | 2026-11-14 17:53:22（stockanalysis.com/stocks/nok） |
| `read_social` | — | **0** | 无 |
| `read_url` | — | **0** | 无 |
| `web_search` | ok | 5 | 2026-11-14 18:53:08 |
| `search_web` | ok | 6 | 2026-11-14 02:08:23 |
| `news_search` | ok | 2 | 2026-11-14 18:01:05 |

群里的社媒链接只有 2 条相关消息：
- 11-13 10:27（悉尼）小红书短链 `https://xhslink.cn/o/79Ta4C6dKMS` → bot 10:28:08 回「只拿到了标题和短链，正文和图片没抓到，现在提炼不出具体 UI 修改指导」；没有 `read_social` 调用记录。
- 11-12 00:19（悉尼）「我记得有知乎文章还是什么说了华为……」→ bot 00:19:11 先用「收到，已经在查了」回执，00:19:55 给出完整核实回答（知乎/媒体/财报分开看）。**这条是真做了。**
- 雪球 / 微博 / 抖音 / X(twitter/x.com) 链接：**0 条**。

## 5. 表情 / 识图 / 语音

**结论：识图在跑（8 条笔记，D-emoji2 上线后新增 4 条），表情解码 1 次成功；`vision_events` 0 行是诊断开关没开，不是故障；语音 8 条真语音已发出，2 条降级文字。**

证据：

```sql
SELECT (SELECT COUNT(*) FROM vision_events) vision_events_n,
       (SELECT COUNT(*) FROM image_notes) image_notes_n,
       (SELECT COUNT(*) FROM media_notes) media_notes_n,
       (SELECT COUNT(*) FROM message_images) message_images_n,
       (SELECT COUNT(*) FROM jobs WHERE kind='emoji_note') emoji_jobs_n;
-- 0 / 8 / 20 / 10 / 1
```

- `vision_events` **0 行**；代码 `src/vision.ts:1001` 明确「Diagnostic-only… writes stay off unless VISION_EVENTS=1 or vision:events=1」，settings 无 `vision:events` → 按设计不写，**不是故障**。
- `image_notes` 8 条，provider 全是 `deepseek/deepseek-flash`；最近 4 条：18:11:04、18:00:49、18:00:46×2（均在 D-emoji2 17:59 上线后），说明新版本识图在工作。
- `emoji_note` job 1 条，`done`，2026-11-14 17:43:24；对应 18:03（悉尼）「读一下这个表情」的回复「ext base64 解出来 {"text":"[prpr]"}，faceType=4 对不上，不瞎编」。
- `media_notes` 20 条、`message_images` 10 条。
- 语音（`outbox_attempts` + `ds_usage`）：

| 指标 | 值 |
|---|---|
| `voice:sent:voice` | **8**（最后 17:20:31） |
| `voice:sent:text` | 2（最后 15:08:45） |
| `ds_usage purpose=tts` | 8 ok / 2 failed(upstream)，最后 17:20:41 |

即：8 条真的以语音发出，2 条早期失败走了「原文文字」降级；`tool_calls` 的 `tts_reply` 也是 8 ok / 2 failed。

## 6. 夜间自省 / 复盘 / 晨报

**结论：`review_reports` 0 行；`dreams` 最后一条是 11-13；今天 08:00 没有晨报；8 点日报 schedule 是今天 14:05 才建的，首跑明天 08:00。**

证据：

```sql
SELECT COUNT(*),MIN(date),MAX(date) FROM review_reports;        -- 0 / null / null
SELECT id,date,created_at,message_count FROM dreams ORDER BY date DESC;  -- 6 行，最新 date=2026-11-13
SELECT id,status,created_at,body FROM outbox WHERE id LIKE '%morning%' OR id LIKE '%review%';
-- 只有 release-notice:morning-report，sent，2026-11-14 14:05:49
SELECT id,status FROM outbox
 WHERE created_at >= strftime('%s','2026-11-13 20:40:00')*1000
   AND created_at <= strftime('%s','2026-11-13 21:30:00')*1000;  -- 0 行（悉尼 07:40–08:30）
```

- `review_reports`：**0 行**（`review_count` n=0）。
- `dreams`：6 行，date 只有 2026-11-12 / 2026-11-13；最后 `created_at=2026-11-12T17:33:52Z`（悉尼 11-13 04:33）。
- `jobs kind=dream`：11-14 03:00:03、03:01:05 两条都 `done`、attempts=1、error=null，但 `dreams` 没有 11-14 新行；同期 `settings.self_note` / `team_reflection` 有更新（「今晚我在整理 t.o.o. 的总结要求…」）。
- 晨报：今天悉尼 07:40–08:30 窗口 `outbox` **0 行**；唯一 morning 键是公告 `release-notice:morning-report`（14:05:49 sent），正文「从明天起，每天早上 8 点……」。
- 定时：`schedules` 唯一一行 `sched-digest_daily-…`，`kind=digest_daily`，`tz=Australia/Sydney`，`spec={"time":"08:00"}`，`status=active`，`created_at=2026-11-14 14:05:37`，`next_run_at=2026-11-15 08:00:00`；`schedule_runs` **0 行**。

## 7. 账本 / 定时表

**结论：`schedules` 存在且只有 1 行（8 点日报），`schedule_runs` 0 行；`records` / `ledger` 表不存在，账本没有持久化。**

证据：

```sql
SELECT (SELECT COUNT(*) FROM schedules) schedules_n,
       (SELECT COUNT(*) FROM schedule_runs) runs_n,
       (SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%record%' OR name LIKE '%ledger%') record_tables;
-- 1 / 0 / 0
```

- `schedules` 1 行：`digest_daily`，08:00 Australia/Sydney，active，next 11-15 08:00，由 11-13 04:11（悉尼）的请求迟到约 34 小时才建。
- `schedule_runs` 0 行：一次都没跑过。
- `sqlite_master` 85 个表/视图里没有 `records`、没有 `ledger`；`promises` 0 行、`capability_gaps` 0 行。
- 因此「记账 / 报销」只能从 `messages` 上下文现算：17:12 说「没捞到记录」，17:13–17:14 报出「t.o.o. ¥370、卡特龙 ¥50、Souvereign ¥290，合计 ¥710」。数据不在任何表里。

## 8. Worker secret 名字

**结论：7 个名字，`OPENAI_API_KEY` 与 `DEEPSEEK_API_KEY` 都在。**

证据（Cloudflare API `GET /accounts/…/workers/scripts/inkboard-team/secrets`，只取 name）：

```text
ADMIN_TOKEN, DEEPSEEK_API_KEY, GITHUB_TOKEN, OPENAI_API_KEY,
QQ_APP_ID, QQ_APP_SECRET, RUNNER_TOKEN
```

未读取、未打印任何值。

---

## 附：本次没有做 / 不能证明的

- 没有触发任何真实生图、TTS、识图或群消息；生图「能不能出图」只按开关+代码+历史记录判断，线上无成功样本。
- `settings` 表没有更新时间字段，无法从 D1 证明 `off:image_gen` 从 1 改 0 的准确时刻；只能引用 14:47 的 A 快照与 C2 17:38 公告做旁证。
- `turn_tools` 只有 26 行、最早 11-13，不能代表全部历史工具调用；`tool_calls` 只审计 `calc`/`mcp_*`，不能作为读取器调用量的依据。
- `vision_events` 0 行是诊断开关默认关闭，不能据此判断识图失败。
