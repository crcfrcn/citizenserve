"""原文生产SQL在真实SQLite执行，24并发连接；RPC证据是公开合成向量。"""
import concurrent.futures
import copy
import json
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
MAIN = (ROOT / 'cloudflare/schema.sql').read_text()
MAIN += '\n' + (ROOT / 'cloudflare/topup/schema.sql').read_text()
SQL = {n+'_topup': (ROOT / f'cloudflare/topup/{n}.sql').read_text() for n in ['insert','claim','settle','exception']}
SQL['relay_attempt'] = (ROOT / 'cloudflare/sql/relay_attempt.sql').read_text()
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

def row(i=0, tx=None):
    v=copy.deepcopy(TOPUP['order']);v['order_id']=f'top_{i:032x}';v['intent']['intent_id']=f'tpi_{i:032x}'
    v['payment_txid']=tx or f'0x{i+1:064x}'
    return v

def insert(db,o):return execute(db,'insert_topup',{'order':o,'now':1005000})
def before(db,oid):return json.loads(db.execute('SELECT data FROM topup_orders WHERE order_id=?',(oid,)).fetchone()[0])
def save(db,b,a,now=1005000):return execute(db,'settle_topup',{'before':b,'after':a,'now':now})
def change(o,**fields):
    v=copy.deepcopy(o);v['revision']+=1;v.update(fields);return v

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
    def test_identical_order_24_retries_are_idempotent(self):
        outcomes,count=self.parallel(MAIN,lambda db,i:db.execute('SELECT COUNT(*) FROM topup_orders').fetchone()[0] if i is None else insert(db,row()))
        self.assertEqual(sum(outcomes),24);self.assertEqual(count,1)
    def test_payment_and_intent_uniqueness_across_24_connections(self):
        for same_intent in [False,True]:
            def op(db,i):
                if i is None:return db.execute('SELECT COUNT(*) FROM topup_orders').fetchone()[0]
                o=row(i, '0x'+'09'*32) if not same_intent else row()
                if same_intent:o['payment_txid']=f'0x{i:064x}'
                return insert(db,o)
            outcomes,count=self.parallel(MAIN,op);self.assertEqual(sum(outcomes),1);self.assertEqual(count,1)
    def test_intent_exists_before_payment_and_quote_deadline_does_not_destroy_order(self):
        o=row();o['payment_txid']=None;o['payer_signature']=None;o['phase']='awaiting'
        self.assertTrue(insert(self.db,o));a=change(o,phase='verifying',payment_txid='0x'+'09'*32,payer_signature='0x11')
        self.assertTrue(save(self.db,o,a));self.assertEqual(before(self.db,o['order_id'])['phase'],'verifying')
    def test_cas_24_workers_only_one_state_transition(self):
        o=row()
        def op(db,i):
            if i is None:return before(db,o['order_id'])['revision']
            insert(db,o);return save(db,o,change(o,phase='received',exception_reason=f'retry-{i}'))
        outcomes,revision=self.parallel(MAIN,op);self.assertEqual(sum(outcomes),1);self.assertEqual(revision,o['revision']+1)
    def signed(self,i=0,account='0x'+'07'*32):
        o=row(i);self.assertTrue(insert(self.db,o))
        claim='tpc_'+f'{i:032x}';self.assertTrue(execute(self.db,'claim_topup',{'order':o,'account':account,'claim':claim,'now':1005000}))
        payment=copy.deepcopy(TOPUP['payment']);payment['tx_hash']=o['payment_txid']
        signed={'account_id':account,'claim':claim,'nonce':12,'extrinsic':'0x0102','tx_hash':f'0x{i+50:064x}','born':9}
        received=change(o,phase='received',payment=payment);self.assertTrue(save(self.db,o,received));o=received
        a=change(o,phase='signed',payment=payment,signed=signed,scan=9)
        self.assertTrue(save(self.db,o,a));return a
    def test_account_has_one_owner_and_signed_transaction_never_auto_expires(self):
        o=self.signed();other=row(1);insert(self.db,other)
        execute(self.db,'claim_topup',{'order':other,'account':o['signed']['account_id'],'claim':'new','now':999999999})
        self.assertEqual(self.db.execute('SELECT order_id FROM topup_accounts').fetchone()[0],o['order_id'])
    def test_unsigned_lease_expires_but_stale_worker_cannot_save_signed_bytes(self):
        o=row();insert(self.db,o);execute(self.db,'claim_topup',{'order':o,'account':'a','claim':'old','now':1005000})
        execute(self.db,'claim_topup',{'order':o,'account':'a','claim':'new','now':1065000})
        payment=copy.deepcopy(TOPUP['payment']);payment.update(checked_at=1065000,verification_deadline=1125000)
        received=change(o,phase='received',payment=payment);self.assertTrue(save(self.db,o,received,1065000));o=received
        a=change(o,phase='signed',payment=payment,signed={'account_id':'a','claim':'old','nonce':1,'extrinsic':'0x01','tx_hash':'0x'+'aa'*32,'born':9})
        self.assertFalse(save(self.db,o,a,1065000));a['signed']['claim']='new';self.assertTrue(save(self.db,o,a,1065000))
    def test_key_rotation_releases_only_expired_unsigned_lease(self):
        o=row();insert(self.db,o)
        execute(self.db,'claim_topup',{'order':o,'account':'old','claim':'old','now':1005000})
        self.assertFalse(execute(self.db,'claim_topup',{'order':o,'account':'new','claim':'new','now':1005001}))
        self.assertTrue(execute(self.db,'claim_topup',{'order':o,'account':'new','claim':'new','now':1065000}))
        self.assertEqual(self.db.execute('SELECT account_id,claim FROM topup_accounts').fetchall(),[('new','new')])
    def test_one_account_24_different_orders_have_one_execution_owner(self):
        def op(db,i):
            if i is None:return db.execute('SELECT count(*) FROM topup_accounts').fetchone()[0]
            o=row(i);insert(db,o);claim=f'claim-{i}'
            execute(db,'claim_topup',{'order':o,'account':'shared','claim':claim,'now':1005000})
            return db.execute('SELECT count(*) FROM topup_accounts WHERE claim=?',(claim,)).fetchone()[0]==1
        outcomes,count=self.parallel(MAIN,op);self.assertEqual(sum(outcomes),1);self.assertEqual(count,1)
    def test_signed_bytes_and_first_payment_cannot_be_replaced_after_timeout(self):
        o=self.signed()
        for field,value in [('extrinsic','0x0304'),('tx_hash','0x'+'dd'*32),('nonce',13),('account_id','0x'+'88'*32)]:
            a=change(o,phase='broadcast');a['signed'][field]=value;self.assertFalse(save(self.db,o,a),field)
        a=change(o,payment_txid='0x'+'cc'*32);self.assertFalse(save(self.db,o,a))
        self.assertTrue(save(self.db,o,change(o,phase='broadcast',exception_reason='topup_broadcast_outcome_unknown')))
    def proof(self,o):
        v=json.loads((ROOT/'test/contract/settlement.json').read_text())['proof'];v.update(tx_hash=o['signed']['tx_hash'],signer_account_id=o['signed']['account_id'],beneficiary_account_id=o['intent']['account_id'],amount=o['intent']['coin_fen'],remark='topup:'+o['order_id']);return v
    def test_only_exact_fresh_finalized_evidence_can_mark_paid_and_release_account(self):
        o=self.signed();p=self.proof(o)
        for field,value in [('amount','2'),('beneficiary_account_id','0x'+'dd'*32),('signer_account_id','0x'+'dd'*32),('tx_hash','0x'+'dd'*32),('remark','wrong'),('verification_deadline',1005000)]:
            bad=copy.deepcopy(p);bad[field]=value;self.assertFalse(save(self.db,o,change(o,phase='paid',gmb=bad)),field)
        self.assertTrue(save(self.db,o,change(o,phase='paid',gmb=p)))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM topup_accounts').fetchone()[0],0)
        terminal=before(self.db,o['order_id']);self.assertFalse(save(self.db,terminal,change(terminal,phase='broadcast')))
    def test_unsupported_pairs_and_custom_amounts_are_rejected_by_storage(self):
        for token,network in [('USDT','base'),('USDT','solana'),('USDC','tron'),('USDC','bnb')]:
            o=row();o['intent'].update(token=token,network=network);self.assertFalse(insert(self.db,o))
        o=row();o['intent']['pay_amount']='16000000';self.assertFalse(insert(self.db,o))
    def test_same_gmb_hash_cannot_pay_two_orders_even_after_account_rotation(self):
        first=self.signed(0);second=self.signed(1,'0x'+'08'*32)
        a=change(second);a['signed']['tx_hash']=first['signed']['tx_hash'];self.assertFalse(save(self.db,second,a))

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
    def test_actual_rpc_budget_is_three_hundred_calls_not_three_hundred_orders(self):
        source=(ROOT/'cloudflare/topup/storage.rs').read_text();sql=next(s for s in re.findall(r'r#"(.*?)"#',source,re.S) if "topup_rpc_rate_exceeded" not in s and "topup-rpc-assert" in s)
        for i in range(300):self.assertTrue(execute(self.db,sql,{'now':1000000,'key':'topup-rpc:base'}))
        self.assertFalse(execute(self.db,sql,{'now':1000000,'key':'topup-rpc:base'}));self.assertTrue(execute(self.db,sql,{'now':1060000,'key':'topup-rpc:base'}))
