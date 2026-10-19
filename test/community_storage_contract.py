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
            "device_id": FIXTURE["public_key"][2:], "session_token_hash": f"{1:064x}", "now": 1000003,"deadline":1060000,"sync_health_millis":600000,
            **{k: FIXTURE[k] for k in ("registration_scope", "service_origin", "chain_scope")}, "institution": "CTZN"}


def execute(db, sql, command):
    with db:
        raw = json.dumps(command, separators=(",", ":"), ensure_ascii=False)
        db.execute(AUTH, (raw,))
        counts = []
        for stmt in sql.split("-- statement")[1:]:
            counts.append(db.execute(stmt, (raw,)).rowcount)
        return counts


def run(db, file, **fields):
    if file == "meter.sql":
        # 100是原有限计量并发夹具，不是非会员可访问权限；生产只交付有效会员许可及Unlimited。
        fields={"membership_checked":1000000,"membership_deadline":1060000,"chain_time":1000000,
                "membership_level":"freedom","membership_status":"active","membership_block":0,"period_start":900000,
                "metric":"browse","amount":fields.get("count",1),
                "period":0,"browse_limit":100,**fields}
    return execute(db, (SQL / file).read_text(), {"auth": auth(), **fields})


def ready(db):
    seed(db)
    activate(db)
    issue_session(db, 1)
    db.execute("INSERT INTO square_memberships(cid_number,account_id,membership_level,started_at,last_charged_at,last_charged_price_fen,authorized_price_fen,paid_until,subscription_status,finalized_block_number,finalized_block_hash,verified_at) VALUES(?,?,'freedom',800000,900000,199900,199900,2000000,'active',0,?,1000000)",(auth()["cid_number"],auth()["account_id"],"0x"+"0"*64));db.commit()


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


class CreatorOverviewSQLContract(unittest.TestCase):
    """执行生产概览SQL，检查逐笔整数计算、损坏数据和真实行数边界。"""
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        ready(self.db)
        self.query = constant("membership.rs", "OVERVIEW")
        self.serial = 0

    def tearDown(self):
        self.db.close()

    def add(self, period, price, count=1, status="active", paid=2000000):
        start = self.serial + 1
        self.serial += count
        # 每个订阅者都建立满足原外键/账户唯一约束的真实合成用户，不关闭外键。
        columns = [r[1] for r in self.db.execute("PRAGMA table_info(users)")][2:]
        self.db.executemany(
            "INSERT INTO users SELECT ?,?," + ",".join(columns) + " FROM users WHERE cid_number=?",
            ((f"OV{n}", f"0x{n + 100:064x}", auth()["cid_number"]) for n in range(start, self.serial + 1)),
        )
        self.db.executemany(
            """INSERT INTO square_creator_subscriptions
            (subscriber_cid_number,creator_cid_number,subscriber_account_id,creator_account_id,tier_id,billing_period,
             started_at,last_charged_at,last_charged_price_fen,authorized_price_fen,paid_until,subscription_status,
             finalized_block_number,finalized_block_hash,verified_at)
             VALUES(?,?,?,?,?,?,800000,900000,?,0,?,?,0,?,1000000)""",
            ((f"OV{n}", auth()["cid_number"], f"0x{n + 100:064x}", auth()["account_id"], "tier", period,
              price, paid, status, "0x" + "00" * 32) for n in range(start, self.serial + 1)),
        )

    def summary(self):
        cursor = self.db.execute(self.query, (auth()["cid_number"], auth()["now"]))
        rows = cursor.fetchall()
        self.assertEqual(len(rows), 1, "D1只能向Worker交付一行概览")
        result = dict(zip((c[0] for c in cursor.description), rows[0]))
        self.assertTrue(all(type(v) is int and 0 <= v <= 9007199254740991 for v in result.values()))
        return result

    def test_empty_and_mixed_periods_preserve_per_subscription_rounding_and_filtering(self):
        self.assertEqual(self.summary(), dict(subscriber_count=0, invalid_count=0, monthly_high=0, monthly_low=0, tier_count=0))
        self.add("monthly", 101)
        self.add("quarterly", 8, count=2, status="cancelled")
        self.add("yearly", 25)
        self.add("quarterly", 2, count=3)  # 逐笔均为0，不能先求总价再除3。
        self.add("monthly", 999, status="suspended")
        self.add("monthly", 999, paid=auth()["now"])
        result = self.summary()
        self.assertEqual((result["subscriber_count"], result["invalid_count"], result["monthly_low"]), (7, 0, 107))
        plan = " ".join(str(r) for r in self.db.execute("EXPLAIN QUERY PLAN " + self.query, (auth()["cid_number"], auth()["now"])))
        self.assertIn("idx_square_creator_subscriptions_creator", plan)

    def test_split_amounts_stay_exact_at_json_boundary_without_sqlite_integer_overflow(self):
        price = 9007199254740991
        self.add("monthly", price, count=100000)
        result = self.summary()
        self.assertEqual(result["subscriber_count"], 100000)
        self.assertEqual(result["monthly_high"] * 1000000 + result["monthly_low"], price * 100000)
        self.add("monthly", 1)
        self.assertEqual(self.summary()["subscriber_count"], 100001)
        self.add("monthly", 1)
        self.assertEqual(self.summary()["subscriber_count"], 100001, "原查询有界，不能加载第100002条")

    def test_corrupt_values_are_explicitly_reported_instead_of_rounded_or_ignored(self):
        for period, price in [("monthly", -1), ("quarterly", 1.5), ("yearly", "broken"), ("monthly", 9007199254740992)]:
            self.add(period, price)
        # 只在本地损坏夹具中越过schema，生产SQL仍必须拒绝非法周期。
        self.db.execute("PRAGMA ignore_check_constraints=ON")
        self.add("weekly", 100)
        self.db.execute("PRAGMA ignore_check_constraints=OFF")
        result = self.summary()
        self.assertEqual((result["subscriber_count"], result["invalid_count"]), (5, 5))
        self.assertEqual(result["monthly_high"] + result["monthly_low"], 0)


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
                run(db, "meter.sql", day="2026-10-07", count=1, paid_until=2000000)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM square_browse_days").fetchone()[0], 0)
            db.close()

    def test_write_rechecks_scope_account_revision_device_token_and_execution_time(self):
        for field, value in [("registration_scope", "other"), ("service_origin", "https://other.test"), ("chain_scope", "0x" + "a" * 64), ("institution", "NATP"), ("account_id", "0x" + "e" * 64), ("binding_revision", 2), ("device_id", "e" * 64), ("session_token_hash", "e" * 64), ("now", 1060000), ("now", 999999)]:
            with self.subTest(field=field, value=value):
                ctx = auth()
                ctx[field] = value
                with self.assertRaises(sqlite3.IntegrityError):
                    execute(self.db, (SQL / "meter.sql").read_text(), {"membership_checked":1000000,"membership_deadline":1060000,"auth": ctx, "day": "2026-10-07", "amount": 1, "paid_until": 2000000,"chain_time":1000000,"metric":"browse","operation_id":"scope-fixture","resource_key":"square-list","period":0})
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
        run(self.db, "meter.sql", day="2026-10-07", count=0, paid_until=2000000)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_browse_days").fetchone()[0], 0)
        run(self.db, "meter.sql", day="2026-10-07", count=99, paid_until=2000000)
        run(self.db, "meter.sql", day="2026-10-08", count=2, paid_until=2000000)
        self.assertEqual(self.db.execute("SELECT SUM(browse_count) FROM square_browse_days").fetchone()[0], 101)

    def test_finite_meter_fixture_rolls_back_overflow_and_other_metrics_do_not_consume_browse(self):
        run(self.db, "meter.sql", day="2026-10-07", count=95, paid_until=2000000)
        with self.assertRaises(sqlite3.IntegrityError):
            run(self.db, "meter.sql", day="2026-10-07", count=6, paid_until=2000000)
        run(self.db, "meter.sql", day="2026-10-07", count=50, metric="detail", paid_until=2000000)
        self.assertEqual(self.db.execute("SELECT browse_count FROM square_browse_days").fetchone()[0], 95)
        with self.assertRaises(sqlite3.IntegrityError):
            run(self.db, "meter.sql", day="2026-10-07", count=1, paid_until=1000003)

    def test_membership_confirmation_expiring_during_query_cannot_charge_or_return_posts(self):
        for checked, deadline in [(1000000, 1000003), (1000004, 1060004), (1000000, 1060001), (None, None)]:
            with self.assertRaises(sqlite3.IntegrityError):
                run(self.db, "meter.sql", day="2026-10-07", count=1, paid_until=2000000,
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
                            run(connection, "meter.sql", day="2026-10-07", count=9, paid_until=2000000)
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


class UnifiedMembershipMeterContract(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(":memory:");ready(self.db)
    def tearDown(self):
        self.db.close()
    def command(self, **changes):
        return {"auth":auth(),"membership_level":"freedom","membership_status":"active","membership_block":0,"period_start":900000,"membership_checked":1000000,"membership_deadline":1060000,
            "paid_until":2000000,"chain_time":1000000,"metric":"browse","amount":3,
            "period":0,"day":"1970-01-01",**changes}
    def test_paid_browse_records_each_real_read_without_random_operations(self):
        sql=(SQL/"meter.sql").read_text();c=self.command();self.assertNotIn("operation_id",c);self.assertNotIn("resource_key",c)
        execute(self.db,sql,c);execute(self.db,sql,c)
        self.assertEqual(self.db.execute("SELECT browse_count FROM square_browse_days").fetchone()[0],6)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM membership_operations").fetchone()[0],0)
        with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,{**c,"amount":4,"browse_limit":9})
        self.assertEqual(self.db.execute("SELECT browse_count FROM square_browse_days").fetchone()[0],6)
    def test_expired_membership_and_revoked_identity_leave_no_meter_record(self):
        sql=(SQL/"meter.sql").read_text()
        with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,self.command(paid_until=auth()["now"]))
        self.db.execute("UPDATE mls_devices SET active=0");self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,self.command())
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM membership_operations").fetchone()[0],0)

    def test_missing_fields_invalid_amount_and_overflow_fail_without_partial_meter(self):
        sql=(SQL/"meter.sql").read_text()
        for field in ["metric","amount","period","membership_checked","paid_until","chain_time"]:
            command=self.command();command.pop(field)
            with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,command)
        for amount in [-1,1.5,9007199254740992]:
            with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,self.command(amount=amount))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM membership_operations").fetchone()[0],0)
        execute(self.db,sql,self.command(metric="detail",amount=9007199254740991))
        with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,self.command(metric="detail",amount=1))
        self.assertEqual(self.db.execute("SELECT amount FROM membership_usage").fetchone()[0],9007199254740991)

    def test_committed_publish_retries_keep_first_period_and_reject_mutated_payload(self):
        sql=(SQL/"meter.sql").read_text()
        first=self.command(metric="published",operation_id="publish:post-1",resource_key="post-1",amount=1,period=100)
        execute(self.db,sql,first)
        execute(self.db,sql,{**first,"period":200})
        self.assertEqual(self.db.execute("SELECT period_start,amount FROM membership_operations").fetchall(),[(100,1)])
        self.assertEqual(self.db.execute("SELECT period_start,amount FROM membership_usage").fetchall(),[(100,1)])
        for changes in [{"amount":2},{"resource_key":"post-2"}]:
            with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,{**first,"period":200,**changes})
        browse=self.command()
        execute(self.db,sql,browse)
        execute(self.db,sql,{**browse,"period":200})
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM membership_operations").fetchone()[0],1)
        for field in ["operation_id","resource_key"]:
            incomplete={**first};incomplete.pop(field)
            with self.assertRaises(sqlite3.IntegrityError):execute(self.db,sql,incomplete)
        # 普通读取不拥有发布回执；同名id不能篡改既有发布记录。
        execute(self.db,sql,{**first,"metric":"detail","period":200})
        self.assertEqual(self.db.execute("SELECT metric,resource_key,amount,period_start FROM membership_operations").fetchone(),("published","post-1",1,100))


class ProfileReadBudgetSQLContract(unittest.TestCase):
    """真实资源段：基础资料与会员边界、两侧日额、原子回滚及并发末额。"""
    sql = (SQL / "meter.sql").read_text().split("-- resource budget")[1]
    def setUp(self):
        self.db=sqlite3.connect(":memory:");ready(self.db)
    def tearDown(self):self.db.close()
    def command(self, member=False):
        c={"auth":auth(),"quota":{"member":member,"day_millis":86400000,"charges":[
            {"metric":"profile_requests","amount":1,"cid_limit":1000,"global_limit":100000},
            {"metric":"profile_read_bytes","amount":512*1024,"cid_limit":64*1024*1024,"global_limit":10*1024**3}]}}
        if member:c.update(membership_level="freedom",membership_status="active",membership_block=0,period_start=900000,
            membership_checked=1000000,membership_deadline=1060000,paid_until=2000000,chain_time=1000000)
        return c
    def reserve(self,db=None,command=None):return execute(db or self.db,self.sql,command or self.command())
    def rows(self):
        return (list(self.db.execute("SELECT metric,amount FROM membership_usage ORDER BY metric")),
                list(self.db.execute("SELECT rate_key,request_count FROM rate_windows ORDER BY rate_key")))
    def test_free_avatar_banner_and_member_use_only_daily_summaries(self):
        self.db.execute("DELETE FROM square_memberships");self.db.commit()
        self.reserve();banner=self.command();banner['quota']['charges'][1]['amount']=1536*1024;self.reserve(command=banner)
        self.assertEqual(self.rows()[0],[("profile_read_bytes",2*1024*1024),("profile_requests",2)])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM membership_operations").fetchone()[0],0)
        before=self.rows()
        with self.assertRaises(sqlite3.IntegrityError):self.reserve(command=self.command(True))
        self.assertEqual(self.rows(),before)
    def test_profile_cannot_unlock_original_member_metrics_or_bypass_revocation(self):
        for metric in ['attachment_begins','chat_chunk_operations','upload_bytes','delivery_bytes','media_requests']:
            c=self.command();c['quota']['charges'].append(dict(metric=metric,amount=1,cid_limit=100,global_limit=100))
            with self.subTest(metric=metric),self.assertRaises(sqlite3.IntegrityError):self.reserve(command=c)
            self.assertEqual(self.rows(),([],[]))
        self.reserve(command=self.command(True))
        self.db.execute("UPDATE scheduler_leases SET updated_at=0 WHERE lease_key LIKE 'sync:membership:%'");self.db.commit()
        before=self.rows()
        with self.assertRaises(sqlite3.IntegrityError):self.reserve(command=self.command(True))
        self.assertEqual(self.rows(),before)
        self.reserve()  # 基础头像仍只依赖公民资格。
        self.db.execute("UPDATE mls_devices SET active=0");self.db.commit();before=self.rows()
        with self.assertRaises(sqlite3.IntegrityError):self.reserve()
        self.assertEqual(self.rows(),before)
    def test_cid_or_global_request_or_byte_last_unit_is_atomic(self):
        for side,metric,limit in [('cid','profile_requests',1000),('cid','profile_read_bytes',64*1024*1024),
                                  ('global','profile_requests',100000),('global','profile_read_bytes',10*1024**3)]:
            with self.subTest(side=side,metric=metric):
                self.db.execute('DELETE FROM membership_usage');self.db.execute('DELETE FROM rate_windows');self.db.commit()
                self.reserve();amount=1 if metric=='profile_requests' else 512*1024
                if side=='cid':self.db.execute('UPDATE membership_usage SET amount=? WHERE metric=?',(limit-amount,metric))
                else:self.db.execute('UPDATE rate_windows SET request_count=? WHERE rate_key=?',(limit-amount,'quota:global:0:'+metric))
                self.db.commit();self.reserve();before=self.rows();changes=self.db.total_changes
                with self.assertRaises(sqlite3.IntegrityError):self.reserve()
                self.assertEqual(self.rows(),before);self.assertEqual(self.db.total_changes,changes)
    def test_parallel_last_avatar_budget_has_exactly_one_winner(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'quota.sqlite';db=sqlite3.connect(path);ready(db);self.reserve(db)
            db.execute("UPDATE membership_usage SET amount=? WHERE metric='profile_read_bytes'",(64*1024*1024-512*1024,));db.commit();db.close()
            def attempt(_):
                local=sqlite3.connect(path,timeout=10)
                try:self.reserve(local);return 1
                except sqlite3.IntegrityError:return 0
                finally:local.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:self.assertEqual(sum(pool.map(attempt,range(16))),1)
            db=sqlite3.connect(path)
            self.assertEqual(db.execute("SELECT amount FROM membership_usage WHERE metric='profile_read_bytes'").fetchone()[0],64*1024*1024)
            self.assertEqual(db.execute("SELECT amount FROM membership_usage WHERE metric='profile_requests'").fetchone()[0],2);db.close()
