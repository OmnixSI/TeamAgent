import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "patch-qq-plist.py"
NODE_DIR = "/Users/x/.nvm/versions/node/v26.13.0/bin"
REQUIRED = [NODE_DIR, "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]


class QQPlistPatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "com.inkboard.team-qq.plist"
        self.original = {
            "Label": "com.inkboard.team-qq",
            "ProgramArguments": [
                NODE_DIR + "/node",
                "/Users/x/.inkboard-team/qq-gateway.mjs",
            ],
            "EnvironmentVariables": {
                "DEEPSEEK_API_KEY_FILE": "/Users/x/.inkboard-team/secrets/deepseek-api-key"
            },
            "RunAtLoad": True,
            "KeepAlive": True,
            "StandardOutPath": "/Users/x/.inkboard-team/qq.log",
            "StandardErrorPath": "/Users/x/.inkboard-team/qq-error.log",
        }
        self.path.write_bytes(plistlib.dumps(self.original))

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *arguments):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--plist", str(self.path), *arguments],
            capture_output=True,
            text=True,
        )

    def test_dry_run_does_not_write(self):
        before = self.path.read_bytes()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertIn("/opt/homebrew/bin", result.stdout)

    def test_apply_only_adds_path_and_keeps_every_other_key(self):
        result = self.run_script("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        value = plistlib.loads(self.path.read_bytes())
        environment = value.pop("EnvironmentVariables")
        expected = dict(self.original)
        expected_environment = expected.pop("EnvironmentVariables")
        self.assertEqual(value, expected)
        self.assertEqual(
            environment["DEEPSEEK_API_KEY_FILE"],
            expected_environment["DEEPSEEK_API_KEY_FILE"],
        )
        parts = environment["PATH"].split(":")
        for item in REQUIRED:
            self.assertIn(item, parts)
        self.assertEqual(parts[0], NODE_DIR)
        self.assertEqual(self.run_script("--check").returncode, 0)

    def test_apply_is_idempotent(self):
        self.assertEqual(self.run_script("--apply").returncode, 0)
        once = self.path.read_bytes()
        self.assertEqual(self.run_script("--apply").returncode, 0)
        self.assertEqual(self.path.read_bytes(), once)

    def test_check_fails_before_patch(self):
        result = self.run_script("--check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("/opt/homebrew/bin", result.stderr)

    def test_extra_existing_path_entries_survive(self):
        value = dict(self.original)
        value["EnvironmentVariables"] = dict(value["EnvironmentVariables"])
        value["EnvironmentVariables"]["PATH"] = "/custom/tools:/usr/bin"
        self.path.write_bytes(plistlib.dumps(value))
        self.assertEqual(self.run_script("--apply").returncode, 0)
        environment = plistlib.loads(self.path.read_bytes())["EnvironmentVariables"]
        self.assertIn("/custom/tools", environment["PATH"].split(":"))

    def test_missing_plist_is_reported(self):
        self.path.unlink()
        result = self.run_script("--apply")
        self.assertEqual(result.returncode, 2)
        self.assertIn("找不到", result.stderr)


if __name__ == "__main__":
    unittest.main()
