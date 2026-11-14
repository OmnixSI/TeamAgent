// Picture collage in the cloud computer: grid, long vertical strip, or a 3x3 split of one picture.
import { sh } from "./types.ts";
import type { Skill, SkillArgs } from "./types.ts";

const EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif"];
const MODES = ["grid", "strip", "split9"];
const FITS = ["cover", "contain"];
const OUTS = ["jpg", "png"];

const num = (a: SkillArgs, key: string, label: string, lo: number, hi: number): number | undefined => {
  const v = a[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${label}要在 ${lo} 到 ${hi} 之间`);
  return Math.round(n);
};
const pick = (a: SkillArgs, key: string, label: string, list: string[], def: string) => {
  const v = a[key] === undefined || a[key] === null || a[key] === "" ? def : String(a[key]).toLowerCase();
  if (!list.includes(v)) throw new Error(`${label}只能是：${list.join("、")}`);
  return v;
};
const colour = (v: unknown, label: string) => {
  const s = String(v).trim();
  if (!/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/.test(s)) throw new Error(`${label}要写成 #ffffff 这样的色值或 white、black 这样的英文颜色名`);
  return s;
};

const SCRIPT = String.raw`import sys, os, json, glob, re, math
from PIL import Image, ImageOps, ImageDraw, ImageFont, ImageColor
P = json.loads(sys.argv[1])
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

def human(n):
    return "%.1f MB" % (n / 1048576) if n >= 1048576 else "%d KB" % max(1, round(n / 1024))

FONTS = ["/usr/share/fonts/**/NotoSansCJK*-Regular.ttc", "/usr/share/fonts/**/NotoSansCJK*.ttc", "/usr/share/fonts/**/*CJK*",
         "/usr/share/fonts/**/wqy*", "/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc"]
def font_path():
    for pat in FONTS:
        for p in sorted(glob.glob(pat, recursive=True)):
            return p
    return None
def load_font(size):
    p = font_path()
    return ImageFont.truetype(p, size) if p else ImageFont.load_default(size)

def die(msg):
    print("FAIL " + msg)
    sys.exit(1)

try:
    BG = ImageColor.getrgb(P["bg"])
    if len(BG) == 4:
        BG = BG[:3]
except ValueError:
    die("背景色不认识：" + P["bg"])
caps = P["captions"]
if any(caps) and not font_path() and any(re.search(r"[^\x00-\x7f]", c) for c in caps):
    die("云电脑里没找到中文字体，说明文字先用英文或数字")

def load(name, want=None):
    im = Image.open("in/" + name)
    if want and im.format == "JPEG":
        im.draft("RGB", (want[0] * 2, want[1] * 2))
    im.load()
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        base = Image.new("RGB", im.size, BG)
        base.paste(im, mask=im.split()[3])
        return base
    return im.convert("RGB")

def caption(d, text, box, size, fill=None):
    # one line, shrunk to fit; long text is cut with an ellipsis
    x0, y0, x1, y1 = box
    font = load_font(size)
    t = text
    while d.textlength(t, font=font) > (x1 - x0) and size > 12:
        size -= 1
        font = load_font(size)
    while d.textlength(t, font=font) > (x1 - x0) and len(t) > 1:
        t = t[:-2] + "…"
    lum = 0.299 * BG[0] + 0.587 * BG[1] + 0.114 * BG[2]
    fill = fill or ((30, 30, 30) if lum > 140 else (235, 235, 235))
    w = d.textlength(t, font=font)
    bb = d.textbbox((0, 0), t, font=font)
    d.text((x0 + (x1 - x0 - w) / 2, y0 + (y1 - y0 - (bb[3] - bb[1])) / 2 - bb[1]), t, font=font, fill=fill)

def save(im, name):
    if P["out"] == "png":
        im.save("out/" + name + ".png", "PNG", compress_level=6)
        return name + ".png"
    im.save("out/" + name + ".jpg", "JPEG", quality=92, optimize=True)
    return name + ".jpg"

files = P["files"]
mode = P["mode"]

if mode == "split9":
    im = load(files[0])
    w, h = im.size
    if P["fit"] == "contain":
        s = max(w, h)
        sq = Image.new("RGB", (s, s), BG)
        sq.paste(im, ((s - w) // 2, (s - h) // 2))
    else:
        s = min(w, h)
        sq = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    tile = min(s // 3, P["tile"])
    if tile < 16:
        die("这张图太小，切不出九宫格")
    sq = sq.resize((tile * 3, tile * 3), Image.LANCZOS)
    outs = []
    for r in range(3):
        for c in range(3):
            outs.append(save(sq.crop((c * tile, r * tile, c * tile + tile, r * tile + tile)), "tile_%d" % (r * 3 + c + 1)))
    print("OK %s ... %s | 九宫格 | 1 张 | 每块 %dx%d | 9 块，从左到右、从上到下编号 1 到 9" % (outs[0], outs[-1], tile, tile))
    sys.exit(0)

n = len(files)
gap = P["gap"]
cw = P["cell"]
if mode == "grid":
    cols = P["cols"] or (math.ceil(n / P["rows"]) if P["rows"] else math.ceil(math.sqrt(n)))
    rows = P["rows"] or math.ceil(n / cols)
    if rows * cols < n:
        die("%d 行 x %d 列只有 %d 格，放不下 %d 张图" % (rows, cols, rows * cols, n))
    first = Image.open("in/" + files[0])
    first = ImageOps.exif_transpose(first)
    asp = min(2.0, max(0.5, first.width / first.height))
    ch = round(cw / asp)
    first.close()
else:
    cols, rows = 1, n
    ch = 0
has_cap = any(caps)
size_cap = P["max_side"]

def plan(cw, ch, gap):
    cap = round(max(14, cw * 0.06) * 1.7) if has_cap else 0
    if mode == "grid":
        return cols * cw + (cols + 1) * gap, rows * (ch + cap) + (rows + 1) * gap, cap
    return None

if mode == "grid":
    W, H, cap = plan(cw, ch, gap)
    s = min(1.0, size_cap / max(W, H))
    if s < 1:
        cw, ch, gap = max(40, int(cw * s)), max(40, int(ch * s)), int(gap * s)
        W, H, cap = plan(cw, ch, gap)
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    fs = max(12, round(cw * 0.06))
    for i, name in enumerate(files):
        r, c = divmod(i, cols)
        in_row = cols if r < rows - 1 else n - (rows - 1) * cols
        x0 = gap + c * (cw + gap) + (cols - in_row) * (cw + gap) // 2
        y0 = gap + r * (ch + cap + gap)
        im = load(name, (cw, ch))
        if P["fit"] == "cover":
            tile = ImageOps.fit(im, (cw, ch), Image.LANCZOS)
            canvas.paste(tile, (x0, y0))
        else:
            im.thumbnail((cw, ch), Image.LANCZOS)
            canvas.paste(im, (x0 + (cw - im.width) // 2, y0 + (ch - im.height) // 2))
        if caps[i]:
            caption(d, caps[i], (x0, y0 + ch, x0 + cw, y0 + ch + cap), fs)
    label = "%dx%d 网格" % (rows, cols)
else:
    sw = P["strip_width"]
    heights = []
    for name in files:
        with Image.open("in/" + name) as t:
            t = ImageOps.exif_transpose(t)
            heights.append(max(1, round(t.height * sw / t.width)))
    cap = round(max(14, sw * 0.045) * 1.7) if has_cap else 0
    H = sum(heights) + n * cap + (n + 1) * gap
    s = min(1.0, size_cap / H)
    if s < 1:
        sw = max(100, int(sw * s))
        gap = int(gap * s)
        heights = [max(1, round(h * s)) for h in heights]
        cap = round(max(14, sw * 0.045) * 1.7) if has_cap else 0
        H = sum(heights) + n * cap + (n + 1) * gap
    W = sw + 2 * gap
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    fs = max(12, round(sw * 0.045))
    y = gap
    for i, name in enumerate(files):
        im = load(name, (sw, heights[i])).resize((sw, heights[i]), Image.LANCZOS)
        canvas.paste(im, (gap, y))
        y += heights[i]
        if caps[i]:
            caption(d, caps[i], (gap, y, gap + sw, y + cap), fs)
        y += cap + gap
    label = "竖长图"

out = save(canvas, "collage")
print("OK %s | %s | %d 张 | %dx%d | %s" % (out, label, n, canvas.width, canvas.height, human(os.path.getsize("out/" + out))))
`;

const skill: Skill = {
  name: "image-collage",
  title: "图片拼图",
  when: "用户要把 2 到 16 张图拼成一张（网格拼图、竖着接起来的长图），或把一张图切成朋友圈九宫格（mode 选 split9，只放一张图）时用。网格和长图返回一张图片，九宫格返回 9 张小图。可以给每张图配一行说明文字（中文可以）。只是缩放、转格式用 image-batch。",
  args: {
    mode: { type: "string", enum: MODES, description: "拼法：grid 网格（默认）；strip 竖着接成一张长图；split9 把一张图切成 3x3 九宫格（此时只能放 1 张图）。" },
    rows: { type: "integer", description: "网格行数。rows 和 cols 都不填就自动排成接近正方形。只在 grid 下有用。" },
    cols: { type: "integer", description: "网格列数。只在 grid 下有用。行列相乘必须放得下全部图片，最后一行不满会居中。" },
    gap: { type: "integer", description: "图片之间和四周的空隙，单位像素，0 到 100，默认 12。split9 不用。" },
    background: { type: "string", description: "底色，如 #ffffff（默认白色）、black、#f5efe6。" },
    captions: { type: "array", items: { type: "string" }, description: "每张图下面的说明文字，按图片顺序一一对应，不需要的位置写空字符串。每条不超过 30 个字，过长会被截断。不填就没有文字。" },
    fit: { type: "string", enum: FITS, description: "图片放进格子的方式：cover 填满格子、多出的部分裁掉（grid 默认，九宫格则是取中间的正方形）；contain 完整显示、留白补边（九宫格里是把整张图补成正方形再切）。strip 不用。" },
    cell_width: { type: "integer", description: "网格里每格的宽度（像素），200 到 1600，默认 600。" },
    strip_width: { type: "integer", description: "长图的宽度（像素），300 到 2000，默认 900。" },
    max_side: { type: "integer", description: "成品最长那一边的上限（像素），默认网格 4096、长图 12000，超出就整体缩小。" },
    format: { type: "string", enum: OUTS, description: "输出格式，jpg（默认，体积小）或 png。" },
  },
  files: { min: 1, max: 16, extensions: EXTS, what: "要拼的图片，拼图 2 到 16 张，九宫格 1 张；顺序就是排列顺序" },
  timeoutSeconds: 300,
  commands(args, files) {
    const mode = pick(args, "mode", "拼法", MODES, "grid");
    if (mode === "split9" && files.length !== 1) throw new Error("九宫格只能放 1 张图");
    if (mode !== "split9" && (files.length < 2 || files.length > 16)) throw new Error("拼图要放 2 到 16 张图");
    for (const f of files) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!EXTS.includes(ext)) throw new Error(`不支持「${f.name}」这种格式，能处理的有：${EXTS.join("、")}`);
    }
    const rows = num(args, "rows", "行数", 1, 16);
    const cols = num(args, "cols", "列数", 1, 16);
    if (mode === "grid" && rows && cols && rows * cols < files.length) throw new Error(`${rows} 行 x ${cols} 列只有 ${rows * cols} 格，放不下 ${files.length} 张图`);
    let captions: string[] = [];
    if (args.captions !== undefined && args.captions !== null && args.captions !== "") {
      if (!Array.isArray(args.captions)) throw new Error("说明文字要按图片顺序写成一个列表");
      if (args.captions.length > files.length) throw new Error(`说明文字有 ${args.captions.length} 条，比图片数 ${files.length} 多`);
      captions = args.captions.map((c: unknown) => String(c ?? "").replace(/[\x00-\x1f]/g, " ").trim());
      if (captions.some(c => c.length > 30)) throw new Error("每条说明文字不要超过 30 个字");
    }
    while (captions.length < files.length) captions.push("");
    if (mode === "split9") captions = captions.map(() => "");
    const p = {
      files: files.map(f => f.name), mode,
      rows: rows ?? null, cols: cols ?? null,
      gap: num(args, "gap", "间隙", 0, 100) ?? 12,
      bg: args.background === undefined || args.background === null || args.background === "" ? "#ffffff" : colour(args.background, "底色"),
      captions,
      fit: pick(args, "fit", "放入方式", FITS, mode === "split9" ? "cover" : "cover"),
      cell: num(args, "cell_width", "每格宽度", 200, 1600) ?? 600,
      strip_width: num(args, "strip_width", "长图宽度", 300, 2000) ?? 900,
      max_side: num(args, "max_side", "最长边上限", 400, 16000) ?? (mode === "strip" ? 12000 : 4096),
      tile: 1080,
      out: pick(args, "format", "输出格式", OUTS, "jpg"),
    };
    const py = `PY=/opt/py/bin/python; [ -x "$PY" ] || PY=\${PYTHON:-python3}`;
    const needHeic = files.some(f => /\.hei[cf]$/i.test(f.name));
    const setup = [
      py,
      `"$PY" -c "import PIL" 2>/dev/null || uv pip install -q --python "$PY" pillow`,
      needHeic ? `"$PY" -c "import pillow_heif" 2>/dev/null || uv pip install -q --python "$PY" pillow-heif || echo "HEIC 解码库没装上，HEIC 文件会失败"` : "",
      "true",
    ].filter(Boolean).join("\n");
    const run = [py, "mkdir -p out", "cat > .skill_image_collage.py <<'PYEOF'", SCRIPT.replace(/\n$/, ""), "PYEOF", `PYTHONUTF8=1 "$PY" .skill_image_collage.py ${sh(JSON.stringify(p))}`].join("\n");
    return [setup, run];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const ok = lines.find(l => l.startsWith("OK "));
    const fail = lines.find(l => l.startsWith("FAIL "));
    if (fail) return { 失败: fail.slice(5) };
    if (!ok) return {};
    const [file, kind, count, size, bytes] = ok.slice(3).split(" | ");
    return { 文件: file, 说明: kind, 图片数: count, 尺寸: size, 体积: bytes };
  },
};
export default skill;
