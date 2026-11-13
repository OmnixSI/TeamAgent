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

    def test_B1_desktop_open_uses_private_file_and_removes_it_after_ten_seconds(self):
        code = 'FakeUnlockCodeForArgvCheck' + 'a' * 18
        out, err = io.StringIO(), io.StringIO()
        paths = []
        def opened(args, **kwargs):
            self.assertEqual(args[0], '/usr/bin/open')
            self.assertNotIn(code, ' '.join(args))
            path = Path(args[-1]); paths.append(path)
            self.assertEqual(path.parent, self.runtime / 'tmp')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertIn("location.replace(\"http://127.0.0.1:3391/login#unlock=" + code + "\")", path.read_text())
            self.assertIsNotNone(kwargs.get('stderr'))
        with patch.dict(os.environ, {'HOME':self.temp.name}), patch.object(unlock, 'mint_code', return_value=code), patch.object(unlock.subprocess, 'run', side_effect=opened), patch.object(unlock.time, 'sleep') as sleep, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            unlock.main()
        sleep.assert_called_once_with(10)
        self.assertFalse(paths[0].exists())
        self.assertEqual(out.getvalue()+err.getvalue(), '')

    def test_B1_mint_cleans_only_expired_unlock_html(self):
        directory = self.runtime / 'tmp'; directory.mkdir(parents=True)
        old = directory / ('unlock-' + 'a'*32 + '.html')
        fresh = directory / ('unlock-' + 'b'*32 + '.html')
        other = directory / 'other.html'
        for path in (old, fresh, other): path.write_text('synthetic')
        os.utime(old, (0, 0)); os.utime(other, (0, 0))
        unlock.mint_code(self.runtime)
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists()); self.assertTrue(other.exists())

if __name__ == '__main__': unittest.main()
