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
  return errors;
}
