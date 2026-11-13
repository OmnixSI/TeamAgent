/** Verified 2026-11-13 against Tencent's official QQ bot docs (page dates inline).
 *
 * Passive replies (group; this file serves groups)
 * - 5 min validity, max 5 replies per message; msg_id comes from event d.id and is
 *   "valid for 5 minutes".
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html (2026-10-28)
 *   https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html (2026-07-21; C2C 60 min/4, group 5 min/5)
 * - The docs do not say whether the 5 min starts at the event timestamp or at receipt.
 *   The 280s claim window (20s margin for the request) is a project choice, not documented.
 * - event_id and msg_id are alternatives; event_id supports INTERACTION_CREATE,
 *   GROUP_ADD_ROBOT and GROUP_MSG_RECEIVE. No validity window is documented for event_id.
 *
 * msg_seq dedup
 * - Same msg_id + msg_seq sent twice fails; increment msg_seq to reply again to one message.
 * - The platform may push the same msg_id more than once, so dedup has to use msg_seq.
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html (2026-09-16)
 * - No msg_seq range is documented. With the 5-reply cap only 5 seqs are usable per msg_id;
 *   our 1..5 counter is a project choice, not documented.
 * - 40054005 = "message deduplicated" (fix: use a different msg_seq). The docs do not say
 *   whether the first request succeeded, so treating it as sent is unverified live.
 *   Platform dedup semantics have not been live-tested: unknown resend stays off.
 *
 * Send error codes (group table, 2026-10-28; the sets below follow it)
 * - passive_invalid: 304103, 40034005, 40034128 (expired msg_id / passive time or quota).
 * - muted: 40054002, 40054003, 40034101 (muted or bot not a group member).
 * - 40054005 -> sent (dedup, see above). The remaining content/param/permission/URL
 *   rejects sit in blocked, not ref_invalid. No specific ref_idx error is documented:
 *   unrecognised JSON 400/422 keeps the legacy quoteOutcome.
 * - Open gaps, left for the file owner rather than changed here: 40034100 (active-message
 *   rate limit) falls through to blocked and should be rate_limited; 50055001/50055006
 *   (server error) should be unknown/retry; 40034004 (rich-media transfer, docs say retry)
 *   is in blocked and is arguably retryable.
 * - Response field: the docs show err_code; official Node SDK 1.0.5 reads code ?? err_code.
 *   A live 401 probe on 2026-11-13 returned both (code=11244, err_code=40011027), so
 *   reading result.code works today.
 *
 * Chunked upload (group, 4 steps)
 * - POST /v2/groups/{group_openid}/upload_prepare (10 QPS): file_type 1 image/2 video/
 *   3 voice/4 file, file_size, file_name, md5, sha1, md5_10m (first 10002432 bytes).
 *   Returns upload_id, block_size (5MB default), parts[{index,presigned_url,block_size}],
 *   upload_config{concurrency=1, retry_timeout=300s, retry_delay=1s}.
 * - PUT each part to presigned_url (no auth header), then POST .../upload_part_finish
 *   (10 QPS) with upload_id, part_index, block_size, md5.
 * - POST /v2/groups/{group_openid}/files (50 QPS) with upload_id, file_name, file_type and
 *   srv_send_msg=false returns file_info and ttl (0 = long-lived).
 * - Direct binary upload is capped at 5MB; URL upload lets the platform fetch the file;
 *   C2C and group uploads are not interchangeable.
 * - Size caps: image/voice 20MB soft, video 30MB soft, file 200MB; over soft is downgraded
 *   to file, over the 200MB hard cap fails.
 * - Upload errors: 850018 muted, 850019 format, 850026 fetch failed, 850027 timeout,
 *   850031 too large, 10000 bad params, 40093001 retryable failure, 40093002 daily cap.
 * - Docs say parts[].index starts at 0; SDK 1.0.5 uses (index - 1) * block_size. Not
 *   verified live; delivery uploads through the SDK, so it follows the SDK behaviour.
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_prepare.post.html (2026-08-10)
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_part_finish.post.html (2026-07-22)
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html (2026-10-09)
 *   https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html (2026-07-21)
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
