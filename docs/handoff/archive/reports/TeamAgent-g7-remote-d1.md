# G7 远程 D1 实测：M1-S 7 条认领 batch

## 总结（15 行内）
- 结论：远程与本地一致（7 项对照全部 MATCH）。
- scratch：`g7-scratch-20261113` / `b5bc86b8-a355-4041-9f3e-d0c3ca957d3b`（APAC），已删除。
- 认证：token 从保险库文件读入 `CLOUDFLARE_API_TOKEN`，仅用于 wrangler；未打印、未写入本日志。
- 工具：wrangler 4.159.0；远程 `d1 execute --remote --command/--file`，本地 `--local`（Miniflare `db.batch`）。
- 原子性预检：`g7_tx` 重复主键在 `--command` 与 `--file` 下均整批回滚（count=0）。
- A 被动认领：7/7 成功；outbox=`sending`；lane=`tokA`/1090000；outbox_send=`tokA`/1000000，passive_msg_id=`g7-src`，msg_seq=1；used=1。
- A 重放：状态不变（used 仍 1）；可观察 UPSERT：lease 1080000→1090000、claimed_at 999999→1000000。
- B 主动 seq：7/7 成功；msg_seq=1，passive_msg_id=NULL，无 passive_claims 行。
- 故障：第 2 条唯一索引冲突（UNIQUE outbox_send.lock_tok），exit 1；整批回滚：lane=0、outbox=`pending`、outbox_send=0、used=0。
- 对照：A/B 语句结果、A/B 状态、重放、UPSERT、故障状态，远程 vs 本地全部 MATCH。
- 清理：scratch 已删除；`d1 list` 仅剩 2 个生产库；`d1 info` scratch 返回 not found。
- 未碰生产表、未改云服务设置、未 push/部署。

## 环境与准备

- 时间：2026-11-13 12:52–12:55 CST（悉尼 15:52–15:55）
- 仓库（只读）：`/Users/yanghongming/Projects/.worktrees/TeamAgent-event-v2-main`
- HEAD：`44c880f`（`fix: 作者前缀下去掉图注重复的「图片：」`）
- SQL：`src/send/lane.ts`、`src/send/passive.ts`、`src/send/enqueue.ts`；相对 `89673dc` 的 `src/send/` diff 为空。
- SHA-256：lane.ts `de55d604...f1596`，passive.ts `b88ae838...a037`。
- 方案：`/Users/yanghongming/Projects/plan-event-layer-v2.md`「风险与回滚」及 M1-S 第 4 步。
- scratch 库：`g7-scratch-20261113`，UUID `b5bc86b8-a355-4041-9f3e-d0c3ca957d3b`，APAC。
- schema：`schema.sql` 导入远程/本地，各 43 张表（远程 `num_tables=43`，本地 `sqlite_master` count=43）。
- 种子行：outbox `g7-msg`/`g7-msg2`/`g7-fault`（均 pending）；passive_claims `g7-src`/`g7-src3`（used=0）。

## 原子性预检（wrangler 多语句是否整批回滚）

```text
$ wrangler d1 execute g7-scratch-20261113 --remote --config /tmp/g7-wrangler.toml \
    --command "CREATE TABLE g7_tx(x INTEGER PRIMARY KEY);"
exit code: 0

$ wrangler d1 execute ... --command "INSERT INTO g7_tx VALUES(1); INSERT INTO g7_tx VALUES(1);"
exit code: 1
key output: UNIQUE constraint failed: g7_tx.x: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY) [code: 7500]

$ wrangler d1 execute ... --command "SELECT count(*) AS n FROM g7_tx;"
exit code: 0
key output: n=0

$ wrangler d1 execute ... --file /tmp/g7-tx-fault.sql   # 同样两条 INSERT
exit code: 1
key output: UNIQUE constraint failed: g7_tx.x: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)
$ ... SELECT count(*) ... -> n=0
```

结论：`--command` 与 `--file` 都是整批事务；后续用 `--command` 跑 7 条 batch。

## A：被动认领（7 条 batch，远程）

命令（token 仅在环境变量中，不记录值）：

```text
$ CLOUDFLARE_API_TOKEN=*** wrangler d1 execute g7-scratch-20261113 --remote \
    --config /tmp/g7-wrangler.toml --command "$(cat /tmp/g7-batch-a.sql)" --json
exit code: 0
```

7 条语句（按 `src/send/lane.ts::claimStatements` 原顺序，参数 `g7-group/g7-msg/g7-src/tokA/now=1000000`）：

```sql
-- 1 租约 UPSERT
INSERT INTO send_lanes VALUES('g7-group','tokA',1090000)
ON CONFLICT(group_id) DO UPDATE SET holder=excluded.holder,lease_until=excluded.lease_until
WHERE send_lanes.lease_until<1000000 OR send_lanes.holder='tokA';

-- 2 打戳（承担锁条件；prev=NULL）
INSERT INTO outbox_send(id,lock_tok,claimed_at) SELECT 'g7-msg','tokA',1000000
WHERE EXISTS(SELECT 1 FROM send_lanes WHERE group_id='g7-group' AND holder='tokA')
AND EXISTS(SELECT 1 FROM outbox o LEFT JOIN outbox_send s ON s.id=o.id
  WHERE o.id='g7-msg' AND COALESCE(s.not_before,0)<=1000000
  AND (o.status IN ('pending','retry','held')))
AND (NULL IS NULL OR EXISTS(SELECT 1 FROM outbox WHERE id=NULL AND status='sent'))
AND NOT EXISTS(SELECT 1 FROM outbox WHERE group_id='g7-group' AND status='sending' AND id!='g7-msg')
ON CONFLICT(id) DO UPDATE SET lock_tok=excluded.lock_tok,claimed_at=excluded.claimed_at;

-- 3 置 sending（带戳）
UPDATE outbox SET status='sending' WHERE id='g7-msg' AND status IN ('pending','retry','held')
AND EXISTS(SELECT 1 FROM outbox_send WHERE id='g7-msg' AND lock_tok='tokA' AND claimed_at=1000000)
RETURNING id;

-- 4 被动认领 UPSERT
INSERT INTO outbox_send(id,passive_msg_id,msg_seq)
SELECT 'g7-msg',msg_id,used+1 FROM passive_claims
WHERE msg_id=(SELECT msg_id FROM passive_claims
  WHERE group_id='g7-group' AND used<5 AND source_ts>720000 AND (msg_id='g7-src' OR 1=1)
  ORDER BY (msg_id='g7-src') DESC,source_ts DESC LIMIT 1)
AND EXISTS(SELECT 1 FROM outbox_send WHERE id='g7-msg' AND lock_tok='tokA' AND claimed_at=1000000)
ON CONFLICT(id) DO UPDATE SET passive_msg_id=excluded.passive_msg_id,msg_seq=excluded.msg_seq
WHERE outbox_send.msg_seq IS NULL;

-- 5 额度 +1（只在 used+1=msg_seq 时）
UPDATE passive_claims SET used=used+1
WHERE msg_id=(SELECT passive_msg_id FROM outbox_send WHERE id='g7-msg')
AND used+1=(SELECT msg_seq FROM outbox_send WHERE id='g7-msg')
AND EXISTS(SELECT 1 FROM outbox_send WHERE id='g7-msg' AND lock_tok='tokA' AND claimed_at=1000000);

-- 6 主动 seq（activeSeq=NULL，空转）
UPDATE outbox_send SET msg_seq=NULL,passive_msg_id=NULL
WHERE id='g7-msg' AND msg_seq IS NULL AND NULL IS NOT NULL
AND EXISTS(SELECT 1 FROM outbox_send WHERE id='g7-msg' AND lock_tok='tokA' AND claimed_at=1000000);

-- 7 读回认领
SELECT passive_msg_id,msg_seq,tries,reason FROM outbox_send WHERE id='g7-msg'
AND EXISTS(SELECT 1 FROM outbox_send WHERE id='g7-msg' AND lock_tok='tokA' AND claimed_at=1000000);
```

逐条结果（远程 `--json`）：

| # | success | rows |
|---|---|---|
| 1 | true | [] |
| 2 | true | [] |
| 3 | true | `[{"id":"g7-msg"}]` |
| 4 | true | [] |
| 5 | true | [] |
| 6 | true | [] |
| 7 | true | `[{"passive_msg_id":"g7-src","msg_seq":1,"tries":0,"reason":null}]` |

状态查询（远程，exit 0）：

```json
[
  [{"group_id":"g7-group","holder":"tokA","lease_until":1090000}],
  [{"id":"g7-msg","status":"sending"}],
  [{"id":"g7-msg","lock_tok":"tokA","claimed_at":1000000,"passive_msg_id":"g7-src","msg_seq":1,"tries":0,"reason":null,"not_before":0}],
  [{"msg_id":"g7-src","used":1}]
]
```

本地 D1（`--local --persist-to /tmp/g7-local-d1`，Miniflare `db.batch`）同一 SQL：exit 0，7 条 success 与 rows 完全一致；状态与远程逐字段一致（MATCH）。

### A 重放与两种 UPSERT 冲突分支

- 直接重放 A（同一 tok/now）：exit 0；状态不变，`used` 仍 1、`msg_seq` 仍 1。
- 可观察 UPSERT：先把 lane 置 `1080000`、outbox 置 `pending`、outbox_send.claimed_at 置 `999999`，再跑 A；exit 0 后：
  - `send_lanes.lease_until` 1080000 → 1090000（第 1 条 UPSERT 的 DO UPDATE 分支）；
  - `outbox_send.claimed_at` 999999 → 1000000（第 2 条 UPSERT 的 DO UPDATE 分支）；
  - `used` 仍 1（重放不重复占额度）。
- 远程与本地该状态同样 MATCH。

## B：主动 seq（7 条 batch，远程/本地）

同一 7 条 SQL，参数 `g7-group2/g7-msg2/g7-src2/tokB/now=1000000/activeSeq=1`；无 passive_claims 行。

```text
$ wrangler d1 execute ... --remote --command "$(cat /tmp/g7-batch-b.sql)" --json
exit code: 0
```

逐条结果（远程）：

| # | success | rows |
|---|---|---|
| 1 | true | [] |
| 2 | true | [] |
| 3 | true | `[{"id":"g7-msg2"}]` |
| 4 | true | [] |
| 5 | true | [] |
| 6 | true | [] |
| 7 | true | `[{"passive_msg_id":null,"msg_seq":1,"tries":0,"reason":null}]` |

状态（远程，exit 0）：

```json
[
  [{"group_id":"g7-group2","holder":"tokB","lease_until":1090000}],
  [{"id":"g7-msg2","status":"sending"}],
  [{"id":"g7-msg2","lock_tok":"tokB","claimed_at":1000000,"passive_msg_id":null,"msg_seq":1,"tries":0,"reason":null,"not_before":0}]
]
```

本地同一 SQL：exit 0，7 条 success/rows 与状态逐字段一致（MATCH）。

## 故障注入：batch 第 2 条失败

故障方式：在 scratch 建唯一索引 `g7_fault_lock ON outbox_send(lock_tok)`，预置一行 `g7-other` 占用 `tokF`；再原样跑 7 条 batch（`g7-fault/tokF`）。第 2 条 `INSERT ... ON CONFLICT(id)` 因 `lock_tok` 唯一冲突在执行期失败（不是语法错误）。

```text
$ ... --command "CREATE UNIQUE INDEX g7_fault_lock ON outbox_send(lock_tok); INSERT INTO outbox_send(id,lock_tok,claimed_at) VALUES('g7-other','tokF',999999);"
exit code: 0

$ ... --command "$(cat /tmp/g7-batch-fault.sql)" --json
exit code: 1
key output (remote): UNIQUE constraint failed: outbox_send.lock_tok: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE) [code: 7500]
key output (local):  UNIQUE constraint failed: outbox_send.lock_tok: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
```

故障后的状态（远程 / 本地，均 exit 0）：

```json
[
  [{"lanes":0}],
  [{"id":"g7-fault","status":"pending"}],
  [{"sends":0}],
  [{"msg_id":"g7-src3","used":0}]
]
```

结论：第 1 条 lane 写入、第 3 条 outbox 置 sending 都被整批回滚；没有「已锁未记账」的中间态。远程与本地 MATCH。

## 远程 vs 本地对照

| 对照项 | 结果 |
|---|---|
| A 7 条语句 success/rows | MATCH |
| A 状态（lane/outbox/outbox_send/passive） | MATCH |
| A 重放后状态 | MATCH |
| 可观察 UPSERT 后状态 | MATCH |
| B 7 条语句 success/rows | MATCH |
| B 状态 | MATCH |
| 故障注入后状态 | MATCH |

对照方式：同一 SQL 文件分别用 `--remote` 与 `--local --persist-to /tmp/g7-local-d1` 执行，解析 `--json` 的 `results` 逐项比较（忽略 meta/耗时）。

## 清理证据

```text
$ wrangler d1 delete g7-scratch-20261113 -y
exit code: 0
Deleted 'g7-scratch-20261113' successfully.

$ wrangler d1 list --json
exit code: 0
count 2
inkboard-team 42e95fb2-16f8-46d9-bf32-34f3e88a4443
inkboard 41dd19d4-e2f8-4467-87e7-7739d19d138e
scratch_present false

$ wrangler d1 info g7-scratch-20261113 --json
exit code: 1
Couldn't find a D1 DB with name or binding 'g7-scratch-20261113' in your config or the API.
```

- 远程 scratch 库已删除；`d1 list` 只剩原有两个生产库。
- 未对生产库执行任何 SQL；只读过 `d1 list`。
- 本地临时 D1 `/tmp/g7-local-d1` 与 `/tmp/g7-*.sql`、`/tmp/g7-wrangler.toml` 已清理。
- 未修改任何云服务设置，未 push、未部署、未往群里发消息。
