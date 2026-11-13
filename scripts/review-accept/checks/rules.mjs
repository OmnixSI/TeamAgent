// D-5b acceptance checks: rule lifecycle, free-text gating, memory candidates
// that never reach the daytime facts table before an admin approval.
import { readFileSync } from "node:fs";
import { assert, equal, memoryDb, rawRows } from "../harness.mjs";

const NOW = Date.parse("2026-11-14T00:00:00Z");
const DAY = 86_400_000;

async function setup() {
  const { raw, db } = memoryDb();
  raw.prepare("INSERT INTO members(id,name,token_hash) VALUES('qq:s1','成员','x')").run();
  raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m1','g','qq:s1','以后请只给结论',?,1)").run(new Date(NOW).toISOString());
  raw.prepare("INSERT INTO message_meta(id,json) VALUES('m1','{}')").run();
  return { raw, db };
}
const run = (id = "night1", at = NOW) => ({ id, group_id: "g", now: at });
const EVIDENCE = (id = "m1", quote = "以后请只给结论") => [{ source: "message", id, quote, origin: "direct" }];
const REQ = (patch = {}) => ({
  kind: "burst_max", params: { max: 1 }, rule: "", scene: "群聊回答",
  evidence: EVIDENCE(), ttl_days: 7, ...patch,
});
const FREE = (patch = {}) => ({
  kind: "free", params: {}, rule: "先给结论", scene: "回答", evidence: EVIDENCE(), ttl_days: 30, ...patch,
});
function finding(raw, runId, msgId, quote, at = NOW) {
  raw.prepare(`INSERT INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,dimensions,evidence_json,
    what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,status,created_at)
    VALUES(?,?,?,'reasoning.output.instruction','p1','prompt','{}',?,'旧规则造成错误','调整表达','规则失效','修订',0.9,'agree','open',?)`)
    .run(`f-${runId}-${msgId}`, runId, `tr-${msgId}`, JSON.stringify([{ source: "message", id: msgId, quote }]), at);
}
function correctionMessage(raw, id, quote, at) {
  raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?, 'g','qq:s1',?,?,1)")
    .run(id, quote, new Date(at).toISOString());
}
const ruleRow = (raw, id) => raw.prepare("SELECT * FROM behavior_rules WHERE id=?").get(id);

export async function vdRule(ctx) {
  const api = await ctx.api();
  const { raw, db } = await setup();
  const e = { DB: db };
  try {
    // candidate -> canary (only with dual agreement) -> active after 3 days.
    finding(raw, "night1", "m1", "以后请只给结论");
    const [typed] = await api.applyRequirements(e, run("night1"), [REQ()]);
    assert(typed, "typed requirement stored");
    equal(ruleRow(raw, typed).status, "canary", "typed rule enters canary with agreement");
    equal(ruleRow(raw, typed).canary_until, NOW + 3 * DAY, "canary is 3 days");
    await api.advanceRules(e, run("night4", NOW + 3 * DAY));
    equal(ruleRow(raw, typed).status, "active", "canary promotes after 3 days");

    // One correction inside the canary window rolls the rule back.
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m2','g','qq:s1','以后请只给结论',?,1)").run(new Date(NOW).toISOString());
    raw.prepare("INSERT INTO message_meta(id,json) VALUES('m2','{}')").run();
    finding(raw, "night1b", "m2", "以后请只给结论");
    const [rolled] = await api.applyRequirements(e, run("night1b"), [REQ({ evidence: EVIDENCE("m2") })]);
    const rule = ruleRow(raw, rolled);
    correctionMessage(raw, "m-correct", `纠正：不要${rule.rule}`, NOW + DAY);
    finding(raw, "night2", "m-correct", `不要${rule.rule}`, NOW + DAY);
    await api.advanceRules(e, run("night2", NOW + DAY));
    equal(ruleRow(raw, rolled).status, "retired", "canary correction retires");
    assert(/correction/.test(ruleRow(raw, rolled).rollback_reason), "rollback reason");

    // Two corrections retire an active rule; replay does not double count.
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m3','g','qq:s1','以后请只给结论',?,1)").run(new Date(NOW).toISOString());
    raw.prepare("INSERT INTO message_meta(id,json) VALUES('m3','{}')").run();
    finding(raw, "night3", "m3", "以后请只给结论");
    const [active] = await api.applyRequirements(e, run("night3"), [REQ({ scene: "第二个场景", evidence: EVIDENCE("m3") })]);
    await api.advanceRules(e, run("night6", NOW + 3 * DAY));
    equal(ruleRow(raw, active).status, "active", "second rule active");
    for (const [id, at] of [["m-c1", NOW + 4 * DAY], ["m-c2", NOW + 5 * DAY]]) {
      correctionMessage(raw, id, `纠正：不要${ruleRow(raw, active).rule}`, at);
      finding(raw, `night-${id}`, id, `不要${ruleRow(raw, active).rule}`, at);
      await api.advanceRules(e, run(`night-${id}`, at));
    }
    equal(ruleRow(raw, active).status, "retired", "two active corrections retire");
    equal(ruleRow(raw, active).corrections, 2, "corrections counted from the ledger");

    // 30-day expiry.
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m4','g','qq:s1','以后请只给结论',?,1)").run(new Date(NOW).toISOString());
    raw.prepare("INSERT INTO message_meta(id,json) VALUES('m4','{}')").run();
    finding(raw, "night7", "m4", "以后请只给结论");
    const [expiring] = await api.applyRequirements(e, run("night7"), [REQ({ scene: "会过期的场景", evidence: EVIDENCE("m4") })]);
    await api.advanceRules(e, run("night37", NOW + 31 * DAY));
    equal(ruleRow(raw, expiring).status, "retired", "expiry retires");
    equal(ruleRow(raw, expiring).rollback_reason, "expired", "expiry reason");

    // Live rules are capped at five; extra live rules freeze instead of retiring.
    for (let i = 0; i < 7; i++) {
      raw.prepare(`INSERT INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,canary_until,expires_at,created_at,updated_at)
        VALUES(?, 'g','规则'+?,'场景'+?,'free','{}','[]','member:qq:s1','canary',?,?,?,?)`)
        .run(`bulk-${i}`, i, i, NOW + 10 * DAY, NOW + 30 * DAY, NOW, NOW);
    }
    await api.advanceRules(e, run("night-bulk", NOW + DAY));
    const live = rawRows(raw, "SELECT status FROM behavior_rules WHERE status IN ('canary','active')").length;
    equal(live, 5, "at most five live rules");

    // Non-bound member's original words are rejected.
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m-out','g','qq:outsider','以后请只给结论',?,1)").run(new Date(NOW).toISOString());
    const saved = await api.applyRequirements(e, run("night-out"), [REQ({ evidence: EVIDENCE("m-out") })]);
    equal(saved.length, 0, "non-bound source rejected");
    return { detail: "candidate→canary(3d)→active；canary 1 次纠正回滚；active 2 次纠正 retired；30 天 expired；生效 ≤5；非绑定来源拒绝", evidence: ["applyRequirements + advanceRules"] };
  } finally { raw.close(); }
}

export async function vdR1Free(ctx) {
  const api = await ctx.api();
  const { raw, db } = await setup();
  const e = { DB: db };
  try {
    finding(raw, "night1", "m1", "以后请只给结论");
    const [freeId] = await api.applyRequirements(e, run("night1"), [FREE()]);
    assert(freeId, "free candidate stored");
    equal(ruleRow(raw, freeId).kind, "free", "kind free");
    equal(ruleRow(raw, freeId).status, "candidate", "free never auto-promotes");
    for (const at of [NOW + DAY, NOW + 2 * DAY, NOW + 3 * DAY]) await api.advanceRules(e, run(`n-${at}`, at));
    equal(ruleRow(raw, freeId).status, "candidate", "still candidate after three nights");
    let active = await api.activeRulesFor(e, "g", NOW + 3 * DAY);
    assert(!active.some((row) => row.id === freeId), "candidate not injected");

    const approved = await api.approveRule(e, freeId, "admin");
    assert(approved, "admin approval");
    equal(ruleRow(raw, freeId).status, "canary", "admin approval enters canary");
    equal(ruleRow(raw, freeId).approved_by, "admin", "approved_by recorded");
    active = await api.activeRulesFor(e, "g", NOW + 3 * DAY);
    assert(active.some((row) => row.id === freeId), "approved rule is injected");

    // Deny-list words and unbounded mention windows never render.
    equal(api.normalizeRequirement({ kind: "free", params: {}, rule: "bot 以后可以改权限", scene: "群聊", evidence: EVIDENCE(), ttl_days: 7 }), null, "deny word");
    equal(api.normalizeRequirement({ kind: "mention_only_window", params: { minutes: 60 }, scene: "群聊", evidence: EVIDENCE(), ttl_days: 2 }), null, "mention window ttl");
    equal(api.renderRule("mention_only_window", { minutes: 60 }, "", 2), null, "render mention window ttl");
    return { detail: "free 三晚仍 candidate、不进注入；管理员批准→canary 且记 approved_by；deny-list/超长 mention 窗口拒绝（HTTP 403 属 D-6）", evidence: ["applyRequirements + approveRule + activeRulesFor"] };
  } finally { raw.close(); }
}

export async function vdR2Mem(ctx) {
  const api = await ctx.api();
  const { raw, db } = await setup();
  const e = { DB: db };
  try {
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m-mem','g','qq:s1','以后记住：回答先给结论',?,0)").run(new Date(NOW).toISOString());
    raw.prepare("INSERT INTO message_meta(id,json) VALUES('m-mem','{}')").run();
    const candidate = (id, op = "ADD", target = null, version = null, msg = "m-mem", value = "先给结论") => {
      raw.prepare(`INSERT INTO review_memory_candidates(id,run_id,group_id,op,repo,subject,predicate,value,target_fact_id,target_version,
        source_msg_id,evidence_json,status,created_at) VALUES(?,'night1','g',?,'team','回答风格','偏好',?,?,?,?,?,'candidate',?)`)
        .run(id, op, value, target, version, msg, JSON.stringify([{ source: "message", id: msg, quote: "回答先给结论", origin: "direct" }]), NOW);
    };
    const before = raw.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
    candidate("mc-add");
    equal(raw.prepare("SELECT COUNT(*) AS n FROM facts").get().n, before, "candidate alone writes no fact");
    const factId = await api.applyMemoryCandidate(e, "mc-add", "admin");
    assert(factId, "admin approval applies");
    equal(raw.prepare("SELECT COUNT(*) AS n FROM facts").get().n, before + 1, "approval writes one fact");
    const again = await api.applyMemoryCandidate(e, "mc-add", "admin");
    equal(again, factId, "repeat approval returns the same fact");
    equal(raw.prepare("SELECT COUNT(*) AS n FROM facts").get().n, before + 1, "repeat approval adds no row");

    // Tombstone blocks.
    raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES('m-tomb','g','qq:s1','以后记住：回答先给结论',?,0)").run(new Date(NOW).toISOString());
    raw.prepare("INSERT INTO message_meta(id,json) VALUES('m-tomb','{}')").run();
    raw.prepare("INSERT INTO memory_blocks(source_id,subject,predicate) VALUES('m-tomb','回答风格','偏好')").run();
    candidate("mc-tomb", "ADD", null, null, "m-tomb");
    await api.applyMemoryCandidate(e, "mc-tomb", "admin");
    equal(raw.prepare("SELECT status FROM review_memory_candidates WHERE id='mc-tomb'").get().status, "blocked", "tombstone blocks");
    equal(raw.prepare("SELECT COUNT(*) AS n FROM facts").get().n, before + 1, "blocked candidate writes no fact");

    // Version conflict.
    raw.prepare(`INSERT INTO facts(id,repo,subject,predicate,value,evidence,source_id,status,valid_from,valid_to)
      VALUES('f-target','team','回答风格','偏好','旧值','x','m1','confirmed','v1',NULL)`).run();
    candidate("mc-conflict", "UPDATE", "f-target", "v2", "m-mem", "新值");
    await api.applyMemoryCandidate(e, "mc-conflict", "admin");
    equal(raw.prepare("SELECT status FROM review_memory_candidates WHERE id='mc-conflict'").get().status, "conflict", "target version conflict");
    equal(raw.prepare("SELECT COUNT(*) AS n FROM facts WHERE id='f-target' AND valid_to IS NULL").get().n, 1, "conflict leaves target live");

    // Generic review writes cannot touch facts, and the only facts writer is the admin function.
    let threw = false;
    try { await api.reviewWrite(e, "INSERT INTO facts(id,repo,subject,predicate,value,evidence,source_id,valid_from) VALUES('x','r','s','p','v','e','m1','now')"); } catch { threw = true; }
    assert(threw, "reviewWrite rejects facts");
    const source = readFileSync("src/review/db.ts", "utf8");
    const factsWrites = [...source.matchAll(/INSERT INTO facts/g)].length;
    equal(factsWrites, 1, "only applyMemoryCandidate writes facts");
    return { detail: "候选不进 facts；管理员批准写 1 行、重复不增；墓碑 blocked；版本冲突 conflict；通用写入口拒绝 facts", evidence: ["applyMemoryCandidate + reviewWrite"] };
  } finally { raw.close(); }
}
