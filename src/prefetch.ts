import { metaOf } from './view';
import { extractBili } from './inbound';
import { FAILURE_PREFIX } from './linkfail';
import { left } from './d1';
import { complaintIntent, requestPrefetch, refKey, targetIn, validRef, type VideoTarget } from './fetchjobs';
export { complaintIntent, bareMention } from './fetchjobs';

type Row = Record<string, any>;
const RETRY_PREFIX = 'prefetch-retry:v1:';
const DAY = 86400000, RETRY_GAP = 600000;

/** Links the sender attached themselves; a card title is not a prefetchable ref. */
function ownLink(latest: Row): VideoTarget | null {
  const meta = metaOf(latest);
  const body = String(latest.body ?? '');
  const urls = [...(meta.biliUrls || []), ...(meta.urls || []),
    ...(body.match(/(?:https?:\/\/|\/\/)[^\s"'<>\\\[\]()（）、，。；]+/g) || [])];
  const target = targetIn(meta.bili || [], latest.id) || targetIn(extractBili(urls, ''), latest.id);
  return target ? { ref: refKey(target), target } : null;
}

/** One statement answers both the 24h cache question and the in-flight job question. */
async function alreadyFetched(e: any, ref: string): Promise<boolean> {
  const row = await e.DB.prepare(`SELECT (SELECT created_at FROM media_notes WHERE id=?) legacy,
    (SELECT created_at FROM media_notes WHERE id=?) alias,(SELECT status FROM jobs WHERE id=?) job`)
    .bind('bili:' + ref, 'alias:v1:bili:' + ref, 'fetch-bili-' + ref).first();
  const fresh = (at: any) => typeof at === 'string' && Date.parse(at) >= Date.now() - DAY;
  return fresh(row?.legacy) || fresh(row?.alias) || !!row?.job;
}

/** Clear a failed short-link note once per ten minutes so a complaint can rebuild it. */
export async function retryFailedBili(e: any, ref: string): Promise<boolean> {
  if (!validRef(ref)) return false;
  const row = await e.DB.prepare("SELECT (SELECT body FROM media_notes WHERE id=?) failure,(SELECT created_at FROM media_notes WHERE id=?) retried")
    .bind(FAILURE_PREFIX + ref, RETRY_PREFIX + ref).first();
  let failure: any = null;
  try { failure = JSON.parse(row?.failure); } catch {}
  if (!failure || !(failure.until > Date.now())) return false;
  if (row?.retried && Date.parse(row.retried) > Date.now() - RETRY_GAP) return false;
  await e.DB.batch([
    e.DB.prepare("DELETE FROM media_notes WHERE id=?").bind(FAILURE_PREFIX + ref),
    e.DB.prepare("INSERT OR REPLACE INTO media_notes VALUES(?,?,?)")
      .bind(RETRY_PREFIX + ref, JSON.stringify({ reason: failure.reason ?? null, until: failure.until }), new Date().toISOString()),
  ]);
  return true;
}

/**
 * Wire one chat turn into prefetch: a non-@ link is read silently, and a complaint
 * about an unread link may clear its failure note to rebuild the same target.
 */
export async function prefetchTurn(e: any, x: { latest: Row; recent: Row[]; target: VideoTarget | null; cfg: any }): Promise<void> {
  if (!x.cfg?.bili?.enabled || !x.latest) return;
  if (x.target && complaintIntent(x.latest.body)) await retryFailedBili(e, x.target.ref);
  if (x.latest.mentioned) return;
  const own = ownLink(x.latest);
  if (!own) return;
  if (x.target && x.target.ref === own.ref) return;
  if (left(e) < 2 || await alreadyFetched(e, own.ref)) return;
  await requestPrefetch(e, own.ref);
}
