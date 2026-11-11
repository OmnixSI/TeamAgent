import { TEAM } from "./config";
export const REPOS: string[] = TEAM.repositories;
export const EFFORT = {
  chat: "high",
  plan: "max",
  memory: "max",
  code: "max",
} as const;
export function command(text: string) {
  // Only a direct command at the beginning authorizes execution; quoted/forwarded elements never enter here.
  const m = text.trim().match(/^\/(开工|方案)\s+(\S+)\s+([\s\S]{1,4000})$/u);
  if (!m) return null;
  const repo = REPOS.find(
    (r) =>
      r.toLowerCase() === m[2].toLowerCase() ||
      r.split("/")[1].toLowerCase() === m[2].toLowerCase() ||
      (INITIAL_PROJECT_HINTS as Record<string, string[]>)[r]?.includes(m[2]),
  );
  return repo ? { repo, title: m[3].trim(), execute: m[1] === "开工" } : null;
}
export function validStatus(s: string) {
  return [
    "proposal",
    "queued",
    "running",
    "in_progress",
    "needs_human",
    "ready_for_review",
    "done",
    "failed",
    "cancelled",
  ].includes(s);
}
// Initial hints only. Learned project facts and corrections are supplied to the model at runtime.
export const INITIAL_PROJECT_HINTS: Record<string, string[]> =
  TEAM.project_aliases;

export function extractUrls(text: string) {
  return [
    ...new Set(
      text.match(
        /https?:\/\/[^\s"'<>\\\[\]()（）\u3001\uff0c\u3002\uff1b]+/g,
      ) || [],
    ),
  ]
    .map((x) => x.replace(/[.,;!?]+$/, ""))
    .filter((x) => {
      try {
        return !!new URL(x).hostname;
      } catch {
        return false;
      }
    })
    .slice(0, 5);
}
