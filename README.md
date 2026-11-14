# TeamAgent

「做 AI 高手」QQ 群里的 Bot。整套跑在 Cloudflare 上，不需要任何本机进程。

```
QQ 群 ⇄ QQ 官方长连接 ⇄ Hub（Durable Object，Cloudflare）
                          ├─ 聊天记录、记忆、账本、定时任务、后台任务（自带 SQLite）
                          ├─ 图片和文件（小的在 SQLite，大的在 R2）
                          ├─ DeepSeek：对话、联网搜索、读网页、深度调研、识图、读文档、语音合成
                          ├─ OpenAI：生图/改图、长音频转写、Python 沙箱
                          ├─ Cloudflare 无头浏览器：文档、思维导图、网页渲染成图和 PDF，打开动态网页
                          ├─ 云电脑（Cloudflare 容器）：ffmpeg、git、Python、LibreOffice，按需开机
                          ├─ 中转（Vercel 香港）：国内站点出口、SILK 语音编码
                          ├─ Workers AI：免费转写、按意思搜索用的向量（每天 1 万 neurons 内）
                          └─ GitHub：读组织仓库；改代码只开草稿 PR
```

线上地址 https://teamagent.inkboard-server.workers.dev （`/health`）。Worker 名 `teamagent`。旧版（v1）的代码在标签 `v1-archive`。

## 一轮对话怎么走

1. QQ 把群消息推到 Hub 持有的长连接，消息落库；图片和文件同时另存一份（QQ 的链接会过期）。
2. 被 @ 或被叫到几乎不等，普通闲聊等 2.2 秒（把连发的几句合起来看）。
3. 同一个模型看到真实的聊天记录和图片，自己决定：不说话（`PASS`）、直接回、或调工具后再回。
4. 推理强度：没人叫它时先不思考地看一眼（约 1 秒决定接不接）；只要开口回话就用 high；调了查资料、跑代码这类干活的工具后用 max。
5. 回复按 QQ 的习惯发：闲聊拆成一两条短句，认真回答发成一条。

图有没有发出去、定时有没有建好，模型只能从工具返回值知道，所以不会出现“画好了”但没图。

## 后台任务

定时任务、先立计划的多步任务（`plan`）、做书（`make_book`）都是后台任务（`job` 表）：

- 不占着群聊，期间照常聊天；`jobs` 工具能查进度、能叫停。
- 每做完一步把进度存到 R2。进程重启后，下一次时钟会把没做完的任务从上一步接着做（最多接两次）；做书已经画好的页不重画。接不上会在群里说没做完。
- 部署新版本时等正在回话的那一轮结束；后台任务最多等十分钟，超过就重启，由上一条接手。
- 定时任务失败会在群里说。没人说话时 QQ 可能不收主动发的图和文件，这时成品排队，下一个人说话时补发。

## 画图

1. 主模型在调 `generate_image` 时写明原话、它对意图的理解、要参考的图、要先上网查长相的对象。
2. 找参考：保存过的形象（原话里点到名字的自动带上）+ 上网找每个具体对象的真实长相。
3. 设计画面（max 推理，能看到全部参考图）：定主体、构图、风格、图中文字、尺寸和质量，写出提示词。
4. 出图。成品连同原话、提示词、用到的参考图一起存（`g12`）。之后说“接着改这张”，会把当初的提示词带上，只改被要求的部分。

图像接口拒绝某一版时，带着它给的原因重新设计一版离原意最近的再画，最多三版。

## 套餐额度

Cloudflare 是每月 5 美元的固定套餐，要求是绝不超出。按量的东西在 `src/budget.ts` 里自己计数，到停止线就拒绝，等下个计费周期（每月 13 日起）：

| 项目 | 套餐内含 | 停止线 |
|---|---|---|
| 无头浏览器 | 每月 10 小时 | 8.5 小时 |
| 容器（云电脑） | 每月 25 小时（1 GiB 实例） | 20 小时 |
| 容器 CPU | 每月 375 vCPU 分钟 | 300 分钟 |
| R2 存储 | 10 GB | 8 GB |
| R2 写入 / 读取 | 100 万 / 1000 万次 | 70 万 / 700 万次 |
| Workers AI | 每天 1 万 neurons | 每天 8,000 |

Hub 因为握着 QQ 长连接而 24 小时在线，这一项固定占 Durable Object 在线时长的 83% 左右（一个月约 33 万 / 40 万 GB·秒）。所以不能再有第二个常驻对象。`usage` 工具和 `GET /admin/usage` 里的 `cloudflare_plan` 能看到每项用了多少。

## 功能模块（`src/feat/`）

每个模块一个文件，通过 `src/feat/types.ts` 里的接口挂进来（工具、时钟、管理接口、公开路由、建表、可调参数、自述），在 `src/feat/index.ts` 登记一次。加新能力优先照这个做，不用动共享文件。

| 模块 | 做什么 | 工具 |
|---|---|---|
| `backup` | 每天北京 03:10 把全部数据（不含站点登录）备份到 R2，留 30 天；周日另存形象和表情包 | `backups` |
| `transfer` | 云电脑和 R2 之间的大文件传输（短时令牌）；云电脑的工具缓存和长期工作区走它 | — |
| `meme` | 300 个梗图模板（摸头、举牌…），拿现成图片秒出 | `meme` |
| `voice` | 免费的方言和多音色语音；图配旁白做视频；双人音频节目 | `narrate` `podcast`（`speak` 也用它的声音） |
| `codeagent` | 云电脑里跑编码代理（OpenCode + DeepSeek），改完开草稿 PR；只读调查 | `code_task` |
| `publish` | 把网页（小游戏、投票、图集、报告）托管在 `/p/<id>/`，带一个小的状态接口 | `publish` |
| `preview` | 把仓库的分支或 PR 在云电脑里跑起来，无头浏览器截图 | `preview_app` |
| `repocheck` | 每晚北京 02:40 给团队仓库装依赖、跑测试，测试由过变挂时在群里说一次 | `repo_health` |
| `search` | 聊天记录分段算向量（存在 SQLite），按意思搜；Workers AI 的计量封装 | `recall` |
| `library` | 自动存下群里分享的链接和文件的正文，可搜可取 | `library` |
| `watch` | 盯网页，关心的东西变了才在群里说 | `watch` |
| `data` | 每天存行情和热榜快照，查历史和走势 | `data` |
| `uptime` | 定时探测几个网址或接口，连续三次失败才在群里说一次，恢复时再说一次 | `uptime` |
| `findimage` | 给群里发过的图配文字并算向量，按描述找图 | `find_image` |
| `steward` | 每天按本月剩余天数给各项额度定当天份额，决定可选的重活开不开；额度见底或月底有富余时在群里说 | `budget` |
| `skills` | 技能执行器：`src/skills/` 里的固定配方在云电脑里跑，输入输出自动收发 | `skill` |
| `filebox` | 文件箱：上传页（单个 2 GB、总共 3 GB、默认留 7 天）和下载链接，文件编号 `x12` 能直接进云电脑 | `filebox` |
| `webkit` | 无头浏览器的批量用法：多个网页按字段摘成表格、网页存档（文字 + PDF + 整页截图）、站点地图 | `web_extract` `web_archive` `site_map` |
| `feeds` | 订阅 RSS/Atom、GitHub 发布和提交、arXiv、Hacker News、YouTube 频道；有新内容可在群里说，也进每日汇总 | `feeds` |
| `papers` | 论文检索（arXiv、Semantic Scholar、OpenAlex、Crossref）、BibTeX、相关文献、全文存进资料库 | `papers` |
| `minutes` | 录音纪要：会议录音或录像 → 转写 → 概要、决定、待办、时间线，全文进资料库 | `minutes` |
| `subtitle` | 视频字幕：带时间轴的转写、翻译和双语 SRT，可烧进视频 | `subtitle` |
| `doctrans` | 整份文档翻译并保留版式（Word、PPT、Excel；PDF 出译文文档；Markdown、SRT） | `translate_doc` |
| `previewlink` | 把仓库的分支或 PR 跑起来，给一个限时能点的链接（默认 10 分钟） | `preview_link` |
| `staticsite` | 在云电脑里构建静态网站并托管到 `/p/<id>/`，重新部署原地替换 | `deploy_site` |
| `flashcards` | 从材料生成记忆卡片，按人做间隔重复，可发布成学习网页、导出 Anki | `flashcards` |
| `toolbox` | 工具箱网页 `/x/toolbox`：全部在浏览器本地运行的小工具，加一份能力清单 | `toolbox` |

## 技能（`src/skills/`）

技能是写死的配方：一个文件一个技能（接口在 `src/skills/types.ts`），`commands(args, files)` 返回要在云电脑里跑的 bash，输入在 `./in/`，结果写到 `./out/`。`skill` 工具负责找输入（聊天文件、`f12`、`g12`、文件箱 `x12`）、恢复需要的工具包、执行、把结果发回群里，超过 25 MB 的结果放进文件箱。模型不用自己拼命令，结果稳定。

| 技能 | 做什么 |
|---|---|
| `doc-to-pdf` | Word、Excel、PPT、Markdown、图片等转 PDF |
| `pdf-tools` | 合并、拆分、抽页、旋转、压缩、转图片、加密解密、水印、页码 |
| `pdf-to-docx` `pdf-to-markdown` | PDF 转可编辑的 Word；PDF 和 Office 文档转 Markdown |
| `pdf-ocr` | 扫描件和图片做文字识别，出可搜索的 PDF 和文本 |
| `md-to-report` `md-to-slides` `resume` | Markdown 排成 PDF 报告（三种版式）、可编辑的 PPT、简历 |
| `image-batch` `image-collage` | 图片批量压缩、改格式、改名、加水印；拼图和九宫格 |
| `media-convert` | 音视频转格式、剪辑、压缩、变速、拼接、转 GIF、抽帧 |
| `qr-code` | 二维码（PNG 和 SVG，可带 logo 和说明文字） |

## 云电脑

`src/computer.ts`：一台 Cloudflare 容器（托管的 Debian 镜像，不需要 Docker 构建），1 核、1 GiB 内存、4 GB 硬盘。要用时开机，装好的工具（ffmpeg、git、Python、Node 26、字体）从 R2 里的缓存解压恢复，缓存没有或坏了就完整安装一遍并重新存缓存；最后一次使用后 90 秒由闹钟关机，硬盘清空。卡住的命令最多让它多开 35 分钟。运行时间（含那 90 秒）和 CPU 秒数都记进套餐计数。只有一个实例。大件工具分成工具包（`src/packs.ts`：`office`、`ocr`、`tex`），各自在 R2 里存一层，哪次运行要用才恢复。部署后云电脑对象要等机器睡过一次才换上新代码。`computer` 工具让模型在里面跑命令，文件箱的 `x12` 可以直接作输入，超过 25 MB 的结果自动进文件箱；`watch_video` 是固定流程：取视频、抽音轨、截帧，音轨再交给转写。

## 自检

每天北京时间 10:30 检查一次（`src/health.ts`）：GitHub 令牌是否有效和几天后过期、B 站和知乎登录是否还在、DeepSeek 余额、昨天花费、OpenAI 密钥、套餐各项是否用到八成。有新问题才在群里说，同一个问题三天内不重复说。`GET /admin/health` 随时可查。

## 记忆

- 长期记忆是一份文档，每晚悉尼 04:30 重写：群友、项目、梗、大家对它的要求、教训、做得好的、惦记的事。每条带日期。
- 重写时对照它现在实际有的工具，删掉过时的规矩；结果比原文短一半以上不采用。最近 14 天每晚的旧版本都留着（`memory:hist:*`）。
- 白天有人立规矩或纠正，`remember` 立刻记一条；`forget` 能当场从长期记忆里删掉对应的几行。
- 全部聊天记录都在，可以按关键词或日期翻。

## 谁能改它

群里让它改自己的毛病时，它用 `self_update`：

- **能改**（立即生效，可撤销，留记录）：`src/config.ts` 里有上下限的参数、三段做法说明（人设补充 / 画图 / 跑代码）、别人叫它的名字。
- **不能改**：代码。它写成改进提议（`propose_code`），在 `GET /admin/changes`。
- **权限**：群主（`wrangler.toml` 的 `OWNERS`）和群主授权过的人说了直接生效；其他人的先记成提议。授权和收回（`grant` / `revoke`）只有群主本人能做。

## 文件

| 文件 | 内容 |
|---|---|
| `src/persona.ts` | 人设、说话方式、什么时候开口、干活规矩。改性格改这里 |
| `src/core.ts` | 一轮对话：拼上下文、推理档位、工具循环、出话 |
| `src/tools.ts` | 全部工具。加能力在这里加一项 |
| `src/hub.ts` | Durable Object 主干：收消息、跑一轮、发消息、后台任务、时钟 |
| `src/gateway.ts` | 和 QQ 的长连接 |
| `src/store.ts` | 图片和文件的存取（SQLite + R2）、群图存档 |
| `src/host.ts` | 工具能碰到的东西（按群、按提问的人） |
| `src/selfedit.ts` `src/config.ts` | 它能自己改的东西、谁有权改 |
| `src/accounts.ts` `src/meter.ts` | 记账：价格表、每次调用的花费、余额对账 |
| `src/budget.ts` | 套餐月度额度和停止线 |
| `src/health.ts` | 每日自检 |
| `src/render.ts` | 无头浏览器：渲染成图、PDF、打开网页 |
| `src/computer.ts` | 云电脑：容器的开机、装软件、跑命令、收发文件、计时 |
| `src/packs.ts` | 云电脑的大件工具包（Office、OCR、LaTeX）怎么装、怎么验 |
| `src/feat/*.ts` `src/skills/*.ts` | 功能模块和技能，各一个文件 |
| `src/sites.ts` | 各站点读取：B 站、小红书、知乎、热榜、行情、X、语音合成 |
| `src/draw.ts` | 画图：找参考图、设计、出图；Python 沙箱 |
| `src/book.ts` `src/show.ts` | 做书；文档、思维导图、流程图、网页的排版模板 |
| `src/memory.ts` | 每晚的记忆整理、图片配文 |
| `src/self.ts` | 它对自己的描述（`about_self`） |
| `src/qq.ts` `src/llm.ts` | QQ 接口与消息解析；DeepSeek 调用 |
| `src/admin.ts` | 管理接口 |
| `test/*.test.mjs` | 离线测试（不联网、不花钱） |
| `relay/` | 香港中转 |

## 工具

| 类别 | 工具 |
|---|---|
| 查资料 | `web_search` `read_url`（网页、推文、小红书、知乎、公众号；可截图） `research`（多轮联网调研） |
| 平台 | `bilibili`（字幕/无字幕转写/热评/搜索） `watch_video`（群里发的视频和各平台视频链接：转写 + 截帧） `hot`（各平台热榜） `x_search` `stock` |
| 团队 | `github`（只读） `ledger`（群内账本） `usage`（花费和套餐用量） `budget`（额度的当天份额和节奏） |
| 文件与媒体 | `read_attachment` `generate_image` `save_reference` `view_image` `speak` `sticker` `show`（文档、思维导图、流程图、网页，可出 PDF） `make_book` |
| 大活 | `plan`（多步任务） `jobs`（后台任务的进度和叫停） `code_task`（改代码开草稿 PR） `preview_app`（跑起来截图） |
| 文件处理 | `skill`（转 PDF、PDF 工具、OCR、排版报告和 PPT、图片和音视频处理、二维码） `filebox`（大文件上传页和下载链接） `translate_doc`（整份文档翻译） `minutes`（录音纪要） `subtitle`（视频字幕） |
| 网页与订阅 | `web_extract` `web_archive` `site_map` `feeds`（订阅源） `papers`（论文和引用） `uptime`（盯网站在不在线） |
| 发布 | `deploy_site`（构建并托管静态站） `preview_link`（限时可点的预览） `toolbox`（工具箱网页） `flashcards`（记忆卡片） |
| 好玩的 | `meme`（梗图模板） `narrate`（配音视频） `podcast`（音频节目） `publish`（发布网页、小游戏） |
| 找东西 | `recall`（按意思搜聊天） `library`（群里分享过的文章和文件） `find_image`（按描述找群里的图） `data`（行情和热榜历史） `watch`（盯网页） `repo_health`（仓库体检结果） |
| 计算 | `run_python`（云端沙箱） `computer`（云电脑：视频音频、克隆仓库、PPT/Word） `chat_stats` |
| 记忆与时间 | `remember` `forget` `search_history` `get_history` `past_summaries` `schedule` |
| 自身 | `about_self`（链路、能力、状态、自检） `self_update`（改参数和做法、授权、写改进提议） |

## 出网的三条路

有些站点拒绝 Cloudflare 的出口地址（B 站 412、微博 403、小红书跳登录）。`src/sites.ts` 按站点选路：

- **直连**：GitHub、百度、腾讯行情、X、B 站音视频 CDN、OpenAI、DeepSeek。
- **中转**（`relay/`，Vercel 香港的一个带密钥的函数，只放行名单内的站点）：B 站接口、小红书、知乎、微博、抖音。能带登录 cookie。SILK 语音编码也在这里做。
- **DeepSeek 抓取接口**：不带登录的公开页面兜底。再读不出来就用无头浏览器真打开。

登录态存在 Hub 里（`cookie:<站点>`），用 `scripts/login-cookies.mjs` 刷新：在一个没有自动化标记的普通浏览器窗口里手动登录，脚本从本机调试端口读出 cookie 写进 Hub。小红书在大陆以外会被它自己跳到 rednote.com，登录态取 rednote.com 的。

中转部署：`cd relay && npx vercel deploy --prod -e RELAY_KEY=<密钥>`，同一个密钥写进 Worker 的 `RELAY_KEY`。

## 部署

```sh
export CLOUDFLARE_API_TOKEN=...   # 账户级 token
npm install
npm run check                      # 类型检查 + 离线测试
npm run deploy                     # check 通过才部署
```

推到 `main` 也会自动部署（Cloudflare Workers Builds：先 `npm run check`，再 `npx wrangler deploy`；Node 版本由 `.node-version` 定）。

Hub 握着 QQ 长连接，部署不会自动替换它；定时触发（每 2 分钟）发现版本号不一致会让它自己重启，想立刻生效就 `POST /admin/restart`。重启后 QQ 会话自动续上，期间没回的 @ 消息会补回。密钥（`wrangler secret put`）：`DEEPSEEK_API_KEY` `QQ_APP_ID` `QQ_APP_SECRET` `OPENAI_API_KEY` `GITHUB_TOKEN` `GITHUB_TOKEN_2`（可选，优先用；读不了的内容退回前一把） `ADMIN_TOKEN` `RELAY_KEY`。

QQ 的 Webhook 用不了（腾讯访问不到 `*.workers.dev`），所以用长连接。`/qq/events` 已经写好，有了自己的域名就能切过去，Hub 就不必常驻。

## 管理接口

都带 `Authorization: Bearer <ADMIN_TOKEN>`。

| 接口 | 作用 |
|---|---|
| `GET /admin/status` | 版本、连接状态、定时任务、正在跑的后台任务、被授权的人、最近 24 小时每类对话的耗时和 token |
| `GET /admin/recent?n=30` | 最近的聊天记录 |
| `GET /admin/turns?n=30` | 最近每轮：耗时、用了哪些工具、说了什么、报错 |
| `GET /admin/toolruns?n=30&name=` | 每次工具调用：耗时、成败、参数、错误 |
| `GET /admin/jobs` | 后台任务记录；`POST {"cancel":id}` 叫停 |
| `GET /admin/memory` | 长期记忆、当天笔记、每日小结；`POST {"memory":"…"}` 改写 |
| `GET /admin/usage?days=3` | 花费和套餐用量 |
| `GET /admin/health` | 现在跑一遍自检 |
| `GET /admin/changes` | 它对自己的改动和代码提议 |
| `GET /admin/sched` | 定时任务；`POST {"spec":…,"task":…}` 新建，`{"cancel":id}` 取消 |
| `POST /admin/trust {"name":"…","on":true}` | 授权或收回某个群友 |
| `POST /admin/dry {"room":"x","text":"…","name":"…"}` | 私下试一句，带真实记忆和设置，不发群 |
| `POST /admin/tool {"name":"…","args":{…},"conv":"t:x"}` | 手动跑一个工具 |
| `POST /admin/task {"task":"…","conv":"t:x"}` | 交办一个后台任务（`"wait":true` 等它做完） |
| `GET /admin/img?id=12` | 取一张图；`&made=1` 看它是怎么画出来的 |
| `POST /admin/reflect` | 现在整理一次记忆 |
| `POST /admin/restart` | 让 Hub 重启换上新版本 |
