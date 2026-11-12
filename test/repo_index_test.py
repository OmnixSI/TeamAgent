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
        self.env = patch.dict(os.environ, {'HOME':str(self.home), 'DEEPSEEK_API_KEY':'synthetic-known-key'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.patches = [patch.object(index, 'H', self.h), patch.object(index, 'settings', return_value={'repositories':[REPO]})]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        (self.h / 'config.json').write_text(json.dumps({'url':'https://cloud.invalid','runnerToken':'synthetic-runner'}))
        index._fetch_at = {}; index._offset = 0; index._known = None; index._backlog = False
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

    def test_R5_regular_and_known_values_are_redacted_from_the_entire_payload(self):
        values = ['ghp_'+'a'*36, 'sk-'+'b'*25, '-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----', 'SESSDATA=abc', 'synthetic-known-key', 'synthetic-runner']
        self.commit('\n'.join(values)); index.sync_once(1000)
        body = json.dumps(self.batches[-1])
        for value in values: self.assertNotIn(value, body)
        self.assertIn('[REDACTED]', body)

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
