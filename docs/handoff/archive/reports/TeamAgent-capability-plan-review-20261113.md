结论：需修改，不能按现方案直接开工；P0无，C1/C3/C4有P1。必须先修索引完整性、请求入口、子代理协议/隔离和委派授权接线，再按串行合并顺序执行。
依据：固定main 0f67b28的隔离快照；未混入fastlinks活跃worktree的未提交改动；链接方案已核为v3.2。
引用：P=plan-bot-capability-v1.md（BINI任务目录原件）；代码行均属main 0f67b28。D=/Users/yanghongming/.openmausbot/tools/npm/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai；DSH版本0.2.2-rc.1。

1. bridge主循环与/context——需调整：runner/bridge.py:226是tick，主循环实际:290–302；独立同步线程在:281–287。索引不可按P:193同步塞进续租主循环，应独立有界运行；/context实际worker.ts:1574，统一runner token校验在:112–117、1335–1336，错误token401/正确token200探针通过。
2. semantic工具、抽函数、失败话术——需调整：工具表:618–775、转后台:851–860真实存在；prepare_project_task在:1083–1144，可提取但须return结果替代原result赋值，并保留source/context/messages及requestPlan/activity。catch:1190–1194已特别保留授权/预算原因，“一律固定话术”不成立。
   C2“在agentAnswer grep role:system”找不到目标：system由participationMessages生成，入口在semantic.ts:807；能力卡须按每轮:845实际tools状态更新，并处理resume.messages，不能只初始化一次。
3. UNTRUSTED_TOOLS/authorizeWrite——需调整（P1）：authz.ts:6、16–19登记新读取工具并实际untrusted包装，旧authorize可复用；但P:506/580的runDelegate没有messages参数，:534却调用tainted(context,messages)，实测传undefined抛TypeError。C4参数也漏request_quote/source_id/title/detail/execute_requested/complexity（semantic.ts:703–735、1084–1110），须明确映射，不能以question代替授权原话。
   既有authorize允许强原话在tainted回合通过，但创建任务降为proposal（authz.ts:112–122、semantic.ts:1106）；须原样保留。authz没有owner身份函数，HTTP owner判定在worker.ts:93–109；群内cancel必须另定可信QQ身份映射，不能取模型参数或昵称。
4. off:开关——需调整：settings中字符串“1”表示关闭，worker.ts:87–91、1053为写入；rhythm.ts:58–64的SWITCH_KEYS白名单控制读取。实证仅存off:repo_tools不会被loadSwitches读出；须登记两键、覆盖research/video_reply及已有pending工具的执行检查，不能只隐藏工具表；尽量复用已有switch查询，避免增加聊天固定读取。
5. speakBrief是否过滤结果——成立（透传），但C2接线需调整：voice.ts:112–124原样序列化传入brief，探针next_action保留；它不会自动取得前面tool结果。semantic.ts:914–921只传decision.brief和acceptedActions，失败结果未进入acceptedActions（:1196），须显式累计safe toolFailures并传入facts，才能满足C2-5。
6. D1绑定参数/分块——成立：9×11=99≤100，8个repo_state×5=40；提交30条最多3语句，3+1+2=6的ingest预算在这些边界内成立。[Cloudflare官方Limits](https://developers.cloudflare.com/d1/platform/limits/)（2026-11-13核对）。项目仍按d1.ts:10、22的“每条语句计数、≤48”执行，不因官方batch计数口径而放宽内部约束。
   入口需调整（P1）：worker.ts:1204–1206、2305–2315的通用上限为262144字节，实证270KB请求在到达新路由前413；P:241的1MB限制只写在ingest里无效。须统一requestBodyLimit与UTF-8总字节分块；30×12000字符的中文patch也可能超过1MB。cron还拟增加至多9条索引清理（P:256–258），必须统一预留/限量并测≤48，不能只测ingest。
7. Worker有无GITHUB_TOKEN——成立（代码支持），线上是否配置未验证：worker.ts:59为可选字段，:402–418有缺失降级和授权GitHub API；scripts/sync-runtime-secrets.py:8及Actions check.yml:33–39没有主动配置它。因此不能写“Worker没有此能力”，也不能假定生产token存在；此次未读取任何secret值。
8. DSH只读档/JSON/外层沙箱——需调整（P1）：--help确认permission preset参数但不列枚举、无轮数/token CLI开关；隔离默认配置和实际CLI确认read-only存在。D/dsh-headless/lib/json-stream-Dc3g2Bl1.js:268–275的final为{type,sessionId,reason,text}，成功reason.kind=completed；execute.py:204–213的解析可沿用。
   按P:629拒绝整个~/.openmausbot会拒绝本机dsh自身安装，实测sandbox-exec启动退出71/Operation not permitted。放行安装代码、临时HOME、只允许localhost模型接口后，原生glob/read确实完成列README和读首行，final completed；bash额外内层sandbox报SANDBOX_UNAVAILABLE，不能把“有final”当作读取成功，必须检查tool_result。
   深度1不成立：本机默认headless真实工具表含subagent/subagent_fork/workflow，未调用它们；安装默认配置的subagent插件与P:91直接冲突（D/dsh-tool-subagent/lib/index.js:452–462；默认工具表已实测）。须专用精简profile禁用原生派生/工作流及不需的写工具，并封住方案B的research再次delegate路径。未读取真实dsh-team.yml，不能证明其已禁用；方案B需明确选用并修K2白名单后才能开工。
9. task来源与0002审批——成立（需校正“审批”口径）：schema.sql:5的tasks.source_id保存messages.id；semantic.ts:1099–1111写入，worker.ts:1673–1693用于通知。0002_plan_authority.sql:1–9仅补历史task_plans，不是人工批准；tasks.ts:6–29建pending计划，worker.ts:782–795自动生成成功即可ready，:1632只领取计划ready的来源任务。保留现有门槛即可，不得宣称每项都等owner审批。
10. 其余执行前假设/漏调用方——不成立（“无需猜、可直接执行”），必须修下列P1及注明的P2：
   P1 索引会漏提交：P:154–157的rev-list --reverse --max-count=30取“最新30条再倒序”，临时真实Git仓库新增35条时漏最早5条；:188全局30条截断与:190游标提交也无逐repo已确认前沿规则。须从游标依次分批、未发送不前进、backlog不受fingerprint去重压制；远端agent/team分支只有head列表，commits_since只查origin/HEAD，分支独有提交的patch永不入库（实证未包含），须覆盖这些ref。
   P1 C3协议缺口：P:545–549 claim RETURNING漏lease，runner无法心跳/回报；:554报告SQL不校验lease_until/deadline，探针截止后更新仍为1；状态改终态后、插回复job前中断，再报返回409且永不补回复（探针retry changes=0）。须返回lease、按截止时间fence，并把终态与持久回复任务原子提交/允许同租约补齐。
   P1 生命周期/配额：P:93的6分钟总截止与:496排队30分钟过期冲突，claim也没筛deadline；:529–534计数后插入非原子，n未定义。须统一queued/running截止、稳定幂等ID、原子配额；新增subagent_runs必须接入worker.ts:1342–1354的idle/quiesce及runner/reload_runtime.py:12–27，否则运行中被当空闲更新、孤儿进程/迟到回报均无闭环。
   P1 K2白名单与步骤冲突：P:61漏merge-base（:154）、config（:175）、grep（:467）、worktree add/remove（:589/595）；现execute.py:146–151等还有合法写git流程，不能被“所有runner git都走K2”禁止。须区分索引读取、受控worktree生命周期、原执行器；补每类明确白名单。
   P2 L2/L3统计与上下文：git diff --numstat HEAD不包含untracked，不能靠status就精确算其新增行；须定义安全计数或标unknown。C3未提交diff的64KB材料与verify_citations只查提交SHA（P:604、635–637）会互相矛盾，须记录工作区来源/行号，不能当作提交内已验证引用。
   P2 同文件与评测：fastlinks v3.2的R4(:373–385)仍按固定本地三件套；C1 LOCAL_TOOLS后，P2必须真正改为集合判断，delegate含code_exec是有副作用的，不可当可重放只读local混批。C3/C4串行顺序可行；当前get_work_status仍在semantic.ts:940–963，合并后再核。评测脚本确认为scripts/evaluate-timing.mjs:91–105（60例），README没有单独工具列表段。

验证：隔离HTTP/SQLite/真实Git探针已跑；现有authz与authz-completion测试78/78通过。DSH试跑使用合成模型SSE、假API key和临时HOME，仅localhost网络，实际glob/read成功；这证明CLI/工具/事件链，不是DeepSeek真实模型能力或生产沙箱已验收。
必须修：上述P1全部先写回方案；不能仅靠“执行前先核”把协议、权限和漏数据的决定留给执行者。修订后再交执行，不要求用户补普通实现细节。
边界：只审不改方案/业务代码/活跃worktree，不运行真实bridge/execute，不访问3391、真实账号、Cookie、密钥文件或Edge profile；未验证生产GITHUB_TOKEN及真实dsh-team.yml内容。临时探针/临时Git仓库/DSH状态均已删除，未安装软件、未向用户仓库提交/push或部署。
