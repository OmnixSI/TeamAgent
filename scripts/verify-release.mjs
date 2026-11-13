import { execFileSync } from "node:child_process";
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
if (health.selfCard?.commit !== sha) throw Error("自知卡版本与线上不一致");
console.log("Live release verified: " + sha);
