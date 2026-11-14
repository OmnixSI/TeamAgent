// Batch picture conversion in the cloud computer: resize, change format, quality, strip metadata, rename, watermark.
import { sh } from "./types.ts";
import type { Skill, SkillArgs } from "./types.ts";

const EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif"];
const FORMATS = ["keep", "jpg", "png", "webp", "avif"];
const FITS = ["contain", "cover", "stretch"];
const POS = ["br", "bl", "tr", "tl", "center"];

const num = (a: SkillArgs, key: string, label: string, lo: number, hi: number): number | undefined => {
  const v = a[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${label}要在 ${lo} 到 ${hi} 之间`);
  return n;
};
const pick = (a: SkillArgs, key: string, label: string, list: string[], def: string) => {
  const v = a[key] === undefined || a[key] === null || a[key] === "" ? def : String(a[key]).toLowerCase();
  if (!list.includes(v)) throw new Error(`${label}只能是：${list.join("、")}`);
  return v;
};
const flag = (v: unknown, def: boolean) => v === undefined || v === null || v === "" ? def : !(v === false || /^(false|no|0|否|不)$/i.test(String(v)));
const colour = (v: unknown, label: string) => {
  const s = String(v).trim();
  if (!/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/.test(s)) throw new Error(`${label}要写成 #ffffff 这样的色值或 white、black 这样的英文颜色名`);
  return s;
};

// Runs inside the cloud computer. Arguments arrive as one JSON string in argv[1]; nothing is interpolated into the code.
const SCRIPT = String.raw`import sys, os, json, glob, re
from PIL import Image, ImageOps, ImageDraw, ImageFont, ImageColor, features
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
    if p:
        return ImageFont.truetype(p, size)
    return ImageFont.load_default(size)

fmt = P["format"]
if fmt == "avif" and not features.check("avif"):
    try:
        import pillow_avif  # noqa
    except Exception:
        print("FAIL 全部 | 这台电脑的图片库不支持 AVIF，请改用 webp 或 jpg")
        sys.exit(1)
if P["wm"] and not font_path() and re.search(r"[^\x00-\x7f]", P["wm"]):
    print("FAIL 全部 | 云电脑里没找到中文字体，水印先用英文或数字")
    sys.exit(1)
try:
    BG = ImageColor.getrgb(P["bg"]) if P["bg"] else None
except ValueError:
    print("FAIL 全部 | 背景色不认识：" + P["bg"])
    sys.exit(1)

def watermark(im):
    t, op = P["wm"], P["wm_opacity"]
    base = im.convert("RGBA")
    w, h = base.size
    size = max(12, int(min(w, h) * 0.045))
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    font = load_font(size)
    bb = d.textbbox((0, 0), t, font=font)
    while bb[2] - bb[0] > w * 0.8 and size > 10:
        size -= 2
        font = load_font(size)
        bb = d.textbbox((0, 0), t, font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    m = int(min(w, h) * 0.025) + 2
    pos = P["wm_pos"]
    x = m if pos in ("bl", "tl") else (w - tw - m if pos in ("br", "tr") else (w - tw) // 2)
    y = m if pos in ("tl", "tr") else (h - th - m if pos in ("bl", "br") else (h - th) // 2)
    a = int(255 * op)
    d.text((x - bb[0] + 1, y - bb[1] + 1), t, font=font, fill=(0, 0, 0, int(a * 0.6)))
    d.text((x - bb[0], y - bb[1]), t, font=font, fill=(255, 255, 255, a))
    return Image.alpha_composite(base, layer)

def flatten(im, bg):
    im = im.convert("RGBA")
    base = Image.new("RGB", im.size, bg)
    base.paste(im, mask=im.split()[3])
    return base

KEEP = {"JPEG": "jpg", "MPO": "jpg", "HEIF": "jpg", "PNG": "png", "WEBP": "webp", "AVIF": "avif"}
SAVE = {"jpg": "JPEG", "png": "PNG", "webp": "WEBP", "avif": "AVIF"}
names = P["files"]
digits = len(str(len(names)))
used = set()
tot_old = tot_new = ok = 0

for i, name in enumerate(names, 1):
    try:
        old = os.path.getsize("in/" + name)
        im = Image.open("in/" + name)
        srcfmt = im.format
        note = ""
        if getattr(im, "n_frames", 1) > 1 and srcfmt == "GIF":
            note = "（动图只取第一帧）"
        icc = im.info.get("icc_profile")
        im.load()
        im = ImageOps.exif_transpose(im)
        exif = None
        if not P["strip"]:
            ex = im.getexif()
            ex.pop(0x0112, None)
            exif = ex.tobytes() if len(ex) else None
        if im.mode == "CMYK":
            icc = None
        has_alpha = "A" in im.mode or (im.mode == "P" and "transparency" in im.info)
        if im.mode not in ("RGB", "RGBA", "L", "LA"):
            im = im.convert("RGBA" if has_alpha else "RGB")
        ow, oh = im.size
        out_fmt = KEEP.get(srcfmt, "png") if fmt == "keep" else fmt
        # size
        nw, nh = ow, oh
        ew, eh = P["exact_w"], P["exact_h"]
        if ew and eh:
            if P["fit"] == "cover":
                im = ImageOps.fit(im, (ew, eh), Image.LANCZOS)
            elif P["fit"] == "stretch":
                im = im.resize((ew, eh), Image.LANCZOS)
            else:
                s = min(ew / ow, eh / oh)
                inner = im.resize((max(1, round(ow * s)), max(1, round(oh * s))), Image.LANCZOS)
                if BG is None and out_fmt != "jpg":
                    canvas = Image.new("RGBA", (ew, eh), (0, 0, 0, 0))
                    inner = inner.convert("RGBA")
                else:
                    canvas = Image.new("RGBA", (ew, eh), (BG or (255, 255, 255)) + (255,))
                    inner = inner.convert("RGBA")
                canvas.paste(inner, ((ew - inner.width) // 2, (eh - inner.height) // 2), inner)
                im = canvas
                has_alpha = has_alpha or (BG is None and out_fmt != "jpg")
        elif ew or eh:
            s = ew / ow if ew else eh / oh
            im = im.resize((max(1, round(ow * s)), max(1, round(oh * s))), Image.LANCZOS)
        elif P["max_w"] or P["max_h"]:
            s = min((P["max_w"] or 10**9) / ow, (P["max_h"] or 10**9) / oh, 1)
            if s < 1:
                im = im.resize((max(1, round(ow * s)), max(1, round(oh * s))), Image.LANCZOS)
        if P["wm"]:
            im = watermark(im)
            if not has_alpha:
                im = im.convert("RGB")
        if out_fmt == "jpg":
            im = flatten(im, BG or (255, 255, 255)) if im.mode in ("RGBA", "LA") else im.convert("RGB")
        kw = {}
        if out_fmt == "jpg":
            kw = dict(quality=P["quality"], optimize=True)
        elif out_fmt == "webp":
            kw = dict(quality=P["quality"], method=4)
        elif out_fmt == "avif":
            kw = dict(quality=P["quality"], speed=8)
        else:
            kw = dict(compress_level=6)
        if exif:
            kw["exif"] = exif
        if icc:
            kw["icc_profile"] = icc
        stem = os.path.splitext(os.path.basename(name))[0]
        pat = P["rename"] or "{name}"
        new = pat.replace("{name}", stem).replace("{n}", str(i).zfill(digits))
        new = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", new).strip(". ")[:80] or "image"
        cand, k = new + "." + out_fmt, 1
        while cand.lower() in used:
            k += 1
            cand = "%s_%d.%s" % (new, k, out_fmt)
        used.add(cand.lower())
        im.save("out/" + cand, SAVE[out_fmt], **kw)
        nsz = os.path.getsize("out/" + cand)
        tot_old += old
        tot_new += nsz
        ok += 1
        print("OK %s -> %s | %s -> %s | %dx%d -> %dx%d%s" % (name, cand, human(old), human(nsz), ow, oh, im.width, im.height, note))
    except Exception as e:
        msg = str(e).splitlines()[0][:120] if str(e) else type(e).__name__
        if "cannot identify" in msg:
            msg = "打不开这个文件（图片损坏，或是不支持的格式，比如没装 HEIC 解码）"
        print("FAIL %s | %s" % (name, msg))

if ok:
    print("TOTAL %d 张 | %s -> %s | 体积变为 %d%%" % (ok, human(tot_old), human(tot_new), round(100 * tot_new / max(1, tot_old))))
else:
    sys.exit(1)
`;

const skill: Skill = {
  name: "image-batch",
  title: "图片批量处理",
  when: "用户发来 1 到 40 张图片，要缩小尺寸、改格式（jpg/png/webp/avif，也能读 iPhone 的 HEIC）、压缩体积、去掉拍摄信息（GPS 位置等）、批量改名或加文字水印时用。输出是处理后的图片，每张一行写明处理前后的大小和尺寸；超过 6 张会自动打成压缩包。想拼成一张图用 image-collage。",
  args: {
    max_width: { type: "integer", description: "最大宽度（像素）。图片比它宽才缩小，不会放大，长宽比不变。例如 1600。" },
    max_height: { type: "integer", description: "最大高度（像素），规则同上。宽高都填时，缩到两个限制里更严的那个。" },
    exact_width: { type: "integer", description: "精确宽度（像素）。只填宽度或只填高度时，另一边按比例算；两个都填就得到这个精确尺寸，长宽比不一致时看 fit。" },
    exact_height: { type: "integer", description: "精确高度（像素）。" },
    fit: { type: "string", enum: FITS, description: "宽高都精确指定、比例又对不上时怎么处理：contain 完整显示、四周补边（默认）；cover 填满、裁掉多余部分；stretch 直接拉伸变形。" },
    background: { type: "string", description: "contain 补边和 png 转 jpg 时透明处的颜色，如 #ffffff 或 white。不填：转 jpg 用白色，其他格式补边处保持透明。" },
    format: { type: "string", enum: FORMATS, description: "输出格式。keep 保持原格式（默认；gif、bmp 等会变 png，iPhone 的 HEIC 会变 jpg）。要发微信、传网页通常选 jpg 或 webp。" },
    quality: { type: "integer", description: "压缩质量 1 到 100，默认 85。只对 jpg、webp、avif 有用，png 是无损的。想明显变小可以用 70 左右。" },
    strip_metadata: { type: "boolean", description: "是否去掉拍摄信息（相机型号、GPS 位置、拍摄时间等）。默认 true，发给别人前建议去掉；false 则保留。" },
    rename: { type: "string", description: "改名规则，{name} 代表原文件名（不含后缀），{n} 代表序号（从 1 开始，自动补零）。例如 旅行_{n} 得到 旅行_01、旅行_02。不填则沿用原名。" },
    watermark: { type: "string", description: "要加的水印文字，可以是中文，不超过 40 个字。不填就不加水印。" },
    watermark_position: { type: "string", enum: POS, description: "水印位置：br 右下角（默认）、bl 左下角、tr 右上角、tl 左上角、center 正中间。" },
    watermark_opacity: { type: "number", description: "水印不透明度 0.1 到 1，默认 0.5，数字越大越明显。" },
  },
  files: { min: 1, max: 40, extensions: EXTS, what: "要处理的图片，1 到 40 张" },
  timeoutSeconds: 600,
  commands(args, files) {
    if (files.length < 1 || files.length > 40) throw new Error("图片批量处理一次要 1 到 40 张图片");
    for (const f of files) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!EXTS.includes(ext)) throw new Error(`不支持「${f.name}」这种格式，能处理的有：${EXTS.join("、")}`);
    }
    const format = pick(args, "format", "输出格式", FORMATS, "keep");
    const fit = pick(args, "fit", "补边方式", FITS, "contain");
    const pos = pick(args, "watermark_position", "水印位置", POS, "br");
    const rename = args.rename === undefined || args.rename === null ? "" : String(args.rename).trim();
    if (rename && (rename.length > 60 || /[\\/]/.test(rename) || rename.includes("..") || /[\x00-\x1f]/.test(rename))) throw new Error("改名规则不能超过 60 个字，也不能带 / 或 \\ 或 ..");
    const wm = args.watermark === undefined || args.watermark === null ? "" : String(args.watermark).trim();
    if (wm.length > 40) throw new Error("水印文字不要超过 40 个字");
    const p = {
      files: files.map(f => f.name),
      max_w: num(args, "max_width", "最大宽度", 16, 20000) ?? null,
      max_h: num(args, "max_height", "最大高度", 16, 20000) ?? null,
      exact_w: num(args, "exact_width", "精确宽度", 16, 20000) ?? null,
      exact_h: num(args, "exact_height", "精确高度", 16, 20000) ?? null,
      fit, format,
      bg: args.background === undefined || args.background === null || args.background === "" ? "" : colour(args.background, "背景色"),
      quality: Math.round(num(args, "quality", "质量", 1, 100) ?? 85),
      strip: flag(args.strip_metadata, true),
      rename,
      wm,
      wm_pos: pos,
      wm_opacity: num(args, "watermark_opacity", "水印不透明度", 0.1, 1) ?? 0.5,
    };
    for (const k of ["max_w", "max_h", "exact_w", "exact_h"] as const) if (p[k] !== null) p[k] = Math.round(p[k]!);
    const needHeic = files.some(f => /\.hei[cf]$/i.test(f.name));
    const py = `PY=/opt/py/bin/python; [ -x "$PY" ] || PY=\${PYTHON:-python3}`;
    const setup = [
      py,
      `"$PY" -c "import PIL" 2>/dev/null || uv pip install -q --python "$PY" pillow`,
      needHeic ? `"$PY" -c "import pillow_heif" 2>/dev/null || uv pip install -q --python "$PY" pillow-heif || echo "HEIC 解码库没装上，HEIC 文件会处理失败"` : "",
      format === "avif" ? `"$PY" -c "import sys; from PIL import features; sys.exit(0 if features.check('avif') else 1)" 2>/dev/null || "$PY" -c "import pillow_avif" 2>/dev/null || uv pip install -q --python "$PY" pillow-avif-plugin || echo "AVIF 编码库没装上"` : "",
      "true",
    ].filter(Boolean).join("\n");
    const run = [py, "mkdir -p out", "cat > .skill_image_batch.py <<'PYEOF'", SCRIPT.replace(/\n$/, ""), "PYEOF", `PYTHONUTF8=1 "$PY" .skill_image_batch.py ${sh(JSON.stringify(p))}`].join("\n");
    return [setup, run];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const ok = lines.filter(l => l.startsWith("OK "));
    const fail = lines.filter(l => l.startsWith("FAIL "));
    const total = lines.find(l => l.startsWith("TOTAL "));
    const r: Record<string, any> = { 成功: ok.length };
    if (fail.length) r.失败 = fail.map(l => l.slice(5)).slice(0, 10);
    if (total) r.总计 = total.slice(6);
    if (ok.length) r.明细 = ok.slice(0, 12).map(l => l.slice(3));
    return r;
  },
};
export default skill;
