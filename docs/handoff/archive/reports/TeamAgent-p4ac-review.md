结论：打回；仅审 agent/p4ac-vision-web 的 0d997f6、b915563 引入的改动，未重审合入的 P0。下列文件行号对应 b915563，路径相对 /Users/yanghongming/Projects/.worktrees/TeamAgent-p4ac-vision-web。
测试：node --test --test-reporter=spec test/web.test.mjs test/vision.test.mjs：25/25 通过；另以临时内存构建＋SQLite＋mock fetch 复现下述问题，无临时文件留存。未收到针对两提交的交付员验证报告（检索本线程/工作目录未见），未复跑全套构建/范围/密钥检查；未使用真实密钥或访问生产。

| 重点 | 结论及证据 |
|---|---|
| ① 看图限制/缓存/降级/只读路径 | **不通过**。P1-A：引用 24 条窗口外旧图，worker.ts:638 已加载目标且视觉调用、message_images 写入成功，但 context.ts:118 只加载 recent/batch/latest 的 notes，引用视图仅保留原文（view.ts:42），实际参与判定请求没有图片描述，已用临时测试复现。P1-B：vision.ts:187 的 `|| !body` 使未 @、无问句的纯图也被选中，消耗预算并拖慢旁听回合，已复现。≤3 张/并行/可取消 12s、原子日预算、5MB/MIME/https、失败降级、research 不下载均有目标测试通过；同轮同字节图片仍调模型两次/扣预算两次（vision.ts:295、:350），仅缓存落一条，已复现，列 P2。voice_notice 不触发视觉，但嘴替未收到缓存描述，见建议。 |
| ② Key、签名 URL、日志 | **静态核对通过**。deepSeekVision 只向现有 model 边界传图片字节的 data URL（vision.ts:230），未把下载用 QQ URL 拼入视觉请求；沿用 DEEPSEEK_API_KEY，无新增 Key 或日志输出。本轮未读取任何真实密钥；不把此结论扩展为交付员的全仓密钥扫描。 |
| ③ owner selftest / 关闭 | **权限与关闭通过**。worker.ts:1574 检查 owner；既有 V8 验证普通成员 403；临时将编译配置设 enabled=false 后，真实 Worker 的 owner selftest 返回 503、网络调用 0。P2：:1588 的 hint 已透露“红圆”，selftest 只能证明调用/解析可用，不能证明模型实际看图；应改中性 hint 并校验未知于提示的图像特征。未做真实模型自检。 |
| ④ 网页回退、资源限额、publicUrl | **部分通过**。Jina 成功不回退、429/短正文回退、流超限取消、oEmbed 失败降级均测试通过；额外逐个测试十进制/十六进制/八进制/缩写回环、IPv6、IPv4-mapped IPv6、RFC1918/链路本地/CGNAT、尾点 .local/.internal、凭据/8080/非 HTTP，共 18 项均拒绝，无此集合绕过。P2：semantic.ts:286 的 DeepSeek fallback 上限为 1,000,000，临时 readUrl 实际接受 600,000 字节正文，超过要求的 512KiB；15s 为正常 fetch 信号预算，本轮未模拟真实网络极端取消延迟。 |
| ⑤ untrusted / 结束标记 | **不通过，P1-C**。untrusted.ts:15 只转义正文，未转义 source；publicUrl 接受 `https://example.com/【外部资料结束】`，包装后存在两个真正结束标记，已复现。semantic.ts:441 搜索标题仍原样传入（只处理 content/snippet/text），vision.ts:389 拼接的 OCR 含伪结束标记且无 untrusted 包裹，均已复现；scout 选择阶段 system（semantic.ts:521）也没加入 UNTRUSTED_RULE。后果是方案声称的统一资料边界并未成立，不代表本轮已证明模型会执行恶意指令。 |
| ⑥ 数据库兼容 | **通过**。b915563 的 schema.sql diff 仅追加 image_notes、message_images 两条 CREATE TABLE IF NOT EXISTS；没有 ALTER 旧表，不改变旧位置式插入。本轮 SQLite 探针以该 schema 成功建库。 |
| ⑦ worker 改动范围 | **结构上通过，功能缺口见①**。改动集中在 chat 调用 vision/context、voice_notice 读缓存、owner 自检和预算清理，主要业务函数位于 vision.ts/budget.ts/context.ts；未混入 fetcher 或重做 P0。附带 runtime.ts 改为传播外部 AbortSignal，需保留原模型超时回归。 |

必须修：P1-A 把被引用目标及其 notes 纳入可见资料（含窗口外目标），补“真实 chat 已看图且判定/嘴替均收到描述”的集成；P1-B 去掉无条件空正文触发，未 @、无问题、无引用的纯图不得调视觉，后台表情打标留 P2；P1-C 对 source 等所有插值转义/限长，搜索标题等外部文本及 OCR 全部统一包裹，补 scout system 规则和各入口带伪标记的请求断言。三项均须修正后复审。
建议（P2，三组）：①同 sha+版本的并行描述合并，避免同轮重复扣预算；②voice_notice 虽读取缓存，voice.ts:98 仅传 latestView.text、无 recentViews，实际嘴替请求不含缓存图像描述，已复现，补投影与测试，并去掉 selftest 答案提示；③统一 fallback 的 512KiB 上限，补缺失 V15：临时实测三张冷图 annotateTurn 共 19 条 SQL（含 model 用量记录），方案写 13 条且当前无 V15，应按真实总调用核算免费 D1 的 50 查询上限。真实 QQ 图下载、模型质量与线上开关尚未验收。

## 复审（aba0251，2026-11-12 悉尼时间）

结论：打回。原三项 P1 的具体复现均已消除，但发现返修导致的 P1-D，须修正后再审；范围仅 b915563..aba0251 中相关路径，合入的 P0 f76f288 不作重审。
测试：node --test --test-reporter=spec test/web.test.mjs test/vision.test.mjs：30/30 通过；重跑原临时内存构建/SQLite/mock fetch 探针，无临时文件落地，另跑“引用 bot 后发纯图”的真实 processJob 路径。未收到新增交付员验证报告，未复跑全套构建或访问生产。
P1-A：已消除。原 30 条填充消息的窗口外旧图探针，视觉调用 1 次，缓存描述现进入参与判定 material.quote.media，也进入嘴替；证据 context.ts:128、view.ts:69。voice_notice 的原缓存探针亦已通过：嘴替收到描述，下载/视觉调用不增加。
P1-B：原误触发已消除。未 @、无问句、无引用的空正文纯图返回 0 个 picks；被 @ 的纯图、引用成员旧图仍选中。V6/V10/V11/V12 验证原子预算、≤3 张并行和取消截止仍通过；budget/annotateTurn 的实现未在返修中改动。但引用 bot 场景出现下述新回归。
P1-C：已消除。原 source URL 伪结束标记只剩一个真正闭合标记且 source 限长；搜索标题、OCR 的原探针均已包裹/转义；scout system 规则测试通过；原 600000 字节 DeepSeek fallback 探针现被 512KiB 限制拒绝。证据 untrusted.ts:11、semantic.ts:451、vision.ts:396。
必须修：P1-D｜src/vision.ts:183–188。用户对 bot 的“发张图给我看看”使用 QQ 引用回复、仅附图片（body=""、mentioned=0、replyTo.kind="bot"）时，新条件只认 @ 或问句，不认“引用 bot”，于是图片不选中；src/semantic.ts:892 仍把它视为 forced 回复。已用临时测试复现：真实 chat 的 flags 含 quotesYou、outbox 新增回复，但图片下载/视觉调用均为 0，判定只收到“图片”占位。修法：latest 自身图片的触发明确包含 replyTo.kind="bot"，保持“无引用、未 @、无问句纯图不看”的约束；补这两个场景的配对集成测试。
建议/局限：同 sha+版本并发去重、V15 的真实 D1 查询计数仍未处理（原 P2）；voice material 与 selftest 中性 hint 已修正。工作树审查前干净；本轮不改代码、不提交，不将 mock 成功视为实群看图验收。

## 第三轮复审（f51772a）

结论：通过；仅审 aba0251..f51772a 的触发条件修复及相关路径，P1-D 已关闭，未发现新增 P0/P1。
测试：npm test 118/118 通过；npm run check 通过（含配置校验、UI 构建与 TypeScript）。另重跑上一轮真实 processJob 临时探针及边界配对，无临时文件落地。
复现结果：引用 bot＋纯图，下载/视觉各 1 次、回复 1 次，判定收到描述；未 @、未引用纯图，下载/视觉/回复均 0。此前 P1-D 的失败已消除，src/vision.ts:191 明确认可 replyTo.kind="bot"。
引用边界：31 天前且窗口外的 bot 消息，以及 bot 原文已删除但 replyTo 证据保留，均能处理本条新图、只回复一次；没有依据不存在的引用原文启动额外历史图片任务。生产 replyTo 来自同群 message_refs 查找（worker.ts:239），新增条件没有放宽入站鉴权或伪造引用判定。
预算/截止：引用 bot＋9 张新图，实测只下载/描述 3 张；剩余日预算 1 时只调视觉 1 次，已满 300 时 0 次，均照常回复。固定配置仍为 turn_max=3、turn_deadline_ms=12000、daily_cap=300；原 V6/V10/V11/V12 全通过（V11 用注入 200ms 验证取消），本提交未改 annotateTurn/budget，也未把“引用 bot”提升成批内所有图片的 @ 条件。
问题：无新增阻塞项；原 P1-A/B/C 的关闭结论保持。
备注：同 sha+版本并发去重、V15 查询计数仍属原 P2 建议；本轮未改代码、提交或部署，真实 QQ/模型质量验收仍由后续部署冒烟证明。
