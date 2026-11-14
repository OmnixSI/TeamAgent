# TeamAgent × Agent-Reach 调研：逐平台解剖、同类项目对照、接入优先级前 8

> 调研员 · 2026-11-14 01:50 Sydney（2026-11-13 22:50 北京，谷时）  
> 只读调研，未改 TeamAgent 仓库，未登录任何平台，未安装浏览器。  
> 目标：回答「Agent-Reach 能不能接、为什么不早接、该怎么接」，并给出可直接施工的最小改法。

---

## 0. 结论（先看这 7 条）

1. **Agent-Reach 不是「一个库」，是「给单个 agent 装一套互联网能力」的 Python CLI 安装器。** MIT，v1.6.1，111k stars，14 个渠道；真正抓取靠 `bili-cli` / OpenCLI 浏览器桥 / CloakBrowser / yt-dlp / Exa-Jina。所有东西落在 `~/.agent-reach/`，查询时起无头浏览器，空闲 600 秒自动关闭；它不是常驻服务器，但会留下第二套工具链和浏览器 profile。
2. **不建议整机接入 Agent-Reach。** 它和 TeamAgent 现有的 Playwright/Edge 登录态、Jina 网页读取、B 站轻读取重复；浏览器渠道还要额外 ~200MB CloakBrowser 二进制 + Node/uv/ffmpeg + 一份独立 Chrome profile；更关键的是它把站点 Cookie 复制进自己的共享 profile，和 TeamAgent「X 不导出 Cookie、B 站只导出 4 个字段」的边界相反。
3. **真正该借的是 OpenCLI，不是 Agent-Reach。** OpenCLI 是 Apache-2.0、Node ≥20.18.1、npm 2.0.3、解包 9.1MB、100+ 站点，覆盖 Agent-Reach 没有的**微博、知乎、抖音、微信**；Agent-Reach 只是它的一个精选包装。`opencli list` 每条命令自带 `access: read|write`，可以直接做只读白名单。
4. **Agent-Reach 覆盖不了用户说的「各种东西」。** 它只有 14 个渠道：B 站、小红书、雪球、X、Reddit、YouTube、网页、GitHub、V2EX、LinkedIn、BOSS、Facebook、Instagram、小宇宙。**没有微博、知乎、抖音、微信、快手、TikTok。**
5. **马上能做、零新依赖的是雪球行情/搜索。** 走腾讯 `qt.gtimg.cn` / `smartbox.gtimg.cn`，纯 HTTP、不用登录；本次实验已取到贵州茅台 `1435.26 (+1.77%)`，580ms。
6. **TeamAgent 已经有的能力不要重做：** 任意公开网页（Jina + DeepSeek 兜底）、GitHub README、单条 X 推文（fxtwitter / syndication / oembed）、B 站标题简介/CC 字幕/热评/音轨 ASR、X 登录。缺的是小红书、雪球、微博、知乎、抖音、微信、X 搜索/用户时间线、B 站搜索/热榜。
7. **接入顺序：** 雪球 → OpenCLI 只读骨架 → 小红书 → X 搜索/资料 → 微博 → 知乎 → 抖音 → 微信公众号。B 站保持现有轻读取，不接 Agent-Reach。

### 为什么之前没接

TeamAgent 的读取链路是围绕「QQ 群里发 B 站链接」长出来的：`jobs(kind='fetch')` + 本机 `fetcher.mjs` + `media_notes` 缓存，先解决最高频的 B 站，再补公开网页和单条推文。Agent-Reach 2026-02 才建仓，定位是给 Claude Code/Codex 这类 CLI agent 装「它自己够不着的互联网」，不是给一个有 Worker+D1+本机 runner 的 QQ bot 用的服务。它不是「接一个 SDK」，而是「再装一套浏览器和工具链」；在 B 站链路刚稳定、本机资源又已经被 ASR 占用的阶段，整机接入不划算。现在值得做的是把它的**平台后端**拆出来借，而不是装它。

---

## 1. Agent-Reach 解剖

### 1.1 身份与活跃度

| 项 | 值 | 出处 |
|---|---|---|
| 仓库 | `Panniantong/Agent-Reach` | https://github.com/Panniantong/Agent-Reach |
| 版本 | v1.6.1（2026-11-01 发布） | `pyproject.toml`；Releases |
| 许可证 | MIT（Copyright 2025 Agent Eyes） | `LICENSE` |
| Stars / Forks / Open issues | 111,493 / 9,994 / 104 | GitHub API，2026-11-14 01:40 Sydney |
| 建仓 / 最近推送 | 2026-02-24 / 2026-11-08 | GitHub API |
| 本次核对 commit | `c70ae6da5d39bc90e09ad2ae0575ccc89f31e284` | `git log -1` |
| Python | ≥3.10 | `pyproject.toml` |
| 运行依赖 | `requests`, `loguru`, `pyyaml`, `yt-dlp[default]==2026.8.19` | `pyproject.toml` |
| 安装方式 | `uv tool install <release zip>`；不要从 PyPI 装同名包 | `docs/install.md` |

维护很活跃：2026-11-08 还在合 PR，2026-11-01 发 1.6.1，issue 区 104 个未关闭。但「活跃」不等于「每个平台都稳」，见 1.5。

### 1.2 安装与运行形态

- 一条命令安装：`uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip`，再 `agent-reach setup`。
- `setup` 只启用 **default** 渠道：`bilibili`、`v2ex`、`github`、`youtube`、`web`。这五个不需要浏览器；B 站会装 `bili-cli`，YouTube 会装 `yt-dlp`/`ffmpeg`。
- 浏览器渠道（小红书、X、雪球社区、Reddit、LinkedIn、BOSS、FB、IG）要 `agent-reach add <channel>`，才会装 **OpenCLI 2.0.3**（npm，Node ≥20.18.1，解包 9.1MB）和 **CloakBrowser 0.6.3**（pip，首次启动下载 ~200MB 的 Chromium 二进制；失败回退系统 Chrome）。
- 所有状态在 `~/.agent-reach/`：`tools/`（私有 Python venv / npm prefix）、`browser/profile/`（共享浏览器 profile）、`sessions/`（各 CLI 的登录态）、`config.yaml`（含雪球 Cookie 字符串）。
- 浏览器生命周期：一个共享 profile；查询默认无头；登录才开窗；空闲 **600 秒**关闭；同一平台最多 2 条、合计 4 条并发，多余的排队；CDP 端口默认 9222，可改。见 `agent_reach/runtime/browser.py:63`、`docs/cloakbrowser.md`。
- 输出契约：每条命令一个 JSON，`{schema_version, ok, channel, action, backend, items, meta, error}`；错误码统一为 `NEED_SETUP / NEED_LOGIN / UPSTREAM_BROKEN / TIMEOUT / RATE_LIMITED / PLATFORM_BLOCKED / NOT_FOUND / BAD_INPUT`，每个码带一句给 agent 的 `hint`。见 `agent_reach/runtime/result.py:23-44`。
- **不是 MCP server**，没有常驻 HTTP 服务；集成方式是 `spawn` 子进程。它会给 Claude Code/Codex 等安装一份 skill，但 TeamAgent 不需要。

### 1.3 资源账（按「用户本机不能当服务器、内存要低」核对）

| 项 | 实测/文档 | 评价 |
|---|---|---|
| Agent-Reach 源码 | 2.7MB | 很轻 |
| 基础 Python venv（含 yt-dlp/requests 等） | 62MB（本次 `du -sh`） | 可接受 |
| OpenCLI npm 包 | 19MB `node_modules`；解包 9.1MB | 可接受 |
| CloakBrowser 二进制 | 上游 README 写 ~200MB，缓存在 `~/.agent-reach/cloak-binaries` | 浏览器渠道的固定成本 |
| 运行时浏览器 | 一个 Chromium + 一个本地 Node daemon；空闲 600s 关闭 | **不是常驻**，但查询时会占几百 MB |
| 遗留物 | `~/.agent-reach/` 整个目录；删除要 `agent-reach uninstall` | 不会散落，但不是「用完即走」 |
| 结论 | 基础渠道（web/github/v2ex/youtube）很轻；**一旦加小红书/X，就是 ~200MB 二进制 + 一套独立浏览器** | 和 TeamAgent 现有 Playwright profile 重复 |

补充：CloakBrowser 0.6.3 的免费二进制可以不带 key 用（`pip download` 后查看 `download.py:278`：「unset CLOAKBROWSER_LICENSE_KEY to use the free binary」）。但当前 0.7.2 的 README 改成「每次启动都要 key，免费 key 要邮箱注册、单并发」；Agent-Reach 锁 0.6.3 是刻意避开这个变化。**如果以后升级 Agent-Reach 或单独升级 CloakBrowser，要重新核对许可和 key 要求。** 另外 CloakBrowser 的 wrapper 是 MIT，**浏览器二进制是独立许可，不是 MIT，不能当开源件再分发**（`docs/cloakbrowser.md` 明确写了）。

### 1.4 14 个渠道逐平台解剖

> 后端列来自 `agent_reach/channels/*.py` 与 `runtime/tools.py:57-65`；登录列来自各 channel 的 `login_url` / `login` 定义；限制列附代码或 release note。

| 渠道（等级） | 能做什么 | 读取后端 | 登录 / 凭据 | 关键限制与证据 |
|---|---|---|---|---|
| **bilibili**（默认） | 搜索、视频信息、热门、字幕 | `bili-cli` 0.6.2；`bilibili-api` 兜底 | 前三个不用登录；字幕要 B 站登录。`agent-reach login bilibili` 会先尝试只读复用本机 Chrome 的 bilibili.com Cookie，再走 `bili login` 扫码 | **扫码在 bili-cli ≤0.6.2 上不可用**：B 站把二维码 Cookie 移到 `Set-Cookie`（bilibili-cli#32），Reach 代码注释直接让你「在浏览器登录后重新 login 复用 Cookie」。见 `channels/bilibili.py:173-183`。搜索/热门/详情不登录可用 |
| **xiaohongshu**（可选） | 搜笔记、读正文、看评论 | OpenCLI（Reach 专用浏览器） | 登录：优先只读复制本机 Chrome 的 xiaohongshu.com 登录；否则在专用浏览器里由用户登录 | 读正文必须带搜索返回的完整链接（含 `xsec_token`）；评论只返回「已加载」的，不是全量导出。见 `channels/xiaohongshu.py:30-70`、README 平台表 |
| **xueqiu**（可选） | 实时行情、搜股票、热帖、热股 | 行情/搜索：腾讯 `qt.gtimg.cn` + `smartbox.gtimg.cn`；社区：雪球 HTTP + Cookie | 行情/搜索**不用登录**；热帖/热股要登录。`login xueqiu --sync` 把浏览器里的 Cookie 写进 `~/.agent-reach/config.yaml` | **Cookie 明文写 config**；**会话几小时就过期**（代码注释原话 "The session expires within hours"）；热帖/热股在 1.6.1 发布时未登录未测。见 `channels/xueqiu.py:28,77-110,160-175` |
| **twitter**（实验） | 搜推文、用户资料、用户推文、读推文串 | OpenCLI | 在 Reach 专用浏览器里登录 x.com | 实验级；反爬会变。代码明确不用 `twitter-cli`，因为它验证失败时会重新读浏览器 Cookie。见 `channels/twitter.py:1-20` |
| **reddit**（可选） | 搜帖子、读正文、看评论、看版块 | 公开网页优先；站内搜索走 OpenCLI | 需要时才在专用浏览器登录 | 1.6.1 发布时测试网络被拦，未测通。见 `CHANGELOG.md:65` |
| **youtube**（默认） | 视频信息、搜索、字幕、语音转文字 | `yt-dlp`；转文字用 Groq/OpenAI Whisper | 公开视频不用登录；转文字要 Groq 或 OpenAI key | 字幕/搜索很稳；转文字是付费 key；YouTube 可能弹「sign in to confirm」。见 `channels/youtube.py:1-60` |
| **web**（默认） | 网页搜索、网页阅读（兜底） | 搜索：Exa 免费托管 MCP；阅读：Jina Reader `r.jina.ai`，Exa 兜底 | 不用登录 | 只适合公开页；Jina/Exa 有限流；反爬页会返回验证页。见 `channels/web.py:29,182-197` |
| **github**（默认） | 搜仓库、读仓库/README、读 issue/PR 及评论 | `gh` CLI 优先，否则 GitHub 公开 API | 不用登录 | 匿名 API 60 次/小时；私有仓库要本机 `gh` 登录 |
| **v2ex**（默认） | 热门、节点、帖子与回复、用户 | V2EX 公开 API | 不用登录 | 很轻；公开 API 限流 |
| **linkedin**（可选） | 搜职位、读职位详情 | OpenCLI | 公开职位不用登录；站内搜索要登录 | 1.6.1 发布时未测通。见 `CHANGELOG.md:65` |
| **boss**（可选） | 搜职位、读 JD | OpenCLI + `boss-agent-cli`（固定 commit zip） | 登录 | 可选；本机装 `boss-agent-cli`，不是通用能力 |
| **facebook**（实验） | 搜索、主页资料 | OpenCLI | 登录 | 实验级，反爬严 |
| **instagram**（实验） | 搜用户、主页资料、用户帖子 | OpenCLI | 登录 | 1.6.1 发布时限流未测通 |
| **xiaoyuzhou**（可选） | 播客转文字 | Groq Whisper | Groq key | 付费 key；只做转写 |

**不覆盖：** 微博、知乎、抖音、微信、快手、TikTok、B 站直播/弹幕、小红书评论全量导出。用户说的「雪球啊、推特啊，各种东西」里，Agent-Reach 能覆盖雪球和 X；微博/知乎/抖音/微信要靠 OpenCLI 或别的项目。

### 1.5 五个可以直接借的设计

1. **public-first（先公开、后登录）**  
   每个 action 声明 `public_web` 前缀；能公开读就先公开读，失败才起浏览器。`channels/base.py:31-49` 的 `Action.public_web`，以及小红书/Reddit 的 action 定义。  
   **借用方式：** TeamAgent 的 `readUrl` 已经是这个思路（Jina 先读，失败再 `tool('fetch')`）；新平台也应先试公开页，再走登录浏览器。

2. **统一错误码 + 给 agent 的 hint**  
   `runtime/result.py:23-44` 的 8 个码，每个码一句「下一步怎么办」；`FINAL_CODES` 明确哪些错误不该换后端重试（`NOT_FOUND`、`BAD_INPUT`、`PLATFORM_BLOCKED`、`RATE_LIMITED`、`NEED_LOGIN`）。  
   **借用方式：** TeamAgent 已有 `src/linkfail.ts` 的 `ReadReason`，把新平台的失败映射到同一套 `login_required / risk / not_found / timeout / empty / unsupported` 即可，不要新造一套。

3. **浏览器生命周期：单 profile + 锁 + 600s 空闲 + 登录窗/查询窗分离**  
   `runtime/browser.py:63`（`IDLE_LIMIT=600`）、`browser_watcher.py`（watcher 持锁、启动/关闭、活动检测）、`docs/cloakbrowser.md`。  
   **借用方式：** TeamAgent 的 `runner/browser-auth.mjs` 已有 `launchPersistentContext` 和私有 profile；把「600s 空闲关闭 + 单实例锁 + 登录时开窗/查询时无头」补到 reader 上即可，不需要 CloakBrowser。

4. **只读、站点范围的 Cookie 复用**  
   `backends/opencli.py:120-145` 的 `export_site_cookies(profile, domain)`：通过 OpenCLI 官方 Browser Bridge 的 Page API 读指定 domain 的 Cookie，不读密码库、不动用户原浏览器。  
   **借用方式：** TeamAgent 已经有更严的版本：B 站只导出 `SESSDATA/bili_jct/DedeUserID/buvid3`（`runner/browser-auth.mjs:12,32-43`），X 只检查 `auth_token` 是否存在、不导出（`:203`）。新平台沿用「只导出必要字段、只发给对应域名」的规则。

5. **上游错误翻译成控制流，不泄漏凭据**  
   `backends/opencli.py:16-56` 把 OpenCLI 的 YAML/JSON 错误分成 `PLATFORM_BLOCKED / RATE_LIMITED / NEED_LOGIN / UPSTREAM_BROKEN`，并明确「不要包含上游输出，可能含凭据」。  
   **借用方式：** TeamAgent 的 `runner/fetcher.mjs` 已有 `safeLogText` / `sanitize`；reader 也要把 stdout 先脱敏再落日志。

### 1.6 局限与坑（按严重程度）

| 坑 | 证据 | 影响 |
|---|---|---|
| **发布自述 28/40 个动作真实验收，12 个未测** | `CHANGELOG.md:65,82`：Reddit（网络被拦）、Instagram（限流）、B 站字幕、LinkedIn、雪球热帖热股（未登录）、小宇宙（未配 key） | 这些渠道不能当「已稳定」；上线前要自己跑真实样本 |
| **B 站扫码登录在锁定的 bili-cli 0.6.2 上不可用** | `channels/bilibili.py:173-183` 注释 + `runtime/tools.py:58` 锁 0.6.2 | 只能先在本机 Chrome 登录 B 站，再让 Reach 复制 Cookie；TeamAgent 已有自己的 B 站扫码，不需要它 |
| **雪球 Cookie 明文写 config、几小时过期** | `channels/xueqiu.py:28,160-175`；`Config().set("xueqiu_cookie", ...)` | 不适合把雪球社区做成长期能力；行情/搜索走无登录 HTTP 更稳 |
| **小红书读正文依赖 `xsec_token` 完整链接** | `channels/xiaohongshu.py:30-70` | 用户只发 `xhslink.com` 短链时，要先展开并保留 token；过期就失败 |
| **X/FB/IG 是实验级** | README 平台表；`channels/twitter.py` | 反爬一变就坏；不能作为唯一 X 读取路径 |
| **浏览器渠道要 ~200MB 二进制 + 独立 profile** | `docs/cloakbrowser.md`；CloakBrowser README | 与「本机不当服务器、内存低」有张力；只能按需启停 |
| **CloakBrowser 二进制许可独立，0.7.2 还要 key** | `docs/cloakbrowser.md`；CloakBrowser README | 不能把二进制当 MIT 再分发；升级要重核 |
| **`web read` 在本机 stock Python 3.12 上 SSL 失败** | 本次实验：`SSL: CERTIFICATE_VERIFY_FAILED`；`ssl.get_default_verify_paths()` 的 cafile/capath 都是 None | 不是 Reach 独有，但说明「装完就能用」依赖 Python 证书；uv 装的 Python 可能不同，需实测 |
| **没有 MCP / HTTP 服务** | 代码只有 CLI | 只能 `spawn`；要做队列、超时、并发控制，得自己包一层 |

---

## 2. 同类项目对照（17 个）

> 星数/许可证/最近推送均来自 GitHub API 或 PyPI，读取时间 2026-11-14 01:40–01:55 Sydney。  
> 「稳定性」是工程判断，不是官方承诺；「付费 key」只列**读取所需**，不列可选云服务。

| 项目（★ / 许可证 / 最近推送） | 能读什么 | 怎么登录 | 稳定性 | 付费 key | 对 TeamAgent 的用法 |
|---|---|---|---|---|---|
| **[OpenCLI](https://github.com/jackwener/OpenCLI)** 31.1k / Apache-2.0 / 2026-11-07 | 100+ 站点：小红书、B 站、知乎、微博、抖音、微信、X、Reddit、雪球、LinkedIn、BOSS、V2EX、YouTube… | Chrome/Chromium 装 Browser Bridge 扩展 + 本地 daemon；用已登录的浏览器 profile | 高活跃；适配器会随站点改版坏；`access` 元数据可做只读门禁 | 无 | **首选底座**：Node CLI，`-f json`，只读命令直接接 runner |
| **[Agent-Reach](https://github.com/Panniantong/Agent-Reach)** 111.5k / MIT / 2026-11-08 | 14 个渠道（见 1.4） | 各渠道自选：浏览器 Cookie 复制、专用浏览器登录、扫码、API key | 高活跃，但 12/40 动作未验收；浏览器渠道重 | 仅转写要 Groq/OpenAI key | **只借代码/设计**，不整机装 |
| **[MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)** 71.1k / **非商业学习许可 1.1** / 2026-11-09 | 小红书、抖音、快手、B 站、微博、贴吧、知乎的笔记/视频/评论 | Playwright 或 CDP 连接已开 Chrome；二维码登录；Cookie 缓存 | 高活跃；大规模爬取封控风险高 | 无 | **许可证不允许商用**；只能读代码，不能直接搬进 TeamAgent |
| **[xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)** 17.1k / Apache-2.0 / 2026-11-10 | 小红书：搜索、笔记、评论、用户、发布 | 二维码登录，Cookie 存本地文件；Go 服务 + MCP | 作者称原项目稳定跑一年、只遇 Cookie 过期；仍是自动化 | 无 | 小红书**备用方案**：如果 OpenCLI 的 XHS 适配器坏了，用它的只读 MCP |
| **[twscrape](https://github.com/vladkens/twscrape)** 3.0k / MIT / 2026-11-06 | X/Twitter 搜索、用户、推文、GraphQL | 账号池（用户名/密码/邮箱），session 存 SQLite；不用浏览器 | 中高；依赖 X 接口和账号质量 | 无（但要 X 账号） | X 搜索的**非浏览器**备选；单账号不建议 |
| **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** 207k / Unlicense / 2026-11-04 | YouTube 及上千站点的视频元数据、字幕、音频 | `--cookies-from-browser` 可选 | 很稳，更新极快 | 无 | 已在 TeamAgent 依赖里（`docs/operations.md:34`）；YouTube 读取可直接用 |
| **[RSSHub](https://github.com/DIYgod/RSSHub)** 47.0k / AGPL-3.0 / 2026-11-13 | 微博、知乎、B 站、小红书、抖音等社区路由（RSS/JSON） | 多数公开；部分路由要 Cookie 环境变量 | 路由多但常坏；自建要维护 Node 服务 | 无 | 微博/知乎热榜的**轻量兜底**；不要当主路径 |
| **[Jina Reader](https://github.com/jina-ai/reader)** 12.3k / Apache-2.0 / 2026-05-22 | 任意公开网页 → Markdown；PDF；搜索 | 不需要登录；可选 API key | 托管稳定；有限流/反爬页 | 免费额度；更高配额可选付费 | **TeamAgent 已经在用**（`src/semantic.ts:477-482`），不需要重复接 |
| **[Firecrawl](https://github.com/firecrawl/firecrawl)** 201k / AGPL-3.0 / 2026-11-13 | 网页抓取、爬站、结构化提取 | 公开页不需要登录；云 API key | 托管稳定；自建要维护 | 云版付费；自建免费 | 不建议：TeamAgent 的 Jina 已够用，AGPL 也麻烦 |
| **[Crawl4AI](https://github.com/unclecode/crawl4ai)** 87.3k / Apache-2.0 / 2026-11-13 | 通用网页抓取、Markdown、结构化 | 支持 cookies / storage state / 持久 profile，但没有登录 UI | 中高；要自己写选择器和登录流程 | 无；云版可选 | 可作为「自建通用抓取」备选；不如 OpenCLI 直接 |
| **[browser-use](https://github.com/browser-use/browser-use)** 120.9k / MIT / 2026-11-13 | 任意网页（LLM 驱动点击/读取） | 可用本机 Chrome profile / CDP；也可云浏览器 | 实验性；LLM 不确定、成本高 | 模型 token；云浏览器 $0.06/小时 | 只适合 ad-hoc 探索，不适合群里的确定性读取 |
| **[playwright-mcp](https://github.com/microsoft/playwright-mcp)** 39.6k / Apache-2.0 / 2026-11-13 | 任意网页，MCP 工具 | 持久 profile、`--user-data-dir`、`--cdp-endpoint` 接已有浏览器 | 稳定；偏交互式，批量效率低 | 无 | 可做人工排障/登录辅助；不建议做生产 reader |
| **[Scrapling](https://github.com/D4Vinci/Scrapling)** 102.4k / BSD-3-Clause / 2026-11-11 | 通用网页、反爬页面、自适应选择器 | Cookie/headers；无登录 UI | 中高；stealth 强 | 无 | 公开页兜底；登录平台仍要自己管 session |
| **[xhs](https://github.com/ReaJason/xhs)** 2.2k / MIT / **2025-07-01** | 小红书 Web API 封装（笔记、评论、用户） | Cookie 字符串；需要 JS 签名 | **低**：15 个月没更新，签名易失效 | 无 | 只读代码参考，不建议上线 |
| **[Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)** 21.4k / Apache-2.0 / 2026-11-09 | 抖音/TikTok/B 站：视频信息、无水印下载、评论 | 自建 API；Cookie 可选 | 中高；要自己部署，接口会随平台变 | 无 | 抖音单链接解析的备选；比 OpenCLI 重 |
| **[bilibili-cli](https://github.com/public-clis/bilibili-cli)** 1.2k / Apache-2.0 / 2026-03-14 | B 站搜索、视频、热门、字幕、用户 | 扫码/Cookie | 中；2026-03 后没更新，二维码登录有已知问题 | 无 | 不需要：TeamAgent 的 B 站链路更贴合 |
| **[CloakBrowser](https://github.com/CloakHQ/CloakBrowser)** 32.9k / wrapper MIT、binary 独立许可 / 2026-11-12 | 隐身 Chromium（不是读取器） | 不需要登录；它是浏览器 | 二进制更新快；0.7.2 每次启动要 key | 免费 key（邮箱）或 Pro | 不建议引入：~200MB，且许可/ key 复杂 |

### 2.1 最值得细看的 6 个

**OpenCLI（首选）**
- 安装：`npm i -g @jackwener/opencli@2.0.3` 或 OpenCLIApp；Node ≥20.18.1；包解包 9.1MB。
- 形态：Chrome/Chromium 扩展 + 本地 daemon（默认 `127.0.0.1:19825`）；命令默认 JSON `{"ok":true,"data":...}`；失败 `{"ok":false,"error":{code,message,hint}}`。
- 覆盖：`docs/adapters/index.md` 列了 100+ 站点；中文平台包括 `xiaohongshu`、`bilibili`、`zhihu`、`weibo`、`douyin`、`weixin`、`xueqiu`、`v2ex`、`tieba`、`hupu`、`jike` 等。
- 只读门禁：`opencli list --site xiaohongshu` 返回 27 条命令，每条带 `access: "read"|"write"`。**这是最有价值的集成点**：不用维护黑名单，安装时抓一次 `list`，只允许 `access=read` 的命令进入命令表。
- 关键限制：扩展必须装进一个已登录的 Chromium profile；TeamAgent 要单独准备 `~/.inkboard-team/browser/reader`，不要让 OpenCLI 接用户日常 Chrome。daemon 要显式停，别让 launchd 常驻。

**MediaCrawler（只能读代码）**
- 平台最全：小红书、抖音、快手、B 站、微博、贴吧、知乎；Playwright 登录态 + CDP 连接已开 Chrome。
- 许可证是 `NON-COMMERCIAL LEARNING LICENSE 1.1`：禁止商业用途、禁止大规模爬取。TeamAgent 是团队自用工具，但「商用/对外」边界不清，**不要复制进仓库**；只参考它的登录态缓存和评论分页。

**xiaohongshu-mcp（小红书备用）**
- Go 服务 + MCP；二维码登录，Cookie 存 `cookies.json`；Apache-2.0；17k stars。
- 作者在 README 里称原项目稳定运行一年多、没封号、只遇 Cookie 过期（这是作者自述，不是独立验证）。
- 如果 OpenCLI 的 XHS 适配器坏了，这是最干净的备用：只读 MCP，不写平台。

**twscrape（X 非浏览器备选）**
- 账号池 + SQLite session；`pip install twscrape`；MIT；0.21.0。
- 好处：不用浏览器，搜索/用户/推文直接走 GraphQL；坏处：要维护 X 账号，账号被封就断。
- 不建议作为主路径：TeamAgent 已有 X 登录窗口，OpenCLI 复用同一套登录更顺。

**Jina Reader（已用，不重复）**
- `https://r.jina.ai/<url>` 返回 Markdown；TeamAgent `src/semantic.ts:462-506` 已接，带 512KB 上限、15s deadline、反爬/登录页识别。
- Agent-Reach 的 `web` 渠道没有增量；**不要为了 web 去装 Agent-Reach**。

**RSSHub（微博/知乎兜底）**
- AGPL-3.0；自建 Node；路由覆盖微博/知乎/B 站/小红书/抖音等，但路由经常因平台改版失效。
- 适合「热榜/时间线」这类低价值、可失败的读取；不适合需要登录的正文/评论。

### 2.2 看过但不能直接借

| 项目 | 原因 |
|---|---|
| `cv-cat/Spider_XHS`（8.5k） | **仓库没有 LICENSE**（GitHub API `license=null`）；默认保留全部权利，不能复制 |
| `dataabc/weibo-crawler`（4.7k） | **没有 LICENSE**；只能读思路，不能搬代码 |
| `Nemo2011/bilibili-api`（4.2k） | **已 archived**，`license=null`；不要作为新依赖 |
| MediaCrawler | 非商业学习许可；不能用于商业/大规模 |
| CloakBrowser 二进制 | wrapper MIT，binary 独立许可；不能再分发 |
| Agent-Reach 里的 `boss-agent-cli` | 固定 commit zip，来源/许可不清晰；不建议引入 |

---

## 3. 对照 TeamAgent 现状

### 3.1 现有链路（精确到文件/行）

```
QQ 消息
  → Worker (src/worker.ts)
  → jobs(kind='fetch')  [schema.sql:8]
  → 本机 fetcher.mjs 的 claim 循环 [runner/fetcher.mjs:244]
  → /api/runner/fetch/claim|report [src/worker.ts:1437, src/fetchjobs.ts:418-426]
  → B 站 API / 字幕 / 热评
  → media_notes 缓存 [schema.sql:13]
  → 回复
```

| 能力 | 现状 | 证据 |
|---|---|---|
| 公开网页正文 | ✅ Jina Reader + DeepSeek `fetch` 兜底；512KB；反爬/登录页识别 | `src/semantic.ts:462-506`；`src/linkfail.ts:41` |
| GitHub README | ✅ `raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md` | `src/semantic.ts:468-476` |
| 单条 X 推文 | ✅ fxtwitter → syndication → oembed，三级 fallback | `src/semantic.ts:419-460` |
| B 站标题/简介/CC 字幕/热评 | ✅ `BiliResult`；字幕缺失有 `subtitle_status` | `src/fetchjobs.ts:9-20,359+`；`runner/fetcher.mjs` |
| B 站音轨 ASR | ✅ 本机 X-ASR；内存 1300MB、临时空间 2048MB、启动门禁 | `runner/media.mjs:13,106,159` |
| X 登录 | ✅ 本机 Edge/Chrome 持久 profile + CDP；只检查 `auth_token` 存在，不导出 Cookie | `runner/browser-auth.mjs:75,158,203`；`runner/native-x-browser.mjs` |
| X 搜索/用户时间线 | ❌ 只有单条推文 | — |
| 小红书 | ❌ | — |
| 雪球 | ❌ | — |
| 微博 / 知乎 / 抖音 / 微信 | ❌ | — |
| B 站搜索/热榜 | ❌ 只按链接读单条 | — |
| YouTube | ⚠️ 装了 yt-dlp（文件助手用），没有 reader 管线 | `docs/operations.md:34` |
| 认证状态 | 只有 `bili` / `x` 两个服务 | `src/auth-status.ts:3` |

### 3.2 差距结论

Agent-Reach 相对 TeamAgent 的**真实增量**只有：
- 小红书（搜索/正文/评论）
- 雪球（行情/搜索/热帖）
- X 搜索/资料/时间线/推文串（TeamAgent 只有单条）
- B 站搜索/热榜（TeamAgent 只有单条）
- YouTube 读取/字幕
- Reddit / LinkedIn / BOSS / FB / IG（低优先级）

Agent-Reach **补不了**微博、知乎、抖音、微信——这四个必须靠 OpenCLI 或专门项目。  
OpenCLI 相对 Agent-Reach 的增量：微博、知乎、抖音、微信、贴吧、虎扑、即刻等 100+ 站点；而且它是 Apache-2.0、Node、9.1MB，更适合 TeamAgent 的技术栈。

### 3.3 三条接入路线

| 路线 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. Agent-Reach CLI sidecar** | runner `spawn` `agent-reach <channel> <action> --json` | 14 个渠道开箱；错误码/超时/并发都做好了 | Python+uv+CloakBrowser+200MB；和现有浏览器重复；Cookie 边界相反；仍缺微博/知乎/抖音/微信 | **不推荐作为底座**；只在对 YouTube/小宇宙有需求时局部用 |
| **B. OpenCLI 只读 sidecar** | runner `spawn` `opencli <site> <action> ... -f json`；只允许 `access=read` | Node/Apache；100+ 站点；覆盖全部中文平台；JSON；9.1MB；登录复用浏览器 | 要扩展 + daemon + 独立 Chrome profile；适配器会坏；要自己包生命周期 | **推荐** |
| **C. 纯 HTTP 移植** | 雪球行情/搜索、V2EX、GitHub 直接 `fetch` | 零新进程、零浏览器、最快 | 每个平台单独写；XHS/X 的签名做不了 | **推荐做雪球等简单平台** |

**最终建议：B + C 组合，A 只作为参考实现和 YouTube/小宇宙的备选。**

### 3.4 推荐架构（OpenCLI 只读 sidecar）

```
QQ 消息 / URL
  → Worker 识别平台（src/inbound.ts 增加 extractReaderLinks）
  → jobs(kind='reader', payload={source,action,target,waiter})   ← 复用 jobs 表，不建新表
  → 本机 runner/reader.mjs claim（/api/runner/reader/claim）
  → 白名单命令表 → spawn `opencli <site> <action> ... -f json`
      env: HOME=~/.inkboard-team/opencli, OPENCLI_PROFILE=teamagent
      timeout: 45s；stdout 先脱敏；stderr 只留错误码
  → 解析 {ok,data}；映射 NEED_LOGIN/RATE_LIMITED/...
  → 回传 Worker；Worker 清洗/截断 → media_notes(id='read:v1:<source>:<hash>')
  → 回复时用 untrusted() 包裹正文（防止网页提示注入）
```

**为什么复用 `jobs`/`media_notes`：** `schema.sql:8` 的 `jobs` 已经有 `kind`、`payload`、`attempts`、`lease_until`、`error`；`media_notes` 是通用 KV + 时间。加一个 `kind='reader'` 不需要迁移；`claimFetch` 只认 `kind='fetch'`，不会误领。需要新增的是 `claimReader` / `reportReader` / 路由，不要改 `fetch` 的语义。

### 3.5 最小改法 A：OpenCLI 只读 sidecar（约 400–500 行）

**新增 `src/readerjobs.ts`（约 220 行）**

```ts
export type ReaderSource = 'xhs'|'x'|'weibo'|'zhihu'|'douyin'|'weixin'|'xueqiu'|'bilibili';
export type ReaderAction = 'search'|'read'|'comments'|'profile'|'hot';

// 只允许这里列出的组合；target 只做 URL/ID 校验，绝不拼任意参数
const COMMANDS: Record<ReaderSource, Partial<Record<ReaderAction, (a:any)=>string[]>>> = {
  xhs:   { search: a=>['xiaohongshu','search',a.query,'--limit',String(a.limit??5)],
           read:   a=>['xiaohongshu','note',a.url],
           comments:a=>['xiaohongshu','comments',a.url,'--limit',String(a.limit??20)] },
  x:     { search: a=>['twitter','search',a.query,'--limit',String(a.limit??5)],
           profile:a=>['twitter','profile',a.username],
           read:   a=>['twitter','thread',a.url] },
  weibo: { hot: a=>['weibo','hot','--limit',String(a.limit??10)],
           search:a=>['weibo','search',a.query,'--limit',String(a.limit??5)] },
  zhihu: { hot: a=>['zhihu','hot','--limit',String(a.limit??10)],
           search:a=>['zhihu','search',a.query,'--limit',String(a.limit??5)] },
  douyin:{ read: a=>['douyin','detail',a.url] },
  weixin:{ read: a=>['weixin','download','--url',a.url,'--output',a.outDir],
           search:a=>['weixin','search',a.query,'--limit',String(a.limit??5)] },
  xueqiu:{ /* 走纯 HTTP，不走 OpenCLI，见 3.6 */ },
  bilibili:{ /* 保持现有 fetch，不接 */ },
};

export function readerCmd(source: ReaderSource, action: ReaderAction, args: any): string[] {
  const fn = COMMANDS[source]?.[action];
  if (!fn) throw new Error('unsupported reader command');
  return fn(args);
}
```

配套：`requestRead()` 写 `jobs`（`kind='reader'`，id 用 `read-<source>-<hash>`，payload 带 `waiters`）；`claimReader()` 与 `claimFetch` 同构；`reportReader()` 校验 lease、清洗、写 `media_notes`、更新 job；`readerRoute()` 处理 `/api/runner/reader/claim|report|login-state`。Worker 侧 `src/worker.ts` 在 `:1437` 旁边加 `if (path.startsWith('/api/runner/reader/')) return readerRoute(...)`。

**新增 `runner/reader.mjs`（约 180 行）**

```js
import {spawn} from 'node:child_process';
import {readerCmd} from './reader-commands.mjs'; // 命令表放 runner 侧；Worker 只认 source/action 白名单
const run = (argv, {timeout=45000, env={}}={}) => new Promise((resolve) => {
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore','pipe','pipe'],
    env: {...process.env, HOME: env.HOME, OPENCLI_PROFILE: 'teamagent'},
  });
  let out='', err='', done=false;
  const timer=setTimeout(()=>{ if(!done){done=true; child.kill('SIGKILL'); resolve({code:-1,out,err:'timeout'});} }, timeout);
  child.stdout.on('data', d=>out+=d);
  child.stderr.on('data', d=>err+=d);
  child.on('close', code=>{ if(!done){done=true; clearTimeout(timer); resolve({code,out,err});} });
});
```

命令表不要放在 `src/` 再让 runner import（TS 编译产物路径不稳定）；`runner/reader-commands.mjs` 与 Worker 的 enum 各存一份，用同一份 JSON 生成测试，保证两边一致。

要点：
- 只跑命令表里的命令；**绝不把用户输入拼成 `opencli browser` 原语**。
- 安装时跑一次 `opencli list --site <site> -f json`，把 `access=write` 的命令记下来并从表里删掉；升级 2.0.3 后重跑。
- `stdout` 可能含带 `xsec_token` 的 URL；落日志前用现有 `safeLogText` 脱敏，D1 只存清洗后的正文。
- 超时 45s；`PLATFORM_BLOCKED`/`RATE_LIMITED` 直接回用户「平台暂时拦了」，不要循环重试。
- daemon 生命周期：首次 `opencli` 会自动起 daemon；在 `reader.mjs` 退出前检查 `lsof -i :19825`，如果是本次起的就 `opencli browser close` / kill；不要让 launchd 常驻 daemon。

**新增配置 `config/team.json`**

```json
"readers": {
  "enabled": false,
  "sources": ["xhs","x","weibo","zhihu","douyin","weixin"],
  "timeout_ms": 45000,
  "max_chars": 6000,
  "idle_close_seconds": 600
}
```

**登录/授权：**
- 单独 profile：`~/.inkboard-team/browser/reader`（0700），不要用用户日常 Chrome，也不要用现有 `browser/bili`、`browser/x`。
- 一次性登录：在开发台加「登录 小红书 / X / 微博 / 知乎 / 抖音」按钮，起一个带扩展的 Edge/Chrome 窗口，用户自己扫码/输密码；只发布固定状态字段（platform、phase、has_session），不发布 Cookie。
- 认证状态：先独立 `settings` key `auth:reader:<source>`，不要硬塞进 `src/auth-status.ts` 的 `['bili','x']` 类型；等稳定后再合并。

**安装：**
- `scripts/install-local.py` 增加 `opencli@2.0.3` 的 npm `--prefix ~/.inkboard-team/opencli` 安装 + SHA/版本校验；扩展 zip 放 `~/.inkboard-team/opencli/extension`。
- 不自动装 Chrome；检测系统 Chrome/Edge/Playwright Chromium，缺了就提示「装一次浏览器」。
- 回滚：删 `~/.inkboard-team/opencli` 和 `browser/reader`，配置 `readers.enabled=false`。

### 3.6 最小改法 B：雪球行情/搜索（纯 HTTP，约 100 行）

Agent-Reach 的 `channels/xueqiu.py:291-330` 是现成实现：

```python
# 行情（GBK）
body = http_request(f"https://qt.gtimg.cn/q={code}").decode("gbk")
f = body.split('="')[1].split("~")
# f[1]=名称 f[2]=代码 f[3]=现价 f[4]=昨收 f[5]=今开
# f[30]=时间 f[31]=涨跌额 f[32]=涨跌幅 f[33]=最高 f[34]=最低

# 搜索（UTF-8）
body = http_request(f"https://smartbox.gtimg.cn/s3/?v=2&q={q}&t=all").decode("utf-8")
```

Node 移植：

```js
// runner/xueqiu.mjs
const txt = new TextDecoder('gbk').decode(await (await fetch(`https://qt.gtimg.cn/q=${code}`)).arrayBuffer());
const f = /="([^"]*)"/.exec(txt)?.[1]?.split('~');
if (!f || f.length < 35) throw new Error('not_found');
return {symbol: f[2], name: f[1], current: f[3], last_close: f[4],
        open: f[5], chg: f[31], percent: f[32], high: f[33], low: f[34], time: f[30]};
```

- `_tencent_code()` 的映射规则也要照搬：`SH600519`/`600519`/`00700`/`AAPL`；`600519` 按首位判断 `sh/sz/bj`；`00700` → `hk00700`；`AAPL` → `usAAPL`。见 `xueqiu.py:130-158`。
- 放在本机 runner 而不是 Worker：`TextDecoder('gbk')` 在 Node 26 可用；Cloudflare Workers 的编码支持不确定，别赌。
- 缓存：`media_notes` id `quote:v1:<symbol>`，TTL 60s；搜索 10min。
- 路由：`GET /api/team/quote?symbol=SH600519`；回复带「数据时间」；不登录、不碰 Cookie。
- 验收：`SH600519`、`600519`、`00700`、`AAPL` 四个都出数；坏代码返回 `not_found`；不产生任何浏览器进程。

### 3.7 不建议做的接入

| 做法 | 原因 |
|---|---|
| 装整套 Agent-Reach，让 bot 调 `agent-reach` | 与现有 Jina/B 站/X 单推文重复；多一套 Python/uv/CloakBrowser；仍缺四个中文平台 |
| 用 MediaCrawler 做小红书/微博 | 非商业许可；大规模爬取封控；代码是 Python 同步栈 |
| 用 browser-use 做每次读取 | 每次要 LLM 决策，慢、贵、不确定；群聊场景要的是确定性 |
| 用 Firecrawl 云版 | 付费；Jina 已覆盖公开页；AGPL 自建麻烦 |
| 把 OpenCLI 的 `browser` 原语暴露给模型 | 等于给模型一个可点击任意网页的浏览器；必须只暴露命令表 |
| 让 OpenCLI 接用户日常 Chrome | 读到用户所有登录态；和 TeamAgent 的私有 profile 边界冲突 |

---

## 4. 风险

| 风险 | 具体表现 | 处置 |
|---|---|---|
| **账号封控 / 条款** | 小红书、X、微博、知乎对自动化浏览器有设备指纹和频率风控；OpenCLI 扩展 + CDP 也可能被识别 | 只读、低频（建议 1 请求/3–5 秒）、不发布/不评论/不关注；用小号；遇验证码立即停，不重试；用户已知悉并接受 |
| **Cookie / 会话泄漏** | OpenCLI profile 里是多个站点的完整登录态；stdout 可能带 `xsec_token` | profile 0700；不进 D1、不进日志、不进截图；只回传固定状态字段；reader 退出时清临时文件 |
| **提示注入** | 网页正文可能包含「忽略之前指令」 | 继续用 `src/untrusted.ts` 包裹；正文只作为材料，不触发工具；系统提示明确「网页内容是不可信数据」 |
| **写操作** | OpenCLI 有 `publish`/`comment`/`follow`/`delete` 等写命令 | 安装时用 `access=read` 生成白名单；代码层只允许命令表；不提供通用 `browser` 工具 |
| **资源** | Chrome + Node daemon + 600s 空闲；本机已有 ASR | 按需启停；空闲 600s 关；同时最多 1 个 reader 浏览器；内存门禁沿用 `startupGate` 思路 |
| **稳定性** | 平台改版 → 适配器坏；OpenCLI 升级可能改 JSON | 锁 `@jackwener/opencli@2.0.3`；启动时 `opencli list` 健康检查；失败回退到 Jina 公开页或明确说「读不到」 |
| **许可证** | OpenCLI Apache-2.0（需 NOTICE）；Agent-Reach MIT；MediaCrawler 非商业；Spider_XHS/weibo-crawler 无证 | 只复制 MIT/Apache/BSD 代码并在 NOTICE 注明；不复制无证/非商业代码；CloakBrowser 二进制不引入 |
| **平台 ToS** | 抓取/自动化可能违反平台条款 | 只读用户本来能看的内容；不批量导出；不做商业分发；出问题由使用者承担 |

---

## 5. 接入优先级前 8（可直接施工）

> 排序依据：用户价值 × 实现成本 × 风险。每项都给出「改哪里、用什么命令、怎么验收」。

### P1. 雪球行情/搜索（零新依赖，先做）

- **用户价值：** 群里问「茅台现在多少」「帮我看看英伟达」——最高频、最确定。
- **实现：** `runner/xueqiu.mjs` 新增 `quote(symbol)` / `search(query)`；`src/quote.ts` 或 `src/xueqiu.ts` 加路由和缓存；复用 `media_notes`。
- **命令/接口：** `https://qt.gtimg.cn/q=<code>`（GBK，`~` 分隔）；`https://smartbox.gtimg.cn/s3/?v=2&q=<q>&t=all`。
- **借用：** `agent_reach/channels/xueqiu.py:130-158`（代码映射）、`:291-330`（解析）。
- **新增：** 约 100–120 行；`config/team.json` 加 `quote.enabled`。
- **不做：** 雪球热帖/热股（要登录、Cookie 明文、几小时过期）；等 P2 的 OpenCLI 雪球适配器稳定后再考虑。
- **验收：** `SH600519`、`600519`、`00700`、`AAPL` 四个都返回现价/涨跌幅/时间；`quote` 响应 < 2s；坏代码 `not_found`；无浏览器进程。

### P2. OpenCLI 只读骨架（一次投入，解锁后面 6 项）

- **用户价值：** 让 bot 能读小红书/微博/知乎/抖音/微信/X 的公开内容。
- **实现：** `src/readerjobs.ts` + `runner/reader.mjs` + `src/worker.ts` 路由 + `config/team.json`；安装 `@jackwener/opencli@2.0.3`。
- **只读门禁：** 安装时 `opencli list --site <site> -f json`，只保留 `access=read`；代码层命令表白名单。
- **新增：** 约 400–500 行；无 D1 迁移（复用 `jobs`/`media_notes`）。
- **验收：** 用一个假命令跑通 claim→spawn→report→D1→回复；`access=write` 命令无法构造；超时 45s 返回 `timeout`；未登录返回 `login_required`；`stdout` 不含 Cookie/token。
- **风险：** 扩展 + daemon + 独立 profile 的安装/登录是最大不确定项；先用一台机器手工验证 `opencli list` 和一条 `xiaohongshu search`。

### P3. 小红书（搜索 / 读正文 / 评论）

- **用户价值：** 用户明确提到小红书；群里的笔记链接可直接读。
- **实现：** `xiaohongshu search <q> --limit N`、`xiaohongshu note <url>`、`xiaohongshu comments <url> --limit N`；URL 识别 `xiaohongshu.com/explore|search_result`、`xhslink.com`。
- **关键：** `note` 必须带搜索返回的 `xsec_token` 完整链接；短链先展开并保留 token；评论只当「已加载」。
- **验收：** 3 条真实笔记（含 1 条短链）→ 标题/作者/正文/点赞；1 条过期 token → 明确 `expired/login_required`；不发布、不评论。
- **备用：** `xiaohongshu-mcp`（Apache-2.0）只读 MCP。

### P4. X 搜索 / 用户资料 / 用户推文 / 推文串

- **用户价值：** 现有只能读单条推文；群聊常问「这个人的最近推文」「搜一下」。
- **实现：** `twitter search <q> --limit N`、`twitter profile <handle>`、`twitter tweets <handle> --limit N`、`twitter thread <url>`。
- **登录：** 用 OpenCLI 的 `reader` profile 登录 x.com；不要读用户日常 Chrome；不导出 `auth_token`。
- **验收：** 3 条搜索/2 个用户 → 条目数/作者/时间；未登录 → `login_required`；日志无 `auth_token`。
- **备选：** `twscrape`（MIT）账号池；不优先。

### P5. 微博（热搜 / 搜索 / 用户）

- **用户价值：** 中文热点；Agent-Reach 没有，OpenCLI 有。
- **实现：** `weibo hot --limit 10`、`weibo search <q> --limit N`、`weibo user <uid>`。
- **验收：** 热搜 10 条；搜索 5 条；1 条登录墙 → `login_required`。
- **兜底：** RSSHub 微博路由（AGPL）只做热榜，不做正文。

### P6. 知乎（热榜 / 搜索 / 问题）

- **用户价值：** 技术/长文；OpenCLI 有 `zhihu hot|search|question|answer-detail`。
- **实现：** `zhihu hot --limit 10`、`zhihu search <q> --limit N`、`zhihu question <url>`。
- **验收：** 热榜 10 条；搜索 5 条；1 个回答正文；登录墙 → `login_required`。

### P7. 抖音（单条分享链接）

- **用户价值：** 群里常见 `v.douyin.com` 短链。
- **实现：** `douyin detail <url> -f json`；OpenCLI 文档明确支持 16–20 位 ID、抖音 URL、`v.douyin.com` 短链（最多 6 次跳转），返回文案/作者/sec_uid/互动/时长/音乐/媒体 URL。
- **验收：** 3 条短链 → 文案/作者/点赞；删除/受限 → `not_found`；媒体 URL 过期不缓存。
- **备选：** `Douyin_TikTok_Download_API`（Apache-2.0）自建 API；比 OpenCLI 重，暂不做。

### P8. 微信公众号（文章正文 / 搜索）

- **用户价值：** 群里转发的 `mp.weixin.qq.com` 文章；公开文章现有 Jina 可能已能读，先测再决定。
- **实现：** 公开文章先用现有 `readUrl`；读不到再用 `weixin download --url <url> --output <tmp>`；搜索用 `weixin search <q> --limit N`（搜狗）。
- **验收：** 3 篇文章 → Markdown 标题/正文；1 篇登录墙 → `login_required`；搜索 5 条；临时目录用完清理。
- **注意：** 搜狗微信搜索反爬较强；不要把搜索做成高频。

### 暂不做（写进 `next.md`）

- B 站搜索/热榜：现有单条链路够用；OpenCLI B 站适配器走浏览器，收益低。
- YouTube：yt-dlp 已装；等有群需求再加 `youtube search|transcript`。
- Reddit/LinkedIn/BOSS/FB/IG：用户价值低、登录/风控成本高。
- MediaCrawler / Spider_XHS / weibo-crawler：许可证不允许直接借。
- browser-use / Firecrawl / Crawl4AI：成本/复杂度高于收益。

---

## 6. 实验记录（实际做了什么）

| 实验 | 命令 | 结果 |
|---|---|---|
| 克隆并读源码 | `git clone --depth 1 https://github.com/Panniantong/Agent-Reach` | 成功；HEAD `c70ae6d`（2026-11-08）；v1.6.1 |
| 隔离安装 | `python3 -m venv /tmp/ar-survey/venv && pip install -e ./Agent-Reach` | 成功；venv 62MB；未污染用户 Python |
| 渠道清单 | `HOME=/tmp/... python -m agent_reach.cli channels` | 返回 14 个渠道 + 每个 action 的参数/后端/登录要求；JSON 可解析 |
| 体检 | `... doctor` | `ok:true`；`bilibili` 报 `bili-cli not installed`；其余 `unverified/not_added` |
| 雪球行情 | `... xueqiu quote 600519` | **成功**：`贵州茅台 1435.26 (1.77%)`；`backend:"tencent"`；`elapsed_ms:580`；raw time `20261113161455` |
| 网页读取 | `... web read https://example.com` | **失败**：`SSL: CERTIFICATE_VERIFY_FAILED`（本机 stock Python 3.12 的 `ssl` cafile/capath 为空）；设置 `SSL_CERT_FILE` 后后端已因首次失败被暂停 108s，未再重试。**未验证该机器上 web 渠道可用** |
| OpenCLI 安装 | `npm install --prefix /tmp/ar-survey/opencli @jackwener/opencli@2.0.3` | 成功；`opencli --version` = 2.0.3；`node_modules` 19MB |
| OpenCLI 只读元数据 | `opencli list --site xiaohongshu -f json` | 返回 27 条命令，每条带 `access: read / write`；这是只读门禁的依据 |
| OpenCLI 命令 schema | `opencli xiaohongshu search --help -f json` | 返回 positionals/options；`limit` 默认 20；`browser:true` |
| 未做 | 安装 CloakBrowser / 启动浏览器 / 登录任何平台 / 真实读小红书/X/微博/知乎/抖音/微信 | 为避免 200MB 下载、账号副作用和用户本机垃圾；这些是 P2/P3 的实机验收项 |
| 未改仓库 | `git status`（TeamAgent V-C release worktree） | 只读；本报告写在 `/Users/yanghongming/Projects/`，不改仓库 |

**临时目录清理：** `/tmp/ar-survey`（含 venv、clone、OpenCLI、npm cache）和 `/Users/yanghongming/Projects/.ar-survey-home` 已删除；`lsof -i :19825` 无监听，未留下 daemon。

---

## 7. 依据（可打开）

### Agent-Reach
- 仓库：https://github.com/Panniantong/Agent-Reach
- 本次 commit：https://github.com/Panniantong/Agent-Reach/tree/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284
- 平台表：`README.md:99-112` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/README.md#L99-L112
- 工具版本：`agent_reach/runtime/tools.py:57-65` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/tools.py#L57-L65
- 浏览器空闲：`agent_reach/runtime/browser.py:63` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/browser.py#L63
- 统一错误码：`agent_reach/runtime/result.py:23-44` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/result.py#L23-L44
- OpenCLI 调用/错误翻译：`agent_reach/backends/opencli.py:16-145` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/backends/opencli.py
- B 站扫码问题：`agent_reach/channels/bilibili.py:173-183` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/bilibili.py#L173-L183
- 雪球行情/搜索：`agent_reach/channels/xueqiu.py:130-158,291-330` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/xueqiu.py
- 雪球 Cookie 同步：`agent_reach/channels/xueqiu.py:160-175` — 同上
- 小红书动作：`agent_reach/channels/xiaohongshu.py:30-70` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/xiaohongshu.py
- Web/Exa/Jina：`agent_reach/channels/web.py:29,182-197` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/web.py
- 28/40 验收：`CHANGELOG.md:65,82` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/CHANGELOG.md#L65
- 安装：`docs/install.md` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/docs/install.md
- 浏览器许可说明：`docs/cloakbrowser.md` — https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/docs/cloakbrowser.md

### OpenCLI
- 仓库：https://github.com/jackwener/OpenCLI
- npm 2.0.3：https://www.npmjs.com/package/@jackwener/opencli/v/2.0.3（Apache-2.0，Node ≥20.18.1，unpacked 9,118,144 B）
- 全部适配器：https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/index.md
- 小红书适配器：https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/xiaohongshu.md
- 抖音适配器：https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/douyin.md
- 微信适配器：https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/weixin.md
- 雪球适配器：https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/xueqiu.md

### 同类项目
- MediaCrawler：https://github.com/NanmiCoder/MediaCrawler ；许可证 https://github.com/NanmiCoder/MediaCrawler/blob/main/LICENSE（NON-COMMERCIAL LEARNING LICENSE 1.1）
- xiaohongshu-mcp：https://github.com/xpzouying/xiaohongshu-mcp （Apache-2.0；README 许可证段）
- twscrape：https://github.com/vladkens/twscrape ；PyPI 0.21.0（MIT）
- yt-dlp：https://github.com/yt-dlp/yt-dlp （Unlicense）
- RSSHub：https://github.com/DIYgod/RSSHub （AGPL-3.0）
- Jina Reader：https://github.com/jina-ai/reader （Apache-2.0）；限流/价格 https://jina.ai/reader#pricing
- Firecrawl：https://github.com/firecrawl/firecrawl （AGPL-3.0）
- Crawl4AI：https://github.com/unclecode/crawl4ai （Apache-2.0）
- browser-use：https://github.com/browser-use/browser-use （MIT）
- playwright-mcp：https://github.com/microsoft/playwright-mcp （Apache-2.0）
- Scrapling：https://github.com/D4Vinci/Scrapling （BSD-3-Clause）
- xhs：https://github.com/ReaJason/xhs （MIT；最后推送 2025-07-01）
- Douyin_TikTok_Download_API：https://github.com/Evil0ctal/Douyin_TikTok_Download_API （Apache-2.0）
- bilibili-cli：https://github.com/public-clis/bilibili-cli （Apache-2.0）
- CloakBrowser：https://github.com/CloakHQ/CloakBrowser （wrapper MIT；binary 独立许可）
- 无许可证/归档：https://github.com/cv-cat/Spider_XHS 、https://github.com/dataabc/weibo-crawler 、https://github.com/Nemo2011/bilibili-api

### TeamAgent 本地
- `schema.sql:8,13,20` — jobs / media_notes / index
- `src/worker.ts:1437` — `/api/runner/fetch/`
- `src/fetchjobs.ts:335,359,418-426` — claimFetch / reportFetch / routes
- `runner/fetcher.mjs:244,276` — fetch loop / login CLI
- `runner/browser-auth.mjs:12,32-43,75,158,199-214` — Cookie 白名单 / 持久 profile / 只导出 B 站
- `runner/native-x-browser.mjs` — X 原生窗口 + CDP + 私有 profile
- `runner/media.mjs:13,106,159` — 内存/临时空间/ASR 门禁
- `src/semantic.ts:419-460,462-506` — 单条推文读取 / Jina 网页读取
- `src/linkfail.ts:41` — 读取失败分类
- `src/auth-status.ts:3` — 认证状态只有 bili/x
- `docs/operations.md:34,55,83-90` — yt-dlp / 每日登录检查 / 浏览器 profile 与 Cookie 规则

---

## 8. 一页话交回

- **结论：** Agent-Reach 值得借，但不值得整机装。它是 14 个渠道的 Python 安装器，底层真正有用的是 OpenCLI；OpenCLI 覆盖 100+ 站点（含 Agent-Reach 没有的微博/知乎/抖音/微信），Apache-2.0、Node、9.1MB，更适合 TeamAgent。
- **可直接借：** 雪球 `xueqiu.py:291-330` 的腾讯行情/搜索；OpenCLI 的 `access=read` 命令表；Agent-Reach 的 600s 空闲浏览器生命周期和统一错误码。
- **实验：** `xueqiu quote 600519` 返回 `1435.26 (+1.77%)`；OpenCLI 2.0.3 的 `list` 返回 27 条小红书命令并带 `access`；未装浏览器、未登录平台。
- **优先级：** 雪球 → OpenCLI 只读骨架 → 小红书 → X → 微博 → 知乎 → 抖音 → 微信。
- **最大风险：** 账号封控/ToS、Cookie 泄漏、写命令误触、适配器随平台改版失效；用只读白名单 + 私有 profile + 低频 + 明确失败回复处置。
