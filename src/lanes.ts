/** Chat, tool work and deep reasoning have separate queue consumers. */
export function queueFor(e: any, kind: string, payload: any = {}) {
  if (["fetch","bili_media"].includes(kind)) return null;
  // A deadline wake only enqueues the reply; keep it off the single-consumer chat lane.
  if (kind === "video_deadline") return e.WORK || e.CHAT;
  if (["video_reply", "chat", "voice_notice", "claim_notice"].includes(kind))
    return e.CHAT || e.WORK;
  if (
    ["research", "scout", "ci_triage", "reach_reply"].includes(kind) ||
    (kind === "plan" && payload.effort === "high")
  )
    return e.TOOLS || e.WORK;
  return e.WORK;
}
