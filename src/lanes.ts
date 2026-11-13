/** Chat, tool work and deep reasoning have separate queue consumers. */
export function queueFor(e: any, kind: string, payload: any = {}) {
  if (["fetch","bili_media"].includes(kind)) return null;
  if (["video_reply", "chat", "voice_notice", "claim_notice"].includes(kind))
    return e.CHAT || e.WORK;
  if (
    ["research", "scout", "ci_triage"].includes(kind) ||
    (kind === "plan" && payload.effort === "high")
  )
    return e.TOOLS || e.WORK;
  return e.WORK;
}
