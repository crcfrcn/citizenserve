"""真实SQLite执行正式聊天SQL，覆盖事务、幂等、代际与注销围栏；不代替Cloudflare实测。"""
import json
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
