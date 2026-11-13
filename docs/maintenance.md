# 团队维护：改哪里，怎样启用

源码、参数、提示词、网页、本机执行器、MCP客户端、迁移、测试和发布流程都在 [OmnixSI/TeamAgent](https://github.com/OmnixSI/TeamAgent)。现有仓库协作者已有写权限，可以开分支评审，也可以按团队约定直接修改 main。新增维护者在仓库访问设置授予 Write，即可使用同一发布流程。

团队工作台：[https://inkboard-team.inkboard-server.workers.dev](https://inkboard-team.inkboard-server.workers.dev)

## 改参数

| 位置                            | 用途                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `config/team.json`              | 共用模型、推理强度、超时、夜间整理、查新时间、修复轮数、仓库范围和代称 |
| `config/team.schema.json`       | 编辑器里的参数提示与类型范围                                           |
| `config/voice.json`             | 群聊嘴替的完整人格与表达提示词                                         |
| `config/participation.json`     | 看谁在对谁说话、什么时候参与、什么时候沉默                             |
| `src/engagement.ts`             | 参与与重复原句检查                                                     |
| `src/ci.ts`                     | CI问题去重、跨仓共享阻塞、恢复与新线索判断                             |
| `src/semantic.ts`               | Agent工具、资料检索、记忆整理与主动探索流程                            |
| `src/tasks.ts`、`src/claims.ts` | 方案、领取、版本冲突与接力                                             |
| `src/runtime.ts`                | 统一DeepSeek请求、凭据过滤、用量和耗时记录                             |
| `runner/`                       | QQ网关、文件处理、开发执行、交付回执与恢复                             |
| `web/`                          | 工作台HTML、样式和交互；构建时嵌入Worker                               |
| `src/guide.ts`                  | 顶部“使用说明”                                                         |
| `wrangler.toml`                 | 实际Worker、D1、三条队列、调度和并发配置                               |
| `.github/workflows/check.yml`   | 自动检查、部署与空闲更新                                               |

日常与小活默认 `quick_effort=high`，重要工作默认 `important_effort=max`。`effort_by_kind` 优先于这两个默认值，可分别调整 `voice`、`participation`、`research`、`memory`、`code`，也可新增实际调用类型。支持 `none / low / high / max`；`none`关闭思考。模型默认 `deepseek-flash`，也可明确改为 `deepseek-v4-pro`。这些值来自[DeepSeek官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)。

夜间默认悉尼03:00–06:00、安静20分钟后整理，每批最多60条，最多8批。批大小受后台 D1 查询预算（≤200 条语句/次）约束，先测再调。默认每天12点和19点探索技术；把 `scout.enabled` 改为false可停用。参数范围由配置校验器检查，超出支持范围时发布会停止；若要扩展机制，同时修改校验、实现与相关回归检查。

本机执行器从相同配置生成DSH的high/max档位，不再读取维护者个人的DSH API密钥。开发轮数、文件超时、代码超时也从该文件读取。正在运行的任务按既有回执与版本继续，更新服务会等待空闲。

## 共用DeepSeek API

团队共用API配置在本仓库 **Settings → Secrets and variables → Actions → `DEEPSEEK_API_KEY`**。发布会把它同步到Cloudflare服务端和本机团队运行目录。聊天、检索、方案、记忆、文件与开发统一使用团队配置；成员维护或发布时无需各自重复填API。

更换共用API：在该仓库Secret中更新值，再运行 **Actions → Check → Run workflow**，或者提交参数变更触发发布。Secret值不会被GitHub重新展示，拥有 Secrets 管理权限的仓库管理员可更新，工作流可使用。普通 Write 维护者修改参数、代码和工作流时，自动发布会直接沿用已有共用API。QQ群和网页不展示它。

其他团队服务凭据也已集中配置为仓库Secrets：`TEAM_ADMIN_TOKEN`、`TEAM_RUNNER_TOKEN`、`TEAM_QQ_APP_ID`、`TEAM_QQ_APP_SECRET`、`TEAM_AUTOLOOP_SOURCE_KEY`。Cloudflare登录使用发布电脑已有的官方Wrangler登录；它的个人OAuth会话不属于项目配置。基础设施标识已在实际wrangler.toml中。

## 提交后自动启用

1. 修改参数、代码或网页，提交并推送到 `main`。
2. **Check** 在群主现有电脑的专用 `teamagent` runner 上运行：配置校验、TypeScript、Node行为检查、Python执行检查、UI语法、MCP客户端检查。
3. 全部通过后，同步团队凭据，执行幂等D1迁移，从该提交发布Worker；`/health`必须返回准确提交号。
4. 同步本机脚本、配置与DSH档位，登记待重启版本。每30秒检查一次空闲状态，空闲后启用本机更新。
5. QQ群内相同CI问题只报一次，重复运行只更新工作台。查看Actions与工作台“运行状态”即可核对发布。

PR只执行检查，合并进main后才发布本助手。这个流程不会自动合并、发布其他业务仓库。`workflow_dispatch`可手动重新发布main。无需成员登录Cloudflare、重填API或开放电脑端口；发布电脑离线时等待它重新上线。

当前GitHub官方说明[自托管runner不收Actions计算费用](https://docs.github.com/en/actions/concepts/billing-and-usage)。本项目使用现有电脑，Cloudflare 于 2026-11-14 升级为 Workers Paid（$5/月），只用套餐自带额度、未开附加项；DeepSeek API 仍按团队账户计量。

## 本机改完再提交

```sh
git clone https://github.com/OmnixSI/TeamAgent.git
cd TeamAgent
npm ci
npm run config:check
npm run check
npm test
npm run test:runner
npm run check:ui
npm ci --prefix clients
npm test --prefix clients
```

Node24或更新、Python3.12或更新即可运行检查；检查不调用付费模型、不向群里发测试消息。本机AI的领取与回填接入见[local-ai.md](local-ai.md)。

## 回滚与迁移电脑

回滚：`git revert`有问题的提交并推到main，检查通过后自动发布回滚版本。需要立即恢复云端时，可在Cloudflare回滚Worker，再通过revert让源码与线上一致。D1新增表保留，不删除历史数据。

迁移发布电脑：使用[GitHub官方自托管runner安装流程](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)，只关联本私有仓库，标签包含 `teamagent`。新电脑登录Wrangler并安装Node、Python、gh与DSH；按[运维说明](operations.md)准备QQ、autoloop和后台服务，再运行Check。迁移QQ网关时先停止旧网关，避免同一机器人两处登录。

本机目录仍叫 `~/.inkboard-team`，用于沿用绑定、缓冲与历史回执。它包含当前连接、共享凭据、session、工作副本和日志；可维护源码均在本仓库，历史群数据在D1，运行状态不作为源码提交。发布runner的注册材料保存在本机专用目录，重新注册不需要改业务代码。

## 插话、防抖与紧急关闭

`config/team.json` 的 `rhythm` 控制聊天时机，修改后需要部署；D1 的 `settings` 开关在下次判定或发送时读取，不需要部署。

| rhythm 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `mention / image / busy / idle` | `1 / 4 / 3 / 2` 秒 | 被 @、只发图、两分钟内至少三条人类消息、其他聊天的防抖；可设为 0，范围 0–10 |
| `cap_ms` | 8000 | 最早未处理消息超过此时限，允许非最新任务处理这批消息 |
| `wait_min / wait_max` | `5 / 45` 秒 | 模型请求等待的上下界；同批最多等一次 |
| `wait_horizon_ms` | 120000 | 超过此批次年龄，不再接受等待 |
| `hard_window_ms / hard_humans` | `1800000 / 6` | 上次主动发言在半小时内、之后少于六条人类消息且没人 @ 或引用机器人时，拦住第二次主动插话 |

通过既有、已授权的 D1 管理入口写入以下语句，即可停用等待或引用；删除对应行后恢复。关闭等待会把模型的 `wait` 解释为 `stop`，不影响被 @ 的必回规则；关闭引用也会影响已入队但未发送的引用。

```sql
INSERT INTO settings(key,value) VALUES('off:wait','1') ON CONFLICT(key) DO UPDATE SET value='1';
INSERT INTO settings(key,value) VALUES('off:quote','1') ON CONFLICT(key) DO UPDATE SET value='1';
-- 恢复：DELETE FROM settings WHERE key IN ('off:wait','off:quote');
```

表情的 `off:sticker_send`、`off:sticker_collect` 和 `sticker_paused_until` 开关及回滚步骤见下文“云端表情库（P2）”。引用连续出现三次「HTTP 400/422 JSON → 去掉引用后成功」时，自动设置 `off:quote=1`，并记录 `quote.disabled`。其他 HTTP 错误或未知发送结果不因此重发。恢复前应核对 `outbox_attempts` 和真实 QQ 响应；成功带引用发送会归零 `quote_fail`。

`chat_decisions` 保存每轮的批次、动作、是否 forced、等待、硬规则、引用目标与 outbox id；`outbox_meta` 单独保存引用，保留旧表的位置插入格式。两张表只通过幂等 CREATE 追加。冷图段不写决策或推进游标，续跑的 `chat-v-*` 才判定；等待续跑是 `chat-wait-*`。

部署后的观察点：`last_chat_timing.queueMs` 可核对 Queues 延迟投递；若被 @ 的队列等待持续超过 5 秒，按方案将四个防抖秒数设为 0 后部署回退。QQ 拒绝引用的真实码型、外部请求与 D1 每次调用语句预算（聊天 48、后台 200）仍需线上日志核验，单测不能替代。

## D1 预算与插话评测

`src/d1.ts` 的 `metered()` 在 fetch、每条 queue 消息和 scheduled 入口记录真实执行数，`batch` 的每条语句分别计数。聊天/HTTP 入口上限 48（为故障路径保留两条），后台队列与 scheduled 上限 200（平台单次 1,000）；计量器只记录，工具、发送和视频扫描在调用处判断余量。

`COST` 依据 `test/rhythm.test.mjs` 的 B3–B7 实测：冷图 `image=8`（含 Workers AI neurons 预扣），每次模型用量记录 `turn=2`；带八条旧事实更新的纠正工具最多 12，故 `tool` 从 8 升为 12。首次读开关、引用去除重发及第三次失败熔断合计最多 10，故 `send_row` 从 7 升为 10。`tail=16` 保留后续回答与持久化余量，`sticker=5` 为尚未实现的 P2 初值。本次实测三图段 28、引用加两段发送的回答段 44、重工具回合 44、research 30、视频 report 8、各 video_reply 29、积压 cron 最多 44 条。视频扫描每类最多五条；积压由后续 cron 和独立队列任务继续处理。cron 先完成必要维护，再把剩余额度交给发送，避免发送耗尽维护额度。

不准通过调高入口预算（聊天 48、后台 200）或调低常量掩盖超限。后续实现扩大工具或发送路径时，先补最大路径的计数测试，再按实测提高常量；三图段应分别保持不超过 30 和 44。

60 条合成场景在 `test/fixtures/timing-synthetic.json`，全部虚构，不含群消息。`scripts/evaluate-timing.mjs` 调用生产的视图、提示组装、三态解析和硬规则函数；标签不进入提示，模型走既有 runtime 边界。真实模型评测只接收当前进程已有的 `DEEPSEEK_API_KEY`，不读取 `.env` 或凭据文件，不发送 QQ、不读远端 D1、不在 CI 调用模型。

```sh
# 仅确定性规则验证，不调用模型，不代表合成模型评测通过
node scripts/evaluate-timing.mjs --rules-only
# 在已安全配置环境变量的本机进程运行；最多调参重跑三轮
node scripts/evaluate-timing.mjs
```

默认结果写入 `~/.inkboard-team/eval/timing-synthetic-result.json`，权限 0600；用 `--output <本机路径>` 可指定位置，不提交结果。本轮 P1 代码交付要求离线合成评测测试和四条规则断言全部通过；按总指挥 2026-11-12 的接续安排，真实模型由交付员在已安全注入环境变量的进程里补跑，作为附加证据，不阻塞代码交付。真实模型评分仍以至少 90% 为通过线；缺少环境变量、请求失败或仅跑规则时不会标记模型合成评测通过。错误只报告未完成，不输出密钥或原始服务异常。

200 个真实窗口的双模型银标、影子回放与 wait 污染排除另行执行；本脚本不声称完成该项。若合并时真实回放仍未达标，部署接续方按方案暂设 `off:wait=1`，达标后再恢复。

## 云端表情库（P2）

代码支持收集、后台标签和按语境发送；QQ 群富媒体仍待线上验收。生产配置保持 `stickers.send=false`。`enabled=true / collect=true` 只开启收集：同一张图按原始 sha256 去重，同一成员重复发送不能让候选晋级，至少两名不同成员使用后才交给视觉模型判断；GIF 或无文字的小图才作为候选，每条消息最多两张。图片字节存入 D1 新表 `stickers`，不修改 `messages.body` 或旧表结构。

标签在 WORK 队列运行，每天最多 40 次，复用既有视觉缓存及每天 300 次视觉额度。状态 0 为候选、1 为待标签、2 为可用、3 为视觉拒收；总量最多 1000 行、单张最多 400000 字节。库满时只清理 30 天前、仅一名发送者的候选；仍满则不收并记录 `sticker.full`。每小时第 7 分钟最多补排十个待标签任务，同一张每天只建一个补排任务。

管理员可通过现有 owner 身份调用 `POST /api/team/stickers`，JSON 为 `{mime,data_base64}`，导入后状态为 1 并排标签任务。支持 JPEG、PNG、GIF、WebP。此路径的 Content-Length 与流读取两处限额均为 `4*ceil(max_bytes/3)+1024`，解码后仍受 `max_bytes` 限制；其他接口继续限制 262144 字节，鉴权不变。未新增读取本机凭据的导入脚本或看板页。

发送需配置值严格为 `true`；字段缺失、字符串 `"true"`、数字等都按关闭处理。嘴替仅在 banter/care 且合适时提供可选的 2–8 字 `sticker` 关键词，多数回复不提供。按 bigram Jaccard 选择得分至少 0.2、24 小时没用过的图；选中后才扣每天 20 次预算，`send_gif=false` 会排除 GIF。同图并发通过同一事务的条件写入保证只排一张。

文字先排队，表情为单独的 `~s` 段。发送前先核对运行开关和 passive 来源年龄；关闭或来源过期时，跳过表情，只有表情待发时连 QQ token 都不获取。文字照常发送。表情先上传 `/files` 获取 `file_info`，再以 `msg_type=7` 发送；缓存距过期超过一分钟时复用，上传没有有效 ttl 时按一小时缓存。任一步失败或网络结果不明均标为 `skipped`，记录 `outbox_attempts`，不重试富媒体。连续三次失败暂停 24 小时并记录 `sticker.paused`，同一轮中后面的图也停止；写入暂停时在同一批事务内归零失败计数，到期后重新累计三次失败；成功也会归零失败计数。

```sql
-- 关闭已排队及后续表情，不需要部署
INSERT INTO settings(key,value) VALUES('off:sticker_send','1') ON CONFLICT(key) DO UPDATE SET value='1';
-- 暂停收集新候选
INSERT INTO settings(key,value) VALUES('off:sticker_collect','1') ON CONFLICT(key) DO UPDATE SET value='1';
```

### 停用、回滚与清空表情

紧急停发先通过已有、已授权的 D1 管理入口设置上面的 `off:sticker_send=1`，下一次发送检查即生效，不需要部署。长期关闭保持 `config/team.json` 的 `stickers.send=false`（默认值），配置修改需要检查并发布；收集和标注可独立保留。

回滚表情代码之前，先关闭发送，并执行以下语句丢弃尚未发送的表情段，再按上文流程回滚。旧版本可能不检查新开关，因此不能只设开关就回滚；文字和已发送记录保留。已发起的 QQ 请求需要先核对结果，不能靠删除待发表撤回。还要检查 `sticker_paused_until`：若它仍在未来 24 小时内，发送仍会被抑制，需等待过期或一并清除（清除语句如下）。

```sql
UPDATE outbox SET status='skipped' WHERE status='pending' AND id LIKE '%~s';
-- 可选：暂停截止在未来的，先清除；否则重新启用发送仍会被抑制
DELETE FROM settings WHERE key='sticker_paused_until';
```

需要清空已收集的图片时，同时设置 `off:sticker_collect=1`，并保持发送关闭、执行上述待发清理。先确认没有正在执行的 `sticker` / `sticker-tag` 任务（`jobs.status='running'`），等已领取任务结束后，再执行以下语句；否则在途收集仍可能把图片写回来。此操作不可恢复，只清空 `stickers` 里的表情图片、标签及对应 `file_info`；不会清 `media_notes`（它不是表情专属，视频/资料缓存仍保留），也不删除群消息和其他任务记录。

```sql
UPDATE jobs SET status='done' WHERE kind IN ('sticker','sticker-tag') AND status='pending';
DELETE FROM stickers;
```

每天发送预算在 `config/team.json` 的 `stickers.caps.send`（默认 20），标注预算在 `stickers.caps.tag`（默认 40）；只在校验允许的范围内调整，运行 `npm run config:check` 后按正常流程发布。标注还受共用视觉预算限制。恢复收集可删除 `settings` 中的 `off:sticker_collect`；恢复发送需确认 QQ 验收通过、`stickers.send=true`，再删除 `off:sticker_send`，并确认 `sticker_paused_until` 已过期或清除，已标为 `skipped` 的段不会重发。

`~s` 不进入 recentBot、对话视图或 P1 的未接话硬规则。`skipped` 不在待发查询或运行状态告警查询中。D1 余量不足时保留 pending，后续 cron 续发；`COST.sticker=6` 覆盖开关、选图、每日预算和三条事务写入，普通文字的 `COST.send_row=10` 不变。富媒体单行另保留两者之和，覆盖缓存写入及熔断路径。关闭的积压用一条条件 UPDATE 标跳过，避免预算不足时逐条写超过 48。

上线接续：由交付员与视觉验收员导入 PNG 和 GIF，临时启用发送并在真群核对上传响应、消息显示及 GIF 动画。没有这些证据前只称“代码就绪，待线上验收”。`file_data`、ttl、富媒体 passive 次数等 QQ 能力仍未验证；不提前实现签名 URL 退路，失败就保持发送关闭。
