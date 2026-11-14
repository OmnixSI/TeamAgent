// The outbound WebSocket to QQ's gateway. QQ cannot reach *.workers.dev with a webhook, so the Hub
// dials out and keeps the connection: identify or resume, heartbeat, and reconnect when it drops.
import type { Hub } from "./hub.ts";
import { clip, sleep } from "./util.ts";

const INTENTS = (1 << 0) | (1 << 1) | (1 << 30) | (1 << 12) | (1 << 25) | (1 << 26);

export class Gateway {
  ws: WebSocket | null = null;
  beat: any = null;
  lastAck = 0;
  lastSeq: number | null = null;
  session: string | null = null;
  connecting = false;
  error = "";

  private hub: Hub;
  constructor(hub: Hub) {
    this.hub = hub;
    const saved = hub.get("gw");
    if (saved) { try { const s = JSON.parse(saved); this.session = s.session; this.lastSeq = s.seq; } catch {} }
  }
  get connected() { return !!this.ws; }
  save() { this.hub.set("gw", JSON.stringify({ session: this.session, seq: this.lastSeq })); }
  forget() { this.session = null; this.lastSeq = null; this.save(); }

  /** Called by the clock: reconnect when the socket is gone or has been silent too long. */
  async watch(now: number) {
    if (!this.hub.on("gateway")) { if (this.ws) this.close(); return; }
    if ((!this.ws || now - this.lastAck > 130000) && !this.connecting) await this.connect();
  }
  async connect() {
    if (this.connecting || !this.hub.on("gateway")) return;
    this.connecting = true;
    try {
      this.close();
      const url = await this.hub.qq.gatewayUrl();
      const resp = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws) throw new Error("gateway upgrade failed " + resp.status);
      ws.accept();
      this.ws = ws;
      this.lastAck = Date.now();
      ws.addEventListener("message", ev => { if (ws === this.ws) this.onFrame(ws, ev.data).catch(e => console.log("frame error", e?.message)); });
      ws.addEventListener("close", ev => { if (ws === this.ws) this.onClose(ev.code); });
      ws.addEventListener("error", () => { if (ws === this.ws) this.onClose(0); });
      this.error = "";
    } catch (e: any) {
      this.error = clip(e?.message || String(e), 200);
      console.log("gateway connect failed", this.error);
    } finally { this.connecting = false; }
  }
  close() {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000, "bye"); } catch {}
  }
  private onClose(code: number) {
    console.log("gateway closed", code);
    if ([4006, 4007, 4009].includes(code)) this.forget();
    if (code === 4004) this.hub.qq.tok = null;
    if (code === 4914 || code === 4915) { this.error = "QQ 平台拒绝连接（" + code + "）"; this.hub.set("flag:gateway", "0"); }
    this.close();
    this.hub.ctx.storage.setAlarm(Date.now() + 2000);
  }
  private async onFrame(ws: WebSocket, raw: any) {
    const p = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    if (p.s) this.lastSeq = p.s;
    if (p.op === 10) {
      const token = "QQBot " + (await this.hub.qq.token());
      ws.send(JSON.stringify(this.session && this.lastSeq !== null
        ? { op: 6, d: { token, session_id: this.session, seq: this.lastSeq } }
        : { op: 2, d: { token, intents: INTENTS, shard: [0, 1] } }));
      if (this.beat) clearInterval(this.beat);
      this.beat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: this.lastSeq })); } catch {} }, p.d.heartbeat_interval);
    } else if (p.op === 11) this.lastAck = Date.now();
    else if (p.op === 7) this.onClose(1000);
    else if (p.op === 9) { if (!p.d) { this.forget(); this.hub.qq.tok = null; } await sleep(3000); this.onClose(1000); }
    else if (p.op === 0) {
      this.lastAck = Date.now();
      if (p.t === "READY") { this.session = p.d.session_id; this.hub.set("gw:ready", new Date().toISOString()); }
      this.save();
      if (p.t !== "READY" && p.t !== "RESUMED") await this.hub.onEvent(p.t, p.d);
    }
  }
}
