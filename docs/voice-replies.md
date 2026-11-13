# 群内语音回复

默认 `auto`：仅回复语音消息，或模型确认当前用户明确要求语音时尝试语音。成功只发送语音；合成、转码或明确拒绝上传时回退原文文字。代码、链接、超过 300 字和多段回复保持文字。

- `/voice`：查看本群模式。
- `/voice on|off|auto`：设置本群模式；校验已绑定成员的 `owner`/`admin` 权限，不信任消息里自报的身份。
- 设置 `voice:mode` 是全局默认；`voice:mode:<群ID>` 优先，值为 `off|auto|always`。
- `tts:provider=auto|edge|deepseek`；`auto` 沿用 DS-2a 的 edge 主、DeepSeek 备用。
- 日限额和关闭开关由 DS-0 的 `dsGuard` 在领取语音任务时检查，限额不足改走原来的文字发送队列。

集成须包含 DS-0（含 0060 用量表迁移）和 DS-2a（SILK 编码及 QQ 富媒体模块）。SILK 依赖由交付流程安装，缺少依赖时回退文字。网关通过现有状态上报获取待发提示，10 秒循环领取；不新增本机服务。

领取使用原子条件更新；每行仅尝试一次。被动回复窗口为原始消息起 240 秒。QQ 发送结果不确定或上报丢失时保留 `unknown`，不自动重发；管理员核对实际群记录后处理。`voice_sending` 过期后转 `unknown`。

DeepSeek 密钥仅通过安全凭据流程交给文件，运行一次实测时设置 `DEEPSEEK_API_KEY_FILE`，执行 `node scripts/f9ds-2b-live.mjs`。脚本只请求一次短句合成，不写 D1、不发 QQ，不保存音频；估算费用上限 $0.01。
