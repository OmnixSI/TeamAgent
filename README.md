# TeamAgent

「做 AI 高手」QQ 群里的常驻 Bot。它在群里聊天、查资料、画图、处理文件，也管团队的任务清单、看板和积分。整套跑在 Cloudflare 上，不需要任何本机进程。

- 线上地址：https://teamagent.inkboard-server.workers.dev （`/health` 看是否在线）
- 团队看板：`/x/board`（每人用自己的个人链接进，在群里对 Bot 说“给我看板链接”）
- Worker 名 `teamagent`。旧版（v1）的代码在标签 `v1-archive`，已停用。

## 它能做什么

| 方面 | 内容 |
|---|---|
| 聊天 | 看得到当天全部聊天和图片，自己决定接不接话；记得群友、项目、梗和大家给它立的规矩 |
| 查资料 | 联网搜索、读网页和各平台内容（B 站、小红书、知乎、公众号、X）、多轮调研、论文检索、订阅源 |
| 做内容 | 画图和改图、梗图、语音和方言、配音视频、音频节目、文档和思维导图、插画书、能点开的网页和小游戏 |
| 处理文件 | 转 PDF、PDF 工具、OCR、整份文档翻译、录音纪要、视频字幕、音视频处理、大文件上传和下载 |
| 写代码 | 读团队仓库、让编码代理改代码并开草稿 PR、把分支跑起来截图或给限时预览、每晚给仓库跑测试 |
| 团队协作 | 任务清单（轻重、先后、交接材料）、Bot 自己接活干活、看板、积分和功勋墙、每周战报和奖状、给本地 AI 的 MCP 接口 |
| 盯东西 | 网页变化、网站是否在线、行情和热榜、定时任务、每日汇总 |

每一项对应哪个模块和工具，见 [docs/features.md](docs/features.md)。

## 技术栈一览

```
QQ 群 ⇄ QQ 官方长连接 ⇄ Hub（Durable Object）
                          ├─ SQLite：聊天记录、记忆、任务、账本、定时和后台任务
                          ├─ R2：大文件、备份、发布的网页、云电脑的工具缓存
                          ├─ DeepSeek：对话、搜索、读网页、调研、识图、语音合成
                          ├─ OpenAI：生图改图、长音频转写、Python 沙箱
                          ├─ 无头浏览器：把文档和网页渲染成图和 PDF、打开动态网页
                          ├─ 云电脑（容器）：ffmpeg、git、Python、LibreOffice，按需开机
                          ├─ Workers AI：免费转写、按意思搜索用的向量
                          ├─ 香港中转（Vercel）：国内站点出口、SILK 语音编码、页面镜像
                          └─ GitHub：读组织仓库；改代码只开草稿 PR
```

| 技术 | 用来做什么 | 细节 |
|---|---|---|
| Cloudflare Worker + Durable Object | 入口和唯一的常驻对象 Hub：握着 QQ 长连接，跑每一轮对话、定时和后台任务 | [架构](docs/architecture.md) |
| DO 自带的 SQLite | 全部结构化数据，包括按意思搜索用的向量 | [存储和额度](docs/storage-and-budget.md) |
| R2 | 放不进 SQLite 的大东西 | [存储和额度](docs/storage-and-budget.md) |
| DeepSeek `deepseek-flash` | 所有对话和推理；提示词按缓存友好的顺序排 | [模型、提示词和记忆](docs/model-and-memory.md) |
| OpenAI | 只用于画图、长音频转写、Python 沙箱 | [模型、提示词和记忆](docs/model-and-memory.md) |
| Cloudflare 无头浏览器 | 渲染、截图、PDF、打开要跑脚本的网页 | [云电脑、技能和浏览器](docs/compute.md) |
| Cloudflare 容器 | 一台按需开机的 Linux，跑命令行工具和固定配方（技能） | [云电脑、技能和浏览器](docs/compute.md) |
| Workers AI | 每天免费额度内的转写和向量 | [存储和额度](docs/storage-and-budget.md) |
| Vercel 香港函数 | 被 Cloudflare 出口拒绝的国内站点、SILK 编码、给大陆网络的页面镜像 | [网络](docs/network.md) |
| QQ 官方机器人接口 | 长连接收消息、发文字图片语音文件 | [架构](docs/architecture.md) |
| GitHub API | 读仓库、开草稿 PR、统计每个人在组织仓库里的贡献 | [团队协作](docs/teamwork.md) |
| MCP（HTTP） | 群友本机的 Claude Code、Codex 接任务和交付 | [团队协作](docs/teamwork.md) |

## 文档

| 文档 | 讲什么 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 一条消息从进来到回出去怎么走、后台任务、时钟、重启、代码文件各管什么 |
| [docs/model-and-memory.md](docs/model-and-memory.md) | 推理档位、提示词顺序和缓存、长期记忆、画图流程、Bot 能自己改什么 |
| [docs/storage-and-budget.md](docs/storage-and-budget.md) | 数据放在哪、套餐里每项的额度和停止线、花费怎么记 |
| [docs/compute.md](docs/compute.md) | 云电脑、工具包、技能、无头浏览器 |
| [docs/network.md](docs/network.md) | 出网的三条路、站点登录态、香港中转和镜像 |
| [docs/features.md](docs/features.md) | 全部功能模块、工具和技能的清单 |
| [docs/teamwork.md](docs/teamwork.md) | 任务、Bot 自己干活、交接材料、群里怎么播报、积分和仓库贡献、看板、本地 AI 接口 |
| [docs/operations.md](docs/operations.md) | 部署、密钥、测试房间、管理接口、自检、常见问题 |
| [AGENTS.md](AGENTS.md) | 给改这个仓库的人和 AI 的规矩：硬约束、验证和发布流程 |

## 三条硬约束

1. **不超出 Cloudflare 套餐。** Workers Paid 每月 5 美元，按量的东西都自己计数，到停止线就拒绝（[额度表](docs/storage-and-budget.md#套餐额度)）。
2. **模型只用 DeepSeek `deepseek-flash`。** 回话用 high，干活用 max；OpenAI 只做画图、转写、Python 沙箱。
3. **工具返回真实结果，模型只能照结果说话。** 图有没有发出去、任务有没有建好、分是多少，都以工具返回值为准。

## 本地检查和部署

```sh
npm install
npm run check      # 类型检查 + 离线测试（不联网、不花钱），几秒钟
npm run deploy     # check 通过才部署；需要 CLOUDFLARE_API_TOKEN
```

推到 `main` 会自动部署：Cloudflare Workers Builds 先跑 `npm run check`，通过才 `npx wrangler deploy`。构建机用 Node 24（`.node-version`）。部署之后的重启、密钥、怎么在测试房间里试，见 [docs/operations.md](docs/operations.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 主干：入口、Hub、一轮对话、工具、人设、存储、记账、云电脑 |
| `src/feat/` | 功能模块，一个文件一个模块 |
| `src/skills/` | 技能：在云电脑里跑的固定配方，一个文件一个技能 |
| `test/` | 离线测试 |
| `relay/` | 香港中转和镜像（单独部署到 Vercel） |
| `scripts/` | 刷新站点登录态的脚本 |
| `docs/` | 上面那几篇技术文档 |
