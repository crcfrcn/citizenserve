use super::*;
use crate::tatachat::tests::{access, actor, package, run, FakeHost, Memory, NOW};

#[test]
fn last_resort_resolution_does_not_consume_and_expired_packages_are_hidden() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let permit = access("sender", "phone");
    let package = Package::from_protocol(&package(), permit.actor(), NOW).expect("公开包");
    run(publish(&store, &permit, &package, NOW)).expect("发布");
    for _ in 0..2 {
        assert_eq!(
            run(resolve(&store, "sender", Some("phone"), NOW, 32, 4096)).expect("解析"),
            vec![package.clone()]
        );
    }
    assert!(
        run(resolve(&store, "sender", None, NOW + 600_000, 32, 4096))
            .expect("过期解析")
            .is_empty()
    );
}

#[test]
fn package_validation_checks_owner_last_resort_and_lifetime() {
    let mut value = package();
    value.last_resort = false;
    assert!(Package::from_protocol(&value, &actor("sender", "phone"), NOW).is_err());
    value.last_resort = true;
    value.not_after = NOW;
    assert!(Package::from_protocol(&value, &actor("sender", "phone"), NOW).is_err());
    assert!(Package::from_protocol(&package(), &actor("sender", "other"), NOW).is_err());
}
