# DeepSeek 全家桶 · 线上真实状态（只读核对）

> 核对人：交付员 · 2026-11-14 13:50 Australia/Sydney  
> 线上版本：GitHub `origin/main` = `41db2b52ebddd4eb1f46871e9d260ef504da8dc3`（`/health.release` 同值，selfCard 构建于 `2026-11-13T23:19:26Z` = 2026-11-14 10:19 Sydney）  
> 方法：仓库代码只读检查 + Cloudflare D1 `SELECT` + `wrangler secret list`（只列名字）+ 本机 runner 文件哈希/服务状态。  
> 边界：没有写线上 D1、没有发群、没有部署、没有调用付费 API；没有打印任何密钥值。

---

## 0. 一句话结论

**不是“什么都没上”，而是“代码上了不少，线上真正跑过的很少”。**

- DeepSeek 七条链路（ASR / TTS / OCR / Search / Fetch / Vision / Chat）的代码都在 `41db2b5` 里，其中 5 条还带完整工具与配额。
- 但线上 D1 的 `ds_usage` **0 行**、`tool_calls` **0 行**；上线后群消息 **0 条**。真正有调用证据的只有 **DeepSeek 回复模型** 和 **DeepSeek 搜索**（后者还是 12:00 自动查新走的旧路径）。
- 另有四项不是“没写”，而是“写了但没打开/没钥匙”：**TTS**（DeepSeek 备用缺 runner key）、**B 站云端 ASR**（runner 无 key，media 服务未加载）、**F9 读文档**（`docread:enabled` 未设）、**F8 生图**（`OPENAI_API_KEY` 未配）。
- 真正没上线的是 **F11**；**DeepSeek OCR 读文档**没有接，`read_document` 走的是本机 Python。

---

## 1. 线上基线（证据）

| 项 | 实测值 | 说明 |
|---|---|---|
| `/health.release` | `41db2b52ebddd4eb1f46871e9d260ef504da8dc3` | 与 `origin/main` 一致 |
| `messages` | 466 行，最后 `2026-11-14 02:13:41` Sydney | V-D 10:19 上线后 **0 条** |
| `model_runs` | 504 行，最后 `2026-11-14 12:00` Sydney | 上线后仅 3 次：12:00 自动查新（2×chat + 1×voice 文案） |
| `ds_usage` | **0 行** | asr/tts/ocr/search/fetch 全部 0 |
| `tool_calls` | **0 行** | 所有 F7 额外工具（含 read_image_text / generate_image / web_search / fetch_page）0 次 |
| `outbox` | 266 sent + 1 failed；上线后 2 条 | 10:21 V-D 公告、12:00 自动查新；无 voice 行 |
| 群图片/语音 | 12 条图片附件，最后 `01:56`（上线前）；语音附件 **0**；`message_images` 0 | 上线后无图、无语音 |
| D1 开关 | 只有 `off:quote=0`、`off:sticker_collect=0`、`off:wait=0` | 没有 `off:dstools`、`off:ds_*`、`docread:enabled`、`voice:mode`、`vision:provider`、`tts:provider` |
| Worker secret 名 | `ADMIN_TOKEN`、`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`QQ_APP_ID`、`QQ_APP_SECRET`、`RUNNER_TOKEN` | `DEEPSEEK_API_KEY` **有**；`OPENAI_API_KEY` **没有** |
| 本机 runner key | `readKey({})` = 空；`DEEPSEEK_API_KEY` / `DEEPSEEK_API_KEY_FILE` 均未设；`config.json.deepseek=null` | runner 侧 DeepSeek 调用会 auth 失败 |
| 本机 media 服务 | `com.inkboard.team-media` **未加载**，无 `media.mjs` 进程 | B 站 `bili_media` 任务没有执行器 |
| runner 文件 | `cloud-asr.mjs`、`tts.mjs`、`voice-delivery.mjs`、`qq-gateway.mjs`、`media.mjs`、`deepseek-client.mjs` 与仓库哈希一致 | 本机跑的就是 41db2b5 的 runner 代码 |

> 说明：`ds_usage` 只覆盖 `callDsTool` 路径；`src/semantic.ts:310-327` 的旧 `tool("search"|"fetch")` 和 `src/vision.ts` 的 DeepSeek 视觉调用**不记账**。所以 0 行不能推出“所有 DeepSeek 调用都是 0”，下面逐项区分。

---

## 2. 逐项表（12 行）

| # | 能力 | 代码在线上？ | 开关 / 配置 | 调用证据（线上 D1 / 服务） | 真实群验证 | 结论 |
|---|---|---|---|---|---|---|
| 1 | 群语音消息云端 ASR | 是，`src/voice-asr.ts`（#44 进 main） | `off:ds_asr` / `off:dstools` 未设 = 开；Worker `DEEPSEEK_API_KEY` 有 | `ds_usage asr=0`；`message_meta` 语音附件 0；无 `voice_asr` job | 无（上线后 0 条消息） | **已上线且已打开**；从未触发 |
| 2 | B 站长音频云端 ASR | 是，`runner/cloud-asr.mjs`（本机副本同 hash） | `asr:provider` 未设 = auto；`off:ds_asr` 未设；但 runner 无 DeepSeek key，`media` 服务未加载 | `ds_usage asr=0`；12 个 `media` job：8 failed / 3 done / 1 cancelled，最后一个 09:47（上线前） | 无 | **已上线但当前不可用**；云端会 auth 失败并回退本机 X-ASR |
| 3 | TTS 语音回复 | 是，`runner/tts.mjs` + `runner/voice-delivery.mjs`（同 hash） | 配置 `voice.tts.enabled=false`，但 `src/voice.ts:79` 强制 `enabled:true`；真正开关是 `voice:mode`（未设 = auto，仅语音来源/明确要求才发）；provider auto = edge→deepseek；runner 无 key | `outbox` 中 `voice` 行 0；`outbox_meta` 含 `voice_text` 0；`ds_usage tts=0` | 无 | **已上线但默认关**；DeepSeek TTS 备用不可用，edge-tts 可用 |
| 4 | OCR 读图 | 是，`src/tools/read-image-text.ts`（#44），已注册 | `off:read_image_text` / `off:ds_ocr` 未设 = 开；Worker key 有 | `ds_usage ocr=0`；`tool_calls` 0；上线后 0 张图 | 无 | **已上线且已打开**；0 调用 |
| 5 | OCR 读文档 | **否**（DeepSeek OCR 未接文档）；本机 `read_document` 在 #41 | `docread:enabled` 未设 = 关 | 无 `docread` job；`ds_usage ocr=0` | 无 | **DeepSeek 文档 OCR 没上线**；本机读取也默认关 |
| 6 | 联网搜索 | 是，`src/tools/web-search.ts` + 旧 `src/semantic.ts:310` | `off:ds_search` 未设 = 开；Worker key 有 | `ds_usage search=0`（旧路径不记账）；`scout-2026-11-14-12` 于 12:00:44 生成，`discoveries` 有 GitHub/arXiv URL | **是**（12:00 主动查新发到群，非人工提问） | **已上线且已打开**；有真实调用 |
| 7 | 网页抓取 | 是，`src/tools/fetch-page.ts` + 旧 `tool("fetch")` | `off:ds_fetch` 未设 = 开；Worker key 有 | `ds_usage fetch=0`；`tool_calls` 0；`fetch` job 最后 02:12（上线前） | 无 | **已上线且已打开**；0 调用 |
| 8 | 看图改 DeepSeek 为主（F6P-1） | 是，`src/vision.ts`（#44） | `vision:provider` 未设 = auto；`AUTO_CHAIN = deepseek → workers`；低价值图（表情包）workers 先；Worker key 有 | `model_runs` 的 `vision` 4 次，最后 `2026-11-12 07:36`（上线前）；`image_notes=1` 旧；上线后 0 图 | 无 | **已上线且已打开**；0 调用 |
| 9 | DeepSeek 作为回复模型 | 是，`config/team.json` + `src/runtime.ts:102` | `model.name=deepseek-flash`；Worker key 有 | `model_runs` 504 次；`chat` job 500 个，最后 02:13；上线后 3 次（12:00 自动查新） | **是**（500 个 chat job；上线后只有自动查新） | **已上线且已打开**；唯一长期主力 |
| 10 | F8 生图 | 是，#44 已带进 main；`src/imagegen.ts` / `generate-image.ts` / `openai.ts` 与 `release/F8` 逐字相同 | `off:image_gen` / `off:openai` 未设 = 开；但 Worker `OPENAI_API_KEY` **未配** | `image_gen_log=0`；`generated_images=0`；`openai_usage=0` | 无 | **代码在线上但不可用**（缺 OpenAI key），不是“代码没合” |
| 11 | F11 | **否**：main 无 `migrations/0070_feature_requests.sql`，无 `feature_request` 代码 | — | `release/F11` 未合；D1 无相关表/行 | 无 | **没上线** |
| 12 | F9 读取（`read_document`） | 是，#41 进 main；文件与 `release/F9` 逐字相同 | `docread:enabled` 未设 = 关（`src/tools/read-document.ts:92-95`） | 无 `docread` job；`tool_calls` 0 | 无 | **已上线但默认关**；不是 DeepSeek（本机 Python） |

---

## 3. 三类归纳（按要求）

### 已上线且已打开

1. **DeepSeek 回复模型**：`deepseek-flash`，504 次 `model_runs`，500 个 `chat` job；上线后 12:00 仍在用。
2. **DeepSeek 搜索**：`web_search` 工具在，旧 scout 路径 12:00 真实调用成功并写进 `discoveries`；但群内 `web_search` 工具本身 0 次。
3. **群语音云端 ASR**：`src/voice-asr.ts` 已接 `worker.ts:397`，Worker key 有；只是还没有语音消息触发。
4. **OCR 读图**：`read_image_text` 已注册，开关默认开；0 次调用。
5. **看图 DeepSeek 为主**：`AUTO_CHAIN` 默认 `deepseek → workers`；0 次调用（上线后无图）。
6. **网页抓取**：`fetch_page` 开关默认开，Worker key 有；0 次调用。

> 第 3–6 项严格说是“已上线、已打开、尚无调用证据”；第 1–2 项才有线上调用证据。

### 已上线但默认关 / 不可用

1. **TTS 语音回复**：链路在，但默认只在“收到语音”或模型明确要求时发；DeepSeek TTS 只是 edge-tts 的备用，且 runner 没 key，备用实际不可用。
2. **B 站长音频云端 ASR**：代码在，但 runner 没 DeepSeek key，`media` 服务未加载；实际会回退本机 X-ASR，云端 0 次。
3. **F9 读取**：`read_document` 代码在，`docread:enabled` 未设，工具直接返回“本机文档读取端没有开启”。
4. **F8 生图**：代码在，`off:image_gen` 没关，但 `OPENAI_API_KEY` 没配，调用会 auth 失败。

### 没上线

1. **F11**：main 没有 0070 迁移、没有 feature_request 代码，release/F11 未合。
2. **DeepSeek OCR 读文档 / Files 文档问答**：代码里没有把 PDF/DOC 送到 `/v1/tools/ocr` 的路径；`read_document` 走本机 `runner/docread.py`。
3. **DeepSeek TTS 作为主路径**：没有启用；默认 edge-tts，DeepSeek 仅备用且缺 key。

---

## 4. 与 BINI 简报的三处纠正

1. **F8 不是“没在线上”**：`src/imagegen.ts`、`src/tools/generate-image.ts`、`src/openai.ts` 与 `release/F8` 头 `fa6ab58` 逐字相同（`git diff` 为空），代码已随 #44 进 main。真正的问题是 **`OPENAI_API_KEY` 没配**，所以业务上不可用。
2. **F9 读取也不是“没在线上”**：`src/tools/read-document.ts`、`runner/docread.py` 与 `release/F9` 逐字相同，代码在 #41 进 main。真正的问题是 **`docread:enabled` 没设**，默认关。
3. **F11 才是真没上线**：main 没有 `0070_feature_requests.sql`，也没有 `feature_request` 代码。

---

## 5. 两个会误导判断的旧文案

- `src/self-card.generated.ts:297` 说“云端 DeepSeek /v1/tools/asr 通道已实现……但还没有调用方接入”——**已过期**。`src/worker.ts:20` 已 import `enqueueVoiceJobs` / `runVoiceCloudJob`，`worker.ts:397` 在入站媒体里调用。
- `src/self-card.generated.ts:372` 说 TTS“还没接进群里的实际发送流程，目前不会主动发语音”——**已过期**。`runner/qq-gateway.mjs:179` 已在网关循环里调用 `processVoiceOutbox`，`runner/voice-delivery.mjs` 再调 `voiceReply`。
- 这两条很可能就是用户“感觉什么都没上”的来源；建议在下一版重新生成 self-card。

---

## 6. 证据与查询（可复现）

### 6.1 版本

```bash
git -C /Users/yanghongming/Projects/.worktrees/TeamAgent-V-D-release rev-parse HEAD
# 41db2b52ebddd4eb1f46871e9d260ef504da8dc3
git -C ... rev-parse origin/main
# 41db2b52ebddd4eb1f46871e9d260ef504da8dc3
curl -sS https://inkboard-team.inkboard-server.workers.dev/health
# {"ok":true,...,"release":"41db2b52...","selfCard":{"commit":"41db2b52...","built_at":"2026-11-13T23:19:26.113Z"}}
```

### 6.2 D1 只读查询

```sql
SELECT purpose,status,error_kind,COUNT(*) AS n
FROM ds_usage GROUP BY purpose,status,error_kind;
-- 0 行

SELECT COUNT(*) AS n FROM tool_calls;
-- 0

SELECT COUNT(*) AS n, MAX(ts) AS last_ts FROM messages;
-- 466 / 2026-11-13T23:13:41+08:00（= 2026-11-14 02:13:41 Sydney）

SELECT COUNT(*) FROM messages WHERE ts>='2026-11-13T23:19:26Z';
-- 0

SELECT kind,effort,status,COUNT(*) AS n,MAX(created_at) AS last_ms
FROM model_runs GROUP BY kind,effort,status ORDER BY n DESC;
-- chat 21 / participation 277 / voice 142 / research 52 / memory 6 / vision 4 / plan 1 / research failed 1
-- vision 最后 2026-11-12 07:36 Sydney

SELECT key,value FROM settings
WHERE key LIKE 'off:%' OR key LIKE 'ds:%' OR key LIKE 'voice:%'
   OR key IN ('docread:enabled','vision:provider','tts:provider');
-- 只有 off:quote=0, off:sticker_collect=0, off:wait=0
```

### 6.3 密钥/开关

```bash
npx wrangler secret list --name inkboard-team
# ADMIN_TOKEN, DEEPSEEK_API_KEY, GITHUB_TOKEN, QQ_APP_ID, QQ_APP_SECRET, RUNNER_TOKEN
# 没有 OPENAI_API_KEY

node --input-type=module -e "import {readKey} from './runner/deepseek-client.mjs'; console.log(readKey({})?'yes':'no')"
# no
```

### 6.4 runner 文件一致性

```text
SAME cloud-asr.mjs
SAME tts.mjs
SAME voice-delivery.mjs
SAME qq-gateway.mjs
SAME media.mjs
SAME deepseek-client.mjs
```

### 6.5 本机服务

```text
qq: running
fetch: running
runner: running
media: not loaded
utility: running
utility-quick: running
owner: running
```

---

## 7. 建议（只列，未改动）

| 优先级 | 建议 | 理由 |
|---|---|---|
| P1 | 给 runner 配 DeepSeek key（`DEEPSEEK_API_KEY_FILE` 或 `config.deepseek.key_file`），并加载 `com.inkboard.team-media` | 否则 B 站云端 ASR 永远 401 回退本机，TTS 的 DeepSeek 备用也不可用 |
| P1 | 明确 `asr:provider`：若要云端就修 key/media；若要本机就设 `local`，不要再对外称“云端 ASR 已上” | 现状是“代码在、云端没跑” |
| P2 | 重新生成 self-card，修正 ASR/TTS 两条旧文案 | 当前自述会让用户以为功能没接 |
| P2 | 统一 search/fetch 记账：把 `src/semantic.ts:310` 旧路径接到 `callDsTool` | 否则 `ds_usage` 永远看不到 scout 的搜索 |
| P2 | F8：配 `OPENAI_API_KEY` 或把 `generate_image` 从工具表隐藏 | 现在工具在、调用必 auth 失败 |
| P2 | F9：若要让群读文档，设 `docread:enabled=1` 并确认 runner docread 依赖 | 现在工具固定返回“没有开启” |
| P3 | 文档 OCR：目前 DeepSeek OCR 只接图片，扫描版 PDF 没有云端 OCR | 与“OCR 读图读文档”预期有差距 |

---

## 8. 未验证/局限

- 没有在真实群里发任何消息来触发语音/图片/文档；所有“0 调用”是线上 D1 与 job 表的事实，不是功能不可用的推断。
- 没有调用付费 API 做新的端到端验证；DeepSeek 五项 API 的可达性来自 2026-11-14 01:47–01:57 的直连探测报告（`TeamAgent-deepseek-suite-probe-20261114.md`），不是本次线上 bot 调用。
- `ds_usage` 与 `tool_calls` 不覆盖旧 `semantic.tool()` 搜索/抓取和 `vision.ts` 视觉调用；已在表中分别注明。
- `media` 服务的“未加载”是本机 launchd 状态；如果它是被有意停用（例如 B 站视频改走 `utility.py` 本地 X-ASR），则“云端 ASR”更应标为未启用，而不是待触发。

---

*文件路径：`/Users/yanghongming/Projects/.agent/releases/trip1/ds-live-state.md`*
