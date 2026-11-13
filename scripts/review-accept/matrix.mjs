// Matrix rendering is pure so tests can assert 76-row coverage without
// running the acceptance checks.
import { escapeCell } from "./harness.mjs";
import { ITEMS, RUNNABLE, BLOCKED } from "./registry.mjs";

export function renderMatrix(results, startedAt) {
  const lines = [
    "# V-D 验收矩阵（D-10a 生成）",
    "",
    `生成时间：${startedAt.toISOString()} · 共 ${results.length} 条 · runnable ${RUNNABLE.length} · blocked ${BLOCKED.length}`,
    "",
    "| id | 场景 | 状态 | 负责包 | 检查脚本 | 依赖/阻塞 | 需要的真实数据 | 证据/备注 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const result of results) {
    const item = result.item;
    const deps = result.status === "BLOCKED" ? `blocked_by:${result.blockedBy}` : `${item.packages}`;
    lines.push(`| ${result.id} | ${escapeCell(item.scenario)} | ${result.status}${result.preflight === "FAIL" ? " (preflight FAIL)" : ""} | ${escapeCell(item.packages)} | ${escapeCell(item.script)} | ${escapeCell(deps)} | ${escapeCell(item.data)} | ${escapeCell((result.detail || "").slice(0, 500))} |`);
  }
  const pass = results.filter((result) => result.status === "PASS").length;
  const fail = results.filter((result) => result.status === "FAIL").length;
  const blocked = results.filter((result) => result.status === "BLOCKED").length;
  const preflightFail = results.filter((result) => result.preflight === "FAIL").length;
  lines.push("", `汇总：PASS ${pass} · FAIL ${fail} · BLOCKED ${blocked}（preflight FAIL ${preflightFail}）`, "");
  return lines.join("\n");
}

export function matrixRows(markdown) {
  return markdown.split("\n").filter((line) => /^\| VD-/.test(line)).length;
}
