//! 由锚定区块metadata解码整份storage；不扫描事件字节寻找看似合法的CID。
use crate::shared::{crypto, Error, Result};
use frame_metadata::{
    v14::{StorageEntryType, StorageHasher},
    RuntimeMetadata, RuntimeMetadataPrefixed,
};
use parity_scale_codec::Decode;
use scale_info::{form::PortableForm, PortableRegistry};
use scale_value::{Composite, Value, ValueDef};
use std::{collections::BTreeMap, hash::Hasher};
pub type Decoded = Value<u32>;
#[derive(Clone, Debug)]
pub struct ExtrinsicTypes {
    pub versions: Vec<u8>,
    pub address: u32,
    pub signature: u32,
    pub call: u32,
    pub extensions: Vec<u32>,
}
pub struct Metadata {
    pub extrinsic: Option<ExtrinsicTypes>,
    pub types: PortableRegistry,
    entries: BTreeMap<(String, String), StorageEntryType<PortableForm>>,
}
pub fn invalid() -> Error {
    Error::new(503, "chain_encoding_invalid")
}
impl Metadata {
    pub fn read(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(invalid());
        }
        let mut input = bytes;
        let m = RuntimeMetadataPrefixed::decode(&mut input).map_err(|_| invalid())?;
        if m.0 != frame_metadata::META_RESERVED || !input.is_empty() {
            return Err(invalid());
        }
        let extrinsic = match &m.1 {
            RuntimeMetadata::V14(x) => {
                let ty = x.types.resolve(x.extrinsic.ty.id).ok_or_else(invalid)?;
                let param = |name: &str| {
                    ty.type_params
                        .iter()
                        .find(|p| p.name == name)
                        .and_then(|p| p.ty)
                        .map(|t| t.id)
                        .ok_or_else(invalid)
                };
                match (param("Address"), param("Signature"), param("Call")) {
                    (Ok(address), Ok(signature), Ok(call)) => Some(ExtrinsicTypes {
                        versions: vec![x.extrinsic.version],
                        address,
                        signature,
                        call,
                        extensions: x
                            .extrinsic
                            .signed_extensions
                            .iter()
                            .map(|e| e.ty.id)
                            .collect(),
                    }),
                    _ => None,
                }
            }
            RuntimeMetadata::V15(x) => Some(ExtrinsicTypes {
                versions: vec![x.extrinsic.version],
                address: x.extrinsic.address_ty.id,
                signature: x.extrinsic.signature_ty.id,
                call: x.extrinsic.call_ty.id,
                extensions: x
                    .extrinsic
                    .signed_extensions
                    .iter()
                    .map(|e| e.ty.id)
                    .collect(),
            }),
            RuntimeMetadata::V16(x) => {
                let indices = x
                    .extrinsic
                    .transaction_extensions_by_version
                    .get(&0)
                    .ok_or_else(invalid)?;
                let extensions = indices
                    .iter()
                    .map(|i| {
                        x.extrinsic
                            .transaction_extensions
                            .get(i.0 as usize)
                            .map(|e| e.ty.id)
                            .ok_or_else(invalid)
                    })
                    .collect::<Result<Vec<_>>>()?;
                Some(ExtrinsicTypes {
                    versions: x.extrinsic.versions.clone(),
                    address: x.extrinsic.address_ty.id,
                    signature: x.extrinsic.signature_ty.id,
                    call: x.extrinsic.call_ty.id,
                    extensions,
                })
            }
            _ => None,
        };
        let mut entries = BTreeMap::new();
        macro_rules! normalize {
            ($meta:expr) => {{
                let meta = $meta;
                for p in meta.pallets {
                    if let Some(s) = p.storage {
                        for e in s.entries {
                            entries.insert((s.prefix.clone(), e.name), e.ty);
                        }
                    }
                }
                Self {
                    types: meta.types,
                    entries,
                    extrinsic,
                }
            }};
        }
        Ok(match m.1 {
            RuntimeMetadata::V14(m) => normalize!(m),
            RuntimeMetadata::V15(m) => normalize!(m),
            RuntimeMetadata::V16(m) => normalize!(m),
            _ => return Err(invalid()),
        })
    }
    pub fn storage_type(&self, pallet: &str, name: &str, map: bool) -> Result<u32> {
        let entry = self
            .entries
            .get(&(pallet.into(), name.into()))
            .ok_or_else(invalid)?;
        match entry {
            StorageEntryType::Plain(t) if !map => Ok(t.id),
            StorageEntryType::Map { hashers, value, .. }
                if map && hashers == &[StorageHasher::Blake2_128Concat] =>
            {
                Ok(value.id)
            }
            _ => Err(invalid()),
        }
    }
    pub fn decode(&self, bytes: &[u8], ty: u32) -> Result<Decoded> {
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(invalid());
        }
        let mut input = bytes;
        let result = scale_value::scale::decode_as_type(&mut input, ty, &self.types)
            .map_err(|_| invalid())?;
        if !input.is_empty() {
            return Err(invalid());
        }
        Ok(result)
    }
}
pub fn field<'a>(v: &'a Decoded, name: &str) -> Result<&'a Decoded> {
    let c = match &v.value {
        ValueDef::Composite(c) => c,
        ValueDef::Variant(v) => &v.values,
        _ => return Err(invalid()),
    };
    match c {
        Composite::Named(fields) => fields
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v)
            .ok_or_else(invalid),
        _ => Err(invalid()),
    }
}
pub fn variant(v: &Decoded) -> Result<&str> {
    if let ValueDef::Variant(v) = &v.value {
        Ok(&v.name)
    } else {
        Err(invalid())
    }
}
pub fn integer(v: &Decoded) -> Result<u64> {
    v.as_u128()
        .and_then(|n| u64::try_from(n).ok())
        .filter(|n| *n <= crate::shared::MAX_SAFE_INTEGER)
        .ok_or_else(invalid)
}
pub fn bytes(v: &Decoded, max: usize) -> Result<Vec<u8>> {
    fn collect(v: &Decoded, out: &mut Vec<u8>, max: usize, depth: usize) -> Result<()> {
        if depth > 16 {
            return Err(invalid());
        }
        if let Some(n) = v.as_u128() {
            out.push(u8::try_from(n).map_err(|_| invalid())?);
        } else if let ValueDef::Composite(c) = &v.value {
            for v in c.values() {
                collect(v, out, max, depth + 1)?;
            }
        } else {
            return Err(invalid());
        }
        if out.len() > max {
            return Err(invalid());
        }
        Ok(())
    }
    let mut out = Vec::new();
    collect(v, &mut out, max, 0)?;
    Ok(out)
}
pub fn cid(v: &Decoded) -> Result<String> {
    let value = String::from_utf8(bytes(v, 32)?).map_err(|_| invalid())?;
    crate::shared::ids::cid(&value).map_err(|_| invalid())?;
    Ok(value)
}
fn twox128(value: &[u8]) -> Vec<u8> {
    [0, 1]
        .into_iter()
        .flat_map(|seed| {
            let mut h = twox_hash::XxHash64::with_seed(seed);
            h.write(value);
            h.finish().to_le_bytes()
        })
        .collect()
}
pub fn value_key(pallet: &str, name: &str) -> String {
    let mut b = twox128(pallet.as_bytes());
    b.extend(twox128(name.as_bytes()));
    format!("0x{}", crypto::hex(&b))
}
pub fn map_key(pallet: &str, name: &str, encoded_key: &[u8]) -> String {
    use blake2::{
        digest::{Update, VariableOutput},
        Blake2bVar,
    };
    let mut b = crypto::unhex(&value_key(pallet, name)).expect("generated hex");
    let mut h = Blake2bVar::new(16).expect("constant output");
    h.update(encoded_key);
    let mut hash = [0; 16];
    h.finalize_variable(&mut hash).expect("constant output");
    b.extend(hash);
    b.extend(encoded_key);
    format!("0x{}", crypto::hex(&b))
}
pub fn identity_events(value: &Decoded) -> Result<Vec<String>> {
    let ValueDef::Composite(records) = &value.value else {
        return Err(invalid());
    };
    if records.len() > 10_000 {
        return Err(invalid());
    }
    let mut cids = Vec::new();
    for record in records.values() {
        let event = field(record, "event")?;
        if variant(event)? != "CitizenIdentity" {
            continue;
        }
        let ValueDef::Variant(pallet) = &event.value else {
            return Err(invalid());
        };
        let inner = pallet.values.values().next().ok_or_else(invalid)?;
        if matches!(
            variant(inner)?,
            "PopulationDateReady" | "PopulationMaintenanceFaulted"
        ) {
            continue;
        }
        cids.push(cid(field(inner, "cid_number")?)?);
        if cids.len() > 1024 {
            return Err(invalid());
        }
    }
    Ok(cids.into_iter().collect())
}

impl Metadata {
    /// 流式解码只消费一个 metadata 类型；调用方必须核对最终剩余字节为零。
    pub fn prefix(&self, input: &mut &[u8], ty: u32) -> Result<Decoded> {
        scale_value::scale::decode_as_type(input, ty, &self.types).map_err(|_| invalid())
    }
    pub fn map_types(&self, pallet: &str, name: &str) -> Result<(u32, u32, Vec<StorageHasher>)> {
        match self.entries.get(&(pallet.into(), name.into())) {
            Some(StorageEntryType::Map {
                key,
                value,
                hashers,
            }) => Ok((key.id, value.id, hashers.clone())),
            _ => Err(invalid()),
        }
    }
    /// 编码键先由 metadata 反解闭环，再按各键真实 hasher 构造；不假定 enum index。
    pub fn storage_key(
        &self,
        pallet: &str,
        name: &str,
        parts: &[Vec<u8>],
    ) -> Result<(String, u32)> {
        let (key, value, hashers) = self.map_types(pallet, name)?;
        if parts.len() != hashers.len() {
            return Err(invalid());
        }
        self.decode(&parts.concat(), key)?;
        let mut out = crypto::unhex(&value_key(pallet, name))?;
        for (p, h) in parts.iter().zip(hashers) {
            match h {
                StorageHasher::Blake2_128Concat => {
                    let k = crypto::unhex(&map_key(pallet, name, p))?;
                    out.extend(&k[32..]);
                }
                StorageHasher::Twox64Concat => {
                    let mut x = twox_hash::XxHash64::with_seed(0);
                    x.write(p);
                    out.extend(x.finish().to_le_bytes());
                    out.extend(p);
                }
                _ => return Err(invalid()),
            }
        }
        Ok((format!("0x{}", crypto::hex(&out)), value))
    }
}
pub fn one(value: &Decoded) -> Result<&Decoded> {
    match &value.value {
        ValueDef::Variant(v) if v.values.len() == 1 => v.values.values().next().ok_or_else(invalid),
        _ => Err(invalid()),
    }
}
pub fn text(value: &Decoded, max: usize) -> Result<String> {
    String::from_utf8(bytes(value, max)?).map_err(|_| invalid())
}
pub fn u128_value(value: &Decoded) -> Result<u128> {
    value.as_u128().ok_or_else(invalid)
}
