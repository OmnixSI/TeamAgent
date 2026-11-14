# x-login-real-edge 4e87f4e 增量复核（487fa6f..4e87f4e）
结论：打回（P0 无；P1 有 1 条；P2 有 1 条）。
测试：`npm run check` 0；`npm test` 402/402；`npm run test:runner` 53 Python + 51 Node 全绿；`git diff --check` 0。P1 用 /tmp 临时脚本复现，未改 worktree。
1) P1 假报已登录：`/i/jf/onboarding/web?mode=login`（X 当前 Sign in 链接）+ `.x.com` auth_token → `login('x')` 返回 ok；`/login`、`/i/flow/login` 对照 waiting；五组合测试用旧 `/i/flow`，未覆盖当前入口。
2) 通过：missing 15 秒宽限、starting/waiting/ok 文案与停轮询；页面测试通过；owner 未写新 state。
3) 通过：waiting 不带 error；owner 仅 failed/debug_unavailable 附 error；页面 waiting 为 note；测试通过。
4) 通过：B 站 `[]`/`null`/字符串旧文件 `_save` 重置为空并 0600，`status` 全链路 ok，无 500。
5) 通过：diff 未改启动参数/回环绑定/CA（仅 X 判定、页面文案、B 站 guard）；未发现本轮新引入的失败误报；P1 属上轮假报的同类残留。
6) 通过：上述三条命令全绿；但五组合未覆盖 `/i/jf`、`/logout`、尾斜杠/编码路径。
问题：
P1｜runner/browser-auth.mjs:175：路径排除只有 `/login`、`/logout`、`/i/flow/*`；X 当前登录入口 `/i/jf/onboarding/web?mode=login`（从 https://x.com/ 的 Sign in 链接核对）不在名单，页面仍是登录页且 `.x.com` auth_token 存在时 `login('x')` 返回 ok（临时脚本复现）。后果：上轮 P1 假报在当前 X 路由上仍在；修法：至少排除 `/i/jf/onboarding/`（含 `web`），并补该 URL 的五组合；更稳的是复用 `xState` 的登录表单/账号切换器检查（需处理 risk）。
P2｜runner/browser-auth.mjs:175：纯 URL denylist 脆弱：`/i/flow`（HTTP 200 的 "Something went wrong"）与 `/%6Cogin` 构造下仍 ok；`/login/`、`/logout/` 线上 302，风险低；旧 `/home` 后台标签或 SPA 在 `/home` 弹登录层也可 ok（URL-only）。修法：`decodeURIComponent`+去尾斜杠，且优先当前活动页/本次打开的页，或改用页面状态检查；补 `/logout`、尾斜杠、编码、多标签用例。
备注：`npm test` 从 396 增至 402；新增 5 组合 + 2 页面测试均绿；`/i/jf` 是当前真实入口，测试用的是旧 `/i/flow`，这是本轮最需要修的缺口；真实 X 账号登录未做（本 bot Works on Off）。
