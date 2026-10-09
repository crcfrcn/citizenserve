use super::{external_batch, fail, first, string};
use citizenserve::{
    downloads::{
        ports::Repository,
        publication::{Row, Update},
        routes::Platform,
    },
    shared::{Error, Result},
};
use serde_json::json;
use worker::{send::SendFuture, D1Database};
pub struct D1Downloads {
    pub db: D1Database,
}
impl Repository for D1Downloads {
    fn read(&self, p: Platform) -> impl std::future::Future<Output = Result<Row>> + Send {
        SendFuture::new(async move {
            let row: Row = first(
                &self.db,
                "SELECT * FROM citizenchain_download_publications WHERE platform=?1",
                &[string(p.name())],
            )
            .await?
            .ok_or_else(fail)?;
            row.value(p)?;
            Ok(row)
        })
    }
    fn publish(
        &self,
        p: Platform,
        i: &Update,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<Row>> + Send {
        SendFuture::new(async move {
            if i.expected_revision >= 9_007_199_254_740_991 {
                return Err(Error::new(409, "publication_revision_conflict"));
            }
            if let Some(v) = &i.publication {
                v.validate(p)?
            }
            external_batch(
                &self.db,
                json!({"platform":p.name(),"input":i}),
                include_str!("../sql/publish_download.sql"),
                Error::new(409, "publication_revision_conflict"),
            )
            .await?;
            self.read(p).await
        })
    }
}
