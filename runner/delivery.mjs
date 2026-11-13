// Durable native-file delivery. A crash during send is unknown, never an automatic resend.
import fs from "node:fs";
import path from "node:path";
const write = (file, data) => {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
function cleanOutputs(d, root) {
  const base = fs.realpathSync(root);
  for (const file of d.files || []) {
    const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep);
    if (relative.length !== 4 || relative[0] !== "_deliveries" ||
        !/^[a-f0-9]{32}$/.test(relative[1]) || relative[2] !== "outputs") continue;
    try {
      const real = fs.realpathSync(file);
      if (real !== path.join(base, ...relative)) continue;
      fs.unlinkSync(real);

    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Also finish directory cleanup if a previous pass stopped after unlinking.
    let parent = path.dirname(path.join(base, ...relative));
    for (let level = 0; level < 3; level++, parent = path.dirname(parent)) {
      try { fs.rmdirSync(parent); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
    }
  }
}
// Receipts written by older runner versions may have no cloud id. A confirmed
// send is safe to retire; anything unconfirmed is parked for manual recovery.
// Retiring drops only the receipt: its outputs stay on disk for manual reuse.
function retire(file, d) {
  if (d.sent_count == null) d.sent_count = (d.files || []).length;
  write(file, d);
  fs.unlinkSync(file);
}
function park(file) {
  const base = file.replace(/\.(sent|failed|unknown)$/, "");
  let target = base + ".legacy";
  for (let n = 2; fs.existsSync(target); n++) target = `${base}.legacy-${n}`;
  fs.renameSync(file, target);
}
export function recoverDeliveries(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith(".sending"))) {
    const file = path.join(dir, name),
      d = JSON.parse(fs.readFileSync(file));
    d.status = "unknown";
    d.attempts = Math.max(1, d.attempts || 0);
    write(file, d);
    fs.renameSync(file, file.replace(/\.sending$/, ".unknown"));
  }
}
// Safe failures retry at most three times. Unknown sends never retry; only
// confirmed files are removed at that limit. Unconfirmed files expire after
// 24 hours, or earlier when the global 20-file / 100 MiB budget is exceeded.
const MAX_ATTEMPTS = 3;
// Retry waits owned here because the files never leave this machine.
// Keep the schedule in step with src/delivery-retry.ts.
const RETRY_DELAYS_MS = [60_000, 300_000];
function errorCode(error, attempted) {
  if (attempted) return 'send_failed';
  const message = String(error?.message || '');
  if (message === 'file denied') return 'file_denied';
  if (message === 'invalid files') return 'invalid_files';
  return 'target_unavailable';
}
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_FILES = 20;
const MAX_RETAINED_BYTES = 100 * 1024 * 1024;
function unconfirmed(d) {
  return (d.files || []).slice(d.sent_count || 0);
}
function sweepRetained(dir, root, now) {
  const retained = fs.readdirSync(dir).filter(name => name.endsWith('.json.unknown')).map(name => {
    const file = path.join(dir, name), d = JSON.parse(fs.readFileSync(file));
    d.retain_until ||= now + RETENTION_MS;
    write(file, d);
    const files = unconfirmed(d).filter(file => fs.existsSync(file));
    return {file, d, count: files.length, bytes: files.reduce((sum, file) => sum + fs.lstatSync(file).size, 0)};
  }).sort((a, b) => a.d.retain_until - b.d.retain_until);
  let count = retained.reduce((sum, entry) => sum + entry.count, 0);
  let bytes = retained.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of retained) {
    const {file, d} = entry;
    if (!d.retention_removed && now < d.retain_until && count <= MAX_RETAINED_FILES && bytes <= MAX_RETAINED_BYTES) continue;
    cleanOutputs(d, root);
    d.retention_removed = true;
    count -= entry.count;
    bytes -= entry.bytes;
    if (d.reported) fs.unlinkSync(file);
    else write(file, d); // Keep only an unacknowledged receipt, never resend.
  }
}
async function finishDelivery(file, d, root, report) {
  if (d.status !== "sent" && d.attempts < MAX_ATTEMPTS) return;
  d.exhausted = d.status !== "sent";
  write(file, d);
  cleanOutputs(d.status === 'unknown' && !d.retention_removed
    ? {...d, files: d.files.slice(0, d.sent_count || 0)} : d, root);
  if (!d.reported) {
    try {
      await report({id:d.id,status:d.status,sent_count:d.sent_count || 0,
        attempts:d.attempts,exhausted:d.exhausted,
        ...(d.status === 'failed' ? {error:d.error || 'send_failed'} : {}),
        ...(d.status === 'unknown' ? {unconfirmed_files:unconfirmed(d).map(file => path.basename(file)),
          retain_until:d.retain_until,retention_removed:!!d.retention_removed} : {})});
    } catch { return; } // Retry reporting without sending files again.
    d.reported = true;
    write(file, d);
  }
  if (d.status !== 'unknown' || d.retention_removed) fs.unlinkSync(file);
}
export async function deliverFiles({ dir, root, target, sendFile, report, now = Date.now() }) {
  if (!fs.existsSync(dir)) return;
  sweepRetained(dir, root, now);
  const pending = [];
  // Maintain every terminal receipt even if three active sends already await work.
  for (const name of fs.readdirSync(dir).filter(x => /\.json(?:\.(sent|failed|unknown))?$/.test(x))) {
    const file = path.join(dir, name), d = JSON.parse(fs.readFileSync(file));
    d.status ||= name.match(/\.(sent|failed|unknown)$/)?.[1];
    d.attempts = Math.max(0, Math.min(MAX_ATTEMPTS, Number(d.attempts) || 0));
    if (typeof d.id !== "string" || !d.id) {
      if (d.status === "sent") retire(file, d);
      else park(file);
      continue;
    }
    // Pin the original age before any retry rewrites the manifest's mtime.
    const created = typeof d.created_at === 'number' ? d.created_at : Date.parse(d.created_at);
    d.created_at = Number.isFinite(created) ? created : fs.statSync(file).mtimeMs;
    if (!['sent','unknown'].includes(d.status) && now - d.created_at > RETENTION_MS) {
      d.status = 'failed';
      d.error = 'expired';
      d.attempts = MAX_ATTEMPTS;
      delete d.next_attempt;
      write(file, d);
      await finishDelivery(file, d, root, report);
      continue;
    }
    if (d.status === "unknown" || d.status === "failed" && d.reported) {
      d.attempts = Math.min(MAX_ATTEMPTS, Math.max(1, d.attempts) + 1);
      write(file, d);
      await finishDelivery(file, d, root, report);
    } else if (d.status === "sent" || d.attempts >= MAX_ATTEMPTS) {
      await finishDelivery(file, d, root, report);
    } else if (Number(d.next_attempt) > now) continue;
    else pending.push({file,d});
  }
  for (const {file,d} of pending.slice(0,3)) {
    const base = file.replace(/\.(sent|failed|unknown)$/, ""), active = base + ".sending";
    fs.renameSync(file, active);
    d.attempts++;
    d.sent_count = 0;
    write(active, d);
    let attempted = false;
    try {
      const destination = await target({ message: d.message, delivery: d.id });
      const rootPath = fs.realpathSync(root) + path.sep;
      const files = d.files.map(f => {
        const real = fs.realpathSync(f), stat = fs.statSync(real);
        if (!real.startsWith(rootPath) || !real.includes(path.sep + "outputs" + path.sep) ||
            !stat.isFile() || stat.size > 50 * 1024 * 1024) throw Error("file denied");
        return real;
      });
      if (!files.length || files.length > 5) throw Error("invalid files");
      for (const localPath of files) {
        d.inflight = path.basename(localPath);
        write(active, d);
        attempted = true;
        await sendFile(destination.group_id, localPath);
        d.sent_count++;
        delete d.inflight;
        write(active, d);
      }
      d.status = "sent";
      delete d.next_attempt;
      delete d.error;
    } catch (error) {
      d.status = attempted ? "unknown" : "failed";
      d.error = errorCode(error, attempted);
      d.next_attempt = d.status === "failed" && d.attempts < MAX_ATTEMPTS
        ? now + RETRY_DELAYS_MS[Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, d.attempts - 1))]
        : 0;
    }
    write(active, d);
    const terminal = base + "." + d.status;
    fs.renameSync(active, terminal);
    // Sweep before reporting so a new result that exceeds the budget reports
    // its actual retention state. Sweep every flush, even without active sends.
    sweepRetained(dir, root, now);
    await finishDelivery(terminal, JSON.parse(fs.readFileSync(terminal)), root, report);
  }
}
