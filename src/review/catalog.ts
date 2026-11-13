// V-D 评判闭环 · 静态工具目录（D-2）
// 工具名手抄自 src/semantic.ts 的 agentAnswer 工具表（get_work_status … get_project）与
// src/repo.ts 的 repoTools（repo_changes / repo_commit / repo_file）；V-B 合入后由 capabilityCard() 接管。
// review 代码不得 import worker.ts / semantic.ts / tasks.ts / lanes.ts，所以这里不引用它们。
import type { Snapshot } from "./types";

export type CatalogTool = Snapshot["tools_catalog"][number];
export type ToolNeed = CatalogTool["needs"][number];

// readonly 与 src/authz.ts 的 WRITE_TOOLS 相反：写工具只有 create_file_task / prepare_project_task /
// remember_correction 三个。repo_* 一律 readonly，C8 的判定就靠这个字段（design 第 317 行）。
// needs 只标工具真正跑不起来缺的东西：私人仓库要 github_token，repo_* 还受 off:repo_tools 开关约束。
// runner 只影响本机索引新鲜度（快照 repo.cache_age_s），归 data_stale_or_coverage，不算 capability_offline。
export const TOOLS_CATALOG: CatalogTool[] = [
  { name: "get_work_status", readonly: true, needs: [] },
  { name: "remember_correction", readonly: false, needs: [] },
  { name: "recall_memory", readonly: true, needs: [] },
  { name: "create_file_task", readonly: false, needs: ["runner"] },
  { name: "prepare_project_task", readonly: false, needs: [] },
  { name: "search_web", readonly: true, needs: [] },
  { name: "read_web", readonly: true, needs: [] },
  { name: "get_project", readonly: true, needs: [] },
  { name: "repo_changes", readonly: true, needs: ["github_token", "switch"] },
  { name: "repo_commit", readonly: true, needs: ["github_token", "switch"] },
  { name: "repo_file", readonly: true, needs: ["github_token", "switch"] },
];

// capability（types.ts 的 CAPABILITIES 词表，另允许 other:<词>）→ 缺什么就用不了。
// 没写的 capability 返回 []，不猜。
const CAPABILITY_NEEDS: Record<string, ToolNeed[]> = {
  repo_visibility: ["github_token", "switch"],
  repo_read: ["github_token", "switch"],
  repo_disambiguation: ["github_token", "switch"],
  bili_video: ["switch"],
  bili_shortlink: ["switch"],
  ci_logs: ["github_token"],
};

// 开关名只能取自 src/rhythm.ts 的 SWITCH_KEYS（review 不 import rhythm，测试用例校验成员关系）。
const CAPABILITY_SWITCHES: Record<string, string[]> = {
  repo_visibility: ["off:repo_tools"],
  repo_read: ["off:repo_tools"],
  repo_disambiguation: ["off:repo_tools"],
  bili_video: ["auth:bili"],
  bili_shortlink: ["auth:bili"],
};

export function capabilityNeeds(capability: string): ToolNeed[] {
  return [...(CAPABILITY_NEEDS[capability] ?? [])];
}

export function switchKeysFor(capability: string): string[] {
  return [...(CAPABILITY_SWITCHES[capability] ?? [])];
}
