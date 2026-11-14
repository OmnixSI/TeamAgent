# F6 上线后只读验收（2026-11-14 01:50–02:00 Sydney）

> 🔴 **P1 · @必回看门狗在回放历史消息**：01:45–01:48 把 11-11/11-13 的 msg#131/132/153/348 当成漏回，逐分钟补发「在做」并重新回答，共 8 条 outbox（246/247/249/250/251/252/253/254）。其中 #254 是对 2 天前日报请求的补答，仍写「5 个仓库」。根因 `src/mention-guard.ts:60-70` 只有 `m.ts <= now-45s/90s` 上限，没有时间下限。01:53 起线上为 `b0557fd`（PR #40，不含 `mention-guard.ts` 改动），最后一条旧消息补发停在 01:48:24。详见 `.agent/releases/F6/postdeploy/mention-watchdog-p1.md`。

## 结论

- **线上部署、迁移、服务正常**：事故版本 `c612431`（01:44–01:53），01:53 起为 `b0557fd`（PR #40，不含 `mention-guard.ts` 改动）；`/health` 200。02:00 复查 `max(messages.rowid)=462` 与 `chat_cursor:群=462` 相等，不超前；outbox 258 条（257 sent / 1 failed），最后 sent 01:57:22；0009/0010/0011 的表和列齐全；qq/fetch/runner 三个 launchd 服务 running。
- **F6-1 仓库发现：通过**（本地独立库 + 当前线上真实 6 仓库数据）。msg#436 解析到 `OmnixSI/peiwan-club-saas`，head `fdd7b76`，仍能读到 `9fa6a12`；msg#437/438 的 `list_repos` 均为 6 个，点出 `peiwan-club-saas`。
- **F6-5 @必回：90 秒/45 秒路径通过，但线上看门狗有上述 P1**，不能算整体通过。
- **F6-6 日推、F6-7 看图、F6-8 CSV 交付：代码回放通过，线上能力未落地/未修复**——schedules=0、vision selftest 502、outbox#19 仍 failed 且 deliveries=0。
- **验收清单 8 项：3 通过 / 5 未通过或不能独立验证。**

## 1. 线上只读体检

| 项 | 实测 | 判定 |
|---|---|---|
| `/health` | 200 `release=b0557fd8af564199ad11921d9d62999d2d6a3998`（01:53 起；事故版本 c612431，01:44–01:53） | 正常 |
| messages 最大 id | 462（02:00） | — |
| chat_cursor | `chat_cursor:9968A0…=462`；旧全局 `chat_cursor=450` | 与 max 相等，**不超前** |
| outbox | 258 条；257 sent、1 failed；最后 sent 2026-11-14 01:57:22 Sydney | 部署后 246–258 段有正常回复；旧消息重发停在 01:48:24 |
| 0009/0010/0011 | `schedules` 13 列、`schedule_runs` 8 列、`turn_tools` 10 列、`delivery_retries` 5 列均存在 | 已应用（schema.sql 覆盖；`migrate.mjs` 只显式列 0009） |
| 本机服务 | `com.inkboard.team-qq/fetch/runner` 均 `state=running`，pid 57371/57379/57386 | 正常 |
| Worker secrets | ADMIN_TOKEN、DEEPSEEK_API_KEY、**GITHUB_TOKEN**、QQ_APP_ID、QQ_APP_SECRET、RUNNER_TOKEN | 名字存在；值未读 |
| repo_cache | 6 行，最新更新 01:45:57；peiwan head `fdd7b76`，`9fa6a12` 可读 | 数据同步正常 |
| 只读证明 | 19 次 D1 查询 `rows_written=0`、`changes=0` | 无线上写入 |

### 线上新发现的异常

1. **P1 看门狗回放历史**：见首行和 `mention-watchdog-p1.md`。当前 backlog 已清到 0，但 8 条已发出，撤不回；建议加 10 分钟下限或只扫部署后消息。
2. **P1 日推仍未落地**：`schedules=0`、`schedule_runs=0`。outbox#206 承诺的「每天 8:00」没有创建；F6-6 只是提供了能力。
3. **P1 看图仍不可用**：生产 `GET /api/team/vision/selftest` → HTTP 502 `runner_unsupported`「视觉模型不支持或 AI 未绑定」，next_action 要求检查 Workers AI 绑定/模型条款。需在 Cloudflare 控制台接受 Meta Llama 3.2 许可（用户本人操作），否则图仍看不了。
4. **P1 历史 CSV 仍未补发**：outbox#19 仍 `failed`，`deliveries=0`、`delivery_retries=0`；F6-8 的重试只对新交付生效。
5. **P2 日报仍复述 5 个仓库**：outbox#254 是看门狗补发的旧日报，正文写「登记表上共 5 个…疑似 peiwan-club-saas」。不是新的 `list_repos` 结果，但用户看到的是部署后的新消息。

### 1.1 用户报告的重发：近 3 小时 outbox 独立复核

窗口 `created_at >= 1794571083845`（2026-11-13 22:58:03 Sydney）内共 **21 条 outbox（rowid 239–259）**；其中旧消息重发 **8 条**，对应 4 个旧源，每个旧源 2 条（「在做」回执 + 完整回复）：

| 发送（Sydney） | outbox rowid | 源 msg rowid | 源消息原时间（+08） | 距源消息 |
|---|---|---|---|---|
| 01:45:02 | 246「在做：这是面试软件的 logo」 | 131 | 2026-11-11 18:06:11 | 3159 分钟（52.6h） |
| 01:45:23 | 247「哦，那是我上条看走眼了…」 | 131 | 2026-11-11 18:06:11 | 3159 分钟 |
| 01:46:02 | 249「在做：你别管这个logo…」 | 132 | 2026-11-11 18:06:19 | 3160 分钟 |
| 01:46:21 | 250「搜了，query 就是 MausBot…」 | 132 | 2026-11-11 18:06:19 | 3160 分钟 |
| 01:47:02 | 251「在做：这条消息」 | 153 | 2026-11-11 18:47:07 | 3120 分钟（52h） |
| 01:47:26 | 252「日报得有材料…」 | 153 | 2026-11-11 18:47:07 | 3120 分钟 |
| 01:48:02 | 253「在做：把今天群里的对话…」 | 348 | 2026-11-13 01:08:38 | 1299 分钟（21.6h） |
| 01:48:24 | 254「今日日报（精简版）…」 | 348 | 2026-11-13 01:08:38 | 1300 分钟 |

- **不是同内容重复**：窗口内按 `body` 分组重复 = 0 组。按 `msg_id` 有 5 组各 2 行：4 组是上述「回执 + 完整回复」（内容不同），第 5 组是当前新消息 msg rowid 457 的 255「收到，正在查…」+ 256 检索结果，属正常两段式。
- **每条只发一次**：8 条 mention 行在 `outbox_attempts` 各 1 次、HTTP 200，无 5xx/重试记录。
- **已停止**：最后一条旧消息补发 01:48:24；之后 255–259 全是当时新消息的正常回复。02:00 复查 `mention_outbox=8`、`last_mention=01:48:24`、`max=462`、`cursor=462`、`/health=b0557fd`，没有新增旧消息重发。
- **根因仍在**：`b0557fd` 未改 `src/mention-guard.ts:60-70`；现在停止是因为历史候选被清空（backlog=0），不是代码修复。未来再出现「历史 mentioned 但无 outbox/decision」仍可能重演。

## 2. 逐条真实消息回放

本地独立 SQLite（`schema.sql` 全量建库），真实行来自线上只读导出；模型请求只发 `api.deepseek.com`，QQ 真实发送 0，线上 D1 写 0。

| # | 消息/场景 | 期望 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | msg#436「读一下最新的陪玩店那个项目」 | 解析到 `peiwan-club-saas`，读到最新 head 和 `9fa6a12` | **通过（工具/数据层）** | `replay-repo-real.json`：repo=`OmnixSI/peiwan-club-saas`、source=`local_index`、head=`fdd7b76`、commits 含 `9fa6a12`、error=null |
| 2 | msg#437「公司里面现在有几个仓库」 | 答 6 个 | **通过（工具层）** | 同上：`list_repos.count=6`，含 6 个 full |
| 3 | msg#438「应该还有一个新的仓库才对」 | 点出 `peiwan-club-saas` | **通过（工具层）** | 同上：count=6，aliases 含「陪玩店/陪玩店新仓库」 |
| 4 | msg#428「说话」@必回 22 分钟 | 90 秒内 reply 或「在做」 | **路径通过，线上有 P1** | `node --test test/mention-guard.test.mjs`：MG2「90 秒内 reply」；但看门狗补了 msg#131/132/153/348 |
| 5 | msg#424「你人呢 查到哪里去了」 | 45 秒回执、完成后不重复 | **路径通过，线上有 P1** | 同上 MG3「45 秒 reply」；44/44 全绿 |
| 6 | outbox#183/#222 看图（msg#305/383/384） | 真能看懂图；失败如实说明 | **未通过** | 生产 selftest 502 `runner_unsupported`；本地 26/26 只证明假 binding 和失败措辞 |
| 7 | outbox#19 CSV 交付（msg#34） | 文件真的发出；失败重试 | **未通过（线上）** | outbox#19 仍 failed（11-11 19:40:41）；deliveries=0；本地 delivery-retry 7/7 只证代码路径 |
| 8 | outbox#206 日推/提醒 | 每天 08:00 Sydney 真推送 | **未通过（线上）** | schedules=0；本地 S7/S13 通过（351 建 08:00、cron 真出站） |

补充：F6-1 的 44/44（mention+repo+tool failure）、F6-6 的 14/14、F6-8 的 7/7、F6-7 的 26/26、整包 `npm test` 858/858、`npm run check` exit 0、Python `repo_index_test` 46 OK + `sync_runtime_secrets_test` 4 OK，均无失败。

## 3. GITHUB_TOKEN

- Worker secret 名单**含 GITHUB_TOKEN**；部署记录明确写「未设置 GITHUB_TOKEN_FILE，线上 GITHUB_TOKEN 未被覆盖」。
- 实际令牌值不可读，Cloudflare secrets API 只返回名字；`request_credential` 的自定义 label 方式在本环境只接受内置 credential_id，未能取得「GitHub 只读令牌（bot 云端读仓库用）」文件，因此**本轮没有独立重跑 6 仓库权限**。本轮没有再申请 1Password；Cloudflare 只读查询用的是此前已交付的令牌文件。
- 可沿用的既有证据：团队记忆 2026-11-14 01:30 Sydney 记录该 fine-grained PAT 对 OmnixSI 全部 6 仓库 metadata/commits/contents/issues/pulls 均 200；本轮 repo_cache 6 行、peiwan `fdd7b76`/`9fa6a12` 也可读，但这是本机 runner 的 `gh` 读权，不等于 Worker token 权限。
- 结论：**配置存在（通过）；6 仓库读权限本轮不能独立验证（不算通过）**。不需要写 Worker secret；若 BINI 要闭环，需能取到该只读令牌文件后重跑一次 6 仓库 GET。

## 4. 未验证 / 需要 BINI 或用户

- **看门狗 P1**：建议开发改 `src/mention-guard.ts:60-70`，加 `m.ts >= now-10min`（或只扫部署后消息）；这是阻塞项。
- **看图 P1**：需要用户在 Cloudflare 控制台 Workers AI 接受 Meta Llama 3.2 许可，之后重跑 `/api/team/vision/selftest` 并回放 #183/#222。
- **日推 P1**：需要一次管理员写操作创建 `daily 08:00 Australia/Sydney` 的 digest schedule；本轮只读，未写线上。
- **CSV P1**：历史 outbox#19 未补发；需要决定是否重发那份 CSV，或让用户重发一次文件任务验证新重试。
- **Worker token 权限**：需要令牌文件路径，或接受沿用 01:30 的核验记录。
- 真实模型措辞未验证：回放用确定性模型 stub，只证明工具选择和数据路径；没有调用生产 DeepSeek 生成最终句子。
- 本轮没有再申请 1Password；之前误触发的那张服务账号令牌卡与本次任务无关，请拒绝/忽略，未读取任何值。

## 5. 证据文件

- 线上只读 JSON：`.agent/releases/F6/postdeploy/online-postdeploy.json`（19 查询全部 `rows_written=0`）
- 真实数据回放：`.agent/releases/F6/postdeploy/replay-repo-real.json`
- 看门狗 P1：`.agent/releases/F6/postdeploy/mention-watchdog-p1.md`
- 日志：`.agent/releases/F6/postdeploy/logs/{mention-repo-tool,schedules,delivery-retry,vision,npm-test,check,python-f6}.log`
- 验收清单：`.agent/releases/F6/acceptance.json`（3 true / 5 false）
- 本报告：`/Users/yanghongming/Projects/TeamAgent-F6-postdeploy-20261114.md`
