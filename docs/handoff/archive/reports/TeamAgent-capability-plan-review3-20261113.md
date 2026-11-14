结论：需修改；P0无，P1仍有1项，前轮9项中8项已关闭、1项未关闭。不能按现文全部开工，须先修正read_evidence判据。
范围：固定代码main 0f67b28；P=任务目录plan-bot-capability-v1.md v1.2；F=同目录plan-fastlinks-v3.md；Fw=TeamAgent-fastlinks/.agent/plans/plan-fastlinks-v3.md；只聚焦review2点名项。
验证：提取方案原函数及本机DSH原生读取窗口/格式化函数跑合成文件；证据判据10例中8例符合要求、2例复现误判；字节24例通过；另跑深度8例、派发23例契约模拟、回收6例与marker时效、resume往返及双文件比对。
1）P1【未关闭】假成功——P:948–975尤其:964只去行号，未去DSH包装；空glob/无read+final completed均已正确失败，但真实格式的空文件、纯空白文件仍产出ev=[文件]，非空final即done。依据：runner/execute.py:204–213的JSON/final接入点；本机dsh-tool-fs/lib/index.js:55–60允许空文件、:104–115输出<path>/<type>/<content>和EOF提示，:315–322用于read结果。已用临时探针复现。
   必须改：P:964只统计真实文件编号行的非空正文，剔除XML封套、EOF/分页提示；或消费可核实的结构化read内容。S-13/S-19补本机原生空/空白结果反例；仅用空字符串或裸行号构造测试不够。
2）P1【已关闭】深度闸——P:866–875完整tools生成allowedNames，循环入口拦截也覆盖resume.pending，并在runDelegate/createProjectTask双入口拒绝subagent；对应semantic.ts:834–836、938–939。契约模拟未提供调用、pending和直调均拒绝，未发生派发。
3）P1【已关闭】孤儿回收——P:901–919补两阶段marker、空pid跳过、ps启动时间与reader命令双核及900秒时效，符合execute.py:50–60和reload_runtime.py:12、21接线；原文信号分支6例模拟符合预期，旧marker不挡重载。所有信号均替换为记录器，未杀真实进程；完整崩溃恢复留实现验收。
4）P1【已关闭】内联回归——P:54–77与F/Fw:373–399保留单一三态分类及原R4分支，单个read_web/read_x仍inline、delegate混读取handoff；23例分类契约模拟通过。原测试1–7明确要求不改；方案尚未实施，本轮未声称这些集成回归已跑通。
5）P2【已关闭】字节边界——P:123–131的原cutBytes函数实跑中文、emoji、ASCII及0/小边界/11998–12000共24例，编码长度≤n、无替换符、保持前缀；与worker.ts:1204–1206、2305–2315入口上限契约配套。
6）P2【已关闭】resolved_sha——P:687新表列无需ALTER，:807–812校验40位sha并存列，:846由该列取sha7，:1002回报prepare所得sha；已贯通移动ref到投递的来源契约，不再用当前head冒充。
7）P2【已关闭】code_exec接口——P:1097–1108在semantic内分流，createProjectTask(e,a,context,messages)无batch参数且不导出，来源原样context.batch?.find||context.latest；对应semantic.ts:1083–1087，原授权及0002口径未被改写。
8）P2【已关闭】失败记录resume——P:542、551覆盖初始化恢复及全部handoff载荷；与semantic.ts:863–871、worker.ts:559–573的payload恢复一致，JSON往返保留安全裁剪失败三件套，旧payload回退空数组。
9）P2【已关闭】双方案同步——F与Fw:394–399的R4补充逐字一致（SHA256 162e01d402988f900c6f26260661e186210fb696d3230c2680fde1aef0ffc8a2），与P:46–77三态优先级一致。
新增文字扫描：未发现另一项可确认的新P0/P1；第1项是旧P1未完全关闭。上述“已关闭”指方案合同足够明确，不替代实现后的安全/故障/集成验收。
边界：实际仓库入口目录缺失，使用现存TeamAgent-fastlinks worktree的固定git对象只读核查；未修改方案/业务代码/活跃worktree，未访问真实服务、账号、Cookie、密钥或Edge profile，未安装/部署/提交。全部自写探针和合成文件已删除；本bot无相关自动监控。

v1.3 聚焦复核（2026-11-13 悉尼00:57）：结论【已关闭／本项通过】；只复核剩余“假成功”P1，未发现本次新增函数引入的新P0/P1，其余8项沿用上轮结论。
方法：直接提取方案P:954–984的NUMBERED/result_text/body_chars/read_evidence执行；合成文件经本机dsh-tool-fs 0.2.2-rc.1原buildWindow/formatReadOutput（lib/index.js:65–115）生成原生read文本，未改写待审函数。
结果：31组body_chars＋read_evidence夹具、5组事件守卫，共36组全部符合预期；S-26:1057列的空/空白、冒号与箭头仅行号、BOM/零宽、分页、内容块列表、未知格式均覆盖。
原P1反例：原生空文件、纯空白文件均body_chars=0、ev=[]；即使final completed且有总结文字，也按P:988–994进入failed/not_found、answer为空。空glob、无read、read错误、仅上下文、越界路径同样无证据。
正文保留：正常及分页“# Title”均为6字符；原生编号行内以123abc、2026: value、1: content、9→arrow、2026、0、1| pipe、制表符＋数字开头的8例正文全部保留，未把正文的第二层数字当行号再剥。
封套检查：路径含123:README.md、EOF/分页/截断提示均不增加计数；正常/空内容块列表及{text}/{content}容器分别正确接受/拒绝；无编号的未知格式按合同拒绝，不以封套或路径补成功。依据P:954–966、982及DSH原生formatter:104–115。
边界：这是方案函数与原生格式的离线验证，不等于真实DeepSeek、完整子代理执行/回报已验收；未改方案/业务代码/活跃worktree，未接触真实服务、Cookie、密钥；临时夹具已删除并核验，本bot无自动监控。
