# D 版 · 群里「真能办事」：定时任务、账本/清单、定时执行动作、自建工具、执行入口

> 架构师 · 2026-11-14（周六，谷时）· 基线 origin/main **0a16658**（release/B @8c768b1 + docread）
> 依据：`diagnosis.md`（8 事件成 3 败 5）、`research.md`（成熟项目对照）、`replay-cases.md`（RC-01..13）
> 本文所有「文件:行」都在 origin/main 上核对过（只读 `git archive`）。

---

## 0. 目标

用户原话（11-14 17:15）：「在群里面，让他执行一个东西，或者定时任务，或者新建一个工具，哪怕是让他维护一个账单，他目前都非常的弱」。

做完后，群里一句话就能：

| 编号 | 能力 | 一句话例子 | 必须的效果 |
|---|---|---|---|
| a | 定时任务（泛化时间） | 「每天北京时间0点发DeepSeek余额」「每月1号9点发上月账单」「明天下午3点提醒我交报告」 | 当场落库 + 回执带下次时间（双时区）；**说了「记下了/已建」就一定有行**，没有就老实说失败原因 |
| b | 账本/清单 | 「记账报销额度 我¥360，卡特龙¥50…」「我加10」「总账单」「把卡特龙那笔改成60」「导出账本」 | 一句话建本、增删改查汇总导出；默认群共享；私有可见性有方案 |
| c | 定时执行动作 | 「把账本跟API余额每天北京时间0点发一下，再播报每日token总数」 | 定时任务能跑白名单动作（账本汇总、余额、token、聊天总结、查数后总结），只读、限额、不递归 |
| d | 新建工具 | 「自己建立一个本地记账工具」「以后我说『日结』你就出账本+余额」 | 数据类工具 = 新记录类型；流程类工具 = 保存技能（白名单动作 + 说明）；超出边界的老实登记需求并给单号 |
| e | 执行一个东西 | 「帮我跑一下 xx 然后把结果发群里」 | 受控入口：即时动作当场跑；本机长任务走现有 runner 队列，排队/开始/进行中/完成都有回执 |

**不缩窄**：五项全部有工作包和验收；做不到的部分（真代码工具、任意外部 API）给出 ≥2 条替代路（§9）。

---

## 1. 验收场景（全部进 acceptance.json）

真实数据 = `replay-cases.md` 的 RC-01..13（线上 messages 只读抽取，本地假 D1 回放，**不往群发**）。
D 版新增能力在线上还没有成功样本，用**合成用例**（标 `合成`），原话按真实群聊风格写；以后有真实交办就按 replay-cases §4 追加替换。

| ID | 来源 | 输入（摘要） | 期望（判定以 DB 为准） | 负责包 |
|---|---|---|---|---|
| RC-01 | rid 未列 | 「把今天群里的对话…总结一个日报」 | outbox +1 含要点；schedules +0（回归） | D4 |
| RC-02 | rid 351 | 「悉尼时间每天早上8点…推送昨日聊天内容总结，一定要精简」 | schedules +1：kind=digest_daily，spec.time=08:00，tz=Australia/Sydney，source_msg_id=该消息；回复含「记下了」+首次时间 | D3b, D4 |
| RC-03 | rid 355 | 「你妈的，我的日报呢？」（库里 0 条日程） | 回复不出现「真落地/已经建好/以后每天」除非 active 行存在；应如实说没建并直接补建或给一键补建话术 | D4 |
| RC-04 | rid 382 | 「工作台UI修改指导 @bot 把这个发布到工作台作为一个新任务」 | tasks +1（repo=inbox，status=proposal）；回复带任务号；不出现「已发布」而无行 | D4, D8 |
| RC-05 | rid 394 | 「记账报销额度\n我￥360，卡特龙￥50，Souvereign￥90」 | record_types +1（名「报销额度」）；records +3（TOO 36000 分、卡特龙 5000、Souvereign 9000）；回复合计 ¥500 + 记录号 | D1, D4 |
| RC-06 | rid 396 | 「我加10」（紧接 RC-05） | records +1（TOO +1000 分）；汇总 TOO=370，合计 510 | D1, D4 |
| RC-06b | rid 485/486（测试员抽原文） | Souvereign +200 那条 | records +1（Souvereign +20000 分）；合计 710 | D1, D4 |
| RC-07 | rid 482→484 | 「每天在固定时间发…token和用量的日报」 | 第一轮：schedules +0，pending_actions +1，追问「几点」**只一次**；第二轮给时间（合成「北京时间0点」）→ schedules +1，pending 关闭 | D3b, D4 |
| RC-08 | rid 488 | 「每天北京时间0点在群里发DeepSeek余额即可」 | schedules +1：kind=agent_task，tz=Asia/Shanghai，spec.time=00:00，steps=[quota]；`next_run_at` = 下一个北京 0 点（UTC 16:00）；回复含「北京时间 0 点（悉尼 03:00/02:00 按当日时区）」；不含兜底句 | D2, D3b, D4 |
| RC-09 | rid 493 | 「把账本跟API余额每天在北京时间0点发…自己建立一个本地记账工具…播报每日token总数」 | schedules +1：agent_task，steps ⊇ {records_summary(报销额度), quota, token_usage}；「本地记账工具」= 已存在的记录类型（回复说清账本已在库里、怎么用）**或** feature_requests +1；回复不出现「已立项/在建」而无行 | D1, D3b, D4 |
| RC-10 | rid 496 **冷上下文** | 只注入 496「总账单」，前置 RC-05/06/06b 落库 | 回复含 370 / 50 / 290 / 710，数字来自 records_read | D1, D9 |
| RC-11 | rid 496 带上下文 | 同上 | 同上（回归） | D1 |
| RC-12 | rid 286 | 「你先闭嘴10分钟bot设个定时任务十分钟后再说话」 | schedules +1 kind=mute，run_at≈now+10min（±1min）；回复一句确认 | D2, D4 |
| RC-13 | rid 449 负例 | 「后面直接挂个定时任务，让它2:10自动开干」（在聊他们自己的 bot） | schedules +0、outbox +0（回归） | D4 |
| S-01 | 合成 | 「每月1号早上9点把上个月报销账单发群里」 | agent_task cadence=monthly month_days=[1] time=09:00 tz=Sydney；next_run_at 正确跨月 | D2, D3b |
| S-02 | 合成 | 「明天下午3点提醒我交周报」 | kind=reminder run_at=明天15:00 Sydney；回执含日期 | D2, D3b |
| S-03 | 合成 | 「每周一北京时间9点发上周聊天总结」 | digest_weekly weekdays=[1] time=09:00 tz=Asia/Shanghai | D2, D3b |
| S-04 | 合成 | 「每30分钟提醒我喝水，到晚上10点为止」 | cadence=every every_minutes=30 until=当天22:00；超每日发送上限时如实说并建议 | D2, D3b |
| S-05 | 合成 | 「把卡特龙那笔改成60」 | 回 quote（旧值 50→新值 60，记录号），第二句「确认」后才 UPDATE；record_events 有 update 行 | D1, D4 |
| S-06 | 合成 | 「删掉我刚记的那笔」/「清空报销账本」 | 单条：creator 或管理员可删，软删；清空：需 confirm_token，非管理员拒绝 | D1, D4 |
| S-07 | 合成 | 「导出报销账本」 | 生成 CSV（BOM，≤500 行）；runner 在线 → jobs +1（file 投递）；离线 → ≤50 行文本表格；工作台链接 | D1, D6, D8 |
| S-08 | 合成 | 「建个购物清单：牛奶、鸡蛋」「鸡蛋买了」「清单还剩啥」 | record_types +1（kind=list 模板）；records +2；鸡蛋 status=done；查询只列未完成 | D1, D4 |
| S-09 | 合成 | 「以后我说『日结』你就发账本汇总和DeepSeek余额」→「日结」 | skills +1（status=active，steps 只读）；第二句触发 skill_run，回复含账本合计和余额 | D5, D4 |
| S-10 | 合成 | 「建个工具每天自动去某网站抓价格」 | 超出白名单 → 不建技能；feature_requests +1 并回「做不了的部分 + 单号」 | D5, D4 |
| S-11 | 合成 | 「现在把账本和余额发一下」 | 即时 run_steps，无入队；数字与 records_read/get_quota 一致 | D3a, D4 |
| S-12 | 合成（管理员） | 「@bot 帮我跑一下：统计 runner/ 目录下 py 文件行数，发群里」 | jobs +1（kind=media，payload.mode=exec）；回执「已排队 #id」；claim 时 outbox `job-start:<id>`；完成走现有结果投递 | D6 |
| S-13 | 合成（普通成员） | 同 S-12 | 拒绝（只说权限原因 + 可用的即时动作），jobs +0 | D6 |
| S-14 | 合成 | 模型回复写了「记下了，每天8点发」但本轮没有成功的 schedule_create | 守卫：能用解析器补建就补建（schedules +1）；补不了就把这句换成「没登记上：<原因>」，且与上一条 bot 回复不重复同一句 | D4 |
| S-15 | 合成 | agent_task 被注入（spec.note 含「删除所有记录」） | 运行时只能调只读动作；records 不变；run 记 error_kind=denied | D3b |
| S-16 | 合成 | 非创建者、非管理员「取消TOO的日报」 | 拒绝并说明；schedules 不变 | D3b |
| S-17 | 合成 | agent_task 连续失败 9 次 | status=paused，群里一次通知；schedule_list 显示已暂停 | D3b |
| S-18 | 合成 | 「记一笔私账：我午饭35，只有我能看」 | records.visibility=private；他人查询/汇总不含；本人在群里查只显示条数+提示去工作台看 | D1, D8 |

---

## 2. 现状与根因（main 0a16658）

| # | 根因 | 位置 |
|---|---|---|
| R1 | 时间解析只认「每天/每周X + 紧跟钟点 + 发/推」，「北京时间」「0点」「固定时间」「每月」「明天」全失败 → 守卫掉兜底句 | `src/schedules.ts:164-215` parseScheduleRequest；`:108-113` parseTime 仅 HH:MM；`src/reply-finalize.ts:8` GUARD_FALLBACK、`:140-224` promiseGuard |
| R1b | schedule_create 工具描述写死「时间按悉尼时间 HH:MM」，无 tz 参数、kind 只有 4 种，模型无法表达「北京 0 点发余额」，于是不调用 | `src/semantic.ts:974-997` |
| R2 | 日程只能发「聊天总结/提醒/闭嘴」，digestText 只读 messages；余额推送只有运维 `/api/admin/daily-push`（owner-only） | `src/schedules.ts:314-323,378-398,751-753`；`src/worker.ts:2474` |
| R3 | 全库没有账本/清单结构；「记好了」纯口头 | schema 无表；`outbox rid 223/225` |
| R4 | 「新建工具」只有 request_feature（只立项）；模型说「已立项/在建」却 0 行 | `src/semantic.ts:879`；`outbox rid 304` |
| R5 | 执行类只能走 create_file_task（要求「生成文件」话术）/ prepare_project_task（repo 必填 6 选 1）；runner 开始执行没有回执 | `src/semantic.ts:847,896-931,1277-1381`；`src/worker.ts:1795-1812` claim 无通知 |
| R6 | 回执守卫只管日程一种承诺，不管「记好了/已立项/已发布」 | `src/reply-finalize.ts:140-224` |
| R7 | cancelSchedule 无归属检查；failSchedule 每 3 次通知但永不暂停 | `src/schedules.ts` cancelSchedule、failSchedule |
| R8 | 只有 calc/mcp_* 写 tool_calls 审计，新写工具无痕 | `src/toolkit.ts:59-67` |

迁移现状（已核对）：origin/main 与本仓所有分支 `migrations/` 最高 **0080_learning.sql**；`scripts/migrate.mjs:32` 硬编码清单，**每次部署全部重跑**（所以迁移必须幂等，改 CHECK 必须用 JS ensure 函数）。

---

## 3. 方案总览

一句话：**「记录」做数据底座，「动作」做执行底座，日程/技能/即时执行都只是「什么时候、按什么配方」调同一套白名单动作；所有写入走工具当场落库，所有承诺走回执守卫对账。**

```
群消息 ──► semantic 工具循环 ──► records_write / records_read           (b, d-数据类)
                         ├─► schedule_create(v2: cadence/tz/steps)     (a, c)
                         ├─► skill_save / skill_run                    (d-流程类)
                         ├─► run_steps（即时）/ run_task（本机长任务）   (e)
                         └─► finalizeSpoken ─► receipt-guard 对账       (a 假回执)
cron 每分钟 ─► runSchedules ─► kind=agent_task ─► actions.runSteps(只读) ─► 可选 1 次模型成文 ─► outbox
```

借鉴（写明来源，按 research.md 已核对的部分）：
- 记录模型：Open WebUI / NocoDB 的「类型定义 JSON schema + 行 JSON + 生成列索引」；Coze 的「数据库插件」只读/读写分离；去重键 = `turn_id:tool_call_id`（LangBot 的工具调用幂等做法）。
- 技能：AstrBot 的「指令 → 预设流程」与 Coze 工作流的「节点白名单」思路；只保存配方，不保存代码。
- 时间解析：路线 A 自写中文规则表（下节）；路线 B 借 chrono-node（MIT，`chrono.zh` 解析器）做后备，仅在 A 的 100 例表测试失败率 >5% 时启用（包体 ~200KB，Worker 可承受但不首选）。
- 不做（research.md §8 已否决）：每用户物理表、模型生成代码执行、自定义 SQL、把账本塞进 facts。

---

## 4. 建议补充（用户没说但不做会失望，已纳入工作包）

1. **双时区回执**：凡 tz≠悉尼，回执同时写「北京时间 0 点（悉尼 03:00）」；悉尼换季（4 月/10 月）自动跟着变，北京 0 点永远是北京 0 点（存 tz=Asia/Shanghai，而不是存死悉尼 03:00）。→ D3b
2. **改日程**：「把日报改到9点」不必先取消再建 → `schedule_update`。→ D3b
3. **待补全记忆**：缺时间问一次，30 分钟内给了时间就直接建（RC-07）。→ D3b/D4
4. **记账改错有回悔**：改/删都留 record_events，「撤销上一笔」可用。→ D1
5. **「我」自动换成说话人名字**；人名按群昵称归一（TOO / t.o.o. 同一人）。→ D1
6. **失败暂停**：连续失败 9 次自动暂停并告知，不再每天刷屏。→ D3b
7. **工作台能看账本/技能/日程**（只读页 + CSV 下载），群里不方便看长表。→ D8（需设计师 ui-spec）
8. **schedule_list 显示每个日程最近一次是否发出**（schedule_runs 状态），对付「我的日报呢」。→ D3b
9. **审计**：所有新写工具写 tool_calls。→ D1/D5/D6 各自调用统一审计函数（D0 导出）。

---

## 5. 接口与数据结构（冻结；各包按此并行，改动须经架构师）

### 5.1 迁移 `migrations/0090_records.sql`（新文件，全部 IF NOT EXISTS，幂等）

```sql
-- D 版：记录类型 / 记录 / 审计 / 技能 / 待补全
CREATE TABLE IF NOT EXISTS record_types(
  id TEXT PRIMARY KEY,                 -- 'rt-' + 8位随机
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,                  -- 「报销额度」「购物清单」
  kind TEXT NOT NULL DEFAULT 'ledger' CHECK(kind IN ('ledger','list','log')),
  schema TEXT NOT NULL DEFAULT '{}',   -- NormalizedSchema JSON（§5.3）
  visibility_default TEXT NOT NULL DEFAULT 'group' CHECK(visibility_default IN ('group','private')),
  owner TEXT NOT NULL,                 -- 建本人 sender
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
CREATE TABLE IF NOT EXISTS records(
  id TEXT PRIMARY KEY,                 -- 'r-' + 8位随机；对外显示「#」+ 后 6 位
  type_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  creator TEXT NOT NULL,               -- sender
  visibility TEXT NOT NULL DEFAULT 'group' CHECK(visibility IN ('group','private')),
  data TEXT NOT NULL,                  -- 归一后的 JSON
  person TEXT GENERATED ALWAYS AS (json_extract(data,'$.person')) STORED,
  title TEXT GENERATED ALWAYS AS (json_extract(data,'$.title')) STORED,
  amount_cents INTEGER GENERATED ALWAYS AS (json_extract(data,'$.amount_cents')) STORED,
  occurred_at INTEGER GENERATED ALWAYS AS (json_extract(data,'$.occurred_at')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  dedup_key TEXT UNIQUE,               -- turn_id + ':' + tool_call_id（+ ':' + 行序号）
  source_msg_id TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_type ON records(type_id,deleted_at,occurred_at);
CREATE INDEX IF NOT EXISTS records_person ON records(type_id,person);
CREATE INDEX IF NOT EXISTS records_group ON records(group_id,created_at);
CREATE TABLE IF NOT EXISTS record_events(
  id TEXT PRIMARY KEY, record_id TEXT, type_id TEXT NOT NULL, group_id TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('define','add','update','delete','restore','export')),
  before TEXT, after TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS record_events_rec ON record_events(record_id,created_at);
CREATE INDEX IF NOT EXISTS record_events_group ON record_events(group_id,created_at);
CREATE TABLE IF NOT EXISTS skills(
  id TEXT PRIMARY KEY,                 -- 'sk-' + 8位随机
  group_id TEXT NOT NULL, name TEXT NOT NULL,      -- 触发名「日结」
  triggers TEXT NOT NULL DEFAULT '[]',             -- 额外触发词 JSON 数组，≤5，每个 ≤12 字
  steps TEXT NOT NULL,                              -- Step[] JSON（§5.4）
  note TEXT NOT NULL DEFAULT '',                    -- 成文说明，≤600 字
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('proposed','active','disabled')),
  uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
  source_msg_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
CREATE TABLE IF NOT EXISTS pending_actions(
  id TEXT PRIMARY KEY,                 -- 'pa-' + source_msg_id
  group_id TEXT NOT NULL, sender TEXT NOT NULL,
  tool TEXT NOT NULL,                  -- 'schedule_create' | 'records_write'
  draft TEXT NOT NULL,                 -- 已有参数 JSON
  missing TEXT NOT NULL,               -- 'time' | 'confirm' | ...
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','expired')),
  asked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pending_actions_open ON pending_actions(group_id,sender,status,expires_at);
```

> D1 生成列（STORED）在 SQLite ≥3.31 支持；D1 当前 SQLite 3.4x。**未在线上 D1 实测**——D0 必须先在 `wrangler d1 execute --local` 跑通；若线上不支持，备选：去掉生成列，records 加普通列 person/title/amount_cents/occurred_at/status，由 `normalizeData` 写入时同步填（接口不变，只改 DDL 和 INSERT）。

### 5.2 日程表重建（`scripts/migrate-schedules.mjs` 新文件，导出 `ensureSchedulesV2(execute)`）

- 判定：`SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'`；sql 含 `'agent_task'` 则什么都不做（幂等）。
- 否则**一次 execute 调用**提交以下语句（同一批次，D1 按批次原子执行；未线上实测，见 §10 风险）：

```sql
CREATE TABLE schedules_v2(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('digest_daily','digest_weekly','reminder','mute','agent_task')),
  tz TEXT NOT NULL DEFAULT 'Australia/Sydney', spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled','paused')),
  next_run_at INTEGER, last_run_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
INSERT INTO schedules_v2(id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at)
  SELECT id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_v2 RENAME TO schedules;
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);
CREATE INDEX IF NOT EXISTS schedules_group ON schedules(group_id,status);
```

- `scripts/migrate.mjs`：清单末尾加 `"migrations/0090_records.sql"`；**循环结束后**调用 `ensureSchedulesV2(execute)`（不能放在 schema.sql 之后，因 0009 也会 CREATE IF NOT EXISTS 旧表——放最后最稳）。
- `schema.sql` 里 `CREATE TABLE IF NOT EXISTS schedules` 的两处 CHECK 改成新值（新库/测试库直接是新表）。`migrations/0009_f6_schedules.sql` **不改**（历史文件，重跑时 IF NOT EXISTS 不生效）。
- 测试假 D1（`test/learning-accept.mjs` browserDb 等）若从 schema.sql 建库则自动是新 CHECK；`test/` 下自建 schedules 表的夹具由 D0 一并更新（`rg -n "CREATE TABLE.*schedules" test/`）。

### 5.3 记录层 `src/records.ts`（D1 包实现；签名冻结）

```ts
export type FieldType = "text" | "money" | "number" | "date" | "person" | "enum" | "bool";
export interface FieldDef { key: string; label: string; type: FieldType; required?: boolean; options?: string[] }
export interface NormalizedSchema { fields: FieldDef[]; summary?: { group_by?: string; sum?: "amount_cents" } }
// 模板：kind=ledger → fields [person(person,required), amount(money,required), title(text), occurred_at(date)]；summary {group_by:"person", sum:"amount_cents"}
//       kind=list   → fields [title(text,required), status(enum:["todo","done"], default todo), person(person)]
//       kind=log    → fields [title(text,required), occurred_at(date), amount(number)]
export const LIMITS = { typesPerGroup: 20, fieldsPerType: 12, recordsPerGroup: 20000, pageRows: 200, exportRows: 500, exportBytes: 65536, bodyChars: 4000 };

export interface Actor { sender: string; name: string; isAdmin: boolean }
export interface WriteCtx { e: any; groupId: string; actor: Actor; sourceMsgId: string; dedupBase: string /* turn_id:tool_call_id */; now: number; names: Map<string,string> /* sender→群昵称 */ }

export function normalizeSchema(kind: "ledger"|"list"|"log", extra?: FieldDef[]): NormalizedSchema;
/** 金额：「￥360」「360元」「三百六」「-10」「加10」→ amount_cents；「我/本人/自己」→ actor.name；人名按 names 与已有 person 值做大小写/标点无关匹配（t.o.o. == TOO）。失败抛 RecordError('invalid', 中文原因)。 */
export function normalizeData(schema: NormalizedSchema, raw: Record<string, unknown>, ctx: WriteCtx): Record<string, unknown>;
export async function findType(e: any, groupId: string, nameOrId: string): Promise<RecordTypeRow | null>; // 名称模糊：完全相等 > 去空格相等 > 唯一包含
export async function defineRecordType(ctx: WriteCtx, a: { name: string; kind: "ledger"|"list"|"log"; extra_fields?: FieldDef[]; visibility_default?: "group"|"private" }): Promise<{ type: RecordTypeRow; created: boolean }>;
export async function addRecords(ctx: WriteCtx, typeId: string, rows: Record<string, unknown>[], visibility?: "group"|"private"): Promise<{ ids: string[]; duplicated: number }>; // INSERT OR IGNORE … RETURNING id；≤50 行/次；同批写 record_events
export async function queryRecords(e: any, q: { groupId: string; typeId: string; viewer: Actor; filter?: { person?: string; status?: string; from?: number; to?: number; text?: string }; limit?: number; cursor?: string }): Promise<{ rows: PublicRecord[]; next?: string; hiddenPrivate: number }>;
export async function summarizeRecords(e: any, q: { groupId: string; typeId: string; viewer: Actor; group_by?: string; from?: number; to?: number }): Promise<{ groups: { key: string; sum_cents: number; count: number }[]; total_cents: number; count: number; hiddenPrivate: number }>;
export async function quoteChange(ctx: WriteCtx, a: { record_id?: string; match?: { person?: string; title?: string }; typeId: string; op: "update"|"delete"; patch?: Record<string, unknown> }): Promise<{ token: string; before: PublicRecord; after?: PublicRecord; expires_at: number }>; // token 存 pending_actions(missing='confirm')，10 分钟
export async function applyChange(ctx: WriteCtx, token: string): Promise<{ record: PublicRecord; op: "update"|"delete" }>; // 只允许 creator 或 isAdmin；写 record_events
export async function undoLast(ctx: WriteCtx, typeId: string): Promise<{ undone: PublicRecord; op: string } | null>; // 只撤 actor 自己 10 分钟内最后一次 add/update/delete
export async function exportCsv(e: any, q: { groupId: string; typeId: string; viewer: Actor }): Promise<{ filename: string; csv: string; rows: number; truncated: boolean }>; // UTF-8 BOM；≤500 行 ≤64KB
export class RecordError extends Error { constructor(public kind: "invalid"|"denied"|"quota"|"not_found"|"ambiguous", msg: string) }
export interface PublicRecord { id: string; short: string /* #后6位 */; person?: string; title?: string; amount?: string /* ¥370.00 */; status?: string; occurred_at?: string; creator_name: string; visibility: "group"|"private" }
```

可见性规则（冻结）：`visibility='private'` 的行只有 creator 能在 query/summarize/export 里看到；他人结果里计入 `hiddenPrivate` 计数不显示内容。**在群里**，本人查询私有行也只回「你有 N 条私有记录，在工作台查看」（群消息人人可见）——工作台（D8，登录后）显示明细。

### 5.4 动作层 `src/actions.ts`（D3a 实现；所有「执行」的唯一入口）

```ts
export type Step =
  | { action: "records_summary"; type: string; group_by?: string; period?: "all"|"today"|"yesterday"|"this_month"|"last_month" }
  | { action: "records_query"; type: string; filter?: { person?: string; status?: string; text?: string }; limit?: number /* ≤20 */ }
  | { action: "quota" }                                            // renderQuota(e,{group,sender:viewer.sender,now})（src/quota.ts:724），ok 取 .text，否则 reason_text
  | { action: "token_usage"; period?: "today"|"yesterday" }        // model_usage（schema.sql:54）按 schedule tz 的自然日求 SUM(input_tokens+output_tokens), SUM(n)
  | { action: "chat_digest"; days?: 1|7; topic?: string }          // 复用 schedules.digestText（src/schedules.ts:580，现未导出；D0 只加 export 关键字）
  | { action: "work_status" }                                      // tasks + jobs 最近 5 条（同 semantic get_work_status 的 SQL）
  | { action: "text"; text: string };                              // 固定文字，≤300 字
export const READ_ONLY_ACTIONS = new Set(["records_summary","records_query","quota","token_usage","chat_digest","work_status","text"]);
export interface StepResult { action: string; ok: boolean; text: string /* 已成文的一段，≤800 字 */; data?: unknown; error_kind?: string }
export interface RunCtx { e: any; groupId: string; viewer: Actor; tz: string; now: number; purpose: "chat"|"schedule"|"skill" }
export function validateSteps(steps: unknown): { ok: true; steps: Step[] } | { ok: false; reason: string }; // ≤6 步；未知 action / 非只读 → 拒绝
export async function runSteps(ctx: RunCtx, steps: Step[]): Promise<StepResult[]>;          // 顺序执行；单步失败不影响后续
export function joinResults(results: StepResult[], title?: string): string;                // 无 note 时的确定性成文：标题 + 每段一块，≤1800 字
export async function composeWithNote(ctx: RunCtx, results: StepResult[], note: string): Promise<string>; // 1 次 DeepSeek 调用，无工具，max_tokens 1200；结果当资料包（UNTRUSTED_MARK 包裹），失败回退 joinResults
```

`viewer` 在定时任务里 = 日程 owner（所以 owner 的私有记录也不会被发到群里：summary 在群发场景强制 `viewer.isAdmin=false` 且 private 行一律排除）。

### 5.5 日程 v2（D3b 实现，`src/schedules.ts` 扩展；`src/schedule-parse.ts` 由 D2 实现）

```ts
export type ScheduleKind = "digest_daily"|"digest_weekly"|"reminder"|"mute"|"agent_task";
export interface ScheduleSpec {   // 旧字段全保留
  time?: string; weekdays?: number[]; run_at?: number; text?: string; minutes?: number; topic?: string; dedup?: string; origin?: string; request_quote?: string;
  cadence?: "daily"|"weekly"|"monthly"|"once"|"every";   // 新；旧行缺省时按 kind 推断
  month_days?: number[];          // 1..31，-1 = 月末
  every_minutes?: number;         // 5..1440
  window?: [string, string];      // every 的时段 "HH:MM"
  until?: number;                 // 截止 ms
  steps?: Step[];                 // agent_task 必填
  note?: string;                  // agent_task 可选成文说明 ≤600 字
  title?: string;                 // 回执和推送标题「每日账本+余额」
}
// tz 存在 schedules.tz 列（已有列）：北京时间 → 'Asia/Shanghai'；不说默认 'Australia/Sydney'。

// src/schedule-parse.ts（纯函数，无 IO）
export type When =
  | { cadence: "daily"; time: string; tz: string }
  | { cadence: "weekly"; time: string; weekdays: number[]; tz: string }
  | { cadence: "monthly"; time: string; month_days: number[]; tz: string }
  | { cadence: "once"; run_at: number; tz: string }
  | { cadence: "every"; every_minutes: number; window?: [string,string]; until?: number; tz: string };
export type ParseResult = { ok: true; when: When; tzSaid: boolean; matched: string } | { ok: false; missing: "time"|"date"; cadence?: string } | null;
export function parseWhen(text: string, now: number, defaultTz?: string): ParseResult;
export function parseContent(text: string): Step[];   // 关键词→步骤：账本/账单/记账/报销 → records_summary(type=最近提到的账本名或「账本」)；余额/额度 → quota；token/用量/消耗 → token_usage；聊天/日报/总结/昨日 → chat_digest；兜底 text
export function describeWhen(when: When, now: number): string; // 「每天 北京时间 00:00（悉尼 03:00）」「每月1日 09:00」
```

解析规则表（D2 必须全部实现并在 `test/schedule-parse.test.mjs` 每条至少 1 例，共 ≥100 例）：
- 时区词：北京时间/北京/国内时间/中国时间 → Asia/Shanghai；悉尼时间/悉尼/澳洲时间 → Australia/Sydney；UTC/格林威治 → UTC。时区词可出现在节奏词前或后（「每天北京时间0点」「北京时间每天0点」）。
- 节奏词：每天/每日/天天/每晚/每早 → daily；每周X/每个周X/每星期X/周一到周五/工作日/周末 → weekly；每月N号/每月N日/每个月N号/月初(=1)/月底/月末(=-1) → monthly；每N分钟/每N小时/每隔半小时 → every；今天/明天/后天/大后天/下周X/N号/N月N日/N分钟后/N小时后/半小时后/一会儿(拒绝,当作缺时间) → once。
- 钟点：阿拉伯与中文数字（零〇一二两三…十二、廿）；「X点/X时/X:YY/X：YY/X点半/X点一刻/X点三刻/X点Y分/整」；时段词修正：凌晨/半夜(0-5)、早上/上午/早(≤12 原样)、中午(12/1→13)、下午/傍晚/晚上/今晚(1-11 → +12)；「0点/零点/午夜/半夜12点」→ 00:00；「中午12点」→12:00。
- 中间允许插入：在/于/的/群里/给我/固定/准时/按时/左右/前后、标点空格。
- 「固定时间/某个时间/定时/找个时间」而无钟点 → `{ok:false, missing:"time"}`。
- 明确拒绝：只出现「2:10」而无节奏词且无「提醒我/发/推」类动词（RC-13 场景由意图层判断，parser 只负责「能不能解析」，不负责「该不该建」）。

`nextRun(spec, now, tz)` 改造：daily/weekly 保持；monthly 逐月找（最多 13 个月，-1=当月最后一天；2/30 这种跳过当月）；every：下一个 now+every 对齐 window 与 until；once：run_at。DST：一律通过 `zonedToUtc(y,m,d,h,mi,tz)`（`src/schedules.ts:83`）求值。

工具（D3b 在 `src/tools/schedule-tools.ts` 实现成 BotTool；D4 负责把 semantic.ts 里的旧定义/旧 case 删掉换成它们）：

```ts
schedule_create { kind?: ScheduleKind; when_text?: string /* 用户原话里讲时间的那段 */; cadence?; time?; tz?: "Asia/Shanghai"|"Australia/Sydney"|"UTC"; weekdays?; month_days?; run_at?: string; minutes?; every_minutes?; until?: string;
                  steps?: Step[]; content_text?: string /* 用户说要发什么 */; title?; note?; topic?; text?; pending_id?: string; source_id?: string }
  → 成功 { ok:true, accepted:true, family:"schedule", id, kind, tz, next_run_at, next_run_text /*双时区*/, say }
  → 缺时间 { ok:false, need:"time", pending_id, say:"几点发？（默认悉尼时间，也可以说北京时间）" }   // 同时写 pending_actions
  → 其他失败 { ok:false, error_kind, reason_text, say }
  规则：when_text/原话经 parseWhen 得到的结果 **优先于** 模型填的 time/tz（不一致时用解析结果并记 onViolation）；
        content_text/原话经 parseContent 得 steps，模型 steps 与之合并去重；有 steps 且非纯聊天总结 → kind=agent_task。
schedule_update { id?: string; topic?: string; 同 create 的时间/内容字段 } → 只允许 owner 或管理员；重算 next_run_at；返回同 create。
schedule_list { include_done? } → 每行含 id、title、双时区下次时间、最近一次 schedule_runs.status（sent/failed/none）、fail_count、status。
schedule_cancel { id?; topic? } → **新增**：owner 或管理员才可取消（mute 例外：任何人可取消自己的闭嘴）。
schedule_pause / resume 不单独做工具：用 schedule_update { status:"paused"|"active" }。
```

`runSchedules`（`src/schedules.ts`）对 agent_task：`validateSteps` → `runSteps(purpose:"schedule")` → 有 note 则 `composeWithNote`（**每 tick 最多 2 个需要模型的任务**，其余顺延到下一分钟，仍在 MAX_MISSED_AGE 15 分钟内）→ outbox（id 仍用 `outboxIdFor`）。失败 `fail_count+1`；`fail_count>=9` → status=paused + 一条通知 outbox `sched-paused:<id>`。每群每天 agent_task 运行 ≤24 次（计 schedule_runs）。`max_active_per_group` 5→**10**（config/team.json）。

### 5.6 回执守卫 `src/receipt-guard.ts`（D4 实现）

```ts
export type Family = "schedule"|"record"|"feature"|"task"|"skill"|"job";
export interface Accepted { tool: string; family: Family; id?: string; ok: boolean; reason?: string }
export const CLAIMS: { family: Family; re: RegExp }[] = [
  { family: "schedule", re: /记下了|(已|已经)(设|建|定|登记)(好|上)?了?|设好了|定好了|真落地|以后每(天|周|月)|每(天|周|月).{0,10}(会|都会|准时)(发|推|提醒)/ },
  { family: "record",   re: /记(好|上|下)了|已(记|入)(账|上|录)|账(已|记)(更新|改好)|删(掉|好)了/ },
  { family: "feature",  re: /已立项|在建|已(登记|记录)(需求|下需求)|排进(计划|开发)/ },
  { family: "task",     re: /已(发布|建|创建)(到工作台|任务)|任务(建好|已建)/ },
  { family: "skill",    re: /(工具|技能|指令).{0,6}(建好|做好|已建|已保存|上线)/ },
  { family: "job",      re: /(已经?|开始)(执行|跑)|在跑了|已排队/ },
];
export interface GuardInput { text: string; accepted: Accepted[]; failures: Accepted[]; lastBotText?: string;
  autoLand?: (family: Family) => Promise<Accepted | null> /* 仅 schedule：用 parseWhen/parseContent 对 userText 补建 */;
  existing?: (family: Family) => Promise<boolean> /* 状态类追问时（「已经建好」）查库：本群是否已有对应 active 行 */ }
export async function guardReceipts(g: GuardInput): Promise<{ text: string; violations: { family: Family; sentence: string; fixed: "landed"|"replaced"|"kept" }[] }>;
```

规则（冻结）：逐句扫描；一句命中多个 family（如「记下了」同时像 schedule 和 record）时，任一 family 满足即保留；命中 family F 的承诺句 → ① 本轮有 F 的成功 accepted → 保留；② 否则 `existing(F)` 为真且句子是陈述既有事实 → 保留；③ 否则 F=schedule 时尝试 `autoLand`，成功则保留并在句尾补「（#id，下次 …）」；④ 否则替换为 `honest(F, failures)`：有失败原因说原因（「没登记上：时间没说清，你说几点我马上建」/「没记上：<reason_text>」），没调用就说「这次没登记上」；若与 `lastBotText` 中的同类句完全相同，改用第二套措辞并附可直接复制的一句话指令（例：「直接回我『每天北京时间0点发余额』就行」）。
`finalizeSpoken`（`src/reply-finalize.ts`）里原 ② promiseGuard 改为调用 guardReceipts；GUARD_FALLBACK 保留为 honest(schedule) 的第一套措辞之一。`acceptedActions` 从字符串数组升级为 `Accepted[]`（semantic.ts 内部，D4 独占）。

### 5.7 技能 `src/skills.ts` + `src/tools/skills.ts`（D5 实现）

```ts
skill_save { name: string /* ≤12字 */; triggers?: string[]; steps: Step[]; note?: string; request_quote: string; source_id?: string }
  → validateSteps 不过 → { ok:false, error_kind:"unsupported", unsupported: string[], say: "这部分我做不了：…；要我登记成需求吗" }（模型随后可调 request_feature）
  → 成功 { ok:true, accepted:true, family:"skill", id, status, say: "建好了：以后说「<name>」我就 <步骤摘要>" }
skill_run { name: string; args?: { type?: string; period?: string } } → runSteps(purpose:"skill") → { ok:true, text } ；uses+1
skill_list {} ; skill_disable { name } （owner 或管理员）
```
- 只存配方（Step[] + note），**不存代码、不存 URL、不存提示词以外的东西**；steps 只能是 READ_ONLY_ACTIONS。
- 状态：创建人发起 → 只读步骤直接 active；每群 ≤20 个；同名覆盖需 owner 或管理员。
- 触发：semantic 每轮把本群 active 技能「名字+触发词」放进 system 一行（≤30 个，≤400 字）；消息完全等于/以技能名开头时模型应调 skill_run（few-shot）。
- 「建立一个本地记账工具」（RC-09）= `records_write.define_type`（数据类工具）；已存在同名账本 → 回复「账本已经在库里（#类型号），记账直接说『记账 xx 我加10』，查账说『总账单』」，不登记需求。

### 5.8 执行入口（D6 实现）

1. **即时动作** `run_steps { steps: Step[] }`（BotTool，untrusted:false，任何成员）：validateSteps → runSteps(purpose:"chat") → 文本。S-11。
2. **本机长任务** `run_task { title; instructions; request_quote; source_id? }`（BotTool，写工具）：
   - 权限：`isAutoSender(e, sender)`（`src/feature-request-core.ts:162`，= config auto_senders ∪ members.role='owner'）为真；`source.meta.direct===true`；本轮未被污染（`ctx.isTainted()` 为假）；`request_quote` 在原话里（`quoteIn`）。任一不满足 → `{ok:false,error_kind:"denied",say:"本机执行只有管理员能派；你可以让我现在出账本/余额/总结这类即时结果"}`。
   - 入队：复用 create_file_task 的 jobs 结构（`src/semantic.ts:1318-1381`），`id='exec-'+source.id`，`kind='media'`，payload 加 `mode:"exec"`、`want_files:false`、`effort:"high"`、`lane:"quick"`；INSERT OR IGNORE。
   - 回执：立即 `{ok:true,accepted:true,family:"job",id,say:"已排队 #<id后6位>，开始和结束我都会在群里说"}`。
   - 开始回执：`src/worker.ts:1795` media claim 成功且 `payload.mode==='exec'` → `INSERT OR IGNORE INTO outbox(id='job-start:'||id, …,'开始执行 #xxxxxx：<title>')`。
   - 进行中：cron（`src/worker.ts` 每分钟段）对 `mode='exec' AND status='running'` 且开始 >5 分钟、>15 分钟各发一次「还在跑，已 N 分钟」（outbox id `job-progress:<id>:5` / `:15`，INSERT OR IGNORE 天然去重）。
   - 排队过久：pending >10 分钟 → 一次「执行端不在线，任务还在排队 #xxxxxx」（`job-stale:<id>`）。
   - 完成/失败：沿用现有 `utility-notice` / media-result 路径（`src/worker.ts:1880-1895`），不改。
3. **导出投递**（给 S-07）：`records_read export` 得到 CSV 后：runner 心跳 10 分钟内在线 → 入队 `id='export-'+source.id`，payload `{mode:"file", file:{name, content_b64}, message:source.id, want_files:true, effort:"high", lane:"quick"}`；`runner/utility.py` 在调用模型前判断 `p.get("mode")=="file"`：写文件到工作目录后直接走现有交付，**不调模型**。runner 不在线 → 回 ≤50 行文本表 + 工作台下载链接（D8）。

### 5.9 记录工具 `src/tools/records.ts`（D1 实现）

```ts
records_read { op: "types"|"query"|"summarize"|"export"; type?: string; filter?: {...}; group_by?: string; period?: string; cursor?: string }
  untrusted: true  // 记录内容是成员写的，回到模型时按资料包包裹
records_write { op: "define_type"|"add"|"quote_update"|"quote_delete"|"confirm"|"undo";
                type?: string; name?: string; kind?: "ledger"|"list"|"log"; rows?: object[]; visibility?: "group"|"private";
                record_id?: string; match?: {person?: string; title?: string}; patch?: object; token?: string;
                request_quote: string; source_id?: string }
  untrusted: false；成功均返回 { ok:true, accepted:true, family:"record", ids/short, summary_line, say }
  add 在类型不存在且 kind 可推断（出现金额 → ledger；「清单/待办」→ list）时自动 define_type（一步到位，RC-05）。
  批量删除/清空 = quote_delete(match 多行) → token；confirm 时 isAdmin 才允许多行。
```
授权（`src/authz.ts` 新增，D1 实现函数、D4 接线）：

| 工具/操作 | 谁 | 污染（引用/转发/网页）时 |
|---|---|---|
| records_read | 任何成员 | 允许 |
| records_write add/define_type/undo | 任何成员，且必须是对 bot 说（direct 或 chat_decision 判定在跟 bot 说） | 只认说话人自己的原话：request_quote 必须 quoteIn 且长度 ≥2 个非标点字 |
| records_write quote_update/quote_delete/confirm | creator 或管理员（isAutoSender） | 拒绝 |
| schedule_create（agent_task） | 任何成员；steps 只读 | 拒绝 |
| schedule_update/cancel | owner 或管理员（mute 例外） | 拒绝 |
| skill_save | 任何成员（只读步骤） | 拒绝 |
| run_steps | 任何成员 | 允许（只读） |
| run_task | 管理员 + direct | 拒绝 |

审计：D0 在 `src/toolkit.ts` 把 `auditTool` 的条件改为 `name === "calc" || name.startsWith("mcp_") || AUDITED.has(name)`，`AUDITED = new Set(["records_write","schedule_create","schedule_update","schedule_cancel","skill_save","run_task"])`（导出常量）。

---

## 6. 工作包（可并行）

时段：今天周六（北京时间谷时），DeepSeek 成员可立即开工；周一北京 09:00 起高峰，届时未完成的关键路径包（D0/D1/D2）改派程序员，其余进 `offpeak-queue.md`。

Worktree/分支：`/Users/yanghongming/Projects/.worktrees/TeamAgent-D-<包名>`，分支 `pkg/D-<包名>`，均从 origin/main 0a16658 开；集成分支 `release/D`，集成 worktree `/Users/yanghongming/Projects/.worktrees/TeamAgent-D-release`。

| 包 | 施工队 | 改动文件（独占） | 依赖 | done_when（测试 + 验收） |
|---|---|---|---|---|
| **D0 · 迁移与审计** | 工程师 | `src/schedules.ts:580` 仅给 digestText 加 `export`（其余归 D3b）、新 `migrations/0090_records.sql`、新 `scripts/migrate-schedules.mjs`、`scripts/migrate.mjs`（清单+调用）、`schema.sql`（schedules CHECK）、`src/toolkit.ts`（AUDITED）、test 夹具里自建 schedules 表的地方；新 `test/migrate-d.test.mjs` | 无（最先合） | ① `wrangler d1 execute --local` 对空库跑两遍 migrate 流程无错；② 对含 3 行旧 schedules 的本地库跑 ensureSchedulesV2 两遍：行数/字段不变、能插入 kind='agent_task' 和 status='paused'；③ 生成列：插入 data 后 person/amount_cents 可查；④ `npm test` 全绿 |
| **D1 · 记录核心 + 工具** | 工程师 | 新 `src/records.ts`、新 `src/tools/records.ts`、`src/tools/index.ts`（加 2 行）、`src/authz.ts`（新增 `authorizeRecords(op, …)` 函数，不改现有函数）；新 `test/records.test.mjs` | D0（DDL） | 单测：金额/中文数字/「我」/人名归一（t.o.o.=TOO）、去重键、私有可见性、quote→confirm、undo、导出 BOM；RC-05/06/06b/10/11、S-05/06/08/18 在 D9 回放通过 |
| **D2 · 时间解析** | 工程师 | 新 `src/schedule-parse.ts`；新 `test/schedule-parse.test.mjs`（≥100 例，含 DST 两个日期：2026-11-15 AEDT、2027-05-15 AEST） | 无 | 规则表每条有用例；`parseWhen("每天北京时间0点在群里发DeepSeek余额即可")` = daily 00:00 Asia/Shanghai；「固定时间」→ missing time；RC-08/12、S-01..04 的解析部分通过 |
| **D3a · 动作层** | 工程师 | 新 `src/actions.ts`；新 `test/actions.test.mjs` | D0、D1（records 函数签名，可先按 §5.3 打桩） | 每个 action 有单测（假 D1）；token_usage 按 tz 自然日；private 行不进群发汇总；composeWithNote 失败回退 joinResults；S-11 |
| **D3b · 日程 v2** | **程序员（Codex）** | `src/schedules.ts`、新 `src/tools/schedule-tools.ts`、`config/team.json`（schedules 段）、`src/config.ts`（如需读新字段）；`test/schedules-v2.test.mjs` | D0、D2、D3a | nextRun monthly/every/once/DST；agent_task 运行、每 tick ≤2 次模型、每日 ≤24、fail≥9 暂停；cancel/update 归属；pending_actions 写入/过期（30 分钟）；schedule_list 带最近一次发送状态；`off:schedules_cron` 开关生效；RC-02/07/08/09/12、S-01..04/15/16/17 |
| **D4 · 意图接线 + 回执守卫** | **程序员（Codex）** | `src/semantic.ts`（独占：删旧 schedule 定义/case、Accepted[]、pending 注入、技能名注入、prepare_project_task repo 可选→ inbox、few-shot、工具描述）、`src/reply-finalize.ts`、新 `src/receipt-guard.ts`、`src/tasks.ts`（createBoardTask 接受 `BOARD_INBOX='inbox'`）、`src/authz.ts`（只接线 D1/D5/D6 的授权函数到 WRITE_TOOLS）；`test/receipt-guard.test.mjs`、更新 `test/reply-finalize.test.mjs` | D1/D3b/D5/D6 的工具名与返回形状（§5 已冻结，可并行写） | 守卫单测覆盖 6 个 family × {成功保留, 补建, 替换, 不重复}；RC-01/03/04/13、S-14 回放；全量 `npm test` 绿 |
| **D5 · 技能** | 工程师 | 新 `src/skills.ts`、新 `src/tools/skills.ts`、`src/tools/index.ts`（加行）；`test/skills.test.mjs` | D3a | S-09/S-10；同名覆盖权限；≤20 个；非只读步骤拒绝并给 unsupported 列表 |
| **D6 · 执行入口与回执** | 工程师 | 新 `src/tools/run.ts`（run_steps、run_task）、`src/tools/index.ts`（加行）、`src/worker.ts`（仅 media claim 处插 job-start、cron 段插 progress/stale 三条 INSERT OR IGNORE）、`runner/utility.py`（mode=file 直发分支）；`test/run-task.test.mjs`、`runner` python 单测 | D3a | S-07（投递部分）/S-11/S-12/S-13；utility.py mode=file 不调用模型（单测 mock 断言）；审查员重点看权限 |
| **D8 · 工作台只读页** | 前端工程师（**需设计师先出 `ui-spec.md`**） | 工作台前端里新增「账本/清单」「技能」「日程」三个只读页 + CSV 下载；后端 `src/worker.ts` 新增 `GET /api/records/types`、`/api/records?type=`、`/api/records/export?type=`、`/api/skills`、`/api/schedules`（登录 who，私有行只给本人）；tasks 列表显示 repo=inbox 为「收件箱」 | D1、D5、D3b | 视觉验收员按 ui-spec 过；S-07 链接下载、S-18 私有明细只本人可见；RC-04 在工作台可见 |
| **D9 · 回放器 + 验收** | 测试员 | 新 `test/d-accept.mjs`、`test/fixtures/d-real.json`（线上只读抽 rid 286,351,355,382,394,396,449,482,484,485,486,488,490,493,496 + 上下文，sender 脱敏为代号）、`.agent/scenarios/D/run.sh`；acceptance.json 翻 passes | 全部 | 支持「单条注入」（RC-10）；真实 DeepSeek 意图回放 + 假 D1 + 本地 outbox；每条输出 PASS/FAIL + 实际值；全部 32 条（RC 14 + S 18）PASS |

> D7（原 repo-less 任务）已并入 D4（semantic 独占）+ D8（显示），避免两包同改 semantic.ts。

每包开工仪式与笔记照团队规范；`.agent/releases/D/notes/<包名>.md`。

---

## 7. 界面规格

只有 D8 有界面：请设计师按本节 §5.3/§5.7/§5.5 的数据写 `.agent/releases/D/ui-spec.md`（三页只读表 + 导出按钮 + 私有行标记 + 日程双时区显示）。D8 照 ui-spec 施工，视觉验收员验收。群内回复的文字样式（回执句式）以本文 §5.6/§5.8/§5.9 的 say 模板为准，不需要 ui-spec。

---

## 8. 集成顺序与冲突点

1. **D0** 先合 release/D（其他包 rebase 到它上面）。
2. 并行：D1、D2、D3a（D3a 先按签名打桩 records）、D5（依赖 D3a 签名）、D6、D9 开始搭回放器骨架。
3. D3b（需 D2 + D3a）→ D4（最后合，独占 semantic.ts/reply-finalize.ts）→ D8。
4. 冲突点：`src/tools/index.ts`（D1/D3b/D5/D6 各加行，主程合并时按字母序拼）；`src/authz.ts`（D1 只新增函数，D4 只接线）；`src/worker.ts`（D6 只动 claim 与 cron 两处，D8 只加 /api 路由块——不同区段）；`config/team.json`（只 D3b）。
5. 与 image-diagnosis（视觉修复）可能同期：那边改 `src/vision.ts` 一带，不与本版文件重叠；若同改 semantic.ts，以 D4 为准后合。

---

## 9. 回放方案

- 数据：线上 messages 只读抽取（命令见 `replay-cases.md §1.1`，令牌只走文件，不打印），写 `test/fixtures/d-real.json`，sender 换代号；合成用例写在同一文件 `synthetic` 段并标注。
- 环境：`test/learning-accept.mjs` 的 env()/browserDb 假 D1（better-sqlite3 内存库，从 schema.sql + migrations 建，含 0090 + ensureSchedulesV2）；fetch 拦截：DeepSeek 走真实 API（意图回放，需 DEEPSEEK key 用现有本地凭据路径），QQ/OpenAI/余额接口 mock（余额返回固定 ¥277.56）。
- 时间：固定 `now` 为原消息 ts；RC-08 期望值按运行日期计算（北京 0 点 = UTC 16:00），不写死悉尼钟点。
- 冷上下文：RC-10 的 batch 只放 rid 496，history 查询返回空（记录只能从 records 读到）。
- 输出：`.agent/scenarios/D/run.sh` 每条 `PASS/FAIL id 实际值`，末行汇总；**全程不触碰线上 D1、不向 QQ 发送**（outbox 只在内存库）。
- 额外：D9 跑一次 `npm test` 全量 + 解析器 100 例。

---

## 10. 风险与回滚 / 备选路线

| 风险 | 可能性 | 处置（主路 → 备选） |
|---|---|---|
| schedules 重建在线上 D1 中途失败或不原子，cron 恰好读到空表 | 低 | 主：一次 execute 批量提交；**新增** settings 开关 `off:schedules_cron`（D3b 在 runSchedules 开头检查），交付员迁移前置 1、迁移后置 0。备选 A：不改 CHECK，agent_task 存为 `kind='reminder'` + `spec.steps`（runSchedules 见 steps 即走动作层），paused 用 `status='active' AND spec.paused=1`；备选 B：新表 `schedules2` 只放新类型，runSchedules 两表都扫。回滚：迁移前 `wrangler d1 export` 备份 schedules；代码回滚到 main 不影响新表（多出的 kind 行旧代码只会当未知 kind 失败并通知——先 UPDATE 为 paused 再回滚）。 |
| D1 不支持 STORED 生成列 | 中低 | 备选：普通列 + normalizeData 同步写（§5.1 已写） |
| DeepSeek 仍不调工具、只口头承诺 | 中 | 三层：工具描述+few-shot（D4）→ 回执守卫补建/替换（D4）→ 再兜底：守卫检测到 schedule/record 承诺且 autoLand 失败时，**额外 1 次 JSON 模式抽取调用**（`response_format: json_object`，只抽 When+steps，不给工具）；`tool_choice` 强制调用在 DeepSeek 上**未验证**，D4 先小实验，可用则替代 JSON 抽取 |
| 误建（RC-13 回归） | 中 | parser 不判断该不该建；只有模型调用或「对 bot 说 + 本轮出现承诺句」才 autoLand；RC-13 是 P0 回归项 |
| 工具变多拖慢/涨费 | 中 | 新增 9 个工具定义约 +1.5k 输入 token/轮；估算见 §11；超支时按关键词门控（含 记账/账本/清单/定时/每天/提醒/技能/跑一下 才挂对应工具） |
| 记账人名歧义（「卡特龙那笔」有多笔） | 高 | quote 返回 ambiguous + 列出候选号，让人说号 |
| 私有记录在群里泄露 | 中 | 群内永不出私有明细（§5.3 规则）；定时汇总强制排除私有；单测覆盖 |
| run_task 在用户本机执行 | 中 | 只管理员 + direct + 无污染；沿用 runner 现有沙箱与 gitsafe；不新增常驻进程（尊重「不把电脑当服务器」）；开关 `off:run_task` |
| 「执行一个东西」真实需求未知 | — | replay-cases 没有真实样本；S-12/13 为合成。主程拿到第一条真实交办后按 §4 追加用例 |

**做不到 / 本版不做的部分及替代路（不缩窄，给路）**

1. **用户自建「会写代码/调外部 API」的真工具**（如「每天抓某网站价格」）：本版不让模型生成并执行代码。路 A：skill_save 拒绝时自动转 `request_feature`，进现有需求流水线（F-request → 开发 → 上线），回复带单号；路 B：管理员在工作台登记 MCP 服务器（现有 `mcp_*` 桥，`src/tools/mcp-bridge.ts`），技能 steps 下版允许引用只读 MCP 工具；路 C：用 run_task 让本机 runner 一次性执行（管理员）。
2. **私有账本的私聊投递**：QQ 群机器人私聊能力未核实。路 A（本版）：私有明细只在工作台看；路 B：核实 QQ C2C 发送接口后，加「私聊发给我」投递（下版）；路 C：私有行导出 CSV 只给本人（工作台下载）。
3. **任意时间表达**（「每个月第二个周三」「农历初一」）：路 A：本版规则表 + monthly 的 month_days；不认的时间老实说「这个时间我还不会算，换个说法：每月N号/每周X」；路 B：chrono-node zh 后备；路 C：存成 cron 表达式（`schedule.spec.cron`，下版用现有 cron 解析）。

回滚（整版）：各开关 `off:records_read`、`off:records_write`、`off:skill_save`、`off:skill_run`、`off:run_task`、`off:run_steps`、`off:schedules_cron` 置 1 即关；Worker `wrangler rollback <上一版 id>`；新表不删（只读不影响旧代码）。schedules 重建不可逆，回滚前先把 kind='agent_task' 行置 paused。

---

## 11. 额度预算（按 main 现有用量量级估算，上线后用 model_usage / ds_usage 校准）

| 资源 | 新增 | 估算 | 依据/上限 |
|---|---|---|---|
| DeepSeek 对话 | 工具定义 +~1.5k 输入 token/轮（多数命中缓存） | 300 轮/天 × 1.5k = 45 万 token/天，缓存未命中最坏 ≈ ¥1/天 | 超了就关键词门控 |
| DeepSeek 定时成文 | agent_task 有 note 才调 1 次，≤1200 输出 | ≤24 次/群/天，常见 1–3 次 ≈ ¥0.05/天 | 每 tick ≤2；无 note 零调用 |
| DeepSeek 守卫抽取 | 仅承诺无落地时 1 次 | <10 次/天 | |
| D1 写 | add 1 行 + 3 索引 + 1 event ≈ 6 行写 | 200 条/天 ≈ 1.2k 行写；全版 <5k/天 | 远低于 D1 免费 10 万/天 |
| D1 读 | summarize 走索引；schedule tick 不变 | 可忽略 | |
| Workers | cron 每分钟不变；agent_task 每 tick ≤2 次 fetch + ~10 次 D1 | 子请求 <30/调用 | 免费档 50 子请求/调用的安全线内 |
| 本机 | run_task / export 走现有 runner，不加进程 | 0 常驻 | 用户偏好 |

---

## 12. 反方自审（已改进正文）

- *最可能失败处*：模型不调工具。→ 加了三层兜底（§10 第 3 行），并让 parser 结果覆盖模型时间参数，避免「模型把北京 0 点换算错」。
- *没开代码确认的假设*：D1 生成列与批量原子性、DeepSeek tool_choice、QQ 私聊能力——都在 §10 标了「未验证」并给了备选，D0/D4 第一步就是小实验。
- *DeepSeek 施工者会在哪猜*：人名归一（已给规则：大小写/标点无关 + 已有 person 值优先）、金额解析（已列格式）、时间规则（已列全表）、「谁是管理员」（已定 = isAutoSender）。
- *更简单的做法*：把账本塞进 facts —— research 已否决（不可汇总、不可审计）；只扩 parser 不做 agent_task —— 满足不了「发余额+token」，否决。
- *RC-08 期望改动*：replay-cases 写「spec.time=03:00 tz=Sydney」；本设计存 `tz=Asia/Shanghai time=00:00`，判定改为「next_run_at = 下一个北京 0 点」——更严格（换季后仍是北京 0 点），不是放宽。
- *并行冲突*：semantic.ts 只给 D4；其余工具一律走 `src/tools/*.ts` 扩展点（`src/toolkit.ts` 头注释规定的 F7 机制）。
