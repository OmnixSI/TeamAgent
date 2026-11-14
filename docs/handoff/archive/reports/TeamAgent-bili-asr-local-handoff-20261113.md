结论：PR-A 代码已实现，真实中英 WAV/65 秒分块转写通过；B 站完整音频下载仍失败，A3 尚未通过，不能宣称端到端可用。
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-bili-asr-local（agent/bili-asr-local；HEAD 7cc3d8d；15 个源码/测试/配置文件未提交）。
实现：media/asr/xasr_transcribe、音频 API 追加、安装/移除/定时项、资源配置与 R1–R22/I1–I6 测试；未改 Worker/semantic/utility/delivery。
测试：check=0；主测试 701/701；新 Node 28/28；runner 原 Node 61/61；Python 204 通过（常规 CI 跳过 R12 一项），显式 R12 实机 5/5、零跳过；UI/config/diff=0。
环境：交付员安装 sherpa-onnx 1.13.8 到既定 venv（53MB）；已有 NextThought 模型加载成功，加载峰值约 411MB；未下载/复制模型、未启服务。
真实尝试：历史无字幕 BV1MEW46JEYB，951 秒；once 退出 1，reason=download_failed，files_seen=[]、cleanup.residue=0。
诊断：原始 CDN GET 记录 HTTP 567（TencentEdgeOne），备份 HEAD 403；浏览器 UA + bytes=0-511 小范围 GET 两源均 206，但不代表整条音频可下载。
停止点：曾试浏览器 UA，完整下载仍失败；随后还原 curl UA、增加 bytes=0- 与完整 206 校验，仍失败。依约两次修改后停止，未试第三种组合。
下一定位线索：浏览器 UA 与完整 Range 尚未同时实测；完整下载失败前后实际响应需记录 status/Content-Range/Content-Length，不能打印签名 URL/Cookie。
选片记录：历史 BV1GN4p6pEEP 与 BV1UxnA6yEdw 现有字幕；备用 BV1KwV3zZEPp（4214 秒，无字幕）尚未下载；3–6 分钟及约 60 分钟 A3/长音频 RSS 均未验收。
清理：media-tmp=0、media-reports=0、无 lock/pid 文件、无 ffmpeg/xasr 残留进程、指定目录内无新增音视频或模型文件；R12 样例已自动删除。
方案补丁：按 BINI 取消 .last-sweep；每次启动只检查目录项/时间，清过期报告；超限日志 truncate(0)，不读日志内容。
证据：worktree/.agent/asr-{handoff-checks,r12-real,final-checks,cleanup-final,source-manifest}.json；asr-download-diagnostic.json；asr-real-BV1MEW46JEYB.json；对应日志均保留。
提交建议（待端到端验收通过）：feat: 支持本机单音频 X-ASR 转写与任务清理；本轮未提交、推送、合并、部署或发群消息，线上仅只读 SELECT 选片。
需要 BINI 决定是否交主程继续定位 CDN；默认保留当前 worktree 与已装 venv，先补足完整下载证据，再安排提交。
