// The bot's own books: what every paid call cost, per day and per purpose, checked against the real
// DeepSeek balance, plus how much of the Cloudflare plan's monthly allowance is used.
import type { Hub } from "./hub.ts";
import { dsBalance } from "./llm.ts";
import { PRICE } from "./meter.ts";
import type { Use } from "./meter.ts";
import { BJ, fmtDate, fmtFull } from "./util.ts";

const integer = (n: number) => n.toLocaleString("zh-CN");
export const reportHeading = (day: string) => `【每日账目｜${day} 北京时间】`;

type TokenTotals = { input_tokens: number; output_tokens: number; total_tokens: number };
function tokens(input: number, output: number): TokenTotals {
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

export class Accounts {
  private hub: Hub;
  constructor(hub: Hub) { this.hub = hub; }
  record(u: Use) {
    this.hub.sql.exec(
      "INSERT INTO spend(day,provider,item,unit,calls,in_tok,cached_tok,out_tok,units,usd) VALUES(?,?,?,?,1,?,?,?,?,?) " +
      "ON CONFLICT(day,provider,item) DO UPDATE SET calls=calls+1, in_tok=in_tok+excluded.in_tok, cached_tok=cached_tok+excluded.cached_tok, out_tok=out_tok+excluded.out_tok, units=units+excluded.units, usd=usd+excluded.usd",
      fmtDate(Date.now(), BJ), u.provider, u.item, u.unit || "", u.inTok || 0, u.cachedTok || 0, u.outTok || 0, u.units || 0, u.usd || 0);
  }
  async balance(): Promise<number | null> {
    try {
      const d: any = await dsBalance(this.hub.env);
      const amount = (d.balance_infos || []).find((b: any) => b.currency === "CNY")?.total_balance;
      if (amount == null || String(amount).trim() === "") return null;
      const cny = Number(amount);
      return Number.isFinite(cny) ? cny : null;
    } catch { return null; }
  }
  /** DeepSeek balance at the start of each Beijing day; the difference between days is what was really spent. */
  async snapshot() {
    const day = fmtDate(Date.now(), BJ);
    if (this.hub.sql.exec("SELECT 1 FROM snap WHERE day=?", day).toArray().length) return;
    const cny = await this.balance();
    if (cny !== null) this.hub.sql.exec("INSERT OR IGNORE INTO snap(day,cny,ts) VALUES(?,?,?)", day, cny, Date.now());
  }
  /** Estimated spend for one Beijing day, both providers folded into CNY at the DeepSeek rate. */
  dayEstimateCny(day: string) {
    const rows = this.hub.sql.exec("SELECT provider, SUM(usd) usd FROM spend WHERE day=? GROUP BY provider", day).toArray() as any[];
    return rows.reduce((n, r) => n + Number(r.usd) * (r.provider === "deepseek" ? PRICE.dsCnyPerUsd : 7.2), 0);
  }
  /** Ledger and balance are read at report time. Only the usage window is a completed Beijing day. */
  async dailyReport(conv: string, day: string) {
    const rows = this.hub.sql.exec(
      "SELECT provider,SUM(in_tok) input,SUM(out_tok) output,SUM(usd) usd FROM spend WHERE day=? GROUP BY provider ORDER BY provider", day,
    ).toArray() as { provider: string; input: number; output: number; usd: number }[];
    const providers = rows.map(r => ({ provider: String(r.provider), ...tokens(Number(r.input), Number(r.output)), estimated_usd: Number(r.usd) }));
    const total = tokens(providers.reduce((n, r) => n + r.input_tokens, 0), providers.reduce((n, r) => n + r.output_tokens, 0));
    const live = await this.balance();
    const snap = live === null ? this.hub.sql.exec("SELECT cny,ts FROM snap WHERE cny IS NOT NULL ORDER BY ts DESC LIMIT 1").toArray()[0] : undefined;
    const balance = live !== null ? { cny: live, source: "live" as const, at: Date.now() }
      : snap ? { cny: Number(snap.cny), source: "snapshot" as const, at: Number(snap.ts) } : null;
    const entries = (this.hub.sql.exec("SELECT name,balance FROM ledger WHERE conv=? ORDER BY name", conv).toArray() as { name: string; balance: number }[])
      .map(r => ({ name: r.name.replace(/\s+/g, " ").trim(), cents: Math.round(r.balance * 100) }));
    const ledger = { entries, total_cents: entries.reduce((n, r) => n + r.cents, 0) };
    const providerName = (provider: string) => provider === "deepseek" ? "DeepSeek" : "OpenAI";
    const costs = providers.map(r => r.provider === "deepseek"
      ? `DeepSeek ¥${(r.estimated_usd * PRICE.dsCnyPerUsd).toFixed(2)}` : `OpenAI $${r.estimated_usd.toFixed(2)}`);
    const text = [
      reportHeading(day),
      entries.length ? `群账本（发布时） ${entries.map(r => `${r.name} ¥${(r.cents / 100).toFixed(2)}`).join("、")}，合计 ¥${(ledger.total_cents / 100).toFixed(2)}` : "群账本暂无记录。",
      balance ? `DeepSeek 余额 ¥${balance.cny.toFixed(2)}${balance.source === "snapshot" ? `（即时读取失败，最近快照 ${fmtFull(balance.at, BJ)}）` : "（接口实读）"}` : "DeepSeek 余额暂不可查。",
      total.total_tokens ? `已记录 token 总数 ${integer(total.total_tokens)}（输入 ${integer(total.input_tokens)}，输出 ${integer(total.output_tokens)}）` : "暂无带 token 数据的调用记录。",
      ...providers.filter(r => r.total_tokens > 0).map(r => `· ${providerName(r.provider)} ${integer(r.total_tokens)} token`),
      ...(costs.length ? [`当日费用估算 ${costs.join("、")}`] : []),
      "Token 来自 Bot 记录的 API 用量。按次、按时计量及其他客户端的用量不计入。",
    ].join("\n");
    return { date: day, ledger, deepseek_balance: balance, tokens: { ...total, providers: providers.map(({ provider, input_tokens, output_tokens, total_tokens }) => ({ provider, input_tokens, output_tokens, total_tokens })) }, text };
  }
  async usage(days: number) {
    await this.snapshot().catch(() => {});
    const since = fmtDate(Date.now() - (days - 1) * 86400000, BJ), today = fmtDate(Date.now(), BJ);
    const rows = this.hub.sql.exec("SELECT * FROM spend WHERE day>=? ORDER BY day DESC, usd DESC", since).toArray();
    const cny = (usd: number) => Math.round(usd * PRICE.dsCnyPerUsd * 1000) / 1000, r4 = (n: number) => Math.round(n * 10000) / 10000;
    const byDay: Record<string, any> = {};
    for (const r of rows as any[]) {
      const d = (byDay[r.day] ||= { date: r.day, deepseek_estimate_cny: 0, openai_estimate_usd: 0, ...tokens(0, 0), items: [] });
      if (r.provider === "deepseek") d.deepseek_estimate_cny += Number(r.usd) * PRICE.dsCnyPerUsd; else d.openai_estimate_usd += Number(r.usd);
      d.input_tokens += Number(r.in_tok);
      d.output_tokens += Number(r.out_tok);
      d.total_tokens = d.input_tokens + d.output_tokens;
      d.items.push({
        what: r.item, via: r.provider === "deepseek" ? "DeepSeek" : "OpenAI", calls: r.calls,
        ...(r.in_tok || r.out_tok ? { input_tokens: r.in_tok, cached_input_tokens: r.cached_tok, output_tokens: r.out_tok } : {}),
        ...(r.units && r.unit ? { amount: Math.round(Number(r.units) * 10) / 10 + " " + r.unit } : {}),
        cost: r.provider === "deepseek" ? "约 ¥" + cny(Number(r.usd)) : "约 $" + r4(Number(r.usd)),
      });
    }
    const balanceNow = await this.balance();
    const snaps = this.hub.sql.exec("SELECT day,cny FROM snap WHERE day>=? ORDER BY day", fmtDate(Date.now() - days * 86400000, BJ)).toArray() as any[];
    const real: any[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const end = i + 1 < snaps.length ? Number(snaps[i + 1].cny) : snaps[i].day === today ? balanceNow : null;
      if (end === null || !Number.isFinite(end)) continue;
      const diff = Math.round((Number(snaps[i].cny) - end) * 100) / 100;
      real.push({ date: snaps[i].day, ...(diff >= 0 ? { really_spent_cny: diff } : { topped_up_cny: -diff }), ...(snaps[i].day === today ? { note: "今天到现在" } : {}) });
    }
    const list = Object.values(byDay).map((d: any) => ({ ...d, deepseek_estimate_cny: Math.round(d.deepseek_estimate_cny * 1000) / 1000, openai_estimate_usd: r4(d.openai_estimate_usd) }));
    return {
      days: list,
      total: { deepseek_estimate_cny: Math.round(list.reduce((n, d: any) => n + d.deepseek_estimate_cny, 0) * 100) / 100, openai_estimate_usd: r4(list.reduce((n, d: any) => n + d.openai_estimate_usd, 0)), ...tokens(list.reduce((n, d: any) => n + d.input_tokens, 0), list.reduce((n, d: any) => n + d.output_tokens, 0)) },
      deepseek_account: { balance_now_cny: balanceNow, real_spend_by_day: real, note: "真实花费是账户余额的变化，包含这个 key 在别处的用量；记账是从 2026-11-14 晚上开始的，之前的没有明细" },
      cloudflare_plan: this.hub.plan.report(this.hub.store.r2All()),
      about_the_numbers: "DeepSeek 按官方价格表估（工作日北京时间 9–12 点、14–18 点是双倍价），以余额变化为准。OpenAI 是按每次调用返回的用量和官方价格估的美元，真实账单要这把 key 有读账单的权限才能查，现在没有。Cloudflare 是每月 5 美元的固定套餐，cloudflare_plan 里是套餐内含量用了多少，用到停止线就停，不会多花钱。日期按北京时间。",
    };
  }
}
