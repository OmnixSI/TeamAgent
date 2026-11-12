# 链接读取失败：P0b

B 站失败回报只含枚举原因，风控另带秒数；异常原文和 Cookie 留在本机。被 @ 且原因明确时回固定中文模板；未被 @ 时把原因作为素材交给模型决定是否回复。

| 原因 | 行为 / 失败缓存 TTL |
|---|---|
| risk | 告知读取被拦截；60–3600 秒，缺省 600 秒；标题搜索回报 3600 秒 |
| not_found | 告知视频不存在或不可见；1 小时 |
| unsupported | 告知不是普通视频链接；1 小时 |
| login_required / invalid | 告知权限不足 / 读取出错；不缓存，可再次尝试 |
| offline | 上次在线超过 120 秒时立即告知离线；不缓存；从未上线按未知处理 |
| timeout | 在线但超时仍走模型，素材明确说读取超时；不缓存 |

失败键为 `failure:v1:bili:<ref>`，JSON 为 `{reason,until}`；所有失败写入沿用抓取任务的租约守卫。缓存有效时不建等待、不重置抓取任务、不调用模型。标题失败回复附复制链接建议；标题超时保留原 `TITLE_FALLBACK`。
网页失败通过 `reason_text` 说明原因：`empty` 表示打开但无正文，`unsupported` 表示非公开网页。现有不可信资料包装与授权边界保持。

## D1 预算实测

`test/fastlinks-budget.test.mjs` 的 `measured()` 同时核对计数器与底层执行次数，所有路径均 ≤48。一个 batch 中的每条语句各占一次，包含零行更新。
本地一个 batch 三条语句的计数由 `test/fastlinks-budget.test.mjs` 的 `measured()` 得出：计数 3，changes `[1,1,0]`，剩余预算 45；没有向生产数据库发请求。这验证应用计数规则，不声称测得生产服务的限额执行。

| 路径 | P0a 基线 | P0b |
|---|---:|---:|
| bili-wait | 21 | 22 |
| fetch-report（成功） | 7 | 8 |
| video-reply（成功） | 36 | 36 |
| cache-hit（成功） | 38 | 38 |
| B3-answer | 45 | 45 |
| fail-cache-reply | — | 17 |
| offline-reply | — | 17 |
| failed-video-reply | — | 10 |
| failure-report（含缓存） | — | 8 |

## 验证、上线与回滚

R1–R8、B1–B17、M1–M6、W1–W7 覆盖原因、无泄漏、TTL、离线、等待、租约、新旧混跑和网页。M1/M2 实际调用仓库内 384b420 的旧 runner / Worker 快照，临时模块在 finally 删除。
对照临时切回六个生产文件的 384b420 内容（保留新纯函数模块以运行测试）：Worker 7 过 / 24 败，runner 定向 1 过 / 8 败，预算 1 过 / 2 败，网页 W1 0 过 / 1 败；随后恢复新实现。
唯一计划调整：经 BINI 裁定，仅将旧 W3 超时素材断言改为「读取超时」，其余行为断言未改。
建议先更新本机 runner，再上线 Worker；两个方向均兼容旧版回报。不涉及 schema 或迁移；本次实现不执行部署。
可独立回滚 Worker 至 384b420，或还原 runner/fetcher.mjs 与 bili-title.mjs。失败缓存最多一小时失效；需立即清除时执行 `DELETE FROM media_notes WHERE id LIKE 'failure:v1:%'`。
