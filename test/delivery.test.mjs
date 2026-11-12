import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverDeliveries, deliverFiles } from "../runner/delivery.mjs";
function fixture(staged = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-delivery-")),
    root = path.join(dir, "utility"),
    outputs = path.join(root, ...(staged ? ["_deliveries", "a".repeat(32)] : ["job"]), "outputs"),
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
    file,
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
test("confirmed native send cleans staged outputs while its cloud receipt remains retryable", async () => {
  const f = fixture(true);
  let sends = 0, reports = 0;
  const options = {
    dir: f.queue, root: f.root, target: async () => ({ group_id: "G" }),
    sendFile: async (_group, file) => { assert.ok(fs.readFileSync(file, "utf8").includes("大肥鱼")); sends++; },
    report: async () => { if (++reports === 1) throw Error("report outage"); },
  };
  try {
    await deliverFiles(options);
    assert.equal(sends, 1);
    assert.ok(!fs.existsSync(f.file), "confirmed output must not remain cached");
    assert.ok(!fs.existsSync(path.dirname(path.dirname(f.file))), "empty controlled spool directory is removed");
    assert.ok(!JSON.parse(fs.readFileSync(f.manifest + ".sent")).reported);
    await deliverFiles(options);
    assert.equal(sends, 1, "retry cloud receipt only, with no access to deleted output");
    assert.equal(reports, 2);
    assert.equal(JSON.parse(fs.readFileSync(f.manifest + ".sent")).reported, true);
  } finally { f.clean(); }
});
test("failed or uncertain native sends preserve the unconfirmed staged artifact", async () => {
  for (const attempted of [false, true]) {
    const f = fixture(true);
    try {
      await deliverFiles({dir:f.queue,root:f.root,
        target:async()=>{if(!attempted)throw Error("no target");return {group_id:"G"};},
        sendFile:async()=>{throw Error("send outcome unknown");},report:async()=>{}});
      assert.ok(fs.existsSync(f.file));
      assert.ok(fs.existsSync(f.manifest + (attempted ? ".unknown" : ".failed")));
    } finally { f.clean(); }
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
