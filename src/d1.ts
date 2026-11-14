/** Keep IN lists below D1's 100 bound-parameter limit. */
export function chunks<T>(xs: T[], n = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export type Meter = { used: number; limit: number; left(): number };

/** Per-invocation statement budgets after the Workers Paid upgrade (D1 allows 1,000).
 *  Chat/HTTP gets 64: 19 statements before the model + 32 tool floor + 10 send = 61,
 *  leaving headroom so ordinary no-@ turns still offer tools; cron/background get 200. */
export const D1_BUDGET: { chat: number; background: number } = { chat: 64, background: 200 };
/** Queue name decides the budget without an extra D1 query. Only the two background
 *  lanes and their dead-letter queues get 200; the chat lane and any unknown name stay
 *  at the conservative 64. */
export const DLQ_QUEUES = ["inkboard-team-dlq", "team-agent-tools-dlq"];
export function queueLimit(queue: string | undefined): number {
  return queue === "inkboard-team" || queue === "team-agent-tools" || DLQ_QUEUES.includes(String(queue))
    ? D1_BUDGET.background
    : D1_BUDGET.chat;
}

/** Count actual D1 executions; optional work decides how to use the remaining budget. */
export function metered<E extends { DB: any }>(e: E, limit = D1_BUDGET.chat): E & { meter: Meter; tail: import("./timing").Tail } {
  if ((e as any).meter) return e as E & { meter: Meter; tail: import("./timing").Tail };
  const meter: Meter = { used: 0, limit, left() { return this.limit - this.used; } };
  const wrap = (statement: any): any => ({
    __s: statement, sql: statement.sql,
    bind(...args: any[]) { return wrap(statement.bind(...args)); },
    first(...args: any[]) { meter.used++; return statement.first(...args); },
    all(...args: any[]) { meter.used++; return statement.all(...args); },
    run(...args: any[]) { meter.used++; return statement.run(...args); },
  });
  const database = Object.create(e.DB);
  database.prepare = (sql: string) => wrap(e.DB.prepare(sql));
  database.batch = (statements: any[]) => {
    meter.used += statements.length;
    return e.DB.batch(statements.map(s => s.__s));
  };
  return { ...e, DB: database, meter, tail: { timing: [], cache: [], ruleActivities: [] } };
}
// B3–B7: image=8 (cache, vision cap, Workers AI neuron hold + correction, note write); model usage=2; correction with 8 superseded facts=12.
// send_row=10 includes lazy switches, reference recovery and the third-failure fuse.
// sticker=6 covers switch, selection, daily budget, and three atomic reservation writes.
// Prefetch reserves only its SELECT; cache and timing writes are sent in the tail.
export const COST = { image: 8, turn: 2, tool: 12, send_row: 10, sticker: 6, tail: 16, prefetch: 1 };
export const left = (e: any) => e.meter ? e.meter.left() : Infinity;

/** Fixed application reason; never forward an arbitrary tool exception. */
export class ResourceLimitError extends Error {
  constructor() { super("本轮资源已用完，请再发一条消息继续"); }
}
