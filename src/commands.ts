import { TEAM } from "./config";
import { REPOS } from "./policy";

export type CommandName = "help" | "status" | "stop" | "recall";

export type CommandInput = {
  groupId: string;
  messageId: string;
  memberId: string;
  text: string;
};

const HELP = `命令
/help 这张说明
/status 版本、开关、令牌、索引、任务、定时
/stop 停掉本群正在跑的长任务
/方案 <仓库> <目标> 整理方案
/开工 <仓库> <目标> 交给本机执行
@我 + 帮我画/生成一张……的图
也可以直接说「帮助」「状态」「停」。

我能做：聊天接梗、查链接和 B 站字幕、整理文件与数据、记团队决定、写方案、查仓库和 CI、夜间整理、把开发交给成员接力、按描述生成图片。
撤回：QQ 机器人接口没有开放撤回，我撤不回已发消息；但可以发一条「更正」。`;

const RECALL_LIMIT =
  "这条我撤不回，QQ 机器人接口没有开放撤回；我可以发一条『更正』覆盖它";
const RECALL_CORRECTION = "更正：上一条消息作废，不再算数。";

const SWITCH_KEYS = [
  "off:repo_tools",
  "off:vision",
  "off:sticker_collect",
  "off:sticker_send",
  "off:bili.media",
  "ci_notifications_v2",
  "runner_seen",
] as const;

const KIND_LABELS: Record<string, string> = {
  chat: "聊天处理",
  media: "文件处理",
  plan: "方案整理",
  research: "资料检索",
  video_reply: "B站视频",
  voice_notice: "语音通知",
  sticker: "表情采集",
  "sticker-tag": "表情整理",
  ci_triage: "CI 排查",
  scout: "查新",
  dream: "夜间整理",
  fetch: "读取链接",
};

const SCHEDULE_LABELS: Record<string, string> = {
  digest_daily: "每日总结",
  digest_weekly: "每周总结",
  reminder: "提醒",
  mute: "静默",
};

/** Deterministic group commands. Free text aliases are exact matches only. */
export function parseCommand(text: string): CommandName | null {
  const t = String(text || "")
    .trim()
    .replace(/[。！!？?，,、；;：:]+$/u, "")
    .trim();
  if (!t) return null;
  if (/^\/help(?:@\S+)?$/i.test(t) || /^(?:help|帮助|指令|命令)$/i.test(t))
    return "help";
  if (
    /^\/status(?:@\S+)?$/i.test(t) ||
    /^(?:status|状态|运行状态)$/i.test(t)
  )
    return "status";
  if (/^\/stop(?:@\S+)?$/i.test(t) || /^(?:stop|停|停下|停止)$/i.test(t))
    return "stop";
  if (/^(?:撤回|撤销)(?:一下|吧)?$/u.test(t)) return "recall";
  if (
    /(?:撤回|撤销|删掉|删除|改掉)/u.test(t) &&
    /(你|刚才|上一条|上条|那条|这条|消息|回复|发的)/u.test(t)
  )
    return "recall";
  return null;
}

function jsonOf(raw: any): any {
  if (!raw) return {};
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

function ago(ts: number, now = Date.now()) {
  const delta = Math.max(0, now - Number(ts || 0));
  if (!Number.isFinite(delta)) return "时间未知";
  if (delta < 60000) return "刚刚";
  if (delta < 3600000) return Math.floor(delta / 60000) + " 分钟前";
  if (delta < 86400000) return Math.floor(delta / 3600000) + " 小时前";
  return Math.floor(delta / 86400000) + " 天前";
}

function sydneyTime(ts: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM.memory.timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Number(ts)));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function jobTitle(job: any) {
  const payload = jsonOf(job.payload);
  const raw =
    job.task_title ||
    payload.title ||
    job.message_body ||
    payload.intent?.text ||
    job.id;
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 28);
}

function jobLine(job: any) {
  return `${KIND_LABELS[job.kind] || job.kind}「${jobTitle(job)}」${ago(job.created_at)}`;
}

function repoName(repo: string) {
  return repo.split("/")[1] || repo;
}

export async function statusReport(e: any): Promise<string> {
  const stored = (
    await e.DB.prepare(
      "SELECT key,value FROM settings WHERE key IN (" +
        SWITCH_KEYS.map(() => "?").join(",") +
        ")",
    )
      .bind(...SWITCH_KEYS)
      .all()
  ).results as any[];
  const sw = Object.fromEntries(stored.map((r: any) => [r.key, r.value]));
  const on = (name: string) => sw["off:" + name] !== "1";

  const stickersOn = TEAM.stickers?.enabled !== false;
  const stickers = `${
    stickersOn && on("sticker_collect") ? "收开" : "收关"
  }/${stickersOn && TEAM.stickers?.send === true && on("sticker_send") ? "发开" : "发关"}`;
  const biliMedia =
    TEAM.bili?.enabled !== false &&
    TEAM.bili?.media?.enabled !== false &&
    on("bili.media");
  const vision = TEAM.vision?.enabled !== false && on("vision");

  const lines = [
    `运行状态 · 版本 ${e.RELEASE || "development"}`,
    `开关：repo_tools ${on("repo_tools") ? "开" : "关"} · vision ${
      vision ? "开" : "关"
    } · stickers ${stickers} · bili.media ${
      biliMedia ? "开" : "关"
    } · CI 通知 ${sw.ci_notifications_v2 === "0" ? "关" : "开"}`,
    `令牌：GITHUB_TOKEN ${e.GITHUB_TOKEN ? "有" : "无"} · QQ 凭据 ${
      e.QQ_APP_ID && e.QQ_APP_SECRET ? "有" : "无"
    }`,
  ];

  const runnerAt = Date.parse(sw.runner_seen || "");
  lines.push(
    !runnerAt
      ? "Runner：没有心跳记录"
      : `Runner：${ago(runnerAt)}${
          Date.now() - runnerAt < 90000 ? "（在线）" : "（离线）"
        }`,
  );

  const repoRows = (
    await e.DB.prepare(
      `SELECT r.repo,
        (SELECT updated_at FROM repo_cache c WHERE c.repo=r.repo) AS cache_at,
        (SELECT MAX(at) FROM repo_commits m WHERE m.repo=r.repo) AS commit_at
       FROM (${REPOS.map(() => "SELECT ? AS repo").join(" UNION ALL ")}) r`,
    )
      .bind(...REPOS)
      .all()
  ).results as any[];
  lines.push("索引：");
  for (const repo of REPOS) {
    const row = repoRows.find((r: any) => r.repo === repo);
    const cacheAt = Number(row?.cache_at || 0);
    const commitAt = Number(row?.commit_at || 0);
    lines.push(
      `· ${repoName(repo)} ${
        cacheAt
          ? ago(cacheAt)
          : commitAt
            ? `未索引（最新提交 ${ago(commitAt)}，资料未同步）`
            : "未索引（本机没同步）"
      }`,
    );
  }

  const counts = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')",
  ).first();
  const n = Number(counts?.n || 0);
  if (!n) lines.push("任务：没有进行中");
  else {
    const oldest = await e.DB.prepare(
      `SELECT j.id,j.kind,j.payload,j.created_at,t.title AS task_title,m.body AS message_body
       FROM jobs j
       LEFT JOIN tasks t ON t.id=json_extract(j.payload,'$.task')
       LEFT JOIN messages m ON m.id=json_extract(j.payload,'$.message')
       WHERE j.status IN ('pending','running')
       ORDER BY j.created_at LIMIT 1`,
    ).first();
    lines.push(
      `任务：${n} 个进行中，最久「${jobTitle(oldest)}」${ago(
        oldest?.created_at,
      )}`,
    );
  }

  // F6-6 may not be merged yet: a missing table must never break /status.
  try {
    const schedule = await e.DB.prepare(
      "SELECT kind,next_run_at FROM schedules WHERE status='active' AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 1",
    ).first();
    lines.push(
      schedule
        ? `定时：${sydneyTime(schedule.next_run_at)}（${
            SCHEDULE_LABELS[schedule.kind] || schedule.kind
          }）`
        : "定时：没有启用中的",
    );
  } catch {}
  // F6-3 may not be merged yet: same degradation rule for the audit table.
  try {
    const failure = await e.DB.prepare(
      "SELECT name,error_kind,created_at FROM turn_tools WHERE ok=0 ORDER BY created_at DESC LIMIT 1",
    ).first();
    lines.push(
      failure
        ? `工具：最近失败 ${failure.name}（${
            failure.error_kind || "未知原因"
          }，${ago(failure.created_at)}）`
        : "工具：没有失败记录",
    );
  } catch {}

  return lines.join("\n");
}

/** Cancel this group's pending/running work; repeated calls report nothing left. */
export async function stopGroupJobs(e: any, groupId: string): Promise<string> {
  const jobs = (
    await e.DB.prepare(
      `SELECT j.id,j.kind,j.payload,j.created_at,t.title AS task_title,m.body AS message_body
       FROM jobs j
       LEFT JOIN tasks t ON t.id=json_extract(j.payload,'$.task')
       LEFT JOIN messages m ON m.id=json_extract(j.payload,'$.message')
       WHERE j.status IN ('pending','running') AND (
         json_extract(j.payload,'$.message') IN (SELECT id FROM messages WHERE group_id=?1)
         OR json_extract(j.payload,'$.latestId') IN (SELECT id FROM messages WHERE group_id=?1)
         OR (j.kind='video_reply' AND json_extract(j.payload,'$.wait') IN (SELECT id FROM video_waits WHERE group_id=?1))
         OR (j.kind='plan' AND json_extract(j.payload,'$.task') IN (SELECT id FROM tasks WHERE source_id IN (SELECT id FROM messages WHERE group_id=?1)))
       )
       ORDER BY j.created_at LIMIT 90`,
    )
      .bind(groupId)
      .all()
  ).results as any[];
  if (!jobs.length) return "现在没有在跑的长任务。";
  const ids = jobs.map((j: any) => j.id);
  await e.DB.batch([
    e.DB.prepare(
      "UPDATE video_waits SET status='cancelled' WHERE group_id=? AND status IN ('waiting','running')",
    ).bind(groupId),
    e.DB.prepare(
      "UPDATE jobs SET status='cancelled',error='群内 /stop 取消' WHERE status IN ('pending','running') AND id IN (" +
        ids.map(() => "?").join(",") +
        ")",
    ).bind(...ids),
  ]);
  const lines = jobs.slice(0, 5).map((j: any) => `· ${jobLine(j)}`);
  if (jobs.length > 5) lines.push(`· 还有 ${jobs.length - 5} 个`);
  return `已停 ${jobs.length} 个：\n${lines.join("\n")}`;
}

/**
 * Handle a deterministic command before participation. Returns true when the
 * message was a command (including a revoked member's ignored command).
 * Replies go through the existing outbox so QQ delivery stays unchanged.
 */
export async function handleCommand(
  e: any,
  input: CommandInput,
): Promise<boolean> {
  const cmd = parseCommand(input.text);
  if (!cmd) return false;
  if (input.memberId) {
    const member = await e.DB.prepare("SELECT revoked FROM members WHERE id=?")
      .bind(input.memberId)
      .first();
    if (member?.revoked) return true;
  }
  const bodies =
    cmd === "help"
      ? [HELP]
      : cmd === "status"
        ? [await statusReport(e)]
        : cmd === "stop"
          ? [await stopGroupJobs(e, input.groupId)]
          : [RECALL_LIMIT, RECALL_CORRECTION];
  const now = Date.now();
  await e.DB.batch(
    bodies.map((body, i) =>
      e.DB.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?)").bind(
        `cmd-${input.messageId}-${i}`,
        input.groupId,
        null,
        body,
        "pending",
        now + i,
      ),
    ),
  );
  return true;
}
