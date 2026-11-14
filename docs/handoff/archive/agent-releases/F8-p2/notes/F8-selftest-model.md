# F8-selftest-model（P2 小修）

- 2026-11-14 19:35 Sydney：从 origin/main 25e5094 开 worktree `.worktrees/TeamAgent-F8-selftest-model`，分支 `pkg/F8-selftest-model`；基线 `node --test test/imagegen-selftest.test.mjs` 5/5。
- 先写测试：默认 model 断言红（actual gpt-image-1，expected IMAGE_MODEL）；补 settings 优先级用例（原本已绿，作为回归）。
- 实现：`src/imagegen-selftest.ts:6` 导入 `IMAGE_MODEL`，删除本地 `DEFAULT_MODEL`；`:26`/`:28` 缺省用它，settings 仍优先。
- 验证：`node --test test/imagegen-selftest.test.mjs` 6/6；`npm run check` 绿；全量 `npm test` 2131 tests / 2120 pass / 1 fail / 10 skip，失败为 MG2 D1 预算断言，在干净 origin/main（25e5094）同样失败，与本包无关。
- 提交：`25ed808 fix(imagegen): selftest defaults to the current image model`（2 files, +44/-4）。未 push、未部署、未碰线上。
