# V-D review fixture subset

供 D-3（trace / 信号）单元测试用的**脱敏**真实数据子集。数据来自生产 D1 的只读导出（`scripts/review-export.py`，每条查询 `rows_written=0`），行号（`rowid`）与线上一致；QQ 消息 id、发送者 id、群 id、昵称和引用都替换成了 `fx-*` 稳定假名。

- `subset.sql`：可直接 `db.exec()` 的 INSERT 脚本（先跑 `schema.sql`）。
- `subset.json`：同一份数据的结构化版本，含 `note` 和来源说明。
- `load.mjs`：`loadReviewSubset(database)`，加载 `subset.sql`。

生产访问令牌、浏览器会话、签名 URL、密码哈希一律没有进入本目录；`members.token_hash` 是本地假值。本目录内扫密钥类特征（API key、GitHub PAT、鉴权头、URL 访问令牌、浏览器会话字样）为 0 命中。

## 覆盖的案例

| 案例 | 入站 `messages.rowid` | 出站 `outbox.rowid` | D-3 断言 |
|---|---|---|---|
| #17 22 分钟无回复 | 428, 429, 430, 431, 432 | 239 | 全部带 S1 |
| #13「收敛一点」 | 95（上下文 93/94/96） | 76, 77 | 95 带 S7（93–96 同一发送者 3 分钟内 4 条） |
| #2 正式上线能力自述 | 434（追问 435） | 241 | 434 的 trace 带 S8 |
| #3 马哥改大肥鱼 | 338, 339 | 190, 191 | 339 第二问带 S10 |
| #20 b23 后 Queues 长文 | 419 | 232, 233 | outbox 233 带 S9 |
| S10 记忆工具自相矛盾 | 212–220 | 144–149（重点 145、149） | 145 与 149 对 `memory_write` 说法相反 |
| 负样本基线 | 437 | 243 | 正常回答，不得判成失败 |

## 加载示例

```js
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { loadReviewSubset } from "./fixtures/review/load.mjs";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync("schema.sql", "utf8"));
loadReviewSubset(db);
```

`subset.sql` 用 `BEGIN; … COMMIT;` 包住，重复加载同一份内存库会因主键冲突失败；每个测试新建一个库即可。
