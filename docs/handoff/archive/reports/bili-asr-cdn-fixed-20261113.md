结论：PR-A CDN完整下载已修复，真实匿名无字幕视频下载→本机X-ASR转写跑通；已提交 df08e4bc1fecd9d7c1d2d3d79fea514366fc074b（父7cc3d8d，仅本地未push）。
worktree：/Users/yanghongming/Projects/.worktrees/TeamAgent-bili-asr-local；分支agent/bili-asr-local；父7cc3d8d2949f725e326460192bb77404ee6c71ba。
根因：完整Range配curl UA返回403；同一条DASH音频改浏览器UA并保留Range后206，Content-Range=0–7792918/7792919，收到/写入7792919字节。
修复范围：相对程序员交接仅runner/media.mjs下载UA、runner/test_media.mjs新增CDN回归、docs/operations.md验收记录；全部15个PR-A文件已随该提交提交。
真机：BV1MEW46JEYB，subtitle_status=none；node runner/media.mjs once在匿名隔离HOME运行，只读链接既有venv/模型；不读真实登录文件、不连云。
转写：duration951秒，covered950.60175秒，partial=true，chunks32，chars6205；下载到转写27秒，含隔离与审计总35.5秒。
文字示例：[00:00] 统治全球算力帝国的男人黄仁勋……（仅展示音轨转写片段，不留转写全文）。
内存：X-ASR峰值789.23MB；Node+子进程树峰值838.84MB，均≤1300；nice实测15。
清理①：只出现a.m4a/a.wav；临时目录0、报告目录0、cleanup.residue=0；隔离HOME及符号链接全部移除。
清理②③：ffmpeg/X-ASR残留进程0；命名目录metadata审计无新增或改动音视频/模型文件，未复制或下载模型。
测试先红后绿：新增CDN回归先download_failed，修复后29/29 Node音频用例；原Node fetcher61/61。
Python：204项OK(skip1为可选R12)；R12本机已装Tingting/Samantha合成中英样例独立5/5、0skip，含65秒分块，临时样例已删；I1–I6通过。
其他：npm run check=0；npm test701/701、0skip；UI/config/diff检查均0。
证据：工作树.agent/cdn-{probe,once-real,cleanup-audit,r12-real}.json及cdn-*-green/final日志；source manifest记录交接15文件哈希。
边界：未push/merge/deploy、未启定时项、未发群消息、未写线上D1、未碰Cookie/密钥/Edge；云端PR-B联验与长时验收未做；风险L1。
