// Availability monitoring: does a site answer, how fast, with what status. No model, no cost, runs every few minutes.
// A target flips to DOWN after 3 failures in a row (the two re-checks come 30 s apart) and back to UP after 2 successes.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { clip, fmtFull, BJ } from "../util.ts";

export const LIMITS = {
  perConv: 20, perTick: 5, minEvery: 2, maxEvery: 1440, defaultEvery: 5, timeoutMs: 10000, maxTimeoutMs: 30000,
  failsToDown: 3, oksToUp: 2, recheckMs: 30000, remindMs: 6 * 3600000, bodyBytes: 200 * 1024,
  keepChecksMs: 7 * 86400000, keepIncidentsMs: 90 * 86400000,
  slowFactor: 5, slowRuns: 3, slowFloorMs: 200, slowMinSamples: 10,
};

/** The network seam: tests replace it with scripted responses. */
export const deps = { fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init) };

type Row = {
  id: number; conv: string; name: string; url: string; method: string; expect_status: number | null; expect_text: string | null;
  every_min: number; timeout_ms: number; state: string; since: number | null; last: number | null; next: number; fails: number;
  latency_ms: number | null; by: string; active: number; oks: number; fail_at: number | null; err: string | null;
  notified: number | null; slow_n: number; slow_day: string | null; created: number;
};
type Probe = { ok: boolean; status: number | null; ms: number; error: string | null };

const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as unknown as Row[];
const get = (hub: Hub, id: number) => rows(hub, "SELECT * FROM uptime WHERE id=?", id)[0];
const inFlight = new Set<number>();

// ---------- plain-Chinese helpers ----------
export function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + " 分钟";
  if (m < 1440) return Math.floor(m / 60) + " 小时" + (m % 60 ? " " + (m % 60) + " 分钟" : "");
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d + " 天" + (h ? " " + h + " 小时" : "");
}
const when = (ts: number | null) => (ts ? fmtFull(Number(ts), BJ) : "还没查过");
const dayOf = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

/** What a thrown fetch error means to a person. */
export function classify(e: any, timeoutMs: number): string {
  const msg = String(e?.message || e || "");
  if (e?.name === "AbortError" || e?.name === "TimeoutError" || /timeout|timed out|aborted/i.test(msg)) return `超时（${Math.round(timeoutMs / 1000)} 秒内没有回应）`;
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|dns|could not resolve|name not resolved|no such host/i.test(msg)) return "域名解析不了（DNS 查不到这个地址）";
  if (/certificate|tls|ssl|handshake|CERT_/i.test(msg)) return "HTTPS 证书或加密连接出问题（TLS 错误）";
  if (/refused|ECONNREFUSED/i.test(msg)) return "服务器拒绝连接";
  if (/reset|ECONNRESET|connection lost|closed|terminated/i.test(msg)) return "连接被中途断开";
  return "连不上：" + clip(msg || "未知错误", 80);
}

// ---------- one probe ----------
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader(), dec = new TextDecoder(), parts: string[] = [];
  let got = 0;
  while (got < max) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength; parts.push(dec.decode(value, { stream: true }));
  }
  reader.cancel().catch(() => {});
  return parts.join("").slice(0, max);
}

export async function probe(t: Pick<Row, "url" | "method" | "expect_status" | "expect_text" | "timeout_ms">): Promise<Probe> {
  const t0 = Date.now(), ctl = new AbortController();
  let timer: any;
  const timeout = new Promise<Probe>(res => { timer = setTimeout(() => { ctl.abort(); res({ ok: false, status: null, ms: Date.now() - t0, error: classify({ name: "AbortError" }, t.timeout_ms) }); }, t.timeout_ms); });
  const work = (async (): Promise<Probe> => {
    try {
      const method = t.expect_text ? "GET" : t.method === "HEAD" ? "HEAD" : "GET";
      const res = await deps.fetch(t.url, { method, redirect: "follow", signal: ctl.signal, headers: { "user-agent": "TeamAgent-uptime/1", accept: "*/*" } });
      const status = res.status;
      let body = "";
      if (t.expect_text && method === "GET") body = await readCapped(res, LIMITS.bodyBytes);
      else res.body?.cancel().catch(() => {});
      const ms = Date.now() - t0;
      const statusOk = t.expect_status ? status === t.expect_status : status >= 200 && status < 400;
      if (!statusOk) return { ok: false, status, ms, error: t.expect_status ? `返回了 ${status}，约定的是 ${t.expect_status}` : `返回了错误状态 ${status}` };
      if (t.expect_text && !body.includes(t.expect_text)) return { ok: false, status, ms, error: `页面能打开（${status}），但里面没有约定的文字「${clip(t.expect_text, 30)}」` };
      return { ok: true, status, ms, error: null };
    } catch (e: any) { return { ok: false, status: null, ms: Date.now() - t0, error: classify(e, t.timeout_ms) }; }
  })();
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}

// ---------- uptime numbers ----------
/** Share of the window the target was not in a declared incident, in percent. */
export function uptimePct(hub: Hub, t: Row, now: number, windowMs: number): number {
  const from = Math.max(now - windowMs, t.created), total = now - from;
  if (total <= 0) return 100;
  let down = 0;
  for (const i of hub.sql.exec("SELECT start, end FROM uptimeinc WHERE target=? AND start<? AND (end IS NULL OR end>?)", t.id, now, from).toArray() as any[])
    down += Math.min(now, Number(i.end ?? now)) - Math.max(from, Number(i.start));
  return Math.round((1 - Math.min(down, total) / total) * 10000) / 100;
}

function median7d(hub: Hub, id: number, now: number): number | null {
  const q = hub.sql.exec("SELECT COUNT(*) n FROM uptimelog WHERE target=? AND ok=1 AND ts>?", id, now - LIMITS.keepChecksMs).toArray()[0] as any;
  const n = Number(q.n);
  if (n < LIMITS.slowMinSamples) return null;
  const m = hub.sql.exec("SELECT ms FROM uptimelog WHERE target=? AND ok=1 AND ts>? ORDER BY ms LIMIT 1 OFFSET ?", id, now - LIMITS.keepChecksMs, Math.floor(n / 2)).toArray()[0] as any;
  return Number(m.ms);
}

export function prune(hub: Hub, now: number) {
  hub.sql.exec("DELETE FROM uptimelog WHERE ts<?", now - LIMITS.keepChecksMs);
  hub.sql.exec("DELETE FROM uptimeinc WHERE end IS NOT NULL AND end<?", now - LIMITS.keepIncidentsMs);
}

// ---------- the state machine ----------
export type CheckResult = { ok: boolean; state: string; status: number | null; ms: number; error: string | null; changed?: "down" | "up" };

export async function checkTarget(hub: Hub, t: Row, now = Date.now()): Promise<CheckResult> {
  const p = await probe(t);
  const median = p.ok ? median7d(hub, t.id, now) : null;
  hub.sql.exec("INSERT INTO uptimelog(target,ts,ok,status,ms,error) VALUES(?,?,?,?,?,?)", t.id, now, p.ok ? 1 : 0, p.status, p.ms, p.error);
  const base = { status: p.status, ms: p.ms, error: p.error, ok: p.ok };
  const every = t.every_min * 60000;
  let errOut = t.err, state = t.state, since = t.since, fails = t.fails, oks = t.oks, failAt = t.fail_at, notified = t.notified, slowN = t.slow_n, slowDay = t.slow_day;
  let next = now + every, changed: "down" | "up" | undefined;
  const say: string[] = [];
  const label = `「${clip(t.name, 40)}」`;

  if (p.ok) {
    fails = 0; failAt = null; errOut = null;
    if (state === "down") {
      oks += 1;
      if (oks >= LIMITS.oksToUp) {
        const inc = hub.sql.exec("SELECT id, start FROM uptimeinc WHERE target=? AND end IS NULL ORDER BY id DESC LIMIT 1", t.id).toArray()[0] as any;
        const began = inc ? Number(inc.start) : Number(since || now);
        if (inc) hub.sql.exec("UPDATE uptimeinc SET end=? WHERE id=?", now, inc.id);
        say.push(`${label}恢复了（${t.url}），这次一共打不开了 ${span(now - began)}。`);
        state = "up"; since = now; oks = 0; notified = null; changed = "up";
      } else next = now + LIMITS.recheckMs;
    } else {
      oks = 0;
      if (state !== "up") { state = "up"; since = now; }
      // Slow-down notice: latency well above the 7-day median for several checks in a row, at most once a day.
      if (median !== null && p.ms > Math.max(median * LIMITS.slowFactor, LIMITS.slowFloorMs)) {
        slowN += 1;
        if (slowN >= LIMITS.slowRuns && slowDay !== dayOf(now)) {
          slowDay = dayOf(now);
          say.push(`${label}变慢了：最近连着 ${slowN} 次要 ${p.ms} 毫秒才回应，平时一般是 ${median} 毫秒左右（${(p.ms / Math.max(median, 1)).toFixed(1)} 倍）。还能打开，先留意一下。`);
        }
      } else slowN = 0;
    }
  } else {
    oks = 0; slowN = 0;
    if (state === "down") {
      if (notified === null || now - notified >= LIMITS.remindMs) {
        const inc = hub.sql.exec("SELECT start FROM uptimeinc WHERE target=? AND end IS NULL ORDER BY id DESC LIMIT 1", t.id).toArray()[0] as any;
        say.push(`${label}还是打不开，已经 ${span(now - Number(inc?.start ?? since ?? now))} 了（${t.url}）：${p.error}`);
        notified = now;
      }
    } else {
      if (fails === 0) { failAt = now; errOut = p.error; }
      fails += 1;
      if (fails >= LIMITS.failsToDown) {
        state = "down"; since = now; notified = now; changed = "down";
        hub.sql.exec("INSERT INTO uptimeinc(target,start,end,error) VALUES(?,?,NULL,?)", t.id, failAt ?? now, errOut ?? p.error);
        say.push(`${label}打不开了（${t.url}）\n从 ${when(failAt ?? now)} 起连着 ${fails} 次检查都失败：${errOut ?? p.error}`);
      } else next = now + LIMITS.recheckMs;
    }
  }

  hub.sql.exec("UPDATE uptime SET state=?, since=?, last=?, next=?, fails=?, oks=?, fail_at=?, err=?, latency_ms=?, notified=?, slow_n=?, slow_day=? WHERE id=?",
    state, since, now, next, fails, oks, failAt, errOut, p.ms, notified, slowN, slowDay, t.id);
  for (const s of say) { try { await hub.say(t.conv, s); } catch (e: any) { console.log("uptime say failed", t.id, e?.message); } }
  return { ...base, state, changed };
}

/** Runs a check outside the clock (tool, admin, add) without overlapping a running one. */
async function checkNow(hub: Hub, id: number, conv?: string): Promise<any> {
  const t = get(hub, id);
  if (!t || (conv && t.conv !== conv)) return { ok: false, error: "没有这个编号的监控" };
  if (inFlight.has(id)) return { ok: false, error: "这个正在检查，稍等" };
  inFlight.add(id);
  try { return { id, name: t.name, ...describe(await checkTarget(hub, t)) }; } finally { inFlight.delete(id); }
}

function describe(r: CheckResult) {
  const now = r.ok ? "正常" : "这次没通过";
  return { ok: true, reachable: r.ok, http_status: r.status, latency_ms: r.ms, result: now, error: r.error || undefined, state: r.state === "down" ? "已判定打不开" : r.state === "up" ? "正常" : "刚加入，还在确认", note: !r.ok && r.state !== "down" ? "单次失败不算宕机，会在半分钟后再确认，连着 3 次失败才会在群里说" : undefined };
}

// ---------- the tool ----------
const everyText = (m: number) => (m % 1440 === 0 ? m / 1440 + " 天" : m % 60 === 0 ? m / 60 + " 小时" : m + " 分钟");
const nameOf = (url: string) => { try { const u = new URL(url); return u.host + (u.pathname.length > 1 ? clip(u.pathname, 30) : ""); } catch { return clip(url, 40); } };

function tools({ hub, conv, askers }: Ctx): Tool[] {
  return [{
    name: "uptime", slow: true,
    description: "盯群里自家网站和服务有没有挂：只看能不能打开、多快、返回什么状态，不花钱，查得勤。挂了（连着 3 次失败）会自动在群里说一声，恢复了也说。" +
      "和 watch 不同：watch 是读页面内容、看群友关心的事有没有变；这个只管“活着没有”。" +
      "op=add：url 是完整链接，name 可选（不填用域名），every 是每几分钟查一次（最少 2，默认 5），expect_status 可选（要求返回的状态码，不填就是 2xx/3xx 都算好），expect_text 可选（页面里必须出现的字，例如接口返回里的 \"ok\":true）；加的时候会马上查一次，把状态和响应时间告诉群友。" +
      "op=list：看这个群所有监控，每个有现在的状态、持续多久、最近响应时间、24 小时和 7 天可用率。op=remove：不盯了，给 id。op=check：现在就查，给 id，不给就查全部。op=history：给 id，看它的故障记录（什么时候开始、持续多久、第一个报错）。" +
      "每个群最多 20 个。证书快到期的提醒做不了（从这里读不到证书）。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "list", "remove", "check", "history"] },
        url: { type: "string", description: "完整链接，op=add 时必填" },
        name: { type: "string", description: "给它起个名字，例如“官网”“后端健康检查”" },
        every: { type: "number", description: "检查间隔，分钟，2 到 1440，默认 5" },
        expect_status: { type: "number", description: "要求的 HTTP 状态码，不填则 2xx/3xx 都算正常" },
        expect_text: { type: "string", description: "返回内容里必须包含的文字（只看前 200 KB）" },
        method: { type: "string", enum: ["GET", "HEAD"], description: "默认 GET；HEAD 更省流量但有些服务不支持" },
        id: { type: "number", description: "监控编号，op=remove / history 必填，op=check 可选" },
      },
      required: ["op"],
    },
    run: async a => {
      const now = Date.now();
      if (a.op === "list") {
        const list = rows(hub, "SELECT * FROM uptime WHERE conv=? ORDER BY id", conv);
        return {
          ok: true, count: list.length,
          targets: list.map(t => ({
            id: t.id, name: t.name, url: t.url, every: everyText(t.every_min),
            state: t.state === "down" ? "打不开" : t.state === "up" ? "正常" : "还在确认",
            since: t.since ? `${when(t.since)}（${span(now - t.since)}）` : undefined,
            last_checked: when(t.last), last_latency_ms: t.latency_ms, last_error: t.state === "down" ? t.err : undefined,
            uptime_24h: uptimePct(hub, t, now, 86400000) + "%", uptime_7d: uptimePct(hub, t, now, 7 * 86400000) + "%",
          })),
        };
      }
      if (a.op === "remove") {
        const t = rows(hub, "SELECT * FROM uptime WHERE id=? AND conv=?", Number(a.id), conv)[0];
        if (!t) return { ok: false, error: "这个群里没有编号 " + a.id + " 的监控" };
        for (const q of ["DELETE FROM uptime WHERE id=?", "DELETE FROM uptimelog WHERE target=?", "DELETE FROM uptimeinc WHERE target=?"]) hub.sql.exec(q, t.id);
        return { ok: true, removed: t.id, name: t.name };
      }
      if (a.op === "check") {
        if (a.id !== undefined && a.id !== null && a.id !== "") return checkNow(hub, Number(a.id), conv);
        const ids = rows(hub, "SELECT * FROM uptime WHERE conv=? AND active=1 ORDER BY id", conv).map(t => t.id);
        if (!ids.length) return { ok: false, error: "这个群还没有监控" };
        return { ok: true, results: await Promise.all(ids.map(id => checkNow(hub, id, conv))) };
      }
      if (a.op === "history") {
        const t = rows(hub, "SELECT * FROM uptime WHERE id=? AND conv=?", Number(a.id), conv)[0];
        if (!t) return { ok: false, error: "这个群里没有编号 " + a.id + " 的监控" };
        const inc = hub.sql.exec("SELECT * FROM uptimeinc WHERE target=? ORDER BY id DESC LIMIT 20", t.id).toArray() as any[];
        return {
          ok: true, id: t.id, name: t.name, state: t.state === "down" ? "打不开" : "正常",
          incidents: inc.map(i => ({ from: when(i.start), to: i.end ? when(i.end) : "还没恢复", lasted: span(Number(i.end ?? now) - Number(i.start)), first_error: i.error })),
          note: inc.length ? undefined : "最近 90 天没有故障记录",
        };
      }
      if (a.op !== "add") return { ok: false, error: "op 只能是 add / list / remove / check / history" };

      const url = String(a.url || "").trim();
      if (!/^https?:\/\/[^\s/]+\S*$/i.test(url)) return { ok: false, error: "要一个 http 或 https 开头的完整链接" };
      const mine = rows(hub, "SELECT * FROM uptime WHERE conv=? AND active=1", conv);
      if (mine.length >= LIMITS.perConv) return { ok: false, error: `这个群已经盯着 ${LIMITS.perConv} 个地址了，先去掉几个再加` };
      const dup = mine.find(t => t.url === url);
      if (dup) return { ok: false, error: `这个地址已经在盯了（编号 ${dup.id}）` };
      const asked = Number(a.every) > 0 ? Math.round(Number(a.every)) : LIMITS.defaultEvery;
      const every = Math.min(LIMITS.maxEvery, Math.max(LIMITS.minEvery, asked));
      const status = Number(a.expect_status) >= 100 && Number(a.expect_status) <= 599 ? Math.round(Number(a.expect_status)) : null;
      const text = String(a.expect_text || "").trim() || null;
      const method = String(a.method || "").toUpperCase() === "HEAD" && !text ? "HEAD" : "GET";
      const name = clip(String(a.name || "").trim() || nameOf(url), 60);
      const id = Number(hub.sql.exec(
        "INSERT INTO uptime(conv,name,url,method,expect_status,expect_text,every_min,timeout_ms,state,since,last,next,fails,latency_ms,by,active,oks,created,slow_n) VALUES(?,?,?,?,?,?,?,?,'new',NULL,NULL,?,0,NULL,?,1,0,?,0) RETURNING id",
        conv, name, url, method, status, text, every, LIMITS.timeoutMs, now + every * 60000, String(askers?.[0]?.name || ""), now).toArray()[0].id);
      const r = await checkNow(hub, id, conv);
      return { ...r, id, every: everyText(every), clamped: every !== asked ? "间隔超出允许范围，已按 " + everyText(every) + " 设置" : undefined };
    },
  }];
}

const feature: Feature = {
  name: "uptime",
  schema: `CREATE TABLE IF NOT EXISTS uptime(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, name TEXT, url TEXT, method TEXT, expect_status INTEGER, expect_text TEXT, every_min INTEGER, timeout_ms INTEGER, state TEXT, since INTEGER, last INTEGER, next INTEGER, fails INTEGER, latency_ms INTEGER, by TEXT, active INTEGER, oks INTEGER, fail_at INTEGER, err TEXT, notified INTEGER, slow_n INTEGER, slow_day TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS uptime_due ON uptime(active, next);
CREATE TABLE IF NOT EXISTS uptimelog(id INTEGER PRIMARY KEY AUTOINCREMENT, target INTEGER, ts INTEGER, ok INTEGER, status INTEGER, ms INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS uptimelog_t ON uptimelog(target, ts);
CREATE TABLE IF NOT EXISTS uptimeinc(id INTEGER PRIMARY KEY AUTOINCREMENT, target INTEGER, start INTEGER, end INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS uptimeinc_t ON uptimeinc(target, start);`,
  tools,
  tick(hub, now) {
    if (now - Number(hub.get("uptime:prune") || 0) > 3600000) { hub.set("uptime:prune", String(now)); try { prune(hub, now); } catch (e: any) { console.log("uptime prune failed", e?.message); } }
    const due = rows(hub, "SELECT * FROM uptime WHERE active=1 AND next<=? ORDER BY next LIMIT ?", now, LIMITS.perTick + inFlight.size);
    let started = 0;
    for (const t of due) {
      if (started >= LIMITS.perTick) break;
      if (inFlight.has(t.id)) continue;
      // Not due again until the probe has had its full timeout; the result sets the real next time.
      hub.sql.exec("UPDATE uptime SET next=? WHERE id=?", now + t.timeout_ms + 20000, t.id);
      inFlight.add(t.id); started++;
      hub.ctx.waitUntil(checkTarget(hub, t, now).then(() => {}, e => console.log("uptime check failed", t.id, e?.message)).finally(() => inFlight.delete(t.id)));
    }
  },
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/uptime") return null;
    const json = (o: any, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    if (req.method === "POST") return json(await checkNow(hub, Number(body?.check)));
    const now = Date.now();
    return json({
      targets: rows(hub, "SELECT * FROM uptime ORDER BY id").map(t => ({
        id: t.id, conv: t.conv, name: t.name, url: t.url, every_min: t.every_min, state: t.state, fails: t.fails, oks: t.oks, active: !!t.active,
        since: when(t.since), last: when(t.last), due_in_s: Math.round((t.next - now) / 1000), latency_ms: t.latency_ms, err: t.err,
        up24h: uptimePct(hub, t, now, 86400000), up7d: uptimePct(hub, t, now, 7 * 86400000),
      })),
      open_incidents: hub.sql.exec("SELECT * FROM uptimeinc WHERE end IS NULL ORDER BY id").toArray(),
    });
  },
  about: [
    "我能替群里盯自家网站和服务有没有挂：给我一个链接，我每隔几分钟（最少 2 分钟，默认 5 分钟）访问一次，看能不能打开、多快、返回什么状态；还可以要求页面里必须有某段文字。这一项不花钱，也不用模型。",
    "它和盯网页内容的功能不一样：那个是读页面看群友关心的事有没有变，这个只管“活着没有”。",
    "防误报：某个地址连着 3 次检查失败（失败后半分钟再查两次）才算挂了，我会在群里说一次：什么挂了、从什么时候起、原因是超时、域名解析不了、证书出错还是返回了错误状态。挂着的时候最多每 6 小时提醒一次，恢复后连着 2 次正常才说好了，并告诉你们挂了多久。",
    "响应时间连着 3 次超过 7 天中位数的 5 倍，我会提醒一次，同一个地址一天最多一次。",
    "每个群最多盯 20 个地址。检查记录留 7 天，每次故障（开始、结束、持续多久、第一个报错）留 90 天，可以问我某个地址的故障记录和 24 小时、7 天的可用率。",
    "HTTPS 证书什么时候到期我查不了（这里读不到证书信息），所以不做证书到期提醒。",
  ],
};
export default feature;
