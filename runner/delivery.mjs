// Durable native-file delivery. A crash during send is unknown, never an automatic resend.
import fs from "node:fs";
import path from "node:path";
const write = (file, data) => {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
function cleanSentOutputs(d, root) {
  if (d.status !== "sent") return;
  const base = fs.realpathSync(root);
  for (const file of d.files || []) {
    const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep);
    if (relative.length !== 4 || relative[0] !== "_deliveries" ||
        !/^[a-f0-9]{32}$/.test(relative[1]) || relative[2] !== "outputs") continue;
    try {
      const real = fs.realpathSync(file);
      if (real !== path.join(base, ...relative)) continue;
      fs.unlinkSync(real);
      fs.rmdirSync(path.dirname(real));
      fs.rmdirSync(path.dirname(path.dirname(real)));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
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
    write(file, d);
    fs.renameSync(file, file.replace(/\.sending$/, ".unknown"));
  }
}
export async function deliverFiles({ dir, root, target, sendFile, report }) {
  if (!fs.existsSync(dir)) return;
  // Retry only cloud receipts, including receipts from a previous process. Never resend files.
  for (const name of fs
    .readdirSync(dir)
    .filter((x) => /\.json\.(sent|failed|unknown)$/.test(x))) {
    const file = path.join(dir, name),
      d = JSON.parse(fs.readFileSync(file));
    cleanSentOutputs(d, root);
    if (d.reported || !d.id) continue;
    try {
      await report({
        id: d.id,
        status: d.status,
        sent_count: d.sent_count || 0,
      });
      d.reported = true;
      write(file, d);
    } catch {}
  }
  for (const name of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith(".json"))
    .slice(0, 3)) {
    const file = path.join(dir, name),
      active = file + ".sending";
    fs.renameSync(file, active);
    const d = JSON.parse(fs.readFileSync(active));
    d.sent_count = 0;
    let attempted = false;
    try {
      const destination = await target({ message: d.message, delivery: d.id });
      const base = fs.realpathSync(root) + path.sep;
      const files = d.files.map((f) => {
        const real = fs.realpathSync(f),
          stat = fs.statSync(real);
        if (
          !real.startsWith(base) ||
          !real.includes(path.sep + "outputs" + path.sep) ||
          !stat.isFile() ||
          stat.size > 50 * 1024 * 1024
        )
          throw Error("file denied");
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
    } catch {
      d.status = attempted ? "unknown" : "failed";
    }
    write(active, d);
    fs.renameSync(active, file + "." + d.status);
    cleanSentOutputs(d, root);
    try {
      await report({ id: d.id, status: d.status, sent_count: d.sent_count });
      d.reported = true;
      write(file + "." + d.status, d);
    } catch {}
  }
}
