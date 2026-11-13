// Review-local pure redaction; mirrors src/runtime.ts:4–17, with the v2 >=10-char key rule.
export function redact(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[密钥已隐藏]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[凭据已隐藏]')
    .replace(/((?:API[_ -]?KEY|Authorization|密码|验证码|access_token|clientSecret)\s*[=:：]\s*)["']?[^\s,"'\n}]+/gi, '$1[已隐藏]');
}
export function redacted<T>(value: T): T { return JSON.parse(redact(JSON.stringify(value))); }
