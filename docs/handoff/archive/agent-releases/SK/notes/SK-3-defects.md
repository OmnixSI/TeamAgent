> 状态（2026-11-14 03:16）：P1-1 与 P1-2 已在 `release/SK` `5d29297` 修复，A 层 24/24 验证通过。
> 本文件保留发现时的证据。剩余 S4 用户回答缺 D1 表/队列/绑定见 `replay/B-report.md` §缺陷1。

# SK-3 发现的缺陷（测试员只列，不改产品代码）

基准：`pkg/SK-2@6c5ee70` + SK-1 真实生成卡（`37d454c`），临时预览 worktree；A 层走真实
`describe_self` + 假 D1，B 层真实 DeepSeek、假库、出站只放行 api.deepseek.com。

## P1-1 describe_self 被当成后台 research 任务（阻塞真实使用）

- 文件：`src/semantic.ts:9`（`LOCAL_TOOLS` 没有 `describe_self`），`src/semantic.ts:986`。
- 触发：模型任何一次调用 `describe_self`。
- 现象：`answerWithTools` 把非 LOCAL_TOOLS 的工具调用转成 `research-*` 后台任务，立即返回
  「查着呢，待会儿单独回你」；B 层 24 条只有 1 条通过。典型回答：
  「生图那条链路我后台捋一下，稍等单独回你这条」「在查了，查清楚直接回你这条」。
- 验证：在预览 worktree 临时把 `describe_self` 加进 `LOCAL_TOOLS`（未提交），B 层升到
  19/22；说明修复点有效。它是只读本地工具，不应走 research 后台。
- 建议修法：`LOCAL_TOOLS` 增加 `describe_self`；或把只读 EXTRA_TOOLS 统一视为本地工具。

## P1-2 repo_map 段被 1800 字截断，S4 永远答不全

- 文件：`src/self-card.ts:21`（`SEGMENT_MAX=1800`）、`src/self-card.ts:249-266`（repoMap）、
  `src/self-card.ts:304`（clip）。
- 现象：`repo_map` 实际输出 1824 字，只渲染到「关键模块」，尾部
  「…（本段超过上限，已截断）」；`数据表`、`定时`、`队列`、`绑定` 四行完全没有机会出现。
  `messages`/`outbox`/`settings` 均不在输出里（`jobs` 只是模块名碰巧出现）。
- 影响：S4 的 A 层与 B 层都失败；A 层预览 22/24，仅 S4 两条失败。
- 建议修法：把「入口/数据表/定时/队列/绑定」放到 top_dirs 与 modules 之前；压缩目录 role
  或拆成 `repo_map`（摘要）+ `repo_detail`（长列表），保证摘要段不被截断。

## P2 仓库问题有时不走 describe_self

- 现象：S4-q2 有一条真实回答「没拿到代码索引结果，brief 里只有一段损坏的工具调用残留…
  缺 GitHub 只读 token」，模型改调了 repo_file/search_code，而不是 describe_self repo_map。
- 影响：即使修好 P1-2，仓库类问题仍可能因为工具路由失败而答不出；建议提示词把
  describe_self 的 repo_map 明确为「仓库构成」的第一来源，repo_file 只用于要具体代码行时。

## P2 单条回答把 JSON 协议残留带进正文

- 现象：S6 no_openai_key 的一条回答在正常中文后追加了
  `{"mode":"banter","text":"..."}` 原文；不影响事实，但会原样发到群里。
- 位置：`src/voice.ts` 的 `speakBrief`/`decodeVoice` 之后仍出现 JSON 块，需 SK-2 复核
  是否是模型把协议 JSON 写进了 text 字段。

## 已校准、不算缺陷的项

- 样例夹具 `gpt-image-1` 与当前代码 `gpt-image-2.5-flare` 不一致：样例只作脚手架，不作验收卡。
- S1 回答不总写 `api.openai.com`，但写明 OpenAI + 模型 + 文件 + 限额；验收不要求主机，已去掉该断言。
- S2 回答写 `media.mjs` 而不是 `runner/asr.mjs`：两者都在 runner/，已允许。
- S7-q1「你能发语音吗」只要求「没接进群 + SILK」；厂商与文件由 q2「语音合成用哪家」承担。
