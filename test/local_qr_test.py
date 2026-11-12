"""The QR capability is returned only by the existing guarded loopback owner."""
import http.client
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]

class LocalQrTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.runtime = self.home / '.inkboard-team'
        self.runtime.mkdir()
        (self.runtime / 'config.json').write_text('{"url":"https://cloud.test","adminToken":"fake-owner"}')
        self.directory = self.runtime / 'state/login-qr'
        self.directory.mkdir(parents=True, mode=0o700)
        self.qr = 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=' + 'a' * 32
        self.path = self.directory / 'bili-flow.json'
        self.save()
        class NoServer:
            def __init__(self, address, handler):
                self.address = address
            def serve_forever(self):
                pass
        with patch.dict(os.environ, {'HOME': str(self.home)}), patch.object(sys, 'path', [str(ROOT / 'runner'), *sys.path]), patch('http.server.ThreadingHTTPServer', NoServer):
            self.module = runpy.run_path(str(ROOT / 'runner/owner.py'))
        self.module['Handler'].runtime = self.runtime
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.module['Handler'])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def save(self, expires=None):
        self.path.write_text(json.dumps({'id':'flow', 'service':'bili', 'qr_url':self.qr, 'expires_at':expires or int(time.time()*1000)+300000}))
        self.path.chmod(0o600)

    def request(self, path='/api/local/service-login/qr?id=flow', headers=None, method='GET', body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        try:
            conn.request(method, path, body=body, headers=headers or {'Host':'127.0.0.1:3391','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1'})
            r = conn.getresponse()
            return r.status, r.read(), dict(r.getheaders())
        finally:
            conn.close()

    def test_qr_is_local_only_and_never_proxied_to_cloud(self):
        with patch('urllib.request.urlopen') as cloud:
            status, body, headers = self.request()
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['qr_url'], self.qr)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
            self.assertNotIn('Access-Control-Allow-Origin', headers)
            cloud.assert_not_called()

    def test_local_qr_keeps_host_origin_custom_header_and_preflight_guards(self):
        with patch('urllib.request.urlopen') as cloud:
            for headers in [
                {'Host':'evil.test','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1'},
                {'Host':'127.0.0.1:3391','Origin':'https://evil.test','X-TeamAgent-Local':'1'},
                {'Host':'127.0.0.1:3391','Origin':'null','X-TeamAgent-Local':'1'},
                {'Host':'127.0.0.1:3391','Origin':'http://127.0.0.1:3391'},
            ]:
                self.assertEqual(self.request(headers=headers)[0], 403)
            self.assertEqual(self.request(method='OPTIONS')[0], 501)
            cloud.assert_not_called()

    def test_expired_and_invalid_qr_cannot_be_read_or_traverse_paths(self):
        with patch('urllib.request.urlopen') as cloud:
            self.save(expires=1)
            self.assertEqual(self.request()[0], 404)
            self.assertEqual(self.request('/api/local/service-login/qr?id=../../config')[0], 400)
            cloud.assert_not_called()

    def test_successful_owner_cancellation_clears_local_qr(self):
        response = Mock(status=200, headers={'Content-Type':'application/json'})
        response.read.return_value = b'{"flow":{"phase":"cancelled"}}'
        with patch('urllib.request.urlopen', return_value=response) as cloud:
            result = self.request('/api/team/service-login', method='DELETE', body=json.dumps({'service':'bili','id':'flow'}))
            self.assertEqual(result[0], 200)
            self.assertFalse(self.path.exists())
            self.assertEqual(cloud.call_args.args[0].data, b'{"service": "bili", "id": "flow"}')

if __name__ == '__main__': unittest.main()
