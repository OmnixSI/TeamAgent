// A daily look at the things that quietly stop working: tokens that expire, logins that lapse, money
// that runs low, plan allowances that fill up. Problems are told to the group once, not every day.
import type { Hub } from "./hub.ts";
import { relay } from "./sites.ts";
import type { Net } from "./sites.ts";
import { BJ, fmtDate } from "./util.ts";

export type Check = { key: string; ok: boolean; text: string };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export async function checkHealth(hub: Hub): Promise<Check[]> {
  const env = hub.env, main = hub.get("main") || "", out: Check[] = [];
  const net: Net = { env: env as any, cookie: site => hub.get("cookie:" + site) || "" };
  const guard = async (key: string, run: () => Promise<Check | null>) => {
    try { const c = await run(); if (c) out.push(c); } catch (e: any) { out.push({ key, ok: false, text: key + " 检查本身出错：" + String(e?.message || e).slice(0, 80) }); }
  };
  await Promise.all([
    guard("github", async () => {
      if (!env.GITHUB_TOKEN) return { key: "github", ok: false, text: "没有配置 GitHub 令牌，查不了仓库" };
      const r = await fetch("https://api.github.com/orgs/" + (env.GITHUB_ORG || "OmnixSI"), { headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, "User-Agent": "teamagent" }, signal: AbortSignal.timeout(15000) });
      if (r.status === 401 || r.status === 403) return { key: "github", ok: false, text: "GitHub 令牌失效了（" + r.status + "），现在查不了仓库，要群主换一个" };
      const exp = r.headers.get("github-authentication-token-expiration");
      if (!exp) return { key: "github", ok: true, text: "GitHub 令牌有效，没有设过期时间" };
      const days = Math.floor((Date.parse(exp.replace(" UTC", "Z").replace(" ", "T")) - Date.now()) / 86400000);
      return { key: "github", ok: days > 5, text: "GitHub 令牌 " + exp.slice(0, 10) + " 过期（还有 " + days + " 天）" + (days > 5 ? "" : "，过期后我查不了仓库，要群主换一个长期的") };
    }),
    guard("deepseek", async () => {
      const cny = await hub.accounts.balance(), floor = Number(hub.edit.cfg(main, "balance_alert"));
      if (cny === null) return { key: "deepseek", ok: false, text: "DeepSeek 余额查不到（密钥可能有问题）" };
      return { key: "deepseek", ok: cny >= floor, text: "DeepSeek 余额 ¥" + cny + (cny >= floor ? "" : "，低于提醒线 ¥" + floor + "，该充值了") };
    }),
    guard("spend", async () => {
      const day = fmtDate(Date.now() - 86400000, BJ), cny = Math.round(hub.accounts.dayEstimateCny(day) * 100) / 100, cap = Number(hub.edit.cfg(main, "spend_alert"));
      return { key: "spend", ok: cny <= cap, text: "昨天（" + day + "）估算花了 ¥" + cny + (cny <= cap ? "" : "，超过提醒线 ¥" + cap) };
    }),
    guard("openai", async () => {
      if (!env.OPENAI_API_KEY) return { key: "openai", ok: false, text: "没有配置 OpenAI 密钥，画不了图" };
      const r = await fetch("https://api.openai.com/v1/models?limit=1", { headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, signal: AbortSignal.timeout(15000) });
      return { key: "openai", ok: r.status !== 401, text: r.status === 401 ? "OpenAI 密钥失效了，画图、跑代码、音频转写都用不了" : "OpenAI 密钥有效" };
    }),
    guard("bili", async () => {
      const cookie = net.cookie("bili");
      if (!cookie) return { key: "bili", ok: false, text: "B 站没有保存登录，字幕读不了" };
      const r = await relay(net, { url: "https://api.bilibili.com/x/web-interface/nav", headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/", Cookie: cookie } });
      if (r.status !== 200) return { key: "relay", ok: false, text: "香港中转不通（" + (r.error || r.status) + "），国内站点和语音都会受影响" };
      const login = JSON.parse(r.text)?.data?.isLogin;
      return { key: "bili", ok: !!login, text: login ? "B 站登录有效" : "B 站登录过期了，字幕读不了，要群主重新登录一次" };
    }),
    guard("zhihu", async () => {
      const cookie = net.cookie("zhihu");
      if (!cookie) return null;
      const r = await relay(net, { url: "https://www.zhihu.com/api/v4/me", headers: { "User-Agent": UA, Cookie: cookie } });
      return { key: "zhihu", ok: r.status === 200, text: r.status === 200 ? "知乎登录有效" : "知乎登录过期了（" + r.status + "），回答读不全，要群主重新登录一次" };
    }),
  ]);
  for (const site of ["xhs", "x"]) if (!net.cookie(site)) out.push({ key: site, ok: false, text: (site === "xhs" ? "小红书" : "X") + " 没有保存登录" });
  for (const t of hub.plan.tight(hub.store.r2Bytes())) out.push({ key: "plan:" + t.slice(0, 12), ok: false, text: "Cloudflare 套餐：" + t + "，到停止线会自动停用到下个周期" });
  if (!hub.gateway.connected) out.push({ key: "gateway", ok: false, text: "QQ 长连接现在是断开的" });
  return out;
}

/** Runs the checks, remembers the result, and returns the problems that have not been announced in the last three days. */
export async function dailyHealth(hub: Hub) {
  const checks = await checkHealth(hub), now = Date.now();
  hub.set("health:last", JSON.stringify({ at: now, checks }));
  const fresh = checks.filter(c => !c.ok && now - Number(hub.get("alert:" + c.key) || 0) > 3 * 86400000);
  for (const c of fresh) hub.set("alert:" + c.key, String(now));
  for (const c of checks.filter(c => c.ok)) if (hub.get("alert:" + c.key)) hub.set("alert:" + c.key, "0");
  return fresh;
}
