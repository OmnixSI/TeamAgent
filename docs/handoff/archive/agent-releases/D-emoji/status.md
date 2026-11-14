# D-emoji 上线状态

- 状态：**已上线**
- 时间：2026-11-14 17:47 Sydney
- main：`a4d4f677e3c18fe92672123437e658622c9ccf23`（PR #49 squash）
- 本趟 Worker：`d26e7917-52a5-4a3c-a479-a99500bad5c9`（`a4d4f67`，17:42:43 部署）
- 当前线上：`3adfdf8` / Worker `14347135-0b0f-4c82-9f62-700940cdf043`（17:44:46 趟 C3 覆盖；C3 包含 `a4d4f67`，D-emoji 代码仍在）
- 回滚点：`1d13359d-cc65-4451-bc76-c8c4b9c6fcaf`（release `f2b7084`）
- 门槛：check / check:ui 干净；npm test 2109 / 2099 pass / 0 fail / 10 skip；真实消息回放通过
- 包范围：只含 `833a96b`；工程师第二个 commit `29bc9ec` 上线后才提交，另走一趟
- 公告：`release-notice:emoji` outbox rowid 320，17:45 入队，17:47 `sent`（HTTP 200）
- 线上识图：17:43 真实群消息 `emoji_note` job done，`image_notes` 新增 1 条（DeepSeek flash，sticker_like=1）；`faceType=1/6` 部署后尚无新入站，待下一条真实小黄脸/超级表情只读复查
- 详情：`.agent/releases/D-emoji/notes/deliver.md`

## D-emoji2（引用图 / 跨批次识图，2026-11-14 17:56 Sydney）

- 状态：**已上线**
- main：`20220a1ea570cef215abc5f98c5bafc2fe3e06ec`（PR #51 squash，基线 `3adfdf8`）
- 本趟 Worker：`38772185-9711-45b2-9d70-3c3cac789a83`
- 回滚点：`14347135-0b0f-4c82-9f62-700940cdf043`（`3adfdf8`）
- 包范围：`e1c2b59` + `29bc9ec` + `f81bbe1`（cherry-pick 到 `3adfdf8`，无冲突）
- 门槛：check / check:ui 干净；npm test 2130 / 2120 pass / 0 fail / 10 skip；回放 11 例通过（引用图 r518、普通图 r480、跨批次 r502；QQ 发送 0、线上 D1 写入 0）
- 数据库：`vision_events` 已建表，线上 `COUNT(*)=0`（`VISION_EVENTS=1` 才写）
- 本机：6 服务 running；无 runner 文件改动，未跑 `install-local.py --apply`，media plist 未动
- 公告：`release-notice:emoji2` outbox rowid 326，17:56 入队；17:59 `sent`（HTTP 200，同键 1 行；首插 created_at 单位误用秒被标 skipped，改毫秒后同 rowid 发出）
- 未验证：部署后尚无新的线上引用图/跨批次真实触发；能力依据为本机真实消息回放
- 详情：`.agent/releases/D-emoji/notes/deliver2.md`
