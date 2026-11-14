# TeamAgent Git 盘点（只读）

- 快照时间：2026-11-13 22:52 AEDT（悉尼）
- 主仓工作树：`/Users/yanghongming/Projects/.worktrees/TeamAgent-p4b-login`
- `origin/main`：`df11aa2` — `chore: 打开 B 站音轨转写开关 (#33) [skip ci]`
- 范围：21 个已注册 worktree（其中 2 个 detached）、28 个本地分支、11 个远端 `agent/*`、5 个旧独立 clone、PR #1–#33。
- 边界：只读。未 push、未 merge、未 commit、未改任何工作区文件；`git fetch` 只更新了本地 `origin/main`。本报告文件是唯一写入。

## 0. 结论

1. `origin/main` 干净，停在 `df11aa2`；28 个 PR 全部 MERGED，0 个 open。PR 编号 10、17–20 不是 PR，是 issue。
2. 真正没进 `main` 的内容只有三块：**event-v2 分支族**（22 个提交，含 G4 的 `8e6e7f1`）、**`agent/fix-delivery-legacy-receipt`**（1 个提交，正在施工）、**`agent/c1b-repo-files`**（1 个 WIP 提交）。另有 `agent/login-fix` 的 6 个未提交旧文件。
3. event-v2 里 `agent/event-layer-v2` 是最完整的集成分支：21 ahead / 4 behind main，已包含 `event-v2-main`、`event-v2-fix`、`event-v2-prog` 的全部提交（这三条相对 layer 独有 0 个提交）；只差 G4 的 `8e6e7f1`。
4. `TeamAgent-event-v2-fix` 工作区那 36 条未提交改动是 **G4 的成品交付物，不是垃圾**：其中 18 个数组夹具与 layer 分支逐字节相同；9 个 101/102/103 单对象夹具被移进 `test/fixtures/events/g4/`，这部分是 layer 没有的；但 5 个 `qq-send` 夹具和 `test/send-pipeline.test.mjs` 是旧版本（固定毫秒时间戳，没有 `now` 展开），整包提交会回退 `34e25f7` 的时间戳修复。必须选择性合并，不能整包合。
5. 13 个已合并 PR 的本地分支 tip 用 `merge-base --is-ancestor` 查是 NO，这是 squash 合并的正常现象，不代表有未合并代码；判断见每行「判断」列。

> 数量差异：BINI 说 `git worktree list` 有 22 个，本次快照实际是 **21 个已注册 worktree**（另 5 个旧独立 clone 不在 worktree 列表里，容易被 `ls .worktrees` 误算成 26 个目录）。

## 1. 口径

- 「在 main？」= `git merge-base --is-ancestor <tip> origin/main`；`是` 表示 tip 本身已在 main 历史里。
- 「ahead/behind」= `git rev-list --left-right --count origin/main...<ref>`，格式 **ahead/behind**。
- PR 状态来自 `gh pr list --state all --limit 100`；分支 tip 与 PR `headRefOid` 对照。
- 远端分支 tip 用 `git ls-remote --heads origin 'refs/heads/agent/*'` 取，因为本仓 fetch refspec 只有 `+refs/heads/main:refs/remotes/origin/main`，本地 `origin/agent/*` 是旧的。
- 时间统一换算为悉尼时间（AEDT）。

## 2. 已注册 worktree（21 个）

本表及 §3 表中出现的 PR 状态均为 **MERGED**；`—` 表示没有对应 PR。

| # | worktree | 分支 | tip / 最后提交（悉尼） | 在 main？ | ahead/behind | 未提交 | PR | 判断 |
|---|---|---|---|---|---|---|---|---|
| 1 | TeamAgent-p4b-login | agent/p4b-login | `58e640b` 11-12 12:33 登录探活风控 | 是 | 0/47 | 0 | #8 | 已合并可清理（#8 merge commit 就是 tip） |
| 2 | TeamAgent-bili-answer-fields | agent/bili-answer-fields | `fe7be58` 11-13 14:12 保留已读视频字段 | 否 | 1/4 | 0 | #30 | 已合并可清理（tip = PR head，squash） |
| 3 | TeamAgent-bili-asr-cloud | agent/bili-asr-cloud | `67a3635` 11-13 21:41 多视频措辞与配置校验 | 否 | 2/2 | 0 | #32 | 已合并可清理（tip = PR head，squash） |
| 4 | TeamAgent-bili-asr-local | agent/bili-asr-local | `1ae4840` 11-13 21:41 音轨解码与本机恢复边界 | 否 | 2/3 | 0 | #31 | 已合并可清理（tip = PR head，squash） |
| 5 | TeamAgent-bili-fix | agent/bili-reply-materials | `a999b1e` 11-13 10:22 长视频素材不可信边界 | 否 | 3/8 | 0 | #26 | 已合并可清理（tip = PR head，squash） |
| 6 | TeamAgent-c1b | agent/c1b-repo-files | `407addc` 11-13 09:18 WIP 测试草稿与 DENY 夹具 | 否 | 3/9 | 0 | — | 疑似废弃：基于 #25 的 WIP，只新增 126 行 `gitsafe_test.py` 草稿 + DENY 夹具差异，未接入 #27 的正式实现 |
| 7 | TeamAgent-c1b-cloud | agent/c1b-cloud-read | `e7f52e4` 11-13 10:11 C1b 复核 P2 | 否 | 3/7 | 0 | #27 | 已合并可清理：C1b 相关文件树与 #27 head `c4863bd` 完全一致；3/7 只是基线落后 |
| 8 | TeamAgent-cap-c2 | agent/cap-c2 | `71deb11` 11-13 08:37 `(#24)` | 是 | 0/9 | 0 | #24（经 cap-c3-runner） | 已合并可清理：分支停在 #24 合并提交，无自己的 PR |
| 9 | TeamAgent-deploy-bili | detached | `df11aa2` 11-13 22:36 打开 B 站音轨转写 | 是 | 0/0 | 0 | #33 | 已合并可清理（就是当前 main） |
| 10 | TeamAgent-event-v2 | agent/event-layer-v2 | `693992e` 11-13 21:35 M0 规则注释 merge | 否 | 21/4 | 0 | — | **未合并但有价值：event-v2 集成候选（见 §5）** |
| 11 | TeamAgent-event-v2-fix | agent/event-v2-g4 | `8e6e7f1` 11-13 21:09 101/102/103 夹具与回归 | 否 | 13/4 | **36** | — | **未合并但有价值：G4 成品，但需选择性合并（见 §5）** |
| 12 | TeamAgent-event-v2-fix-eng | agent/event-v2-fix | `34e25f7` 11-13 21:29 夹具时间戳改运行期相对时间 | 否 | 18/4 | 0 | — | 未合并；已被 layer 包含（独有 0），layer 落地后可清理 |
| 13 | TeamAgent-event-v2-main | agent/event-v2-main | `39a1a38` 11-13 21:25 QQ 发送规则注释 | 否 | 16/4 | 0 | — | 未合并；已被 layer 包含（独有 0），layer 落地后可清理 |
| 14 | TeamAgent-event-v2-prog | agent/event-v2-prog | `9a7ce63` 11-13 15:22 空白正文回退与引用预算 | 否 | 8/4 | 0 | — | 未合并；已被 layer 包含（独有 0），layer 落地后可清理 |
| 15 | TeamAgent-fastlinks-verify | detached | `060a961` 11-13 00:12 P0a 引用误杀与三链接截止 | 否 | 2/13 | 0 | #21 | 已合并可清理（detached 在 #21 head） |
| 16 | TeamAgent-fix-delivery-legacy-receipt | agent/fix-delivery-legacy-receipt | `2aaf2c1` 11-13 22:43 兼容无 id 旧回执 | 否 | 1/0 | 0 | — | **进行中，不要动**（工程师正在做；盘点中由 `30b7ce9` 改写为 `2aaf2c1`） |
| 17 | TeamAgent-issue10 | agent/issue10-p2 | `dd0f9f3` 11-12 16:23 空闲闸计入已领取登录 | 是 | 0/33 | 0 | #14 | 已合并可清理 |
| 18 | TeamAgent-local-login-page | agent/local-login-page | `7d12b22` 11-12 16:39 登录成功先落盘 | 是 | 0/29 | 0 | #12 | 已合并可清理 |
| 19 | TeamAgent-login-fix | agent/login-fix | `0039e5f` 11-12 16:45 Merge PR #12 | 是 | 0/26 | **6** | — | 疑似废弃：分支本身在 main；6 个未提交旧登录改动（4 改 + 2 未跟踪），mtime 11-12 17:0x；同文件的正式修复已由 #16 和后续 `4e87f4e` 进 main，该版本未被采用 |
| 20 | TeamAgent-sticker-followups | agent/sticker-followups | `16866b9` 11-12 16:32 表情回滚暂停截止 | 是 | 0/14 | 0 | #13 | 已合并可清理 |
| 21 | TeamAgent-vision-fix | agent/vision-fix | `93cbfb4` 11-12 21:44 neutral faces 归一 | 是 | 0/17 | 0 | #15 | 已合并可清理 |

## 3. 没有 worktree 的本地分支（9 个）

| 分支 | tip / 最后提交（悉尼） | 在 main？ | ahead/behind | PR | 判断 |
|---|---|---|---|---|---|
| main（本地） | `954aa99` 11-12 14:36 Merge PR #9 | 是 | 0/38 | — | 本地 main 落后 origin/main 38 个提交；可 fast-forward，不属于工作分支 |
| agent/bili-media-enable | `6179f3d` 11-13 22:35 打开 B 站音轨转写 | 否 | 1/1 | #33 | 已合并可清理（squash） |
| agent/cap-c1 | `adcdd16` 11-13 04:48 只读索引阻断仓库程序 | 否 | 9/12 | #23 | 已合并可清理（squash） |
| agent/cap-c1-followup | `fbfe9a8` 11-13 08:43 脱敏与进程回收回归 | 否 | 2/9 | #25 | 已合并可清理（squash） |
| agent/cap-c3-runner | `5b830b0` 11-13 05:33 C3 rebase 后隔离 Git 夹具 | 否 | 5/11 | #24 | 已合并可清理（squash） |
| agent/fastlinks-p0a | `060a961` 11-13 00:12 引用误杀与三链接截止 | 否 | 2/13 | #21 | 已合并可清理（squash） |
| agent/fastlinks-p0b | `2ae6f59` 11-13 01:31 修正 P0b 预算数据来源 | 否 | 2/11 | #22 | 已合并可清理（squash） |
| agent/image-fetch-redirect | `e595981` 11-13 11:20 QQ 图片来源白名单 | 否 | 2/6 | #29 | 已合并可清理（squash） |
| agent/pending-notice-fix | `512c877` 11-13 11:39 并发资料任务与中断回执 | 否 | 7/5 | #28 | 已合并可清理（squash） |

## 4. 远端 `agent/*`（11 个，全部已合并）

远端 tip 来自 `git ls-remote`。本地 `origin/agent/bili-reply-materials` 记录成 `41d200c` 是旧缓存，实际远端是 `a999b1e`；fetch refspec 只跟 main，导致其余 `origin/agent/*` 根本没拉下来。

| 远端分支 | tip | PR | 状态 | 判断 |
|---|---|---|---|---|
| agent/bili-asr-cloud | `67a3635` | #32 | MERGED | 已合并可清理（远端可删） |
| agent/bili-asr-local | `1ae4840` | #31 | MERGED | 已合并可清理（远端可删） |
| agent/bili-reply-materials | `a999b1e` | #26 | MERGED | 已合并可清理（远端可删） |
| agent/c1b-cloud-read | `c4863bd` | #27 | MERGED | 已合并可清理（远端可删） |
| agent/image-fetch-redirect | `e595981` | #29 | MERGED | 已合并可清理（远端可删） |
| agent/issue10-p2 | `dd0f9f3` | #14 | MERGED | 已合并可清理（远端可删） |
| agent/local-login-page | `7d12b22` | #12 | MERGED | 已合并可清理（远端可删） |
| agent/p2-stickers | `064e04e` | #7 | MERGED | 已合并可清理（远端可删） |
| agent/pending-notice-fix | `512c877` | #28 | MERGED | 已合并可清理（远端可删） |
| agent/sticker-followups | `16866b9` | #13 | MERGED | 已合并可清理（远端可删） |
| agent/vision-fix | `93cbfb4` | #15 | MERGED | 已合并可清理（远端可删） |

`agent/bili-media-enable`（PR #33）的远端分支已经删了，本地分支还在。

## 5. event-v2 分支关系

### 5.1 共同基线

五条 event 分支都从 `cd222c4`（PR #28 的合并提交，main 上的点）长出来，没有一个进过 main。

### 5.2 谁基于谁

```
cd222c4 (#28)
└─ M0: 9c98407 → 1b0414f
   └─ P-1..P-7: 8ec9bb3 → fed83a6
      └─ M1-S: 28e6823 → 681248c
         └─ 返工: 517abdb → 9a7ce63 → 21a76db   [event-v2-prog = 9a7ce63]
            ├─ M1-R 侧线: 89673dc → 779790a → 44c880f → 2010939
            │  └─ G4: 8e6e7f1（父 89673dc）        [event-v2-g4]
            │
            ├─ a03302a = merge(21a76db, 2010939)
            │  ├─ main 线: 39a1a38                  [event-v2-main]
            │  └─ fix 线: f636036 → 34e25f7         [event-v2-fix]
            │
            └─ 12262f9 = merge(a03302a, 34e25f7)
               └─ 693992e = merge(12262f9, 39a1a38) [event-layer-v2]
```

关键事实：

- `agent/event-v2-prog`（`9a7ce63`）是基础实现线：M0 + P-1..P-7 + M1-S + 两个修复。8 ahead。
- `agent/event-v2-main`（`39a1a38`）在 `21a76db` 之后合了 M1-R（`a03302a`），再带 P2 修复 `779790a`/`44c880f`/`2010939` 和文档 `39a1a38`；**没有** `f636036` 那套 121 条夹具。16 ahead。
- `agent/event-v2-fix`（`34e25f7`）同样在 `a03302a` 之后，加 `f636036`（121 条夹具）和 `34e25f7`（时间戳改运行期相对时间）；**没有** `39a1a38` 文档。18 ahead。
- `agent/event-layer-v2`（`693992e`）把 fix 线（`12262f9`）和 main 线（`39a1a38`）合到一起，因此**包含 fix + main 的全部提交**；相对 main 21 ahead / 4 behind。它比 main 少的最新 4 个提交是 #31/#32/#33 那批，不是 event 内容。
- `agent/event-v2-g4`（`8e6e7f1`）从 `89673dc` 分出，**早于** P2 修复、M1-R 合并、文档和夹具线；相对 layer 独有 **1 个提交**（`8e6e7f1`），缺 `779790a`/`44c880f`/`2010939`/`39a1a38`/`f636036`/`34e25f7`。

### 5.3 各 event 分支相对 layer 的独有提交

| 分支 | 相对 layer ahead/behind | 独有提交 |
|---|---|---|
| event-v2-prog | 0 / 13 | 无 |
| event-v2-fix | 0 / 3 | 无 |
| event-v2-main | 0 / 5 | 无 |
| event-v2-g4 | 1 / 9 | `8e6e7f1` |
| event-layer-v2 | — | 自身 21 个提交不在 main |

### 5.4 m1-r / m1-s / G4 报告说明做到哪一步

- `.agent/m1-s-final-report.md`（event-v2-main）：M1-S 本机实现与验收完成；`npm test` **847/847**，check/check:ui/config:check 通过；未做 M1-R，未提交、未推送、未部署；未实测真实 QQ 业务码/远程 D1 完整七条并发。
- `.agent/event-v2-m1r-report.md`：M1-R、G1–G3、部署前 P2 a/b 完成；全量 **894/894**，check/check:ui 通过；明确「没做」G4/G5、bili v2、push、部署、线上 D1、真实 QQ 发言（G4 后来由并行线程补上，见下一条）。
- `.agent/event-v2-m1r-review.md`（我这边的复审）：通过，无 P0/P1；P2 从 3 条收敛到 1 条（`view.ts` owner 为空的图注前缀），已由 `2010939` 修掉。未审 G4 夹具与 bili v2。
- `.agent/event-v2-g4-report.md`（在 `TeamAgent-event-v2-fix`）：G4 完成；88 收 + 33 发 = 121 条夹具；`npm test` **1025 项，1019 pass / 0 fail / 2 skip / 4 todo**；`npm run check` 通过；`npm run test:runner` 红 8F/31E，全在 gitsafe/repo_index/subagent，未改 runner，需交付员对照 main；报告自称「本轮工作区改动由交付员提交」。

### 5.5 G4 那 36 条未提交改动到底是什么

`git status --porcelain` 是 **36 条**：10 条 tracked（1 个测试文件改 + 9 个旧单对象夹具删除）+ 26 条 untracked 条目（`g4/`、`qq-send/` 两个目录按条目计；实际展开 39 个文件）。

- 18 个 `test/fixtures/events/E*.json` 数组夹具：与 `agent/event-layer-v2` **逐字节相同**（hash 对比 18/18 same）——layer 已有，是重复的。
- 9 个 `test/fixtures/events/g4/*.json`：从 `8e6e7f1` 根目录移入；其中 3 个逐字节相同，6 个把真实正文/引用替换成了「测试文本」（脱敏，符合 G4 报告）。layer 没有这 9 个文件，这是 G4 的独有价值。
- 5 个 `test/fixtures/qq-send/*.json` 与 layer 不同：G4 是固定毫秒时间戳（如 `1794564944740`），layer 是 `"now"` + 测试运行时展开。抽查 3 个都是 `created_at` 写法差异。`test/send-pipeline.test.mjs` 也少了 `timeValue`/`expand`。**整包提交会把 `34e25f7` 的时间戳修复回退**。
- 其余：`NOTICE`、`docs/qq-events.md`、`scripts/fixtures-from-d1.mjs`、`test/event-replay.test.mjs`、`test/fixtures/legacy/inbound-68ef1c3.ts` 与 layer 相同；`test/send-pipeline.test.mjs` 旧。
- 测试文件 `test/event-101-102-103-fixtures.test.mjs` 的改动是把读取目录改成 `events/g4/` 并跳过数组文件——这是消解重名的必要适配。

**合并建议**：只把 `test/fixtures/events/g4/` 9 个文件 + `test/event-101-102-103-fixtures.test.mjs` 的适配补到 layer；`qq-send` 和 `send-pipeline.test.mjs` 保留 layer 版本；18 个数组夹具不要重复提交。

## 6. 哪些提交还没进任何集成分支

当前仓库只有 `origin/main` 一个集成分支（本地/远端都没有 `release/*`）。按「内容不在 main」计，只有下列 24 个提交 + 1 组未提交改动：

### 6.1 event-v2（21 个，全部在 `agent/event-layer-v2`，均不在 main）

```
9c98407 feat: 定义事件层 v2 共享契约
1b0414f merge: 事件层 v2 M0 共享契约
8ec9bb3 feat: 统一 QQ 事件解析与引用媒体处理
fed83a6 merge: 事件层 v2 程序员 P-1～P-7
28e6823 feat: 发送状态机 M1-S（账本、租约、原子认领、错误分类）
681248c merge: 发送状态机 M1-S
517abdb fix: 修复事件正文重复与超长代码分段丢失
9a7ce63 fix: 修复空白正文回退并恢复引用总项数预算
21a76db merge: 事件层 v2 程序员 P-1～P-7 返工（终审通过）
a2b91fa test: 补充事件层 M1-R 接线与 G1–G3 回归测试
05ce889 feat: 接通事件层通知、转发素材与强制回应
89673dc test: 更新转发展示相关旧断言
779790a fix: 删除无消费者的 chunk_send 开关
44c880f fix: 作者前缀下去掉图注重复的「图片：」
2010939 fix: 无作者图注同样去掉重复的图片前缀
a03302a merge: 事件层 v2 M1-R（转发/notice/forceReply 接线）+ 小修
f636036 test: 补充事件层 v2 夹具与回放测试（121 条，D1 脱敏 + doc/synth）
34e25f7 test: 夹具时间戳改为运行期相对时间，避免窗口过期变红
39a1a38 docs: 核对 QQ 官方发送规则写入 codes.ts 注释
12262f9 merge: 事件层 v2 M0 夹具与回放测试（121 条）
693992e merge: 事件层 v2 M0 QQ 发送规则注释
```

另：`8e6e7f1`（G4 的 101/102/103 单对象夹具）只在 `agent/event-v2-g4`，不在 layer，也不在 main。

### 6.2 其他

- `2aaf2c1` — `agent/fix-delivery-legacy-receipt`，直接基于 `df11aa2`，1 ahead；工程师正在施工。盘点开始时是 `30b7ce9`，22:43 改写成 `2aaf2c1`。
- `407addc` — `agent/c1b-repo-files`，WIP 测试草稿；1 个独有提交（`6648bc2`/`fbfe9a8` 的 SHA 也不在 main，但内容已由 #25 合入）。
- `agent/login-fix` 工作区 6 个未提交文件（4 个 tracked 修改 + 2 个 untracked；untracked 的 `runner/native-x-browser.mjs`、`test/bili_login_errors_test.py` 在 main 已存在）。

### 6.3 不要误判

下面这些分支 tip 用 `merge-base --is-ancestor` 是 NO，但 PR 已 MERGED，内容已在 main，属于 squash 的正常结果：bili-answer-fields、bili-asr-cloud、bili-asr-local、bili-media-enable、bili-reply-materials、c1b-cloud-read、cap-c1、cap-c1-followup、cap-c3-runner、event 之外的 fastlinks-p0a/p0b、image-fetch-redirect、pending-notice-fix。`c1b-cloud-read` 还额外核对过：C1b 相关文件树与 #27 head 完全一致。

## 7. BINI 点名分支/副本逐项核对

| 名字 | 类型 | 在 main？ | PR | 判断 |
|---|---|---|---|---|
| p4b-login | worktree + 本地分支 | 是 | #8 | 已合并可清理 |
| p4ac-vision-web | 旧独立 clone（`/Projects/.worktrees/TeamAgent-p4ac-vision-web`） | 是（`bd47d28` = #3 merge） | #3 | 疑似废弃：旧 clone，clean，无 .agent |
| p2-stickers | 旧独立 clone | 是（`064e04e` = #7 head） | #7 | 疑似废弃：旧 clone，仅 `.agent/` 未跟踪 |
| sticker-followups | worktree + 本地分支 | 是 | #13 | 已合并可清理 |
| vision-fix | worktree + 本地分支 | 是 | #15 | 已合并可清理 |
| login-fix | worktree + 本地分支 | 分支是 | — | 疑似废弃：6 个未提交旧登录改动；同文件修复已由 #16 / `4e87f4e` 进 main，该版本未被采用 |
| local-login-page | worktree + 本地分支 | 是 | #12 | 已合并可清理 |
| issue10 | worktree + 本地分支 | 是 | #14 | 已合并可清理 |
| cap-c2 | worktree + 本地分支 | 是（`71deb11` = #24 merge） | #24（经 cap-c3-runner） | 已合并可清理 |
| c1b | worktree + `agent/c1b-repo-files` | 否 | — | 疑似废弃：WIP 测试草稿 |
| c1b-cloud | worktree + `agent/c1b-cloud-read` | 内容已合并 | #27 | 已合并可清理 |
| fastlinks-verify | detached worktree | 否（tip 是 #21 head） | #21 | 已合并可清理 |
| bili-answer-fields | worktree + 本地分支 | 否（squash） | #30 | 已合并可清理 |
| bili-fix | worktree，分支 `agent/bili-reply-materials` | 否（squash） | #26 | 已合并可清理 |
| TeamAgent-baseline-delivery-legacy | — | — | — | **当前不存在**：worktree list、`.git/worktrees`、本地/远端分支、`/Users/yanghongming/Projects` 目录都没有；只有 archive 里若干 `*baseline*.log` 是日志名。`agent/fix-delivery-legacy-receipt` 的 `30b7ce9`/`2aaf2c1` 父提交都是 `df11aa2`，不是从某个 baseline 副本长出来的 |

## 8. 5 个旧独立 clone（不在 worktree 列表）

这 5 个目录的 `--git-common-dir` 都是自己的 `.git`，是旧 clone，不是当前主仓的 worktree；它们的 tip 全部已在 main。

| 目录 | 当前分支 | tip | 对应 PR | 未跟踪 | 判断 |
|---|---|---|---|---|---|
| TeamAgent-p1-engage | main | `b40189d`（#6 merge） | #6 | `.agent/` | 疑似废弃（旧副本，可归档后删） |
| TeamAgent-p2-stickers | agent/p2-stickers | `064e04e`（#7 head） | #7 | `.agent/` | 疑似废弃（旧副本，可归档后删） |
| TeamAgent-p4ac-vision-web | main | `bd47d28`（#3 merge） | #3 | 无 | 疑似废弃（旧副本，可删） |
| TeamAgent-p4b-fetcher | main | `9b62fb6`（#5 merge） | #5 | `.agent/` | 疑似废弃（旧副本，可归档后删） |
| TeamAgent-teamagent-p0 | agent/teamagent-p0 | `f76f288`（#2 head） | #2 | 无 | 疑似废弃（旧副本，可删） |

另外 `Projects/TeamAgent-archive-20261113/` 下有 7 份 **只含 `.agent` 文档**的归档副本（cap-c1、cap-c1-followup、cap-c3、fastlinks、fastlinks-p0b、image-fix、pending-fix），不是 git 仓库。

## 9. 清理建议（均未执行，删文件需用户批准）

**A. 已合并、可清理（分支/ worktree / 远端）**
- worktree：p4b-login、bili-answer-fields、bili-asr-cloud、bili-asr-local、bili-fix、c1b-cloud、cap-c2、deploy-bili、fastlinks-verify、issue10、local-login-page、sticker-followups、vision-fix。
- 本地分支：上列 + bili-media-enable、cap-c1、cap-c1-followup、cap-c3-runner、fastlinks-p0a/p0b、image-fetch-redirect、pending-notice-fix。
- 远端：§4 的 11 个 `agent/*`。

**B. 不要删 / 不要清**
- `TeamAgent-event-v2`、`TeamAgent-event-v2-fix`、`TeamAgent-event-v2-fix-eng`、`TeamAgent-event-v2-main`、`TeamAgent-event-v2-prog`：event-v2 的唯一实现和证据。
- `TeamAgent-fix-delivery-legacy-receipt`：工程师正在施工。
- `TeamAgent-event-v2-fix` 的 36 条未提交改动：G4 成品，不是垃圾；等交付员按 §5.5 选择性提交。

**C. 疑似废弃，建议先归档 `.agent` 再删（需用户批准）**
- `TeamAgent-login-fix`（6 个旧登录改动）。
- `TeamAgent-c1b`（`407addc` WIP 测试草稿）。
- 5 个旧独立 clone（§8）。
- 7 份 archive 的 `.agent` 副本可保留，不占多少空间。

## 10. 证据与限制

- 关键命令：`git worktree list --porcelain`、`git for-each-ref`、`git merge-base --is-ancestor`、`git rev-list --left-right --count origin/main...<ref>`、`git cherry`、`git ls-remote`、`gh pr list --state all`、`git status --porcelain`、对 G4 文件做 `git hash-object` 与 `git rev-parse <ref>:<path>` 对比。
- 未跑测试/构建；G4 的 1025 项、M1-S 847、M1-R 894 都是报告里的数字，不是本次重跑结果。
- `fix-delivery` 分支在盘点过程中从 `30b7ce9` 改写成 `2aaf2c1`，说明工程师仍在活动；本报告以 22:52 的 `2aaf2c1` 为准。
- `TeamAgent-baseline-delivery-legacy` 没有找到任何磁盘、分支或 worktree 痕迹，无法给出 git 关系；如果它是别的机器/别的会话里的临时副本，需要提供路径才能核。
- 未改仓库内容：主 worktree `git status` 为 0；所有 worktree 中只有 `event-v2-fix`（36，G4 原有）和 `login-fix`（6，旧改动）非空，均为盘点前已存在。
