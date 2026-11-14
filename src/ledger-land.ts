// D4 阶段 2 返工：账本承诺的确定性补建。
// 守卫发现「已记/已加/已删/已改」但本轮没有 records_write 成功时，用一次非 thinking 的
// JSON 抽取（只抽动作，不给工具）拿到 {op,type,person,amount,title,note}，再走 records_write
// 的内部实现落库；抽不出或校验失败返回 null，守卫会改成「没记上」。
import { model } from "./runtime";
import { isAutoSender } from "./feature-request-core";
import { recordsWriteTool } from "./tools/records";
import { toolSwitchedOff } from "./toolkit";
import { tainted } from "./authz";
import type { Accepted } from "./receipt-guard";

export type LedgerOp = "add" | "set" | "delete" | "mark_done" | "confirm";

export interface LedgerAction {
  op: LedgerOp;
  type?: string;
  person?: string;
  amount?: string;
  title?: string;
  note?: string;
}

const OPS = new Set<LedgerOp>(["add", "set", "delete", "mark_done", "confirm"]);
const EXTRACT_MODEL_KIND = "ledger";
const EXTRACT_TIMEOUT_MS = 20000;

function clean(value: unknown, max = 40): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max);
}

/** 非 thinking + json_object：从成员原话抽一个账本动作。只抽，不执行。 */
export async function extractLedgerAction(e: any, text: string): Promise<LedgerAction | null> {
  const quote = clean(text, 500);
  if (!quote) return null;
  let content = "";
  try {
    const d = await model(
      e,
      EXTRACT_MODEL_KIND,
      "none",
      {
        max_tokens: 220,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是账本动作抽取器。只输出一个 JSON 对象，不要解释。字段：op 只能是 add/set/delete/mark_done/confirm；" +
              "type 是账本名；person 是人名；amount 是金额数字（不带单位）；title 是事项；note 是备注。没有的字段填 null。" +
              "「X买了/X勾掉/X完成/X打勾」是 mark_done（不是 add）；「再加/又记一笔/我加10」才是 add。",
          },
          { role: "user", content: "群友原话：" + quote },
        ],
      },
      EXTRACT_TIMEOUT_MS,
    );
    content = String(d?.choices?.[0]?.message?.content || "");
  } catch {
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const op = clean(parsed.op) as LedgerOp;
  if (!OPS.has(op)) return null;
  const action: LedgerAction = { op };
  for (const key of ["type", "person", "title"] as const) {
    const value = clean(parsed[key]);
    if (value) action[key] = value;
  }
  const amount =
    typeof parsed.amount === "number" && Number.isFinite(parsed.amount)
      ? String(parsed.amount)
      : clean(parsed.amount, 24).replace(/[¥￥元块\s]/g, "");
  if (amount) action.amount = amount;
  const note = clean(parsed.note, 120);
  if (note) action.note = note;
  return action;
}

function rowsFor(action: LedgerAction): Record<string, unknown>[] {
  if (action.person || action.amount) {
    return [
      {
        ...(action.person ? { person: action.person } : {}),
        ...(action.amount ? { amount: action.amount } : {}),
        ...(action.title ? { title: action.title } : {}),
      },
    ];
  }
  if (action.title) {
    const titles = action.title
      .split(/[、,，;；]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 50);
    return titles.length > 1 ? titles.map((title) => ({ title })) : [{ title: action.title }];
  }
  // 清单口语「购物清单：鸡蛋、牛奶」：按顿号/逗号拆成多行。
  if (action.note) {
    const titles = action.note
      .split(/[、,，;；]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (titles.length) return titles.map((title) => ({ title }));
  }
  return [];
}

/** records_read 读的是本群账本，不该把同一轮的记账/删账判成污染；外部资料仍算污染。 */
export function recordsTaint(context: any, messages: any[], fallback: () => boolean = () => false): boolean {
  try {
    const readIds = new Set<string>();
    for (const m of messages) {
      if (m?.role !== "assistant") continue;
      for (const call of m.tool_calls || [])
        if (String(call?.function?.name || "") === "records_read") readIds.add(String(call.id));
    }
    const filtered = messages.filter(
      (m) => !(m?.role === "tool" && readIds.has(String(m.tool_call_id))),
    );
    return tainted(context, filtered);
  } catch {
    return fallback();
  }
}

async function openConfirmToken(e: any, groupId: string, sender: string): Promise<string | null> {
  const row = await e.DB.prepare(
    "SELECT id FROM pending_actions WHERE group_id=? AND sender=? AND tool='records_write' AND status='open' AND expires_at>? ORDER BY asked_at DESC LIMIT 1",
  )
    .bind(groupId, sender, Date.now())
    .first();
  return row?.id ? String(row.id) : null;
}

/**
 * 同一轮里模型已经 quote 了单笔改/删、却停下来等确认时，用户原话本来就是明确命令：
 * 直接 confirm 落库，避免「说了删但没删」。批量/清空仍然不自动确认。
 */
export async function confirmPendingFromCommand(
  e: any,
  context: any,
  messages: any[],
  since: number,
): Promise<Accepted | null> {
  const latest = context?.latest;
  if (!latest?.id || !latest?.group_id || !latest?.sender || !latest?.body) return null;
  const body = String(latest.body).trim();
  const isConfirmWord = /^确认[。！!]?$/.test(body);
  if (!isConfirmWord && (!/[删改标]|done|完成|已买|买好|勾掉/.test(body) || /[？?]|吗/.test(body))) return null;
  if (recordsTaint(context, messages)) return null;
  const row = await e.DB.prepare(
    "SELECT id,draft FROM pending_actions WHERE group_id=? AND sender=? AND tool='records_write' AND status='open' AND expires_at>? AND asked_at>=? ORDER BY asked_at DESC LIMIT 1",
  )
    .bind(latest.group_id, latest.sender, Date.now(), isConfirmWord ? 0 : Number(since) || 0)
    .first();
  if (!row?.id) return null;
  let draft: any = {};
  try {
    draft = JSON.parse(String(row.draft || "{}"));
  } catch {
    return null;
  }
  if (!Array.isArray(draft?.recordIds) || draft.recordIds.length !== 1) return null;
  // 金额修改保留 quote→确认 两步（S-05）；单笔删除和「标成完成」才在同一轮落库。
  const markDone = String(draft?.after?.status || "") === "done";
  if (draft?.op === "update" && !markDone) return null;
  try {
    const result = await recordsWriteTool.run(
      e,
      { op: "confirm", token: String(row.id), request_quote: body, source_id: latest.id },
      { context, source: latest, messages, isTainted: () => false },
    );
    return acceptedOf(result);
  } catch {
    return null;
  }
}

/**
 * 执行一次账本兜底。调用方只在「守卫发现 record 承诺且本轮无 records_write 成功」时调用。
 * 所有权限/归属/去重仍走 records_write 自己的 authorizeRecords 与 applyChange。
 */

export async function landLedger(
  e: any,
  context: any,
  messages: any[],
  isTainted: () => boolean,
): Promise<Accepted | null> {
  const latest = context?.latest;
  if (!latest?.id || !latest?.group_id || !latest?.sender || !latest?.body) return null;
  if (await toolSwitchedOff(e, recordsWriteTool)) return null;
  // 外部资料（引用/转发/网页）仍拒绝；只有 records_read 的账本结果不算污染。
  const dirty = recordsTaint(context, messages, isTainted);
  if (dirty) return null;
  const addressed =
    latest.meta?.direct === true || Number(latest.mentioned) === 1 || context.mentioned === true;
  if (!addressed) return null;
  const action = await extractLedgerAction(e, String(latest.body));
  if (!action) return null;
  // 「我加10」「删掉刚记的那笔」里没有人名：按说话人处理（records 的 normalizePerson 认「我」）。
  if (!action.person && !action.title && ["add", "set", "delete", "mark_done"].includes(action.op))
    action.person = "我";

  const ctx = { context, source: latest, messages, isTainted: () => dirty };
  const quote = String(latest.body);
  const run = (args: any) => recordsWriteTool.run(e, args, ctx);
  const base = { request_quote: quote, source_id: latest.id };

  try {
    if (action.op === "confirm") {
      const token = await openConfirmToken(e, String(latest.group_id), String(latest.sender));
      if (!token) return null;
      const result = await run({ op: "confirm", token, ...base });
      return acceptedOf(result);
    }

    if (action.op === "add") {
      const rows = rowsFor(action);
      if (!rows.length) return null;
      const result = await run({
        op: "add",
        ...(action.type ? { type: action.type } : {}),
        rows,
        ...base,
      });
      return acceptedOf(result);
    }

    // set / delete / mark_done：先 quote，再立即 confirm —— 模型已经在回复里声称做完了。
    const match = {
      ...(action.person ? { person: action.person } : {}),
      ...(action.title ? { title: action.title } : {}),
    };
    if (!Object.keys(match).length) return null;
    const args: any =
      action.op === "delete"
        ? { op: "quote_delete", ...(action.type ? { type: action.type } : {}), match, ...base }
        : {
            op: "quote_update",
            ...(action.type ? { type: action.type } : {}),
            match,
            patch: action.op === "mark_done" ? { status: "done" } : { amount: action.amount },
            ...base,
          };
    if (action.op === "set" && !action.amount) return null;
    const quoted = await run(args);
    if (quoted?.ok !== true || !quoted.token) return null;
    const confirmed = await run({ op: "confirm", token: quoted.token, ...base });
    return acceptedOf(confirmed);
  } catch {
    return null;
  }
}

function acceptedOf(result: any): Accepted | null {
  if (result?.ok !== true || result?.accepted !== true) return null;
  const id = result.id || result.ids?.[0];
  if (!id) return null;
  return {
    tool: "records_write",
    family: "record",
    id: String(id),
    ok: true,
    say: typeof result.say === "string" ? result.say : "",
  } as Accepted;
}
