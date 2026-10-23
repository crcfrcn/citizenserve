"""执行Cloudflare运行仓直接使用的SQLite SQL；不把此结果冒充线上D1验收。"""
import concurrent.futures
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / "cloudflare/schema.sql").read_text()
SCHEMA += '\n' + (ROOT / 'cloudflare/topup/schema.sql').read_text()
CREATE = (ROOT / "cloudflare/sql/create_registration.sql").read_text()
CAS = (ROOT / "cloudflare/sql/cas_registration.sql").read_text()


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
        self.assertTrue({'membership_usage', 'membership_operations'}.issubset({row[0] for row in tables}))
        self.assertEqual(len(tables), 42)  # 原账户注销表保留，另含统一会员计量及幂等操作两表。
        self.assertTrue({'account_deletion_assert', 'account_deletion_challenges', 'account_deletions'}.issubset({row[0] for row in tables}))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)

    def test_authority_view_and_only_two_price_columns_switch_atomically(self):
        import re
        from auth_storage_contract import seed,activate,issue_session
        old_view="CREATE VIEW IF NOT EXISTS authorized_business_sessions AS\nSELECT s.session_token_hash,s.cid_number,s.account_id,s.binding_revision,s.device_id,\n s.created_at,s.expires_at,c.checked_at_millis,c.verification_deadline_millis,\n a.registration_scope,a.service_origin,a.chain_scope,a.institution\nFROM square_sessions s\nJOIN users u ON u.cid_number=s.cid_number AND u.account_id=s.account_id AND u.binding_revision=s.binding_revision AND u.cid_status='active'\nJOIN mls_devices d ON d.cid_number=s.cid_number AND d.device_id=s.device_id AND d.account_id=s.account_id AND d.binding_revision=s.binding_revision AND d.active=1\nJOIN cid_admissions a ON a.cid_number=s.cid_number AND a.institution=u.institution AND a.source='turnstile'\nJOIN user_identity_checks c ON c.cid_number=s.cid_number AND json_extract(c.row_json,'$.authoritative_current')=1 AND json_extract(c.row_json,'$.chain_scope')=a.chain_scope AND c.account_id=s.account_id AND c.binding_revision=s.binding_revision\nWHERE NOT EXISTS(SELECT 1 FROM account_deletions x WHERE x.cid_number=s.cid_number AND x.state='pending');"
        current_view=re.search(r'CREATE VIEW authorized_business_sessions AS[\s\S]*?;',SCHEMA)[0]
        column="  authorized_price_fen INTEGER CHECK(authorized_price_fen IS NULL OR (authorized_price_fen>=0 AND authorized_price_fen<=9007199254740991)),\n"
        db=sqlite3.connect(':memory:');db.executescript(SCHEMA.replace(column,''));seed(db);activate(db);issue_session(db,1)
        db.execute('DROP VIEW authorized_business_sessions');db.execute(old_view);db.commit()
        before=db.execute('SELECT row_json FROM user_identity_checks').fetchone()[0]
        def migrate():
            for table in ['square_memberships','square_creator_subscriptions']:
                db.execute('ALTER TABLE '+table+' ADD COLUMN authorized_price_fen INTEGER CHECK(authorized_price_fen IS NULL OR (authorized_price_fen>=0 AND authorized_price_fen<=9007199254740991))')
            db.execute('DROP VIEW authorized_business_sessions');db.execute(current_view)
        try:
            db.execute('BEGIN');migrate();self.assertEqual(db.execute('SELECT count(*) FROM authorized_business_sessions').fetchone()[0],1)
            raise RuntimeError('simulate deployment transaction failure')
        except RuntimeError:db.rollback()
        self.assertNotIn('authorized_price_fen',[r[1] for r in db.execute('PRAGMA table_info(square_memberships)')])
        self.assertIn('checked_at_millis',db.execute("SELECT sql FROM sqlite_master WHERE name='authorized_business_sessions'").fetchone()[0])
        with db:migrate()
        for table in ['square_memberships','square_creator_subscriptions']:
            self.assertIn('authorized_price_fen',[r[1] for r in db.execute('PRAGMA table_info('+table+')')])
        self.assertEqual(db.execute('SELECT row_json FROM user_identity_checks').fetchone()[0],before)
        self.assertEqual(db.execute('SELECT count(*) FROM authorized_business_sessions').fetchone()[0],1)
        db.executescript(SCHEMA);self.assertEqual(db.execute('SELECT count(*) FROM square_sessions').fetchone()[0],1)
        db.close()

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
        columns={r[1] for r in db.execute('PRAGMA table_xinfo(topup_orders)')}
        self.assertTrue({'data','network','payment_txid','gmb_tx_hash','phase'}.issubset(columns))
        indexes={r[1] for r in db.execute('PRAGMA index_list(topup_orders)')}
        self.assertIn('idx_topup_gmb',indexes)
        self.assertIn('active_claim',{r[1] for r in db.execute('PRAGMA table_info(chain_extrinsic_relays)')})
        self.assertEqual(db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0],42);db.close()


class ResourceBudgetStorageContract(unittest.TestCase):
    """CID/全站同一生产SQL事务；用真实会话view验证失败回滚，不以模型替代SQL。"""
    def setUp(self):
        from community_storage_contract import ready
        self.db = sqlite3.connect(':memory:')
        ready(self.db)
        self.sql = (ROOT / 'cloudflare/sql/meter.sql').read_text().split('-- resource budget\n', 1)[1]

    def tearDown(self):
        self.db.close()

    def command(self, *, member=False, amount=1, cid_limit=3, global_limit=5, metric='chat_commands'):
        from community_storage_contract import auth
        return {'auth': auth(), 'quota': {'member': member, 'day_millis': 86400000,
            'charges': [{'metric': metric, 'amount': amount, 'cid_limit': cid_limit, 'global_limit': global_limit}]},
            'membership_checked': 1000000, 'membership_deadline': 1060000, 'membership_level': 'freedom',
            'membership_status': 'active', 'membership_block': 0, 'period_start': 900000,
            'paid_until': 2000000, 'chain_time': 1000000}

    def reserve(self, command):
        from community_storage_contract import execute
        return execute(self.db, self.sql, command)

    def test_free_chat_only_uses_current_citizen_session_and_aggregates(self):
        self.db.execute('DELETE FROM square_memberships'); self.db.commit()
        self.reserve(self.command())
        self.assertEqual(self.db.execute('SELECT amount FROM membership_usage').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT request_count FROM rate_windows').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM membership_operations').fetchone()[0], 0)

    def test_cid_exact_limit_and_global_failure_roll_back_the_whole_batch(self):
        self.reserve(self.command(amount=3))
        with self.assertRaises(sqlite3.IntegrityError): self.reserve(self.command())
        self.assertEqual(self.db.execute('SELECT amount FROM membership_usage').fetchone()[0], 3)
        self.assertEqual(self.db.execute('SELECT request_count FROM rate_windows').fetchone()[0], 3)
        self.db.execute('UPDATE membership_usage SET amount=0'); self.db.execute('UPDATE rate_windows SET request_count=5'); self.db.commit()
        before=self.db.total_changes
        with self.assertRaises(sqlite3.IntegrityError): self.reserve(self.command())
        self.assertEqual(self.db.total_changes,before,'全站已满不应先写CID再回滚增加写成本')
        self.assertEqual(self.db.execute('SELECT amount FROM membership_usage').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT request_count FROM rate_windows').fetchone()[0], 5)

    def test_member_quota_rechecks_latest_record_health_and_permission(self):
        command = self.command(member=True, metric='delivery_bytes')
        self.reserve(command)
        for mutation in ["UPDATE square_memberships SET subscription_status='suspended'", "UPDATE square_memberships SET paid_until=1000003", "UPDATE square_memberships SET finalized_block_number=1", "UPDATE scheduler_leases SET updated_at=1 WHERE lease_key LIKE 'sync:membership:%'"]:
            with self.subTest(mutation=mutation):
                self.db.execute('SAVEPOINT mutation')
                self.db.execute(mutation)
                # execute使用真实事务；显式回滚后保留首次预扣，失败不能多占也不能少扣。
                try:
                    raw=json.dumps(command)
                    for stmt in self.sql.split('-- statement')[1:]: self.db.execute(stmt,(raw,))
                    self.fail('旧会员许可不能继续预扣')
                except sqlite3.IntegrityError:
                    self.db.execute('ROLLBACK TO mutation'); self.db.execute('RELEASE mutation')
        self.assertEqual(self.db.execute('SELECT amount FROM membership_usage').fetchone()[0], 1)

    def test_missing_invalid_duplicate_and_nonmember_object_costs_fail_closed(self):
        import copy
        source=self.command()
        bad=[]
        for field in ['metric','amount','cid_limit','global_limit']:
            command=copy.deepcopy(source); command['quota']['charges'][0].pop(field); bad.append(command)
        for amount in [0,-1,1.5,9007199254740992]:
            command=copy.deepcopy(source); command['quota']['charges'][0]['amount']=amount; bad.append(command)
        command=copy.deepcopy(source); command['quota']['charges']*=2; bad.append(command)
        bad.append(self.command(metric='delivery_bytes'))
        for command in bad:
            with self.subTest(command=command['quota']):
                with self.assertRaises(sqlite3.IntegrityError): self.reserve(command)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM membership_usage').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM rate_windows').fetchone()[0], 0)

    def test_revoked_session_cannot_debit_any_counter(self):
        self.db.execute('UPDATE mls_devices SET active=0'); self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError): self.reserve(self.command())
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM membership_usage').fetchone()[0], 0)


    def test_utc_day_changes_both_aggregate_keys_without_resetting_old_usage(self):
        self.reserve(self.command(amount=3))
        command=self.command();command['auth']['now']=86400100;command['auth']['deadline']=86460100
        self.db.execute('UPDATE scheduler_leases SET updated_at=?',(command['auth']['now'],));self.db.commit()
        self.reserve(command)
        self.assertEqual(self.db.execute('SELECT period_start,amount FROM membership_usage ORDER BY period_start').fetchall(),[(0,3),(86400000,1)])
        self.assertEqual(self.db.execute('SELECT rate_key,request_count,expires_at FROM rate_windows ORDER BY rate_key').fetchall(),[('quota:global:0:chat_commands',3,86400000),('quota:global:1:chat_commands',1,172800000)])

    def test_parallel_writers_cannot_both_spend_the_last_main_budget(self):
        from community_storage_contract import ready,execute
        with tempfile.TemporaryDirectory() as area:
            file=Path(area)/'quota.sqlite';db=sqlite3.connect(file);ready(db);db.close()
            def spend(_):
                db=sqlite3.connect(file,timeout=10)
                try:execute(db,self.sql,self.command(cid_limit=1,global_limit=1));return True
                except sqlite3.IntegrityError:return False
                finally:db.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:out=list(pool.map(spend,range(2)))
            self.assertEqual(sorted(out),[False,True])
            db=sqlite3.connect(file)
            self.assertEqual(db.execute('SELECT amount FROM membership_usage').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT request_count FROM rate_windows').fetchone()[0],1);db.close()


class DeletionDayQuotaContract(unittest.TestCase):
    def test_actual_exclusion_keeps_all_nine_current_day_counters_without_pending_rows(self):
        import re,json
        from community_storage_contract import ROOT,ready,auth
        db=sqlite3.connect(':memory:');ready(db);cid=auth()['cid_number'];day=86400000
        source=(ROOT/'cloudflare/repositories/deletion.rs').read_text()
        guard=re.search(r'const CURRENT_QUOTA_EXCLUSION:\s*&str\s*=\s*"([^"]+)";',source)[1]
        metrics=['chat_connections','chat_commands','chat_frame_bytes','chat_deliveries','attachment_begins','chat_chunk_operations','upload_bytes','delivery_bytes','media_requests']
        for metric in metrics:
            for period in [0,day]:db.execute('INSERT INTO membership_usage VALUES(?,?,?,7,1)',(cid,metric,period))
        db.execute("INSERT INTO membership_usage VALUES(?,'detail',?,1,1)",(cid,day));db.commit()
        raw=json.dumps({'job':{'cid_number':cid},'quota_day':day});condition="cid_number=json_extract(?1,'$.job.cid_number')"+guard
        with db:db.execute('DELETE FROM membership_usage WHERE rowid IN(SELECT rowid FROM membership_usage WHERE '+condition+' LIMIT 100)',(raw,))
        self.assertEqual(db.execute('SELECT COUNT(*),MIN(period_start),SUM(amount) FROM membership_usage').fetchone(),(9,day,63))
        self.assertIsNone(db.execute('SELECT 1 FROM membership_usage WHERE '+condition+' LIMIT 1',(raw,)).fetchone())
        # 下一UTC日的同一条件不保护已经结束的旧日，当前日额度从未被清零。
        raw=json.dumps({'job':{'cid_number':cid},'quota_day':day+86400000})
        self.assertEqual(db.execute('SELECT COUNT(*) FROM membership_usage WHERE '+condition,(raw,)).fetchone()[0],9)
        db.close()
