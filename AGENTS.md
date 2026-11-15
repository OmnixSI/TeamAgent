# TeamAgent

「做 AI 高手」QQ 群里的常驻 Bot。整套跑在 Cloudflare Workers 上（Worker `teamagent`，一个 Durable Object），不依赖任何本机进程。先读 [README.md](README.md)。

旧版（v1，本机执行器 + D1 + 开发台网页）已停用，代码留在标签 `v1-archive` 里，不要照它的文档和结构做事。

## 改代码之前

- 一轮对话的逻辑在 `src/core.ts`，Bot 的行为规矩在 `src/persona.ts`，内置工具在 `src/tools.ts`。加新能力优先写成功能模块：`src/feat/<名字>.ts` 一个文件（接口在 `src/feat/types.ts`，在 `src/feat/index.ts` 登记），不动共享文件；云电脑里的固定配方写成技能 `src/skills/<名字>.ts`。工具返回真实结果，模型只能照结果说话。
- `src/self.ts` 是 Bot 对自己的描述，群友问“你怎么实现的”时它照这个答。改了架构、存储、流程，在同一次提交里把这里的文字改对。
- 群友能在群里让 Bot 改的东西（参数、做法说明、名字、授权）在 `src/config.ts` 和 `src/selfedit.ts`；其余都是代码，只能在这里改。Bot 写的代码改进提议在 `GET /admin/changes`，接手工作时先看一眼。

## 硬约束

- **不能超出 Cloudflare 套餐**（Workers Paid 每月 5 美元，群主明确要求）。按量的东西都在 `src/budget.ts` 里计数并设了停止线：无头浏览器、容器、R2。新增任何按量计费的用法，先加计数和停止线，再用。常驻的 QQ 长连接已经占掉 Durable Object 在线时长的八成多，不要再加第二个常驻对象。
- 模型一律用 DeepSeek `deepseek-flash`；回话 high，干活 max。OpenAI 只用于画图、音频转写、Python 沙箱。
- 私人群，尺度由 `persona.ts` 的【尺度】一节定，Bot 自己停手的只有那三种。不要加第四种，也不要删。
- 密钥只在 Worker secrets 和 `~/.inkboard-team/`，不进仓库、日志、提示词和群消息。
- 登录各站点用普通浏览器手动登录后取 cookie（`scripts/login-cookies.mjs`），不用带自动化标记的浏览器。

## 验证和发布

```sh
npm install
npm run check      # 类型检查 + 离线测试，几秒钟
npm run deploy     # 先 check，通过才部署
```

- 离线测试里要真跑外部程序（LibreOffice、pandoc、ffmpeg、tesseract）的那几条默认跳过，要跑就 `SKILLS_REAL=1 npm test`。
- 构建机用 Node 24（`.node-version`）。本机 Node 更新的话，合并前用 Node 24 再跑一遍 `npm run check`，两个版本的内置 SQLite 行为有差别。
- 推到 `main` 会自动部署：Cloudflare Workers Builds 先跑 `npm run check`，通过才 `npx wrangler deploy`（2026-11-15 接通）。结果在 GitHub 提交的检查项里看。`npm run deploy` 仍可手动用。
- 部署后 Hub 会在两分钟内自己发现版本变了并重启换上（想立刻生效：`POST /admin/restart`）。云电脑对象不一样：机器开着的时候它一直用旧代码，要等机器空闲关机一次（约 90 秒没人用）才换上。
- 行为改动先在测试房间试：`POST /admin/dry {"room":"x","text":"…"}` 或 `POST /admin/tool`，带真实记忆和设置，不发群。测试画图、发消息一律用 `t:` 房间，不要直接往真群发。
- 提示词按“越不常变的越靠前”排（人设 → 规矩 → 长期记忆 → 工具说明 → 当天聊天 → 末尾提示）。模型服务商按开头相同的部分给缓存价，命中便宜 50 倍。往系统提示词或工具说明里加任何白天会变的内容（时间、计数、列表、状态）都会让它后面的几万 token 按原价重读；这类内容放到 `buildMessages` 末尾。改完用 `GET /admin/prompt` 看 `toolsHash` 稳不稳、`cached_share` 掉没掉。
- 改完验证过就合并到 main 并部署，不用再问。
- 说“已经好了”之前看真实结果：`/admin/turns`、`/admin/toolruns`、`/admin/jobs`、`/admin/recent`。
