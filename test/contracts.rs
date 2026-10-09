#[test]
fn gmb_domain_is_preserved() {
    assert_eq!(
        citizenserve::shared::crypto::hex(&citizenserve::shared::crypto::signing_message(
            0x10,
            &[1, 2, 3, 4, 5, 6, 7, 8]
        )),
        "19e050b3476dfd7db0aae9d527e205da44b8f9d00e5ddf4f81f4830ab0c00568"
    );
}

use citizenserve::{
    shared::crypto,
    user::{
        auth::mls_authentication::{self, Proof},
        identity::{Identity, IdentityLevel},
        registration::{protocol::*, service::*},
    },
};
use ed25519_dalek::{Signer, SigningKey};
fn config() -> Config {
    Config {
        registration_scope: "citizenserve:fixture".into(),
        service_origin: "https://registration.example.test".into(),
        chain_scope: format!("0x{}", "00".repeat(32)),
        site_key: "public-test-key".into(),
    }
}
fn input() -> Prepare {
    Prepare {
        protocol_version: 1,
        chain_scope: config().chain_scope,
        account_id: "0x2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972".into(),
        institution: Institution::CTZN,
    }
}
fn entropy() -> Entropy {
    Entropy {
        enrollment: [1; 16],
        verification: [2; 16],
        recovery: [3; 32],
        page: [4; 32],
        nonce: [5; 32],
    }
}
fn prepared() -> (Enrollment, Response) {
    prepare(&config(), &input(), entropy(), 1_000_000).unwrap()
}
fn verify_input(row: &Enrollment, response: &Response) -> Verify {
    Verify {
        protocol_version: 1,
        enrollment_id: row.enrollment_id.clone(),
        recovery_token: response.recovery_token.clone().unwrap(),
        verification_id: row.attempt.verification_id.clone(),
        turnstile_token: Some("synthetic-turnstile-test-only".into()),
    }
}
fn external(row: &Enrollment) -> SiteverifyResult {
    SiteverifyResult {
        http_ok: true,
        success: true,
        action: ACTION.into(),
        hostname: config().hostname(),
        cdata: row.attempt.cdata.clone(),
        challenge_at_millis: 1_000_001,
    }
}

#[test]
fn registration_matches_confirmed_seven_field_golden() {
    let bytes = context_bytes(&config(), &input()).unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("contract/registration.json")).unwrap();
    assert_eq!(bytes.len(), 232);
    assert_eq!(
        format!("0x{}", crypto::sha256_hex(&bytes)),
        fixture["sha256"].as_str().unwrap()
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        fixture["context"]
    );
}
#[test]
fn prepare_rejects_cid_year_and_duplicate_fields() {
    let base = serde_json::to_string(&input()).unwrap();
    for extra in [
        ",\"cid_number\":\"CN123\"",
        ",\"cid_year\":2026",
        ",\"protocol_version\":1",
    ] {
        let value = format!("{}{}{}", &base[..base.len() - 1], extra, "}");
        assert!(serde_json::from_str::<Prepare>(&value).is_err());
    }
}
#[test]
fn version_and_chain_are_frozen_before_creating_a_record() {
    let mut request = input();
    request.protocol_version = 2;
    assert_eq!(
        context_bytes(&config(), &request).unwrap_err().code,
        "unsupported_registration_version"
    );
    request.protocol_version = 1;
    request.chain_scope = format!("0x{}", "ab".repeat(32));
    assert_eq!(
        context_bytes(&config(), &request).unwrap_err().code,
        "registration_context_mismatch"
    );
}
#[test]
fn capability_secrets_are_separate_and_not_in_persistent_record() {
    let (row, r) = prepared();
    let value = serde_json::to_string(&row).unwrap();
    let recovery = r.recovery_token.as_ref().unwrap();
    let page_token = r
        .verification
        .as_ref()
        .unwrap()
        .page_url
        .split("page_token=")
        .nth(1)
        .unwrap();
    assert_ne!(page_token, recovery);
    assert_eq!(recovery.len(), 43);
    assert_eq!(page_token.len(), 43);
    assert!(!value.contains(recovery));
    assert!(!value.contains(page_token));
    row.recover(recovery).unwrap();
    page(&row, &config(), page_token, 1_000_001).unwrap();
    assert!(row.recover(page_token).is_err());
    assert!(page(&row, &config(), recovery, 1_000_001).is_err());
    assert!(row.response().recovery_token.is_none());
    assert!(row.response().verification.is_none());
}
#[test]
fn prepare_and_page_expire_without_physical_cleanup() {
    let (row, r) = prepared();
    assert_eq!(row.expires_at_millis, 1_600_000);
    let token = r
        .verification
        .unwrap()
        .page_url
        .split("page_token=")
        .nth(1)
        .unwrap()
        .to_owned();
    assert!(page(&row, &config(), &token, 1_300_000).is_err());
    assert_eq!(
        row.check(&config(), 1_600_000).unwrap_err().code,
        "registration_expired"
    );
}
#[test]
fn refresh_invalidates_previous_attempt_without_extending_enrollment() {
    let (mut row, r) = prepared();
    let previous = row.attempt.clone();
    let response = refresh(
        &mut row,
        &config(),
        PageEntropy {
            verification: [6; 16],
            page: [7; 32],
            nonce: [8; 32],
        },
        1_200_000,
    )
    .unwrap();
    assert_ne!(row.attempt.verification_id, previous.verification_id);
    assert_eq!(row.expires_at_millis, 1_600_000);
    assert!(response.recovery_token.is_none());
    assert!(response.verification.is_some());
    let request = verify_input(
        &Enrollment {
            attempt: previous,
            ..row.clone()
        },
        &r,
    );
    assert!(claim(&mut row, &config(), &request, 1_200_001).is_err());
}
#[test]
fn only_same_token_can_retry_and_external_calls_are_capped() {
    let (mut row, r) = prepared();
    let mut request = verify_input(&row, &r);
    assert!(claim(&mut row, &config(), &request, 1_000_001).unwrap());
    assert_eq!(
        claim(&mut row, &config(), &request, 1_000_002)
            .unwrap_err()
            .code,
        "verification_in_progress"
    );
    request.turnstile_token = Some("different-token".into());
    assert_eq!(
        claim(&mut row, &config(), &request, 1_011_002)
            .unwrap_err()
            .code,
        "turnstile_failed"
    );
    request.turnstile_token = Some("synthetic-turnstile-test-only".into());
    for now in [1_011_002, 1_022_003] {
        assert!(claim(&mut row, &config(), &request, now).unwrap());
    }
    assert_eq!(row.attempt.calls, 3);
    assert_eq!(
        claim(&mut row, &config(), &request, 1_033_004)
            .unwrap_err()
            .code,
        "turnstile_failed"
    );
}
#[test]
fn timeout_never_grants_human_verification() {
    let (mut row, r) = prepared();
    let request = verify_input(&row, &r);
    claim(&mut row, &config(), &request, 1_000_001).unwrap();
    assert_eq!(
        save_verification(&mut row, &config(), None, 1_000_100)
            .unwrap_err()
            .code,
        "turnstile_unavailable"
    );
    assert_eq!(row.state, State::Prepared);
    assert_eq!(row.attempt.in_flight_until, 0);
    assert!(claim(&mut row, &config(), &request, 1_000_101).unwrap());
}
#[test]
fn siteverify_requires_action_hostname_cdata_and_time() {
    for kind in 0..7 {
        let (mut row, r) = prepared();
        let request = verify_input(&row, &r);
        claim(&mut row, &config(), &request, 1_000_001).unwrap();
        let mut result = external(&row);
        match kind {
            0 => result.success = false,
            1 => result.http_ok = false,
            2 => result.action = "device_bind".into(),
            3 => result.hostname = "other.test".into(),
            4 => result.cdata = "00".repeat(32),
            5 => result.challenge_at_millis = 900_000,
            _ => result.challenge_at_millis = 1_040_001,
        }
        assert_eq!(
            save_verification(&mut row, &config(), Some(&result), 1_000_002)
                .unwrap_err()
                .code,
            "turnstile_failed"
        );
        assert_eq!(row.state, State::Prepared);
        assert!(row.attempt.rejected);
    }
}
#[test]
fn stored_success_is_retryable_without_repeating_turnstile() {
    let (mut row, r) = prepared();
    let mut request = verify_input(&row, &r);
    claim(&mut row, &config(), &request, 1_000_001).unwrap();
    let result = external(&row);
    save_verification(&mut row, &config(), Some(&result), 1_000_002).unwrap();
    assert_eq!(row.state, State::HumanVerified);
    assert_eq!(row.expires_at_millis, 1_000_000 + VERIFIED_TTL);
    request.turnstile_token = None;
    assert!(!claim(&mut row, &config(), &request, 1_000_003).unwrap());
    assert_eq!(row.attempt.calls, 1);
    assert!(row.response().recovery_token.is_none());
}
#[test]
fn verify_requires_explicit_token_field_even_for_null_retry() {
    let (row, r) = prepared();
    let request = verify_input(&row, &r);
    let mut v = serde_json::to_value(request).unwrap();
    v.as_object_mut().unwrap().remove("turnstile_token");
    assert!(serde_json::from_value::<Verify>(v.clone()).is_err());
    v["turnstile_token"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<Verify>(v).is_ok());
}
#[test]
fn activated_cannot_be_cancelled_or_expired_by_pending_ttl() {
    let (mut row, _) = prepared();
    row.state = State::Activated;
    assert!(row.check(&config(), 1_000_000 + VERIFIED_TTL + 1).is_ok());
    assert_eq!(
        cancel(&mut row, &config(), 1_000_000 + VERIFIED_TTL + 1)
            .unwrap_err()
            .code,
        "registration_already_activated"
    );
}
#[test]
fn scope_and_origin_cannot_reuse_verification() {
    let (row, _) = prepared();
    let mut c = config();
    c.registration_scope = "citizenserve:other".into();
    assert!(row.check(&c, 1_000_001).is_err());
    c = config();
    c.service_origin = "https://other.test".into();
    assert!(row.check(&c, 1_000_001).is_err());
}
#[test]
fn all_authoritative_gmb_vectors_match() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("contract/signing_domain_vectors.json")).unwrap();
    for vector in fixture["vectors"].as_array().unwrap() {
        let tag = u8::from_str_radix(&vector["op_tag"].as_str().unwrap()[2..], 16).unwrap();
        let payload = crypto::unhex(vector["scale_payload_hex"].as_str().unwrap()).unwrap();
        assert_eq!(
            crypto::hex(&crypto::signing_message(tag, &payload)),
            vector["message_hex"].as_str().unwrap()
        );
    }
}

#[test]
fn mls_sign_content_matches_independent_sdk_contract_vector() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("contract/mls_authentication.json")).unwrap();
    let proof: Proof = serde_json::from_value(fixture["proof"].clone()).unwrap();
    let message = proof.message().unwrap();
    assert_eq!(
        crypto::hex(&message),
        fixture["message_hex"].as_str().unwrap()
    );
    assert_eq!(
        crypto::sha256_hex(&message),
        fixture["message_sha256"].as_str().unwrap()
    );
}
fn signed_proof() -> (Proof, Identity) {
    // 固定合成测试种子，不读取任何用户设备材料。
    let key = SigningKey::from_bytes(&[23; 32]);
    let public_key = format!("0x{}", crypto::hex(key.verifying_key().as_bytes()));
    let identity = Identity {
        cid_number: "CN220-CTZN2-198805201-2026".into(),
        account_id: input().account_id,
        binding_revision: 1,
        identity_level: IdentityLevel::Visitor,
        finalized_block_number: 10,
        finalized_block_hash: format!("0x{}", "aa".repeat(32)),
        status: citizenserve::user::identity::CidStatus::Active,
        institution: Institution::CTZN,
        chain_scope: config().chain_scope,
        registered_block_number: 10,
        registered_block_hash: format!("0x{}", "aa".repeat(32)),
        authoritative_current: true,
        registered_at_millis: 900_000,
        finalized_timestamp_millis: 1_000_000,
        checked_at_millis: 1_000_000,
        verification_deadline_millis: 1_060_000,
    };
    let mut proof = Proof {
        user_id: identity.cid_number.clone(),
        device_id: public_key[2..].into(),
        public_key,
        account_id: identity.account_id.clone(),
        binding_revision: 1,
        service_origin: config().service_origin,
        challenge: format!("0x{}", "77".repeat(32)),
        expires_at_millis: 1_200_000,
        method: "POST".into(),
        request_target: "/api/user/devices".into(),
        body_sha256: format!("0x{}", crypto::sha256_hex(b"{}")),
        signature: format!("0x{}", "00".repeat(64)),
    };
    proof.signature = format!(
        "0x{}",
        crypto::hex(&key.sign(&proof.message().unwrap()).to_bytes())
    );
    (proof, identity)
}
#[test]
fn mls_signed_request_rejects_changed_body_target_and_binding() {
    let (proof, identity) = signed_proof();
    proof
        .verify_request(
            &identity,
            &config().service_origin,
            "POST",
            &proof.request_target,
            b"{}",
            1_000_000,
        )
        .unwrap();
    for (method, target, body) in [
        ("POST", proof.request_target.as_str(), b"{ }".as_slice()),
        ("PUT", proof.request_target.as_str(), b"{}".as_slice()),
        ("POST", "/api/user/sessions", b"{}".as_slice()),
    ] {
        assert!(proof
            .verify_request(
                &identity,
                &config().service_origin,
                method,
                target,
                body,
                1_000_000
            )
            .is_err());
    }
    let mut newer = identity;
    newer.binding_revision = 2;
    assert_eq!(
        proof
            .verify_request(
                &newer,
                &config().service_origin,
                "POST",
                &proof.request_target,
                b"{}",
                1_000_000
            )
            .unwrap_err()
            .code,
        "cid_binding_changed"
    );
}
#[test]
fn mls_domain_and_expiration_are_enforced() {
    let (mut proof, _) = signed_proof();
    proof.verify_signature().unwrap();
    proof.challenge = format!("0x{}", "88".repeat(32));
    assert!(proof.verify_signature().is_err());
    let (proof, identity) = signed_proof();
    assert_eq!(
        proof
            .verify_request(
                &identity,
                &config().service_origin,
                "POST",
                &proof.request_target,
                b"{}",
                1_200_000
            )
            .unwrap_err()
            .code,
        "invalid_mls_challenge"
    );
}
#[test]
fn mls_encoding_rejects_padding_whitespace_and_duplicates_but_accepts_other_key_order() {
    let (proof, _) = signed_proof();
    let raw = serde_json::to_string(&proof).unwrap();
    mls_authentication::read(&crypto::base64url(raw.as_bytes())).unwrap();
    assert!(mls_authentication::read(&(crypto::base64url(raw.as_bytes()) + "=")).is_err());
    for text in [
        format!(" {raw}"),
        format!("{},\"method\":\"POST\"}}", &raw[..raw.len() - 1]),
    ] {
        assert!(mls_authentication::read(&crypto::base64url(text.as_bytes())).is_err());
    }
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let reverse: serde_json::Map<String, serde_json::Value> = value
        .as_object()
        .unwrap()
        .iter()
        .rev()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    mls_authentication::read(&crypto::base64url(&serde_json::to_vec(&reverse).unwrap()))
        .unwrap()
        .verify_signature()
        .unwrap();
}
#[test]
fn sr25519_wallet_authorization_rejects_other_account_or_message() {
    let mini = schnorrkel::MiniSecretKey::from_bytes(&[42; 32]).unwrap();
    let key = mini.expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
    let account = format!("0x{}", crypto::hex(&key.public.to_bytes()));
    let message = mls_authentication::device_binding_message(
        "CN123",
        1,
        &account,
        &format!("0x{}", "ab".repeat(32)),
        1000,
    )
    .unwrap();
    let signature = format!(
        "0x{}",
        crypto::hex(&key.sign_simple(b"substrate", &message).to_bytes())
    );
    assert!(mls_authentication::verify_wallet(
        &message, &signature, &account
    ));
    let mut changed = message;
    changed[0] ^= 1;
    assert!(!mls_authentication::verify_wallet(
        &changed, &signature, &account
    ));
    assert!(!mls_authentication::verify_wallet(
        &message,
        &signature,
        &format!("0x{}", "00".repeat(32))
    ));
}
#[test]
fn origin_and_target_normalization_are_strict() {
    for origin in [
        "http://example.test",
        "https://example.test/",
        "https://EXAMPLE.test",
        "https://example.test:443",
        "https://user@example.test",
    ] {
        assert!(citizenserve::shared::ids::origin(origin).is_err());
    }
    for target in ["//other.test/", "/x#f", "/x\\y", "/x%zz", "/with space"] {
        assert!(mls_authentication::target("POST", target).is_err());
    }
}
#[test]
fn membership_is_independent_from_identity_and_chat_deadline_is_clipped() {
    use citizenserve::membership::{Level, Membership, Status};
    let (proof, identity) = signed_proof();
    let membership = Membership {
        level: Level::Spark,
        status: Status::Cancelled,
        paid_until_millis: 1_100_000,
    };
    let admission = citizenserve::user::admission::Admission {
        cid_number: identity.cid_number.clone(),
        enrollment_id: "synthetic".into(),
        source: "turnstile".into(),
        human_verified_at_millis: 900_000,
        registration_scope: config().registration_scope,
        service_origin: config().service_origin,
        chain_scope: config().chain_scope,
        institution: Institution::CTZN,
    };
    let device = citizenserve::user::auth::device::Device {
        cid_number: identity.cid_number.clone(),
        device_id: proof.device_id.clone(),
        binding_revision: 1,
        account_id: identity.account_id.clone(),
        public_key: proof.public_key,
        issued_at: 900_000,
        created_at: 900_000,
        updated_at: 900_000,
        active: true,
    };
    let session = citizenserve::user::auth::session::Session {
        session_token_hash: "00".repeat(32),
        cid_number: identity.cid_number.clone(),
        binding_revision: 1,
        account_id: identity.account_id.clone(),
        device_id: device.device_id.clone(),
        created_at: 900_000,
        expires_at: 1_080_000,
    };
    let authority = citizenserve::server::guard::session_authority(
        &identity,
        &admission,
        &device,
        &session,
        &config(),
        1_000_000,
    )
    .unwrap();
    let subject = citizenserve::user::chat_access::Subject::verified(
        &authority,
        &device,
        &session,
        &config(),
        1_000_000,
    )
    .unwrap();
    assert_eq!(subject.session_deadline(), 1_080_000);
    assert_eq!(
        membership.require(1_000_000).unwrap().chat_file_max_bytes,
        5120 * 1024 * 1024
    );
    assert!(membership.require(1_100_000).is_err());
}
#[test]
fn quota_includes_reservations_and_prevents_overflow() {
    use citizenserve::square::quota::{reserve, Usage};
    let plan = citizenserve::membership::plan(citizenserve::membership::Level::Freedom);
    assert!(reserve(
        Usage {
            images: 299,
            ..Usage::default()
        },
        Usage {
            images: 1,
            ..Usage::default()
        },
        Usage {
            images: 1,
            ..Usage::default()
        },
        plan
    )
    .is_err());
    assert!(reserve(
        Usage {
            images: u32::MAX,
            ..Usage::default()
        },
        Usage::default(),
        Usage {
            images: 1,
            ..Usage::default()
        },
        plan
    )
    .is_err());
}
#[test]
fn object_paths_are_cid_based_and_reject_traversal() {
    assert_eq!(
        citizenserve::square::objects::manifest_key("CN123", "sqp_abc").unwrap(),
        "square/CN123/posts/sqp_abc/manifest.json"
    );
    assert!(citizenserve::square::objects::manifest_key("CN123", "../other").is_err());
    assert!(citizenserve::user::profiles::asset_key("../other", "avatar").is_err());
}
#[test]
fn settlement_claim_is_not_stolen_and_only_same_receipt_is_idempotent() {
    use citizenserve::topup::{Settlement, State};
    let mut s = Settlement {
        state: State::Pending,
        claim_id: None,
        finalized_transaction: None,
    };
    s.claim("worker-a").unwrap();
    s.claim("worker-a").unwrap();
    assert!(s.claim("worker-b").is_err());
    let hash = format!("0x{}", "ab".repeat(32));
    s.settle("worker-a", &hash).unwrap();
    s.settle("worker-a", &hash).unwrap();
    assert!(s
        .settle("worker-a", &format!("0x{}", "cd".repeat(32)))
        .is_err());
    assert_eq!(
        citizenserve::topup::quote("pkg_15")
            .unwrap()
            .citizen_coin_fen,
        1_000_000
    );
}

#[test]
fn relay_and_installer_use_exact_new_contract() {
    use citizenserve::{chain::Relay, downloads};
    assert!(serde_json::from_str::<Relay>(r#"{"extrinsic_hex":"0x01"}"#).is_err());
    assert_eq!(
        serde_json::from_str::<Relay>(r#"{"signed_extrinsic_hex":"0x01"}"#)
            .unwrap()
            .bytes()
            .unwrap(),
        [1]
    );
    assert_eq!(
        downloads::installer_target("/downloads/citizenapp/android")
            .unwrap()
            .0,
        "citizenapp"
    );
    assert!(downloads::installer_target("/download/citizenapp/android").is_err());
}

#[test]
fn exact_push_registration_contract_rejects_old_self_reported_device() {
    use citizenserve::notifications::endpoint::Register;
    assert!(serde_json::from_str::<Register>(
        r#"{"device_id":"ab","platform":"apns","token":"old","expires_at":2000000}"#
    )
    .is_err());
    assert!(citizenserve::notifications::validate_payload(&vec![0; 4097]).is_err());
}
