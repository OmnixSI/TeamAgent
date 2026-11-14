// Refreshes the bot's site logins. Run on a computer where you can log in by hand:
//
//   1. open a plain browser window with its own profile (no automation flags):
//        open -n -a "Google Chrome" --args --user-data-dir="$HOME/.inkboard-team/browser/login" \
//          --remote-debugging-address=127.0.0.1 --remote-debugging-port=9347 \
//          https://passport.bilibili.com/login https://www.rednote.com https://www.zhihu.com/signin https://www.douyin.com
//   2. log in to the sites in that window
//   3. node scripts/login-cookies.mjs <secrets.json> [port] [base-url]
//
// It reads the cookies over the loopback DevTools port and stores them in the Hub. Values are never printed.
import fs from "node:fs";

const [secretFile, port = "9347", base = "https://teamagent.inkboard-server.workers.dev"] = process.argv.slice(2);
const token = JSON.parse(fs.readFileSync(secretFile, "utf8")).ADMIN_TOKEN;
const SITES = {
  bili: { domains: ["bilibili.com"], need: "SESSDATA" },
  xhs: { domains: ["rednote.com"], need: "web_session" },   // xiaohongshu.com redirects here outside mainland China
  zhihu: { domains: ["zhihu.com"], need: "z_c0" },
  douyin: { domains: ["douyin.com"], need: "sessionid" },
  x: { domains: ["x.com"], need: "auth_token", only: ["auth_token", "ct0", "twid", "guest_id"] },
};
const info = await fetch("http://127.0.0.1:" + port + "/json/version").then(r => r.json());
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const cookies = await new Promise(res => {
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id === 1) res(m.result?.cookies || []); };
  ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
});
ws.close();
for (const [site, cfg] of Object.entries(SITES)) {
  const mine = cookies.filter(c => cfg.domains.some(d => c.domain.replace(/^\./, "").endsWith(d)) && (!cfg.only || cfg.only.includes(c.name)));
  if (!mine.some(c => c.name === cfg.need)) { console.log(site.padEnd(7), "not logged in, left unchanged"); continue; }
  const r = await fetch(base + "/admin/cookie", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ site, cookie: mine.map(c => c.name + "=" + c.value).join("; ") }),
  });
  console.log(site.padEnd(7), r.ok ? "saved (" + mine.length + " cookies)" : "failed " + r.status);
}
