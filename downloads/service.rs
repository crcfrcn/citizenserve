use super::{
    ports::{Releases, Repository},
    release,
    routes::{DownloadRoute, Platform},
};
use crate::shared::Result;
pub async fn target<R: Repository, G: Releases>(
    repo: &R,
    github: &G,
    route: DownloadRoute,
) -> Result<String> {
    match route {
        DownloadRoute::App | DownloadRoute::Wallet => {
            let product = if route == DownloadRoute::App {
                "citizenapp"
            } else {
                "citizenwallet"
            };
            release::android(&github.get(product, None).await?, product)
        }
        DownloadRoute::Chain(p) => chain(repo, github, p, false).await,
        DownloadRoute::Updater => chain(repo, github, Platform::Macos, true).await,
        _ => Err(release::missing()),
    }
}
async fn chain<R: Repository, G: Releases>(
    repo: &R,
    github: &G,
    p: Platform,
    updater: bool,
) -> Result<String> {
    let value = repo.read(p).await?.value(p)?.ok_or_else(release::missing)?;
    let r = github.get("citizenchain", Some(&value.version_tag)).await?;
    if github.commit("citizenchain", &value.version_tag).await? != value.source_sha {
        return Err(release::missing());
    }
    release::asset(
        &r,
        "citizenchain",
        &value.version_tag,
        if updater {
            "citizenchain-node-latest-macOS.json"
        } else {
            &value.asset_name
        },
        if updater {
            None
        } else {
            Some(&value.asset_sha256)
        },
    )
}
