结论：需改方案；P0无，P1三项。先补齐下列合同再执行，不能把现有测试清单当作功能已闭环。
范围：只读main 71deb11及PR #25 head fbfe9a8；P=.agent/plans/c1b-repo-clone-and-file.md（TeamAgent-cap-c2 worktree）；以下P:行为方案当前行号，代码特别标PR25的按fbfe9a8，其余按main。
P1 不可信资料接线遗漏：P:32仅允许semantic改两处，:107只包file正文，dir/find的仓库文件名却直接进模型；semantic.ts:1240–1242固定包装名单及authz.ts:6–19均无repo_file。真实tainted探针：同一目录结果repo_changes=true、repo_file=false。须允许改authz并把repo_file所有结果统一包不可信区，补目录/find→后续写工具回归。
P1 已加载凭据的脱敏值未传入：P:23生产调用files_once(t)，:80默认known_values=()，:77直接redact；没有原sync_once的*_config_secrets(config)注入（PR25 repo_index.py:303）。合成不带常见前缀的已知runnerToken在正文中原样保留，传已加载值后才消失。须files_once自行合并已加载配置敏感值，补真实loop调用路径测试，不读取任何新密钥文件。
P1 根目录分支不可达：P:90规定path至少1字节，:101默认却是空串；即使豁免校验，:69的ls-tree不生成根行，:102查询kind=NULL后:105先not_found，进不了目录查询。真实Git＋原SQL已复现。须给空path专门的根目录分支（有snapshot即查dir=""），补零文件仓库和根目录测试。
P2 PR25错误分类接不上：P:14要求按stderr分类，但PR25 gitsafe.py:137–141已stderr=DEVNULL，:203–207只抛generic GitFailed；合成Authentication failed进程返回stderr空。须先以PR25为基线，明确有界收集→内部分类→丢弃的实现位置，保留进程组回收/max_bytes及两个既有异常子类；G2必须经真实子进程到reason而非只测字符串函数。
P2 find长度越过平台限制：P:97允许80字符，:110再包百分号并转义；D1的LIKE/GLOB模式最多50字节。按该限制重放，49字母加两端百分号已报pattern too complex，中文更早。须按转义后UTF-8模式≤50字节校验，或改instr等无LIKE模式上限的查询，并补中英文边界测试。
P2 接口合同相互矛盾：P:101先剥绝对路径斜杠，会把/etc/passwd变成etc/passwd，与W14的invalid_args冲突；P:33照抄json(await ingest...)默认HTTP200，也无法兑现:90的HTTP400。须先拒绝绝对/空段后仅规范允许的./，并明确ingest返回类型与route状态映射，测完整HTTP入口。
P2 500MB检查漏散对象：P:49只查size-pack；真实新init＋原_fetch本地传输探针得到size=36KiB、size-pack=0，设max_kib=1仍通过。须至少统计loose+pack，并明确下载过程中是否有磁盘限制；C7补散对象案例，不能只伪造大pack。
P2 差量只比blob漏模式变化：P:79的acked[path]=blob无法区分普通文件和同内容symlink；真实Git探针100644→120000时blob相同，按方案changed为空，DB保留旧kind。须确认键包含mode/type/kind（或完整行指纹），补file↔symlink同blob回归。
P2 DENY测试仅比名单不够：P:30、92、W13未写TS匹配语义；Python repo_index.py:62–64是先lower再对完整路径和basename各跑fnmatch。须写死同口径并做Python/TS差分夹具，覆盖大小写、嵌套.env、含secret的父目录、.git/*；脱敏回归也须沿用PR25的新token规则，不能从main旧版重建。
D1预算成立：8列×12行=96绑定；删除89路径＋repo=90；ceil(360/12)+ceil(890/89)+1=41条，读文件/列目录/find可保持≤2查询。现官方说明一次batch计一次调用查询，项目d1.ts:22–24仍保守按41条记账，无超48问题；每语句限制仍适用。[官方限制](https://developers.cloudflare.com/d1/platform/limits/)。
Git主体假设成立：PR25 _fetch在无refs的新init库已用真实本地对象验证；固定GitHub URL、只读对象、不checkout、存在目标/符号链接先拒绝、临时目录异常清理的方向可用。_env抽取须保留read类GIT_ALLOW_PROTOCOL=none；call_cap须与原time_budget取更早截止并嵌套恢复，G3应补外层短预算场景。
定位/迁移：main的repo.ts:5–9、semantic.ts:6/809/1222、worker.ts:1230–1236/1364–1366均存在；仓库目前只有0002–0004，0005_repo_files＋migrate.mjs:24可用，C3 Worker后移0006需同步其方案。PR25四文件重叠须先合并再落C1b；当前基线尚无capabilities.ts，后续C2合并时重核动态工具卡，不能覆盖其新增逻辑。
验证/边界：本轮跑原_fetch空库、本地树与根SQL、原tainted、合成值脱敏、PR25子进程stderr、LIKE限制、同blob模式变化和语句/绑定计数；未重复构建/全量测试（方案未实现）。临时仓库/数据库均删除；未改方案、业务代码或活跃worktree，未读真实凭据/访问生产服务/部署；真实私有仓库认证、体积、最终安全发布竞态未验收，本bot无自动监控。
