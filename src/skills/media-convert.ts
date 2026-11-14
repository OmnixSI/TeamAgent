// Audio and video conversion with ffmpeg in the cloud computer (1 vCPU: veryfast preset, 1080p cap).
import { sh } from "./types.ts";
import type { Skill, SkillArgs } from "./types.ts";

const OPS = ["to_mp4", "to_gif", "to_mp3", "to_m4a", "trim", "compress", "speed", "concat", "frames", "info"];
const EXTS = ["mp4", "mov", "mkv", "avi", "webm", "flv", "m4v", "3gp", "ts", "mpg", "mpeg", "wmv", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "amr", "gif"];
const MAX_SECONDS = 3 * 3600;

const num = (a: SkillArgs, key: string, label: string, lo: number, hi: number): number | undefined => {
  const v = a[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${label}要在 ${lo} 到 ${hi} 之间`);
  return n;
};
const flag = (v: unknown, def: boolean) => v === undefined || v === null || v === "" ? def : !(v === false || /^(false|no|0|否|不)$/i.test(String(v)));
// "90", "1:30", "01:02:03.5" or 90.5 -> seconds
const time = (v: unknown, label: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  let n: number;
  if (typeof v === "number") n = v;
  else {
    const s = String(v).trim();
    const m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
    else if (m) n = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    else throw new Error(`${label}要写成秒数（如 90）或 分:秒（如 1:30）或 时:分:秒`);
  }
  if (!Number.isFinite(n) || n < 0 || n > MAX_SECONDS) throw new Error(`${label}不能小于 0，也不能超过 3 小时`);
  return n;
};
const ext = (name: string) => (name.split(".").pop() || "").toLowerCase();
const stemOf = (name: string) => name.replace(/\.[^.]*$/, "") || "output";

// Shared start of every command: helpers and the 3-hour guard.
const PRELUDE = String.raw`set -e
mkdir -p out
SECONDS=0
FF="ffmpeg -hide_banner -loglevel error -nostdin -y"
die() { echo "错误：$1"; exit 1; }
dur() { local d; d=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null | head -1); case "$d" in ""|N/A) d=0;; esac; echo "$d"; }
has_v() { ffprobe -v error -select_streams v -show_entries stream_disposition=attached_pic -of csv=p=0 "$1" 2>/dev/null | grep -q '^0'; }
has_a() { [ -n "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$1" 2>/dev/null)" ]; }
sz() { stat -c %s "$1"; }
human() { awk -v b="$1" 'BEGIN{ if (b >= 1048576) printf "%.2f MB", b/1048576; else printf "%d KB", (b+1023)/1024 }'; }
ok() { echo "OK $(basename "$1") | $(human "$(sz "$1")") | $2"; }
guard() { awk -v d="$1" 'BEGIN{exit !(d>10800)}' && die "这个文件有 $(awk -v d="$1" 'BEGIN{printf "%.1f", d/3600}') 小时，超过 3 小时的上限，请先截取一段"; return 0; }
need_dur() { awk -v d="$1" 'BEGIN{exit !(d>0)}' || die "读不出这个文件的时长，没法继续"; }
`;
const FINISH = String.raw`echo "用时 $SECONDS 秒"`;

const skill: Skill = {
  name: "media-convert",
  title: "音视频转换",
  when: "用户发来音频或视频文件，要转格式、压缩、剪一段、变速、拼接、提取声音、做成 GIF、截取画面或查看文件信息时用。用 op 选操作：to_mp4 转通用 MP4；to_gif 截一段做动图；to_mp3 / to_m4a 提取声音；trim 剪一段；compress 压到指定体积；speed 变速；concat 把 2 到 4 个同类文件首尾拼起来；frames 均匀截几张画面；info 只看文件信息（时长、编码、分辨率等，不产生文件）。文件超过 3 小时会拒绝。云电脑只有一个核，长视频转码要等几分钟。",
  args: {
    op: { type: "string", enum: OPS, description: "要做的操作，见上面的说明。" },
    start: { type: "string", description: "开始时间，写秒数（90）或 分:秒（1:30）。trim 和 to_gif 用，默认从头开始。" },
    end: { type: "string", description: "结束时间，写法同开始时间。trim 用，不填就剪到末尾；必须比开始时间晚。" },
    duration: { type: "number", description: "to_gif 截取多少秒，0.5 到 15，默认 5。" },
    width: { type: "integer", description: "to_gif 的宽度（像素），80 到 1080，默认 480，图片太大时会自动缩小；frames 截图的最大宽度，默认 1280。" },
    fps: { type: "integer", description: "to_gif 每秒几帧，1 到 30，默认 12。" },
    max_height: { type: "integer", description: "to_mp4、speed、concat 输出的最大高度（像素），默认 1080，最高 2160；原视频没这么高不会放大。" },
    crf: { type: "integer", description: "to_mp4 的画质，18（很清晰、文件大）到 32（模糊、文件小），默认 23。" },
    bitrate_kbps: { type: "integer", description: "to_mp3、to_m4a 的音频码率，48 到 320，默认 192。" },
    exact: { type: "boolean", description: "trim 是否精确到帧，默认 true（会重新编码，慢一些，画面从你说的时间点开始）；false 则不重新编码，很快，但视频的起点会往前靠到最近的关键帧，可能多出一两秒。音频文件总是不重新编码。" },
    target_mb: { type: "number", description: "compress 的目标体积（MB），0.1 到 500。会按时长算码率，必要时降低分辨率，成品略小于这个数；目标太小画质没法看时会提示最小可行的体积。" },
    factor: { type: "number", description: "speed 的倍速，0.5 到 3，如 2 表示两倍速、0.5 表示慢放一半。声音同步变速。" },
    count: { type: "integer", description: "frames 要截几张，1 到 30，默认 6，按时间均匀分布。" },
  },
  required: ["op"],
  files: { min: 1, max: 4, extensions: EXTS, what: "音频或视频文件，1 个；concat 时 2 到 4 个，按顺序拼接" },
  timeoutSeconds: 1200,
  commands(args, files) {
    const op = String(args.op ?? "").trim();
    if (!OPS.includes(op)) throw new Error(`op 只能是：${OPS.join("、")}`);
    if (op === "concat") { if (files.length < 2 || files.length > 4) throw new Error("拼接要放 2 到 4 个文件"); }
    else if (files.length !== 1) throw new Error("这个操作一次只处理 1 个文件，要拼接请用 concat");
    for (const f of files) if (!EXTS.includes(ext(f.name))) throw new Error(`不支持「${f.name}」这种格式，能处理的有：${EXTS.join("、")}`);
    const F = files.map(f => "in/" + f.name);
    const f0 = sh(F[0]);
    const stem = stemOf(files[0].name);
    const out = (suffix: string, e: string) => sh(`out/${stem}${suffix}.${e}`);
    const maxH = Math.round(num(args, "max_height", "最大高度", 144, 2160) ?? 1080);
    const body: string[] = [];
    const guardAll = F.map(f => `guard "$(dur ${sh(f)})"`);

    if (op === "info") {
      body.push(
        `ffprobe -v error -print_format json -show_format -show_streams ${f0} > .info.json || die "读不了这个文件，可能已损坏"`,
        `PY=/opt/py/bin/python; [ -x "$PY" ] || PY=\${PYTHON:-python3}`,
        `PYTHONUTF8=1 "$PY" - <<'PYEOF'`,
        String.raw`import json
d = json.load(open(".info.json"))
f = d.get("format", {})
def fr(s):
    try:
        a, b = s.split("/")
        return round(int(a) / int(b), 2) if int(b) else None
    except Exception:
        return None
r = {"格式": f.get("format_long_name"), "时长秒": round(float(f.get("duration") or 0), 2), "大小字节": int(f.get("size") or 0),
     "总码率kbps": round(int(f.get("bit_rate") or 0) / 1000), "视频": [], "音频": []}
for s in d.get("streams", []):
    if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic"):
        r["视频"].append({"编码": s.get("codec_name"), "宽": s.get("width"), "高": s.get("height"), "帧率": fr(s.get("avg_frame_rate", "")), "像素格式": s.get("pix_fmt")})
    elif s.get("codec_type") == "audio":
        r["音频"].append({"编码": s.get("codec_name"), "采样率": int(s.get("sample_rate") or 0), "声道": s.get("channels"), "码率kbps": round(int(s.get("bit_rate") or 0) / 1000)})
print("INFO " + json.dumps(r, ensure_ascii=False))`,
        "PYEOF",
      );
    } else if (op === "to_mp4") {
      const crf = Math.round(num(args, "crf", "画质 crf", 18, 32) ?? 23);
      body.push(...guardAll,
        `has_v ${f0} || die "这个文件里没有画面，没法转成视频"`,
        `$FF -i ${f0} -map 0:v:0 -map '0:a:0?' -vf "scale=-2:'trunc(min(ih,${maxH})/2)*2'" -c:v libx264 -preset veryfast -crf ${crf} -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart ${out("", "mp4")}`,
        `ok ${out("", "mp4")} "H.264 + AAC，最高 ${maxH}p，画质 crf ${crf}"`);
    } else if (op === "to_gif") {
      const start = time(args.start, "开始时间") ?? 0;
      const len = num(args, "duration", "截取秒数", 0.5, 15) ?? 5;
      const w = Math.round(num(args, "width", "宽度", 80, 1080) ?? 480);
      const fps = Math.round(num(args, "fps", "帧率", 1, 30) ?? 12);
      body.push(...guardAll,
        `has_v ${f0} || die "这个文件里没有画面，做不了 GIF"`,
        `D=$(dur ${f0})`,
        `awk -v s=${start} -v d="$D" 'BEGIN{exit !(d>0 && s>=d)}' && die "开始时间 ${start} 秒已经超过视频长度 $(awk -v d="$D" 'BEGIN{printf "%.1f", d}') 秒" || true`,
        `W=${w}`,
        `gif() { $FF -ss ${start} -t ${len} -i ${f0} -vf "fps=${fps},scale='min($1,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 ${out("", "gif")}; }`,
        `gif $W`,
        // The runner can hand back files up to 25 MB, so shrink until it fits.
        `while [ "$(sz ${out("", "gif")})" -gt 20971520 ] && [ "$W" -gt 200 ]; do W=$((W*3/4)); gif $W; done`,
        `ok ${out("", "gif")} "从 ${start} 秒起 ${len} 秒，宽 $W 像素，${fps} 帧/秒"`);
    } else if (op === "to_mp3" || op === "to_m4a") {
      const b = Math.round(num(args, "bitrate_kbps", "音频码率", 48, 320) ?? 192);
      const e = op === "to_mp3" ? "mp3" : "m4a";
      const codec = op === "to_mp3" ? "libmp3lame" : "aac -movflags +faststart";
      body.push(...guardAll,
        `has_a ${f0} || die "这个文件里没有声音"`,
        `$FF -i ${f0} -vn -map 0:a:0 -c:a ${codec} -b:a ${b}k ${out("", e)}`,
        `ok ${out("", e)} "${e.toUpperCase()}，${b} kbps"`);
    } else if (op === "trim") {
      const start = time(args.start, "开始时间");
      const end = time(args.end, "结束时间");
      if (start === undefined && end === undefined) throw new Error("剪切要给开始时间或结束时间");
      const s = start ?? 0;
      if (end !== undefined && end <= s) throw new Error("结束时间必须比开始时间晚");
      const exact = flag(args.exact, true);
      const e0 = ext(files[0].name);
      body.push(...guardAll,
        `D=$(dur ${f0}); need_dur "$D"`,
        `awk -v s=${s} -v d="$D" 'BEGIN{exit !(s>=d)}' && die "开始时间 ${s} 秒已经超过文件长度 $(awk -v d="$D" 'BEGIN{printf "%.1f", d}') 秒" || true`,
        `E=${end === undefined ? '"$D"' : end}`,
        `LEN=$(awk -v s=${s} -v e="$E" -v d="$D" 'BEGIN{if (e>d) e=d; printf "%.3f", e-s}')`,
        `if has_v ${f0} && [ ${exact ? 1 : 0} = 1 ]; then`,
        `  $FF -ss ${s} -i ${f0} -t "$LEN" -map 0:v:0 -map '0:a:0?' -vf "scale=-2:'trunc(min(ih,${maxH})/2)*2'" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart ${out("_cut", "mp4")}`,
        `  ok ${out("_cut", "mp4")} "精确剪切，从 ${s} 秒起共 $LEN 秒（已重新编码为 MP4）"`,
        `else`,
        `  $FF -ss ${s} -i ${f0} -t "$LEN" -map '0:v?' -map '0:a?' -c copy -avoid_negative_ts make_zero ${out("_cut", e0)}`,
        `  ok ${out("_cut", e0)} "不重新编码，从 ${s} 秒起共 $LEN 秒（视频的起点可能略早于指定时间）"`,
        `fi`);
    } else if (op === "compress") {
      const mb = num(args, "target_mb", "目标体积 target_mb", 0.1, 500);
      if (mb === undefined) throw new Error("压缩要告诉我目标体积 target_mb（单位 MB）");
      body.push(...guardAll,
        `D=$(dur ${f0}); need_dur "$D"`,
        `TARGET=$(awk -v m=${mb} 'BEGIN{printf "%d", m*1048576}')`,
        `TB=$(awk -v t="$TARGET" 'BEGIN{printf "%d", t*8*0.96}')`,
        `if ! has_v ${f0}; then`,
        `  AB=$(awk -v tb="$TB" -v d="$D" 'BEGIN{printf "%d", tb/d/1000}')`,
        `  [ "$AB" -ge 24 ] || die "这段音频 $(awk -v d="$D" 'BEGIN{printf "%d", d}') 秒，压到 ${mb} MB 声音没法听，目标至少要 $(awk -v d="$D" 'BEGIN{printf "%.1f", d*24*1000/8/0.96/1048576}') MB"`,
        `  [ "$AB" -le 256 ] || AB=256`,
        `  $FF -i ${f0} -vn -map 0:a:0 -c:a aac -b:a "$AB"k -movflags +faststart ${out("_small", "m4a")}`,
        `  ok ${out("_small", "m4a")} "音频，码率 $AB kbps，目标 ${mb} MB"`,
        `else`,
        `  if has_a ${f0}; then ABK=$(awk -v tb="$TB" -v d="$D" 'BEGIN{t=tb/d; print (t>800000?96:(t>400000?64:32))}'); else ABK=0; fi`,
        `  VB=$(awk -v tb="$TB" -v d="$D" -v a="$ABK" 'BEGIN{printf "%d", tb/d - a*1000}')`,
        `  MIN=$(awk -v d="$D" -v a="$ABK" 'BEGIN{printf "%.2f", (60000+a*1000)*d/8/0.96/1048576}')`,
        `  [ "$VB" -ge 60000 ] || die "这段 $(awk -v d="$D" 'BEGIN{printf "%d", d}') 秒的视频压到 ${mb} MB 画质没法看，目标至少要 $MIN MB"`,
        `  H=$(awk -v v="$VB" -v m=${maxH} 'BEGIN{h=1080; if (v<250000) h=360; else if (v<600000) h=480; else if (v<1500000) h=720; if (h>m) h=m; print h}')`,
        `  enc() { $FF -i ${f0} -map 0:v:0 -vf "scale=-2:'trunc(min(ih,$H)/2)*2'" -c:v libx264 -preset veryfast -b:v "$1" -pass 1 -passlogfile pass -an -f null /dev/null; $FF -i ${f0} -map 0:v:0 -map '0:a:0?' -vf "scale=-2:'trunc(min(ih,$H)/2)*2'" -c:v libx264 -preset veryfast -b:v "$1" -pass 2 -passlogfile pass -pix_fmt yuv420p -c:a aac -b:a "$ABK"k -movflags +faststart ${out("_small", "mp4")}; }`,
        `  enc "$VB"`,
        // Two-pass lands close but not exact; one corrective round if it overshoots.
        `  S=$(sz ${out("_small", "mp4")})`,
        `  if [ "$S" -gt "$TARGET" ]; then VB=$(awk -v v="$VB" -v t="$TARGET" -v s="$S" 'BEGIN{printf "%d", v*t/s*0.95}'); [ "$VB" -ge 40000 ] || die "压不到 ${mb} MB，目标至少要 $MIN MB"; enc "$VB"; S=$(sz ${out("_small", "mp4")}); fi`,
        `  rm -f pass-*.log* pass-*.mbtree`,
        `  ok ${out("_small", "mp4")} "目标 ${mb} MB，实际 $(human "$S")，最高 $H p，视频码率约 $((VB/1000)) kbps"`,
        `fi`);
    } else if (op === "speed") {
      const k = num(args, "factor", "倍速 factor", 0.5, 3);
      if (k === undefined) throw new Error("变速要告诉我倍速 factor，0.5 到 3 之间");
      const af = k > 2 ? `atempo=2,atempo=${+(k / 2).toFixed(4)}` : `atempo=${k}`;
      const tag = "_x" + String(k).replace(".", "_");
      body.push(...guardAll,
        `if has_v ${f0}; then`,
        `  $FF -i ${f0} -map 0:v:0 -map '0:a:0?' -vf "setpts=PTS/${k},scale=-2:'trunc(min(ih,${maxH})/2)*2'" -af "${af}" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart ${out(tag, "mp4")}`,
        `  ok ${out(tag, "mp4")} "${k} 倍速，视频和声音一起变"`,
        `else`,
        `  $FF -i ${f0} -vn -map 0:a:0 -af "${af}" -c:a aac -b:a 160k -movflags +faststart ${out(tag, "m4a")}`,
        `  ok ${out(tag, "m4a")} "${k} 倍速"`,
        `fi`);
    } else if (op === "concat") {
      const e0 = ext(files[0].name);
      const list = F.map(f => sh(f)).join(" ");
      body.push(
        `TOTAL=0`,
        `for f in ${list}; do d=$(dur "$f"); guard "$d"; need_dur "$d"; TOTAL=$(awk -v t="$TOTAL" -v d="$d" 'BEGIN{print t+d}'); done`,
        `guard "$TOTAL"`,
        `V0=0; has_v ${f0} && V0=1`,
        `A_ALL=1; for f in ${list}; do V=0; has_v "$f" && V=1; [ "$V" = "$V0" ] || die "不能把音频和视频拼在一起"; has_a "$f" || A_ALL=0; done`,
        `sig() { ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt,r_frame_rate -of csv=p=0 "$1"; ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "$1"; }`,
        `S0=$(sig ${f0}); SAME=1; for f in ${list}; do [ "$(sig "$f")" = "$S0" ] || SAME=0; done`,
        `case ${sh(e0)} in mp4|m4v|mov|mkv|ts|mp3|m4a|aac|wav|flac|ogg|opus|webm|avi) ;; *) SAME=0;; esac`,
        `if [ "$SAME" = 1 ]; then`,
        `  rm -rf cc; mkdir cc; i=0; for f in ${list}; do ln -s "$PWD/$f" cc/c$i.${e0}; echo "file 'c$i.${e0}'" >> cc/list.txt; i=$((i+1)); done`,
        `  $FF -f concat -safe 0 -i cc/list.txt -c copy ${out("_concat", e0)}`,
        `  ok ${out("_concat", e0)} "编码一致，直接首尾相接，没有重新编码，共 $(awk -v t="$TOTAL" 'BEGIN{printf "%.1f", t}') 秒"`,
        `elif [ "$V0" = 1 ]; then`,
        `  IFS=x read -r W H < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 ${f0})`,
        `  if [ "$H" -gt ${maxH} ]; then W=$((W*${maxH}/H)); H=${maxH}; fi; W=$((W/2*2)); H=$((H/2*2))`,
        `  INS=(); FG=""; CAT=""; i=0; for f in ${list}; do INS+=(-i "$f"); FG="$FG[$i:v:0]scale=$W:$H:force_original_aspect_ratio=decrease,pad=$W:$H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v$i];"; if [ "$A_ALL" = 1 ]; then FG="$FG[$i:a:0]aresample=44100,aformat=channel_layouts=stereo[a$i];"; CAT="$CAT[v$i][a$i]"; else CAT="$CAT[v$i]"; fi; i=$((i+1)); done`,
        `  if [ "$A_ALL" = 1 ]; then AV="v=1:a=1[v][a]"; MAPS="-map [v] -map [a] -c:a aac -b:a 160k"; else AV="v=1:a=0[v]"; MAPS="-map [v]"; fi`,
        `  $FF "\${INS[@]}" -filter_complex "$FG$CAT""concat=n=${files.length}:$AV" $MAPS -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart ${out("_concat", "mp4")}`,
        `  ok ${out("_concat", "mp4")} "编码不一致，已统一成 $W x $H 重新编码为 MP4$([ "$A_ALL" = 1 ] || echo '（有文件没有声音，成品去掉了声音）')"`,
        `else`,
        `  INS=(); FG=""; CAT=""; i=0; for f in ${list}; do INS+=(-i "$f"); FG="$FG[$i:a:0]aresample=44100,aformat=channel_layouts=stereo[a$i];"; CAT="$CAT[a$i]"; i=$((i+1)); done`,
        `  $FF "\${INS[@]}" -filter_complex "$FG$CAT""concat=n=${files.length}:v=0:a=1[a]" -map "[a]" -c:a aac -b:a 160k ${out("_concat", "m4a")}`,
        `  ok ${out("_concat", "m4a")} "编码不一致，已重新编码为 M4A"`,
        `fi`);
    } else if (op === "frames") {
      const n = Math.round(num(args, "count", "截图张数", 1, 30) ?? 6);
      const w = Math.round(num(args, "width", "截图宽度", 160, 1920) ?? 1280);
      body.push(...guardAll,
        `has_v ${f0} || die "这个文件里没有画面"`,
        `D=$(dur ${f0}); need_dur "$D"`,
        `STEM=${sh(stem)}`,
        `for i in $(seq 0 ${n - 1}); do t=$(awk -v d="$D" -v i=$i 'BEGIN{printf "%.3f", d*(i+0.5)/${n}}'); k=$(printf "%02d" $((i+1))); f="out/$STEM"_"$k.jpg"`,
        `  $FF -ss "$t" -i ${f0} -frames:v 1 -vf "scale='min(${w},iw)':-2" -q:v 3 "$f"; ok "$f" "在 $t 秒处"; done`);
    }
    return [PRELUDE + body.join("\n") + "\n" + FINISH];
  },
  report(stdout) {
    const lines = stdout.join("\n").split("\n").map(s => s.trim());
    const r: Record<string, any> = {};
    const info = lines.find(l => l.startsWith("INFO "));
    if (info) { try { r.信息 = JSON.parse(info.slice(5)); } catch { r.信息 = info.slice(5); } }
    const oks = lines.filter(l => l.startsWith("OK "));
    if (oks.length) r.成品 = oks.slice(0, 30).map(l => l.slice(3));
    const t = lines.find(l => /^用时 \d+ 秒$/.test(l));
    if (t) r.用时 = t.slice(3);
    const err = lines.find(l => l.startsWith("错误："));
    if (err) r.错误 = err.slice(3);
    return r;
  },
};
export default skill;
