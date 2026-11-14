# PR-A CDN 完整下载交接（2026-11-13 18:02 Sydney）
状态：停止修改、未提交。工作树 /Users/yanghongming/Projects/.worktrees/TeamAgent-bili-asr-local，分支 agent/bili-asr-local，HEAD 7cc3d8d2949f725e326460192bb77404ee6c71ba；15 个文件与 asr-source-manifest.json 哈希一致。
失败现象：历史无字幕 BV1MEW46JEYB（951 秒），命令 node runner/media.mjs once BV1MEW46JEYB 三次均 exit 1 / error=download_failed / cleanup.residue=0；最后墙钟 11.91 秒。真实 B 站下载→转写未通过，未做 3–6 分钟和约 60 分钟验收。
已记录的完整 GET：首轮同一任务 runMediaJob 诊断，下载主机 upos-sz-mirrorcosov.bilivideo.com，HTTP 567；音频写入字节=0（由拒绝状态码后未 open 文件、files_seen=[] 可确认）；HTTP 响应体实际接收字节未计数；Node 错误 reason=download_failed，无原始 error.code，未进入 ffmpeg。备份源 upos-hz-mirrorakam.akamaized.net 的 HEAD=403。
排除项：浏览器格式 UA + Range bytes=0-511 的小范围 GET，两主机均 HTTP 206 / server=openresty / content-type=video/mp4；该 MIME 是 DASH 音频容器，不能据此声称下过视频；仅检查状态后销毁连接，未测已收字节或完成整条流。
两次修改记录：①仅换浏览器 UA，完整 GET 仍 download_failed（9.64 秒）；②还原 curl UA，加 Range bytes=0- 并只接受完整 206（Content-Range 从 0 到 total-1，计数校验），仍 download_failed（11.91 秒）。这两轮 CLI 未埋 HTTP status/接收字节/底层异常，不能把首轮 567 套用给它们；download_failed 也覆盖 ffmpeg 错误，需进一步区分阶段。
推测（未验证）：UA 与 Range 的组合、开放结束范围和短范围的 CDN 行为差异，或完整响应的 Content-Range/长度条件；浏览器 UA + 完整 Range 尚未同时测。主程应先记录每跳主机、状态、Content-Range/Content-Length、received/written 字节及脱敏错误 code；禁止记录完整链接/query/Cookie，不给 CDN 发 Cookie，不清风控暂停。
已通过：check=0、主测试 701/701、新 Node 28/28、runner 原 Node 61/61、Python 204（常规 CI 跳过 R12），R12 另行真实中英/65 秒 5/5；UI/config/diff=0。固定 sherpa-onnx 1.13.8 已装到 ~/.inkboard-team/xasr-venv（53MB），只读现有模型可加载，加载峰值约 411MB；B 站真实长音频 RSS 未测。
清理复核：18:02 media-tmp=0、media-reports=0、无 lock/pid、无 ffmpeg/xasr 进程、R12 临时目录=0；自 17:55:17 起 ~/.inkboard-team、~/.cache、~/Library/Caches 内无新增音视频/模型文件；未扫其他用户目录。保留已装 venv 和原有模型，未启服务；无推送/合并/部署/群发送，线上只有选片 SELECT。
证据：工作树 .agent/asr-download-diagnostic.json、asr-real-BV1MEW46JEYB.{json,log}、asr-r12-real.{json,log}、asr-handoff-checks.json、asr-final-checks.json、asr-cdn-handoff-cleanup.json、asr-source-manifest.json。保留源码和证据不再操作，由 BINI 派主程接手。
