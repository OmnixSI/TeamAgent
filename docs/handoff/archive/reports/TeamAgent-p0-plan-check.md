结论：打回，需改方案；当前 P0 不可按合同直接开工。范围：plan-teamagent-v1.md §1–§2，对照 TeamAgent HEAD 76855aa；原方案引用的核心函数和位置基本真实。
测试：已用无文件落地的临时测试复现 ASR 占位被真实 rememberCorrection 接受为 confirmed 证据、图片占位进入真实 phraseCandidates；验证 HH:mm 跨午夜排序逆序；内存 SQLite 重放旧 schema＋方案两新表＋现有迁移两次及旧 messages/outbox 位置式插入均通过。未复跑已有基线或访问生产；未改代码。

必须改方案：

- P1｜plan-teamagent-v1.md:87、:54、:60：把渲染正文/卡片标题/ASR 占位写入 messages.body，会改变“原话”的信任边界。src/memory.ts:7、:11，src/semantic.ts:136、:808、:813、:913、:917 直接用 direct/body.includes 校验证据和交办；普通语音附件仍可 direct=true，ASR 内容因而成为执行/confirmed 事实依据；src/learning.ts:10、:72 又会统计合成词。修法：messages.body 保持旧文本语义，渲染/占位/ASR 放 meta 并仅在视图生成，ASR/卡片留 material；can_request_artifact 和视频 instructions 仍依据真实文字，若坚持换 body，须把上述校验、夜间整理及来源 API 一并纳入合同并保存独立原文。只回退代码无法恢复被替换的原文。
- P1｜plan-teamagent-v1.md:59、:91：ib.urls 明含引用内容，又全部用于自动 media job，引用旧 B 站链接会新建 media-<本条id>，重跑旧视频；这与 src/worker.ts:262 的既有边界及方案 §1.6 冲突。修法：分清 ownUrls（本条正文/顶层卡片）和 material/quotedUrls，自动视频任务只用 ownUrls；引用资料仅在真实直接交办后处理。补“引用旧视频无新 media job、顶层新卡片仍建 job”的配对测试。
- P1｜plan-teamagent-v1.md:89、:108、:111、:119：replyTo 只有 kind/target_id，viewMessage(row,names) 没有消息→作者映射，无法实现“引用作者优先”；且 src/semantic.ts:565 的 recentBot 查询没有 id，botView 必需的 outbox.id 拿不到，引用 bot 的 re 无法连到窗口消息。修法：明确批量加载目标消息/作者（含窗口外引用）并为 replyTo 增加 authorId/显示名，recentBot SELECT 带 id；定清 re 的消息 ID 命名空间和 @ 人边连接规则，补真实引用→addressee/threadize 的端到端测试，不能只手工构造带作者的单测对象。
- P1｜plan-teamagent-v1.md:98、:119：视图先投影再按时间排序，却只保留 HH:mm；跨午夜 00:01 会排到 23:59 前，同一分钟多条也失去顺序依据，影响窗口截断与线程首条编号。修法：保留完整时间戳/数值 sortAt 及稳定并列键，或先按原始时间排好再投影；HH:mm 仅供展示，补跨日期和同分钟的成员/bot 混排测试。
- P1｜plan-teamagent-v1.md:119、:124：只替换消费视图，遗漏真实 research 恢复路径 src/worker.ts:485、:507；该 recent 查询只有 id/sender/body/ts，无 metadata/analysed_media，纯函数无法补出卡片、@、引用。搜索/文件工具都会经 src/semantic.ts:685 转此路径，后台完成后的嘴替仍失去结构。修法：明确 chat/research 共用的批量上下文加载与 recentViews 初始化，列全 agentAnswer→speakBrief 两个出口（:721、:742）；voice_notice（worker.ts:573）若仍保留原 latest.body，明确其范围及资料边界。补 research 队列恢复后的嘴替请求断言。

建议：

- P2｜plan-teamagent-v1.md:76、:154：两新表以 IF NOT EXISTS 追加 schema 与 scripts/migrate.mjs:4、test/support.mjs:62 兼容，已验证；完成清单仍应补已有数据库升级/重复迁移、manual 昵称不被 QQ 覆盖、重复事件不重复 refs，以及回滚保留数据的验证。测试模拟器 test/support.mjs:90 的 batch 是 Promise.all，不能据此证明 D1 事务或并发性质；新增 SQL 查询数应逐条核算，batch 不等于一条 SQL。
- P2｜plan-teamagent-v1.md:126：现有 18 项不足以证明 P0 完成；除上述必改配套用例，再补纯图/ASR/表情不作为原话证据、缺昵称与旧 meta 的降级、嵌套转发不触发命令、登录/绑定及脱敏 commandText 回归。搜索 substr/instr 与 COUNT 不会因 body 类型直接报错，风险是含义被改；保留旧 body 可避免搜索、摘要、统计、原话 API（worker.ts:1654、:1665）与回滚一起扩散改造范围。实群卡片/引用/图片仍未验收。
