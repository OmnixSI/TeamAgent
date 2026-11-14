# TeamAgent issue #10 侦察与修复（agent/issue10-p2）
基线 `origin/main` 057bb8f；分支 `agent/issue10-p2`；提交 `dd0f9f3`（未 push/PR）。三条均不阻塞发布。
1. **解锁码经 `/usr/bin/open` argv**
   - issue：owner_unlock.py:100 把 60 秒解锁码放进 `open` 参数，本机其他用户可用 `ps` 截获并抢先兑换。
   - 代码：`runner/owner_unlock.py:100`；`owner.py:83` 新增的 `open -a Edge` 入口同类。
   - 未修：简报明确禁止改 `runner/owner*.py`（登录页分支正在改）。建议改 OS 用户保护通道或交互式 owner 认证；这是本轮唯一未处理项。
2. **旧格式 bili-cookie 未兼容**
   - issue：旧版保存的 cookie 结构升级后不再读取，已登录用户被视为未登录。
   - 代码：`runner/browser-auth.mjs:41` 的 `loadBiliCookies` 只认新结构；同文件 0600 写入。
   - 未修：简报禁止改 `runner/browser-auth.mjs`。建议读取时兼容旧字段并在下次成功登录时迁移，不要读日志/上云。
3. **运行时空闲闸未计入已领取登录流程**
   - issue：`/api/runner/idle` 只查 jobs/tasks/outbox，等待扫码的 claimed login-flow 会被判空闲，重启可能切断。
   - 代码：`src/worker.ts:1340-1344` 的 busy SQL。
   - 已修：加入 `login-flow:bili|x` 中 `claimed_at` 非空、未过期、phase 为 waiting/scanned 的计数；过期或未领取不阻塞。新增 `test/collaboration.test.mjs` 回归：claimed→idle=false，过期→idle=true。
验证：`npm run check` 通过；`npm test` **387/387**；`npm run test:runner` Python **37** + Node **48/48**；`npm run check:ui`、`npm run config:check`、`git diff --check` 全绿。未 push、未部署，未改任何登录页文件。
