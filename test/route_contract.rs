use citizenserve::{
    gate::request::{route, Route},
    user::{
        auth::{
            challenge,
            mls_authentication::{ChallengeRequest, Purpose},
        },
        routes::UserRoute,
    },
};

fn gate_input<'a>(method: &'a str, url: &'a str) -> citizenserve::gate::request::Incoming<'a> {
    citizenserve::gate::request::Incoming {
        method,
        url,
        service_origin: Some("https://registration.example.test"),
        media_origin: Some("https://media.example.test"),
        browser_origin: None,
        preflight_method: None,
        preflight_headers: None,
        content_length: Some("0"),
        authorization: None,
        mls_proof: None,
        internal_header: false,
        upgrade: None,
        websocket_protocol: None,
    }
}

#[test]
fn creator_overview_alone_requires_member_among_membership_entry_routes() {
    use citizenserve::membership::policy::{self, Operation, Requirement};
    for (method, path, expected) in [
        (
            "GET",
            "/api/membership/creator/overview",
            Operation::CreatorOverview,
        ),
        ("GET", "/api/membership", Operation::Membership),
        ("POST", "/api/membership/confirm", Operation::Membership),
    ] {
        let operation = policy::api(route(method, path).unwrap(), path).unwrap();
        assert_eq!(operation, expected);
        assert_eq!(
            operation.requirement("CID1"),
            if expected == Operation::CreatorOverview {
                Requirement::Member
            } else {
                Requirement::Base
            }
        );
    }
    assert_eq!(
        Operation::CreatorOverview.denial().code,
        "membership_required"
    );
    assert_eq!(Operation::CreatorOverview.denial().status, 403);
    assert!(route("GET", "/api/membership/creator/overview/other").is_err());
}

#[test]
fn unified_gate_has_exact_open_cid_and_reject_paths_before_business_io() {
    use citizenserve::gate::{self, Classification};
    let open = gate::classify(gate_input(
        "POST",
        "https://registration.example.test/api/user/registration",
    ));
    let Classification::Open(entry) = open else {
        panic!("真人注册准备必须走明确开放分支")
    };
    let scope = entry.open().unwrap();
    scope
        .require_api(Route::User(UserRoute::Registration))
        .unwrap();
    assert!(scope
        .require_api(Route::ProtectedUser(
            citizenserve::user::routes::ProtectedUserRoute::Contacts
        ))
        .is_err());
    let mut cid = gate_input("POST", "https://registration.example.test/api/user/devices");
    cid.mls_proof = Some("synthetic-shape-only");
    let Classification::Cid(entry) = gate::classify(cid) else {
        panic!("取得CID后的激活必须走公民号分支")
    };
    entry.require_cid(gate::policy::CidRule::Device).unwrap();
    assert!(entry.open().is_err());
    let mut business_io = 0;
    for url in [
        "https://registration.example.test/api/unknown",
        "https://registration.example.test/api/api/user/devices",
        "https://other.example.test/api/health",
        "https://registration.example.test/api/user/../user/devices",
    ] {
        let mut input = gate_input("GET", url);
        input.authorization = Some("Bearer sqs_12121212121212121212121212121212");
        input.mls_proof = Some("synthetic-shape-only");
        match gate::classify(input) {
            Classification::Reject(_) => {}
            _ => {
                business_io += 1;
            }
        }
    }
    assert_eq!(business_io, 0, "未知请求不得触发数据库、RPC或存储处理器");
}

#[test]
fn missing_or_malformed_business_credentials_are_rejected_without_io() {
    use citizenserve::gate::{self, Classification};
    for value in [None, Some("Bearer arbitrary"), Some("Bearer sqs_short")] {
        let mut input = gate_input(
            "GET",
            "https://registration.example.test/api/8964/feed/recommended",
        );
        input.authorization = value;
        assert!(matches!(gate::classify(input), Classification::Reject(_)));
    }
    let mut input = gate_input(
        "GET",
        "https://registration.example.test/api/8964/feed/recommended",
    );
    input.authorization = Some("Bearer sqs_12121212121212121212121212121212");
    assert!(
        matches!(gate::classify(input), Classification::Reject(_)),
        "缺请求证明也必须提前拒绝"
    );
}

#[test]
fn network_and_chat_no_longer_bypass_gate_classification() {
    use citizenserve::gate::{self, Classification};
    assert!(matches!(
        gate::classify(gate_input("POST", "https://nrcrpc.crcfrcn.com/")),
        Classification::Open(_)
    ));
    assert!(matches!(
        gate::classify(gate_input(
            "GET",
            "https://nrcrpc.crcfrcn.com/api/user/profile"
        )),
        Classification::Reject(_)
    ));
    assert!(matches!(
        gate::classify(gate_input(
            "GET",
            "https://registration.example.test/api/tatachat/realtime"
        )),
        Classification::Reject(_)
    ));
    let mut input = gate_input(
        "GET",
        "https://registration.example.test/api/tatachat/realtime",
    );
    input.authorization = Some("Bearer synthetic-chat-credential");
    input.upgrade = Some("websocket");
    input.websocket_protocol = Some("tatachat");
    let Classification::Cid(entry) = gate::classify(input) else {
        panic!("聊天必须走CID分支")
    };
    entry.require_cid(gate::policy::CidRule::Chat).unwrap();
}

#[test]
fn chat_upgrade_shape_keeps_original_bad_request_and_forbidden_boundaries() {
    use citizenserve::gate::{self, Classification};
    let status = |input| match gate::classify(input) {
        Classification::Reject(error) => error.status,
        _ => panic!("无效升级不得接入业务"),
    };
    assert_eq!(
        status(gate_input(
            "GET",
            "https://registration.example.test/api/tatachat/realtime"
        )),
        400
    );
    let mut input = gate_input(
        "GET",
        "https://registration.example.test/api/tatachat/realtime",
    );
    input.upgrade = Some("websocket");
    input.websocket_protocol = Some("tatachatserver");
    assert_eq!(status(input), 400);
    let mut input = gate_input(
        "GET",
        "https://registration.example.test/api/tatachat/realtime",
    );
    input.upgrade = Some("websocket");
    input.websocket_protocol = Some("tatachat");
    assert_eq!(status(input), 403);
    let mut input = gate_input(
        "GET",
        "https://registration.example.test/api/tatachat/realtime",
    );
    input.internal_header = true;
    assert_eq!(status(input), 400);
}

#[test]
fn media_head_range_targets_require_cid_and_cannot_expose_other_bucket_keys() {
    use citizenserve::gate::{self, Classification};
    for method in ["GET", "HEAD"] {
        let mut input = gate_input(
            method,
            "https://media.example.test/square/CID1/posts/p1/media/0/source.webp",
        );
        assert!(matches!(gate::classify(input), Classification::Reject(_)));
        input = gate_input(
            method,
            "https://media.example.test/square/CID1/posts/p1/media/0/source.webp",
        );
        input.authorization = Some("Bearer sqs_12121212121212121212121212121212");
        let Classification::Cid(entry) = gate::classify(input) else {
            panic!("媒体必须验证CID")
        };
        entry.require_cid(gate::policy::CidRule::Media).unwrap();
    }
    for path in [
        "/square/CID1/posts/p1/manifest.json",
        "/square/CID1/posts/p1/media/00/source.webp",
        "/square/CID1/posts/p1/media/0/unknown.webp",
        "/square/CID1/posts/p1/media/0/source.webp?bypass=1",
    ] {
        let url = format!("https://media.example.test{path}");
        let mut input = gate_input("GET", &url);
        input.authorization = Some("Bearer sqs_12121212121212121212121212121212");
        assert!(
            matches!(gate::classify(input), Classification::Reject(_)),
            "{path}"
        );
    }
}

#[test]
fn preflight_is_open_only_for_a_real_registered_target() {
    use citizenserve::gate::{self, Classification};
    let mut input = gate_input(
        "OPTIONS",
        "https://registration.example.test/api/user/contacts",
    );
    input.preflight_method = Some("POST");
    let Classification::Open(entry) = gate::classify(input) else {
        panic!("预检不执行账户业务")
    };
    assert!(entry.preflight());
    assert_eq!(entry.method(), "POST");
    assert!(entry
        .open()
        .unwrap()
        .require_api(Route::ProtectedUser(
            citizenserve::user::routes::ProtectedUserRoute::Contacts
        ))
        .is_err());
    let input = gate_input(
        "OPTIONS",
        "https://registration.example.test/api/user/contacts",
    );
    assert!(
        matches!(gate::classify(input), Classification::Reject(_)),
        "预检缺少目标方法必须拒绝"
    );
    let mut input = gate_input(
        "OPTIONS",
        "https://registration.example.test/api/user/contacts",
    );
    input.preflight_method = Some("TRACE");
    assert!(
        matches!(gate::classify(input), Classification::Reject(_)),
        "未登记方法不能通过预检"
    );
    let mut input = gate_input("OPTIONS", "https://registration.example.test/api/unknown");
    input.preflight_method = Some("POST");
    assert!(matches!(gate::classify(input), Classification::Reject(_)));
    let mut input = gate_input(
        "OPTIONS",
        "https://registration.example.test/api/user/contacts",
    );
    input.preflight_method = Some("POST");
    input.preflight_headers = Some("x-tatachat-internal");
    assert!(matches!(gate::classify(input), Classification::Reject(_)));
}

#[test]
fn internal_open_rules_cannot_be_selected_by_client_headers_or_wrong_queue() {
    use citizenserve::gate::{
        self,
        open::{self, SystemOperation},
        Classification,
    };
    let mut input = gate_input("GET", "https://registration.example.test/api/health");
    input.internal_header = true;
    assert!(matches!(gate::classify(input), Classification::Reject(_)));
    assert!(open::system(SystemOperation::Notifications, "other", "citizenserve").is_err());
    assert!(open::system(
        SystemOperation::ChatQueue,
        "citizenserve-tatachat",
        "citizenserve-tatachat"
    )
    .is_ok());
    assert!(open::system(
        SystemOperation::ChatAlarm,
        "cloudflare.tatachat.alarm",
        "cloudflare.tatachat.alarm"
    )
    .is_ok());
    assert!(open::system(
        SystemOperation::ChatAlarm,
        "client-header",
        "cloudflare.tatachat.alarm"
    )
    .is_err());
    assert!(open::system(SystemOperation::ChatAlarm, "", "").is_err());
}
#[test]
fn registration_auth_and_wallet_recovery_routes_remain_exact() {
    for r in UserRoute::ALL {
        assert_eq!(route(r.method(), &r.external()).unwrap(), Route::User(r));
        assert!(route(
            if r.method() == "GET" { "POST" } else { "GET" },
            &r.external()
        )
        .is_err());
        assert!(route(r.method(), r.path()).is_err());
    }
    assert_eq!(route("GET", "/api/health").unwrap(), Route::Health);
}

#[test]
fn thirteen_business_routes_require_session_proof_and_explicit_budgets() {
    use citizenserve::gate::request::protected_target;
    let routes = [
        ("GET", "/api/user/profiles/CID1", 0),
        ("PUT", "/api/user/profile", 16384),
        ("POST", "/api/user/contacts", 262144),
        ("GET", "/api/8964/feed/recommended", 0),
        ("GET", "/api/8964/feed/following", 0),
        ("GET", "/api/8964/feed/campaign", 0),
        ("GET", "/api/8964/posts?cid_number=CID1", 0),
        ("GET", "/api/8964/follows?cid_number=CID1&type=following", 0),
        ("POST", "/api/8964/follows", 16384),
        ("DELETE", "/api/8964/follows/CID1", 0),
        ("PUT", "/api/8964/follows/CID1/notifications", 16384),
        ("GET", "/api/notifications/unread", 0),
        ("POST", "/api/notifications/read", 16384),
    ];
    for (method, target, budget) in routes {
        let r = protected_target(method, target).unwrap();
        assert!(r.protected());
        assert_eq!(r.method(), method);
        assert_eq!(r.body_limit(), budget);
        assert!(protected_target("PATCH", target).is_err());
    }
}
#[test]
fn request_challenge_uses_empty_body_hash_for_get_and_delete() {
    let mut request = ChallengeRequest {
        account_id: format!("0x{}", "cd".repeat(32)),
        public_key: format!("0x{}", "ab".repeat(32)),
        purpose: Purpose::Request,
        method: "GET".into(),
        request_target: "/api/user/profiles/CID1".into(),
        body_sha256: format!("0x{}", citizenserve::shared::crypto::sha256_hex(b"")),
    };
    assert!(challenge::target(&request).is_ok());
    request.body_sha256 = format!("0x{}", "aa".repeat(32));
    assert!(challenge::target(&request).is_err());
    request.method = "DELETE".into();
    request.request_target = "/api/8964/follows/CID1".into();
    assert!(challenge::target(&request).is_err());
}
#[test]
fn business_aliases_duplicate_and_unknown_queries_are_closed() {
    for target in [
        "/api/square/feed/recommended",
        "/api/user/profile/",
        "/api/user/profiles/CID1?view=full",
        "/api/8964/feed/recommended?limit=2&limit=3",
        "/api/8964/feed/recommended?limit=2&unknown=1",
        "/api/8964/feed/recommended?",
        "/api/8964/feed/recommended?limit=%zz",
    ] {
        assert!(
            citizenserve::gate::request::protected_target("GET", target).is_err(),
            "{target}"
        );
    }
}
#[test]
fn old_and_ambiguous_paths_have_no_alias() {
    for p in [
        "/api/square/auth/challenge",
        "/api/square/auth/device/register",
        "/api/square/auth/session",
        "/api/square/users/confirm",
        "/api/registration/prepare",
        "/api/user/devices/",
        "/api/api/user/devices",
        "/api//user/devices",
        "/api/user/../user/devices",
        "/api/user/%64evices",
        "/api/user/arbitrary",
    ] {
        assert!(route("POST", p).is_err(), "{p}");
    }
}
#[test]
fn registration_budget_and_proof_boundaries_are_explicit() {
    for r in UserRoute::ALL {
        assert_eq!(r.body_limit(), if r.registration() { 8192 } else { 16384 });
    }
    assert!(UserRoute::Page.registration());
    assert!(!UserRoute::Devices.registration());
    assert!(UserRoute::Devices.requires_mls());
    assert!(UserRoute::Sessions.requires_mls());
    assert!(!UserRoute::Challenges.requires_mls());
}
#[test]
fn purpose_cannot_sign_another_route_or_query_alias() {
    let mut r = ChallengeRequest {
        account_id: format!("0x{}", "cd".repeat(32)),
        public_key: format!("0x{}", "ab".repeat(32)),
        purpose: Purpose::Registration,
        method: "POST".into(),
        request_target: UserRoute::Devices.external(),
        body_sha256: format!("0x{}", "aa".repeat(32)),
    };
    assert!(challenge::target(&r).is_ok());
    for target in [
        "/user/devices",
        "/api/user/devices?x=1",
        "/api/user/sessions",
        "/api/square/auth/device/register",
    ] {
        r.request_target = target.into();
        assert!(challenge::target(&r).is_err());
    }
    r.purpose = Purpose::Session;
    r.request_target = UserRoute::Sessions.external();
    assert!(challenge::target(&r).is_err());
    let body = serde_json::to_vec(&serde_json::json!({"account_id":r.account_id})).unwrap();
    r.body_sha256 = format!("0x{}", citizenserve::shared::crypto::sha256_hex(&body));
    assert!(challenge::target(&r).is_ok());
    r.purpose = Purpose::Request;
    assert!(challenge::target(&r).is_err());
}

#[test]
fn seventeen_step4_routes_are_exact_protected_and_budgeted() {
    use citizenserve::gate::request::protected_target;
    for (method, path, budget) in [
        ("GET", "/api/membership", 0),
        ("POST", "/api/membership/confirm", 16384),
        ("GET", "/api/membership/creators/CID1/plans", 0),
        ("POST", "/api/membership/creators/plans", 16384),
        ("GET", "/api/membership/creator/overview", 0),
        (
            "POST",
            "/api/membership/creators/CID1/subscription/confirm",
            16384,
        ),
        ("POST", "/api/8964/uploads", 131072),
        ("PUT", "/api/8964/uploads/squ_1/manifest", 262144),
        ("POST", "/api/8964/uploads/squ_1/complete", 16384),
        ("DELETE", "/api/8964/uploads/squ_1", 0),
        ("POST", "/api/8964/posts/confirm", 16384),
        ("GET", "/api/8964/posts/self?limit=5", 0),
        ("GET", "/api/8964/posts/sqp_1", 0),
        ("DELETE", "/api/8964/posts/sqp_1", 0),
        ("POST", "/api/user/profile/assets", 16384),
        ("PUT", "/api/user/profile/assets/spa_1", 1572864),
        ("GET", "/api/user/profiles/CID1/assets/avatar", 0),
    ] {
        let r = protected_target(method, path).unwrap();
        assert!(r.protected());
        assert_eq!(r.body_limit(), budget);
        assert!(protected_target("PATCH", path).is_err());
    }
}

#[test]
fn step5_exact_tools_cannot_obtain_account_service_permissions() {
    use citizenserve::gate::{
        policy::{OpenRule, Rule},
        request::protected_target,
    };
    let id = format!("top_{}", "ab".repeat(16));
    let mut list = vec![
        (
            "GET",
            "/api/topup/config".into(),
            Rule::Open(OpenRule::Public),
        ),
        (
            "POST",
            "/api/topup/intent".into(),
            Rule::Open(OpenRule::Public),
        ),
        (
            "POST",
            "/api/topup/confirm".into(),
            Rule::Open(OpenRule::PaymentIntent),
        ),
        (
            "POST",
            "/api/topup/status".into(),
            Rule::Open(OpenRule::PaymentIntent),
        ),
        (
            "GET",
            "/api/topup/account".into(),
            Rule::Open(OpenRule::Settlement),
        ),
        (
            "GET",
            "/api/topup/settlement/history".into(),
            Rule::Open(OpenRule::Settlement),
        ),
    ];
    for action in ["claim", "settled", "exception"] {
        assert!(route("POST", &format!("/api/topup/settlement/{id}/{action}")).is_err());
    }
    assert!(route("GET", "/api/topup/settlement/pending").is_err());
    for (method, p) in [
        ("GET", "bootstrap"),
        ("GET", "citizensdk/bootstrap"),
        ("GET", "constitution"),
        ("GET", "runtime-target"),
        ("POST", "extrinsics"),
    ] {
        list.push((
            method,
            format!("/api/chain/{p}"),
            Rule::Open(OpenRule::Public),
        ));
    }
    assert_eq!(list.len(), 11);
    for (m, p, permission) in list {
        let r = route(m, &p).unwrap();
        assert_eq!(r.rule(), permission);
        assert!(!r.protected());
        assert!(protected_target(m, &p).is_err());
    }
    for p in [
        "/api/download/citizenapp/android",
        "/api/downloads/citizenapp/android",
        "/api/downloads/citizenwallet/android",
        "/api/downloads/citizenchain/macos",
        "/api/downloads/citizenchain/macos/updater",
        "/api/downloads/citizenchain/windows/publication",
        "/api/constitution",
        "/api/operations/citizenchain/download-publications/macos",
        "/api/downloads/citizenchain/macOS",
        "/api/chain/extrinsic",
        "/api/chain/runtime-target/",
    ] {
        assert!(route("GET", p).is_err());
    }
    assert!(route("PUT", "/api/downloads/citizenchain/macos/publication").is_err());
    assert!(route("POST", "/api/chain/runtime-target").is_err());
}

#[test]
fn public_rpc_only_uses_the_exact_separate_https_root() {
    use citizenserve::chain::ethereum_rpc::target;
    assert!(target("https://nrcrpc.crcfrcn.com/").is_ok());
    for u in [
        "https://rpc.crcfrcn.com/",
        "http://nrcrpc.crcfrcn.com/",
        "https://www.crcfrcn.com/",
        "https://nrcrpc.crcfrcn.com/api",
        "https://nrcrpc.crcfrcn.com/?method=eth_chainId",
        "https://nrcrpc.crcfrcn.com/#fragment",
        "https://user@nrcrpc.crcfrcn.com/",
        "https://nrcrpc.crcfrcn.com:8443/",
    ] {
        assert!(target(u).is_err(), "{u}");
    }
}

#[test]
fn push_endpoint_exact_actual_api_targets_and_budgets() {
    use citizenserve::gate::request::protected_target;
    for (method, limit) in [("PUT", 16384), ("DELETE", 0)] {
        let r = protected_target(method, "/api/notifications/endpoint").unwrap();
        assert!(r.protected());
        assert_eq!(r.body_limit(), limit);
        for target in [
            "/notifications/endpoint",
            "/api/notifications/endpoints",
            "/api/notifications/endpoint?device_id=other",
        ] {
            assert!(protected_target(method, target).is_err());
        }
    }
    for method in ["POST", "GET", "PATCH"] {
        assert!(route(method, "/api/notifications/endpoint").is_err());
    }
}

#[test]
fn account_deletion_submit_and_readonly_wallet_recovery_have_distinct_authority() {
    use citizenserve::gate::{
        policy::{CidRule, Rule},
        request::protected_target,
    };
    use citizenserve::user::routes::ProtectedUserRoute;
    assert_eq!(
        route("POST", "/api/user/deletion/challenges").unwrap(),
        Route::ProtectedUser(ProtectedUserRoute::DeletionChallenge)
    );
    assert_eq!(
        route("POST", "/api/user/deletion").unwrap(),
        Route::ProtectedUser(ProtectedUserRoute::Delete)
    );
    for p in ["/api/user/deletion/challenges", "/api/user/deletion"] {
        assert!(protected_target("POST", p).is_ok());
        assert!(route("GET", p).is_err());
        assert!(protected_target("POST", &format!("{p}?cid_number=other")).is_err());
    }
    for r in [
        UserRoute::DeletionStatusChallenge,
        UserRoute::DeletionStatus,
    ] {
        let resolved = route("POST", &r.external()).unwrap();
        assert_eq!(resolved.rule(), Rule::Cid(CidRule::Recovery));
        assert!(!resolved.protected());
        assert!(!r.registration());
        assert!(!r.requires_mls());
        assert!(protected_target("POST", &r.external()).is_err());
    }
    assert!(route("POST", "/api/square/account/delete/challenge").is_err());
    assert!(route("POST", "/api/square/account/delete").is_err());
}

#[test]
fn card_avatar_is_exact_authenticated_media_and_never_anonymous_or_a_full_profile_alias() {
    use citizenserve::gate::{self, policy::CidRule, Classification};
    let url = "https://registration.example.test/api/user/cards/CN220-CTZN2-100000002-2026/avatar";
    assert!(matches!(
        gate::classify(gate_input("GET", url)),
        Classification::Reject(_)
    ));
    let mut input = gate_input("GET", url);
    input.authorization = Some("Bearer sqs_12121212121212121212121212121212");
    let Classification::Cid(entry) = gate::classify(input) else {
        panic!("名片头像须为当前会话媒体")
    };
    entry.require_cid(CidRule::Avatar).unwrap();
    assert!(entry.require_cid(CidRule::Business).is_err());
    assert!(entry.open().is_err());
    assert!(entry.api().unwrap().protected());
    assert!(!gate::policy::requires_mls(entry.rule()));
    let old="https://registration.example.test/api/user/profiles/CN220-CTZN2-100000002-2026/assets/avatar";
    let mut input = gate_input("GET", old);
    input.authorization = Some("Bearer sqs_12121212121212121212121212121212");
    assert!(
        matches!(gate::classify(input),Classification::Reject(e) if e.code=="invalid_mls_proof")
    );
    for (method, url) in [
        (
            "GET",
            "https://registration.example.test/api/user/cards/CN220-CTZN2-100000002-2026/banner",
        ),
        ("POST", url),
    ] {
        let mut input = gate_input(method, url);
        input.authorization = Some("Bearer sqs_12121212121212121212121212121212");
        assert!(matches!(gate::classify(input), Classification::Reject(_)));
    }
}
