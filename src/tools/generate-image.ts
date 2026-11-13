// F8-2 generate_image: the model decides from this description whether a member is
// asking for a new picture (no keyword matching here). This tool owns the money
// checks: taint refusal, per-member/per-group quota, one generation per turn, and
// the image_gen_log audit row. The OpenAI call and the outbox write belong to
// F8-1 (src/imagegen.ts); quota reservations belong to F8-0 (src/openai.ts).
//
// Group isolation: group, sender and turn come from the turn context only; tool
// arguments cannot name another group. The log stores at most 500 characters of
// the prompt and never stores a key.
import type { BotTool, ToolCtx } from "../toolkit";
import { generateImage as realGenerateImage, enqueueGeneratedImage as realEnqueueGeneratedImage } from "../imagegen";
import { releaseQuota as realReleaseQuota, reserveQuota as realReserveQuota } from "../openai";

const SIZE_MAP = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" } as const;
type SizeKey = keyof typeof SIZE_MAP;
const DEFAULT_SIZE: SizeKey = "square";
const DEFAULT_USER_DAILY = 5;
const DEFAULT_GROUP_DAILY = 20;
const MAX_PROMPT = 1000;
const LOG_PROMPT = 500;

export type GenerateImageDeps = {
  generateImage: (e: any, o: { prompt: string; size: string; group: string; sender: string }) => Promise<any>;
  enqueueGeneratedImage: (e: any, o: any) => Promise<{ outbox_id: string }>;
  reserveQuota: (
    e: any,
    o: { kind: string; key: string; limit: number; windowMs?: number },
  ) => Promise<{ ok: boolean; used: number; limit: number; reservation_id?: string; id?: string }>;
  releaseQuota: (e: any, reservationId: string) => Promise<void>;
  now: () => number;
};

const realDeps: GenerateImageDeps = {
  generateImage: realGenerateImage,
  enqueueGeneratedImage: realEnqueueGeneratedImage,
  reserveQuota: realReserveQuota,
  releaseQuota: realReleaseQuota,
  now: () => Date.now(),
};

const clip = (text: unknown, max: number): string => Array.from(String(text ?? "")).slice(0, max).join("");

function whoOf(ctx: ToolCtx): { group: string; sender: string; turn: string } {
  const source = ctx?.source || ctx?.context?.latest || {};
  return {
    group: String(source.group_id || source.groupId || ""),
    sender: String(source.sender || ""),
    turn: String(source.id || ""),
  };
}

function failure(kind: string, reason_text: string, next_action: string, retryable = false) {
  return { ok: false, error_kind: kind, retryable, reason_text, next_action };
}

const DEFAULT_REASON: Record<string, string> = {
  refused: "图片内容安全系统拒绝了这个提示词",
  timeout: "图片生成超时了",
  upstream: "图片服务暂时没有成功返回",
  auth: "生图服务的凭据当前不可用",
  budget: "今天的 OpenAI 总预算用完了",
  quota: "生图服务当前额度不足",
  denied: "这次请求被拒绝了",
  unsupported: "这次请求的参数不支持",
};
const DEFAULT_ACTION: Record<string, string> = {
  refused: "告诉成员提示词被安全系统拒绝，可以换一种描述再试一次；不要教人绕过",
  timeout: "告诉成员这次没有生成成功，可以稍后重试一次；不要假装图片已发出",
  upstream: "告诉成员这次没有生成成功，可以过一会儿再试一次；不要假装图片已发出",
  auth: "告诉成员生图服务暂时不可用，请联系管理员检查密钥",
  budget: "告诉成员今天的生图预算用完了，明天再试",
  quota: "告诉成员生图服务暂时额度不足，稍后再试",
  denied: "如实说明被拒绝的原因，不要重试",
  unsupported: "先问成员想画什么，再调用一次",
};

async function settingLimit(e: any, key: string, fallback: number): Promise<number> {
  try {
    const row = await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
    const n = Number(row?.value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

async function writeLog(e: any, row: any): Promise<void> {
  try {
    await e.DB.prepare(
      "INSERT INTO image_gen_log(group_id,sender_id,turn_id,prompt,size,quality,model,status,error_kind,bytes,latency_ms,est_cost_micro_usd,outbox_id,created_at) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        row.group_id,
        row.sender_id,
        row.turn_id,
        row.prompt,
        row.size,
        row.quality ?? null,
        row.model ?? null,
        row.status,
        row.error_kind ?? null,
        row.bytes ?? null,
        row.latency_ms ?? null,
        row.est_cost_micro_usd ?? null,
        row.outbox_id ?? null,
        row.created_at,
      )
      .run();
  } catch {
    // An audit write must not turn a sent picture into a reported failure.
  }
}

/**
 * Claim this turn with a pending row. The partial unique index (group_id,turn_id)
 * WHERE status IN ('pending','ok') makes a duplicate model call lose the race
 * instead of spending twice.
 */
async function claimRow(e: any, row: any): Promise<"claimed" | "live" | "error"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await e.DB.prepare(
        "INSERT INTO image_gen_log(group_id,sender_id,turn_id,prompt,size,status,created_at) VALUES(?,?,?,?,?,?,?)",
      )
        .bind(row.group_id, row.sender_id, row.turn_id, row.prompt, row.size, "pending", row.created_at)
        .run();
      return "claimed";
    } catch {
      try {
        const live = await e.DB.prepare(
          "SELECT 1 AS live FROM image_gen_log WHERE group_id=? AND turn_id=? AND status IN ('pending','ok') LIMIT 1",
        )
          .bind(row.group_id, row.turn_id)
          .first();
        if (live) return "live";
      } catch {
        return "error";
      }
    }
  }
  return "error";
}

async function finishRow(e: any, who: { group: string; turn: string }, patch: any): Promise<void> {
  try {
    await e.DB.prepare(
      "UPDATE image_gen_log SET status=?,error_kind=?,bytes=?,latency_ms=?,est_cost_micro_usd=?,outbox_id=?,model=?,quality=? " +
        "WHERE group_id=? AND turn_id=? AND status='pending'",
    )
      .bind(
        patch.status,
        patch.error_kind ?? null,
        patch.bytes ?? null,
        patch.latency_ms ?? null,
        patch.est_cost_micro_usd ?? null,
        patch.outbox_id ?? null,
        patch.model ?? null,
        patch.quality ?? null,
        who.group,
        who.turn,
      )
      .run();
  } catch {
    // Same rule as writeLog: never turn an audit failure into a delivery claim.
  }
}

async function release(e: any, d: GenerateImageDeps, reservation: any): Promise<void> {
  const id = reservation?.reservation_id || reservation?.id;
  if (!id) return;
  try {
    await d.releaseQuota(e, String(id));
  } catch {
    // Releasing is best effort; the daily reservation expires on its own.
  }
}

async function releaseBoth(e: any, d: GenerateImageDeps, user: any, group: any): Promise<void> {
  await release(e, d, user);
  await release(e, d, group);
}

function quotaFailure(scope: string, used: number, limit: number) {
  const remaining = Math.max(0, limit - used);
  return failure(
    "quota",
    `${scope}今天的生图额度用完了（已用 ${used}/${limit}，还剩 ${remaining} 张）；悉尼时间明天 0 点后重置`,
    "如实告诉成员额度用完和重置时间；不要重试，也不要换个体裁重复调用",
  );
}

const queued = () => ({
  ok: true,
  status: "queued",
  note: "图片会随后单独发出；回复里只用一句话说明正在生成/已生成，不要贴链接，也不要描述图里有什么（你看不到图）",
});

export function makeGenerateImageTool(overrides: Partial<GenerateImageDeps> = {}): BotTool {
  const d: GenerateImageDeps = { ...realDeps, ...overrides };
  return {
    name: "generate_image",
    untrusted: false,
    def: {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "生成一张新图片并发到当前群。当成员明确要你画/生成/做一张图、海报、头像、插画、壁纸或表情图，并给出画面描述时调用；" +
          "prompt 保留成员的原话与语言，图里要出现的文字原样写进去，只能补画风，不能改变成员的意图。" +
          "不用于：把「画」当比喻（画饼、画重点、画大饼）、问你怎么画、要你改代码或画数据图表（那是 create_file_task 或直接回答）、" +
          "要找现成图片或表情包（用 search_emoji / search_web）、只是夸图好看。" +
          "画面描述不清楚时先反问一句再调用，不要自己编大段细节；一次只生成一张。" +
          "调用成功后图片会单独发出，你看不到图，不要描述图里有什么，也不要说已经看到。",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "成员的画面描述，保留原语言；图中要出现的文字原样写进去；可以补画风，但不能改变成员意图。",
            },
            size: {
              type: "string",
              enum: ["square", "portrait", "landscape"],
              description: "画幅：square 方图 1024x1024（缺省）、portrait 竖图 1024x1536、landscape 横图 1536x1024。",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    },
    async run(e: any, args: any, ctx: ToolCtx): Promise<any> {
      const who = whoOf(ctx);
      const a = args || {};
      const rawPrompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
      const requestedSize = a.size === undefined || a.size === null || a.size === "" ? DEFAULT_SIZE : String(a.size);
      const sizeOk = Object.prototype.hasOwnProperty.call(SIZE_MAP, requestedSize);
      const sizeKey: SizeKey = sizeOk ? (requestedSize as SizeKey) : DEFAULT_SIZE;
      const now = d.now();
      const started = now;
      const base = {
        group_id: who.group,
        sender_id: who.sender,
        turn_id: who.turn,
        prompt: clip(rawPrompt, LOG_PROMPT),
        size: sizeKey,
        created_at: now,
      };

      // A turn carrying outside material cannot authorize spending money on a picture.
      if (typeof ctx?.isTainted === "function" && ctx.isTainted()) {
        await writeLog(e, {
          ...base,
          status: "failed",
          error_kind: "denied",
          latency_ms: 0,
          est_cost_micro_usd: 0,
        });
        return failure(
          "denied",
          "这条请求夹带了外部资料，我不会据此花钱生图，请你直接用自己的话再说一次",
          "让成员重述",
        );
      }

      if (!who.group || !who.sender || !who.turn) {
        return failure("unsupported", "这条消息缺少群、成员或消息 id，不能生图", "告诉成员这条消息暂时不能生图");
      }

      // F8-common: each purpose checks its own admin switch; off:openai is checked by F8-0.
      const purposeOff = await e.DB.prepare("SELECT value FROM settings WHERE key='off:image_gen'").first().catch(() => null);
      if (purposeOff && String(purposeOff.value || "").length > 0 && purposeOff.value !== "0" && purposeOff.value !== "false") {
        await writeLog(e, { ...base, status: "failed", error_kind: "denied", latency_ms: 0, est_cost_micro_usd: 0 });
        return { ...failure("denied", "生图功能已被管理员关闭", "告诉成员该功能当前关闭，不要重试"), unavailable: true };
      }
      if (!rawPrompt) {
        await writeLog(e, { ...base, status: "failed", error_kind: "unsupported", latency_ms: 0, est_cost_micro_usd: 0 });
        return failure("unsupported", "画面描述是空的，没法生成图片", "先问成员想画什么，再调用一次");
      }
      if (Array.from(rawPrompt).length > MAX_PROMPT) {
        await writeLog(e, { ...base, status: "failed", error_kind: "unsupported", latency_ms: 0, est_cost_micro_usd: 0 });
        return failure("unsupported", "画面描述太长了（超过 1000 字），没法一次生成", "让成员用一段话概括画面，不要自己删改重点");
      }
      if (!sizeOk) {
        await writeLog(e, { ...base, status: "failed", error_kind: "unsupported", latency_ms: 0, est_cost_micro_usd: 0 });
        return failure("unsupported", "不支持这个画幅，只能选 square、portrait、landscape", "改用缺省画幅或问成员要横图还是竖图");
      }

      const claim = await claimRow(e, base);
      if (claim === "live") return queued();
      if (claim === "error")
        return failure(
          "unavailable",
          "这次生图请求没能记录下来，我不能在没有审计的情况下花钱",
          "告诉成员稍后再试；不要重复调用",
        );

      const userLimit = await settingLimit(e, "imagegen:user_daily", DEFAULT_USER_DAILY);
      const groupLimit = await settingLimit(e, "imagegen:group_daily", DEFAULT_GROUP_DAILY);
      let userRes: any;
      try {
        userRes = await d.reserveQuota(e, { kind: "imagegen_user", key: who.group + ":" + who.sender, limit: userLimit });
      } catch {
        await finishRow(e, who, { status: "failed", error_kind: "unavailable", latency_ms: d.now() - started });
        return failure("unavailable", "生图额度服务暂时不可用", "告诉成员稍后再试；不要重试");
      }
      if (!userRes?.ok) {
        const used = Number(userRes?.used ?? 0);
        const limit = Number(userRes?.limit ?? userLimit);
        await finishRow(e, who, {
          status: "failed",
          error_kind: "quota",
          latency_ms: d.now() - started,
          est_cost_micro_usd: 0,
        });
        return quotaFailure("你", used, limit);
      }
      let groupRes: any;
      try {
        groupRes = await d.reserveQuota(e, { kind: "imagegen_group", key: who.group, limit: groupLimit });
      } catch {
        await release(e, d, userRes);
        await finishRow(e, who, { status: "failed", error_kind: "unavailable", latency_ms: d.now() - started });
        return failure("unavailable", "生图额度服务暂时不可用", "告诉成员稍后再试；不要重试");
      }
      if (!groupRes?.ok) {
        const used = Number(groupRes?.used ?? 0);
        const limit = Number(groupRes?.limit ?? groupLimit);
        await release(e, d, userRes);
        await finishRow(e, who, {
          status: "failed",
          error_kind: "quota",
          latency_ms: d.now() - started,
          est_cost_micro_usd: 0,
        });
        return quotaFailure("这个群", used, limit);
      }

      let gen: any;
      try {
        gen = await d.generateImage(e, {
          prompt: rawPrompt,
          size: SIZE_MAP[sizeKey],
          group: who.group,
          sender: who.sender,
        });
      } catch {
        gen = { ok: false, error_kind: "upstream", retryable: true };
      }
      if (!gen || gen.ok !== true) {
        const kind = String(gen?.error_kind || "upstream");
        await releaseBoth(e, d, userRes, groupRes);
        await finishRow(e, who, {
          status: "failed",
          error_kind: kind,
          latency_ms: d.now() - started,
          est_cost_micro_usd: Number(gen?.est_cost_micro_usd) || 0,
        });
        const reason =
          typeof gen?.reason_text === "string" && gen.reason_text ? gen.reason_text : DEFAULT_REASON[kind] || DEFAULT_REASON.upstream;
        const action =
          typeof gen?.next_action === "string" && gen.next_action ? gen.next_action : DEFAULT_ACTION[kind] || DEFAULT_ACTION.upstream;
        return failure(kind, reason, action, !!gen?.retryable);
      }

      let enqueued: any;
      try {
        enqueued = await d.enqueueGeneratedImage(e, {
          id: who.turn,
          group: who.group,
          message: who.turn,
          jpeg: gen.jpeg,
          prompt: rawPrompt,
          sender: who.sender,
        });
      } catch {
        enqueued = null;
      }
      if (!enqueued || !enqueued.outbox_id) {
        await releaseBoth(e, d, userRes, groupRes);
        await finishRow(e, who, {
          status: "failed",
          error_kind: "upstream",
          bytes: Number(gen.bytes) || 0,
          latency_ms: Number(gen.latency_ms) || d.now() - started,
          est_cost_micro_usd: Number(gen.est_cost_micro_usd) || 0,
          model: gen.model || null,
          quality: gen.quality || "low",
        });
        return failure(
          "upstream",
          "图片生成好了，但没能排进发送队列，这次不会发出去",
          "告诉成员这次没有发出，可以稍后再试；不要贴链接，也不要说已经发了",
        );
      }

      await finishRow(e, who, {
        status: "ok",
        error_kind: null,
        bytes: Number(gen.bytes) || (gen.jpeg?.length ?? 0),
        latency_ms: Number(gen.latency_ms) || d.now() - started,
        est_cost_micro_usd: Number(gen.est_cost_micro_usd) || 0,
        outbox_id: String(enqueued.outbox_id),
        model: gen.model || null,
        quality: gen.quality || "low",
      });
      return queued();
    },
  };
}

export const generateImageTool: BotTool = makeGenerateImageTool();
