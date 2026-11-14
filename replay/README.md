# B-l9 真实数据回放夹具

这些夹具只用于本地独立库回放和验收，**不写线上 D1、不往 QQ 群发任何消息**。

## 数据来源

- 线上 D1 `inkboard-team`（database_id `42e95fb2-16f8-46d9-bf32-34f3e88a4443`）只读导出，2026-11-14 14:19 Sydney。
- 导出命令（现有只读脚本，每条固定 SELECT，响应断言 `rows_written=0` / `changes=0`）：
  ```bash
  python3 scripts/review-export.py \
    --token-file <Cloudflare 只读令牌文件> \
    --out /tmp/teamagent-l9-export-20261114
  ```
  本次导出 466 条 `messages`、264 条 `outbox`、133 条 `chat_decisions`；`replay/fixtures/export-audit.json` 保留了每条查询的 `rows_written/changes`，全部为 0。
- 生成夹具：
  ```bash
  python3 replay/build-fixtures.py --export /tmp/teamagent-l9-export-20261114
  ```
  脚本只从导出目录选行，不联网、不改正文、不造消息。原始导出留在 `/tmp`，用完删除；仓库里只保留下列必要子集。本次原始导出已删除（2026-11-14 14:27 Sydney）。
- 验收溯源校验（不依赖 `/tmp`，直接用夹具）：
  ```bash
  python3 replay/check-acceptance.py \
    --acceptance ../TeamAgent-p4b-login/.agent/releases/V-D-learning/acceptance.json \
    --fixtures replay/fixtures
  ```
  本次 → entries 20、rid 引用 37、逐字引用 13、errors 0。

## 文件

| 文件 | 内容 | 对应验收 |
|---|---|---|
| `too-daily-request.json` | t.o.o. 11-13 04:11:39 Sydney 原话（`messages.rid=351`）+ 周报原话（`rid=350`）+ 真实回复 `chat-drain-350` (`outbox.rid=203`)、`outbox.rid=206/207` | VL-8、VL-14、VL-19 |
| `chat-drain-350.json` | 单独的真实 `chat-drain-350` 行 | VL-19 |
| `learning-signals-7d.json` | 近 7 天含「别再/口头禅/叫我/以后/每天」的 8 条真实群消息；`别再` 线上 0 条 | VL-4、VL-7、VL-15 |
| `address-request.json` | 最接近 address_as 的真实原话（`messages.rid=214`，「小马是你叫的吗，要叫马哥」）；库里没有字面「以后叫我 XX」 | VL-7 |
| `outbox-cao-18.json` | 禁令（`messages.rid=134`，11-11 21:09 Sydney）之后 18 条含「草」的真实 bot 回复；10 条单独成句、8 条是「草稿/草案」或引用 | VL-6、VL-20 |
| `review-p1-case.json` | V-D v2-notes #17 的真实 22 分钟无回复片段（`messages.rid=428..432`、`outbox.rid=239`） | VL-1、VL-3 |
| `quiet-night.json` | 2026-11-12 00:00–09:00 (+08) 真实记录 0 条 | VL-2 |
| `daytime-batch.json` | 11-13 18:12–18:41 (+08) 的真实白天批次（`messages.rid=420..425`） | VL-20 |
| `export-audit.json` | 只读导出的逐查询审计（`rows_written=0`） | VL-17 |

消息 id 里的 `sk-` 在导出脚本的 **id 字段**被规范成 `sk_`（避免被误认成 API key 前缀）；正文没有任何改动。`messages.rid` / `outbox.rid` 与线上 rowid 一致，可直接回查。

## 零发送/零写入

- 导出端：`scripts/review-export.py` 对每条响应断言 `rows_written==0 && changes==0`；`export-audit.json` 里全部为 0。
- 回放端：`test/learning-accept.mjs` 把 `globalThis.fetch` 换成计数桩，QQ / Cloudflare / DeepSeek 任何网络调用都会计数并报错；本地库是 `node:sqlite` 临时文件，不提供任何线上令牌。
- 每次运行结束写 `replay/out/latest.json` 和 `replay/out/learning-accept-*.log`，固定一行：`QQ 真实发送 0 次、线上 D1 写入 0 行`。

## 模型响应

`replay/fixtures/deepseek-recorded.json` 是**待录制**占位：L1–L8 合入、L3 的新 judge 输出（`schedule_requests` / `avoid_phrase` / `address_as`）可用后，用一次真实 DeepSeek 只读评分录制并写入；在此之前，骨架只用明确标注为 `canned` 的确定性桩跑管线，不把桩输出冒充真实模型结果。
