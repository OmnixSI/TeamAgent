结论：打回；P0无，P1三项、P2两项。自动heavy入口确已去掉，但“只下音频、交付后清理、异常必清理”尚未兑现。审查固定e91bd6d（父210ed47），仅在临时归档副本验证。
P1 runner/utility.py:134–149、201、423：finish仅把outputs绝对路径排入file-deliveries，随后rmtree(work)立即删掉待发送文件；成功和首次报告失败→重试两种探针均队列含1文件但exists=false，delivery.mjs:53–57的realpath将失败。须先把交付文件原子移入受控delivery spool并更新路径，发送确认后再清输出；输入/下载缓存可立即清，不能删除未交付产物。
P1 runner/utility.py:224–234、267–268：附件无视频过滤直接download，yt-dlp仍bestaudio/best。实际安装的yt-dlp对本地合成“只有muxed格式”信息，在--simulate/--no-check-formats下选出muxed avc1 aac；任务探针也确实下载了upload.mp4附件。须只用bestaudio或显式vcodec=none且无视频兜底，视频附件跳过/仅抽远端音轨，不先下视频；把音频附件与链接计数统一限制为1。[格式定义](https://github.com/yt-dlp/yt-dlp#format-selection)。
P1 runner/utility.py:203–423、426–432：清理写在except/else而非覆盖整个任务的finally；stop抛SystemExit不被except Exception捕获。模拟进程交互中退出后，inputs/messages.json、合成cookies.txt及outputs文件全部残留。须统一资源finally处理SIGTERM/KeyboardInterrupt并回收子进程，报告/交付凭证另存可重试spool；补停止期间清理测试。
P2 runner/utility.py:154–168：报告失败分支删输入只留completion，flush_reports成功后却不删该任务目录；探针确认重试后仍留completion.json，且排出的交付路径已失效（P1）。另:404–406仍声称“输入已保留”，实际普通失败/超时已删除。须报告确认后清凭证目录，并按真实保留状态生成文案；重试元数据移出下载任务目录。
P2 范围：11文件中混入短链别名/短码/av转换，runner/fetcher.mjs:121仍是已在PR26返工修掉的catch{}吞原因旧实现，与本次停转写无关。须拆出这些改动或按PR26最终版协调合并；src/semantic.ts确实未变，不能把当前11文件整体称作纯缓存清理。
轻路径确认：定向F-T1从短链/别名/BV入站到fetch→report→video_reply通过，字幕/评论路径未随自动media入口一起删除；新integration的“新视频不自动media”和重复失败通知两项也通过。真实模型回答与部署后待处理旧任务未验收。
测试：正确discover命令下utility四项全绿、Node定向四项全绿；但原Python测试只验manifest数量，不验文件仍可发送。去掉cleanup使3项Python变红，恢复自动heavy使integration变红；把格式改成best时no-whisper测试仍绿，证明关键词扫描不能守住纯音频限制，应增加参数/产物/交付/停止/报告重试行为测试。
边界：只读e91bd6d，未改交付代码/分支/方案，未部署或操作真实任务/QQ/凭据；下载与模型进程全为合成桩，yt-dlp仅离线模拟，未实际下载媒体或模型。临时副本、夹具及变异已清理；未发现显式Whisper/模型下载调用，但未实测通用DSH的峰值内存与全部动态命令行为；本bot无自动监控。

---

# pending-notice-fix 复核（04ced2a，2026-11-13 11:05）

结论：打回（P1 1 条；P2 1 条）。
测试：`/usr/local/bin/python3` 3.12.3 `utility_cleanup_test`+`utility_test` **15/15**；`node --test test/delivery.test.mjs` **5/5**；成功交付、报告失败重试、SIGTERM 清理三项均过。
P1 `runner/delivery.mjs:39-101`：`.failed`/`.unknown` 发送后只保留 staged 文件，`cleanSentOutputs` 仅处理 `sent`，也没有失败次数上限。探针连续 3 次发送失败后仍留 `_deliveries/<key>/outputs/a.txt` 与 `abc.json.unknown`；现有 `failed or uncertain native sends preserve the unconfirmed staged artifact` 正把该行为写成期望。修法：manifest 记 attempts，达到上限的 failed/unknown 清理 staged 输出和目录；unknown 需按“可能已发”策略明确保留上限。
P2 `runner/delivery.mjs:44-47,100`：`.sent`/`.failed`/`.unknown` manifest 从不删除，成功交付后也只清输出；探针与 `confirmed native send...` 均留下 manifest，长期累积小垃圾。修法：report 确认后删除终态 manifest，或统一归档/限额。
其余：P1-1 成功后 outputs 原子迁入 `_deliveries` 并通过 delivery realpath；P1-2 仅 `bestaudio`、视频附件跳过、音频与链接共用 1 槽；P1-3 once finally 回收进程组和任务目录，SystemExit/KeyboardInterrupt 留停止回执；P2 报告 409/失败分支已清凭证；diff 无短链/fetcher/bili，`src/semantic.ts` 未改。并发/内存未见新增：下载串行、单 ACTIVE、50 MB/5 文件上限。
未验收：真实媒体下载、真实模型内存、部署后旧待处理任务。

---

# pending-notice-fix 复审（9ff0671，2026-11-13 11:38）

结论：打回（P1 1 条；P2 0 条）。
测试：`node --test test/delivery.test.mjs` **10/10**；`node --test test/integration.test.mjs` **33/33**；`/usr/local/bin/python3` 3.12.3 `utility_cleanup_test`+`utility_test` **15/15**；失败 3 次、unknown 3 轮、成功三条路径的 `_deliveries` 与 `file-deliveries` 最终均为空，失败不再重发、成功只发一次、报告只发一次；旧测试 `failed or uncertain native sends preserve...` 已不存在，由三个更强的 failed/unknown/partial 测试替代；diff 无短链/fetcher/bili，`semantic.ts` 未改。
P1 `runner/delivery.mjs:52-70,109-113`：达到上限的 `unknown` 会 `cleanOutputs(d, root)` 删除整个 `d.files`，而 `sent_count` 只计已确认文件。新测试 `partial uncertain delivery never resends any file and removes all outputs at the limit` 明确构造两文件：第一个发送成功、第二个 `sendFile` 抛错，3 轮后 `sends=2`、`sent_count=1`、`_deliveries` 与 queue 全空——第二个文件既未被确认发送，也被删除，用户拿不到；通知只说“可能已送达”，无法知道缺的是哪个。修法：unknown 只清已确认发送的文件，未发送文件保留并列入报告/人工取回，或对剩余文件做带幂等的单独补发。
P2 无。失败 3 次路径全部未发送且报告已失败，清理符合“失败上限后清空”；成功路径 manifest 与输出都清空，报告重试不重复发送。
未验收：真实媒体下载、真实模型内存、部署后旧待处理任务。

---

# pending-notice-fix 第三版复审（94b383f，2026-11-13 11:55）

结论：通过（P1/P0 无；P2 3 条）。
测试：`node --test test/delivery.test.mjs` **12/12**；`test/integration.test.mjs` **34/34**；`/usr/local/bin/python3` 3.12.3 `utility_cleanup_test`+`utility_test` **15/15**。
1) 两文件、第一个已发、第二个 `sendFile` 抛错：3 轮后第一个已清、第二个仍在，报告 `unconfirmed_files` 含 `second.csv`；`retain_until` 前仍保留、到点后 queue/root 全空（`partial uncertain...` 测试）。
2) failed 3 次、unknown 3 轮、完全成功：failed/success 最终 `_deliveries` 与 `file-deliveries` 全空；unknown 只保留未确认文件，24 小时后清空（`unknown...`、`failed...`、`success...` 测试）。
3) 21 个保留项/3×40 MiB：分别收敛到 20 个/2 个；只清被扫到的 retained 文件，其他任务文件不受影响（`retained unknown files obey...` 测试）。
4) 失败重试 `targets=3,sends=0`；unknown `sends=1`；部分送达 `sends=2,sent_count=1`，通知只列未确认文件且只发一次（`integration` 34/34）。
P2-1 `.agent/pending-retention-implementation.md` 仍是 9ff0671 的旧文，称 unknown 到上限丢弃 staged，与 94b383f 的 24h 保留不符；建议更新。
P2-2 `src/worker.ts:1460`：unknown 且 `sent_count == files.length` 时 `unconfirmedNames` 为空，通知会生成“附件未确认送达：。”；建议无未确认文件时走“全部文件已确认发送”分支。
P2-3 单任务 5×50 MiB 会超过全局 100 MiB，入场即被清理；通知会说明，但用户可能拿到 0 个文件；建议按单任务上限预检或明确提示重新交办。
未验收：真实媒体下载、真实模型内存、部署后旧待处理任务。

---

# image-fetch-redirect 复核（8d3eb66，2026-11-13 11:48）

结论：打回（P1 1 条；P2 2 条）。
测试：`node --test test/image-redirect.test.mjs` **21/21**；探针 `fetchImage("https://127.0.0.1.nip.io/private.png")` 返回 2 字节并实际调用 fetch；本机 `socket.gethostbyname` 确认 `127.0.0.1.nip.io`→127.0.0.1、`10.0.0.1.nip.io`→10.0.0.1。
P1 `src/vision.ts:116-132,195`：`imageUrl()` 只按 host 字面量拒私网，不做 DNS 解析；初始 URL 又只在 `hop>0` 才检查 QQ 白名单，所以 `https://127.0.0.1.nip.io/...`、`https://10.0.0.1.nip.io/...` 直接通过并 fetch 到私网。修法：初始 host 也必须在 QQ 图片白名单；或在 fetch 前解析 DNS 并拒绝私有/保留地址。
P2 `src/vision.ts:209`：`new URL(location,url)` 接受相对 Location；IR4 测试反而用 `/cdn/image` 成功跳转，与“相对 Location 要拒”不符。修法：Location 先要求 `https://` 再解析。
P2 `src/vision.ts:134,195`：redirect 白名单仅 `multimedia.nt.qq.com.cn`；`gchat.qpic.cn`（QQ 旧图床/群图，[LLOneBot 文章](https://blog.gitcode.com/040d19b8e72bca1d432cdc6f896ffbd3.html)）302 到该 CDN 会被拒。
白名单建议：保留 `multimedia.nt.qq.com.cn`；加入 `gchat.qpic.cn` 与 `*.qpic.cn`（腾讯图床，覆盖 `m.qpic.cn`）；表情/静态图确需时再加精确的 `qzonestyle.gtimg.cn`；不建议 `*.qq.com`（面太宽）。
其余：manual 两跳、逐跳 host/MIME、大小/超时、重定向 body cancel、失败原因/位置/HTTP/MIME 文案、302→CDN 成功与 302→外部/403/MIME/超大/超时测试均通过。
未验收：真实 QQ 图源跳转链、生产边缘 DNS；结论基于 21 项测试、探针及公开资料。

---

# image-fetch-redirect 返工复审（e595981，2026-11-13 11:44）

结论：通过（P1/P0 无；P2 0 条）。
测试：`node --test test/image-redirect.test.mjs` **36/36**；`test/vision.test.mjs` **18/18**；探针四域名均 `result=false,calls=0,reason=blocked,detail=url`；相对 Location `result=false,calls=1,detail=redirect_location`。
① 初始 URL 也过 `qqImageHost()`：`127.0.0.1.nip.io`、`10.0.0.1.nip.io`、`evilqpic.cn`、`qpic.cn.evil.com` 实测均在 fetch 前被拒；`gchat.qpic.cn`、`m.qpic.cn`、`a.b.qpic.cn` 实测可取。
② 相对 Location 被 `/^https:\/\//i` 拒，`/cdn`、`cdn`、`//host`、`?`、`#` 五例均只发一次请求并返回 `redirect_location`。
③ 生产白名单仅 `multimedia.nt.qq.com.cn`、`gchat.qpic.cn`、`*.qpic.cn`（`qpic.cn` 裸域被拒）；旧夹具 fastlinks/rhythm/stickers/vision 的域名改到白名单内，生产代码只放宽到已给出的三个范围，没有为过测试额外放行。
④ `redirect:"manual"`、最多两跳、5 MB、MIME、超时均保留；IR3 验证两跳成功/第三跳拒、重定向 body cancel；IR4 验证 403/MIME/超大/超时与失败文案。
其余：`applyImageOutcomes` 仍带 HTTP/MIME/reason/hop/位置与“请重发”，无“请求被拒”旧文案；无新增 P1/P2。
未验收：真实 QQ 图源跳转链、生产边缘 DNS；未跑全量 668。

---

# pending-notice-fix 增量复核（cd00772，2026-11-13 11:56）

结论：通过（P0/P1 无；P2 1 条）。
测试：`/usr/local/bin/python3` 3.12.3 `utility_cleanup_test`+`utility_test` **21/21**；`node --test test/integration.test.mjs` **36/36**。
1) 跨进程锁：`test_other_service_preserves_live_workspace_and_receipt_then_recovers_after_sigkill` 通过——重活/快活同跑时 live 目录的 `.owner.lock` 持锁，启动清扫 `owned=false` 不删；SIGKILL 后内核释放锁，下一轮 `owned=true` 清掉；无标记旧目录保留 24h（`test_recent_unmarked_legacy_task_survives...`）；普通文件才直接 unlink。
2) SIGTERM：`test_sigterm_after_success_receipt_before_staging_preserves_referenced_outputs` 通过——回执已写、产物未转存时，`discard_workspace` 调 `preserve_outputs` 原子转存后再删 work，不产生“回执引用已删文件”；`test_missing_output_receipt_recovers_as_failure...` 覆盖产物丢失时降级为失败并释放下一次 claim。
3) 通知：`test_accepted file tasks still notify terminal failure after a pending or sent acknowledgement` 通过——`answered` 去重已移除，ack 不再吞失败；media 用 `ref`、非 media 用 `b.id` 的 notice key，确认与失败分开去重，重复 report 只发一次。
范围：`371c617..cd00772` 仅 `runner/utility.py`、`src/worker.ts`、两侧测试；无 semantic/短链/fetcher。worktree HEAD `512c877` 另含 vision 改动，不属于本增量。
P2 `runner/utility.py:246,622`：根目录 `.sweep.lock` 为永久 0 字节锁文件（清扫显式跳过），每个 utility root 一个；不是任务垃圾，但“绝对零残留”需在文档说明。
未验收：真实 quick/heavy 双进程、真实 SIGKILL 时序、生产通知；其余均以合成桩复现。
