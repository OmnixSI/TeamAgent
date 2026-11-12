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
- owner.py：127.0.0.1:3391管理代理，除公开首页外所有 API 都需本机会话；先双击桌面 TeamAgent-登录 解锁，仍保留回环 Host 与同源访问校验。

QQ SDK单独锁定在 runner/sdk/，安装到私密运行目录，不再依赖 DSH 的 QQ 插件目录。文件助手需 pypdf、openpyxl、ffmpeg、ffprobe、yt-dlp；DSH运行于已配置的headless profile，聊天配置high、重要任务配置max。工具在独立工作目录与 workspace-write模式执行；这不是操作系统级容器。

在确认没有运行中资料或开发任务后执行 python3 scripts/install-local.py，更新已审查的运行文件。脚本保留配置、配对、spool、结果与系统服务，安装官方SDK并更新五仓名单，不创建新凭据。

当前 launchd 服务：com.inkboard.team-qq、com.inkboard.team-runner、com.inkboard.team-owner、com.inkboard.team-utility、com.inkboard.team-utility-quick、com.inkboard.team-fetch。用户登录后运行；退出桌面窗口不影响服务。按需用 launchctl kickstart -k gui/$(id -u)/服务名 重启，避免处理中途重启。

电脑需登录、联网、保持唤醒。当前 QQ 入口仍是本机官方长连接；电脑离线时，QQ收信、文件与代码执行均暂停。Web端与已保存资料留在Cloudflare。

## B 站 / X 一次性登录

经审查安装本机版本（`python3 scripts/install-local.py --apply`）后，双击桌面「TeamAgent-登录.command」，选「打开开发台（B 站扫码）」会自动打开并解锁网页，再点「登录 B 站」扫码；选 X 则保持原有的浏览器登录窗口。一次性解锁码无需复制。也可继续在终端使用原有的独立浏览器登录命令（成功后关窗并通知，五分钟未完成则关闭）：

```sh
node ~/.inkboard-team/fetcher.mjs login bili
node ~/.inkboard-team/fetcher.mjs login x
```

Playwright 固定在 `runner/sdk` 的本地依赖中，安装脚本通过 `npm ci --ignore-scripts` 安装。优先使用系统 Chrome，缺少时使用本机 Playwright 缓存中已有的 Chromium；两者都没有时提示需要安装一次浏览器，不自动全局安装。持久化配置与 Cookie 使用 [Playwright 浏览器上下文接口](https://playwright.dev/docs/api/class-browsercontext)。

浏览器配置位于 `~/.inkboard-team/browser/bili/`、`browser/x/`，目录权限 0700；B 站只导出 `SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3`，每项为 `{value, expires}`，写入 `secrets/bili-cookie.json`（文件 0600、目录 0700）。X 不导出 Cookie。导出的 B 站登录 Cookie 只随 `api.bilibili.com` 请求发送，短链和字幕下载不携带 Cookie。账号密码无需交给机器人，Cookie 不进入上报或日志。

fetcher 每天本机时间 09:00 检查两项登录态，重启后错过当天检查会补查；使用 B 站登录态前也会探活。仅从已登录变为过期或风控时弹本机提醒；群里等下一次正常回复附一行，每个服务最多每 24 小时一次，恢复登录后清除提醒标记。缺少登录不催促；检查期间网络失败不会被认定为登录过期。登录窗口打开时，同服务后台检查暂缓。

这一步只提供登录入口、状态探活和提醒，尚不增加 B 站 AI 字幕接口或 X 搜索、时间线读取。
回滚桌面入口：`python3 scripts/install-local.py --remove`；保留用户登录数据及现有后台服务。需撤销登录时由用户在对应网站退出登录或撤销设备。

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

## 网页登录 B 站和 X（仅本机 owner）

双击桌面「TeamAgent-登录.command」→ 选「打开开发台（B 站扫码）」；浏览器会自动打开并解锁管理员开发台 `http://127.0.0.1:3391/`，直接显示「运行状态」中的登录卡片。再点「登录 B 站」并用手机扫码，全程无需复制解锁码。直接打开网址但未解锁时，页面会显示「本机开发台未解锁：双击桌面『TeamAgent-登录』→ 选『打开开发台（B 站扫码）』」，不使用成员名字口令解锁 owner。桌面菜单里的 X 选项保持原有本机登录方式。普通成员名字登录看不到 owner 登录卡片，也不能调用对应接口。

桌面入口以当前 OS 用户生成一次性解锁码：仅把有效期写到 `state/owner-unlock/<码的SHA256>.json`（目录 0700、文件 0600），60 秒过期，只能原子认领一次。明码只放在浏览器 URL 的 `#unlock=` 后，网页先清除地址栏再直接向本机接口交换会话；码不发给 Cloudflare，也不进入日志。会话仅在 owner.py 内存保存哈希，浏览器端只放在当前标签页的 sessionStorage；12 小时过期、最多保留 8 个，owner.py 重启后全部作废，需要重新双击桌面入口。首页和 `/guide` 不带管理员凭据代理，其余 API（包括登录、二维码、AI 凭据与管理员操作）未解锁统一返回 401，且不调用云端；本机会话头不转发给云端。

明确边界：这一层防住其它 OS 用户、没有私密目录访问权限的沙箱进程和跨站网页，**不防同一 OS 用户下的进程**。同用户进程本来就能读取 0600 的 config.json 和 Cookie 文件，这个边界明确接受。解锁码短暂出现在 `/usr/bin/open` 的进程参数里；跨用户的进程参数可见性未核实，因此不把它作为安全防线，仅以 60 秒有效期和一次性认领限制这一残余风险。

- 「登录 B 站」把本机扫码链接画成浏览器内的二维码，用 B 站 App 扫描并确认。二维码 URL 含可领取 Cookie 的轮询凭证，不能经过 Cloudflare/D1 或第三方图片服务。本机 fetcher 只把二维码临时写入 `~/.inkboard-team/state/login-qr/bili-<请求ID>.json`（文件 0600、目录 0700）；owner 通过 `/api/local/service-login/qr?id=<请求ID>` 直接交给同源网页。该接口要求原有回环 Host/Origin 校验及 `X-TeamAgent-Local: 1`，不代理到云端，不提供跨域访问；响应禁止缓存和 Referrer。终态、取消时清理本机二维码，过期文件拒绝读取。云端 owner 页面只给出本机入口，不显示二维码。
- 本机 fetcher 自己持有 key 并调用 passport 的 generate/poll，读取响应的 Set-Cookie，仅把四个允许字段及过期时间写入 `~/.inkboard-team/secrets/bili-cookie.json`（0600）。二维码 URL、轮询 key、成功响应的跨域 URL、refresh_token、cookie 值均不回传。缺少 buvid3 时匿名调用现有 fingerprint API；风控时保留已保存的会话和空 buvid3，后续抓取再补。
- 「登录 X」由本机 fetcher 打开 Chrome，账号密码和验证码只在真实 X 窗口内填写；网页仅显示进展。可点「取消登录」关闭窗口。桌面「TeamAgent-登录.command」继续保留。
- 登录请求五分钟失效，B 站二维码可能更早失效（passport 当前文档为三分钟）。同一服务只能有一个未结束请求；取消或失败后可重新发起。终态和超时不展示二维码。本机风控暂停十分钟，页面提示「B 站暂时限制，请稍后再试」。
- 本机两分钟无领取或登录进展回报时，卡片提示「本机服务没在线，请检查」，停止接受新的登录操作；最近登录检查时间来自现有 auth 状态。先检查 team-fetch 是否在线，避免反复点击。

云端 `settings` 仅使用固定键 `login-flow:bili`、`login-flow:x`、`fetcher:last-seen`，只保存请求 ID、服务、进度和时间，不加表。owner 的 `/api/team/service-login` 支持 GET 状态、POST 请求、DELETE 取消；runner 使用现有 fetch/claim 和 fetch/login-state 回报，暂停领取闸照常生效。状态回报只接受固定进度字段；拒绝二维码及其他额外字段，状态读取时清除旧版本残留的二维码字段。前端活动登录每两秒更新、空闲时每三十秒检查；只在运行状态页可见且 owner 登录时运行。密码、验证码和会话 Cookie 不进入网页；二维码仅在本机 owner 网页短暂显示。

接口字段核对依据：[B 站 web 扫码接口资料](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/login/login_action/QR.md)（2026-11-12，社区整理；真实扫码仍需发布后在 Mac 验收）。
