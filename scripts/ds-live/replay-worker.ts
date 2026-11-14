// DS-live isolated local replay adapter. Production worker sources are imported
// unchanged; only the network edge is isolated:
//   - every api.bot.qq.com request is recorded and answered locally (no send);
//   - replay-media URLs are served from bytes the selector captured read-only;
//   - api.deepseek.com is passed through for real calls;
//   - every other outbound host is denied.
// The adapter never stores or logs a credential.
import worker, { signature } from "../../src/worker";
import { enqueueVoice } from "../../src/voice";
import { EXTRA_TOOLS } from "../../src/tools";

type Media = { mime: string; b64: string };
const realFetch = globalThis.fetch.bind(globalThis);
const enc = new TextEncoder();

let active: any = { media: {}, calls: [], qq: [] };

const json = (x: any, status = 200) => Response.json(x, { status });

function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

globalThis.fetch = async (input: any, init: any = {}): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const host = url.hostname;
  if (host === "api.bot.qq.com") {
    if (url.pathname.includes("getAppAccessToken"))
      return json({ access_token: "REPLAY-NOT-A-REAL-TOKEN", expires_in: 7200 });
    let body: any = null;
    try {
      body = init.body ? JSON.parse(String(init.body)) : null;
    } catch {}
    active.qq.push({ path: url.pathname, method: init.method || "POST", body });
    if (url.pathname.includes("/files")) return json({ file_info: "REPLAY-FILE-INFO", ttl: 0, id: "replay-file" });
    return json({ id: "replay-qq-" + active.qq.length, timestamp: new Date().toISOString() });
  }
  if (host === "multimedia.nt.qq.com.cn" && url.pathname.startsWith("/replay-media/")) {
    const item: Media | undefined = active.media[url.pathname.slice("/replay-media/".length)];
    if (!item) return new Response("replay media missing", { status: 404 });
    return new Response(bytesOf(item.b64), { status: 200, headers: { "content-type": item.mime } });
  }
  if (host === "api.openai.com") {
    const started = Date.now();
    const meta: any = { path: url.pathname, status: 0, ms: 0, redirect: init?.redirect };
    let response: Response;
    try {
      response = await realFetch(input, init);
    } catch (error: any) {
      meta.ms = Date.now() - started;
      meta.error = String(error?.message || error);
      active.calls.push(meta);
      throw error;
    }
    meta.status = response.status;
    meta.ms = Date.now() - started;
    try {
      const data = await response.clone().json();
      meta.model = data?.model;
      meta.usage = data?.usage;
      meta.error = data?.error?.message;
    } catch {}
    active.calls.push(meta);
    return response;
  }
  if (host === "api.deepseek.com") {
    const started = Date.now();
    const meta: any = { path: url.pathname, status: 0, ms: 0 };
    try {
      const body = JSON.parse(String(init.body || "{}"));
      if (Array.isArray(body.tools)) {
        const names = body.tools.map((t: any) => t?.function?.name);
        const dup = names.filter((n: any, i: number) => names.indexOf(n) !== i);
        meta.tools = names.length;
        meta.duplicate_tools = [...new Set(dup)];
      }
      meta.model_requested = body.model;
    } catch {}
    let response: Response;
    try {
      response = await realFetch(input, init);
    } catch (error: any) {
      meta.status = 0;
      meta.ms = Date.now() - started;
      meta.error = String(error?.stack || error);
      active.calls.push(meta);
      throw error;
    }
    meta.status = response.status;
    meta.ms = Date.now() - started;
    try {
      const data = await response.clone().json();
      meta.model = data?.model;
      meta.usage = data?.usage;
      meta.error = data?.error?.message;
      meta.head = typeof data?.choices?.[0]?.message?.content === "string"
        ? data.choices[0].message.content.slice(0, 160)
        : undefined;
    } catch {}
    active.calls.push(meta);
    return response;
  }
  throw Error("REPLAY outbound denied: " + host);
};

function runtime(e: any) {
  return {
    ...e,
    QQ_APP_ID: "REPLAY-APP",
    QQ_APP_SECRET: "replay-signing-secret-only",
    RUNNER_TOKEN: "replay-runner-only",
    ADMIN_TOKEN: "replay-owner-only",
    MODEL: "deepseek-flash",
    WORK: { send: async () => {} },
    CHAT: { send: async () => {} },
    TOOLS: { send: async () => {} },
  };
}

async function rows(e: any, sql: string) {
  return (await e.DB.prepare(sql).all()).results;
}

export default {
  async fetch(request: Request, e: any) {
    const u = new URL(request.url);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return new Response("local only", { status: 403 });
    const env = runtime(e);
    // Production HTTP routes (runner claim/report, admin) run unchanged.
    if (u.pathname.startsWith("/api/")) return worker.fetch(request, env);
    const b: any = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (u.pathname === "/__health") return json({ ok: true, release: "41db2b5", model: "real-deepseek", qq: "record-only" });
    if (u.pathname === "/__reset") {
      const tables = await rows(e, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '%_fts_%'");
      for (const { name } of tables) await e.DB.prepare('DELETE FROM "' + name + '"').run();
      active = { media: b.media || {}, calls: [], qq: [] };
      for (const row of b.messages || []) {
        await e.DB.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,0)")
          .bind(row.id, row.group_id, row.sender, row.body || "", row.ts, row.mentioned ? 1 : 0).run();
        await e.DB.prepare("INSERT OR REPLACE INTO message_meta VALUES(?,?)")
          .bind(row.id, typeof row.meta === "string" ? row.meta : JSON.stringify(row.meta || {})).run();
      }
      const settings: Record<string, string> = {
        group_id: b.groupId || "REPLAY-GROUP",
        ["chat_cursor:" + (b.groupId || "REPLAY-GROUP")]: "0",
        "off:wait": "1",
        "off:sticker_send": "1",
        "off:sticker_collect": "1",
        "voice:mode": "auto",
        "tts:provider": "deepseek",
        "docread:enabled": "1",
        "asr:provider": "auto",
        "vision:provider": "auto",
        ...(b.settings || {}),
      };
      for (const [key, value] of Object.entries(settings))
        await e.DB.prepare("INSERT INTO settings VALUES(?,?)").bind(key, String(value)).run();
      for (const m of b.members || [])
        await e.DB.prepare("INSERT OR REPLACE INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,?,0)")
          .bind(m.id, m.name || "replay", m.id + "-hash", m.role || "member").run();
      if (b.biliJob) {
        const j = b.biliJob;
        await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,created_at) VALUES(?,?,?,'pending',0,0,?)")
          .bind(j.id, "bili_media", JSON.stringify(j.payload), Date.now()).run();
      }
      return json({ ok: true, tables: tables.length });
    }
    if (u.pathname === "/__ingest") {
      const raw = JSON.stringify(b.event);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = await signature("replay-signing-secret-only", ts + raw);
      const response = await worker.fetch(new Request("https://team.example/api/qq/events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature-timestamp": ts, "x-signature-ed25519": sig },
        body: raw,
      }), env);
      return json({ status: response.status, body: await response.json().catch(() => null) });
    }
    if (u.pathname === "/__drain") {
      const processed: any[] = [];
      for (let round = 0; round < 8; round++) {
        const next = await e.DB.prepare("SELECT MIN(COALESCE(json_extract(payload,'$.notBefore'),0)) AS at FROM jobs WHERE kind NOT IN ('fetch','bili_media','voice_runner') AND attempts<3 AND status='pending'").first();
        const at = Number(next?.at || 0);
        if (at > Date.now() && at <= Date.now() + 15000) await new Promise((resolve) => setTimeout(resolve, at - Date.now() + 40));
        const pending = (await e.DB.prepare("SELECT id,kind,payload FROM jobs WHERE kind NOT IN ('fetch','bili_media','voice_runner') AND attempts<3 AND COALESCE(json_extract(payload,'$.notBefore'),0)<=? AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY CASE WHEN kind='chat' THEN 0 ELSE 1 END, created_at LIMIT 20")
          .bind(Date.now(), Date.now()).all()).results;
        if (!pending.length) break;
        for (const job of pending) {
          const before = await e.DB.prepare("SELECT status,attempts,error FROM jobs WHERE id=?").bind(job.id).first();
          await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, env);
          const after = await e.DB.prepare("SELECT status,attempts,error FROM jobs WHERE id=?").bind(job.id).first();
          processed.push({ id: job.id, kind: job.kind, before, after });
        }
      }
      return json({ processed });
    }
    if (u.pathname === "/__sign") return json({ signature: await signature("replay-signing-secret-only", String(b.text || "")) });
    if (u.pathname === "/__voice_enqueue") {
      const source = { sender: b.sender || "replay-sender", id: b.messageId, meta: { media: [{ kind: "voice" }] } };
      (env as any).voiceSource = source;
      (env as any).voiceSwitches = { "voice:mode": "auto", "tts:provider": b.provider || "deepseek" };
      await enqueueVoice(env, String(b.id), String(b.group), String(b.messageId), JSON.stringify({ mode: "work", text: String(b.text || "") }), { source });
      const row = await e.DB.prepare("SELECT id,status,body FROM outbox WHERE id=?").bind(b.id).first();
      return json({ ok: true, outbox: row });
    }
    if (u.pathname === "/__tool") {
      const tool = EXTRA_TOOLS.find((t: any) => t.name === b.name);
      if (!tool) return json({ error: "unknown tool" }, 404);
      const ctx: any = {
        context: { latest: { id: b.messageId, group_id: b.groupId, sender: b.sender }, switches: {} },
        source: { id: b.messageId, group_id: b.groupId, sender: b.sender },
        messages: [],
        isTainted: () => false,
      };
      const started = Date.now();
      try {
        const result = await tool.run(env, b.input || {}, ctx);
        return json({ ok: true, result, ms: Date.now() - started });
      } catch (error: any) {
        return json({ ok: false, error: String(error?.message || error), ms: Date.now() - started }, 500);
      }
    }
    if (u.pathname === "/__state") {
      return json({
        jobs: await rows(e, "SELECT id,kind,status,attempts,error,payload FROM jobs ORDER BY created_at"),
        outbox: await rows(e, "SELECT id,group_id,msg_id,body,status,created_at FROM outbox ORDER BY created_at"),
        outboxMeta: await rows(e, "SELECT id,json FROM outbox_meta"),
        messages: await rows(e, "SELECT id,body,ts,mentioned FROM messages ORDER BY rowid"),
        meta: await rows(e, "SELECT id,json FROM message_meta"),
        dsUsage: await rows(e, "SELECT purpose,status,error_kind,latency_ms,units,est_cost_micro_usd FROM ds_usage ORDER BY created_at"),
        toolCalls: await rows(e, "SELECT name,status,error_kind,latency_ms,args_hash FROM tool_calls ORDER BY created_at"),
        modelRuns: await rows(e, "SELECT kind,effort,status,duration_ms,input_tokens,output_tokens FROM model_runs ORDER BY created_at"),
        imageNotes: await rows(e, "SELECT sha,desc,tags,sticker_like,text FROM image_notes"),
        decisions: await rows(e, "SELECT latest_id,gate,action,outbox_id,model_ms FROM chat_decisions ORDER BY created_at"),
        mediaNotes: await rows(e, "SELECT id,substr(body,1,200) AS body,created_at FROM media_notes ORDER BY created_at"),
        settings: await rows(e, "SELECT key,value FROM settings ORDER BY key"),
        imageGenLog: await rows(e, "SELECT group_id,sender_id,turn_id,prompt,size,quality,model,status,error_kind,bytes,latency_ms,est_cost_micro_usd,outbox_id FROM image_gen_log ORDER BY id"),
        generatedImages: await rows(e, "SELECT id,group_id,mime,bytes,width,height,length(data) AS stored_bytes,expires_at FROM generated_images"),
        openaiUsage: await rows(e, "SELECT purpose,model,status,error_kind,latency_ms,est_cost_micro_usd FROM openai_usage ORDER BY created_at"),
        calls: active.calls,
        qq: active.qq,
      });
    }
    return new Response("not found", { status: 404 });
  },
};
