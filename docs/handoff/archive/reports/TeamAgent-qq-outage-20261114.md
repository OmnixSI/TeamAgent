# TeamAgent QQ bot「下线」事件（2026-11-14 00:03–00:11 Sydney）

## 结论
不是 Worker 挂了，也不是 QQ 长连接断了。是 **全局 `settings.chat_cursor` 被线上回放推到 432**，之后真实消息复用了 426–432 的 rowid，全部命中 `m.ordinal <= cursor` 的跳过分支：任务被标记 done，但不生成 decision/outbox，所以群里看起来像 bot 下线。

## 时间线（Sydney）
- 22:49–23:12 交付员的 B 站音轨验收回放直接写线上 D1：合成消息/任务用 `REPLAY-GROUP-v1-*`，7 个 turn 的 `stage_timings` 可见 `REPLAY-v1..v5/sub/sub2`；清理只按 REPLAY 前缀删行，**没有恢复 `chat_cursor`**。
- 23:45–00:03 真实消息 426–432 进来（含 23:49「说话」、00:03 空 @），rowid 复用了回放删掉的行号。
- 00:03:14 / 00:03:20 两条 chat 任务建立，00:04 cron 处理，全部 `done`、attempts=1、无 outbox、无 chat_decisions（最后一条 decision 停在 21:41）。
- 00:11 修复后，bot 对 428–432 批次生成回复并发送成功。

## 证据
- `messages` 426–432：`has_outbox=0`；425 及以前 `has_outbox=1, status=sent`。
- `chat_cursor`=432 = `MAX(rowid)`；`jobs` 432 `status=done, attempts=1, error=''`。
- `chat_decisions` 最新 21:41:31，`outbox` 最新 21:41:31，直到修复前无新增。
- `stage_timings` 有 75 行 `turn_id LIKE 'REPLAY%'`，时间 22:49:05–23:12:17。
- 修复后：outbox 新行 `status=sent, http_status=200`，created 00:11:15；job 432 `done, attempts=1`；cursor 回到 432（已消费到最新）。
- `/health`：`{"ok":true,"release":"876221409c89ff4fb99ef1a3e8fd5ef62ebb683c"}`。
- QQ 网关：PID 11571 两条 ESTABLISHED；qq.log 最后 `12:57:49Z resumed`。

## 恢复动作（已执行）
1. `UPDATE settings SET value='427' WHERE key='chat_cursor'`（427 = 最后一条真正回复过的消息 425 之后、待回复批次之前）。
2. `UPDATE jobs SET status='pending',attempts=0,lease_until=0,error=NULL WHERE id=(SELECT 'chat-'||id FROM messages WHERE rowid=432)`。
3. 00:11 cron 领取，bot 回复 428–432 批次，outbox `sent` 200。

## 当前线上版本
- release `8762214`（PR #34，delivery 旧回执修复），部署版本 `fdf00234-a2e3-43ee-b2ef-55cdbfe87c27`（23:57:21）。
- 上一个版本 `392b4d9a-7a9c-4647-a7d0-9cd9df98e712`，可 `wrangler rollback`。
- 23:52 的 main push CI `43428814239` 在 `Deploy shared team service` 失败：self-hosted runner 没有 `CLOUDFLARE_API_TOKEN`（`sync-runtime-secrets.py` 第一步就退出）；23:57 的发布是手动完成的。CI 自动部署当前不可用。

## 待修（P1，代码）
- `chat_cursor` 是全局单键，不按 group 分；任何回放/另一个群都能把真实群卡死。建议改成 `chat_cursor:<group_id>`，首次从旧全局键初始化，补迁移测试。
- 回放纪律：合成消息不得写线上 D1；必须用本地 `wrangler dev --local` + 独立 D1（V-A replay 已如此）。确需线上回放时，清理必须同时恢复 `chat_cursor` 并记录快照。
