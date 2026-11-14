import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { validateTeamConfig } from "../config/validate.mjs";
const settings = JSON.parse(
  readFileSync(new URL("../config/team.json", import.meta.url), "utf8"),
);
await build({
  entryPoints: ["src/config.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/config-routing.mjs",
});
const { modelSettings } = await import("../.wrangler/config-routing.mjs");
test("shared settings reject unsupported effort, unsafe night batches and malformed project configuration", () => {
  assert.deepEqual(validateTeamConfig(settings), []);
  const bad = structuredClone(settings);
  bad.model.quick_effort = "guess";
  bad.memory.messages_per_batch = 121;
  bad.memory.timezone = "NoSuch/Zone";
  bad.repositories = ["outside/project"];
  bad.web = { jina: "yes" };
  bad.vision.turn_max = 5;
  const errors = validateTeamConfig(bad);
  assert.ok(errors.includes("model.quick_effort"));
  assert.ok(errors.some((x) => x.startsWith("memory.messages_per_batch")));
  assert.ok(errors.includes("memory.timezone"));
  assert.ok(errors.includes("repositories"));
  assert.ok(errors.includes("web.jina"));
  assert.ok(errors.includes("vision.turn_max"));
});
test("worker routing reads the same default model, per-kind effort and timeout settings", () => {
  assert.equal(
    modelSettings("voice", "high", 1).effort,
    settings.model.effort_by_kind.voice,
  );
  assert.equal(
    modelSettings("important-proposal", "max", 1).effort,
    settings.model.important_effort,
  );
  assert.equal(
    modelSettings("plain-file", "high", 1).effort,
    settings.model.quick_effort,
  );
  assert.equal(
    modelSettings("voice", "high", 1).timeout,
    settings.model.timeouts_ms.voice,
  );
  assert.equal(modelSettings("voice", "high", 1).model, settings.model.name);
});
test('rhythm settings validate debounce seconds and positive timing thresholds',()=>{
  assert.deepEqual(validateTeamConfig(settings),[]);
  for(const [key,value] of [['mention',11],['idle',-1],['busy','3'],['cap_ms',0],['hard_humans',0]]){
    const bad=structuredClone(settings);bad.rhythm[key]=value;
    assert.ok(validateTeamConfig(bad).includes('rhythm.'+key),key);
  }
  const bad=structuredClone(settings);bad.rhythm.wait_min=40;bad.rhythm.wait_max=10;
  assert.ok(validateTeamConfig(bad).some(x=>x.startsWith('rhythm.wait_min')));
});
