# SK next（P2，不挡上线）
- 通用：模型输出里残留 `<｜｜DSML｜｜ calls>` 进正文（2/7 次，src/voice.ts:16/96 出口未清洗）。
- src/semantic.ts:1412 `JSON.stringify(result).slice(0,40000)` 截成坏 JSON（1/7）。
- 仓库/代码题偶尔被转后台 research（semantic.ts:9/986，4/154）。
- 清单 mcp_bridge 的 off:mcp 是运行时拼接，校验登记不了。
- 新增能力必须登记 config/self-manifest.json，否则构建失败（设计如此）。

## 补充（03:36，集成前）
- P2：代码位置类问法（「在哪个文件」）有时被 semantic.ts:9/986 转成后台任务，或本地假库缺 GitHub token 而答不出；抽跑 S9 0/2、S2 1/2。线上有 token，真实群验证时重点看。修法：repo_file/search_code 也进本地同步路径，或失败时回落 describe_self(capability) 给文件与行号。
- P2：DSML 残片的上游根因（主模型把工具调用写成正文，进入 decision.brief）；本版只在 speakBrief 出口丢弃含 DSML 的行，S4 B 7 次 DSML 正文 0；仍有 1/14 回答是「标签鬼画符」（正文无字面 DSML，但答非所问）。
- B 层断言口径：S4 B 只查表数/核心表、定时、队列、绑定、入口、目录名；目录职责只在 A 层核对。
