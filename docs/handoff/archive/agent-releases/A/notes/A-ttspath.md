# A-ttspath · TTS/ASR ffmpeg 绝对路径 + 生图额度行

- 2026-11-14 15:00 Sydney 开工：worktree `.worktrees/TeamAgent-A-ttspath`，分支 `pkg/A-ttspath`，基线 main `28a1238`。
- 背景：qq launchd 无 PATH → tts.mjs 裸 ffmpeg ENOENT → 被 asr.mjs 记成 asr_unavailable → 语音降级文字。
- 15:10 实现：`runner/toolchain.mjs`（FFMPEG_BIN/FFPROBE_BIN → /opt/homebrew/bin → /usr/local/bin → PATH）；tts/voice/silk/media/utility 全改绝对路径；`runCommand` 支持 missingReason；qq-gateway 启动预检并把 tools 放进 gateway-status；Worker 存 `qq_gateway.tools`，看板缺 ffmpeg 时显示徽标；`off:image_gen=1` 时额度回复不再有生图行；新增 `scripts/patch-qq-plist.py`（只改 EnvironmentVariables.PATH，不重启）。
- 测试：`npm run check` 干净；`npm run check:ui` 通过；`npm test` 1933 tests / 1923 pass / 0 fail / 10 skipped；plist 补丁 6/6；utility 12/12。
- 极简 PATH：`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` 下预检 ffmpeg=/opt/homebrew/bin/ffmpeg、ffprobe=/opt/homebrew/bin/ffprobe；真实 DeepSeek TTS 一句「验证语音。」→ 24 kHz mono 16-bit WAV 59,598 B → SILK 4,415 B（#!SILK_V3），同一份 WAV 在极简 PATH 下转 SILK 成功。
- 证据：`.agent/releases/A/evidence/tts-live-2026-11-14.json`、`tts-live-2026-11-14.silk`、`toolchain-minpath-2026-11-14.txt`；plist 补丁副本 `.agent/releases/A/com.inkboard.team-qq.plist.patched`。
- 提交：83c3b71（runner 工具链）、2cfb4bd（quota 行）、34fbd6b（健康信息）、0685d0e（plist 补丁脚本）。
