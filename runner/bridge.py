#!/usr/bin/env python3
"""One leased task at a time. Source credentials remain local; owner credentials never leave this machine."""
import threading, json, os, time, urllib.request, urllib.error, pathlib, subprocess, base64, ssl, hashlib

import repo_index

HOME = pathlib.Path.home() / ".inkboard-team"
CONFIG = json.loads((HOME / "config.json").read_text())
CURRENT = HOME / "current.json"


def save(v):
    p = CURRENT.with_suffix(".tmp")
    p.write_text(json.dumps(v, ensure_ascii=False))
    p.chmod(0o600)
    p.replace(CURRENT)


def request(base, path, key, body=None):
    req = urllib.request.Request(
        base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "User-Agent": "InkBoard-Team/1",
        },
    )
    with urllib.request.urlopen(
        req,
        timeout=25,
        context=ssl.create_default_context(
            cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None
        ),
    ) as r:
        return json.load(r)


def cloud(path, body):
    return request(CONFIG["url"], "/api/runner/" + path, CONFIG["runnerToken"], body)


last_sync = 0
check_evidence = {}


def sync_repos():
    global last_sync
    if time.time() - last_sync < 300:
        return
    repositories = list(CONFIG["repos"])
    organization = subprocess.run(
        [
            "gh",
            "repo",
            "list",
            "OmnixSI",
            "--limit",
            "1000",
            "--json",
            "nameWithOwner,isArchived",
        ],
        text=True,
        capture_output=True,
        timeout=30,
    )
    if organization.returncode == 0:
        repositories = sorted(
            set(repositories)
            | {
                r["nameWithOwner"]
                for r in json.loads(organization.stdout)
            }
        )
    for repo in repositories:
        context = {"repo": repo, "syncedAt": time.time()}
        for key, path in [
            ("metadata", ""),
            ("readme", "/readme"),
            ("issues", "/issues?state=open&per_page=8"),
            ("pulls", "/pulls?state=open&per_page=5"),
        ]:
            r = subprocess.run(
                ["gh", "api", "repos/" + repo + path],
                text=True,
                capture_output=True,
                timeout=30,
            )
            if r.returncode:
                context[key] = {"unavailable": True}
                continue
            d = json.loads(r.stdout)
            if key == "readme":
                context[key] = base64.b64decode(d["content"]).decode(
                    "utf8", errors="replace"
                )[:16000]
            elif key == "metadata":
                context[key] = {k: d.get(k) for k in ["default_branch", "pushed_at"]}
            else:
                context[key] = [
                    {k: v.get(k) for k in ["number", "title", "html_url"]} for v in d
                ]
        for filename in [
            "AGENTS.md",
            "CONTRIBUTING.md",
            "package.json",
            "docs/MEMORY_ARCHITECTURE.md",
            "docs/PERSONALITY.md",
        ]:
            rr = subprocess.run(
                ["gh", "api", "repos/" + repo + "/contents/" + filename],
                text=True,
                capture_output=True,
                timeout=20,
            )
            if rr.returncode != 0 and "404" not in rr.stderr:
                context.setdefault("file_errors", []).append(filename)
            if rr.returncode == 0:
                data = json.loads(rr.stdout)
                if data.get("encoding") == "base64":
                    context.setdefault("files", {})[filename] = base64.b64decode(
                        data["content"]
                    ).decode("utf8", errors="replace")[:10000]
        branch = context.get("metadata", {}).get("default_branch")
        if branch:
            head = subprocess.run(
                ["gh", "api", "repos/" + repo + "/commits/" + branch],
                text=True,
                capture_output=True,
                timeout=20,
            )
            if head.returncode != 0:
                context["head"] = {"unavailable": True}
            if head.returncode == 0:
                commit = json.loads(head.stdout)
                person = commit.get("author") or {}
                authored = commit.get("commit", {}).get("author") or {}
                context["head"] = {
                    "sha": commit.get("sha"),
                    "url": commit.get("html_url"),
                    "message": str(commit.get("commit", {}).get("message") or "").split(
                        "\n"
                    )[0][:300],
                    "author": {
                        "name": authored.get("name")
                        or person.get("login")
                        or "未知作者",
                        "login": person.get("login"),
                        "url": person.get("html_url"),
                    },
                    "at": authored.get("date"),
                }
            rr = subprocess.run(
                [
                    "gh",
                    "api",
                    "repos/" + repo + "/commits/" + branch + "/check-runs?per_page=20",
                ],
                text=True,
                capture_output=True,
                timeout=20,
            )
            if rr.returncode != 0:
                context["checks"] = {"unavailable": True}
            if rr.returncode == 0:
                context["checks"] = [
                    {
                        k: v.get(k)
                        for k in [
                            "id",
                            "head_sha",
                            "name",
                            "status",
                            "conclusion",
                            "html_url",
                            "output",
                        ]
                    }
                    for v in json.loads(rr.stdout).get("check_runs", [])
                ]
        for check in (
            context.get("checks", []) if isinstance(context.get("checks"), list) else []
        ):
            output = check.pop("output", None)
            if output:
                check["evidence"] = {
                    "title": str(output.get("title") or "")[:300],
                    "summary": str(output.get("summary") or "")[:3500],
                }
            if check.get("conclusion") in ["failure", "timed_out", "action_required"]:
                evidence_key = (repo, check["id"], check.get("head_sha"))
                if evidence_key not in check_evidence:
                    annotation = subprocess.run(
                        [
                            "gh",
                            "api",
                            "repos/"
                            + repo
                            + "/check-runs/"
                            + str(check["id"])
                            + "/annotations?per_page=10",
                        ],
                        text=True,
                        capture_output=True,
                        timeout=20,
                    )
                    if annotation.returncode == 0:
                        check_evidence[evidence_key] = [
                            {
                                "message": str(a.get("message") or "")[:1800],
                                "path": a.get("path"),
                                "level": a.get("annotation_level"),
                            }
                            for a in json.loads(annotation.stdout)
                            if a.get("annotation_level") == "failure"
                        ][:3]
                if evidence_key in check_evidence:
                    check.setdefault("evidence", {})["annotations"] = check_evidence[
                        evidence_key
                    ]
        if len(check_evidence) > 100:
            for k in list(check_evidence)[:-60]:
                check_evidence.pop(k, None)
        cloud("context", {"repo": repo, "context": context})
    last_sync = time.time()


def tick():
    t = json.loads(CURRENT.read_text()) if CURRENT.exists() else None
    if not t:
        t = cloud("claim", {}).get("task")
        if not t:
            return
        save(t)
    if not t.get("event"):
        a = request(
            CONFIG["hub"],
            "/v1/events",
            CONFIG["sourceKey"],
            {
                "id": hashlib.sha256(
                    (t["id"] + ":" + str(t["version"])).encode()
                ).hexdigest(),
                "type": "team.task",
                "subject": "task:"
                + hashlib.sha256(
                    (t["id"] + ":" + str(t["version"])).encode()
                ).hexdigest(),
                "summary": t["title"][:200],
                "detail": "任务资料在本机受限配置目录。",
            },
        )
        if not a.get("routed"):
            raise RuntimeError("No autoloop rule matched")
        t["event"] = a["event"]
        save(t)
    cloud("heartbeat", {"id": t["id"], "lease": t["lease"], "version": t["version"]})
    ev = request(CONFIG["hub"], "/v1/events/" + str(t["event"]), CONFIG["sourceKey"])
    runs = ev.get("runs", [])
    if runs and runs[-1]["state"] in ("done", "nothing", "cancelled"):
        result_path = (
            HOME
            / "results"
            / (
                hashlib.sha256((t["id"] + ":" + str(t["version"])).encode()).hexdigest()
                + ".json"
            )
        )
        result = (
            json.loads(result_path.read_text())
            if result_path.exists()
            else {
                "status": "needs_human",
                "result": "执行未留下完整结果，请检查本机 autoloop。",
            }
        )
        cloud(
            "report", dict(id=t["id"], lease=t["lease"], version=t["version"], **result)
        )
        CURRENT.unlink()


def sync_loop():
    while True:
        try:
            sync_repos()
        except Exception as e:
            print("repo sync", type(e).__name__, flush=True)
        time.sleep(30)


if __name__ == "__main__":
    threading.Thread(target=sync_loop, daemon=True).start()
    threading.Thread(target=repo_index.loop, daemon=True).start()
    while True:
        try:
            tick()
        except urllib.error.HTTPError as e:
            print("bridge HTTP", e.code, flush=True)
            if e.code == 409 and CURRENT.exists():
                # Human changed the task or the lease expired. Preserve the handoff; never silently overwrite it.
                CURRENT.rename(HOME / ("conflict-" + str(int(time.time())) + ".json"))
        except Exception as e:
            print("bridge", type(e).__name__, flush=True)
        time.sleep(15)
