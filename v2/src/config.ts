// The part of the bot it is allowed to change by itself: bounded settings, short playbooks that are
// appended to prompts, and the names it answers to. Everything else is code and needs a maintainer.
export type Tunable = { default: number | string; min?: number; max?: number; options?: string[]; what: string };

export const TUNABLES: Record<string, Tunable> = {
  wait_called_ms: { default: 350, min: 0, max: 5000, what: "被叫到之后等多久再开始回（毫秒）" },
  wait_chat_ms: { default: 2200, min: 500, max: 15000, what: "没人叫我时，等大家连发的话停下来多久再看（毫秒）" },
  wait_max_ms: { default: 6000, min: 1000, max: 30000, what: "一串连发最多等多久（毫秒）" },
  reply_split_max: { default: 3, min: 1, max: 5, what: "闲聊一次最多拆成几条发" },
  image_daily: { default: 40, min: 0, max: 300, what: "每天最多画几张图" },
  python_daily: { default: 40, min: 0, max: 300, what: "每天最多跑几次代码" },
  voice_daily: { default: 60, min: 0, max: 300, what: "每天最多发几条语音" },
  image_quality: { default: "medium", options: ["low", "medium", "high"], what: "群友没指定时画图用的质量" },
  transcribe_max_minutes: { default: 60, min: 5, max: 120, what: "B 站无字幕视频最多转写多少分钟" },
  history_carry: { default: 150, min: 30, max: 600, what: "夜间整理之前的聊天再多带多少条进上下文" },
  talkative: { default: "normal", options: ["quiet", "normal", "chatty"], what: "没人叫我时主动接话的积极程度" },
};

export const PLAYBOOKS: Record<string, string> = {
  persona: "补充的人设、说话方式和日常规矩（每一轮都会读到）",
  drawing: "画图时额外遵守的偏好和做法（构思画面那一步会读到）",
  python: "跑代码、出图表、生成文件时额外遵守的做法（沙箱里的那一步会读到）",
};
export const PLAYBOOK_LIMIT = 1500;

export function checkTunable(key: string, value: unknown): { ok: true; value: number | string } | { ok: false; error: string } {
  const t = TUNABLES[key];
  if (!t) return { ok: false, error: "没有这个参数。能改的有：" + Object.keys(TUNABLES).join("、") };
  if (t.options) return t.options.includes(String(value)) ? { ok: true, value: String(value) } : { ok: false, error: "只能是 " + t.options.join(" / ") };
  const n = Number(value);
  if (!Number.isFinite(n) || n < t.min! || n > t.max!) return { ok: false, error: "要在 " + t.min + " 到 " + t.max + " 之间" };
  return { ok: true, value: Math.round(n) };
}
