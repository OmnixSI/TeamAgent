import { readFileSync } from "node:fs";
import { request } from "./api.mjs";
const [command, id, version, status, file] = process.argv.slice(2);
try {
  let result;
  if (command === "list") result = await request("/api/team/tasks");
  else if (command === "show")
    result = await request("/api/team/task?id=" + encodeURIComponent(id));
  else if (command === "claim")
    result = await request("/api/team/task/claim", {
      id,
      version: Number(version),
    });
  else if (command === "report")
    result = await request("/api/team/task/report", {
      id,
      version: Number(version),
      status: status || "ready_for_review",
      result: readFileSync(file, "utf8"),
    });
  else
    throw Error(
      "用法：node clients/cli.mjs list | show ID | claim ID VERSION | report ID VERSION STATUS RESULT_FILE",
    );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
