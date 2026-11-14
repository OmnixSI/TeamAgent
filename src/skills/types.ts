// A skill is a fixed, tested recipe that runs in the cloud computer: the chat model picks the skill and
// fills in its arguments, and the commands come from here rather than being written fresh each time.
// One file per skill in src/skills/, registered once in src/skills/index.ts.
export type SkillArgs = Record<string, any>;
/** An input file, already placed at ./in/<name> inside the run directory. */
export type SkillFile = { name: string };
export type Skill = {
  /** kebab-case id the model passes, e.g. "doc-to-pdf". */
  name: string;
  /** Short Chinese name, e.g. "文档转 PDF". */
  title: string;
  /** Chinese, for the chat model: when to pick this skill and what comes back. One or two sentences. */
  when: string;
  /** Arguments besides the files (JSON-schema-like). */
  args?: Record<string, { type: "string" | "number" | "integer" | "boolean" | "array"; description: string; enum?: string[]; items?: any }>;
  required?: string[];
  /** How many input files it takes and which extensions (lowercase, no dot); omit when it takes none. */
  files?: { min: number; max: number; extensions?: string[]; what?: string };
  /** Tool packs it needs in the cloud computer: names from src/packs.ts. */
  packs?: string[];
  /** Whole-run limit; default 300 seconds. */
  timeoutSeconds?: number;
  /**
   * The shell commands, run in order with bash inside the run directory: inputs are in ./in, results must be
   * written to ./out (everything there is handed back). Validate the arguments here and throw an Error with a
   * plain Chinese message when they are wrong. Anything that came from a person must go through `sh()`.
   */
  commands(args: SkillArgs, files: SkillFile[]): string[];
  /** Optional: facts for the model taken from what the commands printed (page counts, durations…). */
  report?(stdout: string[]): Record<string, any>;
};
/** Quotes a string for bash. */
export const sh = (s: unknown) => "'" + String(s).replace(/'/g, "'\\''") + "'";
