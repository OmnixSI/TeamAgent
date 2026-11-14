// ⚠️ 占位文件，不属于 D3b。
// 真实现由 pkg/D-D3a 提供（design §5.4）。D3b 为了能独立 `npm run check` / 构建，
// 先按冻结签名留空：调用会立刻抛错，绝不会静默算错。
// 合并顺序：pkg/D-D3a 先于 pkg/D-D3b；冲突时整文件取 D-D3a 的版本，删掉本文件头这段说明。
export type Step =
  | { action: "records_summary"; type: string; group_by?: string; period?: "all" | "today" | "yesterday" | "this_month" | "last_month" }
  | { action: "records_query"; type: string; filter?: { person?: string; status?: string; text?: string }; limit?: number }
  | { action: "quota" }
  | { action: "token_usage"; period?: "today" | "yesterday" }
  | { action: "chat_digest"; days?: 1 | 7; topic?: string }
  | { action: "work_status" }
  | { action: "text"; text: string };

export const READ_ONLY_ACTIONS = new Set<string>([
  "records_summary",
  "records_query",
  "quota",
  "token_usage",
  "chat_digest",
  "work_status",
  "text",
]);

export type Actor = { sender: string; name?: string; isAdmin?: boolean };
export interface StepResult {
  action: string;
  ok: boolean;
  text: string;
  data?: unknown;
  error_kind?: string;
}
export interface RunCtx {
  e: any;
  groupId: string;
  viewer: Actor;
  tz: string;
  now: number;
  purpose: "chat" | "schedule" | "skill";
}

const notReady = (name: string) =>
  Error(`${name} 尚未接入：本分支是 D3b，动作层由 pkg/D-D3a 提供（design §5.4）`);

export function validateSteps(_steps: unknown): { ok: true; steps: Step[] } | { ok: false; reason: string } {
  throw notReady("validateSteps");
}

export async function runSteps(_ctx: RunCtx, _steps: Step[]): Promise<StepResult[]> {
  throw notReady("runSteps");
}

export function joinResults(_results: StepResult[], _title?: string): string {
  throw notReady("joinResults");
}

export async function composeWithNote(_ctx: RunCtx, _results: StepResult[], _note: string): Promise<string> {
  throw notReady("composeWithNote");
}
