# B 站 412 诊断与修复（2026-11-12）

结论：Chrome UA 且无匿名 `buvid3` 时 `view` 返回 412；`curl/8.7.1`（或无 UA）直接 200，Chrome UA + `buvid3` 也 200。`buvid4` 单独不够，`SESSDATA` 非必需；curl UA + `buvid3` 是最稳组合。目标 `BV1ZAWM61Evb`；buvid3 已获得 len=46，buvid4 len=76（不记录值）。本次交叉 13 次 + 端到端 5 次请求。
| UA | 无 b3 view | 有 b3 view | 无 b3 reply | 有 b3 reply |
|---|---|---|---|---|
| 无 | 200/0 | 200/0 | 200/0 | 200/0 |
| curl/8.7.1 | 200/0 | 200/0 | 200/0 | 200/0 |
| Chrome | **412/-412** | 200/0 | 200/0 | 200/0 |
- `/x/web-interface/view` 是主要 412 点；旧 `/x/v2/reply` 上表均 200，`/x/v2/reply/main` 无 b3 为 200/-352、带 b3 200/0。
- `/x/player/v2` 无 Cookie 也 200/0；`/x/player/wbi/v2` 需 `w_rid`，nav 即使 `-101` 仍有 `wbi_img`，签名后 200/0。匿名字幕返回 `need_login_subtitle` 或空 `subtitle_url`，不得声称看过。
- 对比：curl HTTP/2、curl `--http1.1`、Node https、Node fetch 无 Cookie 全 412；带 b3 的 curl 200，排除 TLS/HTTP 版本主因。
- 同代码 fetcher 端到端：SPI→nav→view→player/wbi→reply 全部 200，标题/UP 主/3 条热评成功，`subtitle_status="none"`。
- 修复：`runner/fetcher.mjs` 改 `curl/8.7.1` UA；SPI 匿名 b3 仅内存；view 412 刷新 b3 重试一次；SPI/view 只记状态码；Cookie 只发 `api.bilibili.com`；字幕加 `ok/none/login_required/unavailable`。`src/fetchjobs.ts` 把状态写进资料并在回复中区分「无字幕/需登录」。
- 测试：`npm run check`、`npm test`（151）、`npm run test:runner`（Python 10 + Node 15）、`npm test --prefix clients`（2）、`npm run check:ui`、`npm run config:check`、`git diff --check` 全绿；N10 覆盖 412 刷新重试，N11 覆盖刷新后仍 412 失败，N12 覆盖需登录字幕，N13 覆盖两次 view 412 后暂停且后续短链不发请求，N14 覆盖字幕 -403→unavailable，N15 覆盖暂停到期后短链不延长、随后 view 与 view 200 清零，N5 覆盖 Cookie 不外发。
- 提交：`6746f71`，分支 `agent/p4b-412-fix`；未 push、未合并、未部署。真实群冒烟仍需交付员执行。
