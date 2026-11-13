// 出站语音策略：只决定「这条回复该不该用语音说」，不碰网络、进程或数据库。
// 纯函数，可在 Worker 侧（决定是否写 voice_text）和测试里直接调用。
// 思路参考 AstrBot 的 ProviderEdgeTTS 灰度与长度限制；实现为本仓库自写（AGPL 项目只借思路）。

export type VoiceCfg = {
  enabled?: boolean;
  delivery?: { mode?: string; sourceVoice?: boolean; requested?: boolean; parts?: number; quota?: boolean };
  voice?: string;
  rate?: string;
  max_chars?: number;
};

export type VoiceReason =
  | "ok"
  | "disabled"
  | "mode"
  | "empty"
  | "code"
  | "link"
  | "too_long"
  | "parts"
  | "quota";

/** 语音硬上限：无论配置写多大，超过 300 字一律走文字。 */
export const HARD_MAX_CHARS = 300;

const SPOKEN_MODES = new Set(["care", "banter"]);
const CODE_BLOCK = /```|`[^`\n]+`/;
const LINK = /https?:\/\/|www\.|\]\([^)]+\)|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|cn|org|net|io|dev|ai|app|me|tv|xyz|co|cc|edu|gov|info|top|site|tech)\b/i;

export function effectiveMaxChars(cfg?: VoiceCfg): number {
  const value = cfg?.max_chars;
  if (!Number.isInteger(value) || (value as number) < 1) return HARD_MAX_CHARS;
  return Math.min(value as number, HARD_MAX_CHARS);
}

/** 回复为什么不能走语音；"ok" 表示可以。 */
export function voiceSkipReason(
  reply: unknown,
  mode?: string,
  cfg?: VoiceCfg,
): VoiceReason {
  if (cfg?.enabled !== true) return "disabled";
  if (cfg.delivery) {
    const d = cfg.delivery;
    if (d.mode === "off") return "disabled";
    if (d.quota === false) return "quota";
    if ((d.parts ?? 1) !== 1) return "parts";
    if (d.mode !== "always" && !d.sourceVoice && !d.requested) return "mode";
  } else if (!mode || !SPOKEN_MODES.has(mode)) return "mode";
  if (typeof reply !== "string") return "empty";
  const text = reply.trim();
  if (!text) return "empty";
  if (CODE_BLOCK.test(text)) return "code";
  if (LINK.test(text)) return "link";
  if ([...text].length > effectiveMaxChars(cfg)) return "too_long";
  return "ok";
}

/** 这条回复是否适合用语音发送（care/banter、≤300 字、无代码块/链接、开关打开）。 */
export function shouldVoice(
  reply: unknown,
  mode?: string,
  cfg?: VoiceCfg,
): boolean {
  return voiceSkipReason(reply, mode, cfg) === "ok";
}
