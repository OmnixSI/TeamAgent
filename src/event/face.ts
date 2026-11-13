import type { Segment } from "./types";

// Reuse the existing view parser and labels; there is no second face-ID table.
// ext may contain raw JSON or escaped JSON; a > inside its text is not a tag end.
export const FACE = /\[<face,id=\d+\/>\]|<faceType=(?:ext="\{(?:[^{}"]|"(?:\\.|[^"\\])*")*\}"|"(?:\\.|[^"\\])*"|[^">])*>/g;
export function withoutFaces(body: string): string {
  return body.replace(FACE, "");
}
export function hasFace(body: string): boolean {
  return withoutFaces(body) !== body;
}
export function faceName(tag: string): string {
  // QQ supplies URI-encoded JSON or a JSON string escaped inside ext="…".
  const match = tag.match(/\bext="(.*)"\s*>$/);
  if (!match) return "[表情（名称未知）]";
  try {
    let raw = match[1].startsWith("{") ? match[1] : decodeURIComponent(match[1]);
    if (raw.startsWith("{\\\"")) raw = JSON.parse('"' + raw + '"');
    const text = JSON.parse(raw)?.text;
    const name = typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
    return name ? "[表情：" + name + "]" : "[表情（名称未知）]";
  } catch { return "[表情（名称未知）]"; }
}

export function parseFace(tag: string): Extract<Segment, { type: "face" }> {
  const label = faceName(tag);
  return { type:"face", id:tag.match(/(?:faceId|id)=(\d+)/)?.[1] || "", kind:"face",
    ...(label.startsWith("[表情：") ? {name:label.slice(4,-1)} : {}) };
}
