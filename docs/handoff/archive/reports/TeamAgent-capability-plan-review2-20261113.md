结论：需修改，P0无；v1.1未关闭全部问题，C3仍有P1，且C3派发规则会回退fastlinks内联行为。六方面及18项修订去向如下，不能据“已修订”直接全批开工。
依据：代码固定main 0f67b28；P=任务目录plan-bot-capability-v1.md v1.1；F=同目录plan-fastlinks-v3.md；Fw=/Users/yanghongming/Projects/.worktrees/TeamAgent-fastlinks/.agent/plans/plan-fastlinks-v3.md。只审方案，未改活跃worktree。
1）索引——主体通过（对照#1–3、#12）：按P:198–220伪代码在临时真实Git仓库重跑，35条主线+1条分支独有提交按30+6补齐；部分确认后只留6条，全部确认才推进frontier；旧force-push对象仍存在时，新独立历史也能纳入。P:217的900000字节组包与:335的1048576入口配套；固定两条清理和optionalCron明确，总代码预算仍须实现后实测。
   P2 字节函数仍错：P:99声称TextDecoder(fatal:false)会“丢半字”，实际会补U+FFFD；探针截12000字节后再编码为12001字节。须采用流式解码/回退到UTF-8边界，并对最终编码长度断言；关联代码入口worker.ts:1204–1206、2305–2315，新cutBytes尚未实现。
2）gitsafe——通过（#7）：P:84–86已覆盖merge-base/config/grep及受控worktree add/remove/prune，原execute.py:146–151、214–271写git流程明确排除，snapshot的新读取单独走read类；不再因新增白名单禁止旧执行器。生产认证与具体实现不在本轮验证范围。
3）C3——部分通过（#4–6、#8、#13、#18）：原lease缺失、终态/回复非原子、配额非原子等契约已补齐；SQLite探针确认同lease重报保留首结果且只有1个回复job，原子start重复不扣配额、同来源第3条被拒。P:815–855已明确pause/idle/reload与marker接线，P:659–665统一截止常量；未运行真实服务。
   专用reader配置（P:598–619）本机实测启动退出0，工具表只有glob/grep/read/todo_write；实际read取得合成README首行，final.reason.kind=completed。使用临时HOME、合成模型接口及localhost沙箱，说明配置可运行、派生/shell/web工具已隐藏；完整生产凭据拒读和443网络规则仍须S-3验收，不把本次模拟称为生产隔离已通过。
   P1 假成功未关：P:880允许“read或fs-search非错误”即done，比第0步:626的成功read要求更松；实际DSH回放只有glob的completed/No files found，final仍completed，按该判据会误报已读。须要求成功取得实际文件内容，或方案B明确返回非空代码片段；空glob/grep及仅路径列表不得满足成功条件。代码依据runner/execute.py:204–213只解析final，新增execute判据必须补此检查。
   P1 深度闸只藏工具：P:638、828移除origin=subagent时的delegate工具表项，但:829执行分支和:711–719的runDelegate不校验origin。带原@上下文的子代理research若返回delegate调用，仍可落到派发；现semantic.ts:932–939按名称进switch，不检查工具是否曾被offered。须在runDelegate服务端入口拒绝origin=subagent，并补“未提供却返回delegate”的回归；不能仅靠模型遵守工具表。
   P1 启动前marker无法安全回收：P:852规定Popen前写marker，pid/pgid此时只能为空；:854直接killpg，实证killpg(None,0)先抛TypeError，cleanup/删marker可能不执行，reload两道marker闸继续阻塞。非空旧PGID也须验证仍属本run，避免PID复用后误杀。关联runner/execute.py:50–61（Popen后才有pid）、reload_runtime.py:12、21；补空pid及复用PID用例，全程不得对不匹配进程发信号。
   P2 可观测字段还缺：P:807输出sha7，但:770的持久result与:902–907报告契约都没明确携带实际解析的SHA；ref可移动，Worker不能以当前head代替。须在runner回报/存储/交付中贯通resolvedSha，workspace引用继续独立标注。
4）C4——授权方向通过，接口需调整（#8、#15）：P:988–993已要求同字段、同必填、保留authorizeWrite/proposal/requestPlan/activity，并正确说明0002不是人工审批，符合semantic.ts:1083–1144、worker.ts:782–795、1632。
   P2 P:989、991的case直接传batch，但main agentAnswer（semantic.ts:611起）没有batch局部变量，旧逻辑使用context.batch（:1085）。须明确传context.batch||[]、回退context.latest，并确定跨模块调用createProjectTask的导出/注入位置；否则“纯重构零变化”这一步会因标识符缺失卡住。
5）C2/开关——本轮调用内通过，resume仍需调整（#9–11、#16）：SWITCH_KEYS登记和执行检查已列入P:127–130；每轮offered与替换式能力卡在:494–505明确；失败累计:510–514可进入speakBrief，符合rhythm.ts:58–64、voice.ts:112–124。
   P2 toolFailures在每次agentAnswer重置为[]，转后台时现有semantic.ts:863–871只保存messages/pending/turn，不保存它；前台失败后再handoff，后台最终facts会丢该失败三件套。须把安全裁剪后的数组纳入resume载荷或从既有tool消息恢复，并测“前台失败→下一轮转后台→嘴替仍含next_action”。
6）合并顺序——串行顺序可行，但派发规则冲突（#14）：P:35–40的C1→fastlinks P2→C2→P3→C3→C4顺序清楚；以下不能照伪代码合并。
   P1 P:50–55的二选一分类把foreground=false全部转research，单个read_web/read_x既不在LOCAL_TOOLS也不在SIDE_EFFECT_FOREGROUND，因此C3合并会覆盖fastlinks R4已有inline路径；判定探针结果为research，预期为inline。关联main semantic.ts:851–860、Fw:373–398。须统一三态：含副作用的混批handoff；纯本地/允许的单独delegate走前台；无副作用的其他批次继续调用inlineable，而非全部handoff，并保留P2原测试。
   P2 两份fastlinks方案未同步：Fw:394–398已有R4补充；本任务给的F原件全文未检出LOCAL_TOOLS/SIDE_EFFECT_FOREGROUND/delegate，仍是旧三件套。P文末对照#14“已追加”只对worktree副本成立；须统一作为交付合同的两份内容和规则优先级。
验证范围：本轮跑新游标/分支补批、force-push、原子配额、report重报、派发谓词、空marker、字节边界及两次DSH合成模型回放；没有重跑上一轮78项未改基线测试。未实际执行任何派生工具、真实进程kill或生产重载。
18项对照摘要：#1–3、#7、#12、#15、#17–18的原主体假设已修/记录清楚；#4–6、#8、#13须补C3成功/深度/恢复/字段问题；#9–11须补resume失败透传；#14须补统一派发和双文件同步；#16定位约定可沿用。字节边界为修订新引入P2。
边界：只审不改方案/业务代码/活跃worktree，不访问真实服务、Cookie、密钥或Edge profile；无安装/部署/用户仓库提交。临时Git仓库、DSH临时HOME与全部自写探针已删除；按上列P1修订后再交执行。
