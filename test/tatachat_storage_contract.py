"""执行许可交付前的生产SQL原文；使用现有主库与授权view，不另建聊天身份库。"""
import json
import re
import sqlite3
import unittest
from pathlib import Path
import community_storage_contract as community
import auth_storage_contract as auth

ROOT = Path(__file__).resolve().parents[1]
TEXT = (ROOT / "server/cloudflare/repositories/chat_access.rs").read_text()
CURRENT = re.search(r'pub const CURRENT_SQL: &str = "([^"]+)";', TEXT)[1]


class ChatAccessStorageContract(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        community.ready(self.db)
        self.params = [f"{1:064x}", auth.IDENTITY["cid_number"], auth.FIXTURE["public_key"][2:],
                       auth.IDENTITY["account_id"], 1, auth.FIXTURE["registration_scope"],
                       auth.FIXTURE["service_origin"], auth.FIXTURE["chain_scope"], "CTZN",
                       1000003, auth.FIXTURE["issued_at"]]

    def tearDown(self):
        self.db.close()

    def current(self):
        return self.db.execute(CURRENT, self.params).fetchone()

    def test_valid_current_snapshot_matches_one_session(self):
        self.assertEqual(self.current(), (self.params[0],))

    def test_signed_during_session_deletion_cannot_be_delivered(self):
        self.db.execute("DELETE FROM square_sessions")
        self.assertIsNone(self.current())

    def test_signed_during_device_revocation_cannot_be_delivered(self):
        self.db.execute("UPDATE mls_devices SET active=0")
        self.assertIsNone(self.current())

    def test_same_public_key_reactivation_invalidates_old_device_generation(self):
        self.db.execute("UPDATE mls_devices SET issued_at=issued_at+1")
        self.assertIsNone(self.current())
        self.params[-1] += 1
        self.assertIsNotNone(self.current())

    def test_signed_during_account_rebinding_cannot_be_delivered(self):
        self.db.execute("UPDATE users SET binding_revision=binding_revision+1")
        self.assertIsNone(self.current())

    def test_no_human_admission_cannot_be_delivered(self):
        self.db.execute("DELETE FROM cid_admissions")
        self.assertIsNone(self.current())

    def test_unknown_identity_fails_closed(self):
        self.db.execute("DELETE FROM user_identity_checks")
        self.assertIsNone(self.current())

    def test_exact_expiry_future_check_and_old_identity_rejected(self):
        for value in [1000000 - 1, 1060000, 87400002]:
            with self.subTest(now=value):
                self.params[9] = value
                self.assertIsNone(self.current())

    def test_expired_session_rejected_before_cleanup(self):
        self.db.execute("UPDATE square_sessions SET expires_at=?", (self.params[9],))
        self.assertIsNone(self.current())

    def test_every_identity_scope_parameter_is_bound(self):
        for index in range(9):
            with self.subTest(index=index):
                original = self.params[index]
                self.params[index] = 2 if index == 4 else "wrong' OR 1=1 --"
                self.assertIsNone(self.current())
                self.params[index] = original

    def test_no_chat_shadow_tables_or_raw_key_storage(self):
        tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(len(tables), 39)
        self.assertTrue({'account_deletion_assert', 'account_deletion_challenges', 'account_deletions'}.issubset(tables))
        self.assertFalse(any(name.startswith('tatachat_') for name in tables))
        self.assertNotIn("TATACHAT_AUTH_KEY", auth.SCHEMA)
        for index in range(11):
            with self.subTest(index=index):
                original = self.params[index]
                self.params[index] = None
                self.assertIsNone(self.current())
                self.params[index] = original


if __name__ == "__main__":
    unittest.main()
