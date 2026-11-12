#!/usr/bin/env python3
"""Loopback-only owner view. Team invitations use the separate authenticated cloud site."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import os, json, re, urllib.request, urllib.error, ssl, shutil, subprocess, time, math
from urllib.parse import urlsplit, parse_qs
from local_login_qr import read_local_qr, clear_local_qr
from local_bili_login import BiliPaused, LocalBiliLogin, login_error
from local_login_page import PAGE
from owner_unlock import redeem_code, mint_code, OwnerSessions

C = json.loads((Path.home() / ".inkboard-team/config.json").read_text())


class Handler(BaseHTTPRequestHandler):
    runtime = Path.home() / '.inkboard-team'
    sessions = OwnerSessions()
    bili_login = None
    def log_message(self, *a):
        pass

    def parse_request(self):
        # Validate before BaseHTTPRequestHandler can collapse a leading //.
        self.request_version = 'HTTP/1.0'
        self.command = None
        self.requestline = ''
        self.close_connection = True
        line = re.fullmatch(rb'([A-Z]+) ([\x21-\x7e]+) HTTP/1\.[01]\r\n', self.raw_requestline)
        if line:
            target = line[2].decode('ascii')
            if target.startswith('/') and not target.startswith('//') and not any(c in target for c in ('\\', '#')):
                parsed = urlsplit(target)
                path = parsed.path
                if not parsed.scheme and not parsed.netloc and not any(c in path for c in ('%', '..', '//')) and '.' not in path.split('/'):
                    # All dispatch, authorization and forwarding use these same values.
                    self.route_path = path
                    self.route_query = parsed.query
                    self.route_target = path + ('?' + parsed.query if parsed.query else '')
                    return super().parse_request()
        self.local_json(400, {'error':'无效的请求路径'})
        return False

    def local_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(data)

    def local_page(self):
        data = PAGE.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html;charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def bili(self):
        if self.__class__.bili_login is None:
            self.__class__.bili_login = LocalBiliLogin(self.runtime, C)
        return self.__class__.bili_login

    def local_action(self):
        if self.headers.get('X-TeamAgent-Local') != '1' or not self.sessions.valid(self.headers.get('X-TeamAgent-Session')):
            self.local_json(401, {'error':'本机开发台未解锁'})
            return False
        return True

    def open_login(self):
        code = mint_code(self.runtime)
        url = 'http://127.0.0.1:3391/login#unlock=' + code
        edge = '/Applications/Microsoft Edge.app'
        try:
            if Path(edge).exists():
                subprocess.run(['/usr/bin/open', '-a', 'Microsoft Edge', url], timeout=5, check=True)
            else:
                subprocess.run(['/usr/bin/open', url], timeout=5, check=True)
        except (OSError, subprocess.SubprocessError):
            return self.local_json(503, {'error':'无法打开浏览器'})
        return self.local_json(200, {'opened': True})

    def open_x(self):
        info = self.x_status()
        if info.get('phase') in ('starting','waiting','debug_unavailable') and info.get('expires_at', 0) > time.time()*1000:
            return self.local_json(200, {'opened': True})
        node = shutil.which('node') or '/opt/homebrew/bin/node'
        fetcher = self.runtime / 'fetcher.mjs'
        if not Path(node).exists() or not fetcher.exists():
            return self.local_json(503, {'error':'X 登录组件未安装'})
        try:
            (self.runtime / 'state/x-login.json').unlink(missing_ok=True)
            subprocess.Popen([node, str(fetcher), 'login', 'x'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            return self.local_json(503, {'error':'X 登录组件未安装'})
        return self.local_json(200, {'opened': True})

    def x_status(self):
        errors = {
            'browser_missing':'未找到 Edge 或 Chrome，请先安装浏览器',
            'debug_unavailable':'浏览器调试端口不可用，请在打开的窗口登录后点击“我已登录”重试；若仍失败，请检查浏览器调试策略',
            'not_logged_in':'未检测到 X 登录态，请在浏览器中完成登录后重试',
            'window_closed':'登录窗口已关闭，请重新打开',
        }
        try:
            path = self.runtime / 'state/x-login.json'
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as stream:
                info = os.fstat(stream.fileno())
                if info.st_size > 4096 or info.st_mode & 0o077:
                    raise ValueError('invalid status')
                data = json.load(stream)
            phase = data.get('phase')
            if phase not in ('starting','waiting','debug_unavailable','ok','failed'):
                raise ValueError('invalid phase')
            result = {'phase':phase}
            reason = data.get('reason')
            if reason in errors:
                result['reason'] = reason
                if phase in ('failed','debug_unavailable'):
                    result['error'] = errors[reason]
            expiry = data.get('expires_at')
            if type(expiry) in (int,float) and math.isfinite(expiry):
                result['expires_at'] = expiry
                if phase in ('starting','waiting','debug_unavailable') and expiry <= time.time()*1000:
                    result.update(phase='failed',reason='not_logged_in',error=errors['not_logged_in'])
            metadata = data.get('metadata', {})
            title = metadata.get('title')
            title = title if title in ('X','Twitter','登录 X','登录 / X','Log in to X','Something went wrong','X / X') else '其他页面（标题已隐藏）'
            http = metadata.get('http')
            present = metadata.get('auth_token_present')
            result['metadata'] = {'title':title,'http':http if type(http) is int and 100 <= http <= 599 else None,'auth_token_present':present if type(present) is bool else None}
            return result
        except FileNotFoundError:
            return {'phase':'missing'}
        except (OSError, ValueError, TypeError, AttributeError):
            return {'phase':'failed','reason':'debug_unavailable','error':errors['debug_unavailable']}

    def confirm_x(self):
        if self.x_status().get('phase') not in ('waiting','debug_unavailable'):
            return self.local_json(409, {'error':'未检测到登录窗口，请先打开 X 登录'})
        path = self.runtime / 'state/x-login-confirm'
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write('retry')
        except OSError:
            return self.local_json(503, {'error':'本机登录目录不可写，请联系维护者检查'})
        return self.local_json(200, {'checking':True})

    def unlock(self):
        message = {'error':'解锁码无效或已过期'}
        if self.headers.get('Origin') != 'http://127.0.0.1:3391' or self.headers.get('X-TeamAgent-Local') != '1':
            return self.local_json(403, message)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 256:
                return self.local_json(403, message)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or not redeem_code(self.runtime, body.get('code')):
                return self.local_json(403, message)
        except (ValueError, TypeError, OSError):
            return self.local_json(403, message)
        session, expiry = self.sessions.issue()
        return self.local_json(200, {'session':session,'expires_at':expiry})

    def proxy(self):
        if (
            self.headers.get("Host") != "127.0.0.1:3391"
            or self.headers.get("Origin", "http://127.0.0.1:3391")
            != "http://127.0.0.1:3391"
        ):
            self.send_error(403)
            return
        if self.route_path == '/login' and self.command == 'GET':
            return self.local_page()
        if self.route_path == '/api/local/session' and self.command == 'POST':
            return self.unlock()
        if self.route_path in ('/api/local/bili/start','/api/local/bili/status','/api/local/x/open','/api/local/x/status','/api/local/x/confirm','/api/local/open-login'):
            if not self.local_action():
                return
            if self.route_path == '/api/local/bili/start':
                if self.command != 'POST':
                    return self.send_error(405)
                try:
                    return self.local_json(200, self.bili().start())
                except BiliPaused as error:
                    return self.local_json(503, login_error(error))
                except Exception as error:
                    return self.local_json(502, login_error(error))
            if self.route_path == '/api/local/bili/status':
                if self.command != 'GET':
                    return self.send_error(405)
                query = parse_qs(self.route_query, keep_blank_values=True)
                if set(query) != {'id'} or len(query['id']) != 1:
                    return self.local_json(400, {'error':'无效登录'})
                return self.local_json(200, self.bili().status(query['id'][0]))
            if self.route_path == '/api/local/x/status':
                return self.local_json(200, self.x_status()) if self.command == 'GET' else self.send_error(405)
            if self.route_path == '/api/local/x/confirm':
                return self.confirm_x() if self.command == 'POST' else self.send_error(405)
            if self.command != 'POST':
                return self.send_error(405)
            return self.open_login() if self.route_path == '/api/local/open-login' else self.open_x()
        if self.route_path not in ('/', '/guide') and not self.sessions.valid(self.headers.get('X-TeamAgent-Session')):
            return self.local_json(401, {'error':'本机开发台未解锁'})
        if self.route_path == '/api/local/service-login/qr':
            if self.headers.get('X-TeamAgent-Local') != '1':
                self.send_error(403)
                return
            if self.command != 'GET':
                self.send_error(405)
                return
            status, payload = read_local_qr(self.runtime, self.route_query)
            return self.local_json(status, payload)
        if not (
            self.route_path in ("/", "/guide")
            or self.route_path.startswith(("/api/team/", "/api/admin/"))
        ):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 262144:
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else None
        headers = {'Content-Type':'application/json', 'User-Agent':'InkBoard-Team/1'}
        if self.route_path not in ('/', '/guide'):
            headers['Authorization'] = 'Bearer ' + C['adminToken']
        req = urllib.request.Request(
            C["url"] + self.route_target,
            data=body,
            method=self.command,
            headers=headers,
        )
        try:
            r = urllib.request.urlopen(
                req,
                context=ssl.create_default_context(
                    cafile=(
                        "/etc/ssl/cert.pem"
                        if os.path.exists("/etc/ssl/cert.pem")
                        else None
                    )
                ),
                timeout=30,
            )
        except urllib.error.HTTPError as e:
            r = e
        data = r.read()
        if self.route_path == '/api/team/service-login' and self.command == 'DELETE' and r.status == 200:
            try:
                cancelled = json.loads(body)
                if cancelled.get('service') == 'bili':
                    clear_local_qr(self.runtime, cancelled.get('id'))
            except (ValueError, TypeError):
                pass
        self.send_response(r.status)
        self.send_header(
            "Content-Type", r.headers.get("Content-Type", "application/json")
        )
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if r.headers.get("Content-Security-Policy"):
            self.send_header(
                "Content-Security-Policy", r.headers["Content-Security-Policy"]
            )
        self.end_headers()
        self.wfile.write(data)

    do_GET = proxy
    do_POST = proxy
    do_PATCH = proxy
    do_DELETE = proxy


ThreadingHTTPServer(("127.0.0.1", 3391), Handler).serve_forever()
