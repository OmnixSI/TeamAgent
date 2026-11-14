// Image generation. The chat model says what is wanted and which things must be looked at first; an
// art-director pass (max reasoning, sees every reference picture) decides the picture and writes the
// prompt; then the image model draws it. Reference pictures are passed to both.
import { dsChat, dsJson } from "./llm.ts";
import { PRICE, meter } from "./meter.ts";
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
7. 尺寸：写成“宽x高”。群友没提要求时用平常规格：头像、表情包 1024x1024；人物立绘、手机壁纸、海报 1024x1536；风景、横幅、多人场景 1536x1024。群友提了尺寸、比例或清晰度就照他说的给：2K 方图 2048x2048，2K 横图 2048x1152，4K 横图 3840x2160，4K 竖图 2160x3840；说了具体分辨率或比例（1920x1080、16:9、21:9、手机壁纸 9:16……）就换算成具体的宽和高。规则：宽高都是 16 的倍数，最长边不超过 3840，长宽比不超过 3:1，总像素在 65 万到 829 万之间。
8. 质量：随手玩梗用 low；一般用 medium；字多、细节多、要拿去用的，或者群友要高清、2K、4K、最好的画质，用 high。

尺度：这是熟人私群里的玩笑图，不会外传。荤一点的表情（脸红、翻白眼、吐舌头这类 ahegao 表情包）画在奶蛙、群友、成年角色身上是正常的梗，照原样写进提示词。按群友的原意画，恶搞、损人、荤一点、离谱一点都照画，不要替他们把要求改温和。画的是真人（群友本人、明星、网红、公众人物）也照画：照着参考图保持本人的长相特征，不要换成认不出是谁的形象来回避，也不要在 idea 里加道德评价。只在一种情况下换个画法：照原样写图像模型一定会拒（露骨的性内容、血腥到写实），这时保留原来的梗和冲突，换成它能画的表现手法（夸张、卡通化、暗示、借位），并在 idea 里说明换了什么。

提示词要求：具体、可画，写成连贯的描述，80 到 220 个词；用英文写画面，图中出现的中文文字保留原文；不写“高质量、杰作”这类空话；不写画不出来的抽象概念；群友和 Bot 的形象按记忆里的设定来。

9. 参考图里标着“网上找到的”那些，是为了让你知道要画的对象长什么样。先看清它的真实外观（颜色、体型、五官、材质），提示词里照着写；其中确实是这个对象的，把序号写进 use_refs，画的时候会一起交给图像模型保持长相；不相关的、带水印的、是别的东西的，不要选。群友给的参考图一定会用，不用写。

只输出一个 JSON 对象：
{"idea":"一句中文，说这张图画的是什么","prompt":"给图像模型的提示词","size":"1024x1024","quality":"low|medium|high","use_refs":[0]}`;

const SIZES: Record<string, string> = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };
/** Turns whatever came back ("3840x2160", "landscape", "4k") into a size the image API accepts. */
export function fitSize(raw: unknown): string {
  const text = String(raw || "").toLowerCase().replace(/[×*]/g, "x").trim();
  if (SIZES[text]) return SIZES[text];
  const m = text.match(/(\d{3,4})\s*x\s*(\d{3,4})/), ratio = text.match(/(\d{1,2})\s*[:：/]\s*(\d{1,2})/);
  if (!m && !ratio) return /4k/.test(text) ? "3840x2160" : /2k/.test(text) ? "2048x2048" : SIZES.square;
  // A bare ratio becomes a normal-sized picture of that shape.
  let w = m ? Number(m[1]) : Math.sqrt(1_400_000 * Number(ratio![1]) / Number(ratio![2])), h = m ? Number(m[2]) : w * Number(ratio![2]) / Number(ratio![1]);
  const scale = Math.min(1, 3840 / Math.max(w, h), Math.sqrt(8_294_400 / (w * h)));
  w *= scale; h *= scale;
  const grow = Math.sqrt(655_360 / (w * h));
  if (grow > 1) { w *= grow; h *= grow; }
  if (w / h > 3) h = w / 3; else if (h / w > 3) w = h / 3;
  const snap = (n: number) => Math.max(256, Math.min(3840, Math.round(n / 16) * 16));
  let W = snap(w), H = snap(h);
  // Rounding to multiples of 16 can step back over a limit; nudge one side a step at a time until all three hold.
  for (let i = 0; i < 400; i++) {
    const wide = W >= H;
    if (W > 3 * H) H += 16; else if (H > 3 * W) W += 16;
    else if (W * H < 655_360) { if (wide && W + 16 <= 3840) W += 16; else H += 16; }
    else if (W * H > 8_294_400) { if (wide) W -= 16; else H -= 16; }
    else break;
  }
  return W + "x" + H;
}
const dataUrl = (r: Ref) => {
  let s = "";
  for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
  return "data:" + r.mime + ";base64," + btoa(s);
};

export async function design(env: Env, input: { request: string; intent?: string; context: string; memory: string; refs: Ref[]; size?: string; quality?: string; extra?: string; defaultQuality?: string; members?: string[]; rejected?: { idea: string; prompt: string; reason: string }[]; earlier?: { label: string; idea: string; prompt: string }[] }): Promise<Design> {
  const text = "【群友的要求】\n" + input.request + (input.intent ? "\n\n【Bot 对这张图的理解（它看得到全天的聊天）】\n" + input.intent : "") +
    (input.earlier?.length ? "\n\n【参考图里有 Bot 以前画的，当初的提示词如下。群友要的是在它上面改：没被要求改的部分照原样保留，沿用原提示词的写法】\n" + input.earlier.map(e => e.label + "（" + e.idea + "）：" + clip(e.prompt, 1500)).join("\n\n") : "") +
    (input.size || input.quality ? "\n\n【群友对尺寸和清晰度的要求】" + [input.size, input.quality].filter(Boolean).join("；") + "（照这个定 size 和 quality）" : "") +
    "\n\n【最近的聊天】\n" + clip(input.context, 3000) +
    "\n\n【Bot 记得的事（人物、梗、形象设定）】\n" + clip(input.memory, 2500) +
    (input.members?.length ? "\n\n【群友的昵称】" + input.members.join("、") + "。他们是群里的真人：有他们的照片或保存的形象就照着画；没有的话按记忆里对这个人的描述画一个普通人，不要凭昵称的字面意思编成别的东西（比如把“卡特龙”画成龙或机甲）。" : "") +
    (input.rejected?.length
      ? "\n\n【前面的画法被图像接口拒了】\n" + input.rejected.map((r, i) => "第 " + (i + 1) + " 版：" + r.idea + "\n提示词：" + clip(r.prompt, 700) + "\n接口给的原因：" + (r.reason || "没说")).join("\n\n") +
        "\n\n这次的任务：保留同一个梗、同样的人物和关系，画出接口能接受的、离原意最近的一版，不要退回成一张无关痛痒的图。按这个顺序让步，能少让就少让：" +
        "先换表现手法（动作发生前或发生后的瞬间、借位、遮挡、镜头给到旁人的反应、夸张的卡通化），再把动作本身换成最接近的（比如凑近、亲、捧着、伺候），" +
        "最后才动人物（把真人画成一眼认得出是谁的漫画形象）。" +
        (input.rejected.length >= 2 ? "已经被拒两次了，这一版要明显更稳：不用网上找来的真人照片当参考（use_refs 里不要选它们），人物漫画化。" : "") +
        "idea 里用一句话说清这一版和原要求差在哪。"
      : "") +
    (input.refs.length ? "\n\n【参考图】共 " + input.refs.length + " 张，按顺序是：" + input.refs.map((r, i) => i + " = " + (r.found ? "网上找到的 " : "群友给的 ") + r.label).join("；") : "");
  const given = input.refs.map((r, i) => (r.found ? -1 : i)).filter(i => i >= 0);
  const fallback: Design = { prompt: input.request, size: fitSize(input.size), quality: input.quality || input.defaultQuality || "medium", idea: clip(input.request, 60), use: given };
  try {
    const r = await dsChat(env, {
      messages: [
        { role: "system", content: DIRECTOR + (input.extra ? "\n\n【群里对画图的额外要求】\n" + input.extra : "") },
        { role: "user", content: input.refs.length ? [{ type: "text", text }, ...input.refs.map(ref => ({ type: "image_url", image_url: { url: dataUrl(ref) } }))] : text },
      ],
      max_tokens: 12000, label: "画图构思",
    }, "max", 120000);
    const raw = String(r.message.content || ""), json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const d = JSON.parse(json);
    if (typeof d.prompt !== "string" || d.prompt.length < 20) return fallback;
    return {
      prompt: d.prompt.slice(0, 4000), idea: clip(d.idea || input.request, 80),
      use: [...new Set([...given, ...(Array.isArray(d.use_refs) ? d.use_refs : []).map(Number).filter((i: number) => Number.isInteger(i) && i >= 0 && i < input.refs.length)])].slice(0, 4),
      size: fitSize(d.size || input.size),
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
  const [pw, ph] = d.size.split("x").map(Number), big = pw * ph > 2_500_000;
  let r: Response;
  if (refs.length) {
    const form = new FormData();
    form.append("model", model); form.append("prompt", d.prompt); form.append("size", d.size); form.append("quality", d.quality); form.append("output_format", "jpeg");
    refs.slice(0, 4).forEach((ref, i) => form.append("image[]", new Blob([ref.bytes], { type: ref.mime }), "ref" + i + "." + (ref.mime.split("/")[1] || "jpg")));
    r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, body: form, signal: AbortSignal.timeout(big ? 290000 : 170000) });
  } else {
    r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: d.prompt, size: d.size, quality: d.quality, output_format: "jpeg", n: 1 }), signal: AbortSignal.timeout(big ? 290000 : 170000),
    });
  }
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data.data?.[0]?.b64_json) {
    const blocked = /safety|moderation|policy/i.test(data.error?.code + " " + data.error?.message);
    throw Object.assign(new Error(blocked
      ? "内容被图像模型的安全策略拒绝"
      : "图像模型返回错误（" + r.status + "）" + (data.error?.message ? "：" + clip(data.error.message, 120) : "")),
    { blocked, detail: clip(data.error?.message || "", 300) });
  }
  const u = data.usage || {}, det = u.input_tokens_details || {};
  const imageIn = Number(det.image_tokens || 0), textIn = Number(det.text_tokens ?? Math.max(0, Number(u.input_tokens || 0) - imageIn)), out = Number(u.output_tokens || 0);
  meter({ provider: "openai", item: refs.length ? "改图/带参考图画图" : "画图", inTok: textIn + imageIn, outTok: out, units: 1, unit: "张",
    usd: textIn * PRICE.image.textIn + imageIn * PRICE.image.imageIn + out * PRICE.image.imageOut });
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

/**
 * `reuse` is a sandbox that is still inside its paid 20-minute session; runs without input files go into it
 * instead of opening (and paying for) a new one. Returns the sandbox used so the caller can remember it.
 */
export async function runPython(env: Env & { CODE_MODEL?: string }, task: string, inputs: { name: string; bytes: Uint8Array }[], extra = "", reuse = "") {
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
  const ask = (container: any) => fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.CODE_MODEL || "gpt-6-luna",
      tools: [{ type: "code_interpreter", container }],
      instructions: SANDBOX + (extra ? "\n\n【群里对这类活的额外要求】\n" + extra : ""),
      input: task,
    }),
    signal: AbortSignal.timeout(280000),
  });
  const fresh = { type: "auto", ...(fileIds.length ? { file_ids: fileIds } : {}) };
  let opened = !(reuse && !fileIds.length);
  let r = await ask(opened ? fresh : reuse);
  if (!r.ok && !opened) { opened = true; r = await ask(fresh); }   // the old sandbox had expired
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("代码沙箱返回错误（" + r.status + "）" + (d.error?.message ? "：" + clip(d.error.message, 160) : ""));
  const cu = d.usage || {}, cachedIn = Number(cu.input_tokens_details?.cached_tokens || 0);
  meter({ provider: "openai", item: "跑代码", inTok: Number(cu.input_tokens || 0), cachedTok: cachedIn, outTok: Number(cu.output_tokens || 0), units: 1, unit: "次",
    usd: Math.max(0, Number(cu.input_tokens || 0) - cachedIn) * PRICE.code.in + cachedIn * PRICE.code.cached + Number(cu.output_tokens || 0) * PRICE.code.out + (opened ? PRICE.code.container : 0) });
  const container = String((d.output || []).find((o: any) => o.container_id)?.container_id || "");
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
  // The sandbox also cites inline previews under generated ids; when real files were written, those are duplicates.
  const named = files.filter(f => !/^cfile_/.test(f.name));
  if (named.length) files.splice(0, files.length, ...named);
  const code = (d.output || []).filter((o: any) => o.type === "code_interpreter_call").map((o: any) => o.code || "").join("\n# ----\n");
  return { text, files, code: clip(code, 3000), container, opened };
}
