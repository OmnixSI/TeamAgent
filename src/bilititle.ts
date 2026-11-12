import type {Card} from './inbound';
import {biliNoteText, type BiliResult} from './fetchjobs';
import {untrusted} from './untrusted';

export const BILI_CARD_NOTE = '【仅卡片（标题+预览）】QQ 只提供了这张 B站卡片的标题和预览图，没有视频链接；未读取视频内容。只能依据卡片标题讨论。请在 B 站点“复制链接”发来。';
export const TITLE_FALLBACK = '【仅卡片（标题+预览）】按标题检索暂时没完成（本机抓取端可能离线）；QQ 卡片只给了标题和预览图，未读取视频内容，只能依据卡片标题作答。请在 B 站点“复制链接”发来。';
export const normTitle = (s: string) => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export const cleanCardTitle = (s: string) => [...s.replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0,100).join('');
export const isBiliCard = (card: Card, prompt: unknown) => /哔哩哔哩|bilibili|b站/i.test([card.source,card.name,typeof prompt === 'string' ? prompt : ''].join(' '));
export function fnv64(s: string): string {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(s)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return hash.toString(16).padStart(16,'0');
}
export function titleRef(title: string): string | null {
  const normalized = normTitle(title);
  return /[\p{L}\p{N}\p{S}]/u.test(normalized) ? 't-' + fnv64(normalized) : null;
}
export const isTitleRef = (ref: string) => /^t-[0-9a-f]{16}$/.test(ref);
export type TitleMiss = {miss:'none'|'near'|'multiple';fetched_at:string};
export function titleMissOf(value: any): TitleMiss | null {
  if (!value || !['none','near','multiple'].includes(value.miss)) return null;
  return {miss:value.miss,fetched_at:Number.isFinite(Date.parse(value.fetched_at)) ? new Date(value.fetched_at).toISOString() : new Date().toISOString()};
}
export function titleMaterial(r: BiliResult) {
  return untrusted('bilibili', `【按标题检索匹配，非链接直达】QQ 卡片没有视频链接，下面是按卡片标题在 B站搜到的唯一同名视频：UP 主 ${r.owner}，${r.bvid}。回答时必须先说明这是按标题搜到的同名视频、可能不是卡片里的原视频，并写出 UP 主和 BV 号。\n${biliNoteText(r)}`, r.fetched_at);
}
export function titleMissMaterial(miss: TitleMiss) {
  const detail = miss.miss === 'multiple' ? '找到多个同名视频，无法确定是哪一个。' : '按标题在 B站没找到完全同名的视频。';
  return untrusted('bilibili', `【仅卡片（标题+预览）】QQ 卡片只给了标题和预览图，没有视频链接；${detail}未读取视频内容。只能依据卡片标题作答，不要编造视频内容。请在 B 站点“复制链接”发来。`, miss.fetched_at);
}
