// A feature is one self-contained ability in its own file under src/feat/. It gets the Hub directly and
// plugs in through the hooks below, so features can be written and tested without touching shared files.
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import type { Host } from "../tools.ts";
import type { Asker } from "../selfedit.ts";
import type { Tunable } from "../config.ts";

/** One conversation's view: `host` is what the built-in tools use (sending, files, quotas, settings). */
export type Ctx = { hub: Hub; conv: string; askers: Asker[]; host: Host };

export type Feature = {
  name: string;
  /** Tools this feature adds for a conversation. */
  tools?(ctx: Ctx): Tool[];
  /** Runs on the Hub's 20-second clock. Keep your own "once a day" marks with hub.get/set; put long work in hub.ctx.waitUntil. */
  tick?(hub: Hub, now: number): void | Promise<void>;
  /** Admin routes (the admin token is already checked). Return null when the path is not yours. */
  admin?(hub: Hub, req: Request, url: URL, body: any): Promise<Response | null> | Response | null;
  /** Routes anyone can reach, under /p/ or /x/ only. Return null when the path is not yours. */
  open?(hub: Hub, req: Request, url: URL): Promise<Response | null> | Response | null;
  /** SQL run once at start (CREATE TABLE IF NOT EXISTS …). */
  schema?: string;
  /** Bounded settings the group may change with self_update. */
  tunables?: Record<string, Tunable>;
  /** What the bot should know about this ability when asked how it works: plain Chinese, one fact per line. */
  about?: string[];
};
