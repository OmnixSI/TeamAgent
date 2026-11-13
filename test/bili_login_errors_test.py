import importlib.util
import json
from email.message import Message
from pathlib import Path
import ssl
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runner'))
spec = importlib.util.spec_from_file_location('bili_errors_unit', ROOT / 'runner/local_bili_login.py')
bili = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bili)


class BiliLoginErrorsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name)
        self.login = bili.LocalBiliLogin(self.runtime, {'url':'https://cloud.test', 'runnerToken':'synthetic-token'})
        self.key = 'a' * 32
        self.qr = 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=' + self.key

    def test_save_replaces_non_object_cookie_json(self):
        path = self.runtime / 'secrets/bili-cookie.json'
        path.parent.mkdir()
        fresh = {name: {'value':'synthetic-' + name, 'expires':0} for name in ('SESSDATA','bili_jct','DedeUserID')}
        for old in ('[]', 'null'):
            with self.subTest(old=old):
                path.write_text(old)
                self.login._save(fresh)
                self.assertEqual(json.loads(path.read_text()), fresh)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_generate_poll_and_report_choose_explicit_verified_ca(self):
        responses = []
        for body in [{'code':0,'data':{'url':self.qr,'qrcode_key':self.key}}, {'code':0,'data':{'code':86101}}, {}]:
            response = Mock(headers=Message())
            response.read.return_value = json.dumps(body).encode()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            responses.append(response)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with patch.object(bili.Path, 'is_file', lambda path: str(path) == '/etc/ssl/cert.pem'), patch.object(bili.ssl, 'create_default_context', return_value=context) as tls, patch.object(bili.urllib.request, 'urlopen', side_effect=responses) as opened:
            started = self.login.start()
            self.assertEqual(self.login.status(started['id']), {'phase':'waiting'})
            self.login._report('ok')
        self.assertEqual(tls.call_count, 3)
        self.assertTrue(all(call.kwargs == {'cafile':'/etc/ssl/cert.pem'} for call in tls.call_args_list))
        self.assertTrue(all(call.kwargs['context'] is context for call in opened.call_args_list))
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        report = json.loads(opened.call_args_list[-1].args[0].data)
        self.assertEqual(set(report), {'service','state','checked_at'})
        self.assertNotIn(self.key, json.dumps(report))

    def test_ca_fallback_and_missing_ca_fail_before_network(self):
        with patch.object(bili.Path, 'is_file', lambda path: str(path) == '/etc/ssl/certs/ca-certificates.crt'), patch.object(bili.ssl, 'create_default_context') as tls:
            bili.login_tls_context()
            tls.assert_called_once_with(cafile='/etc/ssl/certs/ca-certificates.crt')
        with patch.object(bili.Path, 'is_file', return_value=False), patch.object(bili.urllib.request, 'urlopen') as opened:
            with self.assertRaises(Exception) as failure:
                self.login.start()
            error = bili.login_error(failure.exception)
            self.assertEqual(error['reason'], 'certificate')
            self.assertIn('证书', error['error'])
            opened.assert_not_called()

    def test_ok_poll_gets_a_bounded_settle_window_after_qr_expiry(self):
        headers = Message(); calls = []
        def http(url):
            calls.append(url)
            if 'generate' in url:
                return headers, {'code':0,'data':{'url':self.qr,'qrcode_key':self.key}}
            return headers, {'code':0,'data':{'code':0}}
        for name in ('SESSDATA','bili_jct','DedeUserID'):
            headers.add_header('Set-Cookie', name + '=synthetic-' + name + '; Max-Age=3600')
        self.login._http = http
        self.login._report = lambda state: None
        started = self.login.start()
        self.login._sessions['active']['expires_at'] = int(time.time() * 1000) - 1000
        self.assertEqual(self.login.status(started['id']), {'phase':'ok'})
        started = self.login.start()
        self.login._sessions['active']['expires_at'] = int(time.time() * 1000) - 31000
        before = len(calls)
        self.assertEqual(self.login.status(started['id']), {'phase':'expired'})
        self.assertEqual(len(calls), before)

    def test_corrupt_or_unreadable_risk_state_is_closed_and_explained(self):
        risk = self.runtime / bili.RISK_PATH
        risk.parent.mkdir()
        for value in ['broken', '[]', 'null', '{"paused_until":"bad"}', '{"paused_until":NaN}', '{"paused_until":Infinity}']:
            with self.subTest(value=value):
                self.login = bili.LocalBiliLogin(self.runtime, {})
                risk.write_text(value)
                with patch.object(bili.urllib.request, 'urlopen') as opened:
                    with self.assertRaises(bili.BiliPaused) as failure:
                        self.login.start()
                    error = bili.login_error(failure.exception)
                    self.assertEqual(error['reason'], 'risk_state')
                    self.assertIn('风控状态文件', error['error'])
                    opened.assert_not_called()

    def test_pause_reports_deadline_and_http_without_remote_text(self):
        error = urllib.error.HTTPError(self.qr, 412, 'Cookie=secret ' + self.key, None, None)
        with patch.object(bili.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaises(bili.BiliPaused) as failure:
                self.login.start()
        info = bili.login_error(failure.exception)
        self.assertIn('HTTP 412', info['error'])
        self.assertIn('暂停至', info['error'])
        self.assertGreater(info['paused_until'], time.time() * 1000)
        self.assertNotIn(self.key, json.dumps(info))
        self.assertNotIn('secret', json.dumps(info))

    def test_certificate_and_business_errors_are_fixed_and_do_not_leak(self):
        for error, reason in [(urllib.error.URLError(ssl.SSLCertVerificationError(self.qr)), 'certificate'), (urllib.error.HTTPError(self.qr, 403, self.key, None, None), 'http')]:
            with patch.object(bili.urllib.request, 'urlopen', side_effect=error):
                with self.assertRaises(Exception) as failure:
                    self.login.start()
            info = bili.login_error(failure.exception)
            self.assertEqual(info['reason'], reason)
            self.assertNotIn(self.key, json.dumps(info))
            self.assertNotIn('https:', json.dumps(info))
        response = Mock(headers=Message())
        response.read.return_value = json.dumps({'code':-400, 'message':self.qr}).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(bili.urllib.request, 'urlopen', return_value=response):
            with self.assertRaises(Exception) as failure:
                self.login.start()
        info = bili.login_error(failure.exception)
        self.assertIn('业务码 -400', info['error'])
        self.assertNotIn(self.key, json.dumps(info))
