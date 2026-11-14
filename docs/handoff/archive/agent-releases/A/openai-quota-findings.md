# OpenAI「还剩 $3 美元」排查（只读，2026-11-14）

## 结论

群里的原话不是账户余额，而是 **本 bot 自己设的 OpenAI 每日预算闸门**：

> `OpenAI：今天 0 次 / $0，上限 $3.00，剩 $3.00`

模型把它压缩成了「OpenAI 还剩 $3.00」。$3.00 来自代码常量 `OPENAI_DAILY_CAP_MICRO_USD = 3_000_000`（即 $3），减去当天 `openai_usage` 的估算花费（0），**没有调用任何 OpenAI 余额接口**。用户后台看到的是 OpenAI 账户额度，两者不是同一个量；所以后台“有很多”和这条 $3 并不矛盾。

已有修复提交 `c830efa`（分支 `pkg/A3b`，仅本地、未推送、未部署），把文案改成「OpenAI 每日预算（团队自设的闸门，不是账户余额）」并补了「账户余额：查不到」和回归测试。线上仍是旧文案 `e67743f`。

---

## 1. 原句、时间线、触发的代码路径

### 1.1 入站问题

| 项 | 值 |
|---|---|
| 时间 | 2026-11-14 14:36:58 Sydney（D1 `ts = 2026-11-14T11:36:58+08:00`） |
| 发送者 | `0FC1E8A8BD28981E86866125AC3FCEFF`（群主） |
| 原文 | `DeepSeek 还有多少余额` |
| `mentioned` | 1（@ 了 bot） |
| 消息 id | `ROBOT1.0_OyB7TgbASj-VgfcoKvzFbhumJiiqG9cEyn1LXwXhIXStjxMv6qaJAPsotDJYNjvle21FTcFXtShnxcLBIq4rLC5TNlzEFDrc9dUz9F.3zxsNIqrVm3QhC6-bhktADRFg` |

### 1.2 出站两条

| 时间（Sydney） | outbox id | 正文 |
|---|---|---|
| 14:37:19 | `chat-ROBOT1.0_OyB7TgbASj-...` | 余额这块我拿不到实时数，已经挂后台查了，出结果我单独回你这条。视频那个总结也在跑，别急 |
| 14:37:27 | `research-ROBOT1.0_OyB7TgbASj-VgfcoKvzFbhumJiiqG9cEyn1LXwXhIXStjxMv6qaJAPsotDJYNjvle21FTcFXtShnxcLBIq4rLC5TNlzEFDrc9dUz9F.3zxsNIqrVm3QhC6-bhktADRFg` | 查了：DeepSeek ¥94.80，全是充值，赠送 0；今天 1 次、本月 1 次，近 7 天基本没动。**顺带 OpenAI 还剩 $3.00**，生图今天 0/20。 |

用户问的就是 14:37:27 这条。

### 1.3 哪条回复、哪个工具、哪段代码

`jobs` 表中同 id 的研究任务（`research-...`）：

- `kind = research`，`created_at = 14:37:15`，`status = done`，`attempts = 1`，`error = NULL`
- `payload.resume.pending` 是主流程留下的 assistant 消息，`reasoning_content` 里写着：
  > `Souvereign asks about balance, directly @ me. Need to call get_quota.`
- `tool_calls = [{"name":"get_quota","arguments":"{}"}]`

`stage_timings`（同一 turn id）：

```
14:37:13 model_start {"kind":"participation"}
14:37:15 model_end   {"kind":"participation"}
14:37:16 research_queued
14:37:16 model_start {"kind":"voice"}
14:37:19 model_end   {"kind":"voice"}
14:37:19 outbox
14:37:22 model_start {"kind":"research"}
14:37:23 sent
14:37:24 model_end   {"kind":"research"}
14:37:24 model_start {"kind":"voice"}
14:37:26 model_end   {"kind":"voice"}
14:37:27 outbox
14:37:30 sent
```

`activity`：

```
14:37:16.392Z research.queued
14:37:27.270Z research.done
```

即：主流程识别为群主、调用 `get_quota`；线上 e67743f 的 `LOCAL_TOOLS`（`src/semantic.ts:10`）还没有 `get_quota`，所以它被当成非本地工具，代码把带 tool_call 的 assistant 消息放进 `research` 队列（`src/semantic.ts:1034` 生成 `research-` 前缀的 outbox id）；后台任务执行 `get_quota`，用工具结果生成 14:37:27 的最终回复。A3（`3ab5130`）才把 `get_quota` 加进 `LOCAL_TOOLS`，之后同类问题会在主流程本地一步完成。

---

## 2. $3.00 的确切来源

### 2.1 代码链路（线上 e67743f）

1. `src/openai.ts:9`

   ```ts
   export const OPENAI_DAILY_CAP_MICRO_USD = 3_000_000;
   ```

   3,000,000 微美元 = **$3.00**。这是团队自设的每日预算上限，不是 OpenAI 账户余额。

2. `src/quota.ts:454`

   ```ts
   const capMicroUsd = positive(settings["openai:daily_cap_micro_usd"], OPENAI_DAILY_CAP_MICRO_USD);
   ```

   D1 当前没有 `openai:daily_cap_micro_usd` 这个 key，所以取默认值 3,000,000。

3. `src/quota.ts:438-443` 查询当天用量，`src/quota.ts:454-475` 计算上限和剩余

   ```ts
   const openai = await e.DB.prepare(
     "SELECT COUNT(*) AS calls,COALESCE(SUM(est_cost_micro_usd),0) AS spent FROM openai_usage WHERE created_at>=?"
   ).bind(today).first();
   ...
   remainingMicroUsd: Math.max(0, capMicroUsd - spentMicroUsd)
   ```

   当天 `openai_usage` 汇总为 0 行 / 0 微美元，所以 `remaining = 3,000,000 - 0 = 3,000,000`。

4. `src/quota.ts:673-680`（e67743f）拼出的原文：

   ```
   OpenAI：今天 0 次 / $0，上限 $3.00，剩 $3.00
   ```

   （`usdMicro(0)` 返回 `$0`，不是 `$0.00`。）

5. `src/tools/quota.ts` 的 `get_quota` 把这个字符串作为工具结果返回；模型在最终回复里省略了「上限」，写成「OpenAI 还剩 $3.00」。

### 2.2 D1 证据（全部 SELECT，`rows_written = 0`）

`settings` 中的真实快照：

```json
quota:deepseek:balance = {
  "ok": true,
  "at": 1794627440709,
  "available": true,
  "currency": "CNY",
  "total": 94.8,
  "granted": 0,
  "toppedUp": 94.8,
  "totals": [{"currency":"CNY","total":"94.80"}],
  "fromCache": false,
  "fresh": true
}
```

`1794627440709` = 2026-11-14 14:37:20.709 Sydney。

```json
quota:last_snapshot = {
  "at": 1794627440709,
  "deepseek": {"CNY": "94.80"},
  "dsCalls": 1,
  "dsMicroUsd": 0,
  "openaiCalls": 0,
  "openaiMicroUsd": 0,
  "aiUsed": 0,
  "band": "ok"
}
```

`openai_usage` 全表统计：

```
COUNT(*) = 0
SUM(est_cost_micro_usd) = 0
MIN(created_at) = NULL
MAX(created_at) = NULL
```

也就是说，线上从未记录过一次 OpenAI 调用，今天的已用额度必然是 0，`remaining` 必然等于默认上限 $3.00。

相关设置：

```
off:image_gen = "1"
off:openai    = 不存在
openai:daily_cap_micro_usd = 不存在
quota_reservations: 仅 ds:tts:group 1 条，无任何 imagegen* 记录
```

### 2.3 没有任何 OpenAI 余额调用

`src/openai.ts` 只允许 `POST` 到 `https://api.openai.com` 的 `/v1` 路径（`src/openai.ts:297-345`）。代码里没有：

- `/v1/dashboard/billing/credit_grants`
- `/v1/organization/costs`
- 任何 `GET` 余额/账单接口

`grep -rn "credit_grants|dashboard/billing|organization/costs|/v1/billing" src/` 无结果。`OPENAI_API_KEY` 只在真正发起模型/生图请求时使用（`src/openai.ts:306`），额度文案的生成完全不读这个 key。

---

## 3. 为什么和用户后台不一致

**因为比较的是两个不同的量：**

| 用户后台 | bot 这条消息 |
|---|---|
| OpenAI 账户的可用额度 / 账单余额 | 本 bot 自设的「每日 OpenAI 花费上限」减去当天已记录的估算花费 |
| 由 OpenAI 账户和账单决定 | 由代码常量 `3_000_000`（$3）或 D1 设置 `openai:daily_cap_micro_usd` 决定 |
| 与 key 属于哪个组织/项目有关 | **与 key 属于哪个组织/项目无关**，因为这条消息没有请求 OpenAI |
| 可能有很多 | 今天 0 次调用，所以正好剩 $3.00 |

因此：

- 不是「key 属于另一个项目」导致 $3；
- 不是「接口只返回子额度」；
- 不是「预付和赠送口径不同」；
- 不是「缓存过期」；
- 也不是模型凭空编造 $3：工具结果确实是「上限 $3.00，剩 $3.00」，模型只是把「上限/剩」压缩成了「还剩」，造成了余额的歧义。

模型这句「OpenAI 还剩 $3.00」在事实层面对应的是「本 bot 的每日预算还剩 $3.00」，不是「OpenAI 账户还剩 $3.00」。用户按后者理解，所以觉得数字不对。

另外，生产环境从未产生 `openai_usage` 记录，说明这个 bot 至今没有真正花过 OpenAI 的钱；用户后台的余额没有被它扣过。

还有一个措辞问题（P2）：14:37:19 的过渡消息说「余额这块我拿不到实时数」，而真实的余额查询在 14:37:20.7 才完成、14:37:27 给出结果。它是在查询完成前发出的，所以不是数据失败；但「拿不到」容易让人以为查不了，建议改成「额度在查，结果单独回你」。

---

## 4. 其它额度项核对

| 项 | 数字来源 | 判定 | 备注 |
|---|---|---|---|
| DeepSeek 余额 | 真实 `GET https://api.deepseek.com/user/balance`，D1 缓存 10 分钟（`src/quota.ts:15-18, 249-335`） | **正常** | 回复里的 ¥94.80、赠送 0、充值 94.80 与接口返回一致；失败时明确说「暂时查不到」，不猜数字。缓存最多旧 10 分钟，属可接受。 |
| OpenAI | 本地 `openai_usage` 汇总 vs 代码常量/设置上限（`src/quota.ts:454-476`） | **文案有歧义（本次问题）** | 不是账户余额；线上从未调用过 OpenAI。 |
| 生图 | `quota_reservations` 滚动 24 小时的本群/本人计数（`src/quota.ts:444-452`） | **数字本身正常，展示有次要问题** | 是本地限额，不是账户余额；文案写「近 24 小时本群 X/20，你 X/5」，口径清楚。但线上 `off:image_gen=1` 时 e67743f 仍显示「生图 0/20」，会让人以为能生图；A3b 的 `f25e459` 已在关闭时隐藏该行，尚未部署。 |
| Workers AI | 本地 `budget:workers_ai_neurons:utc:<day>` 计数 vs 本地 cap（`src/quota.ts:405-457`） | **本地限额，口径基本清楚** | 文案带「neurons（UTC 日）」，不是账户余额；但同样属于自设闸门，不是 Cloudflare 账户额度。 |
| Cloudflare | 没有查询，固定文案「账户级额度没有公开接口，请看 Cloudflare 后台」 | **正确做法** | 这是 OpenAI 应该采用的模式：查不到就明确说查不到。 |

---

## 5. 修复建议

### 5.1 已有修复（推荐直接采用）

`pkg/A3b` 分支上的 `c830efa`（2026-11-14 15:07:19，作者 oooooomygosh）已经按正确方向修了：

- `src/quota.ts:692`：

  ```
  OpenAI 每日预算（团队自设的闸门，不是账户余额）：今天已用 $0（0 次），预算还剩 $3.00
  ```

- `src/quota.ts:699` 新增：

  ```
  OpenAI 账户余额：查不到（没有公开接口），请看 OpenAI 后台。
  ```

- `src/tools/quota.ts:16` 的工具描述加了：

  > `OpenAI 每日预算（是预算闸门，不是账户余额，不要说成 OpenAI 还剩多少钱）`

- `test/quota.test.mjs:168-171` 断言新文案，并显式禁止 `OpenAI 还剩`；`test/quota.test.mjs:759` 覆盖生图关闭场景。

验证：

```
cd .worktrees/TeamAgent-A3b && node --test test/quota.test.mjs
# 30 tests / 30 pass / 0 fail
```

线上 e67743f 还没有这个提交；`pkg/A3b` 也没有推到 origin（`git branch -r --contains c830efa` 为空）。**修复已写好，但未上线。**

### 5.2 如果 A3b 不马上发

最小热修只需三处：

1. `src/quota.ts` 的 OpenAI 行改成「OpenAI 每日预算（团队自设的闸门，不是账户余额）……预算还剩……」；
2. 增加一行「OpenAI 账户余额：查不到（没有公开接口），请看 OpenAI 后台。」；
3. `src/tools/quota.ts` 描述和 `test/quota.test.mjs` 同步，测试里禁止 `OpenAI 还剩`。

不要只把「上限」改成「预算」而保留「OpenAI：…剩 $3.00」；模型仍可能压缩成「OpenAI 还剩」。

### 5.3 如果以后要显示真实余额

OpenAI 没有面向普通项目 key 的公开余额接口。要拿账户级数据只能用 Admin key 的账单/成本接口，而且成本接口返回的是花费，不是「剩余额度」。所以：

- 没有 Admin key：继续写「查不到，请看 OpenAI 后台」，不要显示任何精确数字；
- 有 Admin key：也只显示「已花费/成本」，不要把成本反推成余额；
- 任何情况下都不要把「本 bot 每日预算」标成「OpenAI 余额」。

### 5.4 建议的回归场景

在 `.agent/scenarios/` 增加一条（只增不减）：

- 输入：真实入站消息「DeepSeek 还有多少余额」（群主，@bot）；
- 期望：回复必须同时包含「OpenAI 每日预算」和「不是账户余额」，且不得包含「OpenAI 还剩」；
- 期望：DeepSeek 余额仍为真实接口值，生图行在 `off:image_gen=1` 时不出现（A3b 行为）。

---

## 6. 验证与限制

### 6.1 已做

- 线上 `/health`：`release = e67743f07163cea9da4d981d94b9d5b8d2662883`，`selfCard.commit` 同值。
- 线上 D1：全部为 `SELECT`，查询结果 `rows_written = 0`；未写任何表、未发任何群消息、未调用付费接口。
- A3（`3ab5130`，`release/A` worktree）的 quota 测试：`node --test test/quota.test.mjs` → 24 tests / 24 pass / 0 fail。
- 线上 e67743f 的文案是由 `git show e67743f:src/quota.ts:672-681` 直接读取确认的（不是用 A3 的测试代跑线上版本）。
- A3b 修复的 quota 测试：30 tests / 30 pass / 0 fail。

### 6.2 未验证 / 限制

- 没有读取 Worker secret `OPENAI_API_KEY` 的值，也没有调用 OpenAI 账户接口；因此无法确认这个 key 属于哪个组织/项目。**但这对本次 $3 的结论没有影响**：该数字不经过 key，也不经过 OpenAI。
- 没有核对用户 OpenAI 后台的实际余额（用户已说明“有很多”，且这属于用户账户数据；本次不需要）。
- `quota:last_snapshot` 未保存 cap 字段；$3 的 cap 是从代码默认值和“无覆盖设置”推出来的。若 14:37 前后曾临时写入 `openai:daily_cap_micro_usd=3000000` 又删除，结论仍然是「本地预算 $3」，不是账户余额。
- `c830efa` 只在本地 `pkg/A3b`，未推送、未部署；线上仍会复现旧文案。

---

## 7. 给 BINI 的 6 行回报

1. **来源**：线上 outbox 14:37:27（`research-...`）回复群主 14:36:58 的「DeepSeek 还有多少余额」，工具是 `get_quota`，由 `research` 后台任务执行。
2. **$3 是什么**：`src/openai.ts:9` 的 `OPENAI_DAILY_CAP_MICRO_USD = 3_000_000`，减去当天 `openai_usage` 的 0，得到 $3.00；不是 OpenAI 账户余额，代码从未调用余额接口。
3. **为什么不符**：用户后台是账户额度，bot 报的是自设每日预算；两者口径不同，与 key 属于哪个组织无关，生产环境 OpenAI 调用记录为 0。
4. **其它项**：DeepSeek 是真实 `/user/balance`；生图/Workers AI 是本地限额且口径基本清楚；生图关闭时线上仍显示额度行是次要问题。
5. **修复**：`pkg/A3b` 的 `c830efa` 已改成「每日预算（不是账户余额）」并加「账户余额查不到」+ 测试，30/30 通过；但未推送、未部署。
6. **建议**：尽快把 `c830efa` 推上去/部署；若不走 A3b，按 5.2 做最小热修，并加「不得出现 OpenAI 还剩」的回归测试。

---

## 附：复现用 SQL（全部只读）

```sql
-- 入站问题
SELECT id, ts, sender, body, mentioned, processed
FROM messages WHERE body LIKE '%还有多少余额%' ORDER BY ts DESC LIMIT 5;

-- 两条出站
SELECT id, status, created_at, body
FROM outbox
WHERE created_at >= 1794627420000 AND created_at <= 1794627480000
ORDER BY created_at;

-- 研究任务和 tool_call
SELECT id, kind, status, attempts, error, payload
FROM jobs
WHERE id = 'research-ROBOT1.0_OyB7TgbASj-VgfcoKvzFbhumJiiqG9cEyn1LXwXhIXStjxMv6qaJAPsotDJYNjvle21FTcFXtShnxcLBIq4rLC5TNlzEFDrc9dUz9F.3zxsNIqrVm3QhC6-bhktADRFg';

-- 额度快照
SELECT key, value FROM settings
WHERE key LIKE 'quota:%' OR key LIKE 'openai:%' OR key LIKE 'imagegen:%';

-- OpenAI 历史用量
SELECT COUNT(*) AS n,
       COALESCE(SUM(est_cost_micro_usd),0) AS spent_usd_micro
FROM openai_usage;

-- 开关和覆盖
SELECT key, value FROM settings
WHERE key IN ('openai:daily_cap_micro_usd','off:openai','off:image_gen');

-- 生图预占
SELECT kind, COUNT(*) AS n FROM quota_reservations GROUP BY kind;
```
