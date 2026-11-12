import http.client
from email.message import Message
import importlib.util
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]

class LocalLoginPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / '.inkboard-team'
        self.runtime.mkdir()
        (self.runtime / 'config.json').write_text('{"url":"https://cloud.test","adminToken":"fake","runnerToken":"runner"}')
        addresses = []
        class NoServer:
            def __init__(self, address, handler):
                addresses.append(address)
            def serve_forever(self):
                pass
        with patch.dict(os.environ, {'HOME': str(self.temp.name)}), patch.object(sys, 'path', [str(ROOT / 'runner'), *sys.path]), patch('http.server.ThreadingHTTPServer', NoServer):
            self.module = runpy.run_path(str(ROOT / 'runner/owner.py'))
        self.module['Handler'].runtime = self.runtime
        self.module['Handler'].bili_login = None
        self.session, _ = self.module['Handler'].sessions.issue()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.module['Handler'])
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, path, method='GET', body=None, session=True):
        headers = {'Host':'127.0.0.1:3391','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1'}
        if session:
            headers['X-TeamAgent-Session'] = self.session
        if body is not None:
            headers['Content-Type'] = 'application/json'
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        try:
            conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = conn.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            conn.close()

    def test_login_page_is_local_and_has_no_cloud_or_qr(self):
        status, body, headers = self.request('/login', session=False)
        self.assertEqual(status, 200)
        self.assertIn('TeamAgent 登录'.encode(), body)
        self.assertNotIn(b'qrcode_key=', body)
        self.assertNotIn(b'cloud.test', body)
        self.assertIn('Content-Security-Policy', headers)
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_start_and_status_require_local_session(self):
        self.assertEqual(self.request('/api/local/bili/start', 'POST', {}, session=False)[0], 401)
        self.assertEqual(self.request('/api/local/bili/status?id=abc', session=False)[0], 401)

    def test_start_and_status_are_local_only_and_do_not_return_cookies(self):
        fake = Mock()
        fake.start.return_value = {'id':'abc','qr_url':'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key='+'a'*32+'&from=','expires_at':int(time.time()*1000)+60000}
        fake.status.return_value = {'phase':'waiting'}
        self.module['Handler'].bili_login = fake
        status, body, _ = self.request('/api/local/bili/start', 'POST', {})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['id'], 'abc')
        status, body, _ = self.request('/api/local/bili/status?id=abc')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'phase':'waiting'})
        self.assertNotIn(b'cookie', body.lower())


    def test_local_bili_reuses_shared_pause_and_single_active_flow(self):
        spec = importlib.util.spec_from_file_location('local_bili_unit2', ROOT / 'runner/local_bili_login.py')
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(ROOT / 'runner'))
        spec.loader.exec_module(module)
        login = module.LocalBiliLogin(self.runtime, {'url':'https://cloud.test','runnerToken':'runner'})
        risk = self.runtime / 'state/bili-risk.json'
        risk.parent.mkdir(parents=True)
        risk.write_text(json.dumps({'paused_until': int(time.time()*1000)+60000}))
        with patch.object(module.urllib.request, 'urlopen') as opened:
            with self.assertRaises(module.BiliPaused):
                login.start()
            opened.assert_not_called()
        login._pause()
        with patch.object(module.urllib.request, 'urlopen') as opened:
            for _ in range(5):
                with self.assertRaises(module.BiliPaused):
                    login.start()
            opened.assert_not_called()
        risk.write_text(json.dumps({'paused_until': 0}))
        headers = Message()
        url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=' + 'b'*32 + '&from='
        calls = []
        def http(path):
            calls.append(path)
            return headers, {'code':0,'data':{'url':url,'qrcode_key':'b'*32}}
        login._http = http
        first = login.start()
        second = login.start()
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(len(calls), 1)


    def test_local_bili_save_failure_never_claims_ok(self):
        spec = importlib.util.spec_from_file_location('local_bili_unit3', ROOT / 'runner/local_bili_login.py')
        module = importlib.util.module_from_spec(spec); sys.path.insert(0, str(ROOT / 'runner')); spec.loader.exec_module(module)
        login = module.LocalBiliLogin(self.runtime, {'url':'https://cloud.test','runnerToken':'runner'})
        headers = Message(); url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=' + 'c'*32 + '&from='
        login._http = lambda path: (headers, {'code':0,'data':{'url':url,'qrcode_key':'c'*32}}) if 'generate' in path else (headers, {'code':0,'data':{'code':0}})
        headers.add_header('Set-Cookie', 'SESSDATA=x; Max-Age=3600'); headers.add_header('Set-Cookie', 'bili_jct=y; Max-Age=3600'); headers.add_header('Set-Cookie', 'DedeUserID=z; Max-Age=3600')
        login._report = lambda state: None
        login._save = lambda fresh: (_ for _ in ()).throw(OSError('disk full'))
        started = login.start()
        self.assertEqual(login.status(started['id']), {'phase':'failed'})
        self.assertEqual(login.status(started['id']), {'phase':'failed'})
        self.assertFalse((self.runtime / 'secrets/bili-cookie.json').exists())

    def test_local_bili_lock_timeout_does_not_write_and_stale_lock_recovers(self):
        spec = importlib.util.spec_from_file_location('local_bili_unit4', ROOT / 'runner/local_bili_login.py')
        module = importlib.util.module_from_spec(spec); sys.path.insert(0, str(ROOT / 'runner')); spec.loader.exec_module(module)
        login = module.LocalBiliLogin(self.runtime, {'url':'https://cloud.test','runnerToken':'runner'})
        risk = self.runtime / 'state/bili-risk.json'; risk.parent.mkdir(parents=True); lock = risk.with_name(risk.name + '.lock')
        lock.mkdir(); started = time.time(); login._pause(); self.assertFalse(risk.exists()); self.assertGreaterEqual(time.time()-started, 0.9)
        os.utime(lock, (time.time()-60, time.time()-60)); login._pause(); self.assertTrue(risk.exists()); self.assertFalse(lock.exists())

    def test_local_bili_generate_and_ok_poll_write_0600_cookie_file(self):
        spec = importlib.util.spec_from_file_location('local_bili_unit', ROOT / 'runner/local_bili_login.py')
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(ROOT / 'runner'))
        spec.loader.exec_module(module)
        login = module.LocalBiliLogin(self.runtime, {'url':'https://cloud.test','runnerToken':'runner'})
        headers = Message()
        login._http = lambda url: (headers, {'code':0,'data':{'url':'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key='+'a'*32+'&from=','qrcode_key':'a'*32}}) if 'generate' in url else (headers, {'code':0,'data':{'code':0}})
        headers.add_header('Set-Cookie', 'SESSDATA=session-private; Max-Age=3600')
        headers.add_header('Set-Cookie', 'bili_jct=csrf-private; Max-Age=3600')
        headers.add_header('Set-Cookie', 'DedeUserID=user-private; Max-Age=3600')
        login._report = lambda state: None
        started = login.start()
        self.assertTrue(started['qr_url'].startswith('https://account.bilibili.com/'))
        self.assertEqual(login.status(started['id']), {'phase':'ok'})
        path = self.runtime / 'secrets/bili-cookie.json'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        saved = json.loads(path.read_text())
        self.assertEqual(saved['SESSDATA']['value'], 'session-private')
        self.assertEqual((self.runtime / 'secrets').stat().st_mode & 0o777, 0o700)

if __name__ == '__main__':
    unittest.main()
