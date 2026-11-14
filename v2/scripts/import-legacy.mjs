// One-time import of the old history into the new Hub. Usage:
//   node scripts/import-legacy.mjs <history.json> <secrets.json> [base-url]
import fs from "node:fs";
import { loadLegacy } from "./legacy.mjs";

const [file, secretFile, base = "https://teamagent.inkboard-server.workers.dev"] = process.argv.slice(2);
const token = JSON.parse(fs.readFileSync(secretFile, "utf8")).ADMIN_TOKEN;
const team = JSON.parse(fs.readFileSync(new URL("../../config/team.json", import.meta.url), "utf8"));
const { conv, rows, facts, settings } = loadLegacy(file);
const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(path + " " + r.status + " " + t.slice(0, 300));
  return JSON.parse(t);
};
const seed = [
  "【项目】（旧系统迁移过来的底稿）",
  ...team.repositories.map(repo => "· " + repo + "：群里也叫 " + (team.project_aliases[repo] || []).join("、")),
  "",
  "【旧系统记下的事实】",
  ...facts.map(f => "· " + [f.repo !== "team" ? f.repo : "", f.subject, f.predicate, f.value].filter(Boolean).join(" ")),
  "",
  ...settings.filter(s => s.key !== "group_id").map(s => "【旧系统的自述】" + s.value),
].join("\n");
let inserted = 0;
for (let i = 0; i < rows.length; i += 200) {
  const last = i + 200 >= rows.length;
  const r = await post("/admin/import", { conv, rows: rows.slice(i, i + 200), main: true, ...(i === 0 ? { memory: seed } : {}), ...(last ? { cursorToEnd: true } : {}) });
  inserted += r.inserted;
}
console.log("conv", conv.slice(0, 8) + "…", "rows", rows.length, "inserted", inserted, "seed chars", seed.length);
