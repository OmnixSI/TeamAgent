结论：打回。审查 ad0aa45（基线 f16c96d）；1 项 P1 必须修，1 项 P2 建议修。
P1｜runner/fetcher.mjs:120、:62、:80：view 412 → SPI 200 → view 412 时，SPI 成功将 riskCount 清零，重试仍被风控也不暂停；修为刷新/短链成功不清除未恢复的 view 风控状态，重试仍 412 时暂停 10 分钟并回报「风控」。
复现｜临时脚本调用真实 runJob/createFetchClient、注入请求和时钟：单任务 2 次 view 412 后 reason=「视频内容未读到」，下一请求仍发出；连续 3 个短链任务累计 6 次 view 412，无暂停。应补业务流程测试，现有 N3 的连续底层请求覆盖不到此路径。
P2｜runner/fetcher.mjs:125：player HTTP 200/code=-403 被标为 none（已临时复现），src/fetchjobs.ts:95 因而说「无 CC 字幕」；只有 code=0 且列表为空才应为 none，接口拒绝应为 unavailable（明确登录错误可为 login_required）。
隐私/SSRF｜runner/fetcher.mjs:49、:57、:67、:108、:138、:148：匿名 buvid3 仅内存，动态值加入脱敏集合；SPI 固定 api.bilibili.com，Cookie 仅发该精确主机，字幕/短链不带；日志仅路径与状态，无新增落盘或直写 D1。动态匿名值脱敏临时测试通过。
重试/UA｜runner/fetcher.mjs:12、:119：仅一次刷新和一次 view 重试，仍失败由 runJob 降级；curl/8.7.1 是固定客户端标识，当前实测可用，未改变 HTTPS/主机名单/DNS 校验/禁止自动跳转；不能据单次成功保证长期免 412。
字幕/等待者｜src/fetchjobs.ts:86：所有空字幕状态均保留「未查看画面或听取音轨」；最大受限正文长度下的 4 状态临时断言通过；本提交未改 video_waits 领取/去重，既有 W 系列随全测通过。真实模型是否遵守尚未实测。
检查｜隔离副本 /tmp/teamagent-412-review-phwszbw_：npm run check、npm test（151/151）、npm run test:runner（Python 与 Node 12/12）、npm test --prefix clients（2/2）、npm run check:ui、npm run config:check 均退出 0；git diff --check 通过。
联网｜2026-11-12 悉尼 04:45 左右，同一 createFetchClient 无本地 Cookie 探测 BV1ZAWM61Evb：SPI/nav/view/player/reply 共 5 次请求全部 HTTP 200，取得元数据与 3 条热评，subtitle_status=none；未输出 Cookie。
边界｜只审不改，未改目标分支，未提交/推送/部署，未读本机登录 Cookie 或 .env；未做 QQ 群端到端冒烟。临时测试不提交。

复审（2026-11-12 悉尼 05:22；f340f2b 对 ad0aa45）：结论：打回；原 P1/P2 已消除，新增 1 项 P1。
原 P1 已修｜runner/fetcher.mjs:80：SPI/短链成功不再清空计数；原 runJob 探针确认两次 view 412 后回报「风控」，后续 3 个短链任务及 +599999ms 时均为 0 请求。
原 P2 已修｜runner/fetcher.mjs:133：player HTTP 200/code=-403 的原探针现得到 subtitle=null、subtitle_status=unavailable。
新增 P1｜runner/fetcher.mjs:62、:80：riskCount 已为 2 时，暂停到期后的成功短链 302 调用 risk(false,false)，仍无条件执行 pausedUntil=now()+600000；因而每次短链成功都续停 10 分钟，始终无法请求 view，即使上游已恢复。
复现/修法｜真实 runJob/createFetchClient 注入时钟：两次 view 412→推进 600000ms→改上游为正常→短链任务仅发 1 次 b23.tv（302），0 次 view，仍回报「风控」；再推进 600000ms 重复同样结果；直达 BV 为成功对照。只在新的风控响应达到阈值时设置暂停，成功响应保留计数但不得续期；补「599999ms 阻止、600000ms 短链→view 恢复」测试。
隐私复核｜runner/fetcher.mjs:67、:79、:111、:138、:148 未退步：临时哨兵测试确认 Cookie 只发 api.bilibili.com，字幕/短链不带，动态 buvid3 与 SESSDATA 哨兵值均不在日志/回报中；未读取真实 Cookie。
验证｜隔离副本 /tmp/teamagent-412-rereview-xzltc6hb：npm test 151/151；npm run test:runner Python 阶段成功、Node 14/14；两命令退出 0，git diff --check 通过。上述原探针与新增到期探针均已运行，临时脚本已删除、不提交。
范围｜只审不改代码/目标分支，未推送或部署；本轮未重跑联网探针，QQ 群端到端行为仍未验证。

第三次复审（2026-11-12 悉尼 05:27；6746f71 对 f340f2b）：结论：通过；本轮未发现新增 P0/P1/P2。
暂停恢复已修｜runner/fetcher.mjs:61、:62：到期后的下次请求先将暂停与计数清零，仅新风控响应从不足 2 次累计至 2 次时设置暂停；成功短链/SPI 保留未到阈值的计数但不延长暂停。
原复现重跑｜真实 runJob/createFetchClient 注入时钟：两次 view 412 后回报「风控」，后续 3 个短链任务及 +599999ms 均 0 请求；+600000ms 后短链 302→view 200→成功回报，未续停。
状态逐格验证｜正常/累计 1 次/暂停中/到期后 × view 412、view 200、短链 302、短链 200、SPI 成功、SPI HTTP 500、SPI 412、SPI HTTP 200/code=-403，共 32 格临时断言全部通过；暂停中均不发请求，短链/SPI 非风控响应不误清零，view 成功与暂停到期可清零。
再次风控｜到期后首个 view 412 仍允许刷新 SPI 并重试，仅第二个 view 412 才重新暂停；完整 runJob 探针与 N10/N11 一并确认刷新重试恰好一次。
已通过项未退步｜runner/fetcher.mjs:67、:79、:111、:133、:138、:148：API 精确主机 Cookie 边界、动态 buvid3/SESSDATA 日志与回报哨兵脱敏、player code=-403→subtitle_status=unavailable 的临时断言均通过。
验证｜隔离副本 /tmp/teamagent-412-third-55hcfbys：npm test 151/151，npm run test:runner Python 阶段成功、Node 15/15，两命令退出 0；git diff --check 通过；临时探针已删除、不提交。
范围｜只审不改目标代码/分支，未提交、推送或部署；本轮未新增联网请求，未验证真实 QQ 群端到端行为。
