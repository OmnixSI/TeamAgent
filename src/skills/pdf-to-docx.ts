// PDF to editable Word with pdf2docx, optionally for a page range. A PDF without a text layer would come out as
// pictures only, so the report says so and points at pdf-ocr.
import type { Skill, SkillArgs } from "./types.ts";
import { PY_COMMON, PY_SETUP, parseRanges, pyRun } from "./pdf-tools.ts";

const MAX_PAGES = 300;

const SCRIPT = String.raw`
import signal, logging
logging.disable(logging.WARNING)
os.makedirs("work", exist_ok=True)
MAXP = P["max_pages"]
name = FILES[0]
src = os.path.join("in", name)
d = open_pdf(src, PW, name)
n = len(d)
sel = pages_of(P["ranges"], n) if P.get("ranges") else list(range(1, n + 1))
sel = sorted(set(sel))
if len(sel) > MAXP:
    die("这次要转 %d 页，单次最多 %d 页（限时 %d 分钟），请用 pages 分段，比如 1-%d" % (len(sel), MAXP, P["budget"] // 60, MAXP))

k = min(len(sel), 10)
idx = sorted(set(sel[round(i * (len(sel) - 1) / (k - 1))] for i in range(k))) if k > 1 else sel[:1]
has = sum(1 for p in idx if len(re.sub(r"\s", "", d[p - 1].get_text())) >= 20)
no_text = has == 0
if d.needs_pass or d.is_encrypted:
    plain = os.path.join("work", "plain.pdf")
    d.save(plain, encryption=fitz.PDF_ENCRYPT_NONE)
    src = plain
d.close()

try:
    from pdf2docx import Converter
except ImportError:
    die("云电脑里没有 pdf2docx，办公工具包没装好")

def on_alarm(sig, frm):
    raise TimeoutError()
signal.signal(signal.SIGALRM, on_alarm)
signal.alarm(P["budget"] - 30)
out_name = uniq(os.path.splitext(name)[0] + ".docx")
out = os.path.join("out", out_name)
t1 = time.time()
cv = Converter(src)
try:
    if P.get("ranges"):
        cv.convert(out, pages=[p - 1 for p in sel])
    else:
        cv.convert(out)
except TimeoutError:
    die("转换超过 %d 秒还没完，页面太复杂；请用 pages 分段转" % (P["budget"] - 30))
finally:
    signal.alarm(0)
    try:
        cv.close()
    except Exception:
        pass
secs = time.time() - t1
if not os.path.exists(out) or os.path.getsize(out) == 0:
    die("没能生成 Word 文件，这份 PDF 的排版可能太特殊")

facts = ""
try:
    from docx import Document
    dd = Document(out)
    paras = sum(1 for p in dd.paragraphs if p.text.strip())
    chars = sum(len(p.text) for p in dd.paragraphs) + sum(len(c.text) for t in dd.tables for r in t.rows for c in r.cells)
    facts = "%d 段文字、%d 个表格、%d 张图，共约 %d 个字" % (paras, len(dd.tables), len(dd.inline_shapes), chars)
except Exception:
    pass
print("OK %s | 转了 %d 页（共 %d 页） | %s | %s" % (out_name, len(sel), n, human(os.path.getsize(out)), facts or "已生成"))
if no_text:
    print("NOTE 这份 PDF 没有文字层（扫描件或纯图片），转出来的 Word 里只有图片，没法编辑文字。先用 pdf-ocr 识别成可搜索的 PDF，再转 Word")
elif has < len(idx):
    print("NOTE 抽查的 %d 页里只有 %d 页有文字层，没有文字的页转出来是图片" % (len(idx), has))
print("NOTE 复杂排版（多栏、文本框、公式）转成 Word 后可能要稍微调整；速度约 %.1f 页/秒" % (len(sel) / max(secs, 0.01)))
print("用时 %d 秒" % round(time.time() - T0))
`;

const skill: Skill = {
  name: "pdf-to-docx",
  title: "PDF 转 Word",
  when: "把 PDF 转成可以编辑的 Word 文档（docx）时用，可以只转几页。要求 PDF 里有可选中的文字；扫描件（没有文字层）要先用 pdf-ocr 识别，否则转出来只有图片。",
  args: {
    pages: { type: "string", description: "只转这些页，如 1-3,7,10-（10- 是第 10 页到最后）。不填就转全部，单次最多 " + MAX_PAGES + " 页" },
    password: { type: "string", description: "PDF 有打开密码时在这里给出" },
  },
  files: { min: 1, max: 1, extensions: ["pdf"], what: "要转的 PDF" },
  packs: ["office"],
  timeoutSeconds: 600,
  commands(args: SkillArgs, files) {
    if (files.length !== 1) throw new Error("一次转 1 个 PDF，现在给了 " + files.length + " 个");
    if (!/\.pdf$/i.test(files[0].name)) throw new Error("要给 PDF 文件，" + files[0].name + " 不是");
    const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
    const p: Record<string, any> = { files: [files[0].name], max_pages: MAX_PAGES, budget: 600 };
    if (has("pages")) p.ranges = parseRanges(args.pages).map(r => [r.a, r.b, r.t]);
    if (has("password")) {
      const pw = String(args.password);
      if (pw.length > 100 || /[\x00-\x1f\x7f]/.test(pw)) throw new Error("密码最长 100 个字符，不能带换行等控制字符");
      p.password = pw;
    }
    return [PY_SETUP, ...pyRun(".skill_pdf_to_docx.py", PY_COMMON + SCRIPT, p)];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const r: Record<string, any> = {};
    const ok = lines.find(l => l.startsWith("OK "));
    if (ok) r.成品 = ok.slice(3);
    const notes = lines.filter(l => l.startsWith("NOTE ")).map(l => l.slice(5));
    if (notes.length) r.说明 = notes;
    if (notes.some(n => n.includes("没有文字层"))) r.没有文字层 = true;
    const t = lines.find(l => /^用时 \d+ 秒$/.test(l));
    if (t) r.用时 = t.slice(3);
    return r;
  },
};
export default skill;
