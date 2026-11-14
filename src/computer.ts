// The cloud computer: one Linux container on Cloudflare Containers that background jobs run shell
// commands in (ffmpeg, git, Python, LibreOffice). It is billed per 10 ms while it runs, so it starts on
// demand, sleeps IDLE seconds after the last use, and every run is charged to the plan's meters together
// with that idle tail. Its prepared tools and any named workspace survive sleep as tarballs in R2, moved
// through the transfer feature's token links (src/feat/transfer.ts).
import { DurableObject } from "cloudflare:workers";
import type { Hub } from "./hub.ts";
import type { Env } from "./util.ts";
import { PART, CAP, cacheName, bootPlan, afterRestore, shouldSave, complete, issue, link, root, row, stored, remove, keysUnder, workspaceName } from "./feat/transfer.ts";

// With the prepared environment restored from R2 a wake-up costs seconds instead of half a minute, so a
// short idle tail is cheaper than keeping the machine up on the chance of another call soon.
const IDLE = 90;
// Memory and disk are billed for as long as the machine runs, CPU only while it computes. One full vCPU
// with "basic"-sized memory and disk installs the tools four times faster than 1/4 vCPU for the same CPU
// seconds, so the run (and the memory-hours) are shorter. 25 GiB-hours of memory = 25 hours of this.
const SIZE = { vcpu: 1, memoryMib: 1024, diskMb: 4000 };
// Debian trixie slim with Node 24, provided by Cloudflare: no Docker build or registry push. The disk
// does not survive sleep. After the first full install (about 25 s) the installed files are kept in R2 as
// one zstd tarball and later wake-ups unpack it; the full install stays as the fallback.
const IMAGE = "cloudflare/debian-trixie";
const MARK = "/opt/computer/ready-1";
const WORK = "/work";
const OUT_CAP = 20 * 1024;
const FILE_CAP = 25 * 1024 * 1024;
const MAX_FILES = 6;

const BOOT = String.raw`set -e
export DEBIAN_FRONTEND=noninteractive HOME=/root
mkdir -p /opt/computer ${WORK}
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils git fontconfig fonts-noto-cjk libatomic1 >/dev/null
# A static build unpacks in seconds; the Debian package takes over half a minute to install.
curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ -C /usr/local/bin --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe' \
  || apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh >/dev/null 2>&1
uv venv -q --seed --python 3.12 /opt/py
VIRTUAL_ENV=/opt/py uv pip install -q pandas matplotlib openpyxl python-pptx python-docx
# Node 26 ahead of the image's Node 24: the team's repositories are developed on 26 and their scripts
# rely on it (for one, the test runner taking a directory). Without it the image's Node stays in use.
(N=$(curl -fsSL https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt | grep -o 'node-v26[0-9.]*-linux-x64.tar.xz' | head -1) && [ -n "$N" ] \
  && mkdir -p /opt/node && curl -fsSL "https://nodejs.org/dist/latest-v26.x/$N" | tar -xJ -C /opt/node --strip-components=1) || rm -rf /opt/node
printf 'font.sans-serif: Noto Sans CJK SC, DejaVu Sans\naxes.unicode_minus: False\n' > /etc/matplotlibrc
# Builds matplotlib's font list now, so it lands in the cache and the first chart after a wake-up is quick.
MPLBACKEND=Agg MATPLOTLIBRC=/etc/matplotlibrc /opt/py/bin/python -c 'import matplotlib.pyplot'
echo 'export PATH=/opt/node/bin:/opt/py/bin:$PATH HOME=/root LANG=C.UTF-8 MPLBACKEND=Agg MATPLOTLIBRC=/etc/matplotlibrc' > /etc/profile.d/computer.sh
# LibreOffice adds most of a minute, so it is installed the first time something calls it.
for n in soffice libreoffice; do printf '#!/bin/sh\nL="libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui"; export DEBIAN_FRONTEND=noninteractive\n[ -x /usr/bin/soffice ] || apt-get install -y -qq --no-install-recommends $L >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq --no-install-recommends $L >/dev/null; }\nexec /usr/bin/%s "$@"\n' $n > /usr/local/bin/$n; chmod +x /usr/local/bin/$n; done
touch ${MARK}`;

const STAMP = "/tmp/computer-stamp", LIST = "/tmp/computer-cache.list";
// What the install added or changed (apt packages with their dpkg records, package lists and generated
// files, ffmpeg, uv and its Python, /opt/py, fonts and caches), minus downloads, logs and test suites.
// Taking every changed file rather than a list of tool paths is what makes apt packages work restored.
const SNAPSHOT = String.raw`cd / && find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path ${WORK} \
  -o -path /opt/computer -o -path /root/.cache/uv -o -path /var/cache/apt -o -path /var/log \
  -o -path /usr/share/doc -o -path /usr/share/man -o -path '*/site-packages/*/tests' -o -path '/root/.local/share/uv/python/*/lib/python3.12/test' \) -prune \
  -o -cnewer ${STAMP} ! -type d -printf '%P\n' > ${LIST}`;
// The image has Node but neither curl nor a zstd binary, so transfers are small Node programs. Node's
// zstd checks the frame checksum, so a cut-off or damaged download fails instead of unpacking garbage.
const FETCH = String.raw`const z=require("zlib"),{spawn}=require("child_process"),{Readable,pipeline}=require("stream");
const [url,dir]=process.argv.slice(1);
(async()=>{const r=await fetch(url);if(!r.ok)throw new Error("HTTP "+r.status);
const tar=spawn("tar",["-xf","-","-C",dir],{stdio:["pipe","inherit","inherit"]});
const done=new Promise((ok,no)=>tar.on("close",c=>c?no(new Error("tar exit "+c)):ok()));
await new Promise((ok,no)=>pipeline(Readable.fromWeb(r.body),z.createZstdDecompress(),tar.stdin,e=>e?no(e):ok()));
await done;})().catch(e=>{console.error(e.message);process.exit(1)});`;
// Packs with tar + zstd into a temporary file, then uploads it in parts below Cloudflare's 100 MB body limit.
const SEND = String.raw`const z=require("zlib"),fs=require("fs"),{spawn}=require("child_process"),{pipeline}=require("stream");
const [url,max,file,...args]=process.argv.slice(1),PART=${PART};
(async()=>{const tar=spawn("tar",args,{stdio:["ignore","pipe","inherit"]});
const done=new Promise((ok,no)=>tar.on("close",c=>c>1?no(new Error("tar exit "+c)):ok()));
const C=z.constants;
await new Promise((ok,no)=>pipeline(tar.stdout,z.createZstdCompress({params:{[C.ZSTD_c_compressionLevel]:3,[C.ZSTD_c_checksumFlag]:1}}),fs.createWriteStream(file),e=>e?no(e):ok()));
await done;const size=fs.statSync(file).size;
if(size>Number(max)){fs.rmSync(file);console.log(JSON.stringify({ok:false,bytes:size,error:"too big"}));return;}
const fd=fs.openSync(file,"r"),n=Math.max(1,Math.ceil(size/PART));
for(let i=0;i<n;i++){const len=Math.min(PART,size-i*PART),b=Buffer.alloc(len);fs.readSync(fd,b,0,len,i*PART);
const r=await fetch(url+"?part="+i+"&last="+(i===n-1?1:0),{method:"PUT",body:b});if(!r.ok)throw new Error("upload part "+i+": HTTP "+r.status+" "+(await r.text()).slice(0,200));}
fs.closeSync(fd);fs.rmSync(file);console.log(JSON.stringify({ok:true,bytes:size,parts:n}));
})().catch(e=>{try{fs.rmSync(file,{force:true})}catch{};console.error(e.message);process.exit(1)});`;
// Cheap proof that the unpacked tools run.
const CHECK = `ffmpeg -version >/dev/null && ffprobe -version >/dev/null && git --version >/dev/null && /opt/py/bin/python -c 'import sys' && mkdir -p ${WORK} /opt/computer && touch ${MARK}`;
/** The prepared environment is about 270 MB compressed; refuse to store something far larger. */
const ENV_MAX = 600 * 1024 * 1024;
// Everything that decides what the cache holds; changing any of it gives the cache a new name.
const RECIPE = [BOOT, SNAPSHOT, FETCH, "zstd-3"].join("\n");
let recipeName: Promise<string> | null = null;
const envName = () => (recipeName ??= cacheName(RECIPE));
/** A persistent workspace may hold at most this much (compressed). */
const WS_CAP = 300 * 1024 * 1024;
// Skipped when a workspace is saved: reinstallable dependencies and any single file over 50 MB (big git
// packs, datasets, build outputs), which would push most workspaces past the cap. Git history beyond
// that stays, so a clone keeps working after the machine slept.
const WS_SKIP = ["node_modules", ".venv", "__pycache__", ".cache"];
const WS_BIG = "50M";

export type Step = { command: string; exit: number; stdout: string; stderr: string; seconds: number };
export type ComputerRequest = {
  commands: string[]; files?: { name: string; bytes: Uint8Array }[]; collect?: string[]; timeoutSeconds?: number;
  /** Environment for the commands of this run only (tokens, keys). Never written to disk or to any log here. */
  env?: Record<string, string>;
  /** Keeps /work/<workspace> across sleeps: restored from R2 before the commands, saved after them (≤ 300 MB). */
  workspace?: string;
};
export type Workspace = { name: string; restored: boolean; saved_bytes?: number; left_out?: string[]; error?: string };
export type ComputerResult = {
  ok: boolean; steps: Step[]; files: { name: string; bytes: Uint8Array }[]; seconds: number;
  woke?: boolean; bootstrap_seconds?: number; skipped?: string[]; error?: string;
  /** How the tools got there after a wake-up: unpacked from the R2 cache, or installed from the internet. */
  setup?: "restored" | "installed"; restore_error?: string; workspace?: Workspace;
};
/** Signed links the machine uses to fetch or save the prepared environment (from the transfer feature). */
export type CacheLinks = { get?: string; put?: string };

const secs = (from: number) => Math.round((Date.now() - from) / 100) / 10;

/** Reads a stream up to `cap` bytes and drains the rest, so huge output never sits in the object's memory. */
async function capped(stream: ReadableStream | null, cap: number) {
  if (!stream) return { bytes: new Uint8Array(), cut: false };
  const parts: Uint8Array[] = [];
  let size = 0, cut = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const v = value as Uint8Array, take = v.subarray(0, Math.max(0, cap - size));
    if (take.length) { parts.push(take); size += take.length; }
    if (take.length < v.length) cut = true;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { bytes, cut };
}
const text = (r: { bytes: Uint8Array; cut: boolean }) => new TextDecoder().decode(r.bytes) + (r.cut ? "\n…（输出太长，后面截掉了）" : "");

export class Computer extends DurableObject<Env> {
  private booting: Promise<{ bootstrap_seconds: number; setup?: "restored" | "installed"; saving?: boolean; restore_error?: string }> | null = null;
  private saving: Promise<void> | null = null;
  private pendingSave = "";
  private busy = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A restarted object (after a deploy) loses the timeout; without it the container stops almost at once.
    const box = ctx.container;
    if (box?.running) ctx.blockConcurrencyWhile(() => box.setInactivityTimeout(IDLE * 1000).catch(() => {}));
  }

  private get box() {
    if (!this.ctx.container) throw new Error("这个 Worker 没有配置容器");
    return this.ctx.container;
  }

  // The alarm puts the machine to sleep IDLE seconds after the last use. The inactivity timeout alone
  // starts counting only once this object has left memory, which adds an unmetered minute or more.
  private async touch() { await this.ctx.storage.setAlarm(Date.now() + IDLE * 1000); }

  // Work in progress postpones the shutdown, but not for ever: a command that never returns (a server
  // left in the foreground, a hung download) would otherwise keep the machine up and the meter running.
  // The longest run a caller may ask for is 30 minutes, so anything busy beyond 35 is stuck.
  private busyFrom = 0;
  private enter() { if (this.busy++ === 0) this.busyFrom = Date.now(); }
  private leave() { this.busy = Math.max(0, this.busy - 1); }

  async alarm() {
    if (this.busy > 0 && Date.now() - this.busyFrom < 35 * 60000) return this.touch();
    this.busy = 0;
    if (this.box.running) await this.box.destroy().catch(() => {});
  }

  private async sh(command: string, seconds: number, args: string[] = [], stdin?: ReadableStream, env?: Record<string, string>) {
    // coreutils timeout signals the whole process group; kill() would reach only the bash it started.
    const p = await this.box.exec(["timeout", "-k", "5", String(seconds), "bash", "-lc", command, "bash", ...args], { cwd: WORK, stdin, ...(env ? { env } : {}) });
    const [out, err, exit] = await Promise.all([capped(p.stdout, OUT_CAP), capped(p.stderr, OUT_CAP), p.exitCode]);
    return { exit, out, err };
  }

  private start() { this.box.start({ image: IMAGE, entrypoint: ["sleep", "infinity"], enableInternet: true, instance: SIZE }); }

  private async node(js: string, args: string[], seconds: number) {
    const p = await this.box.exec(["timeout", "-k", "5", String(seconds), "node", "-e", js, ...args], { cwd: "/" });
    const [out, err, exit] = await Promise.all([capped(p.stdout, OUT_CAP), capped(p.stderr, OUT_CAP), p.exitCode]);
    return { exit, out: text(out), err: text(err) };
  }

  /** Starts the machine if it sleeps and prepares the tools once per wake-up: unpacked from the R2 cache
   *  when `cache.get` is given, otherwise (or when that fails) installed from the internet, after which a
   *  fresh cache is uploaded to `cache.put` in the background. */
  async wake(cache?: CacheLinks): Promise<{ woke: boolean; bootstrap_seconds: number; setup?: "restored" | "installed"; saving?: boolean; restore_error?: string }> {
    const box = this.box;
    let woke = false;
    if (!box.running) { this.start(); woke = true; }
    await box.setInactivityTimeout(IDLE * 1000);
    await this.touch();
    this.enter();
    try {
      this.booting ??= this.setup(cache).finally(() => { this.booting = null; });
      return { woke, ...(await this.booting) };
    } finally { this.leave(); await this.touch(); }
  }

  private async setup(cache?: CacheLinks): Promise<{ bootstrap_seconds: number; setup?: "restored" | "installed"; saving?: boolean; restore_error?: string }> {
    const box = this.box;
    const plan = bootPlan(await box.exec(["test", "-f", MARK]).then(p => p.exitCode) === 0, !!cache?.get);
    if (plan === "none") return { bootstrap_seconds: 0 };
    const t = Date.now();
    let restore_error: string | undefined;
    if (plan === "restore") {
      const r = await this.node(FETCH, [cache!.get!, "/"], 180);
      const ok = r.exit === 0 && await box.exec(["timeout", "30", "bash", "-c", CHECK]).then(p => p.exitCode) === 0;
      if (afterRestore(ok) === "done") return { bootstrap_seconds: secs(t), setup: "restored" };
      restore_error = (r.err || "解开后检查没通过").slice(-300);
      // A half-unpacked system would make apt skip packages it believes are installed: start from a clean disk.
      await box.destroy().catch(() => {});
      this.start();
      await box.setInactivityTimeout(IDLE * 1000);
    }
    await box.exec(["touch", STAMP]).then(p => p.exitCode);
    const p = await box.exec(["bash", "-c", BOOT]);
    const [, err, exit] = await Promise.all([capped(p.stdout, 0), capped(p.stderr, OUT_CAP), p.exitCode]);
    if (exit !== 0) throw new Error("云电脑装软件失败：" + text(err).slice(-800));
    const bootstrap_seconds = secs(t);
    // The file list is taken now, before any command runs, so nothing a job writes ends up in the cache.
    const saving = shouldSave((await this.sh(SNAPSHOT, 60)).exit === 0, cache?.put);
    if (saving) this.pendingSave = cache!.put!;
    return { bootstrap_seconds, setup: "installed", saving, restore_error };
  }

  /** Uploads the environment packed after a full install. Runs in the background once the run that
   *  woke the machine is over, so it neither slows those commands nor makes the caller wait. */
  async saveEnvironment(): Promise<boolean> {
    const url = this.pendingSave;
    if (!url || this.saving || !this.box.running) return false;
    this.pendingSave = "";
    this.enter();
    this.saving = this.node(SEND, [url, String(ENV_MAX), "/tmp/computer-env.tar.zst", "-cf", "-", "-C", "/", "-T", LIST], 900)
      .then(r => { if (r.exit !== 0) console.log("environment cache upload failed", r.err.slice(-300)); })
      .catch(e => console.log("environment cache upload failed", e?.message))
      .finally(() => { this.leave(); this.saving = null; return this.touch(); });
    return true;
  }

  /** Unpacks a saved workspace into /work/<name> unless that directory is already there (the machine stayed
   *  awake); without a saved copy (`url` empty) it just creates the directory. */
  async restoreWorkspace(name: string, url: string): Promise<{ restored: boolean; error?: string }> {
    this.enter();
    try {
      if ((await this.sh('[ -e "$1" ] || { [ -z "$2" ] && mkdir -p -- "$1"; }', 10, [name, url ? "1" : ""])).exit === 0) return { restored: false };
      const r = await this.node(FETCH, [url, WORK], 600);
      if (r.exit === 0) return { restored: true };
      await this.sh('rm -rf -- "$1"', 60, [name]);
      return { restored: false, error: r.err.slice(-300) };
    } finally { this.leave(); await this.touch(); }
  }

  /** Packs /work/<name> (without dependency folders and files over 50 MB) and uploads it. */
  async saveWorkspace(name: string, url: string): Promise<{ bytes?: number; left_out: string[]; error?: string }> {
    this.enter();
    try {
      if ((await this.sh('[ -d "$1" ]', 10, [name])).exit !== 0) return { left_out: [], error: "/work/" + name + " 不存在" };
      const skip = WS_SKIP.map(n => "-name " + n).join(" -o ");
      const big = await this.sh(`find "$1" \\( ${skip} \\) -prune -o -type f -size +${WS_BIG} -print | tee /tmp/ws-"$1".skip`, 60, [name]);
      const left_out = text(big.out).split("\n").filter(Boolean);
      const args = ["--no-wildcards", ...WS_SKIP.map(n => "--exclude=" + n), "-X", "/tmp/ws-" + name + ".skip", "-cf", "-", "-C", WORK, name];
      const r = await this.node(SEND, [url, String(WS_CAP), "/tmp/ws-" + name + ".tar.zst", ...args], 900);
      let res: any = null;
      try { res = JSON.parse(r.out.trim().split("\n").pop() || ""); } catch {}
      if (r.exit !== 0 || !res) return { left_out, error: "保存工作区失败：" + r.err.slice(-300) };
      if (!res.ok) return { left_out, bytes: res.bytes, error: "工作区压缩后 " + Math.round(res.bytes / 1048576) + " MB，超过 300 MB，没有保存" };
      return { bytes: res.bytes, left_out };
    } finally { this.leave(); await this.touch(); }
  }

  /** Passes an HTTP request to a server listening inside the machine (a dev server being previewed). */
  async proxy(port: number, req: Request): Promise<Response> {
    await this.touch();
    return this.box.getTcpPort(port).fetch(req);
  }

  /** CPU seconds the machine has used since it started. */
  async cpu() { return (await this.meter()).cpu; }

  /** CPU seconds since start plus an id that changes with every start, so usage between runs is not lost. */
  async meter() {
    const p = await this.box.exec(["bash", "-c", "cat /proc/sys/kernel/random/boot_id; head -1 /proc/stat"]);
    const [boot, stat] = new TextDecoder().decode((await p.output()).stdout).trim().split("\n");
    const f = stat.trim().split(/\s+/).slice(1).map(Number);
    return { boot, cpu: (f[0] + f[1] + f[2] + f[5] + f[6]) / 100 };
  }

  async put(name: string, bytes: Uint8Array) {
    this.enter();
    try {
      const safe = name.replace(/^.*[\\/]/, "").replace(/[^\w.\-一-鿿]/g, "_") || "file";
      const r = await this.sh('cat > "$1"', 120, [safe], new Blob([bytes]).stream());
      if (r.exit !== 0) throw new Error("放文件失败：" + text(r.err));
      return safe;
    } finally { this.leave(); await this.touch(); }
  }

  async run(command: string, seconds: number, env?: Record<string, string>): Promise<Step> {
    this.enter();
    const t = Date.now();
    try {
      const r = await this.sh(command, seconds, [], undefined, env);
      const stderr = text(r.err) + (r.exit === 124 ? "\n（超时，被停掉了）" : "");
      return { command, exit: r.exit, stdout: text(r.out), stderr, seconds: secs(t) };
    } finally { this.leave(); await this.touch(); }
  }

  /** Files to bring back (paths relative to the work directory, globs allowed) with their sizes. */
  async list(patterns: string[]) {
    const r = await this.sh('shopt -s nullglob globstar; for p in "$@"; do for f in $p; do [ -f "$f" ] && printf "%s\\t%s\\n" "$(stat -c %s "$f")" "$f"; done; done | head -40; true', 30, patterns);
    const seen = new Set<string>();
    return text(r.out).split("\n").filter(Boolean).map(l => { const i = l.indexOf("\t"); return { size: Number(l.slice(0, i)), path: l.slice(i + 1) }; })
      .filter(f => !seen.has(f.path) && seen.add(f.path));
  }

  async take(path: string): Promise<Uint8Array> {
    this.enter();
    try {
      const p = await this.box.exec(["head", "-c", String(FILE_CAP), path], { cwd: WORK });
      const [out, , exit] = await Promise.all([capped(p.stdout, FILE_CAP), capped(p.stderr, 0), p.exitCode]);
      if (exit !== 0) throw new Error("取不回文件 " + path);
      return out.bytes;
    } finally { this.leave(); await this.touch(); }
  }
}

// Measured: packing and uploading the environment after a full install takes about this much CPU. It runs
// after the call returns, so it is charged up front and left out of the next run's CPU reading.
const SAVE_CPU = 30;

/** Links for the environment cache: a read link when a finished cache for this recipe exists, and a write
 *  link so a full install (first time, or after a failed restore) can save a fresh one. Older recipes'
 *  caches are dropped. Reused for a while so a busy hour does not mint tokens per call. */
async function cacheLinks(hub: Hub): Promise<CacheLinks> {
  if (!hub.env.FILES || !hub.env.PUBLIC_URL) return {};
  const name = await envName(), prefix = root(hub) + "cache/", key = prefix + name, have = complete(hub, key), now = Date.now();
  let memo: any = null;
  try { memo = JSON.parse(hub.get("computer:env_links") || "null"); } catch {}
  if (memo && memo.name === name && memo.have === have && memo.exp > now + 10 * 60000) return memo.links;
  for (const k of keysUnder(hub, prefix)) if (k !== key) await remove(hub, k);
  const links: CacheLinks = {};
  if (have) links.get = link(hub, "get", issue(hub, { mode: "get", prefix, name }), name);
  if (stored(hub) - (row(hub, key)?.size || 0) + ENV_MAX <= CAP) links.put = link(hub, "put", issue(hub, { mode: "put", prefix, name }), name);
  hub.set("computer:env_links", JSON.stringify({ name, have, exp: now + 30 * 60000, links }));
  return links;
}

/** Charges the machine's CPU since the last reading (same start) or since it started. */
async function chargeCpu(hub: Hub, box: any, extra = 0) {
  const m: { boot: string; cpu: number } | null = await box.meter().catch(() => null);
  if (!m) return;
  let last: any = null;
  try { last = JSON.parse(hub.get("computer:cpu_mark") || "null"); } catch {}
  const from = last && last.boot === m.boot ? Number(last.cpu) : 0;
  hub.plan.add("container_cpu_seconds", Math.max(0, m.cpu - from) + extra);
  hub.set("computer:cpu_mark", JSON.stringify({ boot: m.boot, cpu: Math.max(m.cpu, from) + extra }));
}

/** Runs commands one after another in the cloud computer (stopping at the first failure) and brings back
 *  the files asked for. Commands run in /work, which keeps its files until the machine sleeps, or for
 *  good under /work/<workspace> when a workspace is named. */
export async function runComputer(hub: Hub, req: ComputerRequest): Promise<ComputerResult> {
  if (!hub.plan.fits("container_seconds", 60) || !hub.plan.fits("container_cpu_seconds", 30)) throw new Error("这个月云电脑的额度用到停止线了，下个周期才能再用");
  const box = hub.env.COMPUTER.get(hub.env.COMPUTER.idFromName("computer"));
  const started = Date.now();
  const deadline = started + Math.min(Math.max(Number(req.timeoutSeconds) || 300, 10), 1800) * 1000;
  const out: ComputerResult = { ok: false, steps: [], files: [], seconds: 0 };
  let woke = false, saving = false;
  try {
    const ws = req.workspace === undefined ? null : workspaceName(String(req.workspace));
    if (req.workspace !== undefined && !ws) throw new Error("工作区名字只能用字母、数字、- 和 _，最多 40 个字");
    const w = await box.wake(await cacheLinks(hub).catch(() => ({})));
    woke = true;
    out.woke = w.woke; out.bootstrap_seconds = w.bootstrap_seconds;
    if (w.setup) out.setup = w.setup;
    if (w.restore_error) out.restore_error = w.restore_error;
    saving = !!w.saving;
    const wsKey = ws ? root(hub) + "ws/" + ws + ".tar.zst" : "";
    if (ws) {
      out.workspace = { name: ws, restored: false };
      const saved = complete(hub, wsKey);
      const r = await box.restoreWorkspace(ws, saved ? link(hub, "get", issue(hub, { mode: "get", prefix: root(hub) + "ws/", name: ws + ".tar.zst" }, 900), ws + ".tar.zst") : "");
      // Carrying on would overwrite the saved copy with an empty folder at the end.
      if (r.error) throw new Error("恢复工作区 " + ws + " 失败：" + r.error);
      out.workspace.restored = r.restored;
    }
    for (const f of (req.files || []).slice(0, 12)) {
      if (f.bytes.length > FILE_CAP) throw new Error(f.name + " 超过 25 MB，放不进云电脑");
      await box.put(f.name, f.bytes);
    }
    for (const command of req.commands) {
      const left = Math.floor((deadline - Date.now()) / 1000);
      if (left < 2) { out.error = "超过时限，后面的命令没跑"; break; }
      const step: Step = await box.run(command, left, req.env);
      out.steps.push(step);
      if (step.exit !== 0) break;
    }
    if (ws && out.workspace) {
      const s = await box.saveWorkspace(ws, link(hub, "put", issue(hub, { mode: "put", prefix: root(hub) + "ws/", name: ws + ".tar.zst" }, 1800), ws + ".tar.zst"));
      if (s.bytes !== undefined && !s.error) out.workspace.saved_bytes = s.bytes;
      if (s.left_out.length) out.workspace.left_out = s.left_out.slice(0, 20);
      if (s.error) out.workspace.error = s.error;
    }
    const found: { size: number; path: string }[] = req.collect?.length ? await box.list(req.collect) : [];
    for (const f of found) {
      if (f.size > FILE_CAP) (out.skipped ??= []).push(f.path + "（超过 25 MB）");
      else if (out.files.length < MAX_FILES) out.files.push({ name: f.path, bytes: await box.take(f.path) });
    }
    const extra = found.filter(f => f.size <= FILE_CAP).length - out.files.length;
    if (extra > 0) (out.skipped ??= []).push("另有 " + (found.length >= 40 ? "至少 " : "") + extra + " 个文件没取回（一次最多 6 个）");
    out.ok = !out.error && out.steps.length === req.commands.length && out.steps.every(s => s.exit === 0);
    return out;
  } catch (e: any) {
    out.error = String(e?.message || e);
    return out;
  } finally {
    // Billed from the start (or from the end of an idle tail already counted) until the machine sleeps.
    const end = Date.now(), until = Number(hub.get("computer:billed_until") || 0);
    hub.plan.add("container_seconds", (end + IDLE * 1000 - Math.max(started, until)) / 1000);
    hub.set("computer:billed_until", String(end + IDLE * 1000));
    if (woke) await chargeCpu(hub, box, saving && await box.saveEnvironment().catch(() => false) ? SAVE_CPU : 0);
    out.seconds = secs(started);
  }
}
