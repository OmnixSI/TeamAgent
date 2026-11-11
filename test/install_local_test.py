"""P4b launchd lifecycle tests: temporary HOME, no real service changes."""
import importlib.util
import os
from pathlib import Path
import plistlib
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

class FetchInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.runtime = self.home / '.inkboard-team'
        self.runtime.mkdir()
        (self.runtime / 'config.json').write_text('{"url":"https://example.test","runnerToken":"fake"}')
        (self.runtime / 'worker-secrets.json').write_text('{}')
        self.commands = []
        self.loaded = False
        self.node_version = 'v24.14.0'
        self.env = patch.dict(os.environ, {'HOME': str(self.home)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_command(self, args, **kwargs):
        self.commands.append(args)
        code = 1 if args[:2] == ['launchctl', 'print'] and not self.loaded else 0
        if args[:2] == ['launchctl', 'bootstrap']:
            self.loaded = True
        return subprocess.CompletedProcess(args, code, stdout=self.node_version if args[-1] == '--version' else '', stderr='')

    def apply(self, remove=False):
        with patch('shutil.which', return_value='/opt/homebrew/bin/node'), patch('subprocess.run', side_effect=self.run_command), patch('sys.argv', ['install-local.py', '--apply'] + (['--remove-fetch'] if remove else [])):
            runpy.run_path(str(ROOT / 'scripts/install-local.py'), run_name='__main__')

    def test_L2_first_apply_generates_and_bootstraps(self):
        self.apply()
        plist = plistlib.loads((self.home / 'Library/LaunchAgents/com.inkboard.team-fetch.plist').read_bytes())
        self.assertTrue(Path(plist['ProgramArguments'][0]).is_absolute())
        self.assertEqual(plist['ProgramArguments'][1], str(self.runtime / 'fetcher.mjs'))
        self.assertEqual(plist['StandardOutPath'], str(self.runtime / 'fetch.log'))
        self.assertEqual(plist['StandardErrorPath'], str(self.runtime / 'fetch-error.log'))
        self.assertEqual(plist['ThrottleInterval'], 30)
        self.assertIn('bootstrap', [x[1] for x in self.commands if x[0] == 'launchctl'])

    def test_L3_repeated_apply_preserves_plist_and_service(self):
        self.apply()
        path = self.home / 'Library/LaunchAgents/com.inkboard.team-fetch.plist'
        before = path.stat().st_mtime_ns
        self.commands.clear()
        self.apply()
        self.assertEqual(path.stat().st_mtime_ns, before)
        self.assertFalse(any(x[:2] in (['launchctl','bootout'], ['launchctl','bootstrap']) for x in self.commands))

    def test_L4_old_or_missing_node_does_not_fail_apply(self):
        self.node_version = 'v20.0.0'
        self.apply()
        self.assertFalse((self.home / 'Library/LaunchAgents/com.inkboard.team-fetch.plist').exists())
        module = runpy.run_path(str(ROOT / 'scripts/install-local.py'))
        with patch('shutil.which', return_value=None), patch('pathlib.Path.glob', return_value=[]), patch('pathlib.Path.exists', return_value=False):
            self.assertIsNone(module['find_node']())

    def test_remove_fetch_rolls_back(self):
        self.apply()
        self.commands.clear()
        self.apply(remove=True)
        self.assertFalse((self.home / 'Library/LaunchAgents/com.inkboard.team-fetch.plist').exists())
        self.assertTrue(any(x[:2] == ['launchctl','bootout'] for x in self.commands))

    def test_L5_reload_fetch_failure_optional_other_services_required(self):
        module = runpy.run_path(str(ROOT / 'runner/reload_runtime.py'))
        self.assertIn('com.inkboard.team-fetch', module['SERVICES'])
        calls=[]
        def run(args, **kw):
            calls.append((args, kw))
            if args[-1].endswith('team-fetch') and kw.get('check'):
                raise subprocess.CalledProcessError(1,args)
        with patch('subprocess.run', side_effect=run):
            module['restart_services']()
        self.assertEqual(len(calls),6)
        self.assertTrue(all(kw['check'] for _,kw in calls[:-1]))
        self.assertFalse(calls[-1][1]['check'])
        with patch('subprocess.run', side_effect=subprocess.CalledProcessError(1,['launchctl'])):
            with self.assertRaises(subprocess.CalledProcessError): module['restart_services']()

if __name__ == '__main__': unittest.main()
