# TeamAgent × DeepSeek「全家桶应用 API」调研

> 调研员（DeepSeek） · 2026-11-14 02:05 Australia/Sydney（2026-11-13 23:05 北京，谷时）  
> 范围：DeepSeek 2026-11-13 上线的应用 API（OCR / ASR / TTS / 文件输入 / 联网搜索 / 组合调用），对照 TeamAgent 现状，给主备路径和 QQ 语音链路。  
> 方法：只读官方文档、官方 `chat-demo` 源码、QQ 官方文档、本机 QQ SDK、TeamAgent `F8-0` 工作区；另做两个本地最小实验。没有改 TeamAgent 仓库，没有向 QQ 群发消息，没有调用付费 API。  
> 标记：✅ 已实测或已由官方源码确认；◐ 官方文档明确、但未跑真实请求；❓ 未验证/官方没写。

---

## 0. 结论（先看这 12 条）

1. **这不是一个「聚合接口」。** 2026-11-13 官方开放的是两层能力：  
   - 聊天接口里的服务端工具：`deepseek_web_search`、`deepseek_read_url`、文件输入、`safety_check`、`title`；  
   - 5 个独立接口：`/v1/tools/asr`、`/v1/tools/tts`、`/v1/tools/ocr`、`/v1/tools/search`、`/v1/tools/fetch`，外加 Files API。  
   ASR / TTS / OCR 不在 chat 请求里自动跑，要客户端自己串。

2. **同一个 key、同一个 base URL、同一个账户余额。** 所有接口都是 `Authorization: Bearer <DeepSeek API Key>`；同账户下多个 key 共享 Files。[官方 Files 文档](https://api-docs.deepseek.com/guides/files_api/) 明确写了 “all API keys under the same account share them”。

3. **ASR 只能补短音频，不能替本机 X-ASR 的 B 站长音频。** 单次 WAV/Ogg Opus、≤8 MiB、≤120 秒；只返回整段 `text` 和 `duration_ms`，没有分段/时间戳，也不支持流式。TeamAgent 的 B 站转写要 90 分钟和 `[mm:ss]` 分段，DeepSeek ASR 直接替不了。

4. **TTS 只有 2 个音色、10 个语种；HTTP 输出 wav/pcm（WS 另有 opus 裸包）。** `stella`（女，默认）/ `tide`（男）；没有语速、音高、SSML、情感参数。官方 demo 只用 `format:"pcm"`，24 kHz 单声道 16-bit 小端。  
   对 TeamAgent 来说，edge-tts 仍更免费、音色更多、可调语速；DeepSeek TTS 的价值是「云端、可 streaming、不依赖本机 edge-tts 进程」。

5. **OCR 是这次最值得接的能力。** PDF/Word/PPT/图片，单文件 100 MiB、1000 页、180 秒总时限，$0.225/千页；返回页级文本，还保留 `<ref>`/`<box>` 坐标，能定位版面。TeamAgent 现在的 `pypdf` 只能抽文本层，扫描件/图片没有 OCR，这是真空白。

6. **File Parsing 和 OCR 不是一回事。** File Parsing 是先把文件传到 Files API，上传时解析，拿 `file_id` 放进 chat 上下文，模型可以直接问答；`rich_layout_recognition` 还会把图表裁出来给模型看。OCR 是无状态识别，不存文件、不进 chat。两者同价（$0.225/千页），按场景选。

7. **Search / Fetch 不是新东西，TeamAgent 已经接了。** `src/semantic.ts:306-327` 已经在调 `https://api.deepseek.com/v1/tools/search|fetch`；`src/tools/news-search.ts:10` 也把 DeepSeek Search 作为 Google/Bing RSS 之后的后备。这次新增的是「服务端 web tools」和配套的引用/深搜协议，不是从零接 Search。

8. **`deepseek-flash` 原生视觉，单图 ≤1024 tokens。** 没有独立 vision endpoint；用 chat 的 `image_url`/`file_id`。单图 32 MiB（inline/URL）、64 MiB（file_id），单请求最多 600 张。  
   这可以替 TeamAgent 现在 Workers AI 的 `@cf/meta/llama-3.2-11b-vision-instruct`；贴纸/低价值图仍可留免费 Workers AI。

9. **组合调用 = 同一次 chat 里带 file/image + web tools；不是 ASR+OCR+TTS 一次完成。** 典型链路仍是：ASR 转文字 → chat（可带文件、可联网）→ TTS 合成。  
   `deepseek_web_search`/`deepseek_read_url` 会忽略 `temperature`、`top_p` 等参数；`tool_choice` 不能强制点名这两个工具。

10. **QQ 官方语音只收 SILK。** 富媒体上传 `file_type=3` 的格式要求写的是「语音：silk」；发送用 `msg_type=7` + `media.file_info`。WAV/MP3/AMR 不在官方要求里。  
    当前 TeamAgent 的 `runner/tts.mjs` 产出 24 kHz WAV，`voiceReply` 直接 `bot.sendVoice({localPath: wav})`；SDK 1.0.5 的 `sendVoice` 不做转码，按文档会在 QQ 侧失败（本次未发群实测）。

11. **TeamAgent 的出站语音现在根本没接上。** `runner/tts.mjs:216` 的 `voiceReply` 只有 `test/tts.test.mjs` 调用；`runner/delivery.mjs`、`runner/qq-gateway.mjs`、`src/worker.ts` 都没有 TTS 调用点，配置里也没有 `voice` 开关。  
    所以“每次回复发语音”第一步不是换 DeepSeek TTS，而是补：策略 → 合成 → SILK → 发送 → 失败回文字 这条生产链路。

12. **推荐顺序：OCR 先接；TTS 先修链路（edge-tts 主 / DeepSeek 备）；Vision 用 DeepSeek 主 / Workers AI 备 / Luna 难例；ASR 长音频留本机；Search/Fetch 保持现状；生图留 OpenAI。**  
    理由和逐项判断见 §3、§4。

---

## 1. 官方真实接口清单

### 1.1 ASR（语音转文字）

| 项 | 内容 |
|---|---|
| Endpoint | `POST https://api.deepseek.com/v1/tools/asr` |
| 认证 | `Authorization: Bearer <API key>` |
| Content-Type | `multipart/form-data` |
| 请求字段 | `file`：音频文件，必填 |
| 格式 | 16-bit PCM WAV 或 Ogg Opus，按文件内容识别；WAV 支持 8k/16k/22.05k/24k/32k/44.1k/48k Hz |
| 声道 | 单声道或立体声；立体声只识别左声道 |
| 大小/时长 | ≤8 MiB；≤120 秒；上传须在 10 分钟内完成 |
| 语种 | 21 种：中文 `zh`、粤语 `yue`、英语 `en`、日语、韩语、德语、法语、西班牙语、葡萄牙语、意大利语、俄语、阿拉伯语、印地语、印尼语、越南语、泰语、土耳其语、马来语、菲律宾语、波兰语、匈牙利语 |
| 语言参数 | 没有；自动检测 |
| 流式 | 不支持；整段上传，整段返回 |
| 响应 | `{"request_id":"...","text":"...","duration_ms":3200}` |
| 错误 | 400 格式不对/缺 file；408 上传超 10 分钟；413 >8 MiB；429 并发超限；503 忙；504 识别超时 |
| 计费 | 按音频秒数，不足 1 秒按 1 秒；$0.116/小时（限时 5 折 $0.058） |
| 并发 | 每账户最多 50 个进行中的请求 |

来源：[ASR guide](https://api-docs.deepseek.com/guides/asr/)、[ASR API](https://api-docs.deepseek.com/api/asr/)。

**关键限制（对 TeamAgent）**：没有 segment/timestamp；没有 `language` 参数；没有热词/标点控制；120 秒硬上限。`runner/media.mjs:157-158` 现在把 ASR 结果拼成 `[0:12] 文本`，依赖 segment 的 `start/end`，DeepSeek ASR 的响应里没有这些字段。

---

### 1.2 TTS（文字转语音）

| 项 | 内容 |
|---|---|
| HTTP | `POST https://api.deepseek.com/v1/tools/tts` |
| WebSocket | `wss://api.deepseek.com/v1/tools/tts` |
| 认证 | `Authorization: Bearer <API key>`；WS 也支持 `Sec-WebSocket-Protocol: tts, bearer.<API key>` |
| 请求体 | `{"text":"...","voice_id":"stella 或 tide","format":"wav 或 pcm","filter_markdown":true}` |
| 音色 | `stella` 女，默认；`tide` 男 |
| 语种 | 中文、粤语、英语、日语、韩语、马来语、阿拉伯语、印尼语、泰语、越南语；自动检测 |
| 输出 | `wav` 默认 `audio/wav`；`pcm` 为 24 kHz 单声道 16-bit 小端裸 PCM，`Content-Type: audio/pcm` |
| 文本上限 | 10,000 个「计费字符」；请求体 ≤64 KiB；一次请求最多 30 分钟音频 |
| 计费字符 | 中文汉字算 2 个字符；其他字母/数字/空格算 1 个 |
| WS 协议 | 发 `{"event":"text","text":"..."}`，最后 `{"event":"finish_text"}`；音频是二进制帧；结束是 `{"event":"finish","code":"success 或错误码","message":"..."}` |
| WS 限制 | 60 秒没有新文本就结束；单会话 ≤30 分钟；≤10,000 计费字符/64 KiB |
| 不支持 | 语速控制、恢复中断的请求、SSML/音高/情感 |
| 错误 | 400 无可读文本或内容审核（`Content Exists Risk`）；429 并发；503 忙；504 超时 |
| 计费 | $0.45/万字符（限时 5 折 $0.225） |
| 并发 | 每账户最多 50 个进行中请求 |

来源：[TTS guide](https://api-docs.deepseek.com/guides/tts/)、[TTS API](https://api-docs.deepseek.com/api/tts/)、官方 demo [`src/services/api/speech.ts`](https://github.com/deepseek-ai/chat-demo/blob/main/src/services/api/speech.ts)。

**官方 demo 的实证**：`TTS_SAMPLE_RATE = 24000`；`synthesize()` 固定 `format:'pcm'`、`filter_markdown:true`；`readAloud.ts` 直接把响应体当 16-bit LE PCM 流式排程播放。这比只看文档更硬。

---

### 1.3 OCR（文档/图片文字识别）

| 项 | 内容 |
|---|---|
| Endpoint | `POST https://api.deepseek.com/v1/tools/ocr` |
| 认证 | `Authorization: Bearer <API key>` |
| Content-Type | `multipart/form-data` |
| 请求字段 | `file`（必填，带文件名）；`purpose`（必填：`text_recognition` 或 `rich_layout_recognition`） |
| 支持格式 | PDF、Word（DOC/DOCX）、PowerPoint（PPT/PPTX）、图片（PNG/JPEG/WebP/GIF/BMP/TIFF），按实际内容识别 |
| 大小/页数 | ≤100 MiB；≤1000 页 |
| 时间 | 上传 ≤120 秒，中途停顿 ≤30 秒；从开始上传到结果 ≤180 秒 |
| 响应 | `{"id":"ocr-...","object":"ocr.result","created":...,"purpose":"...","page_count":2,"pages":[{"index":0,"text":"...","finish_reason":"stop"}],"usage":{...}}` |
| 页文本 | 原始模型输出，不清理；保留 `<ref>标题</ref><box>[[x1,y1,x2,y2]]</box>` 这类坐标 token（0–1000 归一化） |
| `finish_reason` | `stop` 完整；`length` 该页被截断 |
| 计费 | 按成功识别的页数，$0.225/千页；失败/超时不计费 |
| 并发 | 每账户最多 15 个进行中的识别，和 chat 分开计数 |
| 注意 | 一旦识别开始，HTTP 已是 200；失败会在 body 里返回 `error` 对象，必须检查；客户端断开不会取消识别，仍可能计费 |

来源：[OCR guide](https://api-docs.deepseek.com/guides/ocr/)、[OCR API](https://api-docs.deepseek.com/api/ocr/)。

**语种/准确率**：❓ 官方 OCR 文档没有列支持语种，也没有公布中文/英文准确率；本次没有 key，未实测。不要从“DeepSeek 中文好”推断 OCR 一定好。

---

### 1.4 文件输入：Files API + File Parsing

**上传**：`POST https://api.deepseek.com/files`，`multipart/form-data`，字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | 是 | 文件 |
| `purpose` | 是 | `user_data` / `text_recognition` / `rich_layout_recognition` |
| `expires_after[anchor]` | 否 | 只能是 `created_at`，和 `seconds` 一起用 |
| `expires_after[seconds]` | 否 | 3600–2592000（1 小时–30 天）；不传则永久保存 |

响应：`{"id":"file-api-...","object":"file","bytes":...,"created_at":...,"filename":"...","purpose":"...","expires_at":...}`。

| purpose | 适用文件 | 模型拿到什么 |
|---|---|---|
| `user_data` | 图片（JPEG/PNG/GIF/WebP）；纯文本（txt/md/csv/json/源码）；表格（XLSX/XLS）；电子书（EPUB/MOBI） | 图片可当图引用；文本/表格/电子书转 Markdown 进上下文 |
| `text_recognition` | PDF/Word/PPT/图片（PNG/JPEG/WebP/GIF/BMP/TIFF） | 只拿文字，图表/照片丢掉 |
| `rich_layout_recognition` | 同上 | 文字 + 自动裁出的图表，按原位置给模型 |

**引用方式**：

- Chat Completions：`{"type":"file","file_id":"file-api-..."}`  
- Responses：`{"type":"input_file","file_id":"file-api-..."}`  
- Messages：`{"type":"document","source":{"type":"file","file_id":"..."}}`，并带 `anthropic-beta: files-api-2025-04-14`

**限制**：

- 文档上传：≤100 MiB、≤1000 页；上传 ≤120 秒；解析 ≤120 秒；每账户 15 个进行中的文档上传（和 OCR 分开计数）。
- 请求内最多引用 20 个文档；文档文本合计 ≤8 MiB；重复引用同一个 `file_id` 分别计数。
- 图片：inline/URL ≤32 MiB；`file_id` ≤64 MiB；单请求 ≤600 张；请求体 ≤48 MiB；图片总大小 ≤64 MiB（不含 file_id）/≤200 MiB（含 file_id）。
- Files 存储：每用户 ≤25 GiB、≤10,000 个文件；文件名 ≤512 字节；原文件和解析结果都不能下载。
- 上传时解析；客户端断开仍会跑完，成功就存储并计费；失败不存储不计费。
- 文档不能当图片引用（会 400）；图片可以当 `user_data` 引用。

来源：[File Parsing](https://api-docs.deepseek.com/guides/document_parsing/)、[Files API](https://api-docs.deepseek.com/guides/files_api/)、[Vision](https://api-docs.deepseek.com/guides/vision/)。

**官方 demo 的实证**：`src/services/attachments.ts` 把 PDF/DOC/PPT/PPTX 映射到 `rich_layout_recognition`，其余非图片映射到 `user_data`；单文件上限 64 MB，`user_data` 32 MB；最多 50 个文件、3 个并发上传；`purpose` 必须排在 `file` 前面。可直接照搬。

---

### 1.5 Search（联网搜索）

| 项 | 内容 |
|---|---|
| Endpoint | `POST https://api.deepseek.com/v1/tools/search` |
| 请求 | `{"query":"...","count":10,"ori_question":"...","localization":"","need_content":false}` |
| query | 1–128 个 Unicode 字符，不能全空白；支持 `site:`、`-site:`、`-`、`-"..."`、`"..."`、`lang:`、`after:`、`before:` |
| count | 1–50，默认 10 |
| `ori_question` | 1–128 字符，帮助理解原始问题 |
| `localization` | 可选 IP，用于本地化结果 |
| `need_content` | true 时返回 `content`；false 时 `content` 为空字符串 |
| 响应 | `{"results":[{"rerank_score":2.4,"title":"...","url":"...","snippet":"...","summary":"...","content":"...","site_name":"...","site_icon":"...","date":"...","authority":3}]}` |
| 质量字段 | `rerank_score` 0–3，≥1.5 视为高质量；`authority` 0–4，≥3 为高权威；`-1` 未知 |
| 计费 | 每次成功请求 $0.75/千次；空结果/失败不计费；`count` 不影响单价 |
| 限速 | 每账户 100 QPS |

来源：[Search & Fetch guide](https://api-docs.deepseek.com/guides/search/)、[Search API](https://api-docs.deepseek.com/api/search/)。

---

### 1.6 Fetch（网页抓取）

| 项 | 内容 |
|---|---|
| Endpoint | `POST https://api.deepseek.com/v1/tools/fetch` |
| 请求 | `{"url":"https://..."}` |
| URL | ≤8192 字符；必须是 http/https、有 host、不能带用户名/密码 |
| 响应 | `{"title":"...","content":"# Markdown..."}` |
| 计费 | 每次成功抓到内容 $0.75/千次；失败/超时/空内容不计费 |
| 限速 | 每账户 25 QPS，另有每域名 QPS 限制 |
| 错误 | 403 安全策略拒绝；404 抓不到可用内容；408 读 body 超时；413 body 太大；429 QPS；504 下游超时 |

来源：[Search & Fetch guide](https://api-docs.deepseek.com/guides/search/)、[Fetch API](https://api-docs.deepseek.com/api/fetch/)。

---

### 1.7 聊天里的服务端 web tools（和独立 Search/Fetch 不同）

在 Messages / Responses / Chat Completions 里声明：

```json
"tools": [
  {"type": "deepseek_web_search"},
  {"type": "deepseek_read_url"}
]
```

- **Web search**（thinking 关闭）：模型判断要不要搜，可以一次发多个 query，回答带 citations；每次搜索产生 `server_tool_use` + `web_search_tool_result`。
- **Deep thinking search**（thinking 开启）：模型在多步推理里搜索、打开页面、在页面里找文字，最多约 20 次工具调用；`kind` 为 `deep_search`。
- **URL reading**（`deepseek_read_url`）：只检查最后一条 user message 里的 URL，最多前 10 个不同 URL；模型决定读哪些；每页产生 `server_tool_use` + `web_fetch_tool_result`；页面正文不直接返回，而是加密在 `signature` 里，下一轮要把 block 原样传回。
- **图片搜索**：是 `deepseek_web_search` 的一部分；user message 里有图时可按图搜；`kind` 为 `image_search`/`deep_image_search`。
- **不能做的**：`tool_choice` 不能点名 `deepseek_web_search`/`deepseek_read_url`（400）；`allowed_domains`/`blocked_domains`/`user_location` 不支持；不能和 OpenAI 的 `web_search` 等其它 server tool 混用；声明这些工具后 `temperature`、`top_p`、`frequency_penalty` 等会被忽略。
- **计费**：按 search query 数、image search 次数、成功 fetch 页数计；和独立 Search/Fetch 同价；`usage.server_tool_use` 里的 `web_search_requests`/`web_fetch_requests` 是展示数，不是计费数，计费看 `tool_search`/`tool_fetch`/`tool_image_search`。

来源：[Web Tools](https://api-docs.deepseek.com/guides/web_tools/)、[Build a Chatbot](https://api-docs.deepseek.com/guides/build_a_chatbot/)。

**对 TeamAgent 的判断**：服务端工具适合“让模型自己多步查资料”，但正文在 `signature` 里、要原样回传，和 TeamAgent 现在把搜索结果当 untrusted 文本存 D1 的做法不同。不要为了“用上新 API”把现有可控链路换掉；可作为研究型任务的第二条路径。

---

### 1.8 模型、key、组合调用

| 项 | 内容 |
|---|---|
| 模型名 | `deepseek-flash`（V4.1-Flash-1017；支持视觉、1M context、384K max output）；`deepseek-v4-pro`（V4-Pro-0813；不支持视觉） |
| 旧名 | `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可用，但都路由到 V4.1-Flash-1017，按 Flash 计费 |
| key | 所有 endpoint 同一把 `Authorization: Bearer`；同账户 key 共享 Files |
| 组合 | 同一 chat 请求可以带 `file_id`/图片 + `deepseek_web_search`/`deepseek_read_url`；ASR/TTS/OCR 仍是独立请求，客户端编排 |
| 没有的能力 | 图像生成、视频生成、音乐生成、实时语音对话、embeddings、独立 rerank 接口（截至 2026-11-14 文档） |

**组合调用的一个请求形状**（文档各部分都支持；这个“同时带文件 + 两个 web tool”的具体组合我未跑真实请求，标 ◐）：

```json
POST /chat/completions
{
  "model": "deepseek-flash",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "file", "file_id": "file-api-xxxxxxxx"},
      {"type": "text", "text": "结合这份文件和最新公开资料，列出差异。"}
    ]
  }],
  "tools": [
    {"type": "deepseek_web_search"},
    {"type": "deepseek_read_url"}
  ]
}
```

---

## 2. 价格、限额、谷时与免费额度

### 2.1 工具价格

官方英文页用 USD，中文页用 CNY；下表两边都列，**不是汇率换算**，是官方两套标价。

| 能力 | 英文价 | 中文价 | 备注 |
|---|---:|---:|---|
| ASR | $0.116/小时（限时 5 折 $0.058） | 0.78 元/小时（限时 0.39 元） | 按秒计费，不足 1 秒按 1 秒 |
| TTS | $0.45/万字符（限时 $0.225） | 3 元/万字符（限时 1.5 元） | 中文汉字算 2 字符 |
| OCR | $0.225/千页 | 1.5 元/千页 | 失败/超时不计费 |
| File Parsing | $0.225/千页 | 1.5 元/千页 | 上传时计费；chat 里再按 input tokens 计 |
| Search | $0.75/千次 | 5 元/千次 | 成功且非空才计费 |
| Fetch | $0.75/千次 | 5 元/千次 | 成功抓到内容才计费 |
| Files 存储 | 免费 | 免费 | ≤25 GiB、≤10,000 文件 |

来源：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)、[中文价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

### 2.2 聊天模型价格（USD / 1M tokens）

| 模型 | 缓存命中（谷/峰） | 缓存未命中（谷/峰） | 输出（谷/峰） | 并发 |
|---|---:|---:|---:|---:|
| `deepseek-flash` | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 | 2500 |
| `deepseek-v4-pro` | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 | 500 |

- 谷时是峰时的 5 折；峰时：北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00；其余全部谷时，包括周末和节假日全天。
- **ASR/TTS 的 5 折是“限时折扣”，不是谷时折扣**；官方没有写截止日期。OCR/Search/Fetch 没有谷时折扣。
- **免费额度**：❓ 官方文档没有写新用户赠送金额/免费额度；只写了扣费时优先用「赠送余额」（granted balance）。Files API 免费。不要假设有免费额度。

来源：[Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit/)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)。

### 2.3 并发/限速/超时

| 接口 | 限制 |
|---|---|
| Chat `deepseek-flash` | 2500 并发/账户 |
| Chat `deepseek-v4-pro` | 500 并发/账户 |
| ASR | 50 个进行中请求/账户 |
| TTS | 50 个进行中请求/账户 |
| OCR | 15 个进行中识别/账户，和 chat 分开 |
| File Parsing 上传 | 15 个进行中文档上传/账户，和 OCR 分开 |
| Search | 100 QPS/账户 |
| Fetch | 25 QPS/账户 + 每域名 QPS |
| ASR 上传 | 10 分钟 |
| OCR | 上传 120 秒，总 180 秒 |
| 文档解析 | 上传 120 秒，解析 120 秒 |
| TTS | 单请求 ≤30 分钟音频；WS 空闲 60 秒结束 |

### 2.4 成本示例（按官方价估算，不含 chat tokens）

| 场景 | 估算 |
|---|---:|
| 300 张图/天，`deepseek-flash` 视觉，每图 ≤1024 input + 400 output | 谷时约 $0.12/天，峰时约 $0.24/天 |
| 100 条语音回复/天，每条 300 个汉字（600 计费字符） | 限时 $1.35/天；原价 $2.70/天 |
| 同上，每条 80 个汉字（160 计费字符） | 限时 $0.36/天；原价 $0.72/天 |
| 100 页扫描件 OCR | $0.0225 |
| 100 次 Search/天 | $0.075/天 |
| 90 分钟 B 站音频，按 2 分钟切 45 段 | 限时 $0.087；原价 $0.174（另加约 180 MB 上传） |
| 本机 X-ASR 90 分钟 | 0 元，约 4.5 分钟（rtf 0.05 估算） |

> 以上是算术估算，不是账单；实际按秒/页/次计费，失败/空结果不计费。

---

## 3. 对照 TeamAgent 现状：逐项判断

> 基线：`/Users/yanghongming/Projects/.worktrees/TeamAgent-F8-0`，`5210fa2`（2026-11-14 01:55 +1100，含刚提交的 `src/openai.ts` 共享通道），工作区干净。只读。

### 3.1 出站语音 / TTS：**可补充，但当前链路是断的**

**现状**

- `src/voice.ts` 是**人格/发言文本**（`VOICE` prompt + `fragments`/`enqueueVoice` 写 outbox），不是 TTS；真正的语音合成在 `runner/tts.mjs`。判断“语音能不能发”不要看 `src/voice.ts`。
- `runner/tts.mjs`：edge-tts CLI（`zh-CN-XiaoxiaoNeural`）→ MP3 → ffmpeg 24 kHz 单声道 16-bit WAV → 缓存 1 小时/200 文件/50 MB；失败回文字。见 `runner/tts.mjs:1-18`、`:146-210`。
- `src/tts-policy.ts`：只有 `care`/`banter`、≤300 字、无代码块/链接才发语音；`HARD_MAX_CHARS=300`。
- `runner/tts.mjs:216-242`：`voiceReply()` 合成后 `bot.sendVoice({localPath: wav})`；发送失败回文字。
- **生产调用点：0。** 全仓只有 `test/tts.test.mjs:16` 和 `:46` 调用 `voiceReply`；`runner/delivery.mjs`、`runner/qq-gateway.mjs`、`src/worker.ts` 都没有 TTS 调用；`config/team.json` 没有 `voice` 配置块。
- **QQ 格式：当前发的是 WAV。** 官方要求 silk；SDK 1.0.5 的 `sendVoice` 只是把文件字节 base64 后 `file_type=3` 上传，没有转码（`dist/protocol/api/media.js:61-70`）。本机 `silk-wasm` 未安装（`~/.inkboard-team/sdk/node_modules` 里没有）。所以按文档，即使现在把 `voiceReply` 接上，QQ 也会拒。

**判断**

| 方案 | 结论 |
|---|---|
| DeepSeek TTS 直接替 edge-tts | **可补充，不建议现在替换**。DeepSeek 只有 2 音色、无语速/SSML、按字符收费；edge-tts 免费、音色多、可调 rate，且本机已装好。DeepSeek 的优势是云端 streaming 和不依赖本机 Python 进程。 |
| 先用 edge-tts，再补 DeepSeek 备选 | **推荐**。保持免费主路径；DeepSeek TTS 作为 edge-tts 失败/本机不可用时的备选。 |
| 只换 TTS、不改 QQ 格式 | **不可行**。必须加 WAV/PCM → SILK 转换。 |

**成本提醒**：300 汉字 = 600 计费字符；按限时价 $0.225/万字符 ≈ **$0.0135/条**。100 条/天 ≈ $1.35/天（约 $40/月）。如果每条限 80 汉字，约 $0.0036/条，100 条/天 ≈ $0.36/天。

---

### 3.2 入站语音 / ASR：**不可替换（长音频），可补充（短音频）**

**现状**

- QQ 语音消息本身已带 `asr_refer_text`（QQ 内置语音识别）。`src/inbound.ts:61-62` 直接把它放进 `Media.asr`，`src/view.ts:91-93` 渲染成「语音转写：…」。**聊天里的语音输入不需要再跑 ASR。**
- B 站音轨：`runner/media.mjs:12` 默认 `max_minutes:90`、`rtf:0.05`、`mem_cap_mb:1300`；`:65` ffmpeg 转 16 kHz 单声道 WAV；`:142-159` 最多 90 分钟，调 `runAsr`，`:157` 拼 `[mm:ss]` 文本。
- `runner/asr.mjs:59-66`：本机 X-ASR，模型 `sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03`，内存上限 1300 MB，超时按音频长度算。

**判断**

| 场景 | 结论 |
|---|---|
| QQ 语音消息 | **不需要 DeepSeek ASR**。QQ 已给转写，随消息到达、不额外花钱。 |
| B 站 90 分钟音轨 | **不可替换**。DeepSeek ASR 120 秒上限 + 无时间戳；要替换必须切 45 段、丢句子级时间戳、上传约 180 MB，成本 $0.087（限时）且质量未验证。本机 X-ASR 免费、约 4.5 分钟、已有 `[mm:ss]`。 |
| 非 QQ 的短音频（≤120 秒，mp3/amr/silk 等） | **可补充**。先本地 ffmpeg 转 16-bit PCM WAV/Ogg Opus，再调 DeepSeek ASR；适合本机不在线/不想跑模型时。 |
| 长音频应急上云 | **可做但要改数据结构**。按 110 秒切块，块首时间戳由客户端补；`AsrNote` 的 `segments` 要允许“块级时间戳 + 无句级时间戳”。不是 drop-in。 |

**准确率**：❓ 官方没有公布中文/英文 WER；本次没有 key，未实测。用户现有 X-ASR 自述“更好更快”，在没有 A/B 数据前，默认保留本机为主。

---

### 3.3 文档 / OCR：**最值得接，可补充本地 docread**

**现状**

- `src/tools/read-document.ts`：只读本群附件；`MAX_DOC_BYTES=20 MiB`；`MAX_RESULT_TEXT=24000` 字符；支持 PDF/DOCX/XLSX/XLSM/XLS/PPTX/CSV/TSV。
- `runner/docread.py`：`MAX_TEXT=60000`、`MAX_BYTES=50 MiB`、ZIP ≤500 成员/200 MiB；用 `pypdf`、`python-docx`、`python-pptx`、`openpyxl`/`xlrd` 抽文本；**没有 OCR**，扫描 PDF 只能得到空文本。
- 路径 jail 在 `inputs/`，文档不上云。

**判断**

| 场景 | 结论 |
|---|---|
| 有文本层的 PDF/Office | **本地 docread 继续做主**。免费、私密、快；20 MiB 工具上限够日常。 |
| 扫描 PDF / 图片型文档 / 手机拍照的合同 | **DeepSeek OCR 做主**。这是本地没有的能力；100 MiB/1000 页，$0.225/千页，页级文本 + 坐标。 |
| 需要模型看图表/排版 | **File Parsing `rich_layout_recognition`**。OCR 只给文字，图表会丢；File Parsing 会把图表裁出来给模型。 |
| 需要反复问同一份文档 | **File Parsing + file_id**。上传一次，后续 chat 引用；文件默认永久存，建议设 `expires_after`（1 小时–30 天）。 |
| 私密文档 | **本地优先**。DeepSeek OCR/File Parsing 都要上传到云端；Files 默认永久保存，同账户 key 共享。 |

**建议接法**：在 `src/tools/read-document.ts` 的本地抽取返回空文本/`empty` 时，走 OCR fallback；保留本地结果优先。OCR 返回的 `pages[].text` 直接拼进现有 `text` 字段，`MAX_RESULT_TEXT` 截断；`<ref>/<box>` 可先去掉或保留给模型定位。这样不用改工具协议，也不用把文档塞进 chat。

---

### 3.4 图片 / Vision：**可替换 Workers AI，贴纸留免费**

**现状**

- `src/vision.ts:377-426`：`workersAiVision()` 调 `e.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", ...)`；`visionModel()` 在 `src/runtime.ts:45-57`。
- 限制：图片 ≤5 MB（`:389`）、10 秒超时、`max_tokens:400`（`:394`）；输出 JSON `{desc,text,tags,meme}`。
- 配置：`config/team.json` `vision.enabled=true`、`daily_cap=300`、`turn_max=3`、`turn_deadline_ms=12000`。
- 结果按 sha 缓存在 D1；贴纸/表情包也走这条。

**判断**

| 场景 | 结论 |
|---|---|
| 聊天里的截图、图表、文档照片 | **DeepSeek `deepseek-flash` 视觉做主**。原生多模态、中文场景更强、单图 ≤1024 tokens，成本约 $0.0004–0.0008/图（含 400 output），300 图/天约 $0.12–0.24。 |
| 贴纸/表情包粗分类 | **Workers AI 免费做主**。现有 300/天免费额度、5 MB、400 tokens 够用；DeepSeek 视觉做备选。 |
| 难 OCR（书法、模糊小字、复杂排版） | **OpenAI Luna `gpt-5.6-luna` 做备选**。团队 2026-11-14 实测 11 张图 + 6 帧，强 OCR；但风格化书法仍会错（375 的「汝人」三次读错）。报告：`/Users/yanghongming/Projects/TeamAgent-luna-vision-probe-20261114.md`。 |
| 纯文字图片 | **DeepSeek OCR** 比视觉更合适：按页返回原文 + 坐标，不经过 chat 生成，便宜且不编。 |

**接法**：`src/vision.ts` 的 `VisionProvider` 接口不变，新增 `deepseekVision(e)`：读 bytes → `data:${mime};base64,...` → `POST https://api.deepseek.com/chat/completions`，`model:"deepseek-flash"`，prompt 沿用现有 JSON 约束，`max_tokens:400`；错误映射到 `VisionFault`（超时/额度/拒绝/不支持）。`visionProvider()` 按配置选 DeepSeek → Workers AI → null；贴纸可单独走 Workers AI。

---

### 3.5 联网搜索：**已经接了，保持；可选升级服务端深搜**

**现状**

- `src/semantic.ts:306-327`：`tool(e,"search"|"fetch",...)` 直接 POST `https://api.deepseek.com/v1/tools/{name}`，Bearer `e.DEEPSEEK_API_KEY`，45 秒超时，1 MB 上限。
- `src/semantic.ts:1269-1276`：模型工具 `search_web` → `count:4, need_content:true`，结果用 `untrusted()` 包起来。
- `src/tools/news-search.ts:10-14`：Google News RSS → Bing News RSS → DeepSeek Search；`:223-228` 后备 `count:limit, need_content:false`；每轮最多 2 次、最多 10 条、10 分钟缓存。
- 所以 DeepSeek Search/Fetch **不是新接入**；这次只是官方把 Search/Fetch 正式开放（2026-10-17 已开放，11-13 又加了 web tools）。

**判断**

| 场景 | 结论 |
|---|---|
| 新闻/时效 | **Google/Bing RSS 继续做主**（免费）；DeepSeek Search 后备。 |
| 通用技术检索 | **DeepSeek Search 做主**（已经是）；可加 `ori_question`、`authority>=2`、`rerank_score>=1.5` 过滤。 |
| 多步深搜 | **可选 `deepseek_web_search` + thinking**。模型自己搜/开页/找文字，最多 ~20 次调用，带 citations；但正文在 `signature` 里，存储/回传比现在的纯文本复杂。 |
| 现有 `search_web` | **不要换掉**。现在这条链路可控、可缓存、可标 untrusted；服务端工具作为研究型任务的第二路径。 |

**成本**：$0.75/千次 = $0.00075/次；TeamAgent 每天几十次，成本可忽略。

---

### 3.6 网页抓取：**已经接了 Jina + DeepSeek Fetch 兜底**

**现状**：`src/semantic.ts:472-507` `readUrl()`：

1. GitHub 仓库根链接 → `raw.githubusercontent.com/.../README.md`，512 KB；
2. `r.jina.ai/<url>`，研究 8 秒/内联 4 秒，512 KB；
3. 研究场景且剩余 ≥300 ms → DeepSeek `/v1/tools/fetch`，512 KB；
4. 都失败按 `ReadReason` 返回（risk/timeout/not_found/login_required/empty/unsupported）。

> 如果「V-C fetcher」指的是 F7 的 `read_web` 调研链路，通用网页抓取就是上面这条；`runner/fetcher.mjs` 是 B 站专用的（Cookie、WBI 签名、SSRF 白名单、音轨），不是通用网页 fetcher，别混。

**判断**

| 场景 | 结论 |
|---|---|
| 普通公开网页 | **Jina 先、DeepSeek Fetch 后**，保持。Jina 免费；DeepSeek Fetch 更稳但按次收费。 |
| B 站/需要登录/反爬 | **本机 `runner/fetcher.mjs` 继续做主**。DeepSeek Fetch 是通用抓取，不带 B 站 Cookie/WBI/风控处理，替不了。 |
| GitHub README | 现有 raw 直读继续；DeepSeek Fetch 不需要。 |
| 失败语义 | 现有 `readUrl` 的 reason 映射比 DeepSeek 的 403/404 更细，保留。 |

---

### 3.7 OpenAI Luna / 生图：**底座已提交，业务调用还没接**

更准确地说：

- `src/openai.ts`（`5210fa2` 已提交，426 行）：固定 host `https://api.openai.com`、只允许 `/v1/...`、全局日预算 `$3`（`OPENAI_DAILY_CAP_MICRO_USD=3_000_000`）、记账表 `openai_usage`、配额预留 `quota_reservations`、错误分类（refused/budget/quota/timeout/upstream/auth/unsupported/denied）。
- **业务调用点：0。** 全仓 `callOpenAi` 只在 `src/openai.ts` 定义、`test/openai.test.mjs` 测试；没有 vision/image_gen 的生产调用。测试 fixture 用的是 `gpt-image-1`，不是生产模型选择。
- **Luna 实测**：`gpt-5.6-luna` 视觉可用（`/v1/chat/completions` + `image_url`），11 图 + 6 帧，最终 17 项 $0.020585（按公开价上限估算）；96 个模型 ID 里有 `gpt-5.6-luna`、`gpt-6-luna`；速率窗口 5,000 RPM / 2,000,000 TPM / 50,000 input images。报告：`/Users/yanghongming/Projects/TeamAgent-luna-vision-probe-20261114.md`。
- **生图**：账号模型列表里有 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.6-flare`、`gpt-image-2.6-sunburst` 等；没有生产调用、没有价格/质量对比。DeepSeek 全家桶**没有图像生成**，所以生图仍应留 OpenAI。

**判断**：`src/openai.ts` 可以直接作为 Luna/生图的统一入口；下一步是加 `vision`/`image_gen` 的 caller 和预算估算，而不是再写一套 HTTP。DeepSeek 视觉接入后，Luna 只做难例，避免 $3/天预算被日常图片吃掉。

---

### 3.8 DeepSeek 没有对应能力，别硬替

- 图像生成 / 编辑：没有；留 OpenAI `gpt-image-*`。
- 视频/音乐生成：没有。
- 实时语音对话（双向流）：ASR 不支持流式，TTS 只支持文本流式合成；不能做实时通话。
- Embeddings / rerank 独立接口：文档没有；TeamAgent 现有向量/记忆链路不要动。
- QQ 语音上传：DeepSeek 只产音频，不负责发 QQ；QQ 仍走官方富媒体接口。

---

## 4. 主备路径推荐（免费优先 + 中英文质量优先）

| 能力 | 主路径 | 备路径 | 取舍 |
|---|---|---|---|
| QQ 语音入站 | QQ `asr_refer_text`（免费） | 本机 X-ASR（若 QQ 没给转写） | 不花 ASR 钱，零延迟 |
| 短音频（≤120s，非 QQ） | 本机 X-ASR（免费） | DeepSeek ASR（云端） | 本机优先；云端只在离线/应急 |
| B 站长音频（≤90min） | 本机 X-ASR（免费，带时间戳） | 分段 DeepSeek ASR（应急） | 不丢时间戳、不上传 180MB |
| TTS | edge-tts（免费，多音色，可调 rate） | DeepSeek TTS（2 音色，云端） | 免费/灵活优先；DeepSeek 做备选 |
| 扫描件/图片 OCR | DeepSeek OCR（$0.225/千页） | 本机 pypdf（有文本层时）/ Luna 逐页（难例） | 本地没有 OCR，这是真补洞 |
| 文档问答（含图表） | 本地 docread（文本） | DeepSeek File Parsing `rich_layout_recognition` | 私密/便宜优先；图表题上云 |
| 聊天图片理解 | DeepSeek `deepseek-flash` vision | Workers AI（贴纸/免费）→ Luna（难例） | 质量优先；贴纸不烧钱 |
| 新闻搜索 | Google News RSS → Bing News RSS | DeepSeek Search | 免费 RSS 先 |
| 通用搜索 | DeepSeek Search | 服务端 `deepseek_web_search` 深搜 | 现有链路可控；深搜做第二路径 |
| 网页抓取 | Jina Reader | DeepSeek Fetch | 免费先；失败再付费 |
| 生图 | OpenAI `gpt-image-*` | 无（DeepSeek 没有） | 保留现有 |
| 图片/文档复用 | Files API（免费存储） | D1/本地缓存 | 需要跨请求复用时才上 |

### 4.1 如果目标是“把语音识别搬到云上”

可以，但要分两种：

1. **QQ 语音消息**：本来就不需要 ASR，QQ 已转写；搬到云上没有收益。
2. **B 站/长音频**：DeepSeek ASR 单次 120 秒、无时间戳；要上云必须分段。建议做一个 `cloud-asr` 开关：
   - 按 110 秒切，约 50 段（90 分钟），8–10 并发（避免 50 并发上限和 429）；
   - 每段记录 `offset`，拼成 `[0:00] 段文本`；
   - 失败段落回退本机 X-ASR；
   - 成本约 $0.087/90 分钟（限时价），上传约 180 MB；
   - 质量未验证，先拿 3 个 B 站视频 A/B，再决定是否默认。

**结论**：不要一次性把 B 站 ASR 全切云；先做“短音频云、长音频本机”的混合，符合用户“X-ASR 更好更快”的现状。

### 4.2 如果目标是“每次回复发语音”

先修链路，再谈 provider：

1. 在 Worker/outbox 里加一个 `voice` 意图（或 `voice_text` 字段），由 `src/tts-policy.ts` 决定；
2. 本地 runner 在投递时调用 `voiceReply`；
3. `voiceReply` 里把 WAV/PCM 转 SILK，再 `sendVoice`；
4. 失败回文字，不重试（避免重复消息）；
5. 加每日条数/字符预算，防 TTS 账单。

推荐 provider：**edge-tts 主**（免费、音色多、已有），**DeepSeek TTS 备**（云端、2 音色、按字符计费）。如果实测 DeepSeek 音质明显更好，再反过来，但要把每条限制在 80–120 汉字。

---

## 5. QQ 语音格式与 TTS→QQ 转换链路

### 5.1 QQ 官方要求（✅ 文档 + 本地 SDK 源码）

QQ 机器人富媒体上传：

- 单聊：`POST /v2/users/{openid}/files`
- 群聊：`POST /v2/groups/{group_openid}/files`
- 请求：`file_type`（1 图片、2 视频、3 语音、4 文件）、`url`、`srv_send_msg`、`file_data`（文档标“暂未支持”）
- **格式要求：图片 png/jpg；视频 mp4；语音 silk**。
- 发送：`POST /v2/groups/{group_openid}/messages`，`msg_type=7`，`media:{"file_info":"..."}`，`content` 要给一个值（官方说填空格），`msg_seq` 防重。

来源：[QQ 富媒体消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)、[QQ 发送消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)。

**注意矛盾**：官方文档把 `url` 标为必填、`file_data` 标“暂未支持”；本机 SDK 1.0.5 的 `media.js` 实际用 `file_data` base64 上传。两者必有一个过时。当前 TeamAgent 走 SDK 的 base64 路径；上线前必须用一条真实语音验证；失败就改用 `url`（把 silk 放临时 HTTPS 地址，例如 Worker/R2 一次性链接）。

**语音时长**：❓ 官方文档没有写语音消息时长上限；客户端常见 60 秒限制，未核实。建议先按 ≤60 秒、≤300 汉字做。

### 5.2 当前 TeamAgent 链路与断点

```
文本
  → runner/tts.mjs synthesize()
      edge-tts → speech.mp3
      ffmpeg -ac 1 -ar 24000 -c:a pcm_s16le → speech.wav
  → voiceReply()
      bot.sendVoice({localPath: speech.wav})
  → SDK MediaApi.uploadMedia()
      fs.readFile(wav) → base64
      POST /v2/groups/{group_openid}/files
      { file_type: 3, file_data: "<base64 wav>", srv_send_msg: false }
  → QQ 侧要求 silk → 预期 304082/304083（upload/convert media info fail）
```

断点有三个：

1. **没有生产调用点**：`voiceReply` 只在测试里被调用；
2. **没有 SILK 转换**：WAV 直接上传；
3. **没有语音配置/预算**：`config/team.json` 没有 voice 开关。

### 5.3 推荐链路（最小改动）

```
文本
  → (可选) DeepSeek TTS: POST /v1/tools/tts {format:"pcm"} → 24k mono s16le PCM
     或 edge-tts: mp3 → ffmpeg -f s16le -ar 24000 -ac 1 → PCM
  → silk-wasm encode(pcm, 24000) → .silk
  → bot.sendVoice({buffer: silk})  // SDK 原样 base64, file_type=3
  → QQ /files → file_info → /messages msg_type=7
```

**代码（DeepSeek TTS + silk-wasm，Node 侧）**：

```js
import { encode } from "silk-wasm";

export async function deepseekTtsToSilk(text, { key, voice = "stella" } = {}) {
  const r = await fetch("https://api.deepseek.com/v1/tools/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voice,      // stella | tide
      format: "pcm",        // 24 kHz, mono, s16le
      filter_markdown: true,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  const pcm = new Uint8Array(await r.arrayBuffer());
  const { data } = await encode(pcm, 24000);
  return Buffer.from(data); // 直接给 bot.sendVoice({ buffer })
}
```

**edge-tts 版本**（复用现有 `runner/tts.mjs` 的 WAV，再转 PCM）：

```js
import { encode } from "silk-wasm";
import { execFileSync } from "node:child_process";

function wavToPcm24k(wavPath) {
  return execFileSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", wavPath,
    "-f", "s16le", "-ar", "24000", "-ac", "1", "-acodec", "pcm_s16le",
    "pipe:1",
  ], { maxBuffer: 50 * 1024 * 1024 });
}

export async function wavToSilk(wavPath) {
  const pcm = wavToPcm24k(wavPath);
  const { data } = await encode(new Uint8Array(pcm), 24000);
  return Buffer.from(data);
}
```

**如果直接用 QQ SDK 的现成函数**（`@tencent-connect/qqbot-nodejs/protocol` 导出）：

```js
import { audioFileToSilkBase64 } from "@tencent-connect/qqbot-nodejs/protocol";

// 第二个参数只允许 .silk，强制走 ffmpeg → PCM → silk-wasm；
// 不传时 .wav/.mp3 会被“直接上传”，那是 QQ 文档不认的。
const b64 = await audioFileToSilkBase64(wavPath, [".silk"]);
await bot.sendVoice(target, { fileData: b64 });
```

`audioFileToSilkBase64` 在 `dist/protocol/utils/audio.js:173`；它内部用 `ffmpegToPCM` + `pcmToSilk`，需要 `silk-wasm` 已安装。SDK 的 `sendVoice` 本身不调用它，所以必须显式调。

### 5.4 本次本地实验（✅ 真跑了）

**实验 1：1 秒正弦波**

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ar 24000 -ac 1 -c:a pcm_s16le test.wav
ffmpeg -i test.wav -f s16le -ar 24000 -ac 1 -acodec pcm_s16le test.pcm
node -e "import('silk-wasm').then(async ({encode,decode,isSilk})=>{...})"
```

结果：PCM 48,000 bytes → SILK 3,616 bytes，`isSilk=true`，解码 1,040 ms。✅

**实验 2：edge-tts 真中文语音 → SILK → 解码 → 本机 X-ASR**

```bash
~/.inkboard-team/venv/bin/edge-tts --voice zh-CN-XiaoxiaoNeural \
  --text "这是一条语音链路测试，确认采样率和编码都正确。" --write-media edge.mp3
ffmpeg -i edge.mp3 -vn -ac 1 -ar 24000 -c:a pcm_s16le edge.wav
ffmpeg -i edge.wav -f s16le -ar 24000 -ac 1 -acodec pcm_s16le edge.pcm
# silk-wasm encode → edge.silk
# silk-wasm decode → decoded.pcm → ffmpeg -ar 16000 → decoded16.wav
~/.inkboard-team/xasr-venv/bin/python runner/xasr_transcribe.py decoded16.wav --model-dir "$MODEL"
```

结果：

- edge-tts 输出 29,952 bytes MP3；ffmpeg 24k 单声道 WAV 239,694 bytes；PCM 239,616 bytes。
- SILK 19,313 bytes，`isSilk=true`，解码 5,040 ms。
- 本机 X-ASR 转写：`这是一条语音链路测试， 确认采样率和编码都正确。`（与原文一致，仅多一个空格）。

结论：**edge-tts → 24k mono WAV → silk-wasm → SILK → 解码回 WAV → X-ASR 能正确识别**。这证明格式转换链路是通的；**没有证明 QQ 上传/播放**（未发群）。

### 5.5 QQ 语音链路未验证的部分

- ❓ QQ `/files` 是否接受 `file_data` base64（文档说暂未支持，SDK 在用）。
- ❓ QQ 是否接受 24k SILK（文档只写 silk，没写采样率；SDK 用 24k）。
- ❓ QQ 语音时长上限（官方没写）。
- ❓ `silk-wasm` 在 Cloudflare Worker 运行时是否可用（本机 Node 26 验证；包说明支持 Node/browser，Worker 未测）。
- ❓ 发送后的客户端播放效果/音量/停顿（没有发群，不能试听）。

**上线前最小验证**：用一条 5 秒 SILK，`srv_send_msg=false` 上传拿 `file_info`，再发一条 `msg_type=7` 到测试群；失败则改 `url` 方式。这个动作会往群里发消息，按团队公约需要用户批准，不能由调研员直接做。

---

## 6. 可以直接借用的文件和函数

### 6.1 DeepSeek 官方 demo（MIT，v0.1.1，commit `5d5dd75`）

仓库：<https://github.com/deepseek-ai/chat-demo>

| 文件 | 函数/内容 | 借来做什么 |
|---|---|---|
| `src/services/api/speech.ts` | `transcribe(apiKey, audio, signal)`；`synthesize(apiKey, text, voice, signal)`；`TTS_SAMPLE_RATE=24000` | ASR 用 `FormData` 传 `file`；TTS 固定 `format:'pcm'`、`filter_markdown:true`，直接拿裸 PCM |
| `src/services/speech/recorder.ts` | `SAMPLE_RATE=16000`、`MAX_SECONDS=120`、`encodeWav(chunks,length)` | 浏览器录音转 16k 单声道 16-bit WAV；QQ 场景不需要，但可复用到网页入口 |
| `src/services/speech/readAloud.ts` | `toFloat32(bytes)`、PCM 流式排程 | 如果做网页试听/朗读，直接照搬 |
| `src/services/attachments.ts` | `getUploadPurpose(name,isImage)`、`MAX_SIZE_MB=64`、`MAX_USER_DATA_SIZE_MB=32`、`MAX_COUNT=50`、`MAX_CONCURRENT=3` | Files API 的 purpose/大小/并发规则，直接照搬 |
| `src/services/api/client.ts` | `uploadFile(apiKey,file,purpose,signal)`，`purpose` 在 `file` 前，Anthropic beta header | Files 上传的字段顺序/错误处理 |
| `src/services/chat/reply.ts` | `toFileBlocks()` / `toUserParam()` | 文件 block + text 的顺序：先文件后文本 |

### 6.2 SILK 转换

| 来源 | 函数 | 说明 |
|---|---|---|
| `silk-wasm@3.7.1`（MIT，Tencent silk encoder for Node/browser） | `encode(pcm, 24000)`、`decode(silk, 24000)`、`isSilk(bytes)` | 本次实验验证；SILK 19,313 bytes / 5 秒；解码回 PCM 正常 |
| QQ SDK `dist/protocol/utils/audio.js` | `audioFileToSilkBase64(filePath, [".silk"])` | 内部 ffmpeg→PCM→silk-wasm；第二个参数必须只给 `.silk`，否则 `.wav/.mp3` 会“直接上传” |
| QQ SDK `dist/protocol/utils/audio.js` | `pcmToSilk(pcmBuffer, sampleRate)` | 如果已经拿到 DeepSeek TTS 的 PCM，直接调这个，不用 ffmpeg |
| QQ SDK `dist/protocol/utils/audio.js` | `convertSilkToWav(inputPath, outputDir)` | 入站/调试：SILK → WAV，便于本机 ASR |
| QQ SDK `dist/QQBot.js` | `sendVoice(target, {buffer / fileData / localPath})` | 只上传，不转码；传 SILK |

### 6.3 TeamAgent 里要改的文件

| 文件 | 现状 | 改法 |
|---|---|---|
| `runner/tts.mjs` | edge-tts → WAV；`voiceReply` 发 WAV | 加 `wavToSilk()`；`voiceReply` 发 `{buffer:silk}`；保留失败回文字 |
| `src/tts-policy.ts` | 300 字、care/banter、无链接/代码 | 可保留；加每日条数/字符预算；TTS 成本高时把 300 降到 120 |
| `runner/delivery.mjs` / `runner/qq-gateway.mjs` | 没有 voice 调用 | 在投递 outbox 时按 `voice` 标记调用 `voiceReply`；或用独立 `voice_jobs` 表 |
| `src/worker.ts` | 没有 TTS 调用 | 在生成回复后写 `voice` 意图；不要直接在 Worker 里发 QQ |
| `src/vision.ts` | Workers AI only | 加 `deepseekVision(e)` provider；`visionProvider()` 按配置选 |
| `src/tools/read-document.ts` | 本地抽取；空文本返回 empty | 空文本/扫描件时走 OCR fallback；保留本地优先 |
| `src/semantic.ts` | 已接 Search/Fetch | 不用改；可选加 `ori_question`/authority 过滤 |
| `src/tools/news-search.ts` | 已接 DeepSeek Search 后备 | 不用改 |
| `src/openai.ts` | 共享 OpenAI 通道，$3/天，无 caller | 加 `vision`/`image_gen` caller；Luna 只做难例 |

### 6.4 不要借的

- 不要把 DeepSeek TTS 的 `format` 写成 `mp3`/`ogg`/`silk`：HTTP 只支持 `wav`/`pcm`；WS 支持 `opus`，但那是无容器 Opus packet，不能直接当 Ogg 文件。
- 不要把 WAV/MP3 直接传 QQ `file_type=3`：官方要求 silk；SDK 的 `.wav/.mp3` “直接上传”是代码行为，不是文档保证。
- 不要用 DeepSeek ASR 直接替 `mediajobs.ts` 的 `AsrNote`：没有 `start/end/chunks`，会破坏 `[mm:ss]` 和覆盖范围。
- 不要指望 OCR 保留图表：要图表用 `rich_layout_recognition` 或 Files API。
- 不要用 `deepseek_web_search` 时还依赖 `temperature`/`top_p`：会被忽略。
- 不要为了“组合调用”把 ASR/TTS/OCR 塞进一个 chat 请求：它们不是 chat 工具。

---

## 7. 已验证 / 未验证清单

### 7.1 已验证

| 项 | 证据 |
|---|---|
| 5 个工具 endpoint 真实存在 | 2026-11-14 01:50 Sydney 无 key POST `/v1/tools/asr`、`/v1/tools/tts`、`/v1/tools/ocr`、`/v1/tools/search`、`/v1/tools/fetch`，全部 401 `authentication_error`；`/v1/models` 同样 401。说明路由存在，鉴权生效；不代表业务成功 |
| 官方文档的接口/限额/价格 | 直接读 `api-docs.deepseek.com` 的 `.md` 源（2026-11-13 更新页 + 各 guide/api 页） |
| 官方 demo 的 TTS/ASR/文件用法 | clone `deepseek-ai/chat-demo` `5d5dd75`，读 `speech.ts`/`recorder.ts`/`readAloud.ts`/`attachments.ts`；MIT |
| WAV→SILK | `silk-wasm@3.7.1`，1 秒 24k 单声道 WAV → 3,616 bytes SILK，`isSilk=true`，解码 1,040 ms |
| edge-tts→SILK→X-ASR | 5 秒中文，edge-tts MP3 → 24k WAV → 19,313 bytes SILK → 解码 5,040 ms → 本机 X-ASR 转写与原文一致 |
| TeamAgent 现状 | 读 `F8-0` `5210fa2` 的 `src/voice.ts`、`runner/tts.mjs`、`src/tts-policy.ts`、`src/vision.ts`、`runner/media.mjs`、`src/inbound.ts`、`src/semantic.ts`、`src/tools/news-search.ts`、`src/tools/read-document.ts`、`runner/docread.py`、`src/openai.ts`；`git status` 干净 |
| TTS 未接线 | 全仓 grep：`voiceReply` 只出现在 `runner/tts.mjs` 定义和 `test/tts.test.mjs`；worker/delivery/qq-gateway 无调用；`config/team.json` 无 voice 块 |
| QQ 只收 silk | 官方 rich-media 文档 `file_type=3` 格式要求；SDK `media.js` 原样 base64 上传、不转码；本机 `silk-wasm` 未安装 |

### 7.2 未验证

| 项 | 原因 / 下一步 |
|---|---|
| ASR 中文/英文准确率 | 没有 DeepSeek key，未跑真实音频；官方无 WER。建议拿 3 条真实群语音 + 3 条 B 站片段 A/B |
| TTS 音质/自然度 | 没有试听样本；官方只列 2 音色。建议 20 句中英混合 A/B（edge-tts vs DeepSeek） |
| OCR 中文/英文准确率、语种 | 官方没列语种/准确率；没有 key。建议 10 页扫描合同 + 5 张截图实测 |
| File Parsing 图表裁切质量 | 未上传真实 PDF；官方说“不保证每张图都裁到” |
| QQ `file_data` base64 是否可用 | 文档说暂未支持，SDK 在用；未发群。需一条 5 秒 SILK 上传测试 |
| QQ 语音时长/采样率 | 官方没写；SDK 用 24k；需真机播放确认 |
| `silk-wasm` 在 Cloudflare Worker | 本机 Node 26 验证；Worker 运行时未测 |
| 服务端 `deepseek_web_search` + 文件同请求 | 文档各部分支持，未跑组合；建议先用一个公开 PDF 测 |
| DeepSeek TTS WAV 采样率 | 文档只明确 PCM 24k；WAV 未写。官方 demo 只用 PCM，建议我们也用 PCM |
| 免费额度 | 官方文档没写金额；未登录 platform 核对账单 |
| 生图/ Luna 生产接入 | `src/openai.ts` 有底座，无 caller；Luna 只做过探测，未接 TeamAgent |

---

## 8. 风险与边界

1. **隐私/留存**：OCR 会把文件传到 DeepSeek 处理；File Parsing 会存进 Files（默认永久，除非设 `expires_after`）；ASR/TTS 的音频/文本也会上传。群里的合同、身份证、私聊截图不要默认上云。  
2. **成本**：TTS 按字符、OCR 按页、Search/Fetch 按次；没有公开免费额度。必须加每日预算/条数上限。  
3. **限流**：OCR 15 并发、ASR/TTS 50、Search 100 QPS、Fetch 25 QPS；批量 OCR/ASR 要限并发，不要一次打满。  
4. **QQ 格式**：官方只认 silk；`file_data` 与 `url` 的文档矛盾；上线前必须真机验证。  
5. **内容审核**：TTS 可能 400 `Content Exists Risk`；`safety_check` 可选但不是自动的；公开群要自己承担审核义务。  
6. **新接口稳定性**：2026-11-13 刚上线，文档/价格/限额可能变；限时 5 折没有截止日期。  
7. **模型能力**：ASR 无时间戳、TTS 无韵律控制、OCR 无语言列表、Vision 单图 1024 tokens；不要按“DeepSeek App 的完整体验”预期 API。  
8. **不要本机当服务器**：DeepSeek TTS/ASR 是 HTTP，可以在 Worker 侧调用；但 QQ 发送仍在本机 gateway，silk 转换也在本机。不要把长时间任务/大文件长期留在本机；实验文件用完清理。

---

## 9. 来源

### 官方 DeepSeek

- 更新日志（2026-11-13 全家桶发布）：<https://api-docs.deepseek.com/updates/>
- ASR 指南：<https://api-docs.deepseek.com/guides/asr/>
- ASR API：<https://api-docs.deepseek.com/api/asr/>
- TTS 指南：<https://api-docs.deepseek.com/guides/tts/>
- TTS API：<https://api-docs.deepseek.com/api/tts/>
- OCR 指南：<https://api-docs.deepseek.com/guides/ocr/>
- OCR API：<https://api-docs.deepseek.com/api/ocr/>
- Search & Fetch 指南：<https://api-docs.deepseek.com/guides/search/>
- Fetch API：<https://api-docs.deepseek.com/api/fetch/>
- File Parsing：<https://api-docs.deepseek.com/guides/document_parsing/>
- Files API：<https://api-docs.deepseek.com/guides/files_api/>
- Vision：<https://api-docs.deepseek.com/guides/vision/>
- Web Tools：<https://api-docs.deepseek.com/guides/web_tools/>
- Build a Chatbot：<https://api-docs.deepseek.com/guides/build_a_chatbot/>
- 模型与价格：<https://api-docs.deepseek.com/quick_start/pricing/>
- 中文价格：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- 限流：<https://api-docs.deepseek.com/quick_start/rate_limit/>
- 安全：<https://api-docs.deepseek.com/guides/safety/>

### 官方 demo / 第三方

- DeepSeek 官方 chat-demo（MIT，v0.1.1，`5d5dd75`）：<https://github.com/deepseek-ai/chat-demo>
- IT之家 2026-11-13 报道（价格与“全家桶”说法）：<https://m.ithome.com/html/1026960.htm>
- `silk-wasm`（MIT，3.7.1）：<https://github.com/idranme/silk-wasm>

### QQ

- QQ 富媒体消息：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html>
- QQ 发送消息：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html>
- 本机 SDK：`@tencent-connect/qqbot-nodejs@1.0.5`，`dist/protocol/api/media.js`、`dist/protocol/utils/audio.js`、`dist/QQBot.js`

### TeamAgent / 本机

- 基线：`/Users/yanghongming/Projects/.worktrees/TeamAgent-F8-0` @ `5210fa2`（2026-11-14 01:55 +1100）
- 出站语音：`runner/tts.mjs:216-242`、`src/tts-policy.ts:22`
- 视觉：`src/vision.ts:377-426`、`config/team.json` `vision`
- 本机 ASR：`runner/media.mjs:12,65,142-159`、`runner/asr.mjs:59-66`
- 入站语音：`src/inbound.ts:61-62`
- 搜索/抓取：`src/semantic.ts:306-327,472-507,1269-1276`、`src/tools/news-search.ts:10-14,223-228`
- 文档：`src/tools/read-document.ts:9-11`、`runner/docread.py:27-31`
- OpenAI 通道：`src/openai.ts:9,272`、`test/openai.test.mjs:100`
- Luna 视觉实测：`/Users/yanghongming/Projects/TeamAgent-luna-vision-probe-20261114.md`
- Agent-Reach 调研（同日另一份，不在本报告范围）：`/Users/yanghongming/Projects/TeamAgent-agent-reach-survey-20261114.md`

---

## 10. 一句话交回

**先接 OCR（补扫描件空白），再修 TTS→SILK→QQ 的断链；ASR 长音频留本机 X-ASR，短音频用 DeepSeek 备；Search/Fetch 已接不用重做；Vision 用 DeepSeek 主、Workers AI/Luna 备；生图留 OpenAI。**
