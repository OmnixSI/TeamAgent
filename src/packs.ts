// Tool packs for the cloud computer: sets of programs that are too big to install on every wake-up, so
// each is installed once, cached in R2 and restored only by the runs that ask for it.
export type Pack = {
  /** Chinese, one line: what is in it. */
  what: string;
  /** Bash that installs it on a machine that already has the base tools. */
  install: string;
  /** A command that succeeds when the pack is already present. */
  check: string;
};
export const PACKS: Record<string, Pack> = {};
