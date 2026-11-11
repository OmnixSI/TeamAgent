#!/usr/bin/env python3
"""Install reviewed source into the existing private runtime. No secrets are created or printed."""
from pathlib import Path
import shutil, subprocess, json, sys

root = Path(__file__).resolve().parents[1]
home = Path.home() / ".inkboard-team"
if not (home / "config.json").exists() or not (home / "worker-secrets.json").exists():
    sys.exit("先按 docs/operations.md 配置本机私密文件；本脚本不会生成或显示凭据。")
home.chmod(0o700)
for name in ["config.json", "worker-secrets.json"]:
    (home / name).chmod(0o600)
# Runtime and services keep their existing names so pairing, spool, tasks and credentials survive migration.
for path in (root / "runner").glob("*"):
    if path.suffix in [".py", ".mjs"]:
        shutil.copy2(path, home / path.name)
(home / "sdk").mkdir(exist_ok=True)
for name in ["package.json", "package-lock.json"]:
    shutil.copy2(root / "runner/sdk" / name, home / "sdk" / name)
subprocess.run(
    ["npm", "ci", "--ignore-scripts", "--prefix", str(home / "sdk")], check=True
)
config = json.loads((home / "config.json").read_text())
config["repos"] = [
    "OmnixSI/NextThought",
    "OmnixSI/NextThought-Website",
    "OmnixSI/WhalePartner",
    "OmnixSI/peiwan-store-platform-blueprint",
    "OmnixSI/TeamAgent",
]
tmp = home / "config.tmp"
tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2))
tmp.chmod(0o600)
tmp.replace(home / "config.json")
print("已安装本机执行文件与独立 QQ SDK；确认没有运行中任务后重启相应 launchd 服务。")
