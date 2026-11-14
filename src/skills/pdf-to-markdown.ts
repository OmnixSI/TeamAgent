// PDF, Word, PowerPoint, Excel and HTML to Markdown with markitdown; pymupdf takes over for PDFs when markitdown
// finds no text. Optionally also writes the plain text.
import type { Skill, SkillArgs } from "./types.ts";
import { PY_COMMON, PY_SETUP, parseRanges, pyRun } from "./pdf-tools.ts";

const EXT = ["pdf", "docx", "pptx", "xlsx", "html", "htm"];
const MAX_PDF_PAGES = 400;

const SCRIPT = String.raw`
os.makedirs("work", exist_ok=True)
name = FILES[0]
e = os.path.splitext(name)[1].lower().lstrip(".")
stem = os.path.splitext(name)[0]
src = os.path.join("in", name)
CJK = re.compile(r"[㐀-鿿]")
GAP = re.compile(r"(?<=[㐀-鿿])[ \t]+(?=[㐀-鿿])")
pages_note = ""
fitz_text = None

def tidy(t):
    t = t.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    t = GAP.sub("", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip() + "\n"

def solid(t):
    return len(re.sub(r"\s", "", t)) >= 20

if e == "pdf":
    d = open_pdf(src, PW, name)
    n = len(d)
    sel = pages_of(P["ranges"], n) if P.get("ranges") else list(range(1, n + 1))
    if len(sel) > P["max_pages"]:
        die("要转 %d 页，单次最多 %d 页，请用 pages 分段" % (len(sel), P["max_pages"]))
    if P.get("ranges") or d.needs_pass or d.is_encrypted:
        sub = build(d, sel)
        src = os.path.join("work", "sub.pdf")
        sub.save(src, garbage=3, deflate=True)
    pages_note = "%d 页" % len(sel) if len(sel) == n else "第 %s 页，共 %d 页" % (P["ranges_text"], n)
    fitz_text = "\n\n".join(d[p - 1].get_text("text", sort=True).strip() for p in sel)
    d.close()

md, how = "", ""
try:
    from markitdown import MarkItDown
    work_in = os.path.join("work", "input." + ("html" if e == "htm" else e))
    shutil.copyfile(src, work_in)
    r = MarkItDown(enable_plugins=False).convert(work_in)
    md = getattr(r, "text_content", None) or getattr(r, "markdown", "") or ""
    how = "markitdown"
except ImportError:
    if e != "pdf":
        die("云电脑里没有 markitdown，办公工具包没装好")
except Exception as ex:
    if e != "pdf":
        die("没能读懂这个文件（%s）" % type(ex).__name__)
if e == "pdf" and not solid(md):
    if solid(fitz_text or ""):
        md, how = fitz_text, "pymupdf（markitdown 没读出文字，改用备用办法，没有标题和表格结构）"
    else:
        die("这份 PDF 里读不到文字，是扫描件或纯图片。先用 pdf-ocr 识别，再来转 Markdown")
md = tidy(md)
if not solid(md):
    die("文件里没有可提取的文字")
out_md = uniq(stem + ".md")
open(os.path.join("out", out_md), "w", encoding="utf-8").write(md)
nonsp = len(re.sub(r"\s", "", md))
cjk = len(CJK.findall(md))
print("OK %s | %s | %d 个字符（不含空白），其中汉字 %d | 方法：%s" % (out_md, human(os.path.getsize(os.path.join("out", out_md))), nonsp, cjk, how))
if P["also_text"]:
    if e == "pdf" and solid(fitz_text or ""):
        txt = tidy(fitz_text)
    else:
        t = re.sub(r"^\s{0,3}#{1,6}\s*", "", md, flags=re.M)
        t = re.sub(r"(\*\*|__|\x60)", "", t)
        t = re.sub(r"^\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)*\s*\|?\s*$\n?", "", t, flags=re.M)
        t = re.sub(r"\s*\|\s*", "  ", t.strip("|"))
        txt = tidy(t)
    out_txt = uniq(stem + ".txt")
    open(os.path.join("out", out_txt), "w", encoding="utf-8").write(txt)
    print("OK %s | %s | %d 个字符（不含空白）" % (out_txt, human(os.path.getsize(os.path.join("out", out_txt))), len(re.sub(r"\s", "", txt))))
if pages_note:
    print("NOTE 范围：" + pages_note)
print("用时 %d 秒" % round(time.time() - T0))
`;

const ext = (n: string) => (n.match(/\.([^./\\]+)$/)?.[1] || "").toLowerCase();

const skill: Skill = {
  name: "pdf-to-markdown",
  title: "转成 Markdown",
  when: "把 PDF、Word（docx）、PowerPoint（pptx）、Excel（xlsx）、网页 HTML 里的内容提取成 Markdown 文本时用，适合拿去喂给模型、做笔记、整理资料。可以顺便给一份纯文本。扫描版 PDF 没有文字，要先用 pdf-ocr。",
  args: {
    pages: { type: "string", description: "只对 PDF 有效：只转这些页，如 1-3,7，不填就是全部（单次最多 " + MAX_PDF_PAGES + " 页）" },
    also_text: { type: "boolean", description: "是否再给一份纯文本 .txt，默认 false" },
    password: { type: "string", description: "PDF 有打开密码时在这里给出" },
  },
  files: { min: 1, max: 1, extensions: EXT, what: "pdf、docx、pptx、xlsx 或 html 文件" },
  packs: ["office"],
  timeoutSeconds: 420,
  commands(args: SkillArgs, files) {
    if (files.length !== 1) throw new Error("一次转 1 个文件，现在给了 " + files.length + " 个");
    const e = ext(files[0].name);
    if (!EXT.includes(e)) throw new Error(files[0].name + " 不是能转的格式，能转的有 " + EXT.join("、") + "；旧版 doc、ppt、xls 先用 doc-to-pdf 转成 PDF 再来");
    const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
    const p: Record<string, any> = { files: [files[0].name], max_pages: MAX_PDF_PAGES, also_text: has("also_text") && (args.also_text === true || /^(true|1|yes|是)$/i.test(String(args.also_text))) };
    if (has("pages")) {
      if (e !== "pdf") throw new Error("pages 只对 PDF 有用，" + e + " 文件不用填");
      const rs = parseRanges(args.pages);
      p.ranges = rs.map(r => [r.a, r.b, r.t]);
      p.ranges_text = rs.map(r => r.t).join(",");
    }
    if (has("password")) {
      const pw = String(args.password);
      if (pw.length > 100 || /[\x00-\x1f\x7f]/.test(pw)) throw new Error("密码最长 100 个字符，不能带换行等控制字符");
      if (e !== "pdf") throw new Error("password 只对 PDF 有用");
      p.password = pw;
    }
    return [PY_SETUP, ...pyRun(".skill_pdf_to_markdown.py", PY_COMMON + SCRIPT, p)];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const r: Record<string, any> = {};
    const oks = lines.filter(l => l.startsWith("OK "));
    if (oks.length) r.成品 = oks.map(l => l.slice(3));
    const m = lines.find(l => l.startsWith("OK "))?.match(/(\d+) 个字符/);
    if (m) r.字符数 = Number(m[1]);
    const notes = lines.filter(l => l.startsWith("NOTE ")).map(l => l.slice(5));
    if (notes.length) r.说明 = notes;
    const t = lines.find(l => /^用时 \d+ 秒$/.test(l));
    if (t) r.用时 = t.slice(3);
    return r;
  },
};
export default skill;
