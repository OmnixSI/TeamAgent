import { test } from "node:test";
import assert from "node:assert/strict";
import { env, req } from "./support.mjs";

const beat = (e, tools) =>
  req(
    e,
    "/api/runner/gateway-status",
    { connected: true, blocked: "", tools },
    "runner-secret",
  );

const pulse = async (e) => (await req(e, "/api/team/pulse")).json();

test("gateway status keeps the silk preflight error for the dashboard", async () => {
  const e = env();
  const response = await beat(e, {
    ffmpeg: { ok: true, path: "/opt/homebrew/bin/ffmpeg" },
    ffprobe: { ok: true, path: "/opt/homebrew/bin/ffprobe" },
    silk: {
      ok: false,
      error_kind: "tts_silk_missing",
      missing: "silk-wasm",
      error: "silk-wasm 未安装或无法加载：ERR_MODULE_NOT_FOUND",
    },
  });
  assert.equal(response.status, 200);
  const gateway = (await pulse(e)).connection.gateway;
  assert.equal(gateway.tools.silk.ok, false);
  assert.equal(gateway.tools.silk.error_kind, "tts_silk_missing");
  assert.equal(gateway.tools.silk.missing, "silk-wasm");
  assert.match(gateway.tools.silk.error, /silk-wasm/);
});

test("gateway status records a healthy silk preflight without an error", async () => {
  const e = env();
  await beat(e, {
    ffmpeg: { ok: true, path: "/opt/homebrew/bin/ffmpeg" },
    ffprobe: { ok: true, path: "/opt/homebrew/bin/ffprobe" },
    silk: { ok: true, path: "silk-wasm", error_kind: "", missing: "" },
  });
  const silk = (await pulse(e)).connection.gateway.tools.silk;
  assert.equal(silk.ok, true);
  assert.equal(silk.error_kind, undefined);
  assert.equal(silk.error, undefined);
});
