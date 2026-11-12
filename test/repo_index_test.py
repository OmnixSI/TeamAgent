"""C1 R-* contract tests: synthetic Git repositories and a fake cloud only."""
import ast
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from runner import repo_index as index

REPO = 'OmnixSI/TeamAgent'


class RepoIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.h = self.home / '.inkboard-team'
        self.root = self.h / 'repos/TeamAgent'
        self.root.mkdir(parents=True)
        self.env = patch.dict(os.environ, {'HOME':str(self.home)})
        self.env.start(); self.addCleanup(self.env.stop)
        self.patches = [patch.object(index, 'H', self.h), patch.object(index, 'settings', return_value={'repositories':[REPO]})]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        (self.h / 'config.json').write_text(json.dumps({'url':'https://cloud.invalid','runnerToken':'synthetic-runner'}))
        index._fetch_at = {}; index._offset = 0; index._backlog = False
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Index Test'); self.git('config', 'user.email', 'index@example.invalid')
        self.git('remote', 'add', 'origin', 'https://github.com/' + REPO + '.git')
        self.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
        self.batches = []
        self.post = patch.object(index, '_post', side_effect=lambda body, config: self.batches.append(copy.deepcopy(body)) or 200)
        self.post.start(); self.addCleanup(self.post.stop)
        actual_run = index.gitsafe.run
        def local(root, cls, *args):
            return '' if cls == 'lifecycle' else actual_run(root, cls, *args)
        self.safe = patch.object(index.gitsafe, 'run', side_effect=local)
        self.safe.start(); self.addCleanup(self.safe.stop)

    def git(self, *args, root=None):
        return subprocess.run(['git', *args], cwd=root or self.root, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, text='data', filename='code.txt'):
        path = self.root / filename
        path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
        self.git('add', '--', filename); self.git('commit', '-qm', 'change ' + filename)
        sha = self.git('rev-parse', 'HEAD'); self.git('update-ref', 'refs/remotes/origin/main', sha)
        return sha

    def state(self):
        return json.loads((self.h / 'repo-index-state.json').read_text())

    def commits(self, batch=-1):
        return [c for r in self.batches[batch]['repos'] for c in r.get('commits', [])]

    def test_R1_R14_oldest_thirty_then_backlog_five_despite_same_fingerprint(self):
        shas = [self.commit(str(i)) for i in range(35)]
        index.sync_once(1000)
        self.assertEqual([c['sha'] for c in self.commits()], shas[:30])
        self.assertTrue(all(c['files'][0]['add'] is not None for c in self.commits()))
        self.assertEqual(self.state()[REPO]['frontier'], {})
        index.sync_once(1010)
        self.assertEqual([c['sha'] for c in self.commits()], shas[30:])
        self.assertEqual(self.state()[REPO]['frontier']['refs/remotes/origin/main'], shas[-1])
        self.assertEqual(self.state()[REPO]['acked'], [])
        self.assertEqual((self.h / 'repo-index-state.json').stat().st_mode & 0o777, 0o600)

    def test_R2_new_commits_after_ack_are_the_only_pending(self):
        self.commit('base'); index.sync_once(1000)
        later = [self.commit(str(i)) for i in range(2)]
        index.sync_once(1010)
        self.assertEqual([c['sha'] for c in self.commits()], later)

    def test_R3_missing_frontier_after_rewritten_history_is_not_a_boundary(self):
        sha = self.commit()
        result = index.pending_commits(self.root, {'frontier':{'refs/remotes/origin/main':'f'*40},'acked':[]})
        self.assertEqual(result, [sha])

    def test_R4_denied_files_keep_only_path_and_counts_never_patch(self):
        self.commit('base', 'README.txt')
        secrets = [('.env','ENV-PRIVATE-LINE'),('deploy/key.pem','PEM-PRIVATE-LINE'),('a/.npmrc','NPM-PRIVATE-LINE')]
        for path, text in secrets: self.commit(text, path)
        sha = self.commit('allowed-code', 'src/x.ts')
        self.git('reset', '--soft', 'HEAD~4'); self.git('commit', '-qm', 'four files')
        record = index.commit_record(self.root, self.git('rev-parse', 'HEAD'))
        paths = {f['path']:f for f in record['files']}
        self.assertEqual(len(paths), 4)
        for path, value in secrets:
            self.assertTrue(paths[path]['hidden']); self.assertNotIn(value, json.dumps(record))
        self.assertIn('allowed-code', record['patch'])

    def test_R5_pattern_values_are_redacted_from_the_entire_payload(self):
        values = ['ghp_'+'a'*36, 'sk-'+'b'*25, '-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----', 'SESSDATA=abc']
        self.commit('\n'.join(values)); index.sync_once(1000)
        body = json.dumps(self.batches[-1])
        for value in values: self.assertNotIn(value, body)
        self.assertIn('[REDACTED]', body)

    def test_review_known_values_are_literal_longest_first_and_not_recursive(self):
        values = ['fake.+cookie', 'fake.+cookie-long', '[REDACTED]', '', None]
        self.assertEqual(index.redact('fake.+cookie-long fake.+cookie keep', values),
                         '[REDACTED] [REDACTED] keep')

    def test_review_common_token_and_cookie_forms_are_redacted(self):
        samples = [
            'runnerToken = "synthetic-runner-value"',
            '"runner_token": "synthetic-runner-value"',
            "'access_token': 'synthetic-access-value'",
            'refreshToken=synthetic-refresh-value',
            'api_key: synthetic-api-value',
            'client_secret=synthetic-client-value',
            'Authorization: Bearer synthetic.bearer-value',
            'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.c3ludGhldGlj',
            'Cookie: custom_session=synthetic-cookie; other=synthetic-other',
            'Set-Cookie: session=synthetic-cookie; HttpOnly',
            '"cookie": "custom_session=synthetic-cookie; other=synthetic-other"',
            '"SESSDATA": "synthetic-cookie"',
            'auth_token = synthetic-cookie',
            'sessionid=synthetic-cookie',
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertEqual(index.redact(sample), '[REDACTED]')

    def test_review_redact_without_known_values_preserves_normal_code(self):
        text = 'const count = 42; // ordinary code'
        self.assertEqual(index.redact(text), text)
        self.assertEqual(index.redact(text, None), text)
        self.assertEqual(index.redact('SESSDATA=synthetic-cookie'), '[REDACTED]')

    def test_review_sync_redacts_config_token_and_supplied_cookie_before_cutting(self):
        token, cookie = 'synthetic-runner-long-value', 'opaque-cookie-fake.+value'
        (self.h / 'config.json').write_text(json.dumps({'url':'https://cloud.invalid','runnerToken':token}))
        self.git('config', 'user.name', token + ' ' + cookie)
        self.commit(token + ' ' + cookie + '\n' + 'a'*5000)
        self.git('commit', '--amend', '-qm', token + ' ' + cookie, '-m', cookie + ' ' + token)
        self.git('update-ref', 'refs/remotes/origin/main', self.git('rev-parse', 'HEAD'))
        read = Path.read_text
        def guarded(path, *args, **kwargs):
            self.assertNotIn(path.name, ('worker-secrets.json','bili-cookie.json','.env'))
            return read(path, *args, **kwargs)
        cut = index.cut_bytes
        def guarded_cut(text, size):
            self.assertNotIn(token, text); self.assertNotIn(cookie, text)
            return cut(text, size)
        with patch.object(Path, 'read_text', guarded), patch.object(index, 'cut_bytes', side_effect=guarded_cut):
            index.sync_once(1000, known_values=[cookie])
        payload = json.dumps(self.batches[-1])
        self.assertNotIn(token, payload); self.assertNotIn(cookie, payload)
        record = self.commits()[0]
        for field in ('author', 'subject', 'body', 'patch'):
            self.assertIn('[REDACTED]', record[field])
        self.assertNotIn('synthetic-run', record['patch'])

    def test_sync_redacts_all_config_secret_values_in_patch_and_commit_message(self):
        values = ['opaque-admin.+value', 'opaque-source-key', 'opaque-api-key-value',
                  'opaque-client-value', 'opaque-password-value', 'opaque-cookie-value', 'opaque-list-token']
        config = {'url':'https://cloud.invalid', 'runnerToken':'synthetic-runner',
                  'adminToken':values[0], 'sourceKey':values[1],
                  'service':{'api_key':values[2], 'clientSecret':values[3], 'password':values[4], 'cookie':values[5]},
                  'accounts':[{'access_token':values[6]}]}
        (self.h / 'config.json').write_text(json.dumps(config))
        text = ' '.join(values)
        self.commit(text)
        self.git('commit', '--amend', '-qm', text, '-m', text)
        self.git('update-ref', 'refs/remotes/origin/main', self.git('rev-parse', 'HEAD'))
        index.sync_once(1000)
        record = self.commits()[0]
        for field in ('patch', 'subject', 'body'):
            self.assertIn('[REDACTED]', record[field])
            for value in values:
                self.assertNotIn(value, record[field])
        for value in values:
            self.assertNotIn(value, json.dumps(self.batches[-1]))

    def test_config_secrets_require_exact_names_and_long_values(self):
        tokens = ['synthetic-admin-token-long', 'synthetic-runner-token-long', 'synthetic-source-key-long']
        config = {'adminToken':tokens[0], 'runnerToken':tokens[1], 'sourceKey':tokens[2],
                  'key':'a', 'hotkeys':{'save':'cmd+s', 'long':'ordinary-hotkey-description'},
                  'monkey':'ordinary-monkey-description', 'tokenizer':'ordinary-tokenizer-description',
                  'service':{'api_key':'short', 'password':'password', 'clientSecret':'commonword'}}
        self.assertEqual(set(index._config_secrets(config)), set(tokens))
        text = 'const on = true; a cmd+s password commonword short ordinary-hotkey-description ordinary-monkey-description ordinary-tokenizer-description'
        self.assertEqual(index.redact(text, index._config_secrets(config)), text)
        for value in tokens:
            self.assertEqual(index.redact(value, index._config_secrets(config)), '[REDACTED]')
        generic = {'token':'x'*20, 'secret':'y'*20, 'privateKey':'z'*20, 'credential':{'v':'w'*20}}
        self.assertEqual(set(index._config_secrets(generic)), {c*20 for c in 'xyzw'})
        self.assertEqual(list(index._config_secrets({'token':'short', 'tokenizer':'t'*20})), [])

    def test_R6_R16_chinese_patch_and_request_are_bounded_in_utf8_bytes(self):
        for i in range(4): self.commit('中'*11000, 'src/p'+str(i)+'.ts')
        record = index.commit_record(self.root, self.git('rev-parse', 'HEAD'))
        self.assertLessEqual(len(record['patch'].encode()), 12000); self.assertEqual(record['truncated'], 1)
        self.assertNotIn('\ufffd', record['patch'])
        index.sync_once(1000)
        self.assertLessEqual(len(json.dumps(self.batches[-1], ensure_ascii=False).encode()), 900000)
        for c in self.commits(): self.assertLessEqual(len(c['patch'].encode()), 12000)

    def test_R7_index_build_does_not_execute_malicious_git_helpers(self):
        self.commit('safe')
        marker = self.home / 'evil-ran'; script = self.home / 'evil.sh'
        script.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\n'); script.chmod(0o700)
        for key in ('core.fsmonitor','diff.external','diff.evil.textconv'): self.git('config', key, str(script))
        self.git('config', 'alias.log', '!'+str(script))
        (self.root / '.gitattributes').write_text('*.txt diff=evil\n')
        index.build(REPO, {}, 30); self.assertFalse(marker.exists())

    def worktree(self, name='w1', parent=None):
        target = (parent or self.h / 'work') / name
        target.parent.mkdir(parents=True, exist_ok=True)
        self.git('worktree', 'add', '--detach', str(target), 'HEAD')
        return target

    def test_R8_R17_worktree_counts_do_not_read_untracked_or_follow_symlink(self):
        self.commit('base\n'); work = self.worktree()
        (work / 'code.txt').write_text('base\nadded\n')
        (work / 'new.txt').write_text('DO-NOT-READ-NEW')
        target = self.home / 'private-key'; target.write_text('DO-NOT-READ-KEY')
        (work / 'link').symlink_to(target)
        state = index.worktrees([self.h / 'work'], REPO)[0]
        self.assertEqual(state['untracked'], 2)
        self.assertEqual(sum(f['add'] or 0 for f in state['files']), 1)
        self.assertTrue(all(f['add'] is None for f in state['files'] if f['status'] == '??'))
        encoded = json.dumps(state)
        for value in ('DO-NOT-READ-NEW','DO-NOT-READ-KEY',str(self.home)): self.assertNotIn(value, encoded)

    def test_R9_unchanged_sends_only_a_three_hundred_second_heartbeat(self):
        self.commit(); index.sync_once(1000); index.sync_once(1299)
        self.assertEqual(len(self.batches), 1)
        index.sync_once(1300)
        self.assertEqual(self.batches[-1]['repos'][0]['unchanged'], True)
        self.assertNotIn('commits', self.batches[-1]['repos'][0])

    def test_R10_failed_post_or_timeout_does_not_move_persisted_progress(self):
        self.commit(); index.sync_once(1000); before = (self.h / 'repo-index-state.json').read_bytes()
        later = self.commit('later')
        for response in (500, TimeoutError('synthetic timeout')):
            with self.subTest(response=str(response)):
                with patch.object(index, '_post', side_effect=response if isinstance(response, Exception) else None, return_value=response):
                    index.sync_once(1010)
                self.assertEqual((self.h / 'repo-index-state.json').read_bytes(), before)
        index.sync_once(1020); self.assertEqual([c['sha'] for c in self.commits()], [later])

    def test_review_fetch_failure_isolated_to_middle_repo_and_retried(self):
        self.commit('base')
        repos = [REPO, 'OmnixSI/Broken', 'OmnixSI/Healthy']
        roots = [self.root, self.h / 'repos/Broken', self.h / 'repos/Healthy']
        for repo, root in zip(repos[1:], roots[1:]):
            self.git('clone', '-q', str(self.root), str(root))
            self.git('remote', 'set-url', 'origin', 'https://github.com/' + repo + '.git', root=root)
            self.git('config', 'user.name', 'Index Test', root=root)
            self.git('config', 'user.email', 'index@example.invalid', root=root)
        local = index.gitsafe.run.side_effect
        with patch.object(index, 'settings', return_value={'repositories':repos}):
            index.sync_once(1000)
            before = self.state()
            pending = {}
            for repo, root in zip(repos, roots):
                with patch.object(self, 'root', root):
                    pending[repo] = self.commit('later for ' + repo)
            for failure in (index.gitsafe.GitFailed('private diagnostic'), TimeoutError('private diagnostic')):
                attempts = []
                def fetch(root, cls, *args):
                    if cls == 'lifecycle':
                        attempts.append(root)
                        if root == roots[1]:
                            raise failure
                    return local(root, cls, *args)
                index._offset = 0
                with self.subTest(failure=type(failure).__name__), patch.object(index.gitsafe, 'run', side_effect=fetch), patch('builtins.print') as log:
                    index.sync_once(1120)
                    self.assertEqual(self.state()[repos[1]], before[repos[1]])
                    self.assertNotIn(repos[1], [r['repo'] for r in self.batches[-1]['repos']])
                    for repo in (repos[0], repos[2]):
                        self.assertEqual(self.state()[repo]['frontier']['refs/remotes/origin/main'], pending[repo])
                    self.assertIn(roots[1], attempts)
                    self.assertEqual(index._fetch_at[repos[1]], 1000)
                    self.assertIn(type(failure).__name__, str(log.call_args_list))
                    self.assertNotIn('private diagnostic', str(log.call_args_list))
            index.sync_once(1130)
            self.assertEqual(index._fetch_at[repos[1]], 1130)
            self.assertEqual(self.state()[repos[1]]['frontier']['refs/remotes/origin/main'], pending[repos[1]])
            self.assertEqual([c['sha'] for c in self.commits()], [pending[repos[1]]])

    def test_review_filenames_with_spaces_preserve_complete_patch_and_paths(self):
        for filename in ('my file.txt', 'folder with spaces/my file.txt', '含 空格.txt'):
            with self.subTest(filename=filename):
                sha = self.commit('complete patch content\n', filename)
                record = index.commit_record(self.root, sha)
                raw = self.git('show', '--patch', '--format=', '--diff-merges=first-parent', sha)
                self.assertEqual(record['patch'].strip(), raw)
                self.assertEqual(record['files'][0]['path'], filename)
                self.assertIn('+complete patch content', record['patch'])
                self.assertEqual(record['truncated'], 0)

    def test_review_renamed_space_paths_preserve_denied_source_filtering(self):
        self.commit('private synthetic contents\n', 'private secret.txt')
        self.git('mv', 'private secret.txt', 'ordinary file.txt')
        self.git('commit', '-qm', 'rename private file')
        record = index.commit_record(self.root, self.git('rev-parse', 'HEAD'))
        self.assertEqual(record['files'][0]['path'], 'ordinary file.txt')
        self.assertEqual(record['files'][0]['status'], 'R')
        self.assertEqual(record['patch'], '')

    def test_R11_non_allowlisted_repo_remote_and_escaping_directories_are_skipped(self):
        self.commit(); roots = self.h / 'work'; good = self.worktree()
        other = roots / 'other'; other.mkdir()
        self.git('init', '-q', root=other)
        self.git('remote', 'add', 'origin', 'https://github.com/other/private.git', root=other)
        (roots / 'escape').symlink_to(self.home, target_is_directory=True)
        found = index.worktrees([roots], REPO)
        self.assertEqual([w['label'] for w in found], [good.name])
        with self.assertRaises(ValueError): index.build('other/private', {}, 30)

    def test_R12_disabled_index_never_invokes_git(self):
        (self.h / 'config.json').write_text('{"index":{"enabled":false}}')
        with patch.object(index.gitsafe, 'run') as git:
            index.loop(); git.assert_not_called()

    def test_R13_agent_and_team_branch_only_commits_are_indexed(self):
        base = self.commit(); st = {'frontier':index.tracked_refs(self.root)}
        self.git('checkout', '-qb', 'feature')
        extra = [self.commit('branch'+str(i)) for i in range(3)]
        self.git('update-ref', 'refs/remotes/origin/main', base)
        self.git('update-ref', 'refs/remotes/origin/agent/x', extra[-1])
        self.git('update-ref', 'refs/remotes/origin/team/x', extra[-1])
        result = index.build(REPO, st, 30)
        self.assertEqual([c['sha'] for c in result['commits']], extra)
        self.assertTrue(all(c['patch'] for c in result['commits']))
        self.assertEqual({b['name'] for b in result['branches']}, {'main','agent/x','team/x'})

    def test_R15_partial_ack_keeps_exact_backlog_until_cloud_accepts(self):
        shas = [self.commit(str(i)) for i in range(35)]
        index.sync_once(1000); first_state = self.state()
        with patch.object(index, '_post', return_value=500): index.sync_once(1010)
        self.assertEqual(self.state(), first_state)
        index.sync_once(1020)
        self.assertEqual([c['sha'] for c in self.commits()], shas[30:])
        self.assertEqual(self.state()[REPO]['acked'], [])

    def test_R16_byte_batching_leaves_excess_commits_pending(self):
        self.commit(); original = index.build(REPO, {}, 30)
        records = [{**original['commits'][0], 'sha':format(i,'040x'),'patch':'中'*4000} for i in range(1,31)]
        synthetic = {**original, 'commits':records, '_pending':[c['sha'] for c in records], 'pending_left':0}
        with patch.object(index, 'build', return_value=synthetic), patch.object(index, 'MAX_BODY', 50000):
            index.sync_once(1000)
        self.assertGreater(len(self.commits()), 0); self.assertLess(len(self.commits()), 30)
        self.assertLessEqual(len(json.dumps(self.batches[-1],ensure_ascii=False).encode()), 50000)
        self.assertEqual(self.state()[REPO]['frontier'], {})

    def test_R18_index_thread_never_blocks_bridge_lease_tick(self):
        source = Path(__file__).parents[1] / 'runner/bridge.py'
        tree = ast.parse(source.read_text()); block = next(n for n in tree.body if isinstance(n, ast.If) and '__main__' in ast.unparse(n.test))
        started = threading.Event(); release = threading.Event(); ticks = []
        class Done(Exception): pass
        def slow(): started.set(); release.wait(2)
        def tick(): self.assertTrue(started.wait(1)); ticks.append(len(ticks)*15)
        def sleep(seconds):
            if len(ticks) == 3: raise Done()
        namespace = {'threading':threading,'sync_loop':lambda:None,'repo_index':types.SimpleNamespace(loop=slow),'tick':tick,'time':types.SimpleNamespace(sleep=sleep),'urllib':__import__('urllib'),'CURRENT':self.h/'current.json'}
        try:
            with self.assertRaises(Done): exec(compile(ast.Module(body=block.body,type_ignores=[]),str(source),'exec'), namespace)
            self.assertEqual(ticks, [0,15,30])
        finally: release.set()

    def test_R19_cut_bytes_preserves_unicode_boundaries(self):
        for text in ('a'+'中'*5000, '😀'*4000, 'a'*16000):
            for n in (12000,11999,11998):
                result = index.cut_bytes(text,n)
                self.assertLessEqual(len(result.encode()),n); self.assertTrue(text.startswith(result)); self.assertNotIn('\ufffd',result)
                if len(text.encode()[:n].decode('utf-8',errors='ignore').encode()) == n: self.assertEqual(len(result.encode()), n)

    def test_review_P2_missing_origin_head_falls_back_and_acknowledges_main_or_master(self):
        sha = self.commit()
        self.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
        for branch in ('main', 'master'):
            with self.subTest(branch=branch):
                if branch == 'master':
                    self.git('update-ref', 'refs/remotes/origin/master', sha)
                    self.git('update-ref', '-d', 'refs/remotes/origin/main')
                self.assertEqual(index._default_ref(self.root), 'refs/remotes/origin/' + branch)
                index.sync_once(1000 if branch == 'main' else 1400)
                self.assertEqual(self.batches[-1]['repos'][0]['head']['sha'], sha)
                self.assertEqual(self.state()[REPO]['frontier'], {'refs/remotes/origin/' + branch:sha})

    def test_review_P2_index_redacts_patterns_without_opening_secret_files_or_environment_keys(self):
        self.commit('sk-' + 'q'*25 + '\nSESSDATA=synthetic\n')
        read = Path.read_text
        def guarded(path, *args, **kwargs):
            self.assertNotIn(path.name, ('worker-secrets.json','bili-cookie.json','.env'))
            return read(path, *args, **kwargs)
        with patch.object(Path, 'read_text', guarded), patch.object(index.os.environ, 'get', side_effect=AssertionError('index must not inspect credential environment values')):
            index.sync_once(1000)
        payload = json.dumps(self.batches[-1])
        self.assertNotIn('q'*25, payload); self.assertNotIn('SESSDATA=synthetic', payload)
        self.assertIn('[REDACTED]', payload)

    def test_review_P2_denied_workspace_paths_are_metadata_only_as_K2_allows(self):
        self.commit('ordinary code\n')
        work = self.worktree()
        (work / '.env').write_text('SYNTHETIC-DENIED-CONTENT')
        result = index.build(REPO, {}, 30)
        entry = next(f for f in result['worktrees'][0]['files'] if f['path'] == '.env')
        self.assertTrue(entry['hidden']); self.assertIsNone(entry['add'])
        self.assertNotIn('SYNTHETIC-DENIED-CONTENT', json.dumps(result))
