# B 站视频理解（字幕 / 音轨 / 画面）调研 — DeepSeek
2026-11-13｜未登录、未用用户 Cookie、未发群消息。**实测**＝本轮真跑；**文档**＝README/官方；**未核实**＝没验证。
**结论**：走「登录态字幕优先 → 无字幕用本机 X-ASR → ffmpeg 场景抽帧 → 文本模型总结」三段式，成本≈0，10 分钟视频约 1–2 分钟出总结；画面只送 6–10 帧，且只在有人问「画面里是什么」时才送。
## 1. 开源项目（近一年仍活跃）

- [BiliNote](https://github.com/JefferyHcool/BiliNote)（7,748★ MIT 2026-09-01）：B站/YouTube/抖音→Markdown 笔记；浏览器插件带登录态抓字幕、跳过后端转写；转写支持 Fast-Whisper/MLX-Whisper/Groq；可选自动截图。
- [ViNote](https://github.com/zrt-ai-lab/ViNote)（483★ MIT 2026-09-05）：DeepSeek Harness SDK 编排的视频知识 Agent；字幕优先 + faster-whisper/FunASR/Qwen3 兜底。
- [BibiGPT-v1](https://github.com/JimmyLv/BibiGPT-v1)（6,272★ GPL-3.0 2026-11-04）：开源 v1 只走字幕（读码：取 subtitle.list + SESSDATA），无本地 ASR/帧理解；同作者 [bibigpt-skill](https://github.com/JimmyLv/bibigpt-skill)（141★ MIT 2026-11-10）是给 Claude Code/Codex 的 agent skill。
- [bilibili-mcp](https://github.com/adoresever/bilibili-mcp)（193★ MIT 2026-03-11）：B站 MCP，搜索/评论/字幕/弹幕；[VideoRAG](https://github.com/HKUDS/VideoRAG)（3,523★ KDD'26）是「和视频对话」的检索框架，非 B 站专用。取流用 [yutto](https://github.com/yutto-dev/yutto)（活跃）；[bilibili-api](https://github.com/Nemo2011/bilibili-api)、[BBDown](https://github.com/nilaoda/BBDown) 均已 archived（2026-07-06 / 2026-05-14）。
- 共同点：**全部字幕优先**，拿不到才转写；没人对每条视频密集抽帧。BiliNote README 原话「插件在浏览器里带本地登录态抓字幕，跳过后端音频转写」（文档）。
## 2. 三条路线

| 路线 | 成本 | 10 分钟视频 | 效果 | 难度 | 风险 |
|---|---|---|---|---|---|
| A 纯字幕+文本 | 0 | 5–10s | 有字幕时最好 | 低 | 无字幕即失效 |
| **B 字幕→X-ASR→6–10 帧** | 0（全本机） | 40–90s | 接近 A，画面可补 | 中 | B站风控、Cookie 只留本机 |
| C 全画面密集抽帧 | 高（多模态 token） | 3–5min | 细节全但贵且吵 | 高 | 成本不可控 |
推荐 B。字幕硬限制：匿名拿不到 CC——`view.data.subtitle.list[].subtitle_url` 为空串、`player/wbi/v2` 返回 `need_login_subtitle: true`（我 2026-11-12 实测，样本 BV1tnZqYTEx6），必须用本机登录态，Cookie 不出本机。
## 3. 无字幕兜底：用 X-ASR，不用 whisper

你本机的 **X-ASR zh-en**（SJTU/SII 2026-06，Apache-2.0，sherpa-onnx）：流式 161MB、离线 167MB（int8）；你自己的 `~/LocalProjects/NextThought/docs/ASR-MODELS-2026-10.md` 记着 x86 2 线程实测 RTF 0.10–0.13 / 0.03–0.05，Apple Silicon 更快；WenetSpeech 会议 CER 离线 7.06% vs Whisper large-v3 18.39%。按 RTF 0.05 估，10 分钟视频约 30 秒。

我本轮实测对照：M2 Pro 上 openai-whisper `small` 转 66.5 秒中文音频用了 **54.5 秒**（≈0.82 RTF），10 分钟要 8 分钟量级；`large-v3-turbo` 没跑完（我中止）。whisper.cpp 官方称 Core ML 编码器 >3× 加速（文档），但仍追不上 X-ASR 的体积/速度。

取音轨：`yt-dlp -f bestaudio -x --audio-format wav <链接>`（本机 2026.03.17 已装，实测版本）；只处理用户主动贴的链接。

## 4. 画面：抽帧与多模态

- **场景切换优先、固定间隔兜底**：ffmpeg `select='gt(scene,0.3)'` 是官方滤镜（[文档](https://ffmpeg.org/ffmpeg-filters.html)），10 分钟通常 20–60 个切点，再按最小间隔 20s 稀释；无切点的 PPT 类退回每 30s 一帧。
- **送几张**：总结 6–10 张（约每 60–90 秒一张）；只有人问「画面写了什么」才对指定时段加密。
- **送哪个**：优先团队现成 GPT 多模态（已有额度，不新增费用）；其次 Gemini API 免费层（有免费额度，但 RPM/RPD 随模型变，**未核实具体数字**）；本机 Qwen2.5-VL 7B 要 5GB 内存、每帧数秒，不作首选。
- DeepSeek 不能读图（BiliNote 专门修过 DeepSeek 被多模态消息 400 拒绝），图文必须分两次调用。
## 5. 推荐与分阶段
1. **P0 字幕**：本机登录态取 `player/wbi/v2` 的 `subtitle_url`；取不到标 `login_required`，不要假装无字幕。
2. **P1 音轨**：接 X-ASR 离线模型（ffmpeg 抽 16k 单声道），结果落 `media_notes` 并带语言。
3. **P2 画面**：6–10 帧场景抽帧，送团队多模态员，把「画面摘要」并进同一份材料；按问题类型决定是否看图，控成本。
## 未核实 / 风险

- Gemini 免费层具体额度未核实；团队多模态额度也不是无限。BiliNote 的抽帧间隔 README 未写，我没读它后端代码。
- X-ASR 的 RTF 来自你的文档（x86 2 线程），我本轮没在这台 M2 Pro 上跑（sherpa-onnx 只有 Swift 包，没装 Python/CLI）。B 站接口属灰区：只读用户贴的链接，不批量抓取、不存档。
