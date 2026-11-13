"""B-5: INKBOARD_TEAM_HOME isolation and bridge daemon registration."""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULES = ["team_home", "settings", "gitsafe", "subagent", "repo_index", "execute",
           "utility", "bridge", "reload_runtime", "owner", "owner_unlock"]


class TeamHomeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="b5-home-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.real_home = self.root / "home"
        self.real_home.mkdir()
        self.real = self.real_home / ".inkboard-team"
        self.real.mkdir()
        self.write_runtime(self.real, "https://real.example", "real-token")
        self.iso = self.root / "iso"
        self.write_runtime(self.iso, "http://127.0.0.1:8787", "local-token")
        (self.iso / "agent-settings.json").write_text(json.dumps({"repositories": ["Iso/Repo"], "marker": "iso"}))

        self.env = patch.dict(os.environ, {"HOME": str(self.real_home)})
        self.env.start()
        self.addCleanup(self.env.stop)
        saved = os.environ.pop("INKBOARD_TEAM_HOME", None)

        def restore_env():
            if saved is None:
                os.environ.pop("INKBOARD_TEAM_HOME", None)
            else:
                os.environ["INKBOARD_TEAM_HOME"] = saved
        self.addCleanup(restore_env)
        self.path = patch.object(sys, "path", [str(ROOT / "runner"), *sys.path])
        self.path.start()
        self.addCleanup(self.path.stop)
        self.addCleanup(self.reload_all)

    def write_runtime(self, home, url, token):
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.json").write_text(json.dumps({
            "url": url, "runnerToken": token, "hub": "https://hub.example",
            "sourceKey": "source", "repos": [], "subagent": {"enabled": False},
        }))
        (home / "worker-secrets.json").write_text(json.dumps({"DEEPSEEK_API_KEY": "synthetic-" + token}))
        (home / "sub").mkdir(exist_ok=True)

    def fresh(self, name):
        if name == "bridge":
            for dependency in ["subagent", "repo_index", "team_home"]:
                sys.modules.pop("runner." + dependency, None)
        sys.modules.pop("runner." + name, None)
        return importlib.import_module("runner." + name)

    def fresh_owner(self):
        import http.server

        class NoServer:
            def __init__(self, *args, **kwargs):
                pass

            def serve_forever(self):
                pass

        with patch.object(http.server, "ThreadingHTTPServer", NoServer):
            return self.fresh("owner")

    def reload_all(self):
        for name in MODULES:
            if name == "owner":
                sys.modules.pop("runner.owner", None)
                continue
            module = sys.modules.get("runner." + name)
            if module is not None:
                importlib.reload(module)

    def test_unset_home_matches_main_exactly(self):
        expected = Path.home() / ".inkboard-team"
        for name, attribute in [("bridge", "HOME"), ("subagent", "H"), ("repo_index", "H"),
                                ("execute", "H"), ("utility", "H"), ("reload_runtime", "H")]:
            module = self.fresh(name)
            self.assertEqual(getattr(module, attribute), expected, name)
        owner = self.fresh_owner()
        self.assertEqual(owner.Handler.runtime, expected)
        subagent = self.fresh("subagent")
        self.assertEqual(subagent.private_sub("x"), expected / "sub/x")
        gitsafe = self.fresh("gitsafe")
        self.assertTrue(gitsafe._private_target(ROOT, expected / "sub/x"))
        self.assertFalse(gitsafe._private_target(ROOT, expected / "outside/x"))

    def test_env_selects_home_config_and_every_reader(self):
        with patch.dict(os.environ, {"INKBOARD_TEAM_HOME": str(self.iso)}):
            expected = self.iso
            for name, attribute in [("bridge", "HOME"), ("subagent", "H"), ("repo_index", "H"),
                                    ("execute", "H"), ("utility", "H"), ("reload_runtime", "H")]:
                module = self.fresh(name)
                self.assertEqual(getattr(module, attribute), expected, name)
            bridge = self.fresh("bridge")
            self.assertEqual(bridge.CONFIG["url"], "http://127.0.0.1:8787")
            self.assertEqual(bridge.CONFIG["runnerToken"], "local-token")
            owner = self.fresh_owner()
            self.assertEqual(owner.C["url"], "http://127.0.0.1:8787")
            self.assertEqual(owner.Handler.runtime, expected)
            subagent = self.fresh("subagent")
            self.assertEqual(subagent.private_sub("x"), expected / "sub/x")
            gitsafe = self.fresh("gitsafe")
            self.assertTrue(gitsafe._private_target(ROOT, expected / "sub/x"))
            self.assertFalse(gitsafe._private_target(ROOT, expected / "outside/x"))
            reload_runtime = self.fresh("reload_runtime")
            marker = expected / "sub" / "x.running"
            marker.write_text("{}")
            self.assertEqual(reload_runtime.live_markers(), [marker])
            marker.unlink()

    def test_env_selects_settings_and_secrets(self):
        with patch.dict(os.environ, {"INKBOARD_TEAM_HOME": str(self.iso), "DEEPSEEK_API_KEY": ""}):
            settings = self.fresh("settings")
            self.assertEqual(settings.api_key(), "synthetic-local-token")
            with patch.object(settings, "__file__", str(self.root / "no-repo" / "runner" / "settings.py")):
                self.assertEqual(settings.settings()["marker"], "iso")

    def test_owner_unlock_uses_selected_home(self):
        with patch.dict(os.environ, {"INKBOARD_TEAM_HOME": str(self.iso)}):
            owner_unlock = self.fresh("owner_unlock")
            with patch.object(owner_unlock, "mint_code", return_value="code") as mint, \
                    patch.object(owner_unlock.subprocess, "run") as run:
                owner_unlock.main()
            mint.assert_called_once_with(self.iso)
            self.assertTrue(run.called)

    def test_bridge_starts_subagent_loop_as_daemon(self):
        bridge = self.fresh("bridge")
        started = []

        class Thread:
            def __init__(self, target=None, daemon=None, **kwargs):
                started.append((target, daemon))

            def start(self):
                pass

        with patch.object(bridge.threading, "Thread", Thread):
            bridge.start_daemons()
        self.assertEqual([target.__name__ for target, _ in started], ["sync_loop", "loop", "loop"])
        self.assertIs(started[1][0], bridge.repo_index.loop)
        self.assertIs(started[2][0], bridge.subagent.loop)
        self.assertTrue(all(daemon for _, daemon in started))


if __name__ == "__main__":
    unittest.main()
