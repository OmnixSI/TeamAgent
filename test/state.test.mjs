// Offline tests for the stateful helpers that sit on the Hub: the plan allowance and self-editing.
// budget.ts and selfedit.ts use TypeScript parameter properties (`constructor(private hub: Hub) {}`),
// which Node's type stripping refuses. A test-only load hook rewrites that one construct; src is untouched.
import { registerHooks } from "node:module";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (!url.endsWith(".ts") || !url.includes("/src/")) return r;
    const src = String(r.source);
    if (!/constructor\(\s*(private|public|protected|readonly)\s/.test(src)) return r;
    return { ...r, source: src.replace(/constructor\(\s*(?:private|public|protected)\s+(?:readonly\s+)?(\w+)\s*:\s*([^)]*)\)\s*\{\s*\}/g, "constructor($1: $2) { this.$1 = $1; }") };
  },
});
const { cycleStart, Plan, PLAN, DAILY, R2_STORAGE_STOP } = await import("../src/budget.ts");
const { SelfEdit } = await import("../src/selfedit.ts");

const kv = () => {
  const m = new Map();
  return { m, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); } };
};
const day = ts => new Date(ts).toISOString().slice(0, 10);

describe("budget.cycleStart", () => {
  test("cycle starts on the 13th UTC", () => {
    assert.equal(day(cycleStart(Date.UTC(2026, 10, 15, 12))), "2026-11-13");
    assert.equal(day(cycleStart(Date.UTC(2026, 10, 13, 0, 0))), "2026-11-13");
    assert.equal(day(cycleStart(Date.UTC(2026, 10, 12, 23, 59, 59))), "2026-10-13");
    assert.equal(day(cycleStart(Date.UTC(2026, 11, 31))), "2026-12-13");
    assert.equal(cycleStart(Date.UTC(2026, 10, 20, 7, 30)), Date.UTC(2026, 10, 13));
  });
  test("across the year boundary", () => {
    assert.equal(day(cycleStart(Date.UTC(2027, 0, 5))), "2026-12-13");
    assert.equal(day(cycleStart(Date.UTC(2027, 0, 13))), "2027-01-13");
  });
});

describe("budget.Plan", () => {
  let hub, plan;
  beforeEach(() => { hub = kv(); plan = new Plan(hub); });

  test("take refuses once the stop line would be passed", () => {
    const stop = PLAN.browser_seconds.stop;
    assert.equal(plan.take("browser_seconds", stop - 600), true);
    assert.equal(plan.take("browser_seconds", 600), true, "reaching the stop line exactly is allowed");
    assert.equal(plan.used("browser_seconds"), stop);
    assert.equal(plan.take("browser_seconds", 1), false);
    assert.equal(plan.used("browser_seconds"), stop, "a refused take is not counted");
    assert.equal(plan.left("browser_seconds"), 0);
  });

  test("fits, left, add and the storage key", () => {
    assert.equal(plan.fits("r2_writes"), true);
    assert.equal(plan.fits("r2_writes", PLAN.r2_writes.stop + 1), false);
    plan.add("r2_writes", 1.234);
    plan.add("r2_writes", -5);
    assert.equal(plan.used("r2_writes"), 1.23);
    assert.equal(plan.left("r2_writes"), PLAN.r2_writes.stop - 1.23);
    const key = [...hub.m.keys()][0];
    assert.equal(key, "plan:" + day(cycleStart(Date.now())) + ":r2_writes");
    assert.equal(plan.fits("unknown_meter", 1e12), true);
    assert.equal(plan.left("unknown_meter"), Infinity);
    assert.equal(plan.take("unknown_meter", 5), true);
  });

  test("report shape", () => {
    plan.add("browser_seconds", 3600);
    const now = Date.now();
    const r = plan.report(2 * 1048576, now);
    const start = cycleStart(now), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    assert.equal(r.cycle, day(start) + " 到 " + day(end.getTime()));
    assert.equal(typeof r.rule, "string");
    assert.equal(r.items.length, Object.keys(PLAN).length + Object.keys(DAILY).length + 2);
    for (const i of r.items) {
      for (const k of ["what", "used", "included", "unit", "percent_of_included"]) assert.ok(k in i, k);
    }
    const browser = r.items.find(i => i.what === PLAN.browser_seconds.what);
    assert.deepEqual(browser, { what: PLAN.browser_seconds.what, used: 3600, stop_at: 30600, included: 36000, unit: "秒", percent_of_included: 10 });
    const r2 = r.items.find(i => i.unit === "MB");
    assert.equal(r2.used, 2);
    assert.equal(r2.stop_at, R2_STORAGE_STOP / 1048576);
    const dur = r.items.at(-1);
    assert.match(dur.what, /^Durable Object/);
    assert.ok(dur.whole_cycle_estimate_percent >= dur.percent_of_included);
  });

  test("tight lists items past 80% of the included amount", () => {
    plan.add("browser_seconds", 30000);   // 83%
    plan.add("r2_writes", 500000);        // 50%
    const t = plan.tight(0);
    assert.equal(t.length, 1);
    assert.match(t[0], /无头浏览器.*已用 83\.3%/);
  });
});

/** Just enough of the Hub for SelfEdit: kv, shadow rooms, owners and the two SQL tables it touches. */
function fakeHub({ owners = "OWNER", members = [], shadow = {} } = {}) {
  const store = kv(), changes = [];
  const msg = members.map(([sender, name, conv = "G", seq = 1]) => ({ sender, name, conv, seq, role: "user" }));
  const exec = (q, ...b) => {
    const rows = (() => {
      if (/^SELECT sender, name FROM msg/.test(q)) {
        const [conv, name, , exact] = b;
        const hits = msg.filter(m => m.conv === conv && m.role === "user" && m.sender && (m.name === name || m.name.includes(name)));
        hits.sort((x, y) => Number(y.name === exact) - Number(x.name === exact) || y.seq - x.seq);
        return hits.slice(0, 1).map(m => ({ sender: m.sender, name: m.name }));
      }
      if (/^INSERT INTO change/.test(q)) {
        const [conv, ts, by, kind, key, before, after, reason, status] = b;
        const row = { id: changes.length + 1, conv, ts, by, kind, key, before, after, reason, status };
        changes.push(row);
        return [{ id: row.id }];
      }
      if (/^SELECT id,ts,by,kind,key,after,reason,status FROM change WHERE conv=\? ORDER BY id DESC LIMIT 12/.test(q)) {
        return changes.filter(c => c.conv === b[0]).sort((x, y) => y.id - x.id).slice(0, 12).map(c => ({ ...c }));
      }
      if (/^SELECT \* FROM change WHERE id=\? AND conv=\?/.test(q)) {
        return changes.filter(c => c.id === b[0] && c.conv === b[1]).map(c => ({ ...c }));
      }
      const upd = q.match(/^UPDATE change SET status='(\w+)' WHERE id=\?$/);
      if (upd) { for (const c of changes) if (c.id === b[0]) c.status = upd[1]; return []; }
      throw new Error("fake sql does not know: " + q);
    })();
    return { toArray: () => rows };
  };
  return { get: store.get, set: store.set, kv: store.m, changes, env: { OWNERS: owners }, shadow: conv => shadow[conv] || "", sql: { exec } };
}

describe("selfedit.SelfEdit", () => {
  const owner = [{ id: "OWNER", name: "群主" }];
  const li = [{ id: "U2", name: "小李" }];
  const zhang = [{ id: "U3", name: "小张" }];
  const why = "群友说回得太慢了，调一下等待";
  let hub, edit;
  beforeEach(() => {
    hub = fakeHub({ owners: " OWNER , OTHER ", members: [["U2", "小李"], ["U3", "小张"], ["U4", "小李子", "G", 5]] });
    edit = new SelfEdit(hub);
  });

  test("defaults and ranks", () => {
    assert.equal(edit.cfg("G", "wait_called_ms"), 350);
    assert.equal(edit.cfg("G", "talkative"), "normal");
    assert.equal(edit.cfg("G", "no_such"), 0);
    assert.equal(edit.rank("G", owner), "owner");
    assert.equal(edit.rank("G", [{ id: "OTHER", name: "" }]), "owner");
    assert.equal(edit.rank("G", li), "member");
    assert.deepEqual(edit.aliases("G"), []);
  });

  test("owner applies a config change directly", async () => {
    const r = await edit.update("G", owner, { op: "set_config", key: "wait_called_ms", value: 1000, reason: why });
    assert.equal(r.ok, true);
    assert.equal(r.before, "350");
    assert.equal(r.now, "1000");
    assert.equal(edit.cfg("G", "wait_called_ms"), 1000);
    assert.equal(hub.changes[0].status, "applied");
    assert.equal(hub.changes[0].by, "群主");
    assert.equal(edit.cfg("OTHER_GROUP", "wait_called_ms"), 350, "settings are per conversation");
  });

  test("a change needs a reason and a valid value", async () => {
    assert.match((await edit.update("G", owner, { op: "set_config", key: "wait_called_ms", value: 1000, reason: "短" })).error, /reason/);
    assert.match((await edit.update("G", owner, { op: "set_config", key: "wait_called_ms", value: 99999, reason: why })).error, /之间/);
    assert.equal((await edit.update("G", owner, { op: "set_config", key: "wait_called_ms", value: 350, reason: why })).unchanged, true);
    assert.match((await edit.update("G", owner, { op: "bogus", reason: why })).error, /不认识的 op/);
    assert.equal(hub.changes.length, 0);
  });

  test("a member's change is only proposed until an owner applies it", async () => {
    const p = await edit.update("G", li, { op: "set_config", key: "talkative", value: "quiet", reason: why });
    assert.equal(p.ok, false);
    assert.equal(p.needs_approval, true);
    assert.equal(edit.cfg("G", "talkative"), "normal");
    assert.equal(hub.changes[0].status, "proposed");
    const self = await edit.update("G", li, { op: "apply", id: p.id });
    assert.equal(self.ok, false, "the proposer cannot approve their own change");
    assert.equal(edit.cfg("G", "talkative"), "normal");
    const ok = await edit.update("G", owner, { op: "apply", id: p.id });
    assert.equal(ok.ok, true);
    assert.equal(ok.applied, p.id);
    assert.equal(edit.cfg("G", "talkative"), "quiet");
    assert.equal(hub.changes[0].status, "applied");
    const again = await edit.update("G", owner, { op: "apply", id: p.id });
    assert.equal(again.ok, false);
    assert.match(again.error, /applied/);
  });

  test("grant by owner makes a member trusted, who can then change settings and approve", async () => {
    const g = await edit.update("G", owner, { op: "grant", member: "小李" });
    assert.equal(g.ok, true);
    assert.deepEqual(g.now_trusted, ["小李"]);
    assert.equal(edit.rank("G", li), "trusted");
    assert.equal(hub.changes.at(-1).kind, "trust");
    const s = await edit.update("G", li, { op: "set_config", key: "image_daily", value: 10, reason: why });
    assert.equal(s.ok, true);
    assert.equal(edit.cfg("G", "image_daily"), 10);
    const p = await edit.update("G", zhang, { op: "set_config", key: "voice_daily", value: 5, reason: why });
    assert.equal(p.needs_approval, true);
    assert.equal((await edit.update("G", li, { op: "apply", id: p.id })).ok, true);
    assert.equal(edit.cfg("G", "voice_daily"), 5);
    // a trust change itself cannot be reverted or applied through this path
    const trustId = hub.changes.find(c => c.kind === "trust").id;
    assert.match((await edit.update("G", owner, { op: "revert", id: trustId })).error, /没有这条可操作的改动/);
    // revoke
    const rv = await edit.update("G", owner, { op: "revoke", member: "小李" });
    assert.equal(rv.ok, true);
    assert.deepEqual(rv.now_trusted, []);
    assert.equal(edit.rank("G", li), "member");
  });

  test("grant prefers the exact name and reports unknown names", async () => {
    await edit.update("G", owner, { op: "grant", member: "小李" });
    assert.deepEqual(edit.trusted("G"), [{ id: "U2", name: "小李" }]);
    const none = await edit.update("G", owner, { op: "grant", member: "不存在的人" });
    assert.equal(none.ok, false);
    assert.match(none.error, /没找到/);
  });

  test("grant by a non-owner is refused, even when trusted", async () => {
    const r = await edit.update("G", zhang, { op: "grant", member: "小张" });
    assert.equal(r.ok, false);
    assert.match(r.error, /只有群主/);
    await edit.update("G", owner, { op: "grant", member: "小李" });
    const t = await edit.update("G", li, { op: "grant", member: "小张" });
    assert.equal(t.ok, false);
    assert.equal(edit.rank("G", zhang), "member");
  });

  test("revert restores the previous value, once", async () => {
    await edit.update("G", owner, { op: "set_config", key: "wait_called_ms", value: 800, reason: why });
    const second = await edit.update("G", owner, { op: "set_config", key: "wait_called_ms", value: 1200, reason: why });
    assert.equal(edit.cfg("G", "wait_called_ms"), 1200);
    const r = await edit.update("G", owner, { op: "revert", id: second.id });
    assert.equal(r.ok, true);
    assert.equal(r.restored, "800");
    assert.equal(edit.cfg("G", "wait_called_ms"), 800);
    const twice = await edit.update("G", owner, { op: "revert", id: second.id });
    assert.equal(twice.ok, false);
    assert.match(twice.error, /reverted/);
    assert.equal((await edit.update("G", li, { op: "revert", id: 1 })).ok, false, "members cannot revert");
    assert.equal((await edit.update("OTHER", owner, { op: "revert", id: 1 })).ok, false, "ids are scoped to the conversation");
  });

  test("playbook append, replace, slot check and length limit", async () => {
    const a = await edit.update("G", owner, { op: "set_playbook", slot: "persona", text: "说话短一点", reason: why });
    assert.equal(a.ok, true);
    assert.equal(edit.play("G", "persona"), "· 说话短一点");
    await edit.update("G", owner, { op: "set_playbook", slot: "persona", text: "- 别用表情", reason: why });
    assert.equal(edit.play("G", "persona"), "· 说话短一点\n· 别用表情");
    await edit.update("G", owner, { op: "set_playbook", slot: "persona", text: "只留这一条", mode: "replace", reason: why });
    assert.equal(edit.play("G", "persona"), "只留这一条");
    assert.match((await edit.update("G", owner, { op: "set_playbook", slot: "nope", text: "x", reason: why })).error, /slot/);
    assert.match((await edit.update("G", owner, { op: "set_playbook", slot: "drawing", text: "", reason: why })).error, /text/);
    const big = await edit.update("G", owner, { op: "set_playbook", slot: "persona", text: "字".repeat(1500), reason: why });
    assert.equal(big.ok, false);
    assert.match(big.error, /1500/);
    assert.equal(edit.play("G", "persona"), "只留这一条");
    const fits = await edit.update("G", owner, { op: "set_playbook", slot: "python", text: "字".repeat(1498), reason: why });
    assert.equal(fits.ok, true, "'· ' plus 1498 characters is exactly the limit");
  });

  test("alias add and remove", async () => {
    const a = await edit.update("G", owner, { op: "add_alias", alias: "小蛙", reason: why });
    assert.equal(a.ok, true);
    assert.deepEqual(edit.aliases("G"), ["小蛙"]);
    assert.equal((await edit.update("G", owner, { op: "add_alias", alias: "小蛙", reason: why })).unchanged, true);
    await edit.update("G", owner, { op: "add_alias", alias: "蛙蛙", reason: why });
    assert.deepEqual(edit.aliases("G"), ["小蛙", "蛙蛙"]);
    await edit.update("G", owner, { op: "remove_alias", alias: "小蛙", reason: why });
    assert.deepEqual(edit.aliases("G"), ["蛙蛙"]);
    assert.match((await edit.update("G", owner, { op: "add_alias", alias: "蛙", reason: why })).error, /2 到 12/);
    assert.match((await edit.update("G", owner, { op: "add_alias", alias: "蛙".repeat(13),reason: why })).error, /2 到 12/);
  });

  test("propose_code is logged and changes nothing", async () => {
    const r = await edit.update("G", li, { op: "propose_code", title: "修一下重连", text: "断线后没重连", reason: why });
    assert.equal(r.ok, true);
    assert.equal(hub.changes[0].kind, "code");
    assert.equal(hub.changes[0].status, "proposed");
    assert.match((await edit.update("G", owner, { op: "apply", id: r.id })).error, /没有这条可操作的改动/);
  });

  test("status lists settings, playbooks, aliases and recent changes", async () => {
    await edit.update("G", owner, { op: "set_config", key: "wait_called_ms", value: 900, reason: why });
    const s = await edit.update("G", li, {});
    assert.equal(s.settings.wait_called_ms.now, 900);
    assert.equal(s.settings.talkative.now, "normal");
    assert.deepEqual(s.settings.talkative.options, ["quiet", "normal", "chatty"]);
    assert.equal(s.playbooks.persona.text, "（空）");
    assert.deepEqual(s.aliases, []);
    assert.equal(s.recent_changes.length, 1);
    assert.equal(s.recent_changes[0].status, "applied");
    assert.match(s.recent_changes[0].what, /config wait_called_ms → 900/);
  });

  test("a test room reads the main group's values unless it has its own", async () => {
    const h = fakeHub({ shadow: { TEST: "G" } });
    const e = new SelfEdit(h);
    await e.update("G", [{ id: "OWNER", name: "群主" }], { op: "set_config", key: "reply_split_max", value: 5, reason: why });
    assert.equal(e.cfg("TEST", "reply_split_max"), 5);
    await e.update("TEST", [{ id: "OWNER", name: "群主" }], { op: "set_config", key: "reply_split_max", value: 1, reason: why });
    assert.equal(e.cfg("TEST", "reply_split_max"), 1);
    assert.equal(e.cfg("G", "reply_split_max"), 5);
  });
});
