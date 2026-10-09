use citizenserve::user::{
    profile_service::{Doc, Update},
    profiles,
};
use serde_json::json;
fn doc() -> Doc {
    Doc::empty("CN220-CTZN2-198805201-2026")
}
fn update(v: serde_json::Value) -> Update {
    serde_json::from_value(v).unwrap()
}
#[test]
fn omitted_fields_preserve_existing_text_and_assets() {
    let first=doc().apply(&update(json!({"display_name":"  名称\u{feff}","bio":"  简介  ","avatar_object_key":profiles::asset_key(&doc().cid_number,"avatar").unwrap(),"avatar_content_hash":"AB".repeat(32)})),1).unwrap();
    let next = first.apply(&update(json!({"bio":"修改"})), 2).unwrap();
    assert_eq!(next.display_name, "名称");
    assert_eq!(next.avatar_content_hash, Some("ab".repeat(32)));
    assert_eq!(next.cid_number, first.cid_number);
}
#[test]
fn utf16_limits_count_supplementary_characters() {
    assert!(doc()
        .apply(&update(json!({"display_name":"😀".repeat(20)})), 1)
        .is_ok());
    assert_eq!(
        doc()
            .apply(&update(json!({"display_name":"😀".repeat(21)})), 1)
            .unwrap_err()
            .code,
        "profile_field_too_long"
    );
    assert!(doc()
        .apply(&update(json!({"bio":"😀".repeat(80)})), 1)
        .is_ok());
    assert!(doc()
        .apply(&update(json!({"bio":"😀".repeat(81)})), 1)
        .is_err());
}
#[test]
fn trim_matches_ecmascript_bom_but_preserves_nel() {
    assert_eq!(profiles::trim("\u{feff}\u{a0} x \u{3000}"), "x");
    assert_eq!(profiles::trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
}
#[test]
fn asset_and_hash_must_be_paired_owned_and_cleared_together() {
    let key = profiles::asset_key(&doc().cid_number, "banner").unwrap();
    assert!(doc()
        .apply(&update(json!({"banner_object_key":key})), 1)
        .is_err());
    assert!(doc().apply(&update(json!({"banner_object_key":"profile/other/banner","banner_content_hash":"a".repeat(64)})),1).is_err());
    let first = doc()
        .apply(
            &update(json!({"banner_object_key":key,"banner_content_hash":"a".repeat(64)})),
            1,
        )
        .unwrap();
    assert!(first
        .apply(&update(json!({"banner_object_key":null})), 2)
        .is_err());
    let next = first
        .apply(
            &update(json!({"banner_object_key":null,"banner_content_hash":null})),
            2,
        )
        .unwrap();
    assert!(next.banner_object_key.is_none());
}
#[test]
fn profile_body_cannot_choose_cid_account_or_duplicate_fields() {
    for body in [
        r#"{"cid_number":"other"}"#,
        r#"{"account_id":"other"}"#,
        r#"{"display_name":"a","display_name":"b"}"#,
    ] {
        assert!(serde_json::from_str::<Update>(body).is_err());
    }
    assert!(doc()
        .apply(&update(json!({"display_name":null})), 1)
        .is_err());
}
