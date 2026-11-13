/** Worker wiring, after identity and reference resolution:
 * forceReply(ne, { selfId: e.QQ_APP_ID, nicknames: confirmed bot names,
 *                  replyToBot: ref?.kind === "bot" }). The caller owns those lookups.
 * This module performs no I/O and does not modify the shared event contract.
 */
import type { NormalizedEvent } from "./types";

export type WakeContext = { selfId: string; nicknames: readonly string[]; replyToBot: boolean };

// Ported from nonebot/adapter-onebot@8e0d1145a7106f0c4e2b383e39e5bcf1dfd1d86d
// nonebot/adapters/onebot/v11/bot.py::_check_at_me/_check_reply/_check_nickname (MIT).
// Copyright (c) 2021 NoneBot
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
export function forceReply(ne: NormalizedEvent, context: WakeContext): boolean {
  const self = context.selfId;
  if (ne.kind !== "message" || ne.actor.bot || self && ne.actor.id === self) return false;
  if (ne.mentionsBot || context.replyToBot) return true;
  if (ne.segments.some(s => s.type === "mention" && (s.self || !!self && s.id === self)
    || s.type === "reply" && !!self && s.preview.authorId === self)) return true;
  let leading = "";
  for (const segment of ne.segments) {
    if (segment.type !== "text") break;
    leading += segment.text;
  }
  return context.nicknames.some(value => {
    const name = value.trim();
    if (!name) return false;
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("^\\s*" + literal + "(?:\\s|[,:：，。!?！？]|$|(?=\\p{Script=Han}))", "iu").test(leading);
  });
}
