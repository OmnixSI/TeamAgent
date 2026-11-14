结论：打回；P0无，P1一项，P2三项。样本短链素材补回及完整BV号已通过重放，但新research全历史扫描会突破查询预算。
版本/依据：审查agent/bili-reply-materials提交bce4c961，基线origin/main=210ed474；先读.agent/bili-fix-baseline.md及两份b23证据。所有执行在临时git archive副本，未改交付worktree。
P1 src/fetchjobs.ts:145–163、worker.ts:578：无条件收集batch/recent全部视频，逐ref查缓存，未命中再查outcome，无数量/余量/总文本限制。真实queue探针：24条历史短链＋当前普通代码问题，62次D1 API调用，首个模型请求前已57次（项目语句计数64），超过免费50及项目48；24条命中缓存则注入145463字符。已用临时测试复现。须只取本轮videoTarget/明确引用目标，固定小量或批量查库、预留预算，并封顶素材总长；补无关recent不触发素材查询及最坏预算回归。
P2 runner/fetcher.mjs:120–122：av转换把请求异常吞掉，且不检查view.code，实际412、-101、-404均变unsupported，错误宣称“不是普通视频”。已用原fixture复现。须传播网络/风控异常，按API code交给现有classify；只有终点确属非视频才unsupported，补av风控/权限/不存在/超时测试。
P2 src/worker.ts:580–582：已有resume.messages通常已含前台素材，此处再盲append。真实chat→get_project handoff→research（pending含1个真实调用）复现同一BV在消息里1→2份；应按目标ref更新/补缺，不重复追加，保留pending/tool_call对应次序；测试须用真实handoff载荷。
P2 test/fetchjobs.test.mjs:54–59：缺素材断言检查模型请求根部x.materials，但素材位于messages中的JSON/文本，属于空断言。临时把未缓存分支改成p.materials=[编造素材]后F-T1b仍全绿。须解析/遍历实际messages检查，并断言未就绪时video_waits/唤醒、终态失败原因分别正确，不能只测没抛异常。
主样本重放：MV29F7r缓存bvid=BV1GN4p6pEEP、695秒、无字幕的F-T1b/F-T1c均通过；新biliNoteText:130显式携带完整BV号，尚不能据合成回复声称真实模型一定不再推断错误编号。
安全/文案：videoMaterial仍经untrusted，恶意标题/热评中的伪结束标记已被转义；单份biliNoteText有6000字符上限，缺的是上述总量限制。未发现新SSRF/命令注入：-/_只进固定HTTPS路径，无shell；fetcher短链请求仍仅b23.tv，入站bili2233.cn被归一为同码；手动重定向终点仅bilibili.com/www/m，DNS公地址检查保留。真实别名码空间覆盖未现场联网验证。
回归杀伤力：去掉resume补入→F-T1c红；去掉BV号行→F-T1b红；SHORT退回4–12位字母数字→N6b红，恢复后原3测试均绿。另有上列“编造素材”变异存活，不能把这三次变红当作等待分支已覆盖。
Python对比：用指定/usr/local/bin/python3（3.12）在base及bce4c961分别完整discover，各175项、0失败0错误（约84秒）；本环境未复现工程师记录的8fail+2error，未独立证实其外层sandbox限制，但确认两版本结果一致。未重复交付员已做的全量Node/构建检查。
边界：未访问真实QQ服务、账号、Cookie或密钥，未发消息/部署/提交；全部临时副本、变异和夹具已删除并核验。当前job结束后重新执行同一payload的幂等、真实模型措辞和线上资源指标仍需实现修正后验收；本bot无自动监控。
