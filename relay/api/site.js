// Mirror of the bot's own public pages (board, published pages, toolbox, file links) for networks that cannot
// reach *.workers.dev. Runs in Hong Kong. Only /x/… and /p/… of the one Worker are forwarded; nothing else.
export const config = { maxDuration: 60 };

const ORIGIN = (process.env.SITE_ORIGIN || "https://teamagent.inkboard-server.workers.dev").replace(/\/+$/, "");
const PASS_UP = ["accept", "accept-language", "authorization", "content-type", "cookie", "if-none-match", "if-modified-since", "range", "user-agent", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const DROP_DOWN = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie", "location", "alt-svc", "nel", "report-to", "cf-ray", "cf-cache-status", "server"]);
const MAX_BODY = 4 * 1024 * 1024;

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) return null; chunks.push(c); }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const here = new URL(req.url, "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "mirror"));
  const path = here.searchParams.get("__p") || "";
  here.searchParams.delete("__p");
  if (!/^\/(x|p)\/[^\s]*$/.test(path) || path.includes("..")) { res.statusCode = 404; return res.end("not found"); }
  const target = ORIGIN + path + (here.searchParams.size ? "?" + here.searchParams.toString() : "");
  const headers = { "x-forwarded-host": here.host, "x-mirror": "hk" };
  for (const h of PASS_UP) if (req.headers[h]) headers[h] = req.headers[h];
  // A page served by this mirror posts to this mirror: to the Worker that is a same-site request.
  if (req.headers.origin) headers.origin = req.headers.origin === here.origin ? ORIGIN : req.headers.origin;
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req);
    if (body === null) { res.statusCode = 413; res.setHeader("content-type", "text/plain; charset=utf-8"); return res.end("通过香港镜像最多传 4 MB，大文件请用直连地址：" + ORIGIN + path); }
  }
  let r;
  try { r = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(55000) }); }
  catch (e) { res.statusCode = 502; res.setHeader("content-type", "text/plain; charset=utf-8"); return res.end("镜像连不上源站：" + String(e?.message || e).slice(0, 120)); }
  res.statusCode = r.status;
  for (const [k, v] of r.headers) if (!DROP_DOWN.has(k)) res.setHeader(k, v);
  const cookies = r.headers.getSetCookie?.() || [];
  if (cookies.length) res.setHeader("set-cookie", cookies);
  const loc = r.headers.get("location");
  if (loc) res.setHeader("location", loc.startsWith(ORIGIN) ? loc.slice(ORIGIN.length) || "/" : loc);
  if (!r.body || req.method === "HEAD") return res.end();
  try { for await (const chunk of r.body) res.write(chunk); } catch {}
  res.end();
}
