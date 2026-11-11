import { readFileSync } from "node:fs";
import { validateTeamConfig } from "../config/validate.mjs";
const config = JSON.parse(
  readFileSync(new URL("../config/team.json", import.meta.url), "utf8"),
);
const errors = validateTeamConfig(config);
for (const file of ["voice", "participation"]) {
  const c = JSON.parse(
    readFileSync(
      new URL("../config/" + file + ".json", import.meta.url),
      "utf8",
    ),
  );
  if (typeof c.text !== "string" || !c.text.trim() || c.text.length > 20000)
    errors.push(file + ".text");
}
if (errors.length) throw Error("配置校验失败: " + errors.join(", "));
console.log("Team config and prompts are valid");
