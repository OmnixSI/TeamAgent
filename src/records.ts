// D1 records core: record types, normalized rows, private visibility, quotes,
// undo and CSV export. All totals come from SQL; this module never sums in JS.
//
// The public signatures are frozen by design §5.3. DDL: migrations/0090_records.sql.
import { chunks } from "./d1";

export type FieldType = "text" | "money" | "number" | "date" | "person" | "enum" | "bool";
export interface FieldDef { key: string; label: string; type: FieldType; required?: boolean; options?: string[] }
export interface NormalizedSchema { fields: FieldDef[]; summary?: { group_by?: string; sum?: "amount_cents" } }

export const LIMITS = { typesPerGroup: 20, fieldsPerType: 12, recordsPerGroup: 20000, pageRows: 200, exportRows: 500, exportBytes: 65536, bodyChars: 4000 };

export interface Actor { sender: string; name: string; isAdmin: boolean }
export interface WriteCtx {
  e: any;
  groupId: string;
  actor: Actor;
  sourceMsgId: string;
  dedupBase: string; /* turn_id:tool_call_id */
  now: number;
  names: Map<string, string>; /* sender→群昵称 */
}

export interface RecordTypeRow {
  id: string;
  group_id: string;
  name: string;
  kind: "ledger" | "list" | "log";
  schema: NormalizedSchema;
  visibility_default: "group" | "private";
  owner: string;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

export interface PublicRecord {
  id: string;
  short: string; /* #后6位 */
  person?: string;
  title?: string;
  amount?: string; /* ¥370.00 */
  status?: string;
  occurred_at?: string;
  creator_name: string;
  visibility: "group" | "private";
}

export class RecordError extends Error {
  candidates?: { id: string; short: string }[];
  constructor(public kind: "invalid" | "denied" | "quota" | "not_found" | "ambiguous", msg: string) {
    super(msg);
    this.name = "RecordError";
  }
}

const KINDS = ["ledger", "list", "log"] as const;
type Kind = (typeof KINDS)[number];
const CONFIRM_TTL = 10 * 60 * 1000;
const UNDO_TTL = 10 * 60 * 1000;

// ---------- small helpers ----------
function randomId(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function shortOf(id: unknown): string {
  return "#" + String(id || "").slice(-6);
}
function formatMoney(cents: number): string {
  const n = Math.round(Number(cents) || 0);
  return (n < 0 ? "-¥" : "¥") + (Math.abs(n) / 100).toFixed(2);
}
function parseJson<T>(text: unknown, fallback: T): T {
  try { return JSON.parse(String(text ?? "")) as T; } catch { return fallback; }
}
function sydneyDate(ms: number): string {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}
async function all(e: any, sql: string, ...args: unknown[]): Promise<any[]> {
  const result = await e.DB.prepare(sql).bind(...args).all();
  return result?.results ?? [];
}
async function first(e: any, sql: string, ...args: unknown[]): Promise<any | null> {
  return (await e.DB.prepare(sql).bind(...args).first()) ?? null;
}
async function count(e: any, sql: string, ...args: unknown[]): Promise<number> {
  const row = await first(e, sql, ...args);
  return Number(Object.values(row ?? { n: 0 })[0] || 0);
}
async function namesById(e: any, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, string>();
  if (!unique.length) return out;
  try {
    for (const part of chunks(unique)) {
      const rows = await all(e, "SELECT member_id,name FROM member_names WHERE member_id IN (" + part.map(() => "?").join(",") + ")", ...part);
      for (const row of rows) out.set(row.member_id, row.name);
    }
  } catch { /* an old database may not have member_names yet */ }
  return out;
}
function creatorName(id: string, names: Map<string, string>): string {
  return names.get(id) || "成员" + String(id || "").slice(-4);
}
function parseType(row: any): RecordTypeRow {
  const kind: Kind = KINDS.includes(row?.kind) ? row.kind : "ledger";
  let schema = parseJson<NormalizedSchema>(row?.schema, { fields: [] });
  if (!schema?.fields?.length) schema = normalizeSchema(kind);
  return { ...row, kind, schema };
}
async function typeById(e: any, groupId: string, typeId: string): Promise<RecordTypeRow> {
  const row = await first(e, "SELECT * FROM record_types WHERE id=? AND group_id=?", typeId, groupId);
  if (!row) throw new RecordError("not_found", "没找到这个记录类型");
  return parseType(row);
}
function publicOf(row: any, names: Map<string, string>): PublicRecord {
  const data = parseJson<Record<string, any>>(row?.data, {});
  const record: PublicRecord = {
    id: row.id,
    short: shortOf(row.id),
    creator_name: creatorName(row.creator, names),
    visibility: row.visibility === "private" ? "private" : "group",
  };
  if (data.person !== undefined && data.person !== null && data.person !== "") record.person = String(data.person);
  if (data.title !== undefined && data.title !== null && data.title !== "") record.title = String(data.title);
  if (data.amount_cents !== undefined && data.amount_cents !== null) record.amount = formatMoney(Number(data.amount_cents));
  if (data.status !== undefined && data.status !== null && data.status !== "") record.status = String(data.status);
  if (data.occurred_at !== undefined && data.occurred_at !== null) record.occurred_at = sydneyDate(Number(data.occurred_at));
  return record;
}

// ---------- schema / amount / person / data ----------
export function normalizeSchema(kind: "ledger" | "list" | "log", extra?: FieldDef[]): NormalizedSchema {
  const base: Record<Kind, FieldDef[]> = {
    ledger: [
      { key: "person", label: "人员", type: "person", required: true },
      { key: "amount", label: "金额", type: "money", required: true },
      { key: "title", label: "说明", type: "text" },
      { key: "occurred_at", label: "时间", type: "date" },
    ],
    list: [
      { key: "title", label: "事项", type: "text", required: true },
      { key: "status", label: "状态", type: "enum", options: ["todo", "done"] },
      { key: "person", label: "人员", type: "person" },
    ],
    log: [
      { key: "title", label: "内容", type: "text", required: true },
      { key: "occurred_at", label: "时间", type: "date" },
      { key: "amount", label: "数量", type: "number" },
    ],
  };
  const fields = base[kind].map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) }));
  for (const field of extra || []) {
    if (!field?.key || !field?.type) throw new RecordError("invalid", "自定义字段缺少 key 或类型");
    if (fields.some((f) => f.key === field.key)) throw new RecordError("invalid", `字段重复：${field.key}`);
    fields.push({ ...field, ...(field.options ? { options: [...field.options] } : {}) });
  }
  if (fields.length > LIMITS.fieldsPerType) throw new RecordError("quota", `一个记录类型最多 ${LIMITS.fieldsPerType} 个字段`);
  const schema: NormalizedSchema = { fields };
  if (kind === "ledger") schema.summary = { group_by: "person", sum: "amount_cents" };
  return schema;
}

const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** Chinese numerals up to 万, including the spoken 三百六 = 360 and 一万二 = 12000. */
function chineseNumber(text: string): number {
  let total = 0, section = 0, number = 0, lastUnit = 0, zero = false, saw = false;
  for (const ch of text) {
    if (ch in DIGITS) {
      number = DIGITS[ch];
      saw = true;
      if (ch === "零" || ch === "〇") zero = true;
    } else if (ch in UNITS) {
      const unit = UNITS[ch];
      if (!number) number = 1;
      section += number * unit;
      lastUnit = unit;
      number = 0;
      zero = false;
      saw = true;
    } else if (ch === "万") {
      section = (section + number) * 10000;
      total += section;
      section = 0;
      number = 0;
      lastUnit = 10000;
      zero = false;
      saw = true;
    } else {
      throw new RecordError("invalid", `金额没看懂：${text}`);
    }
  }
  if (!saw) throw new RecordError("invalid", `金额没看懂：${text}`);
  if (number) {
    if (!zero && lastUnit >= 10) section += number * (lastUnit === 10000 ? 1000 : lastUnit / 10);
    else section += number;
  }
  return total + section;
}

/** ￥360 / ¥360 / 360元 / 360块 / 三百六 / 三百六十 / -10 / 加10 / 减5 / 10.5 → integer cents. */
export function parseAmountCents(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) return Math.round(input * 100);
  let text = String(input ?? "").trim();
  if (!text) throw new RecordError("invalid", "金额没看懂：空");
  text = text.replace(/\s+/g, "").replace(/,/g, "").replace(/[￥¥$]/g, "");
  let sign = 1;
  if (/^[-−－]/.test(text)) { sign = -1; text = text.slice(1); }
  else if (/^\+/.test(text)) text = text.slice(1);
  if (/^[减扣负]/.test(text)) { sign = -1; text = text.slice(1); }
  else if (/^[加增]/.test(text)) { sign = 1; text = text.slice(1); }
  text = text.replace(/(元|块|圆|人民币|RMB|CNY)$/i, "");
  if (!text) throw new RecordError("invalid", "金额没看懂：只有符号");
  if (/^\d+(?:\.\d+)?$/.test(text)) return sign * Math.round(Number(text) * 100);
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(text)) throw new RecordError("invalid", `金额没看懂：${input}`);
  return sign * Math.round(chineseNumber(text) * 100);
}

function normalizeNameValue(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}
const SELF_NAMES = new Set(["我", "本人", "自己", "俺", "咱"]);

function normalizePerson(value: unknown, ctx: WriteCtx): string {
  const text = String(value ?? "").trim();
  if (!text) throw new RecordError("invalid", "人员没填");
  if (SELF_NAMES.has(text)) return ctx.actor.name;
  const needle = normalizeNameValue(text);
  if (!needle) throw new RecordError("invalid", `人名没看懂：${text}`);
  for (const name of ctx.names.values()) {
    if (normalizeNameValue(String(name)) === needle) return String(name);
  }
  if (normalizeNameValue(ctx.actor.name) === needle) return ctx.actor.name;
  // addRecords preloads the type's existing person values because this function
  // stays synchronous (design §5.3 freezes normalizeData as a plain function).
  for (const name of ((ctx as any).knownPeople || []) as string[]) {
    if (normalizeNameValue(name) === needle) return name;
  }
  return text;
}

function parseDateMs(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (!text) throw new RecordError("invalid", `${label}没填`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(text + "T00:00:00Z");
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new RecordError("invalid", `${label}没看懂：${text}`);
  return ms;
}

export function normalizeData(schema: NormalizedSchema, raw: Record<string, unknown>, ctx: WriteCtx): Record<string, unknown> {
  const input = raw || {};
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const value = input[field.key];
    if (field.type === "money") {
      const centsKey = field.key === "amount" ? "amount_cents" : field.key + "_cents";
      let cents: number | undefined;
      if (value !== undefined && value !== null && String(value).trim() !== "") cents = parseAmountCents(value);
      else if (input[centsKey] !== undefined && input[centsKey] !== null) cents = Math.round(Number(input[centsKey]));
      if (cents === undefined || !Number.isFinite(cents)) {
        if (field.required) throw new RecordError("invalid", `${field.label}没填`);
        continue;
      }
      out[centsKey] = cents;
      continue;
    }
    if ((value === undefined || value === null || String(value).trim() === "") && field.type === "date" && field.key === "occurred_at") {
      out[field.key] = ctx.now;
      continue;
    }
    if ((value === undefined || value === null || String(value).trim() === "") && field.key === "status" && field.type === "enum") {
      out[field.key] = field.options?.includes("todo") ? "todo" : field.options?.[0];
      continue;
    }
    if (value === undefined || value === null || String(value).trim() === "") {
      if (field.required) throw new RecordError("invalid", `${field.label}没填`);
      continue;
    }
    if (field.type === "person") {
      out[field.key] = normalizePerson(value, ctx);
    } else if (field.type === "date") {
      out[field.key] = parseDateMs(value, field.label);
    } else if (field.type === "number") {
      const n = Number(String(value).replace(/[￥¥$,，]/g, ""));
      if (!Number.isFinite(n)) throw new RecordError("invalid", `${field.label}不是数字：${value}`);
      out[field.key] = n;
    } else if (field.type === "enum") {
      const text = String(value).trim();
      if (field.options?.length && !field.options.includes(text)) throw new RecordError("invalid", `${field.label}只能是：${field.options.join(" / ")}`);
      out[field.key] = text;
    } else if (field.type === "bool") {
      out[field.key] = value === true || value === 1 || value === "1" || /^(true|yes|是|对)$/i.test(String(value));
    } else {
      out[field.key] = String(value).trim().slice(0, LIMITS.bodyChars);
    }
  }
  return out;
}

// ---------- types ----------
export async function findType(e: any, groupId: string, nameOrId: string): Promise<RecordTypeRow | null> {
  const needle = String(nameOrId ?? "").trim();
  if (!needle) return null;
  if (/^rt-/.test(needle)) {
    const row = await first(e, "SELECT * FROM record_types WHERE id=? AND group_id=?", needle, groupId);
    return row ? parseType(row) : null;
  }
  const rows = await all(e, "SELECT * FROM record_types WHERE group_id=? AND status='active' ORDER BY created_at", groupId);
  const exact = rows.find((row) => row.name === needle);
  if (exact) return parseType(exact);
  const squeezed = needle.replace(/\s+/g, "");
  const loose = rows.find((row) => String(row.name).replace(/\s+/g, "") === squeezed);
  if (loose) return parseType(loose);
  const contains = rows.filter((row) => String(row.name).includes(needle) || needle.includes(String(row.name)));
  return contains.length === 1 ? parseType(contains[0]) : null;
}

export async function defineRecordType(
  ctx: WriteCtx,
  a: { name: string; kind: "ledger" | "list" | "log"; extra_fields?: FieldDef[]; visibility_default?: "group" | "private" },
): Promise<{ type: RecordTypeRow; created: boolean }> {
  const name = String(a?.name ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) throw new RecordError("invalid", "记录类型要有名字");
  if (!KINDS.includes(a?.kind)) throw new RecordError("invalid", "记录类型只能是 ledger / list / log");
  const existing = await first(ctx.e, "SELECT * FROM record_types WHERE group_id=? AND name=?", ctx.groupId, name);
  if (existing) return { type: parseType(existing), created: false };
  const total = await count(ctx.e, "SELECT COUNT(*) AS n FROM record_types WHERE group_id=? AND status='active'", ctx.groupId);
  if (total >= LIMITS.typesPerGroup) throw new RecordError("quota", `一个群最多 ${LIMITS.typesPerGroup} 个记录类型`);
  const schema = normalizeSchema(a.kind, a.extra_fields);
  const id = randomId("rt-");
  const now = Number(ctx.now) || Date.now();
  const visibility: "group" | "private" = a.visibility_default === "private" ? "private" : "group";
  try {
    await ctx.e.DB.prepare(
      "INSERT INTO record_types(id,group_id,name,kind,schema,visibility_default,owner,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',?,?)",
    ).bind(id, ctx.groupId, name, a.kind, JSON.stringify(schema), visibility, ctx.actor.sender, now, now).run();
  } catch (error) {
    const raced = await first(ctx.e, "SELECT * FROM record_types WHERE group_id=? AND name=?", ctx.groupId, name);
    if (raced) return { type: parseType(raced), created: false };
    throw error;
  }
  const type: RecordTypeRow = { id, group_id: ctx.groupId, name, kind: a.kind, schema, visibility_default: visibility, owner: ctx.actor.sender, status: "active", created_at: now, updated_at: now };
  await ctx.e.DB.prepare(
    "INSERT INTO record_events(id,record_id,type_id,group_id,actor,action,before,after,source_msg_id,created_at) VALUES(?,NULL,?,?,?,'define',NULL,?,?,?)",
  ).bind(randomId("re-"), id, ctx.groupId, ctx.actor.sender, JSON.stringify(type), ctx.sourceMsgId, now).run();
  return { type, created: true };
}

// ---------- records ----------
export async function addRecords(
  ctx: WriteCtx,
  typeId: string,
  rows: Record<string, unknown>[],
  visibility?: "group" | "private",
): Promise<{ ids: string[]; duplicated: number }> {
  const type = await typeById(ctx.e, ctx.groupId, typeId);
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) throw new RecordError("invalid", "没有要记的内容");
  if (list.length > 50) throw new RecordError("quota", "一次最多记 50 行");
  const total = await count(ctx.e, "SELECT COUNT(*) AS n FROM records WHERE group_id=? AND deleted_at IS NULL", ctx.groupId);
  if (total + list.length > LIMITS.recordsPerGroup) throw new RecordError("quota", `一个群最多 ${LIMITS.recordsPerGroup} 条记录`);
  const vis = visibility === "private" || (!visibility && type.visibility_default === "private") ? "private" : "group";
  const now = Number(ctx.now) || Date.now();
  const knownPeople = (await all(ctx.e, "SELECT DISTINCT person FROM records WHERE type_id=? AND group_id=? AND person IS NOT NULL", typeId, ctx.groupId))
    .map((row) => String(row.person));
  const statements: any[] = [];
  const ids: string[] = [];
  list.forEach((raw, index) => {
    const data = normalizeData(type.schema, raw, { ...ctx, typeId, knownPeople } as WriteCtx);
    const id = randomId("r-");
    ids.push(id);
    const dedup = `${ctx.dedupBase}:${index}`;
    statements.push(ctx.e.DB.prepare(
      "INSERT OR IGNORE INTO records(id,type_id,group_id,creator,visibility,data,dedup_key,source_msg_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
    ).bind(id, typeId, ctx.groupId, ctx.actor.sender, vis, JSON.stringify(data), dedup, ctx.sourceMsgId, now, now));
    statements.push(ctx.e.DB.prepare(
      "INSERT INTO record_events(id,record_id,type_id,group_id,actor,action,before,after,source_msg_id,created_at) SELECT ?,?,?,?,?,'add',NULL,?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=?)",
    ).bind(randomId("re-"), id, typeId, ctx.groupId, ctx.actor.sender, JSON.stringify(data), ctx.sourceMsgId, now, id));
  });
  const results = await ctx.e.DB.batch(statements);
  const inserted: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const result = results[i * 2];
    const row = result?.results?.[0] ?? result?.[0];
    if (row?.id) inserted.push(String(row.id));
  }
  return { ids: inserted, duplicated: list.length - inserted.length };
}

async function resolvePersonFilter(e: any, typeId: string, groupId: string, input: unknown): Promise<string> {
  const text = String(input ?? "").trim();
  if (!text) return "";
  const needle = normalizeNameValue(text);
  const rows = await all(e, "SELECT DISTINCT person FROM records WHERE type_id=? AND group_id=? AND person IS NOT NULL", typeId, groupId);
  for (const row of rows) if (normalizeNameValue(String(row.person)) === needle) return String(row.person);
  return text;
}

function visibilityWhere(viewer: Actor): { sql: string; args: unknown[] } {
  return { sql: "(visibility='group' OR creator=?)", args: [viewer.sender] };
}

export async function queryRecords(
  e: any,
  q: { groupId: string; typeId: string; viewer: Actor; filter?: { person?: string; status?: string; from?: number; to?: number; text?: string }; limit?: number; cursor?: string },
): Promise<{ rows: PublicRecord[]; next?: string; hiddenPrivate: number }> {
  await typeById(e, q.groupId, q.typeId);
  const limit = Math.max(1, Math.min(Number(q.limit) || 50, LIMITS.pageRows));
  const offset = Math.max(0, Number.parseInt(String(q.cursor ?? "0"), 10) || 0);
  const where: string[] = ["type_id=?", "group_id=?", "deleted_at IS NULL"];
  const args: unknown[] = [q.typeId, q.groupId];
  const hiddenWhere: string[] = ["type_id=?", "group_id=?", "deleted_at IS NULL", "visibility='private'", "creator<>?"];
  const hiddenArgs: unknown[] = [q.typeId, q.groupId, q.viewer.sender];
  if (q.filter?.person) {
    const person = await resolvePersonFilter(e, q.typeId, q.groupId, q.filter.person);
    where.push("person=?"); args.push(person);
    hiddenWhere.push("person=?"); hiddenArgs.push(person);
  }
  if (q.filter?.status) {
    where.push("status=?"); args.push(String(q.filter.status));
    hiddenWhere.push("status=?"); hiddenArgs.push(String(q.filter.status));
  }
  if (Number.isFinite(q.filter?.from)) {
    where.push("occurred_at>=?"); args.push(Number(q.filter!.from));
    hiddenWhere.push("occurred_at>=?"); hiddenArgs.push(Number(q.filter!.from));
  }
  if (Number.isFinite(q.filter?.to)) {
    where.push("occurred_at<=?"); args.push(Number(q.filter!.to));
    hiddenWhere.push("occurred_at<=?"); hiddenArgs.push(Number(q.filter!.to));
  }
  if (q.filter?.text) {
    where.push("title LIKE ?"); args.push(`%${String(q.filter.text)}%`);
    hiddenWhere.push("title LIKE ?"); hiddenArgs.push(`%${String(q.filter.text)}%`);
  }
  const visible = visibilityWhere(q.viewer);
  const sql = `SELECT * FROM records WHERE ${where.join(" AND ")} AND ${visible.sql} ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`;
  const rows = await all(e, sql, ...args, ...visible.args, limit + 1, offset);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const hidden = await count(e, `SELECT COUNT(*) AS n FROM records WHERE ${hiddenWhere.join(" AND ")}`, ...hiddenArgs);
  const names = await namesById(e, page.map((row) => row.creator));
  const out: { rows: PublicRecord[]; next?: string; hiddenPrivate: number } = { rows: page.map((row) => publicOf(row, names)), hiddenPrivate: hidden };
  if (more) out.next = String(offset + limit);
  return out;
}

export async function summarizeRecords(
  e: any,
  q: { groupId: string; typeId: string; viewer: Actor; group_by?: string; from?: number; to?: number },
): Promise<{ groups: { key: string; sum_cents: number; count: number }[]; total_cents: number; count: number; hiddenPrivate: number }> {
  await typeById(e, q.groupId, q.typeId);
  const where: string[] = ["type_id=?", "group_id=?", "deleted_at IS NULL"];
  const args: unknown[] = [q.typeId, q.groupId];
  const hiddenWhere: string[] = ["type_id=?", "group_id=?", "deleted_at IS NULL", "visibility='private'", "creator<>?"];
  const hiddenArgs: unknown[] = [q.typeId, q.groupId, q.viewer.sender];
  if (Number.isFinite(q.from)) {
    where.push("occurred_at>=?"); args.push(Number(q.from));
    hiddenWhere.push("occurred_at>=?"); hiddenArgs.push(Number(q.from));
  }
  if (Number.isFinite(q.to)) {
    where.push("occurred_at<=?"); args.push(Number(q.to));
    hiddenWhere.push("occurred_at<=?"); hiddenArgs.push(Number(q.to));
  }
  const visible = visibilityWhere(q.viewer);
  const key = q.group_by === "status" ? "COALESCE(status,'')" : q.group_by === "creator" ? "creator" : "COALESCE(person,'')";
  const groups = await all(e,
    `SELECT ${key} AS key, COALESCE(SUM(amount_cents),0) AS sum_cents, COUNT(*) AS count FROM records WHERE ${where.join(" AND ")} AND ${visible.sql} GROUP BY ${key} ORDER BY sum_cents DESC, key ASC`,
    ...args, ...visible.args);
  const total = await first(e,
    `SELECT COALESCE(SUM(amount_cents),0) AS total_cents, COUNT(*) AS count FROM records WHERE ${where.join(" AND ")} AND ${visible.sql}`,
    ...args, ...visible.args);
  const hiddenPrivate = await count(e, `SELECT COUNT(*) AS n FROM records WHERE ${hiddenWhere.join(" AND ")}`, ...hiddenArgs);
  return {
    groups: groups.map((row) => ({ key: String(row.key ?? ""), sum_cents: Number(row.sum_cents) || 0, count: Number(row.count) || 0 })),
    total_cents: Number(total?.total_cents) || 0,
    count: Number(total?.count) || 0,
    hiddenPrivate,
  };
}

async function loadCandidates(ctx: WriteCtx, type: RecordTypeRow, a: { record_id?: string; match?: { person?: string; title?: string } }): Promise<any[]> {
  if (a.record_id) {
    const row = await first(ctx.e, "SELECT * FROM records WHERE id=? AND type_id=? AND group_id=? AND deleted_at IS NULL", a.record_id, type.id, ctx.groupId);
    return row ? [row] : [];
  }
  const where = ["type_id=?", "group_id=?", "deleted_at IS NULL"];
  const args: unknown[] = [type.id, ctx.groupId];
  if (a.match?.person) {
    where.push("person=?");
    args.push(await resolvePersonFilter(ctx.e, type.id, ctx.groupId, a.match.person));
  }
  if (a.match?.title) {
    where.push("title LIKE ?");
    args.push(`%${String(a.match.title)}%`);
  }
  return all(ctx.e, `SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`, ...args);
}

export async function quoteChange(
  ctx: WriteCtx,
  a: { record_id?: string; match?: { person?: string; title?: string }; typeId: string; op: "update" | "delete"; patch?: Record<string, unknown> },
): Promise<{ token: string; before: PublicRecord; after?: PublicRecord; expires_at: number }> {
  const type = await typeById(ctx.e, ctx.groupId, a.typeId);
  if (a.op !== "update" && a.op !== "delete") throw new RecordError("invalid", "只能改或删");
  if (a.op === "update" && (!a.patch || !Object.keys(a.patch).length)) throw new RecordError("invalid", "没说要改成什么");
  const candidates = await loadCandidates(ctx, type, a);
  if (!candidates.length) throw new RecordError("not_found", "没找到要改的那笔记录");
  for (const row of candidates) {
    if (row.creator !== ctx.actor.sender && !ctx.actor.isAdmin) throw new RecordError("denied", "只能改自己记的，或请管理员改");
  }
  if (candidates.length > 1 && a.op === "update") {
    const error = new RecordError("ambiguous", "有多笔符合，请告诉我记录号：" + candidates.slice(0, 8).map((row) => shortOf(row.id)).join("、"));
    error.candidates = candidates.slice(0, 8).map((row) => ({ id: row.id, short: shortOf(row.id) }));
    throw error;
  }
  if (candidates.length > 1 && !ctx.actor.isAdmin) {
    const clearing = !a.record_id && !a.match?.person && !a.match?.title;
    if (a.op === "delete" && clearing) throw new RecordError("denied", "清空账本需要管理员确认");
    const error = new RecordError("ambiguous", "有多笔符合，只有管理员能一次删多笔。要删哪一笔？" + candidates.slice(0, 8).map((row) => shortOf(row.id)).join("、"));
    error.candidates = candidates.slice(0, 8).map((row) => ({ id: row.id, short: shortOf(row.id) }));
    throw error;
  }
  const now = Number(ctx.now) || Date.now();
  const names = await namesById(ctx.e, candidates.map((row) => row.creator));
  const token = randomId("pa-");
  let after: Record<string, unknown> | undefined;
  if (a.op === "update") {
    const merged = { ...parseJson<Record<string, unknown>>(candidates[0].data, {}), ...(a.patch || {}) };
    if ((a.patch as any)?.amount !== undefined) delete merged.amount_cents;
    const knownPeople = (await all(ctx.e, "SELECT DISTINCT person FROM records WHERE type_id=? AND group_id=? AND person IS NOT NULL", type.id, ctx.groupId))
      .map((row) => String(row.person));
    after = normalizeData(type.schema, merged, { ...ctx, typeId: type.id, knownPeople } as WriteCtx);
  }
  const expires = now + CONFIRM_TTL;
  const draft = {
    typeId: type.id,
    op: a.op,
    recordIds: candidates.map((row) => row.id),
    after: after ?? null,
  };
  await ctx.e.DB.prepare(
    "INSERT INTO pending_actions(id,group_id,sender,tool,draft,missing,status,asked_at,expires_at) VALUES(?,?,?,'records_write',?,'confirm','open',?,?)",
  ).bind(token, ctx.groupId, ctx.actor.sender, JSON.stringify(draft), now, expires).run();
  const before = publicOf(candidates[0], names);
  return { token, before, ...(after ? { after: publicOf({ ...candidates[0], data: JSON.stringify(after) }, names) } : {}), expires_at: expires };
}

export async function applyChange(ctx: WriteCtx, token: string): Promise<{ record: PublicRecord; op: "update" | "delete" }> {
  const now = Number(ctx.now) || Date.now();
  const pending = await first(ctx.e, "SELECT * FROM pending_actions WHERE id=? AND group_id=? AND tool='records_write'", token, ctx.groupId);
  if (!pending || pending.status !== "open") throw new RecordError("not_found", "没有待确认的改动，或已经用过了");
  if (Number(pending.expires_at) <= now) {
    await ctx.e.DB.prepare("UPDATE pending_actions SET status='expired' WHERE id=?").bind(token).run();
    throw new RecordError("not_found", "这个确认已经过期（10 分钟），请重新发起");
  }
  const draft = parseJson<{ typeId: string; op: "update" | "delete"; recordIds: string[]; after?: Record<string, unknown> | null }>(pending.draft, { typeId: "", op: "delete", recordIds: [] });
  if (!draft.typeId || !draft.recordIds?.length) throw new RecordError("not_found", "这次改动的内容丢了，请重新发起");
  const records: any[] = [];
  for (const id of draft.recordIds) {
    const row = await first(ctx.e, "SELECT * FROM records WHERE id=? AND group_id=? AND type_id=?", id, ctx.groupId, draft.typeId);
    if (!row || row.deleted_at) throw new RecordError("not_found", `记录 ${shortOf(id)} 已经不在了`);
    records.push(row);
  }
  for (const row of records) {
    if (row.creator !== ctx.actor.sender && !ctx.actor.isAdmin) throw new RecordError("denied", "这次改动只能由记录人或管理员确认");
  }
  const statements: any[] = [];
  if (draft.op === "update") {
    if (!draft.after) throw new RecordError("not_found", "这次改动没有新内容，请重新发起");
    for (const row of records) {
      statements.push(ctx.e.DB.prepare("UPDATE records SET data=?,updated_at=? WHERE id=?").bind(JSON.stringify(draft.after), now, row.id));
      statements.push(ctx.e.DB.prepare(
        "INSERT INTO record_events(id,record_id,type_id,group_id,actor,action,before,after,source_msg_id,created_at) VALUES(?,?,?,?,?,'update',?,?,?,?)",
      ).bind(randomId("re-"), row.id, draft.typeId, ctx.groupId, ctx.actor.sender, String(row.data), JSON.stringify(draft.after), ctx.sourceMsgId, now));
    }
  } else {
    for (const row of records) {
      statements.push(ctx.e.DB.prepare("UPDATE records SET deleted_at=?,updated_at=? WHERE id=?").bind(now, now, row.id));
      statements.push(ctx.e.DB.prepare(
        "INSERT INTO record_events(id,record_id,type_id,group_id,actor,action,before,after,source_msg_id,created_at) VALUES(?,?,?,?,?,'delete',?,NULL,?,?)",
      ).bind(randomId("re-"), row.id, draft.typeId, ctx.groupId, ctx.actor.sender, String(row.data), ctx.sourceMsgId, now));
    }
  }
  statements.push(ctx.e.DB.prepare("UPDATE pending_actions SET status='done' WHERE id=?").bind(token));
  await ctx.e.DB.batch(statements);
  const names = await namesById(ctx.e, records.map((row) => row.creator));
  const firstRow = records[0];
  const shown = draft.op === "update" ? { ...firstRow, data: JSON.stringify(draft.after) } : firstRow;
  return { record: publicOf(shown, names), op: draft.op };
}

export async function undoLast(ctx: WriteCtx, typeId: string): Promise<{ undone: PublicRecord; op: string } | null> {
  const now = Number(ctx.now) || Date.now();
  const events = await all(ctx.e,
    "SELECT * FROM record_events WHERE group_id=? AND type_id=? AND actor=? AND action IN ('add','update','delete') AND created_at>=? ORDER BY created_at DESC, rowid DESC LIMIT 20",
    ctx.groupId, typeId, ctx.actor.sender, now - UNDO_TTL);
  for (const event of events) {
    const row = await first(ctx.e, "SELECT * FROM records WHERE id=? AND group_id=? AND type_id=?", event.record_id, ctx.groupId, typeId);
    if (!row) continue;
    if (event.action === "add" && row.deleted_at) continue;
    if (event.action === "delete" && !row.deleted_at) continue;
    if (event.action === "update" && !event.before) continue;
    const names = await namesById(ctx.e, [row.creator]);
    if (event.action === "add") {
      await ctx.e.DB.batch([
        ctx.e.DB.prepare("UPDATE records SET deleted_at=?,updated_at=? WHERE id=?").bind(now, now, row.id),
        ctx.e.DB.prepare("INSERT INTO record_events(id,record_id,type_id,group_id,actor,action,before,after,source_msg_id,created_at) VALUES(?,?,?,?,?,'delete',?,NULL,?,?)")
          .bind(randomId("re-"), row.id, typeId, ctx.groupId, ctx.actor.sender, String(row.data), ctx.sourceMsgId, now),
      ]);
      return { undone: publicOf(row, names), op: "add" };
    }
    if (event.action === "update") {
      const before = parseJson<Record<string, unknown>>(event.before, {});
      await ctx.e.DB.batch([
        ctx.e.DB.prepare("UPDATE records SET data=?,deleted_at=NULL,updated_at=? WHERE id=?").bind(JSON.stringify(before), now, row.id),
        ctx.e.DB.prepare("INSERT INTO record_events(id,record_id,type_id,group_id,actor,action,before,after,source_msg_id,created_at) VALUES(?,?,?,?,?,'update',?,?,?,?)")
          .bind(randomId("re-"), row.id, typeId, ctx.groupId, ctx.actor.sender, String(row.data), JSON.stringify(before), ctx.sourceMsgId, now),
      ]);
      return { undone: publicOf({ ...row, data: JSON.stringify(before) }, names), op: "update" };
    }
    if (event.action === "delete") {
      await ctx.e.DB.batch([
        ctx.e.DB.prepare("UPDATE records SET deleted_at=NULL,updated_at=? WHERE id=?").bind(now, row.id),
        ctx.e.DB.prepare("INSERT INTO record_events(id,record_id,type_id,group_id,actor,action,before,after,source_msg_id,created_at) VALUES(?,?,?,?,?,'restore',NULL,?,?,?)")
          .bind(randomId("re-"), row.id, typeId, ctx.groupId, ctx.actor.sender, String(row.data), ctx.sourceMsgId, now),
      ]);
      return { undone: publicOf({ ...row, deleted_at: null }, names), op: "delete" };
    }
  }
  return null;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export async function exportCsv(
  e: any,
  q: { groupId: string; typeId: string; viewer: Actor },
): Promise<{ filename: string; csv: string; rows: number; truncated: boolean }> {
  const type = await typeById(e, q.groupId, q.typeId);
  const visible = visibilityWhere(q.viewer);
  const max = LIMITS.exportRows;
  const data = await all(e,
    `SELECT * FROM records WHERE type_id=? AND group_id=? AND deleted_at IS NULL AND ${visible.sql} ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT ?`,
    q.typeId, q.groupId, ...visible.args, max + 1);
  const names = await namesById(e, data.map((row) => row.creator));
  let truncated = data.length > max;
  const lines = ["记录号,人员,标题,金额,状态,时间,创建人,可见性"];
  const encoder = new TextEncoder();
  let bytes = encoder.encode("\uFEFF" + lines[0] + "\r\n").length;
  let count = 0;
  for (const row of data.slice(0, max)) {
    const record = publicOf(row, names);
    const line = [
      record.short, record.person || "", record.title || "", record.amount || "",
      record.status || "", record.occurred_at || "", record.creator_name,
      record.visibility === "private" ? "私有" : "群内",
    ].map(csvCell).join(",");
    const chunk = line + "\r\n";
    const size = encoder.encode(chunk).length;
    if (bytes + size > LIMITS.exportBytes) { truncated = true; break; }
    lines.push(line);
    bytes += size;
    count++;
  }
  const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
  const safe = type.name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "records";
  return { filename: `${safe}-${sydneyDate(Date.now())}.csv`, csv, rows: count, truncated };
}
