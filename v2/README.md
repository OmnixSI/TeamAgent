# TeamAgent v2

群里的 Bot，整套跑在 Cloudflare 上，不需要任何本机进程。

```
QQ 群 ⇄ QQ 官方长连接 ⇄ Hub（Durable Object，Cloudflare）
                          ├─ 聊天记录、记忆、账本、定时任务（自带 SQLite）
                          ├─ DeepSeek：对话、联网搜索、读网页、深度调研、识图、读文档、余额
                          ├─ OpenAI：生图
                          └─ GitHub：只读查看组织仓库
```

线上地址 https://teamagent.inkboard-server.workers.dev （`/health`）。Worker 名 `teamagent`。

## 一轮对话怎么走

1. QQ 把群消息推到 Hub 持有的长连接，消息落库。
2. 被 @ 或被叫到等 0.35 秒，普通闲聊等 2.2 秒（把连发的几句合起来看）。
3. 同一个模型看到真实的聊天记录和图片，自己决定：不说话（`PASS`）、直接回、或调工具后再回。
4. 调了查资料类工具后自动切到深度思考档；闲聊不思考，约 1 秒出话。
5. 回复按 QQ 的习惯发：闲聊拆成一两条短句，认真回答发成一条。

图有没有发出去、定时有没有建好，模型只能从工具返回值知道，所以不会出现“画好了”但没图。

## 文件

| 文件 | 内容 |
|---|---|
| `src/persona.ts` | 人设、说话方式、什么时候开口、干活规矩。改性格改这里 |
| `src/core.ts` | 一轮对话：拼上下文、工具循环、出话 |
| `src/tools.ts` | 全部工具。加能力在这里加一项 |
| `src/hub.ts` | Durable Object：QQ 连接、存储、发送、定时、夜间整理、管理接口 |
| `src/memory.ts` | 每晚把当天聊天整理成长期记忆、教训和小结 |
| `src/qq.ts` | QQ 接口与消息解析 |
| `src/llm.ts` | DeepSeek / OpenAI 调用 |
| `test/replay.mjs` | 用真实历史在本地回放，不发群 |

## 工具

`web_search` `read_url` `research`（多轮联网调研） `think_hard`（deepseek-v4-pro 深度推理） `github` `read_attachment`（PDF/Word/PPT/扫描件） `generate_image` `remember` `forget` `search_history` `get_history` `past_summaries` `schedule` `ledger` `balance`

## 记忆

- 长期记忆是一份文档，每晚悉尼 04:30 重写一次：群友、项目、梗、大家对它的要求、它自己的教训、惦记的事。
- 白天有人立规矩或纠正，`remember` 立刻记一条，当晚并入长期记忆。
- 全部聊天记录都在，随时可以按关键词或日期翻。

## 部署

```sh
export CLOUDFLARE_API_TOKEN=...   # 账户级 token
npx wrangler deploy -c v2/wrangler.toml
```

部署后 Hub 约 40 秒换上新代码，QQ 连接自动重连。密钥（`wrangler secret put`）：`DEEPSEEK_API_KEY` `QQ_APP_ID` `QQ_APP_SECRET` `OPENAI_API_KEY` `GITHUB_TOKEN` `ADMIN_TOKEN`。

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
- 需要登录态的站点（B 站视频字幕、小红书、X）目前读不了，只能读公开网页。
- 还没接语音回复。群友发的语音用 QQ 自带的转写文字。
