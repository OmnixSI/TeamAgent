// Documents to PDF: Word, Excel, PowerPoint, OpenDocument, RTF, HTML, plain text, Markdown and pictures.
// Office formats go through LibreOffice (headless), Markdown through pandoc (typst when this pandoc has it, else Word),
// pictures through Pillow and pymupdf. Several inputs become several PDFs, or one merged PDF in the given order.
import type { Skill, SkillArgs } from "./types.ts";
import { sh } from "./types.ts";
import { PY_COMMON, PY_IMG, PY_SETUP, cleanName, pyRun } from "./pdf-tools.ts";

const OFFICE = ["doc", "docx", "dot", "dotx", "odt", "ott", "rtf", "xls", "xlsx", "xlsm", "ods", "ppt", "pptx", "pps", "ppsx", "odp"];
const IMAGES = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const OTHER = ["html", "htm", "md", "markdown", "txt"];
const ext = (n: string) => (n.match(/\.([^./\\]+)$/)?.[1] || "").toLowerCase();

const SCRIPT = String.raw`
import glob, zipfile, shutil
os.makedirs("work", exist_ok=True)
IMG = %IMAGES%
DEADLINE = T0 + P["budget"]
LO = shutil.which("soffice") or shutil.which("libreoffice")
FONT = "Noto Sans CJK SC"
CJK_NAME = re.compile(r"CJK|Noto|Hei|Song|Kai|Ming|Source ?Han|WenQuan|WQY|Droid|PingFang|Fang|SimSun|SimHei|YaHei|Hiragino|Unicode|STH|Sarasa|Heiti|Songti", re.I)

def read_text(path):
    b = open(path, "rb").read()
    if b.startswith(b"\xef\xbb\xbf"):
        return b[3:].decode("utf-8", "replace")
    if b.startswith((b"\xff\xfe", b"\xfe\xff")):
        return b.decode("utf-16", "replace")
    for enc in ("utf-8", "gb18030", "big5"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            pass
    return b.decode("utf-8", "replace")

def lo_convert(src, filt="pdf"):
    if not LO:
        die("云电脑里没有 LibreOffice，办公工具包没装好")
    cmd = [LO, "--headless", "--norestore", "--nologo", "--nodefault", "--nofirststartwizard"]
    if os.environ.get("LO_PROFILE"):
        cmd.append("-env:UserInstallation=file://" + os.environ["LO_PROFILE"])
    cmd += ["--convert-to", filt, "--outdir", "work", src]
    env = dict(os.environ)
    env.setdefault("HOME", "/root")
    env["LC_ALL"] = os.environ.get("LO_LOCALE", "zh_CN.UTF-8")
    left = max(30, min(170, DEADLINE - time.time()))
    rc, o, e = run(cmd, left)
    out = os.path.splitext(src)[0] + ".pdf"
    if rc is None:
        return None, "转换超过 %d 秒，被停掉了" % left
    if not os.path.exists(out) or os.path.getsize(out) == 0:
        return None, "LibreOffice 没能打开这个文件，可能已损坏、有打开密码或格式不对"
    return out, ""

def patch_sheet(x):
    m = re.search(r'<dimension ref="([A-Z]+)\d*(?::([A-Z]+)\d*)?"', x)
    cols = 1
    if m:
        n = 0
        for ch in (m.group(2) or m.group(1)):
            n = n * 26 + ord(ch) - 64
        cols = n
    land = cols > 9
    if re.search(r"<sheetPr\b", x):
        if re.search(r"<pageSetUpPr\b", x):
            x = re.sub(r"<pageSetUpPr\b[^>]*?/>", '<pageSetUpPr fitToPage="1"/>', x, count=1)
        elif re.search(r"<sheetPr\b[^>]*?/>", x):
            x = re.sub(r"<sheetPr\b([^>]*?)/>", r'<sheetPr\1><pageSetUpPr fitToPage="1"/></sheetPr>', x, count=1)
        else:
            x = x.replace("</sheetPr>", '<pageSetUpPr fitToPage="1"/></sheetPr>', 1)
    else:
        x = re.sub(r"(<worksheet\b[^>]*>)", r'\1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>', x, count=1)
    attrs = 'fitToWidth="1" fitToHeight="0"' + (' orientation="landscape"' if land else "")
    m = re.search(r"<pageSetup\b([^>]*?)/>", x)
    if m:
        drop = r'\s(fitToWidth|fitToHeight' + ("|orientation" if land else "") + r')="[^"]*"'
        x = x[:m.start()] + "<pageSetup" + re.sub(drop, "", m.group(1)) + " " + attrs + "/>" + x[m.end():]
    else:
        tag = "<pageSetup " + attrs + "/>"
        m = re.search(r"<pageMargins\b[^>]*?/>", x)
        if m:
            x = x[:m.end()] + tag + x[m.end():]
        else:
            m = re.search(r"<(headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b", x)
            ins = m.start() if m else x.rindex("</worksheet>")
            x = x[:ins] + tag + x[ins:]
    return x

def fit_xlsx(src, dst):
    # Edits only the page-setup lines of each sheet, so cell contents and cached values stay exactly as they were.
    zin = zipfile.ZipFile(src)
    names = zin.namelist()
    if any(n.startswith(("xl/charts/", "xl/drawings/", "xl/media/", "xl/pivotTables/", "xl/embeddings/")) for n in names):
        return False
    try:
        zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
        for it in zin.infolist():
            data = zin.read(it.filename)
            if re.match(r"xl/worksheets/sheet\d+\.xml$", it.filename):
                try:
                    data = patch_sheet(data.decode("utf-8")).encode("utf-8")
                except Exception:
                    pass
            zout.writestr(it, data)
        zout.close()
        return True
    except Exception:
        return False

def tune_docx(path, a4=True):
    try:
        from docx import Document
        from docx.shared import Mm
        from docx.oxml.ns import qn
    except Exception:
        return False
    d = Document(path)
    for s in d.sections:
        if a4:
            s.page_width, s.page_height = Mm(210), Mm(297)
            s.left_margin = s.right_margin = Mm(25)
            s.top_margin = s.bottom_margin = Mm(22)
    for st in d.styles:
        try:
            rpr = st.element.get_or_add_rPr()
            rf = rpr.get_or_add_rFonts()
            for a in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
                k = qn("w:" + a)
                if k in rf.attrib:
                    del rf.attrib[k]
            rf.set(qn("w:eastAsia"), FONT)
            mono = bool(re.search(r"code|verbatim|source", st.name or "", re.I))
            if not mono:
                rf.set(qn("w:ascii"), FONT)
                rf.set(qn("w:hAnsi"), FONT)
        except Exception:
            pass
    d.save(path)
    return True

def txt_to_docx(text, dst):
    from docx import Document
    from docx.shared import Pt, Mm
    from docx.oxml.ns import qn
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]", "", text.replace("\r\n", "\n").replace("\r", "\n"))
    lines = text.split("\n")
    if len(lines) > 60000:
        die("文本有 %d 行，太长了（最多 6 万行）" % len(lines))
    d = Document()
    for s in d.sections:
        s.page_width, s.page_height = Mm(210), Mm(297)
        s.left_margin = s.right_margin = Mm(22)
        s.top_margin = s.bottom_margin = Mm(20)
    st = d.styles["Normal"]
    st.font.name = FONT
    st.font.size = Pt(10.5)
    st.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), FONT)
    for ln in lines:
        p = d.add_paragraph(ln)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.space_before = Pt(0)
    d.save(dst)

def md_route():
    if shutil.which("pandoc") is None:
        return None
    rc, o, e = run(["pandoc", "--list-output-formats"], 20)
    return "typst" if rc == 0 and re.search(r"^typst$", o, re.M) and shutil.which("typst") else "word"

def md_to_pdf(src_text, i):
    if not shutil.which("pandoc"):
        return None, "云电脑里没有 pandoc，办公工具包没装好"
    md = "work/u%d.md" % i
    open(md, "w", encoding="utf-8").write(src_text)
    pdf = "work/u%d.pdf" % i
    how = md_route()
    if how == "typst":
        typ = "work/u%d.typ" % i
        rc, o, e = run(["pandoc", "--sandbox", "-f", "markdown-smart", "-s", "-t", "typst", "-V", "mainfont=" + FONT, "-V", "papersize=a4", "-V", "fontsize=11pt", "-V", "margin.x=2.2cm", "-V", "margin.y=2.2cm", "-o", typ, md], 90)
        if rc == 0 and os.path.exists(typ):
            rc, o, e = run(["typst", "compile", typ, pdf], 120)
            if rc == 0 and os.path.exists(pdf) and os.path.getsize(pdf) > 0:
                return pdf, "Markdown 经 pandoc 和 typst 排版"
    docx = "work/u%d.docx" % i
    rc, o, e = run(["pandoc", "--sandbox", "-f", "markdown-smart", "-t", "docx", "-o", docx, md], 90)
    if rc != 0 or not os.path.exists(docx):
        return None, "pandoc 没能读懂这份 Markdown"
    tune_docx(docx)
    out, err = lo_convert(docx)
    return out, ("Markdown 经 pandoc 转成 Word 再出 PDF" if out else err)

def fonts_note(pdf):
    try:
        d = fitz.open(pdf)
        names, text = [], ""
        for pg in list(d)[:6]:
            for f in pg.get_fonts():
                nm = re.sub(r"^[A-Z]{6}\+", "", f[3] or "")
                if nm and nm not in names:
                    names.append(nm)
            text += pg.get_text()[:400]
        cjk = [n for n in names if CJK_NAME.search(n)]
        if re.search(r"[一-鿿]", text) and not cjk:
            return "注意：文字里有中文，但 PDF 里没找到中文字体，部分字可能显示成方块"
        if cjk:
            return "中文字体 " + "、".join(cjk[:2])
    except Exception:
        pass
    return ""

# ---- plan: images are one unit (unless separate), everything else one unit per file
units, img_unit = [], None
for nm in FILES:
    e = os.path.splitext(nm)[1].lower().lstrip(".")
    if e in IMG:
        if P["separate_images"]:
            units.append(["img", [nm]])
        else:
            if img_unit is None:
                img_unit = ["img", []]
                units.append(img_unit)
            img_unit[1].append(nm)
    else:
        units.append([e, [nm]])

zh = run(["fc-list", ":lang=zh", "family"], 20) if shutil.which("fc-list") else (0, "ok", "")
if zh[0] == 0 and not zh[1].strip():
    print("NOTE 云电脑里没有中文字体，中文可能显示成方块")

results, failed = [], []
for i, (kind, names) in enumerate(units):
    label = names[0] if len(names) == 1 else "%d 张图" % len(names)
    if time.time() > DEADLINE - 15:
        failed.append("%s：时间不够，没来得及转" % label)
        continue
    try:
        extra = ""
        if kind == "img":
            doc = images_to_pdf(["in/" + n for n in names], P["page_size"], P["margin_mm"])
            pdf = "work/u%d.pdf" % i
            doc.save(pdf, garbage=3, deflate=True)
            extra = "%d 张图，页面%s" % (len(names), "按图片大小" if P["page_size"] == "fit" else "A4")
            stem = os.path.splitext(names[0])[0] + ("等%d张" % len(names) if len(names) > 1 else "")
        else:
            nm = names[0]
            stem = os.path.splitext(nm)[0]
            src = "in/" + nm
            if kind in ("md", "markdown"):
                pdf, extra = md_to_pdf(read_text(src), i)
            elif kind == "txt":
                dst = "work/u%d.docx" % i
                try:
                    txt_to_docx(read_text(src), dst)
                except ImportError:
                    shutil.copyfile(src, "work/u%d.txt" % i)
                    dst = "work/u%d.txt" % i
                pdf, err = lo_convert(dst)
                extra = err
            elif kind in ("html", "htm"):
                t = read_text(src)
                if not re.search(r"<meta[^>]+charset", t, re.I):
                    t = '<meta charset="utf-8">' + t
                else:
                    t = re.sub(r"(<meta[^>]+charset=)[\"']?[\w-]+", r'\1"utf-8', t, count=1, flags=re.I)
                dst = "work/u%d.html" % i
                open(dst, "w", encoding="utf-8").write(t)
                pdf, err = lo_convert(dst, "pdf:writer_web_pdf_Export")
                extra = err
            else:
                dst = "work/u%d.%s" % (i, kind)
                shutil.copyfile(src, dst)
                if kind == "xlsx" and P["fit_width"]:
                    fitted = "work/u%d_fit.xlsx" % i
                    if fit_xlsx(dst, fitted):
                        os.replace(fitted, dst)
                        extra = "表格已调成每页一整宽（不会再被切成左右几页）"
                    else:
                        extra = "表格里有图表或图片，保持原来的分页"
                pdf, err = lo_convert(dst)
                if not pdf:
                    extra = err
        if not pdf:
            failed.append("%s：%s" % (label, extra or "转换失败"))
            continue
        results.append((stem, pdf, extra, label))
    except SystemExit:
        raise
    except Exception as ex:
        failed.append("%s：%s" % (label, str(ex).replace("\n", " ")[:100]))

if not results:
    die("没有一个文件转成功。" + "；".join(failed))

def page_size_text(pdf):
    d = fitz.open(pdf)
    r = d[0].rect
    w, h = sorted((r.width * 25.4 / 72, r.height * 25.4 / 72))
    name = "A4" if abs(w - 210) < 3 and abs(h - 297) < 3 else "Letter" if abs(w - 216) < 3 and abs(h - 279) < 3 else ""
    return "%d×%d 毫米%s" % (round(w), round(h), "（" + name + "）" if name else "")

if P["merge"] and len(results) > 1:
    new = fitz.open()
    order = []
    for stem, pdf, extra, label in results:
        d = fitz.open(pdf)
        new.insert_pdf(d)
        order.append("%s（%d 页）" % (label, len(d)))
    name = uniq((P.get("out_name") or "合并") + ".pdf")
    path = os.path.join("out", name)
    new.save(path, garbage=3, deflate=True)
    print("OK %s | %d 页 | %s | 共合并 %d 个文件" % (name, len(new), human(os.path.getsize(path)), len(results)))
    print("NOTE 合并顺序：" + " → ".join(order))
else:
    for stem, pdf, extra, label in results:
        name = uniq(stem + ".pdf")
        path = os.path.join("out", name)
        shutil.copyfile(pdf, path)
        d = fitz.open(path)
        bits = [b for b in (page_size_text(path), fonts_note(path), extra) if b]
        print("OK %s | %d 页 | %s | %s" % (name, len(d), human(os.path.getsize(path)), "；".join(bits)))
for f in failed:
    print("NOTE 没转成：" + f)
print("用时 %d 秒" % round(time.time() - T0))
`.replace("%IMAGES%", JSON.stringify(IMAGES));

// Documents written on Windows or macOS name fonts the machine does not have (宋体, 微软雅黑, PingFang…), and
// fontconfig's own fallback picks the Hong Kong glyph set. This maps them to the Simplified Chinese Noto fonts.
const FONT_ALIASES: [string, string[]][] = [
  ["Noto Serif CJK SC", ["serif", "SimSun", "宋体", "NSimSun", "新宋体", "STSong", "华文宋体", "Songti SC", "FangSong", "仿宋", "KaiTi", "楷体", "STKaiti"]],
  ["Noto Sans CJK SC", ["sans-serif", "Microsoft YaHei", "微软雅黑", "SimHei", "黑体", "PingFang SC", "苹方-简", "STHeiti", "华文黑体", "Heiti SC", "DengXian", "等线"]],
  ["Noto Sans Mono CJK SC", ["monospace"]],
];
const FONT_CONF = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>` +
  FONT_ALIASES.map(([to, from]) => from.map(f => `<alias><family>${f}</family><prefer><family>${to}</family></prefer></alias>`).join("")).join("") + `</fontconfig>`;
export const FONT_SETUP = `if [ "$(id -u)" = 0 ] && [ -d /etc/fonts/conf.d ] && [ ! -f /etc/fonts/conf.d/09-cjk-sc.conf ]; then printf '%s' ${sh(FONT_CONF)} > /etc/fonts/conf.d/09-cjk-sc.conf && fc-cache -f >/dev/null 2>&1; fi; true`;

const skill: Skill = {
  name: "doc-to-pdf",
  title: "文档转 PDF",
  when: "把 Word、Excel、PowerPoint、WPS 另存的 docx/xlsx/pptx、OpenDocument、RTF、HTML、Markdown、纯文本、图片转成 PDF 时用，中文正常显示。给几个文件就得到几个 PDF；要合成一个 PDF 就把 merge 设为 true，顺序按给文件的顺序；几张图片默认拼成一个 PDF。已经是 PDF 的合并、拆分用 pdf-tools。",
  args: {
    merge: { type: "boolean", description: "多个文件时，是否把结果合成一个 PDF（按给文件的顺序），默认 false，每个文件各出一个 PDF" },
    output_name: { type: "string", description: "合并后的文件名（不用写 .pdf），默认“合并”" },
    page_size: { type: "string", enum: ["a4", "fit"], description: "图片转 PDF 的页面：a4（默认，居中缩放进 A4，横图自动横放）或 fit（页面和图片一样大）" },
    margin_mm: { type: "integer", description: "图片在 A4 上的页边距（毫米），0 到 40，默认 10" },
    separate_images: { type: "boolean", description: "给了多张图片时，默认拼成一个 PDF（一张图一页）；设为 true 则每张图各出一个 PDF" },
    fit_width: { type: "boolean", description: "xlsx 表格是否调成每页一整宽，避免宽表被切成左右几页，默认 true（含图表的表格不动）" },
  },
  files: { min: 1, max: 20, extensions: [...OFFICE, ...OTHER, ...IMAGES], what: "Word/Excel/PPT/OpenDocument/RTF/HTML/Markdown/纯文本/图片，可以混着给，顺序有意义（合并和图片页序都按它）" },
  packs: ["office"],
  timeoutSeconds: 480,
  commands(args: SkillArgs, files) {
    const names = files.map(f => f.name);
    if (!names.length) throw new Error("要给至少一个要转的文件");
    const known = new Set([...OFFICE, ...OTHER, ...IMAGES]);
    const bad = names.filter(n => !known.has(ext(n)));
    if (bad.length) throw new Error(bad.join("、") + " 不是能转的格式；能转的有 Word、Excel、PowerPoint、OpenDocument、RTF、HTML、Markdown、txt 和常见图片（PDF 本身不用转）");
    const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
    const bool = (v: any, def: boolean) => (v === undefined || v === null || v === "" ? def : v === true || /^(true|yes|1|是)$/i.test(String(v)));
    let margin = 10;
    if (has("margin_mm")) {
      margin = Number(args.margin_mm);
      if (!Number.isInteger(margin) || margin < 0 || margin > 40) throw new Error("页边距要在 0 到 40 毫米之间的整数");
    }
    const size = has("page_size") ? String(args.page_size).toLowerCase() : "a4";
    if (!["a4", "fit"].includes(size)) throw new Error("页面大小只能是 a4 或 fit");
    const merge = bool(args.merge, false);
    const p = {
      files: names, merge, out_name: has("output_name") ? cleanName(args.output_name, "合并") : "合并",
      page_size: size, margin_mm: margin, separate_images: bool(args.separate_images, false), fit_width: bool(args.fit_width, true),
      budget: 400,
    };
    return [FONT_SETUP, PY_SETUP, ...pyRun(".skill_doc_to_pdf.py", PY_COMMON + PY_IMG + SCRIPT, p)];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const r: Record<string, any> = {};
    const oks = lines.filter(l => l.startsWith("OK "));
    if (oks.length) r.成品 = oks.slice(0, 40).map(l => l.slice(3));
    const notes = lines.filter(l => l.startsWith("NOTE ")).map(l => l.slice(5));
    if (notes.length) r.说明 = notes;
    const t = lines.find(l => /^用时 \d+ 秒$/.test(l));
    if (t) r.用时 = t.slice(3);
    return r;
  },
};
export default skill;
