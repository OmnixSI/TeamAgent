export type ReadReason = 'risk'|'offline'|'timeout'|'not_found'|'login_required'|'ambiguous'|'runner_outdated'|'invalid'|'unsupported'|'empty';
export const READ_REASONS: readonly ReadReason[] = ['risk','offline','timeout','not_found','login_required','ambiguous','runner_outdated','invalid','unsupported','empty'];
export const FETCH_REASONS: readonly ReadReason[] = ['risk','timeout','not_found','login_required','unsupported','invalid'];
export const OFFLINE_MS = 120000;
export const FAILURE_PREFIX = 'failure:v1:bili:';
export const LINK_FAIL_RULE = '读不到的链接：按 reason_text 如实告诉群友是哪种情况，不要只说“读不了”，也不要提工具、接口或服务名。';
export function legacyReason(s: unknown): ReadReason {
  return s === '风控' ? 'risk' : s === '本机抓取端未回报' ? 'timeout' : 'invalid';
}
export function fetchFailure(b: any): { reason: ReadReason; retryAfter?: number } {
  const reason: ReadReason = FETCH_REASONS.includes(b.reason) ? b.reason : legacyReason(b.reason);
  const seconds = Number(b.retryAfter);
  return { reason, ...(reason === 'risk' ? {retryAfter: Number.isFinite(seconds) ? Math.max(60, Math.min(3600, seconds)) : 600} : {}) };
}
export function failureTtl(f: { reason: ReadReason; retryAfter?: number }): number {
  return f.reason === 'risk' ? (f.retryAfter ?? 600) * 1000 : ['not_found','unsupported'].includes(f.reason) ? 3600000 : 0;
}
export function jobReason(error: unknown): ReadReason {
  return READ_REASONS.includes(error as ReadReason) ? error as ReadReason : legacyReason(error);
}
export function biliFailReply(reason: ReadReason, o: { title: boolean }): string {
  const replies: Partial<Record<ReadReason,string>> = {
    risk: 'B 站这次拦住了读取，暂时读不到这个视频的内容，我先不总结，免得乱说。过一会儿再问我试试。',
    offline: 'B 站视频的读取端暂时离线，这次没拿到视频内容，我先不总结，免得乱说。等它恢复后再问我。',
    timeout: '这次读取 B 站视频超时了，没拿到内容，我先不总结。稍后再问我一次试试。',
    not_found: '这个 B 站视频打不开，可能已删除、还在审核或仅 UP 主自己可见，我读不到内容。',
    login_required: '这个 B 站视频要登录或有观看权限才能看，读取端这次没读到内容。',
    unsupported: '这个 B 站链接不是普通视频（可能是直播、专栏或动态），我目前只能读 B 站视频。',
    runner_outdated: '读取 B 站视频的程序需要更新，暂时读不了这个视频。',
  };
  return (replies[reason] ?? '这次读取 B 站视频出了点问题，没拿到内容，我先不总结。稍后再问我试试。') + (o.title ? '如果方便，在 B 站点“复制链接”发我，我读得更准。' : '');
}
export function biliFailMaterial(reason: ReadReason, o: { title: boolean; titleFallback: string }): string {
  if (o.title && reason === 'timeout') return o.titleFallback;
  const phrases: Partial<Record<ReadReason,string>> = {risk:'被 B 站风控拦截',offline:'读取端离线',timeout:'读取超时',not_found:'视频不存在或不可见',login_required:'需要登录或观看权限',unsupported:'不是普通视频链接'};
  return `【未读取视频内容】原因：${phrases[reason] ?? '读取出错'}。只能依据群聊里的卡片标题和文字作答，不要概括视频内容；被问到时照实说明原因，不提内部程序或服务名。`;
}
export function webFailText(reason: ReadReason): string {
  const phrases: Partial<Record<ReadReason,string>> = {
    risk:'网站拦截了自动读取',login_required:'需要登录、没有访问权限，或网站拒绝了自动读取',not_found:'页面不存在或已删除',
    empty:'页面打开了，但没有可读的正文（可能只有图片/视频，或要登录后才显示）',timeout:'读取超时',unsupported:'不是公开网页链接，不能读取',
  };
  return phrases[reason] ?? '读取出错';
}
