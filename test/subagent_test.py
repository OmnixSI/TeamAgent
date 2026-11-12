"""C3 local contracts. All repositories, credentials and processes are synthetic."""
import json
import concurrent.futures
import os
from pathlib import Path
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch

from runner import subagent as s
from runner import reload_runtime as reload


def envelope(body, footnote="(End of file - total 2 lines)"):
    return f"<path>/w/x.txt</path>\n<type>file</type>\n<content>\n{body}\n\n{footnote}\n</content>"


def read_events(path="README.md", result=None, status="completed"):
    return [{"type": "tool_call", "callId": "r", "tool": "read", "input": {"file_path": path}},
            {"type": "tool_result", "callId": "r", "status": status,
             "result": envelope("1: # Title\n2: ") if result is None else result}]


class LocalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="c3-test-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.h = self.home / ".inkboard-team"
        self.sub = self.h / "sub/x"
        self.sub.mkdir(parents=True)
        self.addCleanup(patch.stopall)
        patch.object(s, "H", self.h).start()
        patch.object(Path, "home", return_value=self.home).start()
        patch.dict(os.environ, {"TMPDIR": str(self.home), "DEEPSEEK_API_KEY": "synthetic-api-key"}).start()

    def synthetic_roots(self, home=None):
        home=self.home/'isolated-home' if home is None else home
        roots={'real_home':self.home,
               'read':[self.home/'.openmausbot/tools/npm',self.home/'.nvm/versions/node/test',self.sub,
                       self.h/'repos/Test/.git',home],
               'reader':self.h/'dsh-reader.yml'}
        for path in roots['read']:path.mkdir(parents=True,exist_ok=True)
        s.reader_profile()
        return roots

    def require_native_sandbox(self):
        r=subprocess.run(['sandbox-exec','-p','(version 1)(allow default)','/usr/bin/true'],capture_output=True)
        if r.returncode:self.skipTest('nested sandbox')

    def test_S26_native_envelopes_and_blocks_count_only_numbered_body(self):
        cases = [(envelope("", "(End of file - total 0 lines)"), 0),
                 (envelope("1:   \n2: \t\n3: \u3000"), 0),
                 ("1:\n2:\n3:", 0), ("     1→\n     2→", 0),
                 (envelope("1: # Title\n2: "), 6),
                 (envelope("1: # Title\n2: ", "(Showing lines 1-2 of 50. Use offset=3 to continue.)"), 6),
                 ("hello world", 0), (envelope("1: \ufeff\u200b\u200c\u200d\u2060"), 0)]
        cases += [([{"type": "text", "text": cases[4][0]}], 6),
                  ([{"type": "text", "text": cases[0][0]}], 0),
                  ({"content": [{"text": cases[4][0]}]}, 6)]
        for result, count in cases:
            with self.subTest(result=result):
                self.assertEqual(s.body_chars(result), count)
                self.assertEqual(s.read_evidence(read_events(result=result), self.sub), ["README.md"] if count else [])
                r = s.classify_events({}, self.sub, "a"*40,
                    read_events(result=result) + [{"type":"final","reason":{"kind":"completed"},"text":"模型结论"}], 0)
                self.assertEqual(r["status"], "done" if count else "failed")
                if not count:
                    self.assertEqual((r["error_kind"], r["answer"]), ("not_found", ""))

    def test_S13_read_errors_context_escape_and_empty_are_not_evidence(self):
        (self.home / "outside").write_text("synthetic")
        (self.sub / "link").symlink_to(self.home / "outside")
        for events in [[], read_events(status="error"), read_events(".teamagent-context.md"),
                       read_events("../../etc/hosts"), read_events("link"), read_events(result=envelope(""))]:
            with self.subTest(events=events):
                self.assertEqual(s.read_evidence(events, self.sub), [])

    def test_review_tilde_reads_must_not_be_worktree_evidence(self):
        with patch.dict(os.environ,{'HOME':str(self.home)}):
            (self.home/'x.txt').write_text('outside')
            for path in ['~/x.txt','~/.inkboard-team/config.json']:
                with self.subTest(path=path):
                    self.assertEqual(s.read_evidence(read_events(path),self.sub),[])
                    result=s.classify_events({},self.sub,'a'*40,read_events(path)+[
                        {'type':'final','reason':{'kind':'completed'},'text':'不可转发的结论'}],0)
                    self.assertEqual((result['error_kind'],result['answer']),('not_found',''))

    def test_S19_empty_search_completed_is_failed_with_tried(self):
        events = [{"type":"tool_call","tool":"glob","callId":"g","input":{}},
                  {"type":"tool_result","callId":"g","status":"completed","result":"No files found"},
                  {"type":"final","reason":{"kind":"completed"},"text":"编造的结论"}]
        r = s.classify_events({}, self.sub, "a"*40, events, 0)
        self.assertEqual((r["status"],r["error_kind"],r["answer"],r["read"]), ("failed","not_found","",[]))
        self.assertIn("搜索了 1 次", r["tried"])

    def test_upstream_failures_never_return_model_answer(self):
        for final, code in [([], 1), ([], 0), ([{"type":"final","reason":{"kind":"limit"},"text":"bad"}],0),
                            (read_events()+[{"type":"final","reason":{"kind":"completed"},"text":"  "}],0)]:
            r = s.classify_events({}, self.sub, "a"*40, final, code)
            self.assertEqual((r["error_kind"],r["answer"]), ("upstream",""))

    def test_S12_profile_exact_tools_and_private_mode(self):
        p = s.reader_profile()
        # Explicit fixture avoids a developer-machine path dependency in CI.
        expected = Path(__file__).parent / 'fixtures/dsh-reader.yml'
        self.assertEqual(p.read_text(), expected.read_text())
        self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)

    def test_review_concurrent_profiles_publish_complete_private_files(self):
        shared=s.reader_profile()
        original=s.write_private
        barrier=threading.Barrier(2)
        targets=[]
        def write(path,text):
            targets.append(path)
            self.assertEqual(shared.read_text(),s.READER_PROFILE)
            barrier.wait(timeout=3)
            return original(path,text)
        with patch.object(s,'write_private',side_effect=write),concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=[pool.submit(s.reader_profile) for _ in range(2)]
            self.assertEqual([f.result(timeout=5) for f in results],[shared,shared])
        self.assertEqual(len(set(targets)),2)
        self.assertNotIn(shared,targets)
        self.assertEqual(shared.read_text(),s.READER_PROFILE)
        self.assertEqual(shared.stat().st_mode & 0o777,0o600)
        self.assertTrue(all(not p.exists() for p in targets))

    def test_S25_marker_atomic_two_phases_and_permissions(self):
        marker = self.h / "sub/x.running"
        m = {"id":"x","lease":"l","pid":None,"pgid":None,"lstart":None,"started_at":time.time()}
        s.write_marker(marker,m)
        self.assertIsNone(json.loads(marker.read_text())["pid"])
        self.assertEqual(marker.stat().st_mode & 0o777,0o600)
        s.write_marker(marker,dict(m,pid=123,pgid=123,lstart="synthetic-start"))
        self.assertEqual(json.loads(marker.read_text())["pid"],123)
        self.assertEqual(list(marker.parent.glob('*.tmp')),[])

    def test_S20_null_pid_never_probes_or_signals_and_still_reports(self):
        s.write_marker(self.h/'sub/x.running',{"id":"x","lease":"l","pid":None})
        with patch.object(s.subprocess,'run') as ps, patch.object(s.os,'killpg') as kill, \
             patch.object(s,'cleanup') as clean, patch.object(s,'report') as report, patch.object(s,'prune'):
            s.recover_orphans()
        ps.assert_not_called(); kill.assert_not_called(); clean.assert_called_once_with(self.sub)
        report.assert_called_once_with('x','l',{'status':'failed','error_kind':'runner_offline','answer':''})
        self.assertFalse((self.h/'sub/x.running').exists())

    def test_S21_ps_identity_mismatch_and_bad_json_do_not_kill(self):
        for lstart, output in [('start','start sleep 300'),('wrong','start dsh-reader.yml')]:
            s.write_marker(self.h/'sub/x.running',{'id':'x','lease':'l','pid':123,'pgid':123,'lstart':lstart})
            with patch.object(s.subprocess,'run',return_value=subprocess.CompletedProcess([],0,output,'')), \
                 patch.object(s.os,'killpg') as kill, patch.object(s,'cleanup'), patch.object(s,'report'), patch.object(s,'prune'):
                s.recover_orphans()
                kill.assert_not_called()
        (self.h/'sub/bad.running').write_text('{')
        s.write_marker(self.h/'sub/x.running',{'id':'x','lease':'l','pid':None})
        with patch.object(s,'cleanup') as clean, patch.object(s,'report') as report, patch.object(s,'prune'):
            s.recover_orphans()
        self.assertEqual(clean.call_count,2);self.assertEqual(report.call_count,1)

    def test_orphan_cleanup_error_does_not_stop_later_markers(self):
        for id in ['first','second']:
            s.write_marker(self.h/f'sub/{id}.running',{'id':id,'lease':'l','pid':None})
        with patch.object(s,'cleanup',side_effect=[OSError(),None]),patch.object(s,'report') as report,patch.object(s,'prune'):
            s.recover_orphans()
        self.assertEqual(report.call_count,2)
        self.assertEqual(list((self.h/'sub').glob('*.running')),[])

    def test_S16_matching_real_process_group_is_reclaimed(self):
        proc = subprocess.Popen(['/bin/sh','-c','sleep 300 & wait','dsh-reader.yml'],start_new_session=True)
        self.addCleanup(lambda: proc.poll() is None and os.killpg(proc.pid,signal.SIGKILL))
        lstart = subprocess.run(['ps','-o','lstart=','-p',str(proc.pid)],text=True,capture_output=True).stdout.strip()
        s.write_marker(self.h/'sub/x.running',{'id':'x','lease':'l','pid':proc.pid,'pgid':proc.pid,'lstart':lstart})
        with patch.object(s,'cleanup'), patch.object(s,'report'), patch.object(s,'prune'):
            s.recover_orphans()
        proc.wait(timeout=3)
        self.assertEqual(proc.returncode,-signal.SIGKILL)

    def test_report_409_is_fenced_and_network_retry_uses_same_lease(self):
        conflict=urllib.error.HTTPError('https://test.invalid',409,'conflict',{},None)
        with patch.object(s,'post',side_effect=conflict) as post, patch.object(s.time,'sleep'):
            self.assertFalse(s.report('x','l',{'status':'done'})); self.assertEqual(post.call_count,1)
        with patch.object(s,'post',side_effect=[OSError(),OSError(),{}]) as post, patch.object(s.time,'sleep'):
            self.assertTrue(s.report('x','l',{'status':'done'}))
            self.assertEqual(post.call_count,3)
            self.assertTrue(all(c.args[1]['lease']=='l' for c in post.call_args_list))
        with patch.object(s,'post',side_effect=OSError()) as post,patch.object(s.time,'sleep') as sleep:
            self.assertFalse(s.report('x','l',{'status':'done'}))
            self.assertEqual((post.call_count,sleep.call_count),(4,3))

    def test_local_protocol_auth_and_empty_success_ack(self):
        (self.h/'config.json').write_text('{"url":"https://test.invalid","runnerToken":"synthetic-runner-token"}')
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return b''
        with patch.object(s.urllib.request,'urlopen',return_value=Response()) as cloud:
            self.assertEqual(s.post('heartbeat',{'id':'x','lease':'l'}),{})
        req=cloud.call_args.args[0]
        self.assertEqual(req.full_url,'https://test.invalid/api/runner/subagent/heartbeat')
        self.assertEqual(json.loads(req.data),{'id':'x','lease':'l'})
        self.assertEqual(req.get_header('Authorization'),'Bearer synthetic-runner-token')
        self.assertEqual(s.scrub('synthetic-runner-token'),'[REDACTED]')

    def test_S17_timeout_is_derived_from_absolute_deadline(self):
        for seconds, expected in [(400,300),(60,45),(40,25)]:
            self.assertEqual(s.run_timeout({'deadline':(100+seconds)*1000},now=100),expected)

    def test_source_message_id_is_a_single_filename_not_a_new_protocol_whitelist(self):
        self.assertEqual(s.private_sub('sub-msg:1-h8').name,'sub-msg:1-h8')
        for id in ['../x','x/y','', '.', '..']:
            with self.assertRaises(s.RunError):s.private_sub(id)

    def test_S18_paused_claim_and_S11_disabled_loop(self):
        with patch.object(s,'post',return_value={'task':None,'job':None}):self.assertIsNone(s.claim())
        with patch.object(s,'local_config',return_value={'subagent':{'enabled':False}}), patch.object(s,'claim') as claim:
            s.loop();claim.assert_not_called()

    def test_S5_scrub_known_and_pattern_secrets(self):
        self.assertEqual(s.scrub('synthetic-api-key ghp_'+'a'*36),'[REDACTED] [REDACTED]')
        self.assertEqual(len(s.scrub('a'*4000)),3500)

    def test_S22_marker_age_boundary_in_both_modules(self):
        patch.object(reload,'H',self.h).start()
        marker=self.h/'sub/x.running';marker.write_text('{}')
        now=time.time()
        for age,expected in [(1000,False),(600,True),(900,False)]:
            os.utime(marker,(now-age,now-age))
            with patch.object(time,'time',return_value=now):
                self.assertEqual(bool(s.live_markers()),expected)
                self.assertEqual(bool(reload.live_markers()),expected)

    def test_review_marker_disappearing_between_glob_and_stat_is_ignored(self):
        patch.object(reload,'H',self.h).start()
        live=self.h/'sub/live.running';live.write_text('{}')
        gone=self.h/'sub/gone.running'
        original=Path.stat
        def stat(path,*args,**kwargs):
            if path==gone:gone.unlink(missing_ok=True)
            return original(path,*args,**kwargs)
        for module in [s,reload]:
            gone.write_text('{}')
            with self.subTest(module=module.__name__),patch.object(Path,'stat',stat):
                self.assertEqual(module.live_markers(),[live])

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_review_maus_top_level_files_and_other_credential_stores_are_denied(self):
        paths=[self.home/'.openmausbot'/name for name in
               ['bots.json','bot-api.json','browser-engine-key','config.json','future-private.json','workspaces/probe','tools/private-key']]
        paths += [self.home/'.dsh/.credentials.yaml',self.h/'qq-session.json']
        for path in paths:path.parent.mkdir(parents=True,exist_ok=True);path.write_text('synthetic-deny')
        allowed=self.home/'.openmausbot/tools/npm/probe';allowed.parent.mkdir(parents=True);allowed.write_text('allowed')
        sb=s.sandbox_profile(self.sub,self.home/'isolated-home',self.synthetic_roots())
        try:
            for path in paths:
                with self.subTest(path=path):
                    r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(path)],capture_output=True)
                    self.assertNotEqual(r.returncode,0,r.stderr);self.assertNotIn(b'synthetic-deny',r.stdout)
            r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(allowed)],capture_output=True)
            self.assertEqual((r.returncode,r.stdout),(0,b'allowed'),r.stderr)
        finally:sb.unlink()

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_review_legitimate_code_names_readable_sensitive_paths_still_denied(self):
        good=[self.sub/name for name in ['src/prefix-sum.ts','box-shadow.css','bilingual.md']]
        bad=[self.h/name for name in ['bili-cookie.json','bili.cookies.json','x-auth/token','x-browser/auth','browser/x/Default/Cookies','secrets/bili-cookie.json']]
        for path in good+bad:path.parent.mkdir(parents=True,exist_ok=True);path.write_text('synthetic-content')
        sb=s.sandbox_profile(self.sub,self.home/'isolated-home',self.synthetic_roots())
        try:
            for path in good+bad:
                with self.subTest(path=path):
                    r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(path)],capture_output=True)
                    self.assertEqual(r.returncode==0,path in good,r.stderr)
        finally:sb.unlink()

    def fake_dsh(self, events=None, sleep=0):
        exe=self.home/'fake-install/fake-dsh'
        exe.parent.mkdir(exist_ok=True)
        events = read_events()+[{'type':'final','reason':{'kind':'completed'},'text':'README.md:1 已核实'}] if events is None else events
        exe.write_text('#!'+sys.executable+'\nimport json,sys,time,os\nsys.stdin.read()\n'
            + f'time.sleep({sleep})\n'
            + 'print('+repr('\n'.join(json.dumps(e) for e in events))+',flush=True)\n')
        exe.chmod(0o700)
        patch.dict(os.environ,{'TEAM_AGENT_DSH':str(exe),'GITHUB_TOKEN':'must-not-leak','GH_TOKEN':'must-not-leak','runnerToken':'must-not-leak'}).start()
        self.run={'id':'x','lease':'l','deadline':(time.time()+400)*1000,'resolved_sha':'a'*40,'question':''}
        root=self.h/'repos/Test';(root/'.git').mkdir(parents=True,exist_ok=True)
        patch.dict(s._roots,{str(self.sub):root}).start()
        patch.object(s,'repo_git_clean',return_value=True).start()

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S3_S4_real_sandbox_blocks_synthetic_secrets_and_external_writes(self):
        files=[self.h/'worker-secrets.json',self.h/'dsh-team.yml',self.h/'config.json',self.h/'x-browser/auth',
               self.h/'bili.cookies.json',self.home/'.ssh/id_rsa',self.home/'.config/gh/hosts.yml',
               self.home/'.aws/credentials',self.home/'.codex/auth.json',self.home/'.claude/credentials.json',
               self.home/'Library/Keychains/synthetic',self.home/'.openmausbot/workspaces/x']
        for p in files:p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic-deny')
        allowed=self.home/'.openmausbot/tools/npm/probe';allowed.parent.mkdir(parents=True);allowed.write_text('allowed')
        temp_home=self.home/'isolated-home';temp_home.mkdir(mode=0o700)
        # TMPDIR must not include the synthetic home, otherwise the plan explicitly permits writes there.
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'TMPDIR':tmp}):
            sb=s.sandbox_profile(self.sub,temp_home,self.synthetic_roots(temp_home))
            try:
                for p in files:
                    r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(p)],capture_output=True)
                    self.assertNotEqual(r.returncode,0,p);self.assertNotIn(b'synthetic-deny',r.stdout)
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(allowed)],capture_output=True)
                self.assertEqual((r.returncode,r.stdout),(0,b'allowed'),r.stderr)
                for p,ok in [(self.h/'repos/x/README',False),(self.home/'a',False),(self.sub/'a',True),(temp_home/'a',True)]:
                    p.parent.mkdir(parents=True,exist_ok=True)
                    r=subprocess.run(['sandbox-exec','-f',str(sb),'/usr/bin/touch',str(p)],capture_output=True)
                    self.assertEqual(r.returncode==0,ok,r.stderr)
            finally:sb.unlink()

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S3_v15_home_content_denied_six_roots_readable_metadata_allowed(self):
        self.require_native_sandbox()
        private=[self.home/'.openmausbot'/name for name in ['bots.json','bot-api.json','browser-engine-key','config.json','other/x']]
        private += [self.home/'.dsh/.credentials.yaml',self.home/'.ssh/id_rsa',self.home/'Documents/a.txt']
        private += [self.h/name for name in ['qq-session.json','worker-secrets.json','config.json','dsh-team.yml']]
        for path in private:path.parent.mkdir(parents=True,exist_ok=True);path.write_text('must-not-read')
        roots=self.synthetic_roots()
        allowed=[]
        for directory in roots['read']:
            p=directory/'probe';p.write_text('allowed');allowed.append(p)
        for directory in [roots['read'][0],roots['read'][2]]:
            p=directory/'deep/probe';p.parent.mkdir();p.write_text('deep-allowed');allowed.append(p)
        allowed.append(roots['reader'])
        expected={p:p.read_bytes() for p in allowed}
        sb=s.sandbox_profile(self.sub,roots['read'][-1],roots)
        try:
            for p in private:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(p)],capture_output=True)
                self.assertNotEqual(r.returncode,0,p);self.assertEqual(r.stdout,b'')
            for p in allowed:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(p)],capture_output=True)
                self.assertEqual((r.returncode,r.stdout),(0,expected[p]),r.stderr)
            for p in [self.home/'.openmausbot',self.home/'.openmausbot/tools',self.h,self.home/'.openmausbot/bots.json']:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/usr/bin/stat','-f','%p',str(p)],capture_output=True)
                self.assertEqual(r.returncode,0,r.stderr)
            for p in [self.home/'.openmausbot',self.h,self.home]:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/ls',str(p)],capture_output=True)
                self.assertNotEqual(r.returncode,0,p)
            for p in [roots['read'][0],roots['read'][2]]:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/ls',str(p)],capture_output=True)
                self.assertEqual(r.returncode,0,r.stderr)
            r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(roots['read'][2]/'../../config.json')],capture_output=True)
            self.assertNotEqual(r.returncode,0);self.assertEqual(r.stdout,b'')
        finally:sb.unlink()

    def test_S27_exact_read_root_rules_and_no_regex(self):
        roots=self.synthetic_roots();home=roots['read'][-1]
        for directories in [roots['read'],[p for p in roots['read'] if p!=roots['read'][1]]]:
            actual=dict(roots,read=directories)
            sb=s.sandbox_profile(self.sub,home,actual)
            try:
                lines=['(version 1)','(allow default)','(deny file-read-data','  (require-all',f'    (subpath {json.dumps(str(self.home))})']
                lines += [f'    (require-not (subpath {json.dumps(str(p.resolve()))}))' for p in directories]
                lines += [f'    (require-not (literal {json.dumps(str(roots["reader"].resolve()))}))))',
                          '(deny file-write* (subpath "/"))',
                          '(allow file-write* (literal "/dev/null"))',
                          f'(allow file-write* (subpath {json.dumps(str(self.sub))}) (subpath {json.dumps(str(self.home))}) (subpath {json.dumps(str(home))}))',
                          '(deny network-outbound)','(allow network-outbound (remote tcp "*:443"))',
                          '(allow network-outbound (literal "/private/var/run/mDNSResponder"))']
                self.assertEqual(sb.read_text(),'\n'.join(lines)+'\n')
                self.assertNotIn('regex',sb.read_text())
                self.assertNotIn('allow file-read*',sb.read_text())
            finally:sb.unlink()

    def test_S28_unsafe_read_roots_rejected_before_process_start(self):
        self.fake_dsh()
        roots=self.synthetic_roots()
        for index,path in [(0,self.home),(0,self.home.parent),(0,self.home/'.openmausbot'),(0,self.h),(1,self.h),
                           (0,self.home/'.config')]:
            with self.subTest(index=index,path=path):
                bad=dict(roots,read=list(roots['read']));bad['read'][index]=path
                with self.assertRaises(s.SandboxUnsafe):s.sandbox_profile(self.sub,roots['read'][-1],bad)
                with patch.object(s,'sandbox_roots',return_value=bad),patch.object(s.subprocess,'Popen') as launch:
                    result=s.execute(self.run,self.sub)
                self.assertEqual(result['error_kind'],'runner_unsupported');launch.assert_not_called()
        literal=dict(roots,reader=self.h/'config.json')
        with self.assertRaises(s.SandboxUnsafe):s.sandbox_profile(self.sub,roots['read'][-1],literal)

    def test_S28_special_path_characters_rejected_and_symlink_roots_resolved(self):
        roots=self.synthetic_roots();self.fake_dsh()
        for char in ['"','\\','\n','\0']:
            bad=dict(roots,read=list(roots['read']));bad['read'][2]=self.home/('invalid'+char+'path')
            with self.subTest(char=repr(char)):
                with self.assertRaises(s.SandboxUnsafe):s.sandbox_profile(self.sub,roots['read'][-1],bad)
                with patch.object(s,'sandbox_roots',return_value=bad),patch.object(s.subprocess,'Popen') as launch:
                    result=s.execute(self.run,self.sub)
                self.assertEqual(result['error_kind'],'runner_unsupported');launch.assert_not_called()
                with patch.dict(os.environ,{'TMPDIR':str(self.home/('invalid'+char+'tmp'))}) if char!='\0' else self.subTest('nul checked through roots'):
                    if char!='\0':
                        with self.assertRaises(s.SandboxUnsafe):s.sandbox_profile(self.sub,roots['read'][-1],roots)
        link=self.home/'sub-link';link.symlink_to(self.sub,target_is_directory=True)
        good=dict(roots,read=list(roots['read']));good['read'][2]=link
        sb=s.sandbox_profile(link,roots['read'][-1],good)
        try:
            self.assertIn(str(self.sub),sb.read_text());self.assertNotIn(str(link),sb.read_text())
        finally:sb.unlink()

    def test_S29_install_prefix_resolves_symlink_and_fallback(self):
        prefix=self.home/'install';script=prefix/'lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
        script.parent.mkdir(parents=True);script.write_text('synthetic')
        link=prefix/'bin/dsh';link.parent.mkdir();link.symlink_to(script)
        self.assertEqual(s.install_root(link),prefix)
        self.assertEqual(s.install_root(self.home/'other/fake-dsh'),self.home/'other')

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S30_symlink_outside_read_roots_is_denied(self):
        self.require_native_sandbox()
        roots=self.synthetic_roots();outside=self.home/'.openmausbot/bots.json';outside.parent.mkdir(exist_ok=True)
        outside.write_text('must-not-read');(self.sub/'link.txt').symlink_to(outside)
        (self.sub/'ok.txt').write_text('allowed')
        sb=s.sandbox_profile(self.sub,roots['read'][-1],roots)
        try:
            for name,ok in [('link.txt',False),('ok.txt',True)]:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(self.sub/name)],capture_output=True)
                self.assertEqual(r.returncode==0,ok,r.stderr)
                self.assertNotIn(b'must-not-read',r.stdout)
        finally:sb.unlink()

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S31_selected_W1_semantic_matrix_and_var_realpath(self):
        self.require_native_sandbox()
        t=self.home;allowed=t/'allowed';(allowed/'deep').mkdir(parents=True)
        files={allowed/'ok.txt':'OK-'+secrets.token_hex(8),allowed/'deep/n.txt':'N-'+secrets.token_hex(8),
               t/'conf.yml':'CONF-'+secrets.token_hex(8),t/'secret.txt':'SECRET-'+secrets.token_hex(8),t/'conf.yml.bak':'BACKUP'}
        for path,text in files.items():path.write_text(text)
        (allowed/'link.txt').symlink_to(t/'secret.txt')
        subprocess.run(['/usr/bin/xattr','-w','x.k','v',str(t/'secret.txt')],check=True)
        # Exercise sandbox_roots with /var aliases, rather than just testing already canonical paths.
        alias=Path(str(t).replace('/private/var/','/var/',1))
        fake_dsh=allowed/'dsh';fake_dsh.write_text('synthetic');fake_dsh.chmod(0o700)
        repo=t/'repo';(repo/'.git').mkdir(parents=True)
        temporary=alias/'temp-home';temporary.mkdir()
        host_tmp=tempfile.TemporaryDirectory(prefix='c3-write-probe-',dir=t.parent)
        self.addCleanup(host_tmp.cleanup)
        with patch.object(s,'dsh_program',return_value=str(alias/'allowed/dsh')), \
             patch.object(s,'reader_profile',return_value=alias/'conf.yml'), \
             patch.object(Path,'home',return_value=alias),patch.dict(s._roots,{str(alias/'allowed'):repo}), \
             patch.dict(os.environ,{'TMPDIR':host_tmp.name}):
            roots=s.sandbox_roots(alias/'allowed',temporary,{'PATH':os.environ['PATH']})
            sb=s.sandbox_profile(alias/'allowed',temporary,roots)
        try:
            self.assertEqual(roots['real_home'],t)
            self.assertNotIn('"'+str(alias)+'/',sb.read_text())
            for path in [allowed/'ok.txt',allowed/'deep/n.txt',t/'conf.yml']:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(path)],capture_output=True,text=True)
                self.assertEqual((r.returncode,r.stdout),(0,files[path]),r.stderr)
            for path in [t/'secret.txt',t/'conf.yml.bak',allowed/'../secret.txt',allowed/'link.txt']:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/cat',str(path)],capture_output=True)
                self.assertNotEqual(r.returncode,0);self.assertEqual(r.stdout,b'')
            for path in [t,t/'secret.txt',allowed]:
                self.assertEqual(subprocess.run(['sandbox-exec','-f',str(sb),'/usr/bin/stat','-f','%z',str(path)],capture_output=True).returncode,0)
            self.assertNotEqual(subprocess.run(['sandbox-exec','-f',str(sb),'/bin/ls',str(t)],capture_output=True).returncode,0)
            r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/ls',str(allowed)],capture_output=True,text=True)
            self.assertEqual(r.returncode,0);self.assertIn('ok.txt',r.stdout)
            # m6 is diagnostic only for W1: preserve its result without constraining it.
            subprocess.run(['sandbox-exec','-f',str(sb),'/usr/bin/xattr','-p','x.k',str(t/'secret.txt')],capture_output=True)
            self.assertEqual(subprocess.run(['sandbox-exec','-f',str(sb),'/bin/echo','ok'],capture_output=True).returncode,0)
            # /dev/null is a write-only device exception, independent of the read roots.
            r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/sh','-c','cat "$1" > /dev/null','probe',str(allowed/'ok.txt')],capture_output=True)
            self.assertEqual(r.returncode,0,r.stderr)
            for path in [t/'blocked-new.txt',t/'secret.txt']:
                r=subprocess.run(['sandbox-exec','-f',str(sb),'/bin/sh','-c','printf overwritten > "$1"','probe',str(path)],capture_output=True)
                self.assertNotEqual(r.returncode,0,path)
            self.assertFalse((t/'blocked-new.txt').exists())
            self.assertEqual((t/'secret.txt').read_text(),files[t/'secret.txt'])
        finally:sb.unlink()

    def test_S6_environment_whitelist_and_S12_actual_command(self):
        self.fake_dsh()
        env=s.reader_env(self.home/'temp-home')
        self.assertFalse({'GITHUB_TOKEN','GH_TOKEN','runnerToken'} & env.keys())
        self.assertEqual(env['HOME'],str(self.home/'temp-home'))
        self.assertEqual(env['DEEPSEEK_API_KEY'],'synthetic-api-key')
        self.assertEqual(env['TMPDIR'],str(self.home/'temp-home/tmp'))
        self.assertEqual(Path(env['TMPDIR']).stat().st_mode & 0o777,0o700)
        args=s.reader_command(self.sub,self.home/'sb')
        self.assertIn(str(self.h/'dsh-reader.yml'),args)
        self.assertEqual(args[args.index('--permission-mode')+1],'read-only')
        self.assertNotIn('dsh-team.yml',' '.join(args))

    def test_reader_key_uses_existing_loader_and_is_scrubbed(self):
        with patch.object(s,'api_key',return_value='loaded-synthetic-key'):
            env=s.reader_env(self.home/'temporary-home')
        self.assertEqual(env['DEEPSEEK_API_KEY'],'loaded-synthetic-key')
        self.assertEqual(s.scrub('loaded-synthetic-key'),'[REDACTED]')

    def test_S10_loop_never_claims_a_third_local_slot(self):
        class StopLoop(BaseException):pass
        with patch.object(s,'local_config',return_value={}),patch.object(s,'recover_orphans'), \
             patch.object(s.concurrent.futures,'ThreadPoolExecutor') as pool, \
             patch.object(s,'claim',return_value={'id':'x'}) as claim, \
             patch.object(s.time,'sleep',side_effect=[None,None,StopLoop]):
            futures=[Mock(),Mock()]
            for future in futures:future.done.return_value=False
            pool.return_value.__enter__.return_value.submit.side_effect=futures
            with self.assertRaises(StopLoop):s.loop()
        self.assertEqual(claim.call_count,2)

    def test_S17_less_than_thirty_seconds_never_starts_a_process(self):
        run={'id':'x','deadline':(time.time()+40)*1000}
        with patch.object(s.subprocess,'Popen') as launch:
            r=s.execute(run,self.sub)
        launch.assert_not_called();self.assertEqual(r['error_kind'],'timeout')

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S7_ninety_seconds_without_renewal_fences_process(self):
        self.fake_dsh(sleep=30)
        clock=time.monotonic
        with patch.object(s,'HEARTBEAT',0.02),patch.object(s,'post',side_effect=OSError()), \
             patch.object(s.time,'monotonic',side_effect=lambda:clock()*10000):
            self.assertIsNone(s.execute(self.run,self.sub))

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S8_timeout_kills_group_and_returns_empty_answer(self):
        self.fake_dsh(sleep=30)
        started=time.monotonic()
        with patch.object(s,'run_timeout',return_value=0.2):r=s.execute(self.run,self.sub)
        self.assertLess(time.monotonic()-started,4)
        self.assertEqual((r['error_kind'],r['answer']),('timeout',''))
        self.assertEqual(list(self.home.glob('sub-home-*')),[])

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S7_heartbeat_conflict_fences_process_and_suppresses_report(self):
        self.fake_dsh(sleep=30)
        error=urllib.error.HTTPError('https://test.invalid',409,'conflict',{},None)
        with patch.object(s,'HEARTBEAT',0.02),patch.object(s,'post',side_effect=error):
            self.assertIsNone(s.execute(self.run,self.sub))

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_reader_success_updates_second_marker_and_cleans_home(self):
        self.fake_dsh()
        r=s.execute(self.run,self.sub)
        self.assertEqual((r['status'],r['read']),('done',['README.md']))
        m=json.loads((self.h/'sub/x.running').read_text())
        self.assertTrue(m['pid'] and m['pgid'] and m['lstart'])
        self.assertEqual(list(self.home.glob('sub-home-*')),[])

    @unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(),'macOS sandbox required')
    def test_S5_S6_real_child_environment_and_secret_redaction(self):
        self.fake_dsh(events=read_events())
        exe=Path(os.environ['TEAM_AGENT_DSH'])
        with exe.open('a') as stream:
            stream.write('print(json.dumps({"type":"final","reason":{"kind":"completed"},"text":json.dumps(dict(os.environ))}),flush=True)\n')
        result=s.execute(self.run,self.sub)
        env=json.loads(result['answer'])
        self.assertEqual(env['DEEPSEEK_API_KEY'],'[REDACTED]')
        self.assertFalse({'runnerToken','GITHUB_TOKEN','GH_TOKEN'} & env.keys())
        self.assertIn('sub-home-x-',env['HOME']);self.assertFalse(Path(env['HOME']).exists())

    def test_S15_reload_checks_twice_and_resumes_after_late_marker(self):
        patch.object(reload,'H',self.h).start()
        (self.h/'pending-restart.json').write_text('{}')
        (self.h/'config.json').write_text('{"url":"https://test.invalid","runnerToken":"fake"}')
        with patch.object(reload,'live_markers',return_value=[self.sub]),patch.object(reload.urllib.request,'urlopen') as cloud:
            reload.main();cloud.assert_not_called()
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return b'{"idle":true}'
        bodies=[]
        def cloud(req,**kw):bodies.append(json.loads(req.data));return Response()
        with patch.object(reload,'live_markers',side_effect=[[],[self.sub]]), \
             patch.object(reload.urllib.request,'urlopen',side_effect=cloud), \
             patch.object(reload.time,'sleep'),patch.object(reload.subprocess,'run') as install:
            reload.main();install.assert_not_called()
        self.assertEqual(bodies,[{'quiesce':True},{'resume':True}])

    def test_S22_old_marker_reaches_quiesce_fresh_marker_blocks_it(self):
        patch.object(reload,'H',self.h).start()
        (self.h/'pending-restart.json').write_text('{}')
        (self.h/'config.json').write_text('{"url":"https://test.invalid","runnerToken":"fake"}')
        marker=self.h/'sub/x.running';marker.write_text('{}')
        for age,expected in [(1000,1),(600,0)]:
            now=time.time();os.utime(marker,(now-age,now-age))
            with patch.object(reload.urllib.request,'urlopen') as cloud:
                reload.main()
            self.assertEqual(cloud.call_count,expected)


class GitTests(unittest.TestCase):
    def setUp(self):
        LocalTests.setUp(self)
        self.root=self.h/'repos/Test'
        self.root.mkdir(parents=True)
        env=dict(os.environ,GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_NOSYSTEM='1',GIT_TERMINAL_PROMPT='0')
        def git(*args,cwd=None):
            return subprocess.run(['git',*args],cwd=cwd or self.root,env=env,text=True,capture_output=True,check=True).stdout.strip()
        self.git=git
        remote=self.home/'origin.git';git('init','--bare',str(remote))
        git('init','-b','main');git('config','user.name','Synthetic');git('config','user.email','synthetic@example.invalid')
        (self.root/'README.md').write_text('C3_README\nSecond line\n')
        (self.root/'src').mkdir()
        (self.root/'src/a.ts').write_text('export const keyword = 1;\n')
        (self.root/'src/b.ts').write_text('export const keyword = 2;\n')
        (self.root/'.env').write_text('SYNTHETIC_PASSWORD=secret_keyword\n')
        git('add','.');git('commit','-m','fixture');self.sha=git('rev-parse','HEAD')
        git('remote','add','origin',str(remote));git('push','origin','main')
        url = 'https://github.com/example/Test.git'
        git('remote', 'set-url', 'origin', url)
        invoke = s.gitsafe._invoke
        def local_fetch(root, env, args, extra=(), **kwargs):
            # gitsafe intentionally ignores source/global URL rewrites. Inject
            # this exact fixture rewrite only at the test's fetch invocation;
            # origin validation, neutral repo isolation and real Git stay active.
            if args == ['fetch', '--prune', 'origin']:
                extra = [*extra, '-c', 'url.' + remote.as_uri() + '.insteadOf=' + url]
            return invoke(root, env, args, extra=extra, **kwargs)
        patch.object(s.gitsafe, '_invoke', side_effect=local_fetch).start()
        patch.object(s.gitsafe, '_lookup_credential', return_value=None).start()
        self.run={'id':'x','lease':'l','repo':'example/Test','ref':self.sha,'question':'keyword','deadline':(time.time()+400)*1000}
        patch.object(s,'settings',return_value={'repositories':['example/Test']}).start()

    def test_fixture_fetch_refreshes_remote_refs_and_keeps_url_guard(self):
        url = 'https://github.com/example/Test.git'
        self.assertEqual(s.gitsafe._origin_url(self.root), url)
        (self.root/'src/a.ts').write_text('export const fetched = 3;\n')
        self.git('add', '.');self.git('commit', '-m', 'remote-only fixture change')
        later = self.git('rev-parse', 'HEAD')
        self.git('push', str(self.home/'origin.git'), 'HEAD:refs/heads/agent/fixture')
        self.git('reset', '--hard', self.sha)
        self.sub.rmdir()
        sub, sha = s.prepare(dict(self.run, ref='agent/fixture'))
        self.assertEqual(sha, later)
        self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/agent/fixture'), later)
        self.assertIn('fetched = 3', (sub/'src/a.ts').read_text())
        self.assertEqual(self.git('config', '--get', 'remote.origin.url'), url)
        s.cleanup(sub)
        self.git('remote', 'set-url', 'origin', str(self.home/'origin.git'))
        with self.assertRaises(s.gitsafe.GitFailed):
            s.gitsafe.run(self.root, 'lifecycle', 'fetch', '--prune', 'origin')

    def test_S1_prepare_pins_commit_and_cleanup_removes_worktree(self):
        sub,sha=s.prepare(self.run)
        self.assertEqual((sub,sha),(self.sub,self.sha))
        self.assertEqual(self.git('rev-parse','HEAD',cwd=sub),self.sha)
        s.cleanup(sub)
        self.assertFalse(sub.exists())
        self.assertNotIn(str(sub),self.git('worktree','list','--porcelain'))

    def test_S2_bad_refs_do_not_create_worktrees(self):
        self.sub.rmdir()
        for ref in ['no-such','../x','--help']:
            with self.subTest(ref=ref),self.assertRaises(s.RunError) as caught:
                s.prepare(dict(self.run,ref=ref))
            self.assertEqual(caught.exception.kind,'invalid_args')
            self.assertFalse(self.sub.exists())

    def test_S23_named_file_must_be_read_and_sha_is_reported(self):
        run=dict(self.run,question='读 src/a.ts')
        final=[{'type':'final','reason':{'kind':'completed'},'text':'src/a.ts:1'}]
        r=s.classify_events(run,self.root,self.sha,read_events('src/b.ts')+final,0)
        self.assertEqual((r['error_kind'],r['answer'],r['sha']),('not_found','',self.sha))
        events=read_events('src/a.ts')+read_events('src/b.ts')
        # Real call IDs are unique.
        events[0]['callId']=events[1]['callId']='a'
        r=s.classify_events(run,self.root,self.sha,events+final,0)
        self.assertEqual(r['status'],'done');self.assertEqual(set(r['read']),{'src/a.ts','src/b.ts'})

    def test_S24_B_empty_and_denied_hits_never_create_answers(self):
        for term in ['missing-xyz','secret_keyword']:
            r=s.search_read(dict(self.run,question=term,keywords=[term]),self.sha)
            self.assertEqual((r['status'],r['error_kind'],r['answer']),('failed','not_found',''))

    def test_S30_repo_git_credentials_rejected_before_launch(self):
        with patch.dict(s._roots,{str(self.sub):self.root}):
            for url in ['https://github.com/a/b','https://x:ghp_'+'a'*36+'@github.com/a/b']:
                self.git('config','remote.origin.url',url)
                self.assertEqual(s.repo_git_clean(self.root),'@' not in url)
                if '@' in url:
                    with patch.object(s,'repo_git_clean',return_value=False),patch.object(s.subprocess,'Popen') as launch:
                        result=s.execute(dict(self.run,resolved_sha=self.sha),self.sub)
                    self.assertEqual(result['error_kind'],'runner_unsupported');launch.assert_not_called()
            self.git('config','remote.origin.url','https://github.com/a/b')
            self.git('config','http.https://github.com/.extraheader','synthetic-authorization')
            self.assertFalse(s.repo_git_clean(self.root))
            with patch.object(s,'repo_git_clean',return_value=False),patch.object(s.subprocess,'Popen') as launch:
                result=s.execute(dict(self.run,resolved_sha=self.sha),self.sub)
            self.assertEqual(result['error_kind'],'runner_unsupported');launch.assert_not_called()

    def test_B_only_searches_pinned_sha_and_limits_three_nonsecret_files(self):
        (self.root/'src/a.ts').write_text('not_in_commit\n')
        r=s.search_read(dict(self.run,keywords=['keyword']),self.sha)
        self.assertEqual(r['status'],'done')
        self.assertIn('export const keyword = 1;',r['answer'])
        self.assertNotIn('not_in_commit',r['answer']);self.assertNotIn('SYNTHETIC_PASSWORD',r['answer'])
        self.assertEqual(len(r['read']),2)

    def test_S9_committed_workspace_and_unverified_citations_are_distinct(self):
        (self.root/'new.txt').write_text('uncommitted\n')
        s.workspace_sources[str(self.sub)]={'new.txt':self.root}
        r=s.verify_citations(self.root,self.sha,'README.md:1 missing.ts:1 workspace:new.txt:1 new.txt:1',{'new.txt'},sources={'new.txt':self.root})
        self.assertEqual(len(r['citations']),1);self.assertEqual(len(r['workspaceCitations']),1)
        self.assertEqual(r['unverifiedCitations']['count'],2)

    def test_handle_marks_before_prepare_and_always_cleans(self):
        self.sub.rmdir()
        def prepare(run):
            m=json.loads((self.h/'sub/x.running').read_text())
            self.assertIsNone(m['pid']);raise s.RunError('invalid_args')
        with patch.object(s,'READER_VERIFIED',True),patch.object(s,'prepare',side_effect=prepare),patch.object(s,'report') as report:
            s.handle(self.run)
        self.assertEqual(report.call_args.args[2]['error_kind'],'invalid_args')
        self.assertFalse((self.h/'sub/x.running').exists())

    def test_B_handle_never_creates_worktree_and_keeps_resolved_sha(self):
        self.sub.rmdir()
        with patch.object(s,'READER_VERIFIED',False),patch.object(s,'prepare') as prepare,patch.object(s,'post',return_value={}),patch.object(s,'report') as report:
            s.handle(self.run)
        prepare.assert_not_called()
        self.assertEqual(report.call_args.args[2]['sha'],self.sha)
        self.assertFalse(self.sub.exists())

    def test_cleanup_removes_crashed_temporary_home(self):
        tmp=self.home/'sub-home-x-synthetic';tmp.mkdir();(tmp/'state').write_text('synthetic')
        s.cleanup(self.sub)
        self.assertFalse(tmp.exists())

    def test_S1_exception_after_preparation_still_removes_worktree(self):
        self.sub.rmdir()
        with patch.object(s,'READER_VERIFIED',True),patch.object(s,'execute',side_effect=OSError()),patch.object(s,'report') as report:
            s.handle(self.run)
        self.assertEqual(report.call_args.args[2]['error_kind'],'upstream')
        self.assertFalse(self.sub.exists())
        self.assertFalse((self.h/'sub/x.running').exists())

    def test_context_pack_taint_diff_deny_redaction_and_workspace_boundaries(self):
        self.sub.rmdir();sub,sha=s.prepare(self.run)
        work=self.h/'work/topic';work.parent.mkdir()
        self.git('worktree','add','-b','feature-probe',str(work),self.sha)
        (work/'src/a.ts').write_text('export const changed = "ghp_'+'a'*36+'";\n')
        (work/'.env').write_text('SYNTHETIC_PASSWORD=must-not-appear\n')
        (self.h/'work/escape').symlink_to(self.home,target_is_directory=True)
        text=s.context_pack(dict(self.run,question='看看 feature-probe',tainted=1,resolved_sha=sha),sub)
        self.assertIn('<<<WORKSPACE',text);self.assertIn('[REDACTED]',text)
        self.assertNotIn('must-not-appear',text);self.assertIn('只回答代码事实',text)
        self.assertIn('src/a.ts',s.workspace_sources[str(sub)])
        self.assertEqual((sub/'.teamagent-context.md').read_text(),text)
        s.cleanup(sub)


if __name__=='__main__':unittest.main()
