/** Keep IN lists below D1's 100 bound-parameter limit. */
export function chunks<T>(xs: T[], n = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export type Meter = { used: number; limit: number; left(): number };
/** Count actual D1 executions; optional work decides how to use the remaining budget. */
export function metered<E extends { DB: any }>(e: E, limit = 48): E & { meter: Meter } {
  if ((e as any).meter) return e as E & { meter: Meter };
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
  return { ...e, DB: database, meter };
}
export const COST = { image: 6, turn: 2, tool: 8, send_row: 7, sticker: 5, tail: 16 };
export const left = (e: any) => e.meter ? e.meter.left() : Infinity;
