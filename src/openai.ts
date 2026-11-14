// LOCAL COMPILE STUB for pkg/F8-2 — do not commit. F8-0 (pkg/F8-0) replaces this file.
export type OpenAiFail = {
  ok: false;
  error_kind: "refused" | "budget" | "quota" | "timeout" | "upstream" | "auth" | "unsupported" | "denied";
  retryable: boolean;
  status?: number;
  reason_text: string;
  next_action: string;
};
export type OpenAiOk<T = any> = { ok: true; json: T; latency_ms: number; status: number };

export async function callOpenAi<T = any>(_e: any, _o: any): Promise<OpenAiOk<T> | OpenAiFail> {
  throw new Error("F8-0 stub: callOpenAi is not implemented in pkg/F8-2");
}
export async function reserveQuota(
  _e: any,
  _o: { kind: string; key: string; limit: number; windowMs?: number },
): Promise<{ ok: boolean; used: number; limit: number; reservation_id?: string }> {
  throw new Error("F8-0 stub: reserveQuota is not implemented in pkg/F8-2");
}
export async function releaseQuota(_e: any, _reservationId: string): Promise<void> {
  throw new Error("F8-0 stub: releaseQuota is not implemented in pkg/F8-2");
}
