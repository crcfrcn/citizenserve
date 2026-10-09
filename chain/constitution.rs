//! 宪法展示来自同一canonical finalized锚点，metadata解码完整Law/Version而不跳过字段。
use super::{
    finalized,
    finalized::Anchor,
    identity,
    ports::Rpc,
    scale::{self, Decoded, Metadata},
};
use crate::shared::{crypto, Error, Result};
use parity_scale_codec::Encode;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
async fn map<R: Rpc>(
    rpc: &R,
    m: &Metadata,
    a: &Anchor,
    name: &str,
    parts: &[Vec<u8>],
) -> Result<Option<Decoded>> {
    let (key, ty) = m.storage_key("LegislationYuan", name, parts)?;
    let v = rpc.call("state_getStorage", json!([key, a.hash])).await?;
    if v.is_null() {
        return Ok(None);
    }
    Ok(Some(m.decode(
        &crypto::unhex(v.as_str().ok_or_else(scale::invalid)?)?,
        ty,
    )?))
}
pub fn sequence<'a>(m: &Metadata, v: &'a Decoded, max: usize) -> Result<Vec<&'a Decoded>> {
    let mut v = v;
    for _ in 0..16 {
        if let scale_value::ValueDef::Composite(scale_value::Composite::Unnamed(c)) = &v.value {
            if c.len() == 1
                && matches!(&m.types.resolve(v.context).ok_or_else(scale::invalid)?.type_def, scale_info::TypeDef::Composite(t) if t.fields.len()==1 && t.fields[0].name.is_none())
            {
                v = &c[0];
                continue;
            }
            if c.len() > max {
                return Err(scale::invalid());
            }
            return Ok(c.iter().collect());
        }
        return Err(scale::invalid());
    }
    Err(scale::invalid())
}
fn optional(v: &Decoded) -> Result<Option<&Decoded>> {
    match scale::variant(v)? {
        "None" => Ok(None),
        "Some" => Ok(Some(scale::one(v)?)),
        _ => Err(scale::invalid()),
    }
}
fn text(v: &Decoded, name: &str, max: usize) -> Result<String> {
    scale::text(scale::field(v, name)?, max)
}
fn optional_text(v: &Decoded, name: &str, max: usize) -> Result<Option<String>> {
    optional(scale::field(v, name)?)?
        .map(|v| scale::text(v, max))
        .transpose()
}
pub fn encoded(m: &Metadata, v: &Decoded) -> Result<Vec<u8>> {
    let mut b = vec![];
    scale_value::scale::encode_as_type(v, v.context, &m.types, &mut b)
        .map_err(|_| scale::invalid())?;
    Ok(b)
}
pub fn chapters(
    m: &Metadata,
    root: &Decoded,
    immutable: &BTreeMap<u64, String>,
) -> Result<Vec<Value>> {
    let mut chapter_numbers = BTreeSet::new();
    let mut articles_all = BTreeSet::new();
    let mut output = vec![];
    for c in sequence(m, root, 64)? {
        let cn = positive(c)?;
        if !chapter_numbers.insert(cn) {
            return Err(scale::invalid());
        }
        let mut sections = vec![];
        let mut section_numbers = BTreeSet::new();
        for s in sequence(m, scale::field(c, "sections")?, 64)? {
            let sn = positive(s)?;
            if !section_numbers.insert(sn) {
                return Err(scale::invalid());
            }
            let mut articles = vec![];
            for a in sequence(m, scale::field(s, "articles")?, 256)? {
                let an = positive(a)?;
                if !articles_all.insert(an) {
                    return Err(scale::invalid());
                }
                if let Some(expected) = immutable.get(&an) {
                    if super::transaction::hash(&encoded(m, a)?) != *expected {
                        return Err(Error::new(503, "constitution_immutable_hash_mismatch"));
                    }
                }
                let mut clauses = vec![];
                let mut numbers = BTreeSet::new();
                for q in sequence(m, scale::field(a, "clauses")?, 256)? {
                    if !numbers.insert(positive(q)?) {
                        return Err(scale::invalid());
                    }
                    clauses.push(json!({"text_cn":text(q,"text",65536)?,"text_en":optional_text(q,"text_en",65536)?}));
                }
                articles.push(json!({"number":an,"title_cn":text(a,"title",4096)?,"title_en":optional_text(a,"title_en",4096)?,"body_cn":text(a,"body",65536)?,"body_en":optional_text(a,"body_en",65536)?,"immutable":immutable.contains_key(&an),"clauses":clauses}));
            }
            if articles.is_empty() {
                return Err(scale::invalid());
            }
            sections.push(json!({"number":sn,"title_cn":text(s,"title",4096)?,"title_en":optional_text(s,"title_en",4096)?,"articles":articles}));
        }
        if sections.is_empty() {
            return Err(scale::invalid());
        }
        output.push(json!({"number":cn,"title_cn":text(c,"title",4096)?,"title_en":optional_text(c,"title_en",4096)?,"sections":sections}));
    }
    if output.is_empty() || immutable.keys().any(|n| !articles_all.contains(n)) {
        return Err(scale::invalid());
    }
    Ok(output)
}
fn positive(v: &Decoded) -> Result<u64> {
    let n = scale::integer(scale::field(v, "number")?)?;
    if n == 0 || n > u32::MAX as u64 {
        return Err(scale::invalid());
    }
    Ok(n)
}
pub async fn read<R: Rpc>(rpc: &R, genesis: &str, now: u64) -> Result<Value> {
    let a = finalized::head(rpc, genesis).await?;
    let m = identity::metadata(rpc, &a).await?;
    let law = map(rpc, &m, &a, "Laws", &[0u64.encode()])
        .await?
        .ok_or(Error::new(404, "constitution_not_found"))?;
    if scale::integer(scale::field(&law, "law_id")?)? != 0
        || scale::variant(scale::field(&law, "tier")?)? != "Constitution"
        || scale::integer(scale::field(&law, "scope_code")?)? != 0
        || !matches!(
            scale::variant(scale::field(&law, "status")?)?,
            "Pending" | "Effective"
        )
    {
        return Err(scale::invalid());
    }
    let version = optional(scale::field(&law, "effective_version")?)?
        .map(scale::integer)
        .transpose()?
        .ok_or(Error::new(404, "constitution_not_effective"))?;
    let v32 = u32::try_from(version).map_err(|_| scale::invalid())?;
    let v = map(rpc, &m, &a, "LawVersions", &[0u64.encode(), v32.encode()])
        .await?
        .ok_or_else(scale::invalid)?;
    if scale::integer(scale::field(&v, "law_id")?)? != 0
        || scale::integer(scale::field(&v, "version")?)? != version
    {
        return Err(scale::invalid());
    }
    let timestamp = identity::storage(rpc, &m, &a, "Timestamp", "Now", None)
        .await?
        .as_ref()
        .map(scale::integer)
        .transpose()?
        .ok_or_else(scale::invalid)?;
    if scale::integer(scale::field(&v, "published_at")?)? > timestamp
        || scale::integer(scale::field(&v, "effective_at")?)? > timestamp
    {
        return Err(Error::new(404, "constitution_not_effective"));
    }
    let labels = map(
        rpc,
        &m,
        &a,
        "LawVersionLabels",
        &[0u64.encode(), v32.encode()],
    )
    .await?;
    let manifest = identity::storage(
        rpc,
        &m,
        &a,
        "LegislationYuan",
        "ConstitutionImmutableManifest",
        None,
    )
    .await?
    .ok_or_else(scale::invalid)?;
    let nums = sequence(&m, scale::field(&manifest, "article_numbers")?, 512)?;
    let hashes = sequence(&m, scale::field(&manifest, "article_hashes")?, 512)?;
    if nums.len() != hashes.len() {
        return Err(scale::invalid());
    }
    let mut immutable = BTreeMap::new();
    for (n, h) in nums.into_iter().zip(hashes) {
        let n = scale::integer(n)?;
        if n == 0
            || immutable
                .insert(n, format!("0x{}", crypto::hex(&scale::bytes(h, 32)?)))
                .is_some()
        {
            return Err(scale::invalid());
        }
    }
    let content_hash = format!(
        "0x{}",
        crypto::hex(&scale::bytes(scale::field(&v, "content_hash")?, 32)?)
    );
    let root = scale::field(&v, "chapters")?;
    if super::transaction::hash(&encoded(&m, root)?) != content_hash {
        return Err(Error::new(503, "constitution_content_hash_mismatch"));
    }
    let generated_at = now;
    let doc = json!({"ok":true,"schema":"citizenapp.constitution","version":version,"content_hash":content_hash,"version_label":labels.as_ref().map(|l|Ok::<Value,Error>(json!({"cn":text(l,"title",4096)?,"en":optional_text(l,"title_en",4096)?}))).transpose()?,"immutable_articles":immutable.keys().collect::<Vec<_>>(),"chapters":chapters(&m,root,&immutable)?,"generated_at":generated_at,"cache_ttl_seconds":300});
    if serde_json::to_vec(&doc)
        .map_err(|_| scale::invalid())?
        .len()
        > 2 * 1024 * 1024
    {
        return Err(scale::invalid());
    }
    Ok(doc)
}
