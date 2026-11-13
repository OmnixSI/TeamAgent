import { chunks } from "./d1";
import { botView, buildConversation, mediaViews, metaOf, refIdsOf, viewMessage, type RefTarget } from "./view";
import { imageNotesFor } from "./vision";
import { quotedImagesFromMeta } from "./media/quoted";

type Row = Record<string, any>;
type ChatContext = {
  latest?: Row;
  batch: Row[];
  recent: Row[];
  names: Map<string, string>;
  refs: Map<string, RefTarget>;
  imageNotes: Map<string, string[]>;
  imagePicks: Set<string>;
};

export async function namesFor(e: { DB: any }, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const batches = await e.DB.batch(chunks(unique).map(part =>
    e.DB.prepare("SELECT member_id,name FROM member_names WHERE member_id IN (" + part.map(() => "?").join(",") + ")").bind(...part)));
  return new Map(batches.flatMap((r: any) => r.results).map((r: any) => [r.member_id, r.name]));
}
export async function loadBatch(e: { DB: any }, groupId: string, cursor: number) {
  const rows = (
    await e.DB.prepare(
      "SELECT m.rowid AS ordinal,m.*,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.group_id=? AND m.rowid>? ORDER BY m.rowid LIMIT 60",
    )
      .bind(groupId, cursor)
      .all()
  ).results;
  return rows.map((r: Row) => ({ ...r, meta: metaOf(r) }));
}

export async function loadChatContext(
  e: { DB: any },
  x: {
    groupId: string;
    latestId?: string;
    batchIds?: string[];
    cursor?: number;
    batch?: Row[];
    imagePicks?: string[];
  },
): Promise<ChatContext> {
  const recent = (
    await e.DB.prepare(
      "SELECT m.rowid AS ordinal,m.id,m.group_id,m.sender,m.body,m.ts,m.mentioned,mm.json AS metadata,n.body AS analysed_media FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id LEFT JOIN media_notes n ON n.id=m.id WHERE m.group_id=? ORDER BY m.rowid DESC LIMIT 24",
    )
      .bind(x.groupId)
      .all()
  ).results
    .reverse()
    .map((r: Row) => ({ ...r, meta: metaOf(r) }));
  let batch: Row[] = [];
  if (x.batch !== undefined) {
    batch = x.batch.map((r) => ({ ...r, meta: metaOf(r) }));
  } else if (x.batchIds?.length) {
    const ids = x.batchIds.slice(0, 60);
    batch = (
      await e.DB.prepare(
        "SELECT m.rowid AS ordinal,m.*,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.group_id=? AND m.id IN (" +
          ids.map(() => "?").join(",") +
          ") ORDER BY m.rowid",
      )
        .bind(x.groupId, ...ids)
        .all()
    ).results;
  } else if (x.cursor !== undefined) {
    batch = await loadBatch(e, x.groupId, x.cursor);
  }
  batch = batch.map((r) => ({ ...r, meta: metaOf(r) }));
  let latest = x.latestId
    ? [...batch, ...recent].find((r) => r.id === x.latestId)
    : batch[batch.length - 1];
  if (x.latestId && !latest) {
    const r = await e.DB.prepare(
      "SELECT m.rowid AS ordinal,m.*,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.id=? AND m.group_id=?",
    )
      .bind(x.latestId, x.groupId)
      .first();
    if (r) latest = { ...r, meta: metaOf(r) };
  }
  const refs = new Map<string, RefTarget>(), targetMeta = new Map<string, any>();
  const contextRows = [...recent, ...batch, ...(latest ? [latest] : [])], ids = refIdsOf(contextRows);
  const refBatches = ids.member.length ? await e.DB.batch(chunks(ids.member).map(part =>
    e.DB.prepare("SELECT m.id,m.sender,substr(m.body,1,200) body,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.id IN (" + part.map(() => "?").join(",") + ")").bind(...part))) : [];
  const refRows: Row[] = refBatches.flatMap((r: any) => r.results);
  const names = await namesFor(e, [...contextRows, ...refRows].flatMap(r => {
    const meta = metaOf(r);
    return [r.sender, ...(meta.mentions || []).map((m: any) => m.id), meta.replyTo?.authorId];
  }));
  for (const r of refRows) {
    targetMeta.set(r.id, metaOf(r));
    refs.set(r.id, { id: r.id, from: names.get(r.sender) || "成员" + r.sender.slice(-4), fromId: r.sender.slice(-6), text: r.body });
  }
  if (ids.bot.length) {
    const rows = (
      await e.DB.prepare(
        "SELECT id,substr(body,1,200) body FROM outbox WHERE id IN (" +
          ids.bot.map(() => "?").join(",") +
          ")",
      )
        .bind(...ids.bot)
        .all()
    ).results;
    for (const r of rows)
      refs.set("b:" + r.id, {
        id: "b:" + r.id,
        from: "你",
        fromId: "bot",
        text: r.body,
      });
  }
  const withImages = [...recent, ...batch, ...(latest ? [latest] : [])]
    .filter((r) =>
      (r.meta?.media || []).some((m: any) => m.kind === "image") ||
      quotedImagesFromMeta(r.meta).length>0,
    )
    .map((r) => r.id);
  const imagePicks = new Set(x.imagePicks || []);
  const imageNotes = await imageNotesFor(e, [
    ...new Set([...withImages, ...ids.member]),
  ]);
  for (const [id, meta] of targetMeta) {
    const media = mediaViews(meta, id, imageNotes, imagePicks,names);
    if (media?.length) refs.get(id)!.media = media;
  }
  return {
    recent,
    batch,
    latest,
    names,
    refs,
    imageNotes,
    imagePicks,
  };
}

export function buildViews(
  ctx: Partial<ChatContext>,
  recentBot: any[],
) {
  const names = ctx.names || new Map<string, string>(),
    refs = ctx.refs || new Map<string, RefTarget>();
  const make = (r: Row) =>
    viewMessage(r, names, refs, ctx.imageNotes, ctx.imagePicks);
  const recentViews = buildConversation(
    (ctx.recent || []).map(make),
    recentBot.map(botView),
  ).filter((v) => v.fromId !== "bot");
  const batchViews = buildConversation((ctx.batch || []).map(make), [], 60);
  const latestView = ctx.latest
    ? batchViews.find((v) => v.id === ctx.latest!.id) ||
      recentViews.find((v) => v.id === ctx.latest!.id) ||
      make(ctx.latest)
    : undefined;
  return { recentViews, latestView, batchViews };
}
