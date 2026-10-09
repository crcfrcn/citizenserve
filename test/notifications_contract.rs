use citizenserve::{
    notifications::{
        delivery::{self, AuthorizedEndpoint, Outcome},
        endpoint::{Environment, Provider, Register, Stored},
        fanout::{Follower, Page},
        jobs::{self, Cursor, Delivery, Job, Kind, Lease, Message, Source, State},
    },
    shared::crypto,
    user::identity::Identity,
};
use serde_json::json;
fn endpoint() -> Stored {
    Stored {
        cid_number: "CN123".into(),
        account_id: format!("0x{}", "cd".repeat(32)),
        binding_revision: 1,
        device_id: "ef".repeat(32),
        push_provider: Provider::Apns,
        push_token: "ab".repeat(32),
        apns_environment: Some(Environment::Sandbox),
        expires_at: 2_000_000,
        endpoint_revision: 1,
        updated_at: 1_000_000,
    }
}
fn job() -> Job {
    Job {
        job_id: jobs::id(Kind::Fanout, &["post"]),
        source_kind: Source::Post,
        source_key: "post:1".into(),
        cid_number: "CN456".into(),
        post_id: Some("sqp_1".into()),
        tx_hash: Some(format!("0x{}", "ab".repeat(32))),
        lapse_at: None,
        created_at: 1_000_000,
        expires_at: 2_000_000,
        state: State::Pending,
        cursor_created_at: None,
        cursor_cid_number: None,
    }
}
#[test]
fn endpoint_four_fields_and_explicit_null() {
    let v = json!({"push_provider":"fcm","push_token":"test-token-123456","apns_environment":null,"expires_at":2_000_000});
    assert!(serde_json::from_value::<Register>(v.clone())
        .unwrap()
        .canonical(1_000_000)
        .is_ok());
    for key in [
        "push_provider",
        "push_token",
        "apns_environment",
        "expires_at",
    ] {
        let mut x = v.clone();
        x.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<Register>(x).is_err());
    }
    let mut x = v;
    x["device_id"] = json!("self-reported");
    assert!(serde_json::from_value::<Register>(x).is_err());
    assert!(serde_json::from_str::<Register>(r#"{"push_provider":"fcm","push_provider":"apns","push_token":"test-token-123456","apns_environment":null,"expires_at":2000000}"#).is_err());
}
#[test]
fn canonical_token_environment_and_ttl() {
    let mut r = endpoint().registration();
    r.push_token = r.push_token.to_uppercase();
    assert_eq!(
        r.canonical(1_000_000).unwrap().push_token,
        endpoint().push_token
    );
    for expires in [
        1_000_000,
        1_000_000 + citizenserve::notifications::ENDPOINT_TTL_MILLIS + 1,
        u64::MAX,
    ] {
        let mut r = endpoint().registration();
        r.expires_at = expires;
        assert!(r.canonical(1_000_000).is_err());
    }
    for token in ["ab".repeat(31), "zz".repeat(32)] {
        let mut r = endpoint().registration();
        r.push_token = token;
        assert!(r.canonical(1_000_000).is_err());
    }
    let mut r = endpoint().registration();
    r.apns_environment = None;
    assert!(r.canonical(1_000_000).is_err());
    let mut r = Register {
        push_provider: Provider::Fcm,
        push_token: "test-token-123456".into(),
        apns_environment: None,
        expires_at: 2_000_000,
    };
    r.push_token.push('\n');
    assert!(r.canonical(1_000_000).is_err());
}
#[test]
fn queue_only_locator_and_unambiguous_ids() {
    assert_ne!(
        jobs::id(Kind::Fanout, &["a:b", "c"]),
        jobs::id(Kind::Fanout, &["a", "b:c"])
    );
    let m = Message {
        version: 1,
        kind: Kind::Delivery,
        id: jobs::id(Kind::Delivery, &["1"]),
    };
    m.validate().unwrap();
    for id in [
        "https://evil.test/".into(),
        jobs::id(Kind::Fanout, &["1"]),
        "nd_AB".into(),
    ] {
        assert!(Message { id, ..m.clone() }.validate().is_err());
    }
    let mut v = serde_json::to_value(m).unwrap();
    v["url"] = json!("https://evil.test/");
    assert!(serde_json::from_value::<Message>(v).is_err());
}
#[test]
fn lease_attempt_deadline_and_retry_bounds() {
    for attempt in [0, 5, 255] {
        assert!(Lease::acquired(
            jobs::id(Kind::Delivery, &["1"]),
            Kind::Delivery,
            "ab".repeat(16),
            1_000_000,
            attempt
        )
        .is_err());
    }
    let l = Lease::acquired(
        jobs::id(Kind::Delivery, &["1"]),
        Kind::Delivery,
        "ab".repeat(16),
        1_000_000,
        4,
    )
    .unwrap();
    assert!(l.valid(1_000_000, 15_000).is_ok());
    assert!(l.valid(1_105_000, 15_000).is_err());
    assert!(l.valid(999_999, 0).is_err());
    assert_eq!(jobs::retry_delay(4, Some(0)), 1);
    assert_eq!(jobs::retry_delay(4, Some(u32::MAX)), 3600);
}
#[test]
fn page_cursor_and_target_bound() {
    let j = job();
    let f = Follower {
        cursor: Cursor {
            created_at: 900_000,
            cid_number: "CN123".into(),
        },
        endpoints: vec![endpoint()],
    };
    let page = Page {
        followers: vec![f.clone()],
        complete: false,
    };
    page.validate(&j).unwrap();
    assert_eq!(page.deliveries(&j).len(), 1);
    assert!(Page {
        followers: vec![f; 6],
        complete: false
    }
    .validate(&j)
    .is_err());
    let mut p = page.clone();
    p.followers[0].endpoints[0].cid_number = "CN789".into();
    assert!(p.validate(&j).is_err());
    let mut j = j;
    j.cursor_created_at = Some(900_000);
    j.cursor_cid_number = Some("CN123".into());
    assert!(page.validate(&j).is_err());
}
#[test]
fn providers_distinguish_invalid_device_and_configuration() {
    for (status, reason) in [(410, "Unregistered"), (400, "BadDeviceToken")] {
        assert!(matches!(
            delivery::classify(Provider::Apns, status, &json!({"reason":reason}), None, 1),
            Outcome::InvalidEndpoint
        ));
    }
    for reason in ["DeviceTokenNotForTopic", "BadTopic", "InvalidProviderToken"] {
        assert!(matches!(
            delivery::classify(Provider::Apns, 400, &json!({"reason":reason}), None, 1),
            Outcome::Blocked
        ));
    }
    assert!(matches!(
        delivery::classify(
            Provider::Fcm,
            404,
            &json!({"error":{"details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}),
            None,
            1
        ),
        Outcome::InvalidEndpoint
    ));
    assert!(matches!(
        delivery::classify(
            Provider::Fcm,
            404,
            &json!({"error":{"details":[{"errorCode":"UNREGISTERED"}]}}),
            None,
            1
        ),
        Outcome::Blocked
    ));
    assert!(matches!(
        delivery::classify(Provider::Fcm, 200, &json!({}), None, 1),
        Outcome::Retry { .. }
    ));
    assert!(matches!(
        delivery::classify(
            Provider::Fcm,
            200,
            &json!({"name":"projects/test/messages/1"}),
            None,
            1
        ),
        Outcome::Accepted
    ));
    assert!(matches!(
        delivery::classify(Provider::Apns, 429, &json!({}), Some(9999), 1),
        Outcome::Retry {
            delay_seconds: 3600
        }
    ));
}
#[test]
fn authorization_checks_all_current_facts() {
    let mut i: Identity =
        serde_json::from_str(include_str!("contract/finalized_identity.json")).unwrap();
    let mut e = endpoint();
    e.cid_number = i.cid_number.clone();
    let d = Delivery {
        delivery_id: jobs::id(Kind::Delivery, &["1"]),
        job_id: job().job_id,
        cid_number: i.cid_number.clone(),
        account_id: e.account_id.clone(),
        binding_revision: 1,
        device_id: e.device_id.clone(),
        endpoint_revision: 1,
        state: State::Pending,
        attempts: 1,
    };
    assert!(
        AuthorizedEndpoint::from_facts(&i, &d, e.clone(), true, true, 1_000_001)
            .unwrap()
            .is_some()
    );
    for (admission, source) in [(false, true), (true, false)] {
        assert!(
            AuthorizedEndpoint::from_facts(&i, &d, e.clone(), admission, source, 1_000_001)
                .unwrap()
                .is_none()
        );
    }
    e.endpoint_revision = 2;
    assert!(
        AuthorizedEndpoint::from_facts(&i, &d, e, true, true, 1_000_001)
            .unwrap()
            .is_none()
    );
    i.authoritative_current = false;
    assert!(AuthorizedEndpoint::from_facts(&i, &d, endpoint(), true, true, 1_000_001).is_err());
}
#[test]
fn payload_public_and_size_limit() {
    let p = delivery::payload(&job(), Some("标题"), "公开摘要", "作者").unwrap();
    assert_eq!(p["kind"], "square_post");
    assert!(p.get("mls").is_none());
    assert!(delivery::payload(&job(), Some(&"字".repeat(2000)), "", "作者").is_err());
    let mut j = job();
    j.source_kind = Source::StorageCleanup;
    assert_eq!(
        delivery::payload(&j, None, "", "").unwrap()["cleanup_after"],
        1_000_000 + 86_400_000
    );
    assert_eq!(crypto::sha256_hex(b"x").len(), 64);
}
#[test]
fn independent_public_provider_vectors() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("contract/notifications.json")).unwrap();
    for row in v["responses"].as_array().unwrap() {
        let provider = serde_json::from_value(row["provider"].clone()).unwrap();
        let result = delivery::classify(
            provider,
            row["status"].as_u64().unwrap() as u16,
            &row["body"],
            None,
            1,
        );
        assert_eq!(
            serde_json::to_value(result).unwrap()["kind"],
            row["expected"]
        );
    }
}
