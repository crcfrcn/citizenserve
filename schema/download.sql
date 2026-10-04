-- 公民链官网下载数据库唯一完整schema。该数据库只保存产品发布流程显式提交的四个平台指针，
-- 不保存 CitizenServe 用户数据、安装包字节、任意外部 URL 或版本历史。

-- 空字段表示该平台尚未发布；revision 永不回退，既用于条件更新，也防止回滚后重放旧请求。
CREATE TABLE IF NOT EXISTS citizenchain_download_publications (
  platform TEXT PRIMARY KEY CHECK(platform IN ('linux-arm', 'linux-amd', 'macos', 'windows')),
  version_tag TEXT,
  source_sha TEXT,
  asset_name TEXT,
  asset_sha256 TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  published_at INTEGER CHECK(published_at IS NULL OR published_at > 0),
  CHECK(
    (version_tag IS NULL AND source_sha IS NULL AND asset_name IS NULL
      AND asset_sha256 IS NULL AND published_at IS NULL)
    OR
    (version_tag IS NOT NULL AND source_sha IS NOT NULL AND asset_name IS NOT NULL
      AND asset_sha256 IS NOT NULL AND published_at IS NOT NULL)
  )
);

INSERT OR IGNORE INTO citizenchain_download_publications(platform) VALUES
  ('linux-arm'), ('linux-amd'), ('macos'), ('windows');
