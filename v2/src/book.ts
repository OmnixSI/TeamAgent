// A longer production than one picture or one page: an illustrated book. The steps are
//   plan (story, art style, cast) → cover → page illustrations (same references on every page)
//   → layout → PDF + preview strip.
import { dsChat } from "./llm.ts";
import { draw } from "./draw.ts";
import type { Ref } from "./draw.ts";
import { clip } from "./util.ts";
import type { Env } from "./util.ts";

export type BookPlan = {
  title: string; subtitle: string; style: string; ending: string; cover: string;
  cast: { name: string; look: string }[];
  pages: { text: string; art: string }[];
};

const AUTHOR = `你是绘本作者兼美术指导，给一个三人熟人群写一本带插图的小书。群里说话荤素不忌、互相损，书可以按这个调性来。

先想清楚：这本书讲什么、笑点或情绪落在哪、怎么起头怎么收尾。然后写出来。

要求：
- 故事有起承转合，用具体的人、具体的事、具体的梗，不写空话和鸡汤。群里真实的人和事优先用上。
- 每一页一个清楚的画面：谁、在哪、在干什么、什么表情。画面之间有变化（场景、景别、情绪），不要每页都是站着说话。
- 正文是中文，每页 30 到 80 个字，读起来像绘本，不像说明书。
- 人物外貌写进 cast，够具体，保证每一页都能画成同一个样子。有参考图的角色照参考图写。
- 插图里不出现任何文字，文字由排版来放。
- 插图描述用英文写。

只输出一个 JSON 对象：
{"title":"书名","subtitle":"副标题或一句话简介","style":"整本书统一的画风，英文一句话：媒介、线条、配色、光线","cast":[{"name":"角色名","look":"英文外貌描述"}],"cover":"封面插图的英文描述","pages":[{"text":"这一页的正文","art":"这一页插图的英文描述"}],"ending":"封底的一句话"}`;

export async function planBook(env: Env, input: { brief: string; pages: number; memory: string; context: string; refs: Ref[]; style?: string; extra?: string }): Promise<BookPlan> {
  const text = "【要做的书】\n" + input.brief + "\n\n【正文页数】" + input.pages + (input.style ? "\n\n【指定的画风】" + input.style : "") +
    "\n\n【群里的人和事（Bot 的记忆）】\n" + clip(input.memory, 3500) + "\n\n【最近的聊天】\n" + clip(input.context, 2500) +
    (input.refs.length ? "\n\n【角色参考图】按顺序是：" + input.refs.map(r => r.label).join("、") + "。cast 里这些角色的 look 照图写。" : "") +
    (input.extra ? "\n\n【群里对画图的额外要求】\n" + input.extra : "");
  const dataUrl = (r: Ref) => { let s = ""; for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000)); return "data:" + r.mime + ";base64," + btoa(s); };
  const r = await dsChat(env, {
    messages: [
      { role: "system", content: AUTHOR },
      { role: "user", content: input.refs.length ? [{ type: "text", text }, ...input.refs.map(ref => ({ type: "image_url", image_url: { url: dataUrl(ref) } }))] : text },
    ],
    max_tokens: 16000, label: "做书构思",
  }, "max", 240000);
  const raw = String(r.message.content || ""), d = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  if (!Array.isArray(d.pages) || d.pages.length < 2) throw new Error("没写出像样的分页");
  return {
    title: clip(d.title || "无题", 40), subtitle: clip(d.subtitle || "", 80), style: clip(d.style || "warm picture-book illustration", 400),
    ending: clip(d.ending || "完", 80), cover: clip(d.cover || d.pages[0].art, 900),
    cast: (Array.isArray(d.cast) ? d.cast : []).slice(0, 8).map((c: any) => ({ name: clip(c.name, 30), look: clip(c.look, 400) })),
    pages: d.pages.slice(0, input.pages).map((p: any) => ({ text: clip(p.text, 220), art: clip(p.art, 900) })),
  };
}

const artPrompt = (plan: BookPlan, art: string, cover: boolean) =>
  plan.style + ". " + art + "\nCharacters (keep them identical on every page): " + plan.cast.map(c => c.name + " — " + c.look).join("; ") +
  "\nFull-bleed picture-book illustration. Absolutely no text, letters, captions or speech bubbles in the image. " +
  (cover ? "Composition for a book cover: main characters prominent, calm area in the upper third for a title." : "Keep the bottom quarter of the frame calm and uncluttered; a caption will be laid over it.");

/** Draws the cover first, then every page with the same references plus the cover, a few at a time. */
export async function illustrate(env: Env, plan: BookPlan, refs: Ref[], quality: string, progress?: (done: number, total: number) => void) {
  const size = "1536x1024", total = plan.pages.length + 1;
  const one = async (art: string, cover: boolean, using: Ref[]): Promise<Uint8Array | null> => {
    for (const softer of [false, true]) {
      try {
        return await draw(env, { prompt: artPrompt(plan, art, cover) + (softer ? "\nKeep it playful and tame: cartoon exaggeration, nothing explicit or gory." : ""), size, quality, idea: "", use: [] }, using.slice(0, 4));
      } catch (e: any) { if (!e?.blocked) throw e; }
    }
    return null;
  };
  const cover = await one(plan.cover, true, refs);
  progress?.(1, total);
  const shared: Ref[] = cover ? [...refs.slice(0, 3), { label: "cover", bytes: cover, mime: "image/jpeg" }] : refs;
  const images: (Uint8Array | null)[] = new Array(plan.pages.length).fill(null);
  let next = 0, done = 1;
  await Promise.all([0, 1, 2, 3].map(async () => {
    for (;;) {
      const i = next++; if (i >= plan.pages.length) return;
      images[i] = await one(plan.pages[i].art, false, shared).catch(() => null);
      progress?.(++done, total);
    }
  }));
  return { cover, images };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/** One landscape page per spread: full-bleed illustration with the text on a paper band along the bottom. */
export function bookHtml(plan: BookPlan, cover: Uint8Array | null, images: (Uint8Array | null)[], byline: string, zoom = 1) {
  const img = (b: Uint8Array | null) => b ? `<img src="data:image/jpeg;base64,${b64(b)}">` : `<div class="blank"></div>`;
  const pages = plan.pages.map((p, i) => `
    <section class="page">${img(images[i])}
      <div class="band"><p>${esc(p.text)}</p><span class="no">${i + 1}</span></div>
    </section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:1200px 800px;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0;background:#1d1a16}
    body{zoom:${zoom};font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC","Noto Sans CJK SC",serif;color:#2a251e}
    .page{position:relative;width:1200px;height:800px;overflow:hidden;page-break-after:always;break-after:page;background:#f3ead8}
    .page img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .blank{position:absolute;inset:0;background:repeating-linear-gradient(45deg,#efe4cd,#efe4cd 24px,#eadfc6 24px,#eadfc6 48px)}
    .band{position:absolute;left:0;right:0;bottom:0;padding:26px 84px 30px 64px;background:linear-gradient(to top,rgba(250,244,230,.97) 0,rgba(250,244,230,.93) 72%,rgba(250,244,230,0) 100%);padding-top:64px}
    .band p{margin:0;font-size:29px;line-height:1.62;letter-spacing:.5px;text-align:justify}
    .no{position:absolute;right:34px;bottom:26px;font:600 17px "Noto Sans CJK SC",sans-serif;color:#8a7d66}
    .cover .shade{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(20,16,10,.74) 0,rgba(20,16,10,.28) 38%,rgba(20,16,10,0) 60%)}
    .cover .title{position:absolute;left:70px;right:70px;top:64px;color:#fff8e8;text-shadow:0 3px 18px rgba(0,0,0,.55)}
    .cover h1{margin:0;font:900 84px/1.12 "Noto Sans CJK SC","PingFang SC",sans-serif;letter-spacing:4px}
    .cover h2{margin:16px 0 0;font:500 28px/1.4 "Noto Sans CJK SC",sans-serif;opacity:.94}
    .cover .by{position:absolute;left:70px;bottom:44px;font:500 20px "Noto Sans CJK SC",sans-serif;color:#fff8e8;text-shadow:0 2px 10px rgba(0,0,0,.6)}
    .end{display:flex;flex-direction:column;align-items:center;justify-content:center;background:#2a251e;color:#f3ead8;text-align:center;padding:0 140px}
    .end p{font-size:36px;line-height:1.7;margin:0 0 34px}.end small{font:500 18px "Noto Sans CJK SC",sans-serif;color:#b3a688}
  </style></head><body>
    <section class="page cover">${img(cover)}<div class="shade"></div>
      <div class="title"><h1>${esc(plan.title)}</h1>${plan.subtitle ? `<h2>${esc(plan.subtitle)}</h2>` : ""}</div><div class="by">${esc(byline)}</div></section>
    ${pages}
    <section class="page end"><p>${esc(plan.ending)}</p><small>${esc(plan.title)} · ${esc(byline)}</small></section>
  </body></html>`;
}
