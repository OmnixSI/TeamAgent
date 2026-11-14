# x-login-real-edge 3f4272d 增量复核（4e87f4e..3f4272d）
结论：打回（P0 无；P1 有 1 条；P2 有 2 条）。
测试：`npm run check` 0；`npm test` 415/415；`npm run test:runner` 53 Python + 51 Node 全绿；`git diff --check` 0。P1 用 /tmp 临时脚本复现；P2 为代码路径/推断；未改 worktree。
1) 通过：`/i/jf/onboarding/web?mode=login`、`/i/flow`、`/%6Cogin`、`/login/`、`/logout/`、`/home` 登录层、后台旧 `/home`+活动登录页均 waiting；13 项新测试覆盖；独立脚本 oldPage locator 0 次。
2) P1：真正 `/home` + marker + 无表单 + `.x.com` token → ok；marker 缺失 → waiting；但登录表单 selector miss 时仍会 false ok（见 P1）。
3) 通过：Cookie getter 未读；`xAuthTokenPresent` 仍只 x.com/.x.com name/domain；启动参数/回环/CA diff 未改。
4) 通过：上述命令全绿；`npm test` 402→415，新增 13 项。
问题：
P1｜runner/browser-auth.mjs:93-95：`xState` 先查登录表单，但 selector 不匹配（返回 false，不是抛错）时，`/home` 上的旧 account marker 仍会 ok；临时脚本 formMiss（表单存在、selector miss）复现 `login('x')=ok`；现有 `home login overlay` 用例只把同一 selector 的 isVisible 设为 true，未模拟 selector miss；修法：加宽表单检测/增加独立否定信号，或把 selector miss 视为不确定并 waiting；补该用例。
P2-1｜runner/browser-auth.mjs:98-102：`xSessionUrl` 排除整个 `/i/`；已登录的 `/i/chat`（X 消息页，marker 可见、无表单、token 在）会一直 waiting，属判定过严；修法：只排除 `/i/flow`、`/i/jf/onboarding`、`/i/jf`，或直接以 xState 判定；补 `/i/chat` 正向用例。
P2-2｜runner/browser-auth.mjs:105-111：`currentXPage` 对每个 page 调 `evaluate(hasFocus)`，无超时；冻结的后台旧 `/home` 可能卡住登录循环；现有用例的 oldPage.evaluate 立即返回；修法：给 focus 检查加 500ms 超时/跳过明显非 X 页；补冻结页用例。
备注：多标签用例的 `oldPage.locator` 抛错会被 `xState(...).catch(()=>null)` 吞掉，不能证明旧页未被选中；我的独立脚本计数 0 次才成立；启动参数/回环/CA 未改；真实 X 账号登录未做（Works on Off）。
