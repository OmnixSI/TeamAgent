// ds-balance get_quota: answer "how much DeepSeek balance is left" from the
// provider's own read-only endpoint, comparing with the previous real read.
// Read-only: one cached balance read and at most one small snapshot write.
// The kill switch is settings key off:ds_balance; it is on unless an admin
// writes a truthy value there.
import type { BotTool, ToolCtx } from "../toolkit";
import { renderQuota } from "../quota";

export const getQuotaTool: BotTool = {
  name: "get_quota",
  switch: "ds_balance",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "get_quota",
      description:
        "查 DeepSeek 账户还剩多少余额：读官方余额，跟上次查询比较，回答里直接说还剩多少、比上次多了或少了多少。被问「你还有多少额度」「DeepSeek 余额」「额度还剩多少」「比上次少了多少」时调用。只有群主本人直接问才给具体金额；其他人只回答够用/偏低/快没了。只读，不猜数字；查不到就如实说查不到。回答保持口语化，不要提接口、缓存或数据库。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  async run(e: any, _args: any, ctx: ToolCtx): Promise<any> {
    // Reuse A-quota's owner rule: only the QQ owner who directly asked gets
    // exact amounts; everyone else gets the same one-line band.
    const latest = ctx?.context?.latest || {};
    const meta = latest?.meta || {};
    const owner = String(meta.memberRole || "").toLowerCase() === "owner";
    const direct = !!(ctx?.context?.mentioned || meta.direct === true);
    return renderQuota(e, { owner: owner && direct });
  },
};
