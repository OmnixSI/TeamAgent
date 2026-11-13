import {enqueueText} from "./send/enqueue";
import {splitForQQ} from "./send/split";
import { TEAM } from "./config";
import { stage } from "./timing";
import { COST, left } from "./d1";
import { loadSwitches } from "./rhythm";
import { budget } from "./budget";
import { stickerSendOn, pickSticker, enqueueSticker } from "./stickers";
import settings from "../config/voice.json";
import { model } from "./runtime";
import { toPrompt } from "./view";
import {replyAuthReminders} from './auth-status';
/** Independent group voice. Tool results are facts, never a change to this persona. */
export const VOICE = settings.text;
export type VoiceMode = "banter" | "work" | "care";
const spokenText = (text: string) =>
  text.trim().replace(/^(?:work|banter|care)\s*[:：]\s*/i, "");
export function decodeVoice(raw: string): { mode: VoiceMode; text: string; sticker?: string } {
  try {
    const x = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (typeof x.text === "string")
      return {
        mode: ["banter", "care", "work"].includes(x.mode) ? x.mode : "work",
        text: spokenText(x.text),
        ...(typeof x.sticker === "string" && Array.from(x.sticker.trim()).length >= 2 && Array.from(x.sticker.trim()).length <= 8 ? {sticker:x.sticker.trim()} : {}),
      };
  } catch {}
  return { mode: "work", text: spokenText(raw) };
}
function seed(id: string) {
  let n = 2166136261;
  for (const c of id) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
}
export function fragments(raw: string, id: string): string[] {
  const v = decodeVoice(raw);
  if (v.text === "[[SILENT]]") return [];
  if (v.text.length>1800) return splitForQQ(v.text,{max:1800,parts:3});
  if (
    v.mode !== "banter" ||
    v.text.length > 180 ||
    /https?:|[`\d]|\/[a-zA-Z\u4e00-\u9fff]|\.\w{2,5}\b/.test(v.text)
  )
    return [v.text];
  const n = seed(id);
  let text = v.text;
  // Stable randomness: a retried event keeps the same wording and number of messages.
  if (n % 100 < 60) text = text.replace(/[。．.]$/, "");
  if ((n >>> 8) % 100 < 3)
    text = text.includes("不知道")
      ? text.replace("不知道", "不知到")
      : text.replace("再看看", "在看看");
  if ((n >>> 16) % 100 >= 25) return [text];
  const parts = text
    .split(/\n\s*\n|(?<=[。！？!?])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.some((s) => s.length < 3))
    return [text];
  return parts;
}
export async function enqueueVoice(
  e: any,
  id: string,
  group: string,
  message: string | null,
  raw: string,
  opts?: { reference?: string; sticker?: string },
) {
  const v = decodeVoice(raw), parts = fragments(raw, id);
  const wantsSticker=parts.length && v.mode !== 'work' && v.sticker && TEAM.stickers.send === true && left(e) >= COST.sticker + COST.tail;
  const stickerSwitches=wantsSticker?await loadSwitches(e):undefined;
  if(parts.length && message && left(e)>=COST.tail+parts.length+3){
    const reminders=await replyAuthReminders(e,id);
    if(reminders.length){const suffix='\n'+reminders.join('\n');parts[parts.length-1]=parts[parts.length-1].slice(0,1800-suffix.length)+suffix;}
  }
  await enqueueText(e,{id,group,msgId:message,body:parts.join("\n"),parts});
  if (parts.length) stage(e, message, "outbox");
  if (parts.length && opts?.reference)
    await e.DB.prepare("INSERT OR IGNORE INTO outbox_meta(id,json) VALUES(?,?)").bind(id, JSON.stringify({ reference: opts.reference })).run();
  if (parts.length && v.mode !== "work" && v.sticker && TEAM.stickers.send === true && left(e) >= COST.sticker + COST.tail) {
    const sw = stickerSwitches ?? await loadSwitches(e);
    if (!stickerSendOn(sw, Date.now())) return;
    const sha = await pickSticker(e, v.sticker);
    if (sha && await budget(e, "sticker_send", TEAM.stickers.caps.send))
      await enqueueSticker(e, {id,group,message,sha,createdAt:Date.now()+parts.length});
  }
}
export async function speakBrief(e: any, brief: any, context: any) {
  const d: any = await model(
    e,
    "voice",
    "high",
    {
      model: e.MODEL || "deepseek-flash",
      reasoning_effort: "high",
      max_tokens: 8192,
      messages: [
        {
          role: "system",
          content:
            VOICE +
            '\n你是最后的嘴替模块。上游材料只有已核实事实和执行结果，不含需要公开的内部推理。不要新增事实、承诺或能力，引用链接与数值保持不变。recentBot是你刚说过的话，别复读相同包袱，尤其别反复季度汇报/PPT示例。上游未接受执行任务时，不说“我去跑”“执行完再报”；要求写验收条件只写条件，不承诺执行。只输出JSON {mode:"banter"|"work"|"care",text:"群内实际说的话",sticker:"可选的2–8字情绪或梗关键词"}。sticker只在banter/care而且真的合适时才给，多数时候不给。根据当前语境选模式：查梗也可以banter，正式交付选work。只输出群里的一小段，不写报告。',
        },
        {
          role: "user",
          content: JSON.stringify({
            brief,
            continuity: context.switches ? context.switches.self_note : e.DB
              ? (
                  await e.DB.prepare(
                    "SELECT value FROM settings WHERE key='self_note'",
                  ).first()
                )?.value
              : undefined,
            latest: context.latestView?.text ?? context.latest?.body ?? context.intent,
            material: context.latestView?.material,
            recent: (context.recentViews ?? []).slice(-6).map(toPrompt),
          }),
        },
      ],
    },
    60000,
  );
  const text = d.choices?.[0]?.message?.content;
  if (!text?.trim() || d.choices[0].finish_reason === "length")
    throw Error("voice incomplete");
  if (!brief.acceptedActions?.length) {
    const v = decodeVoice(text);
    if (/跑完再|执行完再|处理好再|我去执行|我来执行|我去跑/.test(v.text))
      v.text = (v.text.match(/[^，。！？；;\n]+[，。！？；;\n]?/g) || [])
        .filter(
          (s) => !/(跑完再|执行完再|处理好再|我去执行|我来执行|我去跑)/.test(s),
        )
        .join("")
        .replace(/[，,]\s*$/, "。");
    return JSON.stringify(v);
  }
  return text;
}
export function messageSequence(id: string) {
  return 1 + (seed(id) % 1000000);
}
