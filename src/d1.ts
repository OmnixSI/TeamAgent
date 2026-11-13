/** Keep IN lists below D1's 100 bound-parameter limit. */
export function chunks<T>(xs: T[], n = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export type Meter = { used: number; limit: number; left(): number };
/** Count actual D1 executions; optional work decides how to use the remaining budget. */
export function metered<E extends { DB: any }>(e: E, limit = 48): E & { meter: Meter; tail: import("./timing").Tail } {
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
  return { ...e, DB: database, meter, tail: { timing: [], cache: [] } };
}
// B3–B7: image=6, model usage=2; correction with 8 superseded facts=12.
// send_row=15: atomic claim 7 + fenced result <=6 + quote fuse 2.
// sticker=6 covers switch, selection, daily budget, and three atomic reservation writes.
// Prefetch reserves only its SELECT; cache and timing writes are sent in the tail.
export const COST = { image: 6, turn: 2, tool: 12, send_row: 15, sticker: 6, tail: 16, prefetch: 1 };
export const left = (e: any) => e.meter ? e.meter.left() : Infinity;

/** Fixed application reason; never forward an arbitrary tool exception. */
export class ResourceLimitError extends Error {
  constructor() { super("本轮资源已用完，请再发一条消息继续"); }
}
