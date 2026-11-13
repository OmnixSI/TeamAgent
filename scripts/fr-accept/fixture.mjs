/**
 * F11 FR-5 · 真实群消息夹具（只读）。
 *
 * 来源：/Users/yanghongming/Projects/TeamAgent-f7-2-real-fixture-20261114/messages.json
 * 462 条真实群消息（rid 1..462 连续），从线上 D1 只读导出；本模块只读文件，
 * 写进进程内 node:sqlite，绝不回写夹具或线上。
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { FIXTURE_DIR, GROUP, pending } from "./harness.mjs";

export function loadFixture() {
  const file = join(FIXTURE_DIR, "messages.json");
  let raw;
  try {
    raw = readFileSync(file);
  } catch (err) {
    throw pending(`真实夹具读不到：${file}（${err.code || err.message}）`);
  }
  const sha = createHash("sha256").update(raw).digest("hex");
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "fixture-manifest.json"), "utf8"));
  } catch {}
  let messages;
  try {
    messages = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw pending(`真实夹具不是合法 JSON：${err.message}`);
  }
  if (!Array.isArray(messages) || !messages.length)
    throw pending("真实夹具为空或不是数组");

  const metaOf = (m) => {
    try {
      return typeof m.meta === "string" ? JSON.parse(m.meta) : m.meta || {};
    } catch {
      return {};
    }
  };
  const byRid = new Map(messages.map((m) => [m.rid, m]));
  const byId = new Map(messages.map((m) => [m.id, m]));

  let direct = 0;
  let mentioned = 0;
  let both = 0;
  const senders = new Map();
  for (const m of messages) {
    const d = metaOf(m).direct === true;
    const at = Number(m.mentioned) > 0;
    if (d) direct++;
    if (at) mentioned++;
    if (d && at) both++;
    senders.set(m.sender, (senders.get(m.sender) || 0) + 1);
  }

  const groupIds = new Set(messages.map((m) => m.group_id));
  const rids = messages.map((m) => m.rid);
  const contiguous = rids.every((rid, i) => rid === i + 1);

  return {
    file,
    sha256: sha,
    bytes: raw.length,
    manifest,
    manifestSha: manifest.sha256 || null,
    shaOk: !manifest.sha256 || manifest.sha256 === sha,
    messages,
    byRid,
    byId,
    metaOf,
    groupId: groupIds.size === 1 ? [...groupIds][0] : GROUP,
    stats: {
      rows: messages.length,
      direct,
      mentioned,
      direct_and_mentioned: both,
      non_direct: messages.length - direct,
      mentioned_zero: messages.length - mentioned,
      rid_contiguous: contiguous,
      rid_first: rids[0],
      rid_last: rids.at(-1),
      group_ids: [...groupIds],
      senders: Object.fromEntries(senders),
    },
  };
}

/** 把 462 条真实消息原样放进本地库（messages + message_meta）。 */
export async function insertMessages(e, messages) {
  let inserted = 0;
  for (const m of messages) {
    await e.DB.prepare(
      "INSERT OR REPLACE INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        m.id,
        m.group_id,
        m.sender,
        m.body,
        m.ts,
        m.mentioned ? 1 : 0,
        m.processed ? 1 : 0,
      )
      .run();
    if (m.meta != null)
      await e.DB.prepare("INSERT OR REPLACE INTO message_meta(id,json) VALUES(?,?)")
        .bind(m.id, typeof m.meta === "string" ? m.meta : JSON.stringify(m.meta))
        .run();
    inserted++;
  }
  return inserted;
}

/** 夹具里该消息的真实 ref_idx（meta.msgIdx）；没有就返回 null，由调用方注明「造」。 */
export function realRefIdx(fixture, msg) {
  const meta = fixture.metaOf(msg);
  return typeof meta.msgIdx === "string" && meta.msgIdx ? meta.msgIdx : null;
}

export async function seedMessageRef(e, { target_id, ref_idx, group_id = GROUP }) {
  await e.DB.prepare(
    "INSERT OR REPLACE INTO message_refs(ref_idx,kind,target_id,group_id,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(ref_idx, "member", target_id, group_id, Date.now())
    .run();
}

/**
 * 合成一条「直接 @ 机器人」的本地消息，只用于 S3/S4/S6/S7 等合成场景。
 * id 前缀固定 FR5-SYN-，不会和真实夹具撞。
 */
export async function insertSyntheticMessage(
  e,
  { id, quote, sender, senderName = "Souvereign", mentioned = 1, direct = true, meta = {} },
) {
  if (!id.startsWith("FR5-SYN-")) throw new Error("合成消息 id 必须以 FR5-SYN- 开头");
  const ts = new Date().toISOString();
  const metaJson = JSON.stringify({
    direct,
    senderName,
    forwarded: [],
    card: null,
    urls: [],
    ...meta,
  });
  await e.DB.prepare(
    "INSERT OR REPLACE INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,0)",
  )
    .bind(id, GROUP, sender, quote, ts, mentioned ? 1 : 0)
    .run();
  await e.DB.prepare("INSERT OR REPLACE INTO message_meta(id,json) VALUES(?,?)")
    .bind(id, metaJson)
    .run();
  return { id, group_id: GROUP, sender, body: quote, ts, mentioned, meta: metaJson };
}
