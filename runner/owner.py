#!/usr/bin/env python3
"""Loopback-only owner view. Team invitations use the separate authenticated cloud site."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import os, json, urllib.request, urllib.error, ssl
from urllib.parse import urlsplit
from local_login_qr import read_local_qr, clear_local_qr
from owner_unlock import redeem_code, OwnerSessions

C = json.loads((Path.home() / ".inkboard-team/config.json").read_text())


class Handler(BaseHTTPRequestHandler):
    runtime = Path.home() / '.inkboard-team'
    sessions = OwnerSessions()
    def log_message(self, *a):
        pass

    def local_json(self, status, payload):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

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
        if self.path == '/api/local/session' and self.command == 'POST':
            return self.unlock()
        if self.path.startswith('/api/') and not self.sessions.valid(self.headers.get('X-TeamAgent-Session')):
            return self.local_json(401, {'error':'本机开发台未解锁'})
        if urlsplit(self.path).path == '/api/local/service-login/qr':
            if self.headers.get('X-TeamAgent-Local') != '1':
                self.send_error(403)
                return
            if self.command != 'GET':
                self.send_error(405)
                return
            status, payload = read_local_qr(self.runtime, self.path)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
            return
        if not (
            self.path in ("/", "/guide")
            or self.path.startswith(("/api/team/", "/api/admin/"))
        ):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 262144:
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else None
        headers = {'Content-Type':'application/json', 'User-Agent':'InkBoard-Team/1'}
        if self.path not in ('/', '/guide'):
            headers['Authorization'] = 'Bearer ' + C['adminToken']
        req = urllib.request.Request(
            C["url"] + self.path,
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
        if self.path == '/api/team/service-login' and self.command == 'DELETE' and r.status == 200:
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
