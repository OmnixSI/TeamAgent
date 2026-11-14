结论：打回；范围 58e640b~1..ea78a7f（17 文件），含 58e640b 对 02f19c4 的返修。P0：无；P1：1 项新增；P2：原项已修，本轮无新增。
原 P1 已修｜runner/browser-auth.mjs:96、:141、:162、:180；runner/fetcher.mjs:184：独立临时探针证实共享客户端暂停时 check/login 为 0 请求、0 开窗；持续 HTTP412/code=-352/-412 各只探活 1 次即停（不再 150 次），后续探活零请求；fetch→nav→fetch 间隔均≥1200ms。
原 P2 已修｜runner/browser-auth.mjs:87、:190：原场景 X503、空白页、导航失败均返回未知并保留原 ok 文件，无 expired 回报或提醒；明确登录页/登录框仍由 L16 验证过期。
新增 P1｜runner/qr-login.mjs:55、:56、:58；src/login-flow.ts:10、:60：二维码 URL 中的 qrcode_key（同一个 poll 用来领取 Set-Cookie 的轮询凭证）经 cloud(login-state) 写入 D1，又由 Worker owner GET 返回；不能视为无敏感性的展示字段，违反「登录凭据不上 Cloudflare/D1」红线。
P1 实证｜临时脚本通过真实 Worker+隔离 SQLite 创建/领取/上报流程，从 settings('login-flow:bili') 及 owner 响应均恢复出同一个测试 key；独立客户端不带 Cookie 即以它构造 poll 请求并接收模拟成功 Set-Cookie。证明凭证流向与客户端复用能力，未进行真实扫码或声称真实会话已被窃取。
P1 修法｜二维码 URL/图像经 127.0.0.1 本机接口直传管理页，轮询 key 只保留本机；Worker 仅中继不含二维码凭证的请求 ID、phase、时间、risk。仅将 URL 改成图片/base64 仍可解码，不能消除上云问题。
本机入口/CSRF｜runner/owner.py:16、:77 的监听确为 127.0.0.1，固定 Host/Origin；真实临时 HTTP 服务测试：同源 POST=200，恶意 Origin/null Origin/错误 Host=403，跨站预检=501，均未转发。未发现未授权跨站开窗路径。
边界说明｜src/worker.ts:1693：Cloudflare 的 /api/team/service-login 并非仅 loopback 可达，而是 owner Bearer 鉴权可达；缺身份401、普通成员403、runner 通道单独鉴权已由接口测试通过，不能把这些等同于二维码从未经过云端。
Cookie/日志｜runner/fetcher.mjs:69、:81；runner/qr-login.mjs:66–79：除上述扫码 key 外，未发现密码、验证码、会话 Cookie、成功跨域 URL、refresh_token 被回传/记录；带哨兵的 API/passport/fingerprint/字幕/短链实测，仅 api.bilibili.com 的 API 请求带 Cookie，日志不含哨兵；现有端到端夹具亦验证上报过滤。
权限/安装｜runner/browser-auth.mjs:16–35、:128；scripts/install-local.py:80、:140：Cookie 原子写入0600，secrets/browser/profile 目录0700，新增 .mjs 随现有安装流程复制；权限夹具与已有安装验证通过，未对真实 HOME 执行安装。
取消/期限/离线｜src/login-flow.ts:23–63、runner/qr-login.mjs:41–91：并发去重/单次领取、旧回报409、取消清二维码、超时隐藏、两分钟离线提示均有接口/UI测试；独立探针确认 X 导航挂起时第二次心跳409会关闭上下文并返回 cancelled、不写 auth 状态；QR 的412/-352/-412均在 generate+单次 poll 后停并共享抓取暂停。
验证｜已读 .agent/login-web-{test,runner,clients}.log；隔离副本 /tmp/teamagent-login-web-review-ez2ak1bm 自跑 npm run check、npm test（356/356）、runner 三测试文件（63/63，含重复导入）、npm run check:ui、git diff --check 均通过；另跑原 P1/P2、跨站请求和扫码 key 流向探针。
未验证｜没有真实手机扫码、真实两站账号登录或实际 Chrome 窗口/验证码验收；二维码仅有参考矩阵及模拟 DOM 验证。未改项目代码/分支、未提交/部署、未读取真实 Cookie 或 .env；临时脚本已删除、不提交。

复审 2（2026-11-12；29eb6a0 对 ea78a7f）：结论：打回。原「二维码凭证上云」P1 已修；新增 P1×1、P2×1；P0 无。
原 P1 已修实证｜runner/qr-login.mjs:34、:57；src/login-flow.ts:51：独立完整探针使用真实 runLoginFlow/createFetchClient、模拟 B 站 HTTP、真实 Worker+隔离 SQLite，覆盖等待→已扫码→成功；记录全部云端请求体、SQL绑定/最终行、响应及日志，均不含测试 qrcode_key、二维码 URL、Cookie、refresh_token 或成功跨域地址。
新增 P1｜runner/owner.py:19–32、:55：新 QR 接口仅检查 Host/Origin 和固定 X-TeamAgent-Local:1，没有 owner 会话或私有凭证；任意可连接 loopback 的本机客户端能绕过文件0600所表达的隔离取得扫码能力。固定头是跨站防线，不是身份认证。
P1 复现｜独立子进程不带 Authorization、Origin、Cookie：GET /api/team/service-login 得流程 ID，再 GET /api/local/service-login/qr?id=该ID（仅加公开固定头）返回200及二维码 URL；POST 登录请求也被代理代填 owner Token 转发。均在临时 HTTP 服务/假云端完成，未读取真实凭据或开窗；启动转发继承旧代理，新暴露内容是扫码能力。
P1 修法｜在本机 QR 读取及登录操作前验证 owner 会话或随机私有 capability，并保护其发放/页面引导入口；不能由匿名 owner 代理另取到相同凭证。保留 Host/Origin 检查。此项是本轮明确要求的「其它本机进程不能未授权拿二维码」尚未满足。
新增 P2｜web/app.js:1108、:58–68：新提示传入 http://127.0.0.1:3391，但 link() 只为 HTTPS 设置 href，远程 owner 看到的引导链接不可点击；独立执行实际 helper 证实 href=undefined。为这个固定回环地址设置专用链接，并补 href 断言，勿放宽任意 HTTP 地址。
网页/网络边界｜runner/owner.py:19、:106：只监听127.0.0.1，无 CORS 放行，no-store/no-referrer；独立 HTTP 探针确认恶意/空 Origin、缺自定义头被403拒绝，二维码读取不调用云端。远程 Worker 仍 owner 鉴权，但已不返回二维码；这不能替代本机客户端鉴权。
权限/清理｜runner/local-login-qr.mjs:9–18、runner/local_login_qr.py:45–56、runner/qr-login.mjs:92：运行中实测二维码文件0600、目录0700；正常成功及独立取消/超时/-352 探针均删除暂存、失败不写 Cookie；到期文件拒读，异常强杀后的物理扫除未实现/未验证。
旧数据｜src/login-flow.ts:14：独立插入 bili/x 两条旧 qr_url 后，首次 owner GET 即在返回前删除两者，状态与流程ID保留；这是读取时清理，不是部署迁移，本轮未对生产执行。
回归｜取消/超时/风控独立探针均仅1次 poll即结束并清理；-352 共享暂停仍生效。并发请求/领取去重、离线提示、X取消及原P1/P2边界随现有测试通过；Cookie仍仅 API 主机注入，安全字段回报策略未改。
验证｜隔离副本 /tmp/teamagent-login-local-review-9hf0umhp：npm run check、npm test（359/359）、npm run test:runner（Python成功、Node41/41）、npm run check:ui、git diff --check 均退出0；另有上述独立完整流、旧数据、HTTP子进程、退出清理、链接探针，临时脚本已删除。
未验证｜未扫描真实二维码、未使用真实账号/Chrome、未启动生产登录流程；未以另一OS账户实际运行客户端，跨账户风险来自回环HTTP接口缺身份检查。只审不改代码/分支，未提交或部署。

方案核查（2026-11-12；p4b-local-auth-fix.md，对照 29eb6a0 固定源码，未审并行中的实现）：结论：需补充；主体可执行，以下约束及测试补齐后可作为下一轮验收合同。
成立｜owner.py:17–60 确为匿名 loopback 代理代填 adminToken；web/app.js:1436 确会在127.0.0.1无凭证自动load；scripts/install-local.py:74–100 的0700桌面入口及 :121/:140 的.py复制机制均可复用；worker.ts:1215 的公开静态页不依赖Authorization。
成立｜方案§4（:30–35）在分支前统一锁全部 /api/*，覆盖 team/admin/local、GET/POST/PATCH/DELETE，以及 ai-tokens、pair、登录/取消/二维码；当前前端仅 api()（web/app.js:85）与 localServiceQr()（:1076）两条 fetch 路径。公开例外应精确限定方法/路径，静态页不得代填owner Token。
必须补/P1｜方案§5（:38）未明确把 #unlock 处理限定于 localOwner()；同一 web/app.js 也由远程 Worker 静态页提供（worker.ts:1215），若远程 origin 带片段时照该句执行，兑换 POST 会把解锁码发给Cloudflare。明确仅127.0.0.1:3391可兑换；远程片段可清除但不得提交、存储或附带到任何请求。
需补测试｜第10条增加“远程origin+合法#unlock”零兑换/零凭证上云；本机残留team-token但无local-session不得自动load（web/app.js:1、:1436）；api()与localServiceQr()各自收到401均清会话、隐藏旧app/二维码并停止轮询，不能只测一个helper（现 :95、:1081）。
需补测试｜第1/3条增加 GET或其它方法 /api/local/session 不可绕锁、公开GET /及/guide上游无Authorization/会话头；普通/PATCH管理员接口抽测401且零上游调用。第5条增加owner服务重启后旧会话失效；第11条保留X分支、路径引号/空格转义及新增Python脚本在staging/apply均复制的既有回归。
成立/边界｜43位随机码、私有目录与0600、rename原子认领后O_NOFOLLOW+fstat(uid/mode/普通文件)、内存哈希会话+锁+8项上限，足以覆盖不具备私密目录读取权的客户端；Host/Origin与固定头仍负责CSRF/rebinding。沙箱进程的保证需限定为“无法读私密目录、拿不到引导码”，不能泛指所有同UID进程。
建议/待验｜方案:85/:92 对跨UID进程参数可见性仍未确认；open 的 argv 实际包含完整码，60秒与单次使用不能消除抢兑窗口。上线前验证该OS边界，或选不把码放进跨UID可见参数的私有引导；在未验证前勿宣称已防住所有其它OS用户。fragment不进HTTP/Referer成立，但不能保证初始浏览器历史/恢复记录从未接触它。
测试充分性｜原11项覆盖主要安全合同；加上述origin/双401/旧token/公开例外/重启断言后足够进入代码复审，届时仍须原独立无凭据进程探针失败、合法解锁完整链路及二维码/会话均不上云。第9条应覆盖新session handler所有成功/错误响应及日志，不仅正常打印路径。
启用/未验证｜reload_runtime.py:5、:25–27 已包含owner重启；仅install-local --apply（:140–161）复制文件不会自行重启owner，应在交付核验重启后的匿名401与旧会话失效。本轮只读方案和固定提交并追加报告，未改方案/代码，未跑尚未实现的测试、未验证跨UID或真实浏览器历史。

复审 3（2026-11-12；413fbe0 对 29eb6a0）：结论：打回。P0无；P1×1（原本机鉴权问题仍可绕过）；原P2已修，无新增P2。
P1｜runner/owner.py:54、:56：鉴权以原始 self.path.startswith('/api/') 判定，二维码分派却用 urlsplit(self.path).path；HTTP absolute-form 请求不以 /api/ 开头，但解析后能命中二维码路由，绕过会话。
P1 实证｜独立临时HTTP服务、已存在且未过期的 known-flow：不带 X-TeamAgent-Session，发送 GET http://127.0.0.1:3391/api/local/service-login/qr?id=known-flow（Host为127.0.0.1:3391、固定头为1）得到200及测试二维码；同一资源的普通 /api/local/... 请求得到401。流程ID已知是触发条件，不能代替owner身份；全程未访问真实二维码。
P1 修法｜入口拒绝非origin-form的请求目标，或先统一解析/校验路径，再用同一结果执行会话检查和路由，保证任何二维码返回都先验会话；增加“普通路径/absolute-form均无会话401且无二维码/零云调用”的独立进程回归。
普通鉴权/会话已成立｜独立子进程访问8条team/local/admin接口及POST/DELETE/PATCH均401、零上游调用；合法码换会话后QR200、登录操作正常转发；上游只有adminToken、没有本机会话头；公开 /与/guide 不带Authorization；重建会话存储后旧身份401。
码/会话实证｜真实 mint/redeem：0600/0700、并发两个认领恰一成功、原码及claimed文件清除；已用码、60秒边界、0644、符号链接、不同uid模拟均拒绝；12h失效与第9会话淘汰最旧项成立；Host变体及恶意/null Origin均403。仅监听127.0.0.1，静默日志路径不含测试码/会话。
原P2/补充项已修｜web/app.js:71、:110、:1101、:1457–1480：独立VM执行实际源码，固定回环链接有href，通用HTTP链接仍拒绝；远程origin即便有#unlock及成员token也不兑换/发送该码；本机残留team-token但无本机会话零请求；api/QR两条401均清会话、隐藏app并显示中文解锁提示。
桌面入口代码链成立｜独立执行实际 launcher 生成函数和 owner_unlock.main（仅mock open）：launcher0700、zsh语法通过、X分支保留；实际mint后自动调用open且只用fragment、不打印；前端先replaceState再交换、存sessionStorage，实际selectView('system')触发带会话的state加载。未假称实机窗口已验收。
二维码不回归｜独立真实Worker+隔离SQLite+runLoginFlow探针覆盖成功/取消/超时/-352：全部云请求体、D1绑定/最终行、响应及日志不含key/URL/Cookie/refresh_token；每种终态都清本机QR，风险进入共享暂停；去重和此前Cookie主机边界随既有回归通过，本提交未改这些实现。
验证｜已读 .agent/login-private-validation.log；隔离副本 /tmp/teamagent-unlock-review-y6476yjr 自跑 npm run check、npm test（363/363）、npm run test:runner（Python成功、Node41/41）、npm run check:ui、git diff --check 均退出0；另跑上述独立HTTP/子进程/VM/桌面代码链/四种云边界流程，临时脚本已删除。
未验证｜无真实扫码、真实Chrome/手机或另一OS账户测试；open argv跨UID可见性与浏览器初始历史残留仍未验证，同UID可读私密文件的既定边界保留。未改项目代码/分支、未提交或部署。

复审 4（2026-11-12；95bcfbe 对 413fbe0）：结论：通过。原 absolute-form 鉴权绕过已消除；本轮 P0/P1/P2 均无新增。
原复现实证｜runner/owner.py:19–38：原 GET http://127.0.0.1:3391/api/local/service-login/qr?id=known 无会话请求现返回400，在鉴权/路由前被拒；普通无会话路径返回401，均不返回二维码、不调用云端。
独立攻击矩阵｜临时真实HTTP服务+原始socket共1645个匿名请求，覆盖7类受保护资源及GET/POST/DELETE/PATCH/get/HEAD/OPTIONS/CONNECT；含大小写scheme、userinfo、异主机/端口、authority、星号、//、重复斜杠、点段、%2e/%2f/%5c/双编码、反斜杠、空字节、66000字符路径、tab/空格、fragment、Host不一致及HTTP/1.0。全部4xx/5xx、零二维码、零云端调用，服务端stdout/stderr均空。
单一解析链｜owner.py:29 仅解析一次请求目标，生成route_path/query/target；:75/:77/:79用于兑换/鉴权/路由，:103仅用route_target转发，:123取消也用route_path。local_login_qr.py:35–41只收query串；其:20解析的是二维码内容URL，不是HTTP路由。独立计数确认合法QR请求的目标解析恰1次。
合法链路实证｜并发兑换恰一200/一403；带会话QR200，非法目标即使有会话也400；公开首页/guide及查询串正常且无Authorization；带会话发起/取消、ai/admin相同前置鉴权及查询转发成立，本机会话头不送云端；带query的取消成功后文件消失、再读404。
安全/回归｜独立探针复核0600/0700、60秒边界失效和重启后旧会话401；现有单次使用/符号链接/uid/容量/TTL/Host与CSRF测试通过。二维码凭据不上云、旧字段清除、取消/超时/防重复/共享风控随完整回归通过；本提交未改其生成、上报或清理逻辑，仅统一请求目标传递。
验证｜已读 .agent/request-target-validation.log；隔离副本 /tmp/teamagent-target-review-omc28j9r 自跑 npm run check、npm test（363/363）、npm run test:runner（Python成功、Node41/41）、npm run check:ui、git diff --check 均退出0。上述攻击与合法链路为自写探针，脚本已删除、不提交。
真机待验｜系统默认浏览器是否实际打开/自动解锁、手机能否识别真实B站码并完成确认、真实网络/验证码、X窗口、macOS通知、跨UID参数可见性及浏览器初始历史残留；本轮未启动生产服务或使用真实账号。
首次双击最可能的现场问题｜代码已更新但旧owner进程尚未重启/3391尚未就绪，导致页面打不开或兑换失败；冷启动浏览器若超过60秒也会码过期。发布验收应核对owner已重启（reload_runtime.py:5已包含它），再验证匿名401和双击后的自动解锁；当前只确认代码及隔离行为，未声称已发布。未改代码/分支、未提交或部署。

复审 5（2026-11-12；55e2178 对已通过的95bcfbe）：结论：打回；P0无，P1×1，新增P2无。
P1｜web/app.js:1103–1105、:1136、:1166：180秒前端截止时移除二维码和取消按钮、启用重试，但重试仅POST新登录；后台仍waiting/scanned时，src/login-flow.ts:4、:27–29的300秒TTL/去重条件会返回409，按钮虽可点却不能换码。
实证｜独立VM执行实际前端、真实Worker+隔离SQLite：创建并领取B站流程、报告waiting，渲染二维码→推进180秒→旧QR/取消按钮消失→点击实际“重新获取二维码”handler；得到409「该服务正在登录，请完成或取消已有登录」，未创建新流程。后台终态尚未回报时可触发，不能仅以按钮disabled=false证明重试可用。
修法/补测｜前端重试应先按旧flow.id取消仍活动的流程，处理已终态/已变更的幂等冲突后再创建；或在后台允许重建前保留可取消入口。补真实Worker联动的“3分钟本地过期但5分钟后台仍活动→点击重试→取得新flow/二维码”测试，勿只mock POST成功。
范围/隐私｜git diff仅web/app.js、test/login-ui.test.mjs，未触碰owner、local_login_qr、login-flow或其它runner鉴权/传输；新增deadline仅id/时间，新增timer标签仅秒数，未增加key/URL向DOM属性、日志、storage或请求体的写入。原SVG本机渲染保持原逻辑。
定时器/终态｜代码使用单个全局1s interval，无每卡片建timer；切页/隐藏时跳过，脱离节点清clock，重绘/失败/终态置空。生命周期回归测试通过，独立探针确认interval数量不增加、归零旧QR移除；没有做真实浏览器堆内存测量。
X文案｜web/app.js:1161明确在Mac弹出的真实x.com浏览器窗口登录、本网页不需要也不收密码；卡片无密码输入框。实际默认Chrome/Chromium窗口仍待真机验收。
验证｜隔离副本 /tmp/teamagent-countdown-review-b01xkdwt：npm test367/367、npm run check:ui、git diff --check均通过；独立点击联动探针复现上述409。既有测试只验证归零按钮可点击，没有验证其业务请求成功；临时探针已删除。
边界｜只审不改代码/目标分支，未提交、部署或重发消息；未打开真实浏览器或扫码。95bcfbe的后端安全通过结论不受此两文件diff影响。

复审 6（2026-11-12；61f9654 对 55e2178）：结论：通过。原倒计时重试409的P1已修，本轮P0/P1/P2均无新增。
原P1亲跑实证｜web/app.js:1097–1119、:1192：独立VM执行真实按钮handler，连接真实Worker+隔离SQLite（本机二维码供给为夹具）；180秒归零后点击，依次DELETE旧流程200、POST新流程200，取得不同flow ID与不同二维码，页面仅1个新SVG，旧码已移除。
连点实证｜独立探针将DELETE悬挂，在心跳重绘后再次点击新按钮，再放行：仅1次DELETE、1次POST、1个新二维码；loginStartBusy最终为空，定时器数量不变。
取消失败实证｜注入DELETE503：显示「取消旧登录失败…尚未创建新的登录」，零POST，旧流程保留，重试按钮恢复可用；解除故障后再次点击成功取得新流程，没有卡死。
自然结束竞态实证｜在DELETE前由真实runner回报旧流程expired：DELETE409后重新GET确认终态，再POST200取得新流程；独立替换竞态中另一客户端已建活动新流程时，旧按钮显示「流程已变化…尚未创建」，不POST、不取消或覆盖替代流程。
隐私/状态实证｜上述5组探针均检查前端请求与storage/日志，不含qrcode_key或二维码URL；API写请求体只有service/id；成功或竞态结束后仅显示当前流程二维码，定时器未新增。真实手机扫码与浏览器堆内存仍未测。
范围｜git diff --name-only 55e2178..61f9654 仅web/app.js与test/login-ui.test.mjs；后端鉴权、路由、二维码传输均未改，95bcfbe安全通过结论不变。api()仅给既有错误附加HTTP status，未改变凭据头或端点。
验证｜隔离副本 /tmp/teamagent-retry-review-2fbimryl：npm test371/371、npm run check:ui、git diff --check均退出0；另跑上述自写的实际点击/Worker联动探针，全部通过，临时脚本已删除。
边界｜只审不改代码/分支，不push、不提交或部署；未打开真实登录窗口或使用真实账号。此次通过证明修复与隔离回归，不代表已发布或真实扫码已完成。

复审 7（2026-11-12；5746dee 对 61f9654）：结论：打回；P0无，P1×1，新增P2无。
范围成立｜diff仅web/app.js与test/login-ui.test.mjs；未改owner鉴权、统一路由、二维码传输或Worker状态通道。
P1｜web/app.js:1177、:1195 把持久的 auth.state=risk 当作无期限禁用条件；但 runner/browser-auth.mjs:208 当日daily已完成就不再探活，十分钟抓取暂停结束不会自动清除risk。新增禁用会使用户无法通过再次登录恢复，除非等次日检查或另一个取视频任务触发探活。
独立实证｜临时HOME+真实BrowserAuth/FetchClient/Worker/隔离SQLite：先完成当天daily→QR生成412记录risk→推进600001ms→client.isPaused=false→daily跳过→Worker返回online=true、flow=null、auth=risk；实际UI按钮仍disabled，点击0POST。人工让后台auth恢复missing后按钮才重新可用，证明仅测“修改快照后恢复”不足以覆盖实际恢复链。
修法｜区分当前暂停与历史risk：暂停到期后允许受本机真实暂停闸保护的恢复探活/重试，或让后台到期主动更新状态；不能仅按持久risk永久禁用。补上述完整生命周期测试，不应靠人工改快照解锁。
已通过探针｜当前risk时按钮及倒计时归零后均保持禁用、点击0POST、旧QR移除；后台明确恢复后按钮可用；“重新登录X”仍调用原startServiceLogin并发出{service:'x'}，页面文本/请求不含key或二维码原文；离线提示提供操作步骤。
61f9654回归实证｜独立实际按钮+真实Worker：无risk的180秒归零重试仍DELETE200→POST200，取得新flow/新QR，页面只1个SVG、定时器数量不增；云端写请求体不含二维码/key。
窄屏核对｜独立对比本机main=31d0c2c与5746dee：web/index.html完全相同，CSS除无关login-qr块外完全相同；tabs定义、selectView/键盘事件块逐字相同。现有.tabs横向overflow:auto（style.css:264–272）及窄屏规则为main已有，未新增导航回归；未测实际屏幕像素。
验证/边界｜隔离副本 /tmp/teamagent-risk-ui-review-94accwl6：npm test374/374、npm run check:ui、git diff --check通过；自写恢复/X/倒计时Worker联动探针已跑，脚本已删除。未改代码/分支、未部署或真实扫码，未连接3391或访问真实~/.inkboard-team。

复审 8（2026-11-12；9b87519 对 5746dee）：结论：通过；P0/P1/P2：无；复审7的P1已修。
范围｜diff仅web/app.js、test/login-ui.test.mjs；后端、鉴权、二维码传输和Worker状态通道均未改。web/app.js:1176、:1186只保留risk提示，:1194不再按历史risk禁用。
独立探针a/b｜临时HOME＋真实BrowserAuth/FetchClient/Worker＋SQLite＋VM实际按钮：当天daily完成→生成请求412→共享暂停；历史risk且在线按钮可点，暂停中点击显示“B 站暂时限制，请稍后再试”，B站新增HTTP=0、SVG=0。
独立探针c｜推进600001ms→isPaused=false→daily当天跳过→Worker仍返回auth.state=risk；再次实际点击，经真实领取/QR流程成功生成新二维码，页面显示“等待扫码”、SVG=1，未人工清除risk。
独立探针d｜仍为历史risk时推进180001ms，web/app.js:1128–1131移除旧QR并开放重试；实际点击DELETE200→POST200、flow id更换、仅1个新SVG、定时器数量不增，未复发409。
独立探针d续｜“重新登录X”实际点击仍向Worker提交service=x；离线时按钮禁用且保留“双击桌面TeamAgent-登录／重启Mac服务”步骤（web/app.js:1172、:1193–1195）。
隐私实证｜上述探针检查Worker请求体、D1 settings、DOM属性、storage和日志：无二维码URL/qrcode_key；二维码仅由本机私有文件提供并编码为SVG，未改本地传输边界。
验证｜隔离副本/tmp/teamagent-risk-unlock-review-4kusbcht：自写探针全部通过（已删除），npm test376/376、npm run check:ui、git diff --check通过；另核对交付员risk-recovery-validation.log，未发现需追加审查的问题。
边界｜只审不改代码/分支、不push；未访问真实3391、真实~/.inkboard-team或进行真实扫码；结论为隔离回归通过，不代表已发布或手机扫码已验证。
