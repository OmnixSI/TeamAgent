// Placeholder until this feature is written. The exported functions are the contract other features and
// the skill runner code against: files too big for a chat message or for the 25 MB path into and out of
// the cloud computer live in "the box" (R2) and are referred to as "x12".
import type { Hub } from "../hub.ts";
import type { Feature } from "./types.ts";

export type BoxFile = { ref: string; name: string; size: number; mime: string; ts: number; expires: number; by: string };
/** A box file this conversation may use, or null. */
export function boxFile(_hub: Hub, _conv: string, _ref: string): BoxFile | null { return null; }
/** A bash command that downloads a box file to `dest` inside the cloud computer through a short-lived link. */
export function boxDownloadCommand(_hub: Hub, _conv: string, _ref: string, _dest: string): string | null { return null; }
/** A bash command that uploads `path` from the cloud computer into the box; call `claim()` after it ran to register the file and get its reference and a download link people can open. */
export function boxUpload(_hub: Hub, _conv: string, _path: string, _name: string, _days = 7): { command: string; claim(): Promise<{ ref: string; name: string; size: number; link: string } | null> } {
  return { command: "false", claim: async () => null };
}
/** A link people can open in a browser to download a box file, valid for `hours`. */
export function boxLink(_hub: Hub, _conv: string, _ref: string, _hours = 72): string | null { return null; }
/** Puts bytes the Worker already holds into the box (a result too big for a chat message). */
export async function boxPut(_hub: Hub, _conv: string, _name: string, _bytes: Uint8Array, _days = 7): Promise<{ ref: string; link: string } | null> { return null; }

const feature: Feature = { name: "filebox" };
export default feature;
