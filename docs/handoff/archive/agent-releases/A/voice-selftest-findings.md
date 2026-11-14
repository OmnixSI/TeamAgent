# A · 语音自测与「生图」公告只读排查

- 排查：测试员
- 快照：2026-11-14 14:47:43 Sydney（AEDT）
- 线上：`inkboard-team` Worker，`release/A @e67743f`；D1 `42e95fb2-16f8-46d9-bf32-34f3e88a4443`
- 边界：只读 `SELECT`；未写 D1、未往群里发消息、未重试发送。下文所有 D1 查询的 `rows_written` 均为 0。
- 凭据与调用：使用已有的 Cloudflare 只读令牌；未使用 xAI key，未真实调用生图或语音接口。生图可用性只按「开关值 + 代码路径 + 已有成功记录」判断，未做付费实测。

## 0. 结论

1. **语音自测只发出了文字，没有发出语音文件。** outbox 行 `selftest:voice:2026-11-14` 正文是「这是语音自测，听到请忽略，群里照常聊。」，状态 `sent`；发送尝试的 `outbox_attempts.code = voice:sent:text`，说明跑的是「语音失败→原文文字」降级路径，不是语音消息。
2. **根因是 qq 服务的 PATH 里没有 `/opt/homebrew/bin`，`ffmpeg` 找不到。** edge 和 DeepSeek 两条 TTS 都走到了「转 24k 单声道 WAV」这一步，然后因为 `spawn("ffmpeg")` 报 `ENOENT` 失败；`runner/asr.mjs` 把 `ENOENT` 统一记成 `asr_unavailable`，所以日志看起来像 ASR 问题，实际是 TTS 的转码依赖缺失。`runner/tts.mjs` 按设计回退原文文字，只发一次。
3. **「生图」只出现在 A 公告的额度项和随后的额度回复里，不是生图能力公告。** 线上 `settings.off:image_gen = "1"`，`generate_image` 会被管理员开关直接拒绝；`image_gen_log` 0 行、`generated_images` 0 行、`openai_usage` 里 `image_gen` 0 行、`quota_reservations` 里 `imagegen*` 0 行。**当前不能生图，也从未成功生成过。**
4. **A 公告已发出。** `release-notice:A`，14:35:52 入队，14:36:14 发送尝试返回 HTTP 200，状态 `sent`；`msg_id` 为空（与 264–267 等所有公告一致），原文见 §5。
5. **语音开关不是原因。** 线上 settings 没有 `voice:enabled`、`voice:mode`、`tts:provider`、`off:tts`；`outbox_meta` 里 `cfg.enabled=true`、`voice=zh-CN-XiaoxiaoNeural`，语音是明确入队的。

## 1. 14:00 后 outbox 全量（悉尼时间）

截至 14:47:43，`created_at >= 1794625200000`（14:00:00）共 **10 行**，全部 `sent`；没有 `failed` / `pending` / `voice` / `voice_sending` 行。

| 去重键 / ID | 类型 | 入队 | 发送尝试 | 状态 | 语音附件 | 内容（原文） |
|---|---|---|---|---|---|---|
| `release-notice:morning-report` | 公告·文字 | 14:05:49 | 14:06:14 | sent | 无 | 从明天起，每天早上 8 点（悉尼时间）我会发一条昨天群里聊了什么的小总结。 |
| `release-notice:backfill-01` | 公告·文字 | 14:05:56 | 14:06:16 | sent | 无 | 群里发的图片我现在能看懂了，问我图里是什么、写了什么字都行。 |
| `release-notice:backfill-02` | 公告·文字 | 14:15:51 | 14:16:16 | sent | 无 | 想找群里以前说过的话，告诉我关键词或者是谁说的，我能翻出来。 |
| `release-notice:backfill-03` | 公告·文字 | 14:26:03 | 14:26:13 | sent | 无 | 群里聊得多的时候，喊我总结一下，我会按结论、决定和待办分好给你。 |
| `selftest:voice:2026-11-14` | 语音自测（**实际文字**） | 14:35:41 | 14:36:12 | sent | **无**（只有 `voice_text` / `cfg` 元数据） | 这是语音自测，听到请忽略，群里照常聊。 |
| `release-notice:A` | 公告·文字 | 14:35:52 | 14:36:14 | sent | 无 | 以后想知道我还剩多少额度，直接问我就行：DeepSeek 余额、今天用了多少、OpenAI 和生图还剩多少，我都能报。别人问我只说个大概，你问我才给具体数。 |
| `release-notice:backfill-04` | 公告·文字 | 14:37:16 | 14:37:24 | sent | 无 | 问我哪个项目最近改了什么、哪个 PR 还开着、哪个 Issue 还没关，我能直接查。 |
| `chat-ROBOT1.0_OyB7…` | 聊天回复·文字 | 14:37:19 | 14:37:22 | sent | 无 | 余额这块我拿不到实时数，已经挂后台查了，出结果我单独回你这条。视频那个总结也在跑，别急 |
| `research-ROBOT1.0_OyB7…` | 聊天回复·文字 | 14:37:27 | 14:37:29 | sent | 无 | 查了：DeepSeek ¥94.80，全是充值，赠送 0；今天 1 次、本月 1 次，近 7 天基本没动。顺带 OpenAI 还剩 $3.00，生图今天 0/20。 |
| `release-notice:backfill-05` | 公告·文字 | 14:46:19 | 14:47:13 | sent | 无 | 想查网上的最新消息，直接问我，我会把看到的来源链接一起给你。 |

完整 id：

```text
chat-ROBOT1.0_OyB7TgbASj-VgfcoKvzFbhumJiiqG9cEyn1LXwXhIXStjxMv6qaJAPsotDJYNjvle21FTcFXtShnxcLBIq4rLC5TNlzEFDrc9dUz9F.3zxsNIqrVm3QhC6-bhktADRFg
research-ROBOT1.0_OyB7TgbASj-VgfcoKvzFbhumJiiqG9cEyn1LXwXhIXStjxMv6qaJAPsotDJYNjvle21FTcFXtShnxcLBIq4rLC5TNlzEFDrc9dUz9F.3zxsNIqrVm3QhC6-bhktADRFg
```

说明：

- 通知和自测行的 `msg_id` 都是 `null`；聊天回复行的 `msg_id` 是用户原消息 id（回复目标），不是机器人发出的消息 id。发送结果要看 `outbox_attempts.http_status` 与 `status`。
- `backfill-05` 是排查过程中 14:46 新发的同一补发批次，和语音/生图问题无关，仅按要求列全。
- 14:00 后提到「生图」的只有两行：`release-notice:A` 和 `research-…`（14:37:27）。没有其他生图相关出站行。

## 2. 语音自测那一条到底发了什么

`outbox`：

```json
{"id":"selftest:voice:2026-11-14","status":"sent","created_at":1794627341000,
 "body":"这是语音自测，听到请忽略，群里照常聊。","msg_id":null}
```

`outbox_meta`：

```json
{"voice_text":"这是语音自测，听到请忽略，群里照常聊。",
 "voice":"zh-CN-XiaoxiaoNeural",
 "cfg":{"enabled":true,"voice":"zh-CN-XiaoxiaoNeural","rate":"+0%","max_chars":300,"cache_minutes":60,"timeout_ms":20000},
 "sender":""}
```

`outbox_attempts`：

| 字段 | 值 |
|---|---|
| started_at | `1794627372323` = 2026-11-14 14:36:12 Sydney |
| http_status | `null` |
| code | **`voice:sent:text`** |

`ds_usage`（TTS 记账）：

| id | purpose | status | error_kind | latency_ms | units | est_cost_micro_usd |
|---|---|---|---|---|---|---|
| `voice:selftest:voice:2026-11-14` | tts | failed | upstream | 4526 | 0 | 0 |

`tool_calls`：`turn_id=selftest:voice:2026-11-14`，`name=tts_reply`，`status=failed`，`error_kind=upstream`，`latency_ms=4526`。

`~/.inkboard-team/qq.log`（文件 mtime 14:36:15）：

```text
tts failed: edge asr_unavailable 2cd02e91
tts failed: deepseek asr_unavailable 8f072629
```

**结论：** 实际发出的是**纯文字**，不是语音文件；也不是「语音发出去后再补一条文字」，而是 TTS 合成/转码失败后按设计只发一次原文文字。没有 SILK 上传、没有 `tts send failed` 行、没有生成 `generated_images` 或语音附件记录。

## 3. 为什么没有真语音：具体断点

调用链：

1. `runner/qq-gateway.mjs:1` 引入 `processVoiceOutbox`；`:179` 在 QQ 已连接且 `voiceReady` 时每 10 秒拉一次 voice outbox。
2. `runner/voice-delivery.mjs` 逐条调用 `voiceReply`；TTS 失败时 `voiceReply` 走 `say("tts_failed")`，用 `textBot.sendText` 发原文。
3. `runner/tts.mjs` 先试 edge（`:213`），再试 DeepSeek（`:243`）；两条路都在合成出音频后调用**裸命令** `run("ffmpeg", …)` 转 24 kHz 单声道 WAV。
4. `runner/asr.mjs:17` 的 `childEnv()` 原样传 `process.env.PATH`；`:42` 把子进程 `ENOENT` 映射成 `fault("asr_unavailable")`。
5. `com.inkboard.team-qq` 的 launchd 配置**没有 PATH 环境变量**。`launchctl print` 显示：

```text
default environment = {
    PATH => /usr/bin:/bin:/usr/sbin:/sbin
}
environment = {
    DEEPSEEK_API_KEY_FILE => /Users/yanghongming/.inkboard-team/secrets/deepseek-api-key
    XPC_SERVICE_NAME => com.inkboard.team-qq
}
```

6. 本机 `ffmpeg` 只在 `/opt/homebrew/bin/ffmpeg`（`/usr/bin/ffmpeg` 不存在）；所以 qq 进程里 `spawn("ffmpeg")` 必然 `ENOENT`。

复现（本地只读，未联网、未发消息）：

```text
$ env PATH=/usr/bin:/bin:/usr/sbin:/sbin /Users/yanghongming/.nvm/versions/node/v26.13.0/bin/node \
  --input-type=module -e 'import {runCommand} from "./runner/asr.mjs"; try{await runCommand("ffmpeg",["-version"],{timeoutMs:5000})}catch(e){console.log(JSON.stringify({reason:e.reason}))}'
{"reason":"asr_unavailable"}
```

同时 `~/.inkboard-team/venv/bin/edge-tts --version` 正常（`edge-tts 7.3.1`），因为 `edgeTtsCommand()` 用的是绝对路径 `~/.inkboard-team/venv/bin/edge-tts`；它不依赖 PATH。DeepSeek 路线也不依赖 PATH 取 key，所以两条路都能走到「音频已生成、ffmpeg 找不到」这一步。

**为什么两条日志都是 `asr_unavailable`：**

- edge：`edge-tts` 正常跑完，`ffmpeg` 第一次 spawn 失败 → `asr_unavailable`；
- deepseek：`callDs("tts", …)` 返回了音频字节（否则会是 `auth/quota/upstream/unsupported` 等错误码），写 `raw.wav` 后 `ffmpeg` 同样 spawn 失败 → `asr_unavailable`。

`~/.inkboard-team/tts-cache` 为空，也符合「音频生成在 `.work-*` 临时目录，转码失败后 `finally` 清理」的路径。

**次要发现（记账口径）：** DeepSeek TTS 这次很可能已经返回了音频字节，但 `reportVoice` 因为最终 `audio` 为 `null`、`b.provider` 缺失，把 `ds_usage.units` 记成 0、`est_cost_micro_usd` 记成 0。19 字按 `DS_PRICES.tts_micro_usd_per_10k_chars = 225000` 估算约 0.00043 美元；金额很小，但「上游成功、转码失败」的调用目前不会计入 TTS 成本。是否真的产生 DeepSeek 计费，需查 DeepSeek 账单；代码层面只能确认这条路径会丢 units。

## 4. 「生图」那句的来源、开关与真实可用性

### 4.1 两条原文

1. **A 公告**（`release-notice:A`，14:35:52 入队 / 14:36:14 发送，`sent`）：

   > 以后想知道我还剩多少额度，直接问我就行：DeepSeek 余额、今天用了多少、OpenAI 和生图还剩多少，我都能报。别人问我只说个大概，你问我才给具体数。

   这句只承诺「报生图额度」，没有说「能生图」；但它把「生图」当成一个现成能力来列，容易被读成「现在可以生图」。

2. **14:37:27 的额度回复**（`research-ROBOT1.0_OyB7…`，14:37:29 发出）：

   > 查了：DeepSeek ¥94.80，全是充值，赠送 0；今天 1 次、本月 1 次，近 7 天基本没动。顺带 OpenAI 还剩 $3.00，生图今天 0/20。

   这句是模型在回答 14:36:58 用户「DeepSeek 还有多少余额」时，调用 `get_quota` 后生成的。`src/quota.ts:683` **无条件**拼上「生图：近 24 小时本群 x / y 张」，`src/tools/quota.ts:15-16` 的工具描述也把「OpenAI/生图每日限额」写进去了；所以即使 `off:image_gen=1`，模型仍会看到并复述「生图 0/20」。

### 4.2 谁发的

- 两条都是 **TeamAgent 的 QQ 机器人账号**发出的；D1 的 `outbox` 没有「操作者」字段，无法从库里定位到具体是哪个人。
- `release-notice:A` 在代码库里没有生成路径（`src/`、`scripts/` 里 grep `release-notice` 无命中），和 264–267 的公告一样是运营侧手工入队/公告流程的产物，不是模型临场说的。公告 id 就是去重键 `release-notice:A`。
- 14:37:27 那条是模型回复：`chat_decisions` 里 `id=chat-ROBOT1.0_OyB7…`，`gate=model`，`action=tool`，`model_ms=6921`，`outbox_id=chat-ROBOT1.0_OyB7…`；它引用的 `get_quota` 输出包含生图额度行。

### 4.3 线上开关与真实可用性

| 项 | 值 / 证据 |
|---|---|
| `settings.off:image_gen` | **`"1"`**（= 关闭） |
| `settings` 里 `imagegen:*` | 没有任何键；每日限额用代码默认值（每人 5、每群 20，滚动 24h） |
| `generate_image` 工具 | `src/tools/generate-image.ts:274-278` 先查 `off:image_gen`，非空且不是 `0/false` 就返回 `denied`：「生图功能已被管理员关闭」；`src/toolkit.ts:48` 也会在通用工具层拦截 |
| `image_gen_log` | **0 行**（全表） |
| `generated_images` | **0 行** |
| `openai_usage` | **0 行**（`purpose=image_gen` 也是 0） |
| `quota_reservations` | `imagegen*` **0 行**；只有 1 条 `ds:tts:group` |

按 BINI 的三项口径：**开关值 = `off:image_gen:"1"`（关闭）；代码路径 = 在 `generate-image.ts` 的开关检查处直接 `denied`，走不到 OpenAI 调用；已有成功记录 = 0 条（`image_gen_log` / `generated_images` / `openai_usage(image_gen)` / `quota_reservations(imagegen)` 全为 0）。**

**结论：当前不能生图。** 不是「额度用完了」，而是管理员开关关闭；在开关打开并做一次真实生成验证前，任何「生图还剩多少」都只是额度计数器，不代表能力可用。也没有任何公告介绍过「现在可以生图」。

## 5. 趟 A 公告是否已发、原文

| 字段 | 值 |
|---|---|
| 去重键 | `release-notice:A` |
| 入队 | `1794627352000` = 2026-11-14 14:35:52 Sydney |
| 发送尝试 | `1794627374440` = 14:36:14 Sydney |
| `outbox.status` | **`sent`** |
| `outbox_attempts.http_status` | **200** |
| `outbox_attempts.code` | `""`（QQ 返回成功，状态判定为 `sent`；与其它已发公告一致） |
| `msg_id` | `null`（所有公告/自测行都这样；聊天回复行才带用户原消息 id） |
| 同 id 行数 | 1 |

原文（78 字，一字未改）：

> 以后想知道我还剩多少额度，直接问我就行：DeepSeek 余额、今天用了多少、OpenAI 和生图还剩多少，我都能报。别人问我只说个大概，你问我才给具体数。

## 6. 建议修法（不改业务代码，交给施工/运维侧）

1. **先修 qq 服务的 PATH（最小、最直接）。** 给 `~/Library/LaunchAgents/com.inkboard.team-qq.plist` 加：
   ```xml
   <key>PATH</key>
   <string>/Users/yanghongming/.nvm/versions/node/v26.13.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
   ```
   然后 `launchctl bootout gui/501/com.inkboard.team-qq` + `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.inkboard.team-qq.plist`（只 `kickstart -k` 不会重读 plist 的 EnvironmentVariables）。这与其它 `com.inkboard.team-*` 服务的 PATH 一致。
2. **代码侧加兜底（建议同做）。** `runner/tts.mjs` 的 `ffmpeg` 改成可配置/绝对路径（如 `process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg"`，不存在再回退 `ffmpeg`），并在 voice 服务启动时预检 `edge-tts`/`ffmpeg`，缺哪个就在日志里写清；不要只在发送时失败。
3. **错误码分开。** `runner/asr.mjs` 的 `ENOENT → asr_unavailable` 是给 ASR 用的；TTS 转码失败应记 `tts_tool_missing` / `tts_transcode_failed`，并在 `qq.log` 写出具体命令。否则下次还会把 TTS 问题看成 ASR。
4. **记账补洞。** `reportVoice` 在 `audio` 为 `null` 时拿不到 provider；如果 DeepSeek 已返回音频但 ffmpeg 失败，当前 units=0。建议在 `synthesize` 失败结果里带上「已成功拿到音频的 provider / 字节数」，或按 provider 成功点先记一次 usage，再记转码失败。
5. **生图口径。** `off:image_gen=1` 时，`renderQuota` 应省略生图行，或写成「生图：当前关闭」；`get_quota` 的工具描述也不要再把「生图每日限额」当成现成能力。A 公告/后续公告在功能关闭时不要列「生图还剩多少」；等功能真正打开并有一次真实生成证据后，再单独发能力公告。
6. **安装脚本。** `scripts/install-local.py` 的 `install_node_service` 已经会写 PATH，但 qq 服务不在它的安装列表里（当前 plist 是手工/旧脚本产物）。把 qq 也纳入安装器，或至少在文档里写死 PATH 要求，避免重装后复发。
7. **回归场景。** 在 `.agent/scenarios/voice-selftest/` 固化本次真实数据：输入用这条 19 字正文和 `cfg.enabled=true`；用假 QQ `sendVoice`/`sendText`，断言 (a) 依赖齐全时产出 SILK voice 且只发一条；(b) ffmpeg 缺失时只发一条原文文字，attempt code 为 `voice:sent:text` 且日志含具体缺失命令；(c) 任何情况下都不重复发送。

## 7. 证据与查询

- D1 查询：`outbox` / `outbox_meta` / `outbox_attempts` / `settings` / `ds_usage` / `tool_calls` / `chat_decisions` / `image_gen_log` / `generated_images` / `openai_usage` / `quota_reservations`，全部 `SELECT`，`rows_written=0`。
- 本机日志：`~/.inkboard-team/qq.log`（14:36:15，两行 `tts failed`）。
- launchd：`launchctl print gui/501/com.inkboard.team-qq`（无 PATH，默认 `/usr/bin:/bin:/usr/sbin:/sbin`）。
- 命令复现：`runCommand("ffmpeg")` 在服务 PATH 下返回 `{"reason":"asr_unavailable"}`；`/opt/homebrew/bin/ffmpeg` 存在，`/usr/bin/ffmpeg` 不存在。
- 未做：未写线上 D1、未发群消息、未重试 voice outbox、未调用付费生图接口。
