// The layer the bot may change by itself: bounded settings, short playbooks, the names it answers to,
// and who is allowed to make those changes. Every change is logged and can be reverted.
import type { Hub } from "./hub.ts";
import { PLAYBOOKS, PLAYBOOK_LIMIT, TUNABLES, checkTunable } from "./config.ts";
import { BJ, clip, fmtFull } from "./util.ts";

export type Asker = { id: string; name: string };
type Member = { id: string; name: string };

export class SelfEdit {
  private hub: Hub;
  constructor(hub: Hub) { this.hub = hub; }
  /** Test rooms read the main group's values unless they have their own. */
  private scoped(prefix: string, conv: string, key: string) {
    const shadow = this.hub.shadow(conv);
    return this.hub.get(prefix + ":" + conv + ":" + key) ?? (shadow ? this.hub.get(prefix + ":" + shadow + ":" + key) : null);
  }
  cfg(conv: string, key: string): number | string {
    const t = TUNABLES[key], raw = this.scoped("cfg", conv, key);
    if (!t) return 0;
    if (raw === null) return t.default;
    return t.options ? raw : Number(raw);
  }
  play(conv: string, slot: string) { return this.scoped("play", conv, slot) || ""; }
  aliases(conv: string): string[] { try { return JSON.parse(this.scoped("alias", conv, "list") || "[]"); } catch { return []; } }
  /** Members the owner has given the same say over these settings. */
  trusted(conv: string): Member[] { try { return JSON.parse(this.scoped("trusted", conv, "list") || "[]"); } catch { return []; } }

  private owners() { return String(this.hub.env.OWNERS || "").split(",").map(x => x.trim()).filter(Boolean); }
  rank(conv: string, askers: Asker[]): "owner" | "trusted" | "member" {
    const owners = this.owners(), trusted = this.trusted(conv).map(m => m.id);
    if (askers.some(a => owners.includes(a.id))) return "owner";
    return askers.some(a => trusted.includes(a.id)) ? "trusted" : "member";
  }
  private member(conv: string, name: string): Member | null {
    const real = this.hub.shadow(conv) || conv;
    const row = this.hub.sql.exec("SELECT sender, name FROM msg WHERE conv=? AND role='user' AND sender<>'' AND (name=? OR name LIKE ?) ORDER BY (name=?) DESC, seq DESC LIMIT 1", real, name, "%" + name + "%", name).toArray()[0] as any;
    return row ? { id: String(row.sender), name: String(row.name) } : null;
  }
  /** Used by the owner's instruction in chat and by the admin surface. */
  setTrusted(conv: string, name: string, on: boolean) {
    const who = this.member(conv, name);
    if (!who) return { ok: false as const, error: "群里没找到叫“" + name + "”的人" };
    const list = this.trusted(conv).filter(m => m.id !== who.id);
    if (on) list.push(who);
    this.hub.set("trusted:" + conv + ":list", JSON.stringify(list));
    return { ok: true as const, who: who.name, trusted: list.map(m => m.name) };
  }
  private write(conv: string, kind: string, key: string, value: string) {
    this.hub.set((kind === "config" ? "cfg" : kind === "playbook" ? "play" : "alias") + ":" + conv + ":" + (kind === "alias" ? "list" : key), value);
  }

  async update(conv: string, askers: Asker[], a: any) {
    const op = String(a.op || "status"), rank = this.rank(conv, askers), allowed = rank !== "member";
    const by = [...new Set(askers.map(x => x.name || x.id.slice(-4)))].join("、") || "（没人，系统任务）";
    const reason = String(a.reason || "").trim();
    if (op === "status") {
      return {
        can_change_myself: "参数、做法说明、别人叫我的名字。代码逻辑（收发、存储、安全、工具实现）我自己改不了，只能写提议。",
        who_can_change: { owner: "群主（写在部署配置里，谁也改不了）", also_trusted: this.trusted(conv).map(m => m.name), others: "其他人提的改动先记成提议，群主或被授权的人同意后生效" },
        settings: Object.fromEntries(Object.entries(TUNABLES).map(([k, t]) => [k, { now: this.cfg(conv, k), default: t.default, what: t.what, ...(t.options ? { options: t.options } : { min: t.min, max: t.max }) }])),
        playbooks: Object.fromEntries(Object.keys(PLAYBOOKS).map(slot => [slot, { what: PLAYBOOKS[slot], text: this.play(conv, slot) || "（空）" }])),
        aliases: this.aliases(conv),
        recent_changes: this.hub.sql.exec("SELECT id,ts,by,kind,key,after,reason,status FROM change WHERE conv=? ORDER BY id DESC LIMIT 12", conv).toArray()
          .map((r: any) => ({ id: r.id, when: fmtFull(Number(r.ts), BJ), by: r.by, what: r.kind + " " + r.key + " → " + clip(r.after, 80), reason: clip(r.reason, 120), status: r.status })),
      };
    }
    const log = (kind: string, key: string, before: string, after: string, status: string) =>
      Number(this.hub.sql.exec("INSERT INTO change(conv,ts,by,kind,key,before,after,reason,status) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id", conv, Date.now(), by, kind, key, before, after, reason, status).toArray()[0].id);
    if (op === "grant" || op === "revoke") {
      if (rank !== "owner") return { ok: false, error: "给谁权限、收回谁的权限，只有群主本人能定" };
      const before = JSON.stringify(this.trusted(conv).map(m => m.name));
      const r = this.setTrusted(conv, String(a.member || ""), op === "grant");
      if (!r.ok) return r;
      const id = log("trust", r.who, before, JSON.stringify(r.trusted), "applied");
      return { ok: true, id, now_trusted: r.trusted, note: op === "grant" ? r.who + " 现在可以直接让我改参数、做法说明和名字，也能批准和撤销改动；授权和收回仍然只有群主能做" : r.who + " 的权限收回了" };
    }
    if (op === "revert" || op === "apply") {
      if (!allowed) return { ok: false, error: "撤销和批准要群主或被授权的人来说" };
      const row = this.hub.sql.exec("SELECT * FROM change WHERE id=? AND conv=?", Number(a.id), conv).toArray()[0] as any;
      if (!row || row.kind === "code" || row.kind === "trust") return { ok: false, error: "没有这条可操作的改动" };
      if (op === "revert" && row.status === "applied") { this.write(conv, String(row.kind), String(row.key), String(row.before)); this.hub.sql.exec("UPDATE change SET status='reverted' WHERE id=?", row.id); return { ok: true, reverted: row.id, restored: clip(row.before, 200) }; }
      if (op === "apply" && row.status === "proposed") { this.write(conv, String(row.kind), String(row.key), String(row.after)); this.hub.sql.exec("UPDATE change SET status='applied' WHERE id=?", row.id); return { ok: true, applied: row.id, now: clip(row.after, 200) }; }
      return { ok: false, error: "这条现在的状态是 " + row.status + "，不能这么操作" };
    }
    if (reason.length < 8) return { ok: false, error: "要写 reason：问题是什么、查到的原因、为什么这样改" };
    if (op === "propose_code") {
      const id = log("code", clip(a.title || "未命名", 80), "", clip(a.text || "", 3000), "proposed");
      return { ok: true, id, note: "已记成第 " + id + " 号改进提议，等维护代码的人处理；这个问题现在还没修好，别说修好了" };
    }
    let kind = "", key = "", before = "", after = "";
    if (op === "set_config") {
      const checked = checkTunable(String(a.key), a.value);
      if (!checked.ok) return { ok: false, error: checked.error };
      kind = "config"; key = String(a.key); before = String(this.cfg(conv, key)); after = String(checked.value);
    } else if (op === "set_playbook") {
      const slot = String(a.slot), text = String(a.text || "").trim();
      if (!PLAYBOOKS[slot]) return { ok: false, error: "slot 只能是 " + Object.keys(PLAYBOOKS).join(" / ") };
      if (!text && a.mode !== "replace") return { ok: false, error: "要写 text" };
      kind = "playbook"; key = slot; before = this.play(conv, slot);
      after = a.mode === "replace" ? text : (before ? before + "\n" : "") + "· " + text.replace(/^[·\-\s]+/, "");
      if (after.length > PLAYBOOK_LIMIT) return { ok: false, error: "这段做法说明超过 " + PLAYBOOK_LIMIT + " 字了，先用 mode=replace 合并精简再加" };
    } else if (op === "add_alias" || op === "remove_alias") {
      const alias = String(a.alias || "").trim(), list = this.aliases(conv);
      if (alias.length < 2 || alias.length > 12) return { ok: false, error: "名字要 2 到 12 个字" };
      kind = "alias"; key = alias; before = JSON.stringify(list);
      after = JSON.stringify(op === "add_alias" ? [...new Set([...list, alias])].slice(0, 12) : list.filter(x => x !== alias));
    } else return { ok: false, error: "不认识的 op" };
    if (before === after) return { ok: true, unchanged: true, now: clip(after, 200) };
    if (!allowed) {
      const id = log(kind, key, before, after, "proposed");
      return { ok: false, needs_approval: true, id, note: "改自己的设置要群主或被授权的人点头。已记成第 " + id + " 号提议，他们说同意后用 op=apply 生效；现在还没改" };
    }
    this.write(conv, kind, key, after);
    const id = log(kind, key, before, after, "applied");
    return { ok: true, id, before: clip(before, 200) || "（空）", now: clip(after, 300), undo: "说撤销第 " + id + " 号就能改回去" };
  }
}
