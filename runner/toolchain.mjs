/**
 * Locate external audio binaries without trusting launchd's PATH.
 *
 * launchd starts com.inkboard.team-qq with only /usr/bin:/bin:/usr/sbin:/sbin,
 * while Homebrew installs ffmpeg in /opt/homebrew/bin. Spawning a bare
 * "ffmpeg" therefore fails with ENOENT even though the tool is installed.
 * FFMPEG_BIN / FFPROBE_BIN are explicit overrides; otherwise the standard
 * Homebrew prefixes are tried before PATH.
 */
import fs from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
];
export const FFPROBE_CANDIDATES = [
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
];

const envOf = (deps = {}) => deps.env || process.env;

function isExecutable(file, deps = {}) {
  if (!file) return false;
  if (typeof deps.isExecutable === "function") return deps.isExecutable(file) === true;
  try {
    (deps.accessSync || fs.accessSync)(file, (deps.constants || fs.constants).X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one binary. The result is a data object, never a throw, so a
 * startup preflight can report both tools at once.
 */
export function resolveBinary(name, options = {}) {
  const deps = options.deps || {};
  const env = options.env || envOf(deps);
  const key = name.toUpperCase() + "_BIN";
  const configured =
    typeof env[key] === "string" ? env[key].trim() : "";
  if (configured) {
    return isExecutable(configured, deps)
      ? { ok: true, path: configured, source: key }
      : {
          ok: false,
          path: configured,
          source: key,
          error: key + " 指向的文件不存在或不可执行：" + configured,
        };
  }
  const candidates = options.candidates || [];
  for (const candidate of candidates) {
    if (isExecutable(candidate, deps))
      return { ok: true, path: candidate, source: "standard" };
  }
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate, deps))
      return { ok: true, path: candidate, source: "PATH" };
  }
  return {
    ok: false,
    path: null,
    source: null,
    error:
      name +
      " 不在 " +
      (candidates.length ? candidates.join("、") : "标准位置") +
      "，也不在 PATH 中",
  };
}

export function ffmpegToolchain(deps = {}) {
  return resolveBinary("ffmpeg", { deps, candidates: FFMPEG_CANDIDATES });
}

export function ffprobeToolchain(deps = {}) {
  const env = envOf(deps);
  // An explicit FFPROBE_BIN is authoritative; do not derive around it.
  if (typeof env.FFPROBE_BIN === "string" && env.FFPROBE_BIN.trim())
    return resolveBinary("ffprobe", { deps, candidates: FFPROBE_CANDIDATES });
  const ffmpeg = ffmpegToolchain(deps);
  if (ffmpeg.ok) {
    const sibling = join(dirname(ffmpeg.path), "ffprobe");
    if (isExecutable(sibling, deps))
      return { ok: true, path: sibling, source: "ffmpeg-sibling" };
  }
  return resolveBinary("ffprobe", { deps, candidates: FFPROBE_CANDIDATES });
}

/** Startup preflight: both tools, with paths and a human-readable error each. */
export function preflightTools(deps = {}) {
  return { ffmpeg: ffmpegToolchain(deps), ffprobe: ffprobeToolchain(deps) };
}

/** Turn a failed resolution into a named fault the caller can log and report. */
export function requireTool(tool, reason) {
  if (tool?.ok && tool.path) return tool.path;
  throw Object.assign(Error(tool?.error || "audio tool unavailable"), {
    reason,
    missing: true,
  });
}

export function describeTools(tools) {
  return ["ffmpeg", "ffprobe"]
    .map((name) => {
      const tool = tools?.[name];
      return tool?.ok ? name + "=" + tool.path : name + " missing (" + (tool?.error || "unknown") + ")";
    })
    .join("; ");
}
