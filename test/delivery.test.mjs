import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverDeliveries, deliverFiles } from "../runner/delivery.mjs";
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-delivery-")),
    root = path.join(dir, "utility"),
    outputs = path.join(root, "job", "outputs"),
    queue = path.join(dir, "deliveries");
  fs.mkdirSync(outputs, { recursive: true });
  fs.mkdirSync(queue);
  const file = path.join(outputs, "实际成果.csv");
  fs.writeFileSync(file, "项目,数量\n大肥鱼,3");
  const manifest = path.join(queue, "one.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ id: "delivery-1", message: "source", files: [file] }),
  );
  return {
    dir,
    root,
    queue,
    manifest,
    clean() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("file success is sent once even when cloud receipt fails and the gateway restarts", async () => {
  const f = fixture();
  let sends = 0,
    receipts = 0;
  const options = {
    dir: f.queue,
    root: f.root,
    target: async () => ({ group_id: "G" }),
    sendFile: async () => {
      sends++;
    },
    report: async () => {
      if (++receipts === 1) throw Error("network");
    },
  };
  try {
    await deliverFiles(options);
    assert.equal(sends, 1);
    recoverDeliveries(f.queue);
    await deliverFiles(options);
    assert.equal(sends, 1);
    assert.equal(receipts, 2);
    assert.equal(
      JSON.parse(fs.readFileSync(f.manifest + ".sent")).reported,
      true,
    );
  } finally {
    f.clean();
  }
});
test("a crash during SDK send becomes unknown and never resends", async () => {
  const f = fixture();
  let sends = 0;
  try {
    fs.renameSync(f.manifest, f.manifest + ".sending");
    recoverDeliveries(f.queue);
    await deliverFiles({
      dir: f.queue,
      root: f.root,
      target: async () => ({ group_id: "G" }),
      sendFile: async () => {
        sends++;
      },
      report: async (r) => assert.equal(r.status, "unknown"),
    });
    assert.equal(sends, 0);
    assert.ok(fs.existsSync(f.manifest + ".unknown"));
  } finally {
    f.clean();
  }
});
test("outside-workspace files are rejected before any QQ send", async () => {
  const f = fixture();
  let sends = 0;
  try {
    fs.writeFileSync(
      f.manifest,
      JSON.stringify({
        id: "delivery-1",
        message: "source",
        files: [path.join(f.dir, "private.txt")],
      }),
    );
    fs.writeFileSync(path.join(f.dir, "private.txt"), "private");
    await deliverFiles({
      dir: f.queue,
      root: f.root,
      target: async () => ({ group_id: "G" }),
      sendFile: async () => {
        sends++;
      },
      report: async (r) => assert.equal(r.status, "failed"),
    });
    assert.equal(sends, 0);
  } finally {
    f.clean();
  }
});
