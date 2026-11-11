import raw from "../config/team.json";
import { validateTeamConfig } from "../config/validate.mjs";
export type Effort = "none" | "low" | "high" | "max";
const errors = validateTeamConfig(raw);
if (errors.length)
  throw Error("Invalid config/team.json: " + errors.join(", "));
export const TEAM = raw;
export function modelSettings(
  kind: string,
  requested: Effort,
  timeout: number,
) {
  const efforts = TEAM.model.effort_by_kind as Record<string, Effort>;
  const timeouts = TEAM.model.timeouts_ms as Record<string, number>;
  return {
    model: TEAM.model.name,
    effort:
      efforts[kind] ||
      ((requested === "max"
        ? TEAM.model.important_effort
        : TEAM.model.quick_effort) as Effort),
    timeout: timeouts[kind] || timeout,
  };
}
