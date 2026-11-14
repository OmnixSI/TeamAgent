# pkg/cleanup-at-source 进度笔记

- 2026-11-14 18:45 Sydney · 开工仪式：worktree `.worktrees/TeamAgent-cleanup-at-source`，分支 `pkg/cleanup-at-source`（基于 origin/main 20220a1）。基线 `npm test` 2119 过 / 1 失败（vision-openai V2 时间敏感，单跑通过）/ 10 skip。
- 18:50 · 审计 runner 落地文件：media.mjs、docread-job.mjs、voice.mjs、tts.mjs、silk.mjs、cloud-asr.mjs 都已在 finally 删自己的目录；缺的是「被杀/崩溃后的遗留清理」和总量上限。media-tmp/voice-tmp 只有 media 自己的 sweepLocal 管，doc-tmp、tts-cache、silk 临时目录、/tmp 卡片样本没人扫。
- 19:00 · 新增 `runner/tmpclean.mjs`：白名单根（media-tmp 1h、voice-tmp 1h、doc-tmp 24h、tts-cache 24h、card-samples 24h、$TMPDIR 的 f9ds-silk-/teamagent-test-/旧前缀），总量上限 500MB 超限删最旧；media.lock 持有时 cap 不动 media-tmp；符号链接不跟随；配置/state/secrets/results/node_modules/xasr-venv/models 永不进入。
- 19:05 · 接线：fetcher.mjs 启动扫一次 + 每小时；media.mjs 启动按小时闸门扫（launchd 每分钟拉起，用 state/tmpclean.json 记录）。
- 19:10 · 测试 `test/tmpclean.test.mjs` 15 例：失败也清（media/docread）、超时也清、TTL 过期清、新鲜保留、cap 删最旧、grace 内不动、media 锁保护、配置/游标/令牌/依赖/模型不误删、符号链接不跟随、旧前缀回收、启动+每小时+重叠跳过+小时闸门。另加 `test/tmp.mjs` 统一前缀 + t.after。
- 19:15 · 测试/回放脚本统一前缀 `teamagent-test-`（41 个文件一行改动），旧前缀保留一版在 sweep 里。
- 19:20 · `npm run check` 绿、`npm run check:ui` 绿、`node --test runner/test_fetcher.mjs` 79/79。`npm run test:runner` 的 Python 部分在本机预存失败（pristine worktree 同样 8 failures+64 errors，环境问题，未改任何 .py）。
- 19:30 · 最终版：`npm test` 2135 过 / 0 失败 / 10 skip；`npm run check` 绿；`npm run check:ui` 绿；`node --test runner/test_fetcher.mjs` 79/79。
- 19:35 · 提交：d4e8a75 test / 3a99032 feat / f2fd395 chore（分支 pkg/cleanup-at-source，基于 origin/main 20220a1）。未 push、未部署、未重启 launchd。
- 19:36 · 实跑 sweeper（home=~/.inkboard-team, tmp=$TMPDIR）：44 个今天的测试目录 195MB，全部未过 24h TTL，0 删除；media-tmp/voice-tmp/doc-tmp 空，tts-cache 1.1MB。
- 19:38 · 清理本 worktree 的 node_modules(241M)+.wrangler(427M)，现 8.9M；worktree 干净。
