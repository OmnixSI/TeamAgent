import { explicitWriteRequest } from "./authz";
import { addressee, metaOf } from "./view";
import { parseDecision } from "./rhythm";
import { UNTRUSTED_RULE } from "./untrusted";
import settings from "../config/participation.json";
/** Group participation is decided before the separate voice module. */
export const PARTICIPATION = settings.text + "\n" + UNTRUSTED_RULE;
export function participation(raw: string, forced = false) {
  const d = parseDecision(raw, { forced, allowWait: false });
  return { should_reply: d.action === "reply", kind: d.kind, brief: d.brief };
}
export type ParticipationInput = Record<string, any> & { system?: string };
/** Preserve caller field order, so production and replay use identical messages. */
export function participationMessages(x: ParticipationInput): { role: string; content: string }[] {
  const { system = PARTICIPATION, ...data } = x;
  return [{ role: "system", content: system }, { role: "user", content: JSON.stringify(data) }];
}
export async function maySpeak(
  e: any,
  p: any,
  forced: boolean,
  accepted: boolean,
) {
  return accepted || forced || p.action === "reply" || p.should_reply === true;
}
export function alreadySaid(text: string, recent: any[]) {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  const normalized = normalize(text);
  return (
    !!normalized &&
    recent.some(
      (message) => normalize(String(message.body || "")) === normalized,
    )
  );
}

/** Routing hint only: tool execution still requires authorizeWrite and its original checks. */
export function isDirectRequest(row: any): boolean {
  const meta = metaOf(row), recipient = addressee(meta, new Map());
  if ((recipient && recipient !== "你") || meta.addressedOther) return false;
  return explicitWriteRequest("create_file_task", row) || explicitWriteRequest("prepare_project_task", row);
}
