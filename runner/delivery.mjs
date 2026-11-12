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
// Failed before any SDK send may retry up to three times. Unknown may already
// have sent: NEVER resend, retain through at most three maintenance rounds
// (including the original send), then discard outputs and report uncertainty.
const MAX_ATTEMPTS = 3;
async function finishDelivery(file, d, root, report) {
  if (d.status !== "sent" && d.attempts < MAX_ATTEMPTS) return;
  d.exhausted = d.status !== "sent";
  write(file, d);
  cleanOutputs(d, root);
  if (!d.reported) {
    try {
      await report({id:d.id,status:d.status,sent_count:d.sent_count || 0,
        attempts:d.attempts,exhausted:d.exhausted});
    } catch { return; } // Keep only the receipt; retry reporting, never the files.
  }
  fs.unlinkSync(file);
}
export async function deliverFiles({ dir, root, target, sendFile, report }) {
  if (!fs.existsSync(dir)) return;
  const pending = [];
  // Maintain every terminal receipt even if three active sends already await work.
  for (const name of fs.readdirSync(dir).filter(x => /\.json(?:\.(sent|failed|unknown))?$/.test(x))) {
    const file = path.join(dir, name), d = JSON.parse(fs.readFileSync(file));
    d.status ||= name.match(/\.(sent|failed|unknown)$/)?.[1];
    d.attempts = Math.max(0, Math.min(MAX_ATTEMPTS, Number(d.attempts) || 0));
    if (d.status === "unknown" || d.status === "failed" && d.reported) {
      d.attempts = Math.min(MAX_ATTEMPTS, Math.max(1, d.attempts) + 1);
      write(file, d);
      await finishDelivery(file, d, root, report);
    } else if (d.status === "sent" || d.attempts >= MAX_ATTEMPTS) {
      await finishDelivery(file, d, root, report);
    } else pending.push({file,d});
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
    } catch { d.status = attempted ? "unknown" : "failed"; }
    write(active, d);
    const terminal = base + "." + d.status;
    fs.renameSync(active, terminal);
    await finishDelivery(terminal, d, root, report);
  }
}
