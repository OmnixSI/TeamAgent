"""Shared repository parameters; credentials come from the deployment environment."""
import json, pathlib, os, shutil

try:
    from runner import team_home
except ModuleNotFoundError:
    import team_home

def settings():
    repository = pathlib.Path(__file__).resolve().parents[1] / "config/team.json"
    path = pathlib.Path(os.environ["TEAM_AGENT_SETTINGS"]) if os.environ.get("TEAM_AGENT_SETTINGS") else repository if repository.exists() else team_home.home() / "agent-settings.json"
    return json.loads(path.read_text())

def api_key():
    value = os.environ.get("DEEPSEEK_API_KEY")
    if not value:
        value = json.loads((team_home.home() / "worker-secrets.json").read_text())["DEEPSEEK_API_KEY"]
    return value

def dsh_program():
    value = os.environ.get("TEAM_AGENT_DSH") or shutil.which("dsh")
    if value:
        return value
    fallback = pathlib.Path("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh")
    if fallback.exists():
        return str(fallback)
    return "dsh"
