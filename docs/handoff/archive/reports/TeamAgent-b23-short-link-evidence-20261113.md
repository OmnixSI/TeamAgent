# B 站短链读不到：线上证据（2026-11-13 09:37 Sydney）

## 样本

- 消息：`https://b23.tv/MV29F7r`，2026-11-13 06:37:46 +08（= 09:37:46 Sydney）
- 正文：「【10月鸿蒙智行销量暴跌?…】 https://b23.tv/MV29F7r 总结一下视频内容和评论区观点」
- message id：`ROBOT1.0_OyB7…ADRFg`（完整 id 见 D1）

## 抓取侧：成功

| 证据 | 值 |
|---|---|
| `jobs` | `fetch-bili-MV29F7r`，kind `fetch`，status **done**，attempts 1，error null |
| `video_waits` | ref `MV29F7r`，status **done**，attempts 1，ready 1 |
| `media_notes` | `bili:MV29F7r` 已写入（22:38:03.846Z） |
| 抓取结果 | `bvid=BV1GN4p6pEEP`；标题「10月鸿蒙智行销量暴跌?理想MEGA只卖四十多万?看完就懂了」；UP「超哥超车」；时长 695s；播放 245,473 |
| fetcher 日志 | `fetch short /MV29F7r status=302`（短链解析成功） |

## 阶段计时（stage_timings，turn_id = 该消息 id）

| 阶段 | 时间（ms） |
|---|---|
| chat_claimed | 1794523068933 |
| bili_wait_start | 1794523071498 |
| fetch_claimed | 1794523073778 |
| fetch_reported | 1794523083923 |
| wait_woken | 1794523084326 |
| model_start（participation） | 1794523087248 |
| model_end | 1794523089647 |
| research_queued | 1794523090339 |
| model_start（research） | 1794523124336 |
| model_end（research） | 1794523126577 |
| outbox（失败回复） | 1794523131127 |

## 最终回复（失败那句，前 80 字）

> 这条我抓不到内容，短链后面的 BV 号像被截断了（BV1MV29F7r 这长度不对），视频标题、简介、评论区一个字都没读到…

## 根因（代码）

1. 抓取任务和缓存都成功，但 **research 任务 payload 没有 `materials`**：
   - `research` job（22:38:09.839 创建）payload keys = `authz, background, batchIds, latestId, mentioned, resume, videoWaited`，**materials 数量 0**，`videoWaited=true`。
   - 回复走 `src/worker.ts:564` 的 research 分支：只 `loadChatContext` 后直接 `agentAnswer(e,p)`，没有把 `media_notes` 里的视频素材补进 `p.materials`。
   - 入队处 `src/semantic.ts:909` 把 payload 序列化时也就没有素材字段。
2. 模型只看到消息正文里的短链文本，于是自行推断「BV1MV29F7r 长度不对」并宣布读不到；实际同一时刻 `bili:MV29F7r` 已有完整元数据。
3. 对照：稍后用户发完整链接时，另一条 outbox（22:39:58）能正常引用 `BV1GN4p6pEEP` 的元数据与热评，说明抓取链路本身没问题，丢的是 **short ref → research 素材** 这一段。

## 未查到

- `stage_timings` 中没有 `research` 内部的工具调用明细（只有 model_start/end）。
- 无法从 D1 还原模型当时的完整 prompt；以上以 job payload 字段为准。

---

## 追加：BV 长链接（2026-11-13 09:39:35 Sydney）

- 消息：`https://www.bilibili.com/video/BV1GN4p6pEEP/?share_source=copy_web…`，正文只有卡片标题+链接，无「总结」等请求词。
- **没有新建 fetch 任务，也没有 video_waits**：`video_waits` 无该 latest_id 记录；`jobs` 里只有 `media`（pending）与 `chat`。
- 使用了缓存：`media_notes` 同时存在 `bili:BV1GN4p6pEEP` 与 `bili:MV29F7r`，`created_at` 都是 **2026-11-12T22:38:03.846Z**（短链那次 fetch 同时按 ref 与 bvid 落库）。
- stage_timings：`chat_claimed` 22:39:43.332 → `model_start` 46.491 → `model_end` 54.523 → `model_start` 54.704 → `model_end` 58.572 → `outbox` 58.941 → `sent` 22:40:02.250。
- 回复原文（前 100 字）：「完整链接收到了，BV1GN4p6pEEP。先说明一下：视频正文我抓不到，只拿到了元数据和热评——695秒、简介为空、没有 CC 字幕，画面和音轨也没读到…」
- 缓存字段核对：`duration=695`、`desc` 长度 0、`subtitle_status=none`、`subtitle` 长度 0、热评 8 条 → **「没有字幕」是 B 站确实没有可获取字幕（none），不是字幕接口失败**。
- 「画面和音轨」：B 站链接读取链路本来就不做抽帧/转写；`ffmpeg`/`whisper` 仅在本机 utility 文件任务里用，不在视频链接路径。与 Cookie、登录态无关。
- fetcher 日志（当前进程）：`fetch short /MV29F7r status=302`、`view 200`、`player 200`、`reply 200`，**没有 subtitle 请求行**（因为没有字幕 URL）；`com.inkboard.team-fetch` 状态 running。

## 结论（两类问题分开）

1. **短链真正的 bug**：抓取成功、素材已落 `bili:MV29F7r`，但 research job payload 没有 `materials`，回复阶段丢失素材，模型据此编出「BV1MV29F7r 长度不对」并宣布读不到。
2. **长链接不是短链问题**：该轮命中缓存，没有重新抓取；「没字幕」是 `subtitle_status=none` 的真实情况，「画面/音轨」是当前链路未实现的能力，不应表述为「登录了还读不到」。
