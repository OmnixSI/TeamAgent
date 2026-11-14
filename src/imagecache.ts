import type { CronJob } from "./cron-extra";
import type { Media } from "./inbound";
import { fetchImage, sha256 } from "./vision";

// F8-V2: cache an inbound image as soon as the message arrives, before its QQ URL expires (#222).
// The attachment metadata has no content hash, so the cache key is sha256(url): both the intake
// path (downloadAndStore) and the vision path (getCached) can derive it without another lookup.
export const MAX_IMAGE_CACHE_BYTES = 1_500_000;
export const IMAGE_CACHE_TTL_MS = 7 * 86_400_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_IMAGES_PER_MESSAGE = 4;

export type ImageCacheErrorKind = "denied" | "timeout" | "upstream" | "too_large";

const SKIPPED: Record<ImageCacheErrorKind, string> = {
  denied: "图片地址不在允许的 QQ 图片域名白名单内",
  timeout: "下载超时或网络中断",
  upstream: "图片服务器返回异常或内容不是图片",
  too_large: "图片超过 1.5MB 缓存上限",
};

function errorKind(event: any): ImageCacheErrorKind {
  const reason = String(event?.reason || "");
  if (reason === "oversize") return "too_large";
  if (reason === "blocked" || reason === "redirect_limit") return "denied";
  if (reason === "timeout" || reason === "network") return "timeout";
  return "upstream";
}

export async function sourceSha(url: string) {
  return sha256(new TextEncoder().encode(url));
}

function blob(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export type ImageCacheDownload =
  | { ok: true; sha: string; bytes: number; mime: string; stored: true }
  | { ok: false; sha: string; error_kind: ImageCacheErrorKind; stage: string; reason: string };

/** Download one attachment through the existing F2 URL/redirect/size gate and cache the bytes. */
export async function downloadAndStore(
  e: any,
  o: { sha?: string; url: string; groupId: string; messageId: string; idx: number; width?: number; height?: number },
): Promise<ImageCacheDownload> {
  const sha = o.sha || (await sourceSha(o.url));
  let failure: any = null;
  const report = (event: any) => {
    if (event?.status === "failed") failure = event;
  };
  let fetched: { bytes: Uint8Array; mime: string } | null = null;
  try {
    fetched = await fetchImage(o.url, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), MAX_IMAGE_CACHE_BYTES, report);
  } catch {
    fetched = null;
    failure = failure || { stage: "fetch", reason: "network" };
  }
  const now = Date.now();
  if (fetched?.bytes?.byteLength) {
    await e.DB.prepare(
      "INSERT INTO image_cache(sha,group_id,mime,bytes,width,height,data,created_at,expires_at,source_msg,source_idx,skipped_reason,error_kind,error_stage) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL) ON CONFLICT(sha) DO UPDATE SET " +
        "mime=excluded.mime,bytes=excluded.bytes,width=excluded.width,height=excluded.height,data=excluded.data," +
        "created_at=excluded.created_at,expires_at=excluded.expires_at,source_msg=excluded.source_msg," +
        "source_idx=excluded.source_idx,skipped_reason=NULL,error_kind=NULL,error_stage=NULL " +
        "WHERE image_cache.data IS NULL AND excluded.data IS NOT NULL",
    )
      .bind(
        sha,
        o.groupId,
        fetched.mime,
        fetched.bytes.byteLength,
        o.width ?? null,
        o.height ?? null,
        blob(fetched.bytes),
        now,
        now + IMAGE_CACHE_TTL_MS,
        o.messageId,
        o.idx,
      )
      .run();
    return { ok: true, sha, bytes: fetched.bytes.byteLength, mime: fetched.mime, stored: true };
  }
  const kind = errorKind(failure);
  await e.DB.prepare(
    "INSERT INTO image_cache(sha,group_id,mime,bytes,width,height,data,created_at,expires_at,source_msg,source_idx,skipped_reason,error_kind,error_stage) " +
      "VALUES(?,?,NULL,?,?,?,NULL,?,?,?,?,?,?,?) ON CONFLICT(sha) DO NOTHING",
  )
    .bind(
      sha,
      o.groupId,
      Number(failure?.bytes || 0) || 0,
      o.width ?? null,
      o.height ?? null,
      now,
      now + IMAGE_CACHE_TTL_MS,
      o.messageId,
      o.idx,
      SKIPPED[kind],
      kind,
      String(failure?.stage || "fetch"),
    )
    .run();
  return { ok: false, sha, error_kind: kind, stage: String(failure?.stage || "fetch"), reason: String(failure?.reason || "network") };
}

export type ImageCacheRow = {
  sha: string;
  group_id: string;
  mime: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  data: Uint8Array | null;
  created_at: number;
  expires_at: number;
  source_msg: string | null;
  source_idx: number | null;
  skipped_reason: string | null;
  error_kind: string | null;
  error_stage: string | null;
};

const primed = new WeakMap<object, Map<string, ImageCacheRow | null>>();

/** Seed the per-invocation cache map from the single prefetch statement in vision's coldPicks. */
export function primeImageCache(e: any, rows: any[], shas: string[]) {
  const map = new Map<string, ImageCacheRow | null>();
  for (const sha of shas) map.set(sha, null);
  for (const row of rows) {
    map.set(String(row.sha), { ...row, sha: String(row.sha), data: row.data ? new Uint8Array(row.data) : null });
  }
  primed.set(e, map);
}

/** Cached bytes, or the recorded skip reason, for this sha. Expired rows never count as hits. */
export async function getCached(e: any, sha: string, groupId?: string): Promise<ImageCacheRow | null> {
  const map = primed.get(e);
  if (map?.has(sha)) {
    const row = map.get(sha);
    if (!row || (groupId && row.group_id !== groupId) || row.expires_at <= Date.now()) return null;
    return row;
  }
  const row = await e.DB.prepare(
    "SELECT sha,group_id,mime,bytes,width,height,data,created_at,expires_at,source_msg,source_idx,skipped_reason,error_kind,error_stage " +
      "FROM image_cache WHERE sha=? AND expires_at>?",
  )
    .bind(sha, Date.now())
    .first();
  if (!row) return null;
  if (groupId && row.group_id !== groupId) return null;
  return { ...row, data: row.data ? new Uint8Array(row.data) : null };
}

export async function purgeExpired(e: any, now = Date.now()) {
  const result = await e.DB.prepare("DELETE FROM image_cache WHERE expires_at<=?").bind(now).run();
  return Number((result as any)?.meta?.changes ?? (result as any)?.changes ?? 0);
}

/** The image attachments of one message, indexed the same way vision's pickImages indexes them. */
export function imageCacheEntries(media: Media[] = []) {
  const out: { url: string; idx: number; width?: number; height?: number }[] = [];
  let idx = -1;
  for (const m of media) {
    if (m.kind !== "image") continue;
    idx++;
    if (typeof m.url === "string" && m.url) out.push({ url: m.url, idx, ...(m.width != null ? { width: m.width } : {}), ...(m.height != null ? { height: m.height } : {}) });
  }
  return out.slice(0, MAX_IMAGES_PER_MESSAGE);
}

/** Queue job body: download every image of one message without slowing down the inbound request. */
export async function cacheMessageImages(e: any, p: { group?: string; message?: string; images?: any[] }) {
  for (const img of p.images || []) {
    if (typeof img?.url !== "string" || !img.url) continue;
    await downloadAndStore(e, {
      url: img.url,
      groupId: String(p.group || ""),
      messageId: String(p.message || ""),
      idx: Number(img.idx) || 0,
      ...(img.width != null ? { width: Number(img.width) } : {}),
      ...(img.height != null ? { height: Number(img.height) } : {}),
    });
  }
}

export const imageCachePurgeJob: CronJob = {
  name: "image_cache_purge",
  async run(e: any, now: Date) {
    await purgeExpired(e, now.getTime());
  },
};
