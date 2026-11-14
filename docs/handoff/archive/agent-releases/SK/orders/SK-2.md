# 施工单 · SK · SK-2 运行时合并 + describe_self 工具 + 提示词摘要 + /health
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-SK-2   分支：pkg/SK-2（基线 release/SK@37d454c）
先读：/Users/yanghongming/Projects/.agent/releases/SK/design.md、src/self-card-types.ts（冻结接口，不许改）、test/fixtures/self-card.sample.json（你开发用的样例卡）、src/toolkit.ts 与 src/tools/index.ts（BotTool 扩展点）、src/capability-card.ts 与 test/capability-card.test.mjs。
目标：线上机器人能运行时读取自知卡 + 真实开关状态，回答「怎么实现 / 哪家服务 / 跑在哪 / 开关 / 代码在哪 / 仓库怎么组成」。SK-1 同时在做生成器（产出 src/self-card.generated.ts，gitignore，导出 `SELF_CARD: SelfCard`）。你**不要依赖它存在**：用依赖注入，生产代码从 ./self-card.generated 导入，测试里传样例夹具。

## 要新增/改的文件
- 新增 src/self-card.ts（纯函数 + 一个薄的异步加载）
  - `export async function readLive(e, release?): Promise<SelfLive>`：一次 `SELECT key,value FROM settings WHERE key LIKE 'off:%'` 取开关；envPresent 只给**布尔**：对卡里所有 requires_env 名字，`!!e[name]`（Worker 环境绑定）；release = e.RELEASE || "development"。绝不把任何 env 值放进返回值。
  - `export function capabilityState(cap, live): { state: SelfState; reason: string }`：开关命中（`off:<sw>` 值非空且不是 "0"/"false"，沿用 src/toolkit.ts toolSwitchedOff 的判定）→ switched_off；requires_env 有缺 → not_configured（reason 写缺哪个名字）；default_state==="off_by_default" 且无显式开启 → off_by_default；runs_on 含 local → local_unverified（reason：「依赖本机服务，云端无法确认它此刻在线」，不要说它坏了）；否则 enabled。
  - `export function renderSelf(card, live, topic, query?): string`：topic = overview | capability | vendors | repo_map | switches。
    - 头一行固定：`自知卡 <card.commit前7位>｜线上 <live.release前7位>`；两者不同（且 live.release≠"development"）时第二行加「注意：自知卡版本与线上不一致，细节以 repo_file 读到的代码为准」。
    - overview：每个能力一行「标题：厂商+模型 / 本机或云端 / 状态」；非 enabled 的状态用「已写好未启用（原因）」或「当前已关闭」措辞，绝不把关闭/未配置/未启用的说成能用。≤1500 字。
    - capability（query 必填）：按 id、title、aliases、tools 名、provider.vendor 做包含匹配（不区分大小写，别名与中文关键词都能命中；可命中多个，最多 3 个）。每个能力输出：说明链路 how、厂商/模型/主机、关键文件 path:line 与 role、开关名与当前状态、所需环境变量**名**、本机/云端、限额、状态。无匹配时返回「自知卡里没有这个能力」并列出全部能力标题，不得编造。
    - vendors：每个厂商用于什么、环境变量名、密钥存放位置（只说类别，不说值）。
    - repo_map：top_dirs、关键 modules（按行数前 25）、entrypoints、tables、crons、queues、bindings、repo 名；结尾提示「具体代码用 repo_file 读 <repo>，给文件和大致行号」。
    - switches：卡里出现的所有开关名 → 当前 on/off。
    - 所有输出最后过一遍 src/repo.ts 的 redactPatch，且单段 ≤1800 字（超出截断并注明）。
  - `export function vendorSummary(card, live): string`：一行「底层服务（自动生成，<sha7>）：回复与推理用 DeepSeek deepseek-flash；生图用 OpenAI gpt-image-1；…」，按能力聚合，非 enabled 的标「（当前已关闭）」或「（已写好未启用）」，≤400 字。
- 新增 src/tools/describe-self.ts：BotTool，name "describe_self"，def 描述「查自己：被问到你自己某个能力是怎么实现的、用哪家模型/接口、跑在本机还是云端、哪些开关开着、代码在哪个文件、仓库怎么组成时先调用。topic: overview|capability|vendors|repo_map|switches；capability 要给 query。」`untrusted:false`，switch 默认（工具名 describe_self），run 里 `readLive` + `renderSelf`，返回 `{ok:true, text, card_commit, release}`。SELF_CARD 从 ../self-card.generated 导入。
- 改 src/tools/index.ts：加一行导入并按字母序加入 EXTRA_TOOLS。
- 改 src/capability-card.ts：在 compose 里 CARD_TAIL 之前插入两行（由调用方通过 opts 传入，保持本模块纯函数、不读 D1）：`opts.selfSummary?: string`（vendorSummary 的结果）与固定指引常量 SELF_HINT=「被问到你自己的能力怎么实现、用哪家模型/接口、跑在哪、开关、代码在哪、仓库怎么组成时，先调用 describe_self 取事实，需要代码细节再用 repo_file 读 OmnixSI/TeamAgent 并给出文件和大致行号；查不到就说没查到，不要猜，也不要输出任何密钥、令牌、凭据的值。」CARD_MAX 若不够就提到 1800，并同步修改 test/capability-card.test.mjs 里依赖 1200 的断言（只改数字/必要断言）。
- 改 src/semantic.ts：只改第 926 行附近的注入处：先 `const live = await readLive(e, e.RELEASE)`（失败则 try/catch 降级为不带摘要），把 `vendorSummary(SELF_CARD, live)` 作为 selfSummary 传给 capabilityCard。不改其他逻辑。
- 改 src/worker.ts：/health（约第 1429 行）响应里加 `selfCard: { commit: SELF_CARD.commit, built_at: SELF_CARD.built_at }`（从 ./self-card.generated 导入）。不改其他逻辑。
- 新增 test/self-card.test.mjs（先写）：用 esbuild 打包 src/self-card.ts（写法见 test/capability-card.test.mjs），加载 test/fixtures/self-card.sample.json 作为 card。用例：
  1. 生图问法（query「生图」「画图」「generate_image」）→ 输出含 OpenAI、gpt-image-1、src/imagegen.ts:100、「每人每天 5 张」。
  2. 「语音识别」→ 含 X-ASR、runner/asr.mjs、「本机」，状态 local_unverified 措辞，不含「云端识别」。
  3. 开关 off:image_gen=1 → 输出含「当前已关闭」或「已写好未启用」，且不含「可以直接」类肯定措辞；off:openai=1 同理；envPresent.OPENAI_API_KEY=false → 「未配置」且点名 OPENAI_API_KEY 这个**名字**。
  4. 版本不一致（card.commit 与 live.release 不同）→ 含「自知卡版本与线上不一致」；一致/development 时不含。
  5. 无匹配 query → 含「自知卡里没有这个能力」且列出标题。
  6. 注入假密钥：e.OPENAI_API_KEY="sk-test-FAKE0123456789012345678901234567890"、e.DEEPSEEK_API_KEY 同类 → overview/capability/vendors/repo_map/switches 全部输出与 vendorSummary、/health 响应里都搜不到这些值；只出现环境变量名。
  7. vendorSummary ≤400 字，关闭的能力带标记。
  8. describe_self 经 runExtraTool 调用（用 test/support.mjs 的 env()）返回 ok:true 与 text；其开关 off:describe_self=1 时被拒绝。
  9. capability-card 现有测试全部继续通过；系统提示里含 SELF_HINT 与「底层服务」行。
  生产代码用 ./self-card.generated；它由 SK-1 生成。你本地需要它才能 `npm run check`：在你的 worktree 里临时用一个**不提交**的 stub（把样例夹具转成 TS 导出 SELF_CARD），已被 gitignore 的话放 src/self-card.generated.ts 即可；若 SK-1 已合入 release/SK 则 `git merge release/SK` 用真的。

## 验证命令
`npm run check 2>&1 | tail -30 && node --test test/self-card.test.mjs test/capability-card.test.mjs 2>&1 | tail -30 && npm test 2>&1 | tail -15`（全量不得红，基线数字写进笔记）

## 不要做
不改 src/self-card-types.ts、scripts/、package.json、config/（SK-1）；不在 semantic.ts 里放逻辑；不查线上 D1；不输出任何 env 值（只要布尔和名字）。
## 参考
src/toolkit.ts toolSwitchedOff；src/tools/generate-image.ts（BotTool 写法）；src/repo.ts redactPatch。
done_when：验证命令全绿；9 类用例都有；全量测试不回归；git diff 里 semantic.ts 与 worker.ts 各只有几行。
交回：分支、提交号、测试数字、CARD_MAX 是否改动。进度笔记 /Users/yanghongming/Projects/.agent/releases/SK/notes/SK-2.md（每步追加一行）；上下文压缩后先做开工仪式。
