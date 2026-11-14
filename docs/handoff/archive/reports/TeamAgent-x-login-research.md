只有单家检索，未经 DeepSeek 印证
检索日期：2026-11-12（悉尼）；仅公开资料调研，未读取 Cookie、钥匙串或浏览器数据库，未修改实现。
- **结论 1｜首选：普通 Edge 人工登录，再用内置 DevTools 查看指定站点 Cookie，经仅本机的敏感输入入口导入。**不需隐匿标志、扩展或数据库解密；这是本次研究建议，登录是否成功仍须实测。[Microsoft 官方 Cookie 工具](https://learn.microsoft.com/en-us/microsoft-edge/devtools/storage/cookies)、[twscrape 社区手动导入用法](https://github.com/vladkens/twscrape/blob/main/readme.md)（2026-11-12 核对）。
- **结论 2｜顶部警告有明确线索，X 报错没有确诊。**Chromium 将 `--disable-blink-features` 列入警告名单；建议移除伪装自动化状态的参数，不压制警告。Edge 实际触发标志尚未本机核验。[Chromium 上游源码](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/startup/bad_flags_prompt.cc#L138)（源码事实＋针对本项目的推断，2026-11-12）。
- **结论 3｜“Something went wrong”不能证明 X 识别出自动化。**X 官方列出网络/VPN、旧版本、站点数据和扩展等原因；普通 Firefox 登录也有同文案报告。[X 官方排查](https://help.x.com/en/using-x/x-issues)（2026-11-12 核对）、[WebCompat #225939](https://github.com/webcompat/web-bugs/issues/225939)（社区报告，2026-06-23）。
- **结论 4｜Chrome 136+ 的限制确凿：默认数据目录不接受调试 port/pipe，须指定不同的 user-data-dir。**仅更换默认目录下的 Profile 名字不够。[Chrome 官方公告](https://developer.chrome.com/blog/remote-debugging-port)（2025-03-17）、[Chromium 目录说明](https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/user_data_dir.md)（2026-11-12 核对）。
- **结论 5｜不能概括成“Edge 136+ 一律禁止默认目录调试”。**微软现行文档提供 Edge 原生调试端口，也提供 `edge://inspect` 手动允许本实例调试及 macOS 默认目录连接示例；没有查到 Edge 各版本与 Chrome 136 限制逐一对应的官方表。[Microsoft 官方 CDP](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)、[官方新文档](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)（后者文档日期 2026-06-10；均于 2026-11-12 核对）。
- **结论 6｜原生 Edge＋独立目录＋CDP 是受支持、免费的候选方案，但不是 X 登录修复或免检测保证。**Playwright 支持连接现有 Chromium 实例和按 URL 读取 Cookie，也明确提示 CDP 功能兼容性低于原生协议。[connectOverCDP，v1.9 起](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)、[cookies API](https://playwright.dev/docs/api/class-browsercontext#browser-context-cookies)（官方文档，2026-11-12）。
- **结论 7｜不推荐直接读取 Edge Cookie 数据库。**browser_cookie3 的 macOS 实现读取浏览器数据库并请求钥匙串解密材料，增加权限、依赖和格式兼容负担。[项目源码](https://github.com/borisbabic/browser_cookie3/blob/master/browser_cookie3/__init__.py)、[支持范围](https://github.com/borisbabic/browser_cookie3#readme)（源码事实＋选型判断，2026-11-12）。
- **结论 8｜“本人账号、本机保存”不等于后续抓取获得 X 许可。**浏览器支持的会话导出与平台允许的自动读取必须分别判断；不能承诺任意 Cookie 抓取符合平台条款。[X 当前条款](https://x.com/en/tos)（生效 2026-10-09，2026-11-12 核对）。

**(a) 自动化识别与错误定位**
- 【官方/标准事实】`navigator.webdriver` 是标准自动化信号，MDN 列举自动化、headless 等启动条件；并无公开证据证明本次 X 错误由该属性触发，也未找到 X 对登录检测信号、权重和阈值的官方完整说明。不能把 CDP 连接描述为“无法识别”。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)（页面更新 2024-11-05；2026-11-12 核对）。
- 【社区经验】EasyList #21807 报告普通 Firefox＋uBlock/EasyPrivacy 登录出现同文案，尚属报告者归因；WebCompat #225939 为 Firefox 失败、Edge 成功，已关闭但未给根因。它们只证明文案不专属于自动化。[EasyList #21807](https://github.com/easylist/easylist/issues/21807)（2025-05-12）、[WebCompat #225939](https://github.com/webcompat/web-bugs/issues/225939)（2026-06-23）。
- 【建议验证，未执行】先同网络普通 Edge 人工登录作基线，再比较干净独立目录的人工登录；若仍失败，逐项核对扩展拦截、浏览器版本、站点 Cookie 设置、请求状态与错误代码；仅记录脱敏错误元信息，不交付原始 HAR。若两者都失败，不把故障归咎 Playwright；若只受控启动失败，也须逐项比较，不能直接判定 X 风控。[X 官方排查](https://help.x.com/en/using-x/x-issues)、[支持近一年发布的 Edge 等浏览器](https://help.x.com/en/using-x/x-supported-browsers)（依据＋诊断推断，2026-11-12）。

**(b) 原生 Edge＋CDP 的成立条件与限制**
- 【官方事实】使用真实 Edge 可执行文件，由用户人工完成登录；独立、绝对路径的 `--user-data-dir` 和本机调试端口是最容易跨版本验证的方案。新目录有独立登录态，不能直接取得日常 Edge 的现有会话；同一目录不能由两个实例并用。[Microsoft CDP](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)、[Chromium 目录说明](https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/user_data_dir.md)（2026-11-12 核对）。
- 【官方事实】`RemoteDebuggingAllowed` 策略在 macOS Edge 93+ 可禁止 port/pipe；应检查实际 Edge 版本、`edge://policy`、目录和本机 `/json/version` 是否可用，不以启动进程成功推断 CDP 已启用。[Microsoft 策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/RemoteDebuggingAllowed)（更新 2026-09-28）、[CDP 发现接口](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)（2026-11-12 核对）。
- 【版本边界】微软 2026-06-10 文档的手动允许调试入口是另一条显式授权路径；没有给出其最早 Edge 版本，须在已装版本确认。社区有人报告默认目录端口失效、独立目录成功，但回复也承认没有 Edge 专属正式变更说明，且报告为 Windows，不能代替本机 macOS 验证。[微软现行说明](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)、[Microsoft Q&A](https://learn.microsoft.com/en-nz/answers/questions/5976829/microsoft-edge-remote-debugging-is-not-working-whe)（社区回复 2026-08-17；2026-11-12 核对）。
- 【实现判断】现有 Node＋Playwright 可用 `connectOverCDP` 附着，再取现有 context 的指定站点 Cookie；新建空 context 没有该人工登录态。CDP 端点只限回环地址、只用于独立目录、导入后关闭调试实例；URL 过滤只限制返回数据，不限制 CDP 本身对整个实例的权限。[Playwright API](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)、[Chrome 调试端口风险说明](https://developer.chrome.com/blog/remote-debugging-port)（2026-11-12 核对）。
- 【会话范围】twscrape 当前推荐包含 `auth_token`、`ct0` 的 Cookie 导入，但这是社区客户端约定，不是 X 承诺的稳定认证接口；不能保证两个名称覆盖所有功能。HttpOnly 会话不能完整靠页面 `document.cookie` 导出，DevTools、授权扩展 API 或浏览器 context API 才适用。[twscrape README](https://github.com/vladkens/twscrape/blob/main/readme.md)、[MDN HttpOnly](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#httponly)、[Playwright cookies](https://playwright.dev/docs/api/class-browsercontext#browser-context-cookies)（2026-11-12）。

**(c) 免费路线排序；稳定性与成本为本次研究判断，版本/维护数字为 2026-11-12 快照**
| 路线 | 维护/许可证与出处 | 稳定性、安全与用户操作 | 本项目契合度/迁移成本 |
| --- | --- | --- | --- |
| A 首选：人工登录＋内置 DevTools 导入 | [Edge 官方维护工具](https://learn.microsoft.com/en-us/microsoft-edge/devtools/storage/cookies)；浏览器自带 | 导出路径稳定；步骤稍多、存在误复制风险；不额外开放调试端口或信任扩展 | 最低改动；如无本机敏感输入入口，补该入口；仅本机受限文件保存、值不进日志/聊天/Worker |
| B：人工登录独立 Edge＋Playwright CDP | [官方 API，v1.9 起](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)；[Playwright Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) | 首次需要登录；后续可少复制；须管理目录、端口和版本；X 是否接受未实测 | 已有 Node/Playwright 可复用，改动中等；仅作为透明会话导入，不自动操纵登录挑战 |
| B 备选：Cookie-Editor 等扩展 | [GPL-3.0 仓库](https://github.com/Moustachauve/cookie-editor)、[GitHub 最新 release v1.13.0，2024-02-24](https://github.com/Moustachauve/cookie-editor/releases/tag/v1.13.0)；仓库最后 push 2026-11-10 | 用户操作少；增加 Cookie 权限和供应链信任；仅授予指定站点权限，不能宣称已独立审计 | 导出后本机导入，工程成本低、额外安装成本；不列首选 |
| C：直接 SQLite/钥匙串、browser_cookie3 等库 | [LGPL-3.0 仓库及源码](https://github.com/borisbabic/browser_cookie3)、[PyPI 0.20.1，2024-12-20](https://pypi.org/project/browser-cookie3/)；仓库最后 push 2024-12-20 | 不要求再次网页登录，但可能触发钥匙串授权；数据库锁、路径和加密变更会失败；会接触浏览器解密材料 | Python/原生依赖和维护负担较高，违反本项目“不碰钥匙串”的既定边界，不采用 |
| C：stealth 插件、改 webdriver、自动处理登录挑战的库 | [MDN 自动化标识](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)、[X 条款](https://x.com/en/tos)（2026-11-12） | 维护脆弱，偏离“不规避反自动化”的前提 | 不采用，不以清除警告为成功标准 |

补充依据：扩展读取 Cookie 需要 `cookies` 加对应 host 权限，能返回 HttpOnly 属性；这比页面脚本权限更大。[Chrome 扩展官方 API](https://developer.chrome.com/docs/extensions/reference/api/cookies)（2026-11-12）。以上仓库 star/下载趋势及未关闭严重 issue 未做全面审计，不能把最近 push 等同安全认证；GitHub release 与 PyPI 发布日期不同，未混用。
建议下一步：先让执行成员复现“同网络普通 Edge 人工登录”基线并报告失败请求的脱敏错误；成功后优先接人工导入，确认必要性后再验证独立目录 CDP。此方案排序为研究判断，依据上述官方支持路径，不是已验证的修复。
风险与未核实：Works on 为 Off，本次没有本机浏览器实测；Edge/Playwright 实装版本、策略、网络错误、X 账号状态及会话读取可用性均未核实；没有读取 Cookie，没有复现登录，也没有修改项目。若后续改造影响登录架构，建议审查员核对关键事实。

