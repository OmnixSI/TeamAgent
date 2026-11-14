# SK · 机器人自知（自知卡）
目标（用户 02:26）：群里机器人被问到自己的任何能力——怎么实现的、后面接 DeepSeek 还是 OpenAI、跑在哪、哪些开关开着、代码在哪个文件、仓库怎么组成——都能答准、与线上当前版本一致，不猜、不说「不知道」。
基线：release/SK（= release/F9DS @8a4cabe + 接口提交 37d454c）。集成 worktree /Users/yanghongming/Projects/.worktrees/TeamAgent-SK-release。

## 现状
- 能力卡 src/capability-card.ts 只列工具名+一句话描述+限额，不含「用哪家服务/模型、文件在哪、跑在本机还是云端、仓库构成」。
- 仓库发现 src/repo.ts / repo-discovery.ts / tools/repo-search.ts 已能读代码；OmnixSI/TeamAgent 在 config/team.json 白名单内，repo_file 可读自己的源码。
- 提示词注入点 src/semantic.ts:926；工具扩展点 src/toolkit.ts + src/tools/index.ts（BotTool，开关 settings 键 `off:<switch>`）；/health 在 src/worker.ts:1429；发布变量 RELEASE 由 scripts/deploy.mjs 注入。

## 方案：生成 + 校验 + 运行时合并
1. **生成（构建期）** scripts/gen-self-card.mjs 产出 src/self-card.generated.ts（gitignore，和 ui.generated.ts 同做法，挂在 precheck/pretest/postinstall 和 wrangler build 命令上）。
   - 自动从代码取：工具表（用 esbuild 打包 src/tools/index.ts 与 semantic 的 baseTools 后导入真实对象）、各工具描述与开关、API 主机/模型名/环境变量名（按清单里的 pattern 在指定文件里实际 grep 出来）、限额数字、migrations 的表名、wrangler.toml 的 cron/队列/绑定名、src 与 runner 下各模块首个注释行与行数、worker 入口行号、git HEAD。
   - 人写的只有 config/self-manifest.json：能力 → 说明链路一句话、关键文件+锚点、厂商 pattern、开关名、环境变量名、本机/云端、限额 pattern。**生成器会校验清单**：文件不存在、pattern 在文件里找不到、开关名在代码里没出现、有已注册工具没被任何能力登记（除非列在 `uncovered_ok`）→ 构建失败。这样新增能力不登记就发不了版，清单陈旧也发不了版。
   - 密钥铁律：只读 src/ runner/ scripts/ migrations/ config/team.json wrangler.toml package.json；不读 .env/.dev.vars/密钥文件/~/.ssh；卡里只有环境变量**名**和「密钥存哪类位置」，绝不出现值；仓库名取自 config/team.json，不取 git remote（避免带令牌的地址）。
2. **运行时（线上）** src/self-card.ts：加载生成卡，合并真实状态（settings 里的 off:* 开关、环境绑定是否存在（只要布尔）、版本对比 env.RELEASE），每个能力给出状态：enabled / switched_off / not_configured / off_by_default / local_unverified，非 enabled 一律如实说「已写好未启用（原因）」。
3. **机器人怎么用**
   - 新工具 `describe_self`（src/tools/describe-self.ts，加入 EXTRA_TOOLS，只读、不污染 untrusted）：参数 topic = overview | capability | vendors | repo_map | switches，可带 query（能力名/别名/工具名/关键词）。返回文字段落，带版本头「自知卡 <sha7>｜线上 <sha7>」、文件:行、厂商、模型、开关当前状态、本机/云端、限额。
   - 提示词：能力卡后加一行「底层服务」自动摘要（由卡生成，如「回复用 DeepSeek deepseek-flash；生图用 OpenAI gpt-image-1；…」，关闭的标「当前已关闭」）+ 一句指引：被问自身实现/厂商/位置/开关/仓库构成时先调 describe_self，需要代码细节再用 repo_file 读 OmnixSI/TeamAgent 并给文件和大致行号；查不到就说没查到，不编；不得输出任何密钥/令牌/凭据的值。
   - 版本不一致（卡版本≠env.RELEASE）时返回里明说，并建议以 repo_file 读到的为准。
4. **发布闭环**：/health 增加 `selfCard:{commit,built_at}`；scripts/verify-release.mjs 增加「selfCard.commit === 本次提交」；上线检查表（/Users/yanghongming/Projects/deploy-runbook.md，主程已加一条）要求交付员核对。每趟上线自动重新生成，不需要人手更新。

## 工作包
- SK-1 生成器 + 清单 + 构建/发布钩子 —— 工程师（DeepSeek）。分支 pkg/SK-1，worktree …/TeamAgent-SK-1。
- SK-2 运行时合并 + describe_self 工具 + 提示词摘要 + /health —— 工程师（DeepSeek）；只依赖冻结接口 src/self-card-types.ts 和 test/fixtures/self-card.sample.json，可与 SK-1 并行。
- SK-3 验收回放 —— 测试员（DeepSeek）。先在样例夹具上搭框架，SK-1/SK-2 合入后跑真实卡。
热文件：src/semantic.ts（只改注入处一行）、src/worker.ts（只加 /health 字段）、src/capability-card.ts（只加底层服务摘要和指引）、package.json（只 SK-1 改）。与快速线冲突先走快速线。

## 验收场景（见 acceptance.json）
S1 生图怎么实现 / S2 语音识别哪家 / S3 OpenAI 还是 DeepSeek / S4 仓库怎么组成 / S5 看图用什么模型 / S6 开关关闭如实说已写好未启用 / S7 卡里无密钥值 / S8 卡版本=/health 版本，版本不一致时说明。
回放：本地独立假库（test/support.mjs 的 env()），真实问法；答案事实逐条对照代码事实（由测试从代码里独立取得，不从卡里取）；只读线上、不写线上 D1、不往群里发。真实群验证由用户自己 @ 触发。

## 风险
- 清单需人工登记，靠「未登记工具即构建失败」兜底；厂商 pattern 找不到即失败，防陈旧。
- 模型可能不调 describe_self：靠提示词里的底层服务摘要兜底（常见问题直接就能答对）。
- 卡变大占提示词：提示词里只放摘要（≤400 字），详情走工具按需取，每段 ≤1500 字。
