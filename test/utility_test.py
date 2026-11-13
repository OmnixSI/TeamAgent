import unittest, tempfile, pathlib, json, importlib.util, subprocess
from unittest.mock import patch, MagicMock


class UtilityTests(unittest.TestCase):
    def scenario(self, times_out=False, already_sent=False, report_failure=False):
        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            h = home / ".inkboard-team"
            h.mkdir()
            (h / "config.json").write_text(
                '{"url":"https://example.invalid","runnerToken":"fake"}'
            )
            (h / "worker-secrets.json").write_text('{"DEEPSEEK_API_KEY":"shared-test-key"}')
            with patch.object(pathlib.Path, "home", return_value=home):
                spec = importlib.util.spec_from_file_location(
                    "utility", pathlib.Path(__file__).parents[1] / "runner/utility.py"
                )
                u = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(u)
            reports = []
            claims = 0
            job = {
                "id": "file-test",
                "payload": {
                    "message": "request1",
                    "lease": "lease1",
                    "effort": "high",
                    "instructions": "生成CSV",
                },
            }

            def cloud(path, body):
                nonlocal claims
                if path in ["inputs", "media/heartbeat"]:
                    return {"messages": []}
                if path == "media/claim":
                    claims += 1
                    return {"job": job if claims == 1 else None}
                reports.append(body)
                if report_failure and len(reports) == 1:
                    raise u.urllib.error.URLError("cloud connection lost")
                return {"ok": True}

            proc = MagicMock()
            proc.pid = 12345
            if times_out:
                proc.communicate.side_effect = [subprocess.TimeoutExpired(["private-command"], 120), ("", "")]
            else:
                proc.communicate.return_value = (
                        json.dumps(
                            {
                                "type": "final",
                                "reason": {"kind": "completed"},
                                "text": "CSV已生成",
                            }
                        ),
                        "",
                    )

            def spawn(*a, **kw):
                self.assertEqual(kw["stdin"], subprocess.PIPE)
                self.assertEqual(kw["stdout"], subprocess.PIPE)
                self.assertTrue(kw["start_new_session"])
                out = pathlib.Path(kw["cwd"]) / "outputs/example.csv"
                out.write_text("项目,数量\n大肥鱼,3\n")
                return proc

            if already_sent:
                import hashlib

                q = h / "file-deliveries"
                q.mkdir()
                (
                    q
                    / (
                        hashlib.sha256(job["id"].encode()).hexdigest()[:32]
                        + ".json.sent"
                    )
                ).write_text("{}")
            with patch.object(u, "cloud", side_effect=cloud), patch.object(
                u.subprocess, "Popen", side_effect=spawn
            ) as agent, patch.object(u.os, "killpg") as kill, patch.object(
                pathlib.Path, "home", return_value=home
            ):
                if report_failure:
                    with self.assertRaises(u.urllib.error.URLError):
                        u.once()
                    u.once()
                    self.assertEqual(agent.call_count, 1)
                else:
                    u.once()
            work = h / "utility" / (
                __import__("hashlib").sha256(job["id"].encode()).hexdigest()[:32]
            )
            if not report_failure:
                assert not work.exists(), "utility work directory was not cleaned"
            return (
                reports,
                (
                    list((h / "file-deliveries").glob("*.json"))
                    if (h / "file-deliveries").exists()
                    else []
                ),
                kill.call_count,
            )

    def test_file_delivery_manifest_and_terminal_report(self):
        reports, files, kills = self.scenario()
        self.assertEqual(len(files), 1)
        self.assertIn("CSV已生成", reports[0]["result"])
        self.assertGreaterEqual(kills, 1)

    def test_timeout_kills_group_and_only_reports_human_text(self):
        reports, files, kills = self.scenario(times_out=True)
        self.assertGreaterEqual(kills, 1)
        self.assertFalse(reports[0]["success"])
        self.assertIn("跑了 8 分钟没跑完", reports[0]["result"])
        self.assertNotIn("输入已保留", reports[0]["result"])
        self.assertNotIn("这份资料暂时没处理完", reports[0]["result"])
        self.assertNotIn("private-command", reports[0]["result"])
        self.assertEqual(files, [])

    def test_cloud_receipt_failure_reuses_completion_without_rerunning_agent(self):
        reports, files, kills = self.scenario(report_failure=True)
        self.assertEqual(len(reports), 2)
        self.assertEqual(len(files), 1)
        self.assertGreaterEqual(kills, 1)

    def test_completed_delivery_is_not_enqueued_twice(self):
        reports, files, kills = self.scenario(already_sent=True)
        self.assertEqual(files, [])

    def test_download_budget_stops_at_100_mib_and_keeps_early_files(self):
        size = 40 * 1024 * 1024
        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            h = home / ".inkboard-team"
            h.mkdir()
            (h / "config.json").write_text(
                '{"url":"https://example.invalid","runnerToken":"fake"}'
            )
            (h / "worker-secrets.json").write_text('{"DEEPSEEK_API_KEY":"shared-test-key"}')
            with patch.object(pathlib.Path, "home", return_value=home):
                spec = importlib.util.spec_from_file_location(
                    "utility_budget",
                    pathlib.Path(__file__).parents[1] / "runner/utility.py",
                )
                u = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(u)
            job = {
                "id": "file-budget",
                "payload": {
                    "message": "request",
                    "lease": "lease",
                    "effort": "high",
                    "inputs": [
                        {
                            "attachments": [
                                {
                                    "filename": f"s{source}-{index}.bin",
                                    "content_type": "application/octet-stream",
                                    "url": f"https://files.invalid/{source}/{index}",
                                }
                                for index in range(5)
                            ]
                        }
                        for source in range(3)
                    ],
                },
            }
            captured, downloads = {}, []

            def fake_download(url, target, limit=None):
                if limit is not None and size > limit:
                    raise u.InputTooLarge("too_large")
                with target.open("wb") as output:
                    output.truncate(size)
                downloads.append((url, target, target.stat().st_size))
                return size

            def cloud(path, body):
                if path in ["inputs", "media/heartbeat"]:
                    return {"messages": []}
                if path == "media/claim":
                    return {"job": job}
                captured["report"] = body
                return {"ok": True}

            def communicate(input=None, timeout=None):
                if input is not None:
                    captured["task"] = input
                cwd = pathlib.Path(u.subprocess.Popen.call_args.kwargs["cwd"])
                captured["inputs"] = sorted(x.name for x in (cwd / "inputs").iterdir())
                (cwd / "outputs/example.csv").write_text("ok")
                return (
                    json.dumps(
                        {
                            "type": "final",
                            "reason": {"kind": "completed"},
                            "text": "完成",
                        }
                    ),
                    "",
                )

            proc = MagicMock()
            proc.pid = 12345
            proc.communicate.side_effect = communicate
            with patch.object(u, "cloud", side_effect=cloud), patch.object(
                u.subprocess, "Popen", return_value=proc
            ), patch.object(u, "download", side_effect=fake_download), patch.object(
                u.os, "killpg"
            ), patch.object(pathlib.Path, "home", return_value=home):
                u.once()
            self.assertEqual(len(downloads), 2)
            self.assertTrue(all(item[2] == size for item in downloads))
            kept = [name for name in captured["inputs"] if name.endswith(".bin")]
            self.assertEqual(kept, ["0-s0-0.bin", "1-s0-1.bin"])
            self.assertIn("too_large", captured["task"])
            self.assertIn("s0-2.bin", captured["task"])
            self.assertNotEqual(captured["report"].get("success"), False)
            self.assertIn("完成", captured["report"]["result"])

    def test_download_rejects_a_file_over_the_remaining_budget(self):
        import http.server, socket, threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(40 * 1024 * 1024))
                self.end_headers()
                try:
                    self.wfile.write(b"x")
                except BrokenPipeError:
                    pass

            def log_message(self, *args):
                pass

        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            (home / ".inkboard-team").mkdir()
            (home / ".inkboard-team/config.json").write_text(
                '{"url":"https://example.invalid","runnerToken":"fake"}'
            )
            with patch.object(pathlib.Path, "home", return_value=home):
                spec = importlib.util.spec_from_file_location(
                    "utility_download",
                    pathlib.Path(__file__).parents[1] / "runner/utility.py",
                )
                u = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(u)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            target = home / "third.bin"

            def local_connection(address, timeout=None):
                client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                client.settimeout(timeout)
                client.connect(("127.0.0.1", port))
                return client

            try:
                with patch.object(u, "safe", side_effect=lambda url: url), patch.object(
                    u.socket,
                    "getaddrinfo",
                    return_value=[
                        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))
                    ],
                ), patch.object(
                    u.socket,
                    "create_connection",
                    side_effect=local_connection,
                ):
                    with self.assertRaises(u.InputTooLarge):
                        u.download(
                            f"http://public.invalid:{port}/third.bin",
                            target,
                            20 * 1024 * 1024,
                        )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
