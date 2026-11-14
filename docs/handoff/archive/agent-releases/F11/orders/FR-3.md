# 施工单 · F11 · FR-3 API + 状态转移 + 回复入队 + 超时扫描
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-F11-FR-3   分支：pkg/F11-FR-3   施工者：工程师（DeepSeek；两轮不过转程序员）
目标：工作室能拉单、领单、回写；shipped/failed 时服务端把回复写进 outbox（引用原消息，唯一键，只一次）；不沉默。
要改的文件：
- src/feature-request-api.ts（新）：export async function featureRequestRoute(r: Request, e: any, who: any, path: string, method: string): Promise<Response | null>（不是 /api/team/feature-requests 开头返回 null）；export async function sweepFeatureRequests(e: any, now = Date.now()): Promise<{requeued:number,failed:number}>
- src/worker.ts：**只**加两处——(a) 在 /api/team/* 鉴权之后、/api/team/tasks 路由（约 1908 行）附近加 `const fr = await featureRequestRoute(r,e,who,path,method); if (fr) return fr;`；(b) scheduled 里每次 tick 调 sweepFeatureRequests（看 worker.ts 里 scheduled/定时入口，如 cron 触发处，挑和 sendOutbox 同一处，被 left(e) 预算保护的话遵守）。看 1315 行附近的请求体大小限制表，为这些路径设 16KB 上限。
- test/feature-request-api.test.mjs（新）。
接口（不许改）：types.ts 的 FrReport / FrPublic / FR_TRANSITIONS / FR_REPLY_PREFIX；API 路径与语义见 design.md「工作室接口」。
鉴权：who.role==='owner' 或 'admin' 才能访问；who 为 AI 成员令牌（who.role==='member'）→ 403；无令牌由上游返回 401。decision 只允许 who.role==='owner'。返回体用 FrPublic（toPublic(row, outboxStatus)）：**不含** group_id、sender 原始 id、msg_id；字段 untrusted:true。
转移（全部 CAS，统一 helper transition(e,row,to,patch,now)）：
  UPDATE feature_request SET status=?, version=version+1, updated_at=?, <patch> WHERE id=? AND status=? AND version=?  → meta.changes!==1 → 409 {error:'conflict'}。不在 FR_TRANSITIONS[from] 里的 → 409 {error:'illegal_transition'}。
领单 claim：body {id?,worker}。先数 developing（status='developing' AND lease_until>now）≥cfg.max_developing → 409 {error:'max_developing'}；选行：给 id 就取该行，否则 SELECT 最老的 status='queued' AND mode='build' AND auto=1 ORDER BY created_at,id LIMIT 1；无 → 204；行必须 status='queued' && mode='build'（needs_human/proposal 单永远不可领）→ 否则 409。CAS queued→developing，claimed_by=worker（clip 40），lease_until=now+cfg.lease_hours*3600000，attempts+1。并发两个领同一张：只有一个 CAS 成功，另一个 409。
heartbeat：仅 developing 且 claimed_by===body.worker（不传 worker 则只要 developing）→ 延长 lease_until，保持 status（developing→developing 走 CAS 让 version+1）。
report：
- shipped：行必须 developing；校验 /^[0-9a-f]{7,40}$/ release 且 (e.RELEASE||'').startsWith(release) 否则 409 {error:'release_mismatch'}；rollback_point 非空 clip 60；smoke_verified===true；sanitizeReply(reply_text)（FR-1 的函数）失败 → 422 {error:'reply_invalid',why}。通过 → 一个 e.DB.batch：[CAS UPDATE → shipped（写 release/rollback_point/smoke_verified=1/reply_kind='shipped'/reply_text/reply_outbox_id='frr-<id>'/reply_enqueued_at）, INSERT OR IGNORE INTO outbox SELECT …]。**关键**：outbox 行只在状态 UPDATE 实际生效时才插入——用 `INSERT OR IGNORE INTO outbox(id,group_id,msg_id,body,status,created_at) SELECT ?,?,?,?,'pending',? WHERE EXISTS (SELECT 1 FROM feature_request WHERE id=? AND status='shipped' AND reply_outbox_id=?)`（先 UPDATE 后 INSERT 同 batch，顺序保证）。outbox 列顺序以 migrations 为准（worker.ts:400 是 INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?) 六列）。引用：SELECT ref_idx FROM message_refs WHERE kind='member' AND target_id=<原消息 id> AND group_id=? LIMIT 1；有 → INSERT OR IGNORE INTO outbox_meta(id,json) VALUES(?,?) json={"reference":ref_idx}（看 outbox_meta 现有写入处的列名，rg "outbox_meta" src）；没有 → body='回复「'+clip(quote,12)+'…」：'+text（quote 不足 12 字不加省略号）。已 shipped 且 reply_outbox_id 非空 → 200 幂等返回当前行，不再入队。
- failed：行 status 为 queued 或 developing；reason sanitize（≤150 字，同规则，why 同上）；body 固定「这个我这次没做成：<reason>，已转人工。」；其余同 shipped 的 batch 做法，reply_kind='failed'。
- needs_human：queued|developing → needs_human（status_reason=clip(reason,200)），不入队回复。
- proposal：仅 mode='proposal' 的行：写 proposal_note=clip(note,2000)，状态不变，version+1。mode='build' → 409。
- release：developing→queued，claimed_by/lease_until 置空。
decision：approve 仅 mode='build' 的 needs_human→queued（approved_by=who.name||who.id，auto 保持原值不改；claim 条件是 auto=1... 所以 approve 时同时把 auto 置 1，仅限 owner 手动批准的这种情形）；mode='proposal' approve → 409 {error:'proposal_only'}；reject → rejected（approved_by 记人）。
sweep（scheduled 调用，幂等、可重复）：(1) developing 且 lease_until<now：attempts<3 → CAS 到 queued（清 claimed_by/lease）；attempts>=3 → 走 failed+stale 流程；(2) status IN('queued','developing') 且 created_at<now-cfg.stale_hours*3600000 → failed+reply_kind='stale'，reason 固定「排太久没落地」，入队回复（同 failed 的 batch）。**needs_human 单不扫**（等人，不回复）。每次 sweep 最多处理 20 条。
步骤：
1. 先写 test/feature-request-api.test.mjs（用 test/support.mjs 的 env() 本地库 + 直接往 feature_request 插夹具行；不需要真实模型）。用例对应验收 S7/S8/S9/S10/S11/S12/S13/S14：claim 并发（Promise.all 3 个 claim，max_developing=2、同一张争抢）、shipped 正路径（断言 outbox 1 行、outbox_meta.reference、再 report 一次 outbox 仍 1 行）、release_mismatch 409、smoke_verified=false 422/400、reply_invalid 各种坏文案 422 且状态与 outbox 不变、failed 文案固定模板、stale 扫描三种情形、无 ref_idx 前缀、鉴权（无令牌/随机令牌/teamai_ 令牌 403/owner 200；admin 角色成员 decision 403）、非法转移（shipped 再 claim/report、needs_human 被 claim）、GET 返回体不含 group_id/sender。再加一条：用 stub fetch 跑 sendOutbox（worker.ts 里 export 与否看现有测试怎么测 sendOutbox，rg "sendOutbox|outbox" test/*.mjs），断言请求体带 message_reference；不得有真实网络调用。
2. 实现；3. npm run check && npm test 2>&1 | tail -60。
不要做：不改建单逻辑（FR-2）、不改 types、不改 core；不新增任何重试逻辑；不在 worker.ts 里写业务逻辑。
依赖：FR-1 的迁移 0070 与 core 函数尚未合入：你在本分支里临时自己写迁移副本与 core 简版仅用于本地跑测试，**交回前 git rm 这些文件**，提交里只保留 FR-3 自己的文件（feature-request-api.ts、worker.ts 两处接线、测试）。
参考：src/claims.ts（claimTask/reportTask 的鉴权和 CAS 写法）、src/worker.ts:400 outbox 插入、:1047 起 sendOutbox、src/quote.ts:12、scripts/review-pull.mjs（令牌用法）。
done_when：S7–S14 对应测试全过；并发测试稳定（跑 5 遍都过）；npm run check 无错；worker.ts 改动 ≤15 行。

通用（每个包都适用）：
- 开工仪式：pwd → git log --oneline -3 → 读 .agent/releases/F11/design.md（只读「状态机/识别与闸门/工作室接口/回复」几节）和 src/feature-request-types.ts、src/feature-request-core.ts → 读 .agent/releases/F11/notes/<包名>.md（没有就建）。每完成一步在笔记追加一行。
- 接口冻结：src/feature-request-types.ts 与 src/feature-request-core.ts 的签名不许改（FR-1 只许替换 core 的函数体）。需要改接口就交回，别自己改。
- 读代码精准：rg -n 定位后 sed -n 看几十行；不读 lock 文件/node_modules/生成物。命令输出 2>&1 | tail -60。
- 先写测试再实现；提交用 Conventional Commits，在自己的包分支上提交。验证命令：`npm run check` 无错、`npm test` 全过（输出截断）。不 push、不碰 main、不动线上、不往群里发任何消息、不写线上 D1。
- 不确定的地方先 rg 现有代码找同类写法照着来；仍不确定就在笔记里写下假设继续，交回时列出。
- 交回格式（≤15 行）：分支+提交号、改动文件、新增测试数与 npm test 结果、做了什么假设、没做/遗留。
