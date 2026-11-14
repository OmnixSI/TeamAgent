# fastlinks P0a 小修复查（060a961；对照 2d6a7fa）

结论：通过（无 P0/P1）。
测试：`npm run check`；临时副本 `npm test` 532/532；`fastlinks-p0a-review` 24/24；旧 2d6a7fa + 新测试 9 pass/15 fail；`fastlinks-budget` 15 条通过。
- `jinaOk:399`：只认 `Markdown Content:` 前（无标记前 300 字）的 `Warning: … error (\d{3})` 与 `Title:` 的 challenge/login；正文错误词只在去导航后 <1500 字时判 risk/login；正文 `404` 行匹配已删除。
- 探针/测试：长文引用 Warning…404 / Just a moment / Sign in、正文 `404 Not Found` 行 → ok；真 404/429/401/500 头部、短挑战/登录墙 → 仍失败；1499 失败 / 1500 成功；DeepSeek 无头部、同门槛（`readUrl:479`）。
- `understandLinks:503`：3 条 `Promise.allSettled` 并行、共用 `Date.now()+20000`、顺序按原 urls、失败项 `untrusted()`；24 条测试含并发开始 <100ms、20s 全 timeout、第三页先完成但顺序不变。
- D1：预算 15 条仍过（最高 45，无新增 SQL）；diff 仅 `src/semantic.ts` 与新测试；P2-2 short、P2-3 私有 GitHub、P2-4 oEmbed 未动（`readUrl:466/446`、`readTweet:409`）。
- 回归：旧 2d6a7fa 跑新测试 9 pass/15 fail，与主程自报 15 项一致；新代码 24/24。
未验收：真实 X/Jina/GitHub 实时、20s 实时、远端 D1 迁移、真实群。
