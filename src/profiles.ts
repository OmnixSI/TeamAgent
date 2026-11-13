// F7-5 group-scoped member profiles (画像). This module is the only writer: the nightly job distils
// stable address/preferences/topics from real messages, keeps a source message id on every entry and
// refuses sensitive text. Read/forget tools live in src/tools/profile.ts; nothing writes from a chat turn.
import { listMessages, type HistoryRow } from "./history";
import { TEAM } from "./config";
import { model as callModel } from "./runtime";
import type { CronJob } from "./cron-extra";

export const PROFILE_CATEGORIES = ["address", "preferences", "topics"] as const;
export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];
export interface ProfileEntry {
  text: string;
  source_ids: string[];
  updated_at: number;
}
export type Profile = Record<ProfileCategory, ProfileEntry[]>;
export interface ProfileDraftEntry {
  text?: string;
  quote?: string;
  source_ids?: string[];
}
export type ProfileDraft = Partial<Record<ProfileCategory, ProfileDraftEntry[]>>;
export interface ProfileExtractorInput {
  groupId: string;
  userId: string;
  name: string;
  messages: { id: string; ts: string; body: string }[];
  existing: Profile | null;
}
export type ProfileExtractor = (input: ProfileExtractorInput) => Promise<ProfileDraft | string>;

const MAX_TEXT = 120;
const LIMITS: Record<ProfileCategory, number> = { address: 5, preferences: 16, topics: 12 };
const MAX_SOURCE_IDS = 8;
const DEFAULT_MAX_USERS = 12;
const DEFAULT_MAX_PER_RUN = 2;
const DEFAULT_MIN_MESSAGES = 2;
const DEFAULT_MESSAGES_PER_USER = 60;

const SENSITIVE_RULES: RegExp[] = [
  /\d{17}[\dXx]/,
  /(身份证|证件号码?|护照号)/,
  /(^|[^\d])1[3-9]\d{9}([^\d]|$)/,
  /(手机号|手机号码|电话号码|联系方式)\s*[:：]?\s*\d{5,}/,
  /(^|[^\d])\d{16,19}([^\d]|$)/,
  /(银行卡|卡号|账号|账户)\s*[:：]?\s*\d{6,}/,
  /(密码|口令|验证码|动态码|password|passwd|pwd|otp)/i,
  /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/,
  /(家庭住址|家庭地址|住址|收货地址|收件地址|详细地址|门牌号?|住在|家住)/,
  /(微信号?|wechat|QQ\s*号?)\s*[:：]?\s*[A-Za-z0-9_-]{4,}/i,
  /[\w.+-]+@[\w-]+\.[\w.-]{2,}/,
];

export const PROFILE_OFF_PREFIX = "profile_off:";
export const PROFILE_ADMIN_PREFIX = "profile_admin:";
export function profileOffKey(groupId: string, userId: string): string {
  return PROFILE_OFF_PREFIX + groupId + ":" + userId;
}

export function emptyProfile(): Profile {
  return { address: [], preferences: [], topics: [] };
}

function text(value: any): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function stringList(value: any, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))].slice(0, max);
}
export function parseProfile(summary: string): Profile {
  let raw: any = {};
  try { raw = JSON.parse(summary); } catch { raw = {}; }
  const out = emptyProfile();
  for (const category of PROFILE_CATEGORIES) {
    out[category] = (Array.isArray(raw?.[category]) ? raw[category] : [])
      .filter((entry: any) => entry && text(entry.text))
      .map((entry: any) => ({
        text: text(entry.text).slice(0, MAX_TEXT),
        source_ids: stringList(entry.source_ids, MAX_SOURCE_IDS),
        updated_at: Number(entry.updated_at) || 0,
      }))
      .filter((entry: ProfileEntry) => entry.text)
      .slice(0, LIMITS[category]);
  }
  return out;
}

export function isSensitiveProfileText(value: string): boolean {
  const body = text(value);
  return !body || SENSITIVE_RULES.some((rule) => rule.test(body));
}

function sourceIdsOf(entry: ProfileDraftEntry, messages: HistoryRow[]): string[] {
  const known = new Set(messages.map((m) => String(m.id)));
  let ids = stringList(entry.source_ids, MAX_SOURCE_IDS).filter((id) => known.has(id));
  if (!ids.length && entry.quote) {
    const quote = text(entry.quote).slice(0, 40);
    if (quote.length >= 2)
      ids = messages.filter((m) => text(m.body).includes(quote)).map((m) => String(m.id)).slice(0, MAX_SOURCE_IDS);
  }
  return [...new Set(ids)].slice(0, MAX_SOURCE_IDS);
}

function isVerbatimCopy(value: string, messages: HistoryRow[]): boolean {
  const body = text(value);
  return messages.some((m) => {
    const original = text(m.body);
    if (original.length >= 30 && original === body) return true;
    return original.length >= 60 && body.length >= 30 && original.includes(body);
  });
}

export function sanitizeProfileDraft(
  draft: ProfileDraft | string,
  messages: HistoryRow[],
  now: number,
): { profile: Profile; sensitive: number; invalid: number } {
  let raw: any = draft;
  if (typeof raw === "string") {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    try { raw = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw); } catch { raw = {}; }
  }
  const profile = emptyProfile();
  let sensitive = 0, invalid = 0;
  for (const category of PROFILE_CATEGORIES) {
    const entries = Array.isArray(raw?.[category]) ? raw[category] : [];
    for (const entry of entries.slice(0, LIMITS[category] * 3)) {
      const value = text(entry?.text).slice(0, MAX_TEXT);
      if (!value) { invalid++; continue; }
      if (isSensitiveProfileText(value)) { sensitive++; continue; }
      if (isVerbatimCopy(value, messages)) { invalid++; continue; }
      const ids = sourceIdsOf(entry, messages);
      if (!ids.length) { invalid++; continue; }
      profile[category].push({ text: value, source_ids: ids, updated_at: now });
      if (profile[category].length >= LIMITS[category]) break;
    }
  }
  return { profile, sensitive, invalid };
}

export function mergeProfile(existing: Profile | null, incoming: Profile, now: number): Profile {
  const out = emptyProfile();
  for (const category of PROFILE_CATEGORIES) {
    const merged = new Map<string, ProfileEntry>();
    for (const entry of [...(existing?.[category] || []), ...incoming[category]]) {
      const key = entry.text.toLocaleLowerCase().replace(/\s+/g, "");
      const previous = merged.get(key);
      if (previous) {
        previous.source_ids = [...new Set([...previous.source_ids, ...entry.source_ids])].slice(0, MAX_SOURCE_IDS);
        previous.updated_at = Math.max(previous.updated_at, entry.updated_at || now);
      } else {
        merged.set(key, { text: entry.text, source_ids: [...entry.source_ids], updated_at: entry.updated_at || now });
      }
    }
    out[category] = [...merged.values()].slice(0, LIMITS[category]);
  }
  return out;
}

async function getSetting(e: any, key: string): Promise<string | undefined> {
  const row = await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return row ? String(row.value) : undefined;
}
async function putSetting(e: any, key: string, value: string): Promise<void> {
  await e.DB
    .prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, value)
    .run();
}
function truthy(value: string | undefined): boolean {
  return !!value && !["0", "false", "off", ""].includes(String(value).toLowerCase());
}
function changesOf(result: any): number {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export async function readProfileRow(e: any, groupId: string, userId: string): Promise<any | null> {
  return await e.DB
    .prepare("SELECT summary,updated_at,source_ids FROM profiles WHERE group_id=? AND user_id=?")
    .bind(groupId, userId)
    .first();
}
export async function readProfile(e: any, groupId: string, userId: string): Promise<Profile | null> {
  const row = await readProfileRow(e, groupId, userId);
  return row ? parseProfile(String(row.summary)) : null;
}

async function upsertProfile(e: any, groupId: string, userId: string, profile: Profile): Promise<void> {
  const sourceIds = [...new Set(PROFILE_CATEGORIES.flatMap((category) => profile[category].flatMap((entry) => entry.source_ids)))].slice(0, 200);
  const updatedAt = Math.max(0, ...PROFILE_CATEGORIES.flatMap((category) => profile[category].map((entry) => entry.updated_at)));
  await e.DB
    .prepare(
      "INSERT INTO profiles(group_id,user_id,summary,updated_at,source_ids) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(group_id,user_id) DO UPDATE SET summary=excluded.summary,updated_at=excluded.updated_at,source_ids=excluded.source_ids",
    )
    .bind(groupId, userId, JSON.stringify(profile), updatedAt, JSON.stringify(sourceIds))
    .run();
}

export async function isProfileOff(e: any, groupId: string, userId: string): Promise<boolean> {
  return truthy(await getSetting(e, profileOffKey(groupId, userId)));
}
/** `/profile off` wiring point: true writes the opt-out, false clears it. */
export async function setProfileOff(e: any, groupId: string, userId: string, off: boolean): Promise<void> {
  if (off) await putSetting(e, profileOffKey(groupId, userId), "1");
  else await e.DB.prepare("DELETE FROM settings WHERE key=?").bind(profileOffKey(groupId, userId)).run();
}

export async function isProfileAdmin(e: any, groupId: string, userId: string): Promise<boolean> {
  const value = await getSetting(e, PROFILE_ADMIN_PREFIX + groupId);
  return String(value || "").split(/[\s,]+/).filter(Boolean).includes(userId);
}

export interface ForgetProfileInput {
  groupId: string;
  userId: string;
  actorId: string;
  admin?: boolean;
}
/** Self-service delete. The actor's own forget also opts them out so the next night cannot rebuild it. */
export async function forgetProfile(e: any, input: ForgetProfileInput): Promise<{ ok: boolean; deleted: boolean; error_kind?: string }> {
  if (!input.groupId || !input.userId || !input.actorId) return { ok: false, deleted: false, error_kind: "invalid_args" };
  const allowed = input.admin === true || input.actorId === input.userId || (await isProfileAdmin(e, input.groupId, input.actorId));
  if (!allowed) return { ok: false, deleted: false, error_kind: "denied" };
  const result = await e.DB
    .prepare("DELETE FROM profiles WHERE group_id=? AND user_id=?")
    .bind(input.groupId, input.userId)
    .run();
  if (input.actorId === input.userId) await setProfileOff(e, input.groupId, input.userId, true);
  return { ok: true, deleted: changesOf(result) > 0 };
}

function localParts(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function nameOf(e: any, userId: string): Promise<string> {
  const row = await e.DB.prepare("SELECT name FROM member_names WHERE member_id=?").bind(userId).first();
  const raw = String(row?.name || "");
  if (!raw) return "";
  try { return text(JSON.parse(raw)); } catch { return text(raw); }
}

const EXTRACT_PROMPT = `你是群聊画像整理器。把成员近期的发言提炼成稳定、可复用的画像，不是摘抄。
只输出一个 JSON 对象，结构固定：
{"address":[{"text":"称呼/身份","source_ids":["消息id"],"quote":"可选的原话片段"}],
 "preferences":[{"text":"稳定偏好","source_ids":["消息id"],"quote":"可选"}],
 "topics":[{"text":"擅长或常聊的话题","source_ids":["消息id"],"quote":"可选"}]}
规则：
- 只写长期稳定的称呼、偏好、擅长话题；一次性情绪、当天琐事、猜测和模型自己的评价都不要写。
- 每条必须能追溯到给定消息 id；可以把引用的原话放进 quote，由程序校验；不能确定来源就不要写。
- 文本要提炼成短语，不要整句复制成员原话；每条不超过 60 字。
- 不写身份证、住址、手机号、邮箱、账号、密码、验证码、密钥等敏感信息；看到也不要记录。
- 没有足够证据时返回空数组。不要输出 JSON 以外的文字。`;

function defaultExtractor(e: any): ProfileExtractor {
  return async (input) => {
    const response = await callModel(
      e,
      "memory",
      "max",
      {
        messages: [
          { role: "system", content: EXTRACT_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              name: input.name,
              existing: input.existing,
              messages: input.messages,
            }),
          },
        ],
        response_format: { type: "json_object" },
      },
      120000,
    );
    const content = String(response?.choices?.[0]?.message?.content || "");
    const start = content.indexOf("{"), end = content.lastIndexOf("}");
    return JSON.parse(start >= 0 && end > start ? content.slice(start, end + 1) : content);
  };
}

export interface ProfilesNightOptions {
  now?: Date;
  timeZone?: string;
  startHour?: number;
  endHour?: number;
  groupIds?: string[];
  extract?: ProfileExtractor;
  maxUsersPerNight?: number;
  maxUsersPerRun?: number;
  minMessages?: number;
  messagesPerUser?: number;
  lookbackHours?: number;
}
export interface ProfilesNightResult {
  ran: boolean;
  reason?: string;
  groups: number;
  candidates: number;
  processed: number;
  updated: number;
  sensitive: number;
  invalid: number;
  failed: number;
  skipped: number;
}

function parseDone(value: string | undefined): Set<string> {
  try {
    const list = JSON.parse(String(value || "[]"));
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}
function latestTs(messages: HistoryRow[]): number {
  return Math.max(0, ...messages.map((m) => Date.parse(m.ts) || 0));
}
function profileUpdatedAt(profile: Profile): number {
  return Math.max(0, ...PROFILE_CATEGORIES.flatMap((category) => profile[category].map((entry) => entry.updated_at)));
}

/**
 * Nightly distill+merge. Disabled by default: settings `profiles_enabled` must be truthy.
 * Budget is per local night; processed members are recorded so a re-run does not spend model calls again.
 */
export async function runProfilesNightly(e: any, options: ProfilesNightOptions = {}): Promise<ProfilesNightResult> {
  const result: ProfilesNightResult = {
    ran: false, groups: 0, candidates: 0, processed: 0, updated: 0, sensitive: 0, invalid: 0, failed: 0, skipped: 0,
  };
  if (truthy(await getSetting(e, "off:profiles"))) return { ...result, reason: "switched_off" };
  if (!truthy(await getSetting(e, "profiles_enabled"))) return { ...result, reason: "disabled" };

  const now = options.now || new Date();
  const timeZone = options.timeZone || TEAM.memory.timezone;
  const startHour = options.startHour ?? TEAM.memory.start_hour;
  const endHour = options.endHour ?? TEAM.memory.end_hour;
  const local = localParts(now, timeZone);
  if (!(local.hour >= startHour && local.hour < endHour)) return { ...result, reason: "outside_window" };

  const groups = options.groupIds?.length
    ? [...new Set(options.groupIds.map(String).filter(Boolean))]
    : [await getSetting(e, "group_id")].filter(Boolean) as string[];
  result.ran = true;
  result.groups = groups.length;
  if (!groups.length) return { ...result, reason: "no_group" };

  const budget = Math.max(0, options.maxUsersPerNight ?? DEFAULT_MAX_USERS);
  const perRun = Math.max(1, options.maxUsersPerRun ?? DEFAULT_MAX_PER_RUN);
  const minMessages = Math.max(1, options.minMessages ?? DEFAULT_MIN_MESSAGES);
  const perUser = Math.max(1, options.messagesPerUser ?? DEFAULT_MESSAGES_PER_USER);
  const lookbackHours = Math.max(1, options.lookbackHours ?? 24);
  const afterTs = new Date(now.getTime() - lookbackHours * 3600000).toISOString();
  const beforeTs = now.toISOString();
  const doneKey = "profiles_night:" + local.date;
  const done = parseDone(await getSetting(e, doneKey));
  let used = done.size;
  let runProcessed = 0;
  const extract = options.extract || defaultExtractor(e);

  for (const groupId of groups) {
    const recent = await listMessages(e, { groupId, afterTs, beforeTs, newestFirst: true, limit: 200, clip: 400 });
    const counts = new Map<string, number>();
    for (const message of recent) counts.set(String(message.sender), (counts.get(String(message.sender)) || 0) + 1);
    const candidates = [...counts.entries()].filter(([, count]) => count >= minMessages).sort((a, b) => b[1] - a[1]);
    result.candidates += candidates.length;
    for (const [userId] of candidates) {
      if (used >= budget || runProcessed >= perRun) break;
      const key = groupId + ":" + userId;
      if (done.has(key)) { result.skipped++; continue; }
      if (await isProfileOff(e, groupId, userId)) {
        done.add(key); used++; runProcessed++;
        result.skipped++; await putSetting(e, doneKey, JSON.stringify([...done]));
        continue;
      }
      const messages = await listMessages(e, {
        groupId, sender: userId, afterTs, beforeTs, newestFirst: false, limit: perUser, clip: 400,
      });
      if (!messages.length) {
        done.add(key); used++; runProcessed++;
        result.skipped++; await putSetting(e, doneKey, JSON.stringify([...done]));
        continue;
      }
      // Claim before the model call: overlapping cron ticks must not distill (and bill) the same member twice.
      done.add(key); used++; runProcessed++;
      result.processed++;
      await putSetting(e, doneKey, JSON.stringify([...done]));
      const existing = await readProfile(e, groupId, userId);
      if (existing && latestTs(messages) <= profileUpdatedAt(existing)) {
        result.skipped++;
        continue;
      }
      let draft: ProfileDraft | string;
      try {
        draft = await extract({
          groupId,
          userId,
          name: await nameOf(e, userId),
          messages: messages.map((message) => ({ id: String(message.id), ts: String(message.ts), body: String(message.body) })),
          existing,
        });
      } catch {
        result.failed++;
        continue;
      }
      const clean = sanitizeProfileDraft(draft, messages, now.getTime());
      result.sensitive += clean.sensitive;
      result.invalid += clean.invalid;
      const hasEntries = PROFILE_CATEGORIES.some((category) => clean.profile[category].length > 0);
      if (hasEntries) {
        await upsertProfile(e, groupId, userId, mergeProfile(existing, clean.profile, now.getTime()));
        result.updated++;
      } else {
        result.skipped++;
      }
    }
  }
  return result;
}

export const profilesNightJob: CronJob = {
  name: "profiles",
  async run(e: any, now: Date): Promise<void> {
    await runProfilesNightly(e, { now });
  },
};
