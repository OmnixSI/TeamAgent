// Nightly consolidation: turn the day's chat into durable memory, lessons and a short summary.
import { dsChat } from "./llm.ts";
import type { Env } from "./util.ts";

const SYSTEM = `你在替 QQ 群里的常驻群友 Bot 做每晚的整理。输入有三样：它现有的长期记忆、白天随手记下的条目、这段时间的群聊记录（“Bot(你)”是它自己说的话）。

输出两部分，严格按下面的分隔行，不要多写别的：

===记忆===
完整的新版长期记忆，直接替换旧版。分节写：
【群友】每人一段：昵称和别名、在做什么、说话风格、偏好、雷点。
【项目】每个项目的现状、已经定下的事（带日期）、仓库名和大家怎么称呼它。
【梗和黑话】群里的专属说法是什么意思、怎么来的。
【大家对我的要求】立过的规矩、被纠正过的地方，写成可以照做的句子。
【我的教训】哪里翻车、被骂、让人失望了，下次具体怎么做。只留仍然有用的。
【惦记的事】答应了没做完的、别人说之后要做的、值得之后问一句的。做完或过期的删掉。
要求：只写记录里有依据的事，拿不准就不写；旧记忆里仍然成立的要保留；开玩笑的话不要当成事实或规矩。全文不超过 2400 字。

===小结===
这段时间群聊的小结，200 字以内，口语：聊了什么，定了什么，谁要去干什么。`;

export async function reflect(env: Env, input: { memory: string; notes: string[]; transcript: string; label: string }) {
  const messages = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: "【现有长期记忆】\n" + (input.memory.trim() || "（空）") +
        "\n\n【白天记下的条目】\n" + (input.notes.length ? input.notes.map(n => "· " + n).join("\n") : "（无）") +
        "\n\n【群聊记录：" + input.label + "】\n" + input.transcript,
    },
  ];
  let last = "";
  // Reasoning shares the output budget, so the first attempt can come back empty; retry with less thinking.
  for (const effort of ["max", "high"] as const) {
    const r = await dsChat(env, { messages, max_tokens: 24000 }, effort, 280000);
    const text = String(r.message.content || "");
    const cut = text.split(/={2,}\s*小结\s*={2,}/);
    const memory = cut[0].replace(/^[\s\S]*?={2,}\s*记忆\s*={2,}/, "").trim();
    const summary = (cut[1] || "").trim();
    if (memory.length >= 200 && memory.includes("【")) return { memory, summary, usage: r.usage };
    last = text.slice(0, 200);
  }
  throw new Error("reflect produced no memory: " + last);
}

export async function caption(env: Env, dataUrl: string) {
  const r = await dsChat(env, {
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: "用一句话说清这张图（50 字以内）：是什么、有什么梗；图里有字就把关键的字抄上。只输出这句话。" },
      ],
    }],
    max_tokens: 200,
  }, "none", 30000);
  return String(r.message.content || "").trim().slice(0, 160);
}
