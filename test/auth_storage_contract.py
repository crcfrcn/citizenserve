"""运行适配层使用的真实SQL；SQLite并发/事务验收，不冒充线上D1。"""
import concurrent.futures
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / "server/cloudflare/schema.sql").read_text()
SQL = ROOT / "server/cloudflare/sql"
IDENTITY = json.loads((ROOT / "test/contract/finalized_identity.json").read_text())
FIXTURE = json.loads((ROOT / "test/contract/activation.json").read_text())


def statements(name):
    return (SQL / name).read_text().split("-- statement")[1:]


def project(db, identity=IDENTITY):
    with db:
        for statement in statements("project_identity.sql")[:3]:
            db.execute(statement, (json.dumps(identity), identity["registered_block_hash"]) if "?2" in statement else (json.dumps(identity),))


def enrollment():
    return {"enrollment_id": FIXTURE["enrollment_id"], "registration_context_hash": "0x" + "a" * 64,
            "account_id": IDENTITY["account_id"], "institution": "CTZN", "registration_scope": FIXTURE["registration_scope"],
            "service_origin": FIXTURE["service_origin"], "chain_scope": FIXTURE["chain_scope"],
            "recovery_hash": "b" * 64, "state": "human_verified", "version": 2, "created_at_millis": 900000,
            "expires_at_millis": 87300000, "human_verified_at_millis": FIXTURE["human_verified_at_millis"],
            "activation": None, "attempt": {"verification_id": "11111111-1111-4111-8111-000000000001", "page_hash": "c" * 64}}


def seed(db):
    db.executescript(SCHEMA)
    project(db)
    row = enrollment()
    db.execute("INSERT INTO registration_enrollments VALUES(?,?,?,?,?,?,?,?)",
               (row["enrollment_id"], row["registration_context_hash"], row["state"], row["version"], row["created_at_millis"], row["expires_at_millis"], row["attempt"]["verification_id"], json.dumps(row)))
    db.commit()


def command():
    device = {"cid_number": IDENTITY["cid_number"], "device_id": FIXTURE["public_key"][2:], "public_key": FIXTURE["public_key"],
              "account_id": IDENTITY["account_id"], "binding_revision": 1, "issued_at": FIXTURE["issued_at"],
              "created_at": 1000001, "updated_at": 1000001, "active": True}
    row = enrollment()
    row["state"] = "activated"
    row["version"] += 1
    row["activation"] = {k: device[k] for k in ["cid_number", "account_id", "binding_revision", "device_id", "public_key"]}
    return {"identity": copy.deepcopy(IDENTITY), "device": device,
            "config": {k: FIXTURE[k] for k in ["registration_scope", "service_origin", "chain_scope"]},
            "enrollment": row, "before_version": 2, "now": 1000001}


def activate(db, cmd=None):
    with db:
        for statement in statements("activate_device.sql"):
            db.execute(statement, (json.dumps(cmd or command()),))


def challenge(db, nonce="0x" + "7" * 64, purpose="registration", target="/api/user/devices", now=1000001, session_hash=None):
    proof = {"challenge": nonce, "user_id": IDENTITY["cid_number"], "device_id": FIXTURE["public_key"][2:],
             "public_key": FIXTURE["public_key"], "account_id": IDENTITY["account_id"], "binding_revision": 1,
             "service_origin": FIXTURE["service_origin"], "method": "POST", "request_target": target,
             "body_sha256": "0x" + "d" * 64, "expires_at_millis": now + 300000}
    count = db.execute((SQL / "issue_mls_challenge.sql").read_text(), (json.dumps(proof), purpose, session_hash, now)).rowcount
    db.commit()
    return proof, count


def consume(db, proof, purpose="registration", now=1000002):
    row = {"proof": proof, "purpose": purpose, "session_token_hash": None, "now": now}
    count = db.execute((SQL / "consume_mls_challenge.sql").read_text(), (json.dumps(row),)).rowcount
    db.commit()
    return count


def issue_session(db, token, now=1000002):
    c = command()
    s = {"session_token_hash": f"{token:064x}", "cid_number": IDENTITY["cid_number"], "binding_revision": 1,
         "account_id": IDENTITY["account_id"], "device_id": FIXTURE["public_key"][2:], "created_at": now, "expires_at": now + 86400000}
    with db:
        for statement in statements("issue_session.sql"):
            db.execute(statement, (json.dumps({"session": s, "config": c["config"], "now": now}),))


class AuthStorageContract(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        seed(self.db)

    def tearDown(self):
        self.db.close()

    def test_success_commits_admission_device_and_activation(self):
        activate(self.db)
        self.assertEqual(self.db.execute("SELECT state FROM registration_enrollments").fetchone()[0], "activated")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cid_admissions").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT active FROM mls_devices").fetchone()[0], 1)

    def test_missing_device_tuple_fails_closed_in_database_assertion(self):
        cmd=command()
        cmd["device"].pop("account_id")
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db,cmd)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM mls_devices").fetchone()[0],0)

    def test_request_challenge_cannot_outlive_its_session(self):
        activate(self.db)
        issue_session(self.db,1)
        token_hash=f"{1:064x}"
        proof,_=challenge(self.db,purpose="request",target="/api/user/profiles/me",session_hash=token_hash)
        command_json=json.dumps({"proof":proof,"purpose":"request","session_token_hash":token_hash,"now":1000002})
        sql=(SQL / "consume_mls_challenge.sql").read_text()
        self.db.execute("DELETE FROM square_sessions")
        self.db.commit()
        self.assertEqual(self.db.execute(sql,(command_json,)).rowcount,0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM mls_authentication_challenges").fetchone()[0],1)

    def test_zero_row_registration_cas_cannot_activate(self):
        row = enrollment()
        after = command()["enrollment"]
        params = ("activated", 3, row["expires_at_millis"], row["attempt"]["verification_id"], json.dumps(after), row["enrollment_id"], 2, "human_verified", row["registration_context_hash"], 1000001)
        self.assertEqual(self.db.execute((SQL / "cas_registration.sql").read_text(), params).rowcount, 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM mls_devices").fetchone()[0], 0)

    def test_prepared_expired_wrong_scope_and_wrong_institution_fail_before_writes(self):
        for field, value in [("state", "prepared"), ("expires_at_millis", 1000001), ("registration_scope", "citizenserve:other"), ("institution", "NATP")]:
            with self.subTest(field=field):
                db = sqlite3.connect(":memory:")
                seed(db)
                row = enrollment()
                row[field] = value
                db.execute("UPDATE registration_enrollments SET state=?,expires_at_millis=?,row_json=?", (row["state"], row["expires_at_millis"], json.dumps(row)))
                db.commit()
                with self.assertRaises(sqlite3.IntegrityError):
                    activate(db)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM mls_devices").fetchone()[0], 0)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM cid_admissions").fetchone()[0], 0)
                db.close()

    def test_failure_after_device_write_rolls_back_all_three_records(self):
        self.db.execute("CREATE TRIGGER synthetic_failure BEFORE INSERT ON cid_admissions WHEN NEW.cid_number IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM mls_devices").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT state FROM registration_enrollments").fetchone()[0], "human_verified")

    def test_consumed_challenge_stays_burned_on_business_failure(self):
        proof, count = challenge(self.db)
        self.assertEqual(count, 1)
        self.assertEqual(consume(self.db, proof), 1)
        cmd = command()
        cmd["config"]["service_origin"] = "https://other.example.test"
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db, cmd)
        self.assertEqual(consume(self.db, proof), 0)

    def test_one_enrollment_cannot_change_device(self):
        activate(self.db)
        cmd = command()
        cmd["before_version"] = 3
        cmd["enrollment"]["version"] = 3
        cmd["device"]["public_key"] = "0x" + "e" * 64
        cmd["device"]["device_id"] = "e" * 64
        cmd["enrollment"]["activation"]["public_key"] = cmd["device"]["public_key"]
        cmd["enrollment"]["activation"]["device_id"] = cmd["device"]["device_id"]
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db, cmd)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM mls_devices").fetchone()[0], 1)

    def test_idempotent_same_activation_and_null_reuse(self):
        activate(self.db)
        cmd = command()
        cmd["before_version"] = 3
        cmd["enrollment"]["version"] = 3
        activate(self.db, cmd)
        cmd["enrollment"] = None
        cmd["before_version"] = None
        activate(self.db, cmd)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cid_admissions").fetchone()[0], 1)

    def test_chain_identity_without_admission_cannot_use_null_or_session(self):
        cmd = command()
        cmd["enrollment"] = None
        cmd["before_version"] = None
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db, cmd)
        with self.assertRaises(sqlite3.IntegrityError):
            issue_session(self.db, 1)

    def test_stale_binding_revokes_all_credentials_and_keeps_business_data(self):
        activate(self.db)
        issue_session(self.db, 1)
        proof, _ = challenge(self.db)
        self.db.execute("INSERT INTO user_profiles(cid_number,display_name) VALUES(?,?)", (IDENTITY["cid_number"], "保留资料"))
        self.db.commit()
        new = copy.deepcopy(IDENTITY)
        new.update(account_id="0x" + "e" * 64, binding_revision=2, finalized_block_number=10, finalized_block_hash="0x" + "a" * 64)
        project(self.db, new)
        self.assertEqual(self.db.execute("SELECT active FROM mls_devices").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_sessions").fetchone()[0], 0)
        self.assertEqual(consume(self.db, proof), 0)
        self.assertEqual(self.db.execute("SELECT display_name FROM user_profiles WHERE cid_number=?", (IDENTITY["cid_number"],)).fetchone()[0], "保留资料")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM cid_admissions").fetchone()[0], 1)
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db)

    def test_older_projection_cannot_overwrite_higher_revision_or_freshness(self):
        new = copy.deepcopy(IDENTITY)
        new.update(binding_revision=2, finalized_block_number=10, finalized_block_hash="0x" + "a" * 64, checked_at_millis=1000005, verification_deadline_millis=1060005)
        project(self.db, new)
        project(self.db)
        self.assertEqual(self.db.execute("SELECT binding_revision FROM users WHERE cid_number=?", (IDENTITY["cid_number"],)).fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT checked_at_millis FROM user_identity_checks").fetchone()[0], 1000005)

    def test_expired_and_historical_checks_cannot_issue_or_consume_or_activate(self):
        for historical in [False, True]:
            db = sqlite3.connect(":memory:")
            seed(db)
            if historical:
                i = copy.deepcopy(IDENTITY)
                i["authoritative_current"] = False
                project(db, i)
                now = 1000001
            else:
                now = 1060000
            self.assertEqual(challenge(db, now=now)[1], 0)
            cmd = command()
            cmd["now"] = now
            with self.assertRaises(sqlite3.IntegrityError):
                activate(db, cmd)
            db.close()

    def test_challenge_capacity_is_64_per_purpose_and_expiry_releases_it(self):
        for n in range(65):
            self.assertEqual(challenge(self.db, f"0x{n:064x}")[1], int(n < 64))
        self.db.execute("UPDATE mls_authentication_challenges SET expires_at_millis=1000002 WHERE challenge=?", (f"0x{0:064x}",))
        self.db.commit()
        self.assertEqual(challenge(self.db, "0x" + "e" * 64, now=1000002)[1], 1)

    def test_request_target_body_purpose_and_expiry_must_match(self):
        proof, _ = challenge(self.db)
        for field, value in [("request_target", "/api/user/sessions"), ("body_sha256", "0x" + "a" * 64), ("expires_at_millis", 1300002), ("binding_revision", 2)]:
            bad = dict(proof)
            bad[field] = value
            self.assertEqual(consume(self.db, bad), 0)
        self.assertEqual(consume(self.db, proof, purpose="session"), 0)
        self.assertEqual(consume(self.db, proof), 1)

    def test_session_limit_keeps_new_token_and_failure_does_not_evict_existing(self):
        activate(self.db)
        for token in range(12):
            issue_session(self.db, token)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_sessions").fetchone()[0], 8)
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM square_sessions WHERE session_token_hash=?", (f"{11:064x}",)).fetchone())
        with self.assertRaises(sqlite3.IntegrityError):
            issue_session(self.db, 99, now=1060000)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_sessions").fetchone()[0], 8)

    def test_refresh_lease_coalesces_and_never_extends_deadline(self):
        sql = "UPDATE user_identity_checks SET refresh_lease_until=?2+15000 WHERE cid_number=?1 AND refresh_lease_until<=?2"
        self.assertEqual(self.db.execute(sql, (IDENTITY["cid_number"], 1060000)).rowcount, 1)
        self.assertEqual(self.db.execute(sql, (IDENTITY["cid_number"], 1060000)).rowcount, 0)
        self.assertEqual(self.db.execute("SELECT verification_deadline_millis FROM user_identity_checks").fetchone()[0], 1060000)

    def test_cursor_mismatch_rolls_back_block_and_target_projection_leaves_cursor(self):
        sql = statements("project_identity.sql")
        self.db.execute(sql[4], (9, IDENTITY["finalized_block_hash"], 1000000))
        self.db.commit()
        new = copy.deepcopy(IDENTITY)
        new.update(binding_revision=2, finalized_block_number=10, finalized_block_hash="0x" + "a" * 64)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.db.execute(sql[3], (8, "0x" + "8" * 64))
                for statement in sql[:3]:
                    self.db.execute(statement, (json.dumps(new), new["registered_block_hash"]) if "?2" in statement else (json.dumps(new),))
                self.db.execute(sql[4], (10, new["finalized_block_hash"], 1000001))
        self.assertEqual(self.db.execute("SELECT binding_revision FROM users WHERE cid_number=?", (IDENTITY["cid_number"],)).fetchone()[0], 1)
        project(self.db, new)
        self.assertEqual(self.db.execute("SELECT finalized_block_number FROM user_projection_cursor").fetchone()[0], 9)

    def test_same_block_account_release_is_independent_of_cid_order(self):
        other = copy.deepcopy(IDENTITY)
        other.update(cid_number="CN220-CTZN2-198805202-2026", account_id="0x" + "e" * 64)
        project(self.db, other)
        first = copy.deepcopy(other)
        first.update(account_id=IDENTITY["account_id"], binding_revision=2, finalized_block_number=10, finalized_block_hash="0x" + "a" * 64)
        second = copy.deepcopy(IDENTITY)
        second.update(account_id="0x" + "f" * 64, binding_revision=2, finalized_block_number=10, finalized_block_hash="0x" + "a" * 64)
        sql = statements("project_identity.sql")
        with self.db:
            for i in [first, second]:
                self.db.execute(sql[0], (json.dumps(i),))
            for i in [first, second]:
                self.db.execute(sql[1], (json.dumps(i), i["registered_block_hash"]))
                self.db.execute(sql[2], (json.dumps(i),))
        self.assertEqual(self.db.execute("SELECT account_id FROM users WHERE cid_number=?", (other["cid_number"],)).fetchone()[0], IDENTITY["account_id"])

    def test_final_cursor_write_failure_rolls_back_revocations_and_projection(self):
        activate(self.db)
        issue_session(self.db, 1)
        sql = statements("project_identity.sql")
        self.db.execute(sql[4], (9, IDENTITY["finalized_block_hash"], 1000000))
        self.db.commit()
        new = copy.deepcopy(IDENTITY)
        new.update(binding_revision=2, finalized_block_number=10, finalized_block_hash="0x" + "a" * 64)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.db.execute(sql[3], (9, IDENTITY["finalized_block_hash"]))
                for statement in sql[:3]:
                    self.db.execute(statement, (json.dumps(new), new["registered_block_hash"]) if "?2" in statement else (json.dumps(new),))
                self.db.execute(sql[4], (10, "invalid_hash", 1000001))
        self.assertEqual(self.db.execute("SELECT active FROM mls_devices").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_sessions").fetchone()[0], 1)

    def test_parallel_consumption_and_activation_have_one_winner(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "auth.sqlite")
            db = sqlite3.connect(path)
            db.execute("PRAGMA journal_mode=WAL")
            seed(db)
            proof, _ = challenge(db)
            db.close()

            def work(_):
                connection = sqlite3.connect(path, timeout=15)
                won = consume(connection, proof)
                if won:
                    activate(connection)
                connection.close()
                return won

            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                self.assertEqual(sum(pool.map(work, range(16))), 1)
            db = sqlite3.connect(path)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mls_devices").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM cid_admissions").fetchone()[0], 1)
            db.close()

    def test_revocation_and_older_issued_at_cannot_reactivate_with_old_authorization(self):
        activate(self.db)
        self.db.execute("UPDATE mls_devices SET active=0")
        self.db.commit()
        cmd = command()
        cmd["enrollment"] = None
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db, cmd)
        cmd["device"]["issued_at"] += 1
        activate(self.db, cmd)
        old = copy.deepcopy(cmd)
        old["device"]["issued_at"] -= 1
        with self.assertRaises(sqlite3.IntegrityError):
            activate(self.db, old)


class AccountDeletionStorage(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        seed(self.db)
        activate(self.db)
        issue_session(self.db, 1)
        from community_storage_contract import auth
        self.authorization = auth()

    def tearDown(self):
        self.db.close()

    def issue(self, purpose="delete"):
        c = {"ok": True, "purpose": purpose, "challenge_id": "66" * 32,
             "cid_number": IDENTITY["cid_number"], "account_id": IDENTITY["account_id"],
             "binding_revision": 1, "chain_scope": FIXTURE["chain_scope"],
             "service_origin": FIXTURE["service_origin"], "expires_at_millis": 1300003,
             "signing_payload_hex": "0x00"}
        raw = json.dumps(c, separators=(",", ":"))
        self.db.execute("INSERT INTO account_deletion_challenges VALUES(?,?,?,?,?,?,?)",
                        (c["challenge_id"], c["cid_number"], c["account_id"], 1, purpose, c["expires_at_millis"], raw))
        self.db.commit()
        return {"auth": self.authorization, "challenge": c, "challenge_json": raw, "now": 1000003}

    def begin(self, command):
        from community_storage_contract import execute
        execute(self.db, (SQL / "account_deletion.sql").read_text(), command)

    def test_acceptance_atomically_consumes_nonce_revokes_session_and_keeps_chain_identity(self):
        c = self.issue()
        self.begin(c)
        self.assertEqual(self.db.execute("SELECT state FROM account_deletions").fetchone()[0], "pending")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_sessions").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM authorized_business_sessions").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT active FROM mls_devices").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM account_deletion_challenges").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT cid_status FROM users WHERE cid_number=?", (IDENTITY["cid_number"],)).fetchone()[0], "active")
        with self.assertRaises(sqlite3.IntegrityError):
            self.begin(c)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM account_deletions").fetchone()[0], 1)

    def test_status_nonce_and_tampered_binding_cannot_create_job(self):
        c = self.issue("status")
        with self.assertRaises(sqlite3.IntegrityError):
            self.begin(c)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_sessions").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM account_deletions").fetchone()[0], 0)

    def test_unknown_profile_writer_keeps_session_and_nonce_for_recovery(self):
        c = self.issue()
        cid = IDENTITY["cid_number"]
        self.db.execute("INSERT INTO profile_asset_uploads(upload_id,cid_number,kind,object_key,content_type,byte_size,sha256,generation,state,created_at,expires_at) VALUES(?,?,'avatar',?,'image/webp',4,?,1,'writing',1000000,1900000)",
                        ("profile-unknown", cid, "profile/" + cid + "/avatar", "ab" * 32))
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.begin(c)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_sessions").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM account_deletion_challenges").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT state FROM profile_asset_uploads").fetchone()[0], "writing")

    def test_pending_job_prevents_new_session_and_old_human_admission(self):
        self.begin(self.issue())
        with self.assertRaises(sqlite3.IntegrityError):
            issue_session(self.db, 2)
        admission = self.db.execute("SELECT * FROM cid_admissions").fetchone()
        self.db.execute("DELETE FROM cid_admissions")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.db.execute("INSERT INTO cid_admissions VALUES(" + ",".join("?" for _ in admission) + ")", admission)

    def test_unknown_object_io_is_not_reclaimed_after_lease_timeout(self):
        self.begin(self.issue())
        self.db.execute("UPDATE account_deletions SET io_started=1,lease_until=0,keys_json=?", (json.dumps(["profile/" + IDENTITY["cid_number"] + "/avatar"]),))
        rows = self.db.execute("SELECT deletion_id FROM account_deletions WHERE state='pending' AND io_started=0 AND lease_until<=2000000").fetchall()
        self.assertEqual(rows, [])
        self.assertEqual(self.db.execute("SELECT state FROM account_deletions").fetchone()[0], "pending")

    def test_private_cleanup_whitelist_preserves_financial_claims_and_chain_mirrors(self):
        import re
        from external_storage_contract import insert, row
        order = row(90)
        order["cid_number"] = IDENTITY["cid_number"]
        order["account_id"] = IDENTITY["account_id"]
        self.assertTrue(insert(self.db, order))
        self.db.execute("INSERT INTO chain_extrinsic_relays VALUES(?,?,?,?,1,'submitting',NULL,1,1,1)",
                        ("rel_test", "aa" * 32, "0x" + "11" * 32, "00" * 32))
        self.db.execute("INSERT INTO chain_transaction_confirmations VALUES(?,?,?,?,0,0,'membership',?,1,1)",
                        ("0x" + "22" * 32, IDENTITY["cid_number"], IDENTITY["account_id"], FIXTURE["chain_scope"], "bb" * 32))
        self.db.commit()
        tables = ["users", "topup_orders", "chain_extrinsic_relays", "chain_transaction_confirmations",
                  "square_memberships", "square_creator_tiers", "square_creator_subscriptions"]
        before = {table: self.db.execute("SELECT * FROM " + table).fetchall() for table in tables}
        self.begin(self.issue())
        source = (ROOT / "server/cloudflare/repositories/deletion.rs").read_text()
        whitelist = source.split("const ROWS:")[1].split("];", 1)[0]
        for table, column in re.findall(r'\("([^"]+)","([^"]+)"\)', whitelist):
            while self.db.execute("SELECT 1 FROM " + table + " WHERE " + column + "=? LIMIT 1", (IDENTITY["cid_number"],)).fetchone():
                self.db.execute("DELETE FROM " + table + " WHERE rowid IN(SELECT rowid FROM " + table + " WHERE " + column + "=? LIMIT 100)", (IDENTITY["cid_number"],))
        for table in tables:
            self.assertEqual(self.db.execute("SELECT * FROM " + table).fetchall(), before[table], table)

