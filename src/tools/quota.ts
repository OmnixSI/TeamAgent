// A-quota get_quota: answer "how much allowance do you have left" from real
// provider numbers. Read-only: one cached balance read, a few D1 aggregates,
// no writes except the ten-minute cache. Every group member gets the exact
// numbers and the "since last time" delta, with or without an @mention.
import type { BotTool, ToolCtx } from "../toolkit";
import { renderQuota } from "../quota";

export const getQuotaTool: BotTool = {
  name: "get_quota",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "get_quota",
      description:
        "查自己还剩多少额度：DeepSeek 余额、今天/本月次数与花费、OpenAI 每日预算（是预算闸门，不是账户余额，不要说成 OpenAI 还剩多少钱）、Workers AI neurons，以及较上次的余额（含赠送/充值）与用量变化。被问「你还有多少额度/余额/今天用了多少」时调用。" +
        "任何成员问都给具体余额和较上次的变化，不用 @；只读，不要猜数字。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  async run(e: any, _args: any, ctx: ToolCtx): Promise<any> {
    const latest = ctx?.context?.latest || {};
    return renderQuota(e, {
      group: latest?.group_id,
      sender: latest?.sender,
    });
  },
};
