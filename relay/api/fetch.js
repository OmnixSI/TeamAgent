// Egress relay for sites that refuse Cloudflare's addresses. Runs as a plain Node function in Hong Kong.
// Not an open proxy: a shared key is required and only the listed sites can be fetched.
export const config = { maxDuration: 30 };

const ALLOW = /(^|\.)(bilibili\.com|b23\.tv|bilivideo\.com|hdslb\.com|xiaohongshu\.com|xhslink\.com|xhslink\.cn|xhscdn\.com|rednote\.com|douyin\.com|iesdouyin\.com|douyinpic\.com|weibo\.com|weibo\.cn|sinaimg\.cn|zhihu\.com|zhimg\.com|xueqiu\.com|weixin\.qq\.com)$/i;

export default async function handler(req, res) {
  const key = process.env.RELAY_KEY;
  if (!key || req.headers["x-relay-key"] !== key) return res.status(401).json({ error: "unauthorized" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { url, method = "GET", headers = {}, body, redirect = "follow", max = 3000000 } = req.body || {};
  let target;
  try { target = new URL(url); } catch { return res.status(400).json({ error: "bad url" }); }
  if (target.protocol !== "https:" || !ALLOW.test(target.hostname)) return res.status(403).json({ error: "host not allowed" });
  try {
    const r = await fetch(target, { method, headers, body, redirect, signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).json({
      status: r.status, url: r.url, type: r.headers.get("content-type"), location: r.headers.get("location"),
      bytes: buf.length, body: buf.subarray(0, Math.min(Number(max) || 3000000, 3000000)).toString("base64"),
    });
  } catch (e) {
    return res.status(200).json({ status: 0, error: String(e?.message || e).slice(0, 200) });
  }
}
