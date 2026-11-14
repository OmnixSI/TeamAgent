// Offline tests for the cloud computer's tool packs (src/packs.ts): names, layer naming, the setup
// decisions, ordering, the reported shape and the shell pieces the machine runs (checked with a local bash/awk).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const P = await import("../src/packs.ts");

describe("pack names", () => {
  test("nothing asked is no packs", () => {
    assert.deepEqual(P.pickPacks(undefined), []);
    assert.deepEqual(P.pickPacks(null), []);
    assert.deepEqual(P.pickPacks([]), []);
  });
  test("known names come back once each, in the order given", () => {
    assert.deepEqual(P.pickPacks(["ocr", "office", "ocr", " office "]), ["ocr", "office"]);
  });
  test("an unknown pack is an error that names it and lists the real ones", () => {
    assert.throws(() => P.pickPacks(["office", "photoshop"]), e => {
      assert.match(e.message, /没有叫“photoshop”的工具包/);
      assert.match(e.message, /office、ocr/);
      assert.doesNotMatch(e.message, /“office”/);
      return true;
    });
  });
  test("malformed names are refused, never looked up", () => {
    for (const bad of ["../office", "Office", "of fice", "constructor", "toString", "x".repeat(40)])
      assert.throws(() => P.pickPacks([bad]), /的工具包/, bad);
  });
  test("packs must be a list", () => {
    assert.throws(() => P.pickPacks("office"), /列表/);
  });
  test("the error text works with no packs defined", () => {
    assert.match(P.unknownPack(["x"], {}), /暂时没有/);
  });
});

describe("pack definitions", () => {
  test("office and ocr exist with Chinese descriptions, an install and a check", () => {
    for (const n of ["office", "ocr"]) {
      const p = P.PACKS[n];
      assert.ok(p, n);
      assert.match(p.what, /[一-鿿]/);
      assert.ok(p.install.length > 20 && p.check.length > 10);
    }
    assert.match(P.PACKS.office.install, /libreoffice-writer-nogui/);
    assert.match(P.PACKS.office.install, /typst/);
    assert.match(P.PACKS.office.install, /markitdown\[docx,pptx,xlsx,pdf\]/);
    assert.match(P.PACKS.ocr.install, /tesseract-ocr-chi-sim/);
    // TeX files must land outside /root/.cache, which layers leave out.
    assert.match(P.PACKS.tex.install, /XDG_CACHE_HOME=\/opt\/tex\/cache/);
    assert.match(P.PACK_SNAP, /-path \/root\/\.cache/);
  });
  test("every install, check and helper script is valid bash", () => {
    const scripts = [P.PACK_PREP, P.PACK_SNAP, P.PACK_LINK, P.PACK_MERGE, P.FINGERPRINT];
    for (const p of Object.values(P.PACKS)) scripts.push("set -e\n" + p.install, p.check);
    for (const s of scripts) execFileSync("bash", ["-n", "-c", s]);
  });
});

describe("layer names", () => {
  test("carry the pack name and a hash of its recipe", async () => {
    const a = await P.layerName("office");
    assert.match(a, /^pack-office-[0-9a-f]{16}\.tar\.zst$/);
    assert.equal(await P.layerName("office"), a);
    assert.notEqual(await P.layerName("ocr"), a);
  });
  test("a changed install gives a new name; a changed description or check does not", async () => {
    const base = { what: "x", install: "apt-get install -y foo", check: "true" };
    const a = await P.layerName("t", base);
    assert.notEqual(await P.layerName("t", { ...base, install: base.install + " bar" }), a);
    assert.equal(await P.layerName("t", { ...base, what: "y", check: "false" }), a);
  });
  test("fit the transfer route's single-segment names", async () => {
    for (const n of Object.keys(P.PACKS)) assert.match(await P.layerName(n), /^[\w\-][\w.\-]{0,119}$/);
  });
});

describe("setup decisions", () => {
  test("present, restore or install", () => {
    assert.equal(P.packPlan(true, true), "present");
    assert.equal(P.packPlan(true, false), "present");
    assert.equal(P.packPlan(false, true), "restore");
    assert.equal(P.packPlan(false, false), "install");
  });
  test("a failed restore falls back to installing", () => {
    assert.equal(P.afterPackRestore(true), "done");
    assert.equal(P.afterPackRestore(false), "install");
  });
  test("a layer is saved only from a clean install with a write link", () => {
    assert.equal(P.savePack(true, true, "https://x/put"), true);
    assert.equal(P.savePack(true, false, "https://x/put"), false);
    assert.equal(P.savePack(true, true, undefined), false);
    assert.equal(P.savePack(false, true, "https://x/put"), false);
  });
  test("several packs: installs first, then restores, each in the order asked; present ones need no work", () => {
    const names = ["a", "b", "c", "d", "e"];
    const plans = { a: "restore", b: "install", c: "present", d: "install", e: "restore" };
    assert.deepEqual(P.packOrder(names, plans), [
      { name: "b", plan: "install" }, { name: "d", plan: "install" },
      { name: "a", plan: "restore" }, { name: "e", plan: "restore" },
    ]);
    assert.deepEqual(P.packOrder(["a"], { a: "present" }), []);
  });
});

describe("result", () => {
  test("only setup, seconds and error reach the caller, for the packs asked", () => {
    const done = {
      office: { setup: "restored", seconds: 12.3, cpu: 9, bytes: 1 },
      ocr: { setup: "installed", seconds: 50, error: "存档没能恢复（x），重新装了一遍", drop: true, saved: true },
      other: { setup: "present", seconds: 0 },
    };
    assert.deepEqual(P.packReport(done, ["office", "ocr", "tex"]), {
      office: { setup: "restored", seconds: 12.3 },
      ocr: { setup: "installed", seconds: 50, error: "存档没能恢复（x），重新装了一遍" },
    });
  });
  test("a failed install names the pack", () => {
    const m = P.packFailure("ocr", "E: Unable to locate package tesseract-ocr-chi-sim\n");
    assert.match(m, /^工具包 ocr 没装上/);
    assert.match(m, /tesseract-ocr-chi-sim$/);
    assert.equal(P.packFailure("office"), "工具包 office 没装上，这次的命令没有跑");
  });
});

describe("dpkg records", () => {
  const stanza = (p, v, extra = "") => `Package: ${p}\nStatus: install ok installed\n${extra}Architecture: amd64\nVersion: ${v}\n`;
  const status = (...s) => s.join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
  const local = s => s.replaceAll("/var/lib/dpkg/status", dir + "/status").replaceAll("/var/lib/computer-packs", dir).replaceAll("/tmp/pack-", dir + "/pack-");
  const parse = t => t.split(/\n\n+/).filter(x => x.trim()).map(x => x.match(/^Package: (.*)$/m)[1] + "=" + x.match(/^Version: (.*)$/m)[1]);

  test("the snapshot keeps only the records the install added or changed", () => {
    fs.writeFileSync(dir + "/pack-x.status0", status(stanza("base", "1"), stanza("libc6", "2.41")));
    fs.writeFileSync(dir + "/status", status(stanza("base", "1"), stanza("libc6", "2.41"), stanza("tess", "5"), stanza("libtess", "5")));
    const awk = local(P.PACK_SNAP.split("\n").find(l => l.startsWith("awk -v RS=")));
    execFileSync("bash", ["-c", "set -- x; s=" + dir + "/pack-x; " + awk]);
    assert.deepEqual(parse(fs.readFileSync(dir + "/x.status", "utf8")), ["tess=5", "libtess=5"]);
  });
  test("restoring merges records in any order without losing either pack's", () => {
    fs.writeFileSync(dir + "/a.status", status(stanza("gs", "10"), stanza("lo", "25")));
    fs.writeFileSync(dir + "/b.status", status(stanza("gs", "10"), stanza("tess", "5")));
    const run = order => {
      fs.writeFileSync(dir + "/status", status(stanza("base", "1")));
      for (const n of order) execFileSync("bash", ["-c", local(P.PACK_MERGE), "bash", n]);
      return parse(fs.readFileSync(dir + "/status", "utf8")).sort();
    };
    const want = ["base=1", "gs=10", "lo=25", "tess=5"];
    assert.deepEqual(run(["a", "b"]), want);
    assert.deepEqual(run(["b", "a"]), want);
    assert.deepEqual(run(["a", "a"]), ["base=1", "gs=10", "lo=25"]);
  });
  test("a record of the same package is replaced, not duplicated", () => {
    fs.writeFileSync(dir + "/c.status", status(stanza("base", "2")));
    fs.writeFileSync(dir + "/status", status(stanza("base", "1"), stanza("z", "1")));
    execFileSync("bash", ["-c", local(P.PACK_MERGE), "bash", "c"]);
    assert.deepEqual(parse(fs.readFileSync(dir + "/status", "utf8")), ["base=2", "z=1"]);
  });
  test("no record file means nothing to merge", () => {
    fs.writeFileSync(dir + "/status", status(stanza("base", "1")));
    execFileSync("bash", ["-c", local(P.PACK_MERGE), "bash", "missing"]);
    assert.deepEqual(parse(fs.readFileSync(dir + "/status", "utf8")), ["base=1"]);
  });
});
