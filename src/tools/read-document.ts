// F7-7 read_document: group-scoped reader for documents members upload.
// The parsing itself lives in runner/docread.py (pdf/docx/xlsx/pptx/csv, path-jailed to inputs/).
// This tool only resolves the attachment for the current group, validates it, and returns either the
// runner's cached extraction (`media_notes` id `doc:<message>:<attachment>:<question-hash>`) or a
// structured pending/unavailable answer. It must never claim a document was read without evidence.
import type { BotTool } from "../toolkit";

export const DOC_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".xlsm", ".xls", ".pptx", ".csv", ".tsv"];
export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const MAX_QUESTION = 200;
const MAX_RESULT_TEXT = 24000;
const FAILED_RETRY_MS = 10 * 60 * 1000;
const MAX_FAILED_RETRIES = 3;

const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": ".xlsm",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
};
const MEDIA_TYPE = /^(image|video|audio)\//i;
const MEDIA_KIND = new Set(["image", "video", "voice", "audio"]);

export type DocAttachment = {
  /** position in the original attachments array; part of the cache key */
  index: number;
  url: string;
  filename: string;
  size?: number;
  contentType: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function extensionOf(name: unknown): string {
  const match = /(\.[A-Za-z0-9]{1,8})$/.exec(text(name).trim());
  return match ? match[1].toLowerCase() : "";
}

/** Plain document attachments from one message's metadata. Images, videos, voices stay out. */
export function documentAttachments(meta: any): DocAttachment[] {
  const list = Array.isArray(meta?.attachments)
    ? meta.attachments
    : Array.isArray(meta?.media)
      ? meta.media
      : [];
  const out: DocAttachment[] = [];
  list.forEach((item: any, index: number) => {
    if (!item || typeof item !== "object") return;
    const contentType = text(item.content_type || item.contentType).toLowerCase();
    if (MEDIA_TYPE.test(contentType) || MEDIA_KIND.has(text(item.kind).toLowerCase())) return;
    const url = text(item.url);
    if (!/^https?:\/\//i.test(url)) return;
    let filename = text(item.filename).trim();
    if (!filename) {
      try {
        filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      } catch {
        filename = "";
      }
    }
    const extension = extensionOf(filename) || MIME_EXTENSION[contentType] || "";
    if (!DOC_EXTENSIONS.includes(extension)) return;
    const size = Number(item.size);
    out.push({
      index,
      url,
      filename: filename || "document" + extension,
      contentType,
      ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
    });
  });
  return out;
}

/** Stable D1 key for one (document, question) extraction; a repeated question reuses the same row. */
export function documentNoteKey(messageId: string, index: number, question: string): string {
  const normalized = text(question).trim().replace(/\s+/g, " ").toLowerCase();
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) hash = ((hash * 33) ^ normalized.charCodeAt(i)) >>> 0;
  return `doc:${messageId}:${index}:${hash.toString(36)}`;
}

function fail(error_kind: string, next_action: string, extra: Record<string, any> = {}) {
  return { ok: false, error_kind, retryable: false, next_action, ...extra };
}

function switchedOn(value: unknown): boolean {
  const raw = text(value);
  return raw.length > 0 && raw !== "0" && raw !== "false";
}

/** The parser reports a missing text layer only through warnings; never turn that into a fake read. */
function noReadableText(value: any): boolean {
  const warnings = Array.isArray(value?.warnings) ? value.warnings.map(text) : [];
  return warnings.some((w: string) => w.includes("没有可提取的文字层") || w.includes("文档没有可读文字"));
}

function unreadable(kind: string, detail: unknown, extra: Record<string, any> = {}) {
  const why = kind === "missing_library" ? "本机解析库不全" : kind === "no_text" ? "没有文字层" : "本机文档读取失败";
  const help =
    kind === "no_text"
      ? "这可能是扫描件；当前不会自动 OCR，需要转成图片再识别，或让成员提供文字版。"
      : kind === "missing_library"
        ? "让维护者补上 runner 的文档解析依赖后再读；不要猜内容。"
        : "让成员稍后再问或重新发一次文件；不要猜内容。";
  return fail(kind || "unreadable", `${why}${text(detail) ? `：${text(detail)}` : ""}。${help}`, {
    ...(detail ? { detail: text(detail).slice(0, 300) } : {}),
    ...extra,
  });
}

export const readDocumentTool: BotTool = {
  name: "read_document",
  switch: "docread",
  untrusted: true,
  def: {
    type: "function",
    function: {
      name: "read_document",
      description:
        "读取本群成员发来的文档（PDF/DOCX/XLSX/PPTX/CSV），可就某个问题定位页码、sheet 和原文。只读不写；不要用它读网页或别的群的文件。",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "发文件的那条消息ID；默认本轮最新消息" },
          filename: { type: "string", description: "一条消息里有多个文件时，指定要读的文件名" },
          question: { type: "string", description: "要定位的问题，例如“第3页的金额”" },
        },
      },
    },
  },
  async run(e: any, input: any, ctx: any) {
    const args = input && typeof input === "object" ? input : {};
    const latest = ctx?.context?.latest || {};
    const source = ctx?.source || latest;
    const groupId = text(latest.group_id) || text(source.group_id);
    if (!groupId) return fail("unavailable", "没有群上下文，无法确定这份文件属于哪个群；不要猜内容。");
    const messageId = text(args.message_id) || text(source.id) || text(latest.id);
    if (!messageId) return fail("invalid_args", "需要 message_id：告诉成员重新发一次文件，或指明是哪条消息。");

    const row = await e.DB.prepare(
      "SELECT m.id,m.group_id,m.sender,m.body,m.ts,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.id=? AND m.group_id=?",
    ).bind(messageId, groupId).first();
    if (!row) return fail("not_found", "这条消息不在本群或已经过期；让成员重新发一次文件再问。", { message_id: messageId });

    let meta: any = {};
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      meta = {};
    }
    const files = documentAttachments(meta);
    if (!files.length) {
      return fail("no_document", "这条消息里没有可读的文档；让成员直接上传 PDF、DOCX、XLSX、PPTX 或 CSV 再问一次。", { message_id: messageId });
    }
    const wanted = text(args.filename).trim();
    const chosen =
      (wanted && files.find((item) => item.filename === wanted || item.filename.endsWith(wanted))) || files[0];
    if (chosen.size !== undefined && chosen.size > MAX_DOC_BYTES) {
      return fail("too_large", "文件超过 20 MiB，读取端不收；让成员压缩或拆分后再发。", {
        filename: chosen.filename,
        bytes: chosen.size,
      });
    }

    const question = text(args.question).trim().slice(0, MAX_QUESTION);
    const key = documentNoteKey(messageId, chosen.index, question);
    const jobId = `docread-${messageId}-${chosen.index}-${key.split(":").pop()}`;
    const note = await e.DB.prepare("SELECT body,created_at FROM media_notes WHERE id=?").bind(key).first();
    if (note) {
      let value: any;
      try {
        value = JSON.parse(note.body);
      } catch {
        return fail("corrupt", "本机交回的解析结果损坏，不能当作文档内容；让成员稍后重试或重新发文件。", { filename: chosen.filename });
      }
      if (!value || typeof value !== "object") {
        return fail("corrupt", "本机交回的解析结果不完整，不能当作文档内容；不要猜。", { filename: chosen.filename });
      }
      if (value.ok === false) {
        const extra: Record<string, any> = { filename: chosen.filename, job_id: jobId };
        if (value.retryable === true) extra.retryable = true;
        return unreadable(text(value.error_kind) || "unreadable", value.error, extra);
      }
      if (typeof value.text !== "string") {
        return fail("corrupt", "本机交回的解析结果不完整，不能当作文档内容；不要猜。", { filename: chosen.filename });
      }
      if (noReadableText(value)) {
        return unreadable("no_text", "", { filename: chosen.filename, job_id: jobId });
      }
      return {
        ok: true,
        source: "docread",
        message_id: messageId,
        filename: chosen.filename,
        kind: text(value.kind) || extensionOf(chosen.filename).slice(1),
        cached_at: text(note.created_at),
        pages: Array.isArray(value.pages) ? value.pages : [],
        sheets: Array.isArray(value.sheets) ? value.sheets : [],
        meta: value.meta && typeof value.meta === "object" ? value.meta : {},
        warnings: Array.isArray(value.warnings) ? value.warnings : [],
        hits: Array.isArray(value.hits) ? value.hits : [],
        truncated: value.truncated === true,
        text: value.text.slice(0, MAX_RESULT_TEXT),
      };
    }

    const toggle = await e.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind("docread:enabled")
      .first();
    if (!switchedOn(toggle?.value)) {
      return fail("unavailable", "本机文档读取端没有开启；先不要声称读过这份文件。让成员按普通文件任务处理，或等读取端接好后再问。", {
        message_id: messageId,
        filename: chosen.filename,
      });
    }
    // Failed reads are retried after a cooldown, never cached as terminal content.
    const previous = await e.DB.prepare("SELECT status,error,payload FROM jobs WHERE id=?").bind(jobId).first();
    if (previous?.status === "done") {
      // The job says done but its extraction is gone; run it once more instead of pending forever.
      await e.DB.prepare("UPDATE jobs SET status='pending',attempts=0,lease_until=0,error=NULL WHERE id=? AND status='done'")
        .bind(jobId)
        .run();
    } else if (previous?.status === "failed") {
      let saved: any = {};
      try {
        saved = JSON.parse(previous.payload || "{}");
      } catch {
        saved = {};
      }
      const failedAt = Number(saved?.failed_at) || 0;
      const retries = Number(saved?.retries) || 0;
      const kind = text(previous.error) || "unreadable";
      const detail = text(saved?.failure_detail);
      if (retries >= MAX_FAILED_RETRIES) {
        return fail(kind, `本机读取已重试 ${retries} 次仍未成功${detail ? `：${detail}` : ""}；不要猜内容，让成员重新发一次文件。`, {
          filename: chosen.filename,
          job_id: jobId,
          retryable: false,
        });
      }
      const retryIn = failedAt ? failedAt + FAILED_RETRY_MS - Date.now() : 0;
      if (retryIn > 0) {
        const minutes = Math.max(1, Math.ceil(retryIn / 60000));
        return fail(kind, `上次读取失败${detail ? `：${detail}` : ""}。为避免反复解析，至少 ${minutes} 分钟后再用同一问法重试；不要猜内容。`, {
          filename: chosen.filename,
          job_id: jobId,
          retryable: true,
          retry_after_ms: retryIn,
        });
      }
      await e.DB.prepare("UPDATE jobs SET status='pending',attempts=0,lease_until=0,error=NULL,payload=json_set(json_remove(payload,'$.failed_at','$.failure_detail'),'$.retries',?) WHERE id=? AND status='failed'")
        .bind(retries + 1, jobId)
        .run();
    }
    const payload = {
      message_id: messageId,
      group_id: groupId,
      filename: chosen.filename,
      question,
      key,
      url: chosen.url,
      ...(chosen.size !== undefined ? { bytes: chosen.size } : {}),
      created_at: new Date().toISOString(),
    };
    await e.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id,kind,payload,status,attempts,lease_until,error,created_at) VALUES(?,?,?,'pending',0,0,NULL,?)",
    ).bind(jobId, "docread", JSON.stringify(payload), Date.now()).run();
    return {
      ok: false,
      error_kind: "pending",
      retryable: true,
      job_id: jobId,
      message_id: messageId,
      filename: chosen.filename,
      next_action: "读取已经排队；先告诉成员正在读取，约 1 分钟后用同一个 message_id 和 question 再调用一次，不要猜内容。",
    };
  },
};
