"""Real production SQL and concurrent SQLite writers, no substitute persistence model."""
import concurrent.futures,copy,hashlib,json,sqlite3,tempfile,unittest
from pathlib import Path
from community_storage_contract import ready,auth,execute,SQL
from content_storage_contract import command,run as content_run
import content_storage_contract as content

def system(db,file,**cmd):
    with db:
        raw=json.dumps(cmd,separators=(',',':'))
        return [db.execute(s,(raw,)).rowcount for s in (SQL/file).read_text().split('-- statement')[1:]]

def ident(kind,fields):return {'fanout':'nj_','delivery':'nd_','maintenance':'mt_'}[kind]+hashlib.sha256(json.dumps(fields,separators=(',',':')).encode()).hexdigest()
def device(db,n):
    a=auth();a['device_id']=f'{n:064x}';a['session_token_hash']=f'{n+100:064x}'
    db.execute('INSERT INTO mls_devices VALUES(?,?,?,?,?,1,?,?,?)',(a['cid_number'],a['device_id'],1,a['account_id'],'0x'+a['device_id'],1000000,1000000,1000000))
    db.execute('INSERT INTO square_sessions VALUES(?,?,?,?,?,?,?)',(a['session_token_hash'],a['cid_number'],1,a['account_id'],a['device_id'],1000000,2000000));db.commit();return a

def endpoint(db,a=None,token=None):
    a=a or auth();r={'push_provider':'apns','push_token':token or a['device_id'],'apns_environment':'sandbox','expires_at':2000000}
    execute(db,(SQL/'register_push_endpoint.sql').read_text(),{'auth':a,'input':r});return r

def job(db,n=1):
    id=ident('fanout',[str(n)]);db.execute("INSERT INTO notification_jobs(job_id,source_kind,source_key,cid_number,post_id,tx_hash,created_at,expires_at,updated_at) VALUES(?,'post',?,?,?, ?,1000000,2000000,1000000)",(id,'post:'+str(n),auth()['cid_number'],'sqp_'+str(n),'0x'+f'{n:064x}'));db.commit();return id

def lease(id,kind='fanout',attempt=1,now=1000003,nonce='ab'*16):return {'id':id,'kind':kind,'token':nonce,'attempts':attempt,'acquired_at':now,'expires_at':now+120000}
def claim(db,id,kind='fanout',now=1000003,nonce='ab'*16):system(db,'claim_notification_job.sql',kind=kind,id=id,now=now,nonce=nonce);return lease(id,kind,now=now,nonce=nonce)
def delivery(db,j,n=1,revision=1):
    id=ident('delivery',[str(n)]);db.execute("INSERT INTO notification_deliveries(delivery_id,job_id,cid_number,account_id,binding_revision,device_id,endpoint_revision,updated_at) VALUES(?,?,?,?,1,?,?,1000000)",(id,j,auth()['cid_number'],auth()['account_id'],auth()['device_id'],revision));db.commit();return id
class NotificationStorageContract(unittest.TestCase):
    def setUp(self):self.db=sqlite3.connect(':memory:');ready(self.db)
    def tearDown(self):self.db.close()
    def test_device_endpoint_idempotent_rotate_delete_recreate_generation(self):
        r=endpoint(self.db);a=self.db.execute('SELECT endpoint_revision FROM push_endpoints').fetchone()[0];endpoint(self.db);self.assertEqual(self.db.execute('SELECT endpoint_revision FROM push_endpoints').fetchone()[0],a)
        endpoint(self.db,token='bc'*32);b=self.db.execute('SELECT endpoint_revision FROM push_endpoints').fetchone()[0];self.assertGreater(b,a)
        execute(self.db,(SQL/'delete_push_endpoint.sql').read_text(),{'auth':auth()});endpoint(self.db,token=r['push_token']);self.assertGreater(self.db.execute('SELECT endpoint_revision FROM push_endpoints').fetchone()[0],b)
    def test_no_live_token_theft_expired_or_revoked_can_reclaim(self):
        r=endpoint(self.db);a=device(self.db,2)
        with self.assertRaises(sqlite3.IntegrityError):endpoint(self.db,a,r['push_token'])
        self.db.execute('UPDATE mls_devices SET active=0 WHERE device_id=?',(auth()['device_id'],));self.db.commit();endpoint(self.db,a,r['push_token']);self.assertEqual(self.db.execute('SELECT device_id FROM push_endpoints').fetchone()[0],a['device_id'])
    def test_expiry_and_authorization_rechecked_atomically(self):
        for field,value in [('now',1060000),('binding_revision',2),('device_id','aa'*32),('session_token_hash','aa'*32)]:
            a=auth();a[field]=value
            with self.assertRaises(sqlite3.IntegrityError):endpoint(self.db,a)
        for ttl in [0,7776000001]:
            with self.assertRaises(sqlite3.IntegrityError):execute(self.db,(SQL/'register_push_endpoint.sql').read_text(),{'auth':auth(),'input':{'push_provider':'fcm','push_token':'1234567890abcdef','apns_environment':None,'expires_at':auth()['now']+ttl}})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM push_endpoints').fetchone()[0],0)
    def test_eight_endpoint_parallel_capacity(self):
        with tempfile.TemporaryDirectory(prefix='citizenserve-s6-') as folder:
            path=Path(folder)/'db';db=sqlite3.connect(path);ready(db);auths=[device(db,n) for n in range(2,26)];db.close()
            def attempt(a):
                db=sqlite3.connect(path,timeout=15)
                try:endpoint(db,a);return True
                except sqlite3.IntegrityError:return False
                finally:db.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:out=list(pool.map(attempt,auths))
            self.assertEqual(sum(out),8);db=sqlite3.connect(path);self.assertEqual(db.execute('SELECT COUNT(*) FROM push_endpoints').fetchone()[0],8);db.close()
    def test_claim_duplicate_and_stale_lease_cannot_commit(self):
        j=job(self.db);l=claim(self.db,j);claim(self.db,j,nonce='cd'*16)
        self.assertEqual(self.db.execute('SELECT lease_token,attempts FROM notification_jobs').fetchone(),(l['token'],1))
        bad={**l,'token':'cd'*16}
        with self.assertRaises(sqlite3.IntegrityError):system(self.db,'commit_fanout.sql',lease=bad,job={'cursor_created_at':None,'cursor_cid_number':None},deliveries=[],complete=True,cursor=None,now=1000003)
    def test_fanout_delivery_and_cursor_atomic(self):
        endpoint(self.db);j=job(self.db);l=claim(self.db,j);d={'delivery_id':ident('delivery',['p']),**{k:auth()[k] for k in ['cid_number','account_id','device_id','binding_revision']},'endpoint_revision':1}
        cmd={'lease':l,'job':{'cursor_created_at':None,'cursor_cid_number':None},'deliveries':[d,d],'complete':False,'cursor':{'created_at':999999,'cid_number':auth()['cid_number']},'now':1000003};system(self.db,'commit_fanout.sql',**cmd)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM notification_deliveries').fetchone()[0],1);self.assertEqual(self.db.execute('SELECT cursor_created_at,state FROM notification_jobs').fetchone(),(999999,'pending'))
        with self.assertRaises(sqlite3.IntegrityError):system(self.db,'commit_fanout.sql',**cmd)
    def test_invalid_old_generation_never_deletes_rotated_endpoint(self):
        endpoint(self.db);j=job(self.db);d=delivery(self.db,j);l=claim(self.db,d,'delivery');endpoint(self.db,token='bc'*32)
        system(self.db,'complete_delivery.sql',lease=l,outcome={'kind':'invalid_endpoint'},now=1000004);self.assertEqual(self.db.execute('SELECT COUNT(*) FROM push_endpoints').fetchone()[0],1);self.assertEqual(self.db.execute('SELECT state FROM notification_deliveries').fetchone()[0],'cancelled')
    def test_invalid_current_generation_removed_and_terminal_cas(self):
        endpoint(self.db);j=job(self.db);d=delivery(self.db,j);l=claim(self.db,d,'delivery');system(self.db,'complete_delivery.sql',lease=l,outcome={'kind':'invalid_endpoint'},now=1000004);self.assertEqual(self.db.execute('SELECT COUNT(*) FROM push_endpoints').fetchone()[0],0)
        with self.assertRaises(sqlite3.IntegrityError):system(self.db,'complete_delivery.sql',lease=l,outcome={'kind':'accepted'},now=1000005)
    def test_four_durable_retries_block_without_cron_reset(self):
        j=job(self.db);d=delivery(self.db,j);now=1000003
        for n in range(4):
            l=claim(self.db,d,'delivery',now=now,nonce=f'{n+1:032x}');system(self.db,'complete_delivery.sql',lease=l,outcome={'kind':'retry','delay_seconds':1},now=now+1);now+=1001
        self.assertEqual(self.db.execute('SELECT state,attempts FROM notification_deliveries').fetchone(),('blocked',4));claim(self.db,d,'delivery',now=now+1000000);self.assertEqual(self.db.execute('SELECT attempts FROM notification_deliveries').fetchone()[0],4)
    def test_post_and_outbox_transaction_rollback_and_after_gc_idempotency(self):
        c=content.ContentStorageContract();c.db=self.db;cmd=c.reserve();self.db.execute("UPDATE square_media_assets SET asset_state='ready'");self.db.commit();c.complete(cmd);confirmed=c.confirm(cmd);self.assertEqual(self.db.execute('SELECT COUNT(*) FROM notification_jobs').fetchone()[0],1);c.confirm(cmd);self.assertEqual(self.db.execute('SELECT COUNT(*) FROM notification_jobs').fetchone()[0],1)
        self.db.execute('DELETE FROM notification_jobs');self.db.commit();content_run(self.db,'confirm_post.sql',confirmed);self.assertEqual(self.db.execute('SELECT COUNT(*) FROM notification_jobs').fetchone()[0],0)
        cmd2=command(2);cmd2['limits']['active_uploads']=2;c.reserve(cmd2);self.db.execute("UPDATE square_media_assets SET asset_state='ready'");self.db.commit();c.complete(cmd2);self.db.execute("CREATE TRIGGER fail_outbox BEFORE INSERT ON notification_jobs BEGIN SELECT RAISE(ABORT,'simulated outbox failure'); END");self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):c.confirm(cmd2,tx=11)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_posts WHERE post_id='sqp_2'").fetchone()[0],0)
