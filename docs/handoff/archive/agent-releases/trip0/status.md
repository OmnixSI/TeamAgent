# 趟 0（trip0）上线状态

更新时间：2026-11-14 02:50 Sydney（2026-11-13 15:50Z）· 交付员

## 结论

**已上线。** 修复「偶尔把几个小时前的旧消息又回复一遍」；/health = `f5e39c6`，公告已发出（outbox rowid 264，status=sent）。

## 版本与合并

| 项 | 值 |
|---|---|
| 版本分支 | `release/trip0`（已合入并删除远程分支） |
| 发布前 HEAD | `b64970d`（把 origin/main `1409000` 合回 release，解决 2 处冲突，保留 release 的 2 分钟继承窗 + 过期拦截） |
| PR | [#43](https://github.com/OmnixSI/TeamAgent/pull/43) `fix: 不再重发历史 @（补发时间窗 + 过期拦截）` |
| 合并方式 | `gh pr merge 43 --squash`（不等 CI、不看 CI 状态，§0.1） |
| 合并时间 | 2026-11-13T15:43:20Z |
| main 合并提交 | `f5e39c60a8fc4c4ff1bae7d3c789bd71c448570a` |
| Worker 部署版本 | `ddcad054-9967-49a9-8d47-5b900bf5b8d2` |
| /health release | `f5e39c6`（`verify-release.mjs` 通过） |

## 本机门槛（部署前，在 b64970d 上实跑）

- `npm run check`：通过（0 错）
- `npm run check:ui`：通过（UI JavaScript parses）
- `npm test`：**1063 / 1063 pass**，0 fail
- `node scripts/replay-resend.mjs`：4 条真实历史 @（rowid 131 / 132 / 153 / 348）扫描 0 次、遗留待发全部 skipped；100 秒前的新消息只补偿 1 次、只发 1 次；**QQ 真实发送 0、线上 D1 写入 0、真实网络请求 0**
- 无 Python 改动；无 D1 schema 变更（migrations 只幂等重跑 0020–0026 / 0009，全部 applied）

## 回滚点

- 首选：`bc17114a-f351-402e-a328-4e1aebea5550`（部署于 15:39Z，release `1409000`，即本趟前线上版本）
- 再往前：`8160a4b8-78fd-42f7-a214-02765ffb28c7`（release `cab6582`，F7）
- 命令：`npx wrangler rollback bc17114a-f351-402e-a328-4e1aebea5550 --name inkboard-team`
- 说明：BINI 派单里写的回滚点 8160a4b8 是上一趟的回滚点，本趟前线上已前进到 bc17114a，故以 bc17114a 为首选。
- 无 schema 变更，回滚代码不需要回滚数据库。

## 部署前只读检查（15:42Z）

| 项 | 结果 |
|---|---|
| /health | `1409000`（ok:true） |
| messages | 466 行，max(rowid)=466，最后消息 2026-11-13T23:13:41+08:00 |
| chat_cursor（群） | `466` = max(rowid)，不超前 |
| outbox | 262 行，max(rowid)=263，pending=0，sending=0 |
| mention-* 基线 | 8 行，max(rowid)=254，pending=0 |

## 部署后只读冒烟（15:48Z，部署后约 5 分钟）

| 项 | 结果 |
|---|---|
| /health.release | `f5e39c6` == main 合并提交 ✅ |
| 部署版本 | `ddcad054-9967-49a9-8d47-5b900bf5b8d2` ✅ |
| 入站 | messages 仍 466 行，max(rowid)=466，无新增（夜间无消息） ✅ |
| 游标 | `466`，等于 max(rowid)，不超前 ✅ |
| 出站 | pending=0，sending=0，无积压 ✅ |
| mention-* 新增 | 部署后 `created_at>=1794584600000` 的 mention-* 行 **0 条**（老消息未被重发） ✅ |
| 本机服务 | qq / runner / owner / utility / utility-quick / fetch 全部 running ✅ |
| 日志 | qq.log `QQ gateway resumed` 15:44:30Z；fetch.log `fetcher start ab90345558c8`；4914/4915 命中 0 ✅ |

## 群公告（§11）

- 去重键：`release-notice:trip0`（插入前 SELECT 为空）
- outbox 行号：**264**
- 状态：**sent**（15:45Z 左右由 Worker 发出；未重试、无第二条同类行）
- 正文：`我修好了一个小毛病：以前偶尔会把几个小时前的旧消息又回复一遍，现在不会了。`
- 只写这一行出站；未动入站游标、未改入站记录。

## 本机运行时

- `python3 scripts/install-local.py --apply` 已执行
- `launchctl kickstart -k` 重启 `com.inkboard.team-{qq,fetch,runner}`
- 6 个服务 state=running

## 未验证 / 遗留

- 真实群 @ 触发由用户使用验证（本趟不额外发消息）。
- runner.log 有既有 `repo index ... TimeoutError` / `bridge HTTP 500` 记录（非本趟引入，未处理）。
- trip0 无 SK 自知卡字段（SK 尚未上线，`/health.selfCard` 本趟不适用）。

## BINI 补充派单核对（2026-11-14 02:46 收到，02:56 处理）

派单要求「部署 release/trip0 @7d1cb48，不要用 10be0a5」。核对结果：

- `git rev-parse`：审查时的分支头确实是 `7d1cb4824da32f83e35d172dab0aa40764e3d8f9`。
- 但 02:43 上线时 main 已前进到 `1409000`（PR #42）。若直接部署 7d1cb48，会把 main 上的 #42 回退掉。故先把 origin/main 合回 release（`b64970d`，解决 2 处冲突），再 squash 成 `f5e39c6` 上线。
- **f5e39c6 已包含 7d1cb48 的两处修复**：
  - `src/fetchjobs.ts:46` `INHERIT_WINDOW_MS = 120000`，`:51` 只取 @ 之前 2 分钟内的链接（不是 10be0a5 的无窗口版本）。
  - `src/mention-guard.ts` 的补发扫描与 `AUTO_REPLY_MAX_AGE_MS` 过期拦截已在。
- 线上 `/health` = `f5e39c6`，Worker `ddcad054-9967-49a9-8d47-5b900bf5b8d2`。**不再重部署 7d1cb48**（那会把线上降级到旧提交）。

### 公告

- 本趟公告已于 02:45 发出：`release-notice:trip0`，outbox rowid **264**，status=sent，正文为「我修好了一个小毛病：以前偶尔会把几个小时前的旧消息又回复一遍，现在不会了。」
- BINI 补充的两句合成文案（唯一键 `announce-trip0`）**未发**：按 deploy-runbook §11「一趟只发一条」，本趟的唯一一条已用掉；且以用户名义再发一条属于新的对外消息，未获批准。短链继承能力已上线并通过回放，只是没有单独公告。
- 如果确实要补发第二句，需要用户明确同意再发，届时用新键 `announce-trip0` 并先查重。

### 与 F11（用户 02:41 的想法）的关系

用户「@机器人提需求 → 自动立项 → 开发 → 上线 → 回复原消息」已由架构师/BINI 拆成 F11（设计 `design.md`、验收 S1–S18、施工单 FR-1…FR-5 均已出，工作包在建）。交付员不在本趟重复实现；等 release/F11 集成完成后按 §0.1 上线，并在 `report shipped` 时由 `frr-<单号>` 自动回复原消息。
