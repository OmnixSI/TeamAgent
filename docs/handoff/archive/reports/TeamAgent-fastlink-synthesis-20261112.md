# 快速读链接 · 联合调研综合报告

综合人：调研员（DeepSeek）｜2026-11-12 23:20 悉尼｜对象：OmnixSI/TeamAgent @ 0f67b289
输入：`research-fastlink-ds.md`（我）、`research-fastlink-codex.md`（Codex调研员）、`TeamAgent-fast-links-design-lead-20261112.md`（主程）、`TeamAgent-live-read-test.md`（实测）
本轮实测 21 次 HTTP，全部未登录、未使用任何用户 Cookie、未发群消息。

## 摘要（15 行）

结论：保留 Worker + 本机 fetcher，先修「错误页当成功」「卡片→BV」「缓存按 BV 归一」「10s 轮询」，暂不上 DO/WebSocket；X 用 Fx v2 但必须校验新鲜度，登录态只作兜底；B 站不新增 SDK。

1. **30s 不是固定等待——我原来的判断错了。** 代码是 `due_at=now+30s` 与 fetch 任务同时写入，抓取回报 `ready=1` 后立即唤醒；30s 只对「抓取端没回报」生效。主程与 Codex 一致，我复核源码后确认（`fetchjobs.ts:61-84,176-185`）。
2. **Jina 那次「9,263 字符成功」是 404 页。** 我复现：HTTP 200、9,280 字节、0.64s，正文含 `Warning: Target URL returned error 404`。Codex 的纠正成立。
3. **v_voucher 不是确定性结论。** 9 组对照矩阵里 0 次出现 v_voucher，失败全是 HTTP 412；同一请求连发两次可以一次 200 一次 412；最后用生产头组合实测 200/20 条。buvid3 不是万能钥匙，我原报告「补 buvid3 就通」过强。
4. **新增实测：Fx 的「最新」不可靠。** 同一 profile 端点三次调用出现两个不同头条（`2120625963495277052` 11-11 21:13 UTC vs `2120761225529168312` 11-12 06:10 UTC，差约 9 小时）。必须校验 `created_at`，不能拿到就答。
5. **长推在 Fx 里是 `is_note_tweet:true` + 完整 `text`（859 字符），没有 `note_tweet` 对象。** X GraphQL 的 `note_tweet` 字段名不适用于 Fx v2。

## 一、分歧一：匿名标题搜索为什么出 v_voucher

### 实测矩阵（同一台 Mac、同一出口 IP、无登录）

| # | Cookie / 头 | HTTP | code | v_voucher | 结果数 |
|---|---|---|---|---|---|
| A | 无 Cookie，curl UA | 200 | 0 | 否 | 20 |
| B | +buvid3，curl UA | 412 | — | 否 | 0 |
| C | +buvid3+buvid4 | 412 | — | 否 | 0 |
| D | +buvid3+buvid4+b_nut | 200 | 0 | 否 | 20 |
| E | +buvid3，WBI 签名 | 412 | — | 否 | 0 |
| F | +buvid3，Chrome UA | 200 | 0 | 否 | 20 |
| G | +buvid3，Chrome UA+Referer | 200 | 0 | 否 | 20 |
| H | 与 A 完全相同 | **412** | — | 否 | 0 |
| P | **生产组合**（curl UA+Referer+Accept json+buvid3+WBI） | 200 | 0 | 否 | 20 |

### 结论

- **v_voucher 一次都没出现**，出现的是 HTTP 412 HTML 风控页。两者同属风控层，但不是同一个返回形态；Codex 看到的是 `code:0 + data.v_voucher`，我这边复现不出来。
- **A 与 H 完全同参却 200/412 分叉**，说明按单次请求比对 Cookie 组合无法定因；这是会话/速率状态漂移，不是某个 Cookie 的有无。
- **生产头组合（P）实测通过**，说明线上那套 `curl UA + 浏览器 Referer + buvid3 + WBI` 不是自相矛盾的死路；B/C/E 的 412 更像连续请求后的临时处置。
- **不能否定的部分**：Codex 的 `b3+b4+WBI 仍出 v_voucher` 是在另一次会话里取得的，我没有复现也没有推翻它；合理表述是「buvid3/WBI 必要但不充分，通过与否随会话状态变化」。

### 代码核过的事实（`runner/fetcher.mjs`、`runner/bili-title.mjs`）

- `UA='curl/8.7.1'`（第 12 行），但每个 API 请求固定带 `Referer: https://www.bilibili.com/`、`Accept: application/json`。
- Cookie 只发 `buvid3`（有登录再发 `SESSDATA`）；`buvid3` 由 `/x/frontend/finger/spi` 自动补、缓存 24h。
- 标题搜索走 `/x/web-interface/wbi/search/type`，WBI 签名，`anonymous:true`；**见 v_voucher 就 `pauseSearch` 6 小时**。
- 连续 2 次 412 就整体暂停 10 分钟（`risk()`），所以线上失败会「安静一段时间」，容易被误读成偶发。
- 速率 1.0–1.8s 串行。

## 二、分歧二：cron / 30s / 10s 能不能砍

| 项 | 我的依据 | 主程 / Codex 依据 | 各自缺的证据 |
|---|---|---|---|
| 30s 等待 | 曾按 `wait_seconds=30` 当成每次固定等待 | `startVideoWait` 同时写 `due_at` 与 fetch 任务；回报 `ready=1` 立即 `wakeVideoWait`→`queue.send`（`fetchjobs.ts:61-84,176-185`） | 我：没读唤醒路径（已确认是我漏了）。双方都缺：线上「提前唤醒 / 走兜底」的实际比例 |
| cron 60s | `wrangler.toml:10` 每分钟；`sweepVideoWaits` 扫到期 | 只服务「未回报 / 租约恢复」，正常路径不经过（`fetchjobs.ts:128-135`） | 同上：兜底触发次数的线上分布 |
| 10s 轮询 | `runner/fetcher.mjs:167,170` `sleep(10000)` | 同（Codex 也承认 0–10s） | 无，已一致 |

**判定**：30s 与 cron **只在「抓取端未回报」路径成立**；我原来的「60+30+10+14+5=119s」应降级为**最坏兜底路径**，不是正常路径。正常路径的确定性瓶颈是 **10s 轮询（0–10s）+ 抓取 5–14s + 双模型 5–6s**。主程估的正常样本 ~29s、live-test A1 22.5s 都与此吻合。

## 三、Jina 的成功判定（统一口径）

**不能只看 HTTP 200 和字符数。** 判定顺序：

1. `r.jina.ai` 返回 200；
2. 正文**不含** `Warning: Target URL returned error <3位码>`（含则按该码判失败）；
3. 去导航后正文 ≥ 500 字符；
4. 不含登录/挑战页特征（`Sign in to continue` / `Just a moment` / `Verify you are human`）；
5. 可选：含预期锚点（仓库名、文章标题）。

实测证据：`https://r.jina.ai/https://github.com/OmnixSI/TeamAgent` → 200、9,280 字节、0.64s，正文第 3 行就是 `Warning: Target URL returned error 404: Not Found`，主体是 GitHub 404 壳页。现实现只判 200 + 长度（`src/semantic.ts:435`），会误收。

## 四、FxTwitter 的新鲜度与长推

- 单推 `/2/status/<id>`：269ms，字段含 `created_at / is_note_tweet / media / quote / embed_card / views`。
- 时间线 `/2/profile/<handle>/statuses`：20 条、1.6s，按 id 降序；本次样本未见 `retweeted_tweet`（转推），是否含回复未逐条核对。
- **新鲜度不稳**：三次调用两个版本，头部分别是 11-11 21:13 UTC 与 11-12 06:10 UTC。加 `cachebust` 参数仍可能拿到旧版本。→ 必须用 `created_at` 校验：若头部早于上次已知最新，重试 2 次或改用单推交叉验证；回答里带推文时间。
- **长推完整性**：`is_note_tweet:true` 的样本 `text` 859 字符、含 media、`note_tweet` 键不存在 → Fx 已把长文并入 `text`，读 `text` 即完整；不要去找 `note_tweet`。
- 同一接口两次结果不一致，也意味着**不能把「20 条」当覆盖窗口**，做「最新」要以时间为准。

## 五、两位一致、可直接采信

- b23 短链：`HEAD b23.tv/<code>` 不跟跳转即得 `Location`，0.39–0.47s，正则取 BV。
- Fx v2 覆盖单推/时间线/线程/引用，`api.fxtwitter.com/2/openapi.json` 为唯一契约；限额 1000 req/min/IP。
- Jina 只作兜底；GitHub 走 raw/API 更快（我实测 raw 0.30s）。
- B 站库现状：`bilibili-api` 已归档（2026-07-06）、`bilibili-API-collect` 已清空、BBDown 停更（2026-05-14）→ 不新增依赖，自研薄封装。
- 缓存 key 用 `bvid`（不是 URL 文本），短链/aid 做别名；TTL 7 天。
- 失败原因要落 `jobs.error`，现在统一写「本机抓取未完成」无法定位。

## 六、仅一方查到

- **仅 Codex**：`player/wbi/v2` 的字幕要按整条轨道取全部 body、现实现被 `pages[0]` 与 6000 字符截断；`conclusion/get` 需 `bvid+aid+cid+up_mid` 且要查内层 code；卡片字段除 `qqdocurl/jumpUrl` 还有 `pcJumpUrl`、裸数字 aid/query aid、分 P 传递；GitHub 私有库应走已授权 API 而非 Jina。→ 我未逐条复跑，标「未核实，可采信为主程已读源码」。
- **仅我**：SPI 免登录发 buvid3/buvid4（Codex 也确认了字段存在，但强调不含 b_nut/_uuid，这点他更准确）；`_uuid` 本地生成的说法我未验证，建议按 Codex 的口径「复用正常本机会话，不拼万能 Cookie 串」。
- **两位都未拿到真实 QQ 卡片样本** → 卡片字段解析仍是推断，必须在 fetcher 落一条原始 json 日志验证。

## 七、风险与未核实

1. Fx 公共实例的缓存/限流会变；Nitter 前例说明可能突然关停。建议保留 vx / syndication 降级链，长期自建 FxEmbed（MIT、同为 CF Worker）。
2. v_voucher 的触发条件仍未定因；当前只能做「见 voucher 暂停 + 记录」，不要写成「已解决」。
3. B 站律师函说明接口属灰区：只读用户主动贴的链接，不批量抓取、不存档。
4. `pauseSearch` 6 小时偏长：一次误判会让标题搜索整天不可用，建议降级为 30–60 分钟并记录 voucher 次数。
5. 未验证：线上「提前唤醒 vs 兜底」比例、DO/WebSocket 的实际收益、Jina 匿名速率上限。

## 八、建议下一步

1. **P0（今天可上）**：Jina 判定加 `Warning:` 行；`jobs.error` 写真实原因；`pauseSearch` 降到 30 分钟。
2. **P0**：fetcher 轮询 `sleep(10000)` → 2s，空队列指数退避到 10s；这一条确定省 0–8s，且只改一行。
3. **P1**：卡片→BV 全链路（qqdocurl/jumpUrl→BV→aid），并把原始 json 落一条日志验证字段。
4. **P1**：缓存 key 改 `bvid` + 短链别名；「最新推文」加 `created_at` 校验与重试。
5. **P2**：先补阶段计时（receive/enqueue/claim/fetch/report/answer），有 P50/P95 再决定 DO/WebSocket——Codex 的「先计时后改架构」比我的「直接上 DO」稳，采纳他的顺序。
