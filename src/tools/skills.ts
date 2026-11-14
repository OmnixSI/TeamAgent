// D5 skill tools: skill_save / skill_run / skill_list / skill_disable (design §5.7).
// A skill is only a read-only Step[] recipe; skill_save never stores code or URLs.
import type { BotTool, ToolCtx } from "../toolkit";
import { TEAM } from "../config";
import { isAutoSender } from "../feature-request-core";
import {
  SkillError,
  disableSkill,
  listSkills,
  runSkill,
  saveSkill,
  skillListText,
  stepSummary,
  type SkillRow,
} from "../skills";

const STEP_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "records_summary",
        "records_query",
        "quota",
        "token_usage",
        "chat_digest",
        "work_status",
        "text",
      ],
    },
    type: { type: "string", description: "账本/清单的名称或编号（records_* 必填）" },
    group_by: { type: "string", description: "按字段分组，例如 person" },
    period: {
      type: "string",
      enum: ["all", "today", "yesterday", "this_month", "last_month"],
    },
    filter: {
      type: "object",
      properties: {
        person: { type: "string" },
        status: { type: "string" },
        text: { type: "string" },
      },
      additionalProperties: false,
    },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    days: { type: "integer", enum: [1, 7] },
    topic: { type: "string" },
    text: { type: "string", description: "固定文字，不超过 300 字" },
  },
  required: ["action"],
  additionalProperties: false,
};

function scopeOf(ctx: ToolCtx, args: any) {
  const latest = ctx?.context?.latest || ctx?.source || {};
  let source = latest;
  if (args?.source_id != null) {
    source =
      (ctx?.context?.batch || []).find((message: any) => message.id === args.source_id) ||
      (latest.id === args.source_id ? latest : null);
    if (!source) return null;
  }
  return {
    groupId: String(source?.group_id || latest?.group_id || ""),
    sender: String(source?.sender || ""),
    sourceId: String(source?.id || ""),
    body: String(source?.body || ""),
  };
}

async function actorOf(e: any, ctx: ToolCtx, sender: string) {
  const names: Map<string, string> =
    ctx?.context?.names instanceof Map ? ctx.context.names : new Map();
  return {
    sender,
    name: names.get(sender) || "成员" + String(sender).slice(-4),
    isAdmin: sender ? await isAutoSender(e, sender).catch(() => false) : false,
  };
}

function failure(error_kind: string, reason_text: string, say?: string) {
  return {
    ok: false,
    error_kind,
    retryable: false,
    reason_text,
    say: say || reason_text,
  };
}

function skillFailure(error: unknown): any {
  if (error instanceof SkillError) {
    if (error.kind === "unsupported") {
      const what = error.unsupported.length ? error.unsupported.join("、") : error.message;
      return {
        ok: false,
        error_kind: "unsupported",
        unsupported: error.unsupported,
        retryable: false,
        reason_text: error.message,
        say: `这部分我做不了：${what}；要我登记成需求吗`,
        next_action: "告诉成员哪一步做不了；可以调用 request_feature 把需求登记下来",
      };
    }
    const generic: Record<string, string> = {
      invalid: error.message,
      denied: error.message,
      quota: error.message,
      not_found: error.message,
      ambiguous: error.message,
      unavailable: "动作层暂时没跑起来，先别答应成员，稍后再试",
    };
    return {
      ok: false,
      error_kind: error.kind,
      retryable: false,
      reason_text: error.message,
      say: generic[error.kind] || error.message,
      ...(error.candidates.length ? { candidates: error.candidates } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error_kind: "unavailable",
    retryable: false,
    reason_text: message,
    say: "技能暂时没跑起来，先别答应成员，稍后再试",
  };
}

function skillJson(skill: SkillRow) {
  return {
    id: skill.id,
    name: skill.name,
    triggers: skill.triggers,
    status: skill.status,
    uses: skill.uses,
    last_used_at: skill.last_used_at,
  };
}

export const skillSaveTool: BotTool = {
  name: "skill_save",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "skill_save",
      description:
        "把「以后我说 X 你就做 Y」登记成本群技能：只存只读步骤配方（查账本、余额、用量、摘要、状态或固定文字），不写代码、不抓网址、不改数据。同名技能只有创建者或管理员能覆盖；每群最多 20 个。成员说「建个工具/技能」「以后我说…你就…」时调用。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名/触发名，不超过 12 个字，例如「日结」" },
          triggers: {
            type: "array",
            maxItems: 5,
            items: { type: "string", maxLength: 12 },
            description: "额外触发词，最多 5 个，每个不超过 12 个字",
          },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: STEP_SCHEMA,
            description: "只读动作，按顺序执行；超过只读范围的步骤会被拒绝",
          },
          note: { type: "string", maxLength: 600, description: "成文说明，不超过 600 字" },
          request_quote: {
            type: "string",
            description: "成员要把这件事登记成技能的原话，逐字复制，不少于 2 个字",
          },
          source_id: { type: "string", description: "原话所在消息的 id；省略时用最新一条" },
        },
        required: ["name", "steps", "request_quote"],
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx) {
    const scope = scopeOf(ctx, args);
    if (!scope?.groupId) return failure("invalid", "缺少群信息");
    const quote = typeof args?.request_quote === "string" ? args.request_quote.trim() : "";
    if (quote.length < 2)
      return failure("invalid", "要带一句成员的原话（request_quote）", "我要先确认这是成员本人要建的技能。");
    const actor = await actorOf(e, ctx, scope.sender);
    try {
      const { skill } = await saveSkill(
        { e, groupId: scope.groupId, actor, now: Date.now(), sourceMsgId: scope.sourceId },
        { name: args?.name, triggers: args?.triggers, steps: args?.steps, note: args?.note },
      );
      return {
        ok: true,
        accepted: true,
        family: "skill",
        id: skill.id,
        status: skill.status,
        say: `建好了：以后说「${skill.name}」我就 ${stepSummary(skill.steps)}`,
      };
    } catch (error) {
      return skillFailure(error);
    }
  },
};

export const skillRunTool: BotTool = {
  name: "skill_run",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "skill_run",
      description:
        "运行本群已登记的技能：按名字或触发词精确匹配，执行它的只读步骤并把结果成文。成员只说了技能名/触发词（例如「日结」「收工」）时调用；找不到时会列出本群可用技能。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名或触发词" },
          args: {
            type: "object",
            properties: {
              type: { type: "string", description: "临时换一个账本/清单名" },
              period: { type: "string", description: "临时换时间段：today/yesterday/this_month/last_month/all" },
            },
            additionalProperties: false,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx) {
    const scope = scopeOf(ctx, {});
    if (!scope?.groupId) return failure("invalid", "缺少群信息");
    const actor = await actorOf(e, ctx, scope.sender);
    try {
      const result = await runSkill(
        { e, groupId: scope.groupId, actor, tz: TEAM.memory.timezone, now: Date.now() },
        args?.name,
        args?.args,
      );
      return { ok: true, text: result.text };
    } catch (error) {
      return skillFailure(error);
    }
  },
};

export const skillListTool: BotTool = {
  name: "skill_list",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "skill_list",
      description:
        "列出本群技能：名字、触发词、状态、用过几次。成员问「有哪些技能/工具」「我建过什么」时调用。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  async run(e: any, _args: any, ctx: ToolCtx) {
    const scope = scopeOf(ctx, {});
    if (!scope?.groupId) return failure("invalid", "缺少群信息");
    try {
      const skills = await listSkills(e, scope.groupId, true);
      return { ok: true, text: skillListText(skills), skills: skills.map(skillJson) };
    } catch (error) {
      return skillFailure(error);
    }
  },
};

export const skillDisableTool: BotTool = {
  name: "skill_disable",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "skill_disable",
      description:
        "停用本群的一个技能（以后不再触发）。只有创建者或管理员能停用；只是不用了、不删除数据。成员说「停用/关掉那个技能」时调用。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx) {
    const scope = scopeOf(ctx, {});
    if (!scope?.groupId) return failure("invalid", "缺少群信息");
    const actor = await actorOf(e, ctx, scope.sender);
    try {
      const skill = await disableSkill(
        { e, groupId: scope.groupId, actor, now: Date.now() },
        args?.name,
      );
      return {
        ok: true,
        accepted: true,
        family: "skill",
        id: skill.id,
        status: "disabled",
        say: `已停用「${skill.name}」，以后不会再触发。`,
      };
    } catch (error) {
      return skillFailure(error);
    }
  },
};
