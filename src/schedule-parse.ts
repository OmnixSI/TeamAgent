// ⚠️ 占位文件，不属于 D3b。
// 真实现由 pkg/D-D2 提供（design §5.5）。D3b 为了能独立 `npm run check` / 构建，
// 先按冻结签名留空：调用会立刻抛错，绝不会静默解析错时间。
// 合并顺序：pkg/D-D2 先于 pkg/D-D3b；冲突时整文件取 D-D2 的版本，删掉本文件头这段说明。
import type { Step } from "./actions";

export type When =
  | { cadence: "daily"; time: string; tz: string }
  | { cadence: "weekly"; time: string; weekdays: number[]; tz: string }
  | { cadence: "monthly"; time: string; month_days: number[]; tz: string }
  | { cadence: "once"; run_at: number; tz: string }
  | { cadence: "every"; every_minutes: number; window?: [string, string]; until?: number; tz: string };

export type ParseResult =
  | { ok: true; when: When; tzSaid: boolean; matched: string }
  | { ok: false; missing: "time" | "date"; cadence?: string }
  | null;

const notReady = (name: string) =>
  Error(`${name} 尚未接入：本分支是 D3b，时间解析由 pkg/D-D2 提供（design §5.5）`);

export function parseWhen(_text: string, _now: number, _defaultTz?: string): ParseResult {
  throw notReady("parseWhen");
}

export function parseContent(_text: string): Step[] {
  throw notReady("parseContent");
}

export function describeWhen(_when: When, _now: number): string {
  throw notReady("describeWhen");
}
