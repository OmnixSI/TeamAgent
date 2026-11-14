结论：仍需修改；基线main 0f67b28，只复核R1–R9；R1混跑仍有P1，不能称7项P1已全部关闭。
P1【R1】方案:95、src/fetchjobs.ts:188–209、runner/fetcher.mjs:180：先换新fetcher仍不安全；旧payload短链若解析到p2，新回报page=2被旧Worker丢字段，实证HTTP200并把第二P字幕存进bili:<BV>，新Worker随后又按第一页兼容读。须规定旧payload强制旧第一页语义，或握手后才启用新分P，覆盖正向部署和回滚窗口。
P2【R1/R9】方案:93、97、runner/fetcher.mjs:177–181：av170001其实通过旧SHORT正则，非“无效任务”；BV~p2的旧失败reason是中文“视频内容未读到”，按新枚举只能成invalid而非runner_outdated。须明确识别旧runner/协议不兼容失败的分支，补反向混跑测试，不能只检查成功回报缺page。
P1【R2】方案:77、runner/fetcher.mjs:176–180：旧payload不止BV/短码，现有无链接卡片还走t-<hash>+title；“无v2则按BV或短码”遗漏这条真实路径。字段表主体已贯通，但必须明写旧title分派与TitleMiss/ambiguous转换，并补旧Worker配新runner的标题成功/无匹配回归。
P2【R6】方案:148、src/worker.ts:705–734、src/d1.ts:31：预读写门槛=2×10+2×2+16+4=44；实际入口剩39，读缓存后38，正常聊天此前至少已执行5条SQL，因此该写入分支进不去。须按当前阶段剩余必需开销重算，保证至少有可达的缓存写入路径。
P2【R8】方案:280、295–305、src/worker.ts:718–720：msgref只在startVideoWait写入，但缓存命中会跳过它；实证已有resource+alias时，新消息命中缓存、等待数0，按方案source_id查询返回0行。须在命中和未命中两条路径统一记录来源映射，context同步使用并保留match来源。
P2【R7】方案:348、362、380：允许两个渠道共同返回旧头条并agreed，却仍说“截至HH:MM最新一条”，且验收规定人工看到更新即打回，三者冲突；算法可实现，但须统一为“两个渠道当前返回同一条，未确认最新”，或一律unconfirmed，不以去掉“绝对”代替新鲜度声明。
通过项：R3明确CHAT路由、Worker消费分支、共享due_at与wakeVideoWait幂等；R4临时结果数组/整批handoff/保存新pending及turn自洽；R5源子预算和body共用signal可约束超时；R9外部标记、read_x taint注册及partial保留成功均已明确。
R6重算：计时由每模型+2SQL改为末尾最多+1，left>=1保证这次flush不越48；上轮B3基线44→45，另加一条预读查询时为46。等待路径msgref+1、deadline job+1，get_work_status每次+1须分别计入；未实现前不能据这几个算例证明全部路径≤48。
验证：隔离调用真实旧reportFetch、runJob及缓存命中聊天路径，另执行方案SQL与预算算式；未重复上一轮144项基线测试，未访问真实服务、账号或外部X接口。
边界：方案和业务代码均未改，活跃worktree仍只有原有.agent未跟踪项；临时快照与全部自写探针已删除；以上“通过”只指方案契约可执行，不是新实现已经验收。
