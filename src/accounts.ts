import { activity } from "./runtime";
export const digest = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export const normalizeName = (value: any) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
const json = (value: any, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const passwordHash = (e: any, password: string) =>
  digest(e.ADMIN_TOKEN + "\0name-login\0" + normalizeName(password));
export async function nameLogin(r: Request, e: any) {
  const b: any = await r.json(),
    password = normalizeName(b.password);
  if (!password || password.length > 100)
    return json({ error: "请输入你的成员名字" }, 401);
  const row = await e.DB.prepare(
    "SELECT m.id,m.name,m.revoked,p.password_hash FROM member_passwords p JOIN members m ON m.id=p.member_id WHERE p.login_name=?",
  )
    .bind(password)
    .first();
  if (!row || row.password_hash !== (await passwordHash(e, password)))
    return json({ error: "成员名字不匹配，请检查拼写" }, 401);
  if (row.revoked)
    return json({ error: "该成员访问已暂停，请联系 hongming" }, 403);
  const token = crypto.randomUUID() + crypto.randomUUID();
  await e.DB.prepare("INSERT INTO member_sessions VALUES(?,?,?,?)")
    .bind(await digest(token), row.id, Date.now(), Date.now() + 30 * 86400000)
    .run();
  return json({ token, who: { id: row.id, name: row.name, role: "member" } });
}
export async function provisionNames(e: any, b: any) {
  if (!Array.isArray(b.members) || b.members.length !== 3)
    return json({ error: "当前团队配置需要三名成员" }, 400);
  const names = b.members.map((m: any) => normalizeName(m.name));
  if (
    new Set(names).size !== 3 ||
    names.some((n: string) => !/^[a-z][a-z0-9_-]{1,39}$/.test(n))
  )
    return json({ error: "成员名字需互不相同" }, 400);
  const writes = [];
  for (const m of b.members) {
    const name = normalizeName(m.name),
      id = "name:" + name;
    if (normalizeName(m.password) !== name)
      return json({ error: "本团队按名字登录，口令应与成员名字一致" }, 400);
    writes.push(
      e.DB.prepare(
        "INSERT INTO members(id,name,token_hash,role) VALUES(?,?,?,'member') ON CONFLICT(id) DO UPDATE SET name=excluded.name,role='member'",
      ).bind(id, name, await digest(crypto.randomUUID() + crypto.randomUUID())),
    );
    writes.push(
      e.DB.prepare(
        "INSERT INTO member_passwords VALUES(?,?,?) ON CONFLICT(member_id) DO UPDATE SET login_name=excluded.login_name,password_hash=excluded.password_hash",
      ).bind(id, name, await passwordHash(e, name)),
    );
  }
  writes.push(
    e.DB.prepare(
      "INSERT INTO settings VALUES('auth_mode','names') ON CONFLICT(key) DO UPDATE SET value='names'",
    ),
  );
  await e.DB.batch(writes);
  await e.DB.prepare(
    "UPDATE tasks SET assignee='hongming' WHERE assignee='群主'",
  ).run();
  await activity(
    e,
    "members.configured",
    "team",
    "hongming",
    "三名成员的名字登录已配置",
  );
  return json({ ok: true, members: names });
}
export async function aiIdentity(e: any, hash: string) {
  const row = await e.DB.prepare(
    "SELECT m.id,m.name,'member' AS role,a.id AS key_id FROM ai_tokens a JOIN members m ON m.id=a.member_id WHERE a.token_hash=? AND a.revoked=0 AND a.expires>? AND m.revoked=0 AND EXISTS(SELECT 1 FROM member_passwords p WHERE p.member_id=m.id)",
  )
    .bind(hash, Date.now())
    .first();
  if (!row) return null;
  await e.DB.prepare(
    "UPDATE ai_tokens SET last_used=? WHERE id=? AND (last_used IS NULL OR last_used<?)",
  )
    .bind(Date.now(), row.key_id, Date.now() - 60000)
    .run();
  return { ...row, via: "ai" };
}
export function aiRouteAllowed(path: string, method: string) {
  if (method === "GET")
    return [
      "/api/team/tasks",
      "/api/team/task",
      "/api/team/source",
      "/api/team/project",
      "/api/team/state",
      "/api/team/guide",
    ].includes(path);
  return (
    method === "POST" &&
    [
      "/api/team/task/claim",
      "/api/team/task/report",
      "/api/team/task",
    ].includes(path)
  );
}
export async function tokenRoute(r: Request, e: any, who: any) {
  const member = who.id === "owner" ? "name:hongming" : who.id;
  if (who.via === "ai")
    return json({ error: "本机AI不能创建或管理访问凭证" }, 403);
  if (r.method === "GET")
    return json({
      tokens: (
        await e.DB.prepare(
          "SELECT id,label,created_at,expires,last_used,revoked FROM ai_tokens WHERE member_id=? ORDER BY created_at DESC",
        )
          .bind(member)
          .all()
      ).results,
    });
  const b: any = await r.json();
  if (r.method === "DELETE") {
    await e.DB.prepare(
      "UPDATE ai_tokens SET revoked=1 WHERE id=? AND member_id=?",
    )
      .bind(b.id, member)
      .run();
    await activity(e, "ai.revoked", b.id, who.name, "已撤销一把本机AI访问凭证");
    return json({ ok: true });
  }
  if (r.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (
    !(await e.DB.prepare(
      "SELECT member_id FROM member_passwords WHERE member_id=?",
    )
      .bind(member)
      .first())
  )
    return json({ error: "请先用成员名字登录" }, 403);
  const active = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM ai_tokens WHERE member_id=? AND revoked=0 AND expires>?",
  )
    .bind(member, Date.now())
    .first();
  if (active.n >= 10) return json({ error: "请先撤销不用的接入凭证" }, 409);
  const id = crypto.randomUUID(),
    token = "teamai_" + crypto.randomUUID() + crypto.randomUUID(),
    expires = Date.now() + 90 * 86400000;
  await e.DB.prepare(
    "INSERT INTO ai_tokens(id,member_id,label,token_hash,created_at,expires) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id,
      member,
      String(b.label || "本机AI").slice(0, 60),
      await digest(token),
      Date.now(),
      expires,
    )
    .run();
  await activity(e, "ai.created", id, who.name, "已创建本机AI访问凭证");
  return json({ id, token, expires });
}
