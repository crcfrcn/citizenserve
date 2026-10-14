use super::{ports::Releases, release, routes::DownloadRoute};
use crate::shared::Result;
pub async fn target<G: Releases>(github: &G, route: DownloadRoute) -> Result<String> {
    match route {
        DownloadRoute::App | DownloadRoute::Wallet => {
            let product = if route == DownloadRoute::App {
                "citizenapp"
            } else {
                "citizenwallet"
            };
            release::android(&github.get(product).await?, product)
        }
    }
}
