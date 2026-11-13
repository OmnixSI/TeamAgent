/**
 * SK self-knowledge card: shape of the build-time generated card (src/self-card.generated.ts,
 * produced by scripts/gen-self-card.mjs) and of the live state merged in at runtime.
 * Interface is frozen for the SK release: SK-1 (generator) emits it, SK-2 (runtime) reads it.
 * The card holds NAMES only (env var names, switch names). Never values of keys, tokens or secrets.
 */
export const SELF_CARD_SCHEMA = 1;

export interface SelfRef { path: string; line?: number; role?: string }

export interface SelfProvider {
  /** what this vendor does for the capability, e.g. "生成图片" */
  role: string;
  /** display vendor: DeepSeek | OpenAI | Luna | X-ASR | Cloudflare | GitHub ... */
  vendor: string;
  /** model id as found in code at build time (verified by the generator), if the call names one */
  model?: string;
  /** API host as found in code, e.g. api.openai.com; absent for local components */
  host?: string;
  /** where the generator saw it */
  evidence: SelfRef[];
}

export interface SelfCapability {
  id: string;                       // snake_case, unique: image_generation
  title: string;                    // 生图
  /** words members use for it, used for question matching */
  aliases: string[];
  /** tool names the model can call for it (may be empty for background features) */
  tools: string[];
  /** hand-written one-sentence "how it works" chain from config/self-manifest.json */
  how: string;
  providers: SelfProvider[];
  files: SelfRef[];                 // key files with line anchors resolved at build time
  /** admin kill switches (settings key without the leading "off:") */
  switches: string[];
  /** env/secret NAMES the capability needs (never values) */
  requires_env: string[];
  runs_on: "cloud" | "local" | "both";
  /** the local part, if any: runner script / service name */
  local_component?: string;
  /** limit text with numbers extracted from code, e.g. "每人每天 5 张" */
  limit?: string;
  /** "on": enabled unless a switch is set; "off_by_default": code exists but needs an explicit switch/config */
  default_state: "on" | "off_by_default";
}

export interface SelfVendor {
  vendor: string;
  used_for: string[];               // capability titles
  env_names: string[];              // e.g. ["DEEPSEEK_API_KEY"]
  /** where the key lives, no value: "Cloudflare Worker secret" | "本机 runner 的密钥文件" ... */
  key_location: string;
}

export interface SelfRepoMap {
  repo: string;                     // OmnixSI/TeamAgent (from config/team.json, never from git remote)
  top_dirs: { path: string; role: string }[];
  modules: { path: string; role: string; lines: number }[];   // src/*.ts, src/tools/*.ts, runner/*
  entrypoints: { kind: "fetch" | "queue" | "scheduled" | "runner" | "script"; path: string; symbol?: string; line?: number }[];
  tables: { name: string; migration: string }[];
  crons: string[];
  queues: string[];
  bindings: string[];               // binding NAMES: DB, WORK, CHAT, TOOLS, AI ...
}

export interface SelfCard {
  schema: typeof SELF_CARD_SCHEMA;
  /** git HEAD at build time; the runtime compares it with env.RELEASE */
  commit: string;
  built_at: string;                 // ISO
  capabilities: SelfCapability[];
  vendors: SelfVendor[];
  /** every registered tool: name, first sentence of description, switch name if any */
  tools: { name: string; desc: string; switch?: string }[];
  repo_map: SelfRepoMap;
}

/** Live state merged at runtime by src/self-card.ts, per capability id. */
export type SelfState =
  | "enabled"          // code deployed, no switch off, required env present
  | "switched_off"     // an off:<switch> setting is on
  | "not_configured"   // a required env binding is missing in this deployment
  | "off_by_default"   // code exists but default_state is off_by_default and not turned on
  | "local_unverified"; // depends on a local component whose liveness the cloud cannot confirm

export interface SelfLive {
  release: string;                  // env.RELEASE or "development"
  switches: Record<string, string | undefined>;
  envPresent: Record<string, boolean>;  // name -> bound? (boolean only)
}
