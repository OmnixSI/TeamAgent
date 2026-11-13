import unittest, tempfile, json, importlib.util, pathlib, subprocess, hashlib, urllib.error, os
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location(
    "execute", pathlib.Path(__file__).parents[1] / "runner/execute.py"
)
execute = importlib.util.module_from_spec(spec)
spec.loader.exec_module(execute)


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class RunnerTests(unittest.TestCase):
    def scenario(self, conflict=False, fail=False, snapshot_error=False):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d)
            h = home / ".inkboard-team"
            h.mkdir()
            (h / "worker-secrets.json").write_text('{"DEEPSEEK_API_KEY":"shared-test-key"}')
            (h / "config.json").write_text(
                json.dumps({"url": "https://test.invalid", "runnerToken": "fake-token"})
            )
            task = {
                "id": "test-task",
                "repo": "OmnixSI/WhalePartner",
                "title": "test",
                "detail": "test",
                "lease": "lease",
                "version": 2,
            }
            (h / "current.json").write_text(json.dumps(task))
            execute.H = h
            key = hashlib.sha256(
                (task["id"] + ":" + str(task["version"])).encode()
            ).hexdigest()[:32]
            work = h / "work" / key
            (work / "apps/api").mkdir(parents=True)
            (work / "apps/api/package.json").write_text(
                '{"scripts":{"test":"node --test"}}'
            )
            (h / "repos/WhalePartner").mkdir(parents=True)
            calls = []

            def fake(args, **kwargs):
                calls.append(args)
                if args[0].endswith("/dsh"):
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        json.dumps(
                            {
                                "type": "final",
                                "reason": {"kind": "completed"},
                                "text": "已完成",
                            }
                        )
                        + "\n",
                        "",
                    )
                if args[:2] == ["npm", "test"]:
                    return subprocess.CompletedProcess(
                        args,
                        1 if fail else 0,
                        "tests failed" if fail else "tests passed",
                        "",
                    )
                text = ""
                if args[:3] == ["git", "ls-files", "--modified"]:
                    text = "apps/api/src/test.ts\n"
                if args[:3] == ["git", "status", "--porcelain"]:
                    text = " M apps/api/src/test.ts\n"
                if args[:4] == ["git", "diff", "--cached", "--name-only"]:
                    text = "apps/api/src/test.ts\n"
                if args[:3] == ["gh", "pr", "create"]:
                    text = "https://github.com/example/test/pull/1"
                return subprocess.CompletedProcess(args, 0, text, "")

            parameters = execute.settings()
            parameters["execution"]["repair_rounds"] = 2
            snapshot = MagicMock(
                side_effect=RuntimeError("snapshot broke") if snapshot_error else None
            )
            with patch.object(execute, "settings", return_value=parameters), patch.object(execute, "REPOS", ["OmnixSI/WhalePartner"]), patch.object(execute, "run_agent", side_effect=fake), patch.object(
                pathlib.Path, "home", return_value=home
            ), patch.object(execute.subprocess, "run", side_effect=fake), patch.object(
                execute, "snapshot", snapshot
            ), patch(
                "urllib.request.urlopen",
                side_effect=(
                    urllib.error.HTTPError(
                        "https://test.invalid", 409, "conflict", {}, None
                    )
                    if conflict
                    else lambda *a, **kw: Response()
                ),
            ):
                execute.main()
            result = json.loads(next((h / "results").glob("*.json")).read_text())
            return result, calls, snapshot

    def test_actual_agent_timeout_terminates_its_process_group(self):
        import sys, time

        started = time.monotonic()
        with self.assertRaises(RuntimeError):
            execute.run_agent(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                task={},
                input="",
                cwd=None,
                env={},
                timeout=0.1,
            )
        self.assertLess(time.monotonic() - started, 5)

    def test_success_publishes_only_draft_after_tests(self):
        r, calls, _ = self.scenario()
        self.assertEqual(r["status"], "ready_for_review")
        self.assertTrue(any(c[:3] == ["git", "push", "-u"] for c in calls))
        self.assertTrue(any("--draft" in c for c in calls))
        self.assertFalse(any("merge" in c for c in calls))

    def test_human_change_prevents_push(self):
        r, calls, _ = self.scenario(conflict=True)
        self.assertEqual(r["status"], "needs_human")
        self.assertFalse(any(c[:2] == ["git", "push"] for c in calls))

    def test_two_failed_validations_stop(self):
        r, calls, _ = self.scenario(fail=True)
        self.assertEqual(r["status"], "needs_human")
        self.assertEqual(sum(c[:2] == ["npm", "test"] for c in calls), 2)
        self.assertFalse(any(c[:2] == ["git", "push"] for c in calls))

    def test_each_round_snapshots_and_snapshot_errors_do_not_change_result(self):
        r, calls, snapshot = self.scenario(fail=True)
        self.assertEqual([c.args[3] for c in snapshot.call_args_list], [1, 2])
        self.assertEqual(r["status"], "needs_human")
        r, calls, snapshot = self.scenario(snapshot_error=True)
        self.assertEqual(snapshot.call_count, 1)
        self.assertEqual(r["status"], "ready_for_review")

    def git_repo(self, root):
        repo = root / "repo"
        repo.mkdir()
        env = dict(
            os.environ,
            GIT_CONFIG_NOSYSTEM="1",
            GIT_CONFIG_GLOBAL="/dev/null",
            GIT_AUTHOR_NAME="t",
            GIT_AUTHOR_EMAIL="t@example.invalid",
            GIT_COMMITTER_NAME="t",
            GIT_COMMITTER_EMAIL="t@example.invalid",
        )

        def git(*args):
            subprocess.run(
                ["git", *args], cwd=repo, env=env, check=True, capture_output=True
            )

        git("init", "-q")
        (repo / ".env").write_text("TOKEN=old\n")
        git("add", "-f", ".env")
        (repo / "app.py").write_text("print('hello')\n")
        git("add", "app.py")
        git("commit", "-qm", "init")
        return repo

    def test_snapshot_writes_0600_patch_without_denied_files_and_posts_counts(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            h = root / ".inkboard-team"
            h.mkdir()
            execute.H = h
            (h / "config.json").write_text(
                json.dumps({"url": "https://test.invalid/", "runnerToken": "fake-token"})
            )
            repo = self.git_repo(root)
            (repo / ".env").write_text("TOKEN=ghp_" + "a" * 36 + "\n")
            (repo / "app.py").write_text(
                "print('hello')\nKEY = 'ghp_" + "b" * 36 + "'\n"
            )
            (repo / "notes.txt").write_text("untracked\n")
            requests = []

            def capture(request, **kwargs):
                requests.append(request)
                return Response()

            task = {"id": "test-task", "version": 2, "lease": "lease"}
            with patch("urllib.request.urlopen", side_effect=capture):
                execute.snapshot(repo, "k" * 32, task, 1, "第 1 轮完成 ghp_" + "c" * 36)
            target = h / "snapshots" / ("k" * 32) / "1.patch"
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            patch_text = target.read_text()
            self.assertIn("app.py", patch_text)
            self.assertNotIn(".env", patch_text)
            self.assertNotIn("ghp_", patch_text)
            self.assertEqual(len(requests), 1)
            self.assertEqual(
                requests[0].full_url, "https://test.invalid/api/runner/task_snapshot"
            )
            body = json.loads(requests[0].data)
            self.assertEqual(
                (body["id"], body["version"], body["lease"], body["round"]),
                ("test-task", 2, "lease", 1),
            )
            self.assertEqual(body["untracked"], 1)
            self.assertEqual((body["add"], body["del"]), (2, 1))
            hidden = {f["path"]: f.get("hidden") for f in body["files"]}
            self.assertEqual(len(body["files"]), 3)
            self.assertTrue(hidden[".env"])
            self.assertNotIn("ghp_", body["summary"])
            (repo / "app.py").write_text(
                "print('hello')\nKEY = 'ghp_" + "b" * 36 + "'\nmore\n"
            )
            (repo / "notes2.txt").write_text("untracked\n")
            with patch("urllib.request.urlopen", side_effect=capture):
                execute.snapshot(repo, "k" * 32, task, 2, "第 2 轮")
            self.assertEqual(len(requests), 2)
            second = json.loads(requests[1].data)
            self.assertEqual(second["round"], 2)
            self.assertEqual(second["untracked"], 2)
            self.assertEqual((second["add"], second["del"]), (3, 1))
            target = h / "snapshots" / ("k" * 32) / "2.patch"
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(".env", target.read_text())

    def test_snapshot_git_failure_and_post_failure_only_log(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            h = root / ".inkboard-team"
            h.mkdir()
            execute.H = h
            (h / "config.json").write_text(
                json.dumps({"url": "https://test.invalid", "runnerToken": "fake-token"})
            )
            task = {"id": "test-task", "version": 2, "lease": "lease"}
            with patch.object(
                execute.gitsafe, "run", side_effect=RuntimeError("git blocked")
            ):
                self.assertIsNone(execute.snapshot(root, "k" * 32, task, 1))
            self.assertFalse((h / "snapshots").exists())
            repo = self.git_repo(root)
            (repo / "app.py").write_text("print('changed')\n")
            with patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.HTTPError(
                    "https://test.invalid", 409, "conflict", {}, None
                ),
            ):
                self.assertIsNone(execute.snapshot(repo, "k" * 32, task, 1))
            self.assertTrue((h / "snapshots" / ("k" * 32) / "1.patch").exists())

    def test_snapshot_can_be_disabled_by_config(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            h = root / ".inkboard-team"
            h.mkdir()
            execute.H = h
            (h / "config.json").write_text(
                json.dumps(
                    {
                        "url": "https://test.invalid",
                        "runnerToken": "fake-token",
                        "snapshot": False,
                    }
                )
            )
            with patch.object(execute.gitsafe, "run") as run:
                execute.snapshot(root, "k" * 32, {"id": "x", "version": 1}, 1)
            run.assert_not_called()
            self.assertFalse((h / "snapshots").exists())


if __name__ == "__main__":
    unittest.main()
