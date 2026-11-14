// The skill runner: tool `skill` lets the chat model pick a fixed recipe from src/skills/ and fill in its
// arguments instead of writing shell commands. This file resolves the input files, runs the recipe in a
// fresh directory of the cloud computer, hands ./out back to the chat (big results through the file box)
// and always removes the run directory afterwards.
import type { Feature, Ctx } from "./types.ts";
import type { Tool } from "../core.ts";
import type { Host } from "../tools.ts";
import type { Hub } from "../hub.ts";
import type { ComputerRequest, ComputerResult } from "../computer.ts";
import type { Skill, SkillArgs, SkillFile } from "../skills/types.ts";
import { SKILLS } from "../skills/index.ts";
import { boxFile, boxDownloadCommand, boxUpload } from "./filebox.ts";

const CAP = 25 * 1024 * 1024;    // the cloud computer's path in and out for one file
const MAX_BACK = 6;              // files runComputer brings back in one call
const MAX_IN = 12;               // files runComputer puts in one call
const ROOT = "/work/skill";

/** Everything with side effects, replaceable in tests. */
export type Deps = {
  skills: Skill[];
  runComputer(hub: Hub, req: ComputerRequest): Promise<ComputerResult>;
  boxFile: typeof boxFile;
  boxDownloadCommand: typeof boxDownloadCommand;
  boxUpload: typeof boxUpload;
  id(): string;
};
const realDeps: Deps = {
  skills: SKILLS,
  // Imported on use: computer.ts needs the Workers runtime.
  runComputer: async (hub, req) => (await import("../computer.ts")).runComputer(hub, req),
  boxFile, boxDownloadCommand, boxUpload,
  id: () => [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, "0")).join(""),
};

const clip = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };
const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);
const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const rawExt = (name: string) => name.match(/\.([^./]{1,10})$/)?.[1] || "";
const ext = (name: string) => rawExt(name).toLowerCase();
const normExt = (e: string) => (e === "jpeg" ? "jpg" : e === "tiff" ? "tif" : e === "htm" ? "html" : e);
const mb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " 字节");

// ---------- naming ----------

/** A file name that is safe as one shell word and a path part: CJK and other letters stay, anything a shell or
 *  a file system treats specially becomes "_", the extension is kept and the length is bounded. */
export function safeName(name: string): string {
  let base = String(name || "").split(/[\\/]/).pop() || "";
  base = base.normalize("NFC").replace(/[\u0000-\u001f\u007f\s'"`$!&;|<>(){}\[\]*?#~:\\]/gu, "_").replace(/_+/g, "_");
  if (/^[.\-]/.test(base)) base = "_" + base.replace(/^[.\-]+/, "");
  const e = rawExt(base), stem = e ? base.slice(0, -(e.length + 1)) : base;
  const short = [...stem].slice(0, 60).join("").replace(/^_+$/, "");
  return (short || "file") + (e ? "." + e : "");
}

/** Safe names for a list of inputs, with collisions numbered: a.pdf, a-2.pdf … (case-insensitive). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map(n => {
    const s = safeName(n), e = rawExt(s), stem = e ? s.slice(0, -(e.length + 1)) : s;
    let pick = s;
    for (let i = 2; seen.has(pick.toLowerCase()); i++) pick = stem + "-" + i + (e ? "." + e : "");
    seen.add(pick.toLowerCase());
    return pick;
  });
}

// ---------- validation ----------

/** Close matches for a mistyped skill name. */
export function closeNames(skills: Skill[], name: string): string[] {
  const n = name.toLowerCase().trim(), dist = (a: string, b: string) => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]; d[0] = i;
      for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
    }
    return d[b.length];
  };
  const parts = n.split(/[-_\s]+/).filter(p => p.length > 1);
  return skills.map(s => ({ s, score: s.name.includes(n) || (n.length > 2 && n.includes(s.name)) ? 0 : s.title.includes(name.trim()) && name.trim() ? 0
    : Math.min(dist(n, s.name), parts.some(p => s.name.split("-").includes(p)) ? 3 : 99) }))
    .filter(x => x.score <= Math.max(3, Math.floor(n.length / 3))).sort((a, b) => a.score - b.score).slice(0, 5).map(x => x.s.name);
}

const TYPE_CN: Record<string, string> = { string: "文字", number: "数字", integer: "整数", boolean: "true 或 false", array: "列表" };

/** Checks and normalizes the arguments against the skill's declaration; returns the clean args or a Chinese error. */
export function checkArgs(skill: Skill, given: any): { ok: true; args: SkillArgs } | { ok: false; error: string } {
  const spec = skill.args || {}, args: SkillArgs = {};
  if (given !== undefined && given !== null && (typeof given !== "object" || Array.isArray(given))) return { ok: false, error: "args 要是一个对象，比如 {\"" + (Object.keys(spec)[0] || "参数") + "\": …}" };
  const raw = given || {};
  const unknown = Object.keys(raw).filter(k => !(k in spec));
  if (unknown.length) return { ok: false, error: "「" + skill.title + "」没有参数 " + unknown.join("、") + (Object.keys(spec).length ? "，能填的是：" + Object.keys(spec).join("、") : "，它不需要参数") };
  for (const k of skill.required || []) if (raw[k] === undefined || raw[k] === null || raw[k] === "") return { ok: false, error: "「" + skill.title + "」缺少参数 " + k + "（" + (spec[k]?.description || "") + "）" };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    const s = spec[k], bad = (what = TYPE_CN[s.type]) => ({ ok: false as const, error: "参数 " + k + " 要是" + what + "（" + s.description + "），收到的是 " + clip(JSON.stringify(v), 60) });
    let val: any = v;
    if (s.type === "string") { if (typeof v === "object") return bad(); val = String(v); }
    else if (s.type === "number" || s.type === "integer") {
      val = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(val) || (s.type === "integer" && !Number.isInteger(val))) return bad();
    } else if (s.type === "boolean") {
      if (v === true || v === "true") val = true; else if (v === false || v === "false") val = false; else return bad();
    } else if (s.type === "array") {
      if (!Array.isArray(v)) return bad();
      const it = s.items?.type, en: string[] | undefined = s.items?.enum;
      if (it === "string" && v.some(x => typeof x === "object")) return bad("文字的列表");
      if ((it === "number" || it === "integer") && v.some(x => !Number.isFinite(Number(x)) || (it === "integer" && !Number.isInteger(Number(x))))) return bad(it === "integer" ? "整数的列表" : "数字的列表");
      val = it === "string" ? v.map(String) : it === "number" || it === "integer" ? v.map(Number) : v;
      if (en && val.some((x: any) => !en.includes(String(x)))) return { ok: false, error: "参数 " + k + " 里每一项只能是 " + en.join(" / ") };
    }
    if (s.enum && s.type !== "array" && !s.enum.includes(String(val))) return { ok: false, error: "参数 " + k + " 只能是 " + s.enum.join(" / ") + "，收到的是 " + clip(String(val), 40) };
    args[k] = val;
  }
  return { ok: true, args };
}

/** Number of files and their extensions. `names` may be empty while only counting. */
export function checkFiles(skill: Skill, count: number, names?: string[]): string | null {
  const f = skill.files, what = f?.what ? "（" + f.what + "）" : "";
  if (!f) return count ? "「" + skill.title + "」不需要输入文件，files 留空" : null;
  if (count < f.min) return "「" + skill.title + "」要 " + (f.min === f.max ? f.min : "至少 " + f.min) + " 个文件" + what + "，现在给了 " + count + " 个";
  if (count > f.max) return "「" + skill.title + "」最多 " + f.max + " 个文件" + what + "，现在给了 " + count + " 个";
  if (names && f.extensions?.length) {
    const ok = new Set(f.extensions.map(e => normExt(e.toLowerCase().replace(/^\./, ""))));
    const bad = names.filter(n => !ok.has(normExt(ext(n))));
    if (bad.length) return "「" + skill.title + "」只收 " + f.extensions.join("、") + " 文件，" + bad.join("、") + " 不行";
  }
  return null;
}

// ---------- the commands ----------

/** One skill command, run by bash inside the run directory with errors stopping it (also inside pipes). */
export const wrap = (dir: string, command: string) => "cd " + sq(dir) + " || exit 1\nset -e -o pipefail\n" + command;

/** Puts the inputs in place: chat files were dropped in /work under temporary names, box files are downloaded. */
export function prepareCommand(dir: string, moves: { from: string; to: string }[], downloads: string[]) {
  return [
    "set -e",
    // Leftovers of runs whose cleanup never happened (the machine restarted mid-run) go after two hours.
    "find " + sq(ROOT) + " -mindepth 1 -maxdepth 1 -type d -mmin +120 -exec rm -rf {} + 2>/dev/null || true",
    "mkdir -p " + sq(dir + "/in") + " " + sq(dir + "/out"),
    ...moves.map(m => "mv -f -- " + sq(m.from) + " " + sq(dir + "/in/" + m.to)),
    ...(downloads.length ? ["cd " + sq(dir), ...downloads] : []),
  ].join("\n");
}

/** Lists ./out, and fills ./ship with what goes back: the files themselves, or one zip of ./out when there are
 *  more than six or they sit in folders. Python because the listing and the zip must work the same everywhere. */
export function finishCommand(dir: string, zipName: string) {
  return "cd " + sq(dir) + " || exit 1\nset -e\nPY=$(command -v python3 || command -v python)\n\"$PY\" - " + sq(zipName) + " <<'PY'\n" + [
    "import os, sys, shutil, zipfile",
    "files = []",
    "for r, ds, fs in os.walk('out'):",
    "    ds.sort()",
    "    for f in sorted(fs): files.append(os.path.relpath(os.path.join(r, f), 'out'))",
    "shutil.rmtree('ship', ignore_errors=True); os.mkdir('ship')",
    "for f in files: print('@@out\\t%d\\t%s' % (os.path.getsize(os.path.join('out', f)), f))",
    "if len(files) > " + MAX_BACK + " or any(os.sep in f for f in files):",
    "    with zipfile.ZipFile(os.path.join('ship', sys.argv[1]), 'w', zipfile.ZIP_DEFLATED) as z:",
    "        for f in files: z.write(os.path.join('out', f), f)",
    "    print('@@zip')",
    "else:",
    "    for f in files: os.link(os.path.join('out', f), os.path.join('ship', f))",
    "for f in sorted(os.listdir('ship')): print('@@ship\\t%d\\t%s' % (os.path.getsize(os.path.join('ship', f)), f))",
  ].join("\n") + "\nPY";
}

export function parseFinish(stdout: string) {
  const out: { name: string; size: number }[] = [], ship: { name: string; size: number }[] = [];
  let zipped = false;
  for (const line of stdout.split("\n")) {
    if (line === "@@zip") zipped = true;
    const m = line.match(/^@@(out|ship)\t(\d+)\t(.+)$/);
    if (m) (m[1] === "out" ? out : ship).push({ name: m[3], size: Number(m[2]) });
  }
  return { out, ship, zipped };
}

// ---------- handing results over ----------

const IMG = /\.(png|jpe?g|gif|webp)$/i;
async function deliverFiles(host: Host, files: { name: string; bytes: Uint8Array }[], deliver: boolean) {
  const sent: string[] = [], failed: string[] = [], kept: string[] = [];
  let queued = false;
  for (const f of files) {
    const base = f.name.split("/").pop() || f.name, isImage = IMG.test(base), isVideo = /\.mp4$/i.test(base);
    const mime = "image/" + ext(base).replace("jpg", "jpeg");
    if (!deliver) {
      const id = isImage ? (await host.sendImage(f.bytes, base, mime, true)).id : await host.keepFile(base, f.bytes);
      kept.push(base + " → " + (id || "没存下"));
      continue;
    }
    const r = isImage ? await host.sendImage(f.bytes, base, mime) : isVideo ? await host.sendVideo(base, f.bytes) : await host.sendFile(base, f.bytes);
    let id = isImage ? (r as any).id || "" : "";
    if (!isImage && r.ok) id = await host.keepFile(base, f.bytes);
    if (r.queued) queued = true;
    (r.ok ? sent : failed).push(base + (r.ok ? (id ? " → " + id : "") : "（" + (r.error || "发送失败") + "）"));
  }
  return {
    ...(deliver ? { files_sent: sent } : { kept_as_materials: kept, note: "没发群里。图的编号能排进 show 的网页，文件编号能放进下一次 skill、run_python 或 computer 的 files" }),
    ...(failed.length ? { files_not_sent: failed } : {}),
    ...(queued ? { delivery: "现在群里没人说话，QQ 不让主动发图和文件；已经排好队，下一次有人说话时会自动发出去。照实说还没发出去" } : {}),
  };
}

// ---------- running ----------

/** Pulls the link out of "[文件 名字 链接]" and keeps the name as a fallback. */
function parseRef(ref: string): { ref: string; name?: string } {
  const t = ref.trim(), m = t.match(/^\[?文件\s+(.+?)\s+(https?:\/\/\S+?)\]?$/);
  return m ? { ref: m[2], name: m[1] } : { ref: t.replace(/^\[|\]$/g, "") };
}

function failureText(skill: Skill, r: ComputerResult, count: number, limit: number) {
  const i = r.steps.findIndex(s => s.exit !== 0), st = i >= 0 ? r.steps[i] : null;
  const where = !st ? "" : i === 0 ? "准备输入文件时" : i <= count ? (count > 1 ? "第 " + i + " 条命令" : "命令") : "整理结果时";
  if (!st) return { error: "「" + skill.title + "」没跑完：" + (r.error || "不知道为什么停了"), tail: "" };
  const raw = (st.stderr.trim() || st.stdout.trim()).replace(/\n（超时，被停掉了）$/, "");
  const last = raw.split("\n").map(l => l.trim()).filter(Boolean).pop() || "";
  const error = st.exit === 124 ? "「" + skill.title + "」" + where + "超时了（限 " + limit + " 秒），被停掉了"
    : "「" + skill.title + "」" + where + "出错了（退出码 " + st.exit + "）" + (last ? "：" + clip(last, 160) : "");
  return { error, tail: tail(raw, 1500) };
}

/** Runs one skill for a conversation; other features call this directly. */
export async function runSkill(ctx: Ctx, name: string, files: string[] = [], args: SkillArgs = {}, deliver = true, deps: Deps = realDeps): Promise<any> {
  const { hub, conv, host } = ctx;
  const skill = deps.skills.find(s => s.name === String(name || "").trim());
  if (!skill) {
    const close = closeNames(deps.skills, String(name || ""));
    return { ok: false, error: "没有叫「" + name + "」的技能。" + (close.length ? "是不是：" + close.join("、") + "？" : "现有的：" + deps.skills.map(s => s.name).join("、")) };
  }
  const checked = checkArgs(skill, args);
  if (!checked.ok) return { ok: false, error: checked.error };
  const refs = (Array.isArray(files) ? files : files ? [files] : []).map(String).map(s => s.trim()).filter(Boolean);
  const countErr = checkFiles(skill, refs.length);
  if (countErr) return { ok: false, error: countErr };

  // Resolve every input: box files by name only (downloaded inside the machine), the rest as bytes.
  const inputs: { name: string; bytes?: Uint8Array; box?: string }[] = [];
  for (const r of refs) {
    if (/^x\d+$/i.test(r)) {
      const b = deps.boxFile(hub, conv, r.toLowerCase());
      if (!b) return { ok: false, error: "文件箱里找不到 " + r + "（可能过期了或不是这个群的）" };
      inputs.push({ name: b.name, box: r.toLowerCase() });
      continue;
    }
    const p = parseRef(r);
    const got = await host.fileRef(p.ref).catch(() => null);
    if (!got) return { ok: false, error: "取不到文件 " + clip(r, 80) + "，可以让群友重发，或者换成文件编号" };
    if (got.bytes.length > CAP) return { ok: false, error: (got.name || p.name) + " 有 " + mb(got.bytes.length) + "，超过 25 MB，放不进云电脑；先存进文件箱，再用 x 开头的编号" };
    inputs.push({ name: got.name || p.name || "file", bytes: got.bytes });
  }
  if (inputs.filter(f => f.bytes).length > MAX_IN) return { ok: false, error: "一次最多放 " + MAX_IN + " 个文件进云电脑" };
  const extErr = checkFiles(skill, inputs.length, inputs.map(f => f.name));
  if (extErr) return { ok: false, error: extErr };
  const names = uniqueNames(inputs.map(f => f.name)), skillFiles: SkillFile[] = names.map(n => ({ name: n }));

  let commands: string[];
  try { commands = skill.commands(checked.args, skillFiles).map(String).filter(c => c.trim()); }
  catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
  if (!commands.length) return { ok: false, error: "「" + skill.title + "」没有生成要跑的命令" };

  const downloads: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    if (!inputs[i].box) continue;
    const c = deps.boxDownloadCommand(hub, conv, inputs[i].box!, "./in/" + names[i]);
    if (!c) return { ok: false, error: "文件箱现在用不了，取不到 " + inputs[i].box };
    downloads.push(c);
  }
  if (!(await host.quota("skill", Number(host.cfg("skill_daily")) || 60))) return { ok: false, error: "今天用技能的次数用完了，明天再来" };

  const id = deps.id(), dir = ROOT + "/" + id, limit = Math.min(Math.max(Number(skill.timeoutSeconds) || 300, 10), 1700);
  const temp = (i: number) => "skill-" + id + "-" + i;
  const put = inputs.map((f, i) => (f.bytes ? { name: temp(i), bytes: f.bytes, to: names[i] } : null)).filter(Boolean) as { name: string; bytes: Uint8Array; to: string }[];
  const steps = [
    prepareCommand(dir, put.map(p => ({ from: "/work/" + p.name, to: p.to })), downloads),
    ...commands.map(c => wrap(dir, c)),
    finishCommand(dir, safeName(skill.name + "-结果.zip")),
  ];
  const packs = skill.packs || [];
  let r: ComputerResult | null = null, cleanup: ComputerResult | null = null;
  const big: { name: string; size: number; ref?: string; link?: string; error?: string }[] = [];
  let listed: ReturnType<typeof parseFinish> = { out: [], ship: [], zipped: false };
  try {
    r = await deps.runComputer(hub, {
      commands: steps, files: put.map(p => ({ name: p.name, bytes: p.bytes })), collect: [dir.replace(/^\/work\//, "") + "/ship/*"],
      timeoutSeconds: limit + 60 + (downloads.length ? 300 : 0), ...(packs.length ? { packs } : {}),
    });
    if (r.ok) listed = parseFinish(r.steps[r.steps.length - 1]?.stdout || "");
  } catch (e: any) {
    r = { ok: false, steps: [], files: [], seconds: 0, error: String(e?.message || e) };
  } finally {
    // Big results go to the box in the same call that removes the run directory, so the directory never outlives the run.
    const uploads = listed.ship.filter(f => f.size > CAP).map(f => ({ f, up: deps.boxUpload(hub, conv, dir + "/ship/" + f.name, f.name) }));
    cleanup = await deps.runComputer(hub, {
      commands: [...uploads.map(u => "( " + u.up.command + "\n) || echo " + sq("上传失败：" + u.f.name) + " >&2"), "rm -rf -- " + sq(dir)], timeoutSeconds: uploads.length ? 900 : 30,
    }).catch(e => ({ ok: false, steps: [], files: [], seconds: 0, error: String(e?.message || e) }));
    for (const u of uploads) {
      const c = await u.up.claim().catch(() => null);
      big.push(c ? { name: c.name, size: c.size || u.f.size, ref: c.ref, link: c.link } : { name: u.f.name, size: u.f.size, error: "超过 25 MB，发不了，文件箱现在也存不进去" });
    }
  }
  const seconds = Math.round(((r?.seconds || 0) + (cleanup?.seconds || 0)) * 10) / 10;
  if (!r?.ok) {
    const f = failureText(skill, r!, commands.length, limit);
    return { ok: false, skill: skill.name, error: f.error, ...(f.tail ? { output_tail: f.tail } : {}), seconds, ...(cleanup && !cleanup.ok ? { cleanup_failed: true } : {}) };
  }

  let facts: Record<string, any> | undefined;
  if (skill.report) { try { facts = skill.report(r.steps.slice(1, 1 + commands.length).map(s => s.stdout)); } catch {} }
  const small = r.files.filter(f => f.bytes.length <= CAP);
  const handed = small.length ? await deliverFiles(host, small, deliver) : {};
  const missing = listed.ship.filter(f => f.size <= CAP && !small.some(s => (s.name.split("/").pop() || s.name) === f.name)).map(f => f.name);
  return {
    ok: true, skill: skill.name,
    produced: listed.out.map(f => ({ name: f.name, size: mb(f.size) })),
    ...(!listed.out.length ? { note: "跑完了，但没有产出文件" } : {}),
    ...(listed.zipped ? { zipped: "结果有 " + listed.out.length + " 个文件" + (listed.out.some(f => f.name.includes("/")) ? "（带文件夹）" : "") + "，打成了一个压缩包 " + (listed.ship[0]?.name || "") } : {}),
    ...handed,
    ...(big.some(b => b.ref) ? { big_files: big.filter(b => b.ref).map(b => ({ name: b.name, size: mb(b.size), ref: b.ref, link: b.link })), big_note: "这些文件太大，放进了文件箱：把链接发给群友下载；编号能放进下一次 skill 的 files" } : {}),
    ...(big.some(b => b.error) ? { too_large: big.filter(b => b.error).map(b => b.name + "（" + mb(b.size) + "）：" + b.error) } : {}),
    ...(missing.length ? { not_collected: missing } : {}),
    ...(facts && Object.keys(facts).length ? { facts } : {}),
    seconds,
  };
}

// ---------- the tool ----------

const fileRule = (s: Skill) => (!s.files ? "不要文件" : (s.files.min === s.files.max ? s.files.min : s.files.min + "–" + s.files.max) + " 个" + (s.files.extensions?.length ? " " + s.files.extensions.join("/") : "") + " 文件" + (s.files.what ? "（" + s.files.what + "）" : ""));

export function describeSkill(s: Skill) {
  return {
    name: s.name, title: s.title, when: s.when, files: fileRule(s),
    args: Object.fromEntries(Object.entries(s.args || {}).map(([k, a]) => [k, { type: a.type, description: a.description, ...(a.enum ? { enum: a.enum } : {}), ...((s.required || []).includes(k) ? { required: true } : {}) }])),
    ...(s.timeoutSeconds ? { time_limit_seconds: s.timeoutSeconds } : {}),
  };
}

/** The tool description, with a one-line index of the registered skills. */
export function toolDescription(skills: Skill[]) {
  const index = skills.map(s => "- " + s.name + " — " + s.title + " — " + clip(s.when.replace(/\s+/g, " "), 40)).join("\n");
  return "现成的技能：写好、审过的固定做法，在云电脑里跑。文件转换、PDF 处理、排版成文档、成批处理图片和音视频，先用这个；技能覆盖不到的事才用 computer 自己写命令。" +
    "op=run：name 填技能名，files 填输入文件（[文件 名字 链接] 里的链接、文件编号 f12、图片编号 123-0 / g12 / 存过的名字、文件箱编号 x12），args 填参数；结果直接发群里（deliver=false 只返回编号，给下一步用），超过 25 MB 的放进文件箱给链接。" +
    "op=list：看每个技能要几个什么文件、有哪些参数。不确定参数时先 list。\n" + (index || "（还没有技能）");
}

function skillTool(ctx: Ctx, deps: Deps): Tool {
  return {
    name: "skill", work: true, slow: true,
    description: toolDescription(deps.skills),
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["run", "list"], description: "run 跑一个技能；list 列出全部技能和参数" },
        name: { type: "string", description: "run：技能名，如 " + (deps.skills[0]?.name || "doc-to-pdf") },
        files: { type: "array", items: { type: "string" }, description: "run：输入文件，按技能要的个数和格式给" },
        args: { type: "object", description: "run：技能的参数，见 list" },
        deliver: { type: "boolean", description: "默认 true，结果直接发群里；只是中间素材时填 false，只返回编号" },
      },
      required: ["op"],
    },
    run: async a => {
      if (a.op === "list") return { ok: true, count: deps.skills.length, skills: deps.skills.map(describeSkill) };
      if (a.op !== "run") return { ok: false, error: "op 要是 run 或 list" };
      if (!a.name) return { ok: false, error: "要给技能名 name，现有的：" + deps.skills.map(s => s.name).join("、") };
      return runSkill(ctx, String(a.name), Array.isArray(a.files) ? a.files : a.files ? [a.files] : [], a.args || {}, a.deliver !== false, deps);
    },
  };
}

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Test seam: the feature built over other skills and machine. */
export function makeFeature(deps: Deps = realDeps): Feature {
  return {
    name: "skills",
    tunables: { skill_daily: { default: 60, min: 0, max: 300, what: "每天最多用几次现成技能" } },
    about: [
      "技能是写好、审过的固定做法（文件转换、PDF、排版、图片和音视频批处理等），我只挑技能、填参数，命令不用现写，在云电脑里跑完把结果发回群里",
      "现在有 " + deps.skills.length + " 个技能" + (deps.skills.length ? "：" + deps.skills.map(s => s.title).join("、") : ""),
      "新技能要在代码仓库里加一个文件，经过审查的 PR 合并后才上线；我可以用 code_task 提一个这样的 PR",
      "超过 25 MB 的结果放进文件箱，给下载链接",
    ],
    tools: ctx => [skillTool(ctx, deps)],
    async admin(hub, req, url, body) {
      if (url.pathname !== "/admin/skills") return null;
      if (req.method === "GET") return json({ ok: true, count: deps.skills.length, skills: deps.skills.map(describeSkill) });
      if (req.method !== "POST") return json({ ok: false, error: "GET 或 POST" }, 405);
      const conv = String(body?.conv || "");
      if (!conv) return json({ ok: false, error: '要给 conv，比如 "t:ag-skills"' }, 400);
      const tool = (hub.tools(conv) as Tool[]).find(t => t.name === "skill");
      if (!tool) return json({ ok: false, error: "skill 工具没注册" }, 500);
      const started = Date.now();
      try { const result = await tool.run({ op: "run", name: body.name, files: body.files || [], args: body.args || {}, deliver: body.deliver !== false }); return json({ ms: Date.now() - started, result }); }
      catch (e: any) { return json({ ok: false, error: String(e?.message || e) }, 500); }
    },
  };
}

const feature: Feature = makeFeature();
export default feature;
