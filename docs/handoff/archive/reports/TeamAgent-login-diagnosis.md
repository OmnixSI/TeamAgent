1. 只读诊断，2026-11-12 16:57 AEDT；`agent/login-fix` / `/Users/yanghongming/Projects/.worktrees/TeamAgent-login-fix`，基线 `0039e5f0faa891dd1c00243dcb5e1dde51946531`，工作树干净，尚无修复提交。
2. B 站已复现根因：owner 使用 `/usr/local/bin/python3`（Python 3.12.3 / OpenSSL 3.0.13），默认 CA 文件缺失，TLS 握手失败，尚未收到 B 站 HTTP 响应；不是本次风控暂停导致。
3. 证据：launchd owner PID `27865`；默认 CA 指向不存在的 `/Library/Frameworks/Python.framework/Versions/3.12/etc/openssl/cert.pem`；以安装版相同 `User-Agent: curl/8.7.1`、Referer、Accept 执行 `_http(GENERATE)`，报 `SSLCertVerificationError`，`verify_code=20`，`unable to get local issuer certificate`。
4. 对照：同一 owner 解释器、同一请求仅指定现有 `/etc/ssl/cert.pem`，返回 HTTP 200、`code=0`、`message=OK`，取得有效二维码响应；系统 Python 3.9.6 / LibreSSL 2.8.3 默认验证也成功。未关闭 TLS 校验，未输出二维码链接、key 或 Cookie。
5. 风控文件 `~/.inkboard-team/state/bili-risk.json` 不存在；owner 的 `owner.log` 和 `owner-error.log` 均为 0 字节，fetch 日志无证书/412/429/Traceback 标记。owner 3.12 的代理配置为空，passport DNS 可解析；没有本次 412/风控文件损坏的证据。
6. 安装版 `local_bili_login.py:106` 使用未指定 CA 的 `ssl.create_default_context()`；`owner.py:139` 把异常统一吞成 HTTP 502 /“B 站二维码获取失败，请稍后重试”，且关闭请求日志，故历史失败未保留异常行。认证状态上报的 `local_bili_login.py:177` 也有相同 CA 风险。
7. 桌面实际脚本调用 Python 3.14 的 `owner_unlock.py`，后者用 Edge 打开 `http://127.0.0.1:3391/login#unlock=[已隐藏]`；这只负责解锁，不决定 owner 的解释器。GET `/login` 为 200，正文与安装版 PAGE 完全相同；并非仍打开旧云端等待领取页。
8. X：Edge 版本 `157.0.4341.46`；仓库与安装版 `browser-auth.mjs` 字节一致（SHA256 前缀 `e05c65e6a7fa`）；独立 profile 为 `/Users/yanghongming/.inkboard-team/browser/x`，权限 `0700`，未读取其中 Cookie 或账号文件。
9. 安装版显式启动配置完整为 `launchPersistentContext(profile,{channel:'msedge',headless:false,acceptDownloads:false,serviceWorkers:'block',timeout:20000,chromiumSandbox:true,ignoreDefaultArgs:['--enable-automation'],args:['--disable-blink-features=AutomationControlled']})`；SDK 另附默认开关及 `--remote-debugging-pipe`，没有使用普通 Edge 启动方式。
10. 截图警告与上述 `--disable-blink-features=AutomationControlled` 完全对应；安装版已设 sandbox=true 并过滤 enable-automation，不能把这张图说成仍带 no-sandbox。采样时只发现 Edge 主进程 PID `72039`，完整命令为 `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`，没有附加参数；未发现独立 profile 的登录进程，历史登录进程完整 argv 无法回溯，以上配置不冒充进程实录。
11. “Something went wrong”尚不能证明由自动化检测造成：本机 x.com DNS 正常，使用系统 CA 的无账号 GET `/login` 为 HTTP 200，初始 HTML 没有该报错；安装版还有域名白名单、全 WebSocket 阻断等差异，站点 JS/挑战、地区、账号风控、旧 profile 状态均未排除。未清 Cookie、未测试真实账号、未打开新浏览器。
12. 推荐 B 站修法：仅让扫码请求与状态上报显式使用已验证的系统 CA（与 owner 现有代理路径一致），不关闭证书校验、不修改全局系统设置；以固定中文分类显示证书错误、HTTP 状态、允许的业务码及风控截止时间，并对损坏/非对象/非有限时间的风控文件保守拒绝、给出明确说明，避免笼统 502。
13. 推荐 X 修法：直接启动真实 Edge（缺失再 Chrome）并附加独立 0700 profile、仅绑定 127.0.0.1 的远程调试端口；不附加 no-sandbox、enable-automation、disable-blink-features 等开关，再用本机 CDP 检查登录状态，凭据不离开本机。不承诺移除这些开关一定解决站点报错，需随后真机验证。
14. 本轮仅检查源码/安装文件/launchd/公开响应并写本报告；未改修复代码、未安装依赖、未重启服务、未部署、未提交或推送；未用已解锁网页重新发起登录，未运行修复全套测试。本 bot Works on Off，无法实机点击或截图。按用户新增要求，等待 BINI 确认修法后再改。
