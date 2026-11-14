# TeamAgent「这份资料暂时没处理完」只读排查（2026-11-13 10:09 Sydney）
**结论：不是同一条重复发，是 4 条 B 站链接各建了一个 media 任务；heavy 通道串行、每条 480 秒超时，超时后统一发这句模板，所以像刷屏。代码里没有 40 秒限制。**
1. 出处：`runner/utility.py:397-406` 的 `except Exception` 把所有失败（超时 `:347-357`、任务未完成、没生成文件）都写成这一句；超时阈值 `config/team.json:46-47`（quick 120s / heavy 480s）。
2. 谁建的任务：`src/worker.ts:328-350` 对任何 B 站/YouTube/Vimeo 链接或 video 附件自动建 `media-<消息id>`，`lane:"heavy"`，不要求用户明确说“看视频”。
3. 近 24h：3 条已发（09:46:02、09:54:23、10:02:42），第 4 条截至 10:09 仍在跑（10:02 开始，约 10:10 到 480s）；对应 4 条消息：鸿蒙智行/MEGA `b23.tv/MV29F7r`（09:37）、同一视频完整链接 `BV1GN4p6pEEP`（09:39）、黄仁勋 `BV1MEW46JEYB`（09:42）、尼采 `BV1UxnA6yEdw`（09:47）。
4. 重复：前两条是同一个视频（短链实测 302 到 `BV1GN4p6pEEP`），被当成两份资料；两条通知相隔 8m21s，第 3 条距第 2 条 8m19s。单条消息内不会重发——outbox 用 `INSERT OR IGNORE`（`src/voice.ts:74-85`），键是 `media-result-<消息id>`。
5. 为什么没处理完：前 3 条全是 `TimeoutError: 资料任务超时`（本机 3 份 `~/.inkboard-team/utility/*/error.txt`），不是排队、不是 runner 离线；heavy 一次只跑一个，所以第 3、4 条先排队再跑满 8 分钟。任务里在下载视频/音频并用 CPU 跑 OpenAI Whisper；第 4 条 10:07 还在下载 1.42GB medium 模型。
6. 结果：outputs 全空，没有生成任何文件或视频摘要；同一时段的检索任务已完成（`research.done` 09:38:26/09:38:51），群里可能已按标题/搜索答过，但视频内容没读到。
7. 最小修法：① 不再对所有视频链接自动建 heavy 任务，先走已有 `src/fetchjobs.ts` 的字幕/评论路径，只有明确要“看视频”才升级；② 用 bvid 去重（任务和通知都按 bvid），同一视频只处理一次、只提醒一次；③ `runner/utility.py` 按原因给文案（超时就说“8 分钟没跑完”+已保留输入），失败时先用标题/简介作答；群里已有回答时不再补发空泛提醒（`src/worker.ts:1599-1606`）。
8. 40 秒：代码/配置里没有 40 秒上限；语音只读 QQ 的 `asr_refer_text`（`src/inbound.ts:61-62`、`src/view.ts:91-94`），没有本地长音频转写；上传的音频文件不会自动进 media 任务。
9. 未核实：D1 outbox 原话与精确条数——`wrangler whoami` 报未登录、OAuth 过期，无法执行 `wrangler d1 execute`；以上条数来自线上 `/api/team/state` 的 jobs/activity 与 4 份本机 completion.json。第 4 条的最终结果也尚未落盘。
10. 证据：`/Users/yanghongming/Projects/.worktrees/TeamAgent-bili-fix/{runner/utility.py,src/worker.ts,config/team.json,src/voice.ts}`；线上 release `71deb11`；另见任务目录 `work/cookies.txt`（268B，未读内容，疑似 agent 自行取用 B 站 Cookie，建议安全复核）。
