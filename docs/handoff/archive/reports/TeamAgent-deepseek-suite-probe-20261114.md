# DeepSeek 全家桶应用 API 实测报告（工程师）

- 实测时间：2026-11-14 01:47–01:57 Sydney（北京时间周五 22:47–22:57，谷时）
- 实测账号：用户 Vault 里的 DeepSeek API key（同一把 key 跑通 chat / files / ASR / TTS / OCR / search / fetch；全程未打印、未落盘到仓库或报告）
- 边界：未写线上 D1、未往任何群发消息、未改 TeamAgent 仓库；临时文件在 `/Users/yanghongming/Projects/TeamAgent-deepseek-probe-tmp`，跑完已清理
- 官方依据：<https://api-docs.deepseek.com>（2026-11-13 Change Log、Models & Pricing、ASR/TTS/OCR/Search/Fetch/Files 各 guide），下文“文档值”均指这些页面

---

## 0. 结论（先看这段）

1. **ASR / TTS / OCR / Search / Fetch 五项全部真实调通**，另验证了 Files 上传 + 文档问答 + 看图，以及 `deepseek_web_search` + `deepseek_read_url` 组合调用。所有接口同一个 `https://api.deepseek.com`，同一把 Bearer key，**与现有聊天 API 的 key 通用（已验证）**。
2. **ASR 速度与本机 X-ASR 同档**：真实 21.27 秒 B 站音频，云端 1.88 秒 / 本机 2.01 秒（本机另占 526 MB 内存，云端 0）。有标准答案的 4 组合成语音上，云端字符错误率 0/0/0/0，本机 0/0/8.3%/0（本机把 “500MB” 读成“五零零 M B”）。**但单请求硬上限 120 秒 / 8 MiB，长音频不能直接替代本机 90 分钟长转写，必须切片。**
3. **TTS 可用**：24 kHz 单声道 16-bit WAV，2.88–11.48 秒音频用 1.4–2.9 秒合成；已用 `silk-wasm` 转成 QQ 语音格式（11,270 B，头部 `0x02#!SILK_V3`），再解回 WAV 与原始文件**逐字节同大小（138,284 B）**。
4. **OCR 有一个真实缺陷**：群图 #183（人像 T 恤）触发 “DO ONE” 死循环，返回 19,116 字符、`finish_reason=length`、耗时 10.7 秒，内容完全不可用。文档类（PDF 2 页）和新闻截图（#222，319 字）识别准确。**图片理解应走 `deepseek-flash` 视觉，不要走 OCR。**
5. **费用极低**：本轮全部调用按官方限时价约 **$0.0128**（≈ ¥0.09），按标价约 $0.0214。账户余额期间从 ¥161.78 降到 ¥159.15，但该 key 为全队共用、同期还有多个 DeepSeek 线程在跑，**不能把差额归到本轮**。

---

## 1. 接口清单（逐项实测确认）

| 能力 | 端点 | 请求 | 实测结果 | 文档限制 | 价格（限时 / 标价） |
|---|---|---|---|---|---|
| ASR | `POST /v1/tools/asr` | multipart `file` | ✅ 200 | 16-bit PCM WAV 或 Ogg Opus；≤8 MiB；≤120 s；单/双声道（只认左声道）；不支持流式 | $0.058 / $0.116 每小时音频 |
| TTS | `POST /v1/tools/tts` | JSON `{text, voice_id, format, filter_markdown}` | ✅ 200 | ≤10,000 计费字符；body ≤64 KiB；单次 ≤30 分钟音频；`wav`/`pcm`；音色 `stella`(女，默认)/`tide`(男)；不支持变速/断点续传 | $0.225 / $0.45 每万字符 |
| TTS 流式 | `wss://api.deepseek.com/v1/tools/tts` | WebSocket 文本帧 | ⚠️ 未测 | 60 s 无文本断开；≤30 分钟；`pcm`/`opus` | 同上 |
| OCR | `POST /v1/tools/ocr` | multipart `purpose` + `file` | ✅ 200 | PDF/DOC/DOCX/PPT/PPTX/PNG/JPEG/WebP/GIF/BMP/TIFF；≤100 MiB；≤1,000 页；≤180 s | $0.225 / 千页 |
| Search | `POST /v1/tools/search` | JSON `query,count,need_content,...` | ✅ 200 | query 1–128 字；count 1–50；QPS 100 | $0.75 / 千次成功请求 |
| Fetch | `POST /v1/tools/fetch` | JSON `url` | ✅ 200 | URL ≤8,192 字符；QPS 25（另有按域名限速） | $0.75 / 千次成功请求 |
| Files | `POST /files` | multipart `purpose` + `file` | ✅ 200 | 图片 64 MiB；文档 100 MiB；文本/表格/电子书 32 MiB；存储 25 GiB / 10,000 个 | 文档按页计费；图片/文本免费 |
| 聊天文件问答 | `POST /chat/completions` + `file` block | `file_id` | ✅ 200 | 单请求 ≤20 个文档、文本 ≤8 MiB | 模型 token 价 |
| 组合工具 | chat 请求带 `deepseek_web_search` / `deepseek_read_url` | tools 数组 | ✅ 200 | 见 Web Tools | 搜索/抓取按次 + token |

> 注意：工具类接口是 `/v1/tools/...`，聊天是 `/chat/completions`（没有 `/v1`）。把 `base_url` 直接拼 `/v1` 的客户端要分开处理。

---

## 2. ASR 实测

### 2.1 真实 22 秒 B 站音频（BV1irWP6PExT，C-7 同源）

样本只下音频（145,246 B m4a，21.27 s），未下视频；转 16 kHz 单声道 WAV（680,702 B）后调用。

| 指标 | DeepSeek ASR | 本机 X-ASR |
|---|---|---|
| 音频 | 21.2695 s | 21.2695 s |
| 墙钟耗时 | **1.877 s**（含上传 680 KB） | **2.01 s**（进程启动 + 模型加载 + 解码） |
| 纯解码 | — | 0.559 s |
| 峰值内存 | 0（云端） | 526.4 MB |
| 转写 | 我不让你买，你非买啊！你有点智商没有？你拿去饭钱去买斐济贝和蛋条。这个是，你还用蚁人？ | 我不让你买你非买啊， 你有点智商没有？ 你拿去饭钱去买斐迪贝和弹条。你还用蚁人？ |

两者高度一致，差异 3 处：`斐济贝/斐迪贝`、`蛋条/弹条`（大概率都是商品名听岔）、云端多一个“这个是，”。**没有听感 ground truth，不能判定这两个专名谁对。**

### 2.2 有标准答案的准确率（TTS 合成 → 再识别）

| 用例 | 原文 | DeepSeek CER | 本机 X-ASR CER |
|---|---|---|---|
| B（57 字中文长句） | 这次改动的核心是把语音识别从本机搬到云端……维护一套。 | **0.0000** | 0.0000 |
| C（中英混合 + 数字） | 这个 API 的 TTS 延迟大概两秒，比本机 X-ASR 慢一点，但不用占 500MB 内存。 | **0.0000** | 0.0833（“500MB”→“五零零 M B”） |
| EN（英文） | The quick brown fox… fast and cheap. | **0.0000** | 0.0000（Deepseek 大小写差异，归一化后 0） |

归一化规则：去空格与标点、转小写、字符级 Levenshtein / 参考长度。

### 2.3 格式与语言

- WAV 16 kHz 与 24 kHz 均可；**Ogg Opus（24 kbps）同样成功**，转写与 WAV 完全一致，1.622 s。
- 中英自动识别通过；文档列 21 种语言（zh/yue/en/ja/ko/de/fr/es/pt/it/ru/ar/hi/id/vi/th/tr/ms/fil/pl/hu），**只实测了中英**。
- 无 language 参数，靠音频自动判断。

### 2.4 限制与错误形态

| 场景 | HTTP | 返回 |
|---|---|---|
| mp3 输入 | 400 | `Unsupported audio format: expected 16-bit PCM WAV or Ogg Opus, mono or stereo` |
| 9 MB 文件 | 413 | `Request body exceeds 8388608 bytes` |
| 无 key | 401 | `Authentication Fails (missing key)` |
| 超过 120 s | — | 文档未给专门状态码；按 8 MiB/120 s 硬限，建议客户端先探测时长 |

**关键换算**：8 MiB 对 16 kHz 单声道 16-bit 约为 262 秒，所以 120 秒是实际瓶颈；48 kHz 双声道 WAV 只能放约 43 秒。要转写长音频必须切片（每片 ≤120 s，最好 60–90 s 留余量），再拼接。

### 2.5 能否替代本机 X-ASR

- **≤120 秒的群语音、短视频**：可以，速度快、零内存、中英混合更准。
- **B 站长音频（现有 90 分钟上限）**：不能直接替代。要么切片后并发调用（50 并发上限），要么保留本机 X-ASR。
- 费用：1 小时音频 $0.058（限时），比本机电费/内存占用划算；但切片和拼接逻辑要新写。

---

## 3. TTS 实测

### 3.1 合成结果

| 用例 | 文本 | 计费字符 | 音频时长 | 耗时 | 文件 |
|---|---|---|---|---|---|
| A-stella | 今天的进度我发群里了，你看一下。 | 30 | 2.88 s | 1.513 s | 138,284 B WAV |
| A-tide | 同上 | 30 | 2.88 s | 1.414 s | 138,284 B WAV（与 stella sha256 不同） |
| B | 这次改动的核心是把语音识别从本机搬到云端……维护一套。 | 105 | 11.48 s | 2.882 s | 551,084 B |
| C | 这个 API 的 TTS 延迟大概两秒……500MB 内存。 | 69 | 8.12 s | 2.458 s | 389,804 B |
| EN | The quick brown fox… fast and cheap. | 89 | 5.60 s | 1.981 s | 268,844 B |

- 计费口径：中文 2 字符、其他 1 字符。
- 输出：`audio/wav`，24 kHz、单声道、16-bit PCM。
- 合成速度约为音频时长的 0.25–0.53 倍，短句有 1.4 s 左右固定开销。
- `stella` 与 `tide` 同句时长、字节数相同但 sha256 不同，确认是两个不同音色，不是参数被忽略。

### 3.2 音量与削波

`ffmpeg volumedetect`：mean −18.3 ~ −21.3 dB，max −2.2 ~ −5.4 dB，**无削波、无静音**。

### 3.3 可懂度（回灌本机 X-ASR）

| 用例 | 回识别文本 | 结果 |
|---|---|---|
| A-stella | 今天的进度我发群里了， 你看一下。 | ✅ 完整 |
| B | 这次改动的核心是……维护一套。 | ✅ 完整 |
| C | 这个 A P I 的 T T S 延迟大概两秒……但不用占五零零 M B 内存。 | ✅ 语义完整（数字读法差异） |
| EN | The quick brown fox… fast and cheap. | ✅ 完整 |

**主观音质（像不像人、好不好听）没有听感，不做判断——未验证。** 客观指标只证明“可解码、可懂、不削波”。

### 3.4 QQ 语音链路（wav → silk → 回解）

QQ 官方文档（<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html>）：
- 语音消息展示支持 **silk / mp3 / wav / ogg**；富媒体上传 `file_type=3` 一栏写的是 **silk**，软限 20 MB。
- 上传拿 `file_info`，再用 `msg_type=7` + `media.file_info` 发送；`srv_send_msg=true` 可上传即发。

实测转换（`silk-wasm@3`，临时目录安装，未进仓库）：

| 步骤 | 结果 |
|---|---|
| TTS WAV 规范化（ffmpeg 重写 RIFF 头） | 138,318 B；silk-wasm 直接读流式 WAV 会报 `Main chunk length ... does not match file size`，**必须先规范化** |
| encode → silk | **11,270 B**，耗时 67 ms，头部 `0x02#!SILK_V3`，`getDuration` 2,880 ms |
| decode silk → PCM → WAV | 92,160 B PCM，回写 WAV **138,284 B**，与原始 TTS WAV 字节数完全一致，ffprobe 2.88 s / 24 kHz / 单声道 |
| mp3（备选） | 21,333 B，2.88 s，ffprobe 正常 |

**未做**：没有真的上传到 QQ、没有往群里发（任务明确禁止）。所以“QQ 服务端接受这个 silk”这一步**未验证**，只验证了文件本身是合法 SILK 且可无损回解。

### 3.5 错误与限制

| 场景 | HTTP | 返回 |
|---|---|---|
| 空文本 | 400 | `text must not be empty` |
| 超 10,000 计费字符 / 64 KiB | — | 文档限制，未压测 |
| 内容审核不通过 | 400 | `Content Exists Risk`（文档值，未构造） |

不支持变速、不支持断点续传；WebSocket 流式未测。

---

## 4. OCR 实测

### 4.1 群图 #222（1280×2844 新闻截图，206,812 B，sha256 `63c1831a…`）

`purpose=text_recognition`：**2.569 s**，1 页，319 字，`finish_reason=stop`。

识别内容与 Luna 此前读图一致：状态栏 `10:47 / 17.2 KB/s / 5G / 81`、标题「离谱！黄仁勋辞职后，第三个婚外情又曝光了」、`AI范儿`、`2026年11月13日 07:54`、`1031人`、正文（路透社、纽约时报、Kimberly Powell、第二名员工等）。末尾 `董事？` 处截断，说明图片本身正文就到那里。

`purpose=rich_layout_recognition`：**2.576 s**，830 字，带 `<｜ref｜>title<｜/ref｜><｜box｜>[[0,63,997,119]]<｜/box｜>` 这类坐标，可用于裁剪定位。

### 4.2 群图 #183（519×1271 人像，275,673 B，sha256 `08c0f314…`）——失败

`purpose=text_recognition`：**10.742 s**，1 页，`usage.output_tokens=8192`（打满），`finish_reason=length`，返回 **19,116 字符**，开头全是：

```
DO ONE DO ONE DO ONE DO ONE DO ONE DO ONE ...
```

整段基本就是 “DO ONE” 重复约 2,700 次。图里确实有 T 恤印花文字（`THE FIRST STEP` 等），但模型陷入重复循环，结果不可用。

**这是本次最重要的负面发现**：OCR 对“人像 + 大面积重复/风格化文字”的图片会退化，而且 HTTP 仍是 200，只能靠 `finish_reason=length` 和内容判断。该次仍按 1 页计费（$0.000225）。

正确路径：这类图走 `deepseek-flash` 视觉（见 §6），0.99 秒得到「戴眼镜、白 T 恤、浅色短裤、右手敬礼」，完全正确。

### 4.3 PDF（自建 2 页中文 + 英文 + 数字）

`purpose=text_recognition`：**2.403 s**，`page_count=2`，两页文本全部准确，含 `128.50`、`2026-11-14`、英文整句。

### 4.4 错误形态

| 场景 | HTTP | 返回 |
|---|---|---|
| .txt 文件 | **200**（不是 4xx） | body 是 `{"error":{"message":"Failed to recognize the file: the file format is not supported",...}}` |
| 不支持格式/加密/超页 | 200 或 400/413 | 文档列了固定 message；**接入时必须检查 body 里有没有 `error`** |
| 超 100 MiB | 413 | `file is too large: max 100 MiB` |

### 4.5 结论

- 文档、截图、扫描件：OCR 可用且便宜（$0.225/千页）。
- 人像、海报、表情包：不要用 OCR；用视觉模型。
- 单页最长 180 秒总时长；PDF 最多 1,000 页。

---

## 5. 搜索与抓取

### 5.1 Search

请求：`{"query":"DeepSeek V4.1 Flash 发布 site:api-docs.deepseek.com","count":5}`

- **0.498 s**，5 条结果，`rerank_score` 2.40–2.48，`authority` 全部 3。
- 返回 title/url/snippet/summary/date/site_name，支持 `site:`、`lang:`、`after:`、`before:`、引号精确匹配。
- `count` 只影响返回条数，不影响计费；**按成功请求计费**（空结果不计费）。
- `count=0` → 400 `'count' must be between 1 and 50`。

### 5.2 Fetch

请求 ASR 文档页：**0.228 s**，返回 2,247 字 Markdown，标题正确，正文可直接给模型。

错误形态：请求不存在的路径返回 **403 `URL access denied`**（不是文档里写的 404）。接入时按 4xx 统一处理即可。

### 5.3 组合调用（chat + 两个工具）

一条 `deepseek-flash` 请求，带 `deepseek_web_search` + `deepseek_read_url`，让它读 ASR 文档并搜发布日期：

- **5.906 s**，`usage.server_tool_use = {tool_search:3, tool_fetch:1}`，答案正确（ASR 不支持流式；V4.1 Flash 2026-09-10 发布），并给出两个来源。
- 输入 8,379 tokens（640 命中缓存）、输出 110 tokens。
- 说明“单独或组合调用”这条路是通的；工具调用和上下文拼装由服务端完成。

---

## 6. 文件输入与看图（补充验证）

| 步骤 | 结果 |
|---|---|
| 上传 2 页 PDF（`purpose=text_recognition`） | 2.374 s，返回 `file-api-f89e…`，解析完成才返回 |
| 用 `file_id` 问“第二页写了什么” | 0.806 s，回答「第二页：只有一行中文」，**完全正确**；113 输入 / 6 输出 tokens |
| 上传 #183 人像（`purpose=user_data`） | 0.746 s，返回 `file-api-5e77…` |
| 用 `file_id` 问“图中人物在做什么” | **0.992 s**，回答「戴眼镜、白 T 恤和浅色短裤的年轻男子，正举起右手在头侧敬礼」，**完全正确**；454 输入 / 28 输出 tokens |

这组对比说明：**同一张 #183，OCR 输出 19,116 字垃圾，视觉 1 秒答对。** 接入时图片走视觉、文档走 OCR/文件解析，不要混。

---

## 7. 费用估算（按官方限时价，2026-11-13 页面）

| 项目 | 用量 | 单价 | 小计 |
|---|---|---|---|
| ASR | 67.74 s 音频（5 次调用） | $0.058/小时 | $0.00109 |
| TTS | 323 计费字符（5 次合成） | $0.225/万字符 | $0.00727 |
| OCR | 5 页（2 图 + 2 页 PDF + rich layout） | $0.225/千页 | $0.00113 |
| Search | 1 次成功 | $0.75/千次 | $0.00075 |
| Fetch | 1 次成功 | $0.75/千次 | $0.00075 |
| 文件解析 | 2 页 PDF | $0.225/千页 | $0.00045 |
| 聊天 token | PDF 119 + 图 482 + 组合 8,489 | V4.1 Flash 谷时 $0.15/M 入、$0.6/M 出 | $0.00133 |
| **合计（限时价）** | | | **≈ $0.0128（¥0.09）** |
| **合计（标价）** | | 语音部分翻倍 | **≈ $0.0214（¥0.15）** |

- 余额观测：开始 ¥161.78 → 结束 ¥159.15，差 ¥2.63。**该 key 全队共用、同期多个 DeepSeek 线程在跑，差额不能归因于本轮**；上表是逐次调用按官方单价算的账。
- 免费额度：定价页未写；账户只有余额信息。**是否有免费额度未验证。**
- 谷时折扣：只有模型 token 有峰谷价（谷时半价）；**ASR/TTS/OCR/Search/Fetch 没有谷时折扣**，只有“限时 5 折”。文档已核对。

---

## 8. 已验证 / 未验证清单

### 已验证（有真实调用和原始响应）

- [x] 同一把 key 跑通 chat / files / ASR / TTS / OCR / search / fetch
- [x] ASR：真实 21.27 s B 站音频，1.877 s；WAV 16k/24k、Ogg Opus 均通过；中英自动识别；与 X-ASR 同源对比
- [x] ASR 准确率：3 组有 ground truth 的合成语音 CER 全 0；本机 X-ASR 混合数字句 CER 8.3%
- [x] ASR 错误形态：400 格式错、413 超 8 MiB、401 无 key
- [x] TTS：中英 5 次合成，24 kHz WAV，1.4–2.9 s，音量正常；两种音色确认不同
- [x] TTS 可懂度：4 段回灌本机 ASR 全部可懂
- [x] TTS → SILK：11,270 B，头部合法，解码回 WAV 与原始字节数一致；另有 mp3 备选
- [x] TTS 错误形态：空文本 400
- [x] OCR：#222 截图 319 字准确；2 页 PDF 准确；rich layout 带坐标
- [x] OCR 缺陷：#183 人像 19,116 字 “DO ONE” 死循环，`finish_reason=length`
- [x] OCR 错误形态：.txt 返回 HTTP 200 + body error
- [x] Search：0.498 s、5 条、authority 3；count=0 报 400
- [x] Fetch：0.228 s、2,247 字 Markdown；坏 URL 403
- [x] 组合调用：search 3 次 + fetch 1 次，5.9 s，答案带来源
- [x] Files：PDF 上传 + 问答；图片上传 + 视觉问答
- [x] 费用：逐次按官方单价估算

### 未验证

- [ ] TTS WebSocket 流式（`wss`）未测
- [ ] TTS 主观音质、音色偏好（无听感，不能替用户判断）
- [ ] QQ 服务端是否接受该 silk（未上传、未发群，任务禁止）
- [ ] ASR 除中英外的 19 种语言
- [ ] OCR 复杂表格、公式、竖排、手写、1,000 页大文档
- [ ] 并发/限速（ASR 50、TTS 50、OCR 15、Search 100 QPS、Fetch 25 QPS）未压测
- [ ] 内容安全审核/拒答路径未构造
- [ ] Word/PPT/Excel/EPUB 文件解析未测
- [ ] 免费额度是否存在

---

## 9. 对 TeamAgent 接入的判断（只给结论，未施工）

| 现有能力 | 建议 | 理由 |
|---|---|---|
| `runner/media.mjs` 本机 X-ASR | **短音频可换云端，长音频保留本机或切片** | 云端 1.9 s / 0 内存 / 混合中英更准；但 120 s 上限，B 站长音频要新写切片 |
| `src/voice.ts`（人格文本，不是 TTS） | TTS 可作为“读答案”独立链路 | 合成 1.4–2.9 s，silk 链路已验证；QQ 上传发送未验证 |
| `src/vision.ts` 看图 | **优先 deepseek-flash 视觉** | 同图 OCR 失败、视觉 1 s 答对；且不需要另接 OpenAI |
| V-C fetcher 网页抓取 | 可用 `/v1/tools/fetch` 替代或补充 | 0.23 s 返回 Markdown，$0.75/千次；但 403/404 行为与文档不完全一致 |
| web search 现状 | 可用 `/v1/tools/search` 或 chat 工具 | 0.5 s、authority 3；组合调用由服务端拼上下文 |

**接入前必须处理的三个坑**：
1. ASR 的 120 秒/8 MiB 上限（长音频切片）。
2. OCR 对非文档图片会退化，必须加 `finish_reason`/长度/重复检测，失败回退视觉。
3. OCR 的“HTTP 200 + body error”形态，不能只看状态码。

---

## 10. 复现命令（不含密钥）

```bash
# 环境变量：TOKEN 从安全文件读入，命令里不出现明文
TOKEN="$(cat <credential-file>)"

# ASR（16k 单声道 WAV，≤120s）
curl -s https://api.deepseek.com/v1/tools/asr \
  -H "Authorization: Bearer $TOKEN" -F file="@speech.wav"

# TTS
curl -s https://api.deepseek.com/v1/tools/tts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"今天的进度我发群里了，你看一下。","voice_id":"stella","format":"wav"}' \
  --output speech.wav

# OCR
curl -s https://api.deepseek.com/v1/tools/ocr \
  -H "Authorization: Bearer $TOKEN" \
  -F purpose="text_recognition" -F file="@document.pdf"

# Search
curl -s https://api.deepseek.com/v1/tools/search \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"DeepSeek V4.1 Flash","count":5}'

# Fetch
curl -s https://api.deepseek.com/v1/tools/fetch \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://api-docs.deepseek.com/guides/asr"}'
```

---

*报告完。所有“已验证”项均有本轮真实请求与响应；原始响应摘要见 `TeamAgent-deepseek-suite-probe-20261114-evidence.json`，临时目录已清理。*
