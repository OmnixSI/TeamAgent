# SK 集成评审

结论：**可以上线；无 P0/P1。原 P1 已在 `release/SK @872c616` 关闭。**

## 修复定向复核（872c616）

- 仅复核 `7a07153..872c616` 的生成器修复及新增测试，未重开整轮审查；修复范围无新增 P0/P1。
- 已重新生成该提交的真实自知卡；新增测试 **5/5 通过**。
- 沿原复现路径，用本地假库和非空假 `OPENAI_API_KEY`，逐项设置 `off:generate_image`、`off:search_history`、`off:search_kb`、`off:recall_episode`、`off:summarize_chat`：值为 `1` 时，五项卡状态均为 `switched_off`，真实工具均返回 `denied`。
- 同一环境依次将各键恢复为 `0`、`false` 并重新加载开关：五项均恢复 `enabled`，真实 `toolSwitchedOff` 均为 false；`describe_self(capability)` 的状态文字和 `switches` 列表同步恢复。独立行为验证 **15/15 通过**。
- 本轮仅核实恢复后的开关放行，未执行生图/检索/总结的实际业务调用；所有外部请求均禁止，线上 D1 写入 0、QQ 发送 0。临时验证目录已清理，未改产品代码、未提交。

## 首轮审查记录（7a07153，以下 P1 已关闭）

- 审查对象：`release/SK @7a07153ed43a8fd079bc13737ba7b250092054e6`。
- 工作目录：`/Users/yanghongming/Projects/.worktrees/TeamAgent-SK-release`。
- 已先读 `design.md`、`acceptance.json`、`replay/B-report.md`、`next.md`；不重复报既有模型波动。
- 已执行要求的 `git diff main...release/SK --stat`，并读 `origin/main...HEAD` 的范围；因历史 squash/并行版本造成差异膨胀，深读范围以 SK 基线 `37d454c..HEAD` 的 22 个文件及其直接调用方为主，并非对所有历史新增功能重新全审。

## 原 P1（已关闭）：遗漏真实工具开关，已关闭的能力被稳定报告为已启用

**文件:行**：`config/self-manifest.json:193`、`:696`（同类遗漏还有 `:139`、`:727`、`:759`）；状态判定消费处 `src/self-card.ts:107`。真实开关执行依据为 `src/toolkit.ts:47-49`、`:64`。

**触发条件**：管理员按现有工具开关机制设置 `off:generate_image=1`、`off:search_history=1`、`off:search_kb=1`、`off:recall_episode=1` 或 `off:summarize_chat=1`，随后询问对应能力是否可用。生图验证同时提供假的非空 `OPENAI_API_KEY`，排除“缺 key”掩盖问题。

**原因**：工具执行统一检查 `off:<tool.switch || tool.name>`；生成器虽然在 `card.tools[].switch` 中记录了这个信息，但能力清单没有完整登记这些开关。`capabilityState` 只检查 `cap.switches`，不检查所属工具的实际开关。生图仅登记 `image_gen/openai`，漏掉 `generate_image`；历史搜索等直接登记为空数组。`renderSelf(..., 'switches')` 也只枚举能力开关，因此同样看不到这些已关闭状态。该问题并非缓存不新鲜：复现前已重新 `loadSwitches`，`readLive` 读到了对应值 `1`。

**后果**：供机器人回答自身状态的事实源稳定撒错状态；生图详情、总览及厂商摘要会说已启用，真实调用却被拒绝。这直接违反本版“关闭时如实说明”和用户要求的能力自知，不能靠 S6 仅覆盖 `off:image_gen/off:openai` 的绿灯关闭。

**本地复现结果**（无真实网络调用、无线上写入）：

| 能力 | 设置的真实关闭键 | 自知卡状态 | 同一个环境执行工具 |
| --- | --- | --- | --- |
| 生图 | `off:generate_image=1` | `enabled` | `denied` |
| 历史搜索 | `off:search_history=1` | `enabled` | `denied` |
| 群知识库 | `off:search_kb=1` | `enabled` | `denied` |
| 情景记忆 | `off:recall_episode=1` | `enabled` | `denied` |
| 聊天总结 | `off:summarize_chat=1` | `enabled` | `denied` |

复现路径：`env()` 创建假库 → 写入上述 settings 键 → `loadSwitches(e)` → `readLive(e)` → 对真实生成卡调用 `capabilityState` / `renderSelf(..., 'capability', cap.id)` → 同一环境 `runExtraTool`；五项均返回卡 `enabled`、工具 `error_kind=denied`。历史搜索详情还逐字显示“开关：无”“状态：已启用”。

**修法**：让能力状态与真实注册工具的 `switch || name` 共用来源；至少补齐上述漏登项，并让构建检查发现“工具真实开关未登记到所属能力”。对于包含多个工具/多条可选路径的能力，应明确各子功能状态，不能把某个可选子工具关闭误判成全部能力关闭。补充参数化回归：逐个关闭这些真实开关，断言 `describe_self` 的 capability/overview/switches（有厂商时含摘要）与真实工具拒绝结果一致；恢复到 `0/false` 后状态恢复。修后只需复核该项。

## 验证与边界

- 定向测试：`self-card-gen`、`self-card`、`self-card-replay`、`capability-card`，**84/84 通过**；这些现有测试未覆盖上述五个关闭键。
- `rhythm.test.mjs` 只选开关及 B3/B4 相关项，**5/5 通过**；B3 保持答案阶段 ≤45、B4 ≤48。`selfSwitches` 保存在每次入口新建的 metered 环境上，正常回合复用已有查询，未发现本次改动引入跨请求缓存或预算回归。
- 读到的生成器路径限制、令牌形状扫描、环境密钥值扫描、运行时布尔绑定探测、`redactPatch` 与 `/health` 仅暴露 commit/built_at，结合假密钥注入测试，未发现本次自知路径新增的密钥值泄漏 P0/P1。
- 在临时干净 Git checkout 中确认两个 generated 文件未由 Git 提供；执行 `npm run postinstall` 和 `wrangler deploy --dry-run` 均成功，自知卡完整 commit 与该 checkout HEAD 一致，完整 Worker 打包成功；临时 checkout 已清理。依赖复用了现有 `node_modules`，未重新联网安装，也未实际部署 Cloudflare。
- 已审 LOCAL_TOOLS 的同步分派、工具回合上限及嘴替 DSML 过滤；本报告只列 P0/P1，不把已知偶发模型回答问题重复升为阻塞。
- 未重跑全量测试或付费真实模型回放，未往 QQ 发消息，未写线上 D1，未改产品代码、未提交。工作树保持干净；仅写本报告。
