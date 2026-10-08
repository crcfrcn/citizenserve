-- CitizenServe 唯一最终数据库结构；正式发布重复执行整份文件后必须得到同一结构。
-- CitizenServe Cloudflare D1 唯一创世 schema 基线。
-- 结构变化只收敛到本基线，禁止旧表兼容、双轨字段或影子结构。

-- finalized 用户投影。cid_number 是永久用户主键；account_id 只表示当前链上绑定账户。
-- 注册与绑定区块锚点只允许由 finalized 投影流程写入，普通客户端请求不得修改。
CREATE TABLE IF NOT EXISTS users (
  cid_number TEXT PRIMARY KEY CHECK(
    length(cid_number) BETWEEN 1 AND 32
    AND substr(cid_number, 1, 1) GLOB '[A-Za-z0-9]'
    AND cid_number NOT GLOB '*[^A-Za-z0-9-]*'
  ),
  account_id TEXT NOT NULL UNIQUE CHECK(
    length(account_id) = 66
    AND substr(account_id, 1, 2) = '0x'
    AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  identity_level TEXT NOT NULL CHECK(identity_level IN ('visitor', 'voting', 'candidate')),
  registration_finalized_block_number INTEGER NOT NULL CHECK(registration_finalized_block_number >= 0),
  registration_finalized_block_hash TEXT NOT NULL CHECK(
    length(registration_finalized_block_hash) = 66
    AND substr(registration_finalized_block_hash, 1, 2) = '0x'
    AND substr(registration_finalized_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  binding_finalized_block_number INTEGER NOT NULL CHECK(
    binding_finalized_block_number >= registration_finalized_block_number
  ),
  binding_finalized_block_hash TEXT NOT NULL CHECK(
    length(binding_finalized_block_hash) = 66
    AND substr(binding_finalized_block_hash, 1, 2) = '0x'
    AND substr(binding_finalized_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  identity_finalized_block_number INTEGER NOT NULL CHECK(
    identity_finalized_block_number >= registration_finalized_block_number
  ),
  identity_finalized_block_hash TEXT NOT NULL CHECK(
    length(identity_finalized_block_hash) = 66
    AND substr(identity_finalized_block_hash, 1, 2) = '0x'
    AND substr(identity_finalized_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  registered_at INTEGER NOT NULL CHECK(registered_at >= 0),
  binding_updated_at INTEGER NOT NULL CHECK(binding_updated_at >= registered_at),
  identity_updated_at INTEGER NOT NULL CHECK(identity_updated_at >= registered_at)
);

-- 正式创世身份是本最终基线的一部分；只写缺失CID，不回退后续绑定或身份状态。
-- AccountId与创世锚点均为已核验的公开链数据，不承载任何钱包秘密。
INSERT INTO users (
  cid_number, account_id, binding_revision, identity_level,
  registration_finalized_block_number, registration_finalized_block_hash,
  binding_finalized_block_number, binding_finalized_block_hash,
  identity_finalized_block_number, identity_finalized_block_hash,
  registered_at, binding_updated_at, identity_updated_at
) VALUES (
  'CN220-CTZN2-198805200-2026', '0x0cb1d05c0c9c7f05679b60d6f24c7e5719a3985264e41c5e899d4822dca4b06b', 1, 'visitor',
  0, '0x18847a5dfd263272f2e7727836fe6582f8c4463ff48609df7b96d5e4d9dd24dd', 0, '0x18847a5dfd263272f2e7727836fe6582f8c4463ff48609df7b96d5e4d9dd24dd', 0, '0x18847a5dfd263272f2e7727836fe6582f8c4463ff48609df7b96d5e4d9dd24dd', 0, 0, 0
) ON CONFLICT(cid_number) DO NOTHING;

-- 目标边界：用户结构化公开资料归属 users；R2 只保存头像、背景等媒体对象。
CREATE TABLE IF NOT EXISTS user_profiles (
  cid_number TEXT PRIMARY KEY REFERENCES users(cid_number) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '' CHECK(length(display_name) <= 40),
  bio TEXT NOT NULL DEFAULT '' CHECK(length(bio) <= 160),
  avatar_object_key TEXT CHECK(
    avatar_object_key IS NULL OR avatar_object_key = 'profile/' || cid_number || '/avatar'
  ),
  avatar_content_hash TEXT CHECK(
    avatar_content_hash IS NULL OR (
      length(avatar_content_hash) = 64
      AND avatar_content_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  banner_object_key TEXT CHECK(
    banner_object_key IS NULL OR banner_object_key = 'profile/' || cid_number || '/banner'
  ),
  banner_content_hash TEXT CHECK(
    banner_content_hash IS NULL OR (
      length(banner_content_hash) = 64
      AND banner_content_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK(updated_at >= 0),
  CHECK((avatar_object_key IS NULL) = (avatar_content_hash IS NULL)),
  CHECK((banner_object_key IS NULL) = (banner_content_hash IS NULL))
);

-- 创世公开资料只建立缺失的默认行，重复初始化保留用户已编辑资料。
INSERT INTO user_profiles (cid_number)
SELECT cid_number FROM users WHERE registration_finalized_block_number = 0
ON CONFLICT(cid_number) DO NOTHING;

-- finalized 用户投影只按该单例游标向前扫描；整块处理成功后才允许推进。
CREATE TABLE IF NOT EXISTS user_projection_cursor (
  cursor_id INTEGER PRIMARY KEY CHECK(cursor_id = 1),
  finalized_block_number INTEGER NOT NULL CHECK(finalized_block_number >= 0),
  finalized_block_hash TEXT NOT NULL CHECK(
    length(finalized_block_hash) = 66
    AND substr(finalized_block_hash, 1, 2) = '0x'
    AND substr(finalized_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);

-- finalized 订阅统一投影只使用一个游标；平台会员、创作者订阅和档位整块成功后才推进。
CREATE TABLE IF NOT EXISTS membership_projection_cursor (
  cursor_id INTEGER PRIMARY KEY CHECK(cursor_id = 1),
  finalized_block_number INTEGER NOT NULL CHECK(finalized_block_number >= 0),
  finalized_block_hash TEXT NOT NULL CHECK(
    length(finalized_block_hash) = 66
    AND substr(finalized_block_hash, 1, 2) = '0x'
    AND substr(finalized_block_hash, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);

-- 唯一MLS认证挑战绑定CID、设备、请求及会话；原子删除即消费，计数限制未消费记录。
CREATE TABLE IF NOT EXISTS mls_authentication_challenges (
  challenge TEXT PRIMARY KEY CHECK(length(challenge) = 66 AND substr(challenge, 1, 2) = '0x' AND substr(challenge, 3) NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK(purpose IN ('session', 'request', 'registration')),
  cid_number TEXT NOT NULL,
  device_id TEXT NOT NULL CHECK(length(device_id) = 64 AND device_id NOT GLOB '*[^0-9a-f]*'),
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  service_origin TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')),
  request_target TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 66 AND substr(body_sha256, 1, 2) = '0x' AND substr(body_sha256, 3) NOT GLOB '*[^0-9a-f]*'),
  session_token_hash TEXT CHECK(session_token_hash IS NULL OR (length(session_token_hash) = 64 AND session_token_hash NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  expires_at_millis INTEGER NOT NULL CHECK(expires_at_millis > created_at AND expires_at_millis <= created_at + 300000),
  CHECK((purpose = 'request' AND session_token_hash IS NOT NULL) OR (purpose <> 'request' AND session_token_hash IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_mls_authentication_challenges_cid ON mls_authentication_challenges(cid_number, expires_at_millis);
CREATE INDEX IF NOT EXISTS idx_mls_authentication_challenges_expires ON mls_authentication_challenges(expires_at_millis);

-- 会话强一致索引保存当前MLS设备；明文token仅交给客户端，索引/KV键只保存SHA-256。
CREATE TABLE IF NOT EXISTS square_sessions (
  session_token_hash TEXT PRIMARY KEY CHECK(length(session_token_hash) = 64 AND session_token_hash NOT GLOB '*[^0-9a-f]*'),
  cid_number TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL CHECK(length(device_id) = 64 AND device_id NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_square_sessions_cid_number ON square_sessions(cid_number, expires_at);
CREATE INDEX IF NOT EXISTS idx_square_sessions_cid_account ON square_sessions(cid_number, account_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_square_sessions_expires ON square_sessions(expires_at);

-- 同一CID可登记多个MLS设备，编号就是公钥去前缀；只保存公开身份与钱包授权事实。
CREATE TABLE IF NOT EXISTS mls_devices (
  cid_number TEXT NOT NULL,
  device_id TEXT NOT NULL CHECK(length(device_id) = 64 AND device_id NOT GLOB '*[^0-9a-f]*'),
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  public_key TEXT NOT NULL CHECK(length(public_key) = 66 AND substr(public_key, 1, 2) = '0x' AND substr(public_key, 3) NOT GLOB '*[^0-9a-f]*' AND device_id = substr(public_key, 3)),
  issued_at INTEGER NOT NULL CHECK(issued_at > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(cid_number, device_id)
);
CREATE INDEX IF NOT EXISTS idx_mls_devices_cid_account ON mls_devices(cid_number, account_id);

-- 通讯录唯一 MLS 组与设备消息；只保存公开设备集合和不透明协议字节。
CREATE TABLE IF NOT EXISTS contact_mls_groups (
  cid_number TEXT PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  creator_device_id TEXT NOT NULL,
  group_revision INTEGER NOT NULL CHECK(group_revision >= 0),
  member_device_ids TEXT NOT NULL,
  pending_operation_id TEXT
);
CREATE TABLE IF NOT EXISTS contact_mls_packages (
  cid_number TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key_package TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(cid_number, device_id)
);
CREATE TABLE IF NOT EXISTS contact_mls_operations (
  cid_number TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  group_revision INTEGER NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('create','add','remove','application')),
  target_device_ids TEXT NOT NULL,
  result_json TEXT,
  committed_at INTEGER,
  PRIMARY KEY(cid_number, operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_mls_pending
  ON contact_mls_operations(cid_number) WHERE committed_at IS NULL;
CREATE TABLE IF NOT EXISTS contact_mls_messages (
  cid_number TEXT NOT NULL,
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  message_type TEXT NOT NULL CHECK(message_type IN ('welcome','commit','application')),
  mls_message TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  PRIMARY KEY(cid_number, device_id, operation_id, message_type)
);
CREATE INDEX IF NOT EXISTS idx_contact_mls_delivery
  ON contact_mls_messages(cid_number, device_id, sequence);

-- 只保存必须跨 PoP 精确一致的低频上传与外部 RPC 硬顶；普通请求走原生 RateLimit binding。
CREATE TABLE IF NOT EXISTS rate_windows (
  rate_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_windows_expires
  ON rate_windows(expires_at);

-- 平台订阅 finalized 镜像。身份主键 cid_number 是唯一业务主键;account_id 为当前绑定的
-- 付款/签名钱包账户(链上事实保留);价格、状态和时间只来自链上。
CREATE TABLE IF NOT EXISTS square_memberships (
  cid_number TEXT PRIMARY KEY REFERENCES users(cid_number) ON DELETE CASCADE,
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  membership_level TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_charged_at INTEGER NOT NULL,
  last_charged_price_fen INTEGER NOT NULL,
  paid_until INTEGER NOT NULL,
  subscription_status TEXT NOT NULL CHECK(subscription_status IN ('active', 'cancelled', 'terminated', 'suspended', 'issuerPaused')),
  finalized_block_number INTEGER NOT NULL,
  finalized_block_hash TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  entitlement_lapsed_at INTEGER,
  storage_cleanup_notified_at INTEGER,
  last_tx_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_square_memberships_state
  ON square_memberships(subscription_status, paid_until);

-- 创作者档位 finalized 投影。每档以 creator_cid_number + tier_id 为关系主键；
-- creator_account_id 为当前绑定钱包账户(链上事实保留)；名称和价格都只来自链上。
CREATE TABLE IF NOT EXISTS square_creator_tiers (
  creator_cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
  creator_account_id TEXT NOT NULL CHECK(length(creator_account_id) = 66 AND substr(creator_account_id, 1, 2) = '0x' AND substr(creator_account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  tier_id TEXT NOT NULL,
  tier_name TEXT NOT NULL CHECK(
    length(tier_name) BETWEEN 1 AND 20
    AND length(CAST(tier_name AS BLOB)) <= 80
    AND trim(tier_name) = tier_name
  ),
  tier_order INTEGER NOT NULL,
  monthly_price_fen INTEGER,
  quarterly_price_fen INTEGER,
  yearly_price_fen INTEGER,
  finalized_block_number INTEGER NOT NULL,
  finalized_block_hash TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  last_tx_hash TEXT,
  PRIMARY KEY(creator_cid_number, tier_id)
);

-- 创作者订阅关系以订阅者身份主键 + 创作者身份主键复合主键，允许同一身份订阅多个创作者。
-- subscriber_account_id / creator_account_id 为各自当前绑定钱包账户(链上事实保留)。
CREATE TABLE IF NOT EXISTS square_creator_subscriptions (
  subscriber_cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
  creator_cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
  subscriber_account_id TEXT NOT NULL CHECK(length(subscriber_account_id) = 66 AND substr(subscriber_account_id, 1, 2) = '0x' AND substr(subscriber_account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  creator_account_id TEXT NOT NULL CHECK(length(creator_account_id) = 66 AND substr(creator_account_id, 1, 2) = '0x' AND substr(creator_account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  tier_id TEXT NOT NULL,
  billing_period TEXT NOT NULL CHECK(billing_period IN ('monthly', 'quarterly', 'yearly')),
  started_at INTEGER NOT NULL,
  last_charged_at INTEGER NOT NULL,
  last_charged_price_fen INTEGER NOT NULL,
  paid_until INTEGER NOT NULL,
  subscription_status TEXT NOT NULL CHECK(subscription_status IN ('active', 'cancelled', 'terminated', 'suspended', 'issuerPaused')),
  finalized_block_number INTEGER NOT NULL,
  finalized_block_hash TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  last_tx_hash TEXT,
  PRIMARY KEY(subscriber_cid_number, creator_cid_number)
);
CREATE INDEX IF NOT EXISTS idx_square_creator_subscriptions_creator
  ON square_creator_subscriptions(creator_cid_number, subscription_status, paid_until);
CREATE INDEX IF NOT EXISTS idx_square_creator_subscriptions_state
  ON square_creator_subscriptions(subscription_status, paid_until);

-- Cloudflare 只保留 finalized 交易的最小证明；cid_number 是身份归属主键，
-- account_id 仅记录当次链交易签名账户。
CREATE TABLE IF NOT EXISTS chain_transaction_confirmations (
  tx_hash TEXT PRIMARY KEY,
  cid_number TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  block_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  extrinsic_index INTEGER NOT NULL,
  action_kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  chain_timestamp INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chain_transaction_confirmations_cid_number
  ON chain_transaction_confirmations(cid_number, confirmed_at DESC);

CREATE TABLE IF NOT EXISTS square_uploads (
  upload_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE,
  -- 身份主键:发起上传的 cid_number(占即绑,来自会话)。归属一律按此列。
  cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
  -- 发起上传的钱包账户(当前绑定=后续发布签名者);作链上事实保留,不作身份归属键。
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  post_type TEXT NOT NULL CHECK(post_type IN ('document', 'article', 'video')),
  manifest_hash TEXT NOT NULL,
  manifest_byte_size INTEGER NOT NULL CHECK(manifest_byte_size > 0 AND manifest_byte_size <= 262144),
  content_hash TEXT,
  storage_receipt_id TEXT,
  estimated_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_square_uploads_cid_number
  ON square_uploads(cid_number, status, created_at);
CREATE INDEX IF NOT EXISTS idx_square_uploads_expires
  ON square_uploads(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_square_uploads_completed
  ON square_uploads(status, completed_at, upload_id);

CREATE TABLE IF NOT EXISTS square_media_assets (
  upload_id TEXT NOT NULL REFERENCES square_uploads(upload_id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  -- 身份主键:媒体所属 cid_number(随其 upload 归属)。
  cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
  -- 上传该媒体的钱包账户(当前绑定);作链上事实保留,不作身份归属键。
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  media_index INTEGER NOT NULL,
  media_kind TEXT NOT NULL CHECK(media_kind IN ('image', 'video')),
  object_key TEXT NOT NULL UNIQUE,
  upload_method TEXT NOT NULL CHECK(upload_method = 'r2_put'),
  resource_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  derivative_kind TEXT NOT NULL CHECK(derivative_kind IN ('thumbnail', 'cover')),
  derivative_object_key TEXT NOT NULL UNIQUE,
  derivative_content_type TEXT NOT NULL CHECK(derivative_content_type = 'image/webp'),
  derivative_byte_size INTEGER NOT NULL CHECK(derivative_byte_size > 0),
  derivative_sha256 TEXT NOT NULL CHECK(length(derivative_sha256) = 64 AND derivative_sha256 NOT GLOB '*[^0-9a-f]*'),
  asset_state TEXT NOT NULL CHECK(asset_state IN ('prepared', 'uploading', 'ready', 'error')),
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER,
  PRIMARY KEY(upload_id, media_index)
);
CREATE INDEX IF NOT EXISTS idx_square_media_post
  ON square_media_assets(post_id, media_index);
CREATE INDEX IF NOT EXISTS idx_square_media_cid_number
  ON square_media_assets(cid_number, upload_id, media_index);
CREATE INDEX IF NOT EXISTS idx_square_media_state
  ON square_media_assets(asset_state, updated_at, upload_id, media_index);

CREATE TABLE IF NOT EXISTS square_posts (
  post_id TEXT PRIMARY KEY,
  -- 身份主键:发布者 cid_number(由链上 SquarePostPublished 事件镜像,占即绑)。归属一律按此列。
  cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
  -- 发布该帖的钱包账户(链上签名者=当前绑定);作链上事实保留,不作身份归属键。
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  post_category TEXT NOT NULL CHECK(post_category IN ('normal', 'campaign')),
  post_type TEXT NOT NULL CHECK(post_type IN ('document', 'article', 'video')),
  title TEXT CHECK(title IS NULL OR length(title) BETWEEN 10 AND 50),
  excerpt TEXT NOT NULL CHECK(length(excerpt) <= 300),
  content_hash TEXT NOT NULL,
  storage_receipt_id TEXT NOT NULL,
  chain_block INTEGER NOT NULL,
  chain_block_hash TEXT NOT NULL CHECK(length(chain_block_hash) = 66 AND substr(chain_block_hash, 1, 2) = '0x'),
  tx_hash TEXT NOT NULL CHECK(length(tx_hash) = 66 AND substr(tx_hash, 1, 2) = '0x'),
  created_at INTEGER NOT NULL,
  post_state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_square_posts_feed
  ON square_posts(post_category, post_state, created_at);
CREATE INDEX IF NOT EXISTS idx_square_posts_cid_number
  ON square_posts(cid_number, post_state, created_at);
CREATE INDEX IF NOT EXISTS idx_square_posts_cid_number_type
  ON square_posts(cid_number, post_state, post_type, created_at);
CREATE INDEX IF NOT EXISTS idx_square_posts_state
  ON square_posts(post_state, created_at, post_id);

-- 关注关系纯 off-chain,双端均为身份主键 cid_number(关注者→被关注者)。
CREATE TABLE IF NOT EXISTS square_follows (
  follower_cid_number TEXT NOT NULL,
  followed_cid_number TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  notify_enabled INTEGER NOT NULL DEFAULT 1,  -- 关注即默认开发帖通知；0=对该关注静音（仍在关注流，只是不进红点/推送）
  PRIMARY KEY(follower_cid_number, followed_cid_number)
);
CREATE INDEX IF NOT EXISTS idx_square_follows_followed
  ON square_follows(followed_cid_number, created_at);
CREATE INDEX IF NOT EXISTS idx_square_follows_follower
  ON square_follows(follower_cid_number, created_at, followed_cid_number);
CREATE INDEX IF NOT EXISTS idx_square_follows_notify
  ON square_follows(
    followed_cid_number,
    notify_enabled,
    created_at,
    follower_cid_number
  );

-- 发帖通知「已读游标」：双游标分别驱动广场底部 tab 与关注子 tab 两个红点。
-- 红点数 = 我 notify_enabled=1 的关注在对应游标之后发布的新帖数。
-- 进广场清 last_seen_square_at、进关注子 tab 清 last_seen_following_at；只进广场不进关注→广场清、关注留。
CREATE TABLE IF NOT EXISTS square_notify_reads (
  cid_number TEXT NOT NULL PRIMARY KEY,
  last_seen_square_at INTEGER NOT NULL DEFAULT 0,
  last_seen_following_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS square_browse_days (
  cid_number TEXT NOT NULL,
  browse_day TEXT NOT NULL,
  browse_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(cid_number, browse_day)
);

CREATE TABLE IF NOT EXISTS resource_reservations (
  reservation_id TEXT PRIMARY KEY,
  cid_number TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  image_count INTEGER NOT NULL,
  video_seconds INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reservation_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resource_reservations_cid_number
  ON resource_reservations(cid_number, resource_key, reservation_state, expires_at);
CREATE INDEX IF NOT EXISTS idx_resource_reservations_expires
  ON resource_reservations(reservation_state, expires_at);

CREATE TABLE IF NOT EXISTS resource_usage (
  cid_number TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  image_count INTEGER NOT NULL,
  video_seconds INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(cid_number, resource_key, period_start)
);

CREATE TABLE IF NOT EXISTS resource_totals (
  cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  object_count INTEGER NOT NULL,
  video_seconds INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(cid_number, resource_key)
);

CREATE TABLE IF NOT EXISTS chain_extrinsic_relays (
  relay_id TEXT PRIMARY KEY,
  extrinsic_sha256 TEXT NOT NULL,
  tx_hash TEXT,
  request_ip_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  relay_status TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chain_extrinsic_relays_extrinsic
  ON chain_extrinsic_relays(extrinsic_sha256, relay_status, created_at);
CREATE INDEX IF NOT EXISTS idx_chain_extrinsic_relays_request_ip
  ON chain_extrinsic_relays(request_ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_chain_extrinsic_relays_tx_hash
  ON chain_extrinsic_relays(tx_hash)
  WHERE tx_hash IS NOT NULL;

-- 普通应用通知端点只服务广场公开提醒和会员存储清理预告。
CREATE TABLE IF NOT EXISTS push_endpoints (
  cid_number TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL CHECK(length(device_id) = 64 AND device_id NOT GLOB '*[^0-9a-f]*'),
  push_provider TEXT NOT NULL CHECK(push_provider IN ('apns', 'fcm')),
  push_token TEXT NOT NULL,
  -- APNs Token 与签名环境绑定；FCM 没有该维度，必须为空。
  apns_environment TEXT CHECK(
    (push_provider = 'apns' AND apns_environment IS NOT NULL AND
      apns_environment IN ('sandbox', 'production')) OR
    (push_provider = 'fcm' AND apns_environment IS NULL)
  ),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(cid_number, device_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoints_token
  ON push_endpoints(push_provider, push_token);
CREATE INDEX IF NOT EXISTS idx_push_endpoints_expires
  ON push_endpoints(expires_at);

-- 稳定币到账后的公民币发放台账。一行只代表一笔已确认 EVM 到账；
-- 目标账户已绑定身份时，cid_number 固化付款意图签发时的 finalized 身份归属，供注销按
-- CID 完整删除；未绑定 CID 的冷钱包或他人账户充值不属于任何公民身份，允许为空。
-- CitizenChain 收款账户统一保存规范 AccountId，EVM 地址保持独立地址语义。
CREATE TABLE IF NOT EXISTS topup_orders (
  order_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  token TEXT NOT NULL CHECK(token IN ('USDC', 'USDT')),
  token_contract TEXT NOT NULL,
  evm_tx_hash TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  recv_address TEXT NOT NULL,
  pay_amount TEXT NOT NULL,
  cid_number TEXT,
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  coin_fen TEXT NOT NULL,
  package_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'paid', 'exception')),
  settlement_claim_id TEXT,
  settlement_claimed_at INTEGER,
  gmb_tx_hash TEXT,
  gmb_block_hash TEXT,
  gmb_extrinsic_index INTEGER,
  exception_reason TEXT,
  confirmed_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_orders_txhash
  ON topup_orders(chain_id, evm_tx_hash);
CREATE INDEX IF NOT EXISTS idx_topup_orders_status
  ON topup_orders(status, confirmed_at, order_id);
CREATE INDEX IF NOT EXISTS idx_topup_orders_cid_number
  ON topup_orders(cid_number, confirmed_at DESC)
  WHERE cid_number IS NOT NULL;
