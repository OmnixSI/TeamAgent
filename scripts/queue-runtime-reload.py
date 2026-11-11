"""Schedule an idle-only service reload; the deployment job need not interrupt work."""
import pathlib,json,plistlib,subprocess,sys,shutil,os
h=pathlib.Path.home()/".inkboard-team"
release=subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()
marker=h/"pending-restart.json";marker.write_text(json.dumps({"release":release,"staged":str(h/"runtime-staging"/release)}));marker.chmod(0o600)
label="com.teamagent.runtime-reload"
path=pathlib.Path.home()/"Library/LaunchAgents"/(label+".plist")
if not path.exists():
    path.parent.mkdir(exist_ok=True)
    executable=shutil.which("python3") or sys.executable
    path.write_bytes(plistlib.dumps({"Label":label,"ProgramArguments":[executable,str(h/"reload_runtime.py")],"EnvironmentVariables":{"PATH":os.environ.get("PATH","/usr/bin:/bin")},"StartInterval":30,"RunAtLoad":True,"WorkingDirectory":str(h),"StandardOutPath":str(h/"reload.log"),"StandardErrorPath":str(h/"reload-error.log")}))
    subprocess.run(["launchctl","bootstrap","gui/"+str(os.getuid()),str(path)],check=True)
else:subprocess.run(["launchctl","kickstart","gui/"+str(os.getuid())+"/"+label],check=True)
print("本机更新已排队，空闲时生效")
