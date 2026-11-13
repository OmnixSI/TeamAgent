// Review P1 regression: a real tool kill switch (off:<tool.switch||name>) must flip the card to "switched_off".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/self-card.generated.ts", import.meta.url), "utf8");
const card = eval("(" + src.slice(src.indexOf("= {") + 2, src.lastIndexOf("}") + 1) + ")");
for (const [cap, sw] of [["image_generation","generate_image"],["history_search","search_history"],["knowledge_base","search_kb"],["episode_memory","recall_episode"],["chat_summary","summarize_chat"]])
  test(`card lists real tool switch ${sw} on ${cap}`, () => {
    assert.ok(card.capabilities.find((c) => c.id === cap).switches.includes(sw));
  });
