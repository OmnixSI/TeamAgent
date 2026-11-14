// D1 record tools: records_read (untrusted material) and records_write (audited write).
// Success shapes follow design §5.9: { ok:true, accepted:true, family:"record", … }.
import type { BotTool, ToolCtx } from "../toolkit";
import { isAutoSender } from "../feature-request-core";
import {
  addRecords, applyChange, defineRecordType, exportCsv, findType, LIMITS, queryRecords,
  quoteChange, RecordError, shortOf, summarizeRecords, undoLast,
  type Actor, type PublicRecord, type RecordTypeRow, type WriteCtx,
} from "../records";

const PRIVATE_NOTE = "请到工作台查看";

function money(cents: number): string {
  const n = Math.round(Number(cents) || 0);
  return (n < 0 ? "-¥" : "¥") + (Math.abs(n) / 100).toFixed(2);
}

function failure(error: RecordError): any {
  const next: Record<string, string> = {
    invalid: "让成员补一句更清楚的话，再调用一次",
    denied: "向成员说明权限或原话依据不足，不要重试同一个调用",
    quota: "告诉成员已经到上限，先整理或删除旧记录",
    not_found: "先列出现有账本和记录，再让成员确认",
    ambiguous: "把候选记录号列给成员，问清是哪一笔",
  };
  return {
    ok: false,
    error_kind: error.kind,
    retryable: false,
    reason_text: error.message,
    next_action: next[error.kind] || "把原因告诉成员",
    ...(error.candidates ? { candidates: error.candidates } : {}),
  };
}

async function rows(e: any, sql: string, ...args: unknown[]): Promise<any[]> {
  return (await e.DB.prepare(sql).bind(...args).all()).results ?? [];
}
async function activeTypes(e: any, groupId: string): Promise<any[]> {
  return rows(e, "SELECT id,name,kind,visibility_default FROM record_types WHERE group_id=? AND status='active' ORDER BY created_at", groupId);
}
async function resolveReadType(e: any, groupId: string, name: unknown): Promise<RecordTypeRow> {
  if (name) {
    const found = await findType(e, groupId, String(name));
    if (!found) throw new RecordError("not_found", `没有叫「${name}」的账本`);
    return found;
  }
  const list = await activeTypes(e, groupId);
  if (!list.length) throw new RecordError("not_found", "本群还没有账本，先说「记账 …」建一个");
  if (list.length > 1) throw new RecordError("ambiguous", "本群有多个账本：" + list.map((t) => t.name).join("、") + "，请说查哪个");
  return findType(e, groupId, list[0].id) as Promise<RecordTypeRow>;
}

function inferKind(args: any, quote: string): "ledger" | "list" | "log" {
  if (args?.kind === "ledger" || args?.kind === "list" || args?.kind === "log") return args.kind;
  const probe = `${args?.type || ""} ${args?.name || ""} ${quote}`;
  if (/清单|待办|购物|买|任务列表|todo/i.test(probe)) return "list";
  if (Array.isArray(args?.rows) && args.rows.some((row: any) => row && (row.amount !== undefined || row.amount_cents !== undefined))) return "ledger";
  if (/记账|账本|报销|额度|花了|付|欠|借|余额/.test(probe)) return "ledger";
  if (Array.isArray(args?.rows) && args.rows.some((row: any) => row && row.status !== undefined)) return "list";
  return "ledger";
}

function isGenericLedgerName(name: string): boolean {
  const text = String(name || "").replace(/\s+/g, "");
  return /^(?:一个|个)?(?:本地)?(?:记账)?(?:工具|账本|系统)?$/.test(text) || text === "本地记账工具";
}

function deriveName(quote: string, kind: "ledger" | "list" | "log"): string {
  let text = String(quote || "").split(/\n/)[0].trim();
  text = text.replace(/^(?:帮我|请|麻烦|给我)?\s*(?:记一笔|记一下|记账|记|建立|建|新建|创建|弄|做)(?:一个|个)?(?:本地)?(?:记账)?(?:工具|账本)?[：:\s]*/u, "");
  text = text.split(/[：:，,。；;]/)[0].trim();
  text = text.replace(/^(?:一本|个)/, "").trim();
  if (!text || text.length > 40) return kind === "list" ? "清单" : "账本";
  return text.slice(0, 40);
}

function parseLedgerProse(quote: string): Record<string, unknown>[] {
  const parts = String(quote || "").replace(/\n/g, "，").split(/[，,、;；]/).map((part) => part.trim()).filter(Boolean);
  const out: Record<string, unknown>[] = [];
  for (const part of parts) {
    const match = /^(.*?)([加减扣负]?\s*[¥￥$]?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)\s*(?:元|块)?)$/u.exec(part);
    if (!match) continue;
    const person = match[1].trim().replace(/[：:]\s*$/, "");
    if (!person) continue;
    out.push({ person, amount: match[2].replace(/\s+/g, "") });
  }
  return out;
}

function parseListProse(quote: string): Record<string, unknown>[] {
  const text = String(quote || "");
  const at = Math.max(text.indexOf("："), text.indexOf(":"));
  const tail = at >= 0 ? text.slice(at + 1) : text;
  return tail.split(/[、,，;；\n]/).map((item) => item.replace(/^[\s\-•]+|[\s。]+$/g, "")).filter(Boolean)
    .slice(0, 50).map((title) => ({ title }));
}

function describe(record: PublicRecord | undefined): string {
  if (!record) return "";
  return [record.person, record.title, record.amount, record.status].filter(Boolean).join(" ");
}

function summaryLine(name: string, kind: string, s: { groups: { key: string; sum_cents: number; count: number }[]; total_cents: number; count: number }): string {
  if (kind === "list") {
    const done = s.groups.find((g) => g.key === "done")?.count || 0;
    const todo = s.groups.find((g) => g.key === "todo")?.count || 0;
    return `${name}：${s.count} 条（待办 ${todo}，已完成 ${done}）`;
  }
  const parts = s.groups.filter((g) => g.key).slice(0, 6).map((g) => `${g.key} ${money(g.sum_cents)}`);
  return `${name}：${parts.join("、")}${parts.length ? "，" : ""}合计 ${money(s.total_cents)}（${s.count} 笔）`;
}

function tzOffset(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney", hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
function sydneyMidnight(y: number, m: number, d: number): number {
  const utc = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = utc;
  for (let i = 0; i < 2; i++) guess = utc - tzOffset(guess);
  return guess;
}
function periodRange(period: unknown, now = Date.now()): { from?: number; to?: number } {
  if (!period || period === "all") return {};
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const y = pick("year"), m = pick("month"), d = pick("day");
  if (period === "today") return { from: sydneyMidnight(y, m, d), to: sydneyMidnight(y, m, d + 1) - 1 };
  if (period === "yesterday") return { from: sydneyMidnight(y, m, d - 1), to: sydneyMidnight(y, m, d) - 1 };
  if (period === "this_month") return { from: sydneyMidnight(y, m, 1), to: sydneyMidnight(y, m + 1, 1) - 1 };
  if (period === "last_month") return { from: sydneyMidnight(y, m - 1, 1), to: sydneyMidnight(y, m, 1) - 1 };
  return {};
}

async function ownPrivateCount(e: any, groupId: string, typeId: string, sender: string): Promise<number> {
  const row = await e.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE group_id=? AND type_id=? AND deleted_at IS NULL AND visibility='private' AND creator=?")
    .bind(groupId, typeId, sender).first();
  return Number(row?.n) || 0;
}

async function toolContext(e: any, args: any, ctx: ToolCtx): Promise<{ source: any; groupId: string; actor: Actor; write: WriteCtx }> {
  const context = ctx?.context || {};
  const source = context.batch?.find((m: any) => m.id === args?.source_id) || context.latest;
  if (!source?.id) throw new RecordError("invalid", "没找到对应的群消息");
  const groupId = source.group_id || context.latest?.group_id;
  const names: Map<string, string> = context.names instanceof Map ? context.names : new Map();
  const name = names.get(source.sender) || source.meta?.senderName || "成员" + String(source.sender || "").slice(-4);
  const isAdmin = await isAutoSender(e, source.sender).catch(() => false);
  const actor: Actor = { sender: source.sender, name, isAdmin };
  const write: WriteCtx = {
    e, groupId, actor, sourceMsgId: source.id,
    dedupBase: `${source.id}:records_${args?.op || "write"}`,
    now: Date.now(), names,
  };
  return { source, groupId, actor, write };
}

async function authorized(op: any, input: any): Promise<any | null> {
  // Loaded lazily: tools/index → records → authz → toolkit → tools/index is a
  // module cycle, and authz reads extraUntrustedNames() at module evaluation.
  const { authorizeRecords } = await import("../authz");
  const auth = await authorizeRecords(op, input);
  if (auth.ok) return null;
  return { ok: false, error_kind: "denied", retryable: false, reason_text: auth.reason, next_action: "向成员说明原话依据或权限不足，不要重试同一个调用" };
}

export const recordsReadTool: BotTool = {
  name: "records_read",
  untrusted: true,
  def: {
    type: "function",
    function: {
      name: "records_read",
      description:
        "查本群账本或清单：列类型、查明细、按人合计、导出 CSV；数字以这里的查询结果为准。默认查唯一账本",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["types", "query", "summarize", "export"] },
          type: { type: "string", description: "账本名或类型号；本群只有一个账本时可省略" },
          filter: {
            type: "object",
            properties: {
              person: { type: "string" }, status: { type: "string" },
              from: { type: "number" }, to: { type: "number" }, text: { type: "string" },
            },
            additionalProperties: false,
          },
          group_by: { type: "string", enum: ["person", "status", "creator"] },
          period: { type: "string", enum: ["today", "yesterday", "this_month", "last_month", "all"] },
          cursor: { type: "string" },
          source_id: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx): Promise<any> {
    try {
      const { source, groupId, actor } = await toolContext(e, args, ctx);
      const op = String(args?.op || "");
      if (op === "types") {
        const list = await activeTypes(e, groupId);
        const counts = await rows(e, "SELECT type_id,COUNT(*) AS n FROM records WHERE group_id=? AND deleted_at IS NULL GROUP BY type_id", groupId);
        const byType = new Map(counts.map((row) => [row.type_id, Number(row.n) || 0]));
        const types = list.map((row) => ({ id: row.id, short: shortOf(row.id), name: row.name, kind: row.kind, visibility_default: row.visibility_default, count: byType.get(row.id) || 0 }));
        const say = types.length
          ? "本群有 " + types.length + " 个记录类型：" + types.map((t) => `${t.name}（${t.kind === "list" ? "清单" : t.kind === "log" ? "日志" : "账本"}，${t.count} 条）`).join("、")
          : "本群还没有账本。想记东西直接说「记账 报销额度 我 100」。";
        return { ok: true, op, types, say };
      }
      const type = await resolveReadType(e, groupId, args?.type);
      if (op === "query") {
        const range = periodRange(args?.period);
        const filter = { ...(args?.filter || {}) };
        if (filter.from === undefined && range.from !== undefined) filter.from = range.from;
        if (filter.to === undefined && range.to !== undefined) filter.to = range.to;
        const q = await queryRecords(e, {
          groupId, typeId: type.id, viewer: actor,
          filter, cursor: args?.cursor,
        });
        const privateCount = await ownPrivateCount(e, groupId, type.id, actor.sender);
        const visible = q.rows.filter((row) => row.visibility !== "private");
        const say = `查到 ${visible.length} 条${type.name}记录` + (privateCount ? `。你有 ${privateCount} 条私有记录，${PRIVATE_NOTE}。` : "。");
        return { ok: true, op, type: { id: type.id, short: shortOf(type.id), name: type.name, kind: type.kind }, rows: visible, next: q.next, hiddenPrivate: q.hiddenPrivate, privateCount, say };
      }
      if (op === "summarize") {
        const privateCount = await ownPrivateCount(e, groupId, type.id, actor.sender);
        const viewer: Actor = privateCount ? { ...actor, sender: "__records_group_view__" } : actor;
        const range = periodRange(args?.period);
        const s = await summarizeRecords(e, { groupId, typeId: type.id, viewer, group_by: args?.group_by, ...range });
        const line = summaryLine(type.name, type.kind, s);
        const say = line + (privateCount ? `。另有 ${privateCount} 条私有记录，${PRIVATE_NOTE}。` : "");
        return { ok: true, op, type: { id: type.id, short: shortOf(type.id), name: type.name, kind: type.kind }, groups: s.groups, total_cents: s.total_cents, count: s.count, hiddenPrivate: s.hiddenPrivate, privateCount, summary_line: line, say };
      }
      if (op === "export") {
        const privateCount = await ownPrivateCount(e, groupId, type.id, actor.sender);
        const viewer: Actor = privateCount ? { ...actor, sender: "__records_group_view__" } : actor;
        const csv = await exportCsv(e, { groupId, typeId: type.id, viewer });
        const say = `导出好了：${csv.filename}（${csv.rows} 行${csv.truncated ? "，已截断" : ""}）。` + (privateCount ? `另有 ${privateCount} 条私有记录没有导出，${PRIVATE_NOTE}。` : "");
        return { ok: true, op, type: { id: type.id, short: shortOf(type.id), name: type.name, kind: type.kind }, filename: csv.filename, csv: csv.csv, rows: csv.rows, truncated: csv.truncated, privateCount, say };
      }
      throw new RecordError("invalid", "records_read 只支持 types/query/summarize/export");
    } catch (error) {
      if (error instanceof RecordError) return failure(error);
      throw error;
    }
  },
};

export const recordsWriteTool: BotTool = {
  name: "records_write",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "records_write",
      description:
        "记账或清单：建类型、记一笔、改或删先确认、撤销上一笔；只有成员本人原话能作为依据，改删确认限记录人或管理员。" +
        "「我加10/再加一笔」= op:add（新行，不是改旧行）；「把某人那笔改成60」= op:quote_update + match:{person} + patch:{amount:'60'}；" +
        "「删掉刚记的那笔」= op:quote_delete；改删会返回 token，成员回「确认」后再 op:confirm + token。",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["define_type", "add", "quote_update", "quote_delete", "confirm", "undo"] },
          type: { type: "string", description: "账本名或类型号" },
          name: { type: "string", description: "新建账本时的名字" },
          kind: { type: "string", enum: ["ledger", "list", "log"] },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                person: { type: "string" }, amount: { type: "string" }, amount_cents: { type: "number" },
                title: { type: "string" }, status: { type: "string" }, occurred_at: { type: ["string", "number"] },
              },
              additionalProperties: true,
            },
            maxItems: 50,
          },
          visibility: { type: "string", enum: ["group", "private"] },
          record_id: { type: "string" },
          match: {
            type: "object",
            properties: { person: { type: "string" }, title: { type: "string" } },
            additionalProperties: false,
          },
          patch: { type: "object", additionalProperties: true },
          token: { type: "string" },
          request_quote: { type: "string", description: "成员要办这件事的原话，必须逐字来自该成员本条消息" },
          source_id: { type: "string" },
        },
        required: ["op", "request_quote"],
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx): Promise<any> {
    try {
      const { source, groupId, actor, write } = await toolContext(e, args, ctx);
      const op = String(args?.op || "");
      if (!["define_type", "add", "quote_update", "quote_delete", "confirm", "undo"].includes(op)) throw new RecordError("invalid", "不支持的记录操作");
      const denied = await authorized(op, {
        e, source, context: ctx?.context, messages: ctx?.messages,
        request_quote: args?.request_quote, recordId: args?.record_id, token: args?.token,
        tainted: ctx?.isTainted?.() === true,
      });
      if (denied) return denied;
      const quote = String(args?.request_quote || "");

      if (op === "define_type") {
        let name = String(args?.name || args?.type || "").trim();
        if (!name) {
          const existing = await activeTypes(e, groupId);
          if (existing.length === 1) {
            const type = await findType(e, groupId, existing[0].id) as RecordTypeRow;
            return {
              ok: true, accepted: true, family: "record", id: type.id, short: shortOf(type.id),
              name: type.name, kind: type.kind, created: false,
              summary_line: `账本已经在库里（${shortOf(type.id)}，${type.name}）`,
              say: `账本已经在库里（${shortOf(type.id)}，${type.name}）。记账直接说「记账 ${type.name} 我加10」，查账说「总账单」。`,
            };
          }
          name = deriveName(quote, inferKind(args, quote));
        }
        const kind = args?.kind || inferKind(args, quote);
        const fuzzy = await findType(e, groupId, name);
        const known = fuzzy || (isGenericLedgerName(name)
          ? (await activeTypes(e, groupId)).filter((row) => row.kind === "ledger").length === 1
            ? await findType(e, groupId, (await activeTypes(e, groupId)).find((row) => row.kind === "ledger").id)
            : null
          : null);
        if (known) {
          return {
            ok: true, accepted: true, family: "record", id: known.id, short: shortOf(known.id),
            name: known.name, kind: known.kind, created: false,
            summary_line: `账本已经在库里（${shortOf(known.id)}，${known.name}）`,
            say: `账本已经在库里（${shortOf(known.id)}，${known.name}）。记账直接说「记账 ${known.name} 我加10」，查账说「总账单」。`,
          };
        }
        const { type, created } = await defineRecordType(write, { name, kind, visibility_default: args?.visibility });
        return {
          ok: true, accepted: true, family: "record", id: type.id, short: shortOf(type.id),
          name: type.name, kind: type.kind, created,
          summary_line: created ? `建好了${type.name}（${shortOf(type.id)}，${kind === "list" ? "清单" : kind === "log" ? "日志" : "账本"}）` : `账本已经在库里（${shortOf(type.id)}，${type.name}）`,
          say: created
            ? `账本建好了：${type.name}（${shortOf(type.id)}，${kind === "list" ? "清单" : kind === "log" ? "日志" : "账本"}）。记账直接说「记账 ${type.name} 我加10」，查账说「总账单」。`
            : `账本已经在库里（${shortOf(type.id)}，${type.name}）。记账直接说「记账 ${type.name} 我加10」，查账说「总账单」。`,
        };
      }

      if (op === "add") {
        const requested = String(args?.type || args?.name || "").trim();
        let type: RecordTypeRow | null = requested ? await findType(e, groupId, requested) : null;
        if (!type) {
          const existing = await activeTypes(e, groupId);
          if (!requested) {
            if (existing.length === 1) type = await findType(e, groupId, existing[0].id);
            else if (existing.length > 1) throw new RecordError("ambiguous", "本群有多个账本：" + existing.map((t) => t.name).join("、") + "，请说记到哪个");
          }
          if (!type && requested) {
            const hits = existing.filter((row) => row.name.includes(requested) || requested.includes(row.name));
            if (hits.length > 1) throw new RecordError("ambiguous", "本群有多个账本像「" + requested + "」：" + hits.map((t) => t.name).join("、") + "，请说记到哪个");
            if (!hits.length && isGenericLedgerName(requested)) {
              const ledgers = existing.filter((row) => row.kind === "ledger");
              if (ledgers.length === 1) type = await findType(e, groupId, ledgers[0].id);
            }
          }
          if (!type) {
            const kind = inferKind(args, quote);
            const name = requested || deriveName(quote, kind);
            type = (await defineRecordType(write, { name, kind, visibility_default: args?.visibility })).type;
          }
        }
        let inputRows = Array.isArray(args?.rows) ? args.rows.filter((row: any) => row && typeof row === "object") : [];
        if (!inputRows.length) inputRows = type.kind === "list" ? parseListProse(quote) : parseLedgerProse(quote);
        if (!inputRows.length) throw new RecordError("invalid", "没听出要记什么，请说清人员和金额");
        const added = await addRecords(write, type.id, inputRows, args?.visibility);
        const shorts = added.ids.map(shortOf);
        const shown = shorts.slice(0, 6).join("、") + (shorts.length > 6 ? ` 等 ${shorts.length} 条` : "");
        const isPrivate = args?.visibility === "private" || (!args?.visibility && type.visibility_default === "private");
        if (isPrivate) {
          const line = `${type.name}：新增 ${added.ids.length} 条私有记录`;
          const what = inputRows.slice(0, 3).map((row: any) => [row.person, row.title, row.amount].filter(Boolean).join(" ")).filter(Boolean).join("；");
          const say = added.ids.length
            ? `记好了（${type.name}，私有）：${what}。只有你能看到，群里只显示条数，到工作台查看明细。记录号 ${shown}。`
            : `这几笔已经记过了，没有重复写（${type.name}，私有）。`;
          return {
            ok: true, accepted: true, family: "record", type: { id: type.id, short: shortOf(type.id), name: type.name, kind: type.kind },
            ids: added.ids, short: shorts, duplicated: added.duplicated, private: true, summary_line: line, say,
          };
        }
        const s = await summarizeRecords(e, { groupId, typeId: type.id, viewer: { ...actor, sender: "__records_group_view__" } });
        const line = summaryLine(type.name, type.kind, s);
        const say = added.ids.length
          ? `记好了（${type.name}）：${line}。记录号 ${shown}。`
          : `这几笔已经记过了，没有重复写（${type.name}）。${line}。`;
        return {
          ok: true, accepted: true, family: "record", type: { id: type.id, short: shortOf(type.id), name: type.name, kind: type.kind },
          ids: added.ids, short: shorts, duplicated: added.duplicated, summary_line: line, say,
        };
      }

      if (op === "quote_update" || op === "quote_delete") {
        const type = await resolveReadType(e, groupId, args?.type);
        const change = await quoteChange(write, {
          record_id: args?.record_id, match: args?.match, typeId: type.id,
          op: op === "quote_update" ? "update" : "delete", patch: args?.patch,
        });
        const before = describe(change.before).slice(0, 60);
        const after = describe(change.after).slice(0, 60);
        const say = op === "quote_update"
          ? `要把 ${change.before.short}（${before}）改成 ${after} 吗？回我「确认」就改（10 分钟内有效）。`
          : `要删掉 ${change.before.short}（${before}）吗？回我「确认」就删（10 分钟内有效）。`;
        const title = op === "quote_update" ? "待确认的修改" : "待确认的删除";
        return {
          ok: true, accepted: true, family: "record", token: change.token,
          before: change.before, ...(change.after ? { after: change.after } : {}),
          short: change.before.short, expires_at: change.expires_at,
          summary_line: `${title}：${change.before.short} ${before}${change.after ? " → " + after : ""}`,
          say,
        };
      }

      if (op === "confirm") {
        if (!args?.token) throw new RecordError("invalid", "缺少确认号，请重新发起改动");
        const applied = await applyChange(write, String(args.token));
        const what = describe(applied.record);
        const say = applied.op === "update"
          ? `改好了：${applied.record.short} 现在是 ${what}。`
          : `删好了：${applied.record.short}（${what}）。10 分钟内可以说「撤销上一笔」。`;
        return {
          ok: true, accepted: true, family: "record", id: applied.record.id, short: applied.record.short,
          op: applied.op, record: applied.record, summary_line: `${applied.op === "update" ? "已修改" : "已删除"}：${applied.record.short} ${what}`, say,
        };
      }

      // undo
      const type = await resolveReadType(e, groupId, args?.type);
      const undone = await undoLast(write, type.id);
      if (!undone) throw new RecordError("not_found", "10 分钟内没有可撤销的记录");
      const label = undone.op === "add" ? "撤回新增" : undone.op === "update" ? "撤回修改" : "恢复删除";
      const what = describe(undone.undone);
      return {
        ok: true, accepted: true, family: "record", id: undone.undone.id, short: undone.undone.short,
        op: undone.op, record: undone.undone, summary_line: `${label}：${undone.undone.short} ${what}`,
        say: `撤销了上一笔（${label}）：${what}。`,
      };
    } catch (error) {
      if (error instanceof RecordError) return failure(error);
      throw error;
    }
  },
};
