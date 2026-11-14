# F11c-solo · 需求消费端独立包 + 全链路缺口 + 打开 claim 清单

- 2026-11-14 19:05 Sydney 开工；worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-F11c-solo`，分支 `pkg/F11c-solo`，基线 `origin/main` `25e5094`。
- 提交：`fcf0118` feat（cherry-pick `7fafb92`，只取 `scripts/fr-consume.{mjs,md}`、`test/fr-consume.test.mjs`，无 migrations/records）、`5aa08e3` fix（MG2 预算，见 §2）。未 push、未部署、未开 claim、未写线上 D1、未发群。

## 1. 验证（实测输出）

| 命令 | 结果 |
|---|---|
| `npm run check` | 退出 0 |
| `npm test` | tests 2139 / pass 2129 / fail 0 / skipped 10（36.6s） |
| `node --test test/fr-consume.test.mjs` | 9/9 通过 |
| `node --test test/mention-guard.test.mjs test/feature-request-api.test.mjs` | 46/46 通过；MG2 计数 48（修前 49） |

真实 dry-run（只读 GET，不领、不写线上；开关文件不存在 = 默认关）：

```
$ node scripts/fr-consume.mjs --out /Users/yanghongming/Projects/.agent/feature-requests --token-file ~/.inkboard-team/admin-token
fr-consume：开关关闭，dry-run，只列不领。将处理 0 张：
（要领取：把 ~/.inkboard-team/fr-consume.json 设为 {"enabled":true}，再加 --claim。）
没有 queued + mode=build 的单。
EXIT=0
```

同命令对本地桩（127.0.0.1，3 张假单，仍不带 --claim）验证列单/分流：

```
fr-consume：开关关闭，dry-run，只列不领。将处理 2 张：
- fr-900 · 早上天气+日程播报 → pkg/FR-900 · /Users/yanghongming/Projects/.worktrees/TeamAgent-FR-900
- fr-901 · 批量对外发消息 → pkg/FR-901 · /Users/yanghongming/Projects/.worktrees/TeamAgent-FR-901
needs_human/proposal 1 张不动。
EXIT=0
```

## 2. main 上 MG2 红：根因与修法（本包附带修复）

- 现象：`test/mention-guard.test.mjs:43` MG2 断言 scheduled tick ≤48 条 D1 语句，实测 **49**，main `25e5094` 红。
- 复现：另开 `20220a1`（当前线上版本）干净 worktree 跑同一测试，同样 49 红 → **不是本包引入**，是 main 既有红。
- 根因：`33c71fa`（F11 FR-3）在 `scheduled()` 里加了 `sweepFeatureRequests`（`src/worker.ts:1521`），它每次先做 2 条发现查询（租约过期 + 超时未落地）。去掉这一行后 MG2 实测 47 → 48 上限，**这 2 条查询正好顶破 48**。
- 修法：`5aa08e3` 把两条发现查询合成一条 `UNION ALL`（各自子查询保留自己的 ORDER BY + LIMIT 20），JS 里按 `src` 分流并重新排序；阈值 `reserve + 2` → `reserve + 1`。语义不变，S11/S11b/预算矩阵/46 条相关测试全过，MG2 回到 48。
- 替代方案（未采用）：把 MG2 的 48 改大。那等于放宽对话预算护栏，不如省一条语句。
- 注意：`release/D` 的 `src/feature-request-api.ts` 与 main 同版本，合并本包不会冲突；`release/D` 只改了 `worker.ts`。

## 3. 全链路：一条线上真实请求从「群里被 @」到「回复原消息」

| # | 环节 | 代码/运行位置 | 负责人 | 现在通没通 |
|---|---|---|---|---|
| L1 | 群消息 @ → 模型判意图 → 调 `request_feature` → 建单 | `src/semantic.ts:882`（工具）、`:1387`（case）、`src/authz.ts:148`（原话/@/污染闸门）、`src/feature-request.ts:36`（createRequest） | 平台（Worker，FR-2） | 代码在 main 且已部署；测试员 19:11 的只读盘点（`ledger-all/live-state.md` §3）记录 `feature_request` 表 0 行、`request_feature` 调用 0 次；我自己的 `GET ?status=queued,needs_human` 也返回 0 张（只证明没有待处理单）。已核的两条「加表情/用某书腔调」是普通发言，不满足「直接 @」闸门，不能据此判坏；**真 @ 建单从未验证** |
| L2 | 拉单（每 15 分钟） | launchd `com.inkboard.team-fr`（`~/Library/LaunchAgents/com.inkboard.team-fr.plist`）→ `scripts/fr-pull.mjs`，worktree `TeamAgent-fr-ops` | BINI/运维 | **通**，pull-only（无 `--claim`），interval 900s，last exit 0，0 单。脚本与 main 同版本（fr-ops 固定 3adfdf8，scripts 无 diff） |
| L3 | 消费/建包（领单 + 每单 worktree + 施工单） | `scripts/fr-consume.mjs`（本包） | 工程师 | **不通**：不在 main、无例行任务、开关默认关 |
| L4 | 派单给施工者 | `orders/<id>.md` + `ready-to-dispatch.md`（fr-consume 写） | 主程/BINI | **不通**：没有任何人或任务读这张板；BINI 的 15 分钟例行只拉单不派 |
| L5 | 施工 | worktree `TeamAgent-FR-<票号>`，分支 `pkg/FR-<票号>` | 施工者 | 依赖 L3；建包逻辑已有测试（真实 git worktree） |
| L6 | 本机门槛 | `node scripts/fr-consume.mjs gate <id>` → `npm test`+`npm run check` → `gate/<id>.json` | 施工者 | **刚修通**：main 的 MG2 红会让每张单的门槛永远失败，本包 `5aa08e3` 修好后 48/48 |
| L7 | 合并 + 部署 | `scripts/deploy.mjs`，`env.RELEASE` = 当前 sha；`npm run verify:release` | 交付员/主程 | 既有流程**通**；但没有「单号 ↔ PR ↔ sha」绑定 |
| L8 | 回写 shipped | `scripts/fr-report.mjs shipped --release <sha7> --rollback <上一版> --reply "…" --smoke-passed` → `POST /api/team/feature-requests/<id>/report`（`src/feature-request-api.ts:281`） | 交付员/BINI | **不通**：没人调 fr-report；部署完不会自动回写 |
| L9 | 入队回复原消息 | `enqueueReply`（`src/feature-request-api.ts:109`）：CAS 到 shipped 与 `INSERT OR IGNORE outbox('frr-<单号>')` 同一 D1 batch；有 `message_refs` 就带 reference，没有就加「回复『原话前12字』…」前缀 | 平台 | 代码**通**；线上从未有过 shipped 单，未验证 |
| L10 | 真发送 | `sendOutbox`（`src/worker.ts:1157`），cron `* * * * *`（`wrangler.toml:10`）每分钟扫 pending；引用失败 400/422 去引用重发一次；失败不重新入队 | 平台 | 代码**通**；被动回复 4 分钟窗口外走主动消息（引用可能被丢） |
| L11 | 失败/超时兜底 | `sweepFeatureRequests`（`:422`）：租约过期 attempts<3 回 queued，≥3 或 >72h → failed 并回「排太久没落地，已转人工」 | 平台 | 代码**通**（本包顺手省 1 条语句） |
| L12 | needs_human / 敏感单决策 | `decide`（`:355`）仅 owner；`approve` 置 queued+auto=1 | 用户（经 BINI） | **不通**：没有把 needs_human 单送到用户眼前的路径（不进晨报、群里不回），单子会静默躺着，直到 72h 被判 stale（proposal 单不受 stale 影响，会一直躺着） |

**一句话结论**：管道两头（建单、回复）代码都在线上，中间「领单→建包→派单→门槛→部署→回写 shipped」整段没有自动化，且从未有一张真单走通过；真正卡住用户的不是代码缺失，是 **L3/L4/L8 没人接线 + L1 从未被真实 @ 验证**。

## 4. 补齐施工方案（按性价比排序）

1. **L4 派单（必须，半天）**：BINI 的 15 分钟例行改三步——`fr-pull`（现状）→ `fr-consume`（开关开+`--claim`）→ 读 `ready-to-dispatch.md` 里「可交付：否」的新单，用 `coordinate_bots` 开新线程派给工程师/程序员，消息只带施工单路径。不要自动派 needs_human/proposal。
2. **L8 回写（必须，半天）**：部署步骤末尾加一步「本次部署覆盖了哪些单 → `fr-report shipped`」。最小做法：交付员部署后在同一个 `pkg/FR-*` worktree 里读 `gate/<id>.json`，用 `--release <新 sha7> --rollback <旧 Worker 版本> --reply "<口语一句>"` 回写；`--smoke-passed` 只在真冒烟后加。没有这步，单子永远 developing，6h 后租约过期回 queued，来回空转。
3. **L12 待决策提醒（必须，1 小时）**：晨报加一段「待你定」：`GET /api/team/feature-requests?status=needs_human` 的单号+标题+风险标签，附 approve/reject 命令；BINI 不代批。
4. **L1 真实验证（必须，用户一步）**：让用户在群里对机器人直接 @ 说一句「你应该加个…」，核对 `feature_request` 新增 1 行 + 机器人只回一句「收到」。这是唯一无法在本机证明的环节（模型判意图）。
5. **L7 绑定（可选）**：`fr-report` 成功后把单号写进 PR 描述/公告，便于复盘。
6. 已在本包去掉的阻塞：L6 的 MG2 红。

## 5. 打开 claim 的最小安全步骤

前置事实：

- 服务端**没有** claim 开关。`POST /claim` 只要 owner 令牌就能领；真正的闸只有本地两个：开关文件 + `--claim`。
- 精确名字/默认值：
  - `off:feature_request` —— D1 `settings` 表的键；值 `"1"` 关闭，缺失或其它值开启（`src/feature-request.ts:7`）。据测试员 `live-state.md`（19:11 只读全表核对）：线上 43 行 settings 里**没有这个键** → 开启；另需 `config/team.json` 的 `feature_requests.enabled=true`（现为 true，`config/team.json:148`）。
  - claim 开关 —— `~/.inkboard-team/fr-consume.json`，缺文件 = `enabled:false`（`loadConsumeConfig` 返回 `default:off`）；认 `{"enabled":true}` 或 `{"fr_consume":1}`；环境变量 `FR_CONSUME=1/0` 可临时覆盖。
  - 第二个闸 —— 命令行显式 `--claim`。两者缺一即 dry-run。

步骤：

1. **确认门槛绿**：`pkg/F11c-solo`（含 `5aa08e3`）已合入要跑消费端的那条线；在该 worktree 跑 `npm run check && npm test`，必须 0 fail。main 现在还红，**先合 `5aa08e3` 再开**。
2. **令牌**：`~/.inkboard-team/admin-token`（0600，81 字节，role=owner）。先跑一次只读 `node scripts/fr-pull.mjs --token-file ~/.inkboard-team/admin-token --json`，退出 0 再继续；令牌不进日志、不进聊天。
3. **单次上限**：先把 `config/team.json` 的 `feature_requests.max_developing` 从 2 降到 1（要部署）——第一天宁可慢，也不要一次领两张。服务端另有 auto 5/天、每人 10/天、全群 30/天。
4. **开开关**：`mkdir -p ~/.inkboard-team && printf '{"enabled":true}\n' > ~/.inkboard-team/fr-consume.json && chmod 600 ~/.inkboard-team/fr-consume.json`。然后**先不加 `--claim`** 跑一次，确认只列不领。
5. **手工领一次**：`node scripts/fr-consume.mjs --claim --out /Users/yanghongming/Projects/.agent/feature-requests --token-file ~/.inkboard-team/admin-token`。核对：只领 1 张、只建 1 个 worktree、`orders/` 有施工单、`ready-to-dispatch.md` 出现该单。
6. **跑通一整圈再上定时**：施工 → `gate` 绿 → 部署 → `fr-report shipped` → 群里看到回原消息的回复。**这一圈没走通之前不要装 launchd/例行任务**，否则领了不做的单会在 6h 后回队列、72h 后失败。
7. **上定时**（走通后）：launchd `StartInterval 1800` 或 BINI 例行；同一时刻只允许一个实例（脚本自身没有锁文件——这是已知缺口，建议定时器用 `flock`/`mkdir` 锁或保证 interval > 单次运行时长）。
8. **门槛失败时**：`gate/<id>.json` 的 `pass:false` 一律不得 `report shipped`；要么继续修，要么 `fr-report failed --reason "<口语原因>"`（会回群），要么 `fr-report release` 放回队列。不得把部分完成报成 shipped。
9. **回滚**：`printf '{"enabled":false}\n' > ~/.inkboard-team/fr-consume.json`（或 `FR_CONSUME=0`、删文件）→ 对已领未做的单 `fr-report release` → `git worktree remove <worktree>` + `git branch -D pkg/FR-<票号>` → 删 `orders/`、`gate/`、`ready-to-dispatch.md`。服务端租约 6h 会自动放回，不需要手动改库。没装定时就没有 launchd 要卸。
10. **永不**：自动批准（decision 只有 owner 能调）、领 `mode=proposal`、领 `needs_human`、绕过 `--smoke-passed` 报 shipped。

## 6. 已知风险 / 未验证

- fr-consume 只按 `status=queued && mode=build` 列单，不看 `auto`。线上 `auto=0 + queued + build` 目前不可达（`approve` 会把 auto 置 1），但若有人手改库，`--claim` 会按 id 领走（服务端按 id 领也不查 auto）。建议将来加 `item.auto === true` 过滤。
- 真实 dry-run 只有 0 张单，列单分支是用本地桩验证的；真实有单时的输出格式未在线上见过。
- `fr-consume` 没有并发锁；两个实例同时 `--claim` 时第二个会被服务端 409/`illegal_transition` 挡住并停止整批，不会重复建包，但会提前结束本轮。
- L1（模型是否在真实 @ 下调用工具）本机无法证明，只能用户在群里试一次。
- 线上 Worker 仍是 `20220a1`；本包未部署，`fr-consume` 只在本机跑。
