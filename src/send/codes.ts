/** Verified 2026-11-13 against QQ's group-send error table (updated 2026-10-28):
 * https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * 40054005 dedup; 304103/40034005/40034128 passive expiry/quota;
 * 40054002/40054003/40034101 muted/nonmember. Other documented rejection
 * codes below must not be mistaken for invalid references. No specific ref_idx
 * error was documented: unrecognised JSON 400/422 retains legacy quoteOutcome.
 * Passive 5/300s behavior reference: Mai-with-u/MaiBot@03347c9
 * src/plugins/built_in/qq_official_adapter/plugin.py::_claim_passive_fields (MIT).
 * The plan uses a 280s claim window to leave time for the 20s request.
 * Platform dedup semantics have not been live-tested: unknown resend stays off.
 */
export type SendOutcome='sent'|'ref_invalid'|'passive_invalid'|'rate_limited'|'blocked'|'muted'|'unknown';
const passive=new Set([304103,40034005,40034128]);
const muted=new Set([40054002,40054003,40034101]);
const blocked=new Set([22006,304004,304036,304061,304064,304080,305007,340069,40034004,40034006,40034008,40034009,40034010,40034011,40034024,40034025,40034026,40034027,40034029,40034105,40034106,40034108,40034109,40034124,40034127,40054007,40054010,40054016]);
export function sendOutcome(http:number,result:any,reference:boolean):SendOutcome{
 const code=Number(result?.code);
 if(http>=200&&http<300&&(result?.id||result?.code===0)||code===40054005)return 'sent';
 if(passive.has(code))return 'passive_invalid';if(muted.has(code))return 'muted';
 if(http>=300&&http<400)return 'blocked';
 if(http===429)return 'rate_limited';if(blocked.has(code))return 'blocked';
 if(http>=500||!result)return 'unknown';
 return reference&&(http===400||http===422)?'ref_invalid':'blocked';
}
