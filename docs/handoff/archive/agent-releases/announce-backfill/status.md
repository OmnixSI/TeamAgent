# 晨报 + 补发公告首条 · 执行记录

- 执行：2026-11-14 14:05–14:07 Sydney · 交付员（DeepSeek）
- 依据：BINI 工单 `c8113f10-95ef-4be3-a65d-c19dcaac3be0`；用户 14:01 授权；群友 t.o.o. 2026-11-13 04:11 要求
- 线上基线：`/health.release = 41db2b52ebddd4eb1f46871e9d260ef504da8dc3`（V-D），`selfCard.commit` 同值
- 写库方式：`npx wrangler d1 execute inkboard-team --remote`（令牌只在命令环境读取，未打印/未落盘）

## 结论

1. **每天悉尼 08:00 晨报已真建**：`schedules` 1 行，tz=`Australia/Sydney`、`08:00`、status=`active`，下次 `2026-11-15 08:00`。
2. **两条公告均已入出站队列并已发送**：`release-notice:morning-report` rowid **269**、`release-notice:backfill-01` rowid **270**，14:06 复核均 `sent`，`msg_id` 为空（与 trip0–V-D 一致）。
3. 未动入站记录、未动游标、未部署、未发测试消息。

## 任务 A：每天悉尼 08:00 晨报

### A1. 建前只读检查

| 项 | 建前值 |
|---|---|
| `/health` | `41db2b5`，ok=true |
| `schedules` | 0 行 |
| `schedule_runs` | 0 行 |
| `messages` / `max(rowid)` | 466 / 466 |
| `chat_cursor:9968…` | 466（= max rowid） |
| `outbox` 行数 / max(rowid) | 267 / 268 |
| outbox pending+sending | 0 |

### A2. 入口与参数

- 脚本：`.worktrees/TeamAgent-V-D-release/scripts/create-daily-push.mjs`（owner-only `POST /api/admin/daily-push`，复用 `planSchedule/createSchedule`）
- 源消息：t.o.o. 2026-11-13 04:11 Sydney「然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。」
  - `source_msg_id=ROBOT1.0_uMj7bSoGmOazRMZniW.yT2V5hU3d-j6xzhbCQeAQ6Z.OwSP3g49XjNFz-7MfTy-y7SwXrIDy1.sk-8ujK3u2doyiDiEnBsDjRwFKyBrETjzvJYw94Gf2XvduFhFPmyNe`
- dry-run 结果：`ok=true, dry_run=true, would_write=true`，`next_run_text=2026-11-15 08:00（悉尼）`
- 写入：`node scripts/create-daily-push.mjs --confirm --json` → `ok=true, dry_run=false, status=active`

### A3. schedules 读回（D1 直查）

| 字段 | 值 |
|---|---|
| id | `sched-digest_daily-ROBOT1.0_uMj7bSoGmOazRMZniW.yT2V5hU3d-j6xzhbCQeAQ6Z.OwSP3g49XjNFz-7MfTy-y7SwXrIDy1.sk-8ujK3u2doyiDiEnBsDjRwFKyBrETjzvJYw94Gf2XvduFhFPmyNe` |
| group_id | `9968A083EE07797A987010E64CD421B9` |
| owner | `CBFDDE8B8487BC8C95C6907AA6193E90` |
| kind | `digest_daily` |
| tz | `Australia/Sydney` |
| spec | `{"time":"08:00"}` |
| status | `active` |
| next_run_at | `1794690000000` = **2026-11-15 08:00:00 Sydney** |
| source_msg_id | 同 A2 源消息 |

- 内容模板：`digest_daily` 固定取「昨天 00:00–今天 00:00」本群消息，最多 8 行（一句总览 + 3–6 条进展/决定/待办 + 一条最该推进的事），符合「精简」。
- 去重口径：代码固定用 `sched-<schedule.id>-<dueAt>` 作为 outbox 主键（同一 due 只写一行，重跑不重复），不是工单字面的 `morning-report:<日期>`；语义等价，未改代码。
- 回放证据：`F6P/daily-push-replay.log` 6/6；本次未重复跑，也未发群测试消息。

## 任务 B：补发公告第一条（backfill-01）

| 步骤 | 结果 |
|---|---|
| 插入前 `SELECT id` | 空（`rows_read=2, changes=0`，两个目标键都不存在） |
| `INSERT OR IGNORE` | `changes=1` |
| outbox rowid | **270** |
| 正文 | 「群里发的图片我现在能看懂了，问我图里是什么、写了什么字都行。」 |
| 入队时间 | 2026-11-14 14:05:56 Sydney |
| 复核状态 | `sent`（14:06），`msg_id=null`，同键 1 行 |

## 公告 A：晨报说明

| 步骤 | 结果 |
|---|---|
| 插入前 `SELECT id` | 空 |
| `INSERT OR IGNORE` | `changes=1` |
| outbox rowid | **269** |
| 正文 | 「从明天起，每天早上 8 点（悉尼时间）我会发一条昨天群里聊了什么的小总结。」 |
| 入队时间 | 2026-11-14 14:05:49 Sydney |
| 复核状态 | `sent`（14:06），`msg_id=null`，同键 1 行 |

- 发送顺序 269 → 270，两条间隔约 7 秒；发送路径与 trip0/trip1/SK/V-D 相同，纯文本、无内部名词。

## 最终只读冒烟（14:06 Sydney）

| 指标 | 值 | 判读 |
|---|---|---|
| `/health.release` | `41db2b5` | 未部署，保持 V-D |
| `schedules` | 1 | 晨报在位 |
| `schedule_runs` | 0 | 首次运行要等 11-15 08:00，正常 |
| `messages` / `max(rowid)` | 466 / 466 | 入站无新增 |
| `chat_cursor:9968…` | 466 | 未动，不超前 |
| `outbox` 行数 / max(rowid) | 269 / 270 | 只加两条公告 |
| outbox pending+sending | 0 | 两条都已发出，无积压 |
| 同键重复 | 269=1 行、270=1 行 | 无重复 |

## 文件改动

- `.agent/releases/announce-backfill/queue.md`：新增 §0.1（晨报日程 + 两条 rowid）、§1 第 1 条回填 rowid 270、§6 第 3 条改为「日推已真建」。
- `.agent/releases/announce-backfill/status.md`：本文件。

## 未做 / 待观察

- 没有往群里发测试消息；没有为了验证日推手动触发 `schedule_runs`。
- 明早 08:00 是否真的出 outbox、内容是否够精简，要等首次真实运行；`schedule_runs` 仍为 0 属预期。
- 补发 02–07 由 BINI 另设的每 20 分钟任务逐条发，本趟未动。
- 生产 `summaries` 使用 deepseek-flash；回放用的是 Luna，文案质量可能略有差异。

## 2026-11-14 14:15 补发第 2 条（backfill-02）

| 步骤 | 结果 |
|---|---|
| 只读健检 | `/health.release=41db2b5`；outbox 269 行 / max 270 / pending+sending 0；messages 466 / max rowid 466；`chat_cursor=450`；`release-notice:backfill-02` 键 0 行 |
| `INSERT OR IGNORE` | `changes=1`，rowid **271**，14:15:51 入队（`status=pending`） |
| 正文 | 「想找群里以前说过的话，告诉我关键词或者是谁说的，我能翻出来。」 |
| 复核 | 14:16:22 `status=sent`，`msg_id=null`（与 trip0–V-D 一致），同键 1 行 |

- 发送走线上 Worker 每分钟 `sendOutbox`，未手动触发出站、未改游标、未碰入站记录、未部署。
- 最终只读冒烟（14:16）：outbox 270 行 / max rowid 271 / pending+sending 0；messages 466 / max 466；cursor 450；`/health` 仍 41db2b5。
- 下一条待发：`release-notice:backfill-03`（按 10 分钟节奏由同一任务处理）。

## 2026-11-14 14:26 补发第 3 条（backfill-03）

| 步骤 | 结果 |
|---|---|
| 只读健检 | `/health.release=41db2b5`；outbox 270 行 / max 271 / pending+sending 0；messages 466 / max rowid 466；`release-notice:backfill-03` 键 0 行 |
| `INSERT OR IGNORE` | `changes=1`，rowid **272**，14:26:03 入队（`status=pending`） |
| 正文 | 「群里聊得多的时候，喊我总结一下，我会按结论、决定和待办分好给你。」 |
| 复核 | 14:27 `status=sent`，`msg_id=null`，同键 1 行 |

- 发送走线上 Worker 每分钟 `sendOutbox`，未手动触发出站、未改游标、未碰入站记录、未部署。
- 最终只读冒烟：outbox 271 行 / max rowid 272 / pending+sending 0；messages 466 / max 466；`/health` 仍 41db2b5。
- 下一条待发：`release-notice:backfill-04`（每 10 分钟一条，由同一任务处理）。

## 2026-11-14 14:37 补发第 4 条（backfill-04）

| 步骤 | 结果 |
|---|---|
| 只读健检 | `/health.release=e67743f`（趟 A 已上线）；outbox 273 行 / max rowid 274 / pending+sending 1（趟 A 公告 274）；messages 466 / max 466；`chat_cursor=450`、群游标 466；`release-notice:backfill-04` 键 0 行 |
| 插入前等待 | 趟 A 公告 274 于 14:37 发出后才插入，避免同一 tick 连发两条公告 |
| `INSERT OR IGNORE` | `changes=1`，rowid **276**，14:37:16 入队（`status=pending`） |
| 正文 | 「问我哪个项目最近改了什么、哪个 PR 还开着、哪个 Issue 还没关，我能直接查。」 |
| 复核 | 14:37 `status=sent`，`msg_id=null`，同键 1 行 |

- 发送走线上 Worker 每分钟 `sendOutbox`，未手动触发出站、未改游标、未碰入站记录、未部署。
- 同一分钟内群里有真人消息（messages 466→467）与自动回复（outbox 275/277），与本条公告交叉但各自正常 `sent`；最终 outbox 276 行 / max 277 / pending+sending 0。
- 下一条待发：`release-notice:backfill-05`（每 10 分钟一条，由同一任务处理）。

## 2026-11-14 14:46 补发第 5 条（backfill-05）

| 步骤 | 结果 |
|---|---|
| 只读健检 | `/health.release=e67743f`（趟 A）；outbox 276 行 / max rowid 277 / pending+sending 0；messages 467 / max 467；`release-notice:backfill-05` 键 0 行 |
| `INSERT OR IGNORE` | `changes=1`，rowid **278**，14:46:19 入队（`status=pending`） |
| 正文 | 「想查网上的最新消息，直接问我，我会把看到的来源链接一起给你。」 |
| 复核 | 14:47:27 `status=sent`，`msg_id=null`（与 trip0–V-D 一致），同键 1 行 |

- 未动游标、未碰入站记录、未写别的表、未部署。

## 2026-11-14 14:56 补发第 6 条（backfill-06）

| 步骤 | 结果 |
|---|---|
| 只读健检 | `/health.release=e67743f`；outbox 277 行 / max rowid 278 / pending+sending 0；messages 467 / max 467；`release-notice:backfill-06` 键 0 行 |
| `INSERT OR IGNORE` | `changes=1`，rowid **279**，14:56:00 入队（`status=pending`） |
| 正文 | 「要算数、算比例，直接丢给我，不用自己按计算器。」 |
| 复核 | 14:57 `status=sent`，`msg_id=null`（与 trip0–V-D 一致），同键 1 行；outbox 278 行 / max 279 / open 0 |

- 未动游标、未碰入站记录、未写别的表、未部署。
- 下一条：`release-notice:backfill-07`（§1 最后一条），之后 §1 的 7 条补发全部完成，队列只剩 §2 五条「待验证，不发」。

## 2026-11-14 15:08 补发第 7 条（backfill-07，§1 最后一条）

| 步骤 | 结果 |
|---|---|
| 只读健检 | `/health.release=e67743f`（ok=true）；outbox 278 行 / max rowid 279 / pending+sending 0；messages 467 / max 467；`release-notice:backfill-07` 键 0 行 |
| `INSERT OR IGNORE` | `changes=1`，rowid **280**，15:06:22 入队（`status=pending`） |
| 正文 | 「想让我到点提醒你，或者每天固定时间总结群里消息，把时间告诉我就行。」 |
| 复核 | 15:08 `status=sent`，`msg_id=null`（与 trip0–V-D 一致），同键 1 行；outbox 279 行 / max 280 / open 0 |

- 发送走线上 Worker 每分钟 `sendOutbox`，未手动触发出站、未改游标、未碰入站记录、未部署。
- §1 的 7 条补发全部完成（rowid 270/271/272/276/278/279/280）；队列只剩 §2 五条「待验证，不发」，等证据齐了改标后才会发。
