"""Loopback-only Bilibili QR login. Secrets stay in memory or the 0600 cookie file."""
import json
import math
import os
from pathlib import Path
import re
import secrets
import ssl
import threading
import time
import urllib.request
import urllib.error
from email.utils import parsedate_to_datetime
from local_login_qr import valid_qr_url

UA = "curl/8.7.1"
REFERER = "https://www.bilibili.com/"
GENERATE = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key="
NAMES = ("SESSDATA", "bili_jct", "DedeUserID", "buvid3")
RISK_PATH = "state/bili-risk.json"

class BiliLoginError(Exception):
    def __init__(self, reason, http=None, code=None, until=None):
        self.reason, self.http, self.code, self.until = reason, http, code, until
        super().__init__(reason)

class BiliPaused(BiliLoginError):
    def __init__(self, until=None, http=None, code=None, reason='paused'):
        super().__init__(reason, http=http, code=code, until=until)

def login_tls_context():
    paths = ('/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', ssl.get_default_verify_paths().cafile)
    for path in paths:
        if path and Path(path).is_file():
            try:
                return ssl.create_default_context(cafile=path)
            except (OSError, ValueError):
                continue
    raise BiliLoginError('certificate')

def login_error(error):
    """Only fixed labels and numeric metadata may reach the local page."""
    if isinstance(error, BiliLoginError):
        reason = error.reason
    else:
        cause = error.reason if isinstance(error, urllib.error.URLError) else error
        reason = 'certificate' if isinstance(cause, ssl.SSLError) else 'http' if isinstance(error, urllib.error.HTTPError) else 'timeout' if isinstance(cause, TimeoutError) else 'network' if isinstance(error, (OSError, urllib.error.URLError)) else 'response' if isinstance(error, (ValueError, TypeError)) else 'failed'
    messages = {
        'certificate':'B 站连接证书校验失败，请联系维护者检查本机 CA 证书',
        'http':'B 站请求失败', 'business':'B 站请求未成功',
        'risk_state':'本机风控状态文件损坏或不可读，已暂停请求，请联系维护者检查',
        'paused':'B 站风控暂停，请稍后再试',
        'timeout':'B 站连接超时，请稍后重试', 'network':'B 站网络连接失败，请检查网络',
        'response':'B 站返回的二维码或登录数据格式不正确',
        'storage':'B 站登录信息未能保存，请检查本机目录权限',
        'failed':'B 站登录未完成，请重试',
    }
    result = {'reason':reason if reason in messages else 'failed', 'error':messages.get(reason, messages['failed'])}
    http = error.code if isinstance(error, urllib.error.HTTPError) else getattr(error, 'http', None)
    code = getattr(error, 'code', None) if isinstance(error, BiliLoginError) else None
    if type(http) is int and 100 <= http <= 599:
        result['http'] = http
        result['error'] += '（HTTP ' + str(http) + '）'
    if type(code) is int and -2147483648 <= code <= 2147483647:
        result['code'] = code
        result['error'] += '（业务码 ' + str(code) + '）'
    until = error.until if isinstance(error, BiliLoginError) else None
    if isinstance(until, (int, float)) and math.isfinite(until) and until > 0:
        try:
            stamp = time.strftime('%H:%M', time.localtime(until / 1000))
            result['paused_until'] = until
            result['error'] = 'B 站风控暂停至 ' + stamp + '，请稍后再试' + result['error'].split('请稍后再试', 1)[-1] if reason == 'paused' else result['error']
        except (ValueError, OverflowError, OSError):
            pass
    return result

class LocalBiliLogin:
    def __init__(self, runtime, config):
        self.runtime = Path(runtime)
        self.config = config
        self._sessions = {}
        self._lock = threading.Lock()
        self._risk_lock = threading.Lock()
        self._bad_risk_until = 0
        self._finished = {}

    def _risk_path(self):
        return self.runtime / RISK_PATH

    def _check_pause(self):
        now = time.time() * 1000
        if self._bad_risk_until > now:
            raise BiliPaused(reason='risk_state')
        try:
            data = json.loads(self._risk_path().read_text())
            until = data.get('paused_until') if isinstance(data, dict) else None
            if type(until) not in (int, float) or not math.isfinite(until) or until < 0:
                raise ValueError('invalid risk state')
            if until > now:
                raise BiliPaused(until=until)
        except BiliPaused:
            raise
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, OverflowError):
            self._bad_risk_until = now + 60000
            raise BiliPaused(reason='risk_state')

    def _pause(self):
        path = self._risk_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = path.with_name(path.name + ".lock")
        held = False
        for _ in range(100):
            try:
                os.mkdir(lock, 0o700)
                held = True
                break
            except FileExistsError:
                try:
                    if time.time() - lock.stat().st_mtime > 30:
                        lock.rmdir()
                        continue
                except OSError:
                    pass
                time.sleep(0.01)
            except OSError:
                break
        if not held:
            self._bad_risk_until = time.time() * 1000 + 60000
            return self._bad_risk_until
        try:
            old = 0
            try:
                old = int(json.loads(path.read_text()).get("paused_until", 0))
            except (OSError, ValueError, TypeError, AttributeError, OverflowError):
                old = 0
            value = max(old, int(time.time() * 1000) + 600000)
            temp = path.with_name(path.name + ".tmp-" + secrets.token_hex(6))
            try:
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "w") as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    json.dump({"paused_until": value}, stream)
                temp.replace(path)
            except OSError:
                self._bad_risk_until = value
            finally:
                temp.unlink(missing_ok=True)
            return value
        finally:
            if held:
                try:
                    lock.rmdir()
                except OSError:
                    pass

    def _http(self, url):
        self._check_pause()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=8, context=login_tls_context()) as response:
                headers = response.headers
                body = json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code in (412, 429):
                raise BiliPaused(until=self._pause(), http=error.code)
            raise
        if not isinstance(body, dict) or type(body.get('code')) is not int:
            raise BiliLoginError('response')
        if body.get("code") in (-352, -412):
            raise BiliPaused(until=self._pause(), code=body['code'])
        if body['code'] != 0:
            raise BiliLoginError('business', code=body['code'])
        return headers, body

    @staticmethod
    def _cookies(headers, now):
        found = {}
        for line in headers.get_all("Set-Cookie") or []:
            first, *attrs = line.split(";")
            if "=" not in first:
                continue
            name, value = first.split("=", 1)
            name, value = name.strip(), value.strip()
            if name not in NAMES or not value:
                continue
            expires = -1
            for attr in attrs:
                key, _, raw = attr.partition("=")
                key, raw = key.strip().lower(), raw.strip()
                if key == "max-age" and re.fullmatch(r"-?\d+", raw):
                    expires = int(now / 1000) + int(raw)
                elif key == "expires":
                    try:
                        expires = int(parsedate_to_datetime(raw).timestamp())
                    except (TypeError, ValueError, OverflowError):
                        pass
            found[name] = {"value": value, "expires": expires}
        return found

    def _save(self, fresh):
        path = self.runtime / "secrets/bili-cookie.json"
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.parent.chmod(0o700)
        old = {}
        try:
            old = json.loads(path.read_text())
        except (OSError, ValueError, TypeError):
            old = {}
        if not isinstance(old, dict): old = {}
        selected = {name: fresh[name] for name in NAMES if name in fresh}
        if "buvid3" not in selected and isinstance(old.get("buvid3"), dict):
            selected["buvid3"] = old["buvid3"]
        if not {"SESSDATA", "bili_jct", "DedeUserID"} <= set(selected):
            raise ValueError("incomplete cookies")
        temp = path.with_name(path.name + ".tmp-" + secrets.token_hex(6))
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(selected, stream)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)

    def _report(self, state):
        try:
            config = self.config
            url = config["url"].rstrip("/") + "/api/runner/fetch/auth-status"
            body = json.dumps({"service": "bili", "state": state, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}).encode()
            req = urllib.request.Request(url, data=body, method="POST", headers={
                "Authorization": "Bearer " + config["runnerToken"],
                "Content-Type": "application/json",
            })
            with urllib.request.urlopen(req, timeout=5, context=login_tls_context()) as response:
                response.read()
        except (OSError, KeyError, ValueError, urllib.error.URLError, BiliLoginError):
            pass

    def start(self):
        with self._lock:
            active = self._sessions.get("active")
            if active and active["expires_at"] > time.time() * 1000:
                return {"id": active["id"], "qr_url": active["qr_url"], "expires_at": active["expires_at"]}
            headers, body = self._http(GENERATE)
            data = body.get("data") if body.get("code") == 0 else None
            qr_url, key = (data or {}).get("url"), (data or {}).get("qrcode_key")
            if not isinstance(qr_url, str) or not valid_qr_url(qr_url) or not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{32}", key):
                raise ValueError("invalid QR response")
            login_id = secrets.token_hex(8)
            expires = int(time.time() * 1000) + 180000
            self._sessions = {"active": {"id": login_id, "key": key, "qr_url": qr_url, "expires_at": expires}}
            return {"id": login_id, "qr_url": qr_url, "expires_at": expires}

    def status(self, login_id):
        with self._lock:
            if isinstance(login_id, str) and self._finished.get(login_id) == "ok":
                return {"phase": "ok"}
            item = self._sessions.get("active") if isinstance(login_id, str) else None
            if not item or item["id"] != login_id:
                return {"phase": "expired"}
            if item["expires_at"] <= time.time() * 1000:
                self._sessions = {}
                return {"phase": "expired"}
            key = item["key"]
            try:
                headers, body = self._http(POLL + key)
                if body.get("code") != 0:
                    return {"phase": "failed"}
                code = (body.get("data") or {}).get("code")
                if code == 0:
                    current = self._sessions.get("active")
                    if not current or current is not item or current["expires_at"] <= time.time() * 1000:
                        return {"phase": "expired"}
                    try:
                        self._save(self._cookies(headers, time.time() * 1000))
                    except (OSError, ValueError, TypeError):
                        raise BiliLoginError('storage')
                    self._sessions = {}
                    self._finished[login_id] = "ok"
                    while len(self._finished) > 16:
                        self._finished.pop(next(iter(self._finished)))
                    self._report("ok")
                    return {"phase": "ok"}
                if code == 86090:
                    return {"phase": "scanned"}
                if code == 86101:
                    return {"phase": "waiting"}
                if self._sessions.get("active") is item:
                    self._sessions = {}
                return {"phase": "expired"} if code == 86038 else {"phase":"failed", **login_error(BiliLoginError('business', code=code))}
            except BiliPaused as error:
                return {"phase": "paused", **login_error(error)}
            except (OSError, ValueError, TypeError, urllib.error.URLError, BiliLoginError) as error:
                return {"phase": "failed", **login_error(error)}

    def cancel(self, login_id):
        with self._lock:
            item = self._sessions.get("active")
            if item and item["id"] == login_id:
                self._sessions = {}
