"""K2 / R-7 / R-7b: exercise real Git without touching any user repository."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from runner import gitsafe


class GitSafeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / 'repo'
        self.root.mkdir()
        self.env = patch.dict(os.environ, {'HOME':str(self.home),'NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost'})
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
        with patch.object(gitsafe.subprocess, 'run') as started:
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
        with patch.object(gitsafe.subprocess, 'run') as started:
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

    def test_git_prefix_environment_and_fetch_arguments(self):
        with patch.dict(os.environ, {'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'core.fsmonitor','GIT_CONFIG_VALUE_0':'evil'}), patch.object(gitsafe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'ok', '')) as started:
            self.assertEqual(gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin'), 'ok')
        args, opts = started.call_args
        self.assertEqual(args[0], ['git','--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','diff.external=','-c','core.pager=cat','-c','core.sshCommand=/usr/bin/ssh -F /dev/null -oBatchMode=yes -oConnectTimeout=5','-c','credential.helper=','-c','core.askPass=','-c','protocol.ext.allow=never','-c','safe.directory='+str(self.root.resolve()),'fetch','--prune','origin'])
        self.assertEqual(opts['env']['GIT_CONFIG_NOSYSTEM'], '1')
        self.assertEqual(opts['env']['GIT_CONFIG_GLOBAL'], '/dev/null')
        self.assertEqual(opts['env']['GIT_TERMINAL_PROMPT'], '0')
        self.assertEqual(opts['env']['GIT_OPTIONAL_LOCKS'], '0')
        self.assertNotIn('GIT_CONFIG_COUNT', opts['env'])
        self.assertFalse(opts.get('shell', False))

    def test_git_round_has_one_shared_timeout_budget(self):
        clock = [100.0]
        def slow(args, **kwargs):
            self.assertLessEqual(kwargs['timeout'], 120)
            clock[0] += 65
            return subprocess.CompletedProcess(args, 0, '', '')
        with patch.object(gitsafe.time, 'monotonic', side_effect=lambda:clock[0]), patch.object(gitsafe.subprocess, 'run', side_effect=slow) as started:
            with gitsafe.time_budget(120):
                gitsafe.run(self.root, 'read', 'status')
                gitsafe.run(self.root, 'read', 'status')
                with self.assertRaises(TimeoutError):
                    gitsafe.run(self.root, 'read', 'status')
            self.assertEqual(started.call_count, 2)

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
        with patch.object(gitsafe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as started:
            for args in denied:
                with self.subTest(args=args), self.assertRaises(gitsafe.GitDenied):
                    gitsafe.run(self.root, 'read', *args)
            self.assertEqual(started.call_count, 0)

    def test_review_P2_safe_directory_trusts_only_current_canonical_root(self):
        with patch.dict(os.environ, {'SSH_ASKPASS':'synthetic-untrusted-helper','GIT_SSH_COMMAND':'synthetic-untrusted-command'}), patch.object(gitsafe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as started:
            gitsafe.run(self.root, 'read', 'status')
        args, opts = started.call_args
        directories = [arg for arg in args[0] if arg.startswith('safe.directory=')]
        self.assertEqual(directories, ['safe.directory=' + str(self.root.resolve())])
        self.assertNotIn('GIT_SSH_COMMAND', opts['env']); self.assertNotIn('SSH_ASKPASS', opts['env'])
