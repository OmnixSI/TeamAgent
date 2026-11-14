// Image generation in two steps: an art-director pass decides what the picture should be and writes
// the prompt, then the image model draws it. Reference images are passed to both.
import { dsChat, dsJson } from "./llm.ts";
import { clip, unb64 } from "./util.ts";
import type { Env } from "./util.ts";

export type Ref = { label: string; bytes: Uint8Array; mime: string; found?: boolean };
export type Design = { prompt: string; size: string; quality: string; idea: string; use: number[] };

const DIRECTOR = `你是给图像模型写提示词的美术指导。群友在 QQ 群里让常驻群友 Bot 画图，你来决定这张图到底画什么、怎么画最好，然后写出交给图像模型的提示词。

先想清楚（不用写出来）：
1. 他真正想要什么：是玩梗、表情包、头像、海报、示意图，还是认真的插画？给谁看？笑点或重点在哪？结合聊天上下文，选最贴切、最有意思的那种理解，不要选最保守的。
2. 画面：主体是谁、在干什么、表情和姿态；场景；构图和景别；谁在前谁在后。
3. 风格和媒介：贴纸、扁平插画、厚涂、像素、胶片照片、3D 渲染、水墨……选最适合这个用途的，不要默认“卡通”。
4. 光线、配色、氛围。
5. 图里要不要有字：要的话写清每一处文字的原文、位置、字体感觉；中文必须逐字给出并加引号；没必要就明确写不要文字。
6. 有参考图时：说清楚哪些必须保持不变（角色长相、配色、比例、画风），哪些要改。要修改某张图就只改被要求的部分。
7. 尺寸：头像、表情包用方形；人物立绘、手机壁纸、海报用竖版；风景、横幅、多人场景用横版。
8. 质量：随手玩梗用 low；一般用 medium；字多、细节多、要拿去用的用 high。

提示词要求：具体、可画，写成连贯的描述，80 到 220 个词；用英文写画面，图中出现的中文文字保留原文；不写“高质量、杰作”这类空话；不写画不出来的抽象概念；群友和 Bot 的形象按记忆里的设定来。

9. 参考图里标着“网上找到的”那些，是为了让你知道要画的对象长什么样。先看清它的真实外观（颜色、体型、五官、材质），提示词里照着写；其中确实是这个对象的，把序号写进 use_refs，画的时候会一起交给图像模型保持长相；不相关的、带水印的、是别的东西的，不要选。群友给的参考图一定会用，不用写。

只输出一个 JSON 对象：
{"idea":"一句中文，说这张图画的是什么","prompt":"给图像模型的提示词","size":"square|portrait|landscape","quality":"low|medium|high","use_refs":[0]}`;

const SCOUT = `你是美术指导的前期调研。读群友的要求和聊天上下文，先弄明白他到底要什么，再列出画之前必须看到的参考。

判断三件事：
1. 意图：一句话说清这张图给谁、干什么用、重点或笑点在哪、指的是哪个人或哪个东西。聊天里的代称、梗、上文提到的东西要还原成具体所指。
2. 已保存的形象里（名单会给你）哪些跟这张图有关，就列出来；画 Bot 自己时用它的形象。
3. 画面里还有哪些对象必须知道真实长相才能画对：具体的角色、梗图形象、游戏或动漫人物、真人、产品、地标、某个作品的画风。给每个写一个搜索词，越具体越好，带上出处（如“鸣潮 菲比 立绘”“奶蛙 表情包”）。最多 3 个。猫、办公室、键盘这类谁都知道长什么样的不用查。拿不准长什么样的一律查，不要凭印象。

只输出一个 JSON 对象：{"intent":"…","use_saved":["名字"],"look_up":["搜索词"]}`;

/** Step one of every drawing: work out what is really being asked and what must be looked at first. */
export async function scout(env: Env, input: { request: string; context: string; memory: string; saved: string[]; extra?: string }) {
  const empty = { intent: "", use_saved: [] as string[], look_up: [] as string[] };
  try {
    const r = await dsChat(env, {
      messages: [
        { role: "system", content: SCOUT + (input.extra ? "\n\n【群里对画图的额外要求】\n" + input.extra : "") },
        { role: "user", content: "【群友的要求】\n" + input.request + "\n\n【最近的聊天】\n" + clip(input.context, 3000) + "\n\n【Bot 记得的事】\n" + clip(input.memory, 2500) + "\n\n【已保存的形象】" + (input.saved.join("、") || "（无）") },
      ],
      max_tokens: 3000,
    }, "high", 45000);
    const raw = String(r.message.content || ""), d = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      intent: clip(d.intent || "", 300),
      use_saved: (Array.isArray(d.use_saved) ? d.use_saved : []).map(String).filter((n: string) => input.saved.includes(n)).slice(0, 3),
      look_up: (Array.isArray(d.look_up) ? d.look_up : []).map(String).filter(Boolean).slice(0, 3),
    };
  } catch { return empty; }
}

const SIZES: Record<string, string> = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };
const dataUrl = (r: Ref) => {
  let s = "";
  for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
  return "data:" + r.mime + ";base64," + btoa(s);
};

export async function design(env: Env, input: { request: string; intent?: string; context: string; memory: string; refs: Ref[]; size?: string; quality?: string; extra?: string; defaultQuality?: string }): Promise<Design> {
  const text = "【群友的要求】\n" + input.request + (input.intent ? "\n\n【调研后对意图的理解】\n" + input.intent : "") +
    "\n\n【最近的聊天】\n" + clip(input.context, 3000) +
    "\n\n【Bot 记得的事（人物、梗、形象设定）】\n" + clip(input.memory, 2500) +
    (input.refs.length ? "\n\n【参考图】共 " + input.refs.length + " 张，按顺序是：" + input.refs.map((r, i) => i + " = " + (r.found ? "网上找到的 " : "群友给的 ") + r.label).join("；") : "");
  const given = input.refs.map((r, i) => (r.found ? -1 : i)).filter(i => i >= 0);
  const fallback: Design = { prompt: input.request, size: SIZES[input.size || "square"] || SIZES.square, quality: input.quality || "medium", idea: clip(input.request, 60), use: given };
  try {
    const r = await dsChat(env, {
      messages: [
        { role: "system", content: DIRECTOR + (input.extra ? "\n\n【群里对画图的额外要求】\n" + input.extra : "") },
        { role: "user", content: input.refs.length ? [{ type: "text", text }, ...input.refs.map(ref => ({ type: "image_url", image_url: { url: dataUrl(ref) } }))] : text },
      ],
      max_tokens: 12000,
    }, "max", 120000);
    const raw = String(r.message.content || ""), json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const d = JSON.parse(json);
    if (typeof d.prompt !== "string" || d.prompt.length < 20) return fallback;
    return {
      prompt: d.prompt.slice(0, 4000), idea: clip(d.idea || input.request, 80),
      use: [...new Set([...given, ...(Array.isArray(d.use_refs) ? d.use_refs : []).map(Number).filter((i: number) => Number.isInteger(i) && i >= 0 && i < input.refs.length)])].slice(0, 4),
      size: SIZES[input.size || ""] || SIZES[d.size] || SIZES.square,
      quality: ["low", "medium", "high"].includes(input.quality || "") ? input.quality! : ["low", "medium", "high"].includes(d.quality) ? d.quality : input.defaultQuality || "medium",
    };
  } catch { return fallback; }
}

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Looks up what something really looks like: search the web, collect pictures from the top pages. */
export async function findImages(env: Env, query: string, want = 3): Promise<Ref[]> {
  const r = await dsJson(env, "/v1/tools/search", { query: (query + " 图片").slice(0, 120), count: 8, need_content: false }, 20000);
  if (!r.ok) return [];
  const results: any[] = ((await r.json()) as any).results || [];
  const words = query.split(/\s+/).filter(w => w.length > 1);
  const candidates: string[] = [];
  await Promise.all(results.slice(0, 5).map(async x => {
    try {
      const url = String(x.url || "").split("#")[0];
      const gh = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/?]+)/);
      if (gh) {
        const tree: any = await fetch("https://api.github.com/repos/" + gh[1] + "/" + gh[2] + "/git/trees/HEAD?recursive=1", {
          headers: { "User-Agent": "teamagent", ...(env.GITHUB_TOKEN ? { Authorization: "Bearer " + env.GITHUB_TOKEN } : {}) }, signal: AbortSignal.timeout(10000),
        }).then(t => t.json());
        const files = (tree.tree || []).filter((f: any) => f.type === "blob" && /\.(png|jpe?g|webp)$/i.test(f.path) && f.size > 25000 && f.size < 900000);
        const ranked = files.sort((a: any, b: any) => Number(words.some(w => b.path.includes(w))) - Number(words.some(w => a.path.includes(w))) || a.size - b.size);
        for (const f of ranked.slice(0, 3)) candidates.push("https://raw.githubusercontent.com/" + gh[1] + "/" + gh[2] + "/HEAD/" + f.path.split("/").map(encodeURIComponent).join("/"));
        return;
      }
      const html = await fetch(url, { headers: { "User-Agent": BROWSER }, signal: AbortSignal.timeout(9000) }).then(t => t.text());
      const found = [
        ...[...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/gi)].map(m => m[1]),
        ...[...html.matchAll(/<img[^>]+(?:data-src|data-original|src)=["']([^"']+\.(?:png|jpe?g|webp)[^"']*)["']/gi)].map(m => m[1]),
      ].map(u => { try { return new URL(u.replace(/&amp;/g, "&"), url).href; } catch { return ""; } })
        .filter(u => u && !/logo|icon|avatar|sprite|badge|qrcode|emoji\//i.test(u));
      candidates.push(...found.slice(0, 3));
    } catch {}
  }));
  const refs: Ref[] = [];
  for (const u of [...new Set(candidates)].slice(0, 10)) {
    if (refs.length >= want) break;
    try {
      const res = await fetch(u, { headers: { "User-Agent": BROWSER, Referer: new URL(u).origin + "/" }, signal: AbortSignal.timeout(9000) });
      const mime = (res.headers.get("content-type") || "").split(";")[0];
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.ok && /^image\/(png|jpeg|webp)$/.test(mime) && bytes.length > 15000 && bytes.length < 4_000_000) refs.push({ label: decodeURIComponent(u.split("/").pop() || "").slice(0, 40), bytes, mime, found: true });
    } catch {}
  }
  return refs;
}

/** Draws from text alone, or from text plus reference images (edit / keep-the-character). */
export async function draw(env: Env, d: Design, refs: Ref[]) {
  if (!env.OPENAI_API_KEY) throw new Error("没有配置 OpenAI 密钥");
  const model = env.IMAGE_MODEL || "gpt-image-2.5-flare";
  let r: Response;
  if (refs.length) {
    const form = new FormData();
    form.append("model", model); form.append("prompt", d.prompt); form.append("size", d.size); form.append("quality", d.quality); form.append("output_format", "jpeg");
    refs.slice(0, 4).forEach((ref, i) => form.append("image[]", new Blob([ref.bytes], { type: ref.mime }), "ref" + i + "." + (ref.mime.split("/")[1] || "jpg")));
    r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, body: form, signal: AbortSignal.timeout(170000) });
  } else {
    r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: d.prompt, size: d.size, quality: d.quality, output_format: "jpeg", n: 1 }), signal: AbortSignal.timeout(170000),
    });
  }
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data.data?.[0]?.b64_json) {
    throw new Error(/safety|moderation/i.test(data.error?.code + " " + data.error?.message)
      ? "内容被图像模型的安全策略拒绝"
      : "图像模型返回错误（" + r.status + "）" + (data.error?.message ? "：" + clip(data.error.message, 120) : ""));
  }
  return unb64(data.data[0].b64_json);
}

/** Python in OpenAI's hosted sandbox: computes, plots, converts, and hands back the files it wrote. */
const SANDBOX = `你在一个 Python 沙箱里替 QQ 群里的 Bot 干活。用 python 工具真的把代码跑出来，不要心算，不要只给代码。
输入文件在 /mnt/data 下。要交付的文件（图表、表格、文档）写到 /mnt/data，并在回答里提到文件名。文件名用英文或拼音。

中文必须能正常显示，沙箱里有字体，但要自己指定：
- matplotlib / seaborn：每次画图前先执行
  import matplotlib; matplotlib.rcParams["font.sans-serif"] = ["Noto Sans CJK JP", "AR PL UMing CN", "DejaVu Sans"]; matplotlib.rcParams["font.family"] = "sans-serif"; matplotlib.rcParams["axes.unicode_minus"] = False
  （"Noto Sans CJK JP" 这个名字的字体包含完整的简体中文字形。）
- PIL、词云：字体文件用 /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc。
- reportlab 生成 PDF：pdfmetrics.registerFont(TTFont("CN", "/usr/share/fonts/truetype/arphic-gbsn00lp/gbsn00lp.ttf"))，所有文字用这个字体。
- Excel、Word、PPT 里的中文直接写，不需要特别处理。
图表做完后自己检查一遍：标题、坐标轴、图例里的中文不能是方块。图要清楚好看：dpi 至少 160，标题说人话，数字标在柱子或点上。

如果给了 chat.csv，它是群聊记录，列是 time（北京时间）、name、text，一行一条消息；要统计字数、时段、关键词就老老实实按它算，不要估算。
最后用中文说清：结果是什么、关键数字、生成了哪些文件。出错就照实说错在哪。`;

export async function runPython(env: Env & { CODE_MODEL?: string }, task: string, inputs: { name: string; bytes: Uint8Array }[], extra = "") {
  if (!env.OPENAI_API_KEY) throw new Error("没有配置 OpenAI 密钥");
  const auth = { Authorization: "Bearer " + env.OPENAI_API_KEY };
  const fileIds: string[] = [];
  for (const f of inputs.slice(0, 6)) {
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", new Blob([f.bytes]), f.name);
    const up: any = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: auth, body: form, signal: AbortSignal.timeout(60000) }).then(x => x.json());
    if (up.id) fileIds.push(up.id);
  }
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.CODE_MODEL || "gpt-5.4-mini",
      tools: [{ type: "code_interpreter", container: { type: "auto", ...(fileIds.length ? { file_ids: fileIds } : {}) } }],
      instructions: SANDBOX + (extra ? "\n\n【群里对这类活的额外要求】\n" + extra : ""),
      input: task,
    }),
    signal: AbortSignal.timeout(280000),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("代码沙箱返回错误（" + r.status + "）" + (d.error?.message ? "：" + clip(d.error.message, 160) : ""));
  const messages = (d.output || []).filter((o: any) => o.type === "message");
  const text = messages.flatMap((m: any) => m.content.map((c: any) => c.text || "")).join("\n").replace(/\[([^\]]+)\]\(sandbox:[^)]+\)/g, "$1").trim();
  const cites = messages.flatMap((m: any) => m.content.flatMap((c: any) => c.annotations || [])).filter((a: any) => a.type === "container_file_citation");
  const files: { name: string; bytes: Uint8Array }[] = [], seen = new Set<string>();
  for (const a of cites) {
    if (seen.has(a.file_id) || files.length >= 6) continue;
    seen.add(a.file_id);
    const f = await fetch("https://api.openai.com/v1/containers/" + a.container_id + "/files/" + a.file_id + "/content", { headers: auth, signal: AbortSignal.timeout(60000) });
    if (!f.ok) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length && bytes.length <= 20 * 1024 * 1024) files.push({ name: String(a.filename || "file"), bytes });
  }
  const code = (d.output || []).filter((o: any) => o.type === "code_interpreter_call").map((o: any) => o.code || "").join("\n# ----\n");
  return { text, files, code: clip(code, 3000) };
}
