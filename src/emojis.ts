import { annotateTurn, type ImagePick } from "./vision";
import type { Media } from "./inbound";

/** Sticker images get a meaning-oriented prompt: emotion, tone, meme, and where it fits. */
export const EMOJI_HINT =
  "这是群聊里的表情包。说明画面里是什么，以及它表达的情绪、语气、梗，适合接在什么话后面。";

/**
 * Read one inbound sticker or super emoji as an image and cache the result in
 * image_notes/message_images. Runs in the background queue, never on the
 * inbound request. The same daily sticker-read cap used by on-demand turns is
 * enforced inside describeImage, so an exhausted cap degrades to a placeholder.
 */
export async function runEmojiNote(
  e: any,
  p: { message?: string; group?: string; idx?: number; media?: Media; hint?: string },
) {
  const message = String(p.message || "");
  const idx = Number(p.idx);
  if (!message || !Number.isInteger(idx) || idx < 0 || p.media?.kind !== "image") return;
  const linked = await e.DB.prepare("SELECT sha FROM message_images WHERE message_id=? AND idx=?")
    .bind(message, idx)
    .first();
  if (linked) return;
  const hint = String(p.hint || "").trim();
  const pick: ImagePick = {
    messageId: message,
    ...(p.group ? { groupId: String(p.group) } : {}),
    idx,
    media: p.media,
    hint: hint ? "群友同时说：" + hint.slice(0, 80) + "。" + EMOJI_HINT : EMOJI_HINT,
    sticker: true,
  };
  await annotateTurn(e, [pick], 20000);
}
