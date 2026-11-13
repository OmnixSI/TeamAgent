/**
 * F11 FR-1 owns this file. Stub with the FROZEN signatures so FR-2/FR-3/FR-4 can import it before FR-1 lands.
 * FR-1 replaces the bodies; signatures and return shapes must not change.
 */
import type { FrConfig, FrRiskTag } from "./feature-request-types";

const todo = (name: string): never => { throw new Error("feature-request-core." + name + " not implemented (FR-1)"); };

/** team.json feature_requests merged over defaults (types.ts FrConfig). Never throws. */
export function loadFrConfig(): FrConfig { return todo("loadFrConfig"); }
/** Conservative regex classifier over the concatenated text. Order of tags = order of FrRiskTag. */
export function classifyRisk(text: string): FrRiskTag[] { return todo("classifyRisk"); }
/** Validates user-facing reply text. ok=false → why is a short Chinese reason for the studio to rewrite. */
export function sanitizeReply(text: string, max?: number): { ok: true; text: string } | { ok: false; why: string } { return todo("sanitizeReply"); }
/** Trim, collapse whitespace, cut to max chars (by code points). */
export function clip(text: unknown, max: number): string { return todo("clip"); }
/** YYYY-MM-DD in Australia/Sydney for the epoch ms. */
export function sydneyDay(ms: number): string { return todo("sydneyDay"); }
/** config.auto_senders contains sender OR members(id=sender|'qq:'+sender, role='owner', revoked=0). */
export async function isAutoSender(e: any, sender: string, cfg?: FrConfig): Promise<boolean> { return todo("isAutoSender"); }
