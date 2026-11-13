# 生图能力（generate_image）

F8 新增：成员在群里 @我 说「帮我画/生成一张……的图」，模型自己判断意图后调用 `generate_image`，结果由后台单独发一张 JPEG 到本群。实现：`src/imagegen.ts`（F8-1）、`src/tools/generate-image.ts`（F8-2），OpenAI 通道 `src/openai.ts`（F8-0）。

## 用法

- @我 + 帮我画/生成一张……的图，把画面描述直接给我；不需要命令前缀。
- 回复只说正在生成/已生成，不贴链接、不编造画面；图片随后单独发出。
- 尺寸默认 `1024x1024`，可选 `1024x1536`、`1536x1024`；默认低质量档，超时 100 秒。
- JPEG 超过 1.5 MB 不入库，按失败如实告知，不自动降质量重试。

## 限额

- 每人每天 5 张（settings `imagegen:user_daily` 可调）；每群每天 20 张（`imagegen:group_daily` 可调）。
- 按悉尼时间 0 点重置；超额返回 `quota`，回复写「今天还剩 0 张，明天（悉尼时间 0 点后）重置」。
- 全局日预算 settings `openai:daily_cap_micro_usd`，默认 3_000_000 微美元（$3）；超了返回 `budget`。

## 被拒（内容安全）

- 口径只有两句：图没生成 + 提示词被内容安全系统拒绝，建议换个说法或换一种描述再试。
- 参考失败 note：「这张图没生成：提示词被内容安全系统拒绝了。可以换个说法或换一种描述再试。」
- 不复述违规细节，不解释规则边界，不教绕过（改写、拆词、换语言、换账号都不提）。
- 拒绝不可重试（`refused`，`retryable:false`），不自动换提示词再发一次。

## 成本

- 每次调用写 `openai_usage`（purpose `image_gen`，含 model、latency、`est_cost_micro_usd`）；单价以 OpenAI 账单为准，不写死。
- 失败/被拒不自动重试，避免放大成本；由成员决定是否再要一张。

## 关闭

- 只关生图：settings `off:generate_image` = 1。
- 关闭全部 OpenAI 能力：settings `off:openai` = 1。
- 关闭后能力卡把 `generate_image` 标成「当前已关闭」，模型不再调用。
