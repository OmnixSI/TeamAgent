# 功能清单

[← 回到 README](../README.md)

三样东西：**工具**是模型能调用的动作；**功能模块**是提供工具、定时动作、网页和接口的代码单元（`src/feat/`）；**技能**是在云电脑里跑的固定配方（`src/skills/`，见 [云电脑、技能和浏览器](compute.md#技能)）。

## 工具（按用途）

| 类别 | 工具 |
|---|---|
| 查资料 | `web_search` `read_url`（网页、推文、小红书、知乎、公众号；可截图） `research`（多轮联网调研） `papers`（论文和引用） |
| 平台 | `bilibili`（字幕、无字幕转写、热评、搜索） `watch_video`（群里发的视频和各平台视频链接：转写 + 截帧） `hot`（各平台热榜） `x_search` `stock` |
| 画图和媒体 | `generate_image` `save_reference` `view_image` `meme`（梗图模板） `sticker` `speak` `narrate`（配音视频） `podcast`（音频节目） |
| 文档和排版 | `show`（文档、思维导图、流程图、网页，可出 PDF） `make_book` `read_attachment` |
| 文件处理 | `skill`（转 PDF、PDF 工具、OCR、排版报告和 PPT、图片和音视频处理、二维码） `filebox`（大文件上传页和下载链接） `translate_doc`（整份文档翻译） `minutes`（录音纪要） `subtitle`（视频字幕） |
| 写代码 | `github`（只读） `code_task`（改代码开草稿 PR） `preview_app`（跑起来截图） `preview_link`（限时可点的预览） `repo_health`（仓库体检结果） |
| 发布 | `publish`（网页、小游戏） `deploy_site`（构建并托管静态站） `toolbox`（工具箱网页） `flashcards`（记忆卡片） |
| 团队 | `tasks`（任务清单） `team`（战绩、积分、兑换、仓库贡献） `board_link`（看板个人链接） `ledger`（群内账本） |
| 网页和订阅 | `web_extract` `web_archive` `site_map` `feeds`（订阅源） `watch`（盯网页） `uptime`（盯网站在不在线） |
| 找东西 | `recall`（按意思搜聊天） `search_history` `get_history` `past_summaries` `library`（群里分享过的文章和文件） `find_image`（按描述找群里的图） `data`（行情和热榜历史） |
| 计算 | `run_python`（云端沙箱） `computer`（云电脑里跑命令） `chat_stats` |
| 大活和定时 | `plan`（多步任务） `jobs`（后台任务的进度和叫停） `schedule`（定时任务） |
| 记忆 | `remember` `forget` |
| 花费和额度 | `usage`（花费和套餐用量） `budget`（额度的当天份额和节奏） `daily_accounts` `backups` |
| 自身 | `about_self`（链路、能力、状态、自检） `self_update`（改参数和做法、授权、写改进提议） |

内置工具在 `src/tools.ts`，其余由各功能模块提供。

## 功能模块（`src/feat/`）

### 团队协作

| 模块 | 做什么 | 工具 |
|---|---|---|
| `tasks` | 任务清单：轻重、先后、交接材料；每晚从聊天里补记；Bot 自己做名下的任务 | `tasks` |
| `teamwork` | 战绩、积分和称号、兑换、功勋墙、每周战报和奖状 | `team` |
| `contrib` | 重新起算的时间点；组织仓库里的活按 GitHub 账号计分（挂在 `teamwork` 下，不单独登记） | 通过 `team` |
| `board` | 团队看板 `/x/board` | — |
| `mcp` | 给本地 AI 工具的 MCP 接口 `/x/mcp/<令牌>` | — |
| `access` | 看板和 MCP 的个人链接：点开即登录，只存令牌的哈希，可作废 | `board_link` |

这一组的细节在 [团队协作](teamwork.md)。

### 写代码和仓库

| 模块 | 做什么 | 工具 |
|---|---|---|
| `codeagent` | 云电脑里跑编码代理（OpenCode + DeepSeek），改完开草稿 PR；也能只读调查 | `code_task` |
| `preview` | 把仓库的分支或 PR 在云电脑里跑起来，无头浏览器截图 | `preview_app` |
| `previewlink` | 把分支或 PR 跑起来，给一个限时能点的链接（默认 10 分钟） | `preview_link` |
| `repocheck` | 每晚北京 02:40 给团队仓库装依赖、跑测试，测试由过变挂时在群里说一次 | `repo_health` |
| `staticsite` | 在云电脑里构建静态网站并托管到 `/p/<id>/`，重新部署原地替换 | `deploy_site` |

### 内容和媒体

| 模块 | 做什么 | 工具 |
|---|---|---|
| `meme` | 300 个梗图模板（摸头、举牌…），拿现成图片秒出 | `meme` |
| `voice` | 免费的方言和多音色语音；图配旁白做视频；双人音频节目 | `narrate` `podcast`（`speak` 也用它的声音） |
| `publish` | 把网页（小游戏、投票、图集、报告）托管在 `/p/<id>/`，带一个小的状态接口 | `publish` |
| `flashcards` | 从材料生成记忆卡片，按人做间隔重复，可发布成学习网页、导出 Anki | `flashcards` |
| `toolbox` | 工具箱网页 `/x/toolbox`：全部在浏览器本地运行的小工具，加一份能力清单 | `toolbox` |

### 文件

| 模块 | 做什么 | 工具 |
|---|---|---|
| `skills` | 技能执行器：`src/skills/` 里的固定配方在云电脑里跑，输入输出自动收发 | `skill` |
| `filebox` | 文件箱：上传页（单个 2 GB、总共 3 GB、默认留 7 天）和下载链接，文件编号 `x12` 能直接进云电脑 | `filebox` |
| `transfer` | 云电脑和 R2 之间的大文件传输（短时令牌）；云电脑的工具缓存和长期工作区走它 | — |
| `doctrans` | 整份文档翻译并保留版式（Word、PPT、Excel；PDF 出译文文档；Markdown、SRT） | `translate_doc` |
| `minutes` | 录音纪要：会议录音或录像 → 转写 → 概要、决定、待办、时间线，全文进资料库 | `minutes` |
| `subtitle` | 视频字幕：带时间轴的转写、翻译和双语 SRT，可烧进视频 | `subtitle` |

### 找东西和订阅

| 模块 | 做什么 | 工具 |
|---|---|---|
| `search` | 聊天记录分段算向量（存在 SQLite），按意思搜；Workers AI 的计量封装 | `recall` |
| `library` | 自动存下群里分享的链接和文件的正文，可搜可取 | `library` |
| `findimage` | 给群里发过的图配文字并算向量，按描述找图 | `find_image` |
| `papers` | 论文检索（arXiv、Semantic Scholar、OpenAlex、Crossref）、BibTeX、相关文献、全文存进资料库 | `papers` |
| `feeds` | 订阅 RSS/Atom、GitHub 发布和提交、arXiv、Hacker News、YouTube 频道；有新内容可在群里说，也进每日汇总 | `feeds` |
| `webkit` | 无头浏览器的批量用法：多个网页按字段摘成表格、网页存档、站点地图 | `web_extract` `web_archive` `site_map` |

### 盯东西

| 模块 | 做什么 | 工具 |
|---|---|---|
| `watch` | 盯网页，关心的东西变了才在群里说 | `watch` |
| `uptime` | 定时探测几个网址或接口，连续三次失败才在群里说一次，恢复时再说一次 | `uptime` |
| `data` | 每天存行情和热榜快照，查历史和走势 | `data` |

### 运维

| 模块 | 做什么 | 工具 |
|---|---|---|
| `backup` | 每天北京 03:10 把全部数据（不含站点登录）备份到 R2，留 30 天；周日另存形象和表情包 | `backups` |
| `steward` | 每天按本月剩余天数给各项额度定当天份额，决定可选的重活开不开；额度见底或月底有富余时在群里说 | `budget` |
| `daily-accounts` | 每天北京时间 00:00 在主群发前一日的账目日报 | `daily_accounts` |

## 界面语言

给群友打开的网页——看板 `/x/board`、工具箱 `/x/toolbox`、文件箱的上传和下载页、预览链接和看板链接的失效提示页、记忆卡片学习页——都支持中文和英文：默认跟随浏览器的第一语言（中文用中文，其他一律英文），也可以在页面上手动选「跟随系统 / 中文 / English」。选择记在浏览器的 `localStorage`（键 `ta.lang`，同一个域名下的这些页面共用），切换后当场重绘，不刷新页面。看板的入口是页头右上角的地球图标，工具箱、文件箱和学习页是页头或页脚的下拉框，一句话的失效提示页没有入口，只读已存的选择或系统语言。

- 机制在 `src/i18n.ts`：页面代码里的中文原文就是 key（`tx("概览")`），英文在各页自己的字典里（`board-i18n.ts`、`toolbox-i18n.ts`，文件箱、预览链接、卡片页的字典在各自文件里）；带数字的句子写成 `{slot}` 模板，复数用 `[单数, 复数]`；字典里没有的句子原样显示中文，不会留空。服务端发来的固定句子（错误、额度项、徽章、兑换品、仓库检查结果）在页面里过 `txs()`，按整句或模板匹配。
- 没做英文的：Bot 在群里的回话和人设提示词、给模型看的工具说明、`publish` 发布的图库页和 404/503 小页、`preview` 的截图对比页、周报奖状图、看板里系统自动记的其余任务进展句子。用户自己写的内容（任务标题、聊天小结、人名、兑换品备注）不翻译。已经存进数据库的任务进展里，系统自动记的那几类句子能翻译，其余原样显示。已发布的记忆卡片学习页要等重新发布后才带上英文。
- 新增页面文字：中文原文写进 `tx()`，在字典里补英文；测试（`board-i18n.test.mjs`、`toolbox-i18n.test.mjs` 等）会检查有没有漏翻的中文字符串、字典有没有死条目、占位符对不对。

## 技能（`src/skills/`）

清单和写法见 [云电脑、技能和浏览器](compute.md#技能)。

## 加一项新能力

1. 能写成功能模块就写成模块：`src/feat/<名字>.ts` 一个文件，在 `src/feat/index.ts` 登记，不动共享文件。接口见 [架构](architecture.md#功能模块怎么挂进来)。
2. 是命令行工具的固定用法就写成技能：`src/skills/<名字>.ts`。
3. 用到按量计费的东西，先在 `src/budget.ts` 加计数和停止线。
4. 工具返回真实结果；成功与否让模型从返回值里读，不要让它自己猜。
5. 把模块的 `about` 写对，它会照这个向群友解释自己。
6. 配一份离线测试（`test/<名字>.test.mjs`），不联网、不花钱。
7. 模块带给群友看的网页时，文字走 [界面语言](#界面语言) 的做法，别写死中文。
