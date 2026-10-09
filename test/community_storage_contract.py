"""Execute production SQL verbatim on SQLite, including rollback and parallel writers."""
import concurrent.futures
import copy
import json
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from auth_storage_contract import seed, activate, issue_session, project, IDENTITY, FIXTURE, challenge

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT / "server/cloudflare/sql"


def constant(file, name):
    text = (ROOT / "server/cloudflare/repositories" / file).read_text()
    return re.search(r"const " + name + r":\s*&str\s*=\s*r#\"([\s\S]*?)\"#;", text)[1]


AUTH = constant("mod.rs", "AUTH_ASSERT")


def auth():
    return {"cid_number": IDENTITY["cid_number"], "account_id": IDENTITY["account_id"], "binding_revision": 1,
            "device_id": FIXTURE["public_key"][2:], "session_token_hash": f"{1:064x}", "now": 1000003,
            **{k: FIXTURE[k] for k in ("registration_scope", "service_origin", "chain_scope")}, "institution": "CTZN"}


def execute(db, sql, command):
    with db:
        if "day" in command:
            command={"membership_checked":1000000,"membership_deadline":1060000,**command}
        raw = json.dumps(command, separators=(",", ":"), ensure_ascii=False)
        db.execute(AUTH, (raw,))
        counts = []
        for stmt in sql.split("-- statement")[1:]:
            counts.append(db.execute(stmt, (raw,)).rowcount)
        return counts


def run(db, file, **fields):
    return execute(db, (SQL / file).read_text(), {"auth": auth(), **fields})


def ready(db):
    seed(db)
    activate(db)
    issue_session(db, 1)


def group(db):
    row = db.execute("SELECT group_id,creator_device_id,group_revision,member_device_ids,pending_operation_id FROM contact_mls_groups WHERE cid_number=?", (auth()["cid_number"],)).fetchone()
    return dict(zip(("group_id", "creator_device_id", "group_revision", "member_device_ids", "pending_operation_id"), row[:3] + (json.loads(row[3]), row[4])))


def publish(db):
    execute(db, constant("contacts.rs", "PUBLISH"), {"auth": auth(), "package": "0102", "group_id": "12" * 16})


def reserve(db, kind="create", targets=None, operation_id="34" * 16):
    cmd = {"auth": auth(), "group": group(db), "operation_id": operation_id,
           "operation_kind": kind, "target_device_ids": targets or []}
    execute(db, (SQL / "reserve_contact.sql").read_text(), cmd)
    return cmd


def commit_command(db, reserved, members, messages):
    operation = {"operation_id": reserved["operation_id"], "device_id": auth()["device_id"],
                 "group_revision": reserved["group"]["group_revision"], "operation_kind": reserved["operation_kind"],
                 "target_device_ids": reserved["target_device_ids"], "result_json": None, "committed_at": None}
    return {"auth": auth(), "group": group(db), "operation": operation, "member_device_ids": members,
            "messages": messages, "result_json": json.dumps({"member_device_ids": members, "messages": messages}, separators=(",", ":"))}


def commit(db, cmd):
    return execute(db, (SQL / "commit_contact.sql").read_text(), cmd)


class CommunityStorageContract(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        ready(self.db)

    def tearDown(self):
        self.db.close()

    def test_auth_view_requires_real_admission_session_and_current_active_device(self):
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM authorized_business_sessions").fetchone()[0], 1)
        for table, mutation in [("mls_devices", "UPDATE mls_devices SET active=0"), ("square_sessions", "DELETE FROM square_sessions"), ("cid_admissions", "DELETE FROM cid_admissions")]:
            db = sqlite3.connect(":memory:")
            ready(db)
            db.execute(mutation)
            db.commit()
            with self.assertRaises(sqlite3.IntegrityError):
                run(db, "charge_browse.sql", day="2026-10-07", count=1, paid_until=None)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM square_browse_days").fetchone()[0], 0)
            db.close()

    def test_write_rechecks_scope_account_revision_device_token_and_execution_time(self):
        for field, value in [("registration_scope", "other"), ("service_origin", "https://other.test"), ("chain_scope", "0x" + "a" * 64), ("institution", "NATP"), ("account_id", "0x" + "e" * 64), ("binding_revision", 2), ("device_id", "e" * 64), ("session_token_hash", "e" * 64), ("now", 1060000), ("now", 999999)]:
            with self.subTest(field=field, value=value):
                ctx = auth()
                ctx[field] = value
                with self.assertRaises(sqlite3.IntegrityError):
                    execute(self.db, (SQL / "charge_browse.sql").read_text(), {"auth": ctx, "day": "2026-10-07", "count": 1, "paid_until": None})
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_browse_days").fetchone()[0], 0)

    def test_rebind_after_signature_cannot_write_but_existing_cid_data_survives(self):
        self.db.execute("INSERT INTO user_profiles(cid_number,display_name) VALUES(?,?)", (auth()["cid_number"], "保留"))
        self.db.commit()
        identity = copy.deepcopy(IDENTITY)
        identity.update(account_id="0x" + "e" * 64, binding_revision=2, finalized_block_number=10, finalized_block_hash="0x" + "a" * 64)
        project(self.db, identity)
        with self.assertRaises(sqlite3.IntegrityError):
            run(self.db, "mark_notifications_read.sql", scope="square")
        self.assertEqual(self.db.execute("SELECT display_name FROM user_profiles WHERE cid_number=?", (auth()["cid_number"],)).fetchone()[0], "保留")

    def test_profile_cas_compares_fields_even_when_timestamp_is_equal(self):
        before = {"cid_number": auth()["cid_number"], "display_name": "", "bio": "", "avatar_object_key": None, "avatar_content_hash": None, "banner_object_key": None, "banner_content_hash": None, "updated_at": 0}
        after = {**before, "display_name": "A", "updated_at": 1000003}
        sql = constant("profiles.rs", "WRITE")
        self.assertEqual(execute(self.db, sql, {"auth": auth(), "before": before, "after": after})[-1], 1)
        old = dict(after)
        newer = {**after, "bio": "B"}
        self.assertEqual(execute(self.db, sql, {"auth": auth(), "before": old, "after": newer})[-1], 1)
        stale = {**after, "display_name": "C"}
        self.assertEqual(execute(self.db, sql, {"auth": auth(), "before": old, "after": stale})[-1], 0)
        self.assertEqual(self.db.execute("SELECT display_name,bio FROM user_profiles WHERE cid_number=?", (auth()["cid_number"],)).fetchone(), ("A", "B"))

    def test_browse_empty_results_do_not_charge_and_utc_day_is_independent(self):
        run(self.db, "charge_browse.sql", day="2026-10-07", count=0, paid_until=None)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_browse_days").fetchone()[0], 0)
        run(self.db, "charge_browse.sql", day="2026-10-07", count=99, paid_until=None)
        run(self.db, "charge_browse.sql", day="2026-10-08", count=2, paid_until=None)
        self.assertEqual(self.db.execute("SELECT SUM(browse_count) FROM square_browse_days").fetchone()[0], 101)

    def test_browse_overflow_rolls_back_and_paid_does_not_consume_free_counter(self):
        run(self.db, "charge_browse.sql", day="2026-10-07", count=95, paid_until=None)
        with self.assertRaises(sqlite3.IntegrityError):
            run(self.db, "charge_browse.sql", day="2026-10-07", count=6, paid_until=None)
        run(self.db, "charge_browse.sql", day="2026-10-07", count=50, paid_until=2000000)
        self.assertEqual(self.db.execute("SELECT browse_count FROM square_browse_days").fetchone()[0], 95)
        with self.assertRaises(sqlite3.IntegrityError):
            run(self.db, "charge_browse.sql", day="2026-10-07", count=1, paid_until=1000003)

    def test_membership_confirmation_expiring_during_query_cannot_charge_or_return_posts(self):
        for checked, deadline in [(1000000, 1000003), (1000004, 1060004), (1000000, 1060001), (None, None)]:
            with self.assertRaises(sqlite3.IntegrityError):
                run(self.db, "charge_browse.sql", day="2026-10-07", count=1, paid_until=2000000,
                    membership_checked=checked, membership_deadline=deadline)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_browse_days").fetchone()[0], 0)

    def test_notify_cursors_are_independent_and_monotonic(self):
        run(self.db, "mark_notifications_read.sql", scope="square")
        self.assertEqual(self.db.execute("SELECT last_seen_square_at,last_seen_following_at FROM square_notify_reads").fetchone(), (1000003, 0))
        run(self.db, "mark_notifications_read.sql", scope="following")
        self.db.execute("UPDATE square_notify_reads SET last_seen_square_at=1000004")
        self.db.commit()
        run(self.db, "mark_notifications_read.sql", scope="square")
        self.assertEqual(self.db.execute("SELECT last_seen_square_at,last_seen_following_at FROM square_notify_reads").fetchone(), (1000004, 1000003))

    def test_follow_retry_preserves_date_notify_and_unfollow_is_idempotent(self):
        cmd = {"auth": auth(), "target": "CID2", "enabled": False}
        execute(self.db, constant("square.rs", "FOLLOW"), cmd)
        execute(self.db, constant("square.rs", "NOTIFY"), cmd)
        execute(self.db, constant("square.rs", "FOLLOW"), cmd)
        self.assertEqual(self.db.execute("SELECT created_at,notify_enabled FROM square_follows").fetchone(), (1000003, 0))
        execute(self.db, constant("square.rs", "UNFOLLOW"), cmd)
        execute(self.db, constant("square.rs", "UNFOLLOW"), cmd)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_follows").fetchone()[0], 0)

    def test_publish_never_replaces_existing_group_and_state_has_only_current_packages(self):
        publish(self.db)
        publish(self.db)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_groups").fetchone()[0], 1)
        self.assertEqual(group(self.db)["group_id"], "12" * 16)

    def test_create_commit_is_atomic_idempotent_and_conflicting_result_rejected(self):
        publish(self.db)
        r = reserve(self.db)
        cmd = commit_command(self.db, r, [auth()["device_id"]], [])
        commit(self.db, cmd)
        commit(self.db, cmd)
        self.assertEqual(group(self.db)["group_revision"], 1)
        bad = copy.deepcopy(cmd)
        bad["result_json"] = "{}"
        with self.assertRaises(sqlite3.IntegrityError):
            commit(self.db, bad)
        self.assertIsNone(group(self.db)["pending_operation_id"])

    def test_single_pending_and_operation_capacity_roll_back_cleanup_and_group(self):
        publish(self.db)
        reserve(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            reserve(self.db, operation_id="56" * 16)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_operations").fetchone()[0], 1)

    def test_failure_after_operation_write_rolls_back_result_messages_and_revision(self):
        publish(self.db)
        r = reserve(self.db)
        cmd = commit_command(self.db, r, [auth()["device_id"]], [])
        self.db.execute("CREATE TRIGGER test_failure BEFORE UPDATE ON contact_mls_groups BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            commit(self.db, cmd)
        self.assertEqual(group(self.db)["group_revision"], 0)
        self.assertIsNone(self.db.execute("SELECT result_json FROM contact_mls_operations").fetchone()[0])

    def test_add_rechecks_target_device_before_reserve_and_commit(self):
        publish(self.db)
        first = reserve(self.db)
        commit(self.db, commit_command(self.db, first, [auth()["device_id"]], []))
        target = "cd" * 32
        d = self.db.execute("SELECT * FROM mls_devices").fetchone()
        d = list(d)
        d[1] = target
        d[4] = "0x" + target
        self.db.execute("INSERT INTO mls_devices VALUES(?,?,?,?,?,?,?,?,?)", d)
        self.db.commit()
        r = reserve(self.db, "add", [target], "56" * 16)
        messages = [{"message_type": "commit", "device_ids": [], "mls_message": "01"}, {"message_type": "welcome", "device_ids": [target], "mls_message": "02"}]
        cmd = commit_command(self.db, r, sorted([auth()["device_id"], target]), messages)
        self.db.execute("UPDATE mls_devices SET active=0 WHERE device_id=?", (target,))
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            commit(self.db, cmd)
        self.assertEqual(group(self.db)["group_revision"], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_messages").fetchone()[0], 0)

    def test_message_queue_capacity_blocks_commit_and_ack_only_current_device(self):
        publish(self.db)
        first = reserve(self.db)
        commit(self.db, commit_command(self.db, first, [auth()["device_id"]], []))
        target = "cd" * 32
        self.db.execute("UPDATE contact_mls_groups SET member_device_ids=?", (json.dumps(sorted([auth()["device_id"], target]), separators=(",", ":")),))
        self.db.executemany("INSERT INTO contact_mls_messages VALUES(?,?,?,?,?,?,?)", [(auth()["cid_number"], target, f"{n:032x}", n + 1, "application", "01", auth()["device_id"]) for n in range(1024)])
        self.db.commit()
        r = reserve(self.db, "application", [], "56" * 16)
        msg = [{"message_type": "application", "device_ids": [target], "mls_message": "01"}]
        cmd = commit_command(self.db, r, sorted([auth()["device_id"], target]), msg)
        with self.assertRaises(sqlite3.IntegrityError):
            commit(self.db, cmd)
        execute(self.db, constant("contacts.rs", "ACK"), {"auth": auth(), "id": "0" * 32, "kind": "application"})
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_messages").fetchone()[0], 1024)

    def test_request_challenge_is_bound_to_one_session_hash(self):
        proof, count = challenge(self.db, purpose="request", target="/api/8964/feed/recommended", session_hash=f"{1:064x}")
        self.assertEqual(count, 1)
        raw = json.dumps({"proof": proof, "purpose": "request", "session_token_hash": f"{2:064x}", "now": 1000003})
        self.assertEqual(self.db.execute((SQL / "consume_mls_challenge.sql").read_text(), (raw,)).rowcount, 0)

    def test_operations_capacity_is_1024_and_failed_reserve_leaves_no_pending(self):
        publish(self.db)
        self.db.executemany("INSERT INTO contact_mls_operations VALUES(?,?,?,?,?,?,?,?)", [(auth()["cid_number"], f"{n:032x}", auth()["device_id"], 0, "application", "[]", "{}", 1) for n in range(1024)])
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            reserve(self.db)
        self.assertIsNone(group(self.db)["pending_operation_id"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_operations").fetchone()[0], 1024)

    def test_publish_and_commit_reject_more_than_32_eligible_devices(self):
        publish(self.db)
        r = reserve(self.db)
        cmd = commit_command(self.db, r, [auth()["device_id"]], [])
        d = list(self.db.execute("SELECT * FROM mls_devices").fetchone())
        for n in range(32):
            d[1] = f"{n:064x}"
            d[4] = "0x" + d[1]
            self.db.execute("INSERT INTO mls_devices VALUES(?,?,?,?,?,?,?,?,?)", d)
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            publish(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            commit(self.db, cmd)
        self.assertEqual(group(self.db)["group_revision"], 0)

    def test_remove_clears_only_inactive_target_packages_and_messages(self):
        publish(self.db)
        first = reserve(self.db)
        commit(self.db, commit_command(self.db, first, [auth()["device_id"]], []))
        target = "cd" * 32
        members = sorted([auth()["device_id"], target])
        self.db.execute("UPDATE contact_mls_groups SET member_device_ids=?", (json.dumps(members, separators=(",", ":")),))
        self.db.execute("INSERT INTO contact_mls_packages VALUES(?,?,?,?)", (auth()["cid_number"], target, "01", 1000003))
        self.db.execute("INSERT INTO contact_mls_messages VALUES(?,?,?,?,?,?,?)", (auth()["cid_number"], target, "00" * 16, 1, "application", "01", auth()["device_id"]))
        self.db.commit()
        r = reserve(self.db, "remove", [target], "56" * 16)
        cmd = commit_command(self.db, r, [auth()["device_id"]], [{"message_type": "commit", "device_ids": [], "mls_message": "01"}])
        commit(self.db, cmd)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_messages WHERE device_id=?", (target,)).fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_packages WHERE device_id=?", (target,)).fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM contact_mls_packages WHERE device_id=?", (auth()["device_id"],)).fetchone()[0], 1)

    def test_total_ciphertext_capacity_rolls_back_the_pending_commit(self):
        publish(self.db)
        first = reserve(self.db)
        commit(self.db, commit_command(self.db, first, [auth()["device_id"]], []))
        target = "cd" * 32
        members = sorted([auth()["device_id"], target])
        self.db.execute("UPDATE contact_mls_groups SET member_device_ids=?", (json.dumps(members, separators=(",", ":")),))
        # Fill exactly 32MiB using valid per-message wire sizes, below the per-device 1024 count.
        remaining = 33554432
        n = 0
        while remaining:
            size = min(remaining, 49152)
            self.db.execute("INSERT INTO contact_mls_messages VALUES(?,?,?,?,?,?,?)", (auth()["cid_number"], target, f"{n:032x}", n + 1, "application", "01" * size, auth()["device_id"]))
            remaining -= size
            n += 1
        self.db.commit()
        r = reserve(self.db, "application", [], "56" * 16)
        cmd = commit_command(self.db, r, members, [{"message_type": "application", "device_ids": [target], "mls_message": "01"}])
        with self.assertRaises(sqlite3.IntegrityError):
            commit(self.db, cmd)
        self.assertEqual(group(self.db)["group_revision"], 1)
        self.assertEqual(self.db.execute("SELECT SUM(length(mls_message)/2) FROM contact_mls_messages").fetchone()[0], 33554432)

    def test_profile_counts_separate_documents_campaigns_videos_and_articles(self):
        cid = auth()["cid_number"]
        for n, (category, kind, state) in enumerate([("normal", "document", "published"), ("campaign", "document", "published"), ("normal", "article", "published"), ("normal", "video", "published"), ("normal", "document", "deleted")]):
            self.db.execute("INSERT INTO square_posts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (f"post{n}", cid, auth()["account_id"], category, kind, None, "", "a" * 64, "r1", 9, "0x" + "9" * 64, "0x" + "8" * 64, n + 1, state))
        row = self.db.execute(constant("profiles.rs", "PROFILE"), (cid, cid, auth()["now"])).fetchone()
        self.assertEqual(json.loads(row[-1]), {"following": 0, "followers": 0, "mutual_following": 0, "posts": 1, "campaigns": 1, "videos": 1, "articles": 1})

    def test_unread_counts_only_notify_enabled_followed_published_posts(self):
        cid = auth()["cid_number"]
        for n, state in enumerate(["published", "published", "deleted"]):
            self.db.execute("INSERT INTO square_posts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (f"post{n}", cid, auth()["account_id"], "normal", "document", None, "", "a" * 64, "r1", 9, "0x" + "9" * 64, "0x" + "8" * 64, n + 1, state))
        self.db.execute("INSERT INTO square_follows VALUES(?,?,?,?)", ("viewer", cid, 1, 1))
        self.db.execute("INSERT INTO square_notify_reads VALUES(?,?,?)", ("viewer", 1, 0))
        sql = constant("notifications.rs", "UNREAD")
        self.assertEqual(self.db.execute(sql, ("viewer",)).fetchone(), (1, 2))
        self.db.execute("UPDATE square_follows SET notify_enabled=0")
        self.assertEqual(self.db.execute(sql, ("viewer",)).fetchone(), (0, 0))

    def test_mutual_cursor_is_the_later_relationship_time(self):
        self.db.executemany("INSERT INTO square_follows VALUES(?,?,?,?)", [("viewer", "CID2", 2, 1), ("CID2", "viewer", 5, 1), ("viewer", "CID3", 3, 1), ("CID3", "viewer", 4, 1)])
        sql = constant("square.rs", "MUTUAL")
        self.assertEqual(self.db.execute(sql, ("viewer", None, 50)).fetchall(), [("CID2", 5), ("CID3", 4)])
        self.assertEqual(self.db.execute(sql, ("viewer", 5, 50)).fetchall(), [("CID3", 4)])

    def test_parallel_browse_and_reserve_each_enforce_one_atomic_limit(self):
        for mode in ["browse", "reserve"]:
            with tempfile.TemporaryDirectory() as directory:
                path = str(Path(directory) / "community.sqlite")
                db = sqlite3.connect(path)
                db.execute("PRAGMA journal_mode=WAL")
                ready(db)
                publish(db)
                db.close()

                def work(n):
                    connection = sqlite3.connect(path, timeout=15)
                    try:
                        if mode == "browse":
                            run(connection, "charge_browse.sql", day="2026-10-07", count=9, paid_until=None)
                        else:
                            reserve(connection, operation_id=f"{n:032x}")
                        return 1
                    except sqlite3.IntegrityError:
                        return 0
                    finally:
                        connection.close()

                with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                    self.assertEqual(sum(pool.map(work, range(16))), 11 if mode == "browse" else 1)
                db = sqlite3.connect(path)
                if mode == "browse":
                    self.assertEqual(db.execute("SELECT browse_count FROM square_browse_days").fetchone()[0], 99)
                else:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM contact_mls_operations").fetchone()[0], 1)
                db.close()
