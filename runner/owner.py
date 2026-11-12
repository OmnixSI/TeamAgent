#!/usr/bin/env python3
"""Loopback-only owner view. Team invitations use the separate authenticated cloud site."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import os, json, urllib.request, urllib.error, ssl
from urllib.parse import urlsplit
from local_login_qr import read_local_qr, clear_local_qr

C = json.loads((Path.home() / ".inkboard-team/config.json").read_text())


class Handler(BaseHTTPRequestHandler):
    runtime = Path.home() / '.inkboard-team'
    def log_message(self, *a):
        pass

    def proxy(self):
        if (
            self.headers.get("Host") != "127.0.0.1:3391"
            or self.headers.get("Origin", "http://127.0.0.1:3391")
            != "http://127.0.0.1:3391"
        ):
            self.send_error(403)
            return
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
        req = urllib.request.Request(
            C["url"] + self.path,
            data=body,
            method=self.command,
            headers={
                "Authorization": "Bearer " + C["adminToken"],
                "Content-Type": "application/json",
                "User-Agent": "InkBoard-Team/1",
            },
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
