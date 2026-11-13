#!/usr/bin/env node
// D-9 capability probes — deterministic, local, no model, no network, no QQ, no online D1.
//
// Layer 1 checks the tool layer only (catalog/switches/needs and the implementation
// branch) with the same fake D1 / fake fetch style as test/repo, test/github and
// runner/test_fetcher. It never claims that the model chose the right tool: those
// probes are marked status="needs_model" and wait for D-7 turn_offers.
//
// Layer 2 compares probe results with capability_gaps. It only uses the
// turn_offers of the recorded turn; a missing offer is "unknown" and is never
// backfilled from the current snapshot (R7-CAP). The seed table is empty, so the
// comparison logic is exercised with test/fixtures/review/probes-gaps.sql.
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createFetchClient } from "../runner/fetcher.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "schema.sql");
const REVIEW_MIGRATION = join(ROOT, "migrations/0008_review.sql");
const GAP_FIXTURE = join(ROOT, "test/fixtures/review/probes-gaps.sql");
const PROBE_ENTRY = `
export { runRepoTool } from "./src/repo";
export { metered } from "./src/d1";
export { agentAnswer, readUrl } from "./src/semantic";
export { extractBili } from "./src/inbound";
export { biliNoteText, videoMaterial } from "./src/fetchjobs";
export { buildTraces } from "./src/review/trace";
export { capabilitySnapshot } from "./src/review/snapshot";
export { secondJudge } from "./src/review/second";
export { TOOLS_CATALOG, CATALOG_VERSION, capabilityNeeds } from "./src/review/catalog";
`;

const STATUS = new Set(["pass", "fail", "needs_model", "synthetic"]);
const SEED = "test/fixtures/review/probes-gaps.sql";

let apiCache = null;

async function probeApi() {
  if (apiCache) return apiCache;
  mkdirSync(join(ROOT, ".wrangler"), { recursive: true });
  const outfile = join(ROOT, ".wrangler", `review-probes-${process.pid}.mjs`);
  await build({
    stdin: { contents: PROBE_ENTRY, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile,
    logLevel: "silent",
  });
  try {
    apiCache = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  } finally {
    try { unlinkSync(outfile); } catch {}
  }
  return apiCache;
}

function wrapDb(raw) {
  let executed = 0;
  const make = (sql, args = []) => ({
    sql,
    bind(...values) { return make(sql, values); },
    async first() { executed++; return raw.prepare(sql).get(...args) ?? null; },
    async all() { executed++; return { results: raw.prepare(sql).all(...args) }; },
    async run() {
      executed++;
      const info = raw.prepare(sql).run(...args);
      return { meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
    },
  });
  return {
    get executed() { return executed; },
    prepare(sql) { return make(sql); },
    async batch(statements) {
      if (!statements.length) return [];
      executed += statements.length;
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        try { raw.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
  };
}

function memoryDb({ fixture = null } = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(SCHEMA, "utf8"));
  raw.exec(readFileSync(REVIEW_MIGRATION, "utf8"));
  if (fixture) raw.exec(readFileSync(fixture, "utf8"));
  return { raw, db: wrapDb(raw) };
}

function probeEnv(options = {}) {
  const { raw, db } = memoryDb(options);
  const e = {
    DB: db,
    GITHUB_TOKEN: "synthetic-github-token",
    DEEPSEEK_API_KEY: "synthetic-deepseek-key",
    OPENAI_MODEL: "synthetic-luna",
    RELEASE: "probe",
    WORK: { sent: [], async send(body, opts) { this.sent.push({ body, opts }); } },
  };
  return { raw, e };
}

function sydneyDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function findReleaseDir() {
  if (process.env.REVIEW_RELEASE_DIR) {
    const dir = resolve(process.env.REVIEW_RELEASE_DIR);
    return existsSync(join(dir, "acceptance.json")) ? dir : null;
  }
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".agent/releases/V-D-reflection-loop");
    if (existsSync(join(candidate, "acceptance.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function seedInfo() {
  const release = findReleaseDir();
  const file = release ? join(release, "replay/seed-437.sqlite") : null;
  if (!file || !existsSync(file)) return { path: null, messages: null, message_images: null, image_notes_text: null, capability_gaps: null, turn_offers: null };
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const one = (sql) => raw.prepare(sql).get();
    return {
      path: file,
      messages: one("SELECT COUNT(*) AS n FROM messages").n,
      message_images: one("SELECT COUNT(*) AS n FROM message_images").n,
      image_notes_text: one("SELECT COUNT(*) AS n FROM image_notes WHERE text IS NOT NULL").n,
      capability_gaps: one("SELECT COUNT(*) AS n FROM capability_gaps").n,
      turn_offers: one("SELECT COUNT(*) AS n FROM turn_offers").n,
    };
  } finally {
    raw.close();
  }
}

async function withFetch(handler, net, work) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    net.fetch_hits++;
    const response = await handler(String(url), options);
    if (response === undefined) {
      net.unexpected++;
      throw new Error(`unexpected network: ${String(url).slice(0, 120)}`);
    }
    return response;
  };
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

function record({ name, capability, passed, status, detail, tool, error_kind = null, source = null }) {
  if (!STATUS.has(status)) throw new Error(`invalid probe status ${status}`);
  return { kind: "capability", name, capability, passed, status, detail, tool, error_kind, source };
}

function repoFake(sha, blobText) {
  const blobSha = "b".repeat(40);
  return async (url) => {
    const u = new URL(url);
    if (u.hostname !== "api.github.com") return undefined;
    const path = u.pathname;
    if (/\/commits\/HEAD$/.test(path)) return new Response(sha);
    if (/\/git\/trees\//.test(path)) {
      return Response.json({ tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blobSha, size: Buffer.byteLength(blobText) }], truncated: false });
    }
    if (/\/git\/blobs\//.test(path)) {
      return Response.json({ encoding: "base64", size: Buffer.byteLength(blobText), content: Buffer.from(blobText).toString("base64") });
    }
    if (/\/commits$/.test(path)) {
      return Response.json([{ sha, commit: { message: "probe commit", author: { name: "Probe", date: "2026-11-13T00:00:00Z" } } }]);
    }
    return undefined;
  };
}

function hexSha(seed) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

async function repoProbes(api, net, repositories) {
  const probes = [];
  for (const repo of repositories) {
    const sha = hexSha(repo);
    const { raw, e } = probeEnv();
    let passed = false, detail = "", error_kind = null;
    try {
      const metered = api.metered(e);
      await withFetch(repoFake(sha, "probe readme\n"), net, async () => {
        const result = await api.runRepoTool(metered, "repo_changes", { repo, limit: 3 });
        error_kind = result?.error_kind ?? null;
        passed = !error_kind && Array.isArray(result?.commits) && result.commits.length === 1 && result.commits[0].sha7 === sha.slice(0, 7);
        detail = passed
          ? `${repo}: commits=${result.commits.length} head=${result.commits[0].sha7}`
          : `${repo}: ${JSON.stringify(result).slice(0, 240)}`;
      });
    } catch (error) {
      detail = `${repo}: ${error.message}`;
      error_kind = error.kind ?? "unknown";
    } finally {
      raw.close();
    }
    probes.push(record({
      name: `repo_changes:${repo}`,
      capability: "repo_visibility",
      passed,
      status: passed ? "pass" : "fail",
      detail,
      tool: "repo_changes",
      error_kind,
      source: { kind: "fake_github", repo },
    }));
  }

  const sha = hexSha("repo_file");
  const { raw, e } = probeEnv();
  let passed = false, detail = "", error_kind = null;
  try {
    const metered = api.metered(e);
    await withFetch(repoFake(sha, "probe readme\n"), net, async () => {
      const result = await api.runRepoTool(metered, "repo_file", { repo: repositories[0], path: "README.md" });
      error_kind = result?.error_kind ?? null;
      passed = !error_kind && result?.text === "probe readme" && result?.total_lines === 1 && result?.untrusted === true;
      detail = passed
        ? `${repositories[0]}/README.md: lines=${result.total_lines} sha7=${result.sha7}`
        : JSON.stringify(result).slice(0, 240);
    });
  } catch (error) {
    detail = error.message;
    error_kind = error.kind ?? "unknown";
  } finally {
    raw.close();
  }
  probes.push(record({
    name: "repo_file",
    capability: "repo_read",
    passed,
    status: passed ? "pass" : "fail",
    detail,
    tool: "repo_file",
    error_kind,
    source: { kind: "fake_github", repo: repositories[0], path: "README.md" },
  }));
  return probes;
}

function runnerRequest(handler, net, calls) {
  return (options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      options.lookup(options.host, {}, (error) => {
        if (error) { req.emit("error", error); return; }
        net.https_hits++;
        calls.push(options);
        const response = handler(options, calls.length);
        const res = new EventEmitter();
        res.statusCode = response.status || 200;
        res.headers = response.headers || {};
        callback(res);
        queueMicrotask(() => {
          for (const chunk of response.chunks || [Buffer.from(JSON.stringify(response.body || {}))]) res.emit("data", chunk);
          res.emit("end");
        });
      });
    };
    req.destroy = (error) => { req.emit("error", error || Error("destroyed")); };
    return req;
  };
}

async function biliShortProbe(api, net) {
  const url = "https://b23.tv/F1DkQFC", expected = "BV1GN4p6pEEP";
  const links = api.extractBili([url], "");
  const short = links[0]?.short;
  const calls = [];
  const client = createFetchClient({
    request: runnerRequest((options) => {
      if (options.host !== "b23.tv") return { status: 500, body: {} };
      return { status: 302, headers: { location: `https://www.bilibili.com/video/${expected}` } };
    }, net, calls),
    lookup: (_host, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }]),
    now: () => 10_000,
    sleep: async () => {},
    random: () => 0,
  });
  let passed = false, detail = "", error_kind = null;
  try {
    const bvid = await client.resolveShort(short);
    passed = short === "F1DkQFC" && bvid === expected;
    detail = passed
      ? `${url} → 302 → ${bvid}（runner.resolveShort，1 次 fake https）`
      : `short=${short} resolved=${bvid}`;
  } catch (error) {
    detail = error.message;
    error_kind = error.reason ?? "unknown";
  }
  return record({
    name: "bili_shortlink",
    capability: "bili_shortlink",
    passed,
    status: passed ? "pass" : "fail",
    detail,
    tool: "runner.resolveShort",
    error_kind,
    source: { kind: "real_message", case: 7, rowid: 417, url },
  });
}

async function biliNoCcProbe(api, net) {
  const bvid = "BV1GN4p6pEEP", calls = [];
  const wbi = { img_url: `https://i0.hdslb.com/${"a".repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${"b".repeat(32)}.png` };
  const client = createFetchClient({
    request: runnerRequest((options) => {
      const path = options.path.split("?")[0];
      if (path === "/x/frontend/finger/spi") return { body: { code: 0, data: { b_3: "probe-buvid" } } };
      if (path === "/x/web-interface/nav") return { body: { code: -101, data: { wbi_img: wbi } } };
      if (path === "/x/web-interface/view") {
        return { body: { code: 0, data: { bvid, title: "无字幕视频", desc: "简介", owner: { name: "UP" }, tname: "科技", duration: 695, pubdate: 1, stat: { view: 1 }, aid: 123, pages: [{ cid: 456 }] } } };
      }
      if (path === "/x/player/wbi/v2") return { body: { code: 0, data: { subtitle: { subtitles: [] } } } };
      if (path === "/x/v2/reply") {
        return { body: { code: 0, data: { replies: [{ like: 8, member: { uname: "观众" }, content: { message: "热评原文" } }] } } };
      }
      return { status: 500, body: {} };
    }, net, calls),
    lookup: (_host, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }]),
    now: () => 10_000,
    sleep: async () => {},
    random: () => 0,
  });
  let passed = false, detail = "", error_kind = null;
  try {
    const result = await client.biliLight(bvid);
    const note = api.biliNoteText(result);
    const material = api.videoMaterial(result);
    passed = result.subtitle_status === "none" && result.subtitle === null &&
      result.comments.length === 1 && result.comments[0].message === "热评原文" &&
      note.includes("无 CC 字幕") && note.includes("没拿到字幕，以下基于标题与评论") &&
      material.material.includes("无 CC 字幕") && material.rule.includes("没拿到字幕，以下基于标题与评论");
    detail = passed
      ? `${bvid}: subtitle_status=none, comments=1, note 无编造字幕；素材=${material.material.length}字`
      : JSON.stringify({ subtitle_status: result.subtitle_status, subtitle: result.subtitle, comments: result.comments }).slice(0, 300);
  } catch (error) {
    detail = error.message;
    error_kind = error.reason ?? "unknown";
  }
  return record({
    name: "bili_video_no_cc",
    capability: "bili_video",
    passed,
    status: passed ? "pass" : "fail",
    detail,
    tool: "runner.biliLight+biliNoteText",
    error_kind,
    source: { kind: "real_message", case: 6, rowid: 374, bvid },
  });
}

async function xhsProbe(api, net) {
  const url = "https://xhslink.cn/o/79Ta4C6dKMS";
  const body = `标题：工作台 UI 修改指导\n\n${"正文内容，包含按钮位置与交互说明。".repeat(120)}`;
  const { raw, e } = probeEnv();
  let passed = false, detail = "", error_kind = null;
  try {
    const result = await withFetch(async (requested) => {
      if (!requested.startsWith("https://r.jina.ai/https://xhslink.cn/")) return undefined;
      return new Response(`Title: 工作台 UI 修改指导\n\nMarkdown Content:\n${body}`, { headers: { "content-type": "text/plain" } });
    }, net, () => api.readUrl(e, url, { purpose: "research" }));
    passed = result.ok === true && result.source === "jina" && result.text.length > 500 && result.text.includes("正文内容");
    detail = passed
      ? `${url} → read_web/jina 得到 ${result.text.length} 字（fake）；未验证真实 xhs 反爬`
      : JSON.stringify(result).slice(0, 240);
  } catch (error) {
    detail = error.message;
    error_kind = "unknown";
  } finally {
    raw.close();
  }
  return record({
    name: "xhs_note",
    capability: "xhs_note",
    passed,
    status: passed ? "pass" : "fail",
    detail,
    tool: "read_web/readUrl",
    error_kind,
    source: { kind: "real_message", case: 19, rowid: 382, url },
  });
}

async function csvProbe(api, net) {
  const { raw, e } = probeEnv();
  const body = "接入验收小活：请把这些示例数据整理成 UTF-8 CSV 文件发回群里，不改任何仓库：大肥鱼，进行中，3；面试软件，待验收，2；陪玩店，待整理，1。列名：项目、状态、任务数。";
  const ts = "2026-11-11T16:37:34+08:00";
  let passed = false, detail = "", error_kind = null;
  try {
    await e.DB.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)")
      .bind("fx-m-34", "fx-group", "fx-sender-owner", body, ts, 1).run();
    await e.DB.prepare("INSERT INTO message_meta VALUES(?,?)").bind("fx-m-34", JSON.stringify({
      direct: true, can_request_artifact: true, media: [], attachments: [], urls: [],
    })).run();
    const row = { id: "fx-m-34", group_id: "fx-group", sender: "fx-sender-owner", body, ts, mentioned: 1, meta: { direct: true, can_request_artifact: true, media: [], attachments: [], urls: [] } };
    const context = { latest: row, batch: [row], recent: [row], names: new Map(), refs: new Map(), mentioned: true, background: true };
    let turn = 0;
    await withFetch(async (url, options) => {
      if (!url.startsWith("https://api.deepseek.com/")) return undefined;
      const payload = JSON.parse(options.body);
      if (String(payload.messages?.[0]?.content || "").includes("最后的嘴替模块")) {
        return Response.json({ choices: [{ message: { content: "{\"mode\":\"work\",\"text\":\"已交给后台生成 CSV。\"}" } }] });
      }
      if (turn++ === 0) {
        return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{
          id: "probe-call-create-file", type: "function",
          function: { name: "create_file_task", arguments: JSON.stringify({
            source_id: "fx-m-34",
            request_quote: "请把这些示例数据整理成 UTF-8 CSV 文件发回群里",
            title: "项目状态 CSV",
            instructions: "按列名生成 CSV，三行数据不改",
            source_ids: ["fx-m-34"],
          }) },
        }] } }] });
      }
      return Response.json({ choices: [{ message: { content: "{\"action\":\"reply\",\"kind\":\"direct\",\"brief\":\"已交给后台生成 CSV，生成后发群里。\"}" } }] });
    }, net, () => api.agentAnswer(e, context));
    const job = await e.DB.prepare("SELECT id,kind,status,payload FROM jobs WHERE kind='media'").first();
    const outbox = await e.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first();
    const runs = (await e.DB.prepare("SELECT kind,status FROM model_runs ORDER BY rowid DESC LIMIT 5").all()).results;
    const activities = (await e.DB.prepare("SELECT kind,summary FROM activity ORDER BY rowid DESC LIMIT 5").all()).results;
    const payload = job ? JSON.parse(job.payload) : null;
    passed = !!job && job.status === "pending" && payload?.want_files === true && payload?.title === "项目状态 CSV" &&
      payload?.input_message_ids?.includes("fx-m-34") && outbox.n === 0;
    const denied = activities.find((item) => item.kind === "authz.denied");
    error_kind = passed ? null : denied ? "denied" : "not_created";
    detail = passed
      ? `create_file_task → ${job.id} kind=media want_files=true；outbox=0、WORK.send=${e.WORK.sent.length}（队列唤醒，非 QQ）`
      : `create_file_task 未建 media job；${denied ? `authz.denied: ${denied.summary}` : "未观察到授权拒绝"}；runs=${runs.map((r) => r.kind + ":" + r.status).join(",")}`;
  } catch (error) {
    detail = error.message;
    error_kind = "unknown";
  } finally {
    raw.close();
  }
  return record({
    name: "attachment_send",
    capability: "attachment_send",
    passed,
    status: passed ? "pass" : "fail",
    detail,
    tool: "create_file_task",
    error_kind,
    source: { kind: "real_message", case: 18, rowid: 34 },
  });
}

async function selfReportProbe(api) {
  const { raw, e } = probeEnv();
  let passed = null, detail = "", error_kind = null, status = "needs_model";
  try {
    await e.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('off:repo_tools','1')").run();
    const snapshot = await api.capabilitySnapshot(e);
    const repo = api.TOOLS_CATALOG.find((tool) => tool.name === "repo_changes");
    const file = api.TOOLS_CATALOG.find((tool) => tool.name === "repo_file");
    const web = api.TOOLS_CATALOG.find((tool) => tool.name === "read_web");
    const needs = api.capabilityNeeds("repo_read");
    const ok = snapshot.switches["off:repo_tools"] === "on" && repo?.readonly === true && file?.readonly === true &&
      web?.readonly === true && repo?.needs?.includes("switch") && needs.includes("github_token") && needs.includes("switch") &&
      snapshot.tools_catalog.length === api.TOOLS_CATALOG.length && api.CATALOG_VERSION === "cat-v1";
    detail = ok
      ? `catalog ${api.TOOLS_CATALOG.length} 工具；repo_* readonly=true、needs=github_token/switch；off:repo_tools=on 快照可读；模型是否按只读/开关/白名单自述需 D-7 turn_offers 后判`
      : "catalog 或开关快照与 D-2 目录不一致";
    passed = ok ? null : false;
    status = ok ? "needs_model" : "fail";
  } catch (error) {
    detail = error.message;
    error_kind = "unknown";
    passed = false;
    status = "fail";
  } finally {
    raw.close();
  }
  return record({
    name: "capability_self_report",
    capability: "repo_read",
    passed,
    status,
    detail,
    tool: "TOOLS_CATALOG+capabilitySnapshot",
    error_kind,
    source: { kind: "real_message", case: 2, rowid: 434 },
  });
}

async function imageProbe(api) {
  const { raw, e } = probeEnv();
  let passed = false, detail = "", error_kind = null;
  try {
    const ts = "2026-11-13T12:00:00+08:00";
    await e.DB.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)")
      .bind("probe-img-1", "probe-img-group", "U1", "看这张截图<@bot>", ts, 1).run();
    await e.DB.prepare("INSERT INTO message_meta VALUES(?,?)").bind("probe-img-1", JSON.stringify({
      direct: true, media: [{ content_type: "image/png", url: "https://example.com/probe.png" }], attachments: [], urls: [],
    })).run();
    await e.DB.prepare("INSERT INTO message_images(message_id,idx,sha) VALUES(?,?,?)").bind("probe-img-1", 0, "c".repeat(64)).run();
    await e.DB.prepare("INSERT INTO image_notes(sha,desc,tags,sticker_like,text,created_at) VALUES(?,?,?,?,?,?)")
      .bind("c".repeat(64), "工作台按钮截图", "[]", 0, null, Date.now()).run();
    const page = await api.buildTraces(e, {
      group_id: "probe-img-group",
      window_start: "2026-11-13T00:00:00+08:00",
      window_end: "2026-11-14T00:00:00+08:00",
    });
    const trace = page.traces.find((item) => item.inbound?.id === "probe-img-1");
    const snapshot = await api.capabilitySnapshot(e);
    const second = trace
      ? await api.secondJudge(e, [trace], snapshot, {
        imageSources: [], provider: "openai", model: "synthetic-luna", max_tokens: 2048,
        price: { unit: "usd_micros", input: 1, output: 1 },
      })
      : null;
    const hasImage = trace?.has_image === true || trace?.has_image === 1;
    passed = hasImage && second?.provider === "openai" && second?.reply?.ok === false &&
      ["provider_unavailable", "price_unavailable"].includes(second.reply.error_kind);
    detail = passed
      ? `synthetic（种子 message_images=0）：trace.has_image=1/true；second provider=openai、${second.reply.error_kind}（0 模型调用）`
      : JSON.stringify({ has_image: trace?.has_image, provider: second?.provider, reply: second?.reply }).slice(0, 300);
  } catch (error) {
    detail = error.message;
    error_kind = "unknown";
  } finally {
    raw.close();
  }
  return record({
    name: "image_route",
    capability: "image_read",
    passed,
    status: passed ? "synthetic" : "fail",
    detail,
    tool: "buildTraces+secondJudge",
    error_kind,
    source: { kind: "synthetic", note: "seed has no real image @bot message" },
  });
}

function aggregateCapabilities(probes) {
  const result = {};
  for (const probe of probes) {
    const bucket = result[probe.capability] ?? (result[probe.capability] = { probes: 0, passed: 0, failed: 0, needs_model: 0, synthetic: 0, status: "pass" });
    bucket.probes++;
    if (probe.status === "pass") bucket.passed++;
    else if (probe.status === "fail") bucket.failed++;
    else if (probe.status === "needs_model") bucket.needs_model++;
    else if (probe.status === "synthetic") bucket.synthetic++;
  }
  for (const bucket of Object.values(result)) {
    if (bucket.failed) bucket.status = "fail";
    else if (bucket.needs_model) bucket.status = "needs_model";
    else if (bucket.synthetic) bucket.status = "synthetic";
    else bucket.status = "pass";
  }
  return result;
}

function probeStatusFor(capability, probes) {
  const list = probes.filter((probe) => probe.capability === capability);
  if (!list.length) return "no_probe";
  if (list.some((probe) => probe.status === "fail")) return "fail";
  if (list.some((probe) => probe.status === "needs_model")) return "needs_model";
  if (list.some((probe) => probe.status === "synthetic")) return "synthetic";
  return "pass";
}

function turnOfferFor(gap, offers) {
  let evidence = [];
  try { evidence = JSON.parse(gap.evidence_json || "[]"); } catch {}
  const inbound = evidence.find((item) => item?.source === "message" && typeof item.id === "string")?.id;
  if (!inbound) return { status: "unknown", reason: "gap 没有 message 证据" };
  const offer = offers.find((row) => row.inbound_id === inbound);
  if (!offer) return { status: "unknown", reason: `没有 inbound ${inbound} 的当轮 turn_offers` };
  let switches = {}, names = [];
  try { switches = JSON.parse(offer.switches || "{}"); } catch {}
  try { names = JSON.parse(offer.names || "[]"); } catch {}
  return { status: "known", inbound_id: inbound, turn_id: offer.turn_id, switches, names, runner_ok: offer.runner_ok, catalog_version: offer.catalog_version };
}

function needsRunner(capability) {
  return capability === "attachment_send" || capability === "bili_video" || capability === "bili_shortlink";
}

const CAPABILITY_TOOL = {
  repo_visibility: "repo_changes",
  repo_read: "repo_file",
  xhs_note: "read_web",
  attachment_send: "create_file_task",
};

function verdictFor(gap, status, offer) {
  if (status === "fail") return gap.status === "fixed" || gap.status === "regression" ? "gap_fixed_probe_fail" : "probe_fail_gap_open";
  if (status === "pass") {
    if (gap.status !== "open") return "consistent";
    if (offer.status === "known") {
      if (["repo_visibility", "repo_read", "repo_disambiguation"].includes(gap.capability) && offer.switches?.["off:repo_tools"] === "on") return "unknown_switch_or_policy_off";
      if (needsRunner(gap.capability) && offer.runner_ok === 0) return "unknown_capability_offline";
      if (CAPABILITY_TOOL[gap.capability] && !offer.names.includes(CAPABILITY_TOOL[gap.capability])) return "unknown_tool_not_offered";
    }
    if (offer.status === "unknown") return "unknown_no_turn_offer";
    return "probe_pass_gap_open";
  }
  if (status === "needs_model") return "unknown_needs_model";
  if (status === "synthetic") return "unknown_synthetic";
  return "unknown_no_probe";
}

export function compareGapRows(probes, gaps, offers) {
  const entries = gaps.map((gap) => {
    const status = probeStatusFor(gap.capability, probes);
    const offer = turnOfferFor(gap, offers);
    const verdict = verdictFor(gap, status, offer);
    return {
      fingerprint: gap.fingerprint,
      capability: gap.capability,
      gap_type: gap.gap_type,
      status: gap.status,
      probe_status: status,
      verdict,
      turn_offer: offer.status === "known" ? offer : null,
      note: offer.status === "unknown" ? offer.reason : null,
    };
  });
  const flags = {};
  for (const entry of entries) (flags[entry.verdict] ??= []).push(entry.fingerprint);
  return { entries, flags };
}

function gapFixtureCheck(api, probes) {
  const { raw, db } = memoryDb({ fixture: GAP_FIXTURE });
  try {
    const gaps = raw.prepare("SELECT fingerprint,capability,gap_type,status,evidence_json FROM capability_gaps ORDER BY fingerprint").all();
    const offers = raw.prepare("SELECT turn_id,inbound_id,names,catalog_version,switches,runner_ok FROM turn_offers ORDER BY turn_id").all();
    const compared = compareGapRows(probes, gaps, offers);
    const selftestPass = compareGapRows(
      [{ capability: "xhs_note", status: "pass" }],
      [{ fingerprint: "selftest-open", capability: "xhs_note", gap_type: "tool_missing", status: "open", evidence_json: '[{"source":"message","id":"selftest-msg"}]' }],
      [{ turn_id: "t-selftest", inbound_id: "selftest-msg", names: '["read_web"]', switches: "{}", runner_ok: 1 }],
    ).flags.probe_pass_gap_open?.includes("selftest-open") === true;
    const selftestFail = compareGapRows(
      [{ capability: "xhs_note", status: "fail" }],
      [{ fingerprint: "selftest-fixed", capability: "xhs_note", gap_type: "tool_missing", status: "fixed", evidence_json: "[]" }],
      [],
    ).flags.gap_fixed_probe_fail?.includes("selftest-fixed") === true;
    return {
      source: SEED,
      synthetic: true,
      note: "种子 capability_gaps 为空；夹具预置 open/fixed/runner_offline/无 turn_offers 四类，只证明对照逻辑",
      gaps: compared.entries,
      flags: compared.flags,
      selftest: { probe_pass_gap_open: selftestPass, gap_fixed_probe_fail: selftestFail },
    };
  } finally {
    raw.close();
  }
}

function writeProbes(result, outDir) {
  const release = findReleaseDir();
  const dir = outDir || (release ? join(release, "replay") : join(ROOT, "replay"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `probes-${result.date}.json`);
  result.path = file;
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

export async function runProbes(options = {}) {
  const started = Date.now();
  const api = await probeApi();
  const repositories = JSON.parse(readFileSync(join(ROOT, "config/team.json"), "utf8")).repositories;
  const net = { fetch_hits: 0, https_hits: 0, unexpected: 0 };
  const probes = [];
  probes.push(...await repoProbes(api, net, repositories));
  probes.push(await biliShortProbe(api, net));
  probes.push(await biliNoCcProbe(api, net));
  probes.push(await xhsProbe(api, net));
  probes.push(await csvProbe(api, net));
  probes.push(await selfReportProbe(api));
  probes.push(await imageProbe(api));
  const capabilities = aggregateCapabilities(probes);
  const gapCheck = gapFixtureCheck(api, probes);
  const result = {
    schema: "ta.review.probes.v1",
    generated_at: new Date().toISOString(),
    date: sydneyDate(),
    mode: "local-tool-layer",
    limits: "不调真模型；模型选工具类探针 status=needs_model；图片探针 synthetic；不写线上 D1、不发 QQ",
    catalog_version: api.CATALOG_VERSION,
    probes,
    findings: probes.filter((probe) => probe.status === "fail").map((probe) => ({
      probe: probe.name, capability: probe.capability, error_kind: probe.error_kind, detail: probe.detail,
    })),
    capabilities,
    gap_check: gapCheck,
    seed: seedInfo(),
    safety: {
      qq_real_sends: 0,
      online_d1_rows_written: 0,
      paid_model_calls: 0,
      network: "in-process fake fetch/https adapters",
      fetch_hits: net.fetch_hits,
      https_hits: net.https_hits,
      unexpected_network_hits: net.unexpected,
    },
    elapsed_ms: Date.now() - started,
  };
  if (net.unexpected) throw new Error(`probe used unexpected network ${net.unexpected} time(s)`);
  if (options.write !== false) result.path = writeProbes(result, options.outDir);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProbes({ write: true })
    .then((result) => {
      const pass = result.probes.filter((probe) => probe.status === "pass").length;
      const fail = result.probes.filter((probe) => probe.status === "fail").length;
      const needsModel = result.probes.filter((probe) => probe.status === "needs_model").length;
      const synthetic = result.probes.filter((probe) => probe.status === "synthetic").length;
      console.log(JSON.stringify({
        schema: result.schema,
        path: result.path,
        probes: result.probes.length,
        pass,
        fail,
        needs_model: needsModel,
        synthetic,
        capabilities: Object.fromEntries(Object.entries(result.capabilities).map(([key, value]) => [key, value.status])),
        gap_flags: result.gap_check.flags,
        selftest: result.gap_check.selftest,
        safety: result.safety,
        elapsed_ms: result.elapsed_ms,
      }, null, 2));
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
