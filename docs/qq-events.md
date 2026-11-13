# QQ 群事件与发送错误码（事件层 v2）

本文只记本仓库实际消费的字段、状态和错误码。官方文档更新于 2026-10-28，核对日期 2026-11-13。

## 入站事件

入口：`POST /api/qq/events`（`src/worker.ts::receive`）。签名头 `x-signature-timestamp` /
`x-signature-ed25519`，时间窗 300 s；`op:13` 只做回调地址校验，`op:12` 是 HTTP 回调的应答码。

| 事件 | 处理 |
|---|---|
| `GROUP_MESSAGE_CREATE` | 普通群消息；`@` 提及不改变事件类型 |
| `GROUP_AT_MESSAGE_CREATE` | 视为 `mentionsBot=true` |
| `GROUP_ADD_ROBOT` | 记 `activity(kind='qq.bot_added')`，不落消息 |
| `GROUP_DEL_ROBOT` | 记 `activity(kind='qq.bot_removed')` |
| `GROUP_MSG_REJECT` | `settings['qq:active_rejected']='1'` |
| `GROUP_MSG_RECEIVE` | `settings['qq:active_rejected']='0'` |
| 其它（含私聊） | 回 `{op:12,d:0}`，不读写消息表 |

`author.bot=true`、`author` 等于自身 App ID、非绑定群：一律 `op:12`，不落库。
事件时间戳转毫秒；`Date.parse` 非有限数时不写 `passive_claims`。

## 消息元素

`d.message_type` 与 `d.msg_elements[].message_type` 使用同一套编号：

| 类型 | 含义 | 归一化结果 |
|---|---|---|
| 101 | 图文并行 | 顶层 `content` 非空时只取它；空白（trim 后）才回退元素正文；元素附件按 `own` 归属 |
| 102 | 转发 | `forward` 段，节点保留 `authorId/authorName`；深度 ≤4、节点 ≤64，超出 `truncated` |
| 103 | 引用 | `reply` 段 + `msg_idx`/`ref_msg_idx`；`quoted` 保留预览文本、媒体和卡片 |
| 无类型 | 旧版合并转发文本 | 走 legacy 分支，当作引用（已知差异，夹具 `E15-legacy-*` 锁定） |

`<@!openid>` → `mention` 段，`is_you` 决定 `self`。`<faceType=…,faceId=…,ext=…>` →
`face` 段；`ext` 支持裸 JSON、URL 编码 JSON 和 base64 JSON；都解不出时保留原始 `ext` 并标
`face_unparsed:true`，不报错。`[<face,id=n/>]` 旧标签也保留。`mface` 附件同时产出 `image` 和 `face(kind='mface')`。

图片 `content_type=image/gif` 记 `animated=true`；归属 `owner` + `origin`（`own`/`quote`/`forward`）。
图片 URL 只允许 `multimedia.nt.qq.com.cn` 与 `*.qpic.cn`（取图白名单）；夹具同此规则。

## 出站发送

状态：`pending`（根段，旧 sender 可读）、`held`（后续段）、`retry`（有账本状态）、
`sending`、`sent`、`failed`、`unknown`、`skipped`。v2 永不写回 `pending`。

- 文本：`body.slice(0,4000)`；分段 1800 字 × 最多 3 段，切点空行 → 句末 → 硬切；代码块重包围栏，超长 URL 按字符切。
- 被动回复：同一 `msg_id` 300 s 内最多 5 次；认领窗口 280 s，`msg_seq` 取 1..5，重试不变。
- 引用：出站 `message_reference` 只在 `message_refs.created_at > now-24h` 时带；连续 3 次引用失败自动 `off:quote=1`。
- 去重/限流：`429` 按 30/60/120 s 退避，3 次后 `failed`；5xx/无响应体记 `unknown`，默认不重发。

| 业务码 | 分类 | 处理 |
|---|---|---|
| `40054005` | dedup | 记 `sent` |
| `304103` / `40034005` / `40034128` | 被动额度失效 | 换最近 `msg_id` 重试一次；该 `msg_id` 的 `used=5`，第二次 → `failed` |
| `40054002` / `40054003` / `40034101` | 禁言/不在群 | `failed`，写 `qq:muted_until=now+600000`，入口直接返回 |
| `22006` 等 28 个内容拦截码 | blocked | `failed`，不重试，不计入引用失败 |
| 其它 400/422（带引用时） | ref_invalid | 去引用重试一次 |
| `3xx` | blocked | 表情发送 `redirect:'manual'`，3xx 记失败 |

已核对来源：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>。
平台是否按 `msg_id+msg_seq` 去重尚未线上实测，因此 `off:unknown_resend` 默认关闭重发。

## 夹具

`test/fixtures/events/Exx-*.json`（数组；G4 的 9 个单对象文件在 `events/g4/`，由 `test/event-101-102-103-fixtures.test.mjs` 读取）。
每条含 `{id,group,source,note,event:{op,t,d},expect:{inbound,normalized?,golden?,difference?,maxStatements,rows,meta?,settings?,activity?}}`；
`source` 为 `d1`/`doc`/`adapter`/`synth`。`d1` 全部经 `scripts/fixtures-from-d1.mjs` 脱敏，
openid→`u1..`、名字→`成员A..`、群→`GROUP000001`、消息→`m0001..`、REFIDX→`REFIDX_SYNTH_0001..`，
正文换成等长「测试文本」，B站/网页 URL 与 face 标签保留。`/tmp/ev-raw` 用完即删。

`test/fixtures/qq-send/*.json`（数组）覆盖 `receipt`/`pairs`/`enqueue`/`quoteRef`/`state`/`recent`/`rollback`
七种场景；`test/send-pipeline.test.mjs` 用 `node:sqlite` 真跑 M1-S 的 SQL，不 mock 语句。
