# B 站 60 分钟级音轨转写真机验收（2026-11-13）

## 结论

通过：`max_rss_mb=745.14`、进程树峰值采样 `769.5 MB`、`cleanup.residue=0`，均低于 1300 MB 上限；本机无音频、临时文件、锁、PID 或孤儿进程残留。

执行说明：`once` 于 22:31 左右正常结束（exit 0）；上一轮在清理和汇报前被取消，不是命令超时，结果已完整保留并复核。

## 片源与环境

- 片源：`BV1jjBYYRE9m`《【完整版】温铁军2024年11月演讲，主题：全球化解体与中国的压舱石。》，时长 `3591s`（59.85 分钟），匿名 `subtitle_status=none`，中文内容，公开视频。
- 选片说明：群消息里已核到的视频均不足 55 分钟；按 BINI brief 的兜底规则使用公开长视频。
- 代码：`/Users/yanghongming/Projects/.worktrees/TeamAgent-deploy-bili`，detached HEAD `8f0e3fd`（PR-A #31 + PR-B #32 合并后的 main），`git status` 干净。
- 隔离：临时 `HOME=/Users/yanghongming/Projects/.tmp-media-e2e-20261113`；只软链只读的既有 `xasr-venv` 和 NextThought 模型；无 `secrets/bili-cookie.json`，即无 Cookie。
- 模式：`node runner/media.mjs once BV1jjBYYRE9m`；不 claim、不 report、不写 media-reports、不读云端地址；`bili.media.enabled` 仍为 false；未安装 launchd media 定时项；未发群消息。

## 实测数据

```json
{"bvid":"BV1jjBYYRE9m","subtitle_status":"none","duration":3591,"covered":3590.1765,"partial":true,"chunks":121,"chars":18808,"files_seen":["a.m4a","a.wav"],"max_rss_mb":745.14,"nice":15,"wall_s":107.8,"cleanup":{"residue":0,"paths":[]}}
```

- 耗时：runner `wall_s=107.8`；wrapper 墙钟 `113.7s`；`time -l` real `113.78s`、user `192.16s`、sys `5.53s`。
- 内存：ASR 自报峰值 `745.14 MB`；0.5s 进程树采样峰值 `769.5 MB`（`node 31 + ASR 739` 起，最高 769.5）；`/usr/bin/time -l` 的 `maximum resident set size=791625728` 字节，即 `754.9 MiB`；node 自身峰值 `82.7 MB`。取最大观测值 `769.5 MB`，低于 1300。
- 音频：`files_seen` 仅 `a.m4a`、`a.wav`；m4a 约 15 MB，wav `114885726` 字节（109.6 MiB）；ffmpeg 成功后立即删 m4a，ASR 结束后立即删 wav。
- 覆盖：`covered=3590.1765/3591s`，差 `0.8235s` 为 AAC 帧取整，覆盖率 99.98%；因此 `partial=true`，但不是内容截断。
- 转写质量：`chunks=121`、`chars=18808`，`head` 为可读中文（开头为“今天要跟大家讲的内容……川普重新赢得大选……对中国的关系会不会好一点？”）。
- 清理：`cleanup.residue=0`；隔离 HOME 的 `media-tmp/`、`media-reports/` 均为空；`media.lock`、`media-child.pid` 不存在；真实 `~/.inkboard-team/media-tmp/`、`qq-spool/` 为空，`media-reports/` 不存在；`pgrep -fl 'media.mjs|ffmpeg|xasr_transcribe'` 无结果；临时 HOME 已删除。
- 密钥检查：`grep -E 'SESSDATA|upsig|bili_jct|mid=' run.stdout run.stderr` 0 命中；stdout 只有一行 JSON，无 URL、无 Cookie。

## 500 报错根因（只读分析，未改用户文件）

现象：`~/.inkboard-team/file-deliveries/` 有 3 个旧 `.sent` 回执，gateway 每 10 秒向 `/api/runner/delivery/report` 上报时稳定 500。

根因链：

1. 3 个回执都没有 `id`（其中 2 个还没有 `sent_count`），是旧格式。旧版 `runner/delivery.mjs` 有保护：`if (d.reported || !d.id) continue;`（`37ab49d:runner/delivery.mjs:29`）。
2. #28 重构（`cd222c4`）删掉了这个保护；当前 `runner/delivery.mjs:98-107` 会把 `.sent` 回执交给 `finishDelivery`，`:83` 发 `{id: undefined, ...}`，`JSON.stringify` 直接丢掉 `id`。
3. `src/worker.ts:1458-1459` 直接 `.bind(b.id)`；D1 不接受 `undefined`，抛 `D1_TYPE_ERROR`；该路由没有 try/catch，Cloudflare 返回 500，而不是 404。
4. `runner/delivery.mjs:87-88` 在 report 抛错时直接 return，`d.reported` 永不置位；`.sent` 又不增加 attempts，所以同一批文件每 10 秒无限重试。

修法（建议两处都改，清理文件只是止血）：

1. **runner 容错**：读到无 `id` 的回执时不再上报。`status=sent` 且 `sent_count==files.length`（或 `status=sent` 但缺 `sent_count`，按全部已发处理）→ 直接删除回执、保留输出文件；`unknown/failed` → 改名为 `.legacy` 留档，不参与轮询。顺手对 `status=sent` 但缺 `sent_count` 的旧回执补 `sent_count=d.files.length`。
2. **worker 防御**：`/api/runner/delivery/report` 在 `bind` 前校验 `typeof b.id === 'string' && b.id`，否则返回 400，避免任何缺 `id` 的请求打成 500。
3. **回归测试**：`test/delivery.test.mjs` 增加“无 id 的 `.sent` 不调用 report 且被 retire”；`test/integration.test.mjs` 增加“无 id 的 POST 返回 400”。
4. **立即止血**：这 3 个文件都是 `status=sent`（已确认发送），可整体移到 `file-deliveries/legacy-20261113/` 或删除；只清理能马上停掉 500，但代码容错才是根因修复。

## 复现命令（关键）

```bash
cd /Users/yanghongming/Projects/.worktrees/TeamAgent-deploy-bili
HOME=/path/to/isolated-home node runner/media.mjs once BV1jjBYYRE9m
```
