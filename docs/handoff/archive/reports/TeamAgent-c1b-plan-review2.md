结论：仍需改。原3项P1的修复接线已解决；新增P1验收合同错误必须修，P2错误分类的内存限额仍需补明，不能原样交执行。
范围：只读修订方案v2（P=.agent/plans/c1b-repo-clone-and-file.md）、main 71deb11和PR25 fbfe9a8；未重审上轮已通过部分。
原P1①【已解决】不可信链：P:27、34明确authz.ts:6和semantic.ts:1240都加repo_file，目录/find/失败统一外包且不双包；隔离恢复这三类tool结果后tainted均true。但“所有后续写工具只能proposal”的说法及W16另有下述错误。
原P1②【已解决】脱敏注入：P:24、80、83–84让files_once自行合并_config_secrets并用known，tick无参也覆盖原漏传点；F3:145已改走tick并截上传体。合成值探针区分无注入泄露/有注入脱敏；F3实现时须断言至少一次repo_files上传且正文仍存在并含[REDACTED]，防tick吞异常后空断言。实际tick尚未实现，未冒称跑过该集成测试。
原P1③【已解决】根目录：P:105–106明确省略、空串、点、./四写法及独立根SQL；W15:170覆盖零文件有快照返回entries=[]。契约规整＋原SQL探针四种都通过，绝对路径/双斜杠/反斜杠拒绝，./src/归一为src。
新增P1：P:27、171的W16误用create_file_task来断言“只出proposal”；基线semantic.ts:1010–1014、1104–1114在强原话授权后直接建media job，只有prepare_project_task:1140有tainted→proposal。已在临时基线副本注册repo_file，恢复三类外部结果再调用真实agentAnswer，三例均tainted=true但合法产物仍入media。须W16改测prepare_project_task（有效强原话、execute_requested=true、小任务，断言proposal而非queued），另测无授权不建任务；create_file_task保留现有强原话授权规则，禁止为过W16改其行为。
原6项P2汇总：find→instr、HTTP状态/路径合同、loose+pack、mode+blob指纹、双端DENY共用夹具这5项【已解决】（P:32/35/51/72/94/105/115/152/168）。错误分类reason链【已接通，但限额未闭合】：P:15用communicate先全收stderr再取末4096，并非有界收集；合成子进程实收131072字节后才留4096。请并发排空并用固定4096字节环形尾缓存，保留PR25回收路径；G2加大stderr不死锁、保留缓冲不超额。
新接口一致：P:32/35/94的{status,body}与worker json(o.body,o.status)闭合；P:115原instr SQL实跑80字母、80中文、百分号、下划线均匹配，不受LIKE模式限制；根/目录仍至多2查询、批写41语句上界未变。
验证边界：真实agentAnswer临时探针1项含3分支通过；根/路径/SQL与纯脱敏为契约探针，不是未来实现验收。未改方案、业务代码、活跃worktree或git记录，未读真实凭据/访问生产服务；临时副本与夹具均删除，本bot无自动监控。
