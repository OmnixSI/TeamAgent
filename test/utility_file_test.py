"""D6 S-07: mode=file writes bytes and reports without starting the model.

Covers the delivery contract (file written, report payload, no subprocess) and
the path rules (basename only, `..` and absolute paths refused).
"""
import base64
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]


class UtilityFileDeliveryTests(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        home = pathlib.Path(temp.name)
        h = home / ".inkboard-team"
        h.mkdir()
        (h / "config.json").write_text(
            '{"url":"https://example.invalid","runnerToken":"synthetic"}'
        )
        (h / "worker-secrets.json").write_text("{}")
        with patch.object(pathlib.Path, "home", return_value=home):
            spec = importlib.util.spec_from_file_location(
                "utility_file", ROOT / "runner/utility.py"
            )
            u = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(u)
        return u, home, h

    def run_job(self, u, h, name, content, job_id="export-1"):
        job = {
            "id": job_id,
            "payload": {
                "message": "source1",
                "lease": "lease1",
                "mode": "file",
                "file": {"name": name, "content_b64": content},
            },
        }
        key = u.hashlib.sha256(job_id.encode()).hexdigest()[:32]
        work = h / "utility" / key
        inputs, outputs = work / "inputs", work / "outputs"
        inputs.mkdir(parents=True, mode=0o700)
        outputs.mkdir(mode=0o700)
        completion = u.receipt_path(job_id)
        reports = []

        def cloud(path, body):
            if path != "media/report":
                raise AssertionError("mode=file must not call " + path)
            reports.append(body)
            return {"ok": True}

        spawn = MagicMock()
        with patch.object(u, "cloud", side_effect=cloud), patch.object(
            u.subprocess, "Popen", spawn
        ):
            u.execute(job, work, inputs, outputs, completion)
        spawn.assert_not_called()
        return work, reports

    def encoded(self, text):
        return base64.b64encode(text.encode()).decode()

    def test_file_mode_writes_and_reports_without_a_model(self):
        u, home, h = self.fixture()
        content = "\ufeff项目,金额\n餐费,10\n"
        work, reports = self.run_job(u, h, "报销.csv", self.encoded(content))
        self.assertEqual(len(reports), 1)
        report = reports[0]
        self.assertNotEqual(report.get("success"), False)
        self.assertEqual(report["id"], "export-1")
        self.assertEqual(report["message"], "source1")
        self.assertEqual(report["files"], [{"name": "报销.csv", "bytes": len(content.encode())}])
        self.assertIn("文件已生成", report["result"])
        written = list(home.rglob("报销.csv"))
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0].read_text(), content)

    def test_subdirectory_name_keeps_only_the_basename(self):
        u, home, h = self.fixture()
        work, reports = self.run_job(u, h, "nested/dir/report.csv", self.encoded("a,b\n1,2\n"))
        self.assertEqual(reports[0]["files"][0]["name"], "report.csv")
        self.assertEqual(len(list(home.rglob("report.csv"))), 1)
        self.assertEqual(list(home.rglob("dir")), [])

    def test_path_traversal_is_refused(self):
        u, home, h = self.fixture()
        for name in ("../evil.csv", "../../evil.csv", "..\\..\\evil.csv", "a/../../evil.csv"):
            with self.subTest(name=name):
                for stale in home.rglob("evil.csv"):
                    stale.unlink()
                _, reports = self.run_job(u, h, name, self.encoded("bad\n"), job_id="export-" + str(abs(hash(name))))
                self.assertEqual(reports[0].get("success"), False, name)
                self.assertEqual(list(home.rglob("evil.csv")), [], name)

    def test_absolute_path_is_refused(self):
        u, home, h = self.fixture()
        for name in ("/tmp/evil.csv", "C:\\evil.csv", "\\\\server\\share\\evil.csv"):
            with self.subTest(name=name):
                _, reports = self.run_job(u, h, name, self.encoded("bad\n"), job_id="abs-" + str(abs(hash(name))))
                self.assertEqual(reports[0].get("success"), False, name)

    def test_invalid_base64_fails_without_writing(self):
        u, home, h = self.fixture()
        work, reports = self.run_job(u, h, "x.csv", "not base64!!")
        self.assertEqual(reports[0].get("success"), False)
        self.assertEqual(list(home.rglob("x.csv")), [])

    def test_base64_roundtrip_keeps_bytes(self):
        u, home, h = self.fixture()
        data = bytes(range(256))
        work, reports = self.run_job(u, h, "bin.dat", base64.b64encode(data).decode())
        report = reports[0]
        written = list(home.rglob("bin.dat"))
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0].read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
