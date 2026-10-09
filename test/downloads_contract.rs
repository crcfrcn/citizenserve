use citizenserve::downloads::{
    publication::{self, Publication},
    release,
    routes::{DownloadRoute, Platform},
};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!("contract/downloads.json")).unwrap()
}
#[test]
fn actual_api_raw_body_hmac_matches_independent_python_vector() {
    let v = fixture();
    let s = |k| v[k].as_str().unwrap();
    assert_eq!(
        publication::canonical(
            s("method"),
            s("path"),
            s("time"),
            s("nonce"),
            s("body").as_bytes()
        )
        .unwrap(),
        s("canonical")
    );
    assert!(publication::authorize(
        s("key").as_bytes(),
        s("method"),
        s("path"),
        s("time"),
        s("nonce"),
        s("signature"),
        s("body").as_bytes(),
        1000000
    )
    .is_ok());
    for (path, method, body, time) in [
        (
            "/operations/citizenchain/download-publications/macos",
            "PUT",
            s("body"),
            1000000,
        ),
        (
            "/api/downloads/citizenchain/windows/publication",
            "PUT",
            s("body"),
            1000000,
        ),
        (s("path"), "GET", s("body"), 1000000),
        (s("path"), "PUT", "{}", 1000000),
        (s("path"), "PUT", s("body"), 1300001),
    ] {
        assert!(publication::authorize(
            s("key").as_bytes(),
            method,
            path,
            s("time"),
            s("nonce"),
            s("signature"),
            body.as_bytes(),
            time
        )
        .is_err())
    }
}
#[test]
fn exact_platform_tag_asset_sha_and_formal_release_are_required() {
    let v = fixture();
    let p: Publication = serde_json::from_value(v["publication"].clone()).unwrap();
    p.validate(Platform::Macos).unwrap();
    assert!(p.validate(Platform::Windows).is_err());
    let good = release::asset(
        &v["release"],
        "citizenchain",
        &p.version_tag,
        &p.asset_name,
        Some(&p.asset_sha256),
    )
    .unwrap();
    assert!(good.starts_with("https://github.com/crcfrcn/citizenchain/releases/download/"));
    for n in 0..6 {
        let mut r = v["release"].clone();
        match n {
            0 => r["draft"] = json!(true),
            1 => r["prerelease"] = json!(true),
            2 => r["assets"][0]["digest"] = json!("sha256:bad"),
            3 => {
                r["assets"][0]["browser_download_url"] = json!("https://attacker.invalid/installer")
            }
            4 => {
                let a = r["assets"][0].clone();
                r["assets"].as_array_mut().unwrap().push(a)
            }
            5 => r["assets"][0]["state"] = json!("new"),
            _ => unreachable!(),
        }
        assert!(
            release::asset(
                &r,
                "citizenchain",
                &p.version_tag,
                &p.asset_name,
                Some(&p.asset_sha256)
            )
            .is_err(),
            "{n}"
        )
    }
}
#[test]
fn only_macos_has_updater_and_no_single_download_alias() {
    assert_eq!(
        DownloadRoute::resolve("GET", "/downloads/citizenchain/macos/updater"),
        Some(DownloadRoute::Updater)
    );
    for p in ["windows", "linux-arm", "linux-amd"] {
        assert!(
            DownloadRoute::resolve("GET", &format!("/downloads/citizenchain/{p}/updater"))
                .is_none()
        )
    }
    assert!(DownloadRoute::resolve("GET", "/download/citizenchain/macOS").is_none());
}
#[test]
fn android_uses_fixed_product_asset_and_skips_drafts() {
    let r = json!({"tag_name":"citizenapp-release-android-v1.2.3","draft":false,"prerelease":false,"assets":[{"name":"citizenapp.apk","size":10,"state":"uploaded","browser_download_url":"https://github.com/crcfrcn/citizenapp/releases/download/citizenapp-release-android-v1.2.3/citizenapp.apk"}]});
    assert!(release::android(&json!([r.clone()]), "citizenapp").is_ok());
    assert!(release::android(&json!([r]), "citizenwallet").is_err());
}

#[test]
fn publication_requires_explicit_null_and_canonical_empty_get_signature() {
    assert!(serde_json::from_str::<publication::Update>(r#"{"expected_revision":0}"#).is_err());
    assert!(serde_json::from_str::<publication::Update>(
        r#"{"expected_revision":0,"publication":null}"#
    )
    .is_ok());
    let v = fixture();
    let key = v["key"].as_str().unwrap().as_bytes();
    let path = v["path"].as_str().unwrap();
    let nonce = v["nonce"].as_str().unwrap();
    let canonical = publication::canonical("GET", path, "1000000", nonce, b"").unwrap();
    let sig = citizenserve::shared::crypto::hex(&citizenserve::shared::crypto::hmac_sha256(
        key,
        canonical.as_bytes(),
    ));
    assert!(publication::authorize(key, "GET", path, "1000000", nonce, &sig, b"", 1000000).is_ok());
    assert!(
        publication::authorize(key, "GET", path, "1000000", nonce, &sig, b"{}", 1000000).is_err()
    );
}

#[test]
fn download_service_rejects_tag_commit_mismatch_before_returning_installer() {
    use citizenserve::downloads::{
        ports::{Releases, Repository},
        publication::{Row, Update},
        service,
    };
    use citizenserve::shared::Result;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    struct Repo;
    impl Repository for Repo {
        async fn read(&self, p: Platform) -> Result<Row> {
            let v = fixture();
            let pval: Publication = serde_json::from_value(v["publication"].clone()).unwrap();
            Ok(Row {
                platform: p.name().into(),
                version_tag: Some(pval.version_tag),
                source_sha: Some(pval.source_sha),
                asset_name: Some(pval.asset_name),
                asset_sha256: Some(pval.asset_sha256),
                revision: 1,
                published_at: Some(1000000),
            })
        }
        async fn publish(&self, _: Platform, _: &Update, _: u64) -> Result<Row> {
            panic!("read-only test")
        }
    }
    struct Github(bool);
    impl Releases for Github {
        async fn get(&self, product: &str, tag: Option<&str>) -> Result<Value> {
            assert_eq!(product, "citizenchain");
            assert_eq!(tag, Some("citizenchain-macos-v1.2.3"));
            Ok(fixture()["release"].clone())
        }
        async fn commit(&self, _: &str, _: &str) -> Result<String> {
            Ok(if self.0 {
                "ab".repeat(20)
            } else {
                "ee".repeat(20)
            })
        }
    }
    fn run<F: Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(v) => v,
            _ => panic!("mock immediate"),
        }
    }
    assert!(run(service::target(
        &Repo,
        &Github(true),
        DownloadRoute::Chain(Platform::Macos)
    ))
    .is_ok());
    assert!(run(service::target(
        &Repo,
        &Github(false),
        DownloadRoute::Chain(Platform::Macos)
    ))
    .is_err());
}
