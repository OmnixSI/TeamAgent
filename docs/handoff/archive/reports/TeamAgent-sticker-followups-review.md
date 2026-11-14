# 表情暂停计数修复复核（cc85ac1，基线 057bb8f）

结论：通过（无 P0/P1；2 条 P2）。

测试：`npm run check`、`npm test` 387/387、`npm run test:runner`（Python 37 + fetcher 48）、`npm run check:ui` 全绿；`test/stickers.test.mjs` 当前 30/30。
① 清零逻辑：`sendSticker` 的 result batch 维护 `sticker_fail`，第三次失败后第二个 batch 原子写 `sticker_paused_until` 并把 `sticker_fail` 归零；暂停中 `stickerSendOn` 直接标 skipped，不读写计数；到期（now>until）后从 1 重新累计，3 次再次暂停。S11b 与新回归均通过；`sticker_fail` 只在 `sendSticker` 读写，`stickerSendOn` 只读 `sticker_paused_until`，无遗漏读者。
② 回归有效性：worktree 外副本换回 057bb8f 的 `src/stickers.ts`，S11b、新 three-attempt 周期、D1 计数三条变红；恢复当前后全绿。
③ 文档：`off:sticker_send`/`off:sticker_collect`/`sticker_paused_until`、`id LIKE '%~s'`、`sticker`/`sticker-tag`、`stickers` 表、`stickers.caps.send/tag` 与 `config:check` 均与代码一致。

P2-1：计数递增（result batch）与暂停+清零（第二个 batch）是两次 D1 调用；若中间进程中断，会留下 `sticker_fail=3` 但无 `paused_until`，下一次失败才暂停（多一次失败，不丢暂停）。可合并 SQL 或接受边界。
P2-2：回滚文档“恢复发送删除 `off:sticker_send`”未提 `sticker_paused_until`；若它仍在未来 24h 内，重新启用后发送仍被抑制，建议写明等待或一并清除。
P2-3：“清空表情…及富媒体缓存”的 `DELETE FROM stickers` 只清 stickers（含 file_info）；`media_notes` 不属表情专属、未清；若文档意指 media_notes 需澄清。

未验收：QQ 真实富媒体上传/发送；本次只审代码与测试。
