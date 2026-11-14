# 视频方案补充：X-ASR 调用方式（并入 plan-bili-video-v1.md 的 ASR 一节）

结论：本机 X-ASR 实际是 **sherpa-onnx 版**，不是 MLX。会议软件 NextThought 用的就是这一套，runner 直接复用同一份离线模型和同一组参数，不另装模型、不另起引擎。

## 已核实（2026-11-13，读文件和官方 README 确认）
- 会议软件 = `~/LocalProjects/NextThought`（af60a4d）。它在 Swift 里通过 Sherpa-ONNX C API 调 X-ASR，分两遍：流式 480 ms 出字，加离线整句精修（`Sources/NextThoughtCore/ZipformerStreaming.swift:458-494`，`Sources/NextThought/LocalASRModels.swift:55-91`）。
- 本机模型已装在 `~/Library/Application Support/NextThought/models/`：
  - 离线：`sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03/`，含 encoder-epoch-99-avg-1.int8.onnx、decoder-epoch-99-avg-1.onnx、joiner-epoch-99-avg-1.int8.onnx、tokens.txt、bpe.vocab；sha256 5d02c36d…2224（见 installed.json）。
  - 流式：`sherpa-onnx-x-asr-480ms-streaming-…-2026-06-05/`，视频转写用不到。
- 官方仓库 https://github.com/Gilgamesh-J/X-ASR ：X-ASR-zh-en，0.16B，中英混说，自带标点和大小写；离线和流式统一，部署只走 sherpa-onnx。README 里没有 MLX 版本。本机 python3、homebrew python 和 HuggingFace 缓存里都没找到 MLX 版 X-ASR 或 `sherpa_onnx`。
- NextThought 离线识别参数：采样率 16000、featureDim 80、modelType "transducer"、modelingUnit "bpe"、provider cpu、线程 min(threads,4)（默认 2）、decodingMethod "modified_beam_search"、maxActivePaths 4。热词视频用不上，不配。

## 写进方案的做法（取代原「待侦察：X-ASR 调用方式」）
1. 引擎：runner 用 Python 包 `sherpa-onnx`（Apache-2.0，k2-fsa 官方，与 NextThought 同源）。这是新依赖，理由：X-ASR 官方唯一的运行时，且本机现在没装。交付员装进 runner 用的那个 Python。
2. 模型：只读引用，不复制。用环境变量 `XASR_MODEL_DIR`，默认指向上面的离线模型目录。启动时检查 4 个必需文件，缺任何一个就报人话原因「本机没找到 X-ASR 模型文件：<文件名>（来自会议软件 NextThought 的模型目录）」，不降级到其他引擎。
3. 新文件 `runner/xasr.py`，函数 `transcribe(wav_path: str) -> list[dict]`，返回 `[{start: float, end: float, text: str}]`：
   - `sherpa_onnx.OfflineRecognizer.from_transducer(encoder=…, decoder=…, joiner=…, tokens=…, num_threads=2, sample_rate=16000, feature_dim=80, decoding_method="modified_beam_search", max_active_paths=4)`，每个进程只建一次。
   - 音频：ffmpeg 先转成 16 kHz 单声道 s16le WAV。按 ≤30 s 切段，切点优先选 `silencedetect`（-30 dB、≥0.3 s）找到的静音中点，30 s 内没有静音就在 30 s 处硬切。每段各建 stream、`decode_streams` 批量解码，时间戳取段起点。
   - CLI：`python3 runner/xasr.py <wav>` 向 stdout 输出 JSON 行，供 fetcher.mjs 以子进程调用。退出码：0 成功，2 模型缺失，3 音频解码失败，4 识别异常。stderr 只留最后 2 KB。
4. 中英两种语言共用同一个模型，不做语言路由。官方说明里本来就是中英混说模型。

## 先写的测试（补进测试清单）
- X1：模型目录缺 joiner → 退出码 2，stderr 写明缺哪个文件，不调用任何其他引擎。
- X2：用 sherpa-onnx 自带的中文、英文样例 wav 各一条 → 非空文本，中文结果带标点。
- X3：一段 65 s、中间有静音的音频 → 切 3 段，切点都落在静音区，段时间戳单调递增。
- X4：没有 `sherpa_onnx` 包时 → 人话原因「本机缺少 X-ASR 运行库 sherpa-onnx」，不出现「读不了」。

## 仍待工程师侦察核实（不阻塞写方案）
- 用户说的「MLX 版本」：我没在本机找到。请侦察确认有没有别的安装（如 `uv tool list`、`pipx list`、`~/.cache/uv`）。真有的话也以 NextThought 这一套为准，因为它已经在用、参数已验证。
- runner 实际用哪个 Python 解释器，`pip install sherpa-onnx` 能否装上（Apple Silicon wheel）。
- 一条 10 分钟中文音频的实际耗时和内存峰值（num_threads=2）。拿到后回填方案里长视频的超时值；在此之前先按「音频时长 × 0.3 + 30 s」设超时，这个系数是估计值。
