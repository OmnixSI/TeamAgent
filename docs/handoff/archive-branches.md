# 2026-11-14 归档的本地分支

编队留下的、`main` 里没有的本地分支，全部挂在 `archive/2026-11-14` 分支的归档提交下（GitHub 不保存这么多分支，所以合成一个提交保留它们）。

恢复某条：`git fetch origin archive/2026-11-14 && git switch -c <新分支名> <下表的提交号>`

| 原分支 | 提交 | 最后提交（悉尼） | 说明 |
|---|---|---|---|
| `TeamAgent-f5e-deploy` | `6a59d1301a12` | 11-14 01:49 | fix: 放行缓存仓库生成方案并将 list_repos 视为� |
| `agent/bili-answer-fields` | `fe7be588c41e` | 11-13 14:12 | fix: 保留B站回答中的已读视频字段 |
| `agent/c1b-cloud-read` | `e7f52e487d30` | 11-13 10:11 | fix: C1b 复核 P2（嵌套 .git、Bearer/base64 脱敏、� |
| `agent/c1b-repo-files` | `407addce8503` | 11-13 09:18 | WIP: 保存 C1b 测试草稿与共用 DENY 夹具 |
| `agent/cap-c1` | `adcdd16fbd0e` | 11-13 04:48 | fix: block repository-configured programs during read-only i |
| `agent/cap-c1-followup` | `fbfe9a8a07b3` | 11-13 08:43 | fix: 补齐仓库索引脱敏与进程回收回归 |
| `agent/cap-c3-runner` | `5b830b0fb7c5` | 11-13 05:33 | test: 修复 C3 rebase 后的隔离 Git 夹具 |
| `agent/event-layer-v2` | `693992e59afd` | 11-13 21:35 | merge: 事件层 v2 M0 QQ 发送规则注释 |
| `agent/event-v2-fix` | `34e25f7fd56d` | 11-13 21:29 | test: 夹具时间戳改为运行期相对时间，避免窗 |
| `agent/event-v2-g4` | `8e6e7f1060f0` | 11-13 21:09 | test: 补充事件层 101/102/103 真实样本夹具与回� |
| `agent/event-v2-main` | `39a1a386643b` | 11-13 21:25 | docs: 核对 QQ 官方发送规则写入 codes.ts 注释 |
| `agent/event-v2-prog` | `9a7ce63320c0` | 11-13 15:22 | fix: 修复空白正文回退并恢复引用总项数预算 |
| `agent/fastlinks-p0a` | `060a961fb51c` | 11-13 00:12 | fix: 修正文内错误引用误杀与三链接总截止 |
| `agent/fastlinks-p0b` | `2ae6f5928b55` | 11-13 01:31 | docs: 修正 P0b D1 预算数据来源说法 |
| `agent/fix-delivery-legacy-receipt` | `2aaf2c18d973` | 11-13 22:43 | fix: 兼容无 id 的旧交付回执并校验上报请求 |
| `backup/F9-reader-004afae` | `004afae96d74` | 11-14 19:32 | fix: 超时路径先杀掉读取器自己启动的浏览器� |
| `pkg/B-f9-3` | `2095dee5672a` | 11-14 14:46 | fix: keep the reach contract importable from the flat runner |
| `pkg/B-f9-4` | `6ad3443ce82d` | 11-14 14:37 | feat: read X threads, profiles, timelines and search after l |
| `pkg/B-f9-5` | `960d86aa6eca` | 11-14 14:51 | fix: detect the flat reach CLI through symlinked paths |
| `pkg/C-f91` | `81c71a6ebaeb` | 11-14 17:37 | feat: port Tencent stock quote tool to main (F9-1) |
| `pkg/D-D0` | `09be5b8ec10b` | 11-14 17:53 | test(db): cover D0 migrate, generated columns and audit |
| `pkg/D-D1` | `f5dc9272c3cd` | 11-14 18:10 | feat(records): add records core, tools and records authoriza |
| `pkg/D-D2` | `2a71619cd3ff` | 11-14 18:15 | feat(schedule-parse): add D2 Chinese time parser with DST-sa |
| `pkg/D-D3a` | `5664c0e5a48e` | 11-14 18:28 | feat(actions): implement read-only step runner and note comp |
| `pkg/D-D3b` | `f272810fc846` | 11-14 18:18 | fix(schedules-tools): keep updates from inventing an agent_t |
| `pkg/D-D4` | `043bac60a74e` | 11-14 19:31 | merge: D4 stage 2 (intent wiring, schedule v2, ledger tools) |
| `pkg/D-D5` | `490f04412419` | 11-14 18:27 | feat(skills): add read-only skill recipes and four tools |
| `pkg/D-D6` | `0aae6f33fa5f` | 11-14 18:04 | fix(run): deny execution when the turn's cleanliness is unpr |
| `pkg/D-D8` | `17d146a42c46` | 11-14 18:37 | style(desk): align table widths and meta typography with ui- |
| `pkg/D-D9` | `37645121b8b7` | 11-14 18:40 | test(d-accept): wire real agent replay and DB assertions for |
| `pkg/D-F11c` | `7fafb920d7dd` | 11-14 18:26 | feat(fr): add gated consume script with per-order worktrees  |
| `pkg/D-emoji` | `f81bbe1d0544` | 11-14 17:47 | feat(vision): add opt-in vision event log |
| `pkg/DS-live-verify` | `f496321cd487` | 11-14 14:09 | test(ds-live): allow custom synthetic TTS text without long  |
| `pkg/F11-FR-1` | `68749ef3ba3b` | 11-14 02:51 | test(feature-request): cover FR-1 gates, migration and confi |
| `pkg/F11-FR-2` | `899c9a214dab` | 11-14 02:55 | feat(feature-request): gate semantic intake and persist boun |
| `pkg/F11-FR-3` | `7bf6ac7c44e6` | 11-14 02:55 | feat(feature-request): add studio API, CAS transitions and r |
| `pkg/F11-FR-4` | `b3c63e49ded4` | 11-14 02:54 | feat(feature-request): add studio pull and report scripts |
| `pkg/F11-FR-5` | `405965f3a1e9` | 11-14 03:04 | test(feature-request): tidy acceptance evidence punctuation |
| `pkg/F6-1` | `fd735ef250f4` | 11-14 01:20 | feat: discover organisation repositories from repo_cache |
| `pkg/F6-2` | `e9e32177a2e9` | 11-14 01:35 | feat(deploy): sync optional GITHUB_TOKEN from GITHUB_TOKEN_F |
| `pkg/F6-3` | `3c7a2d734b89` | 11-14 01:20 | fix: explain tool failures and audit bounded recovery |
| `pkg/F6-4` | `b1758bff8819` | 11-14 01:16 | feat: generate truthful capability card from deployed tools |
| `pkg/F6-5` | `afe9d6a883be` | 11-14 01:16 | fix: guard addressed replies and recover missed mentions |
| `pkg/F6-6` | `b4ef714caec8` | 11-14 01:19 | fix: redact schedule tool failure details |
| `pkg/F6-7` | `320d7ff6af46` | 11-14 01:23 | fix: route image understanding through Workers AI |
| `pkg/F6-8` | `054e592fe67b` | 11-14 01:28 | fix: label exhausted attachments as needing attention |
| `pkg/F6-9` | `ae729d7323f8` | 11-14 01:19 | refactor: cancel stop jobs in one bounded update |
| `pkg/F6P-1` | `f855fc7b6dee` | 11-14 02:21 | feat: 看图主链路改为 DeepSeek，Workers AI 降级并� |
| `pkg/F6P-2` | `3c3d90a19043` | 11-14 02:25 | fix: 修复文件交付重试上界并加入 outbox 补发 d |
| `pkg/F6P-3` | `40d3a6467d71` | 11-14 02:24 | feat: 日推建成 08:00 日程与 owner 创建入口 (F6P-3 |
| `pkg/F7-accA` | `b88b4b6004dd` | 11-14 01:44 | merge: pkg/F7-13 into release/F7 |
| `pkg/F7-accB` | `a39c35aee30e` | 11-14 01:59 | fix: capability card keeps every tool row within 1200 chars  |
| `pkg/F8-0` | `5210fa2c56ea` | 11-14 01:55 | feat: add shared OpenAI channel with accounting and quota re |
| `pkg/F8-1` | `af2a5a9fe437` | 11-14 02:03 | feat: generate JPEG images through OpenAI and deliver QQ ric |
| `pkg/F8-2` | `e807306f1b4f` | 11-14 01:57 | feat(tools): add generate_image with quota, taint refusal an |
| `pkg/F8-3` | `b52c5cdfb42a` | 11-14 01:59 | feat: add image generation selftest and OpenAI secret sync |
| `pkg/F8-4` | `de13b084b4f8` | 11-14 02:00 | feat: keep capability card within 1200 chars for F7/F8 tools |
| `pkg/F8-5` | `fa6ab58393a6` | 11-14 02:21 | test: add F8-5 image acceptance replays |
| `pkg/F8-M-A` | `524c7d811505` | 11-14 01:55 | fix: restore async MCP tool discovery in agent tool list |
| `pkg/F8-V1` | `7c0f2796ef45` | 11-14 02:06 | feat: add Luna vision provider with isolated cache and deadl |
| `pkg/F8-V2` | `99c69a069ab9` | 11-14 02:10 | feat: cache inbound images before QQ links expire (F8-V2) |
| `pkg/F8-V3` | `8c5e4e47faac` | 11-14 01:48 | merge: release/F7 into main c612431 (F7 toolkit + 12 package |
| `pkg/F9-1` | `891ced8387e8` | 11-14 02:10 | feat: add Tencent stock quote tool for F9-1 |
| `pkg/F9-2` | `c51c9cf2ac78` | 11-14 02:21 | feat: add read-only social reader skeleton |
| `pkg/F9-3` | `8c5e4e47faac` | 11-14 01:48 | merge: release/F7 into main c612431 (F7 toolkit + 12 package |
| `pkg/F9-4` | `8c5e4e47faac` | 11-14 01:48 | merge: release/F7 into main c612431 (F7 toolkit + 12 package |
| `pkg/F9-5` | `8c5e4e47faac` | 11-14 01:48 | merge: release/F7 into main c612431 (F7 toolkit + 12 package |
| `pkg/F9-reader-timeout` | `0639a3bc01e8` | 11-14 19:58 | fix(reach): reap the reader's browser on a hard timeout |
| `pkg/F9DS-0` | `e98b4cd7fe69` | 11-14 02:15 | feat: add shared DeepSeek tools channel with accounting and  |
| `pkg/F9DS-1a` | `5877644ca9c7` | 11-14 02:35 | chore: require the live silk sample path from the environmen |
| `pkg/F9DS-1b` | `98be0699b4fe` | 11-14 02:20 | feat: add bounded cloud ASR with local audio fallback |
| `pkg/F9DS-2a` | `d287a01c614f` | 11-14 02:23 | chore(deps): pin silk-wasm 3.7.1 for runner voice conversion |
| `pkg/F9DS-2b` | `826c56699efc` | 11-14 02:22 | feat: wire policy-controlled voice replies through QQ gatewa |
| `pkg/F9DS-3` | `732629c5fd5d` | 11-14 02:24 | refactor: drop unused read_image_text constant and column |
| `pkg/F9DS-4` | `f9817ea00c31` | 11-14 02:26 | merge: release/F9DS into pkg/F9DS-4 |
| `pkg/F9r` | `0fa942a3bc58` | 11-14 19:15 | fix: read the zhihu hot list from the public web feed |
| `pkg/V-A-A1b` | `8e74a6017264` | 11-14 01:21 | fix: merge chat cursor reads into the message query |
| `pkg/V-A-A2` | `203ff3dcebe0` | 11-14 00:25 | feat(bili): align note text with main subtitle and ASR outpu |
| `pkg/V-A-A3` | `d851a67a3701` | 11-14 00:59 | fix: deduplicate concurrent image analysis within a turn |
| `pkg/V-A-A4` | `fa44a422f5ca` | 11-13 23:53 | feat: per-group one-time release note on passive replies |
| `pkg/V-A-g4` | `53a9aeb34fd3` | 11-13 23:50 | test: import G4 single-object fixtures 101/102/103 |
| `pkg/V-B-B1` | `fe6ef73764bb` | 11-14 00:17 | feat: add leased read-only subagent worker core |
| `pkg/V-B-B1t` | `8bdfd15ffc56` | 11-13 23:56 | test: add red D-1..D-26 subagent tests |
| `pkg/V-B-B2` | `28a2d66a6e86` | 11-13 23:58 | feat: add C2 capability layer |
| `pkg/V-B-B4r` | `69e1767254dd` | 11-14 00:29 | feat: snapshot runner task progress each round |
| `pkg/V-B-B5` | `47dfc82ee3da` | 11-14 00:35 | feat: isolate runner home and start subagent loop |
| `pkg/V-B-B6` | `35b3efad29ce` | 11-14 00:06 | merge: pkg/fast-hardening-F2c |
| `pkg/V-B-probe` | `53dba4977465` | 11-13 23:53 | docs: record isolated DSH reader probe credential blocker |
| `pkg/V-C-C1b` | `ac7dc3f9c099` | 11-14 01:31 | fix: isolate Bilibili ASR and audio jobs by page |
| `pkg/V-C-C1f` | `ae590211d535` | 11-14 01:08 | fix: isolate paged fetch reports and resource caches |
| `pkg/V-C-C2` | `81bbbac36733` | 11-14 00:03 | feat: parse Bilibili card ids and sample card payloads |
| `pkg/V-C-C3` | `df0555f27fdc` | 11-14 01:05 | feat: map chat messages to their Bilibili fetch results |
| `pkg/V-C-C4b` | `e64921f02cb6` | 11-14 01:46 | feat: prefetch bilibili links from plain messages and bare m |
| `pkg/V-C-C5r` | `ce10a3bb575b` | 11-14 00:33 | feat: 唤醒抓取并自适应轮询，B 站搜索风控退� |
| `pkg/V-C-C5w` | `557165ab3873` | 11-14 01:01 | feat: wake video waits at their shared deadline |
| `pkg/V-C-C6` | `9a35ccad9b9e` | 11-14 00:03 | fix: verify local login lock owners and settle late QR polls |
| `pkg/V-C-C7` | `d75836db5963` | 11-14 01:04 | fix: scope the Bilibili range header to Bilibili URLs |
| `pkg/V-D-D1` | `ff0a3382359a` | 11-14 01:33 | test(review): allow replay directory override in data checks |
| `pkg/V-D-D10a` | `3680bcb243c9` | 11-14 02:04 | test(review): add 76-item acceptance runner and replay matri |
| `pkg/V-D-D10b` | `1eb9be067dcc` | 11-14 02:42 | test(review): unblock D-5a/D-6/D-8 acceptance with fake judg |
| `pkg/V-D-D12` | `d9146d87d2ac` | 11-14 03:16 | fix(ui): address D-12 visual review and D-6c fields |
| `pkg/V-D-D2` | `2559e37bf448` | 11-14 01:24 | test(review): v2 enum snapshots, CATALOG_VERSION, migrate li |
| `pkg/V-D-D3` | `59893eeb129a` | 11-14 01:37 | feat(review): build v2 inbound/outbound traces with provenan |
| `pkg/V-D-D4` | `1cd707a9df75` | 11-14 01:49 | fix(review): cap judge batches using D-0b measurements |
| `pkg/V-D-D5a` | `af4fb558b885` | 11-14 02:06 | feat(review): implement D-5a apply and publish |
| `pkg/V-D-D5b` | `6efbf203b476` | 11-14 01:37 | fix(review): enforce v2 rule admission and atomic memory app |
| `pkg/V-D-D6` | `0d471ec28e14` | 11-14 02:39 | fix(review): bound nightly audit work and resume unfinished  |
| `pkg/V-D-D6c` | `40f507064ed0` | 11-14 02:52 | feat(review): expose health controls and evidenced memory ca |
| `pkg/V-D-D8` | `08e4cc9cdf42` | 11-14 02:21 | feat(review): add D-8 backlog pull and morning report |
| `pkg/V-D-D9` | `16c43b9fc4e9` | 11-14 03:01 | test(review): add deterministic capability probes and gap co |
| `pkg/V-D-authz` | `418254d3c598` | 11-14 03:52 | fix(authz): keep WORK_ACTION unchanged; use 整理 in label  |
| `pkg/cleanup-at-source` | `f2fd395deb68` | 11-14 18:59 | chore(test): 测试与回放临时目录统一 teamagent-tes |
| `pkg/fast-hardening-F2a` | `f9e0563f50a6` | 11-13 23:53 | fix: harden local unlock credentials and shared deny policy |
| `pkg/fast-hardening-F2b` | `0a7889180bfe` | 11-13 23:57 | fix: unify empty-comment wording and keep bili answer rule o |
| `pkg/fast-hardening-F2c` | `0347078b1cf9` | 11-14 00:01 | fix: reject filler-only ASR as no speech |
| `pkg/fast-hardening-F2d` | `1415649ade8a` | 11-13 23:55 | fix: treat sticker send redirects as failures |
| `pkg/fast-lane-F4` | `a6641d2d57e8` | 11-14 00:19 | fix: scope chat_cursor per group with legacy migration |
| `pkg/fast-lane-F5a` | `d642011024cb` | 11-14 00:57 | feat: index every pushed branch and project worktree |
| `pkg/fast-lane-F5b` | `cb25916a4fd0` | 11-14 00:51 | fix: require a local match before repo_file fallback answers |
| `pkg/fast-lane-F5c` | `f6bcaba4cf7b` | 11-14 00:52 | feat: keep read-only repo tools for repository activity ques |
| `pkg/fast-lane-F5d` | `7d9dd25bd944` | 11-14 01:23 | feat: discover cached organization repositories in chat |
| `pkg/fix-resend` | `da899238f50a` | 11-14 02:35 | fix: enforce expiry at queue and outbox claims |
| `pkg/hotfix-bili-shortlink` | `9926974d66e2` | 11-14 02:33 | fix: limit bare-@ link inheritance to the two minutes before |
| `release/B-f9` | `57f45229370c` | 11-14 14:51 | fix: detect the flat reach CLI through symlinked paths |
| `release/D` | `043bac60a74e` | 11-14 19:31 | merge: D4 stage 2 (intent wiring, schedule v2, ledger tools) |
| `release/F11` | `405965f3a1e9` | 11-14 03:04 | test(feature-request): tidy acceptance evidence punctuation |
| `release/F6` | `49c778491f12` | 11-14 01:39 | test: commands status tests drop schedules/turn_tools now sh |
| `release/F6P` | `354928360705` | 11-14 02:40 | Merge branch 'pkg/F6P-3' into release/F6P |
| `release/F7m` | `524c7d811505` | 11-14 01:55 | fix: restore async MCP tool discovery in agent tool list |
| `release/F8` | `fa6ab58393a6` | 11-14 02:21 | test: add F8-5 image acceptance replays |
| `release/F9` | `8c5e4e47faac` | 11-14 01:48 | merge: release/F7 into main c612431 (F7 toolkit + 12 package |
| `release/F9DS` | `22c904ae224d` | 11-14 02:40 | fix: move voice-out report to /voice-outbox/report (collided |
| `release/V-A` | `2d6611a339bf` | 11-14 01:27 | merge: pkg/V-A-A1b into release/V-A |
| `release/V-C` | `d9a0f77087cf` | 11-14 01:52 | merge: pkg/V-C-C4b into release/V-C |
| `release/V-D` | `d724ffc83527` | 11-14 10:15 | fix(authz): whitelist full task labels before splitting at a |
| `release/fast-hardening` | `b5fa5cd27de6` | 11-14 00:54 | Merge remote-tracking branch 'origin/main' into release/fast |
| `release/fast-lane-F5` | `f005395b72e5` | 11-14 01:27 | merge: pkg/fast-lane-F5d |
| `release/trip0` | `b64970d67edc` | 11-14 02:42 | Merge remote-tracking branch 'origin/main' into release/trip |
| `wip/agent-event-v2-g4-20261114` | `25eaa0608af4` | 11-14 20:04 | WIP snapshot of agent/event-v2-g4 (uncommitted work at hando |
| `wip/agent-login-fix-20261114` | `ce3cdd7469f0` | 11-14 20:04 | WIP snapshot of agent/login-fix (uncommitted work at handoff |
| `wip/pkg-D-D4-20261114` | `28f8efbc742f` | 11-14 20:04 | WIP snapshot of pkg/D-D4 (uncommitted work at handoff, 2026- |
| `wip/pkg-F8-2-20261114` | `f925bd00faca` | 11-14 20:04 | WIP snapshot of pkg/F8-2 (uncommitted work at handoff, 2026- |
| `wip/pkg-F8-3-20261114` | `40600c8a1dd5` | 11-14 20:04 | WIP snapshot of pkg/F8-3 (uncommitted work at handoff, 2026- |
| `wip/pkg-V-B-B6-20261114` | `e4f6bc3b5237` | 11-14 20:04 | WIP snapshot of pkg/V-B-B6 (uncommitted work at handoff, 202 |
| `wip/release-F7m-20261114` | `0e2c02bcf0be` | 11-14 20:04 | WIP snapshot of release/F7m (uncommitted work at handoff, 20 |
