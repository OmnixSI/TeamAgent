import { readFileSync } from "node:fs";
import { transform } from "esbuild";
await transform(
  readFileSync(new URL("../web/app.js", import.meta.url), "utf8"),
  { loader: "js" },
);
console.log("UI JavaScript parses");
