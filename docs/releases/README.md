# 版本说明

每个大版本发布前更新这两处，两处文字逐字一致：

1. `docs/releases/<版本>.md`：只写一行，就是群里的说明文字，不超过 60 字（版本名如 `V-A.md`）。
2. `src/release-note.ts`：`RELEASE_NOTE.version` 改成该版本，`text` 改成同一行。

上线后每个群的下一次被动回复末尾附一次，同群同版本只附一次；要关就打开开关 `off:release_note`。
`npm run verify:release` 会按 `RELEASE_NOTE.version` 检查对应文件存在、正好一行、不超过 60 字。
