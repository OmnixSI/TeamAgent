# vision-fix b68820e 复核（基线 057bb8f）

结论：通过（无 P0/P1；3 条 P2）。
测试：`npm run check`；`npm test` 397/397；`vision-failures` 11/11；旧 057bb8f + 新测试 VF1/VF2/VF10/VF11 全红，现版全绿。
1) face：`withoutFaces` 去标签、`hasFace` 传 explicitFace；269KiB 无正文进候选；2MB/带正文因 `max_bytes`/hasText 拒绝；400KB 下载上限保留。改对。
2) 超时：`untilAbort` 包 fetch/body/read/describe，abort 监听 + finally；VF5 stalled body 25ms 取消、<500ms 返回。改对。
3) 诊断：`reportVision` 仅 stage/status/reason/http/mime/bytes/elapsed/traceId；VF4 断言无 URL/QQ/header。改对。
4) 展示：`applyImageOutcomes` 把安全原因映射到 imageNotes，引用图也替换；VF8/VF11 覆盖；群内无内部细节。改对。
5) 回归：旧代码 VF1/VF2/VF10/VF11 红，新代码 11/11，抽查成立。

P2-1：`explicitFace` 且附件 `size` 缺失时仍进 sticker 候选；2MB 图最终在下载 400KB 上限被拒（不误存，多一次 job）。
P2-2：旧 `imagePicks` 回退「图片（未分析：没有可用结果，原因未记录）」偏笼统、像内部话术；老数据仍会显示。
P2-3：各阶段 `console.info` 量大；无敏感字段，但高频图片群建议只按失败或采样输出。
未验收：QQ 真机表情/2MB 图、线上日志量。
