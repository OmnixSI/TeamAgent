"""K2 / R-7 / R-7b: exercise real Git without touching any user repository."""
import base64
import os
from contextlib import contextmanager
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import ssl
import sys
import shlex
import subprocess
import tempfile
import threading
import time
import unittest
import tracemalloc
from unittest.mock import patch

from runner import gitsafe, repo_index


class GitSafeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / 'repo'
        self.root.mkdir()
        self.env = patch.dict(os.environ, {'HOME':str(self.home), 'XDG_CONFIG_HOME':str(self.home / '.config'),
                                          'NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Index Test')
        self.git('config', 'user.email', 'index@example.invalid')
        (self.root / 'data.txt').write_text('before\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'first')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, text=True, capture_output=True, check=True).stdout

    def test_C1b_G1_ls_tree_has_one_exact_read_shape(self):
        sha = self.git('rev-parse', 'HEAD').strip()
        good = ('ls-tree', '-r', '-t', '-z', '--long', '--full-tree', sha)
        self.assertIn('data.txt', gitsafe.run(self.root, 'read', *good))
        for args in (good + ('--',), good[:-1], good[:-1] + ('HEAD',),
                     ('ls-tree', '--format=%(objectname)', sha), good[:-1] + ('a'*39,)):
            with self.subTest(args=args), patch.object(gitsafe, '_run_process') as started:
                with self.assertRaises(gitsafe.GitDenied):
                    gitsafe.run(self.root, 'read', *args)
                started.assert_not_called()

    def test_C1b_G2_real_stderr_is_classified_and_never_returned(self):
        for message, reason in [('Authentication failed for private', 'auth'),
                                ('could not read Username', 'auth'), ('HTTP 403', 'auth'),
                                ('Repository not found', 'not_found'),
                                ('Could not resolve host', 'network'), ('Connection refused', 'network'),
                                ('timed out', 'network'), ('unknown private diagnostic', 'failed')]:
            with self.subTest(reason=reason):
                result = gitsafe._run_process([sys.executable, '-c',
                    'import os; os.write(2, ' + repr(message.encode()) + '); raise SystemExit(128)'],
                    cwd=self.root, env=self.hardened_env(), timeout=3, classify=True)
                self.assertEqual(result.reason, reason)
                self.assertEqual(result.stderr, '')
                self.assertNotIn(message, repr(result))
        with self.assertRaises(ValueError):
            gitsafe._run_process(['git'], cwd=self.root, env={}, timeout=1, classify=True, max_bytes=10)
        with self.assertRaises(ValueError):
            gitsafe._run_process(['git'], cwd=self.root, env={}, timeout=1, classify=True, input='private')

    def test_C1b_G2_eight_mib_stderr_is_drained_with_bounded_memory(self):
        code = ('import os; block=b"x"*65536; '
                '[os.write(2,block) for _ in range(128)]; '
                'os.write(2,b"Authentication failed"); raise SystemExit(128)')
        tracemalloc.start()
        try:
            baseline = tracemalloc.get_traced_memory()[0]
            result = gitsafe._run_process([sys.executable, '-c', code], cwd=self.root,
                env=self.hardened_env(), timeout=5, classify=True)
            peak = tracemalloc.get_traced_memory()[1] - baseline
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 1024*1024)
        self.assertEqual(result.reason, 'auth')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (128, '', ''))

    def test_C1b_G2_classified_timeout_reaps_process_group(self):
        with patch.object(gitsafe.os, 'killpg', wraps=os.killpg) as killed:
            with self.assertRaises(gitsafe.GitFailed) as failure:
                gitsafe._run_process([sys.executable, '-c', 'import time; time.sleep(20)'],
                    cwd=self.root, env=self.hardened_env(), timeout=0.1, classify=True)
        self.assertEqual(failure.exception.reason, 'timeout')
        self.assertNotIn('time.sleep', str(failure.exception))
        killed.assert_called_once()

    def test_C1b_G3_call_cap_is_nested_and_cannot_escape_round_deadline(self):
        self.assertLessEqual(gitsafe._timeout(), 30)
        with gitsafe.call_cap(300):
            self.assertGreater(gitsafe._timeout(), 30)
            with gitsafe.call_cap(90):
                self.assertLessEqual(gitsafe._timeout(), 90)
            self.assertGreater(gitsafe._timeout(), 90)
            with gitsafe.time_budget(5):
                self.assertLessEqual(gitsafe._timeout(), 5)
        self.assertLessEqual(gitsafe._timeout(), 30)
        self.assertEqual(gitsafe._env('read')['GIT_ALLOW_PROTOCOL'], 'none')

    def test_C1b_C1_C4_C5_clone_is_atomic_private_and_never_checks_out(self):
        parent = self.home / 'repos'
        def populate(root, env):
            shutil.copytree(self.root / '.git/objects', Path(root) / '.git/objects', dirs_exist_ok=True)
        with patch.object(gitsafe, '_fetch', side_effect=populate):
            target = gitsafe.clone('Org/Example', parent)
        self.assertEqual(target, parent / 'Example')
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        self.assertEqual([p.name for p in target.iterdir()], ['.git'])
        self.assertEqual(list(parent.glob('.clone-*')), [])
        for name in ('Org/Example', 'Org/link'):
            if name.endswith('/link'):
                (parent / 'link').symlink_to(self.root)
            with self.assertRaises(gitsafe.GitDenied):
                gitsafe.clone(name, parent)
        for name in ('../x', 'OmnixSI/.git', 'a/b/c', 'OmnixSI/..', 'a/b c'):
            with self.subTest(name=name), patch.object(gitsafe.tempfile, 'mkdtemp') as made:
                with self.assertRaises(gitsafe.GitDenied):
                    gitsafe.clone(name, parent)
                made.assert_not_called()

    def test_C1b_C2_C3_failed_clone_cleans_up_and_preserves_reason(self):
        for failure in (gitsafe.GitFailed('fixed', 'auth'), TimeoutError(),
                        subprocess.TimeoutExpired('synthetic', 0.1)):
            with self.subTest(failure=type(failure).__name__), patch.object(gitsafe, '_fetch', side_effect=failure):
                with self.assertRaises(gitsafe.GitFailed) as caught:
                    gitsafe.clone('Org/Example', self.home / 'repos')
                self.assertEqual(caught.exception.reason, 'auth' if isinstance(failure, gitsafe.GitFailed) else 'timeout')
                self.assertEqual(list((self.home / 'repos').iterdir()), [])

    def test_C1b_C7_clone_size_counts_pack_and_loose_objects(self):
        (self.root / 'random.bin').write_bytes(os.urandom(65536))
        self.git('add', 'random.bin'); self.git('commit', '-qm', 'synthetic random bytes')
        for storage in ('loose', 'pack'):
            if storage == 'pack':
                self.git('repack', '-ad'); self.git('prune-packed')
            def populate(root, env):
                shutil.copytree(self.root / '.git/objects', Path(root) / '.git/objects', dirs_exist_ok=True)
            with self.subTest(storage=storage), patch.object(gitsafe, '_fetch', side_effect=populate):
                with self.assertRaises(gitsafe.GitFailed) as caught:
                    gitsafe.clone('Org/Example', self.home / 'repos', max_kib=1)
                self.assertEqual(caught.exception.reason, 'too_large')
                self.assertEqual(list((self.home / 'repos').iterdir()), [])

    def test_C1b_C8_clone_does_not_expose_credentials_in_arguments_or_output(self):
        secret = 'SyntheticPasswordNeverInArguments'
        original = gitsafe._run_process
        arguments = []
        def record(args, **kwargs):
            arguments.append(args)
            return original(args, **kwargs)
        def populate(root, env):
            env = dict(env, TEAMAGENT_GIT_PASSWORD=secret)
            gitsafe._invoke(root, env, ['count-objects', '-v'])
        with patch.object(gitsafe, '_run_process', side_effect=record), patch.object(gitsafe, '_fetch', side_effect=populate), patch('builtins.print') as printed:
            gitsafe.clone('Org/Example', self.home / 'repos')
        self.assertNotIn(secret, str(arguments))
        self.assertNotIn(secret, str(printed.call_args_list))

    def marker_script(self, name):
        marker = self.home / (name + '-executed')
        script = self.home / (name + '.sh')
        script.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nexit 1\n')
        script.chmod(0o700)
        return script, marker

    def index_remote(self):
        repo = 'OmnixSI/TeamAgent'
        self.git('remote', 'add', 'origin', 'https://github.com/' + repo + '.git')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
        return repo

    def test_T1_signed_commit_build_never_executes_local_gpg_programs(self):
        repo = self.index_remote()
        script, marker = self.marker_script('gpg')
        for key in ('gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program'):
            self.git('config', key, str(script))
        self.git('config', 'log.showSignature', 'true')
        signers = self.home / 'allowed-signers'
        signers.write_text('')
        self.git('config', 'gpg.ssh.allowedSignersFile', str(signers))
        original = self.git('cat-file', 'commit', 'HEAD')
        headers = original.split('\n\n', 1)[0]
        for format, label in (('openpgp', 'PGP'), ('ssh', 'SSH')):
            with self.subTest(format=format):
                self.git('config', 'gpg.format', format)
                signature = ('gpgsig -----BEGIN ' + label + ' SIGNATURE-----\n'
                             ' c3ludGhldGlj\n -----END ' + label + ' SIGNATURE-----')
                raw = headers + '\n' + signature + '\n\nsigned ' + format + '\n'
                sha = subprocess.run(['git', 'hash-object', '-t', 'commit', '-w', '--stdin'],
                                     cwd=self.root, input=raw, text=True, capture_output=True, check=True).stdout.strip()
                self.git('update-ref', 'refs/remotes/origin/main', sha)
                marker.unlink(missing_ok=True)
                with patch.object(repo_index, 'repo_root', return_value=self.root), \
                     patch.object(repo_index, 'H', self.home / '.inkboard-team'):
                    result = repo_index.build(repo, {}, 30)
                self.assertFalse(marker.exists(), format + ' verifier executed')
                record = next(c for c in result['commits'] if c['sha'] == sha)
                self.assertEqual(record['subject'], 'signed ' + format)
                self.assertEqual(record['author'], 'Index Test')
                self.assertEqual(result['head']['sha'], sha)

    def filter_worktree_is_skipped(self, include):
        repo = self.index_remote()
        script, marker = self.marker_script('filter')
        (self.root / '.gitattributes').write_text('* filter=evil\n')
        if include:
            config = self.home / 'filter.gitconfig'
            self.git('config', '--file', str(config), 'filter.evil.clean', str(script))
            self.git('config', '--file', str(config), 'filter.evil.process', str(script))
            self.git('config', 'include.path', str(config))
        else:
            self.git('config', 'filter.evil.clean', str(script))
            self.git('config', 'filter.evil.process', str(script))
        (self.root / 'data.txt').write_text('modified tracked file\n')
        result = repo_index.worktrees([self.home], repo)
        self.assertFalse(marker.exists(), 'filter driver executed')
        self.assertEqual(result, [{'label':self.root.name, 'skipReason':'filters_configured'}])
        self.assertNotIn(str(script), str(result))
        for command in ('status', 'diff'):
            with self.subTest(command=command):
                with self.assertRaises(gitsafe.GitDenied):
                    gitsafe.run(self.root, 'read', command)
        self.assertFalse(marker.exists())

    def test_T2_local_filter_driver_is_not_run_and_worktree_is_skipped(self):
        self.filter_worktree_is_skipped(include=False)

    def test_T2b_included_filter_driver_is_not_run_and_worktree_is_skipped(self):
        self.filter_worktree_is_skipped(include=True)

    def test_T3_missing_promisor_blob_never_executes_local_uploadpack(self):
        remote = self.home / 'promisor.git'
        self.git('clone', '--bare', str(self.root), str(remote))
        sha = self.git('rev-parse', 'HEAD').strip()
        blob = self.git('rev-parse', 'HEAD:data.txt').strip()
        script, marker = self.marker_script('uploadpack')
        self.git('config', 'core.repositoryFormatVersion', '1')
        self.git('config', 'extensions.partialClone', 'origin')
        self.git('config', 'remote.origin.url', str(remote))
        self.git('config', 'remote.origin.promisor', 'true')
        self.git('config', 'remote.origin.partialCloneFilter', 'blob:none')
        self.git('config', 'remote.origin.uploadpack', str(script))
        (self.root / '.git/objects' / blob[:2] / blob[2:]).unlink()
        with self.assertRaises(gitsafe.GitFailed):
            gitsafe.run(self.root, 'read', 'show', sha + ':data.txt')
        self.assertFalse(marker.exists(), 'lazy fetch uploadpack executed')

    def hardened_env(self):
        env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_') and k not in ('SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0',
                   GIT_ASKPASS='/usr/bin/false', GIT_OPTIONAL_LOCKS='0')
        return env

    def trusted_helper(self, scope='credential'):
        marker = self.home / 'trusted-actions'
        helper = self.home / 'trusted.sh'
        helper.write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "' + str(marker) + '"\n'
                          'if [ "$1" = get ]; then\n'
                          'printf "username=synthetic-user\\npassword=synthetic-password\\n"\nfi\n')
        helper.chmod(0o700)
        self.git('config', '--global', scope + '.helper', '!' + str(helper))
        return helper, marker

    @contextmanager
    def http_remote(self, mode='public'):
        public = self.home / 'public'; public.mkdir(exist_ok=True)
        remote = public / 'origin.git'
        if not remote.exists():
            self.git('clone', '--bare', str(self.root), str(remote))
        self.git('--git-dir=' + str(remote), 'update-server-info')
        class GitHTTP(SimpleHTTPRequestHandler):
            def do_GET(self):
                expected = 'Basic ' + base64.b64encode(b'synthetic-user:synthetic-password').decode()
                if mode == 'reject' or (mode == 'auth' and self.headers.get('Authorization') != expected):
                    self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="unit"'); self.end_headers()
                else:
                    super().do_GET()
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(GitHTTP, directory=str(public)))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        real_run = gitsafe._run_process
        def isolated(args, **kwargs):
            if args[:3] == ['git', 'credential', 'fill']:
                kwargs['env']['GIT_CONFIG_NOSYSTEM'] = '1'
            # Protect the old baseline's helper-discovery path too.
            if 'config' in args and '--system' in args:
                return subprocess.CompletedProcess(args, 1, '', '')
            return real_run(args, **kwargs)
        try:
            with patch.object(gitsafe, '_origin_url', return_value='http://127.0.0.1:' + str(server.server_port) + '/origin.git'), patch.object(gitsafe, '_run_process', side_effect=isolated) as started:
                yield remote, started
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_R7_read_commands_disable_repo_execution_hooks_and_textconv(self):
        marker = self.home / 'executed'
        script = self.home / 'evil.sh'
        script.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nprintf malicious\n')
        script.chmod(0o700)
        for key in ('core.fsmonitor', 'diff.external', 'diff.evil.textconv', 'core.pager'):
            self.git('config', key, str(script))
        self.git('config', 'alias.log', '!' + str(script))
        (self.root / '.gitattributes').write_text('*.txt diff=evil\n')
        (self.root / 'data.txt').write_text('after\n')
        for args in [('status', '--porcelain'), ('diff', 'HEAD'), ('show', 'HEAD'), ('log', '-p'), ('grep', 'before', 'HEAD')]:
            with self.subTest(command=args):
                gitsafe.run(self.root, 'read', *args)
                self.assertFalse(marker.exists())
        self.assertIn('-after', gitsafe.run(self.root, 'read', 'diff', '-R', 'HEAD'))

    def test_R7b_denied_commands_and_worktree_paths_never_start_a_process(self):
        sub = self.home / '.inkboard-team/sub/ok'
        denied = [
            ('read', ('commit', '-m', 'bad')), ('read', ('push', 'origin')),
            ('read', ('config', '--add', 'x.y', 'bad')),
            ('read', ('config', '--get', '--global')),
            ('read', ('worktree', 'add', '--detach', str(sub), 'HEAD')),
            ('lifecycle', ('commit',)), ('lifecycle', ('push',)),
            ('lifecycle', ('config', '--add', 'x.y', 'bad')),
            ('lifecycle', ('fetch', 'origin')),
            ('lifecycle', ('fetch', '--prune', 'origin', 'HEAD:main')),
            ('lifecycle', ('worktree', 'add', str(sub), 'HEAD')),
            ('lifecycle', ('worktree', 'add', '--detach', str(self.home / '.inkboard-team/work/bad'), 'HEAD')),
            ('lifecycle', ('worktree', 'remove', str(sub))),
            ('read', ('diff', '--output=' + str(self.home / 'bad'))),
            ('read', ('grep', '-O' + str(self.home / 'evil'), 'text')),
            ('read', ('cat-file', '--filters', 'HEAD:data.txt')),
            ('unknown', ('log',)),
        ]
        with patch.object(gitsafe, '_run_process') as started:
            for cls, args in denied:
                with self.subTest(cls=cls, args=args):
                    with self.assertRaises(gitsafe.GitDenied):
                        gitsafe.run(self.root, cls, *args)
            self.assertEqual(started.call_count, 0)

    def test_lifecycle_allows_only_detached_private_worktrees(self):
        sub = self.home / '.inkboard-team/sub/ok'
        sub.parent.mkdir(parents=True)
        gitsafe.run(self.root, 'lifecycle', 'worktree', 'add', '--detach', str(sub), 'HEAD')
        self.assertEqual(gitsafe.run(sub, 'read', 'rev-parse', 'HEAD').strip(), self.git('rev-parse', 'HEAD').strip())
        gitsafe.run(self.root, 'lifecycle', 'worktree', 'remove', '--force', str(sub))
        gitsafe.run(self.root, 'lifecycle', 'worktree', 'prune')
        self.assertFalse(sub.exists())
        sub.symlink_to(self.home, target_is_directory=True)
        with patch.object(gitsafe, '_run_process') as started:
            with self.assertRaises(gitsafe.GitDenied):
                gitsafe.run(self.root, 'lifecycle', 'worktree', 'add', '--detach', str(sub / 'escape'), 'HEAD')
            self.assertEqual(started.call_count, 0)

    def test_read_config_and_ancestor_checks_remain_available(self):
        self.assertIn('Index Test', gitsafe.run(self.root, 'read', 'config', '--get', 'user.name'))
        self.assertIn('user.name', gitsafe.run(self.root, 'read', 'config', '--get-regexp', '^user\\.'))
        gitsafe.run(self.root, 'read', 'merge-base', '--is-ancestor', 'HEAD', 'HEAD')
        self.assertIn(str(self.root), gitsafe.run(self.root, 'read', 'worktree', 'list', '--porcelain'))
        with self.assertRaises(gitsafe.GitFailed) as failure:
            gitsafe.run(self.root, 'read', 'show', 'not-a-ref')
        self.assertNotIn('not-a-ref', str(failure.exception))

    def test_git_prefix_and_read_environment(self):
        def result(args, **kwargs):
            return subprocess.CompletedProcess(args, 1 if 'config' in args else 0, '' if 'config' in args else 'ok', '')
        with patch.dict(os.environ, {'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'core.fsmonitor','GIT_CONFIG_VALUE_0':'evil'}), patch.object(gitsafe, '_run_process', side_effect=result) as started:
            self.assertEqual(gitsafe.run(self.root, 'read', 'status'), 'ok')
        args, opts = started.call_args
        self.assertEqual(args[0], ['git','--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','diff.external=','-c','core.pager=cat','-c','color.ui=false','-c','color.diff=false',
                                  '-c','log.showSignature=false','-c','gpg.program=/usr/bin/false','-c','gpg.openpgp.program=/usr/bin/false',
                                  '-c','gpg.x509.program=/usr/bin/false','-c','gpg.ssh.program=/usr/bin/false',
                                  '-c','core.sshCommand=/usr/bin/ssh -F /dev/null -oBatchMode=yes -oConnectTimeout=5','-c','credential.helper=','-c','protocol.ext.allow=never','-c','safe.directory='+str(self.root.resolve()),'status','--ignore-submodules=all'])
        self.assertEqual(opts['env']['GIT_CONFIG_NOSYSTEM'], '1')
        self.assertEqual(opts['env']['GIT_CONFIG_GLOBAL'], '/dev/null')
        self.assertEqual(opts['env']['GIT_TERMINAL_PROMPT'], '0')
        self.assertEqual(opts['env']['GIT_ASKPASS'], '/usr/bin/false')
        self.assertEqual(opts['env']['GIT_OPTIONAL_LOCKS'], '0')
        self.assertEqual(opts['env']['GIT_ALLOW_PROTOCOL'], 'none')
        self.assertNotIn('GIT_CONFIG_COUNT', opts['env'])
        self.assertFalse(opts.get('shell', False))

    def test_credential_env_sees_same_trusted_config_as_plain_git(self):
        neutral = self.home / 'neutral.git'
        self.git('init', '--bare', '--template=', str(neutral))
        plain = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
        plain['GIT_DIR'] = str(neutral)
        env = gitsafe._credential_env(self.hardened_env(), neutral)
        args = ['git', 'config', '--show-origin', '--show-scope', '--get-all', 'credential.helper']
        expected = subprocess.run(args, cwd=neutral, env=plain, capture_output=True, text=True)
        actual = subprocess.run(args, cwd=neutral, env=env, capture_output=True, text=True)
        self.assertEqual((actual.returncode, actual.stdout), (expected.returncode, expected.stdout))
        self.assertEqual(env['GIT_ASKPASS'], '/usr/bin/false')
        self.assertEqual(env['GIT_TERMINAL_PROMPT'], '0')
        with self.subTest(platform='Apple built-in system config'):
            exec_path = Path(self.git('--exec-path').strip())
            builtin = exec_path.parents[1] / 'share/git-core/gitconfig'
            if not builtin.is_file() or 'osxkeychain' not in builtin.read_text():
                self.skipTest('no Apple built-in gitconfig with osxkeychain; generic comparison passed')
            self.assertIn('osxkeychain', actual.stdout)
            hidden = subprocess.run(args, cwd=neutral, env=dict(env, GIT_CONFIG_NOSYSTEM='1'), capture_output=True, text=True)
            self.assertNotIn('osxkeychain', hidden.stdout)

    def test_fetch_authenticates_with_global_helper_without_running_local_helpers(self):
        public = self.home / 'public'; public.mkdir()
        remote = public / 'origin.git'
        self.git('clone', '--bare', str(self.root), str(remote))
        self.git('--git-dir=' + str(remote), 'update-server-info')
        expected = 'Basic ' + base64.b64encode(b'synthetic-user:synthetic-password').decode()
        class AuthGit(SimpleHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get('Authorization') != expected:
                    self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="unit"'); self.end_headers()
                else:
                    super().do_GET()
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(AuthGit, directory=str(public)))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        url = 'http://127.0.0.1:' + str(server.server_port)
        stolen = []
        class Attacker(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get('Authorization'):
                    stolen.append(self.headers['Authorization'])
                    self.send_response(502)
                else:
                    self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="unit"')
                self.end_headers()
            def log_message(self, *args): pass
        attacker = ThreadingHTTPServer(('127.0.0.1', 0), Attacker)
        attacker_thread = threading.Thread(target=attacker.serve_forever, daemon=True); attacker_thread.start()
        attacker_url = 'http://127.0.0.1:' + str(attacker.server_port)
        trusted = self.home / 'trusted-helper.sh'; trusted_marker = self.home / 'trusted-ran'
        trusted.write_text('#!/bin/sh\nif [ "$1" = get ]; then\n  touch "' + str(trusted_marker) + '"\n  printf "username=synthetic-user\\npassword=synthetic-password\\n"\nfi\n')
        trusted.chmod(0o700)
        evil = self.home / 'evil-helper.sh'; evil_marker = self.home / 'evil-ran'
        evil.write_text('#!/bin/sh\ntouch "' + str(evil_marker) + '"\nexit 1\n'); evil.chmod(0o700)
        included = self.home / 'helpers.gitconfig'
        self.git('config', '--file', str(included), 'credential.' + url + '.helper', '!' + str(trusted))
        self.git('config', '--global', 'include.path', str(included))
        self.git('config', '--global', 'credential.helper', '!' + str(trusted))
        self.git('remote', 'add', 'origin', url + '/origin.git')
        self.git('config', 'credential.helper', '!' + str(evil))
        self.git('config', 'credential.' + url + '.helper', '!' + str(evil))
        self.git('config', 'core.askPass', str(evil))
        malicious_include = self.home / 'network.gitconfig'
        self.git('config', '--file', str(malicious_include), 'http.proxy', attacker_url)
        real_run = gitsafe._run_process
        calls = []
        def isolated(args, **kwargs):
            # Do not consult this machine's system credential store in a fixture.
            calls.append((list(args), dict(kwargs, env=dict(kwargs['env']))))
            if args[:3] == ['git', 'credential', 'fill']:
                self.assertEqual(kwargs['env']['GIT_DIR'], kwargs['cwd'])
                neutral = Path(kwargs['cwd'])
                self.assertNotEqual(neutral, self.root)
                self.assertNotIn(self.root, neutral.parents)
                self.assertNotIn(str(self.root), str((args, kwargs)))
                self.assertNotIn('GIT_CONFIG_NOSYSTEM', kwargs['env'])
                self.assertNotIn('GIT_CONFIG_GLOBAL', kwargs['env'])
                self.assertEqual(kwargs['input'], 'protocol=http\nhost=127.0.0.1:' + str(server.server_port) + '\npath=origin.git\n\n')
                kwargs['env']['GIT_CONFIG_NOSYSTEM'] = '1'
            if 'config' in args and '--system' in args:
                return subprocess.CompletedProcess(args, 1, '', '')
            if 'fetch' in args:
                self.assertNotEqual(Path(kwargs['cwd']), self.root)
                self.assertEqual(kwargs['env']['GIT_CONFIG_NOSYSTEM'], '1')
                self.assertEqual(kwargs['env']['TEAMAGENT_GIT_PASSWORD'], 'synthetic-password')
            else:
                self.assertNotIn('TEAMAGENT_GIT_PASSWORD', kwargs['env'])
            if 'fetch' in args:
                self.assertNotIn('GIT_ALLOW_PROTOCOL', kwargs['env'])
                for key, value in [('proxy', ''), ('sslVerify', 'true'), ('extraHeader', ''), ('followRedirects', 'false')]:
                    self.assertIn('http.' + key + '=' + value, args)
                # No URL-scoped/local CA, header, credential or rewrite settings
                # may reach the actual network process through config includes.
                config = real_run(['git', 'config', '--local', '--list'], **{k:v for k,v in kwargs.items() if k not in ('input',)}).stdout
                self.assertNotIn('http.', config)
                self.assertNotIn('credential.', config)
                self.assertNotIn('url.', config)
            return real_run(args, **kwargs)
        try:
            attacks = [[], [('http.proxy', attacker_url)],
                       [('http.' + url + '.proxy', attacker_url), ('http.' + url + '.sslVerify', 'false')],
                       [('remote.origin.proxy', attacker_url)],
                       [('include.path', str(malicious_include))],
                       [('includeIf.gitdir:' + str(self.root) + '/.path', str(malicious_include))],
                       [('credential.useHttpPath', 'true'), ('credential.username', 'attacker')],
                       [('core.fsmonitor', str(evil))], [('core.hooksPath', str(self.home))],
                       [('url.' + attacker_url + '/.insteadOf', url + '/')],
                       [('url.' + attacker_url + '/.pushInsteadOf', url + '/')],
                       [('http.proxy', attacker_url), ('http.sslVerify', 'false'),
                        ('http.sslCAInfo', str(self.home / 'untrusted-ca')), ('http.sslCAPath', str(self.home)),
                        ('http.extraHeader', 'Authorization: injected-local-header')]]
            for settings in attacks:
                with self.subTest(settings=settings):
                    for key, value in settings: self.git('config', key, value)
                    stolen.clear()
                    try:
                        # HTTP loopback substitutes for the separately tested
                        # production GitHub allowlist; no external service is used.
                        with patch.dict(os.environ, {'NO_PROXY':'', 'no_proxy':''}), patch.object(gitsafe, '_origin_url', return_value=url + '/origin.git'), patch.object(gitsafe, '_run_process', side_effect=isolated):
                            try:
                                gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
                            finally:
                                self.assertEqual(stolen, [], 'repository config leaked Authorization to attacker')
                        self.assertTrue(trusted_marker.exists())
                        self.assertFalse(evil_marker.exists())
                        branch = self.git('symbolic-ref', '--short', 'HEAD').strip()
                        self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/' + branch), self.git('rev-parse', 'HEAD'))
                    finally:
                        for key, _ in settings: self.git('config', '--unset-all', key)
            original = self.git('rev-parse', 'HEAD').strip()
            self.git('update-ref', 'refs/remotes/origin/obsolete', original)
            self.git('tag', 'local-tag')
            self.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + branch)
            self.git('pack-refs', '--all', '--prune')
            later = self.git('--git-dir=' + str(remote), '-c', 'user.name=Remote', '-c', 'user.email=remote@example.invalid',
                             'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'remote change').strip()
            self.git('--git-dir=' + str(remote), 'update-ref', 'refs/heads/' + branch, later)
            self.git('--git-dir=' + str(remote), 'update-server-info')
            with patch.object(gitsafe, '_origin_url', return_value=url + '/origin.git'), patch.object(gitsafe, '_run_process', side_effect=isolated):
                gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/' + branch).strip(), later)
            self.assertEqual(self.git('rev-parse', 'HEAD').strip(), original)
            self.assertEqual(self.git('rev-parse', 'refs/tags/local-tag').strip(), original)
            self.assertEqual(self.git('symbolic-ref', 'refs/remotes/origin/HEAD').strip(), 'refs/remotes/origin/' + branch)
            self.assertNotIn('obsolete', self.git('for-each-ref', '--format=%(refname)', 'refs/remotes/origin'))
            expected = 'Basic intentionally-invalid'
            with patch.object(gitsafe, '_origin_url', return_value=url + '/origin.git'), patch.object(gitsafe, '_run_process', side_effect=isolated), self.assertRaises(gitsafe.GitFailed) as failure:
                gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertNotIn('synthetic-password', str(failure.exception))
            self.assertTrue(any(args[:3] == ['git', 'credential', 'fill'] for args, _ in calls))
            self.assertTrue(all('synthetic-password' not in arg for args, _ in calls for arg in args))
            self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/' + branch).strip(), later)
        finally:
            server.shutdown(); server.server_close(); thread.join()
            attacker.shutdown(); attacker.server_close(); attacker_thread.join()

    def test_fetch_without_credentials_is_public_or_fails_promptly(self):
        for mode in ('public', 'reject'):
            with self.subTest(mode=mode), self.http_remote(mode) as (_, started):
                began = time.monotonic()
                if mode == 'public':
                    gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
                else:
                    with self.assertRaises(gitsafe.GitFailed):
                        gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
                    self.assertLess(time.monotonic() - began, 5)
                fetch = next(c.args[0] for c in started.call_args_list if 'fetch' in c.args[0])
                self.assertNotIn('credential.helper=' + gitsafe.FIXED_HELPER, fetch)
                self.assertTrue(any(c.args[0][:3] == ['git', 'credential', 'fill'] for c in started.call_args_list))

    def test_ssh_fetch_does_not_request_http_credentials(self):
        real_run = gitsafe._run_process
        def isolated(args, **kwargs):
            if 'fetch' in args:
                return subprocess.CompletedProcess(args, 1, '', '')
            if 'config' in args and '--system' in args:
                return subprocess.CompletedProcess(args, 1, '', '')
            return real_run(args, **kwargs)
        with patch.object(gitsafe, '_origin_url', return_value='git@github.com:a/b'), patch.object(gitsafe, '_run_process', side_effect=isolated) as started:
            with self.assertRaises(gitsafe.GitFailed):
                gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
        self.assertFalse(any(c.args[0][:3] == ['git', 'credential', 'fill'] for c in started.call_args_list))

    def test_fetch_preserves_and_updates_custom_pull_refs_while_pruning_deleted_branches(self):
        original = self.git('rev-parse', 'HEAD').strip()
        self.git('config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
        self.git('config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*')
        self.git('update-ref', 'refs/remotes/origin/pr/1', original)
        self.git('branch', 'obsolete')
        with self.http_remote() as (remote, _):
            self.git('--git-dir=' + str(remote), 'update-ref', 'refs/pull/1/head', original)
            self.git('--git-dir=' + str(remote), 'update-server-info')
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            refs = self.git('for-each-ref', '--format=%(refname)')
            self.assertIn('refs/remotes/origin/pr/1', refs)
            self.assertIn('refs/remotes/origin/obsolete', refs)
            later = self.git('--git-dir=' + str(remote), 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'later').strip()
            self.git('--git-dir=' + str(remote), 'update-ref', 'refs/pull/1/head', later)
            self.git('--git-dir=' + str(remote), 'update-ref', '-d', 'refs/heads/obsolete')
            self.git('--git-dir=' + str(remote), 'update-server-info')
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/pr/1').strip(), later)
            self.assertNotIn('refs/remotes/origin/obsolete', self.git('for-each-ref', '--format=%(refname)'))

    def test_fetch_honors_negative_refspecs(self):
        self.git('branch', 'tmp')
        self.git('config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
        self.git('config', '--add', 'remote.origin.fetch', '^refs/heads/tmp')
        with self.http_remote():
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
        self.assertNotIn('refs/remotes/origin/tmp', self.git('for-each-ref', '--format=%(refname)'))

    def test_fetch_skips_invalid_refspecs_without_losing_valid_updates(self):
        self.git('config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
        for spec in ('refs/heads/../x:refs/remotes/origin/x', 'refs/heads/a.lock:refs/remotes/origin/a.lock'):
            self.git('config', '--add', 'remote.origin.fetch', spec)
        with self.http_remote() as (remote, _):
            branch = self.git('symbolic-ref', '--short', 'HEAD').strip()
            later = self.git('--git-dir=' + str(remote), 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'later').strip()
            self.git('--git-dir=' + str(remote), 'update-ref', 'refs/heads/' + branch, later)
            self.git('--git-dir=' + str(remote), 'update-server-info')
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
        self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/' + branch).strip(), later)

    def test_usable_refspecs_validate_with_git_and_fall_back_only_without_positive_specs(self):
        default = '+refs/heads/*:refs/remotes/origin/*'
        valid = [default, 'refs/heads/main:refs/remotes/origin/main',
                 '+refs/pull/*/head:refs/remotes/origin/pr/*', '^refs/heads/tmp', '^refs/heads/tmp/*']
        invalid = ['++refs/heads/*:refs/remotes/origin/*', '+^refs/heads/tmp',
                   '^refs/heads/a:refs/remotes/origin/a', 'refs/heads/../x:refs/remotes/origin/x',
                   'refs/heads/a.lock:refs/remotes/origin/a.lock', 'refs/heads/*:refs/remotes/origin/x',
                   '+refs/heads/*:refs/heads/*', '-x:refs/remotes/origin/x',
                   'refs/heads/main:refs/remotes/origin/../x', 'refs/heads/main:refs/remotes/origin/a.lock']
        neutral = self.home / 'neutral.git'
        self.git('init', '--bare', '--template=', str(neutral))
        env = self.hardened_env()
        real_run = gitsafe._run_process
        with patch.object(gitsafe, '_run_process', wraps=real_run) as started:
            for spec in valid + invalid:
                with self.subTest(spec=spec):
                    expected = [default, spec] if spec.startswith('^') and spec in valid else [spec] if spec in valid else [default]
                    self.assertEqual(gitsafe._usable_refspecs([spec], neutral, env), expected)
            self.assertEqual(gitsafe._usable_refspecs([], neutral, env), [default])
            self.assertEqual(gitsafe._usable_refspecs(valid + invalid, neutral, env), valid)
            for call in started.call_args_list:
                self.assertEqual(call.kwargs['cwd'], neutral)
                self.assertEqual(call.args[0][-3:-1], ['check-ref-format', '--refspec-pattern'])
                self.assertTrue(call.args[0][-1].startswith('refs/'))
                self.assertNotIn('-x:refs/remotes/origin/x', call.args[0])

    def test_trusted_helper_receives_only_get_after_success_rejection_and_public_fetch(self):
        _, marker = self.trusted_helper()
        with self.http_remote('auth'):
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertEqual(marker.read_text().splitlines(), ['get'])
        with self.http_remote():
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertEqual(marker.read_text().splitlines(), ['get', 'get'])
        with self.http_remote('reject'):
            with self.assertRaises(gitsafe.GitFailed):
                gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
        self.assertEqual(marker.read_text().splitlines(), ['get', 'get', 'get'])

    def test_https_connect_proxy_cannot_steal_credentials_and_positive_control_can(self):
        openssl = shutil.which('openssl')
        if not openssl:
            self.skipTest('openssl unavailable')
        cert, key = self.home / 'cert.pem', self.home / 'key.pem'
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=github.invalid', '-keyout', str(key), '-out', str(cert)],
                       check=True, capture_output=True, timeout=20)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        connections, stolen = [], []
        class TLSHTTP(BaseHTTPRequestHandler):
            def do_GET(self):
                auth = self.headers.get('Authorization')
                if auth:
                    stolen.append(auth)
                    self.send_response(403)
                else:
                    self.send_response(401)
                    self.send_header('WWW-Authenticate', 'Basic realm="unit"')
                self.end_headers()
            def log_message(self, *args): pass
        class ConnectProxy(BaseHTTPRequestHandler):
            def do_CONNECT(self):
                connections.append(self.path)
                self.send_response(200); self.end_headers(); self.wfile.flush()
                self.connection.settimeout(5)
                with context.wrap_socket(self.connection, server_side=True) as tls:
                    TLSHTTP(tls, self.client_address, self.server)
                self.close_connection = True
            def log_message(self, *args): pass
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), ConnectProxy)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True); thread.start()
        url = 'https://github.invalid/o/r'
        proxy_url = 'http://127.0.0.1:' + str(proxy.server_port)
        helper, marker = self.trusted_helper('credential.https://github.invalid')
        for name, value in [('http.https://github.invalid.proxy', proxy_url),
                            ('http.https://github.invalid.sslVerify', 'false'),
                            ('http.https://github.invalid.sslCAInfo', str(cert)), ('http.proxy', proxy_url)]:
            self.git('config', name, value)
        real_run = gitsafe._run_process
        def isolated(args, **kwargs):
            if args[:3] == ['git', 'credential', 'fill']:
                kwargs['env']['GIT_CONFIG_NOSYSTEM'] = '1'
            if 'config' in args and '--system' in args:
                return subprocess.CompletedProcess(args, 1, '', '')
            return real_run(args, **kwargs)
        try:
            with patch.dict(os.environ, {'NO_PROXY':'', 'no_proxy':''}), patch.object(gitsafe, '_origin_url', return_value=url), patch.object(gitsafe, '_run_process', side_effect=isolated):
                with self.assertRaises(gitsafe.GitFailed):
                    gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertEqual(connections, [])
            self.assertEqual(stolen, [])
            self.assertEqual(marker.read_text().splitlines(), ['get'])
            control_env = self.hardened_env()
            control_env.update(NO_PROXY='', no_proxy='')
            control = subprocess.run(['git', '-c', 'http.proxy=' + proxy_url, '-c', 'http.sslVerify=false',
                                '-c', 'credential.helper=', '-c', 'credential.helper=!' + str(helper),
                                'ls-remote', url], cwd=self.home, env=control_env,
                               capture_output=True, text=True, timeout=10)
            self.assertNotEqual(control.returncode, 0)  # The proxy deliberately serves no repository.
            self.assertTrue(connections)
            self.assertIn('Basic ' + base64.b64encode(b'synthetic-user:synthetic-password').decode(), stolen)
        finally:
            proxy.shutdown(); proxy.server_close(); thread.join()

    def test_fetch_origin_is_an_unrewritten_allowlisted_github_url(self):
        self.git('remote', 'add', 'origin', 'https://github.com/OmnixSI/TeamAgent.git')
        for prefix in ('https://github.com/', 'git@github.com:'):
            for suffix in ('OmnixSI/TeamAgent', 'OmnixSI/TeamAgent.git'):
                url = prefix + suffix
                self.git('remote', 'set-url', 'origin', url)
                self.git('config', 'url.http://attacker.invalid/.insteadOf', prefix)
                self.assertEqual(gitsafe._origin_url(self.root), url)
        for url in ('http://github.com/OmnixSI/TeamAgent', 'https://attacker.invalid/OmnixSI/TeamAgent',
                    'https://github.com@attacker.invalid/OmnixSI/TeamAgent', 'ext::evil', '/tmp/repo'):
            self.git('remote', 'set-url', 'origin', url)
            with self.subTest(url=url), self.assertRaises(gitsafe.GitFailed):
                gitsafe._origin_url(self.root)

    def test_credential_lookup_shares_the_round_budget_and_is_not_used_for_reads(self):
        clock = [100.0]
        real_run = gitsafe._run_process
        def slow(args, **kwargs):
            if args[:3] == ['git', 'credential', 'fill']:
                self.assertLessEqual(kwargs['timeout'], 1)
                clock[0] += 2
                return subprocess.CompletedProcess(args, 0, 'username=u\npassword=p\n', '')
            if 'fetch' in args:
                return subprocess.CompletedProcess(args, 1, '', '')
            # Never consult a real helper in the old baseline.
            if 'config' in args and '--system' in args:
                return subprocess.CompletedProcess(args, 1, '', '')
            return real_run(args, **kwargs)
        with patch.object(gitsafe, '_origin_url', return_value='https://github.com/a/b'), patch.object(gitsafe.time, 'monotonic', side_effect=lambda:clock[0]), patch.object(gitsafe, '_run_process', side_effect=slow) as started:
            with gitsafe.time_budget(1), self.assertRaises(TimeoutError):
                gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertEqual(sum(c.args[0][:3] == ['git', 'credential', 'fill'] for c in started.call_args_list), 1)
        with patch.object(gitsafe, '_run_process', wraps=real_run) as started:
            gitsafe.run(self.root, 'read', 'status')
            self.assertEqual(started.call_count, 2)
            self.assertTrue(all('credential' not in c.args[0] for c in started.call_args_list))

    def test_git_round_has_one_shared_timeout_budget(self):
        clock = [100.0]
        def slow(args, **kwargs):
            self.assertLessEqual(kwargs['timeout'], 30)
            clock[0] += 65
            return subprocess.CompletedProcess(args, 1 if '--get-regexp' in args else 0, '', '')
        with patch.object(gitsafe.time, 'monotonic', side_effect=lambda:clock[0]), patch.object(gitsafe, '_run_process', side_effect=slow) as started:
            with gitsafe.time_budget(120):
                gitsafe.run(self.root, 'read', 'status')
                with self.assertRaises(TimeoutError):
                    gitsafe.run(self.root, 'read', 'log')
            self.assertEqual(started.call_count, 2)
            self.assertIn('--get-regexp', started.call_args_list[0].args[0])
            self.assertIn('status', started.call_args_list[1].args[0])

    def test_review_P1_fetch_cannot_execute_repository_ssh_command(self):
        marker = self.home / 'ssh-executed'
        script = self.home / 'ssh-evil.sh'
        script.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nexit 1\n'); script.chmod(0o700)
        self.git('remote', 'add', 'origin', 'ssh://127.0.0.1:1/nonexistent')
        self.git('config', 'core.sshCommand', str(script))
        with self.assertRaises(gitsafe.GitFailed):
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
        self.assertFalse(marker.exists(), 'repo-local core.sshCommand executed')

    def test_review_P1_fetch_cannot_execute_credential_helper_or_ext_transport(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        class AuthOnly(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="unit"'); self.end_headers()
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), AuthOnly)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        marker = self.home / 'credential-executed'
        script = self.home / 'credential-evil.sh'
        script.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nexit 1\n'); script.chmod(0o700)
        self.git('remote', 'add', 'origin', 'http://127.0.0.1:' + str(server.server_port) + '/fake')
        self.git('config', 'credential.helper', '!' + str(script))
        self.git('config', 'core.askPass', str(script))
        try:
            with self.assertRaises(gitsafe.GitFailed):
                gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
            self.assertFalse(marker.exists(), 'repo-local credential.helper executed')
        finally:
            server.shutdown(); server.server_close(); thread.join()
        self.git('remote', 'set-url', 'origin', 'ext::' + str(script))
        self.git('config', 'protocol.ext.allow', 'always')
        with self.assertRaises(gitsafe.GitFailed):
            gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')
        self.assertFalse(marker.exists(), 'repo-local ext transport executed')

    def test_review_P2_repository_escape_modes_are_rejected_before_spawn(self):
        denied = [('diff', '--no-index', 'a', 'b'), ('diff', '--no-ind', 'a', 'b'),
                  ('config', '--get', 'include.path'), ('config', '--get', 'Include.Path'),
                  ('config', '--get-regexp', '.*'), ('config', '--get-regexp', '^include'),
                  ('cat-file', '--batch'), ('cat-file', '--batch-check'), ('cat-file', '--batch-command'), ('cat-file', '--bat')]
        with patch.object(gitsafe, '_run_process', return_value=subprocess.CompletedProcess([], 0, '', '')) as started:
            for args in denied:
                with self.subTest(args=args), self.assertRaises(gitsafe.GitDenied):
                    gitsafe.run(self.root, 'read', *args)
            self.assertEqual(started.call_count, 0)

    def test_review_P2_safe_directory_trusts_only_current_canonical_root(self):
        with patch.dict(os.environ, {'SSH_ASKPASS':'synthetic-untrusted-helper','GIT_SSH_COMMAND':'synthetic-untrusted-command'}), patch.object(gitsafe, '_run_process', wraps=gitsafe._run_process) as started:
            gitsafe.run(self.root, 'read', 'status')
        args, opts = started.call_args
        directories = [arg for arg in args[0] if arg.startswith('safe.directory=')]
        self.assertEqual(directories, ['safe.directory=' + str(self.root.resolve())])
        self.assertNotIn('GIT_SSH_COMMAND', opts['env']); self.assertNotIn('SSH_ASKPASS', opts['env'])

    def test_followup_diff_always_ignores_submodules(self):
        with patch.object(gitsafe, '_invoke', wraps=gitsafe._invoke) as started:
            gitsafe.run(self.root, 'read', 'diff', 'HEAD')
        self.assertIn('--ignore-submodules=all', started.call_args.args[2])

    def test_followup_filter_check_has_thirty_second_and_remaining_round_budget(self):
        clock = [100.0]
        def checked(args, **kwargs):
            self.assertIn('--get-regexp', args)
            self.assertEqual(kwargs['timeout'], expected)
            return subprocess.CompletedProcess(args, 1, '', '')
        with patch.object(gitsafe.time, 'monotonic', side_effect=lambda:clock[0]), patch.object(gitsafe, '_run_process', side_effect=checked):
            expected = 30
            gitsafe._check_filters(self.root, self.hardened_env())
            with gitsafe.time_budget(120):
                gitsafe._check_filters(self.root, self.hardened_env())
                clock[0] = 215.0
                expected = 5
                gitsafe._check_filters(self.root, self.hardened_env())
                clock[0] = 220.0
                with self.assertRaises(TimeoutError):
                    gitsafe._check_filters(self.root, self.hardened_env())

    def test_followup_timeout_kills_git_and_credential_helper_descendants(self):
        helper = self.home / 'slow.py'
        marker = self.home / 'descendant-survived'
        helper.write_text('import subprocess, sys, time\n'
                          'subprocess.Popen([sys.executable, "-c", '
                          '"import time; from pathlib import Path; time.sleep(0.8); Path(" + repr(sys.argv[1]) + ").touch()"] )\n'
                          'time.sleep(10)\n')
        command = shlex.quote(sys.executable) + ' ' + shlex.quote(str(helper)) + ' ' + shlex.quote(str(marker))
        self.git('config', '--global', 'credential.helper', '!' + command)
        neutral = self.home / 'neutral.git'
        self.git('init', '--bare', '--template=', str(neutral))
        for kind in ('invoke', 'credential'):
            with self.subTest(kind=kind), patch.object(gitsafe, '_timeout', return_value=0.3), patch.object(gitsafe.os, 'killpg', wraps=os.killpg) as killed:
                began = time.monotonic()
                with self.assertRaises(subprocess.TimeoutExpired):
                    if kind == 'invoke':
                        gitsafe._invoke(self.root, self.hardened_env(), ['-c', 'alias.slow=!' + command, 'slow'])
                    else:
                        env = self.hardened_env()
                        trusted = gitsafe._credential_env(env, neutral)
                        trusted['GIT_CONFIG_NOSYSTEM'] = '1'
                        with patch.object(gitsafe, '_credential_env', return_value=trusted):
                            gitsafe._lookup_credential('https://github.com/a/b', neutral, env)
                self.assertLess(time.monotonic() - began, 1.2)
                killed.assert_called_once()
                time.sleep(0.9)
                self.assertFalse(marker.exists(), 'helper descendant survived the timeout')

    def test_followup_patch_byte_cap_stops_a_streaming_process_and_reaps_it(self):
        args = [sys.executable, '-c', 'import os, time; os.write(1, b"x" * 65536); time.sleep(10)']
        processes = []
        real_popen = subprocess.Popen
        def started(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process
        with patch.object(gitsafe.subprocess, 'Popen', side_effect=started):
            with self.assertRaises(gitsafe.GitOutputTooLarge):
                gitsafe._run_process(args, cwd=self.root, env=self.hardened_env(), timeout=2, max_bytes=256)
        self.assertIsNotNone(processes[0].poll())

    def test_followup_bounded_output_preserves_unicode_and_exact_limit(self):
        for text in ('a' * 256, '中' * 85):
            args = [sys.executable, '-c', 'import sys; sys.stdout.buffer.write(' + repr(text.encode()) + ')']
            result = gitsafe._run_process(args, cwd=self.root, env=self.hardened_env(), timeout=2, max_bytes=256)
            self.assertEqual(result.stdout, text)
            self.assertEqual(result.returncode, 0)

    def test_review_byte_cap_cleanup_kills_descendants_holding_stdout(self):
        marker = self.home / 'overflow-descendant-survived'
        child = 'import time; from pathlib import Path; time.sleep(2); Path(' + repr(str(marker)) + ').touch()'
        parent = ('import subprocess, sys, os, time; '
                  'subprocess.Popen([sys.executable, "-c", ' + repr(child) + ']); '
                  'os.write(1, b"x" * 65536); time.sleep(10)')
        began = time.monotonic()
        with patch.object(gitsafe.os, 'killpg', wraps=os.killpg) as killed:
            with self.assertRaises(gitsafe.GitOutputTooLarge):
                gitsafe._run_process([sys.executable, '-c', parent], cwd=self.root,
                                     env=self.hardened_env(), timeout=3, max_bytes=256)
            killed.assert_called_once()
        self.assertLess(time.monotonic() - began, 1.8)
        time.sleep(1.2)
        self.assertFalse(marker.exists(), 'overflow left a descendant running')
