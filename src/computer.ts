// The cloud computer: one Linux container on Cloudflare Containers that background jobs run shell
// commands in (ffmpeg, git, Python, LibreOffice). It is billed per 10 ms while it runs, so it starts on
// demand, sleeps IDLE seconds after the last use, and every run is charged to the plan's meters together
// with that idle tail.
import { DurableObject } from "cloudflare:workers";
import type { Hub } from "./hub.ts";
import type { Env } from "./util.ts";

const IDLE = 180;
// Memory and disk are billed for as long as the machine runs, CPU only while it computes. One full vCPU
// with "basic"-sized memory and disk installs the tools four times faster than 1/4 vCPU for the same CPU
// seconds, so the run (and the memory-hours) are shorter. 25 GiB-hours of memory = 25 hours of this.
const SIZE = { vcpu: 1, memoryMib: 1024, diskMb: 4000 };
// Debian trixie slim with Node 24, provided by Cloudflare: no Docker build or registry push. The disk
// does not survive sleep, so the tools are installed again after every wake-up (about half a minute).
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
apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils git fontconfig fonts-noto-cjk >/dev/null
# A static build unpacks in seconds; the Debian package takes over half a minute to install.
curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ -C /usr/local/bin --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe' \
  || apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh >/dev/null 2>&1
uv venv -q --seed --python 3.12 /opt/py
VIRTUAL_ENV=/opt/py uv pip install -q pandas matplotlib openpyxl python-pptx python-docx
printf 'font.sans-serif: Noto Sans CJK SC, DejaVu Sans\naxes.unicode_minus: False\n' > /etc/matplotlibrc
echo 'export PATH=/opt/py/bin:$PATH HOME=/root LANG=C.UTF-8 MPLBACKEND=Agg MATPLOTLIBRC=/etc/matplotlibrc' > /etc/profile.d/computer.sh
# LibreOffice adds most of a minute, so it is installed the first time something calls it.
for n in soffice libreoffice; do printf '#!/bin/sh\n[ -x /usr/bin/soffice ] || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui >/dev/null\nexec /usr/bin/%s "$@"\n' $n > /usr/local/bin/$n; chmod +x /usr/local/bin/$n; done
touch ${MARK}`;

export type Step = { command: string; exit: number; stdout: string; stderr: string; seconds: number };
export type ComputerRequest = {
  commands: string[]; files?: { name: string; bytes: Uint8Array }[]; collect?: string[]; timeoutSeconds?: number;
  /** Environment for the commands of this run only (tokens, keys). Never written to disk or to any log here. */
  env?: Record<string, string>;
};
export type ComputerResult = {
  ok: boolean; steps: Step[]; files: { name: string; bytes: Uint8Array }[]; seconds: number;
  woke?: boolean; bootstrap_seconds?: number; skipped?: string[]; error?: string;
};

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
  private booting: Promise<number> | null = null;
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

  async alarm() {
    if (this.busy > 0) return this.touch();
    if (this.box.running) await this.box.destroy().catch(() => {});
  }

  private async sh(command: string, seconds: number, args: string[] = [], stdin?: ReadableStream, env?: Record<string, string>) {
    // coreutils timeout signals the whole process group; kill() would reach only the bash it started.
    const p = await this.box.exec(["timeout", "-k", "5", String(seconds), "bash", "-lc", command, "bash", ...args], { cwd: WORK, stdin, ...(env ? { env } : {}) });
    const [out, err, exit] = await Promise.all([capped(p.stdout, OUT_CAP), capped(p.stderr, OUT_CAP), p.exitCode]);
    return { exit, out, err };
  }

  /** Starts the machine if it sleeps and installs the tools once per wake-up. */
  async wake(): Promise<{ woke: boolean; bootstrap_seconds: number }> {
    const box = this.box;
    let woke = false;
    if (!box.running) {
      box.start({ image: IMAGE, entrypoint: ["sleep", "infinity"], enableInternet: true, instance: SIZE });
      woke = true;
    }
    await box.setInactivityTimeout(IDLE * 1000);
    await this.touch();
    this.busy++;
    try {
      this.booting ??= (async () => {
        if (await box.exec(["test", "-f", MARK]).then(p => p.exitCode) === 0) return 0;
        const t = Date.now();
        const p = await box.exec(["bash", "-c", BOOT]);
        const [, err, exit] = await Promise.all([capped(p.stdout, 0), capped(p.stderr, OUT_CAP), p.exitCode]);
        if (exit !== 0) throw new Error("云电脑装软件失败：" + text(err).slice(-800));
        return secs(t);
      })().finally(() => { this.booting = null; });
      return { woke, bootstrap_seconds: await this.booting };
    } finally { this.busy--; await this.touch(); }
  }

  /** CPU seconds the machine has used since it started. */
  async cpu() {
    const p = await this.box.exec(["head", "-1", "/proc/stat"]);
    const f = new TextDecoder().decode((await p.output()).stdout).trim().split(/\s+/).slice(1).map(Number);
    return (f[0] + f[1] + f[2] + f[5] + f[6]) / 100;
  }

  async put(name: string, bytes: Uint8Array) {
    this.busy++;
    try {
      const safe = name.replace(/^.*[\\/]/, "").replace(/[^\w.\-一-鿿]/g, "_") || "file";
      const r = await this.sh('cat > "$1"', 120, [safe], new Blob([bytes]).stream());
      if (r.exit !== 0) throw new Error("放文件失败：" + text(r.err));
      return safe;
    } finally { this.busy--; await this.touch(); }
  }

  async run(command: string, seconds: number, env?: Record<string, string>): Promise<Step> {
    this.busy++;
    const t = Date.now();
    try {
      const r = await this.sh(command, seconds, [], undefined, env);
      const stderr = text(r.err) + (r.exit === 124 ? "\n（超时，被停掉了）" : "");
      return { command, exit: r.exit, stdout: text(r.out), stderr, seconds: secs(t) };
    } finally { this.busy--; await this.touch(); }
  }

  /** Files to bring back (paths relative to the work directory, globs allowed) with their sizes. */
  async list(patterns: string[]) {
    const r = await this.sh('shopt -s nullglob globstar; for p in "$@"; do for f in $p; do [ -f "$f" ] && printf "%s\\t%s\\n" "$(stat -c %s "$f")" "$f"; done; done | head -40; true', 30, patterns);
    const seen = new Set<string>();
    return text(r.out).split("\n").filter(Boolean).map(l => { const i = l.indexOf("\t"); return { size: Number(l.slice(0, i)), path: l.slice(i + 1) }; })
      .filter(f => !seen.has(f.path) && seen.add(f.path));
  }

  async take(path: string): Promise<Uint8Array> {
    this.busy++;
    try {
      const p = await this.box.exec(["head", "-c", String(FILE_CAP), path], { cwd: WORK });
      const [out, , exit] = await Promise.all([capped(p.stdout, FILE_CAP), capped(p.stderr, 0), p.exitCode]);
      if (exit !== 0) throw new Error("取不回文件 " + path);
      return out.bytes;
    } finally { this.busy--; await this.touch(); }
  }
}

/** Runs commands one after another in the cloud computer (stopping at the first failure) and brings back
 *  the files asked for. Commands run in /work, which keeps its files until the machine sleeps. */
export async function runComputer(hub: Hub, req: ComputerRequest): Promise<ComputerResult> {
  if (!hub.plan.fits("container_seconds", 60) || !hub.plan.fits("container_cpu_seconds", 30)) throw new Error("这个月云电脑的额度用到停止线了，下个周期才能再用");
  const box = hub.env.COMPUTER.get(hub.env.COMPUTER.idFromName("computer"));
  const started = Date.now();
  const deadline = started + Math.min(Math.max(Number(req.timeoutSeconds) || 300, 10), 1800) * 1000;
  const out: ComputerResult = { ok: false, steps: [], files: [], seconds: 0 };
  let cpuFrom = -1;
  try {
    const w = await box.wake();
    out.woke = w.woke; out.bootstrap_seconds = w.bootstrap_seconds;
    // After a wake-up the machine's whole CPU use, installation included, belongs to this run.
    cpuFrom = w.woke ? 0 : await box.cpu();
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
    if (cpuFrom >= 0) hub.plan.add("container_cpu_seconds", Math.max(0, await box.cpu().catch(() => cpuFrom) - cpuFrom));
    out.seconds = secs(started);
  }
}
