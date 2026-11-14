// One conversation turn: a single model sees the real messages, calls tools itself,
// reads the real results, and writes the reply. No separate "decider" and "speaker".
import { BJ, SYD, cleanReply, clip, fmtFull, fmtTime, splitReply } from "./util.ts";
import type { ChatResult, Effort } from "./llm.ts";
import { PERSONA } from "./persona.ts";

export type Row = {
  seq: number; id: string; role: "user" | "bot";
  sender?: string; name?: string; text: string; ts: number; mentioned?: number; meta?: any;
};
export type Tool = {
  name: string; description: string; parameters: any;
  /** slow tools may get a short "on it" line first; work tools switch the model to careful mode */
  slow?: boolean; work?: boolean;
  run(args: any): Promise<any>;
};
export type TurnInput = {
  rows: Row[];              // recent history, oldest first
  cursor: number;           // rows with seq > cursor are new
  mentioned: boolean;
  memory: string;           // long-term memory document
  notes: string[];          // things remembered since the last nightly consolidation
  now: number;
  task?: string;            // set when a schedule fires instead of a chat message
  images?: { seq: number; index: number; dataUrl: string }[];
};
export type TurnDeps = {
  chat(body: { messages: any[]; tools?: any[]; max_tokens?: number }, effort: Effort, timeoutMs?: number): Promise<ChatResult>;
  tools: Tool[];
  interim?(text: string): Promise<void>;
};
export type TurnResult = {
  replies: string[]; silent: boolean;
  stats: { calls: number; tools: string[]; inTok: number; outTok: number; cached: number; ms: number; firstMs: number; error?: string };
};

const MAX_ROUNDS = 8;

export function displayName(r: Row) {
  return r.name || (r.sender ? "成员" + r.sender.slice(-4) : "成员");
}

export function renderLine(r: Row, captions = true) {
  let body = r.text || "";
  const meta = r.meta || {};
  if (meta.quote) body = "〔回复 " + (meta.quote.name || "某人") + "：“" + clip(meta.quote.text, 60) + "”〕" + body;
  const images: any[] = meta.images || [];
  images.forEach((im, i) => {
    body += captions && im.caption ? " [图片：" + clip(im.caption, 80) + "]" : " [图片 " + r.seq + "-" + i + "]";
  });
  for (const f of meta.files || []) body += " [文件 " + (f.name || "未命名") + " " + f.url + "]";
  if (meta.video) body += " [视频]";
  return "[" + fmtTime(r.ts) + "] " + displayName(r) + (r.mentioned ? "（@你）" : "") + "：" + body.trim();
}

export function systemPrompt(memory: string, notes: string[]) {
  return PERSONA +
    "\n\n【你记得的事】（长期记忆，每晚整理一次）\n" + (memory.trim() || "（还没有）") +
    (notes.length ? "\n\n【最近刚记下的】\n" + notes.map(n => "· " + n).join("\n") : "");
}

/** History as real chat turns: people's lines are user content, your own past lines are assistant content. */
export function buildMessages(input: TurnInput) {
  const messages: any[] = [{ role: "system", content: systemPrompt(input.memory, input.notes) }];
  const rows = input.rows.slice();
  while (rows.length && rows[0].role === "bot") rows.shift();
  const fresh = new Set((input.images || []).map(im => im.seq));
  let pending: string[] = [], markerDone = false;
  const flush = () => { if (pending.length) { messages.push({ role: "user", content: pending.join("\n") }); pending = []; } };
  for (const r of rows) {
    if (r.role === "bot") {
      flush();
      const last = messages[messages.length - 1];
      if (last.role === "assistant") last.content += "\n" + r.text;
      else messages.push({ role: "assistant", content: r.text });
      continue;
    }
    if (!markerDone && r.seq > input.cursor && pending.length) { pending.push("———— 以下是新消息 ————"); markerDone = true; }
    if (r.seq > input.cursor) markerDone = true;
    pending.push(renderLine(r, !fresh.has(r.seq)));
  }
  const when = "现在：北京时间 " + fmtFull(input.now, BJ) + "（悉尼 " + fmtFull(input.now, SYD) + "）。";
  if (input.task) {
    pending.push("\n[" + when + "定时任务触发，不是群友发言：" + input.task + "\n把要发到群里的话直接写出来；如果确实没什么可发，只输出 PASS。]");
  } else {
    pending.push("\n[" + when + (input.mentioned
      ? "有人在叫你或对你说话，必须回应，不能 PASS。"
      : "没人叫你。值得接就接一句，不值得就只输出 PASS。") + "]");
  }
  const text = pending.join("\n");
  if (input.images?.length) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text },
        ...input.images.flatMap(im => [
          { type: "text", text: "图片 " + im.seq + "-" + im.index + "：" },
          { type: "image_url", image_url: { url: im.dataUrl } },
        ]),
      ],
    });
  } else messages.push({ role: "user", content: text });
  return messages;
}

const toolDefs = (tools: Tool[]) =>
  tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

function tidy(content: unknown) {
  let text = String(content || "");
  // Tool-call markup occasionally leaks into the text channel; never show it.
  text = text.split("\n").filter(l => !/DSML|<｜|<\|tool|function_calls>/.test(l)).join("\n");
  text = text.replace(/^\s*(\[\d\d:\d\d\]\s*)?(bot|我|奶蛙)\s*[:：]\s*/i, "");
  return text.trim();
}
const isPass = (text: string) => !text || /^\s*[（(【\[]?\s*PASS\b/i.test(text);

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnResult> {
  const started = Date.now();
  const stats: TurnResult["stats"] = { calls: 0, tools: [], inTok: 0, outTok: 0, cached: 0, ms: 0, firstMs: 0 };
  const messages = buildMessages(input);
  const defs = toolDefs(deps.tools);
  const mustReply = input.mentioned || !!input.task;
  let careful = !!input.task, interimSent = false, final = "", nudged = false;

  const call = async (withTools: boolean, effort: Effort, maxTokens: number) => {
    const r = await deps.chat({ messages, tools: withTools ? defs : undefined, max_tokens: maxTokens }, effort, effort === "none" ? 45000 : 150000);
    stats.calls++;
    stats.inTok += Number(r.usage.prompt_tokens || 0);
    stats.outTok += Number(r.usage.completion_tokens || 0);
    stats.cached += Number(r.usage.prompt_cache_hit_tokens ?? r.usage.prompt_tokens_details?.cached_tokens ?? 0);
    if (!stats.firstMs) stats.firstMs = Date.now() - started;
    return r.message;
  };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const lastRound = round === MAX_ROUNDS - 1;
      if (lastRound) messages.push({ role: "user", content: "[工具次数用完了。就用手上已有的结果把话说完，没查到的照实说。]" });
      const msg = await call(!lastRound, careful ? "high" : "none", careful ? 4000 : 900);
      const calls: any[] = msg.tool_calls || [];
      if (!calls.length) {
        final = tidy(msg.content);
        if (isPass(final) && mustReply && !nudged) {
          nudged = true;
          messages.push({ role: "assistant", content: msg.content || "PASS" });
          messages.push({ role: "user", content: "[这条是对你说的，直接回话。]" });
          continue;
        }
        break;
      }
      const used = calls.map(c => deps.tools.find(t => t.name === c.function?.name));
      if (deps.interim && !interimSent && input.mentioned && used.some(t => t?.slow)) {
        const lead = tidy(msg.content);
        if (lead && lead.length <= 40 && !isPass(lead)) { interimSent = true; await deps.interim(cleanReply(lead)).catch(() => {}); }
      }
      // Thinking mode requires the reasoning of earlier tool-call turns to be passed back.
      messages.push({ role: "assistant", content: msg.content || "", reasoning_content: msg.reasoning_content || "", tool_calls: calls });
      const results = await Promise.all(calls.map(async (c, i) => {
        const tool = used[i];
        stats.tools.push(c.function?.name || "?");
        if (!tool) return { error: "没有这个工具" };
        let args: any = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch { return { error: "参数不是合法 JSON" }; }
        try { return await tool.run(args); }
        catch (err: any) { return { ok: false, error: clip(err?.message || String(err), 300) }; }
      }));
      calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: clip(JSON.stringify(results[i]), 24000) }));
      if (used.some(t => t?.work)) careful = true;
    }
  } catch (err: any) {
    stats.error = clip(err?.message || String(err), 300);
    if (mustReply && !input.task) final = "我这边刚才卡了一下，没处理完，你再说一遍";
  }

  stats.ms = Date.now() - started;
  if (isPass(final)) return { replies: [], silent: true, stats };
  const cleaned = cleanReply(final);
  return { replies: careful ? [cleaned] : splitReply(cleaned).slice(0, 3), silent: false, stats };
}
