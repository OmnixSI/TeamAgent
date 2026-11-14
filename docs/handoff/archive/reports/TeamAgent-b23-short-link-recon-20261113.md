# TeamAgent B 站短链读取侦察（main 210ed47，线上 Worker 71deb11）

结论：`b23.tv` 的普通视频短链当前能解析；真正读不到的高概率是 `bili2233.cn` 等别名未进白名单，以及短码/最终跳转被限制。模型随后按 P0b 的失败原因转述成“读不了”。

1. **完整路径**：`parseInbound` 扫描消息 → `scanBiliPayload` 只接受 `b23.tv`、`bilibili.com` 域名（`src/bili-links.ts:15,19`）→ `extractBili` 只把 `b23.tv` 首段当 short（`src/inbound.ts:79,93,48-51`）→ `refIn`/`videoTarget` 取 short（`src/fetchjobs.ts:28-30,37-52`）→ `requestBili` 校验 4–12 位字母数字并建 fetch job（`src/fetchjobs.ts:26-29,84-87`）→ fetcher `biliLight` 调 `resolveShort`（`runner/fetcher.mjs:134-136`）。
2. **解析器边界**：`resolveShort` 最多 3 跳，只允许最终落到 `www.bilibili.com`/`m.bilibili.com` 且路径含 `BVxxxxxxxxxx`；bangumi/live/read/av 等最终页返回 `unsupported`（`runner/fetcher.mjs:111-122`）。`SHORT` 正则仅 4–12 位字母数字（`:18`），带 `-`/`_` 或更长的码会在 `requestBili` 前被拒。
3. **只读实测**：`curl -sIL https://b23.tv/UIm520q` 返回 302 到 `https://www.bilibili.com/video/BV1irWP6PExT?...&p=1...`；`resolveShort('UIm520q')` 返回 `BV1irWP6PExT`，说明普通 b23 视频链当前可用。
4. **bili2233 实测**：`curl -sIL https://bili2233.cn/UIm520q` 同样 302 到 `BV1irWP6PExT`，但 `bili-links.ts:15,19` 和 `inbound.ts:48` 不认该域名，消息在入站阶段就没有 `bili.short`，后续不会请求 fetcher。
5. **失败文案来源**：P0b 的 `biliFailReply`/`biliFailMaterial` 按 `reason` 生成“不是普通视频/读不到”等（`src/linkfail.ts:21-36`）；`unsupported` 明确写“可能是直播、专栏或动态，我目前只能读 B 站视频”。这不是模型凭空说“读不了”，但用户会听到失败结论。
6. **最小修法**：在 `bili-links.ts` 与 `inbound.ts` 增加官方短链别名（至少 `bili2233.cn`，如有 `b23.wtf` 一并列）；放宽短码到 `[0-9A-Za-z_-]{4,32}`；`resolveShort` 允许最终 `bilibili.com`/`m.bilibili.com`，普通 `video/BV` 返回 BV，`av` 转 aid 或明确 `unsupported`；非视频页保留真实 `reason`，不要泛化成“读不了”。
7. **先写测试**：`test/inbound.test.mjs` 加 `bili2233.cn`/带 `-` 短码入站；`runner/test_fetcher.mjs` 的 N6 加别名重定向与 3 跳；`test/fetchjobs.test.mjs` 加 `refIn`/`videoTarget` 对别名 short 的提取；断言失败 reason 为 `unsupported` 而非通用错误。
8. **改动文件**：`src/bili-links.ts`、`src/inbound.ts`、`src/fetchjobs.ts`、`runner/fetcher.mjs`、对应测试；`src/semantic.ts` 不必改，避免与 C1b 冲突。预计 0.5 天（含公开别名实测）。
