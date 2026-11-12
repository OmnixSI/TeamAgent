import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverDeliveries, deliverFiles } from "../runner/delivery.mjs";
function fixture(staged = true) {
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
    assert.deepEqual(fs.readdirSync(f.queue), []);
    assert.deepEqual(fs.readdirSync(f.root), []);
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
    assert.deepEqual(fs.readdirSync(f.queue), []);
  } finally { f.clean(); }
});
test("failed before sending retries at most three times then cleans outputs and reports once", async () => {
  const f = fixture(), reports = []; let targets = 0, sends = 0;
  const options = {dir:f.queue,root:f.root,
    target:async()=>{targets++;throw Error("no target");},
    sendFile:async()=>{sends++;},report:async receipt=>reports.push(receipt)};
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await deliverFiles(options);
      assert.ok(fs.existsSync(f.file));
      assert.equal(JSON.parse(fs.readFileSync(f.manifest+'.failed')).attempts,attempt);
      assert.equal(reports.length,0);
    }
    await deliverFiles(options);
    assert.equal(targets,3);assert.equal(sends,0);
    assert.equal(reports.length,1);assert.equal(reports[0].status,'failed');assert.equal(reports[0].exhausted,true);
    assert.deepEqual(fs.readdirSync(f.queue),[]);assert.deepEqual(fs.readdirSync(f.root),[]);
    await deliverFiles(options);assert.equal(reports.length,1);assert.equal(targets,3);
  } finally {f.clean();}
});
test("unknown send is never repeated and expires after three maintenance rounds", async () => {
  const f = fixture(), reports = [];let sends=0;
  const options={dir:f.queue,root:f.root,target:async()=>({group_id:'G'}),
    sendFile:async()=>{sends++;throw Error('uncertain');},report:async receipt=>reports.push(receipt)};
  try {
    for (let round=1;round<=2;round++) {
      await deliverFiles(options);assert.ok(fs.existsSync(f.file));
      assert.equal(JSON.parse(fs.readFileSync(f.manifest+'.unknown')).attempts,round);
      assert.equal(reports.length,0);
    }
    await deliverFiles(options);assert.equal(sends,1);assert.equal(reports.length,1);
    assert.equal(reports[0].status,'unknown');assert.equal(reports[0].exhausted,true);
    assert.deepEqual(fs.readdirSync(f.queue),[]);assert.deepEqual(fs.readdirSync(f.root),[]);
  } finally {f.clean();}
});
test("a safe failure may succeed on the next attempt and leaves no terminal cache", async () => {
  const f=fixture(),reports=[];let targets=0,sends=0;
  const options={dir:f.queue,root:f.root,target:async()=>{if(++targets===1)throw Error('temporary target outage');return {group_id:'G'};},
    sendFile:async()=>{sends++;},report:async receipt=>reports.push(receipt)};
  try {
    await deliverFiles(options);await deliverFiles(options);
    assert.equal(targets,2);assert.equal(sends,1);assert.equal(reports.length,1);
    assert.equal(reports[0].status,'sent');assert.equal(reports[0].attempts,2);
    assert.deepEqual(fs.readdirSync(f.queue),[]);assert.deepEqual(fs.readdirSync(f.root),[]);
  } finally {f.clean();}
});
test("partial uncertain delivery never resends any file and removes all outputs at the limit", async () => {
  const f=fixture(),reports=[];let sends=0;
  try {
    const other=path.join(path.dirname(f.file),'second.csv');fs.writeFileSync(other,'second');
    const d=JSON.parse(fs.readFileSync(f.manifest));d.files.push(other);fs.writeFileSync(f.manifest,JSON.stringify(d));
    const options={dir:f.queue,root:f.root,target:async()=>({group_id:'G'}),
      sendFile:async()=>{if(++sends===2)throw Error('second file uncertain');},report:async receipt=>reports.push(receipt)};
    for(let i=0;i<3;i++)await deliverFiles(options);
    assert.equal(sends,2);assert.equal(reports.length,1);assert.equal(reports[0].sent_count,1);
    assert.equal(reports[0].status,'unknown');
    assert.deepEqual(fs.readdirSync(f.queue),[]);assert.deepEqual(fs.readdirSync(f.root),[]);
  } finally {f.clean();}
});
test("exhausted delivery keeps only its receipt until cloud acknowledgement, without more sends", async () => {
  const f=fixture();let targets=0,reports=0;
  const options={dir:f.queue,root:f.root,target:async()=>{targets++;throw Error('offline');},sendFile:async()=>assert.fail('no send'),
    report:async()=>{if(++reports===1)throw Error('cloud offline');}};
  try {
    for(let i=0;i<3;i++)await deliverFiles(options);
    assert.deepEqual(fs.readdirSync(f.root),[]);assert.ok(fs.existsSync(f.manifest+'.failed'));
    await deliverFiles(options);assert.equal(targets,3);assert.equal(reports,2);assert.deepEqual(fs.readdirSync(f.queue),[]);
  } finally {f.clean();}
});
test("already acknowledged terminal manifests are removed with their controlled outputs", async () => {
  for(const status of ['sent','failed','unknown']) {
    const f=fixture();
    try {
      const d=JSON.parse(fs.readFileSync(f.manifest));Object.assign(d,{status,reported:true,attempts:3});
      fs.writeFileSync(f.manifest+'.'+status,JSON.stringify(d));fs.unlinkSync(f.manifest);
      await deliverFiles({dir:f.queue,root:f.root,target:async()=>assert.fail('no target'),sendFile:async()=>assert.fail('no send'),report:async()=>assert.fail('already reported')});
      assert.deepEqual(fs.readdirSync(f.queue),[]);assert.deepEqual(fs.readdirSync(f.root),[]);
    } finally {f.clean();}
  }
});
test("a crash during SDK send becomes unknown and never resends", async () => {
  const f = fixture();
  let sends = 0;
  try {
    fs.renameSync(f.manifest, f.manifest + ".sending");
    recoverDeliveries(f.queue);
    const options = {
      dir: f.queue,
      root: f.root,
      target: async () => ({ group_id: "G" }),
      sendFile: async () => {
        sends++;
      },
      report: async (r) => assert.equal(r.status, "unknown"),
    };
    await deliverFiles(options);
    assert.equal(sends, 0);
    assert.ok(fs.existsSync(f.manifest + ".unknown"));
    await deliverFiles(options);
    assert.deepEqual(fs.readdirSync(f.queue),[]);assert.deepEqual(fs.readdirSync(f.root),[]);
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
    const options = {
      dir: f.queue,
      root: f.root,
      target: async () => ({ group_id: "G" }),
      sendFile: async () => {
        sends++;
      },
      report: async (r) => assert.equal(r.status, "failed"),
    };
    for(let i=0;i<3;i++)await deliverFiles(options);
    assert.equal(sends, 0);
    assert.ok(fs.existsSync(path.join(f.dir,'private.txt')),'never delete paths outside controlled spool');
    assert.deepEqual(fs.readdirSync(f.queue),[]);
  } finally {
    f.clean();
  }
});
