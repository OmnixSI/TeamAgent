结论：需改方案；P0无，P1两项（Contents符号链接绕过DENY、grep跨仓库查询）。云端直读路线可行，不能按当前合同直接执行。
基线与定位：全部用git show 210ed47读固定对象；P=TeamAgent-cap-c2/.agent/plans/c1b-cloud-read.md。repo.ts:5–9/68、semantic.ts:6/809/880/885–895/1222、authz.ts:6、d1.ts:10、worker.ts:63均存在；包装名单准确在semantic.ts:1240，调用在1241；runner DENY:23–25共18条、denied:62–64正确。
P1 P:38不能靠Contents返回type识别symlink：API对仓库内指向普通文件的链接直接返回目标正文，README.md→.env会通过请求路径DENY并落入file分支，T6的人工symlink对象测不到。须先按固定sha用Git树验证mode/path，120000只读链接元信息；再读确定的普通blob，补“非敏感链接名→被DENY目标”反例并重算请求数。[官方行为](https://docs.github.com/en/rest/repos/contents#get-repository-content)。
P1 P:40 grep把任意query原样拼进搜索语法，只过滤path、不核item.repository。已用真实公开API验证readme in:path repo:cli/cli repo:octocat/Hello-World返回两仓库共10项；故额外repo限定符能扩张范围，宽token时不能维持“私有只限白名单”。建议本PR移除grep（P:77已允许）；保留则限制查询语法并强制每项full_name等于授权目标，补混仓结果和恶意限定符测试。[Search API](https://docs.github.com/en/rest/search/search#search-code)。
P2 P:33/T2的r.url事后检查不是重定向安全闸：Worker默认follow会向跨域目标转发Authorization，事后拒绝已太晚。须redirect:"manual"，每跳先验HTTPS/api.github.com/允许目标，限定跳数且计入gh预算，禁止采用响应提供的任意下载URL；T2应断言跳转目标未收到请求或token。[官方警告](https://developers.cloudflare.com/workers/runtime-apis/request/#properties)。
P2 P:11/67误套HTTP的10ms到群聊：真实入口worker.ts:2362–2373为Queue消费者，官方免费/付费消费者默认CPU为30秒。须按入口分开验收，不能据HTTP口径承诺/判失败；另用真实repo.ts:18的redactPatch处理250000字节重复未闭合私钥头，本机约537ms，说明限body不等于限CPU，应补线性处理/异常夹具；此数不是生产超限证明。[Queues限制](https://developers.cloudflare.com/queues/platform/limits/)。
P2 P:22/42漏旧参数契约：repo.ts:78–81支持since=24h/3d/7d及默认7d，GitHub since要求ISO时间，author原为名称子串、云端变用户名/邮箱。须明确转换since及两种author语义，补schema中的ref等新增参数和mode默认值，测云端与D1兜底同参行为，不能只改repo字段类型。[Commits参数](https://docs.github.com/en/rest/commits/commits#list-commits)。
P2 P:33的ghFetch(e,segs,query,accept,cap)没有signal参数，却要求调用方传同一8秒signal。须明确传signal/deadline并与每次5秒合并，覆盖gate、head、读取正文和取消路径；补“响应头已到但正文挂起”的探针，避免只限制等响应头。
P2 P:38把content为空一律too_large，会误报合法0字节文件。须区分size=0的合法空base64、encoding=none/缺内容和大小超限，并明确list收到普通文件时的行为；加原生空文件与缺失content的反例。
P2 P:3“同轮不转后台”只能有条件成立：加LOCAL_TOOLS后单个repo_file及repo_file+repo_changes的原判定均不handoff，但与search_web或get_project混批仍按semantic.ts:885–895整批转research；turn<2、每轮最多3工具及D1前置闸仍在。须收窄承诺并补混批/两轮find→read/资源不足测试，不为兑现绝对承诺改既有授权或后台规则。
P2 P:9的get_project现状不准确：worker.ts:399–450是repoContext，仅在:796的计划任务调用；实际get_project在semantic.ts:1201–1220只读repo_cache/facts，仍白名单。保留该工具枚举和写任务枚举是正确边界；生产GITHUB_TOKEN是否缺失无法由源码证明，交付只查secret名字后记录，勿写成已独立核实。
DENY可执行：对210ed47的18条实提取，用方案“全路径或basename、小写、星号跨斜杠”算法做13例双端差分均一致；复制名单＋共享fixture可行。只改repoTools的读仓库参数，不能全局放宽REPOS或prepare_project_task/get_project；新增repo_file的注册、包装、authz三链齐全，未发现另一个生产runRepoTool调用点遗漏。
预算口径：e.meter只记录D1，不自动硬拦（d1.ts:13–24）；agent循环:970会先查余量。新repo_file可0 D1、云端changes叠加1、原兜底≤2；当前三个Queue的max_batch_size均1，gh计数随meter可共享本次调用。10次GitHub请求不是整轮50子请求的证明，须计重定向并以真实模型/QQ链测峰值，不能只测ghFetch mock。
验证：固定源码/调用方检索、真实公开双repo搜索、官方API/平台文档、原redactPatch合成正文、18条DENY的13例差分、四种批次handoff谓词；未跑未实现方案的全量测试/CPU线上验收，也未访问任何私有仓库或真实凭据。
边界：仅新增本报告，未改方案/代码/活跃worktree、未提交/合并/部署，探针未留文件，本bot无自动监控。此方案只覆盖GitHub托管仓库；用户所说上传本地源码/ZIP的接收与云端读取入口尚不在方案内。
