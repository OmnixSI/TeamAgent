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

更换共用API：在该仓库Secret中更新值，再运行 **Actions → Check → Run workflow**，或者提交参数变更触发发布。Secret值不会被GitHub重新展示，仓库维护者可更新，工作流可使用。QQ群和网页不展示它。

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
