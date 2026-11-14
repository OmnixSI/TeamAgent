# F11fix 上线交付（2026-11-14 19:38–19:44 Sydney）

## 结果

| 项 | 值 |
|---|---|
| PR | #56 `fix(fr): @ 提需求当场建单并回「已记下」` |
| 合并 | squash → main `5122f3fe382d1fb5fb8d117a62db5bd9a7232391`（19:41:29 Sydney） |
| 发布提交 | `5122f3f`（基于 `cc7efc3`；`203cee6` cherry-pick 无冲突，release 分支提交 `dd0340b`） |
| Worker 版本 | `d6ec48ab-cb4d-42bf-b665-ead5297e6b8e` |
| `/health` / selfCard | 均为 `5122f3f`（`npm run verify:release` 通过） |
| 回滚点 | `361cb335-0342-45e2-bc61-92d7b4956ac1`（`cc7efc3`，#55） |
| 公告 | `release-notice:F11fix`，outbox rowid `385`，插入 19:43，19:43:12 `sent`/HTTP 200；正文「现在 @我 提需求（包括改说话方式），我会真的登记并回你「已记下」。」 |
| F11 claim | 未开（`settings` 未动 claim 相关键） |

## 门槛（本机，CI 配额已尽，按 runbook §0.1 不等 CI）

- `npm run check`：退出 0
- `npm run check:ui`：`UI JavaScript parses`
- `npm test`：**2222 tests / 2212 pass / 0 fail / 10 skipped**（35.7 s）
- 定向：`test/feature-request-intake.test.mjs` + `test/reply-finalize.test.mjs` **43/43**，含 S18、S19、F1b 与 F8 假回执守卫

## 真实原话回放（本地库、真实 DeepSeek、QQ 发送 0、线上 D1 写入 0）

脚本按 release worktree 复制：`.agent/tmp/f11fix-replay-release.mjs`；结果 `ledger-all/notes/f11fix-release-replay.json`。

| 真实原话 | 工具 | feature_request | research job | 回复 |
|---|---|---|---|---|
| emoji「你以后给我们回复文字的时候…」 | `request_feature` ×1 | 1 行（queued/build） | 0 | 收到，已记下，做好了告诉你。 |
| 修仙「我最近喜欢看 没钱修什么仙…」 | `request_feature` ×1 | 1 行（queued/build） | 0 | 收到，已记下，做好了告诉你。 |

- 回放中 `unexpected` 网络：空；`outbox`：空（没有多发消息）。
- 真实群 @ 自测**未做**：部署后核对时群里最新真人 @ 是 19:35:22（`以后每次我们发出绘图指令…`），已超出 240s；没有新消息可触发，按主程指示「不要为此等」。未插 `selftest:fr:2026-11-14`，未动游标/入站。

## 部署

```bash
npm ci
npm run db:migrate      # 0002…0080 幂等重跑，无新 schema
npm run deploy          # Current Version ID: d6ec48ab-cb4d-42bf-b665-ead5297e6b8e
npm run verify:release  # Live release verified: 5122f3fe...
```

## 冲突提醒（给主程，未处理）

`release/D` 与 F11fix 在 `src/semantic.ts`（LOCAL_TOOLS/import 行）和 `src/reply-finalize.ts`（①b 插到 D 版 ① 之后、`guardReceipts` 之前）有冲突点，解法按 `.agent/releases/ledger-all/notes/F11fix.md` §6；本次 main 上的 #54/#55 已自动合入，无冲突。

## 遗留

- 模型选择仍有波动；确定性来自 `LOCAL_TOOLS`（不转后台）与 ①b（回执必出现），不保证 100% 选对工具。
- 公告只写「已登记」这一已验证事实；「改说话方式」真正生效仍取决于后续消费端，未在公告里承诺上线时间。
- `release/F11fix` 远程分支已删除、release worktree 已移除（19:44）；`pkg/F11fix` worktree 保留给工程师/主程复查（提交未满 2 小时，按清理规则不删）。
