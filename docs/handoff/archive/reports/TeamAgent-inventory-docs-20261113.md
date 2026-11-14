# TeamAgent 文档遗留项盘点（2026-11-13）

> 只读盘点：未修改任何已有文件；本文件为唯一新增。
> 基线：`origin/main = df11aa2`（线上 `/health` 2026-11-13 22:5x 实测 `release=df11aa26d6b01b897d03ed5fbd9e937c8c73d446`）。
> 口径：只列「文档说过要做、但 main 里没有」或「做了但没验收」的事；已合并且无遗留的只作状态锚点。

## 0. 给 BINI 的结论（12 行）

1. **最大一件未完成：事件层 v2 已写完但没合入。** 集成分支 `agent/event-layer-v2` 比 main 多 21 个提交、80 个文件、约 1.49 万行；M0 契约、M1-R 接线、M1-S 发送状态机、G4 夹具都在分支上，`migrations/0005_event_layer.sql`、`src/send/*` 均不在 main。缺的是 rebase、M2 全量冻结审查、PR、M3 真群 15 条验收、部署。
2. **第二件：C3 子代理只完成本机侧。** `runner/subagent.py` 已随 #24 合入，但 Worker 没有 `subagent` job/tool/route，`docs/c3-runner.md` 自己写 `READER_VERIFIED=False`；群 bot 现在不能派子代理。
3. **C2「少说不知道」没有开工。** `agent/cap-c2` 零 diff；只有 C1/C1b 的仓库读取和 `toolFailure` 错误结构，没有能力清单、先查再答、分级确定性。
4. **B 站音轨转写已上线，但没有一次生产群验收。** #31/#32/#33 已合并部署，`bili.media.enabled=true`，`com.inkboard.team-media` 已装且 `StartInterval=60`，安装的 `media.mjs` 与 main 哈希一致；但 `media.log`/`media-error.log` 自 22:38 起 0 字节，V1–V4/V6 没跑。
5. **B 站 60 分钟长音频与清理已单独验收通过。** 3591 秒视频、745/769.5 MB、107.8 秒、`residue=0`；这条证据够支撑 H1–H4 的资源结论，但不等同于群内端到端。
6. **交付回执 500 正在修，未合入。** `agent/fix-delivery-legacy-receipt` 的 `30b7ce9` 已提交（runner 兼容无 id 回执、Worker 在 bind 前校验 id），尚未 push/合并；main 的 `src/worker.ts:1458-1460` 仍直接 `bind(b.id)`。
7. **Fastlinks 只完成了 P0。** #21/#22 修了截止时间、失败原因、Jina 判定；`pauseSearch` 仍 6 小时、fetcher 仍固定 10 秒轮询；P2 的 prefetch/inline/`read_x`/X 时间线未开工。
8. **看画面 PR-C 没有做，也不该按「免费」描述。** 方案 §PR-C 明说复用群里看图是 DeepSeek 按 token 计费（单视频约 0.003 澳元，共用 300 张/天）；当前 `bili.media.frames` 键不存在，默认就是不做。若用户硬性要求「免费」，只能维持不做。
9. **五条硬性要求：1 部分、2 部分、3 部分、4 已上线、5 未做。** 详见 §4。
10. **旧的一次性任务绝大多数已合并。** P0/P1/P2 表情/P4/登录/412/读图/短链/C1/C1b/C3 本机侧/B 站素材/停转写/开关都在 main；真正还值得排期的只有 §2 的 8 项、§3 的 20 项和 §3.1 的 8 组。
11. **旧 PR 的 65 条 P2 里 57 条建议作废。** 属于当时方案的边角、已被后续实现覆盖，或产品口径而非 bug（看画面、OneBot sidecar、authz 整句拒绝等）；保留的 8 组见 §3.1。
12. **建议只开两个大版本。** V-A = 事件层 v2 合并（含 rebase/审查/M3）；V-B = C3 Worker + C2 + Fastlinks P2。B 站验收与交付 500 走快速通道，不占版本。

## 1. 基线与读法

- **已核对**：`git log origin/main`、`git diff origin/main...<branch>`、`git show <branch>:<file>`、`src/*`/`runner/*` 现码、`config/team.json`、`launchctl print`、`/health`、本机 `~/.inkboard-team` 文件哈希与日志。
- **未核对**：生产 D1 表内容（没有用凭据连库）、QQ 群消息、真实 GitHub 私有仓库、事件层分支的最终全量测试（只在各子分支报告里）。
- **文档范围**：根目录 81 份 `.md`；逐份覆盖 BINI 指定的 40 份，另补同主题 18 份；其余早期草稿按主题归并，不单列条目。
- **状态符号**：✅ 已做/已上线；◐ 部分；❌ 未做；🗑 作废/不并入。

## 2. 大版本级遗留（必须排期）

| ID | 事项 | 来源 | 现状 | 卡在哪 | 还差什么 | 量 | 依赖 |
|---|---|---|---|---|---|---|---|
| A1 | 事件层 v2 合入 main | `plan-event-layer-v2.md:122-200`；分支 `agent/event-layer-v2` | ❌ 分支完成，main 没有 `src/send/*`、`migrations/0005` | 分支基于 `954aa99`，落后 main 38 个提交；未开 PR、未冻结 candidate | rebase 到 `df11aa2`；跑全量 `npm test`/`test:runner`/`check:ui`；开唯一 PR；两路审查 + 架构师终审 | L（2–3 天） | 主程、交付员、审查员/架构师 |
| A2 | 事件层 M3 真群验收 | `plan-event-layer-v2.md:201-244`；`TeamAgent-research-qqbot-synthesis:99` | ❌ 未做 | 需要部署候选 SHA 并让用户在群里发 15 条 | 按 M3 表跑 15 条（含无字幕 B 站、转发、引用、3000 字、连 @5 次、>10 MiB 文件）；查 outbox 状态分布/`chat_decisions`/`stage_timings`/本机残留 | M（半天 + 24h 观察） | 用户、交付员 |
| A3 | C3 子代理接 Worker | `docs/c3-runner.md:30-50`；`TeamAgent-c3-runner-review:1-10`；`TeamAgent-capability-synthesis:39-77` | ◐ 本机 `runner/subagent.py` 已随 #24 合入；Worker 无 `subagent` job/tool/route | `READER_VERIFIED=False`；D-1–D-26 全未做；bridge 未注册 `subagent.loop()` | 新增 job kind、`spawn_agent` 工具、claim/lease/deadline/取消/report 幂等、owner/runner 鉴权、配额、D1 ≤48、resume 转 research、bridge 安装与 idle/quiesce 计数 | L（D-1–D-26，方案未给准确人日） | 事件层 A1（worker.ts 冲突）、C3 审查 |
| A4 | C2「少说不知道」 | `TeamAgent-capability-synthesis:39-77`；`plan-event-layer-v2.md:249` | ❌ 未开工；`agent/cap-c2` 零 diff | 只有 `toolFailure` 的 error_kind，没有能力清单/先查再答/分级确定性 | 5 个模式：动态能力清单、工具优先门、可执行失败、查证/推断/未验证分级、无 delegate 不说「我有团队」 | M（3–5 天） | A3（子代理工具是能力清单的一部分） |
| A5 | Fastlinks P2：prefetch/inline/`read_x`/X 时间线 | `plan-event-layer-v2.md:255`；`TeamAgent-fastlink-synthesis:98-107`；`TeamAgent-fastlinks-v3.1-plan-review:3-7` | ❌ 未开工 | 需要用户重新登录 X；要改 `semantic.ts` 派发，事件层 v2 明确不碰 | `read_x` 单推/时间线/线程/引用；缓存 key 改 bvid+别名；最新推文 `created_at` 校验；失败/信任契约；`get_work_status` 映射 | M（5–8 天） | 用户重登 X；A1 合并后避免 semantic 冲突 |
| A6 | B 站 V1–V4/V6 生产验收 | `plan-bili-video-v1.md:466-477`；`TeamAgent-bili-media-enable-20261113.md:1-14` | ◐ V0/A3/V5 已过；V1–V4/V6 未跑 | 没有真实群消息触发过 `bili_media`；`media.log` 0 字节 | 3–6 分钟中文、5 分钟英文、纯音乐 `no_speech`、充电/已删除；每条查 `media-tmp`/`media-reports`/`residue`/孤儿进程/nice/日志密钥扫描 | S（一次群验收） | 用户发 4 条视频 |
| A7 | 交付回执 500 修复 | `TeamAgent-bili-media-longrun:32-60`；`issue10-recon:1-12` | ◐ 分支 `agent/fix-delivery-legacy-receipt` 已提交 `30b7ce9`；main 仍有 bug | 未 push/合并/部署；main `src/worker.ts:1458-1460` 直接 `bind(b.id)` | 跑定向 + 全量测试；合并；把 3 个旧 `.sent` 回执归档/清理；部署后看 10 秒轮询不再 500 | S | 工程师（进行中，不要打断） |
| A8 | 事件层 0005 与 C3 0006 的迁移号 | `plan-event-layer-v2.md:95-114`；`plan-bili-video-v1.md:530-536` | ✅ 已按方案避开：main 只有 0002–0004，事件层用 0005，C3 留 0006 | — | 合入时确认 `scripts/migrate.mjs` 登记顺序；C3 再建 0006 | XS | A1/A3 |

## 3. P2/小项（可并入下一版，或明确作废）

| ID | 事项 | 来源 | 现状 | 证据 | 还差什么 | 量 | 处置 |
|---|---|---|---|---|---|---|---|
| B1 | issue10 解锁码经 `open` argv 暴露 | `issue10-recon:3-5` | ❌ 未修 | `runner/owner_unlock.py:96-104` 仍把 `#unlock=<code>` 放进 `/usr/bin/open` 参数 | 改 OS 用户保护通道/交互式 owner 认证；或至少短时文件描述符传递 | S | 并入小修 |
| B2 | 旧格式 bili-cookie 不兼容 | `issue10-recon:6-8` | ❌ 未修 | `runner/browser-auth.mjs:40-44` 只认 `{name:{value,expires}}` | 读取时兼容扁平 `{SESSDATA:"..."}`，成功登录后迁移；不读日志/不上云 | S | 并入小修 |
| B3 | C1 `sid/session` 的 base64 值漏脱敏 | `TeamAgent-c1-followup-review:1-6` | ❌ 未修 | `runner/repo_index.py:34` 字符集仍 `[A-Za-z0-9_-]`，不含 `+/=` | 扩字符集或按引号整体匹配；补 `{"session":"<base64>"}` 断言 | S | 并入小修 |
| B4 | C1b Python 与本机 DENY 不一致 | `TeamAgent-c1b-cloud-review:20-30` | ❌ 未修 | `runner/repo_index.py:62-64` 只匹配 full/base；TS `src/github.ts` 按任意 path part | `dir/secret.pem/notes.txt` 双端一致；补 `deny_cases.json` | S | 并入小修 |
| B5 | B 站空评论文案自相矛盾 | `TeamAgent-bili-answer-fields-review:6` | ❌ 未修 | `src/fetchjobs.ts:133-141` 空评论仍写「热评：未读到」+「基于标题与评论」 | 按 `comments.length` 二选一；补空评论断言 | S | 并入 B 站小修 |
| B6 | 「受信任前导」仍在 materials 数组 | `TeamAgent-bili-answer-fields-review:7` | ❌ 未修 | `src/fetchjobs.ts:145-149` `BILI_ANSWER_RULE` 与素材同数组 | 移入系统提示/独立 system message；或改 participation 明确豁免 | S/M | 并入 B 站小修 |
| B7 | B 站标题搜片真实正向未验收 | `TeamAgent-bili-card-review:16-19` | ◐ 真实卡片字段与匿名搜索仍可能 v_voucher | `runner/bili-title.mjs` 搜索冷却 6h；真实群正向样本未记录 | 群冒烟发一张真实转发卡片；保留 v_voucher 不重试断言 | S | 群验收 |
| B8 | 单任务 5×50 MiB 可超全局 100 MiB | `TeamAgent-stop-media-cleanup-review:44` | ❌ 未修 | `runner/utility.py:404` 最多 5 附件，各 50MB；`delivery.mjs` 全局上限 100MiB | 入场按全局上限预检，或提前提示「只能保留 2 个」 | S | 并入小修 |
| B9 | `pauseSearch` 6 小时偏长 | `TeamAgent-fastlink-synthesis:98,103` | ❌ 未修 | `runner/bili-title.mjs:23` 仍 `6*3600000` | 降到 30–60 分钟，记录 voucher 次数 | S | 并入 Fastlinks |
| B10 | fetcher 固定 10 秒轮询 | `TeamAgent-fastlink-synthesis:104` | ❌ 未修 | `runner/fetcher.mjs:240,243` 仍 `sleep(10000)` | 2 秒 + 空队列指数退避到 10 秒 | S | 并入 Fastlinks |
| B11 | `.sweep.lock` 永久 0 字节文件 | `TeamAgent-stop-media-cleanup-review:77-83` | ✅ 设计保留 | `runner/utility.py:246`、`:622` 显式跳过 | 文档写明「不是任务垃圾」即可 | XS | 🗑 文档说明 |
| B12 | 部署后 fetcher 重载竞态 | `deploy-runbook.md:197-204` | ◐ 已用固定 node 路径恢复 | `reload.log` 曾出现「team-fetch 加载失败」 | 每次部署后 `launchctl print` 核对 `state=running`；可加自动检查 | S | 运维检查 |
| B13 | unknown 交付保留 24h/20 文件/100MiB | `TeamAgent-stop-media-cleanup-review:36-44` | ✅ 设计如此 | `runner/delivery.mjs:44-74`；`src/worker.ts:1470-1475` | 无需改；但用户要知道「未确认文件不会立即删」 | XS | ✅ 已知 |
| B14 | X 需要用户重新登录 | `plan-event-layer-v2.md:255`；`TeamAgent-x-login-research` | ❌ 未做 | 当前 X 登录态未核；Fastlinks P2 前置 | 用户扫码一次；再跑单推/时间线 | S | 用户 |
| B15 | C3 真实模型工具事件/原生空文件事件未过 | `docs/c3-runner.md:30-31` | ❌ 未做 | `READER_VERIFIED=False`；S-26(g)(h) 待现场核 | 真实 DSH 工具表、未知工具、README read 事件；过了才翻 True | M | A3 前置 |
| B16 | 事件层 G4 的 2 skip/4 todo | `event-v2-g4-report` | ◐ 已知缺口 | face base64 ext 解不出；E10 bili 字幕/ASR 门控；E43–E46 属 v2.1 | bili 已合入后可补 E10；face base64 另开小项；E43–E46 归 A5 | S/M | A1/A5 |
| B17 | 看画面成本口径 | `plan-bili-video-v1.md:530-543` | 🗑 默认不做 | PR-C 未建；`bili.media.frames` 键不存在 | 若用户坚持「免费」，保持不做；要做则按 $0.003/视频、共用 300 张/天 | S | 用户决定 |
| B18 | 文件任务里的 B 站链接未接 X-ASR | `plan-bili-video-v1.md:34` | ❌ 明确列为后续 | `runner/utility.py` 文件任务仍 yt-dlp 只下音频、提示词禁止转写 | 复用 `runner/xasr_transcribe.py`；任务结束清理；只下音频 | M | A6 后 |
| B19 | 事件层真实 QQ 业务码/seq 去重未实测 | `plan-event-layer-v2.md:231-243`；`TeamAgent-g7-remote-d1` | ◐ 远程 D1 7/7 MATCH，真实 QQ 未测 | `off:unknown_resend` 默认关；429/去重/禁言只单测 | M3 真群观察；按需开 unknown 重发 | S | A2 |
| B20 | 事件层分支 rebase 冲突 | A1 | ❌ 未做 | merge-base `954aa99`；main 已加 #31–#33 的 `worker.ts`/`fetchjobs.ts` | 先 rebase；冲突点 `failVideoWait`、`worker.ts` chat 段、`migrate.mjs` 文件列表 | M | 主程 |

### 3.1 旧 PR 的 65 条 P2 取舍

子代理逐份提取了 18 份旧评审的 65 条待办；按代码/文档分拣后，只有下面 8 组还值得看一眼，其余 57 条属低频边界、产品口径或已被后续提交覆盖，统一标「不并入」。

| ID | 事项 | 来源 | 现状 | 证据 | 还差什么 | 量 | 处置 |
|---|---|---|---|---|---|---|---|
| B21 | X 会话判定边角：`xSessionUrl` 排除整个 `/i/`；`currentXPage` 的 `evaluate(hasFocus)` 无超时；只看 `auth_token` 存在 | `TeamAgent-x-login-real-edge-rereview2:10-12`；`TeamAgent-x-login-real-edge-review:15` | ❌ | `runner/browser-auth.mjs:96-112`、`:174` | 只排除 `/i/flow`、`/i/jf`；evaluate 加 500ms 超时；要求 x.com 且非 `/login` 或 ct0 | S | X 重登时一起 |
| B22 | 本机登录回收：只按 mtime、无持有者校验；在途 ok 跨倒计时被丢；B 站扫码未显式用系统 CA | `TeamAgent-local-login-page-review:64-68`；`TeamAgent-login-diagnosis:12` | ❌ | `runner/local_bili_login.py:66-67,98`；`runner/local_login_page.py:22-23` | 回收前验存活/所有权；有界收尾；扫码显式系统 CA | S | 下次登录页改动 |
| B23 | P0a 三个读取口径：DeepSeek `<500` 字仍 ok、私有 GitHub 仍走 raw/Jina、oEmbed 未校验返回 id/作者 | `TeamAgent-p0a-review2:8`；`TeamAgent-p0a-review:12-14` | ❌ | `src/semantic.ts:419,446,409` | 统一 short 口径；私有库交 repoContext；oEmbed 校验 id/author | S | Fastlinks P2 时一起 |
| B24 | 同一图片同轮并行仍调模型两次、扣两次预算 | `TeamAgent-p4ac-review:6,25` | ❌ | `src/vision.ts:295,350` | 同 sha+版本合并 in-flight；补预算断言 | S | 看图成本优化 |
| B25 | C1 生产 loop 未传 cookie `known_values`；`DEEPSEEK_API_KEY` 未进 known_values；D1 旧污染行不回洗 | `TeamAgent-c1-review:36,38-39`；`c1-pr23-a676-review:38-39` | ◐ | `runner/repo_index.py` `sync_once`；D1 `repo_commits` | 从 bridge 内存传已知值；补 key 名；按风险表手工清污染行 | S | C1 维护 |
| B26 | C1b 边角：stderr 无界收集、W16 测试误用 `create_file_task`、`tick` 未实现、HTTP 10ms 误套 Queue 30s、`since/author` 旧契约、`ghFetch` 无 signal、0 字节当 too_large | `TeamAgent-c1b-plan-review2:4-7`；`c1b-cloud-read-plan-review:6-11` | ◐ 部分已实现 | `runner/gitsafe.py:137-141`；`src/github.ts`；`src/worker.ts` | 逐条在 C1b 维护单里核；低风险，不阻塞 | M | C1b 维护 |
| B27 | C3 的 `~` 证据边界、reader patch 原子发布、marker 容错 | `TeamAgent-c3-runner-review:8-10` | ✅ 已修（有先红后绿测试） | `runner/subagent.py` | 无 | XS | ✅ |
| B28 | 表情/读图低风险 P2：失败计数两批中断、`DELETE FROM stickers` 不清 `media_notes`、explicitFace 缺 size 仍进候选、旧图注话术、`console.info` 量大 | `TeamAgent-sticker-followups-review:10-12`；`TeamAgent-vision-fix-review:11-13` | ◐ | `src/stickers.ts`、`src/vision.ts` | 文档说明/采样日志；不阻塞 | S | 🗑 不并入 |

## 4. 五条硬性要求

| # | 要求 | 结论 | 已做的证据 | 还差什么 |
|---|---|---|---|---|
| 1 | B 站无字幕视频必须能总结（X-ASR 本机转写；看画面不做/免费） | **部分** | #31 `9616de6`、#32 `8f0e3fd`、#33 `df11aa2` 已合并；线上 `/health=df11aa2`；`config/team.json:91-98` `media.enabled=true`；`com.inkboard.team-media` 运行中、`StartInterval=60`；安装的 `media.mjs` 与 main SHA256 相同；60 分钟验收 `TeamAgent-bili-media-longrun`（745/769.5MB、107.8s、residue=0）；951 秒真机 `bili-asr-cdn-fixed`（27s、789MB） | 生产群没有跑过 V1–V4/V6；`media.log` 0 字节；看画面未做（PR-C 默认 B，且方案说看图收费，不是免费） |
| 2 | 群里 bot 能看到仓库代码、不说「做不了」 | **部分** | #23 `61fb8cf` 仓库索引 + #25 `210ed47` 加固 + #27 `68ef1c3` 云端直读；`src/repo.ts` 提供 `repo_file` read/list/find；`config/team.json` 白名单 5 个仓库（含 TeamAgent）；`repo_tools` 默认开；C1b 最终复核通过（P2 3 条） | C2 五模式未做（能力清单/先查再答/分级确定性/无 delegate 不说有团队）；C1b 仍有 Python DENY 不一致、base64 hex、字面 `%2f` 三个 P2；真实私有仓库/生产子请求未验收 |
| 3 | bot 能自己指挥子代理 | **部分（不可用）** | #24 `71deb11` 合入 `runner/subagent.py`、`runner/gitsafe.py`、753 行测试；C3 文档、租约、沙箱、回收都在 | Worker 侧 D-1–D-26 全未做：无 `subagent` job kind、无 `spawn_agent` 工具、无 route、bridge 未注册；`READER_VERIFIED=False`；`src/repo.ts:14` 仍写「C3 上线后可派子代理」 |
| 4 | 本机不当服务器、用完清理、内存受控 | **已上线（机制）** | #28 `cd222c4` 停自动 heavy + utility 清理；#31 只下音频、`media.mjs` 短命单实例；`config` 上限 90 分钟/1300MB/2048MB；launchd `Nice=10`、`LowPriorityIO`、`ProcessType=Background`、`StartInterval=60`；长音频 769.5MB、`residue=0`、无孤儿进程、只出现 `a.m4a`/`a.wav` | 生产群尚未跑过；`.sweep.lock` 永久 0 字节（按设计）；unknown 交付保留 24h/100MiB（按设计）；每次部署需核对 fetcher `state=running` |
| 5 | 每个大版本落地后让群里 bot 说一句「这次自己新加了什么」 | **未做（无证据）** | 仓库无 release-note 文件、无提示词/工具；`grep -rn '新加\|自己新\|版本说明'` 只命中两份旧计划 | 加 `docs/releases/<版本>.md` + 部署后由 bot 读一行发群；或在 `verify-release.mjs` 后加一条固定播报；当前只能人工让 BINI 代说 |

## 5. 旧一次性任务/文档逐份结论

| 文档 | 当时结论 | main 现状 | 遗留价值 |
|---|---|---|---|
| `plan-bili-video-v1.md` | v3 定稿 | #31/#32/#33 已合；V1–V4/V6 未验 | §2 A6；§3 B17/B18 |
| `plan-bili-video-xasr-addendum.md` | X-ASR=sherpa-onnx | 已实现（`xasr_transcribe.py`/venv/模型只读）；MLX 问题已排除 | 🗑 无 |
| `plan-event-layer-v2.md` + review 1/2/3 | 方案经三轮审查通过 | 分支完成、main 未合 | §2 A1/A2；§3 B16/B19/B20 |
| `deploy-checklist-20261113.md` | 以 `71deb11` 为目标的旧清单 | 已过时（现 `df11aa2`） | 🗑 作废 |
| `deploy-runbook.md` | 部署/回滚手册 | 仍有效 | §3 B12 |
| `issue10-recon.md` | 3 条，1 条已修 | `dd0f9f3` 已合 #14；解锁码/旧 Cookie 未修 | §3 B1/B2 |
| `bili-412-diagnosis.md` | 412 根因+修法 | #5 已合 | 🗑 无 |
| `bili-asr-cdn-fixed-20261113.md` | CDN 完整下载修好，本地提交 | 已随 #31 合入 | 🗑 无（V5 已补） |
| `bili-asr-cdn-handoff.md` | 下载失败交接 | 已被 cdn-fixed/#31 取代 | 🗑 作废 |
| `bilibili-anonymous-412-research-2026-11-12.md` | 匿名设备 Cookie | #5/#22 已实现 | 🗑 无 |
| `research-bili-card-and-link-reading-codex-2026-11-12.md` | 单家调研 | 已被 #26 覆盖 | 🗑 无 |
| `TeamAgent-b23-short-link-recon/evidence` | 别名/短码/research 丢素材 | #26 已加 `bili2233.cn`、4–32 位短码；`worker.ts:563` 已补 `biliResearchMaterials` | 🗑 已修 |
| `TeamAgent-bili-412-review.md` | 通过 | #5 已合 | 🗑 无 |
| `TeamAgent-bili-answer-fields-review.md` | 通过，P2×2 | #30 已合；P2 仍在 | §3 B5/B6 |
| `TeamAgent-bili-asr-local-handoff.md` | A3 未过 | 已被 cdn-fixed/#31 取代 | 🗑 作废 |
| `TeamAgent-bili-card-review.md` | 通过，P2×2 | #11 已合；ownUrls 已排除 attachments；真实卡片未正向 | §3 B7 |
| `TeamAgent-bili-material-envelope-review.md` | 通过 | #30 已合 | 🗑 无 |
| `TeamAgent-bili-media-enable-20261113.md` | 开关上线，标题写 V0–V6 | #33 已部署；正文只有 1–3 步，无 V1–V6 | §2 A6 |
| `TeamAgent-bili-media-longrun-20261113.md` | 60 分钟通过 | 证据有效；含 500 根因 | §2 A7 |
| `TeamAgent-bili-reply-materials-review/2` | 打回→通过 | #26/#30 已合 | 🗑 无 |
| `TeamAgent-bili-video-plan-review.md` | 打回 P1×7/P2×3 | 方案 v3 已逐条回应；代码 #31/#32 落地 | P2 随实现部分处理；未单列 |
| `TeamAgent-bili-video-recon2.md` | media 常驻可行 | plist 已装、`SERVICES` 已含 media、asr 配置已支持 | 🗑 无 |
| `TeamAgent-bili-video-research-codex/deepseek/synthesis` | 三段式调研 | P0/P1 音轨已做；P2 画面未做 | §3 B17 |
| `TeamAgent-c1-fetch-credentials-plan-review.md` | 方案 P2/验收缺口 | C1 #23/#25 已合 | 🗑 无 |
| `TeamAgent-c1-review/followup/pr23-*` | 多轮审查，最终通过 | #23/#25 已合 | §3 B3 |
| `TeamAgent-c1b-plan-review/2`；`c1b-cloud-read-plan-review` | 方案审查 | #27 已合 | 🗑 无 |
| `TeamAgent-c1b-cloud-review.md` | 通过，P2×3 | #27 已合；P2 仍在 | §3 B4 |
| `TeamAgent-c3-runner-review.md`；`c3-sandbox-boundary` | 打回→修复/通过 | #24 已合；P1-1 敏感文件 deny 已在现码补上；`READER_VERIFIED=False` | §2 A3；§3 B15 |
| `TeamAgent-capability-plan-review/2/3`；`capability-synthesis` | 方案审查；C1/C2/C3 分线 | C1/C1b/C3 本机已合；C2 未开 | §2 A3/A4 |
| `TeamAgent-fast-links-design-lead-20261112.md`；`fastlink-synthesis` | 设计/调研 | P0 已做（Jina/失败原因/截止）；pauseSearch/轮询未做 | §3 B9/B10 |
| `TeamAgent-fastlinks-v3-plan-review.md`；`v3.1` | 方案审查 | v3.1 未实施；P2 仍适用 | §2 A5 |
| `TeamAgent-g7-remote-d1.md` | 远程 D1 7/7 MATCH | 证据有效 | 🗑 无 |
| `TeamAgent-image-edge-rootcause-20261113.md` | 根因+修复 | #29 已合；qpic 白名单/相对 Location 已修 | 🗑 无 |
| `TeamAgent-issue10-idle-review.md` | 通过 | #14 已合 | 🗑 无 |
| `TeamAgent-latency-breakdown/live-read-test` | 延迟/读消息分析 | 结论已被 #21/#22/#23 覆盖 | 🗑 无 |
| `TeamAgent-local-login-page-review.md`；`login-diagnosis` | 打回→修复 | #12 已合 | §3.1 B22（mtime 回收/在途 ok/系统 CA） |
| `TeamAgent-p0-plan-check`；`p0a-review/2`；`p1-review`；`p1p2-*`；`p4-*` | 多轮审查 | #6/#9/#11/#13/#15 已合；`oldest_ts` 已 `||0` | 65 条 P2 中 57 条作废；保留 8 组见 §3.1（B23–B26/B28） |
| `TeamAgent-pending-notice-recon.md` | 只读排查 | #28 已合 | 🗑 无 |
| `TeamAgent-recon-bot-capability-20261112.md` | 现状侦察 | 已被 C1/C1b/C3 取代 | 🗑 无 |
| `TeamAgent-research-qqbot-codex/deepseek/synthesis` | 联合调研，推荐事件层 v2 | 事件层分支已按 B 路线建；C 路线 sidecar 后置 | §2 A1/A2；附录 |
| `TeamAgent-sticker-followups-review.md` | 通过，P2×2 | #13 已合；P2 属低频边界 | 🗑 不并入 |
| `TeamAgent-stop-media-cleanup-review.md` | 打回→通过，P2×3 | #28 已合；P2 见 B8/B11/B13 | §3 B8/B11/B13 |
| `TeamAgent-verify-facts.md`；`what-bot-can-read.md` | 事实核查/能力边界 | 读图失败已由 #29 修；无新增 | 🗑 无 |
| `TeamAgent-vision-fix-review.md` | 通过，P2×3 | #15/#29 已合；P2 仅日志/旧数据 | 🗑 不并入 |
| `TeamAgent-x-login-real-edge-*`；`x-login-research` | 多轮修复/调研 | #16 已合；X 仍需用户重登 | §3 B14；§3.1 B21 |
| `TeamAgent-xasr-recon-20261113.md` | X-ASR 可用，40s 上限 | 已实现并验收 60 分钟 | 🗑 无（Swift/160ms/Whisper 对照不在需求内） |

## 6. 建议版本切分

**快速通道（不占版本，1–2 天）**
- A7 交付 500：合并 `30b7ce9`，部署，确认 10 秒轮询不再 500。
- B1/B2（issue10 两条）、B3/B4（C1/C1b 小脱敏/路径）、B5/B6（B 站空评论/前导）、B8（交付上限）合成一个 `fix/hardening` 小 PR。
- A6 B 站 V1–V4/V6：不改代码，用户在群里发 4 条，交付员记录证据。

**V-A：事件层 v2（唯一大版本，L）**
- rebase `df11aa2` → 全量测试 → PR → 两路审查 + 架构师终审 → 合并 → 部署候选 → M3 15 条 → 24h 观察。
- 同时补 B16 的 E10（bili ASR 门控）与 face base64（如不影响排期）。
- 完成后按硬性要求 5 发一条「这次新加了什么」。

**V-B：能力线（M，可与 V-A 串行）**
- A3 C3 Worker（先只读 `research_readonly`，并发 1）→ B15 真实模型探针 → 开 `READER_VERIFIED`。
- A4 C2 五模式；A5 Fastlinks P2（需先让用户重登 X）。
- 顺序：C3 → C2 → Fastlinks，避免 `semantic.ts` 三线同时改。

**V-C（可选，M）**
- B18 文件任务 B 站链接接 X-ASR；B17 看画面仅在用户明确同意付费后做；否则保持不做。

## 7. 未核实与边界

- 没有连生产 D1 查 `repo_state`/`deliveries`/`outbox` 实际行；结论基于代码、文档、`/health` 和本机文件，未把「代码有」当成「线上已验证」。
- 没有 QQ 群消息读取权限；硬性要求 5 只能判「仓库无实现/无记录」，不能排除 BINI 在群里人工说过。
- 事件层分支的 847/894/1019 测试来自各子线程报告，未在集成分支 `693992e` 上重跑；A1 的第一步就是重跑。
- `TeamAgent-bili-media-enable` 标题写 V0–V6，但正文只有 3 步；我按「未记录=未验收」处理。
- 看画面成本按方案 §PR-C 的 2026-11-13 价目（DeepSeek 输入 $0.30/百万 token、输出 $1.20/百万 token，单图 ≤1024 token，单视频 ≤3 张）；BINI 简报里的「免费」与方案不一致，已在 B17 标出。
- 旧 PR 的 65 条 P2 我按代码/文档分拣为「8 组保留 + 57 条作废」；57 条没有逐条写进报告，只按主题归并。若 BINI 要全量审计，我可以再开一轮只读复核。

## 附录：证据索引

- 主线：`git -C .worktrees/TeamAgent-deploy-bili log --oneline origin/main`；`/health`；`config/team.json:88-99`。
- 事件层：分支 `agent/event-layer-v2`（tip `693992e`，21 commits，`src/send/*`、`migrations/0005_event_layer.sql`）；`docs/qq-events.md`；`.worktrees/TeamAgent-event-v2-main/.agent/m1-s-final-report.md`；`.worktrees/TeamAgent-event-v2-fix/.agent/event-v2-g4-report.md`。
- C3：`docs/c3-runner.md:1-50`；`runner/subagent.py:489-491`；`TeamAgent-c3-runner-review-20261113.md`。
- B 站：`TeamAgent-bili-media-longrun-20261113.md`；`bili-asr-cdn-fixed-20261113.md`；`TeamAgent-bili-media-enable-20261113.md`；`plan-bili-video-v1.md:466-477`。
- 交付：`TeamAgent-bili-media-longrun-20261113.md:32-60`；`src/worker.ts:1454-1512`；分支 `agent/fix-delivery-legacy-receipt` `30b7ce9`。
- 清理：`TeamAgent-stop-media-cleanup-review-20261113.md:36-44,77-83`；`runner/delivery.mjs:44-110`；`runner/utility.py:246,622`。
- 仓库读取：`src/repo.ts`；`src/github.ts`；`TeamAgent-c1b-cloud-review-20261113.md`；`TeamAgent-c1-review-20261113.md`。
- Fastlinks：`TeamAgent-fastlink-synthesis-20261112.md:98-107`；`runner/bili-title.mjs:23`；`runner/fetcher.mjs:240,243`；`TeamAgent-fastlinks-v3.1-plan-review.md:3-7`。
- 旧 issue：`issue10-recon.md:3-8`；`runner/owner_unlock.py:96-104`；`runner/browser-auth.mjs:40-44`。
