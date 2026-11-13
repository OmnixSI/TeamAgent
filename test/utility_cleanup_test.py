"""Exercise downloads, interrupted tasks and the real native-file delivery boundary."""
import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
KEY = hashlib.sha256(b'file-cleanup').hexdigest()[:32]
CSV = '项目,数量\n合成数据,3\n'


class UtilityCleanupTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            h = home / '.inkboard-team'
            h.mkdir()
            (h / 'config.json').write_text('{"url":"https://example.invalid","runnerToken":"synthetic"}')
            with patch.object(pathlib.Path, 'home', return_value=home):
                spec = importlib.util.spec_from_file_location('cleanup_utility', ROOT / 'runner/utility.py')
                u = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(u)
            yield u, h

    @contextmanager
    def execution(self, u, h, *, sources=(), fail_report=False, interrupt=None, extra_output=False):
        state = {'reports': [], 'downloads': [], 'processes': [], 'claims': 0}
        job = {'id': 'file-cleanup', 'payload': {'message': 'source', 'lease': 'lease', 'instructions': '生成 CSV', 'inputs': list(sources)}}

        def cloud(path, body):
            if path == 'media/claim':
                state['claims'] += 1
                return {'job': job if state['claims'] == 1 else None}
            if path in ('inputs', 'media/heartbeat'):
                return {'messages': []}
            state['reports'].append(body)
            if fail_report and len(state['reports']) == 1:
                raise u.urllib.error.URLError('synthetic report outage')
            return {'ok': True}

        def spawn(args, **kwargs):
            state['processes'].append((args, kwargs))
            work = h / 'utility' / KEY
            (work / 'inputs/cookies.txt').write_text('synthetic cookie')
            (work / 'outputs/example.csv').write_text(CSV)
            if extra_output:
                (work / 'outputs/extra.csv').write_text(CSV + 'extra')
            proc = MagicMock(pid=87654)
            proc.poll.return_value = 0
            completed = (json.dumps({'type': 'final', 'reason': {'kind': 'completed'}, 'text': 'CSV已生成'}), '')
            if interrupt and args[0] != 'yt-dlp':
                def stop_once(*args, **kwargs):
                    proc.communicate.side_effect = None
                    proc.communicate.return_value = ('', '')
                    if interrupt == 'signal':
                        u.stop(signal.SIGTERM, None)
                    raise interrupt
                proc.communicate.side_effect = stop_once
            else:
                proc.communicate.return_value = completed
            return proc

        def download(url, target):
            state['downloads'].append(url)
            target.write_bytes(b'synthetic audio or document')

        with patch.object(u, 'cloud', side_effect=cloud), patch.object(u, 'api_key', return_value='synthetic'), \
             patch.object(u, 'dsh_program', return_value='synthetic-dsh'), patch.object(u, 'safe', side_effect=lambda url: url), \
             patch.object(u, 'download', side_effect=download), patch.object(u.subprocess, 'Popen', side_effect=spawn), \
             patch.object(u.os, 'killpg') as kill:
            state['kill'] = kill
            yield state

    def assert_clean_work(self, h):
        self.assertFalse((h / 'utility' / KEY).exists(), 'inputs/messages.json, cookies and partial outputs must be removed')

    def deliver(self, h, expected=None):
        script = '''
import fs from 'node:fs';
import path from 'node:path';
import {deliverFiles} from %s;
const h=process.argv[1], sent=[];
await deliverFiles({dir:path.join(h,'file-deliveries'),root:path.join(h,'utility'),
 target:async()=>({group_id:'synthetic'}),
 sendFile:async(_group,file)=>sent.push(fs.readFileSync(file,'utf8')),
 report:async()=>{}});
process.stdout.write(JSON.stringify(sent));
''' % json.dumps((ROOT / 'runner/delivery.mjs').as_uri())
        run = subprocess.run(['node', '--input-type=module', '-e', script, str(h)], capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertCountEqual(json.loads(run.stdout), expected or [CSV], 'delivery.mjs must accept realpath and read the staged file')

    def test_success_preserves_sendable_outputs_until_native_delivery(self):
        with self.fixture() as (u, h):
            with self.execution(u, h):
                u.once()
            self.assert_clean_work(h)
            manifest = json.loads(next((h / 'file-deliveries').glob('*.json')).read_text())
            output = pathlib.Path(manifest['files'][0])
            self.assertTrue(output.is_file(), 'completion cleanup deleted an unsent artifact')
            self.assertEqual(output.read_text(), CSV)
            self.assertFalse(list((h / 'utility-reports').glob('*/completion.json')))
            self.deliver(h)
            self.assertFalse(output.exists(), 'confirmed delivery must clean its staged output')

    def test_output_budget_is_checked_before_staging_and_survives_report_retry(self):
        mib = 1024 * 1024
        for sizes in ([50 * mib, 50 * mib], [40 * mib, 40 * mib, 20 * mib + 1]):
            oversized = sum(sizes) > 100 * mib
            with self.subTest(sizes=sizes), self.fixture() as (u, h):
                with self.execution(u, h, fail_report=True) as state:
                    spawn = u.subprocess.Popen.side_effect
                    def produce(args, **kwargs):
                        proc = spawn(args, **kwargs)
                        outputs = h / 'utility' / KEY / 'outputs'
                        (outputs / 'example.csv').unlink()
                        for i, size in enumerate(sizes):
                            with (outputs / (str(i) + '.csv')).open('wb') as output:
                                output.truncate(size)  # Sparse fixtures avoid allocating 100 MiB.
                        return proc
                    u.subprocess.Popen.side_effect = produce
                    moves, replace = [], pathlib.Path.replace
                    def track_move(source, target):
                        moves.append(pathlib.Path(target))
                        return replace(source, target)
                    with patch.object(pathlib.Path, 'replace', track_move), self.assertRaises(u.urllib.error.URLError):
                        u.once()
                    self.assert_clean_work(h)
                    staged = h / 'utility/_deliveries' / KEY
                    self.assertEqual(staged.exists(), not oversized)
                    self.assertEqual(any('_deliveries' in target.parts for target in moves), not oversized)
                    receipt = json.loads(next((h / 'utility-reports').glob('*/completion.json')).read_text())
                    if oversized:
                        self.assertIs(receipt['success'], False)
                        self.assertEqual(receipt['local_files'], [])
                        self.assertEqual(receipt['files'], [])
                        self.assertIn('产物太大，请缩小范围后重新交办', receipt['result'])
                    u.flush_reports()
                    self.assertEqual(len(state['processes']), 1)
                    self.assertEqual(len(state['reports']), 2)
                    if oversized:
                        self.assertIn('产物太大，请缩小范围后重新交办', state['reports'][-1]['result'])
                        self.assertFalse(list((h / 'file-deliveries').glob('*.json')))
                        self.assertFalse(staged.exists())
                    else:
                        manifest = json.loads(next((h / 'file-deliveries').glob('*.json')).read_text())
                        self.assertEqual(len(manifest['files']), len(sizes))
                        self.assertEqual(sum(pathlib.Path(p).stat().st_size for p in manifest['files']), 100 * mib)
                    self.assertFalse(list((h / 'utility-reports').glob('*/completion.json')))

    def test_report_outage_keeps_only_retry_receipt_and_sendable_output(self):
        with self.fixture() as (u, h):
            with self.execution(u, h, fail_report=True) as state:
                with self.assertRaises(u.urllib.error.URLError):
                    u.once()
                self.assert_clean_work(h)
                receipts = list((h / 'utility-reports').glob('*/completion.json'))
                self.assertEqual(len(receipts), 1, 'retry receipt must live outside the download directory')
                receipt = json.loads(receipts[0].read_text())
                self.assertTrue(all(pathlib.Path(p).is_file() for p in receipt['local_files']))
                self.assertFalse(list((h / 'file-deliveries').glob('*.json')))
                u.flush_reports()
                self.assertEqual(len(state['processes']), 1, 'retry must not rerun the agent or downloader')
                self.assertEqual(len(state['reports']), 2)
                self.assertFalse(receipts[0].parent.exists(), 'accepted receipt directory must be removed')
            self.deliver(h)

    def test_delivery_receipt_recovers_after_send_even_if_task_receipt_cleanup_was_interrupted(self):
        with self.fixture() as (u, h):
            with self.execution(u, h) as state:
                with patch.object(u, 'clear_receipt', side_effect=SystemExit(0)), self.assertRaises(SystemExit):
                    u.once()
                self.assert_clean_work(h)
                self.assertEqual(len(state['processes']), 1)
            self.deliver(h)
            with patch.object(u, 'cloud') as cloud:
                u.flush_reports()
                self.assertFalse(cloud.called, 'accepted delivery manifest is authoritative, including after sent output cleanup')
            self.assertFalse(list((h / 'utility-reports').glob('*/completion.json')))

    def test_interrupted_output_staging_preserves_all_outputs_for_report_retry(self):
        with self.fixture() as (u, h):
            original = pathlib.Path.replace
            def stop_after_staging(source, target):
                result = original(source, target)
                if '_deliveries' in pathlib.Path(target).parts:
                    raise SystemExit(0)
                return result
            with self.execution(u, h, extra_output=True):
                with patch.object(pathlib.Path, 'replace', stop_after_staging), self.assertRaises(SystemExit):
                    u.once()
                self.assert_clean_work(h)
                u.flush_reports()
            self.deliver(h, [CSV, CSV + 'extra'])

    def test_video_attachments_are_skipped_and_audio_attachments_share_the_link_limit(self):
        sources = [{'attachments': [
            {'filename': 'upload.mp4', 'content_type': 'video/mp4', 'url': 'https://example.invalid/video'},
            {'filename': 'hidden.dat', 'content_type': 'video/webm', 'url': 'https://example.invalid/hidden'},
            {'filename': 'voice.ogg', 'content_type': 'audio/ogg', 'url': 'https://example.invalid/voice'},
            {'filename': 'second.mp3', 'content_type': 'audio/mpeg', 'url': 'https://example.invalid/second'}],
            'urls': ['https://b23.tv/synthetic', 'https://example.invalid/third.mp3']}]
        with self.fixture() as (u, h):
            with self.execution(u, h, sources=sources) as state:
                u.once()
                self.assertEqual(state['downloads'], ['https://example.invalid/voice'])
                self.assertEqual([args[0] for args, _ in state['processes']], ['synthetic-dsh'])
            self.assert_clean_work(h)

    def test_rejected_cloud_report_cleans_receipt_and_never_queues_staged_output(self):
        with self.fixture() as (u, h):
            with self.execution(u, h):
                handler = u.cloud.side_effect
                def reject(path, body):
                    if path == 'media/report':
                        raise u.urllib.error.HTTPError('https://example.invalid', 409, 'cancelled', {}, None)
                    return handler(path, body)
                u.cloud.side_effect = reject
                u.once()
            self.assert_clean_work(h)
            self.assertFalse((h / 'utility-reports' / KEY).exists())
            self.assertFalse((h / 'utility/_deliveries' / KEY).exists())
            self.assertFalse(list((h / 'file-deliveries').glob('*.json')))

    def test_startup_cleanup_removes_orphan_tasks_but_keeps_deliveries(self):
        with self.fixture() as (u, h):
            u.clean_utility_root()  # Missing root is a no-op.
            utility = h / 'utility'
            (utility / 'task-one' / 'outputs').mkdir(parents=True)
            (utility / 'task-one' / 'outputs' / 'partial.csv').write_text(CSV)
            (utility / 'task-two').mkdir()
            (utility / 'stray.txt').write_text('synthetic')
            kept = utility / '_deliveries' / 'kept' / 'outputs'
            kept.mkdir(parents=True)
            (kept / 'ready.csv').write_text(CSV)
            outside = h / 'outside'
            outside.mkdir()
            (outside / 'sentinel.txt').write_text('keep')
            (utility / 'linked').symlink_to(outside, target_is_directory=True)
            u.clean_utility_root()
            self.assertEqual(sorted(p.name for p in utility.iterdir()), ['_deliveries'])
            self.assertEqual((kept / 'ready.csv').read_text(), CSV)
            self.assertFalse((utility / 'linked').exists(), 'only the symlink itself is removed')
            self.assertEqual((outside / 'sentinel.txt').read_text(), 'keep', 'cleanup must not follow symlinks')

    def test_link_downloader_selects_only_audio_and_blocks_later_audio_attachments(self):
        sources = [{'urls': ['https://b23.tv/synthetic', 'https://youtu.be/second']},
                   {'attachments': [{'filename': 'voice.wav', 'content_type': 'audio/wav', 'url': 'https://example.invalid/voice'}]}]
        with self.fixture() as (u, h):
            with self.execution(u, h, sources=sources) as state:
                u.once()
                downloads = [(args, kw) for args, kw in state['processes'] if args[0] == 'yt-dlp']
                self.assertEqual(len(downloads), 1)
                args, kw = downloads[0]
                self.assertEqual(args[args.index('--format') + 1], 'bestaudio')
                self.assertIn('--no-cache-dir', args)
                self.assertIn('--no-playlist', args)
                self.assertTrue(kw['start_new_session'])
                self.assertEqual(kw['stdout'], subprocess.DEVNULL, 'download logs must not accumulate in memory')
                self.assertEqual(state['downloads'], [])
            self.assert_clean_work(h)

    def test_direct_audio_urls_share_one_slot_across_sources(self):
        with self.fixture() as (u, h):
            sources = [{'urls': ['https://example.invalid/one.mp3', 'https://b23.tv/second']},
                       {'attachments': [{'filename': 'two.ogg', 'url': 'https://example.invalid/two'}]}]
            with self.execution(u, h, sources=sources) as state:
                u.once()
                self.assertEqual(state['downloads'], ['https://example.invalid/one.mp3'])
                self.assertEqual([args[0] for args, _ in state['processes']], ['synthetic-dsh'])

    def test_base_exceptions_clean_inputs_cookies_outputs_and_leave_a_retryable_stop_report(self):
        for interrupt in (KeyboardInterrupt(), SystemExit(0), 'signal'):
            with self.subTest(interrupt=type(interrupt).__name__), self.fixture() as (u, h):
                with self.execution(u, h, interrupt=interrupt) as state:
                    with self.assertRaises((KeyboardInterrupt, SystemExit)):
                        u.once()
                    self.assert_clean_work(h)
                    self.assertIsNone(u.ACTIVE)
                    self.assertTrue(state['kill'].called, 'interrupted subprocess group must be reaped')
                    self.assertEqual(len(list((h / 'utility-reports').glob('*/completion.json'))), 1)
                    u.flush_reports()
                    self.assertEqual(len(state['processes']), 1)
                    self.assertFalse(state['reports'][0]['success'])
                    self.assertNotIn('输入已保留', state['reports'][0]['result'])
                    self.assertFalse(list((h / 'utility-reports').glob('*/completion.json')))

    def test_interrupt_during_input_download_cleans_the_entire_task(self):
        with self.fixture() as (u, h):
            with self.execution(u, h, sources=[{'attachments': [{'filename': 'voice.ogg', 'url': 'https://example.invalid/one'}]}]):
                def interrupted_download(url, target):
                    target.write_bytes(b'partial audio')
                    (target.parent / 'cookies.txt').write_text('synthetic')
                    raise KeyboardInterrupt()
                with patch.object(u, 'download', side_effect=interrupted_download), self.assertRaises(KeyboardInterrupt):
                    u.once()
                self.assert_clean_work(h)

    def test_sigterm_reaps_a_real_synthetic_child_and_removes_task_caches(self):
        with self.fixture() as (u, h):
            driver = '''
import importlib.util, json, os, pathlib, signal, subprocess, sys
spec=importlib.util.spec_from_file_location('stopped_utility',sys.argv[1])
u=importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
u.api_key=lambda:'synthetic'; u.dsh_program=lambda:'synthetic-dsh'
u.cloud=lambda path,body: {'job':{'id':'file-cleanup','payload':{'message':'source','lease':'lease'}}} if path=='media/claim' else {'messages':[],'ok':True}
real_popen=subprocess.Popen
def spawn(args,**kwargs):
 work=pathlib.Path(kwargs['cwd']); (work/'inputs/cookies.txt').write_text('synthetic'); (work/'outputs/partial.csv').write_text('partial')
 code="import os,pathlib,time; pathlib.Path("+repr(str(u.H/'ready'))+").write_text(str(os.getpid())); time.sleep(60)"
 return real_popen([sys.executable,'-c',code],**kwargs)
u.subprocess.Popen=spawn
signal.signal(signal.SIGTERM,u.stop)
u.once()
'''
            proc = subprocess.Popen([sys.executable, '-c', driver, str(ROOT / 'runner/utility.py')],
                                    env={**os.environ, 'HOME': str(h.parent)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child_pid = None
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not (h / 'ready').exists() and proc.poll() is None:
                    time.sleep(0.01)
                self.assertTrue((h / 'ready').exists(), 'synthetic child did not start')
                child_pid = int((h / 'ready').read_text())
                proc.terminate()
                stdout, stderr = proc.communicate(timeout=8)
                self.assertEqual(proc.returncode, 0, stderr.decode())
                self.assert_clean_work(h)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if proc.poll() is None:
                    proc.kill(); proc.communicate(timeout=3)
                if child_pid:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
