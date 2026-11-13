#!/usr/bin/env python3
"""OS-user unlock codes and memory-only local owner sessions. Never print secrets."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import threading
import time
import uuid

TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')

def now_ms():
    return int(time.time() * 1000)

def code_directory(runtime):
    return Path(runtime) / 'state/owner-unlock'

def expiry_of(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 256:
            return None
        value = json.load(stream)
    expiry = value.get('expires_at') if isinstance(value, dict) else None
    return expiry if isinstance(expiry, int) else None

def cleanup_unlock_pages(runtime):
    directory = Path(runtime) / 'tmp'
    for path in directory.glob('unlock-*.html'):
        if not re.fullmatch(r'unlock-[a-f0-9]{32}\.html', path.name):
            continue
        try:
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_mtime <= time.time() - 10:
                path.unlink(missing_ok=True)
        except OSError:
            pass

def mint_code(runtime):
    cleanup_unlock_pages(runtime)
    directory = code_directory(runtime)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    for path in directory.glob('*.json'):
        if not re.fullmatch(r'[a-f0-9]{64}\.json', path.name):
            continue
        try:
            expiry = expiry_of(path)
            if expiry is not None and expiry <= now_ms():
                path.unlink(missing_ok=True)
        except (OSError, ValueError, TypeError):
            pass
    code = secrets.token_urlsafe(32)
    path = directory / (hashlib.sha256(code.encode()).hexdigest() + '.json')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump({'expires_at': now_ms()+60000}, stream)
    return code

def redeem_code(runtime, code):
    if not isinstance(code, str) or not TOKEN.fullmatch(code):
        return False
    directory = code_directory(runtime)
    path = directory / (hashlib.sha256(code.encode()).hexdigest() + '.json')
    claimed = directory / ('.claimed-' + str(uuid.uuid4()))
    try:
        os.rename(path, claimed)
    except OSError:
        return False
    try:
        expiry = expiry_of(claimed)
        return expiry is not None and expiry > now_ms()
    except (OSError, ValueError, TypeError):
        return False
    finally:
        claimed.unlink(missing_ok=True)

class OwnerSessions:
    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()

    def issue(self):
        token = secrets.token_urlsafe(32)
        expiry = now_ms() + 12*3600000
        with self._lock:
            self._sessions = {k:v for k,v in self._sessions.items() if v > now_ms()}
            self._sessions[hashlib.sha256(token.encode()).hexdigest()] = expiry
            while len(self._sessions) > 8:
                del self._sessions[next(iter(self._sessions))]
        return token, expiry

    def valid(self, token):
        if not isinstance(token, str) or not TOKEN.fullmatch(token):
            return False
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            expiry = self._sessions.get(digest, 0)
            if expiry <= now_ms():
                self._sessions.pop(digest, None)
                return False
            return True

def main():
    runtime = Path.home() / '.inkboard-team'
    code = mint_code(runtime)
    url = 'http://127.0.0.1:3391/login#unlock=' + code
    directory = runtime / 'tmp'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    page = directory / ('unlock-' + secrets.token_hex(16) + '.html')
    fd = os.open(page, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write('<!doctype html><meta charset="utf-8"><script>location.replace(' + json.dumps(url) + ')</script>')
    try:
        if Path('/Applications/Microsoft Edge.app').exists():
            args = ['/usr/bin/open', '-a', 'Microsoft Edge', str(page)]
        else:
            args = ['/usr/bin/open', str(page)]
        subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        time.sleep(10)
        page.unlink(missing_ok=True)

if __name__ == '__main__':
    main()
