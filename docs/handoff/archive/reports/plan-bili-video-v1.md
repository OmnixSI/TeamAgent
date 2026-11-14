# B 站无 CC 字幕视频总结（本机只取音频转写；画面另议）· 方案 v3 定稿（2026-11-13 17:30，按审查 + 用户硬约束 + main 7cc3d8d 核对）
难度：困难 · 风险 L2 · 基线：**main 7cc3d8d**（已含 #26 短链素材、#28 停止视频自动转写、#29 读图修复、#30 已读字段）· 分三个 PR，见 §PR 分拆总表（谁做、文件、顺序、并行、回滚）
备份：v1 /tmp/plan-bili-video-v1.before-review1.md；v2 /tmp/plan-bili-video-v1.before-final.md。`plan-bili-video-xasr-addendum.md` **整份作废**，唯一合同是本文件。
**行号说明**：下文「现状」里未标版本的行号来自 210ed47，已漂移；以函数名为准，7cc3d8d 的新行号见 §现状「7cc3d8d 锚点」。

## 用户硬约束（2026-11-13 原话：「你不要把我的电脑当成服务器用，你顶多下载一个音频就好了。这些视频还有这些缓存，你也都要在我电脑上清理了…而且不要占用我太多内存。」）
- H1 本机只下载**音频流**（DASH audio，不下视频文件），转写完立刻删掉。本机不做视频下载、视频转码、抽帧。画面理解不在本机做，见 §PR-C（云端看封面和缩略图；收费，待用户拍板）。
- H2 临时文件：
  - 每个任务一个专用目录，成功、失败、超时、取消时都在 `finally` 里删除。
  - 每次启动、每天各扫一次残留。
  - 临时区总量上限 2GB，超了不接任务，并说明原因。
  - 云端只存文字，本机不留音频、切块或模型副本。
  - 每个任务的回报里写「残留 0」；有残留时写出路径。
- H3 资源：
  - 转写单并发、低优先级（nice）。
  - 峰值内存硬上限 1.3GB，超了自杀；参考脚本整段读入的写法必须改成流式分块。
  - 内存吃紧时不接任务（排队）。
  - **不常驻**：由 launchd 定时拉起，没任务就立刻退出，有任务干完就退出。
- H4 不下载 Whisper 或任何模型。只引用本机已装的 X-ASR 模型（只读）。唯一新装的是 `sherpa-onnx` 运行库（pip wheel，不含模型）。

## 目标与完成标准
- 群里发来的 B 站视频（BV 或短链）没有 CC 字幕时，本机用 **X-ASR** 把音轨转成文字，再总结。失败时说清具体原因（§原因表），不笼统地说「读不了」。
- 只用 X-ASR，不接第二个引擎，不买付费 API。Cookie 只留在本机，不进日志、仓库、云端、子进程 env、job 记录。
- 可验证：
  - §测试清单全绿；
  - §真机验收 V0–V6 通过，其中 V6 是 H1–H4 的清理和资源验收；
  - `MEDIA_TEXT` 和 `biliNoteText` 都不含「读不了」（W10、W27）。`src/linkfail.ts` 里原有的规则文案不在本方案范围内。

## 现状 · 7cc3d8d 锚点（2026-11-13 17:30 用 `git show 7cc3d8d:<文件>` 只读核对）
- fetchjobs.ts：`startVideoWait` :96 · `wakeVideoWait` :113 · `biliNoteText` :128–141 · 常量 4000/10000 :142 · `BILI_ANSWER_RULE` :145 · `videoMaterial` :146 · `biliResearchMaterials` :153 · `materialInjected` :192 · `runVideoWait` :204 · `failVideoWait` 约 :229 · `sweepVideoWaits` :243（LIMIT 5）· `claimFetch` :257 · `heartbeatFetch` :264 · `reportFetch` :279，waiter ready 那条在 **:304** · `fetchRoute` :334。
- worker.ts：chat 视频分支 :726–759（`!cached` 才 `startVideoWait` 在 :738，素材在 :759）· processJob 拾取 :500 `kind!='fetch'` · cron :1158 `NOT IN ('media','fetch')` · :1170 旧 media 超时 · `/api/runner/fetch/` 路由 :1388 · 旧 media 路由 :1517–1550 · 看板/取消 :1959/:1984/:2010/:2042 · `job()` :134 对 `kind='media'` 按 ref 去重（与 bili_media 无关）。
- vision.ts（#29 后）：`fetchImage` :182（QQ 图域名白名单 :134）· `deepSeekVision` :346 · `describeBytes` :424，内含 `budget(e,'vision',daily_cap??300)` :442 与缓存。
- **#30 已改无字幕文案**：`biliNoteText` 现在写「未拿到 CC 字幕（需登录）。/未拿到 CC 字幕（字幕接口未完成）。/无 CC 字幕。」+「没拿到字幕，以下基于标题与评论。未查看画面或听取音轨。」，`BILI_ANSWER_RULE` 要求「没拿到字幕时说‘没拿到字幕，以下基于标题与评论’」。**有转写时这两句都与事实冲突**，PR-B 必须改（§三个入口 第 4 条）；没有转写时输出必须与 7cc3d8d 逐字节一致，#30 的测试不改。
- **#28 已上线的相关行为**：`runner/utility.py:execute` 在**文件任务**（旧 `kind='media'`）里遇到 B 站等链接，用 `yt-dlp --format bestaudio --max-filesize 50M --no-cache-dir` 只下一条音频，且提示词写明「不要启动任何语音转写模型」，任务结束清目录（`discard_workspace`/`clean_utility_root`）。它与本方案的 chat 路径互不相干，**不改**；把它接上 X-ASR 列为后续（§没做的）。
- **事件层 v2（agent/event-layer-v2，未合入）**：占用迁移号 **0005**（`migrations/0005_event_layer.sql`）；把 `failVideoWait` 的出站写入改成 `...enqueueStatements(e,{id,group:{col},msgId:{col},body,from:{sql,args}})` 并置 `e.enqueued=true`。本方案的确认语写法跟随开工时 main 上 `failVideoWait` 的写法（§switchToMedia）。
- 用户 About：本机装有 X-ASR，偏好它而非 Whisper；本机不当服务器，视频最多下一个音频，用完清理（与 H1–H4 一致）。

## 现状（210ed47 已核，带行号；函数语义在 7cc3d8d 仍成立，行号以上节为准）
- **轻抓取**：
  - `startVideoWait`（fetchjobs.ts:95）在同一个 batch 里写 `video_waits` 和 `jobs(kind='fetch')`。
  - `reportFetch`（:220）写 `bili:<ref>`，把 waiter 置 ready=1（:242，不看阶段），然后逐个 `wakeVideoWait`（:255，无上限）。
  - `runVideoWait`（:140）的认领条件是 `attempts<3`，租约 120 秒。
- **chat 入口**（worker.ts:726–757）：只有 `!cached` 时才 `startVideoWait`。7 天内有轻缓存时，直接 `agentAnswer`。
- **`kind='media'` 已被占用**，是文件处理任务：worker.ts:1495–1540 的 `/api/runner/media/*`、:1168 cron、:1938/:1963/:2021 看板和取消、runner/utility.py:176。
  - 通用拾取方会拿走任何新 kind：worker.ts:510 `kind!='fetch'`、:1156 `NOT IN ('media','fetch')`、lanes.ts:3 `queueFor`。
- **路由**：
  - `dispatchFetch`（fetchjobs.ts:258）先 `fetcherSeen`，再用 `endsWith('/claim')` 等判断分发。
  - worker.ts:1380 对所有 `/claim` 生效：`runner_pause_until` 期间返回 `{job:null}`。
  - worker.ts:1386 把 `/api/runner/fetch/*` 交给 `fetchRoute`。
  - `OFFLINE_MS=120000`（linkfail.ts:4）。
- **迁移**：
  - migrate.mjs:24 按显式列表执行（schema、0002–0004），schema 之后调用 `ensureVideoWaitAttempts`（PRAGMA 守卫，migrate-video-waits.mjs:2）。
  - `video_waits` 没有 phase 列（schema.sql:51）。
- **安装**：
  - install-local.py 暂存阶段（:117–129）只复制 runner 下的 `*.py/*.mjs`。
  - `--apply`（:140–142）把文件**平铺**复制到 `~/.inkboard-team/`。
  - plist（:50）没有 WorkingDirectory。
  - reload_runtime.py:35 以 45 秒为上限跑 `--apply`；:5 是 SERVICES。
  - `/idle`（worker.ts:1373）把任何 running 的 job 都算作忙。
- **登录与限速**：
  - browser-auth.mjs：`loadBiliCookies(home)`（:40）读的是原子 rename 后的文件，读时不必加锁。`check/prepareBili` 在锁忙时会清空 Cookie（:129）。
  - fetcher.mjs：速率槽是进程内的（:65），只有 `bili-risk.json` 的暂停状态跨进程（:66/:165）。`sanitize`（:43）不去掉 URL query。
- **bili-reply-materials 已合入 main（#26/#30）**：
  - research 素材单份上限 4000、合计 10000（7cc3d8d fetchjobs.ts:142）。
  - 续问注入用 `materialInjected` 去重。
  - 无字幕文案见上节 #30 一条（已不含「读不了」）。
- **其他**：
  - `untrusted()` 默认截到 6000；`agentAnswer` 不截 materials；deepseek 有 1M 上下文。
  - voice.ts:75 是 INSERT OR IGNORE。
  - 本机 `sysctl -n kern.memorystatus_level` 可用（实测返回 43）；Node 有 `fs.statfsSync` 和 `os.setPriority`。

## 方案总览
- **新任务品种**：`jobs.kind='bili_media'`，id `bmedia-<bvid>`，路由 `/api/runner/fetch/media/{claim,heartbeat,report}`。旧的 `kind='media'` 一行不动。
- **本机执行**：短命进程 `media.mjs`，由 launchd `com.inkboard.team-media` 每 60 秒拉起一次（`StartInterval`，不设 KeepAlive，也不设 RunAtLoad）。
  - 每次启动：拿单实例锁 → 做清理 → 查资源 → claim 一次。
  - 没有任务就退出，空转不到 1 秒。有任务就做完、退出，下一分钟再来。
  - launchd 本身也不会同时起两个同名实例。
- **`video_waits` 加 `phase TEXT NOT NULL DEFAULT 'light'`**：轻结果没有字幕时，同一条 wait 切到 media 阶段。切阶段、入队、确认语放在同一个 batch 里，用 wait 的租约做围栏。
- **统一素材装配**：chat（含缓存命中）、`runVideoWait`、research 三个入口都调用 `planVideo()`。
- **不选的做法**：
  - yutto：Cookie 会走 argv。
  - BBDown：已归档。
  - 轻抓取进程顺带转写：长视频会堵住轻抓取。
  - 常驻轮询进程：违反 H3。
  - 由 fetcher 收到信号后拉起 media：要改轻抓取的 claim 协议和 fetcher 主循环，而 bili 分支正在改这两处。

## 核心函数 `planVideo`（`src/mediajobs.ts`）
```
type VideoPlan = { materials: string[]; media: 'none'|'start'|'release'; reason?: MediaReason }
planVideo(e, light, ref, mode: 'light'|'media'|'research', now, waitDueAt?) :
  base = videoMaterial(light, ref)
  if !needsMedia(light, ref) → {materials:[base], media:'none'}
  // needsMedia = !('miss' in light) && !isTitleRef(ref) && light.subtitle_status!=='ok' && light.duration>0（不看 enabled）
  row = 一条 SELECT：asr:<bvid> 正文、asrfail:<bvid> 正文、settings 'media:last-seen'、bmedia-<bvid> 的 status/error
  if row.asr → {[base, asrMaterial(asr, mode==='research'?12000:24000)], 'none'}
  if mode==='research' → {[base, MEDIA_PENDING_MATERIAL], 'none'}       // research 不开任务
  if !TEAM.bili.media.enabled → fail('disabled')
  if row.asrfail 且 until>now → fail(row.asrfail.reason)               // 24h 内不为 paid/not_found/no_speech/audio_unavailable 重跑
  if mode==='light': return seen 在 MEDIA_OFFLINE_MS(=180000，3 个拉起周期) 内 ? {[base], 'start'} : fail('offline')
  // mode==='media'
  if job.status==='failed' → fail(parseReason(job.error))
  if job.status∈(pending,running) && now<waitDueAt → {[base], 'release'}
  → fail('media_timeout')
fail(r) = {materials:[base, mediaFailMaterial(r, light)], media:'none', reason:r}
```
- 无字幕文案（#30 已改）**只在有转写时变**，见 §三个入口 第 4 条；没转写时 `videoMaterial` 输出与 7cc3d8d 逐字节一致。

## 三个入口怎么接
1. **chat（worker.ts:726 起）**：`cached && ref && !transferred` 时，先算 `plan = planVideo(e,cached,ref,'light',now)`。
   - `plan.media==='start'`：调用 `startVideoWait(e,{…,lightReady:true})`。新的可选参数 `lightReady` 的作用：插入的 wait 直接 `ready=1`，不写 `fetchStatement`，插入后立刻 `wakeVideoWait(e,id)`。
     - 返回 true：照现有 video 分支 recordDecision、推进游标、job 置 done，然后 return。
     - 返回 false（同 ref 已有 3 个活动 wait）：用 `[base, mediaFailMaterial('pending')]` 继续回答。
   - 其他情况：用 `plan.materials` 取代 :757 的 `[videoMaterial(cached,…)]`。
2. **`runVideoWait`（fetchjobs.ts:150 的 materials 一行）**：`cached` 存在时，算 `plan = planVideo(e,cached,w.ref,w.phase,now,w.due_at)`。
   - `start` → `switchToMedia(e,w,cached)`，然后 return。
   - `release` → `UPDATE video_waits SET status='waiting',ready=0,lease_until=NULL,attempts=MAX(attempts-1,0) WHERE id=? AND status='running' AND lease_until=?`，然后 return。
   - `none` → 用 `plan.materials` 走现有的回答路径。
   - `!cached` 时保持现状。
3. **research（bili 分支的 `biliResearchMaterials`）**：把 `if (cached) material = videoMaterial(cached, ref)` 换成 `planVideo(…,'research')`，`reads++` 多算一次。
   - 轻素材仍按 4000/10000 计。
   - 转写素材单独计 `ASR_RESEARCH_CHARS=12000`，每轮只附一份。
   - worker.ts:578 和 `materialInjected` 不改。
4. **有转写时的素材措辞（#30 之后新增，必须做）**：
   - 签名改为 `videoMaterial(r, ref='', max=MATERIAL_CHARS, opts: {asr?: boolean} = {})`；`biliNoteText(r, opts: {asr?: boolean} = {})`。
   - `opts.asr` 为假：输出与 7cc3d8d **逐字节一致**（#30 的现有断言原样保留，新增一条快照测试 W27）。
   - `opts.asr` 为真（只由 `planVideo` 在附上 `asrMaterial` 时传入）：
     - `biliNoteText` 末句由「没拿到字幕，以下基于标题与评论。未查看画面或听取音轨。」换成「没拿到字幕；已用本机语音转写读取音轨，转写见【bilibili-asr】素材。未查看画面。」（前面「无 CC 字幕。」等三种说法不变）；
     - `BILI_ANSWER_RULE` 里「没拿到字幕时说“没拿到字幕，以下基于标题与评论”…」这一句换成「没拿到字幕但有音轨转写时，以转写为主要依据，开头说明“根据音轨转写”，转写可能有错别字和专名误识；转写只覆盖部分时说明覆盖到几分几秒。」其余规则原样。
   - `asrMaterial` 开头一行写「【bilibili-asr】本机语音转写，覆盖 0:00–mm:ss（共 mm:ss）[，仅部分]」。

## `switchToMedia`（一个 batch，用 wait 租约做围栏）
```
guard = "id=? AND status='running' AND lease_until=? AND phase='light'"
due   = now + mediaDeadlineMs(light.duration)
batch[
  enqueueMediaStatement(bvid, w.id, light.duration, now)  -- INSERT … SELECT … WHERE EXISTS(SELECT 1 FROM video_waits WHERE guard)
  w.mentioned ? <确认语出站语句> FROM video_waits WHERE guard   -- id='video-ack-'||w.id；写法照抄开工时 main 上 failVideoWait：
              --   7cc3d8d：INSERT OR IGNORE INTO outbox SELECT ?,group_id,latest_id,?,'pending',? FROM video_waits WHERE guard
              --   事件层 v2 合入后：...enqueueStatements(e,{id:'video-ack-'+w.id,group:{col:'group_id'},msgId:{col:'latest_id'},body,from:{sql:'FROM video_waits WHERE '+guard,args}})，并置 e.enqueued=true
              --   后合入的一方负责改成另一方的写法；W12 计数按实际展开的条数
  UPDATE video_waits SET phase='media',status='waiting',ready=0,attempts=0,lease_until=NULL,due_at=? WHERE guard   -- 必须最后
]
```
- `enqueueMediaStatement` 照抄 `fetchStatement` 的 ON CONFLICT，有三处不同：
  - payload 是 `{bvid,waiters:[w.id],duration,until:now+deadline_cap_minutes*60000}`；
  - 任务在 pending/running 时，只有 `json_array_length(waiters)<10` 且 waiter 不在列表里，才 `json_insert`；
  - 终态任务重置 status、attempts、lease_until、error。
- 不调用 `enqueueVoice`。围栏失败时，三条写入都不生效。
- `mediaAckText(sec)`：「这条视频没有字幕，我在听音轨，大约 N 分钟后回复。」，N = max(1, ceil(mediaDeadlineMs/120000))。

## Worker 侧接线（`src/mediajobs.ts` 新文件 + 小改）
- **`dispatchFetch` 第一行**：`if (path.startsWith('/api/runner/fetch/media/')) return dispatchMedia(e,path,b)`，必须放在 `fetcherSeen` 和所有 `endsWith` 之前。
  - `dispatchMedia` 先写 `settings('media:last-seen')`（照抄 `fetcherSeen`，只换 key），再分发 claim、heartbeat、report，其余路径返回 404。
  - 暂停期间由 worker.ts:1380 返回 `{job:null}`。
- **`claimMedia`**：照抄 `claimFetch`，改成 `kind='bili_media'`、租约 **180 秒**、`attempts<2`。
- **`heartbeatMedia(e,id,lease,progress)`**：照抄 `heartbeatFetch`，续租到 now+180 秒，并 `json_set(payload,'$.progress',?)`，progress ≤40 字。
- **`reportMedia(e,b)`**：租约围栏、终态重放、提交后复查，全部照抄 `reportFetch`。
  - 请求体两种：`{id,lease,success:true,result:{bvid,text,covered,duration,partial,chunks},cleanup}` 或 `{id,lease,success:false,reason,chunk?,cleanup}`。
  - `cleanup={residue:number,paths:string[≤5]}`，原样写进 `jobs.payload.$.cleanup`，供看板查看（H2）。
  - 返回 400 的情况：reason 不在 `RUNNER_REASONS`（login_required paid not_found risk audio_unavailable download_failed asr_unavailable asr_failed no_speech media_timeout mem_limit local_busy）；`result.bvid` 与 payload 不符；`redact` 后的 text 超过 60000。
  - 写入，每条都带围栏：
    - 成功时写 `media_notes('asr:<bvid>')`。
    - 失败且 reason ∈ {paid,not_found,no_speech,audio_unavailable} 时，写 `media_notes('asrfail:<bvid>',{reason,chunk,until:now+24h})`。
    - `UPDATE video_waits SET ready=1 WHERE status='waiting' AND phase='media' AND id IN (该任务的 waiters)`。
    - `UPDATE jobs SET status,error`，error 为 `reason` 或 `asr_failed:<chunk>`。
  - 提交后只内联唤醒前 3 个 waiter，每次唤醒前检查 `left(e)>=4`。其余 waiter 已经 ready=1，由下一次 sweep 唤醒。
- **`reportFetch`**：只在 ready UPDATE（7cc3d8d :304）加 `AND phase='light'`，协议不变。
- **`sweepMedia(e)`**：在 `sweepVideoWaits` 开头调用，共 3 条语句。
  - ① `UPDATE jobs SET status='failed',error='timeout' WHERE kind='bili_media' AND status='running' AND attempts>=2 AND lease_until<?`
  - ② `DELETE FROM media_notes WHERE (id LIKE 'asr:%' OR id LIKE 'asrfail:%') AND created_at<?`，参数为 30 天前的 ISO 时间。
  - ③ `DELETE FROM jobs WHERE kind='bili_media' AND status IN ('done','failed','cancelled') AND created_at<?`，参数为 7 天前。
  - 被 ① 判失败的任务，其 waiter 到 due_at 时收尾。
- **排除 bili_media**：
  - worker.ts:510 改成 `kind NOT IN ('fetch','bili_media')`。
  - worker.ts:1156 改成 `kind NOT IN ('media','fetch','bili_media')`。
  - `queueFor` 遇到 `bili_media` 返回 null。
  - :1168/:1503/:1516/:1525/:1536/:1938/:1963/:2021 写死了 `kind='media'`，不改，由 W13 回归。
  - :1989 看板会列出 bili_media，可以接受。
  - `/idle` 把 running 的 bili_media 算作忙，本机升级会等转写跑完。这是预期行为。
- **迁移**：
  - `scripts/migrate-video-waits.mjs` 新增 `ensureVideoWaitPhase(execute)`，照 :2 先 PRAGMA 检查，没有这一列才执行 `ALTER TABLE video_waits ADD COLUMN phase TEXT NOT NULL DEFAULT 'light'`。
  - `migrate.mjs:26` 在 `ensureVideoWaitAttempts` 之后调用它。
  - `schema.sql:51` 的 CREATE 同步加这一列。
  - **不新增编号迁移文件**：编号文件里的 ALTER 在新库和二次执行时会报 duplicate column。0005 归事件层 v2（`0005_event_layer.sql`），0006 归 C3，本方案不占号。migrate.mjs 的文件列表与事件层 v2 同一行冲突时，保留双方改动（列表加 0005，helper 调用加 phase）。

## 原因表（`MEDIA_TEXT`；群里能看到的话，不出现程序名或服务名）
| 原因 | 群里看到的话 |
|---|---|
| offline | 本机转写端没开，这次只看了标题、简介和热评 |
| disabled | 听音轨功能现在是关着的 |
| pending | 这条视频的音轨正在转写，还没出结果 |
| login_required | 视频要登录才能播放，本机登录已失效 |
| paid | 这是付费或充电专属视频，账号没有观看权限 |
| not_found | 视频已删除或不可见 |
| risk | B 站暂时拦住了下载，请 10 分钟后再问 |
| audio_unavailable | B 站没给出可下载的音轨 |
| download_failed | 音轨下载中断了 |
| asr_unavailable | 本机语音转写程序没装好 |
| asr_failed | 语音转写出错（第 N 段） |
| no_speech | 音轨里几乎没有人声（可能是纯音乐） |
| mem_limit | 本机内存不够，转写中途停了 |
| local_busy | 本机临时空间或内存不够，这次没转写 |
| media_timeout | 视频 X 分钟，本机 Y 分钟内没转写完 |
| timeout | 同 media_timeout |

- 失败时**仍然**用标题、简介、热评作答，并在第一句说明原因。
- `MEDIA_PENDING_MATERIAL`：「这条视频没有 CC 字幕，音轨本轮没有转写；只依据标题、简介和热评。」

## 素材上限（统一口径）
| 入口 | 轻素材 | 转写素材 |
|---|---|---|
| chat / runVideoWait | `untrusted` 默认 6000 | `asrMaterial(n,24000)` = `untrusted('bilibili-asr',text,n.created_at,24000)` |
| research | 4000/份、合计 10000（bili 分支常量不动） | 12000，每轮 1 份，单独计量 |

超出上限时按首、中、尾三段比例截断，中间插「[中间省略 mm:ss–mm:ss]」。素材开头写明覆盖时长，以及是否只是部分（partial）。

## 本机 runner（PR-A）
- **路径**：所有运行时脚本都用 `fileURLToPath(new URL('./xasr_transcribe.py', import.meta.url))` 定位相邻文件。这样仓库里的 `runner/` 和安装后平铺的 `~/.inkboard-team/` 都能用。
  - 配置里以 `~/` 开头的路径，用 `os.homedir()` 展开（`expandHome`）。
- **`runner/media.mjs` 每次启动的流程**，按顺序：
  1. **单实例锁**：`mkdirSync(~/.inkboard-team/media.lock)`。锁已存在且 mtime 在 60 分钟内，说明另一个实例在跑，直接退出 0。锁超过 60 分钟视为残留，删掉后重取。任务运行期间每次心跳都 touch 锁。
  2. **清残留（H2）**：
     - 拿到锁就说明没有别的实例，于是 `media-tmp/` 下所有子目录都算孤儿，全部删除。
     - 读 `media-child.pid`：进程还在、且命令行含 `xasr_transcribe` 或 `ffmpeg`，就 `kill(-pgid,'SIGKILL')`，然后删掉 pid 文件。
     - 每日扫一次：`media-tmp/.last-sweep` 距今超过 24 小时，就额外删除超过 24 小时的 `media-reports/*.json`，把 `media.log`/`media-error.log` 截到最后 1MB，并更新 `.last-sweep`。
  3. **资源闸（H3）**：以下任一不满足，就不 claim，记一行日志后退出。任务留在队列里排队，下一分钟再试；到截止还没开始，群里看到的是 media_timeout。
     - `sysctl -n kern.memorystatus_level` ≥ 25（读失败就放行）；
     - `statfsSync(home)` 可用空间 ≥ 3GB；
     - `media-tmp` 总量 < 2GB。
  4. claim 一次。拿到 `job:null` 就退出。拿到的 `job.kind!=='bili_media'` 时记日志后退出，不碰这个任务。
  5. 执行 `runMediaJob`，再 report。然后回到第 3 步，最多连做 3 个任务后退出，避免单次运行无限延长。
- **`runMediaJob(job,deps)`**：
  - 任务目录 `media-tmp/<jobid>`，权限 0700。
  - 用独立的 `setInterval` 每 30 秒心跳一次，**不依赖进度**。
  - 心跳返回 409、超过 `payload.until`、或收到 SIGTERM 时，执行 `AbortController.abort()`：
    - 用 `process.kill(-pid,'SIGKILL')` 杀掉子进程组（spawn 时 `detached:true`，pid 写进 `media-child.pid`）；
    - 中止下载；
    - 收到 409 时不回报，超过 until 时回报 `media_timeout`。
  - 文件生命周期：m4a 在 ffmpeg 成功后**立刻删除**；wav 在 ASR 结束后**立刻删除**。
  - `finally` 里依次做三件事：
    - `rmSync(dir,{recursive:true,force:true})`；
    - 删除 pid 文件；
    - 再检查一遍 `media-tmp/<jobid>` 是否存在，得出 `cleanup={residue:0,paths:[]}`，或残留的文件数和相对路径。
  - 报告在 finally 之后发出。本机日志也写一行「已清理，残留 0」或残留路径。
- **回报**：
  - 每次超时 8 秒，失败后按 2s/4s/8s 间隔重试，共 3 次；收到 409 就丢弃。
  - 3 次都失败时，把报告写到 `media-reports/<jobid>.json`。文件权限 0600，只含文字，不含 URL。下次启动、claim 之前先补报；补报收到 409，或报告已超过 24 小时，就删除。
  - 重新领到同一个 bvid、本地又有暂存报告时，用新的 lease 直接回报，不重跑。
- **Cookie（审查 P2-1）**：只调用只读的 `loadBiliCookies(home)`，**不调用** `createBrowserAuth`、`check`、`prepareBili`。读不到 Cookie 就匿名请求，playurl 返回 -101 时报 `login_required`。
- **跨进程限速**：media 进程自己建 `createFetchClient({log, riskPath: 同一个 bili-risk.json})`。
  - 每个任务最多 3 个 api.bilibili.com 请求，任务之间串行。
  - 速率槽不跨进程，这一点明确接受；风控暂停是共享的，暂停期内直接报 `risk`。
- **`runner/fetcher.mjs` 只往末尾追加**：
  - client 加 `biliAudio(bvid)→{cid,duration,urls[]}`：用 playurl 的 `fnval=16`（DASH），**只取 `dash.audio` 和 backup**，不读 `dash.video`。
  - 新增导出 `classifyMedia(code)`。
  - `allowed()` 和 `resolveShort` 不动。
- **下载（审查 P2-2 + H1）**：`downloadAudio(url,dest,{maxBytes:200MB,signal,lookup})` 用 `https.request` 加 `createSafeLookup()`（拒绝私网和回环地址）。
  - 手动跟随重定向，最多 3 跳。每一跳都必须是 https、端口 443 或缺省、主机后缀在 `MEDIA_HOSTS=['.bilivideo.com','.bilivideo.cn','.akamaized.net']` 里。
  - 只带 Referer `https://www.bilibili.com/` 和 UA，**不带 Cookie**。
  - socket 超时 30 秒，总时长 15 分钟。
  - 下载过程中 `media-tmp` 总量超过 2GB 就中止，报 `local_busy`。
  - 日志只记主机名。异常文本先过 `redactUrl()`（去掉 query 和 fragment），再过 `sanitize()`。签名 URL 不写进 job、日志、报告。
- **ffmpeg（只做音频转码）**：
  - 参数：`['-nostdin','-hide_banner','-loglevel','error','-i',<tmp m4a>,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-t',String(max_minutes*60),'-y',<tmp wav>]`。
  - 超时 120 秒；env 只有 `{PATH,HOME,LANG}`；spawn 后 `os.setPriority(pid,15)`。
- **`runner/asr.mjs`**：
  - 调用：`spawn(python,['-u',SCRIPT,wav,'--model-dir',dir,'--max-rss-mb',String(mem_cap_mb)],{env:{PATH,HOME,LANG},detached:true})`，不经 shell，spawn 后 `os.setPriority(pid,15)`。
  - 内存看门狗：每 5 秒 `execFile('ps',['-o','rss=','-p',pid])`，超过 `mem_cap_mb` 就杀进程组，报 `mem_limit`。
  - 超时：60s + covered×rtf×4。
  - 退出码映射：
    - 2、5 或 ENOENT → asr_unavailable；
    - 6 → mem_limit；
    - 3、4、超时、末行不是合法 result → asr_failed；
    - 识别出的文字少于 10 字 → no_speech。
  - progress 行转成心跳的 progress。
- **launchd（不常驻）**：plist 只用这些键：
  - `ProgramArguments=[node, ~/.inkboard-team/media.mjs]`（展开成绝对路径）
  - `WorkingDirectory=~/.inkboard-team`
  - `StartInterval=60`
  - `ProcessType=Background`、`Nice=10`、`LowPriorityIO=true`
  - PATH 同 fetch（含 `/opt/homebrew/bin`）
  - 日志 `media.log`、`media-error.log`
  - **不设** KeepAlive 和 RunAtLoad。
- **`node runner/media.mjs once <BV>`（本机验收模式，PR-A 必做）**：
  - 不读云端地址、不 claim、不 report、不写 `media-reports/`；其余（单实例锁、启动清理、资源闸、任务目录 0700、心跳计时器换成本地计时、finally 清理）与正式模式同一套代码。
  - 第一步 `client.biliLight(bvid)` 取 `subtitle_status`（`biliLight` 未挂在 client 返回对象上就在末尾追加导出，不改其实现）；为 `ok` 时打印 `{"error":"has_subtitle"}` 并退出 7。
  - 之后走 `runMediaJob`，用 `deps.onFile(name,bytes)` 记录任务目录里出现过的每个文件名。
  - stdout 只打印一行 JSON：`{bvid,subtitle_status,duration,covered,partial,chunks,chars,head,files_seen,max_rss_mb,nice,wall_s,cleanup}`；`head` 为转写前 300 字。失败时 `{bvid,error:<reason>,cleanup}`，退出码 1。不打印 URL、Cookie。
  - `nice` 取 ASR 子进程运行中 `os.getPriority(pid)` 的读数。

## ASR 绑定（依据 `TeamAgent-xasr-recon-20261113.md`，已定）
- **引擎**：本机装的是 **sherpa-onnx 版** X-ASR，不是 MLX 版（`/Applications/InterviewHacker.app` 内置 sherpa-onnx 1.13.8）。
- **模型**：只读引用，不复制、不下载（H4）。
  - 路径：`~/Library/Application Support/NextThought/models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03/`。
  - 必需 5 个文件：encoder、decoder、joiner、tokens.txt、bpe.vocab。
  - 中英共用一个模型。
- **参数**：离线 transducer，bpe，modified_beam_search，max_active_paths 4，2 线程，cpu，16 kHz，featureDim 80。
- **`runner/xasr_transcribe.py`**：以参考脚本 `/Users/yanghongming/Projects/xasr_transcribe.py` 为底，改动如下。
  - ① `import sherpa_onnx` 移进 `build()`。
  - ② **流式分块读取（H3 + 审查 P2-3）**：删掉 `read_wav` 那种把整段转成 float 列表的写法。
    - 新增 `chunk_plan(read_frames, total, chunk_s=30, search_s=2, hard_s=35)`，其中 `read_frames(start,n)` 返回 `array('h')`。
    - 每次最多读 `(chunk_s+search_s)×16000` 帧，约 1MB。
    - 在 `[pos+28s, min(pos+32s, pos+35s)]` 里找最安静的 100ms 作为切点。
    - 解码时按块重读，只把当前块转成 float（35 秒约 18MB）。每块一个 `OfflineStream`，用完即丢。
  - ③ 每块一条 segment `{start,end,text}`，空文本丢弃。
  - ④ stdout 输出 JSON Lines，每行 `flush=True`：每块一行 `{"type":"progress","done":i,"total":n}`，末行是 `{"type":"result","segments":[…],"audio_s":…,"decode_s":…,"max_rss_mb":…}`。
  - ⑤ `--check`：校验 5 个模型文件并加载一次。
  - ⑥ `--max-rss-mb N`：每解完一块，检查 `resource.getrusage(RUSAGE_SELF).ru_maxrss`（macOS 单位是字节），超过 N 就 `exit 6`。
    - macOS 上 `ulimit -v`/RLIMIT_AS 不可靠（**未在本机验证**），所以不依赖它，由自检和 asr.mjs 的看门狗两道防线兜底。
  - ⑦ 退出码：0 成功，2 模型缺失（stderr 写出缺哪个文件），3 wav 格式不对，4 识别异常，5 缺 sherpa_onnx，6 内存超限。stderr 截到最后 2KB。
- **内存上限**：用户说实测 0.7–1.0GB。
  - 硬上限 `mem_cap_mb=1300`。
  - 验收标准：90 分钟音频的峰值 ≤ 10 分钟实测值 + 200MB，且 ≤1300MB。
  - **长音频 RSS 尚未实测**，由 V5 用 `/usr/bin/time -l` 测量。超标就交回，不擅自调参。
- **依赖**：`runner/requirements-xasr.txt` 只有一行 `sherpa-onnx==1.13.8`。venv 放在 `~/.inkboard-team/xasr-venv`，禁止放 /tmp。代码里不出现 whisper、huggingface、hf_hub、modelscope、`from_pretrained`，也不出现任何模型 URL（R21 检查）。

## 安装（审查 P1-1：暂存 / 平铺 / ~ / 45 秒 / 步骤顺序）
- **`scripts/install-local.py` 暂存阶段**（:121 循环之后）：
  - 显式 `shutil.copy2(root/'runner/requirements-xasr.txt', stage/'runner/requirements-xasr.txt')`。
  - 调用 `ensure_xasr(root)`，交互运行，不受 45 秒限制：
    - venv 不存在就 `python3 -m venv`；
    - requirements 的 sha256 和 `xasr-venv/.req.sha256` 不一致时，`pip install --no-cache-dir -r`（timeout 600），然后写 sha；
    - 运行 `--check`；
    - 失败只打印原因，不中断暂存。
- **`--apply` 阶段**：不跑 pip，也不跑 `--check`。只做下面几件事：
  - 平铺复制 .py/.mjs（现有循环），并复制 requirements-xasr.txt；
  - `config.json` 写入 `asr:{python:<绝对路径>, model_dir:<绝对路径>}`；
  - 根据 `team.json` 的 `bili.media.enabled` 决定 `install_media_service()` 或 `remove_media_service()`。
- **`--xasr-only`**：只跑 `ensure_xasr` 并写 asr 配置，然后退出。
- **`--remove-media`**：移除 media 的 plist，删除 `xasr-venv`、`media-tmp`、`media-reports`、`media.lock`、`media-child.pid`。只删 `~/.inkboard-team` 下这几个固定名字，用于回滚和清理。
- `install_fetch_service` 重构为 `install_node_service(label, script, extra_keys)`，fetch 的 plist 字节必须与改前一致（I4）。
- `runner/reload_runtime.py:5` 的 SERVICES 加 `com.inkboard.team-media`，并像 fetch 一样不检查返回结果。对 StartInterval 型任务 kickstart，等于立即跑一次 claim，无害。
- **配置**：
  - `config/team.json` 增加 `bili.media={enabled,max_minutes:90,rtf:0.05,deadline_cap_minutes:40,mem_cap_mb:1300,tmp_cap_mb:2048}`。
  - `config/team.schema.json:223` 和 `config/validate.mjs:110` 同步：字段都必填，enabled 是 boolean，其余是正数。
- `docs/operations.md`：写明启停、日志、回滚、`--remove-media`。

## 任务流与截止
| # | 位置 | 输入 → 输出 | 超时 | 失败 reason |
|---|---|---|---|---|
| 1 | Worker `planVideo`→`switchToMedia` | 无字幕 → bmedia 任务，wait 进入 media，被 @ 时发确认语 | — | offline disabled asrfail 缓存 |
| 2 | runner 启动闸 | 锁 → 清残留 → 资源检查 → claim | — | 资源不足：不 claim，排队 |
| 3 | runner `biliAudio` | bvid → cid、**音频流** URL | 8 秒/请求 | login_required paid not_found risk audio_unavailable |
| 4 | runner 下载 | → tmp/a.m4a（≤200MB） | 30 秒 / 15 分钟 | download_failed local_busy |
| 5 | runner ffmpeg | m4a → wav，然后删 m4a | 120 秒 | asr_unavailable download_failed |
| 6 | runner asr | wav → segments，然后删 wav | 60s + covered×rtf×4 | asr_unavailable asr_failed no_speech mem_limit |
| 7 | runner finally + report | 删目录 → cleanup 统计 → 回报 | 8 秒 ×3，之后暂存 | — |
| 8 | Worker `reportMedia` | asr/asrfail，只 ready media 阶段，唤醒 ≤3 | — | 409 / 400 |
| 9 | `runVideoWait`(media) | 回答、release 或给出原因 | due_at | media_timeout |

- `due_at = now + min(deadline_cap_minutes, 3min + duration×(rtf+0.05)×2)`，另外再加最多 60 秒的拉起延迟，已包含在 3 分钟里。
- runner 的硬上限是 `payload.until`。过了截止才完成的转写只写缓存，不追发。

## D1 预算（每次调用 ≤48 条语句；W12 从真实入口计数）
- **有界设计**：
  - waiters ≤10；
  - 内联唤醒 ≤3，并检查 `left`；
  - sweepMedia 3 条；
  - `planVideo` 多 1 条 SELECT；
  - 切阶段 1 个 batch（3 条）+ 1 条复查。
- **空转写入**：每分钟拉起一次，每次 claim 写 1 条 last-seen，约 1440 次写/天，远低于免费额度的 10 万/天。
- **W12 计数**：用 `metered` 包住真实入口，计数要包含外层 processJob、`enqueueVoice` 的提醒查询、timing/model 的尾写、`flushTail`。四个入口：
  - ① queue `video_reply` 走切阶段；
  - ② HTTP `/api/runner/fetch/media/report`，10 个 waiter；
  - ③ cron `scheduled`：5 个就绪 wait、1 个过期任务、待清理的 asr；
  - ④ chat 缓存命中后开 wait。
  - 每个入口 ≤40，实测数写进 PR。超了就交回。

## PR 分拆总表（执行顺序、并行、文件边界、回滚）
| | PR-A 本机取音频 + X-ASR 转写 + 清理 | PR-B 转写进云端素材与回答 | PR-C 关键帧看图 |
|---|---|---|---|
| 分支 | `agent/bili-asr-local` | `agent/bili-asr-cloud` | `agent/bili-frames` |
| 执行 | **程序员**（runner/安装器，常规 B） | **主程**（D1 围栏、阶段状态，困难） | 程序员；C0 侦察交付员 |
| 只能碰的文件 | `runner/media.mjs`(新) `runner/asr.mjs`(新) `runner/xasr_transcribe.py`(新) `runner/requirements-xasr.txt`(新) `runner/fetcher.mjs`(只在 client 末尾追加) `runner/reload_runtime.py`(:5) `scripts/install-local.py` `config/team.json` `config/team.schema.json` `config/validate.mjs` `docs/operations.md` `runner/test_media.mjs`(新) `runner/test_asr.mjs`(新) `test/xasr_chunk_test.py`(新) `test/install_local_test.py` | `src/mediajobs.ts`(新) `src/fetchjobs.ts` `src/worker.ts` `src/lanes.ts` `scripts/migrate-video-waits.mjs` `scripts/migrate.mjs` `schema.sql` `test/mediajobs.test.mjs`(新) `test/fetchjobs.test.mjs` 迁移测试 | `src/mediaframes.ts`(新) `src/mediajobs.ts` `src/fetchjobs.ts`(runVideoWait 调用点 + biliNoteText frames 句) `src/vision.ts`(只给 readBytesLimited 加 export) `runner/media.mjs`(只加取图链接) `config/*`(frames 键) `test/mediaframes.test.mjs`(新) |
| 关键签名 | `main(argv)`：无参=launchd 模式，`once <BV>`=本机验收模式 · `runMediaJob(job,deps)→{report,cleanup}` · `biliAudio(bvid)→{cid,duration,pic,urls[]}` · `pickAudio(dash)→url[]` · `downloadAudio(url,dest,{maxBytes,signal,lookup})` · `ffmpegArgs(src,dst,maxMin)→string[]` · `runAsr(wav,{python,modelDir,memCapMb,timeoutMs,signal,onProgress})→{segments,audio_s,max_rss_mb}` · `parseAsrOutput(lines)` · `startupGate(home,deps)→{ok,reason}` · `sweepLocal(home,now)` · `expandHome(p)` · Python `chunk_plan(read_frames,total,chunk_s=30,search_s=2,hard_s=35)` | `planVideo(e,light,ref,mode,now,waitDueAt?)→VideoPlan` · `needsMedia(light,ref)` · `switchToMedia(e,w,light)` · `enqueueMediaStatement(e,bvid,waitId,duration,now)` · `dispatchMedia(e,path,b)` · `claimMedia(e)` · `heartbeatMedia(e,id,lease,progress)` · `reportMedia(e,b)` · `sweepMedia(e)` · `asrMaterial(note,max)` · `mediaFailMaterial(reason,light)` · `mediaAckText(sec)` · `ensureVideoWaitPhase(execute)` · `videoMaterial(r,ref,max,{asr})` | `pickFrameUrls(videoshot,pic)→string[]`(本机) · `fetchBiliImage(url,signal)→{bytes,mime}|null` · `describeFrames(e,bvid,urls,signal)→string|null` · `framesMaterial(note)` |
| 先写的测试 | R1–R22、I1–I6 | W1–W27 | C1–C6（§PR-C） |
| 依赖 | 无，**现在就能开工** | 无代码依赖；只读 `TEAM.bili?.media?.enabled===true`（PR-A 未合入时视为 false）。**与 PR-A 并行** | PR-B 合入 + 用户在 §需要用户拍板 选 A |
| 合并条件 | R/I 全绿 + §PR-A 本机实测（A1–A6）全过 | W 全绿 + 迁移在远程 D1 跑过 + 上线后 V1–V6 | C 全绿 + V7 |
| 回滚 | `enabled` 本来就是 false：revert 即可；本机 `python3 scripts/install-local.py --remove-media` 删 venv/临时目录/报告/锁 | ① `enabled=false` 部署；② 有 bili_media 在途时**先**跑 `UPDATE jobs SET status='cancelled',error='rollback' WHERE kind='bili_media' AND status IN ('pending','running')`，再部署旧代码（旧 :500/:1158 会抢 bili_media）；③ phase 列保留 | `bili.media.frames=false` 部署即停；revert 无数据迁移 |

- **并行方式**：PR-A 与 PR-B 文件不重叠，同时开两个 worktree 同时做；PR-A 先合（本机、默认关闭、风险 L1），PR-B 在 PR-A 合入后 rebase 一次（只会在 config 上遇到 PR-A 加的键，不冲突）。PR-C 的 C0 侦察（交付员，两条 curl）可以现在就做，编码等拍板。
- **同一时间只能一人碰**：`src/fetchjobs.ts`、`src/worker.ts` 只归 PR-B 主程；`runner/fetcher.mjs` 只归 PR-A；`src/semantic.ts` 谁都不碰。事件层 v2 也改 fetchjobs/worker：谁后合入谁 rebase，冲突点只有 `failVideoWait` 写法和 migrate.mjs 文件列表（§switchToMedia、§迁移已写怎么合）。
- **上线顺序（PR-B）**：`npm run db:migrate`（远程 D1）→ 部署 Worker（此时 enabled 仍 false）→ team.json 改 enabled=true 再部署 → 本机暂存，空闲时 `--apply` 装上 launchd 定时项 → 跑 V1–V6。
- `once` 模式说明：只在本机跑，不连云、不 claim、不 report；同样走单实例锁、启动清理、资源闸、任务目录、finally 清理，最后把统计打印到 stdout（不写文件）。

## PR-A 本机实测（交付员在 PR-A 的 worktree 里执行；用户亲眼可复核「能拿到音频并转写」）
选片：交付员挑一条**公开、3–6 分钟、中文口播、无 CC 字幕**的视频，BV 写进 PR。`once` 第一步会查字幕：有 CC 字幕就以退出码 7（`has_subtitle`）拒绝并打印原因，换一条即可，所以选错不会白跑。
```
cd /Users/yanghongming/Projects/.worktrees/TeamAgent-bili-asr-local
python3 scripts/install-local.py --xasr-only                       # A1 只装 sherpa-onnx 运行库到 ~/.inkboard-team/xasr-venv；不下任何模型
M="$HOME/Library/Application Support/NextThought/models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03"
~/.inkboard-team/xasr-venv/bin/python runner/xasr_transcribe.py --check --model-dir "$M"; echo "check=$?"   # A2 期望 check=0
touch /tmp/bili-asr-start
node runner/media.mjs once BV1xxxxxxxxx                              # A3 真跑：下音频 → 转码 → 转写 → 清理
ls -A ~/.inkboard-team/media-tmp ~/.inkboard-team/media-reports 2>/dev/null | wc -l   # A4 期望 0
pgrep -fl "xasr_transcribe|ffmpeg" || echo "no-orphan"                                 # A5 期望 no-orphan
find ~/.inkboard-team ~/.cache ~/Library/Caches -newer /tmp/bili-asr-start \( -name "*.onnx" -o -name "*.bin" -o -name "*.pt" -o -name "*.m4a" -o -name "*.wav" -o -name "*.mp4" -o -name "*.flv" \) 2>/dev/null | wc -l   # A6 期望 0
du -sh ~/.inkboard-team/xasr-venv; rm -f /tmp/bili-asr-start
```
A3 的 stdout 是一行 JSON，必须同时满足：`subtitle_status` 为 `none`/`login_required`/`unavailable`；`files_seen` 只含 `a.m4a`、`a.wav`（H1：从未出现视频文件）；`covered`≈视频时长；`chunks`≥1；`chars`≥200；`head` 为转写前 300 字且读得通；`max_rss_mb`≤1300；`nice`≥10；`cleanup.residue`=0。再用一条约 60 分钟视频跑一次 A3，记录 `max_rss_mb` 与墙钟（对应 V5 的长音频内存验收）。全部输出贴进 PR 描述，转写全文不入库、不留文件。

## 步骤
1. PR-A、PR-B 同时开工，各自先写测试（R/I、W），再实现；PR-C 先只做 C0 侦察。
2. PR-A：交付员跑 R/I 全套 + §PR-A 本机实测 → 审查员中间审 → 终审 → 合并（enabled 仍 false，线上无变化）。
3. PR-B：rebase 到含 PR-A 的 main → W 全套 → 远程 D1 迁移试跑 → 复核员中间审 → 终审 → 合并 → 按上线顺序启用 → V1–V6。
4. PR-C：用户选 A 且 C0 结论可行后开工；选 B 就不做。

## 测试清单（先写；* 表示本轮改过）
本机（`runner/test_media.mjs`、`runner/test_asr.mjs`、`test/xasr_chunk_test.py`）：
- R1 `pickAudio`：只在合规主机里选带宽最小的音频；`:4483` 端口或名单外的主机改走 backup；一条都不合规 → audio_unavailable。
- R2* `downloadAudio`：请求头有 Referer、没有 Cookie；超过 maxBytes → download_failed；带 `upsig/mid` 的 URL 在抛错和 3xx 时，日志与异常里只有主机名。
- R3 playurl 返回码：-101→login_required；-404/62002→not_found；-10403/87007/87008→paid（**未确认**，V4 核对）。
- R4* `ffmpegArgs`：参数是数组，含 `-vn -ac 1 -ar 16000 -c:a pcm_s16le -t 5400`；输入在 tmp 目录里；env 的键恰好是 PATH、HOME、LANG；对子进程调用了 `setPriority(pid,15)`。
- R5* asr.mjs（假 spawn）：
  - ENOENT、退出码 2/5 → asr_unavailable；6 → mem_limit；3/4、超时 → asr_failed；文字少于 10 字 → no_speech。
  - env 的键恰好是 PATH、HOME、LANG；argv 含 `-u`、`--model-dir`、`--max-rss-mb`；不经 shell；有 `setPriority`。
- R6 正常路径：输出带 `[mm:ss]`，报告字段齐全；成功和失败两种情况下，目录都被删除，`cleanup.residue=0`。R7 120 分钟视频 → covered=5400，partial=true。R8* 报告里的 Cookie 值变成 `***`，签名 URL 的 query 被去掉。
- R9 `--check --model-dir /nonexistent` → 退出码 2，stderr 写出缺的文件名，最终 asr_unavailable。
- R10* `chunk_plan`：100 秒全静音、100 秒恒定噪声、95 秒中间有静音三种输入，每块 ≤35 秒，单调递增，最后一块到文件末尾。
- R11 `parseAsrOutput`：progress 和 result 混在一起时取 result；末行损坏、缺 segments、start/end 不是数字 → asr_failed。
- R12 集成（有 venv 才跑，CI 跳过）：中英样例各一条，文本非空、中文带标点；65 秒音频 → 至少 2 段，时间单调。
- R13 路径：平铺复制到临时目录、cwd=/tmp 时，SCRIPT 是临时目录下的绝对路径；`expandHome('~/x')` 结果正确。
- R14 心跳：用假时钟，下载、ffmpeg、ASR 三个阶段都每 30 秒心跳一次，即使没有进度；心跳返回 409 → `kill(-pid)`、目录被删、不回报。
- R15 回报：3 次失败 → 暂存文件，权限 0600、不含 `http`；下次启动先补报；收到 409 → 删除；重领同一个 bvid → 不重跑下载和 ASR。
- R16 超过 `payload.until` → 中止，报 media_timeout。R17 重定向到名单外主机、http、:8080、私网 IP，或第 4 跳 → download_failed。
- R18 Cookie：没有文件时匿名；有文件时只有 api.bilibili.com 带 Cookie；`prepareBili` 和 `check` 的调用次数为 0。R19 风控暂停期内 → 不发请求，报 risk。
- R20 内存：假 `read_frames` 喂 90 分钟帧数，每次读取都 ≤32×16000 帧；源码中不存在 `[s / 32768.0 for s in`。`--max-rss-mb 1` → 退出码 6。看门狗收到假 `ps` 返回超限值 → 杀进程组，报 mem_limit。
- R21 H4：对 `runner/` 和 `scripts/install-local.py` 做 grep，`whisper|huggingface|hf_hub|modelscope|from_pretrained|\.onnx"?\s*https?://` 无结果；pip 命令只装 `-r requirements-xasr.txt`，且带 `--no-cache-dir`。
- R22 启动闸与清理（H2/H3）：
  - 锁被占用且 mtime 新 → 退出 0，不 claim；锁超过 60 分钟 → 接管。
  - `media-tmp` 里有残留子目录 → 启动后为空。
  - `media-child.pid` 指向一个仍存活的假 `xasr_transcribe` 进程 → 被杀。
  - `.last-sweep` 超过 24 小时 → 删除超过 24 小时的报告、截断日志。
  - `memorystatus_level=10`、可用空间 1GB、或 tmp ≥2GB → 不 claim。
  - m4a 在 ffmpeg 之后已不存在，wav 在 ASR 之后已不存在（文件系统断言）。
  - 一次运行最多处理 3 个任务。

安装（`test/install_local_test.py`；临时 HOME，对 subprocess 打桩）：
- I1 暂存后，`stage/runner/` 里有 requirements-xasr.txt、media.mjs、asr.mjs、xasr_transcribe.py。
- I2 `--apply` 后脚本平铺到位；config 里的 asr 路径是绝对路径。
- I3 `--apply` 不调 pip，也不调 `--check`；暂存时 sha 不变就不调 pip。
- I4 fetch 的 plist 字节不变。media 的 plist 有 StartInterval=60、Nice=10、ProcessType=Background、LowPriorityIO、WorkingDirectory，没有 KeepAlive 和 RunAtLoad。enabled=false 时调用 remove。
- I5 SERVICES 里有 team-media，并且对它不检查返回结果。
- I6 `--remove-media` 删除 venv、media-tmp、media-reports、锁和 pid 文件；`~/.inkboard-team` 下其他文件不受影响。

Worker（`test/mediajobs.test.mjs`、`test/fetchjobs.test.mjs`、迁移测试）：
- W1 无字幕且在线：建 bili_media 任务，phase=media，attempts=0；被 @ 时 outbox 有 `video-ack-`；不调用 agentAnswer。
- W2 离线：带 offline 文案，不建任务。W3 字幕 ok：行为与现在一致。W4 有 asr 缓存：素材里有转写，不建任务。
- W5 报告成功：写入 `asr:`，media 阶段的 wait 被 ready 并唤醒；租约不对 → 409；重复回报 → 200，不重复写；`cleanup` 写进 payload。W6 reason=paid → 回答里说明付费原因。
- W7 到 due_at 还没有报告 → media_timeout。W8 标题引用 → 不进入 media。W9 enabled=false → disabled，且 needsMedia 仍为真。
- W10 `MEDIA_TEXT` 每一项都非空，不含「读不了」、不含程序名（X-ASR、sherpa、ffmpeg、DeepSeek）。`biliNoteText` 的措辞由 W27 管。W11 40000 字的转写 → chat ≤24000、research ≤12000，带省略标记。
- W12* 语句计数：见 §D1，四个入口各 ≤40。
- W13 抢单回归：旧的 media claim、processJob(:510)、cron(:1156)、`/fetch/claim` 都领不到 bili_media；`queueFor('bili_media')===null`；:2021 不列出它。
- W14 chat 缓存命中、无字幕、无 asr：建 ready=1 的 wait，不建 fetch 任务，切到 media，chat 入口不调用 agentAnswer。W15 缓存命中且有 asr：直接回答，素材里有转写。
- W16 阶段隔离：wait 在 media 阶段时，`reportFetch` 的终态重放或晚到报告不会 ready 它；sweep 和 report 无论谁先，都不会提前判 media_timeout。
- W17 release：任务仍在跑且未到 due_at → wait 回到 waiting、ready=0，attempts 不增加，不回答。
- W18 迁移：新库执行 schema.sql 后连跑两次 helper 无报错；旧库加列后，已有行 phase='light'。
- W19 切阶段围栏：batch 执行前租约被换掉 → 什么都不写；batch 之后中断 → `video-ack-` 和 phase=media 都已落库。
- W20 同一个 bvid 有 11 个 waiter → 只记录 10 个；第 11 个到 due_at 时，有 asr 就用 asr 回答。W21 有 10 个 waiter → 内联唤醒 3 个，其余由 sweep 唤醒。
- W22 research：有 asr → 只附 1 份，≤12000；没有 asr → 附 PENDING 素材，不建任务，续问注入不重复。
- W23 sweepMedia：过期的 running 任务 → failed(timeout)；超过 30 天的 asr/asrfail 被删，29 天的保留；超过 7 天的终态任务被删。
- W24 失败报告：paid → 写入 asrfail，24 小时内不重建任务；未知 reason → 400；`asr_failed` 且 chunk=3 → error 记为 `asr_failed:3`；bvid 不一致 → 400；mem_limit 和 local_busy 都被接受。
- W25 validate 和 schema 能校验 bili.media 的字段（PR-A 的 6 个；PR-C 加 `frames` 后为 7 个，属 C 的测试）。W26 media 路由写 `media:last-seen`，不写 `fetcher:last-seen`；暂停期间 claim 返回 null；last-seen 距今 150 秒仍算在线。
- W27 素材措辞：`videoMaterial(r,ref)` 与 `videoMaterial(r,ref,4000,{asr:false})` 对 #30 的三种无字幕夹具输出与 7cc3d8d 逐字节相同（快照）；`{asr:true}` 时不含「以下基于标题与评论」「未查看画面或听取音轨」，含「根据音轨转写」规则与「转写见【bilibili-asr】素材」；有字幕时 `{asr:true}` 不改变输出。

## 真机验收（交付员挑公开视频，BV 写进 PR）
- V0 `--xasr-only` 之后 `--check` 返回 0。PR-B 上线后，`launchctl print gui/$UID/com.inkboard.team-media` 显示它是 StartInterval 型，空闲时 `pgrep -f media.mjs` 大多数时候为空。
- V1 3–6 分钟中文无 CC 视频 → 总结有具体内容。V2 约 5 分钟英文演讲 → 总结正确。V3 纯音乐 → no_speech。
- V4 充电专属或已删除的视频 → 对应文案，同时核对 R3 的返回码和 R1 的 CDN 主机。
- V5 60–90 分钟视频 → 先收到确认语，截止前收到回答。用 `/usr/bin/time -l` 记录 10 分钟和 90 分钟的峰值 RSS，对照 1300MB 上限。
- **V6 清理与资源（H1–H4）**：V1–V5 每条结束后都检查：
  - `media-tmp/` 为空，`media-reports/` 为空，报告里 `cleanup.residue=0`；
  - `pgrep -f "xasr_transcribe|ffmpeg"` 无输出（没有孤儿进程）；
  - 任务期间 `ls media-tmp/*/` 只出现过 `a.m4a` 或 `a.wav`，从来没有视频文件；
  - `~/.inkboard-team`、`~/.cache`、`~/Library/Caches` 下没有新增模型文件，`du -sh ~/.inkboard-team/xasr-venv` 写进 PR；
  - `ps -o nice= -p <asr pid>` ≥10；
  - 日志 `grep -E "SESSDATA|upsig|bili_jct|mid="` 无结果。

## PR-C 关键帧看图（云端看封面 + 缩略图拼图；本机不下视频、不下图片、不抽帧）
- **收费，需用户拍板（见 §需要用户拍板）**：群里看图用的是 DeepSeek 官方看图（`describeBytes`→`deepSeekVision`，模型 deepseek-flash，**按 token 计费，不免费**；recon2 第 9 条，官方价目 2026-11-13 核对：输入 $0.30/百万 token、输出 $1.20/百万 token，单图 ≤1024 token）。估算每张图约 $0.0007，每条视频最多 3 张 ≈ $0.002（约 0.003 澳元）；与群里看图**共用**现有每天 300 张上限，所以每日封顶不变（300 张 ≈ $0.21/天，约 0.33 澳元，汇率按 1 USD≈1.55 AUD 估）。
- **免费替代不存在**：本机跑 Qwen3-VL 之类要装 ollama 并下 3.3GB 模型，违反 H3/H4；Worker 上没有免费看图模型可用。所以只有「付费用同一模型」或「不做」两条路。
- **能看到什么**：只有封面和 B 站自带的缩略图拼图（videoshot，单格很小），能看出场景、人物、大致画面；**认不出 PPT、代码、图表上的小字**。不是真正的逐场景关键帧，方案和回答里都按「缩略图」说。
- **C0 侦察（交付员，现在就能做，不阻塞 A/B）**：
  1. `curl -s "https://api.bilibili.com/x/player/videoshot?bvid=<BV>&index=1"`（匿名）→ 记录 `code`、`data.image[]` 张数和主机、`img_x_len/img_y_len/img_x_size/img_y_size`、`index[]` 长度；
  2. 在 `wrangler dev --remote` 下用 /tmp 里的临时脚本（不提交）从 Worker 取 1 张拼图和封面（不带 Referer）→ 记录状态码、content-type、字节数。
  - 任一条不成立（要登录、Worker 取不到、主机不是 `*.hdslb.com`）→ PR-C 停，交回 BINI，**不改成本机下载图片**。
- **本机（runner/media.mjs，只加链接，不下载）**：`biliAudio` 已调 view（拿 `pic`），再加 1 次 videoshot 请求（每任务 api.bilibili.com 请求仍 ≤3：view、playurl、videoshot）。`pickFrameUrls(videoshot,pic)→string[]`：封面 + 第 1 张和中间 1 张拼图，最多 3 个，只留 `https:` 且主机以 `.hdslb.com` 结尾的；videoshot 失败只留封面。成功回报加 `frames:[url…]`。
- **Worker（src/mediaframes.ts 新文件）**：
  - `reportMedia`：`frames` 逐条校验（https、无端口、主机以 `.hdslb.com` 结尾、≤300 字），不合格的丢掉（不 400），写进 `jobs.payload.$.frames`。
  - `fetchBiliImage(url,signal)→{bytes,mime}|null`：同上校验；`fetch(url,{redirect:'manual',signal})`，3xx 一律不跟；只收 image/jpeg|png|webp；≤2MB。读字节复用 vision.ts 的 `readBytesLimited`（**vision.ts 只给它加 `export`，不改逻辑**）。
  - `describeFrames(e,bvid,urls,signal)→string|null`：`TEAM.bili.media.frames!==true` → null；有 `media_notes('frames:<bvid>')` 直接返回；否则逐张 `fetchBiliImage` → `describeBytes(e,bytes,mime,hint)`（**复用群里看图的同一模型、缓存和 300 张/天额度**），hint 写「B 站视频《标题》的封面 / 缩略图拼图，按时间从左到右、从上到下」；拼成 ≤600 字写入 `frames:<bvid>`（1 条语句）。总耗时 ≤25 秒，任何失败返回 null。
  - 调用点只有一处：`runVideoWait` 的 media 阶段，在 `planVideo` 给出含转写的素材、准备回答之前；`left(e)<12` 时跳过。chat 缓存命中和 research 只读已有的 `frames:` 缓存，不调看图。
  - `framesMaterial(note)` = `untrusted('bilibili-frames',text,created_at,1500)`，前面加一句「画面只来自封面和缩略图，看不清屏幕小字，不据此写具体数字」。有 frames 素材时 `biliNoteText` 的 asr 末句里「未查看画面。」换成「画面见【bilibili-frames】素材（仅封面与缩略图）。」。
  - `sweepMedia` ② 的 LIKE 加 `'frames:%'`，同 30 天。配置加 `bili.media.frames`（boolean，默认 **false**），schema/validate 同步。
- **测试（先写）**：
  - C1 `pickFrameUrls`：封面 + 首张 + 中间张；http、`hdslb.com.evil.com`、`evilhdslb.com`、带端口 → 丢弃；最多 3 个；videoshot code≠0 → 只剩封面。
  - C2 `fetchBiliImage`：上述非法地址、3xx、非图片类型、>2MB → null，且 3xx 时没有第二次 fetch。
  - C3 `describeFrames`：frames=false → 0 次模型调用；缓存命中 → 0 次；额度用完 → null；3 张 → ≤3 次 `describeBytes`，写入 1 次，≤600 字。
  - C4 `reportMedia`：非法 frames 被丢弃、合法的写进 payload，其余字段照旧。
  - C5 `runVideoWait`(media)：有转写 + frames → 素材为 [基础, 转写, 画面]；看图抛错 → [基础, 转写] 照常回答；`left<12` → 不调看图。
  - C6 W12 入口 ① 带 frames 重新计数仍 ≤40；本机单任务 api.bilibili.com 请求 ≤3，对 `*.hdslb.com` 的本机请求为 0（H1）。
- **V7 真机**：frames=true 时，一条以画面为主的无字幕视频，回答里出现画面描述；当日 vision 额度计数增加 ≤3；任务期间 `media-tmp` 里从未出现图片文件。
- **回滚**：`bili.media.frames=false` 部署即停；revert 无数据迁移，`frames:` 缓存 30 天内由 sweep 清掉。

## 不能动
- 轻抓取的 payload、`tier:'light'`、`fetchStatement`、`reportFetch` 协议。唯一允许的改动：在 ready 那条（7cc3d8d :304）加 `AND phase='light'`。
- `allowed()`，以及「Cookie 只发往 api.bilibili.com」规则；`resolveShort`。
- 旧的 `kind='media'` 全套：7cc3d8d worker.ts:1170、1517–1550、1959–2042，runner/utility.py（含 #28 的 yt-dlp 只取音频与清理逻辑）、runner/delivery.mjs。
- 没有转写时 `videoMaterial`/`biliNoteText` 的输出（#30，逐字节不变，W27）。
- `src/vision.ts` 除 PR-C 给 `readBytesLimited` 加 export 外不动（#29 的 QQ 图白名单与跳转规则原样）。
- `biliFailReply` 的文案；`failVideoWait` 的熔断。
- `semantic.ts`，包括 c1b 加的 repo_file 接线。
- bili 分支的 4000/10000 常量和 `materialInjected`。

## 风险与回滚
- **回滚**：
  1. 把 `enabled` 设为 false，部署 Worker，出现 disabled 文案；
  2. 本机暂存并 apply，移除 launchd 项；
  3. 需要彻底清掉本机文件时，跑 `install-local.py --remove-media`。
  - phase 列只增不减，不用回退。
  - PR-B 若要 revert 代码（不只是关开关）：先跑 `UPDATE jobs SET status='cancelled',error='rollback' WHERE kind='bili_media' AND status IN ('pending','running')`，再部署旧版，否则旧版 processJob（:500）和 cron（:1158）会领走 bili_media 并因缺 `p.message` 失败。PR-C 回滚只需 `frames=false`。各 PR 回滚见 §PR 分拆总表 最后一行。
- **部署顺序**：PR-A 默认关闭，所以不会安装定时项。另外 media.mjs 拿到非 bili_media 的任务时不会处理。
- **排队代价**：内存吃紧或磁盘不够时不接任务，到截止时显示 media_timeout，用户可以稍后再问。为了不占用户的机器，这个代价是有意接受的。
- **X-ASR**：
  - 单块超过 40 秒会报错，由 35 秒硬切兜底，R10 测这一条。
  - 模型目录归 NextThought 所有，目录改名后 `--check` 会失败，报 asr_unavailable，改 `asr.model_dir` 即可修复。
  - sherpa-onnx 版本固定，升级前要重跑 R12。
- **合规**：只处理群友贴出的单条链接；只下最低码率的音频流，用完即删；复用风控暂停。

## 冲突（合并时必须照做）
- **bili-reply-materials（已合入 #26/#30）**：`biliResearchMaterials` 按 §三个入口第 3 条改；`videoMaterial`/`biliNoteText` 按第 4 条加 `opts`，无转写时逐字节不变；`fetcher.mjs` 只在 client 末尾追加。
- **c1b-cloud-read（已合入 #27）**：不碰，保留 repo_file 接线。
- **pending-notice-fix（已合入 #28）**：utility.py / delivery.mjs 不碰；本方案的本机清理是 media.mjs 自己的目录（`media-tmp/`），与 `~/.inkboard-team/utility/` 互不相干，任何清理代码都不得越出 `media-tmp`、`media-reports`、`media.lock`、`media-child.pid` 四个名字（I6、R22）。
- **事件层 v2（未合入）**：确认语写法与 migrate.mjs 文件列表两处，按 §switchToMedia、§迁移 的规则由后合入的一方改；它改 worker.ts 的 chat 段时，PR-B 的 :726–759 接线以函数为准重贴。
- **迁移号**：本方案不占用；0005 归事件层 v2，0006 归 C3。

## 需要用户拍板
只有一件，且只影响 PR-C，**不阻塞 PR-A/PR-B 开工**：
- **看视频画面要花钱**。群里看图用的模型按量收费（不免费）；看一条视频的封面和缩略图约 0.003 澳元，和群里看图共用每天 300 张的上限，所以每天封顶不变（约 0.33 澳元）。只能看出画面大意，看不清 PPT、代码上的小字。
  - A：做，用同一个看图模型（付费，共用额度）。
  - B：不做画面，只用音轨转写 + 标题简介热评（免费）。
  - **默认 B**（用户要求必须免费）。选 A 后再开 PR-C。

## 自审
- **最可能出问题的地方**，各自的兜底：
  - 阶段竞争：`phase='light'` 守卫加 release，测 W16、W17、W19。
  - `/fetch/media/claim` 被旧分发吞掉：放在 dispatch 第一行，PR-A 默认关闭，测 W13、W26。
  - 安装路径：import.meta.url、绝对路径、暂存依赖清单，测 I1–I3、R13。
  - H2/H3 只写进文字、实际没执行：R20、R22、V6 都断言文件系统和进程状态。
  - 本机验收失真：`once` 与正式模式共用 `runMediaJob`、锁、清理和资源闸，只替换 claim/report 两端，A3 测到的就是线上会跑的代码。
  - #30 刚上线的已读字段被改坏：无转写时逐字节不变，W27 快照兜底。
  - 画面费用悄悄上涨：PR-C 默认关，复用 `describeBytes` 的同一额度，单视频 ≤3 张。
- **未确认**：
  - playurl 返回码（R3、V4）；
  - CDN 后缀（R1、V4）；
  - 长音频 RSS（V5）；
  - macOS 的 RLIMIT 是否可靠（不依赖它）；
  - `memorystatus_level` 阈值 25 是否合适（经验值，V6 观察）；
  - videoshot 的一切细节、Worker 能否直接取 `*.hdslb.com` 图片（C0 侦察）；
  - `client.biliLight` 是否已挂在 client 返回对象上（PR-A 动手时看一眼，没有就末尾追加导出）；
  - 事件层 v2 与 PR-B 谁先合入（两种写法都已写明）。
- **更简单的做法都不采用**：常驻轮询违反 H3；复用旧的 media kind 会被抢单；轻抓取顺带转写会堵塞；把 chat 视频交给 #28 的 utility（它已能 yt-dlp 只下音频）要为每条视频起一个 AI 代理、且 utility 是常驻循环，比单独的短命 media.mjs 更重。
- **执行者可能要猜的地方**，已写死：锁超时 60 分钟、一次运行最多 3 个任务、资源阈值、release 时 attempts 怎么算、waiters 上限 10、asrfail 的 4 种 reason 和 24 小时、research 12000、plist 各键、上线顺序。

## 审查意见回应表（审查复核版 P1×7、P2×3 + 用户硬约束 H1–H4）
| # | 意见 | 处理 | 位置 | 新增/改动测试与验收 |
|---|---|---|---|---|
| P1-1 | 安装：requirements 没暂存、平铺、`~`、45 秒 pip、步骤 0 倒挂 | 采纳 | §安装、§本机 runner「路径」、§步骤 | I1–I3、R13、V0 |
| P1-2 | kind 和路由撞车 | 采纳：`bili_media` 加 `/api/runner/fetch/media/*`，放 dispatch 第一行，排除 :510、:1156 和 queueFor | §Worker 侧接线 | W13、W26 |
| P1-3 | 缓存命中绕过等待 | 采纳：三个入口统一走 `planVideo`，chat 加 `lightReady` | §planVideo、§三个入口 | W14、W15、W22 |
| P1-4 | 阶段隔离 | 采纳：reportFetch 的 ready 限定 light；reportMedia 只 ready media；未终态时 release | §Worker 侧接线、§三个入口第 2 条 | W16、W17 |
| P1-5 | 迁移不执行、不可重跑 | 采纳：PRAGMA helper 接入 migrate.mjs 并同步 schema；不用编号，0005 留空 | §Worker 侧接线「迁移」 | W18 |
| P1-6 | D1 预算 | 采纳：waiters ≤10，内联唤醒 ≤3 并检查 left，其余交给 sweep；W12 改为从真实入口计数，≤40 | §D1 预算 | W12*、W20、W21 |
| P1-7 | 租约和阶段提交没闭环 | 采纳：租约 180 秒，独立 30 秒心跳，`-u` 加 flush，409 或截止就杀进程组；报告暂存补报；入队、确认语、phase 同批加围栏 | §switchToMedia、§本机 runner | R14、R15、R16、W19 |
| P2-1 | 第二进程的登录态和限速 | 采纳：只读 Cookie，不进锁；明确速率槽不跨进程，每任务 ≤3 次请求，共享暂停 | §本机 runner「Cookie」「跨进程限速」 | R18、R19 |
| P2-2 | 脱敏和下载边界 | 采纳：每一跳校验 https、443、后缀、安全 DNS，最多 3 跳；redactUrl；env 白名单 | §本机 runner「下载」「ffmpeg」 | R2*、R4*、R5*、R8*、R17 |
| P2-3 | 90 分钟内存、4000/10000 与 24k 统一、剩余合同 | 采纳：流式分块，峰值上限写进验收（长音频未实测）；素材上限表；needsMedia 不看 enabled；TTL 30 天；失败结构；schema 和 validate | §ASR 绑定、§素材上限、§planVideo、§Worker 侧接线、§安装 | R20、W9、W11、W22–W25、V5 |
| H1 | 用户硬约束：只下音频，本机不做视频和抽帧 | 采纳：只取 `dash.audio`，m4a 和 wav 用完立刻删；画面改为 PR-C 云端 videoshot 关键帧（收费、默认不做，见拍板） | §用户硬约束、§本机 runner「下载」、§PR-C | R22（m4a/wav 即删）、V6（目录里从未出现视频） |
| H2 | 用户硬约束：临时文件清理 | 采纳：每个任务一个目录，finally 删除；启动时清孤儿，每天清报告和日志；tmp ≤2GB，不够报 local_busy；云端只存文字；报告带 `cleanup.residue`；新增 `--remove-media` | §本机 runner「启动流程」「runMediaJob」、§安装 | R6、R22、I6、W5、V6（目录为空、residue=0） |
| H3 | 用户硬约束：内存和 CPU | 采纳：单实例锁加单并发；nice 15、launchd Background/Nice/LowPriorityIO；1300MB 硬上限（脚本自检 + ps 看门狗，报 mem_limit）；流式读取；内存吃紧不 claim，排队；StartInterval 拉起，做完就退出 | §本机 runner「启动流程」「asr.mjs」「launchd」、§ASR 绑定 | R4*、R5*、R20、R22、I4、V5（RSS）、V6（nice、无孤儿进程、空闲时无进程） |
| H4 | 用户硬约束：不下载 Whisper 或任何模型 | 采纳：只读引用 NextThought 的模型；pip 只装 sherpa-onnx，加 `--no-cache-dir`；grep 禁用词 | §ASR 绑定「依赖」、§安装 | R21、V6（没有新增模型文件） |
| — | 上一轮「ASR 绑定缺失」 | 审查已撤回；补充文档整份作废 | 文件头 | — |
| 新-1 | main 已到 7cc3d8d：#30 改了无字幕文案与回答规则，#28 加了 utility 只取音频与清理，事件层 v2 占 0005 并改出站写法 | 采纳：补 7cc3d8d 锚点；有转写时改措辞、无转写逐字节不变；确认语跟随 `failVideoWait` 写法；迁移不占号；清理不越出 media 自己的四个名字 | §现状 7cc3d8d 锚点、§三个入口 第 4 条、§switchToMedia、§冲突 | W27、I6、R22 |
| 新-2 | 用户：看画面复用群里看图同一模型且必须免费，收费要标出 | 采纳：标明按量收费与估算，免费替代不存在；PR-C 写全（C0 侦察、函数、C1–C6、V7、回滚），默认不做，交用户 A/B | §PR-C、§需要用户拍板 | C1–C6、V7 |
| 新-3 | PR-A 要有本机真实跑通的验收命令，验后无残留 | 采纳：`media.mjs once <BV>`（有字幕自动拒绝），A1–A6 逐条给命令与期望 | §PR-A 本机实测、§本机 runner「once」 | A1–A6 |
| 新-4 | 写明 PR-A/B/C 文件、签名、测试、回滚、顺序与并行 | 采纳 | §PR 分拆总表、§步骤 | — |
