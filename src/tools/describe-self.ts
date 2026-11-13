// SK-2 describe_self: the model's only sanctioned source for facts about itself.
// Read-only, no env values, no network: the card is the build-time artifact and the
// live half comes from one D1 settings read. Kill switch defaults to the tool name.
import type { BotTool, ToolCtx } from "../toolkit";
import { readLive, renderSelf, SELF_TOPICS } from "../self-card";
import { SELF_CARD } from "../self-card.generated";

const TOPICS = SELF_TOPICS.join("|");

function failure(kind: string, reason_text: string, next_action: string, retryable = false) {
  return { ok: false, error_kind: kind, retryable, reason_text, next_action };
}

export const describeSelfTool: BotTool = {
  name: "describe_self",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "describe_self",
      description:
        "查自己：被问到你自己某个能力是怎么实现的、用哪家模型/接口、跑在本机还是云端、哪些开关开着、代码在哪个文件、仓库怎么组成时先调用。" +
        "topic: overview|capability|vendors|repo_map|switches；capability 要给 query。",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: [...SELF_TOPICS],
            description:
              "查什么：overview 全部能力总览；capability 某个能力（配 query）；vendors 用到的厂商与密钥存放位置（只给名字）；repo_map 仓库组成；switches 当前开关状态",
          },
          query: {
            type: "string",
            description:
              "topic=capability 时必填：能力名、别名、工具名或关键词，例如 生图、语音识别、generate_image",
          },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, _ctx: ToolCtx): Promise<any> {
    const topic = String(args?.topic || "").trim().toLowerCase();
    if (!(SELF_TOPICS as readonly string[]).includes(topic))
      return failure(
        "unsupported",
        `topic 只能是 ${TOPICS}`,
        "改用 overview、capability、vendors、repo_map 或 switches",
      );
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (topic === "capability" && !query)
      return failure(
        "unsupported",
        "topic=capability 需要 query",
        "补上能力名、别名、工具名或关键词再调用一次",
      );
    try {
      const live = await readLive(e);
      return {
        ok: true,
        text: renderSelf(SELF_CARD, live, topic, query || undefined),
        card_commit: SELF_CARD.commit,
        release: live.release,
      };
    } catch {
      return failure(
        "unavailable",
        "读不到线上开关状态，这次没法如实回答自身状态",
        "告诉成员这次没有查到自身状态，不要猜；稍后可以再试",
        true,
      );
    }
  },
};
