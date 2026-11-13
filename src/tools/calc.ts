import type { BotTool } from "../toolkit";

// A bounded recursive-descent arithmetic parser; no JavaScript execution or dependencies.
export function calculate(expression: unknown): number {
  if (typeof expression !== "string" || !expression.trim()) throw Error("请输入算式");
  if (new TextEncoder().encode(expression).length > 1024) throw Error("算式不能超过 1KB");
  const text = expression;
  let at = 0, depth = 0;
  const space = () => { while (/\s/.test(text[at] || "") && at < text.length) at++; };
  const finite = (value: number) => { if (!Number.isFinite(value)) throw Error("计算结果超出范围"); return value; };
  function primary(): number {
    if (++depth > 32) throw Error("算式嵌套过深");
    space(); let value: number;
    const ch = text[at];
    if (ch === "+" || ch === "-") { at++; value = (ch === "-" ? -1 : 1) * primary(); }
    else if (ch === "(") {
      at++; value = sum(); space(); if (text[at++] !== ")") throw Error("括号不匹配");
    } else {
      const token = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(text.slice(at));
      if (!token) throw Error("只支持数字、小数及 + - * / % ( )");
      at += token[0].length; value = finite(Number(token[0]));
    }
    depth--; return value;
  }
  function product(): number {
    let value = primary(); space();
    while (["*", "/", "%"].includes(text[at])) {
      const op = text[at++], rhs = primary();
      if ((op === "/" || op === "%") && rhs === 0) throw Error("不能除以零或对零取余");
      value = finite(op === "*" ? value * rhs : op === "/" ? value / rhs : value % rhs); space();
    }
    return value;
  }
  function sum(): number {
    let value = product(); space();
    while (text[at] === "+" || text[at] === "-") {
      const op = text[at++], rhs = product(); value = finite(op === "+" ? value + rhs : value - rhs); space();
    }
    return value;
  }
  const value = sum(); space(); if (at !== text.length) throw Error("算式中有不支持的字符或缺少运算符");
  return value;
}

export const calcTool: BotTool = {
  name: "calc",
  def: { type: "function", function: { name: "calc", description: "安全计算数字算式，支持小数、+ - * / % 和括号，最长 1KB。", parameters: { type: "object", properties: { expression: { type: "string", maxLength: 1024 } }, required: ["expression"], additionalProperties: false } } },
  untrusted: false,
  async run(_e, args) {
    try { return { ok: true, value: calculate(args?.expression) }; }
    catch (error) { return { ok: false, error_kind: "invalid_arguments", retryable: false, reason_text: (error as Error).message, next_action: "请提供有效的数字算式" }; }
  },
};
