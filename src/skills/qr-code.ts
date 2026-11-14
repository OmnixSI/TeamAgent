// QR code generator: text or link to PNG and SVG, optional centre logo and a Chinese caption.
import { sh } from "./types.ts";
import type { Skill, SkillArgs } from "./types.ts";

const LEVELS = ["L", "M", "Q", "H"];

const colour = (v: unknown, label: string) => {
  const s = String(v).trim();
  if (!/^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})$/.test(s)) throw new Error(`${label}要写成 #000000 这样的六位色值`);
  return (s.length === 4 ? "#" + [...s.slice(1)].map(c => c + c).join("") : s).toLowerCase();
};

const SCRIPT = String.raw`import sys, os, json, glob, re, base64, io
import segno
from PIL import Image, ImageOps, ImageDraw, ImageFont, ImageColor
from xml.sax.saxutils import escape
P = json.loads(sys.argv[1])

def die(msg):
    print("FAIL " + msg)
    sys.exit(1)

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

cap = P["caption"]
if cap and not font_path() and re.search(r"[^\x00-\x7f]", cap):
    die("云电脑里没找到中文字体，说明文字先用英文或数字")
level = "H" if P["logo"] else P["ec"]
try:
    qr = segno.make(P["text"], error=level.lower(), micro=False, encoding="utf-8", boost_error=False)
except Exception as e:
    die("内容太长，装不进二维码，请缩短或把纠错等级调低（现在是 %s）" % level)
n = len(qr.matrix)
border = 4
mods = n + 2 * border
size = P["size"]
mp = size // mods
if mp < 1:
    die("尺寸太小，这个内容需要至少 %d 像素" % mods)
fg, bg = P["fg"], P["bg"]
FG, BGC = ImageColor.getrgb(fg), ImageColor.getrgb(bg)

# wrap the caption into at most 3 lines that fit the width
lines, font, fs = [], None, 0
if cap:
    fs = max(16, round(size * 0.05))
    font = load_font(fs)
    probe = ImageDraw.Draw(Image.new("RGB", (4, 4)))
    cur = ""
    for ch in cap:
        if probe.textlength(cur + ch, font=font) > size * 0.9 and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    lines.append(cur)
    if len(lines) > 3:
        lines = lines[:3]
        lines[2] = lines[2][:-1] + "…"
cap_h = round(fs * 1.5 * len(lines) + fs * 0.6) if lines else 0

img = Image.new("RGB", (size, size + cap_h), BGC)
d = ImageDraw.Draw(img)
ox = (size - mp * mods) // 2
oy = ox
for r, row in enumerate(qr.matrix):
    for c, v in enumerate(row):
        if v:
            x, y = ox + (c + border) * mp, oy + (r + border) * mp
            d.rectangle([x, y, x + mp - 1, y + mp - 1], fill=FG)

logo_png = None
lx = ly = ls = 0
if P["logo"]:
    try:
        lg = Image.open("in/" + P["logo"])
        lg.load()
        lg = ImageOps.exif_transpose(lg).convert("RGBA")
    except Exception:
        die("logo 图片打不开")
    ls = int(n * mp * 0.22)
    lg.thumbnail((ls, ls), Image.LANCZOS)
    pad = max(2, mp)
    bw, bh = lg.width + 2 * pad, lg.height + 2 * pad
    lx, ly = (size - bw) // 2, oy + (n * mp + 2 * border * mp - bh) // 2
    d.rounded_rectangle([lx, ly, lx + bw - 1, ly + bh - 1], radius=pad, fill=BGC)
    img.paste(lg, (lx + pad, ly + pad), lg)
    logo_buf = io.BytesIO()
    lg.save(logo_buf, "PNG")
    logo_png = (base64.b64encode(logo_buf.getvalue()).decode(), lx + pad, ly + pad, lg.width, lg.height, lx, ly, bw, bh, pad)

for i, line in enumerate(lines):
    w = d.textlength(line, font=font)
    d.text(((size - w) / 2, size + fs * 0.3 + i * fs * 1.5), line, font=font, fill=FG)

img.save("out/qrcode.png", "PNG", compress_level=6)
outs = ["qrcode.png"]

if P["svg"]:
    S = size
    # same geometry as the PNG: integer module size, centred
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="%d" height="%d" viewBox="0 0 %d %d">' % (S, S + cap_h, S, S + cap_h)]
    parts.append('<rect width="100%%" height="100%%" fill="%s"/>' % bg)
    path = []
    for r, row in enumerate(qr.matrix):
        c = 0
        row = list(row)
        while c < n:
            if row[c]:
                e = c
                while e < n and row[e]:
                    e += 1
                path.append("M%d %dh%dv%dh-%dz" % (ox + (c + border) * mp, oy + (r + border) * mp, (e - c) * mp, mp, (e - c) * mp))
                c = e
            else:
                c += 1
    parts.append('<path fill="%s" d="%s"/>' % (fg, "".join(path)))
    if logo_png:
        b64, ix, iy, iw, ih, bx, by, bw, bh, pad = logo_png
        parts.append('<rect x="%d" y="%d" width="%d" height="%d" rx="%d" fill="%s"/>' % (bx, by, bw, bh, pad, bg))
        parts.append('<image x="%d" y="%d" width="%d" height="%d" xlink:href="data:image/png;base64,%s"/>' % (ix, iy, iw, ih, b64))
    for i, line in enumerate(lines):
        parts.append('<text x="%d" y="%d" font-size="%d" text-anchor="middle" fill="%s" font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">%s</text>' % (S // 2, round(S + fs * 0.3 + i * fs * 1.5 + fs), fs, fg, escape(line)))
    parts.append("</svg>")
    open("out/qrcode.svg", "w", encoding="utf-8").write("\n".join(parts))
    outs.append("qrcode.svg")

print("OK %s | %dx%d | 纠错等级 %s | %d 格 | %s%s" % (" + ".join(outs), img.width, img.height, qr.error, n, "含 logo" if logo_png else "无 logo", " | 含说明文字" if lines else ""))
`;

const skill: Skill = {
  name: "qr-code",
  title: "二维码",
  when: "用户要把一段文字或一个网址做成二维码时用，返回 png 图片和 svg 矢量图（印刷用）。可以在中间放 logo 图片，也可以在二维码下面加一行中文说明。不需要上传文件，除非要放 logo。",
  args: {
    text: { type: "string", description: "二维码里要放的内容：网址、文字、Wi-Fi 配置串等。最多 1500 个字，越短越容易扫。" },
    size: { type: "integer", description: "图片边长（像素），200 到 2000，默认 800。" },
    error_correction: { type: "string", enum: LEVELS, description: "纠错等级，L 最低、M（默认）、Q、H 最高。放 logo 时会自动用 H。等级越高越抗污损，但格子越密。" },
    caption: { type: "string", description: "二维码下面的一行说明文字，可以是中文，最多 40 个字，太长会换行。不填就没有。" },
    color: { type: "string", description: "二维码颜色，六位色值，默认 #000000。要和底色反差够大才扫得出。" },
    background: { type: "string", description: "底色，六位色值，默认 #ffffff。" },
    svg: { type: "boolean", description: "是否同时输出 svg 矢量图，默认 true。" },
  },
  required: ["text"],
  files: { min: 0, max: 1, extensions: ["png", "jpg", "jpeg", "webp", "gif"], what: "可选：放在二维码正中间的 logo 图片，最多 1 张" },
  timeoutSeconds: 120,
  commands(args: SkillArgs, files) {
    const text = args.text === undefined || args.text === null ? "" : String(args.text);
    if (!text.trim()) throw new Error("要告诉我二维码里放什么内容");
    if (text.length > 1500) throw new Error("内容太长了，二维码最多放 1500 个字，请缩短");
    if (files.length > 1) throw new Error("logo 只能放 1 张图");
    if (files[0] && !/\.(png|jpe?g|webp|gif)$/i.test(files[0].name)) throw new Error("logo 要用 png、jpg、webp 或 gif 图片");
    let size = 800;
    if (args.size !== undefined && args.size !== null && args.size !== "") {
      size = Number(args.size);
      if (!Number.isFinite(size) || size < 200 || size > 2000) throw new Error("尺寸要在 200 到 2000 之间");
      size = Math.round(size);
    }
    const ec = args.error_correction === undefined || args.error_correction === null || args.error_correction === "" ? "M" : String(args.error_correction).toUpperCase();
    if (!LEVELS.includes(ec)) throw new Error("纠错等级只能是 L、M、Q、H");
    const caption = args.caption === undefined || args.caption === null ? "" : String(args.caption).replace(/[\x00-\x1f]/g, " ").trim();
    if (caption.length > 40) throw new Error("说明文字不要超过 40 个字");
    const fg = args.color === undefined || args.color === null || args.color === "" ? "#000000" : colour(args.color, "二维码颜色");
    const bg = args.background === undefined || args.background === null || args.background === "" ? "#ffffff" : colour(args.background, "底色");
    if (fg === bg) throw new Error("二维码颜色和底色不能一样");
    const p = {
      text, size, ec, caption, fg, bg,
      svg: args.svg === undefined || args.svg === null || args.svg === "" ? true : !(args.svg === false || /^(false|no|0|否|不)$/i.test(String(args.svg))),
      logo: files[0] ? files[0].name : "",
    };
    const py = `PY=/opt/py/bin/python; [ -x "$PY" ] || PY=\${PYTHON:-python3}`;
    const setup = [
      py,
      `"$PY" -c "import PIL" 2>/dev/null || uv pip install -q --python "$PY" pillow`,
      `"$PY" -c "import segno" 2>/dev/null || uv pip install -q --python "$PY" segno`,
    ].join("\n");
    const run = [py, "mkdir -p out", "cat > .skill_qr_code.py <<'PYEOF'", SCRIPT.replace(/\n$/, ""), "PYEOF", `PYTHONUTF8=1 "$PY" .skill_qr_code.py ${sh(JSON.stringify(p))}`].join("\n");
    return [setup, run];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const fail = lines.find(l => l.startsWith("FAIL "));
    if (fail) return { 失败: fail.slice(5) };
    const ok = lines.find(l => l.startsWith("OK "));
    if (!ok) return {};
    const [files, size, level, mods, extra] = ok.slice(3).split(" | ");
    return { 文件: files, 尺寸: size, 纠错: level, 格数: mods, 其他: extra };
  },
};
export default skill;
