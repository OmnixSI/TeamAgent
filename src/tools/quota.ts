// A-quota get_quota: answer "how much allowance do you have left" from real
// provider numbers. Read-only: one cached balance read, a few D1 aggregates,
// no writes except the ten-minute cache. Only the group owner who directly asks
// gets exact amounts; everyone else gets one of three coarse words.
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
        "查自己还剩多少额度：DeepSeek 余额（缓存十分钟）、今天/本月的 DeepSeek 次数与估算花费、OpenAI 与生图的每日限额已用/剩余、Workers AI 今日 neurons。被问「你还有多少额度/余额/今天用了多少」时调用。" +
        "只有群主本人直接问才给具体金额和数字；其他人只回答够用/偏低/快没了。只读，不要猜数字。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  async run(e: any, _args: any, ctx: ToolCtx): Promise<any> {
    const latest = ctx?.context?.latest || {};
    const meta = latest?.meta || {};
    const owner = String(meta.memberRole || "").toLowerCase() === "owner";
    const direct = !!(ctx?.context?.mentioned || meta.direct === true);
    return renderQuota(e, {
      owner: owner && direct,
      group: latest?.group_id,
      sender: latest?.sender,
    });
  },
};
