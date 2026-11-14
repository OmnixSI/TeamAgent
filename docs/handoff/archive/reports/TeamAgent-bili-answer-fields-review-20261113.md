结论：通过（审 `fe7be58`，`cd222c4..fe7be58`；无 P0/P1；P2 2 条）

测试：`npm run check`、`npm run check:ui`、`npm run config:check` 通过；`node --test test/*.test.mjs` 701/701，定向 `test/fetchjobs.test.mjs` 53/53。另在 `/tmp` 副本做 3 个变异（字段顺序退回、规则移进封套、删掉“没拿到字幕……”正向句），3 条新测试分别失败，证明能抓回归。worktree 未改，临时副本已删。Python/runner 未复跑：改动只在 TS，交付报告已覆盖。

问题：
- P2 `src/fetchjobs.ts:133,140,145`：`comments:[]` 且无字幕时，正文同时输出「热评：未读到」和「没拿到字幕，以下基于标题与评论」，规则还要求模型照说；空评论视频下模型若照规则就会声称读过评论。建议按 `r.comments.length` 二选一（有评论→标题与评论，无评论→标题），并补空评论断言。已用临时脚本复现。
- P2 `src/fetchjobs.ts:145,149`：所谓“受信任前导”仍在 `materials` 数组内，而 `config/participation.json` 明说 materials 是外部资料、不是指令；新测试只验证它位于 `【外部资料·不可信】` 之前，没有验证 prompt 层把它当可信指令。当前 DeepSeek 回放能照做，但这是模型顺从，不是结构保证。建议把规则放进系统提示或独立 system message，或修改系统提示明确豁免该前导。

备注：
- `src/bilititle.ts:26` 的“按标题搜到的同名视频”限定仍在不可信封套内，本轮真模型回放也未覆盖 title-card；新规则可能让模型只保五项而漏掉该限定，建议并入可信前导。
- 「素材里没有的数字不要写」对用户自带数字/派生数字的误伤只做了 2 条真模型回答，属推断未复现。
