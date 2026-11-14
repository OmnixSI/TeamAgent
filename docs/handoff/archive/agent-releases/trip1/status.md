# 趟 1（trip1）上线状态

更新时间：2026-11-14 03:18 Sydney（2026-11-13 16:18Z）· 交付员

## 结论

**已上线。** main `b763499`，Worker `d9d27ee0-1af7-40c0-bbcb-b86b999edd72`，`/health=b763499`；公告已发出（`release-notice:trip1`，outbox rowid 265，status=sent）；6 个本机服务 running。

## 版本与合并

| 项 | 值 |
|---|---|
| 版本分支 | `release/trip1` @ `1935039b1d39d01f7714fef0aa0032eecf53d00a`（已合并，远程与本地分支随清理删除） |
| PR | [#44](https://github.com/OmnixSI/TeamAgent/pull/44) `release: trip1（语音链路修复、新工具与 B 站链接继承）` |
| 合并方式 | `gh pr merge 44 --squash`（不等 CI、不看 CI 状态，§0.1） |
| 合并时间 | 2026-11-13T16:11:25Z（03:11 Sydney） |
| main 合并提交 | `b76349964fd45ff1fde5fadff341612770c310f1` |
| Worker 部署版本 | `d9d27ee0-1af7-40c0-bbcb-b86b999edd72`（16:12:10Z） |
| /health release | `b76349964fd45ff1fde5fadff341612770c310f1`（`verify-release` 通过） |

## 本机门槛

- `npm run check`：通过（0 错）
- `npm test`：**1359 / 1359 pass**，0 fail（交付员在 1935039 上实跑）
- `npm run check:ui`：通过（主程记录）
- runner 测试 **79/79**、`replay-resend` / `daily-push` 回放通过（QQ 真实发送 0、线上 D1 写入 0）——主程记录
- 审查：审查员 **PASS** @1935039，两条 P1（交付扫描预算、语音先消费后转写）修复后复核通过（`.agent/releases/trip1/review.md`）
- 迁移：`npm run db:migrate` 幂等执行 15 个文件全 applied，含新增 `0060_ds_usage`（4 条）

## 回滚点

- 首选：`ddcad054-9967-49a9-8d47-5b900bf5b8d2`（本趟前线上，release `f5e39c6`）
  `npx wrangler rollback ddcad054-9967-49a9-8d47-5b900bf5b8d2 --name inkboard-team`
- 再往前：`bc17114a-f351-402e-a328-4e1aebea5550`（release `1409000`）
- 本趟迁移只增表/索引且幂等，回滚代码无需回滚数据库。

## 部署前只读（16:10Z）

| 项 | 结果 |
|---|---|
| /health | `f5e39c6…` |
| 当前 Worker 版本 | `ddcad054-9967-49a9-8d47-5b900bf5b8d2` |
| messages | 466 行，max(rowid)=466 |
| chat_cursor（群） | `466` = max(rowid) |
| outbox | 263 行，max(rowid)=264，pending/sending=0 |
| mention-*（mention_receipt + semantic_reply） | 8 行（max rowid 590 / 29） |
| owner id 指纹 | `7232300a26c8`（只记哈希前 12 位） |
| 运行中任务 | running/pending = 0，可安全重启本机服务 |

## 部署后只读冒烟（16:12Z 起）

| 项 | 结果 |
|---|---|
| /health.release | `b763499` == main 合并提交 ✅ |
| 新迁移表 | `ds_usage`、`image_gen_log`、`generated_images`、`kb_docs`、`kb_chunks`、`profiles`、`episodes`、`summaries`、`tool_calls`、`schedules` 全部存在 ✅ |
| 入站 | messages 仍 466 行，max(rowid)=466，无新增 ✅ |
| 游标 | `466` = max(rowid)，不超前 ✅ |
| 出站 | 263 行 / max(rowid)=264，pending+sending=0，无新增积压 ✅ |
| mention-* 新增 | 部署后 5 分钟（至 03:17:31 Sydney）0 条 ✅ |
| 新开关默认关 | `config/team.json` `voice.tts.enabled=false`；`off:*` 仅 quote/sticker_collect/wait=0，无新增开关被打开 ✅ |
| owner id 指纹 | `7232300a26c8`，与部署前一致 ✅ |
| 本机服务 | qq / fetch / runner / owner / utility / utility-quick 全部 running ✅ |
| 日志 | qq.log `QQ gateway resumed` 16:12:31Z；reload.log「已在空闲时启用新版本本机服务」✅ |

## 群公告（§11）

- 去重键：`release-notice:trip1`（插入前 SELECT 为空）
- 正文：`又修好一个小毛病：发了 B 站链接后，哪怕紧接着再单独 @ 我，我也能认出刚才的视频。`
- 只写这一行出站；不碰入站游标、不改入站记录。

### 公告执行记录

- 插入前 `SELECT id='release-notice:trip1'`：空 → `INSERT OR IGNORE` 成功（changes=1）
- outbox 行号：**265**，created_at 1794586427375（16:13:47Z）
- 状态：**sent**（16:14 左右由 Worker cron 发出，`msg_id` 为空，与 trip0 一致）
- 同键行数复查：`release-notice:trip1` = 1 行；`release-notice:*` 共 2 行（trip0 1 + trip1 1），无第二条同类行
- 出站总积压：pending+sending = 0

## 本机运行时

- `python3 scripts/install-local.py --apply` 已执行（写入 `~/.inkboard-team`）
- `launchctl kickstart -k` 重启 `com.inkboard.team-{qq,fetch,runner}`
- 6 个服务 state=running

## 未验证 / 遗留

- 真实群里的语音、生图、读图、搜索等新能力未在真实群验证；本趟公告只写 B 站链接这一条已验证的修复。
- `/health` 当前无 `selfCard` 字段（SK 自知卡尚未上线），本趟不适用。
- 合并前 main 上的 GitHub Check run 红/queued 忽略，不影响线上（§0.1）。
- `~/Library/Preferences/.wrangler/logs` 在本机沙箱下不可写，wrangler 日志已改指 `/tmp/wrangler-trip1`，不影响部署。

## 清理

- 已合并的包 worktree：`TeamAgent-trip1-fixsweep`、`TeamAgent-trip1-fixvoice`（均干净）已 `git worktree remove`，本地 `pkg/trip1-fix-*` 分支已删。
- 集成 worktree `TeamAgent-trip1-release` 已删除；远程与本地 `release/trip1` 已删除。
- 临时文件：`/tmp/trip1-pr.md`、`/tmp/wrangler-trip1` 已清理。
- 保留：`/Users/yanghongming/Projects/.agent/releases/trip1/`（status.md、review.md、review-evidence.json）。

## 上线后只读复核（2026-11-14 03:26 Sydney，BINI 追加）

| 项 | 结果 |
|---|---|
| /health release | `b76349964fd45ff1fde5fadff341612770c310f1`，等于 trip1 合并提交 ✓ |
| Worker 版本 | `d9d27ee0-1af7-40c0-bbcb-b86b999edd72`，与上线记录一致 ✓ |
| chat_cursor（全局 legacy） | **450**（旧键，已停用） |
| chat_cursor:9968…（现行，按群） | **466** |
| MAX(messages.rowid) | **466**（游标落后 16） |
| MAX(outbox.rowid) | **265** |
| 公告 release-notice:trip1 | rowid **265**，status **sent**，正文：「又修好一个小毛病：发了 B 站链接后，哪怕紧接着再单独 @ 我，我也能认出刚才的视频。」|
| owner id 指纹（对照 F11 假定 `0FC1E8A8…`） | **是**（依据 messages.sender 前缀匹配 227 条；`members` 表无 owner 角色行，仅 4 名成员） |
| runner.log `repo index TimeoutError` | **0 次** |
| runner.log `bridge HTTP 500` | **14 次**，集中在日志尾部（行 3904–3924），最后写入 **02:53:52**，此后约 30 分钟无新增；同期另有 `repo index: report unavailable` |

- 以上均为只读核对；未写线上、未发群、未部署、未处理告警。
- 全局 legacy 游标 450 与现行群键 466 的差异见下节；经追查**不是倒退**，是旧键不再更新。


## 游标“倒退”追查（2026-11-14 03:35 Sydney，只读）

**结论：不是倒退，是读了旧键。** PR #36（`f48024a`，2026-11-13 21:52 +08）起游标按群存 `chat_cursor:<group>`，`getChatCursor` 优先读该键；全局 `chat_cursor` 仅作一次性迁移回退，不再更新，停在 **450**。当前群键一直是 **466**，等于 `MAX(messages.rowid)`。trip1 的迁移（`0060_ds_usage`）不碰 settings/游标。

**451–466 共 16 条**（14:36–15:13Z）：发送者 3 条 `CBFD…`、5 条 `B391…`、8 条 owner `0FC1…`；全部 `direct=1`（@/引用直达），无 `mentioned` 批量标记。对应 outbox 回复 11 行（rowid 245–263，均 `sent`，时间 14:37–15:14Z）；451/452/454/455/460/461/463 无独立 outbox 行，可能并入同一批回复。

**部署后（16:12:10Z 起）**：除公告 `release-notice:trip1` 外，outbox 新增 **0**；针对 451–466 旧消息的新 outbox **0**；无重复回复。**重发风险：无**——现行群键 466 已是最大值，下一次 `getChatCursor` 直接返回 466。

**建议命令（待 BINI 确认，本次未执行）**：无需复位。若要把 legacy 键也对齐、消除误读：`UPDATE settings SET value='466' WHERE key='chat_cursor';` 该更新不影响现行逻辑，仅让旧回退路径不再显示滞后。
