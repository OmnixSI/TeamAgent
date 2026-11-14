// OCR: a scanned PDF (or several pictures) becomes a searchable PDF plus a text file, with ocrmypdf and tesseract.
// The cloud computer has one vCPU, so the page count is checked against what fits in the time limit before any work starts.
import { sh } from "./types.ts";
import type { Skill, SkillArgs } from "./types.ts";
import { parseRanges } from "./pdf-tools.ts";

const IMG_EXT = ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"];
const TIME_LIMIT = 900;           // seconds for the whole skill run
const SECONDS_PER_PAGE = 15;      // estimate for a dense A4 page at 200 dpi, chi_sim+eng, one vCPU; not yet measured live (report() prints the real pages per minute)
const RESERVE = 90;               // start-up, image assembly, text file
export const MAX_PAGES = Math.floor((TIME_LIMIT - RESERVE) / SECONDS_PER_PAGE);

const ext = (n: string) => (n.match(/\.([^./\\]+)$/)?.[1] || "").toLowerCase();

const SCRIPT = String.raw`
import sys, os, json, re, io, subprocess, shutil, time
P = json.loads(sys.argv[1])
FILES = P["files"]
T0 = time.time()
os.makedirs("out", exist_ok=True)
os.makedirs("work", exist_ok=True)

def die(msg):
    sys.stderr.write("错误：" + msg + "\n")
    sys.exit(1)

def human(n):
    return "%.1f MB" % (n / 1048576) if n >= 1048576 else "%d KB" % round(n / 1024) if n >= 1024 else "%d 字节" % n

def run(cmd, timeout, env=None):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env=env)
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

def uniq(name):
    base, ext = os.path.splitext(name)
    cand, k = name, 2
    while os.path.exists(os.path.join("out", cand)):
        cand = "%s-%d%s" % (base, k, ext)
        k += 1
    return cand

if not shutil.which("ocrmypdf") or not shutil.which("tesseract"):
    die("云电脑里没有 ocrmypdf 或 tesseract，文字识别工具包没装好")

# languages
rc, o, e = run(["tesseract", "--list-langs"], 30)
have = set(l.strip() for l in (o + e).splitlines()[1:] if l.strip())
need = P["lang"].split("+")
miss = [l for l in need if l not in have]
if miss:
    die("云电脑里没有语言包 %s，现有的是：%s" % ("、".join(miss), "、".join(sorted(have - {"osd", "snum"}))))

DEADLINE = T0 + P["budget"]
name0 = FILES[0]
is_pdf = name0.lower().endswith(".pdf")
stem = os.path.splitext(name0)[0] + ("等%d张" % len(FILES) if not is_pdf and len(FILES) > 1 else "")
src = os.path.join("in", name0)

if is_pdf:
    try:
        import pikepdf
    except ImportError:
        pikepdf = None
    n = None
    if pikepdf:
        try:
            with pikepdf.open(src) as pdf:
                n = len(pdf.pages)
        except pikepdf.PasswordError:
            die("这份 PDF 有打开密码，先用 pdf-tools 的 decrypt 去掉密码")
        except Exception:
            die("打不开 %s，文件可能损坏，或者根本不是 PDF" % name0)
    if n is None:
        raw = open(src, "rb").read()
        n = len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", raw)) or None
    if not n:
        die("数不出这份 PDF 有几页，文件可能损坏")
else:
    from PIL import Image, ImageOps
    imgs = []
    for f in FILES:
        try:
            im = Image.open(os.path.join("in", f))
            im.load()
            im = ImageOps.exif_transpose(im)
        except Exception:
            die("图片 %s 打不开，可能已损坏" % f)
        if im.mode in ("RGBA", "LA", "P"):
            rgba = im.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[3])
            im = bg
        elif im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        if im.width * im.height > 36e6:
            k = (36e6 / (im.width * im.height)) ** 0.5
            im = im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS)
        imgs.append(im)
    n = len(imgs)
    src = os.path.join("work", "images.pdf")
    imgs[0].save(src, "PDF", save_all=True, append_images=imgs[1:], resolution=200.0, quality=92)

sel = None
if P.get("ranges"):
    sel = []
    for a, b, t in P["ranges"]:
        e = n if b is None else b
        if a > n or e > n:
            die("这份文件只有 %d 页，页码“%s”超出了范围" % (n, t))
        sel.extend(range(a, e + 1))
    sel = sorted(set(sel))
todo = len(sel) if sel is not None else n
per = P["seconds_per_page"] * (1.3 if P["deskew"] else 1.0)
maxp = int((P["budget"] - P["reserve"]) / per)
if todo > maxp:
    die("要识别 %d 页，这个技能单次限时 %d 分钟，在 1 个 CPU 上一页要 %d 秒左右，最多识别约 %d 页。请用 pages 分段，比如 1-%d" % (todo, P["budget"] // 60, per, maxp, maxp))

pdf_out = uniq(stem + "_可搜索.pdf")
txt_out = uniq(stem + "_识别文字.txt")
side = os.path.join("work", "side.txt")
cmd = ["ocrmypdf", "-l", P["lang"], "--force-ocr" if P["force"] else "--skip-text", "--output-type", "pdf", "--jobs", "1", "--optimize", "0", "--sidecar", side]
if P["deskew"]:
    cmd.append("--deskew")
if sel is not None:
    cmd += ["--pages", ",".join(str(x) for x in sel)]
cmd += [src, os.path.join("out", pdf_out)]
env = dict(os.environ)
env["OMP_THREAD_LIMIT"] = "1"
t1 = time.time()
rc, o, e = run(cmd, max(60, DEADLINE - time.time()), env)
secs = time.time() - t1
if rc is None:
    die("识别超过限时 %d 分钟，被停掉了；请用 pages 分段" % (P["budget"] // 60))
if rc != 0 or not os.path.exists(os.path.join("out", pdf_out)):
    tail = [l.strip() for l in (e or o).splitlines() if l.strip()]
    msg = tail[-1][:160] if tail else "没有更多信息"
    if rc == 6 or "already has text" in (e or ""):
        msg = "这份 PDF 本来就有文字层，没有需要识别的页（要强行重新识别，把 force 设为 true）"
    die("文字识别没成功（退出码 %s）：%s" % (rc, msg))

skipped = len(re.findall(r"skipping all processing on this page|page already has text", e or "", re.I))
text = open(side, encoding="utf-8", errors="replace").read() if os.path.exists(side) else ""
text = text.replace("[skipped page]", "")
pages_txt = [p.strip() for p in text.split("\f")]
text = "\n\n".join(p for p in pages_txt if p)
text = re.sub(r"(?<=[㐀-鿿])[ \t]+(?=[㐀-鿿])", "", text)
open(os.path.join("out", txt_out), "w", encoding="utf-8").write(text + "\n")
chars = len(re.sub(r"\s", "", text))
han = len(re.findall(r"[㐀-鿿]", text))
rate = todo / max(secs / 60.0, 0.01)
print("OK %s | %d 页 | %s | 加了文字层，可以搜索和复制" % (pdf_out, n, human(os.path.getsize(os.path.join("out", pdf_out)))))
print("OK %s | %d 个字符（不含空白），其中汉字 %d" % (txt_out, chars, han))
print("NOTE 识别了 %d 页，用了 %d 秒，约 %.1f 页/分钟；语言 %s" % (todo, round(secs), rate, P["lang"]))
if skipped:
    print("NOTE 有 %d 页本来就有文字层，已跳过（要对所有页强行重新识别，把 force 设为 true）" % skipped)
if sel is not None:
    print("NOTE 只识别了你指定的页，其余页原样保留在 PDF 里，文字文件里只有识别过的页")
if chars < 5 * todo:
    print("NOTE 识别出的文字很少，可能图片太模糊、语言选得不对，或者页面本来就没有文字")
print("用时 %d 秒" % round(time.time() - T0))
`;

const skill: Skill = {
  name: "pdf-ocr",
  title: "扫描件文字识别",
  when: "扫描版 PDF 或照片里的文字需要识别时用：得到一份能搜索、能复制文字的 PDF，外加一个纯文本文件。默认识别简体中文加英文。云电脑只有 1 个 CPU，识别慢（一页十几秒），单次最多约 " + MAX_PAGES + " 页，页数多就用 pages 分段。给多张图片会按顺序合成一个 PDF 再识别。",
  args: {
    lang: { type: "string", description: "识别语言，默认 chi_sim+eng（简体中文加英文）；只有这两种语言包，纯英文可填 eng，速度更快" },
    pages: { type: "string", description: "只对 PDF 有效：只识别这些页，如 1-3,7。其余页原样保留，文字文件里只有识别过的页" },
    deskew: { type: "boolean", description: "是否先把歪斜的页面摆正，默认 false；拍照、斜着扫的文件可以打开，会慢约三成" },
    force: { type: "boolean", description: "默认 false：已经有文字层的页会跳过；设为 true 则全部页重新识别（原来的文字层不可靠时用）" },
  },
  files: { min: 1, max: 20, extensions: ["pdf", ...IMG_EXT], what: "1 个扫描版 PDF，或者 1 张以上图片（按给的顺序成页）" },
  packs: ["ocr"],
  timeoutSeconds: TIME_LIMIT,
  commands(args: SkillArgs, files) {
    const names = files.map(f => f.name);
    if (!names.length) throw new Error("要给 1 个 PDF 或几张图片");
    const pdfs = names.filter(n => ext(n) === "pdf");
    if (pdfs.length > 1) throw new Error("一次只识别 1 个 PDF，现在给了 " + pdfs.length + " 个");
    if (pdfs.length && names.length > 1) throw new Error("PDF 和图片不能一起给，分开识别");
    const bad = names.filter(n => ext(n) !== "pdf" && !IMG_EXT.includes(ext(n)));
    if (bad.length) throw new Error(bad.join("、") + " 不是能识别的格式，能给的是 PDF 和 " + IMG_EXT.join("、") + " 图片");
    const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
    const bool = (v: any) => v === true || /^(true|1|yes|是)$/i.test(String(v ?? ""));
    const lang = has("lang") ? String(args.lang).trim() : "chi_sim+eng";
    if (!/^[a-z][a-z_]{1,11}(\+[a-z][a-z_]{1,11}){0,3}$/.test(lang)) throw new Error("语言要写成 chi_sim+eng 这样，最多 4 种，用加号连起来");
    const p: Record<string, any> = {
      files: names, lang, deskew: bool(args.deskew), force: bool(args.force),
      budget: TIME_LIMIT, reserve: RESERVE, seconds_per_page: SECONDS_PER_PAGE,
    };
    if (has("pages")) {
      if (pdfs.length === 0) throw new Error("pages 只对 PDF 有用，图片按给的顺序整个识别");
      p.ranges = parseRanges(args.pages).map(r => [r.a, r.b, r.t]);
    }
    const run = [
      // ocrmypdf is a Debian package: its own interpreter has pikepdf and Pillow.
      `OCR=$(command -v ocrmypdf || true); [ -n "$OCR" ] || { echo "错误：云电脑里没有 ocrmypdf，文字识别工具包没装好" >&2; exit 1; }`,
      `PY=$(head -1 "$OCR" | sed 's/^#!//; s/ .*//'); case "$PY" in */env) PY=$(command -v python3);; esac; [ -x "$PY" ] || PY=$(command -v python3)`,
      "mkdir -p out work",
      "cat > .skill_pdf_ocr.py <<'PYEOF'",
      SCRIPT.replace(/\n$/, ""),
      "PYEOF",
      `PYTHONUTF8=1 "$PY" .skill_pdf_ocr.py ${sh(JSON.stringify(p))}`,
    ].join("\n");
    return [run];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const r: Record<string, any> = {};
    const oks = lines.filter(l => l.startsWith("OK "));
    if (oks.length) r.成品 = oks.map(l => l.slice(3));
    const notes = lines.filter(l => l.startsWith("NOTE ")).map(l => l.slice(5));
    if (notes.length) r.说明 = notes;
    const t = lines.find(l => /^用时 \d+ 秒$/.test(l));
    if (t) r.用时 = t.slice(3);
    return r;
  },
};
export default skill;
