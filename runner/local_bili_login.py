"""Loopback-only Bilibili QR login. Secrets stay in memory or the 0600 cookie file."""
import json
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

class BiliPaused(Exception):
    pass

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
            raise BiliPaused()
        try:
            data = json.loads(self._risk_path().read_text())
            if float(data.get("paused_until", 0)) > now:
                raise BiliPaused()
        except BiliPaused:
            raise
        except OSError:
            pass
        except (ValueError, TypeError):
            self._bad_risk_until = now + 60000
            raise BiliPaused()

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
                time.sleep(0.01)
            except OSError:
                break
        try:
            old = 0
            try:
                old = int(json.loads(path.read_text()).get("paused_until", 0))
            except (OSError, ValueError, TypeError, AttributeError):
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
                pass
            finally:
                temp.unlink(missing_ok=True)
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
            with urllib.request.urlopen(req, timeout=8, context=ssl.create_default_context()) as response:
                headers = response.headers
                body = json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code in (412, 429):
                self._pause()
                raise BiliPaused()
            raise
        if body.get("code") in (-352, -412):
            self._pause()
            raise BiliPaused()
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
            with urllib.request.urlopen(req, timeout=5, context=ssl.create_default_context()) as response:
                response.read()
        except (OSError, KeyError, ValueError, urllib.error.URLError):
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
                    self._sessions = {}
                    self._finished[login_id] = "ok"
                    while len(self._finished) > 16:
                        self._finished.pop(next(iter(self._finished)))
                    self._save(self._cookies(headers, time.time() * 1000))
                    self._report("ok")
                    return {"phase": "ok"}
                if code == 86090:
                    return {"phase": "scanned"}
                if code == 86101:
                    return {"phase": "waiting"}
                if self._sessions.get("active") is item:
                    self._sessions = {}
                return {"phase": "expired" if code == 86038 else "failed"}
            except BiliPaused:
                return {"phase": "paused"}
            except (OSError, ValueError, TypeError, urllib.error.URLError):
                return {"phase": "failed"}

    def cancel(self, login_id):
        with self._lock:
            item = self._sessions.get("active")
            if item and item["id"] == login_id:
                self._sessions = {}
