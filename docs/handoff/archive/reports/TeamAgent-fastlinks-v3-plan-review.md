结论：需修改（含P1，按审查约定打回）；核查基线 origin/main=0f67b289，方案 plan-fastlinks-v3.md；只审不改。
测试：隔离快照现有 web/fetchjobs/authz/rhythm 144/144通过；另跑缓存、旧runner混跑、deadline、resume、预算探针。计时成本模拟使原B3/B4回归失败；以下区分实证与方案缺口。
P1 分P错读｜方案:192、204、330；src/fetchjobs.ts:52、174、runner/fetcher.mjs:142、177：旧bili:<BV>只有第一页且无page，不能给p>1兜底；旧runner实测忽略payload.page=2仍success=true。须限制旧缓存仅p=1，回报携带并校验实际page，以能力协商或先兼容runner再启用新任务，撤销全批次“Worker先上且兼容旧runner”。
P1 ref契约不完整｜src/fetchjobs.ts:26、30、57、78、128、runner/fetcher.mjs:177：refIn拟返回对象，其余调用链仍以string为ref/数据库键/缓存键，runJob也只接收字符串；须明确typed target→稳定ref、aid/page入payload→实际page回报→cleanResult→waiter的完整字段，不能只列refIn/extractBili。
P1 deadline未接线｜方案:270–284、src/worker.ts:503、866、src/fetchjobs.ts:142：改动清单漏Worker消费分支，现有failVideoWait只接受running且attempts>=3。实证resource_deadline被标done而wait仍waiting、outbox=0；须加消费分支和到期CAS，ready先读成功结果，按实际共享due_at计算剩余delay，不能一律新等30秒。
P1 resume规则冲突｜方案:247、342、src/semantic.ts:807、832–871、932–933：不能笼统丢弃resume.turn/pending；实证下一轮转后台需保留turn=1、新pending及已完成工具结果。须保留本次待执行消息并限制内联总数，定义同一assistant批次双read/混合工具时整批转后台或带执行游标，补不重放、不漏tool_call_id测试。
P1 时间预算未贯通｜src/semantic.ts:424–449、方案:113、246、322：left/COST是D1语句数，readUrl仍可耗15秒，Promise.allSettled本身不截止；Fx首次超时若独占剩余3秒，后两源无预算。须贯穿绝对deadline/AbortSignal、为各源留子预算，并为read_web明确3秒上限及内联超时后的续跑契约。
P1 埋点挤占交付预算｜src/d1.ts:16–24、31、src/runtime.ts:96、src/worker.ts:982：metered仅记账，COST.turn=2未计新增计时；临时测试仅为每次model加2条SQL，原B3同轮发送2段→1段。须给遥测与缓存预留预算、更新成本并复跑B3–B7；不能据旧测试保证新增逻辑≤48，本轮未证明实际超48。
P1 最新性判据不足｜方案:236、326：只有“比上次最新更旧”才重试，首访无缓存或持续返回相同旧头条都无法发现陈旧；须默认freshness=unconfirmed，明确独立来源确认与确认失效条件，补无历史/相等旧缓存用例，不能把单一缓存时间线当“截至读取时最新”。
P2 get_work_status方向对但映射缺失｜src/semantic.ts:946–952、src/context.ts:47：去掉media后原materials查询和recent.analysed_media均失去关联；只加resource键并按query过滤无法保持source_id语义。须补消息→ref/page→资源关联、按source_id过滤及按原来源保留标题匹配不确定性。
P2 失败/信任契约需明写｜src/fetchjobs.ts:188、212、runner/fetcher.mjs:174、180、src/authz.ts:6–19：现协议是success/result，cleanResult仅成功时调用；须统一reason/scope/retryAfter及partial保留正文规则。新read_x仅untrusted:true不能触发taint（探针false），须实际untrusted()包装并补授权回归，覆盖失败/结构化结果。
已确认 迁移/测试｜package.json:6、scripts/migrate.mjs:24、.github/workflows/check.yml:42：测试为node:test+esbuild、Python unittest；目录migrations存在但迁移清单硬编码，新SQL必须同时登记，schema.sql也须支持新测试库；无需改CI。
已确认 入口｜runner/qq-gateway.mjs:107–116为入站；文本发送由src/worker.ts:1006–1048直连QQ并记sent，不存在所述网关文本发送成功回报；计时应放实际sent提交处。fetch waiters是vw-...等待ID（src/fetchjobs.ts:83、89），需映射latest_id才能串turn_id。
已确认 私库/现状｜src/worker.ts:395–418的repoContext有REPOS白名单、缓存及授权GitHub API，并非readUrl私库路径；须抽取或明确转get_project。src/fetchjobs.ts:135将终态标done，仓库无删除video_waits语句，“终态行会被删”不成立；付费档无法从仓库确认，继续标未验证。
边界：未改方案/业务源码/活跃worktree，不读账号密钥、不访问真实服务、不发群消息、不部署；全部自写探针及临时快照已删除，未验证线上计费档、真实QQ样本或新X源的服务行为。
