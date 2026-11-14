# B 站短链没抓到：原因、证据与最小修复（2026-11-14 02:25 Sydney）

## 结论

**短链本身没坏，消息也被正确识别了；坏在「两条消息合成一批，latest 变成了 5 秒后的空 @」。**（证据链见下，可排除缓存/失败注记）

- 02:07:24 用户发：`【【听懂杰克逊】…】 https://b23.tv/Oto4dmi` + 「总结这个视频讲了什么」（没有 @）。
- 02:07:29（5 秒后）用户又发了一条**只有 @、没有正文**的消息。
- 空 @ 的任务先拿到这一批：`chat_decisions` 里 `latest=空 @`、`gate=model`、`action=tool` 的那条决策，`outbox_id` 指向的是**短链消息**——它替短链回了「视频已进入后台处理」，但 `videoTarget` 只看 latest=空 @，没有建 fetch。
- `src/fetchjobs.ts::videoTarget` **只看 latest，不看 batch**：空 @ 没有链接、没有关键词 → 返回 null；链接那条被跳过。
- 随后游标前移。短链自己的聊天任务再跑时 batch 已空，在视频判断之前就 `return`。短链最终 **0 个 fetch 任务**，机器人只能用聊天/检索作答。
- 机器人先对短链回「视频已进入后台处理，结果稍后单独发到这条消息」，**但后台根本没有抓取任务**；2 分钟后对空 @ 回「短链和 bilibili 视频页都 timeout」，还报错了 BV 号。

**证据链（可排除缓存/失败注记，并确认是合批）**：

- 本机当前 fetcher 日志（`fetch.log`，2026-11-12 04:13 起）里**从未出现过** `fetch short /Oto4dmi` → 没有抓过这个短码，因此也不会有 `bili:Oto4dmi` 缓存或 `failure:v1:bili:Oto4dmi` 注记。
- 没有 `video-vw-<短链消息 id>` 的 outbox → `startVideoWait` 从未为这条消息调用。
- 在 `cached=null`、`failure=null` 的前提下，只要短链 job 以「latest=短链消息」跑过，`startVideoWait` 必然被调用。它没被调用 → 短链 job 的 batch 已被空 @ job 抢走（游标前移，batch 为空，`worker.ts:781` 提前 return）。`chat_decisions` 里短链消息（463）**没有决策行**，空 @（464）的 `gate=model/action=tool` 决策又指向 `chat-<463>`，直接坐实。

修复：`pkg/hotfix-bili-shortlink` @ `2e70a38`，两处小改：
1. **空 @ 继承最近链接**（`bareMention` + `recentLink`，最近 10 条）——直接修这次事故；
2. **普通消息裸链静默预热**（`prefetchBili`，waiters 为空、不重开旧任务）——防止「只发链接、不 @」再次漏读。

全量 `npm test` **866/866 通过**。分支已 push；未部署、未写线上 D1、未发群。

## 线上证据（只读）

### 1) 短链消息（原文）

| 字段 | 值 |
|---|---|
| message id | `ROBOT1.0_OyB7TgbASj-VgfcoKvzFbgqYwjmnRUj1whz64-RKVWFwg6CSmYOJaBjQobQTLByPYOkncGAsvzH96tf8MNsY1ufc9CcD.q-wjum3kSu84kM!` |
| ts | `2026-11-13T23:07:24+08:00`（= 02:07:24 Sydney） |
| body | `【【听懂杰克逊】首次揭秘全球最屌的专辑，BAD磁带中隐藏的秘密——MichaelJackson专家级听法系列3-哔哩哔哩】 https://b23.tv/Oto4dmi` + 换行 + `总结这个视频讲了什么` |
| mentions | `[]`（没有 @） |
| message_meta.bili | `[{"url":"https://b23.tv/Oto4dmi","short":"Oto4dmi"}]` |
| 关键词 | 正文同时含「总结」「视频」，本应命中 `videoTarget` 的关键词分支 |

### 2) 5 秒后的空 @

| 字段 | 值 |
|---|---|
| message id | `ROBOT1.0_OyB7TgbASj-VgfcoKvzFbjfoep6WqttyiCLPIRkWm5zwzZQQpt6kQlcojHXAOig9DKlUHFQV479sD62FRtQAkzrNzDCuZ6v7FJGbSMGoJsgNIqrVm3QhC6-bhktADRFg` |
| ts | `2026-11-13T23:07:29+08:00` |
| body | `""`（空） |
| mentions | `["Bot"]`，`direct: true` |
| 后续 | 23:07:42 建 research 任务（activity「资料检索已转到后台」），23:08:34 完成 |

### 3) 短链抓取侧：0 个任务

| 证据 | 值 |
|---|---|
| 全库队列（`/api/team/state?metrics=1`） | `[{"kind":"media","status":"failed","n":8}]` —— 短链没有 pending/running/failed 的 fetch（长链那条 fetch 已 done） |
| 本机 fetcher | `launchctl` state=running，pid 57379；短链在日志里没有 `fetch short /Oto4dmi` 行 |
| 短链展开 | 本机 fetcher `resolveShort('Oto4dmi')` 返回 `BV1p6xe6PE3s`；`curl -I https://b23.tv/Oto4dmi` → 302 到 `https://www.bilibili.com/video/BV1p6xe6PE3s…` |
| 链接消息的聊天回复 | 23:07:44 `sent`：「视频已进入后台处理，结果稍后单独发到这条消息；不写长报告，只给要点。」 |
| 空 @ 的检索回复 | 23:08:33 `sent`：「视频没抓到——b23.tv 短链和 bilibili 视频页（BV1piWJ6XEWu）都 timeout……」 |
| 抓取任务表 | 只有 `fetch-bili-BV1p6xe6PE3s`（done，waiters=`vw-<长链>`）；**没有 `fetch-bili-Oto4dmi`** |
| 合批证据 | `research-<空@ id>` 的 payload `batchIds` 第一位就是短链消息 id（463），第二位是空 @（464） |

### 4) 机器人最后说了什么（outbox 原文）

| 时间 | 发给 | 原文（截断） |
|---|---|---|
| 23:07:44 | 短链消息 | `视频已进入后台处理，结果稍后单独发到这条消息；不写长报告，只给要点。` |
| 23:08:33 | 空 @ | `视频没抓到——b23.tv 短链和 bilibili 视频页（BV1piWJ6XEWu）都 timeout，搜索也只返回合集页或频道页，没有字幕和正文，正文我不能编。` 后面给了两条路：贴简介/字幕，或按公开事实做「推测框架」。 |
| 23:12:47 | 长链 | `长链接拿到了，字幕和评论都有。先纠正：正确视频号是 BV1p6xe6PE3s，我之前报的 BV1piWJ6XEWu 是错的……` 后面是真实的字幕摘要与热评转述。 |

`chat_decisions` 只有 3 条：① `latest=空 @`、`gate=model`、`action=tool`，`outbox_id=chat-<短链消息>` —— 这就是 23:07:44 那句「视频已进入后台处理」，它由空 @ 的回合发出，指向短链消息；② 长链 `gate=video, action=reply`；③ 23:13 追问 `gate=model`（reason：素材已有字幕和热评可答）。**短链消息（463）自己没有决策行，也没有 `gate=video`**，与「从未建 video wait」一致。

### 5) 后续两条（说明读取端和长链路径都正常）

| 时间 | 消息 | 结果 |
|---|---|---|
| 23:11:47 | 同一视频长链 `BV1p6xe6PE3s` + `<@Bot> 长链接来了，再试试` | 建了 `video_wait` 和 fetch；**02:12:20 抓取成功**（`view`/`player`/`subtitle`/`reply` 全 200），已回复 |
| 23:13:41 | `所以这个视频想表达什么呢，里面的秘密是什么呢` | 聊天回复 23:14:07Z 已发送（queue 7.7s + model 17.1s） |

## 代码原因（main b0557fd）

`src/fetchjobs.ts:39`：

```ts
export function videoTarget(_batch: Row[], latest: Row, recent: Row[], cfg: any) {
  ...
  if (latest.mentioned) { const target = targetOf(meta); if (target) return target; }
  ...
  if (/视频|讲了?啥|讲的什么|说了什么|总结|值得看|up主/i.test(latest.body || "")) { ... }
  return null;
}
```

- `_batch` 参数被忽略；只看 `latest`。
- `loadChatContext` 用 `latestId` 在 batch 里找 latest；链接消息的 job 和空 @ 的 job 都可能把同一批消息里的**空 @** 当成 latest。
- 链接消息自己的 job 在游标前移后再跑，`batch` 为空，在 `worker.ts:781` 的 `if (!batch.length || !latest) return;` 直接返回，永远走不到视频分支。

这不是短链解析问题，也不是开关问题（`config/team.json`：`bili.enabled=true`、`bili.media.enabled=true`），更不是 V-C 的短链白名单没上线（main 已有 `bili2233.cn`、4–32 位短码）。

## 最小修复

分支：`pkg/hotfix-bili-shortlink`（基于 `origin/main` b0557fd）

| 提交 | 内容 |
|---|---|
| `6f35e87` | `fix: prefetch bilibili links posted without an @ mention` |
| `ea6a74b` | `test: replay a prefetched short link into the next question` |
| `2e70a38` | `fix: inherit the closest link when a bare @ follows a short link` |

改动（3 个文件，+151 行）：

- `src/fetchjobs.ts`
  - `bareMention(latest, meta)`：`mentioned && 去掉 <@…> 后正文为空 && 无 placeholder && 无媒体`。
  - `recentLink(recent, latest)`：同群最近 10 条里从新到旧找 `targetOf(metaOf(r))`。
  - `videoTarget` 在 quoted 判断之后插入 `if (bareMention(...)) return recentLink(...)`。
  - `prefetchBili(e, latest, cfg)`：非 @、自带 B 站链接、24h 无缓存、无同名任务、预算 ≥2 → `INSERT OR IGNORE` 一个 `fetch-bili-<ref>`（`waiters: []`），不重开旧任务。
- `src/worker.ts`
  - 聊天分支：`if (!transferred) await prefetchBili(e, latest, TEAM);`（@/关键词路径不变）。
- `test/prefetch.test.mjs`（新，6 条）

## 本地回放

`node --test test/prefetch.test.mjs`：**6/6 PASS**

- P1 裸 b23 短链 → 建一个 waiters=[] 的 light fetch，不建 wait、不回复
- P2 24h 缓存 / 已有任务不重开、不加 waiter
- P3 @ 消息仍走 video wait，不走 prefetch
- P4 BV 长链与 bili2233.cn 别名都能预热
- P5 端到端：短链 → runner claim/report → 下一条「这个视频讲了啥」的模型请求里出现视频标题
- **P6 本次事故逐字回放**：用上面两条真实消息（去掉昵称）→ 空 @ 继承 `Oto4dmi` → `fetch-bili-Oto4dmi`，`waiters=[vw-at-real]`，不产生 outbox

全量回归：`npm test` **866/866 pass / 0 fail**；`npm run check` 通过。

## 没做到 / 未验证

- 未部署到线上（按施工单由主程安排交付员）。分支已 push：`origin/pkg/hotfix-bili-shortlink`。
- 修复上线后需用真实群消息再验一次：普通短链 + 5 秒后空 @，应出现 `fetch-bili-Oto4dmi` 并在 30 秒内回复视频内容。

## 是否需要用户动作

不需要。Cloudflare 令牌已由用户保存；本次用它只读查询线上 D1（`rows_written=0`），补到了 `messages` / `jobs` / `outbox` / `chat_decisions` 原文，并用线上只读接口 `/api/team/source`、`/api/runner/inputs` 交叉核对；未写线上 D1、未发群。
