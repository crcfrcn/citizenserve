use super::*;
use crate::tatachat::tests::{access, actor, run, snapshot, FakeHost, NOW};

#[test]
fn deadlines_are_strict_and_host_capabilities_cannot_be_enlarged() {
    let permit = access("user", "phone");
    assert!(permit.ensure_current(NOW + 59_999).is_ok());
    assert_eq!(permit.ensure_current(NOW + 60_000), Err(Error::Forbidden));
    assert_eq!(permit.effective_max_attachment_bytes(1024), Ok(1024));
    let mut denied = snapshot(actor("user", "phone"));
    denied.chat_enabled = false;
    assert!(Access::from_host(denied, NOW).is_err());
    let mut long = snapshot(actor("user", "phone"));
    long.expires_at_millis += 1;
    assert!(Access::from_host(long, NOW).is_err());
    let mut slow = snapshot(actor("user", "phone"));
    slow.recheck_at_millis += 1;
    assert!(Access::from_host(slow, NOW).is_err());
}

#[test]
fn public_host_access_preserves_strict_deadlines() {
    let fresh = snapshot(actor("user", "phone"));
    // 平台只能通过公开入口取得权限；截止前一毫秒有效，截止时即拒绝。
    let permit = Access::from_host(fresh.clone(), NOW + 59_999).expect("再核验窗口内");
    assert_eq!(permit.deadline(), NOW + 60_000);
    assert_eq!(permit.credential_deadline(), NOW + 900_000);
    for now in [NOW + 60_000, NOW + 60_001] {
        assert!(matches!(
            Access::from_host(fresh.clone(), now),
            Err(Error::Forbidden)
        ));
    }
    let mut expiring = fresh;
    expiring.expires_at_millis = NOW + 30_000;
    expiring.recheck_at_millis = expiring.expires_at_millis;
    assert!(Access::from_host(expiring.clone(), NOW + 29_999).is_ok());
    assert!(matches!(
        Access::from_host(expiring, NOW + 30_000),
        Err(Error::Forbidden)
    ));
}

#[test]
fn public_host_access_rejects_future_issued_snapshot() {
    let mut future = snapshot(actor("user", "phone"));
    future.issued_at_millis = NOW + 1;
    assert!(matches!(
        Access::from_host(future, NOW),
        Err(Error::Forbidden)
    ));
}

#[test]
fn public_host_access_rejects_zero_limits_and_malformed_identity() {
    // 无效宿主快照不能因平台改用公开API而取得推送或其他处理权限。
    for case in 0..6 {
        let mut denied = snapshot(actor("user", "phone"));
        match case {
            0 => denied.max_attachment_bytes = 0,
            1 => denied.actor.user_id = "user:other".into(),
            2 => denied.actor.device_id.clear(),
            3 => denied.authorization_revision.clear(),
            4 => denied.session_id_digest = "a".repeat(63),
            _ => denied.session_id_digest = "g".repeat(64),
        }
        assert!(matches!(
            Access::from_host(denied, NOW),
            Err(Error::Forbidden)
        ));
    }
}

#[test]
fn revision_or_unknown_host_stops_access_without_extending_the_credential() {
    let host = FakeHost::default();
    let mut permit = access("user", "phone");
    host.time.set(NOW + 60_000);
    assert!(run(permit.recheck(&host, false)).is_ok());
    assert_eq!(permit.credential_deadline(), NOW + 900_000);
    *host.revision.borrow_mut() = Some("revision-2".into());
    host.time.set(NOW + 120_000);
    assert_eq!(run(permit.recheck(&host, false)), Err(Error::Forbidden));
    assert_eq!(permit.ensure_current(NOW + 120_000), Err(Error::Forbidden));
    let mut permit = access("user", "phone");
    host.failure.set(Some(Error::StorageUnavailable));
    assert_eq!(
        run(permit.recheck(&host, false)),
        Err(Error::StorageUnavailable)
    );
}

fn signed(context: &CredentialContext, key: &ed25519_dalek::SigningKey, expires: u64) -> String {
    use ed25519_dalek::Signer;
    let claims = Claims {
        version: 1,
        iss: context.issuer.clone(),
        aud: context.audience.clone(),
        purpose: context.purpose.clone(),
        sub: "user".into(),
        device_id: "phone".into(),
        authorization_revision: "revision-1".into(),
        session_hash: "a".repeat(64),
        chat_enabled: true,
        max_attachment_bytes: 1024,
        iat: NOW / 1000,
        nbf: NOW / 1000,
        exp: expires / 1000,
        issued_at_millis: NOW,
        expires_at_millis: expires,
        recheck_at_millis: NOW + 60_000,
    };
    let input = claims
        .unsigned(&context.key_id, NOW)
        .expect("唯一通用签名输入");
    format!(
        "{}.{}",
        input,
        URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes())
    )
}

#[test]
fn real_eddsa_verification_is_not_current_host_authorization() {
    // 公开测试种子只生成合成签名，不使用生产密钥或真实凭证。
    let key = ed25519_dalek::SigningKey::from_bytes(&[42; 32]);
    let mut context = CredentialContext {
        issuer: "https://host.example".into(),
        audience: "citizenserve.tatachat".into(),
        purpose: "tatachat_access".into(),
        key_id: "test-key".into(),
        public_key: key.verifying_key().to_bytes(),
    };
    let token = signed(&context, &key, NOW + 900_000);
    let host = FakeHost::default();
    host.time.set(NOW + 61_000);
    let verified = context
        .verify(&token, host.time.get())
        .expect("旧再核验窗口已过但凭证有效");
    let permit = run(verified.authorize(&host)).expect("重新核实宿主");
    assert_eq!(host.calls.get(), 1);
    assert_eq!(permit.credential_deadline(), NOW + 900_000);
    host.failure.set(Some(Error::Forbidden));
    assert!(run(verified.authorize(&host)).is_err());
    context.key_id = "wrong-key".into();
    assert!(context.verify(&token, NOW).is_err());
    context.key_id = "test-key".into();
    context.purpose = "other".into();
    assert!(context.verify(&token, NOW).is_err());
    context.purpose = "tatachat_access".into();
    assert!(context.verify(&token, NOW + 900_000).is_err());
    let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
    parts[1] = URL_SAFE_NO_PAD.encode(b"{}");
    assert!(context.verify(&parts.join("."), NOW).is_err());
}

#[test]
fn forced_failed_recheck_cannot_reuse_still_unexpired_access() {
    let host = FakeHost::default();
    let mut permit = access("user", "phone");
    host.failure.set(Some(Error::StorageUnavailable));
    assert_eq!(
        run(permit.recheck(&host, true)),
        Err(Error::StorageUnavailable)
    );
    assert_eq!(permit.ensure_current(NOW), Err(Error::Forbidden));
}

#[test]
fn host_may_preserve_original_issue_time_while_refreshing_recheck_window() {
    let mut fresh = snapshot(actor("user", "phone"));
    fresh.recheck_at_millis = NOW + 120_000;
    let permit = Access::from_host(fresh, NOW + 60_000).expect("宿主保持原签发时间");
    assert_eq!(permit.credential_deadline(), NOW + 900_000);
    assert!(permit.ensure_current(NOW + 119_999).is_ok());
}

#[test]
fn signing_input_cannot_issue_stale_or_inconsistent_credentials() {
    let key = ed25519_dalek::SigningKey::from_bytes(&[42; 32]);
    let context = CredentialContext {
        issuer: "https://host.example".into(),
        audience: "citizenserve.tatachat".into(),
        purpose: "tatachat_access".into(),
        key_id: "test-key".into(),
        public_key: key.verifying_key().to_bytes(),
    };
    let token = signed(&context, &key, NOW + 900_000);
    let verified = context.verify(&token, NOW).expect("合成验签");
    let claims = verified.claims();
    // 旧JWT可以进入可信宿主重新核实，但不能被当成新签发输入。
    assert!(context.verify(&token, NOW + 60_000).is_ok());
    assert_eq!(
        claims.unsigned("test-key", NOW + 60_000),
        Err(Error::Forbidden)
    );
    for case in 0..5 {
        let mut changed = claims.clone();
        match case {
            0 => changed.iat += 1,
            1 => changed.expires_at_millis += 1,
            2 => changed.recheck_at_millis += 1,
            3 => changed.iss = "https://host.example/path".into(),
            _ => changed.nbf += 1,
        }
        assert_eq!(changed.unsigned("test-key", NOW), Err(Error::Forbidden));
    }
    assert_eq!(claims.unsigned("bad/key", NOW), Err(Error::Forbidden));
}
