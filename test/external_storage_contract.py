"""原文生产SQL在真实SQLite执行，24并发连接；RPC证据是公开合成向量。"""
import concurrent.futures
import copy
import hashlib
import hmac
import json
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / 'server/cloudflare/schema.sql').read_text()
DOWNLOAD = (ROOT / 'server/cloudflare/download-schema.sql').read_text()
SQL = {n: (ROOT / f'server/cloudflare/sql/{n}.sql').read_text() for n in ['insert_topup','claim_topup','settle_topup','exception_topup','relay_attempt','publish_download']}
TOPUP = json.loads((ROOT / 'test/contract/topup.json').read_text())

def execute(db, name, command):
    sql = SQL.get(name, name)
    db.execute('BEGIN IMMEDIATE')
    try:
        for stmt in sql.split('-- statement')[1:]:
            if not stmt.strip():continue
            db.execute(stmt, (json.dumps(command, separators=(',', ':')),))
        db.commit()
        return True
    except sqlite3.IntegrityError:
        db.rollback()
        return False
    except Exception:
        db.rollback()
        raise

def row(i=0, same_payment=False, same_intent=False):
    v = copy.deepcopy(TOPUP['order'])
    v['order_id'] = f'top_{i:032x}'
    if not same_intent:
        v['intent_id'] = f'tpi_{i:032x}'
    if not same_payment:
        v['evm_tx_hash'] = f'0x{i+1:064x}'
    return v

def payment(o):
    v = copy.deepcopy(TOPUP['payment'])
    v['tx_hash'] = o['evm_tx_hash']
    return v

def insert(db, o):
    return execute(db, 'insert_topup', {'order':o,'payment':payment(o),'now':1005000})

def proof(o):
    v = json.loads((ROOT / 'test/contract/settlement.json').read_text())['proof']
    v['beneficiary_account_id'] = o['account_id']
    v['amount'] = o['coin_fen']
    v['remark'] = 'topup:'+o['order_id']
    return v

def before(db, oid):
    db.row_factory = sqlite3.Row
    return dict(db.execute('SELECT * FROM topup_orders WHERE order_id=?',(oid,)).fetchone())

class ExternalStorage(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.executescript(MAIN)
    def tearDown(self):
        self.db.close()
    def parallel(self, schema, fn):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'test.sqlite'
            db = sqlite3.connect(path, isolation_level=None)
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript(schema)
            db.close()
            def call(i):
                db = sqlite3.connect(path, timeout=30, isolation_level=None)
                try:return fn(db,i)
                finally:db.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
                outcomes=list(pool.map(call,range(24)))
            db=sqlite3.connect(path,isolation_level=None)
            try:return outcomes,fn(db,None)
            finally:db.close()
    def test_same_intent_payment_24_competing_order_ids_are_idempotent(self):
        def op(db,i):
            if i is None:return db.execute('SELECT COUNT(*) FROM topup_orders').fetchone()[0]
            return insert(db,row(i,True,True))
        outcomes,count=self.parallel(MAIN,op)
        self.assertEqual(sum(outcomes),24)
        self.assertEqual(count,1)
    def test_one_payment_cannot_be_claimed_by_24_intents(self):
        def op(db,i):
            if i is None:return db.execute('SELECT COUNT(*) FROM topup_orders').fetchone()[0]
            return insert(db,row(i,True,False))
        outcomes,count=self.parallel(MAIN,op)
        self.assertEqual(sum(outcomes),1)
        self.assertEqual(count,1)
    def test_one_intent_cannot_claim_24_payments(self):
        def op(db,i):
            if i is None:return db.execute('SELECT COUNT(*) FROM topup_orders').fetchone()[0]
            return insert(db,row(i,False,True))
        outcomes,count=self.parallel(MAIN,op)
        self.assertEqual(sum(outcomes),1)
        self.assertEqual(count,1)
    def test_freshness_and_intent_deadline_are_checked_in_write_transaction(self):
        o=row()
        for now in [999999,1065000,1600000]:
            self.assertFalse(execute(self.db,'insert_topup',{'order':o,'payment':payment(o),'now':now}))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM topup_orders').fetchone()[0],0)
    def test_claim_24_workers_has_one_owner_and_never_auto_expires(self):
        o=row()
        def op(db,i):
            if i is None:
                b=before(db,o['order_id'])
                self.assertTrue(execute(db,'claim_topup',{'id':o['order_id'],'claim':b['settlement_claim_id'],'now':999999999}))
                self.assertFalse(execute(db,'claim_topup',{'id':o['order_id'],'claim':'tpc_'+'ff'*16,'now':999999999}))
                return db.execute('SELECT COUNT(*) FROM topup_orders').fetchone()[0]
            insert(db,o)
            return execute(db,'claim_topup',{'id':o['order_id'],'claim':f'tpc_{i:032x}','now':1005000})
        outcomes,count=self.parallel(MAIN,op)
        self.assertEqual(sum(outcomes),1)
        self.assertEqual(count,1)
    def claimed(self,o):
        self.assertTrue(insert(self.db,o))
        self.assertTrue(execute(self.db,'claim_topup',{'id':o['order_id'],'claim':'tpc_'+'33'*16,'now':1005000}))
        return before(self.db,o['order_id'])
    def test_paid_retries_need_complete_evidence_and_do_not_change_settled_time(self):
        o=self.claimed(row())
        p=proof(o)
        c={'before':o,'proof':p,'payment':payment(o),'now':1005000}
        self.assertTrue(execute(self.db,'settle_topup',c))
        c['before']=before(self.db,o['order_id']);c['now']+=1
        self.assertTrue(execute(self.db,'settle_topup',c))
        self.assertEqual(before(self.db,o['order_id'])['settled_at'],1005000)
        for f,bad in [('block_hash','0x'+'dd'*32),('extrinsic_index',1),('evidence_hash','dd'*32),('amount','2'),('beneficiary_account_id','0x'+'dd'*32)]:
            c2=copy.deepcopy(c);c2['proof'][f]=bad
            self.assertFalse(execute(self.db,'settle_topup',c2),f)
    def test_payment_reorg_expired_proof_and_mutated_snapshot_cannot_mark_paid(self):
        o=self.claimed(row())
        c={'before':o,'proof':proof(o),'payment':payment(o),'now':1005000}
        for n in range(4):
            v=copy.deepcopy(c)
            if n==0:v['payment']['block_hash']='0x'+'dd'*32
            elif n==1:v['now']=1065000
            elif n==2:v['before']['intent_hash']='ee'*32
            else:v['before']['settlement_claim_id']='tpc_'+'44'*16
            self.assertFalse(execute(self.db,'settle_topup',v))
        self.assertEqual(before(self.db,o['order_id'])['status'],'pending')
    def test_same_gmb_transfer_cannot_settle_24_orders(self):
        def op(db,i):
            if i is None:return db.execute("SELECT COUNT(*) FROM topup_orders WHERE status='paid'").fetchone()[0]
            o=row(i);insert(db,o);execute(db,'claim_topup',{'id':o['order_id'],'claim':'tpc_'+'33'*16,'now':1005000});o=before(db,o['order_id'])
            return execute(db,'settle_topup',{'before':o,'proof':proof(o),'payment':payment(o),'now':1005000})
        outcomes,count=self.parallel(MAIN,op)
        self.assertEqual(sum(outcomes),1);self.assertEqual(count,1)
    def test_exception_exact_claim_reason_and_terminal_state(self):
        o=self.claimed(row());c={'id':o['order_id'],'claim':o['settlement_claim_id'],'reason':'manual review','now':1005000}
        self.assertTrue(execute(self.db,'exception_topup',c));self.assertTrue(execute(self.db,'exception_topup',c));c['reason']='another reason';self.assertFalse(execute(self.db,'exception_topup',c));self.assertFalse(execute(self.db,'claim_topup',c))
    def attempt(self,i=0,same=False):
        return {'relay_id':f'cer_{i:032x}','extrinsic_sha256':f'{0 if same else i:064x}','tx_hash':f'0x{0 if same else i:064x}','request_ip_hash':'33'*32,'byte_size':100}
    def test_broadcast_ip_cross_connections_hard_cap_is_twenty(self):
        def op(db,i):
            if i is None:return db.execute('SELECT COUNT(*) FROM chain_extrinsic_relays').fetchone()[0]
            return execute(db,'relay_attempt',{'attempt':self.attempt(i),'now':1000000})
        outcomes,count=self.parallel(MAIN,op);self.assertEqual(sum(outcomes),20);self.assertEqual(count,20)
    def test_broadcast_24_claimants_share_one_durable_attempt(self):
        def op(db,i):
            if i is None:return db.execute('SELECT COUNT(*) FROM chain_extrinsic_relays').fetchone()[0]
            a=self.attempt(i,True);a['request_ip_hash']=f'{i:064x}'
            return execute(db,'relay_attempt',{'attempt':a,'now':1000000})
        outcomes,count=self.parallel(MAIN,op);self.assertEqual(sum(outcomes),24);self.assertEqual(count,1)
    def test_uncertain_broadcast_survives_window_and_never_releases_for_resend(self):
        self.assertTrue(execute(self.db,'relay_attempt',{'attempt':self.attempt(0,True),'now':1000000}))
        self.db.execute("UPDATE chain_extrinsic_relays SET relay_status='unknown'")
        self.assertTrue(execute(self.db,'relay_attempt',{'attempt':self.attempt(1,True),'now':999999999}))
        self.assertEqual(self.db.execute('SELECT relay_id,active_claim FROM chain_extrinsic_relays').fetchall(),[('cer_'+'00'*16,1)])
    def test_completed_broadcast_window_can_release_but_crashed_submitting_cannot(self):
        for status,count in [('broadcast',2),('failed',2),('submitting',1)]:
            self.db.execute('DELETE FROM chain_extrinsic_relays')
            execute(self.db,'relay_attempt',{'attempt':self.attempt(0,True),'now':1000000})
            self.db.execute('UPDATE chain_extrinsic_relays SET relay_status=?',(status,))
            execute(self.db,'relay_attempt',{'attempt':self.attempt(1,True),'now':1600000})
            self.assertEqual(self.db.execute('SELECT COUNT(*) FROM chain_extrinsic_relays').fetchone()[0],count)
    def test_publication_24_cas_writers_have_one_winner(self):
        pub=json.loads((ROOT/'test/contract/downloads.json').read_text())['publication']
        def op(db,i):
            if i is None:return db.execute("SELECT revision FROM citizenchain_download_publications WHERE platform='macos'").fetchone()[0]
            p={**pub,'asset_sha256':f'{i:064x}'}
            return execute(db,'publish_download',{'platform':'macos','input':{'expected_revision':0,'publication':p},'now':1000000})
        outcomes,revision=self.parallel(DOWNLOAD,op);self.assertEqual(sum(outcomes),1);self.assertEqual(revision,1)
    def test_withdrawal_idempotence_and_old_revision_never_overwrites(self):
        db=sqlite3.connect(':memory:',isolation_level=None);db.executescript(DOWNLOAD)
        pub=json.loads((ROOT/'test/contract/downloads.json').read_text())['publication'];c={'platform':'macos','input':{'expected_revision':0,'publication':pub},'now':1000000}
        self.assertTrue(execute(db,'publish_download',c));self.assertTrue(execute(db,'publish_download',c));self.assertEqual(db.execute("SELECT revision FROM citizenchain_download_publications WHERE platform='macos'").fetchone()[0],1)
        v=copy.deepcopy(c);v['input']['publication']=None;self.assertFalse(execute(db,'publish_download',v));v['input']['expected_revision']=1;self.assertTrue(execute(db,'publish_download',v));self.assertFalse(execute(db,'publish_download',c));self.assertTrue(execute(db,'publish_download',v));db.close()
    def test_publication_hmac_vector_is_raw_api_body_not_reserialized(self):
        v=json.loads((ROOT/'test/contract/downloads.json').read_text());message='\n'.join([v['method'],v['path'],v['time'],v['nonce'],hashlib.sha256(v['body'].encode()).hexdigest()]);self.assertEqual(hmac.new(v['key'].encode(),message.encode(),hashlib.sha256).hexdigest(),v['signature'])
    def test_actual_rpc_budget_is_three_hundred_calls_not_three_hundred_orders(self):
        source=(ROOT/'server/cloudflare/repositories/topup.rs').read_text();sql=next(s for s in re.findall(r'r#"(.*?)"#',source,re.S) if "topup-rpc:8453" in s)
        for i in range(300):self.assertTrue(execute(self.db,sql,{'now':1000000}))
        self.assertFalse(execute(self.db,sql,{'now':1000000}));self.assertTrue(execute(self.db,sql,{'now':1060000}))
