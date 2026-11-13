"""The deployment secret sync is optional via GITHUB_TOKEN_FILE and never prints values."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TEAM_SECRETS = {
    'DEEPSEEK_API_KEY': 'synthetic-deepseek',
    'TEAM_ADMIN_TOKEN': 'synthetic-admin',
    'TEAM_RUNNER_TOKEN': 'synthetic-runner',
    'TEAM_QQ_APP_ID': 'synthetic-qq-id',
    'TEAM_QQ_APP_SECRET': 'synthetic-qq-secret',
}


class SyncRuntimeSecretsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.cwd = self.home / 'repo'
        (self.cwd / 'node_modules/.bin').mkdir(parents=True)
        self.calls = self.cwd / 'wrangler-calls.txt'
        wrapper = self.cwd / 'node_modules/.bin/wrangler'
        wrapper.write_text('#!/bin/sh\nprintf "%s\\n" "$#" "$@" > "' + str(self.calls) + '"\nexit 0\n')
        wrapper.chmod(0o755)
        self.env = {'HOME': str(self.home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), **TEAM_SECRETS}

    def run_script(self, extra=None):
        env = dict(self.env)
        env.update(extra or {})
        return subprocess.run([sys.executable, str(ROOT / 'scripts/sync-runtime-secrets.py')],
                              cwd=self.cwd, env=env, capture_output=True, text=True, timeout=30)

    def secrets(self):
        return json.loads((self.home / '.inkboard-team/worker-secrets.json').read_text())

    def test_github_token_file_is_synced_without_printing_value(self):
        token = 'gho_' + 'a' * 36
        token_file = self.home / 'github-token'
        token_file.write_text(token + '\n')
        result = self.run_script({'GITHUB_TOKEN_FILE': str(token_file)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(token, result.stdout)
        self.assertNotIn(token, result.stderr)
        self.assertEqual(self.secrets()['GITHUB_TOKEN'], token)
        for name in TEAM_SECRETS.values():
            self.assertIn(name, self.secrets().values())
        calls = self.calls.read_text()
        self.assertIn('secret', calls)
        self.assertIn('bulk', calls)
        self.assertNotIn(token, calls)

    def test_missing_github_token_file_env_skips_with_notice(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('跳过 GITHUB_TOKEN', result.stdout)
        self.assertNotIn('GITHUB_TOKEN', self.secrets())

    def test_unreadable_github_token_file_skips_without_failing(self):
        result = self.run_script({'GITHUB_TOKEN_FILE': str(self.home / 'missing-token')})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('不可读', result.stdout)
        self.assertNotIn('GITHUB_TOKEN', self.secrets())

    def test_empty_github_token_file_skips_without_failing(self):
        token_file = self.home / 'empty-token'
        token_file.write_text('  \n')
        result = self.run_script({'GITHUB_TOKEN_FILE': str(token_file)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('为空', result.stdout)
        self.assertNotIn('GITHUB_TOKEN', self.secrets())


if __name__ == '__main__':
    unittest.main()
