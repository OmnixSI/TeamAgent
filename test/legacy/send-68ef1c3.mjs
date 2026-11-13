// Frozen TeamAgent@68ef1c3 sender, with imports relocated and TS annotations erased.
import {left,COST} from '../../src/d1.ts';
import {loadSwitches,isOn} from '../../src/rhythm.ts';
import {stickerSendOn,sendSticker} from '../../src/stickers.ts';
import {messageSequence} from '../../src/voice.ts';
import {quoteOutcome} from '../../src/quote.ts';
import {activity} from '../../src/runtime.ts';
import {stage} from '../../src/timing.ts';
let qqToken;
export async function sendOutbox(e) {
  if (!e.QQ_APP_ID || !e.QQ_APP_SECRET) return;
  let rows = (
    await e.DB.prepare(
      "SELECT o.*,om.json AS meta FROM outbox o LEFT JOIN outbox_meta om ON om.id=o.id WHERE o.status='pending' ORDER BY o.created_at,o.id LIMIT 5",
    ).all()
  ).results;
  if (!rows.length) return;
  let switches;
  const stickerSources = new Map();
  const stickerRows = rows.filter((o) => o.id.endsWith("~s"));
  if (stickerRows.length) {
    if (left(e) < 2) return;
    switches = await loadSwitches(e);
    if (!stickerSendOn(switches, Date.now())) {
      // One statement also keeps a disabled backlog within the invocation budget.
      await e.DB.prepare("UPDATE outbox SET status='skipped' WHERE status='pending' AND id IN ("+stickerRows.map(()=>"?").join(",")+")")
        .bind(...stickerRows.map((o)=>o.id)).run();
      rows = rows.filter((o)=>!o.id.endsWith("~s"));
    } else for (const o of stickerRows) {
      if (left(e) < 2) return;
      const source = o.msg_id ? await e.DB.prepare("SELECT ts FROM messages WHERE id=?").bind(o.msg_id).first() : null;
      if (!source || !(Date.now()-Date.parse(source.ts)<240000)) {
        await e.DB.prepare("UPDATE outbox SET status='skipped' WHERE id=? AND status='pending'").bind(o.id).run();
        rows = rows.filter((r)=>r.id!==o.id);
      } else stickerSources.set(o.id,source);
    }
    if (!rows.length) return;
  }
  if (!qqToken || qqToken.app !== e.QQ_APP_ID || qqToken.expires < Date.now()) {
    const tokenR = await fetch("https://api.bot.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: e.QQ_APP_ID,
        clientSecret: e.QQ_APP_SECRET,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenR.ok) return;
    const tok = await tokenR.json();
    if (!tok.access_token) return;
    qqToken = {
      app: e.QQ_APP_ID,
      value: tok.access_token,
      expires:
        Date.now() + Math.max(30, Number(tok.expires_in || 300) - 60) * 1000,
    };
  }
  const accessToken = qqToken?.value;
  if (!accessToken) return;
  for (const o of rows) {
    if (o.id.endsWith("~s")) {
      if (!stickerSendOn(switches, Date.now())) {
        if (left(e) < 1) break;
        await e.DB.prepare("UPDATE outbox SET status='skipped' WHERE id=? AND status='pending'").bind(o.id).run();
      } else {
        if (left(e) < COST.send_row + COST.sticker) break;
        const status = await sendSticker(e, o, accessToken, stickerSources.get(o.id), switches, messageSequence(o.id));
        if (status === 401) qqToken = undefined;
      }
      continue;
    }
    if (left(e) < COST.send_row) break;
    let meta = {};
    if (o.meta) {
      try { meta = JSON.parse(o.meta); } catch {}
      switches ??= await loadSwitches(e);
    }
    const reference = typeof meta.reference === "string" && switches && isOn(switches, "quote") ? meta.reference : undefined;
    const locked = await e.DB.prepare(
      "UPDATE outbox SET status='sending' WHERE id=? AND status='pending' RETURNING id",
    )
      .bind(o.id)
      .first();
    if (!locked) continue;
    await e.DB.prepare(
      "INSERT OR REPLACE INTO outbox_attempts(id,started_at) VALUES(?,?)",
    )
      .bind(o.id, Date.now())
      .run();
    try {
      const source = o.msg_id
        ? await e.DB.prepare("SELECT ts FROM messages WHERE id=?")
            .bind(o.msg_id)
            .first()
        : null;
      const send = (ref, increment = 0) => fetch(
        "https://api.bot.qq.com/v2/groups/" + encodeURIComponent(o.group_id) + "/messages",
        {
          method: "POST",
          headers: { Authorization: "QQBot " + accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            content: o.body.slice(0, 4000), msg_type: 0,
            msg_id: source && Date.now() - Date.parse(source.ts) < 240000 ? o.msg_id : undefined,
            msg_seq: messageSequence(o.id) + increment,
            ...(ref ? { message_reference: { message_id: ref } } : {}),
          }),
          signal: AbortSignal.timeout(20000),
        },
      );
      let response = await send(reference), result, recovered = false;
      try { result = await response.json(); } catch {}
      if (reference && quoteOutcome(response.status, result) === "maybe_ref") {
        response = await send(undefined, 1);
        result = undefined;
        try { result = await response.json(); } catch {}
        recovered = quoteOutcome(response.status, result) === "ok";
      }
      const status =
        response.ok && (result?.id || result?.code === 0)
          ? "sent"
          : response.status >= 500 || !result
            ? "unknown"
            : "failed";
      const sent = await e.DB.batch([
        e.DB.prepare("UPDATE outbox SET status=? WHERE id=?").bind(
          status,
          o.id,
        ),
        e.DB.prepare(
          "UPDATE outbox_attempts SET http_status=?,code=? WHERE id=?",
        ).bind(response.status, String(result?.code || ""), o.id),
        ...(status === "sent" && typeof result?.ext_info?.ref_idx === "string"
          ? [e.DB.prepare("INSERT OR IGNORE INTO message_refs VALUES(?,'bot',?,?,?)").bind(result.ext_info.ref_idx, o.id, o.group_id, Date.now())]
          : []),
        ...(reference && status === "sent" ? [recovered
          ? e.DB.prepare("INSERT INTO settings VALUES('quote_fail','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value")
          : e.DB.prepare("UPDATE settings SET value='0' WHERE key='quote_fail' AND value!='0'")] : []),
      ]);
      if (status === "sent") stage(e, o.msg_id, "sent");
      if (reference && status === "sent") {
        const failures = recovered ? Number(sent.at(-1)?.results?.[0]?.value || 0) : 0;
        switches.quote_fail = String(failures);
        if (failures >= 3) {
          await e.DB.prepare("INSERT INTO settings VALUES('off:quote','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
          await activity(e, "quote.disabled", "quote", "Bot", "引用连续失败，已自动关闭引用回复");
          switches["off:quote"] = "1";
        }
      }
      if (response.status === 401) qqToken = undefined;
    } catch {
      await e.DB.prepare("UPDATE outbox SET status='unknown' WHERE id=?")
        .bind(o.id)
        .run();
    }
  }
}

export async function recover(e,now=Date.now()){
 await e.DB.prepare("UPDATE outbox SET status='unknown' WHERE status='sending' AND id IN (SELECT id FROM outbox_attempts WHERE started_at<?)").bind(now-120000).run();
}
