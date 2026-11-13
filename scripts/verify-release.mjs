import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
// The release note is part of the release: one line, at most 60 characters, same text the group sees.
const release =
  process.argv[2] ||
  process.env.TEAM_RELEASE ||
  (readFileSync("src/release-note.ts", "utf8").match(
    /version\s*:\s*['"]([^'"]+)['"]/,
  ) || [])[1];
if (!release) throw Error("无法确定版本名：src/release-note.ts 里没有 RELEASE_NOTE.version");
const path = "docs/releases/" + release + ".md";
const lines = readFileSync(path, "utf8").trim().split("\n");
if (lines.length !== 1 || !lines[0].trim())
  throw Error("版本说明必须正好一行：" + path);
const length = Array.from(lines[0]).length;
if (length > 60) throw Error(`版本说明 ${length} 字，超过 60：` + path);
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const url =
  process.env.TEAM_BOARD_URL ||
  "https://inkboard-team.inkboard-server.workers.dev";
const response = await fetch(url + "/health", {
  signal: AbortSignal.timeout(30000),
});
const health = await response.json();
if (!response.ok || !health.ok || health.release !== sha)
  throw Error("线上版本尚未匹配本次提交");
console.log("Live release verified: " + sha);
