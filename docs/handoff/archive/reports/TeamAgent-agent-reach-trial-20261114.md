# Agent-Reach 隔离实测与 TeamAgent F8-N 接入建议

实测日期：2026-11-14，Australia/Sydney。结论基于本机真实请求、三个项目的源码深读和另外三个项目的官方源码核查；没有上线、发群消息或读取用户凭据文件。

**结论：值得接入为可选的本机读取后端，但当前不能把它当作已经打通四个平台的整体替换方案。** 本轮已装好临时 Python 包并完成 12 次联网读取：X 单条、雪球公开行情、GitHub、V2EX、YouTube 元信息和普通网页有可用内容；小红书站内读取、X 站内搜索/时间线、雪球社区及 B 站登录字幕仍未验证。发现两例“成功但内容是错误页”和两类风控误分类，必须先在适配层修正。

用户指出的方向合理：应把这类成熟工具列为候选，真实运行后选择模块，而不是持续为每个平台另造一套。此前的调研没有完成 Agent-Reach 的集成评估；本报告补上这一项，不把它表述为已经接入。

## 1. 版本、隔离和测量口径

| 对象 | 本次版本或固定提交 | 核查范围 |
|---|---|---|
| Agent-Reach | **1.6.1 / `c70ae6da5d39bc90e09ad2ae0575ccc89f31e284`** | clone、临时 venv 安装、真实 CLI 分发、JSON 契约、HTTP 后端、会话和进程管理源码 |
| OpenCLI | **2.0.3 / `9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8`** | clone；小红书/X/扩展及生命周期源码。未装入本机浏览器 |
| xiaohongshu-mcp | `bb6fa2e208719ee634fec37881be29d3aa4699b3` | clone；详情、评论边界、搜索、浏览器与 Cookie 文件实现。未构建启动 |
| TeamAgent | `release/V-C` / `e12ad40cb4829678fd3b27788ef56972e1d11293` | 仅读代码，与现有读取、登录、任务报告契约比较；未改动该工作副本 |
| 本机运行时 | macOS / Apple Silicon；Python 3.14.5；Node 26.0.0 | 每案独立子进程 |

版本出处：[Agent-Reach pyproject](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/pyproject.toml)、[OpenCLI package.json](https://github.com/jackwener/opencli/blob/9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8/package.json)。Agent-Reach 自身为 MIT；OpenCLI 与 xiaohongshu-mcp 为 Apache-2.0，复制源码时分别保留其许可和署名。

- 临时目录原为 `/private/tmp/agent-reach-trial-2R8Z2G`；安装使用 `python3 -m venv` 和 `pip install --no-cache-dir <clone路径>`，没有运行 `setup/add/update`，也没有修改全局工具或 Agent skills。
- 安装成功指 Python 主包及其声明依赖已装好，**不表示 OpenCLI、bili-cli 和专用浏览器全部装好**。当前固定依赖含 yt-dlp 2026.8.19；辅助测量装了 psutil。
- 在导入配置模块前，仅将包的 `paths.home_dir()` 指向临时隔离目录；不更改系统 HOME。浏览器启动与会话导入被实验门明确拒绝，避免自动安装内核、操作日常浏览器或读取 Cookie。联网表中的 HTTP/yt-dlp 路径没有被替换成模拟返回。
- 每案从启动新 Python 进程开始计时；每 50 ms 累加该进程及其递归子进程 RSS，记录观察到的峰值，单位 MiB。包括解释器启动；不含既存服务、测量器自身或远端 Jina/Exa 的资源。它是一次样本的观察峰值，可能漏过短于采样周期的尖峰，不是容量保证。
- 包内预算 25 秒，外层进程组上限 35 秒。本轮有效请求无外层强杀。没有下载视频、音频或做付费 ASR。GH_TOKEN、GITHUB_TOKEN、OPENAI_API_KEY、GROQ_API_KEY 环境变量均不存在；读取配置也隔离为空目录。
- 初次三案遇到 macOS `/tmp` 是符号链接，触发包的配置目录防护；修正为 `Path.resolve()` 后重跑。三次校准失败单独留在证据，未计入下表。B 站最初异常也产生了网络请求，不能把“12 次有效测量”误说成整个实验只有 12 个 HTTP 请求。

## 2. 各平台真实结果与资源

“可用”由返回正文人工核对，不能只看 `ok:true`。下表数值对应证据 JSON 中同名 case；每项仅一次有效测量，不提供平均值或 P95。

| 平台/动作 | case / 实际后端 | 耗时 s | 观察峰值 MiB | CLI 与内容判定 | 登录/Cookie 条件 |
|---|---|---:|---:|---|---|
| B 站视频信息 | bili_api / bilibili-api | 0.590 | 37.89 | **失败**：HTTP 412，包映射为 UPSTREAM_BROKEN；无视频信息 | 此路匿名；不能推断登录后仍失败 |
| B 站短链读视频 | bili_short / bilibili-api | 2.475 | 37.81 | **失败**：最终 HTTP 412；现有返回没有区分短链解析和后续 view 的失败阶段 | 同上；未测字幕 |
| 小红书公开笔记链接 | xhs_public / public-web→Jina | 6.398 | 37.77 | **伪成功**：ok=true，1,690 字符实际为 rednote 错误页，含 error_code=300031、页面不可用和扫码提示 | 无 Cookie；样本无 xsec_token，不能据此认定登录后笔记也不可读 |
| 小红书公开搜索 | xhs_search_public / public-web→Exa | 0.640 | 37.97 | **部分可用**：2 条、728 字符；一条是咖啡店铺，一条是旧笔记索引/加载壳。可找线索，不能声称站内搜索/最新笔记 | 匿名公开索引；站内需登录和浏览器 |
| X 公开推文链接 | x_thread_public / web→Jina | 3.475 | 37.73 | **可用但有边界**：4,740 字符，目标正文“11 years ago”、时间、被引推文片段和 3 条可见回复；被引正文在“For the”处截断 | 此次匿名可读；不是专用 thread 后端，不能保证全文/所有回复/最新动态 |
| X 公开索引搜索 | x_search_public / public-web→Exa | 0.963 | 37.72 | **失败**：无可用域内结果，UPSTREAM_BROKEN；不支持把 from: 查询当成站内筛选已生效 | 不能由此认定账号需要重新登录 |
| 雪球公开股票行情 | xq_quote / **tencent** | 0.642 | 37.53 | **可用**：贵州茅台结构化行情；返回链接指向雪球，实际请求腾讯 qt.gtimg.cn | 无 Cookie；不是雪球社区读取，也未独立核对报价新鲜度 |
| 雪球股票网页链接 | xq_url_router / web→Jina | 13.972 | 37.45 | **伪成功**：ok=true，488 字符实际为“访问触发保护，请完成人机验证” | 这是远端公开读取收到的挑战页，不证明用户本机账号被封控 |
| V2EX 热门 | v2ex / v2ex-api | 0.261 | 37.84 | **可用**：2 条主题标题、正文和链接，合计正文 126 字符 | 匿名；未测全部评论 |
| GitHub 仓库 | github / github-api | 0.835 | 37.70 | **可用**：Agent-Reach 元数据及 README，正文 9,417 字符 | 本轮公开 API，无令牌；私有仓库继续用 TeamAgent 已有权限 |
| YouTube 视频信息 | youtube / yt-dlp | 17.500 | 76.06 | **可用**：Me at the zoo，标题、作者/日期、描述 264 字符 | 无 Cookie；只抓元信息，未测字幕、视频理解或下载 |
| 普通网页 | web / Jina | 0.459 | 37.53 | **可用**：example.com 的 Example Domain 正文 156 字符 | 无 Cookie |

样本：[B 站历史证据中的 BV1irWP6PExT](https://www.bilibili.com/video/BV1irWP6PExT)、[同一历史短链](https://b23.tv/UIm520q)、[X 样本](https://x.com/elonmusk/status/2120761225529168312)、[小红书样本](https://www.xiaohongshu.com/explore/67a55a9f0000000029008500)、[雪球股票页](https://xueqiu.com/S/SH600519)、[YouTube 样本](https://www.youtube.com/watch?v=jNQXAC9IVRw)。BV/短链复用既有调研证据，没有要求群友重发。小红书笔记 ID 来自公开材料，缺少有效签名链接是本轮样本限制；公开搜索另取得真实笔记线索，但未证明其可完整读取。

原始字段、返回正文和尝试链保存在同目录 `TeamAgent-agent-reach-trial-20261114-evidence.json`，用于复核以上判断。

### 浏览器后端与其他渠道的状态

小红书 `read --backend opencli`、X `thread --backend opencli`、雪球 `hot_posts --backend xueqiu-api` 均运行到实验门，返回带 **TRIAL_GATE** 的 NEED_SETUP。这是实验主动禁止浏览器启动/会话复制的结果，**不是平台真实失败，更不是 NEED_LOGIN 的证据**。0.128–0.195 秒、约 30–35 MiB 只是到门前的 Python 开销，不能拿来当浏览器任务耗时/内存，因此未并入上表。

LinkedIn、Reddit、Boss、Instagram、Facebook、小宇宙没有做真实读取；仅确认 1.6.1 渠道目录中有相应实现。它们不属于本次四个重点平台，报告不把支持列表当实测通过。小宇宙/语音转写需要另外配置服务；本轮未请求密钥、未调用。依据：[渠道目录](https://github.com/Panniantong/Agent-Reach/tree/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels)。

## 3. 登录复用：能走通的机制与本机缺口

**机制上可以复用已连接的 Chromium 浏览器的站点 Cookie；本轮不能保证 Edge 已登录会话已能直接复用。** Agent-Reach 不会仅因为电脑装了 Edge 就自动读到它的登录态。

| 核查项 | 本轮证据 | 结论 |
|---|---|---|
| Edge、Chrome 可执行应用 | 两个应用均存在 | 只证明安装，不证明某站已登录 |
| 本机既有 OpenCLI | 只读包元数据为 **1.7.22** | 低于 Reach 声明 floor **1.8.7**；本次不升级或覆盖 |
| 既有本地 Bridge | 只读 status 没有发现运行实例，已连接来源数为 0 | 当前不能证明可导入 Edge；不表示 Edge 没登录，也不改写成“永远不支持” |
| 用户 Cookie/凭据文件 | 未读取、未复制、未输出 | 实际账号身份、有效期和读取权限保持未验证 |
| 浏览器内存 | 未启动新的浏览器 | **N/A**；不可用 HTTP 后端的 38 MiB 估算浏览器预算 |

代码链路：`session_reuse._source_cookies()` 从 `profiles()` 取得已连接的非专用来源，按站点域过滤，通过 `export_site_cookies()` 的 Page Cookie API 传递；多个有效来源报 NEED_SETUP，不随机选账号。`prepare()` 复制一次到 Reach 专用浏览器并记录来源；只复制 Cookie，不复制整个 Edge/Chrome 配置目录，也不读取密码库。复制后还要以真实读取确认有效，不以 Cookie 数量代替登录成功。来源：[session_reuse.py:54](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/session_reuse.py#L54)、[opencli.py:120](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/backends/opencli.py#L120)、[会话说明](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/skill/references/sessions.md)。

Edge 使用 Chromium 扩展协议，存在复用的工程路径；但 Agent-Reach `_system_chrome()` 的 macOS 回退仅查系统 Chrome，不查 Edge。Edge 更适合作为**连接扩展的来源**，不能直接把它等同于 Reach 的目标浏览器。官方文档主要写 Chrome，Edge 扩展安装/连接/站点 Cookie 复制未实测，结论为**条件可行、待验收**。来源：[browser.py:299](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/browser.py#L299)、[OpenCLI 扩展 manifest](https://github.com/jackwener/opencli/blob/9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8/extension/manifest.json)。

平台差异：

- **B 站**：`reuse_browser_session()` 取得指定站点的 SESSDATA 等字段后，通过子进程 stdin 交给 bili-cli 官方 credential writer；不把 Cookie 放命令行。字幕动作调用该步骤。未导入则不能推断能读字幕。Reach 代码还提示 bili-cli ≤0.6.2 曾有扫码登录保存空凭据的问题；它测试固定的工具版本仍为 0.6.2，所以复用已有登录比承诺“扫一次必好”稳妥。来源：[bilibili.py:85](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/bilibili.py#L85)、[tools.py](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/tools.py)。
- **X**：当前使用 OpenCLI 的登录浏览器动作，不是旧版 bird/twitter-cli。读单条公开链接可先保留匿名后端；搜索、用户时间线、结构化 thread 再走登录浏览器，并标注已加载范围。源码不构成当前账号可用性保证。来源：[twitter.py](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/twitter.py)。
- **小红书**：站内搜索和详情通过 OpenCLI；详情需要搜索结果保留的完整 xsec_token URL，不能从裸 ID 随意重建。登录之后仍可能遇到链接签名/地区/风控问题，未验证本轮裸链接是否已删。来源：[OpenCLI buildNoteUrl](https://github.com/jackwener/opencli/blob/9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8/clis/xiaohongshu/note-helpers.js)、[Reach read](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/xiaohongshu.py#L79)。
- **雪球**：公开行情可走腾讯；社区动作先复用浏览器，`_import_from_browser()` 再把含 xq_a_token 的站点 Cookie 写入本机 Reach 配置供原生请求使用。它不是“全程只保存在浏览器”；需要限制配置文件权限且禁止进入云端日志。会话文档称可能数小时过期，未在本轮测量有效期。来源：[xueqiu.py:159](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/channels/xueqiu.py#L159)。

**需要你在本机做的一步（实施阶段，当前不用做）：** 工程师准备好兼容扩展、指定来源和可见登录窗口后，如果站点复用验证仍失败，你只需在该官方页面完成登录或验证码。不要导出 Cookie 发到聊天。本报告没有认定用户当前需要重新登录；配置升级/连接检查应先由工程师完成。

## 4. 必须修正的返回契约与运行边界

| 问题 | 本轮证据/具体位置 | F8-N 修法 |
|---|---|---|
| 页面错误壳被当正文 | 小红书 public-web ok=true 但包含 300031 和 unavailable；雪球 web ok=true 但内容为人机验证。`public_web._readable()` 的墙检查过窄，web 直读也不统一经过这项检查 | 平台特定的正文结构与错误页检测；小红书必须有关联笔记作者/内容或明确的正文证据；雪球挑战页输出 platform_blocked。只靠字符长度不足 |
| HTTP 412 被分到普通上游故障 | 实测 B 站返回 UPSTREAM_BROKEN；离线调用 `classify(HTTPError(...412...))` 复现 | 转成 platform_blocked/risk，熔断，不再自动回退另一身份/重复请求 |
| OpenCLI SECURITY_BLOCK 未明确映射 | 离线以真实 note 错误形状调用 `_opencli_error()`，返回 UPSTREAM_BROKEN；识别集合只覆盖 ACCOUNT_RISK/CAPTCHA_REQUIRED 等 | 明确接住 SECURITY_BLOCK；保留 stage 和 vendor_code，停止后续后端；不要靠英文消息猜全部错误 |
| 通用 URL 路由覆盖不到专用动作 | `_cmd_read()` 只选有 read 动作的渠道；X 只有 thread，雪球只有 quote/search/hot_posts/hot_stocks，因此普通 read 两者落到 web | TeamAgent 先根据 URL 解析成白名单 channel/action，再执行；雪球任意社区帖子没有 Reach 专用 read，不可承诺原生支持 |
| 安装/首用可能启动浏览器和下载组件 | `browser_binding.environment()`→`session_reuse.prepare()`→`browser.ensure_running()` | 生产查询不能隐式 setup/add/update；独立安装阶段锁版本、登记所持进程和资源，查询仅检查能力 |
| 25 秒 CLI 预算不等于硬截止 | `_call_with_deadline` 对进程内 HTTP 用 daemon thread；时钟可在准备期间暂停；子后端只收到预算 | 外层进程组硬截止、输出字节上限、心跳/取消，终止后清理所持子进程；不能只包一层 Promise.race |
| 公共读取是第三方路线 | public-web 实际走 Jina/Exa，本轮能看到缓存、截断和地区跳转 | 默认仅处理公开链接；登录正文留在本机受控后端，不把 Cookie 或私密页面转交公共读取服务 |

源码依据：[result.classify](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/result.py#L64)、[OpenCLI 错误映射](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/backends/opencli.py#L16)、[public_web._readable](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/public_web.py#L27)、[CLI 路由](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/cli.py#L171)、[dispatch 截止处理](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/dispatch.py#L154)。离线复现结果见证据 error_mapping。

上游已有同站点并发 2、浏览器总并发 4、排队最多 120 秒、浏览器搜索间隔 10 秒、RATE_LIMITED 持久暂停 3,600 秒；这些是源码默认值，**不是本轮压测得到的安全阈值**。建议 TeamAgent 首版限制为浏览器全局 1、每站点 1；普通 API 全局 2；浏览器不排长队，交给已有任务队列。来源：[browser_binding.py](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/browser_binding.py)、[dispatch.py](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/dispatch.py)。

Reach 默认闲置 **600 秒**关闭专用浏览器，期间可能常驻；这与“本机不当服务器、低占用”存在取舍。F8-N 应按批次按需启动、结束显式关闭自己拥有的浏览器和 Bridge，不能杀用户既有进程，也不能因闲置等待十分钟才清理。需要后续真实测量浏览器启动耗时、峰值和退出残留；本轮不能给出这些数字。来源：[browser_watcher.py](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/browser_watcher.py)、[bridge.close](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/bridge.py#L90)。

## 5. 接入方案：作为本机读取工具，与 V-C 分工

### 推荐调用接口

新增 `runner/reach-reader.py` 与 `runner/reach-adapter.mjs`，使用 **一次请求、一次短生命周期子进程、一次 JSON 返回**，不新开常驻 HTTP 服务。Python 主包固定到已审提交；把独立目录路径做成适配器受控参数，避免直接套用上游全局 setup。可以用 Python `run_action()` 形成相同 JSON envelope，或使用 CLI argv，但都由 runner 传入白名单动作。

```json
{
  "id": "job-id", "lease": "current-lease", "version": 1,
  "channel": "xiaohongshu", "action": "read",
  "target": "https://www.xiaohongshu.com/explore/<id>?xsec_token=<opaque>",
  "backend": "opencli", "deadline_ms": 45000
}
```

以上为拟定契约，`<id>`/`<opaque>` 是占位，不是真实凭据。xsec_token 只为本次打开链接使用，不进入对话、诊断日志或通用查询缓存键。禁止用户提供任意命令/本地路径/浏览器参数；不把网页内容当成动作指令。

输出保留 `schema_version/ok/channel/action/backend/items/meta/error`，补 `source_url/fetched_at/content_scope/completeness_verified` 与后端尝试链。仅把筛选后的标题、正文、作者、媒体描述、范围标记交给云端；**不转发 raw Cookie、浏览器状态、全部上游 raw 字段或本机异常栈**。公开搜索只标 search_results，单条正文标 post_text，已加载评论标 loaded_comments，拒绝一律标 full_content。来源：[统一 envelope](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/result.py#L116)。

### 与现有链路的关系

| 现有 V-C 能力 | F8-N 决策 | 理由 |
|---|---|---|
| runner/fetcher.mjs：BV/av/短链/分P、WBI、字幕、风险冷却、租约报告 | **保留为 B 站主路径** | Reach read 只是视频信息；没有承接现有所有分P/队列/ASR契约，本轮其匿名 fallback 还遇到 412 |
| runner/browser-auth.mjs、native-x-browser.mjs：本机登录/状态 | 保留统一登录入口与状态模型；新增 Reach 会话适配 | V-C 偏向 Edge、站点独立 profile；Reach 偏向共享专用 profile，不能直接共用锁住的 profile 目录 |
| src/semantic.ts：readTweet 的 fx→syndication→oembed | **保留公开单条快速路径** | 有结构化推文证据与较短截止；Reach/Jina 本轮更慢且被引正文截断。新增登录 thread/搜索/时间线作为异步补充 |
| src/semantic.ts：通用 readUrl 的 GitHub/Jina/DeepSeek | 保留；共用更严格的正文校验 | Agent-Reach web 也主要组合 Jina/Exa，搬一套并不天然新增可达性 |
| 现有 Worker/D1/Queues 和 fetch job 租约 | 复用工作模式，扩展 source/action 及结果 schema | 长浏览器读取不占聊天消费者；旧租约结果不能覆盖新任务 |
| B 站音频/本机 X-ASR | 保留 | Reach 不是本轮已验证的音视频理解替代；不新增视频下载和付费 Whisper 路线 |
| 小红书、雪球社区等缺口 | 新增按需可选浏览器后端 | 这是 Reach/OpenCLI 的主要增量，需完成真实登录后验收 |

本机核查路径：`/Users/yanghongming/Projects/.worktrees/TeamAgent-V-C-release/runner/fetcher.mjs` 的 `createFetchClient/biliLight/runJob/classify/runFetchLoop`，以及 `src/semantic.ts` 的 `readTweet/readUrl/jinaOk`。固定版本依据：[fetcher](https://github.com/OmnixSI/TeamAgent/blob/e12ad40cb4829678fd3b27788ef56972e1d11293/runner/fetcher.mjs)、[semantic](https://github.com/OmnixSI/TeamAgent/blob/e12ad40cb4829678fd3b27788ef56972e1d11293/src/semantic.ts)、[browser-auth](https://github.com/OmnixSI/TeamAgent/blob/e12ad40cb4829678fd3b27788ef56972e1d11293/runner/browser-auth.mjs)。这是私有仓库链接，需已有仓库权限；本轮没有请求线上凭据。

### error_kind 映射（拟定）

| Reach / 检测结果 | 新工具 error_kind | 对接现有 fetch reason | 行为 |
|---|---|---|---|
| NEED_SETUP | tool_not_ready | 新类型，不塞进 invalid | 提示缺少组件或版本；查询不自装 |
| NEED_LOGIN | login_required | login_required | 先核实指定来源；仅登录动作请求本人介入 |
| PLATFORM_BLOCKED / HTTP 412 / SECURITY_BLOCK / 明确验证码页 | platform_blocked | risk | 同站点停止，尊重上游恢复条件；无条件切后端/换账号不得发生 |
| RATE_LIMITED | rate_limited | risk + retryAfter | 持久保存 retry_after，区别平台与 Exa/Jina 提供方限流 |
| TIMEOUT / 外层硬截止 | timeout | timeout | 撤销本次任务并回收所持进程 |
| NOT_FOUND 且有平台确证 | not_found | not_found | 停止；模糊空列表不能直接称删除 |
| BAD_INPUT / 缺失签名 URL | unsupported | unsupported | 清晰提示缺失链接材料，不引导重新登录 |
| UPSTREAM_BROKEN | upstream_unavailable | 新类型 | 保留阶段码；只有非风控瞬态错误可用预定公开回退 |
| ok=true 但结构不足/错误壳 | insufficient_content | 新类型 | 不作为正文交给模型；必要时只保留搜索线索 |
| BUSY | busy | 新类型 | 回到队列，遵守原始 deadline，不同步等待 120 秒 |

不能把新种类悄悄塞进 V-C 原有 `invalid` 并丢掉原因；新增工具可以单独使用 error_kind，同时兼容 B 站旧 reason。

## 6. 可直接借用的代码及改动

| 来源/文件/函数 | 借用内容 | 必须改的部分 |
|---|---|---|
| Agent-Reach `runtime/result.py`：`envelope/make_item` | 统一结果与来源字段，便于多平台工具返回 | 扩展内容范围/完整性；只放白名单 raw 字段；错误脱敏放在 runner 边界 |
| Agent-Reach `runtime/dispatch.py`：`validate_action/run_action/cooldown` | 参数验证、尝试链、持久冷却 | 修 412/SECURITY_BLOCK；保留外层硬截止；查询不能进行隐式安装/等待人工登录 |
| Agent-Reach `runtime/run.py`：`run_cmd` | argv 调用、超时终止进程组 | 补 stdout/stderr 流式总量上限、取消联动、沙箱环境；不要把任意上游异常回传云端 |
| Agent-Reach `runtime/session_reuse.py`：`_cookies/_source_cookies/prepare` | 站点范围过滤、多来源歧义处理 | 将来源选择绑定 TeamAgent 已确认账号；增加兼容 Edge 的真实检查；不直接碰 Cookie 数据库 |
| Agent-Reach `channels/xueqiu.py`：`_tencent_code/_tencent_quote/_parse_hot_posts` | 股票符号统一、公开行情结构化、热帖解析 | 显式标注腾讯来源和报价时间；社区会话另验收；不要称任意帖子链接已支持 |
| OpenCLI `clis/xiaohongshu/note.js`：`NOTE_EXTRACT_JS`，`note-helpers.js`：`buildNoteUrl` | 小红书正文/作者/互动条的正确 DOM 作用域；保留签名 URL | 若迁入现有浏览器层需改 page 抽象；不搬自动风控重试默认值；正文与评论范围区分 |
| OpenCLI `clis/twitter/thread.js`：`extractTweet/parseTweetDetail` | 提取长推 note_tweet、引用推文、媒体和分页结构 | Query ID/字段会漂移；只读输出、本机维护，不能把当前 ID 当稳定 API |
| xiaohongshu-mcp `xiaohongshu/feed_detail.go`：`GetFeedDetailWithConfig/CommentLoadConfig.normalize` | 详情上下文和评论数量边界，防止零值变无上限 | 10 分钟页面超时、最多 500 轮不是本项目聊天读取预算；Go/Rod 需改成现有浏览器抽象或独立短调用 |

上表前三个项目均已 clone 到具体函数核查。对应来源：[Reach runtime](https://github.com/Panniantong/Agent-Reach/tree/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime)、[OpenCLI 小红书详情](https://github.com/jackwener/opencli/blob/9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8/clis/xiaohongshu/note.js)、[OpenCLI X thread](https://github.com/jackwener/opencli/blob/9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8/clis/twitter/thread.js)、[小红书 MCP 详情实现](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/xiaohongshu/feed_detail.go)。

## 7. 同类项目：后续参考顺序

本表区分源码/文档核查和运行结果，不把“多列几个仓库”当成它们已能在本机使用。

| 项目 | 本轮核查深度 | 可借鉴点 | 本项目选择 |
|---|---|---|---|
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach) | 已安装运行、深读 | 多后端契约、会话复制、冷却 | 做受控适配器候选；不整套替换 |
| [OpenCLI](https://github.com/jackwener/opencli) | clone 深读 | 复用已有 Chromium 登录、平台只读命令、页面租约 | 若主要缺小红书/X，可直接借平台模块，减少 Reach 额外浏览器层；尚未运行此方案 |
| [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | clone 深读 | Go/Rod 搜索、详情、评论上限 | 小红书第二路线；可取解析和边界思路，尚未实跑；当前实现要求自带内核，不是 Edge profile 直接替代 |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 官方 core.py 源码核查，未安装 | 多国内平台 Playwright、登录/客户端/存储分层、CDP 模式 | 用作协议和错误模型对照；偏采集流水线。源码声明非商业学习许可，不能按 MIT 随意搬到商业项目 |
| [bilibili-cli](https://github.com/public-clis/bilibili-cli) | 官方 auth.py 源码核查，未安装运行 | Credential、可选匿名模式、登录验证三态 | Reach 的上游依赖；不能因外层不读密码库就忽略上游可能扫描浏览器 Cookie 的行为；只允许受控会话 |
| [Twikit](https://github.com/d60/twikit) | 官方 Client 源码核查，未安装 | X AsyncClient、GraphQL 解析、明确 HTTP 错误类 | 无浏览器查询候选；需要受控 Cookie/交易头维护，账号实效和风险未测，不作为默认替换 |

后面三项的具体依据：[MediaCrawler XiaoHongShuCrawler.start](https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/xhs/core.py)、[bili-cli get_credential](https://github.com/public-clis/bilibili-cli/blob/main/bili_cli/auth.py)、[Twikit Client.request](https://github.com/d60/twikit/blob/main/twikit/client/client.py)。它们本轮未固定 SHA，因此只支持当前所见源码行为，不提供跨版本运行保证。

## 8. F8-N 最小施工包

建议同一版本集成一次验收，**N1/N2/N3 可按文件边界并行，N4 统一集成；本报告没有派活或开始实现。**

| 包 | 交付文件/范围 | done_when |
|---|---|---|
| **F8-N1：只读进程适配** | runner/reach-reader.py、reach-adapter.mjs、固定版本安装清单 | argv/输入/平台白名单；受控数据目录；不运行全局 setup；输出上限、45 秒硬截止、取消、进程回收；CLI 安装成功与渠道 ready 分开 |
| **F8-N2：平台质量与错误契约** | reader-result.mjs 或等效模块、错误映射、平台正文校验 | 以本轮小红书 300031 壳、雪球挑战页、412、SECURITY_BLOCK 实际返回回放：均不能成功入库；检索摘要与正文范围明确；未知上游结果不猜未登录 |
| **F8-N3：登录与按需生命周期** | 现有 browser-auth 接口的来源适配、兼容组件安装、受控关闭 | 先处理既有 OpenCLI 1.7.22 的版本冲突，不静默覆盖；Edge 来源连接后只回传能力布尔值；用户只在官方页面登录；同站1/全局1；不用时退出自己持有的进程；测浏览器冷启动/峰值/退出残留 |
| **F8-N4：队列/工具接线与真实验收** | Worker 工具与 fetch job schema、来源说明、场景文件、回滚开关 | 不阻塞群聊；lease/CAS/heartbeat 保持；公开单条/B站主路不退化；四重点平台分别记录真实正文、来源、耗时、峰值；无发送动作的真实群链回放；测试员改 passes，审查员检查 P0/P1 |

N4 的最低真实场景：①历史 BV 分P/字幕结果与 V-C 一致，不能只比标题；②X 单条和登录后 thread/用户动态分别验收；③小红书从真实搜索结果取得完整签名链接，正文作者一致、评论只称已加载；④雪球行情标腾讯来源、社区正文不混入挑战页；⑤登录失效与挑战分开；⑥重启、取消、超时后无试验浏览器残留；⑦禁用 Reach 时已有读取功能仍可用。

**首轮发布门槛：N1/N2 完成后只开放本轮已证实的公开读取；小红书/X/雪球登录渠道必须等 N3+N4 的真实场景通过再宣称可用。** 此处是发布建议，不是已执行发布。

## 9. 可复现实验与交付文件

安装过程（目录名为示意，实际执行证据已记录）：

```sh
git clone --depth 1 https://github.com/Panniantong/Agent-Reach.git <临时目录>/src
python3 -m venv <临时目录>/venv
<临时目录>/venv/bin/python -m pip install --no-cache-dir <临时目录>/src
<临时目录>/venv/bin/python -m pip install --no-cache-dir psutil
<临时目录>/venv/bin/python <实验目录>/measure.py bili_api bili_short xq_quote
<临时目录>/venv/bin/python <实验目录>/measure.py xhs_public x_thread_public xq_url_router
<临时目录>/venv/bin/python <实验目录>/measure.py v2ex github youtube
<临时目录>/venv/bin/python <实验目录>/measure.py xhs_search_public x_search_public web
```

重放请按固定 SHA 安装，不能将上述 depth-1 最新分支命令当成版本锁。保存的 probe/measure 脚本对路径做了可迁移处理；measure 自动用临时目录隔离，退出清理，结果写在脚本同目录的 replay.jsonl。重复联网会受站点状态、缓存和风控影响，应先看既有证据；不应为提高成功率反复请求。

交付均在 `/Users/yanghongming/Projects/`：

- `TeamAgent-agent-reach-trial-20261114.md`：本报告。
- `TeamAgent-agent-reach-trial-20261114-evidence.json`：19 个有效测量/能力/离线记录，另存 3 个剔除校准案；其中仅 12 个为联网测量案例，非 19 个平台成功。
- `TeamAgent-agent-reach-trial-20261114-probe.py` 和 `TeamAgent-agent-reach-trial-20261114-measure.py`：受控重放脚本，无用户 Cookie 或密钥。
- `TeamAgent-agent-reach-trial-20261114-replay.jsonl`：可迁移脚本的 version/error_mapping 两项离线重放已通过；未为了脚本验证重复联网。

已核对无实验 Python 进程存活，并删除本次约 270 MiB 的临时 clone、venv、下载资源和实验状态；确认临时目录不存在。未启动浏览器/Bridge，因此没有本次新增浏览器进程需要停止。本机原有 Edge/Chrome/OpenCLI 和用户资料未改动。

未验证的关键部分：Edge 登录态实际复制、账号身份确认、登录后小红书/X/雪球读取、B 站字幕、浏览器峰值/冷启动/封控频率、长时间可靠性。没有这些证据，不能承诺“用户本机登录后所有平台已可读”。
