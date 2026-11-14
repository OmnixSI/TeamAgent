// Pictures and files. Small ones sit in the Hub's own SQLite; anything bigger than a row can hold goes
// to R2. Pictures people post are copied here as they arrive, because the links QQ gives expire.
import type { Hub } from "./hub.ts";
import type { Ref } from "./draw.ts";
import { R2_STORAGE_STOP } from "./budget.ts";

const INLINE_MAX = 1_500_000;            // a SQLite value tops out at 2 MB
const ITEM_MAX = 40 * 1024 * 1024;
const DAY = 86400000;

/** How a picture was made, kept with it so it can be explained, debugged and revised faithfully. */
export type Made = { request?: string; idea?: string; prompt?: string; size?: string; quality?: string; refs?: string[]; ms?: Record<string, number> };

export class Store {
  private puts = 0;
  private hub: Hub;
  constructor(hub: Hub) {
    this.hub = hub;
    for (const ddl of [
      "ALTER TABLE img ADD COLUMN r2 TEXT", "ALTER TABLE img ADD COLUMN size INTEGER", "ALTER TABLE img ADD COLUMN src TEXT", "ALTER TABLE img ADD COLUMN made TEXT",
      "ALTER TABLE blob ADD COLUMN r2 TEXT", "ALTER TABLE blob ADD COLUMN size INTEGER", "ALTER TABLE blob ADD COLUMN src TEXT",
    ]) { try { hub.sql.exec(ddl); } catch {} }
    hub.sql.exec("CREATE INDEX IF NOT EXISTS img_src ON img(conv, src); CREATE INDEX IF NOT EXISTS img_name ON img(conv, name); CREATE INDEX IF NOT EXISTS blob_src ON blob(conv, src);");
  }
  private one(q: string, ...b: any[]) { return this.hub.sql.exec(q, ...b).toArray()[0] as any; }
  private bucket() { return this.hub.env.FILES; }
  r2Bytes() { return Number(this.one("SELECT (SELECT COALESCE(SUM(size),0) FROM img WHERE r2 IS NOT NULL) + (SELECT COALESCE(SUM(size),0) FROM blob WHERE r2 IS NOT NULL) n").n); }

  /**
   * Everything in the bucket that grows with use: kept media, transfer files (file box, tool caches, workspaces),
   * published and deployed sites, and backups. Every writer checks this one total against the stop line, so
   * the parts cannot add up past what the plan includes.
   */
  r2All() {
    const sum = (q: string) => { try { return Number(this.one(q).n) || 0; } catch { return 0; } };   // a table that does not exist yet counts as empty
    return this.r2Bytes() + sum("SELECT COALESCE(SUM(size),0) n FROM xfer") + sum("SELECT COALESCE(SUM(bytes),0) n FROM site") + (Number(this.hub.get("backup:bytes")) || 0);
  }

  private async save(table: "img" | "blob", id: number, bytes: Uint8Array) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (bytes.length <= INLINE_MAX) { this.hub.sql.exec(`UPDATE ${table} SET data=?, size=? WHERE id=?`, buf, bytes.length, id); return true; }
    const ok = this.bucket() && bytes.length <= ITEM_MAX && this.r2All() + bytes.length <= R2_STORAGE_STOP && this.hub.plan.take("r2_writes", 1);
    if (ok) {
      try {
        await this.bucket().put(table + "/" + id, buf);
        this.hub.sql.exec(`UPDATE ${table} SET r2=?, size=? WHERE id=?`, table + "/" + id, bytes.length, id);
        return true;
      } catch (e: any) { console.log("r2 put failed", e?.message); }
    }
    this.hub.sql.exec(`DELETE FROM ${table} WHERE id=?`, id);
    return false;
  }
  async bytes(row: any): Promise<Uint8Array | null> {
    if (!row) return null;
    if (row.r2) {
      if (!this.bucket() || !this.hub.plan.take("r2_reads", 1)) return null;
      const obj = await this.bucket().get(String(row.r2)).catch(() => null);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    }
    return row.data ? new Uint8Array(row.data as ArrayBuffer) : null;
  }

  /** Keeps a picture and returns its number (the "12" of "g12"), or 0 when it could not be kept. */
  async putImage(conv: string, bytes: Uint8Array, mime: string, note: string, extra: { name?: string; src?: string; made?: Made } = {}) {
    if (extra.name) this.drop("img", "conv=? AND name=?", conv, extra.name);
    const id = Number(this.one("INSERT INTO img(conv,ts,mime,note,name,src,made) VALUES(?,?,?,?,?,?,?) RETURNING id",
      conv, Date.now(), mime, note, extra.name || null, extra.src || null, extra.made ? JSON.stringify(extra.made) : null).id);
    if (!(await this.save("img", id, bytes))) return 0;
    if (++this.puts % 20 === 0) this.trim(conv);
    return id;
  }
  async putFile(conv: string, name: string, bytes: Uint8Array, src?: string) {
    const id = Number(this.one("INSERT INTO blob(conv,ts,name,src) VALUES(?,?,?,?) RETURNING id", conv, Date.now(), name, src || null).id);
    if (!(await this.save("blob", id, bytes))) return 0;
    if (++this.puts % 20 === 0) this.trim(conv);
    return id;
  }
  private drop(table: "img" | "blob", where: string, ...b: any[]) {
    const keys = this.hub.sql.exec(`SELECT r2 FROM ${table} WHERE (${where}) AND r2 IS NOT NULL`, ...b).toArray().map((r: any) => String(r.r2));
    this.hub.sql.exec(`DELETE FROM ${table} WHERE ${where}`, ...b);
    if (keys.length && this.bucket()) this.hub.ctx.waitUntil(this.bucket().delete(keys).catch(() => {}));
  }
  removeImage(id: number) { this.drop("img", "id=?", id); }
  /** Named pictures (characters, stickers) stay; the bot's own output keeps the latest 300, chat pictures 45 days, files the latest 150. */
  trim(conv: string) {
    this.drop("img", "conv=? AND name IS NULL AND src IS NULL AND id NOT IN (SELECT id FROM img WHERE conv=? AND name IS NULL AND src IS NULL ORDER BY id DESC LIMIT 300)", conv, conv);
    this.drop("img", "src LIKE 'chat:%' AND ts<?", Date.now() - 45 * DAY);
    this.drop("blob", "conv=? AND id NOT IN (SELECT id FROM blob WHERE conv=? ORDER BY id DESC LIMIT 150)", conv, conv);
  }

  /** Resolves "123-0" (a picture in the chat), "g12" (one the bot made), a saved name, or a URL. */
  async imageRef(conv: string, ref: string): Promise<(Ref & { made?: Made }) | null> {
    const label = ref.trim().replace(/^\[?图片\s*/, "").replace(/\]$/, "");
    const stored = async (row: any) => {
      const bytes = await this.bytes(row);
      let made: Made | undefined;
      try { made = row?.made ? JSON.parse(String(row.made)) : undefined; } catch {}
      return bytes ? { label, bytes, mime: String(row.mime || "image/jpeg"), ...(made ? { made } : {}) } : null;
    };
    const g = label.match(/^g(\d+)$/i);
    if (g) return stored(this.one("SELECT * FROM img WHERE id=?", Number(g[1])));
    let url = /^https?:\/\//.test(label) ? label : "";
    const chat = label.match(/^(\d+)-(\d+)$/);
    if (chat) {
      const kept = this.one("SELECT * FROM img WHERE conv=? AND src=? ORDER BY id DESC LIMIT 1", conv, "chat:" + label);
      if (kept) return stored(kept);
      const row = this.one("SELECT meta FROM msg WHERE seq=? AND conv=?", Number(chat[1]), conv);
      url = row?.meta ? JSON.parse(String(row.meta)).images?.[Number(chat[2])]?.url || "" : "";
    }
    if (!url) {
      // Saved characters; private test rooms borrow the main group's.
      const named = (c: string) => this.one("SELECT * FROM img WHERE conv=? AND name=? ORDER BY id DESC LIMIT 1", c, label);
      return stored(named(conv) || (this.hub.shadow(conv) ? named(this.hub.shadow(conv)) : null));
    }
    const got = await this.hub.fetchBytes(url, 8 * 1024 * 1024);
    return got ? { label, bytes: got.bytes, mime: got.mime.startsWith("image/") ? got.mime : "image/jpeg" } : null;
  }
  /** Resolves "f12" (a kept file), a link from the chat, or any picture reference. */
  async fileRef(conv: string, ref: string) {
    const text = ref.trim(), kept = text.match(/^f(\d+)$/i);
    if (kept) {
      const row = this.one("SELECT * FROM blob WHERE id=?", Number(kept[1])), bytes = await this.bytes(row);
      return bytes ? { name: String(row.name), bytes } : null;
    }
    if (/^https?:\/\//.test(text)) {
      const saved = this.one("SELECT * FROM blob WHERE conv=? AND src=? ORDER BY id DESC LIMIT 1", conv, text);
      const savedBytes = await this.bytes(saved);
      if (savedBytes) return { name: String(saved.name), bytes: savedBytes };
      const got = await this.hub.fetchBytes(text, 30 * 1024 * 1024);
      const named = this.one("SELECT meta FROM msg WHERE conv=? AND meta LIKE ? ORDER BY seq DESC LIMIT 1", conv, "%" + text.slice(0, 80) + "%");
      const name = named?.meta ? (JSON.parse(String(named.meta)).files || []).find((f: any) => f.url === text)?.name : "";
      return got ? { name: name || decodeURIComponent(text.split("/").pop()?.split("?")[0] || "input.bin"), bytes: got.bytes } : null;
    }
    const img = await this.imageRef(conv, text);
    return img ? { name: "image-" + (text.replace(/[^0-9a-z\u4e00-\u9fff-]/gi, "") || "x") + "." + (img.mime.split("/")[1] || "jpg"), bytes: img.bytes } : null;
  }

  /** Copies what a message carried before its QQ links expire. */
  async archiveChat(conv: string, seq: number, meta: any) {
    const images: any[] = meta?.images || [];
    for (let i = 0; i < images.length; i++) {
      if (!images[i]?.url) continue;
      const got = await this.hub.fetchBytes(String(images[i].url), 8 * 1024 * 1024).catch(() => null);
      if (got) await this.putImage(conv, got.bytes, got.mime.startsWith("image/") ? got.mime : "image/jpeg", "群友发的图", { src: "chat:" + seq + "-" + i });
    }
    for (const f of meta?.files || []) {
      if (!f?.url) continue;
      const got = await this.hub.fetchBytes(String(f.url), 20 * 1024 * 1024).catch(() => null);
      if (got) await this.putFile(conv, String(f.name || "file"), got.bytes, String(f.url));
    }
  }
  /** Stickers with the mood each one is for (kept in the picture's note). */
  stickers(conv: string): { name: string; mood: string }[] {
    const of = (c: string) => this.hub.sql.exec("SELECT name, note FROM img WHERE conv=? AND name LIKE 'sticker:%' GROUP BY name ORDER BY name", c).toArray()
      .map((r: any) => ({ name: String(r.name).slice(8), mood: String(r.note || "") === "表情包" ? "" : String(r.note || "") }));
    const mine = of(conv), seen = new Set(mine.map(x => x.name));
    return [...mine, ...(this.hub.shadow(conv) ? of(this.hub.shadow(conv)).filter(x => !seen.has(x.name)) : [])];
  }
  names(conv: string, stickers: boolean): string[] {
    const of = (c: string) => this.hub.sql.exec("SELECT DISTINCT name FROM img WHERE conv=? AND name IS NOT NULL AND name " + (stickers ? "LIKE" : "NOT LIKE") + " 'sticker:%' ORDER BY name", c)
      .toArray().map((r: any) => String(r.name).slice(stickers ? 8 : 0));
    return [...new Set([...of(conv), ...(this.hub.shadow(conv) ? of(this.hub.shadow(conv)) : [])])];
  }
}
