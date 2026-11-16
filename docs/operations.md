# 运维

[← 回到 README](../README.md)

## 部署

```sh
export CLOUDFLARE_API_TOKEN=...   # 账户级 token
npm install
npm run check                      # 类型检查 + 离线测试
npm run deploy                     # check 通过才部署
```

- 推到 `main` 会自动部署：Cloudflare Workers Builds 先跑 `npm run check`，通过才 `npx wrangler deploy`。结果在 GitHub 提交的检查项里看。
- 构建机用 Node 24（`.node-version`）。本机 Node 更新的话，合并前用 Node 24 再跑一遍 `npm run check`，两个版本的内置 SQLite 行为有差别。
- 手动部署前先把 `origin/main` 合进来。别人（或别人的本地 AI）可能刚合了东西，从旧分支部署会把他们的改动从线上挤掉。
- 香港中转单独部署，见 [网络](network.md#香港中转relay)。

### 部署之后

| 对象 | 什么时候换上新代码 |
|---|---|
| Worker | 立刻 |
| Hub | 两分钟内自己发现版本变了并重启；想立刻生效用 `POST /admin/restart`。它会等正在回话的那一轮结束，后台任务最多等十分钟 |
| 云电脑 | 机器开着的时候一直用旧代码，等空闲关机一次（约 90 秒没人用）才换上 |

`GET /admin/status` 的 `build` 是 Hub 实际在跑的版本，确认它变了再说“上线了”。

## 密钥

用 `wrangler secret put` 设置，不进仓库、日志、提示词和群消息。

| 名字 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 对话和 DeepSeek 的各项接口 |
| `OPENAI_API_KEY` | 画图、转写、Python 沙箱 |
| `QQ_APP_ID` `QQ_APP_SECRET` | QQ 官方机器人 |
| `GITHUB_TOKEN` | 读组织仓库、开草稿 PR |
| `GITHUB_TOKEN_2` | 可选，优先用；读不了的内容退回前一把 |
| `ADMIN_TOKEN` | 管理接口 |
| `RELAY_KEY` | 香港中转（和 Vercel 项目里的是同一个） |

不是密钥的配置在 `wrangler.toml` 的 `[vars]`：`GITHUB_ORG`、`CHAT_MODEL`、`IMAGE_MODEL`、`OWNERS`（群主的 QQ 成员号）、`RELAY_URL`、`PUBLIC_URL`、`PUBLIC_URL_CN`。

## 在测试房间里试

行为改动先在测试房间试，不要直接往真群发。测试房间的会话号是 `t:<名字>`，借用真群的记忆、设置、形象和表情包，但什么都不会发到 QQ。

| 做法 | 用途 |
|---|---|
| `POST /admin/dry {"room":"x","text":"…","name":"…"}` | 以某个名字对它说一句，看它怎么回、调了哪些工具（`"mentioned":false` 模拟没人叫它） |
| `POST /admin/tool {"name":"…","args":{…},"conv":"t:x"}` | 直接跑一个工具 |
| `POST /admin/task {"task":"…","conv":"t:x"}` | 交办一个后台任务 |
| `POST /admin/tasks {"work":"t:x"}` | 让 Bot 去做那个房间里轮到它的任务 |
| `POST /admin/team {"weekly":"t:x"}` | 预演周日的战报和颁奖 |
| `POST /admin/team {"conv":"t:x","since":…,"link":…,"sync":true}` | 用真实的 GitHub 数据试计分 |

说“已经好了”之前看真实结果：`/admin/turns`、`/admin/toolruns`、`/admin/jobs`、`/admin/recent`。

## 管理接口

都带 `Authorization: Bearer <ADMIN_TOKEN>`。`conv` 不填就是主群。

### 看状态

| 接口 | 作用 |
|---|---|
| `GET /admin/status` | 版本、连接状态、定时任务、正在跑的后台任务、被授权的人、最近 24 小时每类对话的耗时和 token |
| `GET /admin/recent?n=30` | 最近的聊天记录 |
| `GET /admin/turns?n=30` | 最近每轮：耗时、用了哪些工具、说了什么、报错 |
| `GET /admin/toolruns?n=30&name=` | 每次工具调用：耗时、成败、参数、错误 |
| `GET /admin/jobs` | 后台任务记录；`POST {"cancel":id}` 叫停 |
| `GET /admin/prompt?conv=…&asker=…` | 下一轮提示词各部分的字数，最近一天每次调用的 token 数和缓存命中率；`toolsHash` 变了说明工具说明变了 |
| `GET /admin/usage?days=3` | 花费和套餐用量 |
| `GET /admin/health` | 现在跑一遍自检 |
| `GET /admin/img?id=12` | 取一张图；`&made=1` 看它是怎么画出来的 |

### 记忆和设置

| 接口 | 作用 |
|---|---|
| `GET /admin/memory` | 长期记忆、当天笔记、每日小结；`POST {"memory":"…"}` 改写 |
| `POST /admin/reflect` | 现在整理一次记忆 |
| `GET /admin/changes` | 它对自己的改动和代码提议 |
| `POST /admin/trust {"name":"…","on":true}` | 授权或收回某个群友 |
| `GET /admin/sched` | 定时任务；`POST {"spec":…,"task":…}` 新建，`{"cancel":id}` 取消 |

### 任务和团队

| 接口 | 作用 |
|---|---|
| `GET /admin/tasks` | 任务清单和上次夜间提取的结果 |
| `POST /admin/tasks {"work":"t:x"}` | 让 Bot 现在就去做那个会话里轮到它的任务（可带 `"id"`），在后台做 |
| `POST /admin/tasks {"attach":{"id","kind","title","text","ref"}}` | 手工给任务挂材料（原话也行） |
| `POST /admin/tasks {"extract":"g:…"}` | 试跑夜间任务提取 |
| `GET /admin/team` | 积分榜、功勋墙、兑换、起算时间、GitHub 账号对应 |
| `POST /admin/team {"since":"2026-11-15 21:56"}` | 从这个北京时间重新起算 |
| `POST /admin/team {"link":{"账号":"群里的名字"}}` | 对应 GitHub 账号 |
| `POST /admin/team {"sync":true}` | 现在读一遍仓库，返回记到的每一条 |
| `POST /admin/access {"name":"…"}` | 给已经有看板链接的群友再发一个 MCP 地址（只显示这一次，不挤掉已有的）；`GET` 列出谁有链接 |

### 动手

| 接口 | 作用 |
|---|---|
| `POST /admin/dry` `POST /admin/tool` `POST /admin/task` | 见上面“在测试房间里试” |
| `POST /admin/restart` | 让 Hub 重启换上新版本；`?force=1` 不等正在跑的活，立刻重启（被打断的后台任务会接着做） |

各功能模块还有自己的管理接口，写在模块文件的 `admin` 里。

## 自检

每天北京时间 10:30 检查一次（`src/health.ts`）：GitHub 令牌是否有效和几天后过期、B 站和知乎登录是否还在、DeepSeek 余额、昨天花费、OpenAI 密钥、套餐各项是否用到八成。有新问题才在群里说，同一个问题三天内不重复说。`GET /admin/health` 随时可查。

## 测试

- `npm test` 是离线的：不联网、不花钱，几秒钟跑完。每个功能模块一份 `test/<名字>.test.mjs`。
- 要真跑外部程序（LibreOffice、pandoc、ffmpeg、tesseract）的那几条默认跳过，要跑就 `SKILLS_REAL=1 npm test`。
- 测试里不要依赖真实的钟点：有过只在北京时间晚上 10 点以后才失败的测试，把主干的自动部署卡了一个小时。要用时间就把时间钉住。

## 常见问题

| 现象 | 原因和办法 |
|---|---|
| 部署了但新接口 404 | Hub 还在旧版本。看 `/admin/status` 的 `build`，`POST /admin/restart` |
| 云电脑报“没有这个方法” | 云电脑对象还是旧代码。等机器空闲关机一次（约 90 秒）再试 |
| 发不出语音、国内站点全部读不了 | 中转的密钥丢了或不一致。验一下带密钥的请求是不是 200，见 [网络](network.md#香港中转relay) |
| 主干合并后线上没变 | 自动构建没过。看 GitHub 提交的检查项；多半是测试在构建机上失败 |
| 输入 token 突然变贵 | 有东西打断了提示词缓存。看 `/admin/prompt` 的 `cached_share` 和 `toolsHash`，见 [模型、提示词和记忆](model-and-memory.md#提示词的顺序) |
| Bot 说“已经做了”但其实没有 | 它只该照工具返回值说话。查 `/admin/toolruns` 有没有对应的调用；没有的话，是这件事还没有对应的工具，要补代码 |
| 群里任务消息太多或太少 | 调 `tasks_announce` 和 `tasks_digest_minutes`，见 [团队协作](teamwork.md#群里怎么播报) |
