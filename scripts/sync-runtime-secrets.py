"""Materialize this repository's shared service secrets without printing values."""
import json, pathlib, os, subprocess

MAPPING = {"DEEPSEEK_API_KEY":"DEEPSEEK_API_KEY", "TEAM_ADMIN_TOKEN":"ADMIN_TOKEN", "TEAM_RUNNER_TOKEN":"RUNNER_TOKEN",
           "TEAM_QQ_APP_ID":"QQ_APP_ID", "TEAM_QQ_APP_SECRET":"QQ_APP_SECRET"}
# Optional secrets: absent values are skipped without failing the deployment.
OPTIONAL_MAPPING = {"TEAM_OPENAI_API_KEY": "OPENAI_API_KEY"}


def github_token():
    """Read the optional read-only token from GITHUB_TOKEN_FILE; never echo its value."""
    path = os.environ.get("GITHUB_TOKEN_FILE")
    if not path:
        print("未设置 GITHUB_TOKEN_FILE，跳过 GITHUB_TOKEN")
        return None
    try:
        value = pathlib.Path(path).expanduser().read_text().strip()
    except OSError:
        print("GITHUB_TOKEN_FILE 不可读，跳过 GITHUB_TOKEN")
        return None
    if not value:
        print("GITHUB_TOKEN_FILE 为空，跳过 GITHUB_TOKEN")
        return None
    print("已从 GITHUB_TOKEN_FILE 读取 GITHUB_TOKEN（未打印值）")
    return value


def main():
    h = pathlib.Path.home()/".inkboard-team"
    h.mkdir(mode=0o700, exist_ok=True)
    path = h/"worker-secrets.json"
    secrets = json.loads(path.read_text()) if path.exists() else {}
    for source, target in {**MAPPING, **OPTIONAL_MAPPING}.items():
        if os.environ.get(source):
            secrets[target] = os.environ[source]
    if not os.environ.get("TEAM_OPENAI_API_KEY"):
        print("未设置 TEAM_OPENAI_API_KEY，跳过 OPENAI_API_KEY")
    token = github_token()
    if token:
        secrets["GITHUB_TOKEN"] = token
    if not all(secrets.get(k) for k in MAPPING.values()):
        raise RuntimeError("部署缺少团队服务凭据，请按docs/maintenance.md配置仓库Secrets")
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(secrets))
    tmp.chmod(0o600)
    tmp.replace(path)
    config_path = h/"config.json"
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    config.update(url=os.environ.get("TEAM_BOARD_URL","https://inkboard-team.inkboard-server.workers.dev"),
                  adminToken=secrets["ADMIN_TOKEN"], runnerToken=secrets["RUNNER_TOKEN"])
    config.setdefault("hub", "http://127.0.0.1:3350")
    if os.environ.get("TEAM_AUTOLOOP_SOURCE_KEY"):
        config["sourceKey"] = os.environ["TEAM_AUTOLOOP_SOURCE_KEY"]
    tmp = config_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(config))
    tmp.chmod(0o600)
    tmp.replace(config_path)
    subprocess.run(["node_modules/.bin/wrangler", "secret", "bulk", str(path)], check=True)
    print("团队服务凭据已同步到部署环境")


if __name__ == "__main__":
    main()
