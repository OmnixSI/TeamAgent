# x-login-real-edge 487fa6f 复核（父 0039e5f，PR #16 Draft）

结论：通过（P0 无、P1 无；4 条 P2）。
测试：`npm run check` 0；`npm test` 396/396；`npm run test:runner` 51 Python + 51 Node 全绿；`git diff --check` 通过。真实 Edge 157（headless、临时 profile）实测 CDP 仅监听 127.0.0.1:<本次随机端口>，`browser.close()` 后进程退出。P2 用 /tmp 临时脚本复现，未改 worktree。
1) 启动参数 通过：生产代码无 `no-sandbox` / `enable-automation` / `disable-blink-features`；Playwright 1.65 默认参数也不含。
2) 调试端口 通过：`nativeXArgs` 固定 `--remote-debugging-address=127.0.0.1`；实测仅 IPv4 127.0.0.1 监听。
3) Cookie 值 通过：X 只读 name/domain；B 站错误仅固定文案+数字；state 0600、profile 0700；未进日志/页面/快照。
4) 关闭 通过：成功、超时、abort、CDP 不可用路径均 close+kill；异常路径 finally 关闭；实测 `browser.close()` 结束 Edge。
5) 失败分类 P2：browser_missing / debug_unavailable / not_logged_in 三类失败均有固定文案、未写成成功；但页面首轮 missing 停轮询（P2-1）、waiting 渲成红色错误（P2-2）、stale auth_token 可报 ok（P2-3）。
6) B 站 CA 通过：`login_tls_context` 只传 `cafile`；实测 `verify_mode=CERT_REQUIRED`、`check_hostname=True`；无 `verify=False`/`CERT_NONE`；真实取码沿用交付员验证，未重复。
7) 子进程注入 通过：native 用数组 spawn、无 shell；owner Popen 为固定数组；端口整数校验，profile 非用户输入。
问题：
P2-1｜runner/owner.py:99-100 + runner/local_login_page.py:26：open 先删 state 再异步 spawn，页面首次 /status 可得到 missing 即 clearInterval；窗口已开却显示「未打开 X 登录窗口」且不再轮询（复现：1 次 status 后轮询清除），需再点一次；修法：owner 同步写 starting，或 missing 不终止轮询/加载时调用 xStatus。
P2-2｜runner/browser-auth.mjs:178 + runner/local_login_page.py:26：正常 waiting 也带 error=未检测到登录态，页面按 s.error 渲红；登录中即见错误，「等待登录」不可达；修法：waiting 不带 error 或页面按 phase 优先。
P2-3｜runner/native-x-browser.mjs:23-25 + runner/browser-auth.mjs:174：只看 auth_token 存在（含 twitter.com 旧域），页面仍在 /login 也判 ok；会话失效/旧 cookie 假报已登录，叠加 check 缓存 ok 后不纠正（复现：/login + cookie → ok）；修法：仅 x.com 且结合页面非 /login（不读值），或要求 ct0 并让 check 标 stale。
P2-4｜runner/local_bili_login.py:209,213、:277-280：secrets/bili-cookie.json 为 `[]`/`null` 等合法 JSON 非对象时 `_save` 抛 AttributeError，status 新 storage 捕获不含它；状态接口 500，登录无法完成（复现：`_save`/`status` 直接抛）；修法：old 非 dict 置空，或捕获 AttributeError。
备注：PR 上 Codex 的 2 条 P2（启动期收不到取消、X 缓存检查不重试上报）复核成立；X 测试均注入 launch，生产 `!options.launch` 的 catch/check 分支未被现有测试覆盖；CDP 对同机任意进程开放是 L2 残余风险；真实 X 账号登录/登录页未做（本 bot Works on Off），仍属真机项。
