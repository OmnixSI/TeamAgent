# TeamAgent · OpenAI Luna 识图接入调研（只读）

- 时间：2026-11-14 01:07–01:17 Sydney（北京 22:07–22:17，谷时）
- 代码基线：`/Users/yanghongming/Projects/.worktrees/TeamAgent-F6-release`，branch `release/F6`，HEAD `c1a6c9d`（2026-11-14 01:05 +1100）。
- `src/vision.ts` 的 md5 与 `fast-lane-F4`、`fast-lane-F5a/F5b/F5-release`、`V-D-release` 完全相同（`805ef1d72b1798092711be6c839bdee6`），下列行号对当前 main 同样适用。
- 约束遵守：未改仓库（各 worktree `git status` 干净）、未写生产 D1、未发群消息、未下载视频流。

## 结论

1. **现有链路是完整的，不是坏的。** QQ 图片 URL 经 `mediaOf` → `pickImages` → `fetchImage` → `describeBytes` → `deepSeekVision` → `model()` 发到 `https://api.deepseek.com/chat/completions`。DeepSeek 官方文档（2026-11-14 抓取）明确 `deepseek-flash` 支持图片输入，JPEG/PNG/GIF/WebP，单图最多 1024 tokens。
2. **建议“加 provider，不换默认”。** `VisionProvider` 接口（`src/vision.ts:21-28`）本来就是为替换准备的；新增 `openai` provider（`gpt-6-luna`）+ 自动回退 DeepSeek，默认仍 `deepseek`，不改 `runtime.model()` 的共享路径。
3. **Luna 已实测可用。** 用用户已保存的 OpenAI 凭据调用 `gpt-6-luna` 两次均成功：64×64 PNG 与 1080×1920 JPEG 都返回合法 JSON；1080×1920 `detail=low` 193 prompt tokens / 2.07s，`detail=high` 2469 / 2.33s。按官方价单图约 $0.00004（low）/ $0.00027（high），300 张/日上限约 $0.012–$0.08/日。

## 一、现有图片理解完整链路（文件:行）

| # | 步骤 | 位置 | 关键行为 |
|---|---|---|---|
| 1 | QQ 事件解析 | `src/inbound.ts:65-106` | `parseInbound` 解析 `attachments` |
| 2 | 附件转 Media | `src/inbound.ts:58-63` | `mediaOf` 把 `a.url`、`content_type`、`width/height/size` 写进 `Media{kind:"image",url,...}`；`Media` 类型在 `:8` |
| 3 | 消息批量取图 | `src/worker.ts:735-742` | 非 hardStop 且 `visionProvider(e)` 存在时，`pickImages(preloaded,latestPre,refRows,TEAM.vision.turn_max)`，最多 3 张 |
| 4 | 选图规则 | `src/vision.ts:266-322` | 被 @/问图/引用机器人/带问号才取；当前消息、引用消息、整批消息；按 `messageId:idx` 去重 |
| 5 | 跳过已处理 | `src/vision.ts:481-496` | `coldPicks` 查 `message_images`，已有记录的不再解析 |
| 6 | 解析入口 | `src/vision.ts:498-544` | `annotateTurn` 建一个 12s `AbortController`，3 张图 `Promise.all` 并行 |
| 7 | 下载图片 | `src/vision.ts:182-252` | `fetchImage`：5,000,000 B 上限、仅 HTTPS、最多 2 次跳转、QQ 图床白名单、4 种 MIME、流式读 body 再卡上限 |
| 8 | 下载后的处理 | `src/vision.ts:404-422` | `describeImage` 取 `img.url` → `fetchImage` → `describeBytes` |
| 9 | 缓存与预算 | `src/vision.ts:424-479` | `sha256(bytes)+":"+VISION_VERSION` 查 `image_notes`；未命中先 `budget(e,"vision",300)`；再调 provider |
| 10 | 视觉 provider | `src/vision.ts:399-402` | `visionProvider` 只判断 `TEAM.vision.enabled !== false`，返回 `deepSeekVision` |
| 11 | 现有模型调用 | `src/vision.ts:346-397` | `deepSeekVision.describe` 组装 system prompt + `image_url` data URL，调 `model(e,"vision","none",...,10000,signal)` |
| 12 | 统一模型出口 | `src/runtime.ts:45-124` | 固定 `https://api.deepseek.com/chat/completions`（`:68`），`Authorization: Bearer e.DEEPSEEK_API_KEY`（`:71`），body 合并 `model`、`reasoning_effort`、`thinking`（`:74-79`） |
| 13 | 模型参数 | `config/team.json:4,13,22` | `model.name="deepseek-flash"`；`effort_by_kind.vision="none"`；`timeouts_ms.vision=10000` |
| 14 | 结果落库 | `src/vision.ts:460-471` / `:528-532` | `image_notes` 存 desc/tags/meme/text；`message_images` 记录 `message_id,idx,sha` |
| 15 | 第二次队列调用 | `src/worker.ts:743-758` | 先入 `chat-v-<id>` 任务带 `imageOutcomes`，再回 `chat`；`applyImageOutcomes` 把失败原因写进图片占位 |
| 16 | 注入提示词 | `src/context.ts:120-124`、`:138-145`；`src/view.ts:84-102` | `imageNotesFor` 批量查 `message_images JOIN image_notes`，`mediaViews` 输出“图片：desc；图中文字：…” |
| 17 | 自检入口 | `src/worker.ts:1817-1840` | owner-only `GET /api/team/vision/selftest`，用内置 64×64 `SELFTEST_PNG` 直接调 `provider.describe`，15s 超时，返回 `{ok,desc,ms}` |

**一句话路径：** QQ `attachments[].url`（`inbound.ts:58-63`）→ `pickImages`（`vision.ts:266`）→ `annotateTurn`（`:498`）→ `fetchImage`（`:182`）→ `describeBytes`（`:424`）→ `deepSeekVision`（`:346`）→ `model()`（`runtime.ts:45`）→ `api.deepseek.com`（`:68`）。

## 二、现有模型、配置名、secret 名（只核对名字）

- 模型：`deepseek-flash`（`config/team.json:4`）；vision 推理强度 `none`（`:13`）；vision 超时 `10000` ms（`:22`）。
- 视觉配置块：`config/team.json:92-98` — `enabled=true`、`daily_cap=300`、`turn_max=3`、`turn_deadline_ms=12000`、`prompt=…`。schema 在 `config/team.schema.json:188-221`，校验在 `config/validate.mjs:60-78`。`additionalProperties:false` 会让编辑器对新增键报红；运行期 `validateTeamConfig` 不拒绝额外键，但仍应同步 schema 和校验，避免配置漂移。
- Worker `Env` 声明：`src/worker.ts:56-69` — `ADMIN_TOKEN`、`RUNNER_TOKEN`、`DEEPSEEK_API_KEY`、`GITHUB_TOKEN?`、`QQ_APP_ID?`、`QQ_APP_SECRET?`、`MODEL?`、`RELEASE?`。
- 视觉唯一用到的模型 secret：`DEEPSEEK_API_KEY`（`src/worker.ts:62`，`src/runtime.ts:71`）。
- 仓库内 `OPENAI` / `OPENAI_API_KEY` 出现次数：**0**（`grep -rn OPENAI src scripts config .github docs README.md` 无结果）。
- 部署 secret 映射：`scripts/sync-runtime-secrets.py:8` 只映射 `DEEPSEEK_API_KEY`、`TEAM_ADMIN_TOKEN`、`TEAM_RUNNER_TOKEN`、`TEAM_QQ_APP_ID`、`TEAM_QQ_APP_SECRET`；CI 在 `.github/workflows/check.yml:31-39`。
- 线上 Worker secret 名（只核对名字，团队记忆 2026-11-14 00:50）：`ADMIN_TOKEN`、`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`QQ_APP_ID`、`QQ_APP_SECRET`、`RUNNER_TOKEN`。

## 三、Worker / 超时 / 图片下载约束

### 3.1 运行时

- `wrangler.toml`：三条 Queues（`WORK`、`CHAT`、`TOOLS`），`max_batch_size=1`、`max_batch_timeout=1`、`max_retries=2`；`WORK`/`TOOLS` 并发 2，`CHAT` 并发 1；cron `* * * * *`；**没有 `[limits] cpu_ms`**。
- Cloudflare 账户档位表（2026-11-13 更新）：Workers Free **10 ms CPU/调用、128 MB 内存、50 subrequests/调用**；Queue consumer 墙钟 15 分钟。
- 但 Queues 文档同页写“consumer 默认 30 秒 CPU，可配到 5 分钟”，与 Free 10 ms 的账户表存在表述冲突。**实际值必须用线上 invocation 的 `cpuTime` 核实**，不能按 10 ms 直接下结论。
- 本机实测（Node V8，仅量级参考，不是 Workers isolate）：现有 `b64`（`vision.ts:109-114`，32 KB `String.fromCharCode(...Array.from())`）编码 679 KB 需 49–102 ms、1.5 MB 需 329–446 ms、5 MB 需 103–850 ms（冷启动偏高）；`promptData`（stringify+3 个正则+parse）在 5 MB body 上再花 83 ms。若真是 10 ms 上限，5 MB 图必挂 1102；若是 30 s consumer，则没事。**结论：先看线上 cpuTime，再决定是否降图上限。**
- 内存：5 MB 图在 `bytes`+binary string+b64+JSON body+`promptData` 克隆下，单图峰值约 30–50 MB；`annotateTurn` 三张并行可逼近 128 MB。建议视觉单图上限从 5 MB 降到 **1.5 MB**，或把下载/编码改成串行；QQ 群图常见 0.2–1 MB，1.5 MB 足够。
- 子请求/连接：3 张图共 3 次图床 fetch + 3 次模型 fetch = 6 个 subrequests（Free 限额 50）；每张图内部先下载后调模型，所以同一时刻最多 3 个连接在等响应头，低于“同时 6 个”的上限。

### 3.2 现有下载约束（`vision.ts`）

- `MAX_IMAGE_REDIRECTS = 2`（`:138`）；`fetch(..., {redirect:"manual"})`（`:202`），每跳都重新校验 `imageUrl` 和 `qqImageHost`。
- 白名单：`multimedia.nt.qq.com.cn`、`gchat.qpic.cn`、`*.qpic.cn`（`:134-137`），不接受任意域名/私网/IP/localhost。
- 仅 HTTPS、无用户名密码、端口 443（`:116-131`）。
- MIME 仅 `image/jpeg`、`image/png`、`image/gif`、`image/webp`（`:98-103`）；`content-length` 和流式读取双重卡 5 MB（`:234-243`）。
- 共享 12 s 截止（`annotateTurn`，`:505`）+ 模型 10 s 超时（`config/team.json:22`）。三张图共用同一个 12 s，不是每张 12 s。

## 四、Luna 实测（2026-11-14 01:14 Sydney）

用用户已保存的 OpenAI 凭据（Vault `OpenAI-api`，只读入进程，不打印）调用 `gpt-6-luna`：

| 输入 | detail | prompt tokens | completion tokens | 延迟 | 返回 |
|---|---|---:|---:|---:|---|
| 64×64 PNG（`SELFTEST_PNG`） | low | 37 | 39 | 2.21 s | `{"desc":"一个红色圆形位于浅灰色背景中央。","text":"","tags":["红色圆形","简约","几何"]}` |
| 1080×1920 JPEG（80,891 B，base64 107,856） | low | 193 | 41 | 2.07 s | 正确描述方框斜线 + 红圆 |
| 同一张 | high | 2,469 | 39 | 2.33 s | 正确描述，细节更多 |

请求形状（已验证可用）：

```json
{
  "model": "gpt-6-luna",
  "reasoning_effort": "none",
  "messages": [
    {"role": "system", "content": "<TEAM.vision.prompt>"},
    {"role": "user", "content": [
      {"type": "text", "text": "<hint 前 300 字>"},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,...", "detail": "low"}}
    ]}
  ],
  "max_completion_tokens": 300,
  "response_format": {"type": "json_object"},
  "store": false
}
```

注意：`gpt-6-luna` 是推理模型，`max_tokens` 已废弃且与 o-series 不兼容，**必须用 `max_completion_tokens`**；`reasoning_effort:"none"` 时实测 `reasoning_tokens=0`，300 上限不会被思维链吃掉。

### 成本

OpenAI 官方价（`gpt-6-luna`）：输入 $0.1 / 1M tokens，缓存输入 $0.01 / 1M，输出 $0.5 / 1M。

- 1080×1920 `low`：193×$0.1/1M + 41×$0.5/1M ≈ **$0.00004/张**（约 ¥0.0003）。
- 同图 `high`：2,469×$0.1/1M + 39×$0.5/1M ≈ **$0.00027/张**（约 ¥0.0019）。
- 300 张/日上限：low 约 **$0.012/日**，high 约 **$0.080/日**；月 $0.36–$2.4。
- DeepSeek 对照：单图最多 1024 image tokens；`deepseek-flash` 谷时输入 ¥1/M、输出 ¥4/M，高峰 ¥2/M、¥8/M。按 1024 输入 + 100–300 输出，单图约 **¥0.0014–0.0028**（谷时）/ **¥0.0028–0.0056**（高峰）；300 张/日约 ¥0.4–1.7。
- 结论：Luna `low` 比 DeepSeek 谷时还便宜；Luna `high` 与 DeepSeek 高峰同量级。成本不是阻碍，**质量/隐私**才是决策点。

## 五、接入方案（最小改动）

### 5.1 配置

`config/team.json` 的 `vision` 增五个可选键（默认值即现状）：

```json
"vision": {
  "enabled": true,
  "provider": "deepseek",
  "model": "gpt-6-luna",
  "base_url": "https://api.openai.com/v1",
  "detail": "high",
  "fallback": true,
  "daily_cap": 300,
  "turn_max": 3,
  "turn_deadline_ms": 12000,
  "prompt": "…原样…"
}
```

同时改 `config/team.schema.json:188-221`（`provider` enum `["deepseek","openai"]`、`model`/`base_url` string、`detail` enum、`fallback` boolean）和 `config/validate.mjs:60-78` 的校验。schema 的 `additionalProperties:false` 会阻止编辑器识别新键；运行期虽不强制，但两处都应同步。

### 5.2 `src/vision.ts` 新增 provider

在 `deepSeekVision`（`:346-397`）后加；复用其 JSON 校验逻辑（把 `:378-394` 抽成 `parseVisionNote(text)`）：

```ts
export function lunaVision(e: any): VisionProvider {
  const cfg: any = TEAM.vision;
  const base = String(cfg.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    id: "openai:" + (cfg.model || "gpt-6-luna"),
    async describe(bytes, mime, hint, signal) {
      const r = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + e.OPENAI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model || "gpt-6-luna",
          reasoning_effort: "none",
          messages: [
            { role: "system", content: cfg.prompt },
            { role: "user", content: [
              { type: "text", text: redact(hint).slice(0, 300) || "群聊里的一张图" },
              { type: "image_url", image_url: {
                  url: "data:" + mime + ";base64," + b64(bytes),
                  detail: cfg.detail || "high",
              }},
            ]},
          ],
          max_completion_tokens: 300,
          response_format: { type: "json_object" },
          store: false,
        }),
        signal,
      });
      if (!r.ok) throw Error("视觉请求失败（" + r.status + "）");
      const d: any = await r.json();
      return parseVisionNote(d.choices?.[0]?.message?.content);
    },
  };
}
```

要点：
- `src/vision.ts:6` 的 import 要从 `{ model }` 改成 `{ model, redact }`；`parseVisionNote` 从 `:378-394` 抽出，两个 provider 共用。
- 用 `redact(hint)`（`runtime.ts:4-15`）而不是 `promptData(body)`；图片 base64 不需要跑三个大正则，省 80 ms/5 MB，同时保留“密钥不入提示词”的保证。
- 不经过 `model()`，因为 `model()` 会强行加 DeepSeek 的 `thinking` 字段、固定 `api.deepseek.com` 和 `DEEPSEEK_API_KEY`；OpenAI 会因未知字段 400。
- 如果必须把 Luna 用量记进 `model_runs`/`model_usage`，把 `runtime.ts:99-122` 抽成 `recordModel(e,kind,effort,status,start,usage)`，在 `lunaVision` 成功后调一次；不要为此改 `model()` 的签名。

### 5.3 provider 选择与回退

```ts
export function visionProvider(e: any): VisionProvider | null {
  if (TEAM.vision?.enabled === false) return null;
  const cfg: any = TEAM.vision;
  const openai = cfg.provider === "openai" && e.OPENAI_API_KEY;
  const primary = openai ? lunaVision(e) : deepSeekVision(e);
  if (!openai || cfg.fallback === false) return primary;
  return {
    id: primary.id + "+deepseek",
    async describe(bytes, mime, hint, signal) {
      // 动态 GIF 只有 DeepSeek 文档明确支持；OpenAI 只支持非动画 GIF
      if (mime === "image/gif") return deepSeekVision(e).describe(bytes, mime, hint, signal);
      try {
        return await primary.describe(bytes, mime, hint, signal);
      } catch (err) {
        if (signal.aborted) throw err;       // 12s 总截止到了，不再二次等待
        return deepSeekVision(e).describe(bytes, mime, hint, signal);
      }
    },
  };
}
```

回退触发：`401/403/404/429/5xx`、超时、空输出、JSON 不合法、图片格式拒绝。`signal.aborted` 时不回退，避免总时长翻倍。

### 5.4 缓存键（必须改，否则回滚后 Luna 的描述永久留在 D1）

`vision.ts:429` 现在是 `sha256(bytes)+":"+VISION_VERSION`。改成：

```ts
const tag = (TEAM.vision as any).provider === "openai"
  ? "v1:openai:" + ((TEAM.vision as any).model || "gpt-6-luna")
  : "v1";
const sha = (await sha256(bytes)) + ":" + tag;
```

这样 DeepSeek 旧缓存继续命中，Luna 用自己的命名空间；切回 DeepSeek 不会读到 Luna 的结果。`VisionProvider` 接口加 `id?: string`（可选，避免现有测试里手写的 provider 对象报错），`deepSeekVision` 返回 `id:"deepseek"`，`lunaVision` 返回 `id:"openai:"+model`。

### 5.5 secret / 部署管线

- `src/worker.ts:62` 加 `OPENAI_API_KEY?: string`。
- `scripts/sync-runtime-secrets.py:8` 加 `"TEAM_OPENAI_API_KEY": "OPENAI_API_KEY"`。
- `.github/workflows/check.yml:31-39` 加 `TEAM_OPENAI_API_KEY: ${{ secrets.TEAM_OPENAI_API_KEY }}`。
- `.dev.vars.example`、`docs/operations.md:11` 各加一行名字。
- Worker secret 名建议 `OPENAI_API_KEY`（与 `DEEPSEEK_API_KEY` 对称）；值由交付员从 Vault/用户处注入，**不写入仓库、聊天、日志**。
- 不新增 binding、不新增 D1 迁移、不新增队列；免费档够用。

### 5.6 验证顺序

1. `npm run check` + `npm test`：新增 mock 覆盖 `gpt-6-luna` 请求体（有 `max_completion_tokens`、无 `max_tokens`/`thinking`）、429 回退、缺 key 回退、GIF 走 DeepSeek、缓存键隔离。
2. 本地 `wrangler dev --local` + `.dev.vars` 的 `OPENAI_API_KEY`，跑 `test/vision.test.mjs` 的 3 张图场景；不碰生产 D1。
3. 线上 owner-only `GET /api/team/vision/selftest`：验证 secret、模型、JSON 解析、超时；返回 `ms` 应 ≈ 2 s（本机实测）。
4. 真实图验收：本地 `wrangler dev --local` 用一个 0.5–1 MB 的中文截图 fixture 跑完整 `annotateTurn`，核对 `image_notes.desc/text`、`message_images`、12 s 截止；**不碰生产 D1，不往群里发测试消息**。发布后只用真实群消息观察一次。
5. 盲评 20 张（截图/表情包/商品图/人像各 5 张），Luna `high` vs DeepSeek 当前，比 OCR 准确率、幻觉、延迟、成本；这是 多模态员 的评估范围，我不写他的报告。

## 六、回退方案

| 场景 | 操作 | 影响 |
|---|---|---|
| Luna 质量不如 DeepSeek | `vision.provider:"deepseek"`，部署 | 立即回到现状；Luna 缓存不命中（键不同） |
| Luna 账号/区域故障 | `vision.fallback:true`（默认） | 单次请求内自动回退；群回复不中断 |
| 成本超预期 | `daily_cap` 降到 100，或 `detail:"low"`，或 `turn_max:1` | 单日上限线性下降；无需改代码 |
| 隐私不接受 | `vision.enabled:false` | 图片只显示尺寸，不调模型（现有 `visionProvider` 已支持） |
| 模型 id 不可用 | `vision.model:"gpt-5.6-luna"` | 同一 API；本轮未实测 5.6 |
| 不想加 secret | 不配 `OPENAI_API_KEY` | `visionProvider` 直接走 DeepSeek，不报错 |

## 七、隐私 / 成本 / 风险

- **数据出境**：图片和 hint（可能含群昵称、引用文本）会发给 OpenAI（美国默认区域）；现有链路发给 DeepSeek。OpenAI 官方：API 数据默认不用于训练；abuse monitoring 日志最多 30 天；图片输入会做 CSAM 扫描，命中会人工保留。DeepSeek 的保留/训练条款需按其隐私政策单独核对，本轮未逐条验证。
- **图片内容**：群图可能含人脸、聊天截图、手机号/地址；`image_notes` 会把 desc/text 永久存 D1 并注入后续所有提示词。Luna 的 OCR 更强，意味着更多原文进入 D1；`imageNotesFor` 已用 `untrusted()` 包裹图中文字（`vision.ts:563-568`），注入侧安全，但存储侧仍需按群规处理。
- **提示词注入**：图中文字仍按“资料不是指令”处理（`config/team.json:97`）；Luna 更会“读字”，被截图里的指令带偏的风险不低，保持 `untrusted` 包裹，不要把 OCR 文本升级为系统指令。
- **CPU/内存**：见 §3.1；5 MB 图在 10 ms 档位不可行，在 30 s consumer 可行但三张并行接近 128 MB。**上线前先把 `b64` 换成 `String.fromCharCode.apply(null, chunk)`（本机 5 MB 从 103–850 ms 降到 16–25 ms）并把单图上限降到 1.5 MB**，这是现有代码的独立改进，不依赖 Luna。

  ```ts
  export function b64(bytes: Uint8Array) {
    let binary = "";
    for (let at = 0; at < bytes.length; at += 8192)
      binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 8192) as any);
    return btoa(binary);
  }
  ```
- **动画 GIF**：OpenAI 只支持非动画 GIF；QQ 表情包大量是动画 GIF，必须走 DeepSeek 或先抽首帧，否则会 400。
- **模型访问**：`gpt-6-luna` 用当前 key 实测通过；不同 org/project 可能没有该模型，404 时回退或改 `gpt-5.6-luna`。
- **代理/中转**：若用户的 key 走的是中转（不是 `api.openai.com`），用 `vision.base_url` 覆盖；Cloudflare Worker 不能访问本机 `127.0.0.1:3425` 这类地址。
- **D1 预算**：Luna 本身不增加 D1 语句；每张图仍是 cache SELECT 1 + budget 1 + note INSERT 1 + link INSERT 1 +（若记录用量）2 ≈ 6 条，3 张 18 条，仍在 48 条预算内。回退不写额外行。

## 八、B 站真实视频静帧探测（只读，不下载视频流）

探测方式：`curl --compressed` 取 `https://www.bilibili.com/video/<BV>/` 的 `__INITIAL_STATE__`，解析 `pages[]`；`videoshot` 走公开 JSON API；图片只 `HEAD`，不下载雪碧图/视频流。`api.bilibili.com/x/web-interface/view` 直连返回 **HTTP 412**（风控），页面 HTML 可用；`x/player/v2` 与 `x/player/videoshot` 返回 200/code 0。

| 视频 | 标题 | 分P | 时长/分辨率 | `pages[0].first_frame` | 雪碧图 `videoshot` | 封面 `pic` |
|---|---|---|---|---|---|---|
| `BV1GN4p6pEEP` | 10月鸿蒙智行销量暴跌?理想MEGA只卖四十多万?看完就懂了 | **1 P**（cid 43418980222） | 695 s / 1080×1920 | `i0.hdslb.com/bfs/storyff/_00002o4yn3qd3ufop2uocp57fidx4gb_firsti.jpg`，HEAD 200，image/jpeg，**58,034 B** | 10×10 格，480×270/格，**2 张**，140 个索引（约每 5 s 一帧） | `i2.hdslb.com/bfs/archive/b214cc53…jpg` |
| `BV1MEW46JEYB` | 黄仁勋承认出轨，绝不仅是裤裆里那点事儿 | **1 P**（cid 43455155073） | 951 s / 1920×1080 | `i2.hdslb.com/bfs/storyff/_000033xk9kk86tozq2fiyasd1etkj8b_firsti.jpg`，HEAD 200，image/jpeg，**48,085 B** | 10×10，480×270，**2 张**，188 个索引 | `i0.hdslb.com/bfs/archive/08bff377…jpg` |
| `BV1jjBYYRE9m` | 【完整版】温铁军2024年11月演讲，主题：全球化解体与中国的压舱石。 | **1 P**（cid 26993820458） | 3,591 s / 1920×1080 | `i2.hdslb.com/bfs/storyff/n241125sa164e8t8bk0nno2kw5m9yliz_firsti.jpg`，HEAD 200，image/jpeg，**48,386 B** | 10×10，480×270，**8 张**，717 个索引 | `i1.hdslb.com/bfs/archive/632f93f1…jpg` |

结论（B 站部分）：

- **3/3 都有官方首帧** `pages[].first_frame`，可直接当“单帧识图”输入；但每支只有 1 个 P，**没有多 P 样本**。`first_frame` 是 `pages[]` 内的字段，多 P 时理论上按 P 各有一条，但本轮未实测多 P 视频，不能把“分P多截图”说成已验证。
- **3/3 都有官方 `videoshot` 雪碧图**：`GET https://api.bilibili.com/x/player/videoshot?bvid=<BV>&cid=<cid>&index=1` 返回 `image[]`、`img_x_len=10`、`img_y_len=10`、`img_x_size=480`、`img_y_size=270`、`index[]`；约每 5 秒 1 帧，可裁切成静帧。**这是官方预览帧，不是关键帧，也不是全分辨率**；用于“有没有这张图/大致画面”可以，用于读小字/精确细节不够。
- **封面 `pic` 不是关键帧**：三支的封面都是 `archive/*.jpg`，与 `storyff/*_firsti.jpg` 不同 URL；封面可能是摆拍/设计图，不能当视频画面证据。
- `x/player/v2` 的 `view_points` 在两支上都是 0 条，**没有官方“高能看点”截图**可借。
- 本地 `TeamAgent-bili-card-archive` 只有 `.agent`，`TeamAgent-bili-media-acceptance-20261113` 无 jpg/png/webp；**没有现成静帧素材**。
- 边界：以上只证明“存在官方首帧/预览雪碧图”，**不等于已做视频画面理解评测**；没有下载视频流、没有抽关键帧、没有验证 ASR/字幕与画面的对应关系。

## 九、未验证 / 限制

- 未用真实 QQ 群图片跑 Luna（生产 D1 只读，拿不到图片 URL；未往群里发消息）；Luna 的实测是 64×64 PNG + 合成 1080×1920 JPEG，不代表真实聊天截图/表情包/低质图。
- 未实测 DeepSeek 与 Luna 的同图质量对比；未做 20 张盲评。这是 多模态员 的评估范围。
- 未实测 `gpt-5.6-luna`；未验证用户 OpenAI key 所在 org 的 rate limit/数据区域/是否 ZDR。
- 未读线上 Worker 的 `cpuTime`；§3.1 的 10 ms vs 30 s 冲突需要线上日志定论。
- 未改任何代码；§5 是接入方案，不是已实现。`b64` 性能是本机 Node 基准，Workers isolate 会有差异，但量级差 5–50 倍，方向明确。

## 十、依据（外部链接，2026-11-14 抓取）

- DeepSeek Vision（`deepseek-flash` 图片输入、格式/上限/token 规则）：https://api-docs.deepseek.com/guides/vision/
- DeepSeek 模型与价格（谷时/高峰、输入输出单价）：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- OpenAI GPT-6 Luna（model id、image_input、Chat Completions、价格、上下文）：https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenAI Images and vision（`image_url`/`detail`、patch 计费、非动画 GIF 限制）：https://developers.openai.com/api/docs/guides/images-vision
- OpenAI 数据控制（不训练、abuse 30 天、图片 CSAM 扫描）：https://developers.openai.com/api/docs/guides/your-data
- OpenAI Chat Completions（`max_completion_tokens`、`max_tokens` 弃用）：https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- Cloudflare Workers 限制（Free 10 ms/128 MB/50 subrequests、Queue 15 min）：https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Queues 限制（consumer CPU/墙钟）：https://developers.cloudflare.com/queues/platform/limits/
- B 站页面/接口：`https://www.bilibili.com/video/BV1GN4p6pEEP/`、`https://www.bilibili.com/video/BV1MEW46JEYB/`、`https://www.bilibili.com/video/BV1jjBYYRE9m/`、`https://api.bilibili.com/x/player/videoshot?bvid=<BV>&cid=<cid>&index=1`
