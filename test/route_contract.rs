use citizenserve::{
    server::routes::{route, Route},
    user::{
        auth::{
            challenge,
            mls_authentication::{ChallengeRequest, Purpose},
        },
        routes::UserRoute,
    },
};
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
    use citizenserve::server::routes::protected_target;
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
            citizenserve::server::routes::protected_target("GET", target).is_err(),
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
    assert!(challenge::target(&r).is_ok());
    r.purpose = Purpose::Request;
    assert!(challenge::target(&r).is_err());
}

#[test]
fn seventeen_step4_routes_are_exact_protected_and_budgeted() {
    use citizenserve::server::routes::protected_target;
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
    use citizenserve::server::routes::{protected_target, Permission};
    let id = format!("top_{}", "ab".repeat(16));
    let mut list = vec![
        ("GET", "/api/topup/config".into(), Permission::Public),
        ("POST", "/api/topup/intent".into(), Permission::Public),
        (
            "POST",
            "/api/topup/confirm".into(),
            Permission::PaymentIntent,
        ),
        (
            "POST",
            "/api/topup/status".into(),
            Permission::PaymentIntent,
        ),
        (
            "GET",
            "/api/topup/settlement/pending".into(),
            Permission::Settlement,
        ),
        (
            "GET",
            "/api/topup/settlement/history".into(),
            Permission::Settlement,
        ),
        (
            "GET",
            "/api/downloads/citizenapp/android".into(),
            Permission::Public,
        ),
        (
            "GET",
            "/api/downloads/citizenwallet/android".into(),
            Permission::Public,
        ),
        (
            "GET",
            "/api/downloads/citizenchain/macos/updater".into(),
            Permission::Public,
        ),
    ];
    for action in ["claim", "settled", "exception"] {
        list.push((
            "POST",
            format!("/api/topup/settlement/{id}/{action}"),
            Permission::Settlement,
        ));
    }
    for p in ["macos", "windows", "linux-arm", "linux-amd"] {
        list.push((
            "GET",
            format!("/api/downloads/citizenchain/{p}"),
            Permission::Public,
        ));
        for method in ["GET", "PUT"] {
            list.push((
                method,
                format!("/api/downloads/citizenchain/{p}/publication"),
                Permission::Publication,
            ));
        }
    }
    for (method, p) in [
        ("GET", "bootstrap"),
        ("GET", "citizensdk/bootstrap"),
        ("GET", "constitution"),
        ("POST", "extrinsics"),
    ] {
        list.push((method, format!("/api/chain/{p}"), Permission::Public));
    }
    assert_eq!(list.len(), 28);
    for (m, p, permission) in list {
        let r = route(m, &p).unwrap();
        assert_eq!(r.permission(), permission);
        assert!(!r.protected());
        assert!(protected_target(m, &p).is_err());
    }
    for p in [
        "/api/download/citizenapp/android",
        "/api/constitution",
        "/api/operations/citizenchain/download-publications/macos",
        "/api/downloads/citizenchain/macOS",
        "/api/chain/extrinsic",
    ] {
        assert!(route("GET", p).is_err());
    }
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
    use citizenserve::server::routes::protected_target;
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
    use citizenserve::server::routes::{protected_target,Permission};
    use citizenserve::user::routes::ProtectedUserRoute;
    assert_eq!(route("POST","/api/user/deletion/challenges").unwrap(),Route::ProtectedUser(ProtectedUserRoute::DeletionChallenge));
    assert_eq!(route("POST","/api/user/deletion").unwrap(),Route::ProtectedUser(ProtectedUserRoute::Delete));
    for p in ["/api/user/deletion/challenges","/api/user/deletion"] {
        assert!(protected_target("POST",p).is_ok());
        assert!(route("GET",p).is_err());
        assert!(protected_target("POST",&format!("{p}?cid_number=other")).is_err());
    }
    for r in [UserRoute::DeletionStatusChallenge,UserRoute::DeletionStatus] {
        let resolved=route("POST",&r.external()).unwrap();
        assert_eq!(resolved.permission(),Permission::Account);
        assert!(!resolved.protected());assert!(!r.registration());assert!(!r.requires_mls());
        assert!(protected_target("POST",&r.external()).is_err());
    }
    assert!(route("POST","/api/square/account/delete/challenge").is_err());
    assert!(route("POST","/api/square/account/delete").is_err());
}
