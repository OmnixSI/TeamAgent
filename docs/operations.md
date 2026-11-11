自动发布、共享参数、维护权限与API配置见[维护手册](maintenance.md)。

# 部署、诊断与恢复

源码在 OmnixSI/TeamAgent。当前云端 URL、D1、Queues 和本机私密目录保留旧标识，迁移不重新创建机器人、清空消息或轮换成员凭证。

## 云端

Node24+ 执行 npm ci。wrangler.toml 从示例复制，填自己的账户与 D1 ID。创建 inkboard-team、inkboard-team-chat、team-agent-tools 三条免费队列；聊天消费者并发1，工具消费者并发2，深度工作消费者并发2，batch size1。工具与普通整理不排在max后面，工作任务不进入聊天消费者。

服务端密钥：ADMIN_TOKEN、RUNNER_TOKEN、DEEPSEEK_API_KEY、QQ_APP_ID、QQ_APP_SECRET。用 Wrangler 交互配置或权限0600文件的 secret bulk；不要写进源码、构建变量和 shell 参数。无需把本机 GitHub OAuth令牌上传云端。

升级步骤：

1. 在私密目录导出 D1 备份；D1免费档另有7天Time Travel。
2. npm run check、npm test、npm run test:runner、npm run check:ui。
3. npm run db:migrate。只增表、索引和兼容的方案状态，不删除历史数据。
4. 提交并推送源码，检查 GitHub Check。当前组织托管任务受账单/额度限制无法启动，本轮由同一套本机检查验收并提交明确的本机状态；不更改账单、不升档。
5. npm run deploy。脚本要求工作区已提交，把准确提交号写入 /health。
6. 检查 /health、成员登录、工作台与原有任务；需要时回滚 Worker 版本。新增表可保留，不要反向删除数据来“回滚”。

保留免费档，不运行付费升级命令。D1单次调用最多50查询，批量操作使用 batch；单条参数最多100。本机转发、模型与消息发送有超时，D1保存权威状态，队列只是唤醒。

## 本机

私密目录 ~/.inkboard-team/ 为0700，配置文件0600。docs/config.example.json仅为结构示例。worker-secrets.json由已有 QQ 与模型绑定配置生成，不把它提交到仓库。

- bridge.py：出站领取代码任务、续租、连接agent-autoloop；仓库同步独立线程运行。
- execute.py：独立worktree、Flash max、最多两轮验证、分支和草稿PR。执行标识含任务版本；续租失效会停止DSH进程组，推送前再核对。
- utility.py：普通文件和耗时PDF/视频分别运行；完整输入保存在任务 inputs/messages.json；处理完先保存 completion.json，云端确认后再交付文件。
- qq-gateway.mjs / delivery.mjs：官方SDK收信、落盘转发、session恢复、原生附件发送、发送回执恢复。
- owner.py：127.0.0.1:3391管理代理，只允许回环Host与同源访问。

QQ SDK单独锁定在 runner/sdk/，安装到私密运行目录，不再依赖 DSH 的 QQ 插件目录。文件助手需 pypdf、openpyxl、ffmpeg、ffprobe、yt-dlp；DSH运行于已配置的headless profile，聊天配置high、重要任务配置max。工具在独立工作目录与 workspace-write模式执行；这不是操作系统级容器。

在确认没有运行中资料或开发任务后执行 python3 scripts/install-local.py，更新已审查的运行文件。脚本保留配置、配对、spool、结果与系统服务，安装官方SDK并更新五仓名单，不创建新凭据。

当前 launchd 服务：com.inkboard.team-qq、com.inkboard.team-runner、com.inkboard.team-owner、com.inkboard.team-utility、com.inkboard.team-utility-quick、com.inkboard.team-fetch。用户登录后运行；退出桌面窗口不影响服务。按需用 launchctl kickstart -k gui/$(id -u)/服务名 重启，避免处理中途重启。

电脑需登录、联网、保持唤醒。当前 QQ 入口仍是本机官方长连接；电脑离线时，QQ收信、文件与代码执行均暂停。Web端与已保存资料留在Cloudflare。

## 恢复原则

- **QQ断连**：看工作台网关时间和状态，再查qq.log。READY和RESUMED都表示连接恢复；session落盘可跨进程恢复。平台4914/4915拒绝连接时显示阻塞，不无限重启；修正应用状态后人工重启。
- **群消息转发失败**：qq-spool里按时间补发，事件ID去重。无效或超大事件转qq-rejected，不阻塞后续收信。不要删除spool来掩盖失败。
- **模型失败**：后台最多三次，失败显示在运行状态。管理员只可重试方案、检索、夜间整理；方案版本过期时在任务内重新生成。夜间失败素材不会被当成已整理。
- **方案冲突**：旧AI输出保存在草稿，不覆盖人工内容。成员核对后保存方案或明确排队。
- **开发中断**：任务转成员接手，保留分支、worktree、测试与错误证据。不能自动重开同一版本、合并或发布。
- **资料中断**：completion.json存在时只补报回执，不再跑DSH。成员停止任务后，过期结果不能发布。原始错误只在本机error.txt。
- **附件未知**：.sending在重启后转.unknown，先核对群文件和已确认数量。只重试云端回执，不自动重发附件。确需再次交付时由成员明确提出新任务。
- **群消息未知**：超过发送窗口的sending转unknown；不盲目重发。运行状态可见HTTP状态和平台错误码，不保存密钥或完整异常正文。
- **记忆错误**：用原话纠正或在开发台修正。删除记忆留下来源屏蔽；不要直接改数据库把已关闭版本重新激活。

## 观测与数据

开发台显示近期队列、真实模型档位/耗时/Token、错误任务、附件状态、5分钟连接采样和夜间素材积压。采样最多保留7天，模型指标保留30天，完成的聊天/检索唤醒记录7天后清理；原始消息、事实、任务和交付证据单独持久保存。

日志在私密目录，发布Issue时只提交脱敏的错误码、任务版本与复现步骤。不要上传config、worker-secrets、credentials、QQ session、原始群聊备份或内部思考。

## B 站轻档抓取

`bili.enabled` 控制按需读取公开简介、CC 字幕与热评；无登录态也可运行，字幕缺失时明确说明范围。独立 `team-fetch` 由 `python3 scripts/install-local.py --apply` 幂等安装，要求 Node ≥22；日志在 `~/.inkboard-team/fetch.log` 与 `fetch-error.log`，启动行包含脚本 SHA-256 前 12 位。

只连 B 站 API、b23.tv 与字幕 CDN 公网地址，Cookie 仅发往 API。任务失败或抓取端离线，视频续答到期后按卡片信息回答。暂停领取期间 fetch 同样停止领取。

回滚本机服务：`python3 scripts/install-local.py --apply --remove-fetch`。Worker 设置 `bili.enabled=false` 后停止新建续答，已有等待仍会答完。首次部署与升级需核验 PID、启动哈希及群消息，文件复制成功不代表已启用。

视频续答最多尝试 3 轮；持续失败时只发送一次固定降级说明并进入 `failed`，不会无限重跑。`npm run db:migrate` 会为已有 `video_waits` 表幂等补上 attempts 列并保留等待记录；新建环境直接使用 schema.sql。登录状态接口仅记录状态，本轮未接入登录过期提醒。卸载时若无法停止 team-fetch，会打印警告并保留 plist，需核实进程后再处理。
