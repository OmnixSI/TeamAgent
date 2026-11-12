"""Private, expiring QR display transport. This module never contacts the cloud."""
import json
import math
import os
from pathlib import Path
import re
import stat
import time
from urllib.parse import urlsplit, parse_qs

def qr_path(runtime, login_id):
    if not isinstance(login_id, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', login_id):
        raise ValueError('invalid local login')
    return Path(runtime) / 'state/login-qr' / ('bili-' + login_id + '.json')

def valid_qr_url(raw):
    if not isinstance(raw, str) or len(raw) > 240:
        return False
    try:
        u = urlsplit(raw)
        if u.scheme != 'https' or u.username or u.password or u.port not in (None, 443) or u.fragment:
            return False
        if u.hostname == 'b23.tv':
            return bool(re.fullmatch(r'/[A-Za-z0-9]{4,12}', u.path)) and not u.query
        if u.hostname not in ('passport.bilibili.com', 'www.bilibili.com', 'account.bilibili.com') or u.path not in ('/h5-app/passport/login/scan', '/qrcode/h5/login', '/h5/account-h5/auth/scan-web'):
            return False
        fields = parse_qs(u.query, keep_blank_values=True)
        if set(fields) - {'qrcode_key','oauthKey','navhide','from','callback'} or any(len(v) != 1 for v in fields.values()):
            return False
        key = 'oauthKey' if u.path == '/qrcode/h5/login' else 'qrcode_key'
        return bool(re.fullmatch(r'[a-f0-9]{32}', fields.get(key, [''])[0])) and ('qrcode_key' if key == 'oauthKey' else 'oauthKey') not in fields and fields.get('navhide', ['1']) == ['1'] and fields.get('from', ['']) == [''] and fields.get('callback', ['close']) == ['close']
    except (ValueError, TypeError):
        return False

def read_local_qr(runtime, query_string):
    query = parse_qs(query_string, keep_blank_values=True)
    if set(query) != {'id'} or len(query['id']) != 1:
        return 400, {'error':'invalid local login'}
    try:
        login_id = query['id'][0]
        file = qr_path(runtime, login_id)
    except ValueError:
        return 400, {'error':'invalid local login'}
    try:
        fd = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'r') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 2048:
                return 404, {'error':'二维码暂未就绪'}
            qr = json.load(stream)
        if not isinstance(qr, dict):
            return 404, {'error':'二维码暂未就绪'}
        expires = qr.get('expires_at')
        if qr.get('id') != login_id or qr.get('service') != 'bili' or not isinstance(expires, (int,float)) or not math.isfinite(expires) or expires <= time.time()*1000 or not valid_qr_url(qr.get('qr_url')):
            return 404, {'error':'二维码暂未就绪或已过期'}
        return 200, {'id':login_id,'qr_url':qr['qr_url'],'expires_at':expires}
    except (OSError, ValueError, TypeError):
        return 404, {'error':'二维码暂未就绪'}

def clear_local_qr(runtime, login_id):
    try:
        qr_path(runtime, login_id).unlink(missing_ok=True)
    except (ValueError, OSError):
        pass
