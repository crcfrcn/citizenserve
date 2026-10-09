use citizenserve::{
    membership::Level,
    shared::crypto,
    square::{
        manifest,
        upload_validation::{self, Item, Kind, PostType},
        uploads,
    },
};
use serde_json::json;
fn image() -> Item {
    Item {
        media_kind: Kind::Image,
        content_type: "image/webp".into(),
        byte_size: 100,
        sha256: "a".repeat(64),
        width: 100,
        height: 100,
        duration_seconds: None,
        derivative_kind: "thumbnail".into(),
        derivative_content_type: "image/webp".into(),
        derivative_byte_size: 50,
        derivative_sha256: "b".repeat(64),
    }
}
fn manifest_value() -> serde_json::Value {
    let i = image();
    json!({"schema":"citizenapp.square.post","cid_number":"CID1","post_type":"document","text":"文字","media_items":[{"media_kind":i.media_kind,"content_type":i.content_type,"byte_size":i.byte_size,"sha256":i.sha256,"width":i.width,"height":i.height}]})
}
#[test]
fn document_video_article_enforce_content_shape() {
    let i = image();
    assert!(upload_validation::content(PostType::Document, 0, 0, &[], Level::Spark).is_err());
    assert!(upload_validation::content(
        PostType::Document,
        0,
        300,
        std::slice::from_ref(&i),
        Level::Freedom
    )
    .is_ok());
    assert!(upload_validation::content(
        PostType::Document,
        1,
        0,
        std::slice::from_ref(&i),
        Level::Spark
    )
    .is_err());
    assert!(upload_validation::content(
        PostType::Document,
        0,
        301,
        std::slice::from_ref(&i),
        Level::Spark
    )
    .is_err());
    assert!(upload_validation::content(
        PostType::Document,
        0,
        1,
        &vec![i.clone(); 10],
        Level::Spark
    )
    .is_err());
    assert!(upload_validation::content(
        PostType::Video,
        0,
        1,
        std::slice::from_ref(&i),
        Level::Spark
    )
    .is_err());
    assert!(upload_validation::content(
        PostType::Article,
        10,
        30000,
        &vec![i.clone(); 50],
        Level::Freedom
    )
    .is_ok());
    assert!(
        upload_validation::content(PostType::Article, 10, 1, &vec![i; 51], Level::Freedom).is_err()
    );
}
#[test]
fn declared_limits_use_exact_bytes_dimensions_and_integer_duration() {
    let mut i = image();
    i.byte_size = 1_000_001;
    assert!(i.validate(Level::Freedom).is_err());
    assert!(i.validate(Level::Democracy).is_ok());
    i.width = 1921;
    assert!(i.validate(Level::Democracy).is_err());
    i.width = 1920;
    i.duration_seconds = Some(1);
    assert!(i.validate(Level::Spark).is_err());
    i.duration_seconds = None;
    i.derivative_byte_size = 256001;
    assert!(i.validate(Level::Spark).is_err());
}
#[test]
fn manifest_keeps_raw_hash_and_rejects_wrong_cid_unknown_and_duplicate_fields() {
    let value = manifest_value();
    let raw = serde_json::to_vec(&value).unwrap();
    let hash = crypto::sha256_hex(&raw);
    let m = manifest::read(&raw, "CID1", PostType::Document, &hash).unwrap();
    manifest::validate(&m, &[image()], Level::Freedom).unwrap();
    assert!(manifest::read(&raw, "CID2", PostType::Document, &hash).is_err());
    let mut changed = raw.clone();
    changed.push(b' ');
    assert!(manifest::read(&changed, "CID1", PostType::Document, &hash).is_err());
    let duplicate = String::from_utf8(raw)
        .unwrap()
        .replacen("{", "{\"text\":\"injected\",", 1)
        .into_bytes();
    assert!(manifest::read(
        &duplicate,
        "CID1",
        PostType::Document,
        &crypto::sha256_hex(&duplicate)
    )
    .is_err());
    let mut legacy = value;
    legacy["post_category"] = json!("campaign");
    let r = serde_json::to_vec(&legacy).unwrap();
    assert!(manifest::read(&r, "CID1", PostType::Document, &crypto::sha256_hex(&r)).is_err());
}
#[test]
fn article_requires_unique_complete_media_references_and_canonical_delta() {
    let mut v = manifest_value();
    v["post_type"] = json!("article");
    v["title"] = json!("文章标题共有十个文字");
    v["text"] = json!("这是至少十个汉字的正文");
    v["content_sections"] =
        json!([{"text_delta":[{"insert":"这是至少十个汉字的正文\n","attributes":{"bold":true}}]}]);
    let raw = serde_json::to_vec(&v).unwrap();
    let m = manifest::read(&raw, "CID1", PostType::Article, &crypto::sha256_hex(&raw)).unwrap();
    manifest::validate(&m, &[image()], Level::Spark).unwrap();
    v["content_sections"][0]["gallery_media_indices"] = json!([0]);
    let r = serde_json::to_vec(&v).unwrap();
    let m = manifest::read(&r, "CID1", PostType::Article, &crypto::sha256_hex(&r)).unwrap();
    assert!(manifest::validate(&m, &[image()], Level::Spark).is_err());
}
#[test]
fn prepare_and_complete_have_exact_fields_without_client_authority() {
    assert!(serde_json::from_value::<uploads::Prepare>(json!({"post_type":"document","title_length":0,"text_length":1,"manifest_hash":"a".repeat(64),"manifest_byte_size":123,"media_items":[],"membership_level":"spark"})).is_err());
    assert!(serde_json::from_value::<uploads::Complete>(json!({"manifest_hash":"a".repeat(64),"content_hash":"a".repeat(64),"upload_id":"squ_other"})).is_err());
}
