// Résumé: structured data (JSON) or a small Markdown convention -> one- or two-page PDF through Typst.
// The Typst source is built here in TypeScript (pure, unit-tested); only compiling happens in the cloud computer.
import type { Skill, SkillArgs, SkillFile } from "./types.ts";
import { sh } from "./types.ts";
import { putFile, TYPST_INSTALL, PY_PICK, PDF_PAGES, safeName, MAX_TEXT_BYTES } from "./md-to-report.ts";

export type Entry = { title: string; sub?: string; period?: string; place?: string; bullets: string[] };
export type Resume = {
  name: string; title?: string; contacts: string[]; summary?: string;
  experience: Entry[]; projects: Entry[]; education: Entry[]; skills: string[]; extra: { title: string; items: string[] }[];
};
const STYLES = ["classic", "modern", "compact"];
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" ? v.split(/\n+/).map((x) => x.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean) : []);

/** Contacts may be an array of strings or an object like { email, phone, city, github }. */
function contactList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (v && typeof v === "object") return Object.values(v as any).map(str).filter(Boolean);
  return typeof v === "string" ? v.split(/\s*[|·\n]\s*/).map((x) => x.trim()).filter(Boolean) : [];
}
function skillLines(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? `${str((x as any).name || (x as any).category || (x as any).title)}：${list((x as any).items ?? (x as any).skills).join("、")}` : str(x))).filter(Boolean);
  if (v && typeof v === "object") return Object.entries(v as any).map(([k, x]) => `${k}：${Array.isArray(x) ? (x as any[]).map(str).join("、") : str(x)}`);
  return list(v);
}
const entries = (v: unknown, map: (e: any) => Entry): Entry[] => (Array.isArray(v) ? v.filter((e) => e && typeof e === "object").map(map) : []);

/** Checks and normalises the JSON input; throws a Chinese error for bad data. */
export function normalizeResume(d: any): Resume {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("data 要是一个 JSON 对象，至少包含 name（姓名）");
  if (!str(d.name)) throw new Error("缺少 name（姓名）");
  const r: Resume = {
    name: str(d.name), title: str(d.title), contacts: contactList(d.contacts), summary: str(d.summary),
    experience: entries(d.experience, (e) => ({ title: str(e.company || e.title), sub: str(e.role || e.position), period: str(e.period || e.date), place: str(e.location), bullets: list(e.bullets ?? e.highlights ?? e.description) })),
    projects: entries(d.projects, (e) => ({ title: str(e.name || e.title), sub: str(e.role), period: str(e.period || e.date), place: str(e.link || e.url), bullets: list(e.bullets ?? e.highlights ?? e.description) })),
    education: entries(d.education, (e) => ({ title: str(e.school || e.title), sub: [str(e.degree), str(e.major)].filter(Boolean).join(" · "), period: str(e.period || e.date), place: str(e.location), bullets: list(e.bullets ?? e.details ?? (e.gpa ? `GPA ${e.gpa}` : "")) })),
    skills: skillLines(d.skills),
    extra: (Array.isArray(d.sections) ? d.sections : []).filter((s: any) => s && str(s.title)).map((s: any) => ({ title: str(s.title), items: list(s.items) })),
  };
  if (!r.summary && !r.experience.length && !r.projects.length && !r.education.length && !r.skills.length) throw new Error("内容太少：至少要有 summary、experience、projects、education、skills 之一");
  for (const e of [...r.experience, ...r.projects, ...r.education]) if (!e.title) throw new Error("每条经历都要有名称（工作写 company，项目写 name，教育写 school）");
  const bullets = [...r.experience, ...r.projects, ...r.education].reduce((n, e) => n + e.bullets.length, 0);
  if (bullets > 80 || JSON.stringify(r).length > 40_000) throw new Error("内容太多，一份简历放不下，请精简");
  return r;
}

const SECTION = (h: string): string | null => {
  const t = h.toLowerCase();
  if (/简介|摘要|自我评价|个人评价|summary|profile|about|objective/.test(t)) return "summary";
  if (/工作|实习|职业|经历$|experience|employment|work/.test(t) && !/项目|project/.test(t)) return "experience";
  if (/项目|project/.test(t)) return "projects";
  if (/教育|学历|education/.test(t)) return "education";
  if (/技能|能力|skill/.test(t)) return "skills";
  return null;
};
const parts = (s: string) => s.split(/\s*[|｜]\s*/).map((x) => x.trim());

/**
 * Markdown convention: "# 姓名"; a "> 职位 | 邮箱 | 电话 | 城市" line; "## 简介 / 工作经历 / 项目经历 / 教育背景 / 技能" sections;
 * "### 单位 | 职位 | 时间" for each entry with "- " bullets below; any other "##" section becomes a bullet section.
 */
export function parseResumeMd(md: string): any {
  const d: any = { contacts: [], experience: [], projects: [], education: [], skills: [], sections: [] };
  let sec: string | null = null, cur: any = null, extra: any = null, first = true;
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = /^#\s+(.+)$/.exec(line)) && first) { d.name = m[1].trim(); first = false; continue; }
    if ((m = /^##\s+(.+)$/.exec(line))) {
      sec = SECTION(m[1]); cur = null; extra = null;
      if (!sec) { extra = { title: m[1].trim(), items: [] }; d.sections.push(extra); }
      continue;
    }
    if ((m = /^###\s+(.+)$/.exec(line))) {
      const p = parts(m[1]);
      if (sec === "experience") d.experience.push((cur = { company: p[0], role: p[1], period: p[2], location: p[3], bullets: [] }));
      else if (sec === "projects") d.projects.push((cur = { name: p[0], role: p[1], period: p[2], link: p[3], bullets: [] }));
      else if (sec === "education") d.education.push((cur = { school: p[0], degree: p[1], period: p[2], location: p[3], bullets: [] }));
      else if (extra) extra.items.push(m[1].trim());
      continue;
    }
    if ((m = /^>\s*(.*)$/.exec(line)) && !sec) {
      const p = parts(m[1]);
      if (!d.title) d.title = p.shift(); // first item is the job title
      d.contacts.push(...p.filter(Boolean));
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)?.[1] ?? null;
    const text = bullet ?? line.trim();
    if (!sec && !extra) { if (!d.title && !d.summary) d.title = text; else d.summary = [d.summary, text].filter(Boolean).join(" "); continue; }
    if (sec === "summary") d.summary = [d.summary, text].filter(Boolean).join(" ");
    else if (sec === "skills") d.skills.push(text);
    else if (extra) extra.items.push(text);
    else if (cur) cur.bullets.push(text);
  }
  return d;
}

// Typst helpers -------------------------------------------------------------
const ESC = new Set("\\#$*_`<>@[]~-+/=".split(""));
export const esc = (s: string) => [...s].map((c) => (ESC.has(c) ? "\\" + c : c)).join("").replace(/^(\s*\d+)\./, "$1\\.");
const tstr = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
/** Plain text plus **bold** and [text](url) from the data; everything else is escaped. */
export function inl(s: string): string {
  let out = "", i = 0;
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (let m; (m = re.exec(s)); ) {
    out += esc(s.slice(i, m.index));
    out += m[1] != null ? `#strong[${esc(m[1])}];` : `#link(${tstr(m[3])})[${esc(m[2])}];`;
    i = m.index + m[0].length;
  }
  return out + esc(s.slice(i));
}
const arr = (xs: string[]) => (xs.length ? "(" + xs.map((x) => `[${inl(x)}]`).join(", ") + ",)" : "()");

const THEME: Record<string, { font: string; size: string; accent: string; lead: string; mx: string; my: string; gap: string }> = {
  classic: { font: '("Libertinus Serif", "Noto Serif CJK SC")', size: "11pt", accent: "luma(20)", lead: "0.7em", mx: "2cm", my: "1.7cm", gap: "9pt" },
  modern: { font: '("Noto Sans CJK SC", "DejaVu Sans")', size: "10.5pt", accent: 'rgb("#1f5f8b")', lead: "0.7em", mx: "1.9cm", my: "1.6cm", gap: "9pt" },
  compact: { font: '("Noto Sans CJK SC", "DejaVu Sans")', size: "9.3pt", accent: 'rgb("#2b2b2b")', lead: "0.5em", mx: "1.5cm", my: "1.2cm", gap: "6pt" },
};

export function resumeTypst(r: Resume, style: string, lang: "zh" | "en", photo?: string): string {
  const t = THEME[style];
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const o: string[] = [];
  o.push(`#let k = float(sys.inputs.at("k", default: "1"))`);
  o.push(`#set document(title: ${tstr(r.name)}, author: ${tstr(r.name)})`);
  o.push(`#let accent = ${t.accent}`);
  o.push(`#set page(paper: "a4", margin: (x: ${t.mx} * k, y: ${t.my} * k))`);
  o.push(`#set text(font: ${t.font}, size: ${t.size} * k, lang: ${lang === "zh" ? '"zh", region: "cn"' : '"en"'}, fill: luma(25))`);
  o.push(`#set par(leading: ${t.lead} * k, spacing: 0.6em * k, justify: false)`);
  o.push(`#set list(indent: 0.2em, body-indent: 0.55em, spacing: ${style === "compact" ? "3pt" : "5pt"} * k, marker: [•])`);
  o.push(`#show link: set text(fill: accent)`);
  const sec = {
    classic: `#let sec(t) = block(above: ${t.gap} * k + 10pt, below: 5pt * k, width: 100%, stroke: (bottom: 0.7pt + luma(60)), inset: (bottom: 3pt))[#text(weight: "bold", size: 11.5pt * k)[#t]]`,
    modern: `#let sec(t) = block(above: ${t.gap} * k + 11pt, below: 6pt * k, width: 100%)[#box(width: 3.5pt, height: 0.9em, fill: accent, baseline: 0.1em) #h(5pt) #text(weight: "bold", size: 12pt * k, fill: accent)[#t] #h(6pt) #box(width: 1fr, line(length: 100%, stroke: 0.5pt + luma(200)))]`,
    compact: `#let sec(t) = block(above: ${t.gap} * k + 5pt, below: 3pt * k, width: 100%, stroke: (bottom: 0.5pt + accent), inset: (bottom: 2pt))[#text(weight: "bold", size: 10pt * k, fill: accent)[#t]]`,
  }[style]!;
  o.push(sec);
  o.push(`#let entry(a, b, sub: none, items: ()) = block(above: ${style === "compact" ? "6pt" : "9pt"} * k, below: 0pt, breakable: false)[#grid(columns: (1fr, auto), column-gutter: 8pt, a, align(right, text(fill: luma(95))[#b]))#if sub != none [#v(-2pt * k) #text(fill: luma(70))[#sub]]#if items.len() > 0 [#v(1pt * k) #list(..items)]]`);
  // header
  const contacts = r.contacts.map((c) => (/^https?:\/\//.test(c) ? `#link(${tstr(c)})[${esc(c.replace(/^https?:\/\//, ""))}];` : inl(c)));
  const cline = contacts.join(style === "classic" ? " #h(0.5em) · #h(0.5em) " : " #h(0.4em) | #h(0.4em) ");
  const ph = photo ? `box(width: 2.5cm, height: 3.2cm, radius: 3pt, clip: true, image(${tstr(photo)}, width: 2.5cm, height: 3.2cm, fit: "cover"))` : "";
  if (style === "classic") {
    const head = `[#align(center)[#text(size: 22pt * k, weight: "bold")[${inl(r.name)}]${r.title ? `\\ #v(1pt) #text(size: 12pt * k, style: "italic")[${inl(r.title)}]` : ""}${cline ? `\\ #v(2pt) #text(size: 9.5pt * k, fill: luma(70))[${cline}]` : ""}]]`;
    o.push(photo ? `#grid(columns: (1fr, auto), column-gutter: 10pt, ${head}, ${ph})` : `#block(width: 100%)${head}`);
  } else if (style === "modern") {
    const head = `#text(size: 27pt * k, weight: "bold", fill: accent)[${inl(r.name)}]${r.title ? `\\ #v(2pt) #text(size: 13pt * k, fill: luma(80))[${inl(r.title)}]` : ""}${cline ? `\\ #v(3pt) #text(size: 9.5pt * k, fill: luma(80))[${cline}]` : ""}`;
    o.push(photo ? `#grid(columns: (1fr, auto), column-gutter: 12pt, [${head}], ${ph})` : `#block(width: 100%)[${head}]`);
    o.push(`#v(-2pt)#line(length: 100%, stroke: 1.6pt + accent)`);
  } else {
    const left = `#text(size: 17pt * k, weight: "bold")[${inl(r.name)}]${r.title ? ` #h(6pt) #text(size: 10.5pt * k, fill: luma(80))[${inl(r.title)}]` : ""}`;
    const right = cline ? `align(right + horizon)[#text(size: 8.8pt * k, fill: luma(70))[${cline}]]` : "[]";
    o.push(photo ? `#grid(columns: (1fr, auto, auto), column-gutter: 10pt, align: horizon, [${left}], ${right}, box(width: 1.9cm, height: 2.4cm, radius: 2pt, clip: true, image(${tstr(photo)}, width: 1.9cm, height: 2.4cm, fit: "cover")))` : `#grid(columns: (auto, 1fr), column-gutter: 10pt, align: horizon, [${left}], ${right})`);
  }
  if (r.summary) { o.push(`#sec[${L("个人简介", "Summary")}]`); o.push(inl(r.summary)); }
  const place = (e: Entry) => (e.place ? ` #text(fill: luma(100))[· ${inl(e.place)}]` : "");
  if (r.experience.length) {
    o.push(`#sec[${L("工作经历", "Experience")}]`);
    for (const e of r.experience) o.push(`#entry([#strong[${inl(e.title)}]${e.sub ? ` #h(0.6em) ${inl(e.sub)}` : ""}${place(e)}], [${inl(e.period || "")}], items: ${arr(e.bullets)})`);
  }
  if (r.projects.length) {
    o.push(`#sec[${L("项目经历", "Projects")}]`);
    for (const e of r.projects) o.push(`#entry([#strong[${inl(e.title)}]${e.sub ? ` #h(0.6em) ${inl(e.sub)}` : ""}${e.place ? ` #h(0.6em) #text(fill: luma(100))[${/^https?:/.test(e.place) ? `#link(${tstr(e.place)})[${esc(e.place.replace(/^https?:\/\//, ""))}];` : inl(e.place)}]` : ""}], [${inl(e.period || "")}], items: ${arr(e.bullets)})`);
  }
  if (r.education.length) {
    o.push(`#sec[${L("教育背景", "Education")}]`);
    for (const e of r.education) o.push(`#entry([#strong[${inl(e.title)}]${e.sub ? ` #h(0.6em) ${inl(e.sub)}` : ""}${place(e)}], [${inl(e.period || "")}], items: ${arr(e.bullets)})`);
  }
  if (r.skills.length) {
    o.push(`#sec[${L("专业技能", "Skills")}]`);
    o.push(r.skills.map((s) => { const m = /^([^：:]{1,24})[：:]\s*(.+)$/.exec(s); return m ? `#strong[${inl(m[1])}]${lang === "zh" ? "：" : ": "}${inl(m[2])}` : inl(s); }).join(" \\\n"));
  }
  for (const x of r.extra) { o.push(`#sec[${inl(x.title)}]`); o.push(`#list(..${arr(x.items)})`); }
  return o.join("\n\n") + "\n";
}

const skill: Skill = {
  name: "resume",
  title: "生成简历 PDF",
  when:
    "把个人资料排成一页或两页的简历 PDF，中英文都排得好。最好的输入是 data 参数里的 JSON：" +
    "{name 姓名（必填）, title 求职方向, contacts [电话, 邮箱, 城市, 链接…], summary 个人简介, " +
    "experience [{company, role, period, location, bullets [每条一句话，带数字更好]}], projects [{name, role, period, link, bullets}], " +
    "education [{school, degree, major, period, bullets}], skills [\"语言：Python、Go\", …] 或 {类别: [技能…]}, sections [{title, items}] 放证书/获奖等}。" +
    "也可以写 Markdown（markdown 参数或上传 .md）：# 姓名；下一行「> 求职方向 | 邮箱 | 电话 | 城市」；## 个人简介 / 工作经历 / 项目经历 / 教育背景 / 专业技能；" +
    "每段经历写「### 单位 | 职位 | 起止时间」，下面用 - 列要点；技能用「- 类别：内容」；其他 ## 小节当作要点列表。" +
    "style：classic 经典（衬线、居中）、modern 现代（强调色）、compact 紧凑（信息密集）。可以上传证件照（photo）。内容超过页数时自动略微缩小字号。返回 PDF 和 .typ 源文件。",
  args: {
    data: { type: "string", description: "简历数据，JSON 文本（见说明）。和 markdown 二选一。" },
    markdown: { type: "string", description: "用 Markdown 约定格式写的简历。和 data 二选一。" },
    style: { type: "string", description: "classic 经典（默认）、modern 现代、compact 紧凑。", enum: STYLES },
    language: { type: "string", description: "标题栏目语言：zh 中文、en 英文，默认按内容自动判断。", enum: ["auto", "zh", "en"] },
    pages: { type: "integer", description: "最多几页，1 或 2，默认 2；填 1 会尽量缩进一页。" },
    photo: { type: "string", description: "要放在简历上的照片文件名（先上传）；只传了一张图片时可不填。" },
    name: { type: "string", description: "输出文件名（不含扩展名），默认 resume。" },
  },
  files: { min: 0, max: 5, extensions: ["md", "markdown", "txt", "json", "jpg", "jpeg", "png", "webp"], what: "可选：Markdown 或 JSON 简历文件、证件照" },
  timeoutSeconds: 240,
  commands(args: SkillArgs, files: SkillFile[]) {
    const style = String(args.style || "classic");
    if (!STYLES.includes(style)) throw new Error("style 只能是 classic、modern、compact 三种之一");
    const maxPages = args.pages == null || args.pages === "" ? 2 : Number(args.pages);
    if (maxPages !== 1 && maxPages !== 2) throw new Error("pages 只能是 1 或 2");
    const language = String(args.language || "auto");
    if (!["auto", "zh", "en"].includes(language)) throw new Error("language 只能是 auto、zh、en");
    let raw: any = args.data;
    if (typeof raw === "string" && raw.trim()) {
      try { raw = JSON.parse(raw); } catch { throw new Error("data 不是合法的 JSON，请检查引号和逗号"); }
    } else if (!(raw && typeof raw === "object")) {
      let md = typeof args.markdown === "string" ? args.markdown : "";
      const jf = files.find((f) => /\.json$/i.test(f.name));
      if (!md.trim() && jf) throw new Error("请直接把简历 JSON 放进 data 参数，不要上传 JSON 文件");
      if (!md.trim()) { const f = files.find((x) => /\.(md|markdown|txt)$/i.test(x.name)); if (f) throw new Error("请把 Markdown 简历的文字放进 markdown 参数（上传的文件这里读不到）"); }
      if (!md.trim()) throw new Error("请提供简历内容：data（JSON）或 markdown");
      if (new TextEncoder().encode(md).length > MAX_TEXT_BYTES) throw new Error("简历文字太长了");
      raw = parseResumeMd(md);
    }
    const r = normalizeResume(raw);
    const sample = JSON.stringify(r);
    const lang: "zh" | "en" = language === "auto" ? ((sample.match(new RegExp(CJK.source, "g")) || []).length > sample.length * 0.03 ? "zh" : "en") : (language as "zh" | "en");
    let photo: string | undefined;
    const pic = (n: string) => /\.(jpe?g|png|webp)$/i.test(n);
    if (args.photo) {
      const f = files.find((x) => x.name === String(args.photo) || x.name.toLowerCase() === String(args.photo).toLowerCase());
      if (!f || !pic(f.name)) throw new Error("没有找到照片文件，请先上传 jpg 或 png 图片，photo 填它的文件名");
      photo = "/in/" + f.name;
    } else { const imgs = files.filter((x) => pic(x.name)); if (imgs.length === 1) photo = "/in/" + imgs[0].name; }
    const name = safeName(args.name, "resume");
    const typ = `out/${name}.typ`, pdf = `out/${name}.pdf`;
    const loop = `${PY_PICK}; for K in 1 0.95 0.9 0.85 0.8 0.76; do typst compile --root . --input k=$K ${sh(typ)} ${sh(pdf)} 2>.skill/err.txt || { cat .skill/err.txt >&2; exit 1; }; N=${PDF_PAGES(pdf)}; [ "$N" -le ${maxPages} ] && break; done; echo PAGES=$N; echo SCALE=$K`;
    return ["mkdir -p in out .skill", TYPST_INSTALL, ...putFile(typ, resumeTypst(r, style, lang, photo)), loop];
  },
  report(stdout) {
    const text = stdout.join("\n");
    const scale = Number(/SCALE=([\d.]+)/.exec(text)?.[1] || 1);
    return { pages: Number(/PAGES=(\d+)/.exec(text)?.[1] || 0), ...(scale < 1 ? { shrunk: scale } : {}) };
  },
};
export default skill;
