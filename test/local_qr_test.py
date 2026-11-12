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
import subprocess
import hashlib
import socket
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
        addresses = []
        class NoServer:
            def __init__(self, address, handler):
                self.address = address
                addresses.append(address)
            def serve_forever(self):
                pass
        with patch.dict(os.environ, {'HOME': str(self.home)}), patch.object(sys, 'path', [str(ROOT / 'runner'), *sys.path]), patch('http.server.ThreadingHTTPServer', NoServer):
            self.module = runpy.run_path(str(ROOT / 'runner/owner.py'))
        self.module['Handler'].runtime = self.runtime
        self.unlock = self.module['redeem_code'].__globals__
        self.code = self.unlock['mint_code'](self.runtime)
        self.session, _ = self.module['Handler'].sessions.issue()
        self.bound_address = addresses[0]
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
            conn.request(method, path, body=body, headers=headers if headers is not None else {'Host':'127.0.0.1:3391','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1','X-TeamAgent-Session':self.session})
            r = conn.getresponse()
            return r.status, r.read(), dict(r.getheaders())
        finally:
            conn.close()

    def raw_request(self, target, method='GET', authenticated=False, body=b'{}'):
        # Preserve the exact request-target: high-level clients may normalize or reject it.
        headers = 'Host: 127.0.0.1:3391\r\nOrigin: http://127.0.0.1:3391\r\nX-TeamAgent-Local: 1\r\n'
        if authenticated:
            headers += 'X-TeamAgent-Session: ' + self.session + '\r\n'
        packet = (method+' '+target+' HTTP/1.1\r\n'+headers+'Content-Length: '+str(len(body))+'\r\nConnection: close\r\n\r\n').encode('ascii') + body
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as conn:
            conn.sendall(packet)
            response = http.client.HTTPResponse(conn)
            response.begin()
            return response.status, response.read()

    @staticmethod
    def target_variants(target):
        path, sep, query = target.partition('?')
        suffix = sep+query
        return {
            'origin':(target,False),
            'absolute':('http://127.0.0.1:3391'+target,True),
            'absolute_https':('https://127.0.0.1:3391'+target,True),
            'authority':('127.0.0.1:3391',True),
            'asterisk':('*',True),
            'network_path':('//127.0.0.1:3391'+target,True),
            'leading_double':('/'+target,True),
            'interior_double':(target.replace('/api/','/api//',1),True),
            'dot':('/./'+target.lstrip('/'),True),
            'dotdot':('/safe/../'+target.lstrip('/'),True),
            'encoded_dot':('/%2e/'+target.lstrip('/'),True),
            'encoded_dotdot':('/safe/%2e%2E/'+target.lstrip('/'),True),
            'encoded_slash':(target.replace('/api/','/api%2f',1),True),
            'double_encoded_slash':(target.replace('/api/','/api%252F',1),True),
            'encoded_backslash':(target.replace('/api/','/api%5c',1),True),
            'encoded_nul':(path+'%00'+suffix,True),
            'invalid_percent':(path+'%zz'+suffix,True),
            'backslash':(target.replace('/api/','/api\\',1),True),
            'nul':(path+'\x00'+suffix,True),
            'tab':(path+'\t'+suffix,True),
            'space':(path+' '+suffix,True),
            'fragment':(target+'#fragment',True),
            'case':(path.upper()+suffix,False),
            'trailing_slash':(path+'/'+suffix,False),
            'query':(path+'?'+(query or 'probe=1'),False),
        }

    def test_P1_absolute_form_reproduction_never_releases_qr_without_session(self):
        with patch('urllib.request.urlopen') as cloud:
            for target in ['/api/local/service-login/qr?id=flow','http://127.0.0.1:3391/api/local/service-login/qr?id=flow']:
                status, body = self.raw_request(target)
                self.assertIn(status,[400,401])
                self.assertNotIn(b'qr_url',body)
            cloud.assert_not_called()

    def test_P1_unauthenticated_route_target_and_method_variant_matrix_never_routes_or_proxies(self):
        endpoints = [('GET','/api/local/service-login/qr?id=flow'),('GET','/api/team/service-login'),('POST','/api/team/service-login'),('DELETE','/api/team/service-login'),('POST','/api/team/ai-tokens'),('POST','/api/admin/pair'),('PATCH','/api/admin/revoke'),('GET','/api/team/state'),('PATCH','/api/team/profile')]
        with patch('urllib.request.urlopen') as cloud:
            for method, endpoint in endpoints:
                for name, (target, invalid) in self.target_variants(endpoint).items():
                    for verb in [method, method.lower(), method.title()]:
                        with self.subTest(endpoint=endpoint,variant=name,method=verb):
                            status,body = self.raw_request(target,verb)
                            self.assertIn(status,[400,401])
                            self.assertNotIn(b'qr_url',body)
            cloud.assert_not_called()

    def test_P1_invalid_targets_are_rejected_even_with_session_before_any_route(self):
        endpoints = ['/api/local/service-login/qr?id=flow','/api/team/service-login','/api/team/ai-tokens','/api/admin/pair','/api/team/state','/api/local/session']
        with patch('urllib.request.urlopen') as cloud:
            for endpoint in endpoints:
                for name,(target,invalid) in self.target_variants(endpoint).items():
                    if not invalid:
                        continue
                    with self.subTest(endpoint=endpoint,variant=name):
                        status,body = self.raw_request(target,'POST' if endpoint.endswith('/session') else 'GET',True)
                        self.assertEqual(status,400)
                        self.assertNotIn(b'qr_url',body)
            cloud.assert_not_called()

    def test_P1_canonical_authorized_routes_and_queries_share_auth_dispatch_and_forward_target(self):
        response = Mock(status=200,headers={'Content-Type':'application/json'})
        response.read.return_value = b'{}'
        split = self.module['urlsplit']
        with patch.dict(self.module['Handler'].proxy.__globals__, {'urlsplit':Mock(wraps=split)}) as globals_, patch('urllib.request.urlopen',return_value=response) as cloud:
            parser = globals_['urlsplit']
            for method,path in [('GET','/api/team/service-login?from=web'),('POST','/api/team/service-login?from=web'),('DELETE','/api/team/service-login?from=web'),('POST','/api/team/ai-tokens?label=local'),('POST','/api/admin/pair?from=web'),('PATCH','/api/team/profile?name=%E4%B8%AD%E6%96%87'),('GET','/api/team/project?repo=OmnixSI%2FTeamAgent')]:
                self.save()
                before=parser.call_count
                self.assertEqual(self.raw_request(path,method,True,body=b'{"service":"bili","id":"flow"}')[0],200)
                self.assertEqual(parser.call_count-before,1)
                request=cloud.call_args.args[0]
                self.assertEqual(request.full_url,'https://cloud.test'+path)
                self.assertEqual(request.get_header('Authorization'),'Bearer fake-owner')
                self.assertIsNone(request.get_header('X-teamagent-session'))
                if method=='DELETE':
                    self.assertFalse(self.path.exists())
            for path in ['/?view=system','/guide?lang=zh']:
                self.assertEqual(self.raw_request(path)[0],200)
                self.assertIsNone(cloud.call_args.args[0].get_header('Authorization'))
            cloud.reset_mock()
            self.save()
            self.assertEqual(self.raw_request('/api/local/service-login/qr?id=flow',authenticated=True)[0],200)
            cloud.assert_not_called()

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
                {'Host':'localhost:3391','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1'},
                {'Host':'127.0.0.1:3391.evil.test','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1'},
            ]:
                headers['X-TeamAgent-Session'] = self.session
                self.assertEqual(self.request(headers=headers)[0], 403)
            self.assertEqual(self.request(method='OPTIONS')[0], 501)
            cloud.assert_not_called()
            self.assertEqual(self.bound_address, ('127.0.0.1',3391))

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
            self.assertIsNone(cloud.call_args.args[0].get_header('X-teamagent-session'))

    def test_U2_fake_expired_sessions_and_invalid_unlocks_are_rejected(self):
        headers = {'Host':'127.0.0.1:3391','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1','X-TeamAgent-Session':'x'*43}
        with patch('urllib.request.urlopen') as cloud:
            self.assertEqual(self.request(headers=headers)[0], 401)
            for code in ['x'*43, 'bad']:
                self.assertEqual(self.request('/api/local/session', method='POST', body=json.dumps({'code':code}))[0], 403)
            for case in ['expired','permissions','symlink','uid']:
                code = self.unlock['mint_code'](self.runtime)
                file = self.runtime / 'state/owner-unlock' / (hashlib.sha256(code.encode()).hexdigest()+'.json')
                if case == 'expired':
                    file.write_text('{"expires_at":1}')
                elif case == 'permissions':
                    file.chmod(0o644)
                elif case == 'symlink':
                    target = file.with_suffix('.target')
                    file.rename(target)
                    file.symlink_to(target)
                if case == 'uid':
                    actual_uid = os.getuid()
                    with patch('os.getuid', return_value=actual_uid+1):
                        result = self.request('/api/local/session', method='POST', body=json.dumps({'code':code}))
                else:
                    result = self.request('/api/local/session', method='POST', body=json.dumps({'code':code}))
                self.assertEqual(result[0],403,case)
                self.assertEqual(json.loads(result[1])['error'],'解锁码无效或已过期')
            for body in ['{', '[]', 'x'*257]:
                self.assertEqual(self.request('/api/local/session',method='POST',body=body)[0],403)
            no_origin = {'Host':'127.0.0.1:3391','X-TeamAgent-Local':'1'}
            self.assertEqual(self.request('/api/local/session',headers=no_origin,method='POST',body=json.dumps({'code':self.code}))[0],403)
            with patch('time.time', return_value=time.time()+12*3600+1):
                self.assertEqual(self.request()[0], 401)
            cloud.assert_not_called()

    def test_U3_redeem_read_and_proxy_strips_local_session_and_public_pages_have_no_auth(self):
        status, body, _ = self.request('/api/local/session', method='POST', body=json.dumps({'code':self.code}))
        self.assertEqual(status, 200)
        self.session = json.loads(body)['session']
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request('/api/local/session', method='POST', body=json.dumps({'code':self.code}))[0], 403)
        response = Mock(status=200, headers={'Content-Type':'application/json'})
        response.read.return_value = b'{}'
        with patch('urllib.request.urlopen', return_value=response) as cloud:
            self.assertEqual(self.request('/api/team/service-login', method='POST', body='{"service":"bili"}')[0],200)
            request = cloud.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'), 'Bearer fake-owner')
            self.assertIsNone(request.get_header('X-teamagent-session'))
            for path in ['/', '/guide']:
                self.assertEqual(self.request(path)[0], 200)
                self.assertIsNone(cloud.call_args.args[0].get_header('Authorization'))

    def test_U4_two_http_redemptions_have_exactly_one_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(lambda _: self.request('/api/local/session', method='POST', body=json.dumps({'code':self.code}))[0], range(2)))
        self.assertEqual(sorted(statuses), [200,403])

    def test_U5_http_session_eviction_and_restart_invalidate_old_identity(self):
        tokens = []
        for _ in range(9):
            code = self.unlock['mint_code'](self.runtime)
            status, body, _ = self.request('/api/local/session',method='POST',body=json.dumps({'code':code}))
            self.assertEqual(status,200)
            tokens.append(json.loads(body)['session'])
        self.session = tokens[0]
        self.assertEqual(self.request()[0],401)
        self.session = tokens[-1]
        self.assertEqual(self.request()[0],200)
        self.module['Handler'].sessions = self.module['OwnerSessions']()
        self.assertEqual(self.request()[0],401)

    def test_U6_valid_session_cannot_read_a_removed_cancelled_or_risk_qr(self):
        script = '''import {runLoginFlow} from './runner/qr-login.mjs';
const home=process.argv[1], url='https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key='+'a'.repeat(32);
const client={isPaused:()=>false,pauseForRisk(){},biliPassport:async action=>{
 if(action==='generate')return {body:{code:0,data:{url,qrcode_key:'a'.repeat(32)}}};
 throw Object.assign(Error('risk'),{code:-352});
}};
const phase=await runLoginFlow({id:'flow',service:'bili',expires_at:Date.now()+300000},{home,client,auth:{withLoginLock:async(_s,f)=>f(),record:async()=>{}},cloud:async()=>({ok:true})});
if(phase!=='failed')process.exit(1);'''
        subprocess.run(['node','--input-type=module','-e',script,str(self.runtime)],cwd=ROOT,capture_output=True,text=True,check=True)
        self.assertEqual(self.request()[0],404,'risk -352 must clear the local capability')
        self.save(expires=1)
        self.assertEqual(self.request()[0],404)

    def test_U9_http_logs_never_contain_unlock_session_or_qr_capability(self):
        import contextlib, io
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            _, body, _ = self.request('/api/local/session', method='POST', body=json.dumps({'code':self.code}))
            issued = json.loads(body)['session']
            self.session = issued
            self.request()
            self.module['Handler'].log_message(None, '%s', self.code)
        for value in [self.code,self.session,issued,self.qr]:
            self.assertNotIn(value, out.getvalue()+err.getvalue())

    def test_U1_independent_process_without_session_cannot_read_or_mutate_any_owner_api(self):
        response = Mock(status=200, headers={'Content-Type':'application/json'})
        response.read.return_value = b'{}'
        script = '''import http.client,json,sys
results=[]
for method,path in [('GET','/api/team/service-login'),('GET','/api/local/service-login/qr?id=flow'),('POST','/api/team/service-login'),('DELETE','/api/team/service-login'),('POST','/api/team/ai-tokens'),('POST','/api/admin/pair')]:
 c=http.client.HTTPConnection('127.0.0.1',int(sys.argv[1]))
 c.request(method,path,body='{}' if method!='GET' else None,headers={'Host':'127.0.0.1:3391','Origin':'http://127.0.0.1:3391','X-TeamAgent-Local':'1','Content-Type':'application/json'})
 r=c.getresponse();results.append([r.status,'qr_url' in r.read().decode()]);c.close()
print(json.dumps(results))'''
        with patch('urllib.request.urlopen', return_value=response) as cloud:
            result = subprocess.run([sys.executable, '-c', script, str(self.server.server_port)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), [[401,False]]*6)
            cloud.assert_not_called()

if __name__ == '__main__': unittest.main()
