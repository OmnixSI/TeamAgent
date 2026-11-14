# TeamAgent v2

群里的 Bot，整套跑在 Cloudflare 上，不需要任何本机进程。

```
QQ 群 ⇄ QQ 官方长连接 ⇄ Hub（Durable Object，Cloudflare）
                          ├─ 聊天记录、记忆、账本、定时任务（自带 SQLite）
                          ├─ DeepSeek：对话、联网搜索、读网页、深度调研、识图、读文档、余额
                          ├─ OpenAI：生图/改图、长音频转写、Python 沙箱
                          ├─ 中转（Vercel 香港）：国内站点出口、SILK 语音编码
                          └─ GitHub：只读查看组织仓库
```

线上地址 https://teamagent.inkboard-server.workers.dev （`/health`）。Worker 名 `teamagent`。

## 一轮对话怎么走

1. QQ 把群消息推到 Hub 持有的长连接，消息落库。
2. 被 @ 或被叫到等 0.35 秒，普通闲聊等 2.2 秒（把连发的几句合起来看）。
3. 同一个模型看到真实的聊天记录和图片，自己决定：不说话（`PASS`）、直接回、或调工具后再回。
4. 推理强度：没人叫它时先不思考地看一眼（约 1 秒决定接不接）；只要开口回话就用 high；调了查资料、跑代码这类干活的工具后用 max。
5. 回复按 QQ 的习惯发：闲聊拆成一两条短句，认真回答发成一条。

图有没有发出去、定时有没有建好，模型只能从工具返回值知道，所以不会出现“画好了”但没图。

## 画图

每次画图固定四步（`src/draw.ts`）：

1. **揣摩意图**：读群友原话和上下文，弄清这张图给谁、干什么用、指的是谁。
2. **找参考**：保存过的形象（`save_reference`，如 奶蛙）+ 上网找画面里每个具体对象的真实长相。
3. **设计画面**（max 推理，能看到全部参考图）：定主体、构图、风格、图中文字、尺寸和质量，挑出真正相关的参考图，写出提示词。
4. **出图**：有参考图走改图接口保持长相，没有就直接生成；成品存一份，之后可以用编号（如 g12）继续改。

## 文件

| 文件 | 内容 |
|---|---|
| `src/persona.ts` | 人设、说话方式、什么时候开口、干活规矩。改性格改这里 |
| `src/core.ts` | 一轮对话：拼上下文、工具循环、出话 |
| `src/tools.ts` | 全部工具。加能力在这里加一项 |
| `src/sites.ts` | 各站点的读取：B 站、小红书、知乎、热榜、行情、X、语音合成 |
| `src/draw.ts` | 画图四步、找参考图、云端 Python 沙箱（含中文字体的固定做法） |
| `src/self.ts` | 自述：链路、接入、能力清单、运行状态 |
| `src/config.ts` | 它被允许自己改的参数和做法说明 |
| `src/meter.ts` | 记账：价格表、每次调用的用量和花费估算 |
| `src/hub.ts` | Durable Object：QQ 连接、存储、发送、定时、夜间整理、管理接口 |
| `src/memory.ts` | 每晚把当天聊天整理成长期记忆、教训和小结 |
| `src/qq.ts` | QQ 接口与消息解析 |
| `src/llm.ts` | DeepSeek / OpenAI 调用 |
| `test/replay.mjs` | 用真实历史在本地回放，不发群 |

## 工具

| 类别 | 工具 |
|---|---|
| 查资料 | `web_search` `read_url`（网页、推文、小红书笔记、知乎、公众号） `research`（多轮联网调研） `think_hard`（最高推理档） |
| 平台 | `bilibili`（视频字幕/无字幕转写/热评/搜索） `hot`（微博、抖音、B站、知乎、百度、GitHub、HN 热榜） `x_search` `stock`（A股/港股/美股行情） |
| 团队 | `github`（只读） `ledger`（群内账本） `balance`（DeepSeek 余额） `usage`（它自己每天花了多少、花在哪） |
| 文件与媒体 | `read_attachment`（PDF/Word/PPT/扫描件） `generate_image`（画图、改图） `save_reference` `view_image` `speak`（语音回复） |
| 计算 | `run_python`（云端沙箱：算数据、画图表、生成 Excel/CSV/PDF，产物直接发群） `chat_stats` |
| 记忆与时间 | `remember` `forget` `search_history` `get_history` `past_summaries` `schedule` |
| 自身 | `about_self`（链路、接入、能力、状态） `self_update`（改自己的参数和做法说明，或写代码改进提议） |

## 出网的三条路

有些站点拒绝 Cloudflare 的出口地址（B 站 412、微博 403、小红书跳登录）。`src/sites.ts` 按站点选路：

- **直连**：GitHub、百度、腾讯行情、X、B 站音视频 CDN、OpenAI、DeepSeek。
- **中转**（`relay/`，Vercel 香港的一个带密钥的函数，只放行名单内的站点）：B 站接口、小红书、知乎、微博、抖音。能带登录 cookie。SILK 语音编码也在这里做，因为编码库需要运行时生成代码，Workers 不允许。
- **DeepSeek 抓取接口**：不带登录的公开页面兜底。

登录态存在 Hub 里（`cookie:<站点>`），用 `scripts/login-cookies.mjs` 刷新：在一个没有自动化标记的普通浏览器窗口里手动登录，脚本从本机调试端口读出 cookie 写进 Hub。小红书在大陆以外会被它自己跳到 rednote.com，账号和内容是同一套，登录态取 rednote.com 的。

中转部署：`cd relay && npx vercel deploy --prod -e RELAY_KEY=<密钥>`，同一个密钥写进 Worker 的 `RELAY_KEY`。

## 它怎么回答“你是怎么实现的”

`about_self` 工具返回一份自述（`src/self.ts`）：消息链路、接入的服务、存储、记忆、画图、做不到的事、源码地图。其中能力清单由实际注册的工具生成，运行状态从 Hub 实时读取，所以不会和现实脱节；文字说明部分要在改架构的同一次提交里一起改。问到具体实现，它用 `github` 读 `v2/` 里的源码。

## 记账

每次调用 DeepSeek 和 OpenAI 都经过 `src/meter.ts` 记一笔：用途、次数、输入/缓存/输出 token、按官方价格表估的花费，按北京时间的天累加在 Hub 的 `spend` 表里。DeepSeek 另外每天记一次账户余额（`snap` 表），用余额变化对账；余额有几分钟的延迟。`usage` 工具和 `GET /admin/usage?days=3` 能查。

OpenAI 的真实账单需要 key 带 `api.usage.read` 权限，目前没有，所以 OpenAI 部分只有估算。价格变了改 `meter.ts` 里的 `PRICE`。

## 自我迭代

群里让它改自己的毛病时，它用 `self_update`：

- **自己能改**（立即生效，可撤销，每次留记录）：`src/config.ts` 里列出的有上下限的参数（等待时间、每日额度、默认画质、主动接话的积极程度等）、三段做法说明（人设补充 / 画图 / 跑代码，各 1500 字以内，追加到对应的提示词后面）、别人叫它的名字。
- **自己不能改**：代码逻辑。这类它写成改进提议（`propose_code`），存在 Hub 的 `change` 表里，`GET /admin/changes` 能看到。
- **权限**：`OWNERS`（`wrangler.toml`）里的成员说的直接生效；其他人提的先记成提议，群主同意后 `apply`。
- **约束**：改之前必须先调过 `about_self`；一次只改一处；做法说明变不出新能力。

## 记忆

- 长期记忆是一份文档，每晚悉尼 04:30 重写一次：群友、项目、梗、大家对它的要求、它自己的教训、惦记的事。
- 白天有人立规矩或纠正，`remember` 立刻记一条，当晚并入长期记忆。
- 全部聊天记录都在，随时可以按关键词或日期翻。

## 部署

```sh
export CLOUDFLARE_API_TOKEN=...   # 账户级 token
npx wrangler deploy -c v2/wrangler.toml
```

改了行为就把 `src/util.ts` 里的 `BUILD` 加一。Hub 握着 QQ 长连接，部署不会自动替换它；定时触发（每 2 分钟）发现版本不一致会让它自重启，想立刻生效就 `POST /admin/restart`。重启会等正在进行的对话跑完，重启后 QQ 会话自动续上，期间没回的 @ 消息会补回。密钥（`wrangler secret put`）：`DEEPSEEK_API_KEY` `QQ_APP_ID` `QQ_APP_SECRET` `OPENAI_API_KEY` `GITHUB_TOKEN` `ADMIN_TOKEN` `RELAY_KEY`。

## 管理接口

都带 `Authorization: Bearer <ADMIN_TOKEN>`。

| 接口 | 作用 |
|---|---|
| `GET /admin/status` | 连接状态、定时任务、最近 24 小时每类对话的耗时和 token |
| `GET /admin/recent?n=30` | 最近的聊天记录 |
| `GET /admin/turns?n=30` | 最近每轮：耗时、用了哪些工具、说了什么、报错 |
| `GET /admin/memory` | 长期记忆、当天笔记、每日小结 |
| `POST /admin/dry {"text":"…","name":"…","seedFrom":"<群>"}` | 私下试一句，带真实记忆，不发群 |
| `POST /admin/gateway {"on":true\|false}` | 开关 QQ 连接（紧急闭嘴用 `false`） |
| `POST /admin/reflect` | 立即整理一次记忆 |
| `POST /admin/restart` | 让 Hub 立刻换上最新部署的代码 |
| `POST /admin/task {"task":"…"}` | 让 Bot 现在去做一件事并把结果发到群里 |
| `POST /admin/tool {"name":"…","args":{…}}` | 单独跑一个工具看返回 |
| `POST /admin/cookie {"site":"…","cookie":"…"}` | 写入某站点的登录态；不带参数时列出已有站点 |
| `POST /admin/probe {"url":"…"}` | 看一个地址从 Cloudflare 抓是什么结果 |
| `GET /admin/changes` | 它对自己做过的改动和写下的代码改进提议 |
| `GET /admin/img` | 它发过的图和保存的形象；`?id=` 取原图 |
| `POST /admin/sched` | 加/取消定时任务 |

## 本地回放

```sh
node v2/test/replay.mjs <history.json> <secrets.json> "某句原话" …
node v2/test/replay.mjs <history.json> <secrets.json> --range "某句原话" 40
```

用真实模型和真实工具跑，只打印结果。聊天记录是私有数据，不进仓库。

## 回滚到旧系统

```sh
curl -X POST …/admin/gateway -d '{"on":false}'                       # 云端断开 QQ
npx wrangler secret put QQ_APP_SECRET --name inkboard-team           # 旧 Worker 恢复发信
npx wrangler deploy                                                  # 恢复旧 Worker 的定时触发
launchctl enable gui/$(id -u)/com.inkboard.team-qq
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.inkboard.team-qq.plist
```

## 已知限制

- QQ 的 Webhook 用不了：`*.workers.dev` 在国内不可达。绑一个自有域名后，把回调填成 `https://<域名>/qq/events` 即可改成 Webhook，Hub 就不用常驻持有连接。
- 抖音只接了热榜，单条视频页有脚本校验，还读不了。
- 群友发的语音用 QQ 自带的转写文字，QQ 没给转写的那几条听不到。
- 登录态会过期（B 站约半年，抖音、小红书更短），过期后对应工具会明说“登录失效”，重新跑一次 `login-cookies.mjs`。
