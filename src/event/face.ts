import type { Segment } from "./types";

// Reuse the existing view parser and labels; there is no second face-ID table.
// ext may contain raw JSON, escaped JSON, URL-encoded JSON or base64 JSON; a > inside its text is not a tag end.
export const FACE = /\[<face,id=\d+\/>\]|<faceType=(?:ext="\{(?:[^{}"]|"(?:\\.|[^"\\])*")*\}"|"(?:\\.|[^"\\])*"|[^">])*>/g;
export function withoutFaces(body: string): string {
  return body.replace(FACE, "");
}
export function hasFace(body: string): boolean {
  return withoutFaces(body) !== body;
}

type FaceExt = { raw: string; text?: string; unparsed: boolean };

// QQ supplies URI-encoded JSON, JSON escaped inside ext="…", or base64-encoded JSON.
// A value that is none of them is kept verbatim and flagged; parsing never throws.
function faceExt(tag: string): FaceExt | undefined {
  const match = tag.match(/\bext="(.*)"\s*>$/);
  if (!match) return undefined;
  const raw = match[1];
  const readText = (value: string): string | undefined => {
    try {
      const text = JSON.parse(value)?.text;
      return typeof text === "string" ? text : undefined;
    } catch { return undefined; }
  };
  let candidate = raw;
  if (!candidate.startsWith("{")) { try { candidate = decodeURIComponent(candidate); } catch { /* keep raw */ } }
  let text = readText(candidate);
  if (text === undefined && candidate.startsWith("{\\\"")) {
    try { text = readText(JSON.parse('"' + candidate + '"')); } catch { /* keep raw */ }
  }
  if (text === undefined) {
    try {
      const bytes = Uint8Array.from(atob(candidate), char => char.charCodeAt(0));
      text = readText(new TextDecoder().decode(bytes));
    } catch { /* keep raw */ }
  }
  return text === undefined ? { raw, unparsed: true } : { raw, text, unparsed: false };
}

export function faceName(tag: string): string {
  const ext = faceExt(tag);
  if (!ext || ext.text === undefined) return "[表情（名称未知）]";
  const name = ext.text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return name ? "[表情：" + name + "]" : "[表情（名称未知）]";
}

export function parseFace(tag: string): Extract<Segment, { type: "face" }> {
  const ext = faceExt(tag);
  const name = ext?.text?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return { type:"face", id:tag.match(/(?:faceId|id)="?(\d+)"?/)?.[1] || "", kind:"face",
    ...(name ? {name} : {}),
    ...(ext?.unparsed ? {ext:ext.raw, face_unparsed:true as const} : {}) };
}
