// F6P-3：owner 创建「每天 08:00 悉尼日推」的唯一入口。
// 默认 dry-run，只向已部署的 Worker 查询将写入的 schedules 行；--confirm 才写。
// 真正的创建逻辑在 Worker 的 /api/admin/daily-push（复用 src/schedules.ts 的
// planSchedule/createSchedule），本脚本不直接连 D1、不保存令牌。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_URL = "https://inkboard-team.inkboard-server.workers.dev";
// 用户 2026-11-13 01:11+08（04:11 Sydney）的原始请求；只读快照里的真实消息 id。
export const DEFAULT_SOURCE_ID =
  "ROBOT1.0_uMj7bSoGmOazRMZniW.yT2V5hU3d-j6xzhbCQeAQ6Z.OwSP3g49XjNFz-7MfTy-y7SwXrIDy1.sk-8ujK3u2doyiDiEnBsDjRwFKyBrETjzvJYw94Gf2XvduFhFPmyNe";

export function parseArgs(argv = []) {
  const args = {
    confirm: false,
    json: false,
    help: false,
    sourceId: DEFAULT_SOURCE_ID,
    time: "08:00",
    url: process.env.TEAM_AGENT_URL || "",
    config: process.env.TEAM_AGENT_CONFIG || join(homedir(), ".inkboard-team", "config.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm") args.confirm = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--source-id") args.sourceId = String(argv[++i] || "");
    else if (a.startsWith("--source-id=")) args.sourceId = a.slice("--source-id=".length);
    else if (a === "--time") args.time = String(argv[++i] || "");
    else if (a.startsWith("--time=")) args.time = a.slice("--time=".length);
    else if (a === "--url") args.url = String(argv[++i] || "");
    else if (a.startsWith("--url=")) args.url = a.slice("--url=".length);
    else if (a === "--config") args.config = String(argv[++i] || "");
    else if (a.startsWith("--config=")) args.config = a.slice("--config=".length);
    else throw Error("未知参数：" + a + "（用 --help 看用法）");
  }
  if (!/^\d{1,2}:\d{2}$/.test(args.time)) throw Error("--time 要写成 HH:MM，例如 08:00");
  if (!args.sourceId) throw Error("--source-id 不能为空");
  return args;
}

function localConfig(path) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function resolve(args) {
  const config = localConfig(args.config);
  const url = String(args.url || config.url || DEFAULT_URL).replace(/\/+$/, "");
  const token = String(
    process.env.TEAM_ADMIN_TOKEN || process.env.ADMIN_TOKEN || config.adminToken || "",
  );
  if (!token)
    throw Error(
      "缺少 owner 令牌：设置 TEAM_ADMIN_TOKEN，或在 --config 指向的本机团队配置里提供 adminToken",
    );
  if (!/^https?:\/\//.test(url)) throw Error("Worker 地址要以 http(s):// 开头：" + url);
  return { url, token };
}

export async function main(
  argv = process.argv.slice(2),
  { fetchImpl = globalThis.fetch, log = console.log } = {},
) {
  const args = parseArgs(argv);
  if (args.help) {
    log(
      [
        "用法：node scripts/create-daily-push.mjs [--confirm] [--time 08:00] [--source-id <消息id>]",
        "",
        "默认 dry-run：只打印将写入的 schedules 行，不写线上 D1。",
        "--confirm：真的创建（仅 owner 令牌可用；重复执行幂等）。",
        "令牌：TEAM_ADMIN_TOKEN 环境变量，或本机 ~/.inkboard-team/config.json 的 adminToken。",
        "地址：TEAM_AGENT_URL 环境变量，或本机配置的 url。",
      ].join("\n"),
    );
    return { ok: true, dry_run: true };
  }
  const { url, token } = resolve(args);
  const response = await fetchImpl(url + "/api/admin/daily-push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      source_msg_id: args.sourceId,
      time: args.time,
      dry_run: !args.confirm,
    }),
    signal: AbortSignal.timeout(30000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw Error("Worker 返回的不是 JSON（HTTP " + response.status + "）");
  }
  if (!response.ok || !body.ok)
    throw Error("创建失败（HTTP " + response.status + "）：" + (body.error || "未知错误"));
  if (!args.confirm && (body.dry_run !== true || body.would_write !== true))
    throw Error("dry-run 响应不符合预期：没有确认 would_write");
  if (args.json) {
    log(JSON.stringify(body, null, 2));
    return body;
  }
  const s = body.schedule || {};
  log(args.confirm ? "已写入 schedules（owner only；线上 D1）：" : "dry-run：将写入 schedules（未写线上 D1）：");
  log(
    JSON.stringify(
      {
        id: s.id,
        group_id: s.group_id,
        owner: s.owner,
        kind: s.kind,
        tz: s.tz,
        spec: s.spec,
        next_run_at: s.next_run_at,
        next_run_text: s.next_run_text,
        source_msg_id: s.source_msg_id,
        status: s.status,
      },
      null,
      2,
    ),
  );
  if (!args.confirm) log("\n确认写入：node scripts/create-daily-push.mjs --confirm");
  else log("\n下次推送：" + (s.next_run_text || "见上方"));
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
