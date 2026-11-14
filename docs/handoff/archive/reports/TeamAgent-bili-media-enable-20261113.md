# B 站音轨转写开关上线与 V0–V6 验收（2026-11-13）

## 现场状态（22:36 Sydney，只读核查）
- 分支/PR：`agent/bili-media-enable` **不存在**（`git branch -a` 无匹配），无开关 PR。
- 线上：`/health` release=`8f0e3fdf6a92cbb7540926d3ddd564ccb1a6e715`，即 PR-A #31 + PR-B #32 已合并并部署，`bili.media.enabled` 仍为 **false**（仓库 `config/team.json` 为 false）。
- 本机：`com.inkboard.team-media` **未安装**（launchctl 找不到服务）。
- 残留：无 `media.mjs|xasr_transcribe|ffmpeg` 进程；`media-tmp/` 空；`media-reports/` 不存在；`media.lock`、`media-child.pid` 不存在。
- 结论：没有半途状态，从第 1 步（开分支改开关）开始。

## 步骤记录
1. 开关 PR #33：分支 `agent/bili-media-enable`（6179f3d，只改 config/team.json 一行）→ squash 合并 **df11aa2**。PR 无 CI（[skip ci]，避免 push main 自动部署）；本地 `check-config` 0、`npm run check` 0。
2. 手动部署（CLOUDFLARE_API_TOKEN 从私有凭据文件读入，未落日志）：`npm run deploy` → Worker 版本 **b193ee3b-a542-4758-9d6f-79205795949e**；`verify-release` 通过，`/health` release=`df11aa26d6b01b897d03ed5fbd9e937c8c73d446`。
   回滚点：上一版 **8baf52c1**（release 8f0e3fd），更早 f7cb76c8（release 7cc3d8d）。
3. 部署前 `/api/runner/idle` → `{"idle":true}`；迁移本版无 schema 改动，未重跑。
4. 本机：`python3 scripts/install-local.py` 暂存 df11aa2 → `--apply` 安装；`com.inkboard.team-media` 已加载（StartInterval=60、Nice=10、Background、LowPriorityIO，无 KeepAlive/RunAtLoad）；`com.inkboard.team-fetch` 在 apply 时出现已知重载竞态，已用 `launchctl bootstrap` 恢复，state=running。
5. X-ASR `--check` = 0；venv 53M；没有新增模型（既有 .onnx mtime 2026-09-30，registry.bin 2026-06-01）。

## 真实消息回放（发往不存在的 REPLAY-GROUP-*，不往群里真发）
- 机制：从线上 D1 取真实 messages/message_meta，复制为 REPLAY-* 消息，群号改成不存在的 REPLAY-GROUP-*，直接入 chat 任务；worker 正常跑 fetch/video_wait/bili_media，outbox 因群号无效而 failed，未触达真实群。
- **V1** 真实消息 BV1MEW46JEYB（951s 无 CC）：ack → 2.5 分钟内回答 855 字，开头「根据音轨转写…覆盖 0:00–15:50」；residue=0。
- **V2** 公开英语演讲 BV1EJhE6cE6Q（224s，群历史无英文视频）：英文转写 2108 字、回答 460 字 6 段要点；residue=0。
- **V3** 公开钢琴曲 BV1b1GEzmE9p（259s）：机内 **未触发 no_speech**，ASR 输出 8 段「嗯。」；用户可见回答正确识别「4:19 全程没人声，纯器乐」；residue=0。P2。
- **V4** BV1zzzzzzzzz（不存在）：fetch failed=invalid，回答通用「读取 B 站视频出了点问题」；没有真实已删除/付费视频证据。未覆盖，P2。
- **V5** 公开长视频 BV1jjBYYRE9m（3591s，59.85min）：ack「大约 8 分钟后回复」；22:55:08→23:02:37 完成（due 23:09:25 前），回答 1032 字，覆盖 0:00–59:50；进程树峰值 **728MB**，nice **10/15**；residue=0。
- **V-CC** 真实消息 UIm520q 的缓存 light（BV1irWP6PExT，subtitle_status=ok）：不建 bili_media，直接用字幕回答。当前 live 字幕接口返回 `login_required`（SESSDATA 未过期但服务端可能失效），建议用户重新扫码登录后补测 live 字幕。

## 清理与现场
- 回放数据全部删除；messages 425、message_meta 416、jobs 545、outbox 237、outbox_attempts 130、video_waits 3、media_notes 16、chat_decisions 101、model_runs 439、activity 118，**与回放前基线 delta=0**；REPLAY 标记计数全部 0。
- 最终 media-tmp=0、media-reports 不存在、qq-spool=0、无 media.lock/media-child.pid；无 xasr/ffmpeg；日志 `SESSDATA|upsig|bili_jct|mid=` 0 命中；file-deliveries 的 3 个旧回执未触碰。
- 线上 `/health` release=df11aa2；`bili.media.enabled=true`。

## 结论与未覆盖
- 核心路径通过：真实无 CC 中文（V1）、英文（V2）、60 分钟长视频（V5）、有字幕老路径（V-CC）、清理资源（V6）、定时项（V0）。
- 未达预期/未覆盖：V3 机内 no_speech 被「嗯」填充绕过（用户可见结果正确）；V4 没有真实已删除/付费视频。两项均列为 P2，未调参、未回退；如需回退，把 `bili.media.enabled` 改回 false 部署，再跑 `install-local.py --remove-media`。
- 验收证据：`/Users/yanghongming/Projects/TeamAgent-bili-media-acceptance-20261113/`（acceptance.json、checks.txt、evidence-*.json）；仓库内副本 `.agent/releases/bili-media-v1/`。`passes` 仍为 false，等测试员复核后置 true。
