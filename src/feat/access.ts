// Personal access links for the board and the MCP interface. A group member asks the bot for a link; the
// link carries a random token that stands for that person in that group. Only a hash of the token is kept.
// Opening /x/board/k/<token> stores it in a cookie and moves on to the board; API and MCP calls may send it
// as "Authorization: Bearer <token>" instead.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";

export type Person = { conv: string; uid: string; name: string };
const COOKIE = "tabd";
const MAX_PER_PERSON = 5;
const TOKEN = /^[a-f0-9]{40}$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS access(hash TEXT PRIMARY KEY, conv TEXT, uid TEXT, name TEXT, created INTEGER, seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS access_person ON access(conv, uid, revoked);`;

export async function hashToken(token: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("teamagent-access:" + token));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const newToken = () => [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join("");
const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];

/** A new link token for this person; their oldest links beyond the limit stop working. */
export async function issueAccess(hub: Hub, conv: string, who: { id: string; name: string }, now = Date.now()): Promise<string> {
  const token = newToken();
  hub.sql.exec("INSERT INTO access(hash, conv, uid, name, created, seen, revoked) VALUES(?,?,?,?,?,0,0)", await hashToken(token), conv, who.id, who.name, now);
  const live = rows(hub, "SELECT hash FROM access WHERE conv=? AND uid=? AND revoked=0 ORDER BY created DESC", conv, who.id);
  for (const r of live.slice(MAX_PER_PERSON)) hub.sql.exec("UPDATE access SET revoked=1 WHERE hash=?", r.hash);
  return token;
}
/** Who a token stands for, or null when it is unknown or was revoked. */
export async function checkAccess(hub: Hub, token: string | null | undefined, now = Date.now()): Promise<Person | null> {
  if (!token || !TOKEN.test(token)) return null;
  const hash = await hashToken(token), r = rows(hub, "SELECT conv, uid, name, seen FROM access WHERE hash=? AND revoked=0", hash)[0];
  if (!r) return null;
  if (now - Number(r.seen) > 60000) hub.sql.exec("UPDATE access SET seen=? WHERE hash=?", now, hash);
  return { conv: String(r.conv), uid: String(r.uid), name: String(r.name) };
}
/** Stops this person's links (all of them, or all in one group); returns how many stopped working. */
export function revokeAccess(hub: Hub, conv: string, uid: string): number {
  const n = Number(rows(hub, "SELECT COUNT(*) n FROM access WHERE conv=? AND uid=? AND revoked=0", conv, uid)[0].n);
  hub.sql.exec("UPDATE access SET revoked=1 WHERE conv=? AND uid=?", conv, uid);
  return n;
}
export function listAccess(hub: Hub, conv: string) {
  return rows(hub, "SELECT uid, name, created, seen FROM access WHERE conv=? AND revoked=0 ORDER BY created DESC", conv)
    .map(r => ({ uid: String(r.uid), name: String(r.name), created: Number(r.created), seen: Number(r.seen) }));
}

export const cookieToken = (cookie: string | null | undefined) => new RegExp("(?:^|;\\s*)" + COOKIE + "=([a-f0-9]{40})(?:;|$)").exec(cookie || "")?.[1] || "";
export const bearerToken = (auth: string | null | undefined) => /^Bearer\s+([a-f0-9]{40})$/i.exec(auth || "")?.[1] || "";
/** The person behind a request: the cookie set by a personal link, or a bearer token. */
export async function personOf(hub: Hub, req: Request): Promise<Person | null> {
  return checkAccess(hub, bearerToken(req.headers.get("authorization")) || cookieToken(req.headers.get("cookie")));
}
export const setCookie = (token: string) => COOKIE + "=" + token + "; Path=/x/; Max-Age=" + 180 * 86400 + "; HttpOnly; Secure; SameSite=Lax";
export const clearCookie = () => COOKIE + "=; Path=/x/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

/** The addresses people can use: the Worker's own, and the Hong Kong mirror when one is set up. */
export function bases(hub: Hub): string[] {
  const clean = (u: unknown) => String(u || "").replace(/\/+$/, "");
  const main = clean(hub.env.PUBLIC_URL) || "https://teamagent.inkboard-server.workers.dev", cn = clean((hub.env as any).PUBLIC_URL_CN);
  return cn && cn !== main ? [main, cn] : [main];
}

const feature: Feature = {
  name: "access",
  schema: SCHEMA,
  about: [
    "看板和本地 AI 接口用个人链接登录：群友在群里让我给看板链接，我发一个只代表他本人的链接，点开就登录，不用密码；链接里的令牌我只存哈希，查不回原文。",
    "每人最多同时有 5 个有效链接，再要新的最旧的就失效；说“把我的看板链接作废”我就全部停掉。链接发在群里，群里其他人也看得到，所以它只适合咱们这种互相信任的小群。",
  ],
  tools({ hub, conv, askers }): Tool[] {
    return [{
      name: "board_link",
      description: "给提问的群友一个看板的个人链接（团队看板：任务、群聊动态、记忆、仓库、作品和文件、监控、工具），或者作废他的链接。群友说“给我看板链接”“看板地址”“怎么登录看板”“本地 AI 怎么接任务”时用 op=link；说“把我的看板链接作废”用 op=revoke；op=list 看这个群里谁有有效链接。链接点开即登录，不要让群友输账号密码。返回里 links 是看板地址（有香港镜像时会有两个，大陆网络用镜像那个），mcp 是给本地 AI 接任务用的命令，Claude Code 和 Codex 各一行，把两行都原样发出来。",
      parameters: { type: "object", properties: { op: { type: "string", enum: ["link", "revoke", "list"] } }, required: ["op"] },
      run: async (a: any) => {
        const who = askers[askers.length - 1];
        if (a.op === "list") return { ok: true, people: listAccess(hub, conv).map(p => ({ name: p.name, last_used: p.seen ? new Date(p.seen).toISOString() : "还没用过" })) };
        if (!who?.id) return { ok: false, error: "不知道是谁在问，没法给个人链接；让他在群里直接对我说" };
        if (a.op === "revoke") return { ok: true, revoked: revokeAccess(hub, conv, who.id), note: "他之前的看板链接和本地 AI 令牌都失效了，要用就再要一个" };
        const token = await issueAccess(hub, conv, who), b = bases(hub);
        return {
          ok: true, for: who.name,
          links: b.map(u => u + "/x/board/k/" + token),
          ...(b.length > 1 ? { which: "第一个是直连地址，第二个是香港镜像，大陆网络打不开第一个就用第二个" } : {}),
          mcp: {
            what: "本地 AI 接任务：用哪个工具就在终端里运行对应的那一行，只用运行一次（别的工具填 address 这个地址，类型选 HTTP）",
            claude_code: "claude mcp add --scope user --transport http teamagent " + b[b.length - 1] + "/x/mcp/" + token,
            codex: "codex mcp add teamagent --url " + b[b.length - 1] + "/x/mcp/" + token,
            address: b[b.length - 1] + "/x/mcp/" + token,
          },
          note: "链接代表" + who.name + "本人，别转给群外的人；想作废就说“把我的看板链接作废”",
        };
      },
    }];
  },
  /**
   * POST /admin/access {"name":"…"}: a new MCP address for a member who already holds a link, so the owner
   * can connect a local AI tool as that member without asking in the group. The token is shown this once.
   */
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/access") return null;
    const json = (o: any, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    const conv = String(body?.conv || url.searchParams.get("conv") || hub.get("main") || "");
    if (req.method !== "POST") return json({ ok: true, conv, people: listAccess(hub, conv).map(p => ({ name: p.name, last_used: p.seen })) });
    const name = String(body?.name || "").trim();
    const who = rows(hub, "SELECT uid, name FROM access WHERE conv=? AND name=? AND revoked=0 ORDER BY created DESC LIMIT 1", conv, name)[0];
    if (!who) return json({ ok: false, error: "这个群里没有叫这个名字、手上有看板链接的人；先让他在群里对 Bot 说“给我看板链接”" }, 404);
    const live = Number(rows(hub, "SELECT COUNT(*) n FROM access WHERE conv=? AND uid=? AND revoked=0", conv, String(who.uid))[0].n);
    if (live >= MAX_PER_PERSON) return json({ ok: false, error: "他已经有 " + live + " 个有效链接，再发会把最早的挤掉；先让他作废不用的" }, 409);
    const token = await issueAccess(hub, conv, { id: String(who.uid), name: String(who.name) }), b = bases(hub);
    return json({ ok: true, for: String(who.name), mcp: b.map(u => u + "/x/mcp/" + token) });
  },
  async open(hub, req, url) {
    const m = /^\/x\/board\/k\/([a-f0-9]{40})\/?$/.exec(url.pathname);
    if (!m) return null;
    const ok = await checkAccess(hub, m[1]);
    const page = (s: number, t: string) => new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>看板</title><body style='font:16px/1.7 system-ui;margin:15vh auto;max-width:28em;padding:0 20px'><p>" + t, { status: s, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (!ok) return page(403, "这个看板链接已经失效了。在群里对 Bot 说“给我看板链接”再要一个。");
    return new Response(null, { status: 302, headers: { Location: "/x/board", "Set-Cookie": setCookie(m[1]), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  },
};
export default feature;
