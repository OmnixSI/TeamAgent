"""Plan U2/U5/U8/U9: temporary runtime, no real credentials or browser launch."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('owner_unlock_unit', ROOT / 'runner/owner_unlock.py')
unlock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unlock)

class OwnerUnlockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / '.inkboard-team'

    def code_path(self, code):
        return self.runtime / 'state/owner-unlock' / (hashlib.sha256(code.encode()).hexdigest()+'.json')

    def test_U2_invalid_used_expired_insecure_symlink_and_other_uid_codes_fail(self):
        for code in ['', 'x'*42, 'x'*44, '!'*43, 'a'*43]:
            self.assertFalse(unlock.redeem_code(self.runtime, code))
        code = unlock.mint_code(self.runtime)
        self.assertTrue(unlock.redeem_code(self.runtime, code))
        self.assertFalse(unlock.redeem_code(self.runtime, code))
        code = unlock.mint_code(self.runtime)
        with patch.object(unlock.time, 'time', return_value=unlock.time.time()+61):
            self.assertFalse(unlock.redeem_code(self.runtime, code))
        code = unlock.mint_code(self.runtime)
        self.code_path(code).chmod(0o644)
        self.assertFalse(unlock.redeem_code(self.runtime, code))
        code = unlock.mint_code(self.runtime)
        file = self.code_path(code)
        target = file.with_suffix('.target')
        file.rename(target)
        file.symlink_to(target)
        self.assertFalse(unlock.redeem_code(self.runtime, code))
        code = unlock.mint_code(self.runtime)
        actual_uid = os.getuid()
        with patch.object(unlock.os, 'getuid', return_value=actual_uid+1):
            self.assertFalse(unlock.redeem_code(self.runtime, code))

    def test_U5_sessions_expire_at_twelve_hours_evict_oldest_and_restart_revokes(self):
        store = unlock.OwnerSessions()
        tokens = [store.issue()[0] for _ in range(9)]
        self.assertFalse(store.valid(tokens[0]))
        self.assertTrue(all(store.valid(t) for t in tokens[1:]))
        self.assertFalse(store.valid('a'*43))
        self.assertFalse(unlock.OwnerSessions().valid(tokens[-1]))
        with patch.object(unlock.time, 'time', return_value=unlock.time.time()+12*3600+1):
            self.assertFalse(store.valid(tokens[-1]))

    def test_U8_code_permissions_one_time_atomic_claim_and_expired_cleanup(self):
        code = unlock.mint_code(self.runtime)
        file = self.code_path(code)
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(file.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(set(json.loads(file.read_text())), {'expires_at'})
        self.assertNotIn(code, file.read_text())
        with ThreadPoolExecutor(max_workers=2) as pool:
            result = list(pool.map(lambda _: unlock.redeem_code(self.runtime, code), range(2)))
        self.assertEqual(result.count(True), 1)
        self.assertFalse(file.exists())
        self.assertEqual(list(file.parent.glob('.claimed-*')), [])
        old = unlock.mint_code(self.runtime)
        with patch.object(unlock.time, 'time', return_value=unlock.time.time()+61):
            unlock.mint_code(self.runtime)
        self.assertFalse(self.code_path(old).exists())

    def test_U9_desktop_open_passes_code_only_in_fragment_and_prints_nothing(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {'HOME':self.temp.name}), patch.object(unlock.subprocess, 'run') as run, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            unlock.main()
        args = run.call_args.args[0]
        self.assertEqual(args[0], '/usr/bin/open')
        url = urlsplit(args[1])
        self.assertEqual((url.scheme,url.netloc,url.path,url.query), ('http','127.0.0.1:3391','/',''))
        self.assertRegex(url.fragment, r'^unlock=[A-Za-z0-9_-]{43}$')
        self.assertEqual(out.getvalue()+err.getvalue(), '')
        self.assertIsNotNone(run.call_args.kwargs.get('stderr'))

if __name__ == '__main__': unittest.main()
