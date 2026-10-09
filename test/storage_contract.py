"""执行Cloudflare运行仓直接使用的SQLite SQL；不把此结果冒充线上D1验收。"""
import concurrent.futures
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / "server/cloudflare/schema.sql").read_text()
CREATE = (ROOT / "server/cloudflare/sql/create_registration.sql").read_text()
CAS = (ROOT / "server/cloudflare/sql/cas_registration.sql").read_text()


def record(index, context="0x" + "a" * 64, deadline=1600000):
    eid = f"00000000-0000-4000-8000-{index:012d}"
    vid = f"11111111-1111-4111-8111-{index:012d}"
    return {"enrollment_id": eid, "registration_context_hash": context,
            "state": "prepared", "version": 0, "created_at_millis": 1000000,
            "expires_at_millis": deadline, "recovery_hash": "b" * 64,
            "attempt": {"verification_id": vid, "page_hash": "c" * 64}}


def parameters(row, now=1000001):
    return (row["enrollment_id"], row["registration_context_hash"], row["state"],
            row["version"], row["created_at_millis"], row["expires_at_millis"],
            row["attempt"]["verification_id"], json.dumps(row), now)


def cas_parameters(before, after, now=1000001):
    return (after["state"], after["version"], after["expires_at_millis"],
            after["attempt"]["verification_id"], json.dumps(after),
            before["enrollment_id"], before["version"], before["state"],
            before["registration_context_hash"], now)


class StorageContract(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SCHEMA)

    def tearDown(self):
        self.db.close()

    def test_schema_is_repeatable_and_preserves_business_data_model(self):
        self.db.executescript(SCHEMA)
        tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        self.assertEqual(len(tables), 39)  # 包含账户注销的挑战、任务和断言；下载DB独立。
        self.assertTrue({'account_deletion_assert', 'account_deletion_challenges', 'account_deletions'}.issubset({row[0] for row in tables}))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)
        download = sqlite3.connect(":memory:")
        download.executescript((ROOT / "server/cloudflare/download-schema.sql").read_text())
        download.executescript((ROOT / "server/cloudflare/download-schema.sql").read_text())
        self.assertEqual(download.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0], 1)
        download.close()

    def test_same_context_has_eight_live_entries(self):
        counts = [self.db.execute(CREATE, parameters(record(i))).rowcount for i in range(9)]
        self.assertEqual(counts, [1] * 8 + [0])
        self.assertEqual(self.db.execute(CREATE, parameters(record(20, "0x" + "d" * 64))).rowcount, 1)

    def test_expired_records_release_capacity_before_cleanup(self):
        for i in range(8):
            self.db.execute(CREATE, parameters(record(i, deadline=1000002)))
        self.assertEqual(self.db.execute(CREATE, parameters(record(9), now=1000002)).rowcount, 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM registration_enrollments").fetchone()[0], 9)

    def test_cancelled_and_expired_do_not_use_pending_capacity(self):
        for i in range(8):
            self.db.execute(CREATE, parameters(record(i)))
        for i, state in enumerate(["cancelled", "expired"]):
            before = record(i)
            after = {**before, "state": state, "version": 1}
            self.assertEqual(self.db.execute(CAS, cas_parameters(before, after)).rowcount, 1)
        for i in [10, 11]:
            self.assertEqual(self.db.execute(CREATE, parameters(record(i))).rowcount, 1)
        self.assertEqual(self.db.execute(CREATE, parameters(record(12))).rowcount, 0)

    def test_stale_cas_cannot_overwrite_stored_success(self):
        before = record(1)
        self.db.execute(CREATE, parameters(before))
        success = {**before, "state": "human_verified", "version": 1, "expires_at_millis": 87400000}
        failed = {**before, "version": 1}
        self.assertEqual(self.db.execute(CAS, cas_parameters(before, success)).rowcount, 1)
        self.assertEqual(self.db.execute(CAS, cas_parameters(before, failed)).rowcount, 0)
        self.assertEqual(self.db.execute("SELECT state FROM registration_enrollments").fetchone()[0], "human_verified")

    def test_expired_cas_is_rejected_without_cleanup(self):
        before = record(1)
        self.db.execute(CREATE, parameters(before))
        after = {**before, "version": 1}
        self.assertEqual(self.db.execute(CAS, cas_parameters(before, after, now=1600000)).rowcount, 0)

    def test_json_index_mismatch_and_raw_secret_are_rejected(self):
        row = record(1)
        bad = list(parameters(row))
        bad[7] = json.dumps({**row, "state": "activated"})
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(CREATE, bad)
        bad[7] = json.dumps({**row, "recovery_token": "secret-must-never-be-persisted"})
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(CREATE, bad)
        del row["recovery_hash"]
        bad[7] = json.dumps(row)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(CREATE, bad)

    def test_actual_global_capacity_boundary_is_one_hundred_thousand(self):
        # 使用准确生产SQL边界与真实行数；不把100000改成较小测试参数。
        insert = "INSERT INTO registration_enrollments VALUES (?,?,?,?,?,?,?,?)"
        self.db.executemany(insert, (parameters(record(i, "0x" + f"{i:064x}"))[:8] for i in range(100000)))
        self.assertEqual(self.db.execute(CREATE, parameters(record(100001, "0x" + "f" * 64))).rowcount, 0)
        self.db.execute("DELETE FROM registration_enrollments WHERE enrollment_id=?", (record(0)["enrollment_id"],))
        self.assertEqual(self.db.execute(CREATE, parameters(record(100001, "0x" + "f" * 64))).rowcount, 1)

    def test_parallel_connections_cannot_exceed_context_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registration.sqlite"
            db = sqlite3.connect(path)
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            db.close()

            def create(index):
                with sqlite3.connect(path, timeout=15) as connection:
                    return connection.execute(CREATE, parameters(record(index))).rowcount

            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
                results = list(executor.map(create, range(16)))
            self.assertEqual(sum(results), 8)


if __name__ == "__main__":
    unittest.main()

class ExternalSchemaContract(unittest.TestCase):
    def test_relay_active_claim_and_financial_unique_evidence_survive_repeat_ddl(self):
        db=sqlite3.connect(':memory:');db.executescript(SCHEMA);db.executescript(SCHEMA)
        columns={r[1] for r in db.execute('PRAGMA table_info(topup_orders)')}
        self.assertTrue({'intent_hash','payer_authorization_hash','evm_block_hash','gmb_evidence_hash'}.issubset(columns))
        indexes={r[1] for r in db.execute('PRAGMA index_list(topup_orders)')}
        self.assertIn('idx_topup_paid_gmb',indexes)
        self.assertIn('active_claim',{r[1] for r in db.execute('PRAGMA table_info(chain_extrinsic_relays)')})
        self.assertEqual(db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0],39);db.close()
