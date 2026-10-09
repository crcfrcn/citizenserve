"""Actual publication/quota SQL; confirm_post includes an atomic notification outbox."""
import concurrent.futures
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from community_storage_contract import auth, ready, execute, constant, SQL


def upload(number=1, images=1):
    a=auth()
    return {"upload_id":f"squ_{number}","post_id":f"sqp_{number}","cid_number":a["cid_number"],"account_id":a["account_id"],"post_type":"document","manifest_hash":"a"*64,"manifest_byte_size":100,"storage_receipt_id":f"sqr_{number}","estimated_bytes":100+images*150,"status":"prepared","expires_at":a["now"]+900000,"created_at":a["now"],"content_hash":None,"completed_at":None,"media_items":[]}


def command(number=1,images=1):
    u=upload(number,images)
    assets=[]
    for index in range(images):
        prefix=f"square/{u['cid_number']}/posts/{u['post_id']}/media/{index}"
        assets.append({**{k:u[k] for k in ('upload_id','post_id','cid_number','account_id')},"media_index":index,"media_kind":"image","object_key":prefix+"/source.webp","upload_method":"r2_put","resource_key":"square_image_freedom","content_type":"image/webp","byte_size":100,"sha256":"b"*64,"derivative_kind":"thumbnail","derivative_object_key":prefix+"/thumbnail.webp","derivative_content_type":"image/webp","derivative_byte_size":50,"derivative_sha256":"c"*64,"asset_state":"prepared","width":100,"height":100,"duration_seconds":None,"created_at":auth()["now"],"updated_at":auth()["now"]})
    return {"auth":auth(),"upload":u,"assets":assets,"membership_checked":1000000,"membership_deadline":1060000,"period_start":900000,"paid_until":2000000,"chain_time":1000000,"image_count":images,"video_seconds":0,"limits":{"active_uploads":1,"monthly_images":300,"monthly_video_seconds":18000,"storage_bytes":100000000000}}


def run(db,file,cmd):
    return execute(db,(SQL/file).read_text(),cmd)


def evidence(tx=1,block=9,action="subscribe"):
    a=auth()
    return {"tx_hash":f"0x{tx:064x}","cid_number":a["cid_number"],"account_id":a["account_id"],"block_hash":f"0x{block:064x}","block_number":block,"extrinsic_index":4,"action_kind":action,"request_hash":"d"*64,"chain_timestamp":1000000}


def projection(block=9,tx=1,tiers=None):
    a=auth()
    p={"cid_number":a["cid_number"],"account_id":a["account_id"],"membership_level":"freedom","started_at":800000,"last_charged_at":900000,"last_charged_price_fen":199900,"authorized_price_fen":199900,"paid_until":2000000,"subscription_status":"active"}
    result={"auth":a,"projection":{"anchor":{"number":block,"hash":f"0x{block:064x}","parent_hash":f"0x{max(0,block-1):064x}"},"checked_at":1000000,"verification_deadline":1060000,"chain_time":1000000,"platform":[p],"creators":[],"tiers":[],"evidence":evidence(tx,block)}}
    if tiers is not None:
        result["projection"]["tiers"]=[{"creator_cid_number":a["cid_number"],"creator_account_id":a["account_id"],"tiers":tiers}]
    return result


def credential(number=1,kind="avatar"):
    a=auth()
    return {"upload_id":f"spa_{number}","cid_number":a["cid_number"],"kind":kind,"object_key":f"profile/{a['cid_number']}/{kind}","content_type":"image/webp","byte_size":100,"sha256":f"{number:064x}","generation":0,"prior_etag":None,"object_etag":None,"state":"prepared","created_at":a["now"],"expires_at":a["now"]+900000,"started_at":None,"completed_at":None}


def reserve_asset(db,c):
    run(db,"reserve_profile_asset.sql",{"auth":auth(),"credential":c})
    db.row_factory=sqlite3.Row
    result=dict(db.execute("SELECT * FROM profile_asset_uploads WHERE upload_id=?",(c["upload_id"],)).fetchone())
    db.row_factory=None
    return result


def claim(db,c,now=None):
    a=auth()
    if now is not None:a["now"]=now
    execute(db,constant("media.rs","CLAIM"),{"auth":a,"id":c["upload_id"]})


class ContentStorageContract(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(":memory:")
        ready(self.db)
    def tearDown(self):self.db.close()
    def reserve(self,cmd=None):
        cmd=cmd or command()
        run(self.db,"reserve_upload.sql",cmd)
        return cmd
    def complete(self,cmd):run(self.db,"complete_upload.sql",cmd)
    def delete_start(self,cmd,post=False):execute(self.db,constant("uploads.rs","DELETE"),{**cmd,"post":post})
    def confirm(self,cmd,tx=10):
        fact={"post_id":cmd["upload"]["post_id"],"cid_number":auth()["cid_number"],"account_id":auth()["account_id"],"post_category":"normal","post_type":"document","content_hash":"a"*64,"storage_receipt_id":cmd["upload"]["storage_receipt_id"],"created_block":9,"created_at":1000000,"evidence":evidence(tx,9,"publish_post")}
        c={**cmd,"fact":fact,"title":None,"excerpt":"文字"}
        run(self.db,"confirm_post.sql",c)
        return c
    def test_reserve_keeps_all_rows_in_one_transaction_and_ttl(self):
        c=self.reserve()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_media_assets").fetchone()[0],1)
        self.assertEqual(self.db.execute("SELECT reservation_state,byte_size FROM resource_reservations").fetchone(),('reserved',250))
        with self.assertRaises(sqlite3.IntegrityError):self.reserve(command(2))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_uploads").fetchone()[0],1)
        self.assertEqual(c['upload']['expires_at']-c['upload']['created_at'],900000)
    def test_duplicate_asset_failure_rolls_back_reservation_and_upload(self):
        c=command();c['assets'].append(copy.deepcopy(c['assets'][0]))
        with self.assertRaises(sqlite3.IntegrityError):self.reserve(c)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM resource_reservations").fetchone()[0],0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM square_uploads").fetchone()[0],0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM rate_windows").fetchone()[0],0)
    def test_hourly_prepare_limit_uses_cid_and_resets_only_at_expiry(self):
        key='upload:cid_number:'+auth()['cid_number']
        self.db.execute('INSERT INTO rate_windows VALUES(?,29,?)',(key,auth()['now']+1));self.db.commit()
        self.reserve()
        self.assertEqual(self.db.execute('SELECT request_count FROM rate_windows').fetchone()[0],30)
        c=command(2);c['limits']['active_uploads']=3
        with self.assertRaisesRegex(sqlite3.IntegrityError,'rate_windows.request_count'):self.reserve(c)
        self.db.execute('UPDATE rate_windows SET expires_at=?',(auth()['now'],));self.db.commit();self.reserve(c)
        self.assertEqual(self.db.execute('SELECT request_count,expires_at FROM rate_windows').fetchone(),(1,auth()['now']+3600000))
    def test_parallel_hourly_limit_has_only_one_final_slot(self):
        with tempfile.TemporaryDirectory(prefix='citizenserve-s4-') as folder:
            path=Path(folder)/'db';db=sqlite3.connect(path);ready(db)
            db.execute('INSERT INTO rate_windows VALUES(?,29,?)',('upload:cid_number:'+auth()['cid_number'],auth()['now']+3600000));db.commit();db.close()
            def attempt(n):
                db=sqlite3.connect(path,timeout=10);c=command(n);c['limits']['active_uploads']=100
                try:run(db,'reserve_upload.sql',c);return True
                except sqlite3.IntegrityError:return False
                finally:db.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(attempt,range(1,25)))
            self.assertEqual(sum(results),1)
            db=sqlite3.connect(path)
            self.assertEqual(db.execute('SELECT request_count FROM rate_windows').fetchone()[0],30)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM square_uploads').fetchone()[0],1);db.close()
    def test_used_plus_reserved_images_video_and_storage_are_enforced(self):
        for field,value in [('monthly_images',0),('monthly_video_seconds',0),('storage_bytes',249)]:
            db=sqlite3.connect(':memory:');ready(db);c=command();c['limits'][field]=value
            if field=='monthly_video_seconds':c['video_seconds']=1
            with self.assertRaises(sqlite3.IntegrityError):run(db,'reserve_upload.sql',c)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM resource_reservations').fetchone()[0],0);db.close()
        self.db.execute("INSERT INTO resource_usage VALUES(?, 'square_upload',900000,2000000,0,300,0,1000000)",(auth()['cid_number'],));self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):self.reserve()
    def test_cross_period_pending_storage_still_counts(self):
        c=self.reserve();self.db.execute('UPDATE resource_reservations SET period_start=800000');self.db.commit()
        nextc=command(2);nextc['limits']['active_uploads']=2;nextc['limits']['storage_bytes']=499
        with self.assertRaises(sqlite3.IntegrityError):self.reserve(nextc)
        nextc['limits']['storage_bytes']=500;nextc['limits']['monthly_images']=1;self.reserve(nextc)
    def test_expired_reservation_does_not_count_against_current_capacity(self):
        self.reserve();self.db.execute('UPDATE resource_reservations SET expires_at=1000000');self.db.commit();self.reserve(command(2))
    def test_complete_is_exactly_once_and_keeps_period_from_reservation(self):
        c=self.reserve();self.complete(c);self.complete(c)
        self.assertEqual(self.db.execute("SELECT image_count,byte_size,period_start FROM resource_usage").fetchone(),(1,250,900000))
        self.assertEqual(self.db.execute("SELECT byte_size,object_count FROM resource_totals").fetchone(),(250,3))
        self.assertEqual(self.db.execute("SELECT status,content_hash FROM square_uploads").fetchone(),('completed','a'*64))
    def test_complete_expiry_or_manifest_conflict_rolls_back_every_counter(self):
        c=self.reserve();bad=copy.deepcopy(c);bad['upload']['manifest_hash']='f'*64
        with self.assertRaises(sqlite3.IntegrityError):self.complete(bad)
        self.db.execute("UPDATE square_uploads SET expires_at=1000000");self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):self.complete(c)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM resource_totals").fetchone()[0],0)
    def test_execution_time_and_authority_change_are_rechecked(self):
        for mutation in ["UPDATE mls_devices SET active=0","UPDATE users SET binding_revision=2","DELETE FROM cid_admissions"]:
            db=sqlite3.connect(':memory:');ready(db);db.execute(mutation);db.commit()
            with self.assertRaises(sqlite3.IntegrityError):run(db,'reserve_upload.sql',command())
            self.assertEqual(db.execute('SELECT COUNT(*) FROM resource_reservations').fetchone()[0],0);db.close()
        c=command();c['membership_deadline']=auth()['now']
        with self.assertRaises(sqlite3.IntegrityError):self.reserve(c)
        c=command();c['chain_time']=c['paid_until']
        with self.assertRaises(sqlite3.IntegrityError):self.reserve(c)
    def test_publish_needs_completed_ready_upload_and_strict_transaction_fact(self):
        c=self.reserve()
        with self.assertRaises(sqlite3.IntegrityError):self.confirm(c)
        self.complete(c);self.db.execute("UPDATE square_media_assets SET asset_state='error'");self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):self.confirm(c)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM chain_transaction_confirmations').fetchone()[0],0)
        self.db.execute("UPDATE square_media_assets SET asset_state='ready'");self.db.commit();p=self.confirm(c);run(self.db,'confirm_post.sql',p)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM square_posts').fetchone()[0],1)
        p['fact']['evidence']['request_hash']='f'*64
        with self.assertRaises(sqlite3.IntegrityError):run(self.db,'confirm_post.sql',p)
    def test_wrong_content_anchor_or_wallet_cannot_publish(self):
        c=self.reserve();self.complete(c);bad=copy.deepcopy(c);bad['upload']['storage_receipt_id']='other'
        with self.assertRaises(sqlite3.IntegrityError):self.confirm(bad)
        bad=copy.deepcopy(c);bad['auth']['account_id']='0x'+'ef'*32
        with self.assertRaises(sqlite3.IntegrityError):self.confirm(bad)
    def test_delete_has_durable_locators_and_releases_storage_once_never_monthly(self):
        c=self.reserve();self.complete(c);self.confirm(c);self.delete_start(c,True)
        self.assertEqual(self.db.execute('SELECT status FROM square_uploads').fetchone()[0],'deleting')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM square_media_assets').fetchone()[0],1)
        with self.assertRaises(sqlite3.IntegrityError):run(self.db,'release_content.sql',c)
        # 模拟稍后重试；同时刷新权威身份核验与会话，不能用过期授权骗过SQL。
        self.db.execute("UPDATE square_uploads SET expires_at=1000000");self.db.commit();run(self.db,'release_content.sql',c);run(self.db,'release_content.sql',c)
        self.assertEqual(self.db.execute('SELECT byte_size,object_count FROM resource_totals').fetchone(),(0,0))
        self.assertEqual(self.db.execute('SELECT image_count FROM resource_usage').fetchone()[0],1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM square_posts').fetchone()[0],0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM square_media_assets').fetchone()[0],0)
    def test_cancel_cannot_delete_published_post(self):
        c=self.reserve();self.complete(c);self.confirm(c)
        with self.assertRaises(sqlite3.IntegrityError):self.delete_start(c,False)
        self.assertEqual(self.db.execute('SELECT status FROM square_uploads').fetchone()[0],'published')
    def test_membership_confirmation_idempotence_monotonic_state_and_canonical_conflict(self):
        c=projection();run(self.db,'project_subscription.sql',c);run(self.db,'project_subscription.sql',c)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM chain_transaction_confirmations').fetchone()[0],1)
        bad=copy.deepcopy(c);bad['projection']['evidence']['action_kind']='cancel'
        with self.assertRaises(sqlite3.IntegrityError):run(self.db,'project_subscription.sql',bad)
        newer=projection(10,2);newer['projection']['platform'][0]['membership_level']='spark';run(self.db,'project_subscription.sql',newer)
        run(self.db,'project_subscription.sql',c)
        self.assertEqual(self.db.execute('SELECT membership_level,finalized_block_number FROM square_memberships').fetchone(),('spark',10))
    def test_empty_creator_plans_keep_monotonic_head_and_old_plans_cannot_revive(self):
        tier={'tier_id':'tier1','tier_name':'十个😀','tier_order':0,'monthly_price_fen':100,'quarterly_price_fen':250,'yearly_price_fen':900}
        run(self.db,'project_subscription.sql',projection(9,1,[tier]));run(self.db,'project_subscription.sql',projection(10,2,[]));run(self.db,'project_subscription.sql',projection(9,1,[tier]))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM square_creator_tiers').fetchone()[0],0)
        self.assertEqual(self.db.execute('SELECT creator_plans_block_number FROM square_memberships').fetchone()[0],10)
    def test_background_cursor_cas_and_whole_block_rollback(self):
        c=projection(0,1);c['background']=True;c['expected']=None;c['projection']['evidence']=None
        run(self.db,'project_subscription.sql',c)
        c2=projection(1,2);c2['background']=True;c2['expected']=c['projection']['anchor'];c2['projection']['evidence']=None
        run(self.db,'project_subscription.sql',c2)
        with self.assertRaises(sqlite3.IntegrityError):run(self.db,'project_subscription.sql',c2)
        self.assertEqual(self.db.execute('SELECT finalized_block_number FROM membership_projection_cursor').fetchone()[0],1)
    def test_profile_generation_claim_and_retry_are_serialized(self):
        old=reserve_asset(self.db,credential());new=reserve_asset(self.db,credential(2));self.assertEqual(new['generation'],2)
        with self.assertRaises(sqlite3.IntegrityError):claim(self.db,old)
        claim(self.db,new);claim(self.db,new)
        with self.assertRaises(sqlite3.IntegrityError):reserve_asset(self.db,credential(3))
        run(self.db,'complete_profile_asset.sql',{'auth':auth(),'credential':new,'etag':'etag2'})
        run(self.db,'complete_profile_asset.sql',{'auth':auth(),'credential':new,'etag':'etag2'})
        with self.assertRaises(sqlite3.IntegrityError):run(self.db,'complete_profile_asset.sql',{'auth':auth(),'credential':new,'etag':'different'})
        self.assertEqual(self.db.execute("SELECT state FROM profile_asset_uploads WHERE upload_id='spa_2'").fetchone()[0],'completed')
    def test_profile_reference_requires_completed_asset_hash(self):
        a=auth();before={'cid_number':a['cid_number'],'display_name':'','bio':'','avatar_object_key':None,'avatar_content_hash':None,'banner_object_key':None,'banner_content_hash':None,'updated_at':0}
        after={**before,'avatar_object_key':credential()['object_key'],'avatar_content_hash':credential()['sha256'],'updated_at':1000003}
        execute(self.db,constant('profiles.rs','WRITE'),{'auth':a,'before':before,'after':after})
        self.assertIsNone(self.db.execute('SELECT avatar_content_hash FROM user_profiles WHERE cid_number=?',(a['cid_number'],)).fetchone())
        c=reserve_asset(self.db,credential());claim(self.db,c);run(self.db,'complete_profile_asset.sql',{'auth':a,'credential':c,'etag':'e'})
        execute(self.db,constant('profiles.rs','WRITE'),{'auth':a,'before':before,'after':after})
        self.assertEqual(self.db.execute('SELECT avatar_content_hash FROM user_profiles WHERE cid_number=?',(a['cid_number'],)).fetchone()[0],c['sha256'])
    def test_profile_expired_credential_cannot_start(self):
        c=reserve_asset(self.db,credential());self.db.execute('UPDATE profile_asset_uploads SET created_at=100000,expires_at=1000000');self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):claim(self.db,c)
    def test_parallel_prepare_cannot_oversubscribe(self):
        with tempfile.TemporaryDirectory(prefix='citizenserve-s4-') as folder:
            path=Path(folder)/'db';db=sqlite3.connect(path);ready(db);db.close()
            def attempt(n):
                db=sqlite3.connect(path,timeout=10)
                try:run(db,'reserve_upload.sql',command(n));return True
                except sqlite3.IntegrityError:return False
                finally:db.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(attempt,range(1,25)))
            self.assertEqual(sum(results),1)
            db=sqlite3.connect(path);self.assertEqual(db.execute('SELECT COUNT(*) FROM square_uploads').fetchone()[0],1);db.close()
    def test_parallel_complete_consumes_exactly_once(self):
        with tempfile.TemporaryDirectory(prefix='citizenserve-s4-') as folder:
            path=Path(folder)/'db';db=sqlite3.connect(path);ready(db);c=command();run(db,'reserve_upload.sql',c);db.close()
            def finish(_):
                db=sqlite3.connect(path,timeout=10)
                try:run(db,'complete_upload.sql',c)
                finally:db.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(finish,range(24)))
            db=sqlite3.connect(path);self.assertEqual(db.execute('SELECT image_count FROM resource_usage').fetchone()[0],1);self.assertEqual(db.execute('SELECT byte_size FROM resource_totals').fetchone()[0],250);db.close()

if __name__=='__main__':unittest.main()
