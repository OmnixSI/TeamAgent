// 占位文件：归 D3a（src/actions.ts 由 D3a 实现，签名见 design §5.4）。
// D6 为了在 D3a 未合时单独 `npm run check` / `npm test` 能过而放此占位；
// 合并 D3a 时用 D3a 的 src/actions.ts **整文件替换**本文件，不要保留这里的实现。
// 本文件的函数只抛错，避免未合并时被静默当成可用动作层。
export type Step =
  | { action: "records_summary"; type: string; group_by?: string; period?: "all" | "today" | "yesterday" | "this_month" | "last_month" }
  | { action: "records_query"; type: string; filter?: { person?: string; status?: string; text?: string }; limit?: number }
  | { action: "quota" }
  | { action: "token_usage"; period?: "today" | "yesterday" }
  | { action: "chat_digest"; days?: 1 | 7; topic?: string }
  | { action: "work_status" }
  | { action: "text"; text: string };

export interface StepResult { action: string; ok: boolean; text: string; data?: unknown; error_kind?: string }
export interface RunCtx { e: any; groupId: string; viewer: { sender: string; name: string; isAdmin: boolean }; tz: string; now: number; purpose: "chat" | "schedule" | "skill" }

const PLACEHOLDER = "src/actions.ts 是 D6 的占位文件，D3a 尚未合并";

export function validateSteps(_steps: unknown): { ok: true; steps: Step[] } | { ok: false; reason: string } {
  throw new Error(PLACEHOLDER);
}

export async function runSteps(_ctx: RunCtx, _steps: Step[]): Promise<StepResult[]> {
  throw new Error(PLACEHOLDER);
}

export function joinResults(_results: StepResult[], _title?: string): string {
  throw new Error(PLACEHOLDER);
}
