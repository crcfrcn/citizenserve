//! 检查完整 WebP chunk 与有界 BMFF box，任意字节子串不构成媒体格式证明。
use crate::{
    membership::{self, Level},
    shared::{ids, Error, Result},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PostType {
    Document,
    Article,
    Video,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Image,
    Video,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub media_kind: Kind,
    pub content_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub duration_seconds: Option<u32>,
    pub derivative_kind: String,
    pub derivative_content_type: String,
    pub derivative_byte_size: u64,
    pub derivative_sha256: String,
}
pub fn invalid() -> Error {
    Error::new(400, "invalid_media")
}
pub fn content(
    kind: PostType,
    title: usize,
    text: usize,
    items: &[Item],
    level: Level,
) -> Result<()> {
    let p = membership::plan(level);
    if items.len() > 110 {
        return Err(invalid());
    }
    let images = items.iter().filter(|i| i.media_kind == Kind::Image).count();
    let videos = items.len() - images;
    let ok = match kind {
        PostType::Document => {
            title == 0 && text <= 300 && videos == 0 && images <= 9 && (text > 0 || images > 0)
        }
        PostType::Video => title == 0 && text <= 300 && videos == 1 && images == 0,
        PostType::Article => {
            (10..=50).contains(&title)
                && (1..=30000).contains(&text)
                && items.first().is_some_and(|i| i.media_kind == Kind::Image)
                && images <= p.article_max_images as usize
                && videos <= p.article_max_videos as usize
        }
    };
    if !ok {
        return Err(Error::new(400, "invalid_post_content"));
    }
    for item in items {
        item.validate(level)?;
    }
    Ok(())
}
impl Item {
    pub fn validate(&self, level: Level) -> Result<()> {
        let l = membership::limits::limits(level);
        let p = membership::plan(level);
        if self.byte_size == 0
            || self.derivative_byte_size == 0
            || self.width == 0
            || self.height == 0
            || !ids::hex(&self.sha256, 32, false)
            || !ids::hex(&self.derivative_sha256, 32, false)
            || self.derivative_content_type != "image/webp"
        {
            return Err(invalid());
        }
        let ok = match self.media_kind {
            Kind::Image => {
                self.content_type == "image/webp"
                    && self.byte_size <= l.image_bytes
                    && self.width <= l.image_dimension
                    && self.height <= l.image_dimension
                    && self.duration_seconds.is_none()
                    && self.derivative_kind == "thumbnail"
                    && self.derivative_byte_size <= l.thumbnail_bytes
            }
            Kind::Video => {
                self.content_type == "video/mp4"
                    && self.byte_size <= p.video_max_bytes
                    && self
                        .duration_seconds
                        .is_some_and(|s| s > 0 && s <= p.video_max_seconds)
                    && self.derivative_kind == "cover"
                    && self.derivative_byte_size <= l.cover_bytes
                    && self.width <= 8192
                    && self.height <= 8192
            }
        };
        if ok {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}
fn le32(b: &[u8]) -> Result<u32> {
    Ok(u32::from_le_bytes(b.try_into().map_err(|_| invalid())?))
}
fn be32(b: &[u8]) -> Result<u32> {
    Ok(u32::from_be_bytes(b.try_into().map_err(|_| invalid())?))
}
fn be64(b: &[u8]) -> Result<u64> {
    Ok(u64::from_be_bytes(b.try_into().map_err(|_| invalid())?))
}
pub fn webp(raw: &[u8]) -> Result<(u32, u32)> {
    if raw.len() < 20
        || &raw[..4] != b"RIFF"
        || &raw[8..12] != b"WEBP"
        || le32(&raw[4..8])? as usize + 8 != raw.len()
    {
        return Err(invalid());
    }
    let mut offset = 12;
    let mut bitstream = None;
    let mut canvas = None;
    let mut count = 0;
    while offset < raw.len() {
        count += 1;
        if count > 64 || raw.len() - offset < 8 {
            return Err(invalid());
        }
        let name = &raw[offset..offset + 4];
        let len = le32(&raw[offset + 4..offset + 8])? as usize;
        let start = offset + 8;
        let end = start
            .checked_add(len)
            .filter(|e| *e <= raw.len())
            .ok_or_else(invalid)?;
        let payload = &raw[start..end];
        let dimensions = match name {
            b"VP8X" => {
                if offset != 12
                    || len != 10
                    || payload[0] & 0xc3 != 0
                    || payload[0] & 2 != 0
                    || payload[1..4] != [0, 0, 0]
                {
                    return Err(invalid());
                }
                let w = 1 + u32::from_le_bytes([payload[4], payload[5], payload[6], 0]);
                let h = 1 + u32::from_le_bytes([payload[7], payload[8], payload[9], 0]);
                canvas = Some((w, h));
                None
            }
            b"VP8 " => {
                if len < 10 || payload[0] & 1 != 0 || payload[3..6] != [0x9d, 1, 0x2a] {
                    return Err(invalid());
                }
                let w = u16::from_le_bytes([payload[6], payload[7]]) & 0x3fff;
                let h = u16::from_le_bytes([payload[8], payload[9]]) & 0x3fff;
                Some((w as u32, h as u32))
            }
            b"VP8L" => {
                if len < 5 || payload[0] != 0x2f {
                    return Err(invalid());
                }
                let bits = le32(&payload[1..5])?;
                if bits >> 29 != 0 {
                    return Err(invalid());
                }
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"ANIM" | b"ANMF" => return Err(invalid()),
            b"ALPH" | b"ICCP" | b"EXIF" | b"XMP " => None,
            _ => return Err(invalid()),
        };
        if let Some(d) = dimensions {
            if bitstream.replace(d).is_some() || d.0 == 0 || d.1 == 0 {
                return Err(invalid());
            }
        }
        offset = end + (len & 1);
        if offset > raw.len() || len & 1 != 0 && raw[end] != 0 {
            return Err(invalid());
        }
    }
    let d = bitstream.ok_or_else(invalid)?;
    if canvas.is_some_and(|c| c != d) {
        return Err(invalid());
    }
    Ok(d)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoFacts {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: u32,
}
#[derive(Clone, Copy)]
struct BoxRef<'a> {
    name: &'a [u8],
    data: &'a [u8],
}
fn boxes(raw: &[u8]) -> Result<Vec<BoxRef<'_>>> {
    let mut out = vec![];
    let mut pos = 0;
    while pos < raw.len() {
        if out.len() >= 1024 || raw.len() - pos < 8 {
            return Err(invalid());
        }
        let mut size = be32(&raw[pos..pos + 4])? as u64;
        let mut header = 8;
        if size == 1 {
            if raw.len() - pos < 16 {
                return Err(invalid());
            }
            size = be64(&raw[pos + 8..pos + 16])?;
            header = 16;
        }
        if size < header as u64 || size > raw.len() as u64 - pos as u64 {
            return Err(invalid());
        }
        let end = pos + size as usize;
        out.push(BoxRef {
            name: &raw[pos + 4..pos + 8],
            data: &raw[pos + header..end],
        });
        pos = end;
    }
    Ok(out)
}
fn single<'a>(items: &[BoxRef<'a>], name: &[u8]) -> Result<BoxRef<'a>> {
    let mut found = items.iter().filter(|b| b.name == name);
    let value = *found.next().ok_or_else(invalid)?;
    if found.next().is_some() {
        return Err(invalid());
    }
    Ok(value)
}
fn media_duration(raw: &[u8]) -> Result<u32> {
    let version = *raw.first().ok_or_else(invalid)?;
    let (timescale, duration) = match version {
        0 if raw.len() >= 24 => (be32(&raw[12..16])?, be32(&raw[16..20])? as u64),
        1 if raw.len() >= 36 => (be32(&raw[20..24])?, be64(&raw[24..32])?),
        _ => return Err(invalid()),
    };
    if timescale == 0 || duration == 0 || duration == u64::MAX || duration == u32::MAX as u64 {
        return Err(invalid());
    }
    u32::try_from(duration.div_ceil(timescale as u64)).map_err(|_| invalid())
}
fn hvcc(raw: &[u8]) -> Result<()> {
    if raw.len() < 23 || raw[0] != 1 || raw[21] & 3 != 3 || raw[22] == 0 {
        return Err(invalid());
    }
    let mut pos = 23;
    for _ in 0..raw[22] {
        if pos + 3 > raw.len() {
            return Err(invalid());
        }
        let count = u16::from_be_bytes([raw[pos + 1], raw[pos + 2]]) as usize;
        pos += 3;
        if count == 0 || count > 1024 {
            return Err(invalid());
        }
        for _ in 0..count {
            if pos + 2 > raw.len() {
                return Err(invalid());
            }
            let n = u16::from_be_bytes([raw[pos], raw[pos + 1]]) as usize;
            pos += 2;
            if n < 2 || pos + n > raw.len() {
                return Err(invalid());
            }
            pos += n;
        }
    }
    if pos != raw.len() {
        return Err(invalid());
    }
    Ok(())
}
pub fn hevc(prefix: &[u8], whole_size: u64) -> Result<VideoFacts> {
    if prefix.len() > 4 * 1024 * 1024 || prefix.len() as u64 > whole_size {
        return Err(invalid());
    }
    let mut pos = 0;
    let mut moov = None;
    let mut ftyp = false;
    let mut mdat = false;
    let mut count = 0;
    while pos < prefix.len() {
        count += 1;
        if count > 1024 || prefix.len() - pos < 8 {
            return Err(invalid());
        }
        let name = &prefix[pos + 4..pos + 8];
        let mut size = be32(&prefix[pos..pos + 4])? as u64;
        let mut header = 8;
        if size == 1 {
            if prefix.len() - pos < 16 {
                return Err(invalid());
            }
            size = be64(&prefix[pos + 8..pos + 16])?;
            header = 16;
        }
        if size == 0 {
            size = whole_size - pos as u64;
        }
        if size < header as u64 || size > whole_size - pos as u64 {
            return Err(invalid());
        }
        if name == b"mdat" {
            if moov.is_none() || !ftyp || size <= header as u64 {
                return Err(invalid());
            }
            mdat = true;
            break;
        }
        let end = pos
            .checked_add(size as usize)
            .filter(|e| *e <= prefix.len())
            .ok_or_else(invalid)?;
        let data = &prefix[pos + header..end];
        match name {
            b"ftyp" => {
                if ftyp || pos != 0 || data.len() < 8 || !((data.len() - 8).is_multiple_of(4)) {
                    return Err(invalid());
                }
                ftyp = true;
            }
            b"moov" => {
                if moov.replace(data).is_some() {
                    return Err(invalid());
                }
            }
            b"free" | b"skip" | b"wide" => {}
            _ => return Err(invalid()),
        };
        pos = end;
    }
    if !mdat {
        return Err(invalid());
    }
    let top = boxes(moov.ok_or_else(invalid)?)?;
    let mut video = None;
    for track in top.iter().filter(|b| b.name == b"trak") {
        let t = boxes(track.data)?;
        let mdia = boxes(single(&t, b"mdia")?.data)?;
        let handler = single(&mdia, b"hdlr")?.data;
        if handler.len() < 12 {
            return Err(invalid());
        }
        if &handler[8..12] == b"soun" {
            continue;
        }
        if &handler[8..12] != b"vide" || video.is_some() {
            return Err(invalid());
        }
        let duration_seconds = media_duration(single(&mdia, b"mdhd")?.data)?;
        let minf = boxes(single(&mdia, b"minf")?.data)?;
        let stbl = boxes(single(&minf, b"stbl")?.data)?;
        let stsd = single(&stbl, b"stsd")?.data;
        if stsd.len() < 8 || stsd[..4] != [0, 0, 0, 0] || be32(&stsd[4..8])? != 1 {
            return Err(invalid());
        }
        let entries = boxes(&stsd[8..])?;
        if entries.len() != 1 || !matches!(entries[0].name, b"hvc1" | b"hev1") {
            return Err(invalid());
        }
        let sample = entries[0].data;
        if sample.len() < 78 {
            return Err(invalid());
        }
        let width = u16::from_be_bytes([sample[24], sample[25]]) as u32;
        let height = u16::from_be_bytes([sample[26], sample[27]]) as u32;
        if width == 0 || height == 0 {
            return Err(invalid());
        }
        let codecs = boxes(&sample[78..])?;
        hvcc(single(&codecs, b"hvcC")?.data)?;
        let tkhd = single(&t, b"tkhd")?.data;
        if tkhd.len() < 8 {
            return Err(invalid());
        }
        let n = tkhd.len();
        if be32(&tkhd[n - 8..n - 4])? != width << 16 || be32(&tkhd[n - 4..])? != height << 16 {
            return Err(invalid());
        }
        video = Some(VideoFacts {
            width,
            height,
            duration_seconds,
        });
    }
    video.ok_or_else(invalid)
}
