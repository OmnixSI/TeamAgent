# F9r 进度（F9 读取器移植到最新 main）

- 2026-11-14 19:06 Sydney 开工：worktree `.worktrees/TeamAgent-F9r`，分支 `pkg/F9r`，基线 `origin/main 25e5094`，工作区干净；`node_modules` → `.shared/node_modules`，`runner/sdk/node_modules` → p4b-login（未提交）。
- 已读 `B/notes/F9-2port|F9-3|F9-4|F9-5.md`、`F9/F9-common.md`、survey §0/§5；`TeamAgent-F9-reader` 有另一路在跑，未动。
- cherry-pick：`63aec54`→`ba14708`、`6ad3443`→`db06104`、`7cade8f`→`2443cd6`（冲突 NOTICE/reach-adapter/read-social 测试，取并集）、`879f940`→`9543555`、`3f649ce`→`930d32a`、`0138f4b`→`fd17b1f`、`592837e`→`1b2d8e0`（冲突 NOTICE/adapter/reach-contract，取并集并删重复 `fileURLToPath`）、`e0a68ab`→`493f5cc`、`2095dee`→`4eee406`（契约搬到 runner，冲突取最终版）、`2e35e91`→`9a690a4`、`57f4522`→`1e1c4b6`。
- `0d0da5b` 的结果已包含在 `1b2d8e0`（那一条就是删重复 import，落地时已删，无再改）。
- 移植补丁 `fdcff2b`：`runner/reach-public.mjs`、`runner/x-reader.mjs` 的 `../src/reach-contract.mjs` → `./reach-contract.mjs`（F9-4/F9-5 merge 的冲突解决，不在普通提交列表里；否则平铺安装起不来）。
- 自知卡 `5d98608`：`read_social` 从 `uncovered_ok` 移到 `social_reading` 能力（微博/知乎/抖音/公众号/小红书/X，一句话文案含登录要求与 ToS 风险）；`stock_quote` 已被 main 的 `stock_quote` 能力登记，从 `uncovered_ok` 移除；`SWITCH_KEYS` 加 `reach:mode`、`POSITIVE_GATES` 加 `reach→reach:mode`，卡上显示真实开关态。
- 知乎热榜 `0fa942a`：旧的 `/hot-lists/total` 现在 401（curl 独立复现），改读公开 `/hot-list-web` 并兼容 `title_area/excerpt_area/link`，新增真实夹具与测试（先红后绿）。
- 验证：`npm run check` 0；`npm run check:ui` UI JavaScript parses；`npm test` 2200 项 / 2189 过 / 1 败 / 10 跳过，唯一失败 MG2（D1 语句 49>48）在 `origin/main 25e5094` 同样失败（基线 2130/2119/1/10）；F9 定向 69/69；`runner/test_browser_auth.mjs + test_fetcher.mjs` 101/101。
- 平铺安装：`/tmp/f9r-flat-*` 只放 `runner/reach-*.mjs`，无 `src/`；`import reach-adapter` 15 条命令、`reach-job` OK；真实 CLI：微博热搜 10 条、公众号文章 2509 字、知乎热榜 10 条（均无登录、只读 HTTP，未发群）。
- 需登录平台：小红书 `NEED_LOGIN`（诚实）；抖音短链 `SECURITY_BLOCK`（`platform_blocked`）；X 本次未开窗（profile 19:14 被另一路 `TeamAgent-F9-reader` 的 `x-reader` 占用），`browser-auth check('x')=ok` 但只是 00:39 的上次记录，F9-4 14:35 实测已失效，上线前需复验。
- 未 push、未部署、未发群、未写线上 D1；证据 `.agent/releases/ledger-all/evidence/F9r/`；临时平铺目录与基线 worktree 已清。
