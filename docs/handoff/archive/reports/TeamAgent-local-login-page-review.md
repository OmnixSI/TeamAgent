结论：打回（7555285 对 057bb8f）；P0无，P1两项，P2见下；只审不改。
P1-风控绕过｜runner/local_bili_login.py:27、:96、:119 新建独立urllib请求，未共用fetcher的限速/暂停/登录锁；独立实证：真实FetchClient.pauseForRisk后Python仍生成二维码；连续5次模拟412产生5次请求，未建立暂停。
修法｜让新页面复用同一个本机请求调度器，或跨进程共享原子限速/风控/登录锁；412/-352停止取码与轮询并中文提示，所有入口均受同一暂停约束。
P1-流程并发/过期提交｜runner/local_login_page.py:23、:25 获取按钮无busy/代次保护；实际onclick连点两次、反序响应后出现2个SVG、2个1200ms轮询且旧响应覆盖current；local_bili_login.py:105保留多个会话，:124写入前不复核有效期。
同项实证/修法｜真实Python会话3次start留下3个有效会话；阻塞poll后推进181秒仍返回ok并写Cookie。应单活跃代次、刷新先取消旧任务、串行轮询、丢弃迟到响应，写Cookie前原子确认会话仍有效且未过期；当前owner.py:129没有取消接口，cancel()未接线。
P2-旧码残留｜local_login_page.py:22–23，倒计时归零及failed/expired分支未清空qr；独立VM推进180001ms后过期文本出现但旧SVG仍在。清除SVG/旧会话并停止轮询。
P2-沙箱验收未满足（原有问题未修）｜runner/browser-auth.mjs:72只移除--enable-automation；实际启动函数替身捕获chromiumSandbox=undefined，用[Playwright 1.65.0官方参数构造器](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/chromium/chromium.ts)重算仍含--no-sandbox。显式chromiumSandbox:true并验证实际启动参数。
P2-未实现默认浏览器要求｜owner.py:82–85、owner_unlock.py:101、browser-auth.mjs:55只要装了Edge就强制Edge；捕获启动channel=msedge。登录页应通过系统默认浏览器打开；X需要独立资料夹的限制应明确，不能把“装了Edge”当作“默认浏览器”。
鉴权实证通过｜新4接口和ai-tokens/admin共6类：无会话401、恶意Origin/Host403，云端/启动调用均0；匿名/login只返回静态页，无QR。127.0.0.1绑定、统一路径解析、一次性解锁未被绕过；私有解锁目录0700/文件0600、重复兑换拒绝。
凭据实证/代码核对｜Cookie落盘0600、secrets目录0700；真实_report请求体仅service/state/checked_at，无QR/key/Cookie；owner日志关闭且异常对外为固定文案。二维码由内联SVG编码，不依赖外部图片/脚本；没有发现新增凭据上云路径。
旧问题复核｜[issue #10](https://github.com/OmnixSI/TeamAgent/issues/10)：解锁码仍经open argv且owner.py:83新增同类入口；旧Cookie兼容未修；src/worker.ts:1341空闲闸仍只查jobs/tasks/outbox，新Python内存会话更不可见，重启会丢失当前扫码。仍列暂挂P2，不能宣称已解决。
验证｜隔离副本/tmp/teamagent-local-login-review-fq3kiywk：自写HTTP/VM/状态竞态/浏览器替身探针均已运行；作者local_login_page_test.py 4/4、test_browser_auth.mjs 16/16通过，JS/Python语法检查通过；测试未覆盖上述失败路径。
边界｜未提供本次交付员验证报告，未重复全量构建；未访问3391、真实~/.inkboard-team、日常Edge资料夹或真实账号，未启动真实浏览器；源码只读，临时探针已删除，不提交/推送/部署。

复审 2（2026-11-12；fd6e43d 对 7555285）：结论：打回；P0无，原两项P1仅部分修复，仍有以下实证阻塞。
已修实证｜新Python真实_http＋模拟上游412：连续5次start仅第1次出网、随后4次拒绝；新risk文件0600。原“过期poll写Cookie”探针推进181秒后返回expired、不落Cookie；同页连点只生成1个二维码/1个轮询，倒计时清除旧SVG。
P1-共享暂停未接入生产｜runner/fetcher.mjs:187仍createFetchClient({log})，未传riskPath；:165的pauseForRisk也不落共享文件；browser-auth.mjs:101的备用创建入口同样漏接。独立探针：按生产参数创建的client忽略Python未来暂停文件仍请求；即使传riskPath，pauseForRisk后文件仍不存在。
修法｜生产/CLI/备用客户端统一接入runtime/state/bili-risk.json；所有暂停入口、isPaused/请求闸读取同一权威状态，持久化暂停，补真实入口双向联动测试，不能仅测手工传riskPath。
P1-流程竞态仍在（后端）｜runner/local_bili_login.py:138–152在generate前释放锁；两个线程同时start实证发出2个generate、返回2个不同id，其中1个id立刻expired。应原子占用生成状态或合并在途请求，跨标签页/线程也只产生一个有效流程。
P1-流程竞态仍在（前端）｜runner/local_login_page.py:23只在await前核对current，回调使用全局poll/deadline；实证：旧A的status在途→到期清码→生成B→旧A返回expired，B二维码被删、B轮询被取消。须捕获id/代次与timer，await后再核对，并串行poll，旧回调只能清理自身。
P2-共享文件一致性｜local_bili_login.py:43–54、fetcher.mjs:65–66仅原子rename，无跨写者锁/最大截止合并；延迟旧写者rename实证覆盖新暂停，截止减少100000ms。另损坏JSON被静默当无暂停，独立Python探针仍出网。需原子单调更新、损坏状态诊断与受限恢复，避免提前放行。
文件/凭据核对｜Python临时文件O_EXCL/O_NOFOLLOW＋0600；Node仅mode0600且临时名固定PID，建议统一安全写入并确保既有目录/临时文件权限。风控文件只含paused_until；本轮diff未增加Cookie、QR、key上云/日志/argv路径，原解锁码argv暂挂项仍在。
沙箱已修（代码层）｜browser-auth.mjs:68显式chromiumSandbox:true。独立调用并用[Playwright1.65.0官方Chromium参数构造器](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/chromium/chromium.ts)分别重算msedge/chrome，均不含--no-sandbox；源码按该选项控制参数，无macOS禁止true分支。真实Edge/Chrome启动及系统策略兼容未验证，不能承诺一定启动成功。
Edge验收口径｜按本轮明确简报，优先Edge不再列问题；上一轮该项P2撤回。浏览器仍使用独立browser/x资料夹，未触及用户日常资料夹。
验证｜隔离副本/tmp/teamagent-local-login-r2-8o918bsa，自写Python/Node/VM/文件并发探针已运行；local_login_page_test.py 5/5、test_browser_auth.mjs 17/17、diff空白检查通过，作者测试未覆盖上述生产接线及迟到回调失败路径。
边界｜只审不改代码/分支，临时探针已删除；未访问3391、真实~/.inkboard-team、真实账号/浏览器，不提交/推送/部署。本次未收到独立交付员验证报告。


复审 3（2026-11-12；9785bde 对 fd6e43d）：结论：打回；P0无，P1两项未完全修好，P2如下；只审不改。
测试：隔离快照独立Python/Node/HTTP/VM/跨进程探针已运行，以下问题均已用临时测试复现；相关Node现有测试67/67、Python登录页测试5/5、diff空白检查通过。
原P1-共享暂停接线已修好｜执行生产main函数体并替换外部依赖，确认fetcher.mjs:189传正确riskPath；browser-auth.mjs:101备用入口也读同一路径；未来暂停下CLI登录0请求/0浏览器启动，Python登录接口503且0上游请求，pauseForRisk真实落盘。
P1-共享暂停仍未修好｜runner/fetcher.mjs:65限速等待前读文件，await sleep后仅查内存；探针在等待期间写入未来共享暂停，第二次biliApi仍成功出网，请求数1→2。后果：Python建立风控暂停后抓取仍请求；修法：睡眠结束、发请求前再次读取权威暂停并拒绝。
原P1-部分已修好｜LocalBiliLogin真实双线程start仅1次generate且相同id；阻塞poll推进181秒后返回expired、不写Cookie；VM同页双击仅1次start，旧A迟到expired不再删除新B二维码，倒计时也清旧码。
P1-流程并发仍未修好｜runner/local_login_page.py:23仍setInterval(async…)且无在途保护；local_bili_login.py:189–191成功先清会话再同步上报。真实双poll探针：Cookie已写入、首条阻塞上报时第二条先返回expired，首条稍后ok；VM重放最终显示“二维码已过期”并丢弃ok。修法：串行轮询，后端完成结果按id保留并幂等返回，覆盖慢响应/慢上报。
P2-共享文件一致性未修好｜local_bili_login.py:56–69仅实例内锁，fetcher.mjs:66无跨进程锁；延迟Python rename，让独立Node进程先写更晚截止，随后旧rename使截止实减100000ms。后果：提前恢复；修法：所有写者共用进程间锁，在锁内读取/合并最大截止并原子落盘。
P2-迟到异常未修好｜runner/local_login_page.py:23的catch没有myTimer代次检查；VM旧A请求在B生成后reject，B二维码仍在但状态被旧错误覆盖。修法：成功与异常分支都先校验当前代次。
P2-鉴权验收不符｜runner/owner.py:125–126在鉴权前返回/login，HTTP实测未解锁200，非简报要求的401；只有静态引导、无二维码/凭据，未发现由此越权。修法：区分解锁引导与受保护内容，落实约定的未解锁响应。
原P2-损坏JSON已修好｜Python真实_http和Node真实biliApi读取“{broken”均保守暂停，0请求；Node isPaused也为true。
原P2-沙箱配置已修好｜browser-auth.mjs:68捕获chromiumSandbox=true且显式args无--no-sandbox；与复审2已核对的参数构造逻辑相同。本worktree无Playwright运行依赖，未启动浏览器，不能把配置核对称为真实进程argv验收。
鉴权其余探针通过｜5类本地业务接口无会话均401；恶意Host/Origin均403；解锁码第一次兑换200、第二次403；实际监听为127.0.0.1，本轮探针仅用随机临时端口。
凭据探针通过｜合成Cookie落盘0600、目录0700；真实_report序列化仅service/state/checked_at；二维码由本机SVG呈现，key仅在鉴权后的本地qr_url和官方轮询中使用，未发现新增key/二维码/Cookie外传路径。
Edge口径可接受｜代码为安装Edge则优先Edge；按简报给定“用户默认浏览器就是Edge”，本机效果符合要求，不列问题；未读取系统浏览器设置。
边界：未收到本轮独立交付员验证报告，不重复全量构建；未访问真实服务/账号/Cookie、3391或真实运行目录，未核对桌面已安装版本；临时探针和隔离快照已删除，仓库代码未改，无git写操作。

复审 4（2026-11-12；f1104d4 对 9785bde）：结论：打回；P0无，新增P1一项；原两项P1指定场景已修，P2-a仍未修，逐项如下。
P1-1已修｜fetcher.mjs:65；独立Node探针在限速sleep期间写入未来暂停，唤醒后拒绝，真实请求数保持1，不再1→2。
P1-2已修（原重叠场景）｜local_bili_login.py:188–214；真实双线程status：首个已保存合成Cookie并阻塞report，第二个等待，最终两者均ok，仅1次上游poll；VM连续两次tick也仅发1次请求，ok后旧tick不覆盖终态。
新增P1｜local_bili_login.py:208–212在_save成功前写_finished[id]='ok'；独立探针令_save抛OSError，首次status=failed、第二次=ok，Cookie文件不存在。多标签页/重复查询会误报已登录。修法：保存成功后再原子提交finished=ok，失败不可留下成功标记；补磁盘失败/不完整Cookie回归。
P2-a未修｜fetcher.mjs:66、local_bili_login.py:54–90两端确实用同一bili-risk.json.lock，但等待100×10ms后无论held是否真仍写。跨进程实证：Python持锁延迟rename，Node超时后照写，再被旧rename覆盖，截止减少100000ms。
P2-a崩溃恢复｜预置很旧的残留锁，后续_pause约1.2秒返回且仍写，锁目录仍在；不是永久阻塞，却会永久退化为每次等待后无锁写，无过期/死进程清理。应记录锁所有者/租期并安全回收；未获锁不得更新共享值，保留单调最大截止。
P2-b已修｜local_login_page.py:23；独立VM旧A的expired和reject分别在新B启动后返回，均不改B的二维码/提示；myTimer代次与pollBusy回收后B能继续poll。
P2-c可接受｜匿名/login200是静态引导，供#unlock加载后兑换，理由成立；独立HTTP探针确认不含实际会话/凭据、不创建会话、不取码。五类受保护本地业务接口无会话均401，恶意Origin403；首次兑换/60秒过期/重启失效检查通过。撤销上轮“静态引导必须401”的验收项。
P2边界｜local_login_page.py:22–23仍会在倒计时归零时清poll；VM在途成功ok刚好跨截止返回后仍显示过期。应给已在途的确认结果一个有界收尾，或查询后端已提交终态，不能把已完成扫码误报过期。
保留项｜真实双线程start仍1次generate/同id；合成Cookie0600、secrets0700；独立browserOptions验证Edge优先，browserLaunchOptions的chromiumSandbox=true、args无--no-sandbox。未实际启动Edge/Chrome或读取真实Cookie。
验证｜隔离快照/tmp/teamagent-login-r4-8be75cpe：以上自写Node/Python/VM/HTTP/跨进程探针已跑；现有Node相关测试74/74、Python登录页测试5/5通过。未收到独立交付员验证报告，未重复全量构建。
边界｜只审不改代码/分支，不访问3391或真实~/.inkboard-team，不核对用户桌面已安装版本，不push/合并/部署；临时探针已删除。本轮通过的单测不覆盖新增P1失败路径。


复审 5（2026-11-12；7d12b22 对 f1104d4）：结论：通过；P0/P1无，P2-a部分未修，不能称所有问题均已解决。
测试｜隔离快照独立Python/Node/HTTP/VM及真实双进程探针；现有Python登录页7/7、Node抓取/浏览器/二维码51/51通过；未收到独立交付员验证报告，未重复全量构建。
P1已修｜runner/local_bili_login.py:217–219保存成功后才提交ok；真实_save在rename处注入OSError，首次/第二次均failed、无Cookie/成功上报，解除失败后同id返回ok且重复查询仍ok；旧f1104d4对照为failed→ok。已用临时测试复现并验证修复。
写盘/状态补查｜不完整Cookie两次failed、不落盘；双线程start同id，阻塞保存时第二个status等待，恢复后均ok，仅一次成功上报；合成Cookie0600、目录0700。未发现新增P0/P1或凭据外传。
P2-a部分已修｜runner/local_bili_login.py:74、runner/fetcher.mjs:66：两端同一目录锁；新锁超时约1.2–1.4秒后均不写，60秒残留锁均可回收；真实Python持锁/Node争用及6轮同时双进程写入，正常场景最大截止保留。
问题P2-回收竞态｜runner/local_bili_login.py:66–67、:98与runner/fetcher.mjs:66仅凭mtime回收且无持有者校验；真实Python写者持锁、算好值后停顿31秒，Node回收并写较晚截止，Python恢复rename将截止缩短31003ms（真实时钟，无时间偏移）。已用临时测试复现。
修法｜回收前区分仍存活的持锁者，写入及释放须验证锁所有权；采用双方一致、进程退出可释放的互斥协议，避免只凭目录年龄抢锁。该项仍为P2，不影响按工作室约定通过。
P2-c可接受｜runner/owner.py:125–126、runner/local_login_page.py:24：#unlock需先加载静态页再兑换，HTTP匿名/login=200且无实际二维码/会话/配置凭据、不创建登录实例；VM匿名0请求，带合成片段先兑换再取码，理由与实现一致。
鉴权保留｜五类/api/local业务入口未解锁均401（session兑换入口独立校验一次性码）；本轮未改鉴权代码。Edge优先与chromiumSandbox=true由现有Node测试确认，未启动真实浏览器。
旧P2边界｜复审4所列local_login_page.py:22–23“在途ok跨倒计时截止被丢弃”代码未改，本轮未重跑，继续保留原记录，不视为已修。
边界｜只审不改源码/分支；未触碰3391、真实服务、账号、Cookie或~/.inkboard-team，未核对桌面已安装脚本；无提交/push/部署。临时快照及全部自写探针已删除；本bot无相关自动监控。
