// PDF toolbox: one skill, many operations (merge, split, extract, rotate, delete, compress, pages to images,
// images to PDF, encrypt, decrypt, info, watermark, page numbers). Page ranges are parsed here, before anything
// runs; the work is done by pymupdf, with ghostscript for compression. Arguments reach the script as one JSON string.
import { sh } from "./types.ts";
import type { Skill, SkillArgs } from "./types.ts";

// ---------- page ranges ----------

export type Range = { a: number; b: number | null; t: string };

/** "1-3,7,10-" → [{a:1,b:3},{a:7,b:7},{a:10,b:null}]; null end means "to the last page". Throws a Chinese error. */
export function parseRanges(spec: unknown, label = "页码"): Range[] {
  const raw = String(spec ?? "");
  if (/[\x00-\x08\x0b-\x1f]/.test(raw)) throw new Error(label + "里有看不懂的字符");
  const s = raw.normalize("NFKC").replace(/[第页頁]/g, "").replace(/[–—~到至]/g, "-").replace(/\s*-\s*/g, "-").trim();
  if (!s) throw new Error(label + "不能为空，写法像 1-3,7,10-");
  const tokens = s.split(/[,，、;；\s]+/).filter(Boolean);
  if (!tokens.length) throw new Error(label + "不能为空，写法像 1-3,7,10-");
  if (tokens.length > 200) throw new Error(label + "写了 " + tokens.length + " 段，太多了，最多 200 段");
  return tokens.map(t => {
    const m = t.match(/^(\d{1,5})(?:(-)(\d{1,5}|end|last|末)?)?$/i);
    if (!m) throw new Error(label + "“" + t.slice(0, 20) + "”看不懂，写法像 1-3,7,10-（10- 表示第 10 页到最后一页）");
    const a = Number(m[1]);
    const b = m[2] ? (m[3] && /^\d/.test(m[3]) ? Number(m[3]) : null) : a;
    if (a < 1) throw new Error(label + "从 1 开始数，不能写 " + a);
    if (b !== null && b < a) throw new Error(label + "“" + t + "”的起页比止页大");
    return { a, b, t };
  });
}

// ---------- shared pieces for the PDF skills ----------

/** Picks the Python of the cloud computer (or $PYTHON on a dev machine) and checks pymupdf is there. */
export const PY_SETUP = [
  `PY=/opt/py/bin/python; [ -x "$PY" ] || PY=\${PYTHON:-python3}`,
  `"$PY" -c "import pymupdf" 2>/dev/null || "$PY" -c "import fitz" 2>/dev/null || { echo "错误：云电脑里没有 pymupdf，办公工具包没装好" >&2; exit 1; }`,
].join("\n");

/** Writes a Python file from quoted heredocs (several commands when it is long: no single command gets very big)
 *  and runs it with the JSON parameters as its only argument. */
export function pyRun(file: string, source: string, params: unknown, chunkBytes = 12000): string[] {
  const lines = source.replace(/\n$/, "").split("\n"), chunks: string[] = [];
  let cur: string[] = [], size = 0;
  for (const l of lines) {
    const n = new TextEncoder().encode(l).length + 1;
    if (size + n > chunkBytes && cur.length) { chunks.push(cur.join("\n")); cur = []; size = 0; }
    cur.push(l); size += n;
  }
  chunks.push(cur.join("\n"));
  const py = `PY=/opt/py/bin/python; [ -x "$PY" ] || PY=\${PYTHON:-python3}`;
  return [
    ...chunks.map((c, i) => [...(i === 0 ? [py, "mkdir -p out work"] : []), `cat ${i === 0 ? ">" : ">>"} ${file} <<'PYEOF'`, c, "PYEOF"].join("\n")),
    [py, `PYTHONUTF8=1 "$PY" ${file} ${sh(JSON.stringify(params))}`].join("\n"),
  ];
}

export const cleanName = (s: unknown, fallback: string) => {
  let t = String(s ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f\s'"`$!&;|<>(){}\[\]*?#~:\\/]+/gu, "_").replace(/_+/g, "_").replace(/^[._\-]+|[._\-]+$/g, "");
  t = t.replace(/\.pdf$/i, "").replace(/^[._\-]+|[._\-]+$/g, "");
  return [...t].slice(0, 60).join("") || fallback;
};

export const PY_COMMON = String.raw`import sys, os, json, re, io, subprocess, shutil, math, time, glob
try:
    import pymupdf as fitz
except ImportError:
    import fitz
try:
    fitz.TOOLS.mupdf_display_errors(False)
except Exception:
    pass
P = json.loads(sys.argv[1])
FILES = P.get("files", [])
PW = P.get("password") or None
T0 = time.time()
os.makedirs("out", exist_ok=True)

def die(msg):
    sys.stderr.write("错误：" + msg + "\n")
    sys.exit(1)

def human(n):
    if n >= 1048576:
        return "%.1f MB" % (n / 1048576)
    if n >= 1024:
        return "%d KB" % round(n / 1024)
    return "%d 字节" % n

def stem_of(name):
    return os.path.splitext(name)[0]

def uniq(name):
    base, ext = os.path.splitext(name)
    cand, k = name, 2
    while os.path.exists(os.path.join("out", cand)):
        cand = "%s-%d%s" % (base, k, ext)
        k += 1
    return cand

def run(cmd, timeout):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        o, e = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, 9)
        except Exception:
            pass
        try:
            p.communicate(timeout=5)
        except Exception:
            pass
        return None, "", ""
    return p.returncode, o.decode("utf-8", "replace"), e.decode("utf-8", "replace")

def open_pdf(path, pw=None, label=None):
    label = label or os.path.basename(path)
    try:
        d = fitz.open(path)
    except Exception:
        die("打不开 %s，文件可能损坏，或者根本不是 PDF" % label)
    if d.needs_pass:
        if not pw:
            die("%s 有打开密码，要在 password 里给出密码" % label)
        if not d.authenticate(pw):
            die("密码不对，打不开 %s" % label)
    if len(d) == 0:
        die("%s 里一页都没有" % label)
    return d

def span_text(a, b, n):
    return str(a) if a == b else "%d-%d" % (a, b)

def pages_of(ranges, n):
    out = []
    for a, b, t in ranges:
        e = n if b is None else b
        if a > n or e > n:
            die("这份 PDF 只有 %d 页，页码“%s”超出了范围" % (n, t))
        out.extend(range(a, e + 1))
    return out

def build(src, pages):
    new = fitz.open()
    i = 0
    while i < len(pages):
        j = i
        while j + 1 < len(pages) and pages[j + 1] == pages[j] + 1:
            j += 1
        new.insert_pdf(src, from_page=pages[i] - 1, to_page=pages[j] - 1)
        i = j + 1
    try:
        md = src.metadata or {}
        new.set_metadata({k: md[k] for k in ("title", "author", "subject", "keywords") if md.get(k)})
    except Exception:
        pass
    return new

def save(doc, name, note=""):
    name = uniq(name)
    path = os.path.join("out", name)
    doc.save(path, garbage=3, deflate=True, encryption=fitz.PDF_ENCRYPT_NONE)
    print("OK %s | %d 页 | %s%s" % (name, len(doc), human(os.path.getsize(path)), (" | " + note) if note else ""))
    return path
`;

/** Image files to PDF pages with Pillow and pymupdf: A4 with margin, or a page as big as the picture. */
export const PY_IMG = String.raw`
A4 = (595.276, 841.89)

def load_frames(path):
    from PIL import Image, ImageOps, ImageSequence
    try:
        im = Image.open(path)
        fmt = (im.format or "").upper()
        raw = None
        if fmt == "JPEG" and im.mode in ("RGB", "L") and im.getexif().get(274, 1) in (0, 1):
            with open(path, "rb") as fh:
                raw = fh.read()
        dpi = im.info.get("dpi")
        try:
            dpi = float(dpi[0]) if dpi else None
        except Exception:
            dpi = None
        if dpi is not None and not (36 <= dpi <= 1200):
            dpi = None
        frames = list(ImageSequence.Iterator(im))[:50] if fmt == "TIFF" else [im]
        out = []
        for k, fr in enumerate(frames):
            fr.load()
            fr = ImageOps.exif_transpose(fr)
            if fr.mode in ("RGBA", "LA", "P"):
                rgba = fr.convert("RGBA")
                bg = Image.new("RGB", rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.split()[3])
                fr = bg
                raw_k = None
            elif fr.mode not in ("RGB", "L"):
                fr = fr.convert("RGB")
                raw_k = None
            else:
                raw_k = raw if k == 0 else None
            if raw_k is None:
                buf = io.BytesIO()
                fr.save(buf, "PNG")
                raw_k = buf.getvalue()
            out.append((fr.size, raw_k, dpi))
        return out
    except Exception:
        die("图片 %s 打不开，可能已损坏" % os.path.basename(path))

def images_to_pdf(paths, size="a4", margin_mm=10, fit_dpi=None):
    doc = fitz.open()
    mg = margin_mm * 72 / 25.4
    for p in paths:
        for (w, h), data, dpi in load_frames(p):
            if size == "fit":
                d = fit_dpi or dpi or 150
                pw, ph = w * 72.0 / d, h * 72.0 / d
                k = min(1.0, 14400.0 / max(pw, ph))
                page = doc.new_page(width=max(pw * k, 36), height=max(ph * k, 36))
                rect = page.rect
            else:
                pw, ph = A4 if h >= w else (A4[1], A4[0])
                page = doc.new_page(width=pw, height=ph)
                box = fitz.Rect(mg, mg, pw - mg, ph - mg)
                sc = min(box.width / w, box.height / h, 1.0)
                cx, cy = pw / 2, ph / 2
                rect = fitz.Rect(cx - w * sc / 2, cy - h * sc / 2, cx + w * sc / 2, cy + h * sc / 2)
            page.insert_image(rect, stream=data)
    return doc
`;

// ---------- the skill ----------

const OPS = ["merge", "split", "extract", "rotate", "delete", "compress", "to_images", "from_images", "encrypt", "decrypt", "info", "watermark", "page_numbers"];
const IMG_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const POSITIONS = ["bottom_center", "bottom_right", "bottom_left", "top_center", "top_right", "top_left"];
const ext = (n: string) => (n.match(/\.([^./\\]+)$/)?.[1] || "").toLowerCase();

const SCRIPT = String.raw`
import glob
OP = P["op"]

def path_in(i=0):
    return os.path.join("in", FILES[i])

def need_pages(doc):
    n = len(doc)
    return pages_of(P["ranges"], n) if P.get("ranges") else list(range(1, n + 1))

def groups(pages):
    out, i = [], 0
    while i < len(pages):
        j = i
        while j + 1 < len(pages) and pages[j + 1] == pages[j] + 1:
            j += 1
        out.append((pages[i], pages[j]))
        i = j + 1
    return out

def label_of(pages):
    parts = [span_text(a, b, 0) for a, b in groups(pages)]
    t = "_".join(parts)
    return "第" + (t if len(t) <= 40 else "%d-%d等%d页" % (pages[0], pages[-1], len(pages))) + "页"

# ---- fonts and stamps (watermark, page numbers)
_FONT = {}
def font_at(size):
    from PIL import ImageFont
    size = max(4, int(size))
    if "spec" not in _FONT:
        pats = ["/usr/share/fonts/**/NotoSansCJK*-Regular.ttc", "/usr/share/fonts/**/NotoSansCJK*.ttc", "/usr/share/fonts/**/NotoSansCJK*.otf", "/usr/share/fonts/**/*CJK*",
                "/usr/share/fonts/**/wqy*", "/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"]
        spec = None
        for pat in pats:
            for p in sorted(glob.glob(pat, recursive=True)):
                if p.lower().endswith((".ttc", ".otc")):
                    first = None
                    for i in range(12):
                        try:
                            f = ImageFont.truetype(p, 20, index=i)
                        except Exception:
                            break
                        if first is None:
                            first = (p, i)
                        name = " ".join(f.getname())
                        if re.search(r"\bSC\b|CN|Hei|Gothic|GB", name):
                            spec = (p, i)
                            break
                    spec = spec or first
                else:
                    spec = (p, 0)
                if spec:
                    break
            if spec:
                break
        _FONT["spec"] = spec
    spec = _FONT["spec"]
    if spec is None:
        return ImageFont.load_default(size), False
    return ImageFont.truetype(spec[0], size, index=spec[1]), True

def stamp_png(text, pt, S, rgba, angle, page_rot):
    from PIL import Image, ImageDraw
    f, has_cjk = font_at(pt * S)
    if not has_cjk and re.search(r"[^\x00-\x7f]", text):
        die("云电脑里没找到中文字体，文字先用英文或数字")
    probe = ImageDraw.Draw(Image.new("L", (4, 4)))
    l, t, r, b = probe.textbbox((0, 0), text, font=f)
    pad = int(pt * S * 0.25)
    im = Image.new("RGBA", (r - l + 2 * pad, b - t + 2 * pad), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((pad - l, pad - t), text, font=f, fill=rgba)
    if angle:
        im = im.rotate(angle, expand=True, resample=Image.BICUBIC)
    view = (im.width / S, im.height / S)
    if page_rot:
        im = im.rotate(page_rot, expand=True, resample=Image.BICUBIC)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue(), view

def text_width_pt(text, pt):
    from PIL import ImageDraw, Image
    f, _ = font_at(100)
    probe = ImageDraw.Draw(Image.new("L", (4, 4)))
    return probe.textlength(text, font=f) * pt / 100.0

def put(page, png, view, cx, cy):
    r = fitz.Rect(cx - view[0] / 2, cy - view[1] / 2, cx + view[0] / 2, cy + view[1] / 2)
    if page.rotation:
        r = r * page.derotation_matrix
        r.normalize()
    page.insert_image(r, stream=png, overlay=True)

# ---- operations
def op_merge():
    if len(FILES) < 2:
        die("合并至少要 2 个 PDF")
    new = fitz.open()
    order = []
    for k, nm in enumerate(FILES):
        d = open_pdf(path_in(k), PW, nm)
        new.insert_pdf(d)
        order.append("%s（%d 页）" % (nm, len(d)))
        d.close()
    save(new, (P.get("out_name") or "合并") + ".pdf", "共 %d 个文件" % len(FILES))
    print("NOTE 合并顺序：" + " → ".join(order))

def op_split():
    src = open_pdf(path_in(), PW, FILES[0])
    n = len(src)
    stem = stem_of(FILES[0])
    jobs = []
    if P.get("ranges"):
        for a, b, t in P["ranges"]:
            pg = pages_of([(a, b, t)], n)
            jobs.append(pg)
    elif P.get("every"):
        k = P["every"]
        jobs = [list(range(i, min(i + k, n + 1))) for i in range(1, n + 1, k)]
    else:
        jobs = [[i] for i in range(1, n + 1)]
    if len(jobs) > 300:
        die("会拆成 %d 个文件，太多了（最多 300 个），请加大每份的页数" % len(jobs))
    width = len(str(len(jobs)))
    for idx, pg in enumerate(jobs, 1):
        new = build(src, pg)
        if P.get("ranges"):
            name = "%s_%s.pdf" % (stem, label_of(pg))
        elif P.get("every"):
            name = "%s_第%0*d份_%s.pdf" % (stem, width, idx, label_of(pg))
        else:
            name = "%s_第%0*d页.pdf" % (stem, len(str(n)), pg[0])
        save(new, name)
        new.close()
    print("NOTE 原文件 %d 页，拆成 %d 个文件" % (n, len(jobs)))

def op_extract():
    src = open_pdf(path_in(), PW, FILES[0])
    pg = pages_of(P["ranges"], len(src))
    save(build(src, pg), "%s_%s.pdf" % (stem_of(FILES[0]), label_of(pg)), "从 %d 页里取出 %d 页，按你写的顺序排" % (len(src), len(pg)))

def op_delete():
    src = open_pdf(path_in(), PW, FILES[0])
    n = len(src)
    gone = set(pages_of(P["ranges"], n))
    keep = [i for i in range(1, n + 1) if i not in gone]
    if not keep:
        die("这样会把 %d 页全删光，至少要留一页" % n)
    save(build(src, keep), stem_of(FILES[0]) + "_删页后.pdf", "原来 %d 页，删掉 %d 页" % (n, len(gone)))

def op_rotate():
    src = open_pdf(path_in(), PW, FILES[0])
    sel = need_pages(src)
    for pn in sel:
        pg = src[pn - 1]
        pg.set_rotation((pg.rotation + P["angle"]) % 360)
    save(src, stem_of(FILES[0]) + "_旋转.pdf", "%d 页顺时针转了 %d 度" % (len(sel), P["angle"]))

def op_compress():
    path = path_in()
    orig = os.path.getsize(path)
    src = open_pdf(path, PW, FILES[0])
    n = len(src)
    base = os.path.join("work", "base.pdf")
    src.save(base, garbage=4, deflate=True, encryption=fitz.PDF_ENCRYPT_NONE)
    cands = [("整理结构", base, os.path.getsize(base))]
    gs = shutil.which("gs")
    preset = P["level"]
    if gs:
        gout = os.path.join("work", "gs.pdf")
        rc, o, e = run([gs, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dPDFSETTINGS=/" + preset, "-dNOPAUSE", "-dQUIET", "-dBATCH", "-dSAFER", "-sOutputFile=" + gout, base], 420)
        if rc is None:
            print("NOTE 图片压缩那一步超时了，只做了结构整理")
        elif rc == 0 and os.path.exists(gout) and os.path.getsize(gout) > 0:
            chk = fitz.open(gout)
            if len(chk) == n:
                cands.append(("图片重新压缩（" + preset + "）", gout, os.path.getsize(gout)))
        else:
            print("NOTE 图片压缩没成功，只做了结构整理")
    else:
        print("NOTE 云电脑里没有 ghostscript，只做了结构整理")
    best = min(cands, key=lambda c: c[2])
    pct = round((1 - best[2] / orig) * 100) if orig else 0
    if best[2] < orig * 0.97:
        name = uniq(stem_of(FILES[0]) + "_压缩.pdf")
        shutil.copyfile(best[1], os.path.join("out", name))
        print("OK %s | %d 页 | %s | 原来 %s，现在 %s，小了 %d%%，方法：%s" % (name, n, human(best[2]), human(orig), human(best[2]), pct, best[0]))
    else:
        print("NOTE 没压小：原来 %s，试出来最小也有 %s。这份 PDF 已经很精简，或者里面是压不动的内容，所以没有输出新文件" % (human(orig), human(best[2])))

def op_to_images():
    src = open_pdf(path_in(), PW, FILES[0])
    sel = need_pages(src)
    dpi, fmt = P["dpi"], P["image_format"]
    if len(sel) > 150:
        die("要转 %d 页，太多了（一次最多 150 页），请用 pages 分批" % len(sel))
    stem = stem_of(FILES[0])
    width = len(str(len(src)))
    total = 0
    for pn in sel:
        pg = src[pn - 1]
        mp = pg.rect.width * pg.rect.height * (dpi / 72.0) ** 2 / 1e6
        if mp > 90:
            die("第 %d 页在 %d dpi 下有 %d 百万像素，云电脑装不下，请把 dpi 调低" % (pn, dpi, mp))
        pix = pg.get_pixmap(dpi=dpi, alpha=False)
        name = uniq("%s_第%0*d页.%s" % (stem, width, pn, "png" if fmt == "png" else "jpg"))
        out = os.path.join("out", name)
        if fmt == "png":
            pix.save(out)
        else:
            pix.save(out, jpg_quality=88)
        total += os.path.getsize(out)
        last = (pix.width, pix.height)
    print("NOTE %d 页转成 %s 图片，%d dpi，每张约 %d×%d 像素，共 %s" % (len(sel), fmt.upper(), dpi, last[0], last[1], human(total)))

def op_from_images():
    paths = [path_in(i) for i in range(len(FILES))]
    doc = images_to_pdf(paths, P["page_size"], P["margin_mm"])
    save(doc, (P.get("out_name") or stem_of(FILES[0])) + ".pdf", "%d 张图，页面%s" % (len(FILES), "按图片大小" if P["page_size"] == "fit" else "A4"))

def op_encrypt():
    src = open_pdf(path_in(), P.get("open_password"), FILES[0])
    name = uniq(stem_of(FILES[0]) + "_已加密.pdf")
    path = os.path.join("out", name)
    pw = P["new_password"]
    src.save(path, garbage=3, deflate=True, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw=pw, owner_pw=pw)
    chk = fitz.open(path)
    if not (chk.needs_pass and chk.authenticate(pw)):
        die("加密后复查没通过，文件没有交付")
    print("OK %s | %d 页 | %s | AES-256 加密，打开时要输入你设的密码；复查过：没密码打不开，输入后能打开" % (name, len(src), human(os.path.getsize(path))))

def op_decrypt():
    path = path_in()
    try:
        d = fitz.open(path)
    except Exception:
        die("打不开 %s，文件可能损坏，或者根本不是 PDF" % FILES[0])
    if not d.is_encrypted:
        print("NOTE 这份 PDF 本来就没有密码，原样给你")
        shutil.copyfile(path, os.path.join("out", uniq(FILES[0])))
        print("OK %s | %d 页 | %s" % (FILES[0], len(d), human(os.path.getsize(path))))
        return
    if d.needs_pass:
        if not PW:
            die("要在 password 里给出这份 PDF 的密码")
        if not d.authenticate(PW):
            die("密码不对，解不开")
    save(d, stem_of(FILES[0]) + "_已解密.pdf", "已去掉密码和权限限制")

def op_info():
    path = path_in()
    try:
        d = fitz.open(path)
    except Exception:
        die("打不开 %s，文件可能损坏，或者根本不是 PDF" % FILES[0])
    info = {"文件": FILES[0], "大小": human(os.path.getsize(path))}
    if d.needs_pass and not (PW and d.authenticate(PW)):
        info["加密"] = "有打开密码，" + ("给的密码不对" if PW else "没给密码，看不了页数和内容")
        print("INFO " + json.dumps(info, ensure_ascii=False))
        return
    n = len(d)
    md = d.metadata or {}
    info["页数"] = n
    info["加密"] = "有（已用密码打开）" if d.needs_pass or d.is_encrypted else "无"
    sizes = {}
    for pg in d:
        w, h = pg.rect.width * 25.4 / 72, pg.rect.height * 25.4 / 72
        key = (round(min(w, h)), round(max(w, h)))
        sizes[key] = sizes.get(key, 0) + 1
    def nm(k):
        for t, (a, b) in (("A3", (297, 420)), ("A4", (210, 297)), ("A5", (148, 210)), ("Letter", (216, 279)), ("Legal", (216, 356))):
            if abs(k[0] - a) <= 2 and abs(k[1] - b) <= 2:
                return t
        return ""
    top = sorted(sizes.items(), key=lambda kv: -kv[1])
    info["页面尺寸"] = "；".join("%d×%d 毫米%s%s" % (k[0], k[1], "（" + nm(k) + "）" if nm(k) else "", "" if len(top) == 1 else " 共 %d 页" % c) for k, c in top[:3]) + ("" if len(top) <= 3 else " 等")
    for key, cn in (("title", "标题"), ("author", "作者"), ("creator", "制作软件"), ("producer", "转换工具"), ("creationDate", "创建时间")):
        if md.get(key):
            info[cn] = str(md[key])[:80]
    if md.get("format"):
        info["PDF 版本"] = md["format"]
    k = min(n, 10)
    idx = sorted(set(round(i * (n - 1) / (k - 1)) for i in range(k))) if k > 1 else [0]
    has = sum(1 for i in idx if len(re.sub(r"\s", "", d[i].get_text())) >= 20)
    imgs = sum(1 for i in idx if d[i].get_images())
    info["文字层"] = ("有，可以选中复制" if has == len(idx) else "没有，是扫描件或纯图片，要先用 pdf-ocr 识别" if has == 0 else "部分页有（抽查 %d 页，%d 页有文字）" % (len(idx), has)) if n else "无"
    info["抽查页含图片"] = "%d/%d" % (imgs, len(idx))
    toc = d.get_toc()
    if toc:
        info["书签"] = len(toc)
    print("INFO " + json.dumps(info, ensure_ascii=False))

def op_watermark():
    src = open_pdf(path_in(), PW, FILES[0])
    sel = need_pages(src)
    text = P["text"]
    cache = {}
    for pn in sel:
        pg = src[pn - 1]
        r = pg.rect
        key = (round(r.width), round(r.height), pg.rotation)
        if key not in cache:
            short = min(r.width, r.height)
            pt = min(short * 0.13, short * 1.06 * 100.0 / max(text_width_pt(text, 100), 1))
            cache[key] = stamp_png(text, max(pt, 8), 4, (128, 128, 128, 85), 45, pg.rotation)
        png, view = cache[key]
        put(pg, png, view, r.x0 + r.width / 2, r.y0 + r.height / 2)
    save(src, stem_of(FILES[0]) + "_水印.pdf", "%d 页加了斜向浅灰水印“%s”" % (len(sel), text))

def op_page_numbers():
    src = open_pdf(path_in(), PW, FILES[0])
    n = len(src)
    sel = need_pages(src)
    pos, pt = P["position"], P["font_size"]
    for pn in sel:
        pg = src[pn - 1]
        r = pg.rect
        shown = P["number_style"].replace("{n}", str(pn + P["start"] - 1)).replace("{total}", str(n + P["start"] - 1))
        png, view = stamp_png(shown, pt, 6, (70, 70, 70, 255), 0, pg.rotation)
        side = pos.split("_")[1]
        cx = r.x0 + (r.width / 2 if side == "center" else 36 + view[0] / 2 if side == "left" else r.width - 36 - view[0] / 2)
        cy = r.y0 + (r.height - 22 - view[1] / 2 if pos.startswith("bottom") else 22 + view[1] / 2)
        put(pg, png, view, cx, cy)
    save(src, stem_of(FILES[0]) + "_加页码.pdf", "%d 页加了页码，样式“%s”" % (len(sel), P["number_style"]))

OPS = {"merge": op_merge, "split": op_split, "extract": op_extract, "rotate": op_rotate, "delete": op_delete, "compress": op_compress,
       "to_images": op_to_images, "from_images": op_from_images, "encrypt": op_encrypt, "decrypt": op_decrypt, "info": op_info,
       "watermark": op_watermark, "page_numbers": op_page_numbers}
try:
    OPS[OP]()
except SystemExit:
    raise
except Exception as e:
    msg = str(e).replace("\n", " ")[:160]
    die("处理时出了意外（%s：%s）" % (type(e).__name__, msg))
print("用时 %d 秒" % round(time.time() - T0))
`;

const num = (v: any, label: string, lo: number, hi: number, def: number, integer = true) => {
  if (v === undefined || v === null || v === "") return def;
  const x = Number(v);
  if (!Number.isFinite(x) || (integer && !Number.isInteger(x)) || x < lo || x > hi) throw new Error(label + "要在 " + lo + " 到 " + hi + " 之间" + (integer ? "的整数" : ""));
  return x;
};
const pw = (v: any, label: string) => {
  const s = String(v ?? "");
  if (!s) throw new Error(label + "不能是空的");
  if (s.length > 100 || /[\x00-\x1f\x7f]/.test(s)) throw new Error(label + "最长 100 个字符，不能带换行等控制字符");
  return s;
};

const skill: Skill = {
  name: "pdf-tools",
  title: "PDF 工具箱",
  when: "对 PDF 做常规处理时用：合并、拆分、摘取或删除某几页、旋转、压缩体积、转成图片、图片拼成 PDF、加密/解密、看信息（页数、有没有文字层）、加水印、加页码。用 op 选操作。扫描件识别文字用 pdf-ocr，PDF 转 Word 用 pdf-to-docx。",
  args: {
    op: { type: "string", enum: OPS, description: "操作：merge 合并（按给文件的顺序）；split 拆分；extract 摘出几页成一个新 PDF；rotate 旋转；delete 删页；compress 压缩；to_images 每页转图片；from_images 图片拼成 PDF；encrypt 加密；decrypt 解密；info 看信息；watermark 加水印；page_numbers 加页码" },
    pages: { type: "string", description: "页码范围，如 1-3,7,10-（10- 是第 10 页到最后）。extract、delete 必填，按写的顺序摘取；split 里每段范围拆成一个文件；rotate、to_images、watermark、page_numbers 不填就是全部页" },
    every: { type: "integer", description: "split 用：每 N 页拆一个文件（1 到 1000）。split 在 pages、every、each_page 里三选一" },
    each_page: { type: "boolean", description: "split 用：每页单独一个文件" },
    angle: { type: "integer", description: "rotate 用：顺时针转的角度，90、180 或 270（-90 等于 270）" },
    level: { type: "string", enum: ["screen", "ebook", "printer"], description: "compress 用：screen 最小（图片约 72 dpi，适合手机看）；ebook 默认（约 150 dpi）；printer 较大（约 300 dpi，适合打印）" },
    dpi: { type: "integer", description: "to_images 用：分辨率，36 到 600，默认 150（屏幕看够了，打印用 300）" },
    image_format: { type: "string", enum: ["png", "jpg"], description: "to_images 用：png（默认，清晰）或 jpg（体积小）" },
    password: { type: "string", description: "encrypt：要设置的打开密码（必填）；decrypt：这份 PDF 现有的密码（必填）；其他操作：如果 PDF 本身有密码，在这里给出才能处理" },
    open_password: { type: "string", description: "encrypt 用：如果原 PDF 本身已有密码，这里给原密码" },
    text: { type: "string", description: "watermark 用：水印文字，可以是中文，最多 40 个字，斜着印在每页中间，浅灰色" },
    number_style: { type: "string", description: "page_numbers 用：页码样式，{n} 是当前页码，{total} 是总页数，默认 {n} / {total}，也可以写 第 {n} 页" },
    position: { type: "string", enum: POSITIONS, description: "page_numbers 用：位置，默认 bottom_center（底部居中）" },
    start: { type: "integer", description: "page_numbers 用：第一页显示的页码，默认 1。给了 pages 时页码仍按原来的页序走，只在选中的页上印" },
    font_size: { type: "integer", description: "page_numbers 用：字号（磅），6 到 36，默认 10" },
    page_size: { type: "string", enum: ["a4", "fit"], description: "from_images 用：a4（默认，图片居中缩放进 A4，横图自动横放）或 fit（页面和图片一样大）" },
    margin_mm: { type: "integer", description: "from_images 用：A4 页边距（毫米），0 到 40，默认 10" },
    output_name: { type: "string", description: "merge、from_images 用：结果文件名（不用写 .pdf），默认“合并”或第一张图的名字" },
  },
  required: ["op"],
  files: { min: 1, max: 30, extensions: ["pdf", ...IMG_EXT], what: "merge 要 2 个以上 PDF（顺序就是合并顺序）；from_images 要 1 张以上图片（顺序就是页序）；其他操作只要 1 个 PDF" },
  packs: ["office"],
  timeoutSeconds: 480,
  commands(args: SkillArgs, files) {
    const op = String(args.op ?? "").trim();
    if (!OPS.includes(op)) throw new Error("op 只能是：" + OPS.join("、"));
    const names = files.map(f => f.name);
    const isImg = (n: string) => IMG_EXT.includes(ext(n));
    if (op === "from_images") {
      if (!names.length) throw new Error("图片拼 PDF 要给 1 张以上图片");
      const bad = names.filter(n => !isImg(n));
      if (bad.length) throw new Error("from_images 只收图片（" + IMG_EXT.join("、") + "），" + bad.join("、") + " 不是");
    } else if (op === "merge") {
      if (names.length < 2) throw new Error("合并要 2 个以上 PDF，现在只有 " + names.length + " 个");
      const bad = names.filter(n => ext(n) !== "pdf");
      if (bad.length) throw new Error("合并只收 PDF，" + bad.join("、") + " 不是；Word、图片等先用 doc-to-pdf 转成 PDF，或者给 doc-to-pdf 加上 merge");
    } else {
      if (names.length !== 1) throw new Error("这个操作一次只处理 1 个 PDF，现在给了 " + names.length + " 个");
      if (ext(names[0]) !== "pdf") throw new Error("这个操作要 PDF 文件，" + names[0] + " 不是；图片拼成 PDF 用 op=from_images，Word 等用 doc-to-pdf");
    }

    const p: Record<string, any> = { op, files: names };
    const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
    if (has("pages")) p.ranges = parseRanges(args.pages).map(r => [r.a, r.b, r.t]);
    if ((op === "extract" || op === "delete") && !p.ranges) throw new Error(op === "extract" ? "摘取要给 pages，比如 1-3,7" : "删页要给 pages，比如 2,5-6");
    if (has("password")) p.password = pw(args.password, "password");
    if (op === "split") {
      const modes = [has("pages"), has("every"), args.each_page === true || args.each_page === "true"].filter(Boolean).length;
      if (modes !== 1) throw new Error("拆分要在 pages（按范围）、every（每 N 页）、each_page（每页一个）里选且只选一种");
      if (has("every")) p.every = num(args.every, "每份页数 every", 1, 1000, 1);
    }
    if (op === "rotate") {
      if (!has("angle")) throw new Error("旋转要给 angle：90、180 或 270");
      const a = Number(args.angle);
      const n = a === -90 ? 270 : a;
      if (![90, 180, 270].includes(n)) throw new Error("旋转角度只能是 90、180、270（顺时针）");
      p.angle = n;
    }
    if (op === "compress") {
      const l = has("level") ? String(args.level).toLowerCase() : "ebook";
      if (!["screen", "ebook", "printer"].includes(l)) throw new Error("压缩等级只能是 screen、ebook、printer");
      p.level = l;
    }
    if (op === "to_images") {
      p.dpi = num(args.dpi, "分辨率 dpi", 36, 600, 150);
      const f = has("image_format") ? String(args.image_format).toLowerCase().replace("jpeg", "jpg") : "png";
      if (!["png", "jpg"].includes(f)) throw new Error("图片格式只能是 png 或 jpg");
      p.image_format = f;
    }
    if (op === "from_images") {
      const s = has("page_size") ? String(args.page_size).toLowerCase() : "a4";
      if (!["a4", "fit"].includes(s)) throw new Error("页面大小只能是 a4 或 fit");
      p.page_size = s;
      p.margin_mm = num(args.margin_mm, "页边距 margin_mm", 0, 40, 10);
    }
    if (op === "merge" || op === "from_images") p.out_name = has("output_name") ? cleanName(args.output_name, "") : "";
    if (op === "from_images" && !p.out_name) p.out_name = cleanName(names[0].replace(/\.[^.]+$/, ""), "图片") + (names.length > 1 ? "等" + names.length + "张" : "");
    if (op === "encrypt") {
      if (!has("password")) throw new Error("加密要给 password，也就是你想设的密码");
      p.new_password = p.password;
      delete p.password;
      if (has("open_password")) p.open_password = pw(args.open_password, "原密码 open_password");
    }
    if (op === "decrypt" && !has("password")) throw new Error("解密要给 password，也就是这份 PDF 现在的密码");
    if (op === "watermark") {
      const t = String(args.text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
      if (!t) throw new Error("水印要给 text，比如“内部资料”");
      if ([...t].length > 40) throw new Error("水印文字不要超过 40 个字");
      p.text = t;
    }
    if (op === "page_numbers") {
      const st = has("number_style") ? String(args.number_style).replace(/[\x00-\x1f\x7f]/g, " ").trim() : "{n} / {total}";
      if (!st) throw new Error("页码样式不能是空的");
      if ([...st].length > 40) throw new Error("页码样式不要超过 40 个字");
      if (!st.includes("{n}")) throw new Error("页码样式里要有 {n}，比如 第 {n} 页");
      p.number_style = st;
      const pos = has("position") ? String(args.position).toLowerCase() : "bottom_center";
      if (!POSITIONS.includes(pos)) throw new Error("位置只能是：" + POSITIONS.join("、"));
      p.position = pos;
      p.start = num(args.start, "起始页码 start", -999, 99999, 1);
      p.font_size = num(args.font_size, "字号 font_size", 6, 36, 10);
    }
    const body = PY_COMMON + PY_IMG + SCRIPT;
    return [PY_SETUP, ...pyRun(".skill_pdf_tools.py", body, p)];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const r: Record<string, any> = {};
    const oks = lines.filter(l => l.startsWith("OK "));
    if (oks.length) r.成品 = oks.slice(0, 40).map(l => l.slice(3));
    const notes = lines.filter(l => l.startsWith("NOTE ")).map(l => l.slice(5));
    if (notes.length) r.说明 = notes;
    const info = lines.find(l => l.startsWith("INFO "));
    if (info) { try { r.信息 = JSON.parse(info.slice(5)); } catch { r.信息 = info.slice(5); } }
    const t = lines.find(l => /^用时 \d+ 秒$/.test(l));
    if (t) r.用时 = t.slice(3);
    return r;
  },
};
export default skill;
