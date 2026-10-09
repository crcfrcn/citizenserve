//! 有界媒体格式/存储端口故障测试；内存端口不冒充 Cloudflare R2。
use citizenserve::{
    shared::{crypto, Error, Result},
    square::{
        media,
        storage::{Bucket, Direct, Meta, Put, SignedPut, Storage},
        upload_validation,
    },
    user::{
        profile_assets::{self, Credential, Kind, Repository},
        profile_service::Authorization,
    },
};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("memory port must resolve synchronously"),
    }
}
fn webp(w: u32, h: u32) -> Vec<u8> {
    let bits = (w - 1) | ((h - 1) << 14);
    let mut payload = vec![0x2f];
    payload.extend(bits.to_le_bytes());
    payload.push(0);
    let mut raw = b"RIFF".to_vec();
    raw.extend(18u32.to_le_bytes());
    raw.extend(b"WEBPVP8L");
    raw.extend(6u32.to_le_bytes());
    raw.extend(payload);
    raw
}
fn boxed(name: &[u8; 4], data: Vec<u8>) -> Vec<u8> {
    let mut b = ((data.len() + 8) as u32).to_be_bytes().to_vec();
    b.extend(name);
    b.extend(data);
    b
}
fn hevc() -> Vec<u8> {
    let mut sample = vec![0; 78];
    sample[24..26].copy_from_slice(&100u16.to_be_bytes());
    sample[26..28].copy_from_slice(&80u16.to_be_bytes());
    let mut hvcc = vec![0; 23];
    hvcc[0] = 1;
    hvcc[21] = 3;
    hvcc[22] = 1;
    hvcc.extend([32, 0, 1, 0, 2, 64, 1]);
    sample.extend(boxed(b"hvcC", hvcc));
    let mut stsd = vec![0; 4];
    stsd.extend(1u32.to_be_bytes());
    stsd.extend(boxed(b"hvc1", sample));
    let stbl = boxed(b"stbl", boxed(b"stsd", stsd));
    let minf = boxed(b"minf", stbl);
    let mut mdhd = vec![0; 24];
    mdhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
    mdhd[16..20].copy_from_slice(&5000u32.to_be_bytes());
    let mut hdlr = vec![0; 24];
    hdlr[8..12].copy_from_slice(b"vide");
    let mut mdia = boxed(b"mdhd", mdhd);
    mdia.extend(boxed(b"hdlr", hdlr));
    mdia.extend(minf);
    let mut tkhd = vec![0; 84];
    tkhd[76..80].copy_from_slice(&(100u32 << 16).to_be_bytes());
    tkhd[80..84].copy_from_slice(&(80u32 << 16).to_be_bytes());
    let mut track = boxed(b"tkhd", tkhd);
    track.extend(boxed(b"mdia", mdia));
    let moov = boxed(b"moov", boxed(b"trak", track));
    let mut b = boxed(b"ftyp", b"isom\0\0\0\0isom".to_vec());
    b.extend(moov);
    b.extend(boxed(b"mdat", vec![0; 20]));
    b
}
#[test]
fn webp_chunk_dimensions_riff_size_duplicates_and_animation_are_checked() {
    let b = webp(100, 80);
    assert_eq!(upload_validation::webp(&b).unwrap(), (100, 80));
    let mut bad = b.clone();
    bad[4] = 0;
    assert!(upload_validation::webp(&bad).is_err());
    let mut bad = b.clone();
    bad.extend(&b[12..]);
    let size = (bad.len() - 8) as u32;
    bad[4..8].copy_from_slice(&size.to_le_bytes());
    assert!(upload_validation::webp(&bad).is_err());
    let mut bad = b;
    bad[12..16].copy_from_slice(b"ANMF");
    assert!(upload_validation::webp(&bad).is_err());
}
#[test]
fn hevc_boxes_require_front_moov_real_sample_entry_and_bounded_prefix() {
    let b = hevc();
    assert_eq!(
        upload_validation::hevc(&b, b.len() as u64).unwrap(),
        upload_validation::VideoFacts {
            width: 100,
            height: 80,
            duration_seconds: 5
        }
    );
    let mut bad = b.clone();
    let pos = bad.windows(4).position(|s| s == b"hvc1").unwrap();
    bad[pos..pos + 4].copy_from_slice(b"avc1");
    assert!(upload_validation::hevc(&bad, bad.len() as u64).is_err());
    assert!(upload_validation::hevc(b"ftypmoovmdathvc1", 100).is_err());
    assert!(upload_validation::hevc(&b[..30], b.len() as u64).is_err());
    let bad = boxed(b"mdat", b"moovhvc1".to_vec());
    assert!(upload_validation::hevc(&bad, bad.len() as u64).is_err());
}
#[derive(Default)]
struct MemoryStorage {
    objects: Mutex<BTreeMap<String, (Meta, Vec<u8>)>>,
    reads: Mutex<Vec<(u64, u64)>>,
    fail_put: Mutex<bool>,
    fail_delete: Mutex<bool>,
}
impl Storage for MemoryStorage {
    async fn head(&self, _b: Bucket, k: &str) -> Result<Option<Meta>> {
        Ok(self.objects.lock().unwrap().get(k).map(|(m, _)| m.clone()))
    }
    async fn read(&self, _b: Bucket, k: &str, o: u64, l: u64) -> Result<Vec<u8>> {
        self.reads.lock().unwrap().push((o, l));
        let values = self.objects.lock().unwrap();
        let (_, b) = values.get(k).ok_or(Error::new(409, "missing"))?;
        Ok(b.get(o as usize..(o + l) as usize)
            .ok_or(Error::new(503, "short"))?
            .to_vec())
    }
    async fn put(&self, _b: Bucket, p: Put) -> Result<Meta> {
        if *self.fail_put.lock().unwrap() {
            return Err(Error::new(503, "synthetic_put_failure"));
        }
        let mut values = self.objects.lock().unwrap();
        if values.get(&p.key).map(|(m, _)| &m.etag) != p.previous_etag.as_ref() {
            return Err(Error::new(409, "object_version_conflict"));
        }
        let m = Meta {
            key: p.key.clone(),
            byte_size: p.bytes.len() as u64,
            sha256: crypto::sha256_hex(&p.bytes),
            etag: format!("etag{}", values.len() + 1),
            content_type: p.content_type,
            custom: p.custom,
        };
        values.insert(p.key, (m.clone(), p.bytes));
        Ok(m)
    }
    async fn sign(&self, _p: &Direct, _now: u64) -> Result<SignedPut> {
        panic!("unused")
    }
    async fn delete(&self, _b: Bucket, k: &[String]) -> Result<()> {
        if *self.fail_delete.lock().unwrap() {
            return Err(Error::new(503, "synthetic_delete_failure"));
        }
        for k in k {
            self.objects.lock().unwrap().remove(k);
        }
        Ok(())
    }
    async fn purge(&self, _k: &[String]) -> Result<()> {
        Ok(())
    }
}
#[test]
fn r2_facts_require_full_checksum_metadata_and_exact_dimensions() {
    let s = MemoryStorage::default();
    let raw = webp(100, 80);
    let p = Direct {
        object_key: "square/CID1/posts/sqp_1/media/0/source.webp".into(),
        content_type: "image/webp".into(),
        byte_size: raw.len() as u64,
        sha256: crypto::sha256_hex(&raw),
        upload_id: "squ_1".into(),
        media_index: 0,
        object_role: "source".into(),
        expires_at: 2000000,
    };
    s.objects.lock().unwrap().insert(
        p.object_key.clone(),
        (
            Meta {
                key: p.object_key.clone(),
                byte_size: p.byte_size,
                content_type: p.content_type.clone(),
                sha256: p.sha256.clone(),
                etag: "x".into(),
                custom: BTreeMap::from([
                    ("upload_id".into(), p.upload_id.clone()),
                    ("media_index".into(), "0".into()),
                    ("object_role".into(), "source".into()),
                ]),
            },
            raw,
        ),
    );
    run(media::verify(&s, &p, Some(100), Some(80), None)).unwrap();
    assert!(run(media::verify(&s, &p, Some(101), Some(80), None)).is_err());
    s.objects
        .lock()
        .unwrap()
        .get_mut(&p.object_key)
        .unwrap()
        .0
        .sha256 = "b".repeat(64);
    assert!(run(media::verify(&s, &p, Some(100), Some(80), None)).is_err());
    assert!(s
        .reads
        .lock()
        .unwrap()
        .iter()
        .all(|(_, n)| *n <= 4 * 1024 * 1024));
}
#[test]
fn sigv4_matches_independent_python_golden_and_binds_every_upload_constraint() {
    let f: serde_json::Value = serde_json::from_str(include_str!("contract/content.json")).unwrap();
    let f = &f["sigv4"];
    let p = Direct {
        object_key: f["key"].as_str().unwrap().into(),
        content_type: "image/webp".into(),
        byte_size: f["byte_size"].as_u64().unwrap(),
        sha256: f["sha256"].as_str().unwrap().into(),
        upload_id: "squ_1".into(),
        media_index: 0,
        object_role: "source".into(),
        expires_at: f["now"].as_u64().unwrap() + 900000,
    };
    let signed = media::sign_put(
        f["account"].as_str().unwrap(),
        "TESTACCESS",
        "TESTSECRET",
        f["stamp"].as_str().unwrap(),
        &p,
        f["now"].as_u64().unwrap(),
    )
    .unwrap();
    assert_eq!(signed.url, f["url"].as_str().unwrap());
    assert_eq!(signed.headers["if-none-match"], "*");
    let mut changed = p;
    changed.byte_size += 1;
    assert_ne!(
        signed.url,
        media::sign_put(
            f["account"].as_str().unwrap(),
            "TESTACCESS",
            "TESTSECRET",
            f["stamp"].as_str().unwrap(),
            &changed,
            f["now"].as_u64().unwrap()
        )
        .unwrap()
        .url
    );
}
fn authorization() -> Authorization {
    use citizenserve::{
        server::guard,
        user::{
            admission::Admission,
            auth::{
                device::Device,
                session::{self, Session},
            },
            identity::Identity,
            registration::protocol::Config,
        },
    };
    let i: Identity =
        serde_json::from_str(include_str!("contract/finalized_identity.json")).unwrap();
    let config = Config {
        registration_scope: "fixture".into(),
        service_origin: "https://example.test".into(),
        chain_scope: i.chain_scope.clone(),
        site_key: "fixture".into(),
    };
    let public = format!("0x{}", "aa".repeat(32));
    let d = Device {
        cid_number: i.cid_number.clone(),
        device_id: public[2..].into(),
        account_id: i.account_id.clone(),
        binding_revision: i.binding_revision,
        public_key: public,
        issued_at: 900000,
        created_at: 900000,
        updated_at: 900000,
        active: true,
    };
    let token = format!("sqs_{}", "11".repeat(16));
    let s = Session {
        session_token_hash: session::hash(&token).unwrap(),
        cid_number: i.cid_number.clone(),
        account_id: i.account_id.clone(),
        binding_revision: i.binding_revision,
        device_id: d.device_id.clone(),
        created_at: 900000,
        expires_at: 2000000,
    };
    let a = Admission {
        cid_number: i.cid_number.clone(),
        enrollment_id: "fixture".into(),
        source: "turnstile".into(),
        human_verified_at_millis: 900000,
        registration_scope: config.registration_scope.clone(),
        service_origin: config.service_origin.clone(),
        chain_scope: i.chain_scope.clone(),
        institution: i.institution,
    };
    let authority = guard::session_authority(&i, &a, &d, &s, &config, 1000001).unwrap();
    Authorization::new(&authority, &config, &token, 1000001).unwrap()
}
struct Assets {
    row: Mutex<Credential>,
    fail_complete: Mutex<bool>,
    reference: Mutex<Option<String>>,
}
impl Repository for Assets {
    async fn reserve(&self, _a: &Authorization, _c: &Credential) -> Result<Credential> {
        panic!("unused")
    }
    async fn claim(&self, _a: &Authorization, _id: &str) -> Result<Credential> {
        let mut c = self.row.lock().unwrap();
        c.state = "writing".into();
        Ok(c.clone())
    }
    async fn complete(&self, _a: &Authorization, _c: &Credential, e: &str) -> Result<()> {
        if *self.fail_complete.lock().unwrap() {
            return Err(Error::new(503, "synthetic_sql_failure"));
        }
        let mut row = self.row.lock().unwrap();
        row.state = "completed".into();
        row.object_etag = Some(e.into());
        *self.reference.lock().unwrap() = Some(row.sha256.clone());
        Ok(())
    }
    async fn referenced(
        &self,
        _a: &Authorization,
        _cid: &str,
        _kind: Kind,
    ) -> Result<Option<String>> {
        Ok(self.reference.lock().unwrap().clone())
    }
}
#[test]
fn profile_r2_success_sql_failure_preserves_retry_and_private_range_etag_checks() {
    let a = authorization();
    let raw = webp(100, 80);
    let s = MemoryStorage::default();
    let c = Credential {
        upload_id: "spa_1".into(),
        cid_number: a.cid().into(),
        kind: Kind::Avatar,
        object_key: Kind::Avatar.key(a.cid()).unwrap(),
        content_type: "image/webp".into(),
        byte_size: raw.len() as u64,
        sha256: crypto::sha256_hex(&raw),
        generation: 1,
        prior_etag: None,
        object_etag: None,
        state: "prepared".into(),
        created_at: 1000000,
        expires_at: 1900000,
        started_at: Some(1000001),
        completed_at: None,
    };
    let r = Assets {
        row: Mutex::new(c.clone()),
        fail_complete: Mutex::new(true),
        reference: Mutex::new(None),
    };
    assert!(run(profile_assets::upload(&r, &s, &a, "spa_1", raw.clone())).is_err());
    assert_eq!(r.row.lock().unwrap().state, "writing");
    *r.fail_complete.lock().unwrap() = false;
    run(profile_assets::upload(&r, &s, &a, "spa_1", raw.clone())).unwrap();
    let read = run(profile_assets::read(
        &r,
        &s,
        &a,
        a.cid(),
        Kind::Avatar,
        Some("bytes=2-5"),
        None,
        None,
    ))
    .unwrap();
    assert_eq!(read.status, 206);
    assert_eq!(read.bytes, raw[2..6]);
    assert_eq!(
        run(profile_assets::read(
            &r,
            &s,
            &a,
            a.cid(),
            Kind::Avatar,
            None,
            Some(&read.etag),
            None
        ))
        .unwrap()
        .status,
        304
    );
    s.objects
        .lock()
        .unwrap()
        .get_mut(&c.object_key)
        .unwrap()
        .0
        .sha256 = "b".repeat(64);
    assert!(run(profile_assets::read(
        &r,
        &s,
        &a,
        a.cid(),
        Kind::Avatar,
        None,
        Some(&read.etag),
        None
    ))
    .is_err());
}
#[test]
fn ranges_reject_multiple_overflows_and_zero_suffix() {
    assert_eq!(
        media::range(Some("bytes=-4"), 20).unwrap(),
        media::ByteRange {
            offset: 16,
            length: 4
        }
    );
    for r in [
        "bytes=20-",
        "bytes=5-2",
        "bytes=1-2,4-6",
        "bytes=-0",
        "bytes=18446744073709551616-",
    ] {
        assert!(media::range(Some(r), 20).is_err());
    }
}
#[test]
fn banner_1536kib_proof_is_real_ed25519_and_global_limit_is_2mib() {
    use citizenserve::user::{auth::mls_authentication::Proof, identity::Identity};
    use ed25519_dalek::{Signer, SigningKey};
    let identity: Identity =
        serde_json::from_str(include_str!("contract/finalized_identity.json")).unwrap();
    let key = SigningKey::from_bytes(&[19; 32]);
    let public = format!("0x{}", crypto::hex(key.verifying_key().as_bytes()));
    let body = vec![1; 1536 * 1024];
    let mut p = Proof {
        user_id: identity.cid_number.clone(),
        device_id: public[2..].into(),
        public_key: public,
        account_id: identity.account_id.clone(),
        binding_revision: 1,
        service_origin: "https://example.test".into(),
        challenge: format!("0x{}", "aa".repeat(32)),
        expires_at_millis: 1200000,
        method: "PUT".into(),
        request_target: "/api/user/profile/assets/spa_1".into(),
        body_sha256: format!("0x{}", crypto::sha256_hex(&body)),
        signature: format!("0x{}", "00".repeat(64)),
    };
    p.signature = format!(
        "0x{}",
        crypto::hex(&key.sign(&p.message().unwrap()).to_bytes())
    );
    p.verify_request(
        &identity,
        &p.service_origin,
        "PUT",
        &p.request_target,
        &body,
        1000001,
    )
    .unwrap();
    let huge = vec![1; 2 * 1024 * 1024 + 1];
    p.body_sha256 = format!("0x{}", crypto::sha256_hex(&huge));
    p.signature = format!(
        "0x{}",
        crypto::hex(&key.sign(&p.message().unwrap()).to_bytes())
    );
    assert!(p
        .verify_request(
            &identity,
            &p.service_origin,
            "PUT",
            &p.request_target,
            &huge,
            1000001
        )
        .is_err());
}

struct Deletion {
    row: Mutex<citizenserve::square::uploads::Upload>,
    finishes: Mutex<u32>,
}
impl citizenserve::square::uploads::Repository for Deletion {
    async fn reserve(
        &self,
        _a: &Authorization,
        _u: &citizenserve::square::uploads::Upload,
        _c: &citizenserve::chain::subscription::Current,
    ) -> Result<()> {
        panic!("unused")
    }
    async fn get(
        &self,
        _a: &Authorization,
        _id: &str,
    ) -> Result<Option<citizenserve::square::uploads::Upload>> {
        Ok(Some(self.row.lock().unwrap().clone()))
    }
    async fn manifest_written(
        &self,
        _a: &Authorization,
        _u: &citizenserve::square::uploads::Upload,
    ) -> Result<()> {
        panic!("unused")
    }
    async fn complete(
        &self,
        _a: &Authorization,
        _u: &citizenserve::square::uploads::Upload,
        _c: &citizenserve::chain::subscription::Current,
    ) -> Result<()> {
        panic!("unused")
    }
    async fn start_delete(
        &self,
        _a: &Authorization,
        _u: &citizenserve::square::uploads::Upload,
        _p: bool,
    ) -> Result<()> {
        self.row.lock().unwrap().status = "deleting".into();
        Ok(())
    }
    async fn finish_delete(
        &self,
        _a: &Authorization,
        _u: &citizenserve::square::uploads::Upload,
    ) -> Result<()> {
        *self.finishes.lock().unwrap() += 1;
        self.row.lock().unwrap().status = "deleted".into();
        Ok(())
    }
}
#[test]
fn r2_delete_failure_keeps_durable_locator_and_retry_finishes_once() {
    use citizenserve::square::{upload_validation::PostType, uploads};
    let a = authorization();
    let u = uploads::Upload {
        upload_id: "squ_1".into(),
        post_id: "sqp_1".into(),
        cid_number: a.cid().into(),
        account_id: a.account().into(),
        post_type: PostType::Document,
        manifest_hash: "a".repeat(64),
        manifest_byte_size: 100,
        storage_receipt_id: "sqr_1".into(),
        estimated_bytes: 100,
        status: "completed".into(),
        expires_at: 1000000,
        created_at: 100000,
        completed_at: Some(900000),
        content_hash: Some("a".repeat(64)),
        media_items: vec![],
    };
    let repo = Deletion {
        row: Mutex::new(u.clone()),
        finishes: Mutex::new(0),
    };
    let storage = MemoryStorage::default();
    *storage.fail_delete.lock().unwrap() = true;
    assert!(run(uploads::remove(&repo, &storage, &a, &u, false)).is_err());
    assert_eq!(repo.row.lock().unwrap().status, "deleting");
    assert_eq!(*repo.finishes.lock().unwrap(), 0);
    *storage.fail_delete.lock().unwrap() = false;
    let retry = repo.row.lock().unwrap().clone();
    assert_eq!(
        run(uploads::remove(&repo, &storage, &a, &retry, false)).unwrap()["deleted"],
        true
    );
    let retry = repo.row.lock().unwrap().clone();
    run(uploads::remove(&repo, &storage, &a, &retry, false)).unwrap();
    assert_eq!(*repo.finishes.lock().unwrap(), 1);
}
