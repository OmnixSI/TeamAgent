export function validateTeamConfig(c) {
  const errors = [],
    check = (ok, path) => {
      if (!ok) errors.push(path);
    };
  const effort = (x) => ["none", "low", "high", "max"].includes(x);
  const integer = (x, a, b) => Number.isInteger(x) && x >= a && x <= b;
  check(
    ["deepseek-flash", "deepseek-v4-pro"].includes(c?.model?.name),
    "model.name",
  );
  check(effort(c?.model?.quick_effort), "model.quick_effort");
  check(effort(c?.model?.important_effort), "model.important_effort");
  check(
    c?.model?.effort_by_kind &&
      Object.values(c.model.effort_by_kind).every(effort),
    "model.effort_by_kind",
  );
  check(
    c?.model?.timeouts_ms &&
      Object.values(c.model.timeouts_ms).every((x) => integer(x, 1000, 540000)),
    "model.timeouts_ms",
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone: c?.memory?.timezone });
    check(!!c?.memory?.timezone, "memory.timezone");
  } catch {
    check(false, "memory.timezone");
  }
  for (const key of ["start_hour", "end_hour"])
    check(integer(c?.memory?.[key], 0, 23), "memory." + key);
  check(
    c?.memory?.start_hour < c?.memory?.end_hour,
    "memory.start_hour < end_hour",
  );
  check(integer(c?.memory?.quiet_minutes, 1, 180), "memory.quiet_minutes");
  check(
    integer(c?.memory?.batches_per_night, 1, 24),
    "memory.batches_per_night",
  );
  check(
    integer(c?.memory?.messages_per_batch, 1, 60),
    "memory.messages_per_batch <= 60 (D1 budget)",
  );
  check(typeof c?.scout?.enabled === "boolean", "scout.enabled");
  check(
    Array.isArray(c?.scout?.hours) &&
      c.scout.hours.every((x) => integer(x, 0, 23)),
    "scout.hours",
  );
  if (c?.web !== undefined) {
    check(
      c.web &&
        typeof c.web === "object" &&
        !Array.isArray(c.web) &&
        typeof c.web.jina === "boolean",
      "web.jina",
    );
  }
  if (c?.vision !== undefined) {
    check(
      c.vision &&
        typeof c.vision === "object" &&
        !Array.isArray(c.vision) &&
        typeof c.vision.enabled === "boolean",
      "vision.enabled",
    );
    check(integer(c?.vision?.daily_cap, 1, 10000), "vision.daily_cap");
    check(integer(c?.vision?.turn_max, 1, 3), "vision.turn_max");
    check(
      integer(c?.vision?.turn_deadline_ms, 1000, 120000),
      "vision.turn_deadline_ms",
    );
    check(
      typeof c?.vision?.prompt === "string" && !!c.vision.prompt.trim(),
      "vision.prompt",
    );
  }
  check(integer(c?.execution?.repair_rounds, 1, 5), "execution.repair_rounds");
  for (const key of [
    "code_timeout_seconds",
    "quick_file_timeout_seconds",
    "heavy_file_timeout_seconds",
  ])
    check(integer(c?.execution?.[key], 10, 7200), "execution." + key);
  check(
    Array.isArray(c?.repositories) &&
      c.repositories.length > 0 &&
      c.repositories.every((x) => /^OmnixSI\/[A-Za-z0-9_.-]+$/.test(x)) &&
      new Set(c.repositories).size === c.repositories.length,
    "repositories",
  );
  check(
    Array.isArray(c?.repositories) &&
      c?.project_aliases &&
      typeof c.project_aliases === "object" &&
      !Array.isArray(c.project_aliases) &&
      Object.entries(c.project_aliases).every(
        ([r, a]) =>
          c.repositories?.includes(r) &&
          Array.isArray(a) &&
          a.every((x) => typeof x === "string" && x.length > 0),
      ),
    "project_aliases",
  );
  check(
    !/\bsk-[A-Za-z0-9_-]{16,}\b/.test(JSON.stringify(c)),
    "shared API belongs in DEEPSEEK_API_KEY secret",
  );
  check(typeof c?.bili?.enabled === "boolean", "bili.enabled");
  check(integer(c?.bili?.wait_seconds, 1, 90), "bili.wait_seconds");
  check(typeof c?.bili?.media?.enabled === 'boolean', 'bili.media.enabled');
  for (const key of ['max_minutes','rtf','deadline_cap_minutes','mem_cap_mb','tmp_cap_mb'])
    check(Number.isFinite(c?.bili?.media?.[key]) && c.bili.media[key] > 0, 'bili.media.'+key);
  for (const key of ["mention", "image", "busy", "idle"])
    check(integer(c?.rhythm?.[key], 0, 10), "rhythm." + key);
  for (const [key, max] of Object.entries({cap_ms:60000, wait_min:45, wait_max:45, wait_horizon_ms:600000, hard_window_ms:86400000, hard_humans:100}))
    check(integer(c?.rhythm?.[key], 1, max), "rhythm." + key);
  check(c?.rhythm?.wait_min <= c?.rhythm?.wait_max, "rhythm.wait_min <= wait_max");
  for (const key of ['enabled','collect','send_gif']) check(typeof c?.stickers?.[key] === 'boolean', 'stickers.'+key);
  // send is deliberately fail-closed at runtime: only literal true enables it.
  for (const [key,max] of Object.entries({min_senders:5,max_bytes:400000,max_rows:1000})) check(integer(c?.stickers?.[key],key==='min_senders'?2:1,max),'stickers.'+key);
  for (const [key,max] of Object.entries({tag:40,send:20})) check(integer(c?.stickers?.caps?.[key],1,max),'stickers.caps.'+key);
  errors.push(...validateMcpServers(c?.mcp_servers));
  return errors;
}


// MCP is opt-in. Each configured endpoint and group is an explicit administrator allowlist.
function validateMcpServers(servers) {
  if (servers === undefined) return [];
  const errors = [], seen = new Set();
  if (!Array.isArray(servers) || servers.length > 8) return ['mcp_servers'];
  for (const [i, server] of servers.entries()) {
    const path = 'mcp_servers.' + i;
    if (!server || typeof server !== 'object' || Array.isArray(server)) { errors.push(path); continue; }
    const check = (ok, key) => { if (!ok) errors.push(path + '.' + key); };
    check(typeof server.name === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(server.name) && !seen.has(server.name), 'name');
    seen.add(server.name);
    check(server.transport === 'streamable-http', 'transport');
    check(typeof server.enabled === 'boolean', 'enabled');
    let urlOK = false;
    try {
      const url = new URL(server.url);
      urlOK = typeof server.url === 'string' && server.url.length <= 2048 && !url.username && !url.password && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname)));
    } catch {}
    check(urlOK, 'url');
    check(Array.isArray(server.allow_tools) && server.allow_tools.length > 0 && server.allow_tools.length <= 32 &&
      new Set(server.allow_tools).size === server.allow_tools.length && server.allow_tools.every(x => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(x)), 'allow_tools');
    check(Array.isArray(server.group_ids) && server.group_ids.length > 0 && server.group_ids.length <= 100 &&
      server.group_ids.every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 128), 'group_ids');
    check(server.timeout_ms === undefined || (Number.isInteger(server.timeout_ms) && server.timeout_ms >= 1 && server.timeout_ms <= 15000), 'timeout_ms');
    check(Object.keys(server).every(x => ['name','transport','url','enabled','allow_tools','group_ids','timeout_ms'].includes(x)), 'fields');
  }
  return errors;
}
