"""Maintenance SQL rollback, persisted phases and exactly-once quota release."""
import copy,json,sqlite3,unittest
from community_storage_contract import ready,auth,SQL,execute
from content_storage_contract import command,run as content_run,projection,credential,reserve_asset
from notification_storage_contract import system,ident,lease

def task(db,work='uploads',slot=300000,now=3000000000):
    id=ident('maintenance',[work,str(slot)]);system(db,'schedule_maintenance.sql',key='cron:'+work,work=work,slot=slot,nonce='ab'*16,job_id=id,now=now);system(db,'claim_maintenance_job.sql',id=id,nonce='cd'*16,now=now);return lease(id,'maintenance',now=now,nonce='cd'*16)
def locator(c,reason='expired_upload',lapse=None):
    u=c['upload'];return {'cid_number':u['cid_number'],'upload_id':u['upload_id'],'post_id':u['post_id'],'private_keys':[f"square/{u['cid_number']}/posts/{u['post_id']}/manifest.json"],'public_keys':[c['assets'][0]['object_key'],c['assets'][0]['derivative_object_key']],'byte_size':250,'object_count':3,'video_seconds':0,'reason':reason,'lapse_at':lapse,'profile_generation':None,'object_etag':None,'prior_status':'completed','deletion_started':False,'private_done':False,'public_done':False,'purge_done':False}
class MaintenanceStorageContract(unittest.TestCase):
    def setUp(self):self.db=sqlite3.connect(':memory:');ready(self.db)
    def tearDown(self):self.db.close()
    def complete(self):
        c=command();content_run(self.db,'reserve_upload.sql',c);self.db.execute("UPDATE square_media_assets SET asset_state='ready'");self.db.commit();content_run(self.db,'complete_upload.sql',c);return c
    def begin(self,l,loc,proof=None):system(self.db,'begin_background_delete.sql',lease=l,locator=loc,locator_json=json.dumps(loc),proof=proof,now=l['acquired_at'])
    def finish(self,l,loc,proof=None):system(self.db,'finish_background_delete.sql',lease=l,locator=loc,proof=proof,now=l['acquired_at']+1)
    def test_repeated_schedule_active_kind_slot_not_skipped(self):
        l=task(self.db);task(self.db,slot=600000)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM maintenance_jobs').fetchone()[0],1);self.assertEqual(self.db.execute('SELECT last_slot FROM scheduler_leases').fetchone()[0],300000)
    def test_progress_lease_cas_and_unknown_failure_four_attempts(self):
        l=task(self.db);bad={**l,'token':'ee'*16}
        with self.assertRaises(sqlite3.IntegrityError):system(self.db,'progress_maintenance_job.sql',lease=bad,progress='{}',state='done',progressed=False,delay=1,now=l['acquired_at'])
        now=l['acquired_at']
        for n in range(4):
            if n:system(self.db,'claim_maintenance_job.sql',id=l['id'],nonce=l['token'],now=now)
            system(self.db,'progress_maintenance_job.sql',lease=l,progress='{}',state='pending',progressed=False,delay=1,now=now);now+=1001
        system(self.db,'claim_maintenance_job.sql',id=l['id'],nonce=l['token'],now=now);self.assertEqual(self.db.execute('SELECT state,attempts FROM maintenance_jobs').fetchone(),('blocked',4))
    def test_completed_upload_location_before_cloud_delete_release_after_all(self):
        c=self.complete();l=task(self.db);loc=locator(c);self.begin(l,loc)
        self.assertEqual(self.db.execute('SELECT status FROM square_uploads').fetchone()[0],'deleting');self.assertEqual(json.loads(self.db.execute('SELECT progress_json FROM maintenance_jobs').fetchone()[0])['locator']['upload_id'],loc['upload_id'])
        with self.assertRaises(sqlite3.IntegrityError):self.finish(l,loc)
        loc.update(private_done=True,public_done=True,purge_done=True);self.finish(l,loc);self.assertEqual(self.db.execute("SELECT byte_size FROM resource_totals WHERE resource_key='square_storage'").fetchone()[0],0);self.assertEqual(self.db.execute('SELECT reservation_state FROM resource_reservations').fetchone()[0],'released_consumed');self.assertEqual(self.db.execute('SELECT image_count FROM resource_usage').fetchone()[0],1)
        with self.assertRaises(sqlite3.IntegrityError):self.finish(l,loc)
    def test_expired_unused_released_once_but_writing_retained(self):
        c=command();content_run(self.db,'reserve_upload.sql',c);system(self.db,'release_expired_upload.sql',now=3000000000);system(self.db,'release_expired_upload.sql',now=3000000001);self.assertEqual(self.db.execute('SELECT reservation_state FROM resource_reservations').fetchone()[0],'released')
        db=sqlite3.connect(':memory:');ready(db);content_run(db,'reserve_upload.sql',c);db.execute("UPDATE square_media_assets SET asset_state='uploading'");db.commit();system(db,'release_expired_upload.sql',now=3000000000);self.assertEqual(db.execute('SELECT reservation_state FROM resource_reservations').fetchone()[0],'reserved');db.close()
    def test_cleanup_notice_same_lapse_outbox_and_twenty_four_hours(self):
        content_run(self.db,'project_subscription.sql',projection());self.db.execute("UPDATE square_memberships SET paid_until=1000000,subscription_status='terminated'");self.db.execute("INSERT INTO resource_totals VALUES(?,'square_storage',100000000001,1,0,1000000)",(auth()['cid_number'],));self.db.commit();now=3000000000
        proof={'cid_number':auth()['cid_number'],'account_id':auth()['account_id'],'binding_revision':1,'lapse_at':1000000,'checked_at':now,'deadline':now+60000,'limit':100000000000};cmd={'proof':proof,'job_id':ident('fanout',['storage']),'now':now};system(self.db,'enqueue_notification.sql',**cmd);system(self.db,'enqueue_notification.sql',**cmd);self.assertEqual(self.db.execute('SELECT COUNT(*) FROM notification_jobs').fetchone()[0],1)
        self.assertEqual(self.db.execute('SELECT storage_cleanup_notified_at,storage_cleanup_lapse_at FROM square_memberships').fetchone(),(now,1000000))
    def test_renewal_projection_clears_old_notice(self):
        p=projection();content_run(self.db,'project_subscription.sql',p);self.db.execute('UPDATE square_memberships SET storage_cleanup_notified_at=1,storage_cleanup_lapse_at=1000000');self.db.commit();p=projection(block=10,tx=2);p['projection']['platform'][0]['paid_until']=3000000;content_run(self.db,'project_subscription.sql',p);self.assertEqual(self.db.execute('SELECT storage_cleanup_notified_at,storage_cleanup_lapse_at FROM square_memberships').fetchone(),(None,None))
    def test_profile_delete_holds_generation_until_complete(self):
        c=reserve_asset(self.db,credential());self.db.execute("UPDATE profile_asset_uploads SET state='completed',object_etag='etag1'");self.db.commit();l=task(self.db)
        loc={'cid_number':c['cid_number'],'upload_id':c['upload_id'],'post_id':'','private_keys':[c['object_key']],'public_keys':[],'byte_size':100,'object_count':1,'video_seconds':0,'reason':'profile_staging','lapse_at':None,'profile_generation':c['generation'],'object_etag':'etag1','prior_status':'completed','deletion_started':False,'private_done':False,'public_done':False,'purge_done':False};self.begin(l,loc);self.assertEqual(self.db.execute('SELECT state FROM profile_asset_uploads').fetchone()[0],'writing')
        with self.assertRaises(sqlite3.IntegrityError):reserve_asset(self.db,credential(2))
        loc.update(private_done=True,public_done=True,purge_done=True);self.finish(l,loc);self.assertEqual(self.db.execute('SELECT state FROM profile_asset_uploads').fetchone()[0],'superseded')
    def test_current_profile_reference_prevents_background_deletion(self):
        c=reserve_asset(self.db,credential());self.db.execute("UPDATE profile_asset_uploads SET state='completed',object_etag='etag1'");self.db.execute('INSERT INTO user_profiles(cid_number,avatar_object_key,avatar_content_hash) VALUES(?,?,?)',(c['cid_number'],c['object_key'],c['sha256']));self.db.commit();l=task(self.db);loc={'cid_number':c['cid_number'],'upload_id':c['upload_id'],'post_id':'','private_keys':[c['object_key']],'public_keys':[],'byte_size':100,'object_count':1,'video_seconds':0,'reason':'profile_staging','lapse_at':None,'profile_generation':c['generation'],'object_etag':'etag1','prior_status':'completed','deletion_started':False,'private_done':False,'public_done':False,'purge_done':False}
        with self.assertRaises(sqlite3.IntegrityError):self.begin(l,loc)
    def test_unknown_external_delete_persists_resume_locator_without_releasing(self):
        c=self.complete();l=task(self.db);loc=locator(c);self.begin(l,loc);loc['private_done']=True;loc['deletion_started']=True;system(self.db,'progress_maintenance_job.sql',lease=l,progress=json.dumps({'locator':loc}),state='pending',progressed=True,delay=1,now=l['acquired_at']);self.assertEqual(self.db.execute('SELECT reservation_state FROM resource_reservations').fetchone()[0],'used');self.assertTrue(json.loads(self.db.execute('SELECT progress_json FROM maintenance_jobs').fetchone()[0])['locator']['private_done'])

    def test_expired_membership_deletion_rechecks_notice_delay_and_renewal(self):
        c=self.complete();worker=__import__('content_storage_contract').ContentStorageContract();worker.db=self.db;worker.confirm(c)
        content_run(self.db,'project_subscription.sql',projection(tx=20));now=3000000000
        self.db.execute("UPDATE square_memberships SET paid_until=1000000,subscription_status='terminated',storage_cleanup_notified_at=?,storage_cleanup_lapse_at=1000000",(now-86400000,));self.db.execute("UPDATE resource_totals SET byte_size=100000000250 WHERE resource_key='square_storage'");self.db.commit();l=task(self.db,'storage',now=now)
        loc=locator(c,'expired_membership',1000000);loc['prior_status']='published';proof={'cid_number':auth()['cid_number'],'account_id':auth()['account_id'],'binding_revision':1,'lapse_at':1000000,'checked_at':now,'deadline':now+60000,'limit':100000000000}
        self.db.execute('UPDATE square_memberships SET storage_cleanup_notified_at=?',(now-86399999,));self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):self.begin(l,loc,proof)
        self.db.execute('UPDATE square_memberships SET storage_cleanup_notified_at=?',(now-86400000,));self.db.commit();self.begin(l,loc,proof)
        loc.update(private_done=True,public_done=True,purge_done=True);self.db.execute('UPDATE square_memberships SET paid_until=?',(now+86400000,));self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):self.finish(l,loc,proof)
        self.assertEqual(self.db.execute("SELECT byte_size FROM resource_totals WHERE resource_key='square_storage'").fetchone()[0],100000000250)
        self.assertEqual(self.db.execute('SELECT reservation_state FROM resource_reservations').fetchone()[0],'used')
    def test_missing_proof_or_locator_cannot_bypass_null_sql_predicate(self):
        c=self.complete();l=task(self.db);loc=locator(c);self.begin(l,loc);loc.update(private_done=True,public_done=True,purge_done=True)
        self.db.execute("UPDATE maintenance_jobs SET progress_json='{}'");self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):self.finish(l,loc)
