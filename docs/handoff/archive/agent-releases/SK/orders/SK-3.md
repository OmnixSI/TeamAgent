# 施工单 · SK · SK-3 验收回放（测试员）
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-SK-3   分支：pkg/SK-3（基线 release/SK@37d454c）
先读：/Users/yanghongming/Projects/.agent/releases/SK/design.md 与 acceptance.json；src/self-card-types.ts；test/fixtures/self-card.sample.json；test/capability-card.test.mjs（esbuild 打包 + 假库 env() + mock fetch 的写法）。SK-1（生成器 → src/self-card.generated.ts）和 SK-2（src/self-card.ts、describe_self 工具、提示词摘要、/health.selfCard）正在并行开发；你先在样例夹具上搭好框架，等它们合入 release/SK 后 `git merge release/SK` 再跑真实卡。
目标：用真实问法逐条核对「机器人讲出来的答案」与「代码里的事实」一致，把 acceptance.json 的 S1–S8 变成可重复运行的脚本。你是唯一能改 acceptance.json 里 passes/evidence 的人，但**只有在真实卡上跑通才能置 true**。

## 要新增的文件
- test/self-card-replay.test.mjs（node:test，纳入 npm test）
- scripts/self-card-replay.mjs（可手跑，输出 JSON 报告到 .agent/ 下；证据路径写进 acceptance.json evidence）
- test/fixtures/self-questions.json：问法 + 期望事实（见下）

## 事实从代码独立取得（不得从生成卡里取，否则自证）
测试里用 fs + 正则直接读 src/、runner/、config/team.json、wrangler.toml、migrations/ 得到：生图的接口主机与模型名（src/imagegen.ts）、每人每天限额数字（对应常量）、回复模型名（config/team.json model.name 与 api.deepseek.com 出现位置）、语音识别实现文件（runner/asr.mjs 等）与它走本机 X-ASR 还是云端（读代码判断，写进注释）、看图模型/主机（src/vision.ts 等，以当前合入的代码为准）、TTS 厂商（F9DS：DeepSeek TTS + SILK）、队列名与 cron（wrangler.toml）、顶层目录。

## 两层回放
A 层（确定性，必须有，进 npm test）：每个真实问法 → 按 describe_self 的用法（topic/query 映射写在 self-questions.json）调用 renderSelf/runExtraTool（假库 env()）→ 断言输出同时包含对应「代码事实」里的全部项（主机、模型、文件路径、限额数字、本机/云端、队列名等），且不含相反事实（例如问 OpenAI vs DeepSeek 时不能把生图说成 DeepSeek）。问法至少覆盖：「你这个生图是怎么实现的」「语音识别用的哪家」「你和 OpenAI 还是 DeepSeek 接的」「你的仓库是怎么组成的」「看图用什么模型」「你能发语音吗/语音合成用哪家」「你跑在哪里，本机还是云端」「你的生图开关现在开着吗」「你的代码在哪个文件」，每个问法写 2 种口语变体（共 ≥18 条）。
B 层（真实模型，可选但要跑一次留证）：用 scripts/f9ds-2a-live.mjs 里取 DeepSeek 凭据文件的既有办法（凭据只经环境变量/文件路径读，绝不写进仓库、日志、报告），走 semantic.ts 的 agentAnswer，**数据库用本地假库、出站发消息的函数用 mock（QQ 真实发送=0、线上 D1 写入=0）**，对 A 层同一批问法拿模型真实回答，逐条用同样的事实断言检查回答文本。若取不到凭据，B 层记为 blocked 并写明，不要伪造。
S6：同一批问法下把 off:image_gen=1、off:openai=1 分别置位，答案必须含「已关闭/已写好未启用」且不说能用；清掉 OPENAI_API_KEY 绑定 → 「未配置」。
S7：向 env 注入假密钥（sk-test-FAKE…长串）后，A、B 两层所有输出、/health 响应、生成卡文件全文搜不到假值；并扫描 B 层回答里有无 token 形字符串。
S8：生成卡 commit = `git rev-parse HEAD`；读 /health 处理函数的响应含 selfCard.commit；构造 RELEASE 与卡不同 → describe_self 明说不一致。

## 验证与交回
`node --test test/self-card-replay.test.mjs 2>&1 | tail -40`；合入 SK-1/SK-2 后在真实卡上全跑；`npm run check`、`npm test` 全量不回归。报告：每个问法一行（问法 → 通过/失败 → 断言了哪些事实）；失败项写文件:行与差异，**不要自己修产品代码**，发现的缺陷列出来交回主程。证据文件路径写入 acceptance.json，passes 只在真实卡跑通后置 true。
不要做：不连线上 D1（不写、不读也行，用本地假库）；不往群里发任何消息；不改 src/ 产品代码、scripts/gen-self-card.mjs、config/self-manifest.json。
进度笔记 /Users/yanghongming/Projects/.agent/releases/SK/notes/SK-3.md（每步追加一行）；上下文压缩后先做开工仪式。
done_when：A 层 ≥18 条在真实卡上全绿；B 层跑通或写明 blocked 原因；S1–S8 的 passes 与 evidence 已按真实结果填写。
