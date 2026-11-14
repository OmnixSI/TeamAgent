// Tool packs for the cloud computer: sets of programs that are too big to install on every wake-up, so
// each is installed once, cached in R2 as its own layer and restored only by the runs that ask for it.
// A layer holds what the pack's install changed on top of the base tools and nothing from other packs,
// so layers unpack in any order and together. The machine side is in src/computer.ts.
import { sha } from "./feat/transfer.ts";

export type Pack = {
  /** Chinese, one line: what is in it. */
  what: string;
  /** Bash that installs it on a machine that already has the base tools. */
  install: string;
  /** A command that succeeds when the pack is already present. */
  check: string;
};

const APT = "export DEBIAN_FRONTEND=noninteractive\napt-get update -qq\napt-get install -y -qq --no-install-recommends";

export const PACKS: Record<string, Pack> = {
  office: {
    what: "办公文档：LibreOffice（Word、Excel、PPT 互转和转 PDF，中文正常）、pandoc、qpdf、pdftoppm/pdftotext、ghostscript、ImageMagick、typst，Python 里的 markitdown、pymupdf、pdf2docx、pypdf",
    install: String.raw`${APT} libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui pandoc qpdf poppler-utils ghostscript imagemagick >/dev/null
apt-get clean
VIRTUAL_ENV=/opt/py uv pip install -q 'markitdown[docx,pptx,xlsx,pdf]' pymupdf pdf2docx pypdf
curl -fsSL https://github.com/typst/typst/releases/latest/download/typst-x86_64-unknown-linux-musl.tar.xz | tar -xJ -C /usr/local/bin --strip-components=1 typst-x86_64-unknown-linux-musl/typst
# Debian's ImageMagick refuses PDF input and output unless the policy allows it.
for p in /etc/ImageMagick-*/policy.xml; do [ -f "$p" ] && sed -i '/pattern="PDF"/d' "$p"; done
# The first start of LibreOffice writes its profile (several seconds); doing it here puts the profile in the layer.
cd /tmp && echo 中文 > lo-warm.txt && HOME=/root /usr/bin/soffice --headless --convert-to pdf lo-warm.txt >/dev/null 2>&1; rm -f /tmp/lo-warm.*`,
    check: `[ -x /usr/bin/soffice ] && for c in pandoc qpdf pdftoppm magick typst; do command -v $c >/dev/null || exit 1; done && gs --version >/dev/null && /opt/py/bin/python -c 'import importlib.util as u,sys;sys.exit(not all(u.find_spec(m) for m in ("markitdown","fitz","pdf2docx","pypdf")))'`,
  },
  ocr: {
    what: "文字识别：tesseract（简体中文 chi_sim 和英文 eng）、ocrmypdf（给扫描版 PDF 加上能搜索、能复制的文字层）",
    install: String.raw`${APT} tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng ocrmypdf >/dev/null
apt-get clean`,
    check: `tesseract --list-langs 2>/dev/null | grep -qx chi_sim && command -v ocrmypdf >/dev/null`,
  },
  // Tectonic fetches TeX files on first use. A xeCJK article with the base's Noto CJK fonts needs about
  // 43 MB of them (measured: 141 s to fetch, 21 MB compressed with the binary); ctex's default Fandol
  // fonts pull close to 600 MB, so the warm-up and the description steer to xeCJK.
  tex: {
    what: "LaTeX 排版：tectonic（XeLaTeX，常用宏包已预先下载）；中文用 \\usepackage{xeCJK} 加 \\setCJKmainfont{Noto Serif CJK SC} 或 Noto Sans CJK SC，别用 ctex 默认字体（要现下几百兆）",
    install: String.raw`mkdir -p /opt/tex/cache && cd /opt/tex && curl -fsSL https://drop-sh.fullyjustified.net | sh >/dev/null
printf '#!/bin/sh\nexport XDG_CACHE_HOME=/opt/tex/cache TECTONIC_CACHE_DIR=/opt/tex/cache\nexec /opt/tex/tectonic "$@"\n' > /usr/local/bin/tectonic && chmod +x /usr/local/bin/tectonic
rm -rf /tmp/tex-warm && mkdir /tmp/tex-warm && cd /tmp/tex-warm
printf '%s\n' '\documentclass{article}' '\usepackage{amsmath,amssymb,graphicx,geometry,hyperref,xeCJK}' '\setCJKmainfont{Noto Serif CJK SC}' '\setCJKsansfont{Noto Sans CJK SC}' '\begin{document}' '\section{测试}' '中文 \textsf{黑体} $E=mc^2$' '\end{document}' > a.tex
tectonic a.tex >/dev/null
cd / && rm -rf /tmp/tex-warm`,
    check: `[ -x /opt/tex/tectonic ] && [ -n "$(ls -A /opt/tex/cache 2>/dev/null)" ]`,
  },
};

/** A layer may be at most this big compressed; anything larger is not stored (the pack is then installed each time). */
export const PACK_MAX = 500 * 1024 * 1024;

const NAME = /^[a-z][a-z0-9_-]{0,23}$/;

export const unknownPack = (bad: string[], packs: Record<string, Pack> = PACKS) =>
  "没有叫" + bad.map(b => "“" + b.slice(0, 30) + "”").join("、") + "的工具包，现有的是：" + (Object.keys(packs).join("、") || "（暂时没有）");

/** The packs a run asks for, deduplicated in the order given; an unknown or malformed name is an error. */
export function pickPacks(list: unknown, packs: Record<string, Pack> = PACKS): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("packs 要写成工具包名字的列表，比如 [\"office\"]");
  const names = [...new Set(list.map(x => String(x).trim()).filter(Boolean))];
  const bad = names.filter(n => !NAME.test(n) || !Object.hasOwn(packs, n));
  if (bad.length) throw new Error(unknownPack(bad, packs));
  return names;
}

// Run on the machine with the pack's name as $1. Everything that decides what a layer holds is part of
// its recipe, so changing any of it gives the layer a new name and the old one is dropped.

/** Before an install: the reference point for "changed since" and the dpkg records the base already has. */
export const PACK_PREP = String.raw`set -e; s=/tmp/pack-$1; touch $s.stamp; cp /var/lib/dpkg/status $s.status0`;
/** After an install on a clean machine: the dpkg records the pack added (merged on restore instead of
 *  shipping the shared status file), then every file changed since the stamp, minus shared indexes,
 *  downloads, logs and documentation. Prints the uncompressed size. */
export const PACK_SNAP = String.raw`set -e; s=/tmp/pack-$1
mkdir -p /var/lib/computer-packs
awk -v RS= -v ORS='\n\n' 'FILENAME==ARGV[1] { seen[$0]=1; next } !($0 in seen)' $s.status0 /var/lib/dpkg/status > /var/lib/computer-packs/$1.status
cd / && find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /work -o -path /opt/computer \
  -o -path /root/.cache -o -path /var/cache/apt -o -path /var/cache/debconf -o -path /var/cache/ldconfig -o -path /var/log -o -path /var/lib/apt \
  -o -path /var/lib/dpkg/triggers -o -path '/var/lib/dpkg/status*' -o -path '/var/lib/dpkg/available*' -o -path '/var/lib/dpkg/lock*' -o -path /etc/ld.so.cache \
  -o -path /usr/share/doc -o -path /usr/share/man -o -path /usr/share/info -o -path /usr/share/locale -o -path /usr/share/lintian \
  -o -path '*/site-packages/*/tests' \) -prune -o -cnewer $s.stamp ! -type d -fprintf $s.list '%P\n' -fprintf $s.sizes '%s\n'
awk '{ n += $1 } END { printf "%d\n", n }' $s.sizes`;
/** After a layer unpacked into a staging folder ($1): hard-links it into place (copies when linking is
 *  not possible), so a cut-off or damaged download never leaves half a pack on the system. */
export const PACK_LINK = String.raw`cp -RlP --remove-destination "$1"/. / 2>/dev/null || cp -RP --remove-destination "$1"/. /; r=$?; rm -rf -- "$1"; ldconfig 2>/dev/null; exit $r`;
/** After a restored layer checked out: adds its dpkg records to the status file (replacing same-name ones). */
export const PACK_MERGE = String.raw`f=/var/lib/computer-packs/$1.status; [ -s "$f" ] || exit 0
awk -v RS= -v ORS='\n\n' 'function key(t,  L, n, i, p, a) { n = split(t, L, "\n"); for (i = 1; i <= n; i++) { if (L[i] ~ /^Package: /) p = substr(L[i], 10); else if (L[i] ~ /^Architecture: /) a = substr(L[i], 15) } return p ":" a }
FILENAME==ARGV[1] { k = key($0); add[k] = $0; order[++m] = k; next }
{ k = key($0); if (k in add) { print add[k]; done[k] = 1 } else print }
END { for (i = 1; i <= m; i++) if (!(order[i] in done)) print add[order[i]] }' "$f" /var/lib/dpkg/status > /var/lib/dpkg/status.new && mv /var/lib/dpkg/status.new /var/lib/dpkg/status`;
/** What the system looks like package-wise; equal to the value saved after the base setup means no pack
 *  and no stray install is on the machine, so a pack installed now holds everything it needs. */
export const FINGERPRINT = String.raw`{ cat /var/lib/dpkg/status; ls -1 /opt/py/lib/python3.12/site-packages; } 2>/dev/null | md5sum | cut -c1-32`;

export const packRecipe = (name: string, pack: Pack) => [name, pack.install, PACK_SNAP, PACK_LINK, "zstd-3"].join("\n");
/** R2 object name of a pack's layer: the recipe hash is in it, so a changed install misses the old layer. */
export async function layerName(name: string, pack: Pack = PACKS[name]) {
  return "pack-" + name + "-" + (await sha(packRecipe(name, pack))).slice(0, 16) + ".tar.zst";
}

export type PackPlan = "present" | "restore" | "install";
/** Present when its check passes, restored when a finished layer exists, otherwise installed. */
export const packPlan = (present: boolean, layer: boolean): PackPlan => (present ? "present" : layer ? "restore" : "install");
/** A restore that failed (download cut off, damaged layer, check failing afterwards) falls back to installing. */
export const afterPackRestore = (ok: boolean): "done" | "install" => (ok ? "done" : "install");
/** A layer is saved only from an install on a clean machine (base only, nothing running) with a write link. */
export const savePack = (installed: boolean, clean: boolean, put?: string) => installed && clean && !!put;
/** The work to do, installs first: an install is clean only while no other pack has been unpacked. */
export function packOrder(names: string[], plans: Record<string, PackPlan>) {
  const pick = (p: PackPlan) => names.filter(n => plans[n] === p).map(name => ({ name, plan: p }));
  return [...pick("install"), ...pick("restore")];
}

export type PackSetup = { setup: "present" | "restored" | "installed"; seconds: number; error?: string };
/** What the run reports per pack (the machine returns more for the caller's bookkeeping). */
export function packReport(done: Record<string, PackSetup & Record<string, unknown>>, names: string[]) {
  const out: Record<string, PackSetup> = {};
  for (const n of names) {
    const d = done[n];
    if (d) out[n] = { setup: d.setup, seconds: d.seconds, ...(d.error ? { error: d.error } : {}) };
  }
  return out;
}
export const packFailure = (name: string, detail?: string) =>
  "工具包 " + name + " 没装上，这次的命令没有跑" + (detail ? "：" + detail.trim().slice(-400) : "");
