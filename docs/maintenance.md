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

夜间默认悉尼03:00–06:00、安静20分钟后整理，每批最多60条，最多8批。批大小受免费D1查询预算约束。默认每天12点和19点探索技术；把 `scout.enabled` 改为false可停用。参数范围由配置校验器检查，超出支持范围时发布会停止；若要扩展机制，同时修改校验、实现与相关回归检查。

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

当前GitHub官方说明[自托管runner不收Actions计算费用](https://docs.github.com/en/actions/concepts/billing-and-usage)。本项目使用现有电脑，Cloudflare保持免费档，DeepSeek API仍按团队账户计量。没有更改组织账单或提高预算。

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

`off:sticker_send`、`off:sticker_collect` 和 `sticker_paused_until` 仅作为后续表情能力的预留开关，本次 P1 不启用表情发送。引用连续出现三次「HTTP 400/422 JSON → 去掉引用后成功」时，自动设置 `off:quote=1`，并记录 `quote.disabled`。其他 HTTP 错误或未知发送结果不因此重发。恢复前应核对 `outbox_attempts` 和真实 QQ 响应；成功带引用发送会归零 `quote_fail`。

`chat_decisions` 保存每轮的批次、动作、是否 forced、等待、硬规则、引用目标与 outbox id；`outbox_meta` 单独保存引用，保留旧表的位置插入格式。两张表只通过幂等 CREATE 追加。冷图段不写决策或推进游标，续跑的 `chat-v-*` 才判定；等待续跑是 `chat-wait-*`。

部署后的观察点：`last_chat_timing.queueMs` 可核对 Queues 延迟投递；若被 @ 的队列等待持续超过 5 秒，按方案将四个防抖秒数设为 0 后部署回退。QQ 拒绝引用的真实码型、外部请求与 D1 子请求配额仍需线上日志核验，单测不能替代。

## D1 预算与插话评测

`src/d1.ts` 的 `metered()` 在 fetch、每条 queue 消息和 scheduled 入口记录真实执行数，`batch` 的每条语句分别计数。上限 48 为故障路径保留两条；计量器只记录，工具、发送和视频扫描在调用处判断余量。

`COST` 依据 `test/rhythm.test.mjs` 的 B3–B7 实测：冷图 `image=6`，每次模型用量记录 `turn=2`；带八条旧事实更新的纠正工具最多 12，故 `tool` 从 8 升为 12。首次读开关、引用去除重发及第三次失败熔断合计最多 10，故 `send_row` 从 7 升为 10。`tail=16` 保留后续回答与持久化余量，`sticker=5` 为尚未实现的 P2 初值。本次实测三图段 28、引用加两段发送的回答段 44、重工具回合 44、research 30、视频 report 8、各 video_reply 29、积压 cron 最多 44 条。视频扫描每类最多五条；积压由后续 cron 和独立队列任务继续处理。cron 先完成必要维护，再把剩余额度交给发送，避免发送耗尽维护额度。

不准通过调高 48 或调低常量掩盖超限。后续实现扩大工具或发送路径时，先补最大路径的计数测试，再按实测提高常量；三图段应分别保持不超过 30 和 44。

60 条合成场景在 `test/fixtures/timing-synthetic.json`，全部虚构，不含群消息。`scripts/evaluate-timing.mjs` 调用生产的视图、提示组装、三态解析和硬规则函数；标签不进入提示，模型走既有 runtime 边界。真实模型评测只接收当前进程已有的 `DEEPSEEK_API_KEY`，不读取 `.env` 或凭据文件，不发送 QQ、不读远端 D1、不在 CI 调用模型。

```sh
# 仅确定性规则验证，不调用模型，不代表合成模型评测通过
node scripts/evaluate-timing.mjs --rules-only
# 在已安全配置环境变量的本机进程运行；最多调参重跑三轮
node scripts/evaluate-timing.mjs
```

默认结果写入 `~/.inkboard-team/eval/timing-synthetic-result.json`，权限 0600；用 `--output <本机路径>` 可指定位置，不提交结果。本轮 P1 代码交付要求离线合成评测测试和四条规则断言全部通过；按总指挥 2026-11-12 的接续安排，真实模型由交付员在已安全注入环境变量的进程里补跑，作为附加证据，不阻塞代码交付。真实模型评分仍以至少 90% 为通过线；缺少环境变量、请求失败或仅跑规则时不会标记模型合成评测通过。错误只报告未完成，不输出密钥或原始服务异常。

200 个真实窗口的双模型银标、影子回放与 wait 污染排除另行执行；本脚本不声称完成该项。若合并时真实回放仍未达标，部署接续方按方案暂设 `off:wait=1`，达标后再恢复。
