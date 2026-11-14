# B 站短链未抓视频：独立复核（测试员，2026-11-14 02:35 Sydney）

## 结论

不是短链解析失败，是**两条消息合批后 latest 取错**：23:07:24 的短链消息（无 @）和 23:07:29 的空 @ 合成一批，视频判断只看 latest=空 @，于是 0 个 fetch 任务。修复分支 `pkg/hotfix-bili-shortlink` @ `2e70a38`（已并入 `release/trip0` @ `10be0a5`）的 P6 逐字回放 6/6 通过；**线上仍是 `b0557fd`，修复未部署**。

## 独立证据（线上 D1 只读，rows_written=0）

用只读 Cloudflare 令牌查询生产 D1（`42e95fb2-16f8-46d9-bf32-34f3e88a4443`），每条查询 `meta.rows_written=0`、`changes=0`：

- `messages`：`2026-11-13T23:07:24+08:00` 一条短链消息（`https://b23.tv/Oto4dmi` + “总结这个视频讲了什么”，`mentioned=0`）；`23:07:29+08:00` 一条空正文消息（`mentioned=1`）。
- `chat_decisions`（23:00–23:20）：唯一 `gate=model/action=tool` 的决策满足
  - `latest_id` = 23:07:29 的空 @；
  - `batch_ids` 含 23:07:24 的短链消息；
  - `outbox_id` = `chat-<短链消息 id>`（即“视频已进入后台处理”那条回复挂在短链上，但由空 @ 回合发出）；
  - `mentioned=1`。
- `jobs`：`fetch-bili-Oto4dmi` 数量 **0**；窗口内唯一 fetch 是 `fetch-bili-BV1p6xe6PE3s`（23:11 长链那条，done）。
- `media_notes`：`%Oto4dmi%` 数量 **0**（没有缓存可解释成“抓过但失败”）。

## 修复复核

- worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-hotfix-bili-shortlink`，分支 `pkg/hotfix-bili-shortlink` @ `2e70a38`。
- `node --test test/prefetch.test.mjs` → **6/6 pass**，含 P6“短链 5 秒后空 @ 继承该链接”。
- 线上 `/health`：`release=b0557fd…`，仍是修复前版本；`release/trip0` 的 `10be0a5` 未部署。

## 边界

未写线上 D1、未发 QQ 消息、未部署、未改业务代码。只读了生产 D1 的 SELECT。
