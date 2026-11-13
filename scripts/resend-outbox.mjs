#!/usr/bin/env node
// Owner-only resend of one failed outbox text row. Dry-run by default; a real
// queue write needs an explicit --confirm. This command never talks to QQ and
// never sends an attachment: the file-delivery path owns attachments.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const args = { id: "", confirm: false, json: false, help: false };
  for (const value of argv) {
    if (value === "--confirm") args.confirm = true;
    else if (value === "--dry-run") args.confirm = false;
    else if (value === "--json") args.json = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else if (value.startsWith("-")) throw Error("未知参数：" + value);
    else if (!args.id) args.id = value;
    else throw Error("一次只能重发一条群消息");
  }
  return args;
}

function homeDir() {
  return process.env.INKBOARD_TEAM_HOME || path.join(os.homedir(), ".inkboard-team");
}

export function readConfig() {
  const envUrl = String(process.env.INKBOARD_TEAM_URL || "").replace(/\/+$/, "");
  const envToken = String(process.env.INKBOARD_TEAM_ADMIN_TOKEN || "");
  if (envUrl && envToken) return { url: envUrl, token: envToken };
  const file = process.env.INKBOARD_TEAM_CONFIG || path.join(homeDir(), "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const url = String(envUrl || config.url || "").replace(/\/+$/, "");
  const token = String(envToken || config.adminToken || "");
  if (!url || !token) throw Error("本机 TeamAgent 配置缺少 url 或管理员令牌");
  return { url, token };
}

function ageText(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  if (minutes < 60) return minutes + " 分钟";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + " 小时";
  return Math.round(hours / 24) + " 天";
}

function whenText(created) {
  const at = Number(created);
  if (!Number.isFinite(at) || at <= 0) return "时间未知";
  return new Date(at).toLocaleString("zh-CN", {
    timeZone: "Australia/Sydney",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " 悉尼时间";
}

export function formatPlan(plan) {
  const lines = [
    "resend-outbox — DRY RUN（不发送）",
    "id: " + plan.id,
    "status: " + plan.status,
    "created: " + whenText(plan.created_at) + "（" + ageText(plan.age_ms) + "前）",
    "group: " + (plan.group_id || "未知"),
    "msg: " + (plan.msg_id || "无"),
    "expected: " + plan.expected,
    "stale: " + (plan.stale ? "是（超过 15 分钟，需要 owner 明确同意）" : "否"),
    "eligible: " + (plan.eligible ? "是" : "否"),
    "body (" + plan.body_bytes + " bytes):",
    "---",
    String(plan.body || ""),
    "---",
    "没有发送任何消息。确认用户同意后运行：",
    "  node scripts/resend-outbox.mjs '" + String(plan.id).replace(/'/g, "'\\''") + "' --confirm",
    "该命令只把消息重新放回待发队列，由 TeamAgent 下一轮发送；不会附带历史文件。",
  ];
  return lines.join("\n");
}

async function request(config, body) {
  const response = await fetch(config.url + "/api/team/outbox/resend", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.token,
      "Content-Type": "application/json",
      "User-Agent": "TeamAgent-resend-outbox/1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok)
    throw Error("HTTP " + response.status + "：" + String(payload.error || "请求失败"));
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.id) {
    process.stderr.write(
      "用法：node scripts/resend-outbox.mjs <outbox-id> [--confirm] [--json]\n" +
        "默认 dry-run，只打印将要发送的内容；--confirm 才把消息重新放回待发队列。\n" +
        "只重发文本，不重发附件；附件请按 csv-resend-plan.md 重新生成后走文件交付。\n",
    );
    process.exit(args.help ? 0 : 1);
  }
  const config = readConfig();
  const payload = await request(config, { id: args.id, confirm: args.confirm === true });
  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  if (payload.dry_run) {
    process.stdout.write(formatPlan(payload) + "\n");
    return;
  }
  process.stdout.write(
    "已入队：" + args.id + "（状态 " + payload.status + "）。下一轮发送会把它发到群里；本命令没有直接调用 QQ。\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write((error?.message || String(error)) + "\n");
    process.exit(2);
  });
}
