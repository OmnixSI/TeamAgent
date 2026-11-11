#!/usr/bin/env python3
"""Install reviewed source into the existing private runtime. No secrets are created or printed."""
from pathlib import Path
import shutil, subprocess, json, sys, os, plistlib, re

root = Path(__file__).resolve().parents[1]
FETCH_LABEL = "com.inkboard.team-fetch"

def find_node():
    candidates = []
    path_node = shutil.which("node")
    if path_node:
        candidates.append(path_node)
    versions = list((Path.home() / ".nvm/versions/node").glob("*/bin/node"))
    def version(path):
        return tuple(int(x) for x in re.findall(r"\d+", path.parents[1].name))
    candidates.extend(sorted(versions, key=version, reverse=True))
    if Path("/opt/homebrew/bin/node").exists():
        candidates.append("/opt/homebrew/bin/node")
    for candidate in dict.fromkeys(os.path.realpath(p) for p in candidates):
        try:
            result = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=5)
            match = re.match(r"v?(\d+)", result.stdout.strip())
            if result.returncode == 0 and match and int(match[1]) >= 22:
                return candidate
        except (OSError, subprocess.SubprocessError):
            continue
    return None

def launchctl(*args):
    try:
        return subprocess.run(["launchctl", *args], capture_output=True, text=True, timeout=8).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False

def remove_fetch_service():
    if not launchctl("bootout", "gui/" + str(os.getuid()) + "/" + FETCH_LABEL):
        print("警告：team-fetch 停止失败，保留 plist；服务可能仍在运行。")
        return
    path = Path.home() / "Library/LaunchAgents" / (FETCH_LABEL + ".plist")
    path.unlink(missing_ok=True)

def install_fetch_service():
    node = find_node()
    if not node:
        print("未安装 team-fetch：缺 Node ≥22")
        return
    runtime = Path.home() / ".inkboard-team"
    path = Path.home() / "Library/LaunchAgents" / (FETCH_LABEL + ".plist")
    data = plistlib.dumps({
        "Label": FETCH_LABEL,
        "ProgramArguments": [node, str(runtime / "fetcher.mjs")],
        "EnvironmentVariables": {"PATH": str(Path(node).parent) + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 30,
        "StandardOutPath": str(runtime / "fetch.log"),
        "StandardErrorPath": str(runtime / "fetch-error.log"),
    })
    changed = not path.exists() or path.read_bytes() != data
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    target = "gui/" + str(os.getuid())
    loaded = launchctl("print", target + "/" + FETCH_LABEL)
    if loaded and changed:
        if not launchctl("bootout", target + "/" + FETCH_LABEL):
            print("警告：team-fetch 停止失败")
            return
    if not loaded or changed:
        if not launchctl("bootstrap", target, str(path)):
            print("警告：team-fetch 加载失败")

def main():
    home = Path.home() / ".inkboard-team"
    if not (home / "config.json").exists() or not (home / "worker-secrets.json").exists():
        sys.exit("先按 docs/operations.md 配置本机私密文件；本脚本不会生成或显示凭据。")
    home.chmod(0o700)
    if "--apply" not in sys.argv:
        release=subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()
        stage=home/"runtime-staging"/release
        for directory in ["runner/sdk","config","scripts"]:(stage/directory).mkdir(parents=True,exist_ok=True)
        for path in (root/"runner").glob("*"):
            if path.suffix in [".py",".mjs"]:shutil.copy2(path,stage/"runner"/path.name)
        for name in ["package.json","package-lock.json"]:shutil.copy2(root/"runner/sdk"/name,stage/"runner/sdk"/name)
        for path in (root/"config").glob("*.json"):shutil.copy2(path,stage/"config"/path.name)
        shutil.copy2(__file__,stage/"scripts/install-local.py")
        # This small coordinator never stops a working process before the idle gate.
        shutil.copy2(root/"runner/reload_runtime.py",home/"reload_runtime.py")
        print("本机版本已暂存，等待空闲后应用")
        sys.exit(0)
    parameters=json.loads((root/"config/team.json").read_text())
    target=home/"agent-settings.json"
    tmp=target.with_suffix(".tmp");tmp.write_text(json.dumps(parameters,ensure_ascii=False));tmp.chmod(0o600);tmp.replace(target)
    for name,effort in [("dsh-team.yml",parameters["model"]["effort_by_kind"].get("code",parameters["model"]["important_effort"])),("dsh-chat.yml",parameters["model"]["quick_effort"])]:
        profile=home/name
        profile.write_text("- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: deepseek-official\n    model: "+parameters["model"]["name"]+"\n    reasoningEffort: "+effort+"\n")
        profile.chmod(0o600)
    for name in ["config.json", "worker-secrets.json"]:
        (home / name).chmod(0o600)
    # Runtime and services keep their existing names so pairing, spool, tasks and credentials survive migration.
    for path in (root / "runner").glob("*"):
        if path.suffix in [".py", ".mjs"]:
            tmp=home/(path.name+".tmp");shutil.copy2(path,tmp);tmp.replace(home/path.name)
    (home / "sdk").mkdir(exist_ok=True)
    sdk_changed=not (home/"sdk/package-lock.json").exists() or (home/"sdk/package-lock.json").read_bytes()!=(root/"runner/sdk/package-lock.json").read_bytes() or not (home/"sdk/node_modules").exists()
    for name in ["package.json", "package-lock.json"]:
        shutil.copy2(root / "runner/sdk" / name, home / "sdk" / name)
    if sdk_changed: subprocess.run(
        ["npm", "ci", "--ignore-scripts", "--prefix", str(home / "sdk")], check=True
    )
    config = json.loads((home / "config.json").read_text())
    config["repos"] = parameters["repositories"]
    tmp = home / "config.tmp"
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2))
    tmp.chmod(0o600)
    tmp.replace(home / "config.json")
    if "--remove-fetch" in sys.argv:
        remove_fetch_service()
    else:
        install_fetch_service()
    print("已安装本机执行文件与独立 QQ SDK；确认没有运行中任务后重启相应 launchd 服务。")

if __name__ == "__main__":
    main()
