# A2 上线记录（A3 额度公开 + A3b + read-docs）

- 时间：2026-11-14 15:11–15:19 Sydney · 交付员
- 分支/提交：`release/A2 @ c830efa0d4ad3baf52ce676008575d6c1d458eee`
- 上线方式：本机手动（CI 额度已用尽，未等 CI）

## 1. 结论

| 项 | 值 |
|---|---|
| 线上 release | `c830efa0d4ad3baf52ce676008575d6c1d458eee` |
| `/health.release` | 同值 |
| `selfCard.commit` | 同值 |
| 新 Worker 版本 | `ead62cca-0164-478f-a6d7-08e6fbf1ec2f` |
| 回滚点（旧 Worker） | `32aa437b-c433-4374-9b84-3184851dedd0`（release `e67743f`） |
| review Worker | 本批无 `src/review/`、`wrangler.review.toml` diff，未重发；仍 `88ab4e46-71fb-47e8-b0ff-e048d6d7faf3` |
| main merge commit | `e6edc94212b2927acd603724d1a16446bc7ca965`（`--no-ff`，已 push） |

## 2. 门槛（本机，部署前）

- `npm run check`：0 错；`npm run check:ui`：干净。
- `npm test`：**1949 tests / 1939 pass / 0 fail / 10 skip**（34.9 s）。
- 依赖未变（`package.json`、`package-lock.json` 相对 main 无 diff），复用已安装的 `node_modules`（wrangler 4.159.0，Node v26.13.0），未跑破坏共享软链的 `npm ci`。
- D1 迁移（幂等）：`schema.sql` 102 条 + 0002/0003/0004/0008/0009/0020/0021/0022/0023/0025/0026/0040/0041/0042/0043/0044/0060/0070；本批无新迁移。
- 两条 DLQ 已存在（上一趟建好），deploy 未报 `dead_letter_queue` 校验错误。

## 3. 本机服务

- `python3 scripts/install-local.py --apply`（需 full-access）后 kickstart 7 个 label。
- `qq / fetch / runner / owner / utility / utility-quick`：`state = running`。
- `media`：60 秒定时单次任务，两次运行之间 `state = not running` 属正常；`runs = 43`、`last exit code = 0`。
- `qq.log` 末行 `2026-11-14T04:17:30.963Z QQ gateway resumed`；`TTS toolchain ready: /opt/homebrew/bin/ffmpeg` 已恢复（运行目录从合并后的 main 安装，见 §6）。
- 所有 `*-error.log` 只有 `media-error.log` 非空（159 字节、mtime 仍是 02:15，仍是最初 3 行 `media worker unavailable`，本次没有增长）。

## 4. 只读冒烟（15:18 Sydney，全部 SELECT，rows_written=0）

| 项 | 值 | 判定 |
|---|---|---|
| `messages` / `MAX(rowid)` | 467 / 467 | 无新增 |
| `chat_cursor:9968…`（群游标） | 467 | = max rowid，无回放 |
| legacy `chat_cursor` | 450 | 代码优先读群游标，不使用 legacy |
| `outbox` 行数 / max rowid | 282 / 283 | — |
| `outbox` pending+sending | 0 | 无堆积 |
| 5 分钟内 mention 积压 | 0 | 通过 |
| 全部未处理 mention | 1（rowid 467，14:36 的「DeepSeek 还有多少余额」，14:37 已由 research 任务回答） | 旧行，群游标已越过 |
| `off:image_gen` | `1` | 生图仍关 |
| `docread:enabled` | 不存在 | read-docs 保持关闭 |

时间比较用 `julianday(ts)`（入站 ts 带 `+08:00`，直接字符串比较会误判）。

## 5. 公告

- `release-notice:quota-open`：`INSERT OR IGNORE` changes=1，outbox **rowid 284**，15:15:13 入队。
- 15:15 复核：`status=sent`、`msg_id=null`、`outbox_attempts.http_status=200`、同键 1 行。
- 正文与 queue.md §7 完全一致：DeepSeek 给具体数字+较上次；旧「OpenAI 还剩 3 美元」更正为团队自设每日预算、不是账户余额、账户余额查不到；生图只说「还没开放」，无「能生图」。
- 未动游标，未写其他表。

## 6. 自测：真实消息回放（只读，未往群里发测试消息）

- 输入：线上真实入站 `messages.rowid=467`「DeepSeek 还有多少余额」（成员句式；另用 `isQuotaQuestion` 验证无 @ 也识别）。
- 方法：把线上 settings / ds_usage / openai_usage / quota_reservations 用 SELECT 快照到本地内存 SQLite，用**已部署 commit c830efa 的 `renderQuota`** + 真实 DeepSeek 余额接口跑一遍；线上 D1 只读、QQ 发送 0。
- 结果（2026-11-14 15:15）：

```
DeepSeek 余额：¥82.93（可用；赠送 ¥0.00 / 充值 ¥82.93；查于 11-14 15:15）
DeepSeek 用量：今天 3 次 / $0，本月 3 次 / $0；近 7 天没有用量
OpenAI 每日预算（团队自设的闸门，不是账户余额）：今天已用 $0（0 次），预算还剩 $3.00
OpenAI 账户余额：查不到（没有公开接口），请看 OpenAI 后台。
Workers AI：今天 0 / 8000 neurons（UTC 日）
Cloudflare 账户级额度没有公开接口，请看 Cloudflare 后台。
较上次（14:37）：DeepSeek 余额 −11.87 元 / 今日调用 +2 次
```

- 断言全过：具体余额 ✓、较上次 ✓、「每日预算…不是账户余额」✓、「账户余额：查不到」✓、不含「OpenAI 还剩」✓、`off:image_gen=1` 时无生图行 ✓。
- 脚本：`.agent/releases/A2/replay-quota-live.mjs`；数据快照：`settings.json` / `ds_usage.json` / `openai_usage.json` / `quota_reservations.json`。

## 7. 合入 main

- `git merge --no-ff release/A2` 在 main worktree（`TeamAgent-V-D-release`）。
- 冲突：`src/quota.ts`、`test/quota.test.mjs`（main 的 2cfb4bd 与 A2 的 f25e459 是同一处「生图关闭时隐藏额度行」的重复修复，字段名不同）。
- 解决：两文件取 `release/A2` 侧（含 A3 公开额度 + A3b + 生图行隐藏）；`src/quota.ts`、`test/quota.test.mjs` 与 c830efa 逐字一致（`git diff c830efa e6edc94 -- 这两个文件` 为空）。
- 合并后门槛：`npm run check` 0 错、`check:ui` 干净、`npm test` **1960 / 1950 pass / 0 fail / 10 skip**。
- merge commit `e6edc94`，已 push `a6f34f0..e6edc94`；A2（c830efa）和 main 原有 A-ttspath（a6f34f0）都是它的祖先。

## 8. 遗留 / 未验证

1. **线上比 main 少一个合并提交**：线上是 `c830efa`，main 是 `e6edc94`。main 额外带的是 A-ttspath（语音 PATH 修复、health 工具链、0061 迁移）。0061 之前已应用到 D1，但 A2 代码不使用它。本次按施工单只部署 c830efa；**语音 PATH 修复尚未上线**，需下一次部署 main 才生效。
2. 本机运行目录最后从 **main e6edc94** 安装（保留另一条语音线程刚装好的 `runner/toolchain.mjs`），因此本机 runner 比线上 Worker 新一个合并提交；只差 A-ttspath 的 runner 侧改动，不影响本批额度/文档功能。下一次部署 main 后两者一致。
3. 真实模型对最终措辞的压缩没有在群里复测（不发测试消息）；已用部署 commit 的确定性文案 + 工具描述 + 单测覆盖「不得出现 OpenAI 还剩」。
4. 旧 mention rowid 467 仍 `processed=0`（14:37 由 research 任务回答，不是 chat 路径）；群游标=467 已越过，不会被回放。
