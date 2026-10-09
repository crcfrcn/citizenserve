//! 原始 JSON 字节是链上哈希锚点，读取回灌不得重编码。
use super::upload_validation::{self, Item, Kind, PostType};
use crate::{
    membership::Level,
    shared::{crypto, ids, Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Media {
    pub media_kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    pub content_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delta {
    pub insert: String,
    #[serde(default)]
    pub attributes: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub text_delta: Vec<Delta>,
    #[serde(default)]
    pub gallery_media_indices: Option<Vec<usize>>,
    #[serde(default)]
    pub video_media_index: Option<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: String,
    pub cid_number: String,
    pub post_type: PostType,
    #[serde(default)]
    pub title: Option<String>,
    pub text: String,
    #[serde(default)]
    pub content_sections: Option<Vec<Section>>,
    pub media_items: Vec<Media>,
}
fn invalid() -> Error {
    Error::new(409, "manifest_invalid")
}
fn attributes(d: &Delta) -> bool {
    if d.insert.is_empty() {
        return false;
    }
    d.attributes.iter().all(|(k, v)| match k.as_str() {
        "bold" | "italic" | "underline" | "strike" => v == &Value::Bool(true),
        "font" => v
            .as_str()
            .is_some_and(|s| ["heiti", "songti", "kaiti", "monospace", "jinglei"].contains(&s)),
        "size" => v
            .as_str()
            .is_some_and(|s| ["small", "body", "large", "subtitle", "title"].contains(&s)),
        "color" => v.as_str().is_some_and(|s| {
            [
                "default",
                "secondary",
                "primary",
                "info",
                "success",
                "warning",
                "danger",
            ]
            .contains(&s)
        }),
        "background" => v.as_str().is_some_and(|s| {
            [
                "neutral_soft",
                "primary_soft",
                "info_soft",
                "success_soft",
                "warning_soft",
                "danger_soft",
            ]
            .contains(&s)
        }),
        "align" => d.insert == "\n" && v.as_str().is_some_and(|s| ["center", "right"].contains(&s)),
        "list" => {
            d.insert == "\n"
                && v.as_str()
                    .is_some_and(|s| ["ordered", "bullet"].contains(&s))
        }
        _ => false,
    })
}
pub fn read(raw: &[u8], cid: &str, kind: PostType, expected: &str) -> Result<Manifest> {
    if raw.is_empty()
        || raw.len() > 262144
        || !ids::hex(expected, 32, false)
        || crypto::sha256_hex(raw) != expected
    {
        return Err(Error::new(409, "manifest_hash_mismatch"));
    }
    let m: Manifest = crate::server::routes::parse_json(raw, 262144).map_err(|_| invalid())?;
    if m.schema != "citizenapp.square.post"
        || m.cid_number != cid
        || m.post_type != kind
        || m.media_items.len() > 110
    {
        return Err(invalid());
    }
    ids::cid(cid)?;
    Ok(m)
}
pub fn validate(m: &Manifest, items: &[Item], level: Level) -> Result<()> {
    if m.media_items.len() != items.len() {
        return Err(invalid());
    }
    for (a, b) in m.media_items.iter().zip(items) {
        if a.media_kind != b.media_kind
            || a.content_type != b.content_type
            || a.byte_size != b.byte_size
            || a.sha256 != b.sha256
            || a.width != b.width
            || a.height != b.height
            || a.duration_seconds != b.duration_seconds
        {
            return Err(invalid());
        }
    }
    upload_validation::content(
        m.post_type,
        m.title.as_deref().unwrap_or("").trim().chars().count(),
        m.text.trim().chars().count(),
        items,
        level,
    )?;
    if m.post_type != PostType::Article {
        if m.title.is_some() || m.content_sections.is_some() {
            return Err(invalid());
        }
        return Ok(());
    }
    let sections = m
        .content_sections
        .as_ref()
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
    let mut referenced = BTreeSet::new();
    for section in sections {
        if section.text_delta.is_empty() || !section.text_delta.iter().all(attributes) {
            return Err(invalid());
        }
        let text = section
            .text_delta
            .iter()
            .map(|d| d.insert.as_str())
            .collect::<String>();
        if !text.ends_with('\n') || text.trim().chars().count() < 10 {
            return Err(invalid());
        }
        if section.gallery_media_indices.is_some() && section.video_media_index.is_some() {
            return Err(invalid());
        }
        let (indices, kind) = if let Some(g) = &section.gallery_media_indices {
            if g.is_empty() || g.len() > 9 {
                return Err(invalid());
            }
            (g.clone(), Kind::Image)
        } else {
            (section.video_media_index.into_iter().collect(), Kind::Video)
        };
        for index in indices {
            if index == 0
                || !referenced.insert(index)
                || !m
                    .media_items
                    .get(index)
                    .is_some_and(|i| i.media_kind == kind)
            {
                return Err(invalid());
            }
        }
    }
    if referenced.len() != items.len() - 1 {
        return Err(invalid());
    }
    Ok(())
}
