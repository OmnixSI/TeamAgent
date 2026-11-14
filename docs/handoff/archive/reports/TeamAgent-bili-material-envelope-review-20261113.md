结论：通过。只复审41d200c之上的素材封套差异，原“先包后截丢结束标记”已关闭，未发现新增P0/P1。
实现：src/fetchjobs.ts的videoMaterial先扣完整空封套长度、Math.max(0,正文预算)，titleMaterial/titleMissMaterial接收正文上限，research不再对包装成品slice；总量剩余额度同样在包装前传入。
长素材：定向F-T1b–g八项全绿，覆盖7000字字幕、标题匹配、伪造首尾标记、续跑system消息及三份素材分配4000/4000/≤2000，总量≤10000；各份≤4000且完整结束。独立六组长标题/多空行简介/超长字幕在4000、2000、1000上限均通过。
极小上限：普通视频、标题路径及none/multiple未命中素材，分别在max=-10/0/1/10/40共30例不抛异常、正文为空、不发生负数截取，并保留最小完整封套（极小max小于封套时不承诺总长≤该max，research仍会检查剩余总预算）。
变异：只在临时副本将videoMaterial改回“先完整untrusted再slice(0,max)”，新F-T1e的总预算/直接包装/续跑system断言均变红；原修复版定向八项＋独立两项测试通过，变异已还原且临时副本删除。
范围：diff 41d200c只有src/fetchjobs.ts、src/bilititle.ts、test/fetchjobs.test.mjs三文件，无semantic.ts或无关文件；三文件冻结SHA256=7936a673356401a5e183b543b381eb61d09a47431628d5423adfb23a57af9a93，结束时复核工作区仍一致。
边界：未改交付代码/worktree、未提交/部署、未访问真实服务或凭据；未重复已通过的其他轮次检查。真实模型措辞和线上验收留交付执行，本bot无自动监控。
