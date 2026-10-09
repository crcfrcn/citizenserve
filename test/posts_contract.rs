use citizenserve::{
    server::routes,
    shared::crypto,
    square::{
        local_copy::{Cursor, Query},
        post_service::ConfirmPost,
    },
};
use serde_json::json;
#[test]
fn self_copy_cursor_is_canonical_composite_and_max_five() {
    let a = Cursor {
        created_at: 1000000,
        post_id: "sqp_a".into(),
    };
    let b = Cursor {
        created_at: 1000000,
        post_id: "sqp_b".into(),
    };
    assert_ne!(a.encode().unwrap(), b.encode().unwrap());
    assert_eq!(Cursor::read(&a.encode().unwrap()).unwrap(), a);
    let q = routes::query(Some("limit=5")).unwrap();
    assert_eq!(Query::read(&q).unwrap().limit, 5);
    assert!(Query::read(&routes::query(Some("limit=6")).unwrap()).is_err());
    let ambiguous = crypto::base64url(br#"{"post_id":"sqp_a","created_at":1000000}"#);
    assert!(Cursor::read(&ambiguous).is_err());
}
#[test]
fn publishing_accepts_only_post_and_transaction_anchors() {
    let good = json!({"post_id":"sqp_1","tx_hash":format!("0x{}","aa".repeat(32)),"block_hash":format!("0x{}","bb".repeat(32))});
    assert!(serde_json::from_value::<ConfirmPost>(good.clone()).is_ok());
    for (field, value) in [
        ("upload_id", json!("squ_1")),
        ("cid_number", json!("CID1")),
        ("post_category", json!("campaign")),
    ] {
        let mut v = good.clone();
        v[field] = value;
        assert!(serde_json::from_value::<ConfirmPost>(v).is_err());
    }
}
#[test]
fn self_and_confirm_are_not_dynamic_post_ids_and_aliases_are_rejected() {
    use citizenserve::square::routes::SquareRoute;
    assert_eq!(
        routes::protected_target("GET", "/api/8964/posts/self?limit=5").unwrap(),
        routes::Route::Square(SquareRoute::SelfPosts)
    );
    assert_eq!(
        routes::protected_target("POST", "/api/8964/posts/confirm").unwrap(),
        routes::Route::Square(SquareRoute::ConfirmPost)
    );
    for (method, path) in [
        ("GET", "/api/8964/posts/confirm"),
        ("POST", "/api/8964/posts/self"),
        ("GET", "/api/square/posts/sqp_1"),
        ("GET", "/api/8964/posts/sqp_1?cid_number=CID1"),
    ] {
        assert!(routes::protected_target(method, path).is_err());
    }
}
