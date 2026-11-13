// Leaf module: no imports of worker/semantic/lanes, so src/view.ts (and the review Worker) can use it.
import type { BiliResult } from './fetchjobs';
export type BiliMaterialOptions = {asr?:boolean; asrOmitted?:boolean};
export function biliNoteText(r: BiliResult, opts: BiliMaterialOptions = {}): string {
  const hasSubtitle = r.subtitle_status === 'ok' && !!r.subtitle?.trim();
  // Keep answerable facts before long descriptions/subtitles so bounded material
  // never loses the video's identity or the first available viewer comment.
  return [`BV号：${r.bvid}`, `标题：${r.title}`, `UP主：${r.owner}`, `时长：${r.duration}秒`,
    `热评：${r.comments.map(c => c.uname + "：" + c.message).join("\n") || "热评未读到"}`,
    hasSubtitle ? '【已取得字幕】' : '【已读元数据/热评】',
    `分区：${r.tname}`, `简介：${r.desc}`,
    hasSubtitle
      ? `字幕（${r.subtitle_lang || "未知语言"}）：${r.subtitle}`
      : [r.subtitle_status === "login_required" ? "未拿到 CC 字幕（需登录）。"
          : r.subtitle_status === "unavailable" ? "未拿到 CC 字幕（字幕接口未完成）。" : "无 CC 字幕。",
        opts.asr ? "没拿到字幕；已用本机语音转写读取音轨，转写见【bilibili-asr】素材。未查看画面。" : opts.asrOmitted ? "没拿到字幕；本轮只附一份转写，此视频仅附标题、简介和热评。未查看画面。" : "没拿到字幕，以下基于标题与评论。未查看画面或听取音轨。"].join("")].join("\n").slice(0, 6000);
}
