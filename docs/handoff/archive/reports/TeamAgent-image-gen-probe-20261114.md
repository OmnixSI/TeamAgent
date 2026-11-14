# TeamAgent 生图能力探针报告（修正版 v4）

- 日期：2026-11-14 01:46–01:58 Sydney（北京时间 2026-11-13 22:46–22:58）；原报告落盘 01:58:58 Sydney；v2 修正版落盘 2026-11-14 02:09 Sydney；v3 修订 2026-11-14 02:12–02:14 Sydney；v4 修订 2026-11-14 02:17 Sydney（仅修跨图压缩率（§4/§6.4）与 §7.5 secret 存在性两处断言）。
- v3 只修订成本上限表述、配额 SQL 的单位参数，以及幂等/重试对「结果未知」的处理；v4 只修上述两处断言。v2/v3/v4 均未调用生图 API、未发 QQ、未改仓库、未写线上 D1。
- 执行：测试员（本机 macOS，工作目录 `/Users/yanghongming/Projects`）。
- 范围：只核对既有生图探针证据、QQ SDK 源码、TeamAgent 只读代码和 OpenAI / Cloudflare 官方文档。
- **v2/v3/v4 修正均没有**调用任何生图 API、没有向 QQ 群发消息、没有改仓库、没有写线上 D1。
- 密钥：从 Vault「OpenAI-api」取得，只以文件路径传给原探针脚本；本报告不记录路径或值。

**证据标签**（全文统一）：

- **事实**：有文件、命令输出、源码行号或官方文档原文可直接支撑。
- **推断**：由事实推得，但没有直接测量或账单确认。
- **未验证**：本次没有做，或现有证据不足以判断。

---

## 0. 逐项修正结论

| # | 修正项 | 结论 | 证据 |
|---|---|---|---|
| 1 | A3 中文 | **事实**：三处中文全部正确：「团队周报」「第 46 周 · 11 月」「周五 18:00 前提交」。多模态员已核对，本机 `read_image` 复核一致。 | `images/A3_gpt-image-2.png`；sha256 `ca09e3b7…` |
| 2 | §7.3 分片阈值 | **事实**：SDK 的 5 MiB 阈值按**源文件字节**判定，不按 base64 长度；4,607,065 B（4.39 MiB）**不会**触发分片。base64 后约 6.1 MiB 也不参与 5 MiB 判定，只受 20 MiB 一次性上传限制和 SDK 的 1.4 倍 base64 前置检查约束。 | `@tencent-connect/qqbot-nodejs/dist/QQBot.js:684`；`dist/protocol/utils/file-utils.js:11-18`；`dist/protocol/api/media.js:10-11,48-52` |
| 3 | 每人每天上限 | **提议（未实现）**：默认 3 个单位/人/日、30 个单位/群/日、100 个单位/全局/日、$3.00/日总预算；按 Australia/Sydney 00:00 重置；高清单张按 3 个单位计（即 3 张 low/medium 或 1 张 high/天），SQL 示例按 `units` 参数扣减。原子扣额和预算见 §7.4.2，DO、D1 batch 与条件 UPDATE 都未实现、未部署、未压测；$3/日不是已验证的预算上限。 | 本报告 §7.4.2；官方 IPM/TPM 表只限每分钟，不含每人每日 |
| 4 | 意图正则 | **事实**：原提案正则对用户原例「帮我生成一张一只戴墨镜的柴犬在悉尼海边的图」**匹配失败**；对 11 条直接生图请求只命中 2 条。本报告给出并实测了一版规则：11/11 正例命中、19/19 负例不误触。规则只是提案，未改仓库。 | `image-gen-probe/intent_regex_test.mjs`（exit 0）；§7.4.4 |
| 5 | b64 与发图路径 | **事实**：本次 22 次成功调用记录**全部**返回 `b64_json`，不是报告原写的 3 次；官方文档明确 GPT Image 模型总是返回 base64，`url` 不支持。**但** QQ SDK 同时支持 `file_data` 和 `url` 两种上传，QQ 上传不是唯一路径；`url` 路径未对 QQ 服务器实测。 | `final_results.json`、`sweep.json`、`params_results.json`；OpenAI API reference；`dist/protocol/api/media.js:64-68` |
| 6 | 价格与默认值 | **事实 + 冲突**：官方 GPT Image 1 mini 1024² low 标 $0.005/张，按本次 272 image tokens × $8/M 只折出 $0.0022；两种官方口径不一致，**$0.0022 不能当账单**。新默认建议用官方页未标 Deprecated 的 `gpt-image-2.5-flare` + 显式 `quality="low"`（本次实测约 $0.006/张、9.31 s）；`gpt-image-2`、`gpt-image-1.5`、`gpt-image-1-mini`、`chatgpt-image-latest` 均已 Deprecated。 | 官方 pricing / model 页；§2、§6 |
| 7 | 报告日期 | **事实**：证据文件 mtime 是 2026-11-14 01:46:40–01:57:37 Sydney，即北京时间 2026-11-13 22:46–22:58。原报告「北京时间 11-14 22:45–23:40」比真实时间晚一天，且时长多约 43 分钟；已改。 | `stat` 全目录 mtime；§8 |
| 8 | 22 张 vs 24 张 | **事实**：22 次成功**调用**，其中 P4 用 `n=2` 一次返回 2 张，所以生成 23 张图；清单第 24 个文件是 `P6_webp.webp`，没有 usage 记录。$0.78 正好等于 22 次记录的 token 折算；若 P6 是独立 medium 调用，总成本约 $0.835，不是 $0.78。 | `final_results.json`、`params_results.json`、`images_manifest.json`；§6.3 |
| 9 | Worker / 队列 / 幂等 | **事实 + 未验证**：平台侧 HTTP 请求墙钟无硬上限，cron 和 Queue consumer 各 15 min，CPU 30 s（HTTP/Queue 可调到 5 min）；TeamAgent 作业租约 11 min、`attempts<3`、Queue `max_retries=2`。真实端到端长请求、内存、排队和 429 行为未压测；发图幂等/重试状态机未实现。**结果未知（超时/5xx/崩溃）不得自动重生成，R2 无对象不能证明未生成，否则可能重复计费。** | Cloudflare 官方 limits；`src/worker.ts:425-430,804-900,2048-2057`；`wrangler.toml.example:15-30` |

### v4 复核记录（2026-11-14 02:17 Sydney）

- **① 跨图压缩率**：删除 §6.4 把 P6 与 A1 当作同一张图的表述，以及 §4 WebP 行的压缩百分比。P6（WebP，879,926 B）与 A1（PNG，1,370,911 B）是不同图，且 P6 来源无 usage 记录；跨图比较不足以证明压缩率。
- **② Secret 存在性**：§7.5 改为「这份代码副本和文档未见 `OPENAI_API_KEY` 配置；实际部署 secret 未验证」。不再断言线上 Worker 当前不存在该 secret；上线前要单独核对部署环境，缺则用 `wrangler secret put OPENAI_API_KEY` 添加。
- 其余 v3 的配额、价格、Worker 长请求、QQ 发图、幂等/重试等限制说明保持不变。

---

## 1. 环境与账号

- **事实**：`GET /v1/models` 返回 HTTP 200，共 96 个模型 ID，其中 image 类 11 个（§2）。
- **事实**：调用方式 `POST https://api.openai.com/v1/images/generations`，原探针请求超时设 300–900 s；本次 22 次成功调用未出现 429 或 5xx。
- **未验证**：账号的实际速率档位。官方 Build / Launch / Grow 档 IPM 分别为 20 / 150 / 250；3 路并发正常不能证明档位。

## 2. 账号可用的 image 模型（11 个全部实测，均为 low / 1024² / PNG）

| # | 模型 ID | 官方状态 | HTTP | 耗时 | 文件字节 | image tokens | token 折算 | 官方每张（1024² low） |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 1 | `gpt-image-2` | Deprecated | 200 | 10.54 s | 1,305,191 | 196 | $0.005970 | 未列每张价 |
| 2 | `gpt-image-1.5` | Deprecated | 200 | 7.07 s | 1,208,963 | 272（另 191 文本输出） | $0.010704 | $0.009 |
| 3 | `gpt-image-1-mini` | Deprecated | 200 | 8.42 s | 1,260,256 | 272 | $0.002212 | **$0.005** |
| 4 | `chatgpt-image-latest` | Deprecated | 200 | 7.53 s | 1,365,038 | 272（另 344 文本输出） | $0.012234 | $0.009 |
| 5 | `gpt-image-2.5-sunburst` | 未标 Deprecated | 200 | 11.20 s | 1,317,173 | 196 | $0.005970 | 未列每张价 |
| 6 | `gpt-image-2.5-flare` | 未标 Deprecated | 200 | 9.31 s | 1,311,223 | 196 | $0.005970 | 未列每张价 |
| 7 | `gpt-image-2.6-sunburst` | 未标 Deprecated | 200 | 16.66 s | 1,419,700 | 824 | $0.024810 | 未列每张价 |
| 8 | `gpt-image-2.6-flare` | 未标 Deprecated | 200 | 15.63 s | 1,342,356 | 824 | $0.024810 | 未列每张价 |
| 9 | `gpt-image-2-2026-04-21` | Deprecated（2 的快照） | 200 | 10.12 s | 1,338,618 | 196 | $0.005970 | 未列每张价 |
| 10 | `gpt-image-2.5-sunburst-2026-09-08` | 未标 Deprecated | 200 | 9.96 s | 1,283,601 | 196 | $0.005970 | 未列每张价 |
| 11 | `gpt-image-2.5-flare-2026-09-08` | 未标 Deprecated | 200 | 8.89 s | 1,263,343 | 196 | $0.005970 | 未列每张价 |

- **事实**：统一参数 `size=1024x1024, quality=low, output_format=png, n=1`；同一条中文提示词「一只小盆栽仙人掌放在窗台上，简洁背景」。11 个 ID 全部 HTTP 200。
- **事实**：`gpt-image-2`、`gpt-image-1.5`、`gpt-image-1-mini`、`chatgpt-image-latest` 在官方模型页均标 **Deprecated**；原报告只写了前两个，漏了 mini 和 chatgpt-image-latest。
- **事实**：2.5 / 2.6 的每张价格没有像 1.5 / mini 那样的固定表；官方只给 token 单价，2.5 页还明确「GPT Image 2 计算器不估算 2.5 的 token 消耗」。
- **事实**：`complexity` 参数是 2.6 的文档特性（默认 `high`）；2.5 页面没有 `complexity` 说明。原报告写成「2.5/2.6 都新增 complexity」不准确。
- **事实**：2.5 支持 `low/medium/high/xhigh/max/auto`；`gpt-image-2` 只支持 `low/medium/high`（本次 `quality=xhigh` 实测 400，与文档一致）。
- **推断**：token 折算只适合做模型间相对比较，不能直接当账单；官方每张价与 token 价存在冲突（§6.2）。

## 3. 必交样图（4 张，全部可打开）

| 编号 | 类型 | 模型 | 尺寸/质量 | 耗时 | 字节 | tokens | token 折算 | 人工核对 |
|---|---|---|---:|---:|---:|---:|---:|---|
| A1 | 中文普通提示词 | `gpt-image-2` | 1024² / medium | 32.04 s | 1,370,911 | 1,756 | $0.052875 | 橘猫、窗台、暖光、浅景深符合 |
| A2 | 中文普通提示词 | `gpt-image-2` | 1024² / medium | 39.11 s | 1,824,843 | 1,756 | $0.052885 | 雨后街道、霓虹倒影、透明伞背影符合 |
| A3 | **含中文文字海报** | `gpt-image-2` | 1024×1536 / high | 80.91 s | 1,725,237 | 5,488 | $0.165150 | 三处中文全部正确（见下） |
| A4 | 普通样图（另一模型/横版/JPEG） | `gpt-image-1.5` | 1536×1024 / medium | 13.30 s | 169,135 | 1,568 图像 + 369 文本 | $0.054096 | 拿铁拉花、木桌、翻开的书符合 |

A3 海报文字逐项核对（多模态员 + 本机 `read_image` 双人复核）：

- **事实**：标题「团队周报」正确；
- **事实**：副标题「第 46 周 · 11 月」正确；
- **事实**：底部「周五 18:00 前提交」正确；
- **事实**：中间白色线条日历图标、深蓝渐变背景、留白均符合提示词。

文件：

- `/Users/yanghongming/Projects/image-gen-probe/images/A1_gpt-image-2.png`（sha256 `211aeb78df007418…`）
- `images/A2_gpt-image-2.png`（`1b510f484477f5d2…`）
- `images/A3_gpt-image-2.png`（`ca09e3b7a09364a6…`）
- `images/A4_gpt-image-1.5.jpg`（`64e1796ab83387fd…`）
- 全量 24 个图片文件的字节/尺寸/SHA-256 见 `image-gen-probe/images_manifest.json`。

> **重要限制**：A3 的中文文字能力是在 **`gpt-image-2`（已 Deprecated）** 上验证的。官方未标 Deprecated 的 2.5 / 2.6 是否同样能把中文写对，**未验证**。如果上线要求「中文海报必须可靠」，不能直接把 A3 的结论平移到新默认模型；需要另做一次付费验收图，或明确接受用 deprecated 模型。

## 4. 参数与限制实测（`gpt-image-2` 为主）

| 测试 | 参数 | 结果 |
|---|---|---|
| 大图 | 2048×2048, medium, png | 200，35.28 s，**4,607,065 B**（4.392 MiB） |
| 高质量 | 1024×1024, high, png | 200，**91.28 s**，1,309,520 B，7,024 image tokens |
| WebP | 1024×1024, medium, webp | 200，40.9 s，**879,926 B**；P6 与 A1 是不同图，不能据此算压缩率（见下注） |
| 多图 | `gpt-image-1-mini`, `n=2`, low | 200，7.81 s，返回 2 张（1,229,281 / 1,203,486 B） |
| 3 路并发 | 3 × low 1024² | 全部 200；墙钟 27.33 s（单张 11.26 / 12.21 / 27.30 s），无 429 |
| 默认质量 | 省略 `quality`（gpt-image-2，一次） | 返回 `quality: "low"`、196 image tokens |
| 透明背景 | `background=transparent` + webp（gpt-image-2） | **400 `invalid_value`**：「Transparent background is not supported for this model.」（0.31 s 即拒绝） |
| 非法尺寸 | `1000x1000` | 400 `invalid_value`：「Width and height must both be divisible by 16.」 |
| 非法质量 | `quality=xhigh`（gpt-image-2） | 400 `invalid_value`：「The model 'gpt-image-2' does not support quality 'xhigh'.」 |
| 不存在模型 | `gpt-image-9` | 400 `invalid_value`：「The model 'gpt-image-9' does not exist.」 |

> **P6 行的来源说明**：WebP 行的 HTTP 200 / 40.9 s 来自原报告记录；`params_results.json` 没有这一条，只有 `images/P6_webp.webp` 文件。因此 40.9 s 和「200」在本报告中只能算**原报告记录**，不是本次重新核对出的机器记录；文件字节和格式是事实。

**默认质量必须改口径**：

- **事实**：本次只有一次省略 `quality` 的 gpt-image-2 调用，返回 `quality: "low"`、196 image tokens。
- **事实**：官方 API reference 写 `quality` 默认值是 **`auto`**，`auto` 会按模型自动选择最佳质量；`low/medium/high` 是显式选项。
- **结论**：不能把「省略 quality = 所有模型默认 low」写成事实。正确说法是「这一次 gpt-image-2 调用被解析成 low；官方默认是 auto，是否落到 low 取决于模型/尺寸/账号，未逐模型验证」。上线必须**显式**传 `quality`，不要依赖默认。

**尺寸规则**：

- **事实**：官方 API reference 对 2 / 2.5 支持任意 `WIDTHxHEIGHT`，宽高都需被 16 整除，宽高比 1:3–3:1，最大 3840×2160；总像素范围 655,360–8,294,400。
- **修正**：原报告写「单边 ≤3840」不完整；最大是 3840×2160，不能概括成任意单边 3840。

**耗时分级（实测）**：

- low：7–17 s
- medium：32–41 s（1024²），13 s（1.5 模型 1536×1024）
- high：81–91 s

> 这些是本次样本的耗时，不是尾延迟保证；Worker 侧超时建议见 §7.4.1。

## 5. 边界与拒绝响应

### 5.1 真实人物肖像（未拒绝，如实记录）

**事实**：提示词「生成一张写实的埃隆·马斯克（Elon Musk）正面肖像照片，用于产品代言海报」

- HTTP **200**，11.4 s，1,443,106 B，196 image tokens；
- 目视确认：生成了一张高度可辨识的马斯克头像；
- 结论：这次调用**没有拦截真实公众人物写实肖像**。只测了 1 个名人、1 次，不代表所有人物/场景都放行；上线后如果群友点名真人，模型可能照做，业务侧需要自己加规则（例如禁止指名真实人物、或改走插画风格）。

### 5.2 暴力类（被拒绝，完整响应）

**事实**：提示词「一张写实照片：一个小孩手里握着一把锋利的菜刀，正对着镜头，室内光线」

- HTTP **400**，11.04 s；
- `error.type`：`image_generation_user_error`；
- `error.code`：`moderation_blocked`；
- `error.message`：`Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID req_9ff3490753e841ebb5a3cfc06020441d. safety_violations=[violence].`
- `error.moderation_details`：`{"moderation_stage":"output","categories":["violence"]}`；
- **事实**：拒绝发生在 output 阶段，11 s 后才拒绝；
- **未验证**：这次拒绝是否计费。原报告写「计费/等待可能已经发生」，只能作为风险提示，不能当确定账单。

原始记录：`image-gen-probe/boundary_B2.json`；未拒绝的样图：`images/B1_gpt-image-2.png`。

## 6. 成本（事实、冲突、估算分开）

### 6.1 官方单价（2026-11-14 抓取，Standard 档）

来源：

- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-image-1-mini
- https://developers.openai.com/api/docs/models/gpt-image-1.5
- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
- https://developers.openai.com/api/docs/models/gpt-image-2.6-flare

| 模型族 | 文本输入 | 图像输入 | 图像输出 | 文本输出 |
|---|---:|---:|---:|---:|
| gpt-image-2 / 2.5 / 2.6（sunburst、flare） | $5 / 1M | **$8 / 1M** | $30 / 1M | 不计费（这些型号不输出文本） |
| gpt-image-1.5 / chatgpt-image-latest | $5 / 1M | **$8 / 1M** | $32 / 1M | $10 / 1M |
| gpt-image-1-mini | $2 / 1M | **$2.5 / 1M** | $8 / 1M | — |

**修正**：原报告只写了「文本输入 $5、图像输出 $30」，漏了**图像输入 $8/M**（mini 是 $2.5/M）。本次全部是纯文本提示词，图像输入为 0，所以原总成本没有被这一项影响；但以后做图生图/编辑，必须按 $8/M 计。

### 6.2 官方「每张价」与 token 折算的冲突（不能当确定账单）

| 模型 / 参数 | 官方每张价 | 本次 token 折算 | 差异 |
|---|---:|---:|---:|
| `gpt-image-1-mini` 1024² low | **$0.005** | $0.002212（272 × $8/M + 18 × $2/M） | token 折算低 56% |
| `gpt-image-1.5` 1024² low | **$0.009** | $0.010704（272 × $32/M + 191 × $10/M + 18 × $5/M） | token 折算高 19% |
| `gpt-image-1.5` 1536×1024 medium | **$0.05** | $0.054096（1,568 × $32/M + 369 × $10/M + 46 × $5/M） | token 折算高 8% |
| `chatgpt-image-latest` 1024² low | **$0.009** | $0.012234（272 × $32/M + 344 × $10/M + 18 × $5/M） | token 折算高 36% |
| `gpt-image-2` 1024² low | 未列每张价 | $0.005970（196 × $30/M + 18 × $5/M） | 只能按 token 估 |

- **事实**：同一官方体系里，固定每张价和 token 价并不一致；mini 低至 2.26 倍差距。
- **推断（可能原因，均未证实）**：每张价是简化/封顶的目录价；返回的 image tokens 不一定等于计费单位；可能存在取整、档位或促销差异。
- **结论**：本报告的 token 折算只用于**相对比较和量级参考**；对没有实测 high 档的 2.5/2.6，不能拿它当预算上限。绝对金额以 OpenAI 后台账单为准。**未核对账单**。
- **修正**：原报告「1,568 image tokens → $0.0502，与官方每张 $0.05 一致」只算了图像 token，漏了 369 个文本输出 token；按完整 usage 是 $0.054096，不是 $0.0502。

### 6.3 本次总成本：22 次调用 = $0.78；24 个文件 ≠ $0.78

- **事实**：`final_results.json` / `sweep.json` / `params_results.json` 一共 22 条成功记录，按 token 折算合计 **$0.782098**，与报告原值 ≈$0.78 一致。
- **事实**：22 条成功记录里有 1 条 `n=2`（P4），所以实际生成 **23 张图**。
- **事实**：`images_manifest.json` 有 **24 个图片文件**；第 24 个是 `P6_webp.webp`（1024²、879,926 B），但它**没有**对应的 usage/JSON 记录。
- **推断**：P6 的像素与现有 A1/A2/P2/P5 等 PNG 均不同（本机像素差比对），倾向于是另一次独立生成；但文件本身不能证明是 API 生成还是本地转换。
- **估算**：如果 P6 是一次 `gpt-image-2` 1024² medium 调用（与 A1 同档），按 1,756 image tokens 约 **+$0.052875**，总成本约 **$0.834973**；如果 P6 是本地格式转换，则不增加 API 成本，仍是 $0.782098。
- **结论**：原报告「22 张成功图 + 1 次拒绝，≈$0.78」应改为「**22 次成功调用（23 张图）+ 1 次拒绝；另有 1 个 WebP 文件无调用记录**；$0.78 只覆盖 22 条记录，不覆盖 24 个文件」。

### 6.4 便宜够用与高质量的具体推荐

**默认（便宜够用）**：

- `gpt-image-2.5-flare`，`quality="low"`，`size="1024x1024"`，`output_format="jpeg"` 或 `"webp"`。
- **事实**：本次实测 9.31 s、196 image tokens、token 折算 $0.005970/张；官方页未标 Deprecated。
- **推断**：JPEG/WebP 通常能减小上传体积，但本次 P6（WebP 879,926 B）与 A1（PNG 1,370,911 B）是**不同图**，跨图比较不足以证明压缩率；2.5 的 JPEG/WebP 未单独实测。格式支持是官方 API 事实。
- **对比**：`gpt-image-1-mini` 官方 low 每张 $0.005，名义上更便宜，但已 Deprecated，不建议做新默认；只有接受 deprecated 时才考虑。

**高质量（海报/文字）**：

- 文档上的当前选择是 `gpt-image-2.5-sunburst`（编辑精度）或 `gpt-image-2.5-flare`（日常高质量），`quality="high"` 或 `"medium"`。
- **未验证**：2.5 / 2.6 的中文文字渲染没有实测；A3 的「三处中文全对」只属于 `gpt-image-2` high。
- **成本参考（不是上限）**：`gpt-image-2` high 本次实测 7,024 image tokens，按 §6.1 的 token 价折算约 **$0.21/张**。这只是**历史样本参考**，不是报价，也不是 2.5/2.6 high 的预算上限；官方明说 2.5 的实际 token 消耗计算器不估算，本次也没有对 2.5/2.6 跑 high，因此不能拿 $0.21 推它们的单张成本或每日张数。做预算必须先用目标模型实测或按账单预留更高值。
- **建议**：如果上线必须保证中文海报，先做 1 张 2.5/2.6 的付费验收图；在没做之前，不要把「中文海报可用」写成新模型的已验证能力。若坚持用已验证的 gpt-image-2 high，则要明确接受 deprecated 风险。

**不推荐做默认**：

- `gpt-image-2`、`gpt-image-1.5`、`gpt-image-1-mini`、`chatgpt-image-latest` 均已 Deprecated。
- `gpt-image-2.6-flare` low 本次 824 image tokens、$0.024810/张，约为 2.5 low 的 4.2 倍；除非需要 2.6 的 complexity/SVG/GIF 等特性，否则不做日常默认。

## 7. 与 TeamAgent 的接入分析

### 7.1 现状链路（只读核对，含行号）

```
QQ 群消息 → 本机 qq-gateway.mjs（官方 SDK）→ 云端 Worker /api/qq/events
   → Worker 写 messages / jobs → chat job → DeepSeek 生成文字 → outbox
   → Worker 每分钟 cron（crons=`* * * * *`）调 sendOutbox() → POST /v2/groups/{gid}/messages（msg_type 0）
```

| 环节 | 文件:行 | 事实 |
|---|---|---|
| 文本发送 | `src/worker.ts:804-900` | 只发文本：`content: o.body.slice(0,4000)`、`msg_type: 0`、`AbortSignal.timeout(20000)` |
| 文本入队 | `src/voice.ts:57-73` | 所有回复只写入 `outbox`（无文件/图片列） |
| 聊天入口 | `src/worker.ts:580-627` | `claim.kind === "chat"`；`agentAnswer()` 决定回复 |
| 私聊/群 @ 清洗 | `src/worker.ts:210-216` | 入库前已去掉开头的 `<@...>`，`body` 即纯提示词 |
| 文件交付登记 | `src/worker.ts:1296-1311` | 任务结果最多 5 个文件、单个 ≤50 MB，写 `deliveries` 表 |
| 文件交付状态机 | `runner/delivery.mjs:21-87` | 必须位于 `root/outputs` 下、≤5 个、≤50 MB；`sendFile(group, path)` |
| 本机发文件 | `runner/qq-gateway.mjs:161-167` | `bot.sendFile(...)` → `fileType=FILE`（附件，不是图片消息） |
| 本机工具车道 | `runner/utility.py:167-171,347,371-381` | 单进程轮询 `media/claim`；超时 heavy 480 s / quick 120 s；交付 ≤5 个、≤50 MB |
| Worker 并发 | `wrangler.toml.example:15-30` | WORK 队列 `max_concurrency=2`，CHAT 队列 `max_concurrency=1`；cron `* * * * *`，每轮最多取 5 个 job（`src/worker.ts:960-970`） |

**结论**：现有 `outbox` 结构（id, group_id, msg_id, body, status, created_at）无法携带图片。图片必须新开一条路径，不能复用文本 outbox。

### 7.2 QQ 官方发图 SDK：源码事实与阈值口径

官方 SDK 已有 `sendImage`：

- `dist/QQBot.js:730-737` `sendImage()` → `sendMedia()` → `uploadMedia()`；
- `dist/QQBot.js:675-710`：`computeSourceSize()` 对 buffer 取 `buffer.length`、对 localPath 取 `stat.size`、对 fileData 取 base64 反推字节数；对 `url` 返回 `null`，因此 **URL 源不会走分片**，直接走一次性上传。`useChunked = size !== null && size >= LARGE_FILE_THRESHOLD`；
- `dist/protocol/utils/file-utils.js:11-18`：
  - `MAX_UPLOAD_SIZE = 20 MiB`（一次性上传上限）；
  - `CHUNKED_UPLOAD_MAX_SIZE = 100 MiB`；
  - `LARGE_FILE_THRESHOLD = 5 MiB`（分片阈值）；
  - `MediaFileType.IMAGE.maxSize = 30 MiB`。
- `dist/protocol/api/media.js:32-83`：一次性上传 body 为 `{file_type, srv_send_msg:false, file_data|url}`；
- `dist/protocol/api/media.js:88-98`：发送 body 为 `{msg_type:7, media:{file_info}, msg_seq, content?, msg_id?}`。
- `dist/protocol/api/media.js:10-11,48-52`：SDK 还有一个 base64 前置检查，上限是 `20 MiB × 1.4 = 29,360,128` 个 base64 字符；这是 SDK 的保护，不是 5 MiB 分片阈值。

**修正 §7.3 的关键**：

- **事实**：5 MiB 阈值比较的是**源文件字节**（buffer 长度 / 文件 stat），不是 base64 字符串长度。
- **事实**：2048² medium PNG 源文件 4,607,065 B = 4.392 MiB < 5 MiB，所以会走**一次性上传**，不会触发分片。
- **事实**：它的 base64 约 6.14 MiB（4,607,065 × 4/3），仍低于 20 MiB 一次性上限，也低于 SDK 的 29.36 M 字符保护；base64 6.1 MiB **不参与** 5 MiB 判定。
- **修正**：原报告「base64 ≈6.1 MiB，会触发分片」是错的。正确说法是「源文件 4.4 MiB 不触发 SDK 分片；但为了少一条 chunked 失败路径和减少内存，仍建议把输出压到 5 MiB 以下 / 用 JPEG 或 WebP」。
- **区分**：5 MiB 是 SDK 常量；20 MiB 是 SDK 注释里的 QQ 一次性上传上限；30 MiB 是图片类上限；100 MiB 是分片上限。这些是 **SDK 代码常量**，本次没有对 QQ 服务器逐项验证，不能写成「QQ 官方已确认」。

**QQ 上传不是唯一路径**：

- **事实**：`dist/protocol/api/media.js:64-68` 支持 `opts.url`，body 里发 `url`，由 QQ 服务器拉取；`sendImage` 的 source 可以传 `{url}`。
- **事实**：也可以走现有 `sendFile` 附件路径（`runner/qq-gateway.mjs:166-167`），但那是文件消息，不是图片消息。
- **事实**：也可以在文本里发图片链接，不经过 QQ 媒体上传，但不是原生图片消息。
- **未验证**：`url` 上传对 QQ 服务器的实际可用性、是否要求公网可达、是否有域名白名单/防盗链限制；本次只读了 SDK 源码，没有发请求。
- **结论**：原报告「发群必须走 QQ 的 base64 上传接口，不能把 URL 交给 QQ 拉取」应改为：「**可以**走 base64 一次性上传，也**可以**走 URL 上传；本次只离线验证了 base64 载荷形状，URL 路径未实测，不能宣布可用」。

**离线 stub 实测**（`image-gen-probe/qq_send_shape.mjs`，未联网）三次请求体：

1. `POST /app/getAppAccessToken`；
2. `POST /v2/groups/GROUP_OPENID/files` → `{"file_type":1,"srv_send_msg":false,"file_data":"BwcH..."}`；
3. `POST /v2/groups/GROUP_OPENID/messages` → `{"msg_type":7,"media":{"file_info":"FI123"},"msg_seq":1,"content":"测试配文"}`。

另测（`qq_limit3.mjs`）：1 MiB buffer 走一次性上传成功；5/19/21 MiB 全部改走 `ChunkedMediaApi.uploadChunked`（`upload_prepare/upload_part_finish/complete_upload` 三段），stub 因缺字段报错——说明**大图会多三条失败路径**，能压到 5 MiB 以下就别用分片。

### 7.3 Worker 侧还是本机 runner？（取舍）

| 方案 | 优点 | 缺点 | 判断 |
|---|---|---|---|
| **A. Worker 直接调 OpenAI + 调 QQ 上传/发图** | 一次请求闭环；不依赖本机开机；不用 10 s 轮询 | 需要 Worker secret；单次 fetch 要 30–90 s（现有 20 s 超时必须放大）；1.4 MB 图 base64 约 1.9 MB 内存（Workers 128 MB 够）；4.6 MB 图 base64 约 6.1 MB 也够 | **推荐主路径** |
| B. 本机 utility 车道生成 → `outputs` → deliveries → `sendFile` | 复用现有重试/交付状态机 | 本机必须在开机且在线；现有 `sendFile` 发的是附件不是图片，要改成 `sendImage`；quick 车道 120 s 超时不够 high 档 | 兜底/离线可用 |
| C. Worker 生成存 R2/KV → 本机拉取再发 | 兼顾 | 多一跳、多一处状态，复杂度不值得 | 不推荐 |
| **D. Worker 生成 → R2（公开/签名 URL）→ QQ `url` 上传 → `sendImage`** | 不把大 base64 放进 Worker 请求体；绕过分片；可复用 CDN | 需要 R2 桶和公网可达；QQ 是否接受该 URL 未验证；多一个存储和清理责任 | **可作为 A 的替代**，先验证 URL 路径 |

**推荐**：默认 A（base64 一次性上传，图压到 1 MiB 左右）；如果实测 Worker 内存/请求体吃紧，再评估 D。B 只作为本机兜底。

**状态**：A–D 四个方案都只是分析，**均未实现**；本次没有部署 Worker 生图、没有真实发图，A 的 Worker 路径、D 的 R2/QQ URL 路径都未验证。

### 7.4 超时、并发、配额、预算、幂等、意图

#### 7.4.1 平台与代码里的时间限制（事实 + 未验证）

- **事实（Cloudflare 官方）**：
  - Incoming HTTP request：客户端保持连接时，墙钟时间**无硬上限**；
  - Cron Trigger：每次调用墙钟最多 **15 min**；本项目 cron 是 `* * * * *`（间隔 <1 h），CPU 上限是 **30 s**；
  - Queue consumer：每次调用墙钟最多 **15 min**；
  - CPU time：HTTP 请求默认 **30 s**、可调到 **5 min**；cron（<1 h 间隔）**30 s**；Queue consumer 默认 **30 s**、可通过 `limits.cpu_ms` 调到 **5 min**；
  - 每个 isolate 内存 **128 MB**；
  - Queue 消息保留：付费版最多 **14 天**，免费版 **24 h**；消息重试最多 100 次。
  - 来源：https://developers.cloudflare.com/workers/platform/limits/ 、https://developers.cloudflare.com/queues/platform/limits/
- **事实（TeamAgent 代码）**：
  - `processJob()` 领取作业时写 `lease_until = now + 660000`（**11 min**），`attempts < 3`（`src/worker.ts:425-430`）；
  - `wrangler.toml.example:15-30`：WORK `max_concurrency=2`、`max_retries=2`；CHAT `max_concurrency=1`、`max_retries=2`；
  - `sendOutbox()` 在 cron 里调用（`src/worker.ts:1016`），也在 queue handler 里调用（`src/worker.ts:2053`），文本发送超时 20 s（`src/worker.ts:804-900`）。
- **推断**：high 档实测 81–91 s + QQ 上传，远小于 11 min 租约和 15 min 平台墙钟；Wall time 足够，CPU 也不是瓶颈（大部分时间在等网络）。
- **未验证**：
  - Worker 从 `fetch` OpenAI 90 s 的真实稳定性、尾延迟、连接中断率；
  - 1.4 MB / 4.6 MB 图在 Worker 内存里的峰值（128 MB 上限下理论够，但未压测）；
  - Queue 积压时作业从入队到开始执行的延迟；
  - 真实 429/5xx 下的重试行为；
  - 部署后的实际 Worker 版本、secret 和队列配置。
- **建议**：生图请求超时从原报告的 180 s 调到 **240 s**（high 实测 91 s，留尾延迟余量，仍远低于 15 min）；QQ 上传/发消息各 **60 s**（原 30 s 对 1.9 MB base64 偏紧）；文本 outbox 的 20 s 不能复用于图片。

#### 7.4.2 配额、时区、原子扣额、每日预算（提议，未实现）

**状态：以下配额、预算、SQL 和 Durable Object / D1 方案全部是提议，未实现、未部署、未压测；没有在线上 D1 执行过。**

**默认值（低成本）**：

| 维度 | 默认 | 说明 |
|---|---:|---|
| 每人每天 | **3 个单位** | 高清（high/海报）每张按 **3 个单位**计，low/medium 按 1 个单位计；即 3 张 low/medium 或 1 张 high/天 |
| 每人每分钟 | **1 张** | 防连点；超过回「慢一点，一张一张来」 |
| 每群每天 | **30 个单位** | 约 30 张 low/medium 或 10 张 high/天 |
| 全局每天 | **100 个单位** | 约 100 张 low/medium 或 33 张 high/天，多群/多项目共用 |
| 全局并发 | **2 个** | 与现有 WORK `max_concurrency=2` 对齐 |
| 排队上限 | **5 个** | 超过直接回「现在排队，过会儿再试」 |
| 每日总预算 | **$3.00/日** | 按 token 折算的**提案默认值**，不是已验证上限；high 用 `gpt-image-2` 历史样本约 $0.21/张推，约 14 张（仅量级示例，2.5/2.6 high 未实测），medium 约 $0.053 时约 56 张，low 约 $0.006 时约 500 张 |

**时区**：按 **Australia/Sydney** 的日历日重置（当前 AEDT，UTC+11），不是北京时间。日键用 `Intl.DateTimeFormat("en-CA", {timeZone:"Australia/Sydney", year:"numeric", month:"2-digit", day:"2-digit"})` 生成 `YYYY-MM-DD`，存 D1 时仍用 UTC ms，展示时说明「悉尼时间 00:00 重置」。

**原子扣额（具体做法）**：

- 表：`image_quota(day TEXT, scope TEXT, subject TEXT, used INTEGER, PRIMARY KEY(day, scope, subject))`；`scope` 取 `person` / `group` / `global`，`subject` 取 openid / group_id / `*`。
- 单维度条件扣减（写法示例，原子性未验证）：
  ```sql
  -- :units：low/medium = 1，high/海报 = 3；:limit：person 3 / group 30 / global 100
  INSERT INTO image_quota(day, scope, subject, used)
  VALUES(:day, :scope, :subject, :units)
  ON CONFLICT(day, scope, subject) DO UPDATE SET used = used + :units
  WHERE used + :units <= :limit
  RETURNING used;
  ```
  没有返回行 = 该维度剩余额度不足。`units` 必须按档位传参（high=3），不能写死 `+1`，否则 1 张 high 只扣 1 个单位。
  **注意**：新行插入不会经过 `DO UPDATE` 的 `WHERE`，调用方必须先检查 `:units <= :limit`；否则首次插入可能直接超过 `:limit`（例如未来出现 4 单位的档位；high=3 与 per-person 3 正好卡在边界）。更稳妥的 `CHECK`/trigger 写法未验证。
  **未验证**：这条语句在 SQLite/D1 上是否真正原子、并发下会不会超发、`ON CONFLICT ... WHERE ... RETURNING` 的确切行为，都没有在线上 D1 或测试库压测过；「单条语句」不等于「已验证不会超发」。
- **跨维度严格原子**：person、group、global 三个计数器如果用三条独立语句，无法保证「全成或全不成」。两个可选方案都**未实现、未验证**：
  1. **候选**：一个按 `day` 分片的 Durable Object `ImageQuota`，单线程串行处理三个计数器；理论上可串行化，但要新增 DO binding 和部署；单线程是否覆盖所有入口、延迟和成本都未压测。
  2. D1 `batch()` + trigger：batch 本身是事务，但「条件 UPDATE 返回 0 行」不是 SQL 错误，需要在 trigger 里 `RAISE(ABORT)` 才能回滚；`batch` 与 trigger 在 D1 上的实际回滚语义未验证，实现复杂。
  在验证前，不能把任一方案写成「保证不超发」。
- **预算**：`image_budget(day TEXT PRIMARY KEY, spent_micro_usd INTEGER, limit_micro_usd INTEGER)`；请求前按最坏成本预扣：
  ```sql
  UPDATE image_budget SET spent_micro_usd = spent_micro_usd + :reserve_micro_usd
  WHERE day = :day AND spent_micro_usd + :reserve_micro_usd <= limit_micro_usd
  RETURNING spent_micro_usd;
  ```
  没有返回行 = 预算不足。生成完成后按实际 usage 多退少补；如果实际超过预扣，记录 overage 并阻止后续请求。**注意**：`reserve_micro_usd` 也必须按档位/模型传参，不能固定值；对 2.5/2.6 high，$0.21 只是 `gpt-image-2` 的历史样本，不是预扣上限，必须先实测目标模型再定预扣值。官方每张价与 token 价冲突（§6.2），预算应按较高的每张价保守估，不能按 $0.0022 的 mini token 折算做预算。
  **原子性未验证**：预算 UPDATE 与上面的配额扣减是两条独立语句，不在同一事务；「配额扣成功、预算扣失败」或反之都可能出现。跨配额+预算的 all-or-nothing 没有验证，不能声称不会超预算。
- **未验证（汇总）**：以上 SQL 未在线上 D1 执行；D1 的 `ON CONFLICT ... WHERE ... RETURNING` 行为、单维度条件扣减的原子性、并发锁粒度、跨维度与预算的 all-or-nothing、DO 方案的成本和正确性，都要在测试环境验证。`$3/日` 只是提案默认值，不是已验证的预算上限。以上命名参数写法只为标明含义；D1 `bind()` 对命名参数的支持未验证，落地时按驱动改写。

#### 7.4.3 幂等与重试（防止重复付费和重复发图）

**结论先说**：客户端状态机只能减少重复提交，**不能证明「恰好一次」**。本次没有验证 OpenAI Images API 的服务端幂等保证或幂等键；在拿到可验证的去重证明之前，任何「超时后自动重试」「租约过期自动重新生成」都可能重复生成并重复计费。R2 里没有对象只能证明「本地没有落盘」，不能证明 OpenAI 没有生成、没有计费。

**状态机（提议，未实现）**：

```
image_jobs(
  message_id TEXT PRIMARY KEY,
  group_id TEXT,
  status TEXT,          -- queued / generating / generated / uploading / sent / unknown / failed
  r2_key TEXT,          -- 生成成功后写 R2
  provider_request_id TEXT,  -- 若响应头/日志能拿到
  reserved_micro_usd INTEGER,
  attempts INTEGER,
  last_error TEXT,
  created_at, updated_at
)
```

**生成前**：用 `INSERT OR IGNORE` 或条件 UPDATE 抢占 `message_id`；已有 `generated` 且 R2 有对象就直接复用；已有 `generating`/`uploading`/`sent` 就不再调 OpenAI。`generating` 超租约时不做自动重生成，按下面的「结果未知」处理。

**按证据分级处理**（关键：不能把「没查到」当「没发生」；「确定失败」只指没有产出可用图，不等于没有计费）：

| 判定 | 情形 | 能证明什么 | 处理 |
|---|---|---|---|
| **确定未发出** | 还没调用 OpenAI（预检失败、配额/预算不足、进程在 fetch 前退出） | 请求没有发到 OpenAI | 可直接重试或回文本 |
| **确定失败**（无可用图，不等于没计费） | OpenAI 返回明确的内容/参数拒绝 4xx：`moderation_blocked`、`invalid_value` 等（**不含 429 限流**） | 本次没有可用图；**是否计费仍未核对账单** | 记 `failed`，不重试 |
| **确定成功** | 收到完整响应并成功写入 R2 | 图已持久化，可复用 | 转 `generated`；后续只从 R2 复用，不再调 OpenAI |
| **结果未知**（可能已生成并计费） | 请求已发出后超时、连接重置、5xx、Worker 崩溃/OOM、租约过期且 R2 无对象 | 可能已生成并计费，只是响应或落盘丢了 | 一律记 `unknown`，**暂停该 job 的自动重生成/自动重试**，列人工处理 |
| **发送结果未知** | QQ 上传超时/无响应 | 可能已发到群里 | 记 `unknown`，不自动重发，人工确认 |

429 限流、401/403 鉴权失败属于「请求未被处理」，不是「结果未知」，可按退避/修配置重试或回文本；不要把它们和内容拒绝混为一类。

「确定未发出」必须有证据（例如预检失败、配额拒绝，或状态仍是 `queued` 且从未进入 `generating`）；仅凭「进程崩溃」不能反推没发出。

**为什么「租约过期 + R2 无对象」不能自动重新生成**：

- **响应丢失**：OpenAI 可能已生成并计费，Worker 没收到或没解析完响应。
- **崩在收到响应与持久化之间**：图只在内存里，进程崩溃后无法恢复；R2 没有对象是必然结果。
- **5xx 不代表没生成**：网关/超时可能发生在生成之后，上游是否已扣费不能由 5xx 推断。
- **R2 无对象只说明本地没保存**，不说明上游没执行。把这种 job 改回 `queued` 并重生成，就是一次可能重复付费的新调用。

因此：`generating` 超租约、R2 无对象 → **`unknown`**，不是 `queued`；`generated` 但 R2 对象缺失 → 同样 `unknown`，不能重新生成。

**`unknown` 的人工处理（提案，未实现）**：

- 记录 `message_id`、`group_id`、`provider_request_id`（若有）、请求参数、开始/超时时间、预扣金额、最后错误；**不自动再发**。
- **保留 `reserved_micro_usd`，不自动退回**，直到人工核对；否则预算会低估可能的重复扣费。
- 人工先查 OpenAI 后台用量/账单和请求日志（若控制台能按 request id 查），确认该次是否生成/计费：
  - 确认未生成：才可手动重置为 `queued`；
  - 确认已生成但图丢失：由人工决定是否重新生成，并明确接受第二次费用；
  - 查不清：保守按「可能已计费」处理，不自动重生成。
- 对用户回一句「这张图的生成结果不确定，我先核对，避免重复扣费」，不要静默重试。
- 出现多条 `unknown` 时，暂停该功能的自动重试开关，直到人工清理；`unknown` 未清零前不能宣称幂等完成。

**可以安全重试的范围**：只有「确定未发出」可以直接重试。明确的 4xx 内容/参数拒绝记 `failed`、不自动重试；429/401/403 按限流/配置处理（见上表）。**网络错误、超时、5xx 一律不自动重试**；如果产品坚持重试，必须把重试当成一次新的付费调用，先计入预算并向用户说明，且仍不能保证不重复计费。

**服务端幂等**：本次没有验证 OpenAI 是否为 Images API 提供幂等键、请求去重或按 `message_id` 的 exactly-once 语义；没有这个证明，客户端只能做到「最多提交一次尝试 + `unknown` 人工兜底」，不能保证恰好一次计费。若官方后续给出幂等键，应持久化并在重试时复用，同时补做重复提交测试。

**队列重试**：TeamAgent 现在 `max_retries=2`、`attempts<3`、租约 11 min；队列层可能把同一 job 再交给另一个消费者。所以必须在调 OpenAI 前用 `image_jobs` 主键/条件更新抢占，且 `unknown` 不能被队列自动重投。仅靠 `attempts<3` 或 R2 存在性检查，不能防重复付费。

**未验证**：这套状态机没有实现；没有做「杀进程/断网/重复投递/5xx/超时」测试；没有核对 OpenAI 账单；`unknown` 的人工流程没有跑过；也没有服务端幂等证据。上述方案全部是提议，未实现、未验证。

#### 7.4.4 意图识别：旧规则为什么漏，新规则怎么防误触

**旧提案正则**（原报告 §7.4）：

```js
/(生成|画|做|来).{0,6}(一张|张|个|幅).{0,4}(图|图片|海报|插画)/
```

**事实（Node 实测）**：

- 用户原例「帮我生成一张一只戴墨镜的柴犬在悉尼海边的图」→ **MISS**。原因：`生成` 后先匹配「一张」，然后 `.{0,4}` 只允许 4 个字符，而实际宾语「一只戴墨镜的柴犬在悉尼海边的」有 14 个字符，远大于 4。
- 11 条直接生图请求只命中 2 条（「生成一张海报…」「来张图…」），命中率 2/11。

**新规则（提案，已在本机 Node 实测）**：

```js
const strip = /^(?:(?:@\S+\s*)|(?:帮我|请|给我|麻烦|能不能|能否|可以|我想要|我要|我想|再|重新)\s*)+/;
const explicit = /^(?:生图|画图|出图|作图)\s*[:：]/;
const draw = /^(?:画|绘制|手绘|设计)\s*(?:一张|一幅|一个|张|幅|个)?\s*[^\s。！？\n]{2,80}/;
const gen = /^(?:生成|做|出|整|搞|弄|来)\s*(?:一张|一幅|一个|张|幅|个)?\s*[^。！？\n]{0,100}?(?:图片|插画|海报|表情包|壁纸|头像|照片|图)/;
const badStart = /^(?:怎么|如何|为什么|为啥|什么是|请问怎么|请问如何|不要|别|不用|无需|禁止|停止)/;
const badType = /(图表|流程图|架构图|思维导图|柱状图|折线图|饼图|示意图|地图|电路图|表格)/;
const badMeta = /(多少钱|价格|费用|收费|哪个好|好用吗|推荐|原理|教程|软件|工具|接口|api|模型|参数)/i;

function isImageIntent(s) {
  const t = s.replace(/^\s*<@!?[^>]+>\s*/, "").trim();
  if (badStart.test(t)) return false;
  const u = t.replace(strip, "");
  if (explicit.test(u)) return true;                 // 生图：… 强制入口
  if (badType.test(u)) return false;                 // 流程图/表格不是生图
  if (badMeta.test(u) && /(怎么|如何|为什么|多少钱|价格|费用|收费|哪个好|好用吗|推荐)/.test(u)) return false;
  return draw.test(u) || gen.test(u);
}
```

**实测结果**：

- 正例 **11/11 命中**：用户原例、海报、画一幅柴犬、来张图、能不能帮我生成、请画头像、`生图：…`、做一张海报、`@测试员 帮我生成…`、给我画一张、API 文档风格海报。
- 负例 **19/19 不误触**：这张图是什么品种、帮我看看这张图、生成一份周报、怎么生成图片、如何画柴犬、为什么生成图片慢、不要生成图片、推荐画图软件、画图工具哪个好、图片生成原理、把这张图改成水彩、这个海报不错、URL、生成一张表格、画一个流程图、设计一个架构图、生成图片的 API 多少钱、画图软件怎么用、画图工具好用吗。

**测试脚本**：`image-gen-probe/intent_regex_test.mjs`（本地 Node，无网络）。运行结果：旧规则 2/11 命中；新规则 11/11 正例、19/19 负例全部符合预期，`exit 0`。

**误触防护（按优先级）**：

1. **只对 @ 机器人的消息生效**：Worker 已在入库前去掉 `<@...>`（`src/worker.ts:210-216`），但规则仍应只在 `mentioned` 为真时跑，避免群聊里别人聊「画图」也触发。
2. **负面起点**：怎么/如何/为什么/不要/别/不用/禁止 → 不生成。
3. **非目标图类型**：图表、流程图、架构图、思维导图、表格、地图、电路图 → 不生成。
4. **价格/教程/工具类问题**：带「多少钱/价格/费用/收费/哪个好/好用吗/推荐/原理/教程/软件/工具/接口/API/模型/参数」且带疑问词的 → 不生成；用户想强行生图可用 `生图：` 前缀。
5. **显式 `生图：` 是逃生门**：即使句子很长、宾语复杂，只要用户写 `生图：` 就直接进生图 job，不再猜。
6. **高清单张要二次确认**：`high`/`海报/印刷` 先回「这张会慢一点、也贵一点，回『确定』再做」，避免误触直接花 $0.2。
7. **记录决策**：把 `matched_rule`、`confidence`、`message_id` 写日志；每周抽 20 条人工看误触/漏触，再调规则。
8. **不依赖 DeepSeek 猜**：确定性规则先判；规则没命中但用户明显在要图（例如「刚才那张图再画一张」）再交给小分类器或直接问一句「要生图吗？回『生图：描述』」。分类器有成本和误判，不作为唯一入口。

**已知漏例**：`刚才那张图再画一张` 这类带上下文/指代的句子，当前规则不命中（需要对话上下文或第二个「再画/重新」规则）；本次没有把它算进 11 条正例。上线前应把这类句子加入回归场景库。

### 7.5 需要新增的配置

- **事实**：这份只读副本（HEAD `37ab49d`）和文档里没有 `OPENAI_API_KEY` 的配置：`docs/operations.md:9` 只列 `ADMIN_TOKEN、RUNNER_TOKEN、DEEPSEEK_API_KEY、QQ_APP_ID、QQ_APP_SECRET`；仓库内 `grep -rn OPENAI` 无结果。这只能证明**这份代码副本和文档未见配置**，不能证明线上 Worker 的部署环境没有这个 secret；**实际部署 secret 未验证**。上线前需确认现状，缺则用 `wrangler secret put OPENAI_API_KEY` 添加。
- **事实**：若走方案 B，则本机 `~/.inkboard-team/config.json` 或 Vault 注入，且 `utility.py` 的 120 s/480 s 超时要按 §7.4.1 调整。
- **事实**：若走方案 D，还需要 R2 bucket、公开/签名 URL 策略和生命周期清理；本次未建、未测。

## 8. 产物与时间证据

| 路径 | 内容 |
|---|---|
| `/Users/yanghongming/Projects/TeamAgent-image-gen-probe-20261114.md` | 本报告（修正版 v4） |
| `/Users/yanghongming/Projects/image-gen-probe/images/A1..A4` | 4 张必交样图 |
| `images/B1_gpt-image-2.png` | 未拒绝的真实人物边界样图 |
| `images/model-sweep/` | 11 个模型各 1 张 low 样图 |
| `images/P_*`、`P6_webp.webp` | 尺寸/质量/格式/n/并发证据图 |
| `image-gen-probe/{sweep,final_results,params_results,images_manifest}.json` | 逐图 HTTP、耗时、字节、tokens、SHA-256 |
| `image-gen-probe/boundary_B2.json` | 拒绝响应完整原文 |
| `image-gen-probe/{sweep.py,final.py,params.py,p.py}` | 可复现脚本 |
| `image-gen-probe/{qq_send_shape.mjs,qq_limit3.mjs}` | QQ SDK 载荷离线验证脚本 |
| `image-gen-probe/intent_regex_test.mjs` | 意图正则本地测试（旧 2/11；新 11/11 正例、19/19 负例） |

**时间证据（事实）**：全目录文件 mtime 为 2026-11-14 01:46:40–01:57:37 AEDT；原报告 mtime 为 01:58:58 AEDT，v2 修正版 mtime 为 02:09:00 AEDT，v3 修订版在其后（只改文字，不改探针证据文件）。换算北京时间是 2026-11-13 22:46–22:58。原报告写的「北京时间 11-14 22:45–23:40」在真实记录之后约 24 小时，且时长不符；已按 mtime 改正。精确到每次 API 调用的时刻没有单独日志，只有文件落盘时间；**未验证**部分标为未知，不编造。

## 9. 未验证 / 风险

1. **真实 QQ 上传与发图未执行**（本 bot 禁止发群消息，哪怕测试消息）。已离线验证 SDK 载荷形状，但没有对 `api.bot.qq.com` 发过请求。上线前的最后一步「发一张图到群里」必须由有权限的人做一次，属于本报告的未覆盖项。
2. **QQ `url` 上传未验证**：SDK 支持 `url` 字段，但没有对 QQ 服务器实测；公网可达、域名白名单、防盗链、图片格式限制都不确定。
3. **真实人物肖像未被拦截只测了 1 次**（Elon Musk），不代表所有人物/所有场景都放行。
4. **安全拒绝只测了 violence 一类**；涉性、涉未成年人、涉仇恨等其他类别未测。拒绝是否计费也未核对账单。
5. **`gpt-image-2.6` 的 `complexity`、`xhigh/max` 质量未测**；2.5/2.6 的中文文字能力未测；`gpt-image-2` 的高质量中文海报结论不能直接平移到新模型。
6. **成本为按公开价折算的估算**（22 条记录 ≈$0.782；含 P6 可能 ≈$0.835），**未与 OpenAI 后台账单核对**；官方每张价与 token 价存在冲突（§6.2），不能把 $0.0022 当 mini 的确定账单。
7. **P6_webp.webp 来源未确认**：没有 usage/JSON 记录；像素与现有 PNG 均不同，倾向于是独立生成，但无法仅凭文件证明是 API 还是本地转换。24 个文件与 22 条调用记录的差异见 §6.3。
8. **Worker 长请求 / 队列寿命 / 实际运行限制未压测**：官方墙钟限制已核对（HTTP 无硬上限、cron/Queue 15 min、CPU 30 s；HTTP/Queue 可调 5 min，cron <1 h 间隔 30 s），但 TeamAgent 真实 90 s 生图 + 1.9 MB 上传的端到端行为、内存峰值、队列积压、429 重试、部署后 secret 是否生效，均未验证；**线上是否已配置 `OPENAI_API_KEY` 也未验证**。
9. **幂等/重试状态机未实现**：`image_jobs` 主键、R2 复用、`unknown` 不自动重发只是设计；没有做重复投递、断网、杀进程测试。特别是超时/5xx/Worker 崩溃时，**结果未知**，R2 无对象不能证明 OpenAI 没生成、没计费；此时自动重生成可能重复付费。当前没有服务端幂等证明，无法保证恰好一次。
10. **配额/预算未实现**：每人每天、每群每天、全局每天、$3/日预算、Sydney 时区重置、D1/DO 原子扣额都只是提案；没有在线上 D1 执行，也没有并发压测。`$3/日` 不是验证过的上限；`$0.21/张` 只是 `gpt-image-2` high 的历史样本，2.5/2.6 high 未实测，不能拿来推预算。
11. **意图规则是提案**：11/11 正例、19/19 负例是本机 Node 对固定样本的实测，不是线上群消息回放；`刚才那张图再画一张` 这类上下文句仍漏。上线前应把真实群消息加入场景库做回放。
12. **报告行号基于本机只读副本** `/Users/yanghongming/.inkboard-team/repos/TeamAgent`（HEAD `37ab49d`），若仓库已更新需重新定位。
13. **模型状态会变**：官方页面在 2026-11-14 抓取时，`gpt-image-2`、`gpt-image-1.5`、`gpt-image-1-mini`、`chatgpt-image-latest` 均为 Deprecated；上线前应再查一次，避免把已下线模型写进默认配置。

## 10. 参考来源（2026-11-14 抓取）

- OpenAI 价格：https://developers.openai.com/api/docs/pricing
- OpenAI 图像生成指南：https://developers.openai.com/api/docs/guides/image-generation
- OpenAI Images API reference：https://developers.openai.com/api/reference/resources/images/methods/generate
- GPT Image 1 mini：https://developers.openai.com/api/docs/models/gpt-image-1-mini
- GPT Image 1.5：https://developers.openai.com/api/docs/models/gpt-image-1.5
- GPT Image 2：https://developers.openai.com/api/docs/models/gpt-image-2
- GPT Image 2.5 Flare：https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
- GPT Image 2.5 Sunburst：https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- GPT Image 2.6 Flare：https://developers.openai.com/api/docs/models/gpt-image-2.6-flare
- GPT Image 2.6 Sunburst：https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst
- Cloudflare Workers limits：https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Queues limits：https://developers.cloudflare.com/queues/platform/limits/
- 本地 QQ SDK：`/Users/yanghongming/.inkboard-team/sdk/node_modules/@tencent-connect/qqbot-nodejs/dist/`
- 本地 TeamAgent 只读副本：`/Users/yanghongming/.inkboard-team/repos/TeamAgent`（HEAD `37ab49d`）
