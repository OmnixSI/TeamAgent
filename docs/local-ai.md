# 用自己的 AI 接手团队任务

打开[团队工作台](https://inkboard-team.inkboard-server.workers.dev)，输入自己的名字登录：hongming、jinxiang 或 jinyi，大小写均可。三人看到同一份任务、资料和项目动态；当前身份决定领取与回报记在谁的名下。

## 在网页接活

1. 在任务卡片或详情点“我来接手”。任务显示你的名字，群助手会报一声，并夸一句愿意接活的队友。
2. 点“复制给本机 AI”，交给你电脑上的 ChatGPT、Claude、Codex 等助手。材料包含任务编号、仓库基线、原始交办、方案、已有进展和验收条件。
3. 完成后回填实际修改、测试结果和 PR 链接，再标成“待评审”。成员确认后标“已完成”。

两人同时接同一项时只会一人成功。其他成员正在处理的任务需要先沟通交接。旧页面保存遇到版本冲突时，请保留输入、重新读取任务再调整。

## 让本机 AI 直接连接

需要 Node.js 24 或更新版本，以及组织仓库的读取权限。在自己的电脑上执行：

```sh
git clone https://github.com/OmnixSI/TeamAgent.git
cd TeamAgent
npm ci --prefix clients
```

网页右上角点“本机 AI”，为自己的电脑生成一份接入配置。复制页面提供的 MCP JSON，把 `args` 中的路径改成刚克隆的 `TeamAgent/clients/mcp.mjs` 绝对路径，再加到支持 stdio MCP 的本机助手中。不同客户端的配置界面可能不同；所需参数是 Node 启动命令、脚本路径和页面提供的两个环境变量。

本机 AI 的凭证绑定到登录成员，90 天有效，可在同一页面随时撤销。密钥只显示一次，放在本机客户端配置中，不发群、不提交 Git。每台电脑可以使用自己的独立凭证。

连接后可以直接对自己的 AI 说：

> 查看团队待接力的任务，选出适合当前项目目录的一项。先读方案和最新代码，向我说明要做什么；我交办后接手，完成验证，把结果回填为待评审。

也可以明确交办：

> 接手任务 `<任务编号>`，在独立分支完成，运行相关验证，创建草稿 PR，把改动、验证结果和剩余事项同步到团队工作台。

可用工具：

| 工具                    | 用途                                                      |
| ----------------------- | --------------------------------------------------------- |
| `teamagent_list_tasks`  | 查看共享任务；`assignee=me` 看自己，`unassigned` 看待认领 |
| `teamagent_get_task`    | 读取方案、最新版本、原话与仓库基线                        |
| `teamagent_claim_task`  | 以本人身份接手，返回新版本，并通知群里                    |
| `teamagent_report_task` | 回填本人任务的进展、阻塞或待评审成果                      |
| `teamagent_create_task` | 把建议保存为共享待确认任务，不自动开工                    |
| `teamagent_project`     | 查看同步的最新提交、作者、文档、Issue 和 PR               |

每次写入都使用刚读取或接手后返回的 `version`。冲突时先重新读取；别人已修改的内容不会被旧回执覆盖。本机 AI 不能管理成员、密钥或后台执行端，也不能把任务直接标成已验收。

## 不支持 MCP 时

仍然可以复制网页接力材料，手动回填。也可以让助手调用同一套命令行客户端。把页面生成的凭证保存为仅本人可读的 JSON：

```json
{
  "url": "https://inkboard-team.inkboard-server.workers.dev",
  "token": "这里填写自己的本机AI凭证"
}
```

```sh
chmod 600 /你的路径/teamagent-credentials.json
export TEAM_AGENT_CREDENTIALS_FILE=/你的路径/teamagent-credentials.json
node clients/cli.mjs list
node clients/cli.mjs show 任务编号
node clients/cli.mjs claim 任务编号 当前版本
node clients/cli.mjs report 任务编号 接手后版本 ready_for_review /实际路径/验证结果.txt
```

接入凭证不包含 GitHub 写权限。开分支、提交和草稿 PR 使用各成员自己电脑上已有的 GitHub 登录；是否执行命令由本机助手按你的交办处理。复杂开发由成员的本机 AI 负责，群助手持续整理资料、答疑与接力。
