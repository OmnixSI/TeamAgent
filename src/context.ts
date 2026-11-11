import { botView, buildConversation, metaOf, refIdsOf, viewMessage, type RefTarget } from "./view";

type Row = Record<string, any>;
type ChatContext = { latest?: Row; batch: Row[]; recent: Row[]; names: Map<string, string>; refs: Map<string, RefTarget> };
export async function loadChatContext(e: { DB: any }, x: { groupId: string; latestId?: string; batchIds?: string[]; cursor?: number }): Promise<ChatContext> {
  const recent = (await e.DB.prepare("SELECT m.rowid AS ordinal,m.id,m.group_id,m.sender,m.body,m.ts,m.mentioned,mm.json AS metadata,n.body AS analysed_media FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id LEFT JOIN media_notes n ON n.id=m.id WHERE m.group_id=? ORDER BY m.rowid DESC LIMIT 24").bind(x.groupId).all()).results.reverse().map((r: Row) => ({ ...r, meta: metaOf(r) }));
  let batch: Row[] = [];
  if (x.batchIds?.length) {
    const ids = x.batchIds.slice(0, 60);
    batch = (await e.DB.prepare("SELECT m.rowid AS ordinal,m.*,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.group_id=? AND m.id IN (" + ids.map(() => "?").join(",") + ") ORDER BY m.rowid").bind(x.groupId, ...ids).all()).results;
  } else if (x.cursor !== undefined) {
    batch = (await e.DB.prepare("SELECT m.rowid AS ordinal,m.*,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.group_id=? AND m.rowid>? ORDER BY m.rowid LIMIT 60").bind(x.groupId, x.cursor).all()).results;
  }
  batch = batch.map(r => ({ ...r, meta: metaOf(r) }));
  let latest = x.latestId ? [...batch, ...recent].find(r => r.id === x.latestId) : batch[batch.length - 1];
  if (x.latestId && !latest) {
    const r = await e.DB.prepare("SELECT m.rowid AS ordinal,m.*,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.id=? AND m.group_id=?").bind(x.latestId, x.groupId).first();
    if (r) latest = { ...r, meta: metaOf(r) };
  }
  const names = new Map<string, string>((await e.DB.prepare("SELECT member_id,name FROM member_names LIMIT 500").all()).results.map((r: any) => [r.member_id, r.name]));
  const refs = new Map<string, RefTarget>(), ids = refIdsOf([...recent, ...batch, ...(latest ? [latest] : [])]);
  if (ids.member.length) {
    const rows = (await e.DB.prepare("SELECT id,sender,substr(body,1,200) body FROM messages WHERE id IN (" + ids.member.map(() => "?").join(",") + ")").bind(...ids.member).all()).results;
    for (const r of rows) refs.set(r.id, { id: r.id, from: names.get(r.sender) || "成员" + r.sender.slice(-4), fromId: r.sender.slice(-6), text: r.body });
  }
  if (ids.bot.length) {
    const rows = (await e.DB.prepare("SELECT id,substr(body,1,200) body FROM outbox WHERE id IN (" + ids.bot.map(() => "?").join(",") + ")").bind(...ids.bot).all()).results;
    for (const r of rows) refs.set("b:" + r.id, { id: "b:" + r.id, from: "你", fromId: "bot", text: r.body });
  }
  return { recent, batch, latest, names, refs };
}
export function buildViews(ctx: Partial<ChatContext>, recentBot: any[]) {
  const names = ctx.names || new Map<string, string>(), refs = ctx.refs || new Map<string, RefTarget>();
  const make = (r: Row) => viewMessage(r, names, refs);
  const recentViews = buildConversation((ctx.recent || []).map(make), recentBot.map(botView)).filter(v => v.fromId !== "bot");
  const batchViews = buildConversation((ctx.batch || []).map(make), [], 60);
  const latestView = ctx.latest ? batchViews.find(v => v.id === ctx.latest!.id) || recentViews.find(v => v.id === ctx.latest!.id) || make(ctx.latest) : undefined;
  return { recentViews, latestView, batchViews };
}
