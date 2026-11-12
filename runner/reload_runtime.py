"""Apply a published runtime once cloud work and local code execution are idle."""
import pathlib,json,urllib.request,ssl,os,subprocess,time,sys,shutil

H=pathlib.Path.home()/".inkboard-team"
SERVICES=["com.inkboard.team-qq","com.inkboard.team-runner","com.inkboard.team-owner","com.inkboard.team-utility","com.inkboard.team-utility-quick","com.inkboard.team-fetch"]
def live_markers():
    live=[]
    for path in (H/"sub").glob("*.running"):
        try:
            if time.time()-path.stat().st_mtime < 900:live.append(path)
        except FileNotFoundError:continue
    return live
def restart_services():
    for name in SERVICES:
        subprocess.run(["launchctl","kickstart","-k","gui/"+str(os.getuid())+"/"+name],check=name!="com.inkboard.team-fetch",capture_output=True)

def main():
    marker=H/"pending-restart.json"
    if not marker.exists() or (H/"current.json").exists() or any((H/"file-deliveries").glob("*.sending")) or live_markers():return
    config=json.loads((H/"config.json").read_text())
    request=urllib.request.Request(config["url"]+"/api/runner/idle",data=b'{"quiesce":true}',headers={"Authorization":"Bearer "+config["runnerToken"],"User-Agent":"TeamAgent/1","Content-Type":"application/json"})
    context=ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)
    try:
        with urllib.request.urlopen(request,context=context,timeout=20) as response: idle=json.load(response).get("idle")
    except Exception:return
    if not idle:return
    time.sleep(1)
    if (H/"current.json").exists() or any((H/"file-deliveries").glob("*.sending")) or live_markers():
        request.data=b'{"resume":true}'
        with urllib.request.urlopen(request,context=context,timeout=20):pass
        return
    raw=marker.read_text();pending=json.loads(raw)
    stage=pathlib.Path(pending["staged"]).resolve()
    if not stage.is_relative_to((H/"runtime-staging").resolve()):raise RuntimeError("Invalid runtime staging path")
    subprocess.run([sys.executable,str(stage/"scripts/install-local.py"),"--apply"],check=True,timeout=45)
    if marker.exists() and marker.read_text()==raw:marker.unlink()
    restart_services()
    request.data=b'{"resume":true}'
    with urllib.request.urlopen(request,context=context,timeout=20):pass
    shutil.rmtree(stage)
    print("已在空闲时启用新版本本机服务")
if __name__=="__main__":main()
