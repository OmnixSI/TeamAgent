import { recoverDeliveries, deliverFiles } from "./delivery.mjs";
// Local official QQ gateway. No model runs here; all business processing remains in the team Worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const home = path.join(os.homedir(), ".inkboard-team");
const config = JSON.parse(fs.readFileSync(path.join(home, "config.json")));
const secret = JSON.parse(
  fs.readFileSync(path.join(home, "worker-secrets.json")),
);
const sdk = await import(
  path.join(
    home,
    "sdk/node_modules/@tencent-connect/qqbot-nodejs/dist/index.js",
  )
);
const sessionFile = path.join(home, "qq-session.json");
const sessionPersistence = {
  load: () => {
    try {
      return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    } catch {
      return null;
    }
  },
  save: (value) => {
    fs.writeFileSync(sessionFile + ".tmp", JSON.stringify(value), {
      mode: 0o600,
    });
    fs.renameSync(sessionFile + ".tmp", sessionFile);
  },
  clear: () => {
    fs.rmSync(sessionFile, { force: true });
  },
};
const spool = path.join(home, "qq-spool");
fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
let seed = secret.QQ_APP_SECRET;
while (seed.length < 32) seed += seed;
const key = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seed.slice(0, 32)),
  ]),
  format: "der",
  type: "pkcs8",
});
let flushing = false,
  connected = false,
  blocked = "";
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (const f of fs
      .readdirSync(spool)
      .filter((x) => x.endsWith(".json"))
      .sort(
        (a, b) =>
          fs.statSync(path.join(spool, a)).mtimeMs -
          fs.statSync(path.join(spool, b)).mtimeMs,
      )
      .slice(0, 30)) {
      const raw = fs.readFileSync(path.join(spool, f), "utf8");
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.sign(null, Buffer.from(ts + raw), key).toString("hex");
      const r = await fetch(config.url + "/api/qq/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-signature-timestamp": ts,
          "x-signature-ed25519": sig,
        },
        body: raw,
        signal: AbortSignal.timeout(20000),
      });
      if ([400, 413].includes(r.status)) {
        const rejected = path.join(home, "qq-rejected");
        fs.mkdirSync(rejected, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(spool, f), path.join(rejected, f));
        console.log("QQ relay quarantined an invalid or oversized event");
        continue;
      }
      if (!r.ok) throw Error("cloud HTTP " + r.status);
      fs.unlinkSync(path.join(spool, f));
    }
  } catch (e) {
    console.log("QQ relay waiting:", e.message);
  } finally {
    flushing = false;
  }
}
const bot = new sdk.QQBot({
  sessionPersistence,
  appId: secret.QQ_APP_ID,
  appSecret: secret.QQ_APP_SECRET,
  baseUrl: "https://api.bot.qq.com",
  tokenBaseUrl: "https://api.bot.qq.com",
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => console.log("QQ gateway warning"),
    error: () => console.log("QQ gateway error"),
  },
});
bot.on("message", async (ctx) => {
  const m = ctx.message;
  if (m.kind !== "group") return;
  const raw = JSON.stringify({ op: 0, t: m.rawEventType, d: m.raw });
  const name =
    crypto.createHash("sha256").update(m.messageId).digest("hex") + ".json";
  const target = path.join(spool, name);
  fs.writeFileSync(target + ".tmp", raw, { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
  await flush();
});
bot.on("ready", () => {
  connected = true;
  console.log("QQ official gateway connected");
});
bot.on("error", () =>
  console.log("QQ connection error; check credentials/network"),
);
bot.on("resumed", () => {
  connected = true;
  blocked = "";
  console.log(new Date().toISOString(), "QQ gateway resumed");
});
bot.on("disconnected", (event) => {
  connected = false;
  console.log(
    new Date().toISOString(),
    "QQ gateway disconnected",
    event.code,
    event.willReconnect,
  );
});
setInterval(flush, 10000);

const deliveryDir = path.join(home, "file-deliveries");
recoverDeliveries(deliveryDir);
async function cloud(pathname, body) {
  const response = await fetch(config.url + "/api/runner/" + pathname, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.runnerToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("cloud HTTP " + response.status);
  return response.json();
}
let delivering = false;
setInterval(async () => {
  if (delivering) return;
  delivering = true;
  try {
    await deliverFiles({
      dir: deliveryDir,
      root: path.join(home, "utility"),
      target: (body) => cloud("delivery-target", body),
      report: (body) => cloud("delivery/report", body),
      sendFile: (group, localPath) =>
        bot.sendFile({ scope: "group", targetId: group }, { localPath }),
    });
  } catch {
    console.log("File delivery state requires attention");
  } finally {
    delivering = false;
  }
}, 10000);

setInterval(async () => {
  try {
    await fetch(config.url + "/api/runner/gateway-status", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.runnerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connected, blocked }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {}
}, 30000);
const abort = new AbortController();
process.on("SIGTERM", () => {
  connected = false;
  abort.abort();
  setTimeout(() => process.exit(0), 1000).unref();
});
process.on("SIGINT", () => {
  connected = false;
  abort.abort();
  setTimeout(() => process.exit(0), 1000).unref();
});
try {
  await bot.start(abort.signal);
} catch (error) {
  connected = false;
  console.log("QQ gateway stopped", error.code || "startup_error");
  if (error.code === "GATEWAY_FATAL_CLOSE")
    blocked = "QQ平台拒绝连接，需管理员核对应用状态（" + error.closeCode + "）";
  else process.exit(1);
}
