/**
 * SK-2 self-knowledge runtime: merge the build-time card with live state and render
 * the answers describe_self returns.
 *
 * The card itself is generated at build time by SK-1 (src/self-card.generated.ts,
 * gitignored). Its shape is frozen in src/self-card-types.ts. Everything here except
 * readLive is a pure function, so tests inject test/fixtures/self-card.sample.json.
 *
 * Secret rule: this module keeps env NAMES only. envPresent holds booleans, never the
 * bound value, and every rendered answer is passed through repo.redactPatch as a last
 * line of defence.
 */
import { redactPatch } from "./repo";
import type { SelfCapability, SelfCard, SelfLive, SelfState } from "./self-card-types";
import { SELF_CARD } from "./self-card.generated";

export const SELF_TOPICS = ["overview", "capability", "vendors", "repo_map", "switches"] as const;
export type SelfTopic = (typeof SELF_TOPICS)[number];

/** Any single rendered segment stays at or below this many characters. */
export const SEGMENT_MAX = 1800;
/** The overview has its own, tighter budget (design.md §3). */
export const OVERVIEW_MAX = 1500;
/** The prompt summary is injected into every model request, so it stays small. */
export const SUMMARY_MAX = 400;
const MATCH_MAX = 3;
const MODULE_MAX = 25;
const CLIP_NOTE = "（本段超过上限，已截断）";

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function sha7(value: unknown): string {
  return text(value, "unknown").slice(0, 7);
}

/** Same rule as toolkit.toolSwitchedOff: empty/0/false means the switch is not off. */
function switchOff(value: string | undefined): boolean {
  return value !== undefined && String(value).length > 0 && value !== "0" && value !== "false";
}

/** True when the admin kill switch `off:<name>` is set for this live state. */
export function isSwitchOff(live: SelfLive, name: string): boolean {
  return switchOff(live?.switches?.["off:" + name]);
}

/** Every env NAME the card says a capability needs (deduplicated, order kept). */
export function envNames(card: SelfCard): string[] {
  const names = new Set<string>();
  for (const cap of card.capabilities || [])
    for (const name of cap.requires_env || []) if (name) names.add(String(name));
  return [...names];
}

/**
 * One D1 read of the admin switches plus the boolean env-binding map.
 * `release` defaults to env.RELEASE; `card` exists for tests and defaults to the
 * generated card, because the env names to probe live on the card.
 */
export async function readLive(
  e: any,
  release?: string,
  card: SelfCard = SELF_CARD,
): Promise<SelfLive> {
  const switches: Record<string, string | undefined> = {};
  const preloaded = e?.selfSwitches;
  if (preloaded && typeof preloaded === "object") {
    // rhythm.loadSwitches already reads every off:* row in the turn's existing query;
    // reusing it keeps the D1 budget of a turn unchanged.
    for (const [key, value] of Object.entries(preloaded))
      switches[key] = value === undefined || value === null ? "" : String(value);
  } else if (e?.DB?.prepare) {
    const rows = await e.DB.prepare(
      "SELECT key,value FROM settings WHERE key LIKE 'off:%'",
    ).all();
    for (const row of rows?.results || []) {
      const key = text(row?.key);
      if (!key) continue;
      switches[key] = row?.value === null || row?.value === undefined ? "" : String(row.value);
    }
  }
  const envPresent: Record<string, boolean> = {};
  for (const name of envNames(card)) envPresent[name] = !!e?.[name];
  return {
    release: text(release) || text(e?.RELEASE, "development"),
    switches,
    envPresent,
  };
}

function explicitlyOn(cap: SelfCapability, live: SelfLive): boolean {
  // The frozen data model carries kill switches only. An admin who turns an
  // off-by-default capability on leaves its switch row explicitly at 0/false;
  // a capability with no switch cannot be turned on this way.
  return (cap.switches || []).some((name) => {
    const value = live?.switches?.["off:" + name];
    return value !== undefined && !switchOff(value);
  });
}

/** Truthful state of one capability in this deployment. */
export function capabilityState(
  cap: SelfCapability,
  live: SelfLive,
): { state: SelfState; reason: string } {
  const off = (cap.switches || []).filter((name) => isSwitchOff(live, name));
  if (off.length) return { state: "switched_off", reason: `开关 ${off.join("、")} 已关闭` };
  const missing = (cap.requires_env || []).filter((name) => !live?.envPresent?.[name]);
  if (missing.length) return { state: "not_configured", reason: `未配置环境变量 ${missing.join("、")}` };
  if (cap.default_state === "off_by_default" && !explicitlyOn(cap, live))
    return { state: "off_by_default", reason: "默认关闭，需要管理员显式开启" };
  if (cap.runs_on === "local" || cap.runs_on === "both")
    return { state: "local_unverified", reason: "依赖本机服务，云端无法确认它此刻在线" };
  return { state: "enabled", reason: "已启用" };
}

function stateText(state: SelfState, reason: string): string {
  switch (state) {
    case "switched_off": return `当前已关闭（${reason}）`;
    case "not_configured": return `已写好未启用（${reason}）`;
    case "off_by_default": return `已写好未启用（${reason}）`;
    case "local_unverified": return `本机运行，状态未核实（${reason}）`;
    default: return "已启用";
  }
}

function whereText(cap: SelfCapability): string {
  if (cap.runs_on === "local") return "本机";
  if (cap.runs_on === "both") return "云端+本机";
  return "云端";
}

function vendorText(cap: SelfCapability): string {
  const vendors = (cap.providers || [])
    .map((p) => text(p.vendor) + (text(p.model) ? " " + text(p.model) : ""))
    .filter(Boolean);
  return vendors.length ? vendors.join("、") : "未登记厂商";
}

function clip(value: string, max: number, note = CLIP_NOTE): string {
  const chars = [...value];
  if (chars.length <= max) return chars.join("");
  const suffix = "…" + note;
  return chars.slice(0, Math.max(1, max - [...suffix].length)).join("") + suffix;
}

function header(card: SelfCard, live: SelfLive): string[] {
  const lines = [`自知卡 ${sha7(card.commit)}｜线上 ${sha7(live.release)}`];
  if (text(live.release) && live.release !== "development" && sha7(card.commit) !== sha7(live.release))
    lines.push("注意：自知卡版本与线上不一致，细节以 repo_file 读到的代码为准");
  return lines;
}

function overview(card: SelfCard, live: SelfLive): string {
  const caps = card.capabilities || [];
  const rows = caps.map((cap) => {
    const st = capabilityState(cap, live);
    return `- ${cap.title}：${vendorText(cap)} / ${whereText(cap)} / ${stateText(st.state, st.reason)}`;
  });
  return [`能力总览（${caps.length} 个）：`, ...rows].join("\n");
}

function matchCapabilities(card: SelfCard, query?: string): SelfCapability[] {
  const q = text(query).toLowerCase();
  if (!q) return [];
  const hits: SelfCapability[] = [];
  for (const cap of card.capabilities || []) {
    const fields = [
      cap.id,
      cap.title,
      ...(cap.aliases || []),
      ...(cap.tools || []),
      ...(cap.providers || []).flatMap((p) => [p.vendor, p.model]),
    ]
      .map((f) => text(f).toLowerCase())
      .filter((f) => f.length >= 2);
    if (fields.some((f) => f.includes(q) || q.includes(f))) hits.push(cap);
  }
  return hits.slice(0, MATCH_MAX);
}

function capabilityBlock(cap: SelfCapability, live: SelfLive): string {
  const st = capabilityState(cap, live);
  const providers = (cap.providers || [])
    .map((p) =>
      text(p.vendor) +
      (text(p.model) ? " " + text(p.model) : "") +
      (text(p.host) ? `（主机 ${text(p.host)}）` : ""),
    )
    .filter(Boolean)
    .join("、") || "未登记厂商";
  const files = (cap.files || [])
    .map((f) => text(f.path) + (f.line ? ":" + f.line : "") + (text(f.role) ? `（${text(f.role)}）` : ""))
    .filter(Boolean)
    .join("；") || "未登记关键文件";
  const switches = (cap.switches || [])
    .map((name) => `${name}（${isSwitchOff(live, name) ? "已关闭" : "开启"}）`)
    .join("、") || "无";
  const envs = (cap.requires_env || [])
    .map((name) => `${name}（${live?.envPresent?.[name] ? "已绑定" : "未绑定"}）`)
    .join("、") || "无";
  return [
    `【${cap.title}】（${cap.id}）`,
    `怎么实现：${text(cap.how, "卡里没有写实现链路")}`,
    `厂商：${providers}`,
    `关键文件：${files}`,
    `开关：${switches}`,
    `环境变量：${envs}`,
    `运行位置：${whereText(cap)}`,
    `限额：${text(cap.limit, "未登记限额")}`,
    `状态：${stateText(st.state, st.reason)}`,
  ].join("\n");
}

function capability(card: SelfCard, live: SelfLive, query?: string): string {
  const titles = (card.capabilities || []).map((c) => c.title).join("、");
  const q = text(query);
  if (!q) return `capability 需要 query（能力名、别名、工具名或关键词）。现有能力：${titles}`;
  const hits = matchCapabilities(card, q);
  if (!hits.length) return `自知卡里没有这个能力。\n现有能力：${titles}`;
  return hits.map((cap) => clip(capabilityBlock(cap, live), SEGMENT_MAX)).join("\n\n");
}

function vendorState(card: SelfCard, live: SelfLive, vendor: string, usedFor: string[]): string {
  const caps = (card.capabilities || []).filter(
    (cap) =>
      usedFor.includes(cap.title) ||
      (cap.providers || []).some((p) => text(p.vendor) === vendor),
  );
  const states = caps.map((cap) => capabilityState(cap, live).state);
  if (!states.length) return "未登记";
  if (states.includes("enabled")) return "已启用";
  if (states.includes("local_unverified")) return "本机运行，状态未核实";
  if (states.every((s) => s === "switched_off")) return "当前已关闭";
  return "已写好未启用";
}

function vendors(card: SelfCard, live: SelfLive): string {
  const rows = (card.vendors || []).map((v) => {
    const usedFor = v.used_for || [];
    return `- ${v.vendor}：用于 ${usedFor.join("、") || "未登记"}；环境变量 ${
      (v.env_names || []).join("、") || "无"
    }；密钥位置：${text(v.key_location, "未登记")}；状态：${vendorState(card, live, v.vendor, usedFor)}`;
  });
  return ["底层服务清单：", ...rows].join("\n");
}

const CORE_TABLES = ["members", "settings", "messages", "tasks", "facts", "jobs", "outbox"];
/** Core tables by name plus a count, so 50+ tables never crowd out cron/queue/binding lines. */
function tableSummary(tables: { name: string }[]): string {
  const names = [...new Set(tables.map((t) => t.name))];
  if (!names.length) return "未登记";
  const core = CORE_TABLES.filter((n) => names.includes(n));
  const rest = names.filter((n) => !core.includes(n));
  return `共 ${names.length} 张；核心：${core.join("、") || "（无）"}${rest.length ? `；另有 ${rest.length} 张（如 ${rest.slice(0, 6).join("、")} 等）` : ""}`;
}
function repoMap(card: SelfCard): string {
  const m = card.repo_map || ({} as SelfCard["repo_map"]);
  const modules = [...(m.modules || [])]
    .sort((a, b) => Number(b.lines || 0) - Number(a.lines || 0))
    .slice(0, MODULE_MAX)
    .map((mod) => `${mod.path}（${text(mod.role, "未登记")}，${Number(mod.lines) || 0} 行）`);
  const lines = [
    // The model's brief is squeezed into one short group message downstream; name the must-keep facts up front.
    "【必须保留】回答仓库怎么组成时，群里的话必须同时点到：数据表总数和核心表名、定时、队列、绑定、顶层目录和入口，别只讲目录。",
    `仓库：${text(m.repo, "未登记")}`,
    // Small, high-value facts first: the long directory/entry/module lists may be clipped, these must not be.
    `数据表：${tableSummary(m.tables || [])}`,
    `定时：${(m.crons || []).join("、") || "无"}`,
    `队列：${(m.queues || []).join("、") || "无"}`,
    `绑定：${(m.bindings || []).join("、") || "无"}`,
    `顶层目录：${(m.top_dirs || []).map((d) => `${d.path}（${text(d.role, "未登记")}）`).join("、") || "未登记"}`,
    `入口：${(m.entrypoints || []).map((p) => `${p.kind} ${p.path}${p.line ? ":" + p.line : ""}${text(p.symbol) && text(p.symbol) !== p.kind ? " " + text(p.symbol) : ""}`).join("、") || "未登记"}`,
    `具体代码用 repo_file 读 ${text(m.repo, "OmnixSI/TeamAgent")}，给文件和大致行号。`,
    // Last on purpose: when the segment is clipped only the long module list is lost.
    `关键模块（按行数前 ${MODULE_MAX}）：${modules.join("、") || "未登记"}`,
  ];
  return lines.join("\n");
}

function switches(card: SelfCard, live: SelfLive): string {
  const names = [...new Set((card.capabilities || []).flatMap((cap) => cap.switches || []))];
  if (!names.length) return "卡里没有登记开关。";
  const rows = names.map((name) => {
    const value = live?.switches?.["off:" + name];
    return isSwitchOff(live, name)
      ? `- ${name}：已关闭（off:${name}=${value}）`
      : `- ${name}：开启${value !== undefined ? `（off:${name}=${value}）` : ""}`;
  });
  return ["开关（卡里登记的）：", ...rows].join("\n");
}

/**
 * Render one answer. Header and the version warning are always present; every
 * rendered segment is bounded and the whole answer is redacted before it leaves.
 */
export function renderSelf(
  card: SelfCard,
  live: SelfLive,
  topic: SelfTopic | string,
  query?: string,
): string {
  const head = header(card, live).join("\n");
  const t = text(topic).toLowerCase();
  let body: string;
  if (t === "overview") return redactPatch(clip(head + "\n\n" + overview(card, live), OVERVIEW_MAX));
  if (t === "capability") {
    // Each matched capability is its own <=SEGMENT_MAX segment; up to MATCH_MAX of them.
    body = capability(card, live, query);
    return redactPatch(head + "\n\n" + body);
  }
  if (t === "vendors") body = vendors(card, live);
  else if (t === "repo_map") body = repoMap(card);
  else if (t === "switches") body = switches(card, live);
  else return redactPatch(`${head}\n\n不支持的 topic：${text(topic)}；可用：${SELF_TOPICS.join("、")}。`);
  return redactPatch(head + "\n\n" + clip(body, SEGMENT_MAX));
}

/** One-line vendor digest injected into the system prompt (≤400 chars). */
export function vendorSummary(card: SelfCard, live: SelfLive): string {
  const parts: string[] = [];
  for (const cap of card.capabilities || []) {
    const vendors = (cap.providers || [])
      .map((p) => text(p.vendor) + (text(p.model) ? " " + text(p.model) : ""))
      .filter(Boolean);
    if (!vendors.length) continue;
    const st = capabilityState(cap, live);
    const mark =
      st.state === "switched_off"
        ? "（当前已关闭）"
        : st.state === "local_unverified"
          ? "（本机运行，状态未核实）"
          : st.state === "enabled"
            ? ""
            : "（已写好未启用）";
    parts.push(`${cap.title}用 ${vendors.join("、")}${mark}`);
  }
  const line = `底层服务（自动生成，${sha7(card.commit)}）：${parts.join("；") || "卡里没有登记厂商"}`;
  return redactPatch(clip(line, SUMMARY_MAX));
}
