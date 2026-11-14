# B 站分享卡片修复复核（22854b4，对比 main 31d0c2c）

结论：通过（无 P0/P1；2 条 P2 建议，不阻塞）。

测试：`npm run check`、`npm test` 385/385、`npm run test:runner`（Python 37 + fetcher 47）、`clients` 2、`npm run check:ui`、`npm run config:check`、`git diff --check` 全绿。worktree 外临时副本探针（fixture + 合成事件）：
- 真实形状 miniapp（fields 只有 preview/source/source_logo/title，另有 prompt）→ `biliCard.title` 正确、`card.note` 为「仅卡片…未读取…请在 B 站点复制链接」、`bili=[]`、`ownUrls=[]`；`needsVideo` 返回 `t-…`（title ref）。
- `msg_elements` 内的 B站链接只进 `quotedUrls`，`ownUrls=[]`、`bili=[]`；JSON 转义 `https:\/\/b23.tv\/...` 能还原并进入 own；`preview`/`source_logo`（含字段数组）被排除、不产生 bili；40 层嵌套不抛错。递归有 depth 32，输入受 QQ 事件体上限约束，未见拖垮 Worker 的路径。
- 标题检索：runner 测试覆盖完整 WBI 四参数、匿名（无 SESSDATA）、全部合法候选按 BV 去重恰一、0/多/近似回退、24h miss 缓存、412/v_voucher 暂停、第 6 个之后的同名参与判定；云端口径（NFKC + 空白合一 + 保留大小写标点）与 runner 共同向量一致。
- 材料层级：`BILI_CARD_NOTE`/`TITLE_FALLBACK`/`titleMissMaterial`/`titleMaterial` 分别标注仅卡片、未读取、按标题匹配可能非原视频；不编造内容；提示复制链接。
- 安全：标题 100 字上限、去控制字符；只作 query；匿名搜索 only buvid3；未新增域名；D1 测试不退化；schema 无 ALTER。

## 必须修（P0/P1）

无。

## 建议（P2）

- **P2-1｜src/bili-links.ts 的 ownUrls 扩大**：递归扫描整份 raw 后，`attachments[].url` 等 QQ 签名 CDN 也会进 `ownUrls`（探针：`https://multimedia.nt.qq.com.cn/download?rkey=SECRET`）。`view` 的 `material.links` 会把它给模型；P0 的 `ownUrls` 只来自 body + ark_data。preview/source_logo 已排除、不会当视频链接，但链接面扩大、签名 URL 进入提示词。建议只把 B站/视频候选放进新的 `biliUrls`，`ownUrls` 保持旧语义，或显式排除 `attachments`。
- **P2-2｜真实卡片与匿名搜索未正向验收**：fixture 自述「未找到真实样本，结构为推测」；真实匿名完整签名搜索只返回 v_voucher 验证挑战，未取得正向候选（程序员已如实报告）。回退文案路径稳定（无链接 → 仅卡片 note；搜索失败 → TITLE_FALLBACK），不会编造；但「按标题找到视频」在真实租户是否可用未证明，建议群冒烟用真实转发卡片核验，并保留 v_voucher 计入风控/不重试的断言。

## 备注

- 测试夹具的 `ark_name`、preview 值是合成占位；真实卡片的 `source`/`prompt` 命中 `isBiliCard` 的条件已由 fixture 覆盖，但真实样本仍缺。
- `titleRef`（FNV64/NFKC/空白合一/保留标点）与 runner 的 normTitle 已用共同向量校验；标题只进 search query，不进路径/headers/日志。

---

# 复审 2（23a2682，2026-11-12 15:40）

结论：通过（无 P0/P1；2 条 P2 备注）。
测试：`runner/test_fetcher.mjs` 48/48（N-T3、N-T7 绿）；`npm test` 385/385；`npm run test:runner` Python 37 + fetcher 48；`check`/`check:ui`（本次只改 runner 三文件，src 未变）。
- **v_voucher**：`biliByTitle` 命中后 `pauseSearch(6h)`、不调 `pauseForRisk`；搜索开头检查 `isPaused() || isSearchPaused()`；N-T7 验证 6 小时内标题任务 0 请求、6 小时整点只再搜一次、`isPaused()===false`。
- **412/-352/-412**：仍由 `get()` 的 `risk()` 全局暂停；N-T3 三码逐条断言 `isPaused()===true`、`isSearchPaused()===false`，之后无请求。
- **BV 读取**：N-T7 在 voucher 后 `biliLight(BV)` 仍请求 `/x/web-interface/view`；搜索冷却只在 `biliByTitle` 检查，`biliLight`/`qr-login`/`browser-auth` 仍用 `isPaused`/`pauseForRisk`（代码确认；qr/browser 未直接断言，见 P2-1）。
- **无新持久化/表/域名**：`searchPausedUntil` 只在 `createFetchClient` 内存；进程重启后冷却清零、下一次触发再试一次，符合“重启后合理”的 L1 预期。
- **回退验证**：worktree 外副本把 `bili-title.mjs` 换回 68419d1（`pauseSearch`→`pauseForRisk`）后 N-T3、N-T7 变红（globalPauses>0 / isPaused true），恢复 23a2682 后 48/48 绿。

P2-1：N-T7 只直接断言 BV 读取，未直接构造 qr-login/browser-auth 的暂停状态；代码路径分离清楚，建议后续补一条“搜索冷却不使登录侧 isPaused 变 true”的断言。
P2-2：6 小时硬编码在 `biliByTitle`，与方案一致；若以后要改时长需重新发版，记录即可。
