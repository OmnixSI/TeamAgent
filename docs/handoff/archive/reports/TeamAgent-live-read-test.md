# TeamAgent 真实群消息读取实测（2026-11-12 22:30–22:50 Sydney）

线上 release `0f67b28`，Cloudflare 版本 `46d237d0-…`；本机 fetcher 为 `~/.inkboard-team/fetcher.mjs`（哈希与 main 一致）。

## 1. 登录态

- B 站：`~/.inkboard-team/secrets/bili-cookie.json` 存在、`0600`；字段 `SESSDATA / bili_jct / DedeUserID`，**缺 `buvid3`**（3/4）。
- X：`~/.inkboard-team/browser/x` 存在、`0700`。
- 云端 `settings`：`auth:bili` = `ok`（11:30Z 检查）、`auth:x` = `ok`（11:27Z）。

## 2. 样本与结果

| 类别 | 样本（时间） | 结果 | 关键字段 | 总耗时 |
|---|---|---|---|---|
| A1 b23 链接 | `b23.tv/UIm520q`（11-11 18:16） | **成功** | `BV1irWP6PExT`；标题「这就是老戏骨 灭建国…」；UP「波刚火影忍者手游」；时长 22s；热评 **8** 条；字幕 `ok`，41 字 | **22.5s** |
| A2 b23 链接 | `b23.tv/ALizCFS`（11-11 18:12） | **失败** | 日志 `fetch 视频内容未读到`；B 站 view 接口不可读（疑似删除/私密/地区） | 11.7s（失败） |
| A3 同视频第二次 | 重复 `UIm520q` | **成功** | 直插 fetch 任务未走缓存，仍重新请求 | 19.7s（无缓存收益） |
| B 无链接卡片 | 「学不如抄？Anthropic 为啥这么怕蒸馏！」（11-12 09:24） | **失败** | `search/type` 返回 200，随后 `fetch 风控`；标题检索仍被 v_voucher 挡 | 6.2s（失败） |
| C X 单推 | 群里无该类样本 | — | — | — |
| D 网页链接 | `https://github.com/OmnixSI/TeamAgent`（11-11 21:27） | **成功** | Jina 返回 9,263 字符 | **2.63s** |

- 抓取失败的任务在 `jobs.error` 只写「本机抓取未完成」，真实原因只在 `~/.inkboard-team/fetch.log`（A2=视频未读到、B=风控）。

## 3. 耗时分解（A1 实测 + 代码）

| 阶段 | 实测/代码值 | 位置 |
|---|---|---|
| 防抖 | 1–4s（mention 1s / image 4s / busy 3s / idle 2s） | `src/rhythm.ts:4`、`:2` defaults |
| cron 唤醒 | **最长 60s**（每分钟） | `wrangler.toml:10` `crons=["* * * * *"]` |
| 视频等待 | 30s | `config/team.json` `bili.wait_seconds` |
| fetcher 领取轮询 | 0–10s（实测 ~8.9s 才 claim） | `runner/fetcher.mjs:208` `sleep(10000)` |
| B 站抓取 | 13.6s（短链 302 → view → player → 字幕 → 热评，串行 1.2–1.8s/请求） | `runner/local_bili_login.py`、`fetcher.mjs:65` rate |
| 回灌 Worker | <0.3s | `src/fetchjobs.ts:196-215` |
| 模型回答 | 平均 5.3s（近 35 次 `chat_decisions.model_ms`） | 线上 D1 |

最坏路径约 **119s**（60+30+10+14+5），顺利路径约 **50s**。最长一段是 **cron 60s**，其次 **30s 等待** 与 **抓取 14s**。

## 4. 优化建议（按收益排序）

1. **到点直接入队，别等 cron**：`startVideoWait` 用 Queues `delaySeconds: 30` 在到期时唤醒，`sweepVideoWaits` 只做兜底（`src/fetchjobs.ts:73-92`、`src/worker.ts` 调用处）。收益：-0~60s；风险低。
2. **缩短 fetcher 领取间隔**：`runner/fetcher.mjs:208` 10s → 2s（无任务时指数退避到 10s）。收益：-0~8s；风险：空转请求增多（本机，无 API 成本）。
3. **直插/重复请求也查缓存**：`claimFetch` 前先 `biliCached`，命中直接回写（`src/fetchjobs.ts:52`、`:128` 已在视频路径使用）。收益：重复请求 -18s；风险：缓存时效（现为 7 天）。
4. **抓取内并行**：view 之后再并行 player/字幕/热评（`local_bili_login.py` 串行 + `fetcher.mjs:65` 每请求 1.2–1.8s）。收益 -3~5s；风险：并发更易触发风控，需保留限速。
5. **标题检索风控**：登录后 `search/type` 仍被 v_voucher 挡（证据：A/B 样本日志）。改用带 `v_voucher` 的已登录搜索或 App 接口；失败应立即降级为「仅卡片」提示而不是等 6s。属**代码 + B 站硬限制各一半**。
6. **错误原因落库**：把 fetcher 的 `reason`（视频未读到/风控/网络）写进 `jobs.error`，现在只有「本机抓取未完成」。收益：可诊断性；风险无。
7. **X 兜底**：公开单推可走 oEmbed（约 1–3s），Edge 登录态只用于时间线/回复；避免每条 X 都依赖浏览器调试端口。群里暂无 X 样本，未实测。
8. **字幕完整性**：A1 视频 22s 仅 41 字（AI 字幕单段）；长视频需确认是否取全部分段（现只取第一个 subtitle URL 内容，`fetchjobs.ts` 截 6000 字）。收益：内容完整；风险低。

## 5. 未验证 / 限制

- 群里没有 X 单推样本，X 正文读取未实测。
- 无链接卡片标题检索仍被风控挡，登录未改善。
- 「用户 @ 机器人 → 回复」的全链路真实群消息未触发（本轮只测读取链路）。
- 本次测试插入的 `jobs` 与 `media_notes` 行已删除，复查残留为 0。
