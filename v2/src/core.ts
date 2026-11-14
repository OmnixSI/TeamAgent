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
  rules?: string;           // self-added persona playbook
  askers?: string[];        // who addressed the bot in this batch
  talkative?: string;       // quiet | normal | chatty
  splitMax?: number;
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
    body += " [图片 " + r.seq + "-" + i + (captions && im.caption ? "：" + clip(im.caption, 80) : "") + "]";
  });
  for (const f of meta.files || []) body += " [文件 " + (f.name || "未命名") + " " + f.url + "]";
  if (meta.video) body += " [视频]";
  return "[" + fmtTime(r.ts) + "] " + displayName(r) + (r.mentioned ? "（@你）" : "") + "：" + clip(body.trim(), 1500);
}

export function systemPrompt(memory: string, notes: string[], rules = "") {
  return PERSONA + (rules.trim() ? "\n\n【后来加的规矩】（你自己或群主后来补的，和上面冲突时以这里为准）\n" + rules.trim() : "") +
    "\n\n【你记得的事】（长期记忆，每晚整理一次）\n" + (memory.trim() || "（还没有）") +
    (notes.length ? "\n\n【最近刚记下的】\n" + notes.map(n => "· " + n).join("\n") : "");
}

/** History as real chat turns: people's lines are user content, your own past lines are assistant content. */
export function buildMessages(input: TurnInput) {
  const messages: any[] = [{ role: "system", content: systemPrompt(input.memory, input.notes, input.rules) }];
  const rows = input.rows.slice();
  while (rows.length && rows[0].role === "bot") rows.shift();
  const fresh = new Set((input.images || []).map(im => im.seq));
  let pending: string[] = [], markerDone = false;
  const flush = () => { if (pending.length) { messages.push({ role: "user", content: pending.join("\n") }); pending = []; } };
  for (const r of rows) {
    if (r.role === "bot") {
      flush();
      const last = messages[messages.length - 1];
      // Your own long answers from earlier are kept short in history; the gist is enough to stay consistent.
      const said = r.seq > input.cursor - 30 ? r.text : clip(r.text, 500);
      if (last.role === "assistant") last.content += "\n" + said;
      else messages.push({ role: "assistant", content: said });
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
    const who = [...new Set(input.askers || [])];
    const idle = input.talkative === "quiet" ? "没人叫你。除非有非说不可的新信息，否则只输出 PASS。"
      : input.talkative === "chatty" ? "没人叫你。有能接的话、能抖的机灵就接一句，实在没什么可说才输出 PASS。"
      : "没人叫你。值得接就接一句，不值得就只输出 PASS。";
    pending.push("\n[" + when + (input.mentioned
      ? "有人在叫你或对你说话，必须回应，不能 PASS。" + (who.length > 1 ? "这批新消息里找你的有 " + who.join("、") + "，每个人的事都要办、都要回应，别只办其中一个。" : "")
      : idle) + "]");
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
  // Lines like "[你发了一张图 g12：…]" are the log's record of media you sent, never something to say.
  text = text.split("\n").filter(l => !/^\s*\[你发了(一张图|一个文件|一条语音|表情包)/.test(l)).join("\n");
  text = text.replace(/^\s*(\[\d\d:\d\d\]\s*)?(bot|我|奶蛙)\s*[:：]\s*/i, "");
  return text.trim();
}
const PROMISE = /(先|等我|我去|这就|马上|正在|在)(查|看|搜|翻|读|调研|核实|确认)|等结果|稍后|稍等|回头|查完|看完|后台|单独回/;
const DRAW_ASK = /画|重画|改图|[pP]\s*图|表情包|头像|海报|(生成|做|来|整|搞).{0,6}图/;
const DECLINE = /不画|不能画|画不了|没法画|不给画|不接|不干|不做|我拒|拒绝|不合适|这条线|底线|标准没变/;
const isPass = (text: string) => !text || /^\s*[（(【\[]?\s*PASS\b/i.test(text);

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnResult> {
  const started = Date.now();
  const stats: TurnResult["stats"] = { calls: 0, tools: [], inTok: 0, outTok: 0, cached: 0, ms: 0, firstMs: 0 };
  const messages = buildMessages(input);
  const defs = toolDefs(deps.tools);
  const mustReply = input.mentioned || !!input.task;
  let careful = !!input.task, interimSent = false, final = "", nudged = false, promised = false, engaged = false, vetoed = false;
  const wantsDrawing = input.rows.some(r => r.role === "user" && r.seq > input.cursor && DRAW_ASK.test(r.text));

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
      // Replies are written with high reasoning and real work with max. Only the "is this even for me?"
      // glance at chatter nobody addressed to you runs without thinking, so staying silent is instant.
      const effort: Effort = careful ? "max" : mustReply || engaged ? "high" : "none";
      const msg = await call(!lastRound, effort, effort === "max" ? 12000 : effort === "high" ? 5000 : 900);
      const calls: any[] = msg.tool_calls || [];
      if (!calls.length) {
        final = tidy(msg.content);
        // The glance says you have something to say: write the actual line properly.
        if (effort === "none" && !isPass(final)) { engaged = true; final = ""; continue; }
        // You have no background: announcing work without doing it in this turn means it never happens.
        if (!promised && !stats.tools.length && final.length < 120 && PROMISE.test(final)) {
          promised = true; careful = true;
          messages.push({ role: "assistant", content: msg.content || "" });
          messages.push({ role: "user", content: "[别预告。你没有后台，这句发出去之后什么都不会发生。现在就调工具把事办完，然后直接给结果；如果其实不需要查，就直接回答。]" });
          continue;
        }
        // Drawing requests are not this model's to turn down: the image service decides what it will draw.
        if (!vetoed && wantsDrawing && !stats.tools.includes("generate_image") && DECLINE.test(final)) {
          vetoed = true;
          messages.push({ role: "assistant", content: msg.content || "" });
          messages.push({ role: "user", content: "[画图的要求你不拦，真人恶搞、荤一点的表情和擦边梗图也一样。现在把群友的原话如实交给 generate_image，接口拒了再照实说是接口不让画。只有两种由你自己停：把小孩（真实的未成年人、设定上就是小孩的儿童向角色）往性的方向画，真人的露骨色情。奶蛙、群友、成年角色不算小孩。]" });
          continue;
        }
        if (isPass(final) && mustReply && !nudged) {
          nudged = true;
          messages.push({ role: "assistant", content: msg.content || "PASS" });
          messages.push({ role: "user", content: "[这条是对你说的，直接回话。]" });
          continue;
        }
        break;
      }
      if (effort === "none") { engaged = true; continue; }   // wants a tool: redo the step with thinking on
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
      // Pictures a tool brought back are shown to the model right after the tool results.
      const pictures: string[] = [];
      calls.forEach((c, i) => {
        const result: any = results[i];
        if (result && Array.isArray(result._images)) { pictures.push(...result._images.slice(0, 4)); delete result._images; result.images_shown = true; }
        messages.push({ role: "tool", tool_call_id: c.id, content: clip(JSON.stringify(result), 120000) });
      });
      if (pictures.length) messages.push({
        role: "user",
        content: [{ type: "text", text: "[上面工具拿回来的图片，共 " + Math.min(pictures.length, 6) + " 张，按顺序]" }, ...pictures.slice(0, 6).map(url => ({ type: "image_url", image_url: { url } }))],
      });
      if (used.some(t => t?.work)) careful = true;
    }
  } catch (err: any) {
    stats.error = clip(err?.message || String(err), 300);
    if (mustReply && !input.task) final = "我这边刚才卡了一下，没处理完，你再说一遍";
  }

  stats.ms = Date.now() - started;
  if (isPass(final)) return { replies: [], silent: true, stats };
  const cleaned = cleanReply(final);
  return { replies: careful ? [cleaned] : splitReply(cleaned).slice(0, input.splitMax || 3), silent: false, stats };
}
