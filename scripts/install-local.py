#!/usr/bin/env python3
"""Install reviewed source into the existing private runtime. No secrets are created or printed."""
from pathlib import Path
import shutil, subprocess, json, sys, os, plistlib, re, shlex, hashlib

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

def install_node_service(label, script, extra_keys):
    node = find_node()
    if not node:
        print("未安装 " + label.rsplit('.',1)[-1] + "：缺 Node ≥22")
        return
    runtime = Path.home() / ".inkboard-team"
    path = Path.home() / "Library/LaunchAgents" / (label + ".plist")
    log_name = label.removeprefix("com.inkboard.team-")
    data = plistlib.dumps({
        "Label": label,
        "ProgramArguments": [node, str(runtime / script)],
        "EnvironmentVariables": {"PATH": str(Path(node).parent) + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
        "StandardOutPath": str(runtime / (log_name + ".log")),
        "StandardErrorPath": str(runtime / (log_name + "-error.log")),
        **extra_keys,
    })
    changed = not path.exists() or path.read_bytes() != data
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    target = "gui/" + str(os.getuid())
    loaded = launchctl("print", target + "/" + label)
    if loaded and changed:
        if not launchctl("bootout", target + "/" + label):
            print("警告：" + label + " 停止失败")
            return
    if not loaded or changed:
        if not launchctl("bootstrap", target, str(path)):
            print("警告：" + label + " 加载失败")

def install_fetch_service():
    install_node_service(FETCH_LABEL, "fetcher.mjs", {"RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 30})

MEDIA_LABEL = "com.inkboard.team-media"
def install_media_service():
    install_node_service(MEDIA_LABEL, "media.mjs", {"WorkingDirectory": str(Path.home()/".inkboard-team"), "StartInterval": 60, "ProcessType": "Background", "Nice": 10, "LowPriorityIO": True})

def remove_media_service():
    path = Path.home()/"Library/LaunchAgents"/(MEDIA_LABEL+".plist")
    if not path.exists():
        return True
    target = "gui/"+str(os.getuid())+"/"+MEDIA_LABEL
    if not launchctl("bootout", target) and launchctl("print", target):
        print("警告：team-media 停止失败，保留运行文件。")
        return False
    path.unlink(missing_ok=True)
    return True

def asr_config():
    return {"python": str(Path.home()/".inkboard-team/xasr-venv/bin/python"), "model_dir": str(Path.home()/"Library/Application Support/NextThought/models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03")}

def ensure_xasr(source_root):
    venv = Path.home()/".inkboard-team/xasr-venv"
    requirements = source_root/"runner/requirements-xasr.txt"
    stamp = venv/".req.sha256"
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    try:
        if not (venv/"bin/python").exists():
            subprocess.run([sys.executable,"-m","venv",str(venv)],check=True,timeout=120)
        if not stamp.exists() or stamp.read_text().strip()!=digest:
            subprocess.run([str(venv/"bin/python"),"-m","pip","install","--no-cache-dir","-r",str(requirements)],check=True,timeout=600)
            stamp.write_text(digest)
        child_env = {key: os.environ.get(key, str(Path.home()) if key=="HOME" else "") for key in ["PATH","HOME","LANG"]}
        subprocess.run([str(venv/"bin/python"),str(source_root/"runner/xasr_transcribe.py"),"--check","--model-dir",asr_config()["model_dir"]],check=True,timeout=120,env=child_env)
        return True
    except (OSError, subprocess.SubprocessError):
        print("本机 X-ASR 运行库或已有模型检查失败；未下载模型。")
        return False

def write_asr_config(home):
    path=home/"config.json"
    config=json.loads(path.read_text()) if path.exists() else {}
    config["asr"]=asr_config()
    tmp=home/"config.asr.tmp"
    tmp.write_text(json.dumps(config,ensure_ascii=False,indent=2));tmp.chmod(0o600);tmp.replace(path)

def install_login_launcher():
    node = find_node()
    if not node:
        print("未安装登录入口：缺 Node ≥22")
        return
    runtime = Path.home() / ".inkboard-team"
    for name in ["browser", "browser/bili", "browser/x", "secrets"]:
        path = runtime / name
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.chmod(0o700)
    path = Path.home() / "Desktop/TeamAgent-登录.command"
    content = """#!/bin/zsh
# TeamAgent managed login launcher
choice=$(/usr/bin/osascript -e 'choose from list {"打开开发台（B 站扫码）", "X"} with title "TeamAgent 登录" with prompt "选择要登录的服务"') || exit 0
case "$choice" in
  "打开开发台（B 站扫码）"|"X") exec """ + shlex.quote(sys.executable) + " " + shlex.quote(str(runtime / "owner_unlock.py")) + """ ;;
  *) exit 0 ;;
esac
"""

    if not path.exists() or path.read_text() != content:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(content)
        tmp.chmod(0o700)
        tmp.replace(path)
    path.chmod(0o700)

def remove_login_launcher():
    path = Path.home() / "Desktop/TeamAgent-登录.command"
    if path.exists() and "# TeamAgent managed login launcher" in path.read_text():
        path.unlink()
    # Login profiles and cookies are user data and survive launcher rollback.

def main():
    home = Path.home() / ".inkboard-team"
    if "--remove-media" in sys.argv:
        if remove_media_service():
            for name in ["xasr-venv","media-tmp","media-reports","voice-tmp","media.lock","media-child.pid"]:
                path=home/name
                if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
                else: path.unlink(missing_ok=True)
        return
    if "--xasr-only" in sys.argv:
        home.mkdir(parents=True,exist_ok=True,mode=0o700)
        if not ensure_xasr(root): raise SystemExit(1)
        write_asr_config(home)
        return
    if "--remove" in sys.argv:
        remove_login_launcher()
        print("已移除 TeamAgent 桌面登录入口；保留本机登录数据。")
        return
    home = Path.home() / ".inkboard-team"
    if not (home / "config.json").exists() or not (home / "worker-secrets.json").exists():
        sys.exit("先按 docs/operations.md 配置本机私密文件；本脚本不会生成或显示凭据。")
    home.chmod(0o700)
    if "--apply" not in sys.argv:
        release=subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()
        stage=home/"runtime-staging"/release
        for directory in ["runner/sdk","config","scripts","shared"]:(stage/directory).mkdir(parents=True,exist_ok=True)
        for path in (root/"runner").glob("*"):
            if path.suffix in [".py",".mjs"]:shutil.copy2(path,stage/"runner"/path.name)
        shutil.copy2(root/"runner/requirements-xasr.txt",stage/"runner/requirements-xasr.txt")
        ensure_xasr(root)
        for name in ["package.json","package-lock.json"]:shutil.copy2(root/"runner/sdk"/name,stage/"runner/sdk"/name)
        for path in (root/"config").glob("*.json"):shutil.copy2(path,stage/"config"/path.name)
        shutil.copy2(root/"shared/deny_globs.json",stage/"shared/deny_globs.json")
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
    (home / "shared").mkdir(exist_ok=True)
    policy_tmp = home / "shared/deny_globs.json.tmp"
    shutil.copy2(root/"shared/deny_globs.json", policy_tmp)
    policy_tmp.replace(home/"shared/deny_globs.json")
    for path in (root / "runner").glob("*"):
        if path.suffix in [".py", ".mjs"]:
            tmp=home/(path.name+".tmp");shutil.copy2(path,tmp);tmp.replace(home/path.name)
    shutil.copy2(root/"runner/requirements-xasr.txt",home/"requirements-xasr.txt")
    (home / "sdk").mkdir(exist_ok=True)
    sdk_changed=not (home/"sdk/package-lock.json").exists() or (home/"sdk/package-lock.json").read_bytes()!=(root/"runner/sdk/package-lock.json").read_bytes() or not (home/"sdk/node_modules").exists()
    for name in ["package.json", "package-lock.json"]:
        shutil.copy2(root / "runner/sdk" / name, home / "sdk" / name)
    if sdk_changed: subprocess.run(
        ["npm", "ci", "--ignore-scripts", "--prefix", str(home / "sdk")], check=True
    )
    config = json.loads((home / "config.json").read_text())
    config["repos"] = parameters["repositories"]
    config["asr"] = asr_config()
    tmp = home / "config.tmp"
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2))
    tmp.chmod(0o600)
    tmp.replace(home / "config.json")
    if "--remove-fetch" in sys.argv:
        remove_fetch_service()
    else:
        install_fetch_service()
    if parameters.get("bili",{}).get("media",{}).get("enabled") is True:
        install_media_service()
    else:
        remove_media_service()
    install_login_launcher()
    print("已安装本机执行文件与独立 QQ SDK；确认没有运行中任务后重启相应 launchd 服务。")

if __name__ == "__main__":
    main()
