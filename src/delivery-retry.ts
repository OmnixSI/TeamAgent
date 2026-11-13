// Delivery failure handling. The gateway owns the files, so the retry clock
// itself runs in runner/delivery.mjs (1 min, then 5 min, at most 3 attempts).
// This module owns what the cloud records and says once a delivery is exhausted.
export const DELIVERY_RETRY_DELAYS_MS = [60_000, 300_000] as const;
export const MAX_DELIVERY_ATTEMPTS = 3;

const FAILURE_REASONS: Record<string, string> = {
  expired: "交付已超过 24 小时有效期",
  target_unavailable: "没拿到交付目标（QQ 网关或云端不可用）",
  file_denied: "本机文件校验没过（不在允许目录或超过 50 MiB）",
  invalid_files: "文件数量或格式不合规",
  send_failed: "QQ 附件发送失败（网关或网络异常）",
};

function safeCode(value: unknown): string {
  const code = String(value ?? "");
  return Object.hasOwn(FAILURE_REASONS, code) ? code : "send_failed";
}

/** Turn a gateway code into one sentence a group member can act on. */
export function deliveryFailureReason(value: unknown): string {
  return FAILURE_REASONS[safeCode(value)];
}

export function deliveryAttentionText(input: {
  title?: string;
  attempts?: number;
  error?: string;
}): string {
  const attempts = Math.max(
    1,
    Math.min(MAX_DELIVERY_ATTEMPTS, Number(input.attempts) || MAX_DELIVERY_ATTEMPTS),
  );
  const name = input.title ? `「${String(input.title).slice(0, 80)}」的` : "";
  return (
    `${name}附件没发出去：连续 ${attempts} 次尝试都失败（原因：${deliveryFailureReason(input.error)}）。\n` +
    "文件已不再自动重发；需要这份文件请根据原消息重新交办，或在开发台「需要核对的工作」里查看。"
  );
}

/** The reply writer must never turn an empty file list into “已生成文件”. */
export function utilityStatusText(input: { files: number; wantFiles: boolean }): string {
  const files = Math.max(0, Number(input.files) || 0);
  if (files > 0)
    return `资料已整理，${files} 个文件等待 QQ 交付；只报告实际结果，附件是否送达以交付状态为准。`;
  if (input.wantFiles)
    return "这次没有生成任何文件，也没有附件可交付；只报告实际结果，不要声称有文件或附件已发送。说明没完成的原因和下一步。";
  return "资料分析已完成，没有文件交付；只报告实际结果，不要声称有文件。";
}

async function groupOf(e: any, delivery: any): Promise<string | null> {
  const message = await e.DB.prepare("SELECT group_id FROM messages WHERE id=?")
    .bind(delivery.message_id)
    .first();
  if (message?.group_id) return String(message.group_id);
  const setting = await e.DB.prepare("SELECT value FROM settings WHERE key='group_id'").first();
  return setting?.value ? String(setting.value) : null;
}

/** A zero-file report can still contain the runner's old claim. Replace the
 * claim with the observable fact before the reply writer sees it. */
export function utilityResultText(result: unknown, files: number): string {
  const text = String(result ?? "");
  if (Math.max(0, Number(files) || 0) > 0) return text;
  return text
    .replace(/已生成文件[^\n]*/g, "未生成可交付文件（交付清单为空）")
    .replace(/文件已生成/g, "没有可交付的文件")
    .replace(/生成好直接发群里/g, "没有可交付的文件");
}

/**
 * Record an exhausted delivery. Idempotent: the same terminal receipt may
 * arrive again after a network failure, but only one group explanation and one
 * needs_attention marker are written. A delivery already confirmed sent is
 * never downgraded.
 */
export async function recordDeliveryFailure(
  e: any,
  receipt: any,
  options: { now?: number; id?: string } = {},
): Promise<{ recorded: boolean; status: string; attempts: number }> {
  const id = String(options.id ?? receipt?.id ?? "");
  if (!id) return { recorded: false, status: "unknown", attempts: 0 };
  const delivery = await e.DB.prepare("SELECT * FROM deliveries WHERE id=?")
    .bind(id)
    .first();
  if (!delivery) return { recorded: false, status: "unknown", attempts: 0 };
  if (delivery.status === "sent") return { recorded: false, status: "sent", attempts: 0 };

  const attempts = Math.max(
    1,
    Math.min(MAX_DELIVERY_ATTEMPTS, Number(receipt?.attempts) || MAX_DELIVERY_ATTEMPTS),
  );
  const error = safeCode(receipt?.error);
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const existing = await e.DB.prepare(
    "SELECT delivery_id FROM delivery_retries WHERE delivery_id=?",
  )
    .bind(id)
    .first();

  let notice: { group: string; body: string } | null = null;
  if (!existing && error !== "expired" && now - Date.parse(delivery.updated_at) <= 24 * 3600000) {
    const job = await e.DB.prepare("SELECT payload FROM jobs WHERE id=?")
      .bind(delivery.job_id)
      .first();
    let title = "";
    try {
      title = String(JSON.parse(job?.payload || "{}").title || "");
    } catch {}
    const group = await groupOf(e, delivery);
    if (group)
      notice = { group, body: deliveryAttentionText({ title, attempts, error }) };
  }

  await e.DB.batch([
    e.DB.prepare(
      "INSERT OR IGNORE INTO delivery_retries(delivery_id,attempts,last_error,needs_attention,updated_at) VALUES(?,?,?,1,?)",
    ).bind(id, attempts, error, at),
    e.DB.prepare(
      "UPDATE deliveries SET status='needs_attention',updated_at=? WHERE id=? AND status!='sent'",
    ).bind(at, id),
    e.DB.prepare(
      "UPDATE jobs SET payload=json_set(payload,'$.needs_attention',json('true')) WHERE id=? AND kind='media' AND json_valid(payload)",
    ).bind(delivery.job_id),
    ...(notice
      ? [
          e.DB.prepare(
            "INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,'pending',?)",
          ).bind(
            "delivery-attention-" + id,
            notice.group,
            delivery.message_id,
            notice.body,
            now,
          ),
        ]
      : []),
  ]);
  return { recorded: !existing, status: "needs_attention", attempts };
}
