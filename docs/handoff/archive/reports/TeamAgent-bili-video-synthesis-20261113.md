# B 站视频理解 · 联合调研综合
综合人：调研员（DeepSeek）｜2026-11-13｜输入：我的 `TeamAgent-bili-video-research-deepseek-20261113.md` 与 Codex 的 `...-codex-...md`；未登录、未用 Cookie、未发群消息。

**结论**：推荐「登录态字幕优先 → 无字幕用 X-ASR（中文）→ 代理按问题定向取 6–12 帧 → 文本 DeepSeek 汇总」；重活全在本机 runner，Worker 只排队，回写 `media_notes` 并标来源。
## 一致

- 全部项目都是**字幕优先**，拿不到才转写；抽帧只作补充，没人对每条视频密集抽帧。
- **DeepSeek 是文本模型**：图像必须另接 VLM，BiliNote 专门修过 DeepSeek 被多模态消息 400 拒绝。
- 下载层：`bilibili-api`（archived 2026-07-06）与 `BBDown`（archived 2026-05-14）不再当底座，`yutto` 仍活跃（2026-11-09）。
- 抽帧预算 6–12 张即可，没必要默认 100 帧；架构是 Worker 调度、本机 runner 干重活、回写 D1 `media_notes`。
- 证据必须标来源（字幕/帧/评论），取不到就标 `metadata_only`，不能声称看过视频。
## 分歧与核实

1. **ASR 选型**：我说 X-ASR / Codex 说 Whisper large-v3-turbo。核实：Codex 引的 M1 Max 基准只有英、俄两段（179.8s / 298.1s，[RESULTS](https://github.com/mxl/whisper-benchmark/blob/main/RESULTS.md)），**没有中文**；你本机文档里 WenetSpeech 会议 CER 是 X-ASR 离线 7.06% vs Whisper large-v3 18.39%。→ **中文用 X-ASR，多语种/英文才用 Whisper**。同一基准里 Qwen3-ASR 0.6B 的 RTF 0.048（EN）也快过 Whisper 的 0.090，方向上支持专用 ASR。
2. **BibiGPT 能力**：我原来写「一键总结＋对话」/ Codex 读码说只取字幕。核实：[`fetchBilibiliSubtitleUrls.ts`](https://github.com/JimmyLv/BibiGPT-v1/blob/main/lib/bilibili/fetchBilibiliSubtitleUrls.ts) 确实只读 `subtitle.list` + SESSDATA，无本地 ASR/帧。→ Codex 对，BibiGPT 只能当「字幕总结」参照。
3. **BiliNote 抽帧密度**：Codex 说默认 6 秒 / 我在 `note.py` 看到 `video_interval` 是调用方参数（默认 0）。→ 密度可配、未确认 6 秒；我们按 6–12 张预算，不照抄。
4. **画面理解形态**：我「一次送 6–10 帧」/ Codex「代理先读文本、判断缺口、再定向取帧」。→ 采纳 Codex 的两轮：更省 token，也更准。
## 仅一方查到

- **仅 Codex**：dsh-bilibili 的两轮代理与选帧细节（场景峰＋±4s 细化＋±1.5s 挑清晰帧、默认 6 帧）；Bilibili-Video-Research 的 language/vision/multimodal 三模式与 StepFun 端点；video-understander / video-digest-skill / BiViNote 三个小项目；SubtitleBee 是商业服务（10 分钟/月、非开源）；Qwen3-VL-4B 本地 VLM（Apache-2.0，Ollama 约 3.3GB）。
- **仅我**：X-ASR 的存在、路径与 RTF（你的 `ASR-MODELS-2026-10.md`）；whisper `small` 在 M2 Pro 上 66.5s 音频 54.5s（≈0.82 RTF，实测）；匿名拿不到 CC（`need_login_subtitle: true`，11-12 实测）；ffmpeg `select='gt(scene,0.3)'` 官方滤镜。
## 选型对比（ASR）

| 候选 | 语言 | 体积 | 速度（出处） | 许可 |
|---|---|---|---|---|
| **X-ASR zh-en** | 中英 | 167MB int8 | RTF 0.03–0.05（你文档，x86 2 线程） | Apache-2.0 |
| Whisper large-v3-turbo | 多语 | ~1.5GB | RTF 0.090（M1 Max，英/俄） | MIT |
| Qwen3-ASR 0.6B | 多语 | ~940MB | RTF 0.048–0.068（同基准） | Apache-2.0 |
## 风险与未核实

- X-ASR 我没在这台 M2 Pro 跑通（只有 Swift 包，没装 Python/CLI），速度用你文档的 x86 数据。
- Gemini 免费层额度、StepFun 长期免费、Qwen3-VL-4B 在 16GB Mac 上的实际帧速，都未核实。
- 双方都没跑过真实视频与模型；Codex 只读源码，我只跑了 whisper 与 HTTP 探测。B 站接口属灰区，只读用户贴的链接。
## 建议的下一步

1. **P0 字幕**：本机登录态取 `player/wbi/v2` 的 `subtitle_url`，取不到标 `login_required`。
2. **P1 音轨（先做这个）**：接 X-ASR 离线模型，ffmpeg 抽 16k 单声道，结果落 `media_notes`，带语言与来源——先让无字幕视频能总结。
3. **P2 画面**：按两轮代理，读文本→判断缺口→取 6–12 帧→VLM 描述→融合；VLM 先用本地 Qwen3-VL-4B 或团队多模态员。
4. **P3 长视频追问**：只有真的需要「反复追问整条视频」再评估 VideoRAG；不要每条 QQ 视频建索引。
