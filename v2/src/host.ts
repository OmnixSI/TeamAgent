// What the tools can reach in the Hub, scoped to one conversation and to whoever is asking.
import type { Hub } from "./hub.ts";
import type { Host } from "./tools.ts";
import type { Asker } from "./selfedit.ts";
import { displayName } from "./core.ts";
import { browse, render, renderPdf } from "./render.ts";
import { checkHealth } from "./health.ts";
import { BJ, SYD, clip, fmtDate, fmtFull, unb64 } from "./util.ts";

const SITE_NAMES: Record<string, string> = { bili: "B 站", xhs: "小红书", zhihu: "知乎", douyin: "抖音", x: "X" };

export function makeHost(hub: Hub, conv: string, askers: Asker[] = []): Host {
  const real = hub.shadow(conv) || conv;   // where shared, read-only facts come from
  const n = (q: string, ...b: any[]) => Number(hub.sql.exec(q, ...b).toArray()[0].n);
  return {
    env: hub.env, now: () => Date.now(),
    // messages out
    say: text => hub.say(conv, text, { queue: false }),
    sendImage: (bytes, note, mime, silent, made) => hub.sendImage(conv, bytes, note, mime, silent, made),
    sendFile: (name, bytes) => hub.sendMediaMessage(conv, 4, bytes, "[你发了一个文件：" + name + "]", name),
    sendVoice: silk => hub.sendMediaMessage(conv, 3, unb64(silk), "[你发了一条语音]"),
    // pictures and files
    imageRef: ref => hub.store.imageRef(conv, ref),
    fileRef: ref => hub.store.fileRef(conv, ref),
    keepFile: async (name, bytes) => { const id = await hub.store.putFile(conv, name, bytes); return id ? "f" + id : ""; },
    nameImage: async (ref, name) => {
      const img = await hub.store.imageRef(conv, ref);
      return !!img && !!(await hub.store.putImage(conv, img.bytes, img.mime, "参考图", { name }));
    },
    savedNames: () => hub.store.names(conv, false),
    stickers: () => hub.store.stickers(conv),
    sendSticker: async name => {
      const lib = hub.store.names(conv, true), pick = lib.includes(name) ? name : lib.find(x => x.includes(name) || name.includes(x));
      const img = pick ? await hub.store.imageRef(conv, "sticker:" + pick) : null;
      if (!img) return { ok: false, error: "没有叫这个名字的表情包，现有的：" + lib.join("、") };
      return hub.sendMediaMessage(conv, 1, img.bytes, "[你发了表情包：" + pick + "]");
    },
    saveSticker: async (ref, name, mood) => {
      const img = await hub.store.imageRef(conv, ref), clean = name.trim().slice(0, 16);
      return !!img && !!clean && img.bytes.length <= 1_500_000 && !!(await hub.store.putImage(conv, img.bytes, img.mime, clip(mood || "", 30) || "表情包", { name: "sticker:" + clean }));
    },
    // rendering and browsing
    render: page => render(hub, page),
    renderPdf: (html, width, height) => renderPdf(hub, html, width, height),
    browse: (url, shot) => browse(hub, url, shot),
    // its own settings, books and health
    cfg: key => hub.edit.cfg(conv, key),
    play: slot => hub.edit.play(conv, slot),
    selfUpdate: args => hub.edit.update(conv, askers, args),
    usage: days => hub.accounts.usage(days),
    health: async fresh => {
      if (fresh) { const checks = await checkHealth(hub); hub.set("health:last", JSON.stringify({ at: Date.now(), checks })); }
      try { const h = JSON.parse(hub.get("health:last") || "null"); return h ? { checked: fmtFull(Number(h.at), BJ) + " 北京时间", problems: h.checks.filter((c: any) => !c.ok).map((c: any) => c.text), fine: h.checks.filter((c: any) => c.ok).map((c: any) => c.text) } : null; } catch { return null; }
    },
    sandbox: (id, opened) => {
      if (id) { if (opened || hub.get("sandbox:id") !== id) { hub.set("sandbox:id", id); hub.set("sandbox:at", String(Date.now())); } return id; }
      // A session is paid for 20 minutes; stop reusing it a little before that.
      return Date.now() - Number(hub.get("sandbox:at") || 0) < 17 * 60000 ? hub.get("sandbox:id") || "" : "";
    },
    quota: async (kind, limit) => {
      const k = "quota:" + kind + ":" + fmtDate(Date.now(), SYD), used = Number(hub.get(k) || 0);
      if (used >= limit) return false;
      hub.set(k, String(used + 1)); return true;
    },
    // long jobs
    jobs: () => hub.jobList(conv),
    cancelJob: id => hub.cancelJob(id, conv),
    scratch: (key, value) => {
      const k = "scratch:" + conv + ":" + key;
      if (value === undefined) { try { return JSON.parse(hub.get(k) || "null"); } catch { return null; } }
      if (value === null) hub.sql.exec("DELETE FROM kv WHERE k=?", k); else hub.set(k, JSON.stringify(value));
      return value;
    },
    // the chat itself
    members: () => hub.sql.exec("SELECT name, COUNT(*) c FROM msg WHERE conv=? AND role='user' AND name IS NOT NULL AND name<>'' GROUP BY name ORDER BY c DESC LIMIT 12", real).toArray().map((r: any) => String(r.name)),
    recentLines: count => hub.recent(conv, count).map(r => (r.role === "bot" ? "Bot" : displayName(r)) + "：" + clip(r.text, 300)).join("\n"),
    stats: days => hub.sql.exec(
      "SELECT date(ts/1000 + 28800, 'unixepoch') d, COALESCE(NULLIF(name,''), '成员') n, COUNT(*) c, SUM(length(text)) ch FROM msg WHERE conv=? AND role='user' AND ts>? GROUP BY d, n ORDER BY d DESC, c DESC",
      conv, Date.now() - days * 86400000).toArray().map((r: any) => ({ date: String(r.d), name: String(r.n), count: Number(r.c), chars: Number(r.ch) })),
    chatCsv: days => {
      const rows = hub.sql.exec("SELECT ts,name,role,text FROM msg WHERE conv=? AND ts>? ORDER BY seq", conv, Date.now() - days * 86400000).toArray();
      const cell = (v: string) => '"' + v.replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
      return new TextEncoder().encode("﻿time,name,text\n" + rows.map((r: any) => [fmtDate(Number(r.ts), BJ) + " " + new Date(Number(r.ts) + 8 * 3600000).toISOString().slice(11, 19), r.role === "bot" ? "Bot" : String(r.name || "成员"), String(r.text || "")].map(cell).join(",")).join("\n"));
    },
    searchHistory: async (query, days, limit) => {
      const words = query.split(/\s+/).filter(Boolean).slice(0, 5);
      if (!words.length) return [];
      return hub.sql.exec(
        "SELECT * FROM msg WHERE conv=? AND ts>? AND " + words.map(() => "text LIKE ?").join(" AND ") + " ORDER BY seq DESC LIMIT ?",
        conv, Date.now() - days * 86400000, ...words.map(w => "%" + w + "%"), limit,
      ).toArray().reverse().map(hub.rowOf);
    },
    getHistory: async (from, to, limit) =>
      hub.sql.exec("SELECT * FROM (SELECT * FROM msg WHERE conv=? AND ts>=? AND ts<? ORDER BY seq DESC LIMIT ?) ORDER BY seq", conv, from, to, limit).toArray().map(hub.rowOf),
    summaries: async count => hub.sql.exec("SELECT date,summary FROM day WHERE conv=? ORDER BY date DESC LIMIT ?", conv, count).toArray() as any,
    // memory
    memory: () => hub.memoryOf(conv),
    remember: async text => { hub.sql.exec("INSERT INTO note(conv,text,ts) VALUES(?,?,?)", conv, text, Date.now()); },
    /** Removes matching entries from today's notes and from the long-term memory document. */
    forget: async keyword => {
      const word = keyword.trim();
      if (word.length < 2) return { notes: 0, memory_lines: [] };
      const notes = n("SELECT COUNT(*) n FROM note WHERE conv=? AND text LIKE ?", conv, "%" + word + "%");
      hub.sql.exec("DELETE FROM note WHERE conv=? AND text LIKE ?", conv, "%" + word + "%");
      const doc = hub.get("memory:" + conv) || "", lines = doc.split("\n");
      const gone = lines.filter(l => l.includes(word) && !/^【.*】\s*$/.test(l.trim()));
      if (gone.length && gone.length <= 6) {
        hub.set("memory:prev:" + conv, doc);
        hub.set("memory:" + conv, lines.filter(l => !gone.includes(l)).join("\n"));
      }
      return { notes, memory_lines: gone.length <= 6 ? gone.map(l => clip(l, 120)) : [], ...(gone.length > 6 ? { too_many: gone.length } : {}) };
    },
    // schedules, ledger, logins
    scheduleCreate: async (spec, task) => hub.addSchedule(conv, spec, task),
    scheduleList: async () => hub.sql.exec("SELECT id,spec,task,next FROM sched WHERE conv=? AND active=1 ORDER BY next", conv).toArray()
      .map((s: any) => ({ id: s.id, spec: JSON.parse(s.spec), task: s.task, next: Number(s.next) })),
    scheduleCancel: async id => { hub.sql.exec("UPDATE sched SET active=0 WHERE id=? AND conv=?", id, conv); return true; },
    ledger: async (op, name, amount, note) => {
      if (op !== "list" && name) {
        const old = hub.sql.exec("SELECT balance FROM ledger WHERE conv=? AND name=?", conv, name).toArray()[0];
        const before = old ? Number(old.balance) : 0, after = Math.round((op === "set" ? amount! : before + amount!) * 100) / 100;
        hub.sql.exec("INSERT INTO ledger(conv,name,balance) VALUES(?,?,?) ON CONFLICT(conv,name) DO UPDATE SET balance=excluded.balance", conv, name, after);
        hub.sql.exec("INSERT INTO ledger_log(conv,name,delta,balance,note,ts) VALUES(?,?,?,?,?,?)", conv, name, after - before, after, note || "", Date.now());
      }
      return hub.sql.exec("SELECT name,balance FROM ledger WHERE conv=? ORDER BY name", conv).toArray().map((r: any) => ({ name: String(r.name), balance: Number(r.balance) }));
    },
    cookie: site => hub.get("cookie:" + site) || "",
    status: () => ({
      build: hub.build().slice(0, 8), deployed: hub.env.VERSION?.timestamp || "",
      gateway_connected: hub.gateway.connected,
      messages: n("SELECT COUNT(*) n FROM msg WHERE conv=?", real),
      saved_images: n("SELECT COUNT(*) n FROM img WHERE conv=?", real),
      saved_characters: hub.store.names(conv, false),
      schedules: hub.sql.exec("SELECT spec,task FROM sched WHERE conv=? AND active=1 ORDER BY next", real).toArray().map((r: any) => {
        const spec = JSON.parse(String(r.spec));
        return { when: spec.type === "daily" ? "每天 " + spec.time + "（" + (spec.tz === BJ ? "北京" : "悉尼") + "时间）" : "一次性 " + fmtFull(Number(spec.at), BJ) + " 北京时间", task: clip(r.task, 80) };
      }),
      running_jobs: hub.jobNote(real) || "没有",
      logins: hub.sql.exec("SELECT k FROM kv WHERE k LIKE 'cookie:%'").toArray().map((r: any) => SITE_NAMES[String(r.k).slice(7)] || String(r.k).slice(7)),
      memory_chars: hub.memoryOf(conv).length,
      notes_today: n("SELECT COUNT(*) n FROM note WHERE conv=?", real),
      last_24h: hub.sql.exec("SELECT kind, COUNT(*) c, AVG(ms) m FROM turn WHERE conv=? AND ts>? GROUP BY kind", real, Date.now() - 86400000).toArray()
        .map((r: any) => ({ kind: ({ chat: "没人叫我的闲聊", called: "被叫到的回复", task: "定时或交办任务", job: "转到后台的大活", stale: "来不及接的话" } as Record<string, string>)[String(r.kind)] || String(r.kind), turns: Number(r.c), avg_seconds: Math.round(Number(r.m) / 100) / 10 })),
      last_memory_consolidation: hub.get("reflect:day"),
    }),
  };
}
