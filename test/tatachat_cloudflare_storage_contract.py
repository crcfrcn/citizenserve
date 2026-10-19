"""真实SQLite执行正式聊天SQL，覆盖事务、幂等、代际与注销围栏；不代替Cloudflare实测。"""
import json
import re
import concurrent.futures
import tempfile
import sqlite3
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = (ROOT / 'server/cloudflare/tatachat/schema.sql').read_text()
COMMIT = (ROOT / 'server/cloudflare/tatachat/mailbox_commit.sql').read_text().split('\n-- next\n')
ACK = (ROOT / 'server/cloudflare/tatachat/mailbox_acknowledge.sql').read_text()
CLOCK = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))"


class TataChatCloudflareStorage(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript(SCHEMA)
        self.now = int(time.time() * 1000)

    def tearDown(self):
        self.db.close()

    def commit(self, fingerprint='same', operation='first', devices=('a', 'b')):
        context = {'message_id': 'message-1', 'fingerprint': fingerprint,
                   'operation': operation, 'expires_at': self.now + 60000}
        records = [{'record': {'recipient_user_id': 'recipient',
                               'recipient_device_id': device,
                               'accepted_at_millis': self.now,
                               'expires_at_millis': self.now + 60000,
                               'openmls_ciphertext': 'c3ludGhldGlj'},
                    'wire_bytes': 64} for device in devices]
        with self.db:
            self.db.execute(COMMIT[0], (json.dumps(context),))
            self.db.execute(COMMIT[1], (json.dumps({**context, 'records': records}),))
            self.db.execute(COMMIT[2], (json.dumps(context),))

    def count(self, table):
        return self.db.execute('SELECT count(*) FROM ' + table).fetchone()[0]

    def test_complete_message_and_outbox_commit_together(self):
        self.commit()
        self.assertEqual((self.count('message_receipts'), self.count('messages'),
                          self.count('push_jobs')), (1, 2, 2))

    def test_conflict_rolls_back_whole_transaction(self):
        self.commit()
        before = self.db.iterdump()
        before = list(before)
        with self.assertRaises(sqlite3.IntegrityError):
            self.commit('different', 'second', ('c',))
        self.assertEqual(list(self.db.iterdump()), before)

    def test_same_retry_does_not_resurrect_acknowledged_device(self):
        self.commit()
        self.db.execute(ACK, (json.dumps({'user_id': 'recipient', 'device_id': 'a',
                                       'ids': ['message-1']}),))
        self.db.commit()
        self.commit(operation='retry')
        self.assertEqual(self.count('messages'), 1)
        self.assertEqual(self.count('push_jobs'), 1)
        self.assertEqual(self.db.execute('SELECT operation FROM message_receipts').fetchone()[0], 'first')

    def test_other_device_ack_does_not_delete_delivery(self):
        self.commit()
        self.db.execute(ACK, (json.dumps({'user_id': 'recipient', 'device_id': 'foreign',
                                       'ids': ['message-1']}),))
        self.assertEqual(self.count('messages'), 2)

    def test_expired_server_deadline_rolls_back_writes(self):
        guard = ('INSERT INTO tatachat_assert VALUES(CASE WHEN ?1>' + CLOCK +
                 ' THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING')
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.db.execute('INSERT INTO message_receipts VALUES(?,?,?,?)',
                                ('denied', 'fingerprint', 'nonce', self.now + 60000))
                self.db.execute(guard, (self.now - 10000,))
        self.assertEqual(self.count('message_receipts'), 0)

    def test_failed_delivery_cannot_leave_receipt_or_push_task(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.commit(devices=('a', 'a'))
        self.assertEqual((self.count('message_receipts'), self.count('messages'),
                          self.count('push_jobs')), (0, 0, 0))

    def test_old_lease_does_not_finish_reclaimed_job(self):
        self.commit(devices=('a',))
        self.db.execute("UPDATE push_jobs SET state='leased',attempts=2,lease_id='new',lease_until=?", (self.now + 60000,))
        result = self.db.execute("UPDATE push_jobs SET state='completed' WHERE lease_id='old'")
        self.assertEqual(result.rowcount, 0)
        self.assertEqual(self.db.execute('SELECT state FROM push_jobs').fetchone()[0], 'leased')

    def test_push_token_cannot_be_claimed_by_another_device(self):
        self.db.execute("INSERT INTO push_endpoints VALUES('u','a','android',1,'synthetic','{}')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO push_endpoints VALUES('u','b','android',1,'synthetic','{}')")

    def test_invalid_old_generation_does_not_remove_replaced_endpoint(self):
        self.db.execute("INSERT INTO push_endpoints VALUES('u','a','android',8,'synthetic','{}')")
        self.db.execute("DELETE FROM push_endpoints WHERE user_id='u' AND device_id='a' AND platform='android' AND generation=7")
        self.assertEqual(self.count('push_endpoints'), 1)

    def test_frozen_module_rejects_data_operations(self):
        self.db.execute('UPDATE tatachat_module SET frozen=1')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO tatachat_assert VALUES(CASE WHEN EXISTS(SELECT 1 FROM tatachat_module WHERE frozen=0) THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING")


    def test_retiring_one_mailbox_preserves_other_recipient_and_shared_receipt(self):
        self.commit()
        self.db.execute("INSERT INTO messages VALUES('message-1','other','a','{}',64,?,?)", (self.now,self.now+60000))
        self.db.execute("DELETE FROM messages WHERE user_id='recipient'")
        self.assertEqual(self.db.execute("SELECT user_id FROM messages").fetchone()[0],'other')
        self.assertEqual(self.count('message_receipts'),1)
        self.assertEqual(self.count('push_jobs'),0)

    def test_user_fence_rejects_late_mail_and_reserved_attachment_writer(self):
        self.db.execute("INSERT INTO attachments(attachment_id,generation,fingerprint,metadata,creator_user,creator_device,state,expires_at) VALUES('asset','generation','fp','{}','recipient','a','pending',?)", (self.now+60000,))
        self.db.execute("INSERT INTO attachment_uploads(attempt_id,attachment_id,generation,object_key,upload,state) VALUES('attempt','asset','generation','chat/key','{}','reserved')")
        self.db.execute("INSERT INTO account_deletion_fences VALUES('recipient',?,?)", ('11'*32,self.now))
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.commit()
        self.assertEqual(self.count('messages'),0)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE attachment_uploads SET state='writing' WHERE attempt_id='attempt'")
        self.assertEqual(self.db.execute("SELECT state FROM attachment_uploads").fetchone()[0],'reserved')
        # 已在writing的尝试不能因安装冻结就被当作已终止；定位必须保留。
        self.db.execute("DELETE FROM account_deletion_fences")
        self.db.execute("UPDATE attachment_uploads SET state='writing'")
        self.db.execute("INSERT INTO account_deletion_fences VALUES('recipient',?,?)",('11'*32,self.now))
        self.assertEqual(self.db.execute("SELECT state FROM attachment_uploads").fetchone()[0],'writing')


if __name__ == '__main__':
    unittest.main()


class AttachmentResourceStorage(unittest.TestCase):
    """直接提取生产stock/独占SQL，不用内存模型冒充跨请求原子性。"""
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.executescript(SCHEMA)
        self.text=(ROOT/'server/cloudflare/tatachat/attachment_store.rs').read_text()
        self.stock=re.search(r'let stock\s*=\s*r#"([\s\S]*?)"#;',self.text)[1]
        self.writing=re.search(r'let writing\s*=\s*r#"([\s\S]*?)"#;',self.text)[1]
        self.insert=next(json.loads('"'+m+'"') for m in re.findall(r'"((?:[^"\\]|\\.)*)"',self.text) if m.startswith('INSERT INTO attachments('))
        self.now=int(time.time()*1000)

    def tearDown(self): self.db.close()

    def context(self, name='one', *, user='sender', size=9, pending=1, count=2, capacity=18, global_count=3, global_bytes=27):
        return {'metadata':{'attachment_id':name,'sender_user_id':user,'sender_device_id':'phone','cipher_byte_size':size,'expires_at_millis':self.now+60000},
            'user':user,'device':'phone','fingerprint':name,'generation':'generation-'+name,
            'stock':{'pending':pending,'count':count,'bytes':capacity,'global_count':global_count,'global_bytes':global_bytes}}

    def test_pending_limit_is_atomic_and_does_not_insert_partial_metadata(self):
        raw=json.dumps(self.context())
        with self.db:self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                raw=json.dumps(self.context('two'));self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM attachments').fetchone()[0],1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM attachment_chunks').fetchone()[0],0)

    def test_deleting_still_occupies_bytes_and_count_and_same_id_does_not_recharge(self):
        first=self.context(size=18);raw=json.dumps(first)
        with self.db:self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        self.db.execute("UPDATE attachments SET state='deleting'");self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                raw=json.dumps(self.context('two'));self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        # stock本身只对新ID占量；归属/指纹仍由begin原事务独立断言。
        self.db.execute(self.stock,(json.dumps(first),))
        self.assertEqual(self.db.execute('SELECT count(*) FROM attachments').fetchone()[0],1)

    def test_global_stock_blocks_another_cid(self):
        raw=json.dumps(self.context(global_count=1))
        with self.db:self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                raw=json.dumps(self.context('other',user='another',global_count=1));self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))

    def test_two_connections_cannot_both_take_last_pending_slot(self):
        with tempfile.TemporaryDirectory() as area:
            file=Path(area)/'stock.sqlite';db=sqlite3.connect(file);db.executescript(SCHEMA);db.close()
            def create(name):
                db=sqlite3.connect(file,timeout=10)
                try:
                    with db:
                        # 原write的断言首先取得写事务，之后额度检查与写入不可分开。
                        db.execute("INSERT INTO tatachat_assert VALUES(1) ON CONFLICT(value) DO NOTHING")
                        raw=json.dumps(self.context(name));db.execute(self.stock,(raw,));db.execute(self.insert,(raw,))
                    return True
                except sqlite3.IntegrityError:return False
                finally:db.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:out=list(pool.map(create,['one','two']))
            self.assertEqual(sorted(out),[False,True])

    def test_writing_unknown_counts_against_concurrency_and_indexes_preserve_legacy(self):
        raw=json.dumps(self.context())
        with self.db:self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        upload={'attachment_id':'one','generation':'generation-one','attempt_id':'attempt','object_key':'key','chunk':{'chunk_index':0}}
        self.db.execute("INSERT INTO attachment_uploads(attempt_id,attachment_id,generation,object_key,upload,state) VALUES('attempt','one','generation-one','key',?,'writing')",(json.dumps(upload),));self.db.commit()
        raw=json.dumps({'user':'sender','writing_limit':1})
        with self.assertRaises(sqlite3.IntegrityError):self.db.execute(self.writing,(raw,))
        self.db.rollback()
        self.db.execute("UPDATE attachment_uploads SET state='written'");self.db.commit();self.db.execute(self.writing,(raw,))
        # 普通索引不丢弃旧定位；并发独占必须靠实际条件写，不能靠新唯一索引强删历史。
        self.db.execute("INSERT INTO attachment_uploads(attempt_id,attachment_id,generation,object_key,upload,state) VALUES('old','one','generation-one','old-key',?,'writing')",(json.dumps(upload),))
        self.assertEqual(self.db.execute('SELECT count(*) FROM attachment_uploads').fetchone()[0],2)
        names={r[1] for r in self.db.execute('PRAGMA index_list(attachments)')}
        self.assertIn('attachment_creator_state',names)


    def test_deleting_count_alone_blocks_new_files(self):
        for name in ['one','two']:
            raw=json.dumps(self.context(name,pending=2,capacity=27))
            with self.db:self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        self.db.execute("UPDATE attachments SET state='deleting'");self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                raw=json.dumps(self.context('three',pending=2,capacity=27));self.db.execute(self.stock,(raw,));self.db.execute(self.insert,(raw,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM attachments').fetchone()[0],2)


class ChatCleanupStorageContract(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.executescript(SCHEMA)
        source=(ROOT/'server/cloudflare/tatachat/maintenance.rs').read_text()
        def sql(name):return re.search(r'const '+name+r':\s*&str\s*=\s*"([^"]+)";',source)[1]
        self.claim=sql('CLEANUP_CLAIM');self.finish=sql('CLEANUP_FINISH')
        self.messages=sql('CLEANUP_MESSAGES');self.receipts=sql('CLEANUP_MESSAGE_RECEIPTS');self.slots=sql('CLEANUP_SLOTS');self.next=sql('CLEANUP_NEXT')
    def tearDown(self):self.db.close()
    def test_claim_finish_cas_and_pending_due_are_shared_by_all_consumers(self):
        self.db.execute("INSERT INTO maintenance(slot,state) VALUES(0,'pending')")
        lease=self.db.execute(self.claim,(0,'first',60000,1)).fetchone()[0]
        self.assertEqual(json.loads(lease)['failures'],0)
        self.assertIsNone(self.db.execute(self.claim,(0,'other',60001,2)).fetchone())
        next_lease=self.db.execute(self.claim,(0,'second',120000,60000)).fetchone()[0]
        self.assertEqual(self.db.execute(self.finish,(0,lease,60001,'completed',0,None)).rowcount,0)
        self.assertEqual(self.db.execute(self.finish,(0,next_lease,60001,'pending',61001,json.dumps({'failures':2}))).rowcount,1)
        self.assertIsNone(self.db.execute(self.claim,(0,'early',120000,61000)).fetchone())
        retry=self.db.execute(self.claim,(0,'retry',121001,61001)).fetchone()[0]
        self.assertEqual(json.loads(retry)['failures'],2)
    def test_expired_rows_are_bounded_and_receipts_cannot_cascade_live_messages(self):
        self.db.execute("INSERT INTO message_receipts VALUES('live','fp','live',1)")
        self.db.execute("INSERT INTO messages VALUES('live','user','device','{}',1,0,10000)")
        for n in range(1001):
            key=str(n);self.db.execute('INSERT INTO message_receipts VALUES(?,?,?,1)',(key,'fp',key))
            self.db.execute("INSERT INTO messages VALUES(?,'user','device','{}',1,0,1)",(key,))
        self.assertEqual(self.db.execute(self.messages,(2,1000)).rowcount,1000)
        self.assertEqual(self.db.execute(self.receipts,(2,1000)).rowcount,1000)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM messages WHERE message_id='live'").fetchone()[0],1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM messages').fetchone()[0],2)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM message_receipts').fetchone()[0],2)
    def test_terminal_slot_retention_never_deletes_pending_or_leased(self):
        for slot,state in [(0,'completed'),(300000,'failed'),(600000,'pending'),(900000,'leased'),(1200000,'completed')]:
            self.db.execute('INSERT INTO maintenance(slot,state) VALUES(?,?)',(slot,state))
        self.assertEqual(self.db.execute(self.slots,(900000,1)).rowcount,1)
        self.assertEqual(self.db.execute(self.slots,(900000,1000)).rowcount,1)
        self.assertEqual(self.db.execute('SELECT slot,state FROM maintenance ORDER BY slot').fetchall(),[(600000,'pending'),(900000,'leased'),(1200000,'completed')])

    def test_next_due_uses_existing_expiry_and_cleanup_indexes_without_table_scan(self):
        plan=' '.join(str(row) for row in self.db.execute('EXPLAIN QUERY PLAN '+self.next,(1000,)))
        self.assertNotRegex(plan,r'SCAN attachments')
        self.assertIn('attachment_cleanup',plan);self.assertIn('attachment_expiry',plan)
        self.assertIsNone(self.db.execute(self.next,(1000,)).fetchone()[0])
