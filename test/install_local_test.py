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

    def test_B4_apply_installs_shared_deny_policy_and_flat_runner_loads_it(self):
        self.apply()
        policy = self.runtime / 'shared/deny_globs.json'
        self.assertTrue(policy.exists(), 'shared deny policy must survive runtime installation')
        self.assertEqual(policy.read_bytes(), (ROOT / 'shared/deny_globs.json').read_bytes())
        result = subprocess.run([__import__('sys').executable, '-c', 'import repo_index; assert repo_index.denied("nested/.env/config.txt"); assert not repo_index.denied("src/main.py")'], cwd=self.runtime, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_login_launcher_is_private_idempotent_and_removable(self):
        self.apply()
        path = self.home / 'Desktop/TeamAgent-登录.command'
        self.assertTrue(path.exists())
        before = path.stat().st_mtime_ns
        content = path.read_text()
        self.assertIn('osascript', content)
        self.assertNotIn('fetcher.mjs login', content)
        self.assertIn('owner_unlock.py', content)
        self.assertIn('打开开发台（B 站扫码）', content)
        self.assertTrue((self.runtime / 'owner_unlock.py').exists())
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        for directory in ['browser/bili', 'browser/x', 'secrets']:
            self.assertEqual((self.runtime / directory).stat().st_mode & 0o777, 0o700)
        self.apply()
        self.assertEqual(path.stat().st_mtime_ns, before)
        with patch('sys.argv', ['install-local.py', '--remove']):
            runpy.run_path(str(ROOT / 'scripts/install-local.py'), run_name='__main__')
        self.assertFalse(path.exists())
        self.assertTrue((self.runtime / 'browser/x').exists(), 'rollback preserves user login data')

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
        self.assertEqual(len(calls),7)
        self.assertTrue(all(kw['check'] for _,kw in calls[:-2]))
        self.assertFalse(calls[-1][1]['check']);self.assertFalse(calls[-2][1]['check'])
        with patch('subprocess.run', side_effect=subprocess.CalledProcessError(1,['launchctl'])):
            with self.assertRaises(subprocess.CalledProcessError): module['restart_services']()

    def test_P2_old_path_node_falls_back_to_highest_nvm(self):
        versions = self.home / '.nvm/versions/node'
        for version in ['v22.9.0', 'v24.14.0']:
            path = versions / version / 'bin/node'
            path.parent.mkdir(parents=True)
            path.write_text('')
        module = runpy.run_path(str(ROOT / 'scripts/install-local.py'))
        def node(args, **kwargs):
            version = 'v20.0.0' if args[0] == '/usr/bin/node' else Path(args[0]).parents[1].name
            return subprocess.CompletedProcess(args, 0, stdout=version)
        with patch('shutil.which', return_value='/usr/bin/node'), patch('subprocess.run', side_effect=node):
            self.assertEqual(module['find_node'](), str((versions / 'v24.14.0/bin/node').resolve()))

    def test_P2_failed_bootout_warns_and_retains_plist_without_raising(self):
        self.apply()
        path = self.home / 'Library/LaunchAgents/com.inkboard.team-fetch.plist'
        before = path.read_bytes()
        module = runpy.run_path(str(ROOT / 'scripts/install-local.py'))
        with patch('subprocess.run', side_effect=OSError('launchctl unavailable')), patch('builtins.print') as output:
            module['remove_fetch_service']()
        self.assertTrue(path.exists())
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(any('警告' in str(call) for call in output.call_args_list))

class MediaInstallTests(unittest.TestCase):
    setUp=FetchInstallTests.setUp
    apply=FetchInstallTests.apply
    run_command=FetchInstallTests.run_command
    def module(self):
        spec=importlib.util.spec_from_file_location('installer',ROOT/'scripts/install-local.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
    def test_I1_staging_includes_runtime_and_requirements(self):
        m=self.module()
        with patch.object(m,'ensure_xasr',return_value=True),patch('subprocess.check_output',return_value='fake-release'),patch('sys.argv',['install-local.py']):
            with self.assertRaises(SystemExit)as r:m.main()
        self.assertEqual(r.exception.code,0)
        stage=self.runtime/'runtime-staging/fake-release/runner'
        self.assertTrue((stage.parent/'shared/deny_globs.json').exists(), 'staging must include shared deny policy')
        for name in ['media.mjs','asr.mjs','xasr_transcribe.py','requirements-xasr.txt','package.json','package-lock.json']:self.assertTrue((stage/name).exists(),name)
    def test_S1_apply_installs_runner_dependencies_and_self_checks(self):
        self.apply()
        for name in ['package.json','package-lock.json']:
            self.assertEqual((self.runtime/name).read_bytes(),(ROOT/'runner'/name).read_bytes(),name)
        installed=[c for c in self.commands if c[:2]==['npm','ci'] and str(self.runtime) in c]
        self.assertTrue(installed,self.commands)
        checks=[c for c in self.commands if c[0].endswith('/node') and '--input-type=module' in c]
        self.assertTrue(checks,self.commands)
        self.assertTrue(any('silk-wasm' in c[-1] for c in checks),checks)
    def test_S2_self_check_reports_tts_silk_missing_when_import_fails(self):
        m=self.module()
        def run(args,**kw):
            return subprocess.CompletedProcess(args,1,stdout='',stderr="Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'silk-wasm'")
        with patch('subprocess.run',side_effect=run):
            result=m.check_runner_deps(self.runtime,'/opt/homebrew/bin/node')
        self.assertFalse(result['ok'])
        self.assertEqual(result['error_kind'],'tts_silk_missing')
        self.assertIn('ERR_MODULE_NOT_FOUND',result['error'])
    def test_S3_unchanged_runner_manifest_skips_npm_ci(self):
        self.apply()
        dependency=self.runtime/'node_modules/silk-wasm'
        dependency.mkdir(parents=True)
        (dependency/'package.json').write_text('{}')
        self.commands.clear()
        self.apply()
        self.assertEqual([c for c in self.commands if c[:2]==['npm','ci'] and str(self.runtime) in c],[])
    def test_I2_apply_flattens_files_and_writes_absolute_asr_paths(self):
        self.apply()
        import json
        config=json.loads((self.runtime/'config.json').read_text())
        self.assertTrue(Path(config['asr']['python']).is_absolute());self.assertTrue(Path(config['asr']['model_dir']).is_absolute())
        for name in ['media.mjs','asr.mjs','xasr_transcribe.py','requirements-xasr.txt']:self.assertTrue((self.runtime/name).exists(),name)
    def test_I3_apply_does_not_install_and_unchanged_requirement_skips_pip(self):
        self.apply();self.assertFalse(any('pip' in c or '--check' in c for c in self.commands))
        m=self.module();venv=self.runtime/'xasr-venv';(venv/'bin').mkdir(parents=True)
        (venv/'bin/python').write_text('');import hashlib
        (venv/'.req.sha256').write_text(hashlib.sha256((ROOT/'runner/requirements-xasr.txt').read_bytes()).hexdigest())
        self.commands.clear()
        with patch('subprocess.run',side_effect=self.run_command):self.assertTrue(m.ensure_xasr(ROOT))
        self.assertFalse(any('pip' in c for c in self.commands));self.assertTrue(any('--check' in c for c in self.commands))
        (venv/'.req.sha256').unlink();self.commands.clear()
        with patch('subprocess.run',side_effect=self.run_command):self.assertTrue(m.ensure_xasr(ROOT))
        pip=next(c for c in self.commands if 'pip' in c);self.assertIn('--no-cache-dir',pip);self.assertEqual(pip[-2:],['-r',str(ROOT/'runner/requirements-xasr.txt')])
    def test_I4_media_is_an_interval_job_and_fetch_plist_remains_byte_exact(self):
        m=self.module()
        with patch.object(m,'find_node',return_value='/node'),patch.object(m,'launchctl',return_value=False):
            m.install_fetch_service();m.install_media_service()
        fetch=plistlib.dumps({'Label':'com.inkboard.team-fetch','ProgramArguments':['/node',str(self.runtime/'fetcher.mjs')],'EnvironmentVariables':{'PATH':'/:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'},'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':30,'StandardOutPath':str(self.runtime/'fetch.log'),'StandardErrorPath':str(self.runtime/'fetch-error.log')})
        self.assertEqual((self.home/'Library/LaunchAgents/com.inkboard.team-fetch.plist').read_bytes(),fetch)
        media=plistlib.loads((self.home/'Library/LaunchAgents/com.inkboard.team-media.plist').read_bytes());self.assertEqual(media['StartInterval'],60);self.assertEqual(media['Nice'],10);self.assertEqual(media['ProcessType'],'Background');self.assertTrue(media['LowPriorityIO']);self.assertEqual(media['WorkingDirectory'],str(self.runtime));self.assertNotIn('RunAtLoad',media);self.assertNotIn('KeepAlive',media)
    def test_I5_optional_media_service_is_restarted_without_requiring_a_live_instance(self):
        m=runpy.run_path(str(ROOT/'runner/reload_runtime.py'));self.assertIn('com.inkboard.team-media',m['SERVICES']);calls=[]
        with patch('subprocess.run',side_effect=lambda *a,**kw:calls.append((a,kw))):m['restart_services']()
        self.assertFalse(next(kw['check'] for (a,kw)in calls if a[0][-1].endswith('team-media')))
    def test_I6_remove_media_deletes_only_its_named_runtime_artifacts(self):
        m=self.module();(self.runtime/'unrelated').write_text('preserved')
        for name in ['xasr-venv','media-tmp','media-reports','media.lock']:(self.runtime/name).mkdir()
        (self.runtime/'media-child.pid').write_text('1')
        with patch.object(m,'launchctl',return_value=True),patch('sys.argv',['install-local.py','--remove-media']):m.main()
        for name in ['xasr-venv','media-tmp','media-reports','media.lock','media-child.pid']:self.assertFalse((self.runtime/name).exists(),name)
        self.assertEqual((self.runtime/'unrelated').read_text(),'preserved')

if __name__ == '__main__': unittest.main()
