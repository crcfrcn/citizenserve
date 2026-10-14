use citizenserve::downloads::{ports::Releases, release, routes::DownloadRoute, service};
use citizenserve::shared::Result;
use serde_json::{json, Value};
use std::{future::Future, task::{Context, Poll, Waker}};

fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("模拟端口应立即返回"),
    }
}

fn formal(product: &str) -> Value {
    let tag = format!("{product}-release-android-v1.2.3");
    json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":[{
        "name":format!("{product}.apk"),"size":10,"state":"uploaded",
        "browser_download_url":format!("https://github.com/crcfrcn/{product}/releases/download/{tag}/{product}.apk")
    }]})
}

struct Github;
impl Releases for Github {
    async fn get(&self, product: &str) -> Result<Value> {
        assert!(matches!(product, "citizenapp" | "citizenwallet"));
        Ok(json!([formal(product)]))
    }
}

#[test]
fn android_routes_resolve_to_independent_formal_releases() {
    for (path, product) in [
        ("/downloads/citizenapp/android", "citizenapp"),
        ("/downloads/citizenwallet/android", "citizenwallet"),
    ] {
        let route = DownloadRoute::resolve("GET", path).unwrap();
        assert_eq!(route.method(), "GET");
        assert_eq!(route.body_limit(), 0);
        assert!(run(service::target(&Github, route)).unwrap().starts_with(
            &format!("https://github.com/crcfrcn/{product}/releases/download/")
        ));
        assert!(route.validate_query(&Default::default()).is_ok());
    }
}

#[test]
fn obsolete_chain_routes_and_invalid_android_assets_are_rejected() {
    for path in [
        "/downloads/citizenchain/macos", "/downloads/citizenchain/windows",
        "/downloads/citizenchain/linux-arm", "/downloads/citizenchain/linux-amd",
        "/downloads/citizenchain/macos/updater",
        "/downloads/citizenchain/macos/publication",
    ] {
        assert!(DownloadRoute::resolve("GET", path).is_none());
        assert!(DownloadRoute::resolve("PUT", path).is_none());
    }
    assert!(DownloadRoute::resolve("PUT", "/downloads/citizenapp/android").is_none());
    let route = DownloadRoute::resolve("GET", "/downloads/citizenapp/android").unwrap();
    assert!(route.validate_query(&[("tag".into(), "other".into())].into()).is_err());
    let valid = formal("citizenapp");
    assert!(release::android(&json!([valid.clone()]), "citizenapp").is_ok());
    for mutation in 0..5 {
        let mut invalid = valid.clone();
        match mutation {
            0 => invalid["draft"] = json!(true),
            1 => invalid["prerelease"] = json!(true),
            2 => invalid["assets"][0]["state"] = json!("new"),
            3 => invalid["assets"][0]["browser_download_url"] = json!("https://attacker.invalid/app.apk"),
            _ => invalid["assets"][0]["size"] = json!(0),
        }
        assert!(release::android(&json!([invalid]), "citizenapp").is_err());
    }
    assert!(release::android(&json!([valid]), "citizenwallet").is_err());
}
