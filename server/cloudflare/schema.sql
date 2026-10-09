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
  account_id TEXT NOT NULL CHECK(
    length(account_id) = 66
    AND substr(account_id, 1, 2) = '0x'
    AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  identity_level TEXT NOT NULL CHECK(identity_level IN ('visitor', 'voting', 'candidate')),
  cid_status TEXT NOT NULL DEFAULT 'active' CHECK(cid_status IN ('active','revoked')),
  institution TEXT NOT NULL DEFAULT 'CTZN' CHECK(institution IN ('CTZN','NATP')),
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
CREATE UNIQUE INDEX IF NOT EXISTS users_active_account ON users(account_id) WHERE cid_status='active';
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
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  issued_at INTEGER NOT NULL CHECK(issued_at > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(cid_number, device_id)
);
CREATE INDEX IF NOT EXISTS idx_mls_devices_cid_account ON mls_devices(cid_number, account_id);

-- 通讯录唯一 MLS 组与设备消息；只保存公开设备集合和不透明协议字节。
CREATE TABLE IF NOT EXISTS contact_mls_groups (
  cid_number TEXT PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE CHECK(length(group_id)=32 AND group_id NOT GLOB '*[^0-9a-f]*'),
  creator_device_id TEXT NOT NULL,
  group_revision INTEGER NOT NULL CHECK(group_revision >= 0),
  member_device_ids TEXT NOT NULL CHECK(json_valid(member_device_ids) AND json_type(member_device_ids)='array' AND json_array_length(member_device_ids)<=32),
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
  target_device_ids TEXT NOT NULL CHECK(json_valid(target_device_ids) AND json_type(target_device_ids)='array' AND json_array_length(target_device_ids)<=32),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
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
  membership_level TEXT NOT NULL CHECK(membership_level IN ('freedom','democracy','spark')),
  creator_plans_block_number INTEGER NOT NULL DEFAULT 0 CHECK(creator_plans_block_number>=0),
  creator_plans_block_hash TEXT,
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
  storage_cleanup_lapse_at INTEGER,
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
  upload_id TEXT PRIMARY KEY NOT NULL,
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
  relay_id TEXT PRIMARY KEY NOT NULL,
  extrinsic_sha256 TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  request_ip_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  relay_status TEXT NOT NULL CHECK(relay_status IN ('submitting','broadcast','failed','unknown')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active_claim INTEGER NOT NULL DEFAULT 1 CHECK(active_claim IN (0,1)),
  CHECK(byte_size BETWEEN 1 AND 65536),
  CHECK(length(extrinsic_sha256)=64 AND extrinsic_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(request_ip_hash)=64 AND request_ip_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(tx_hash)=66 AND substr(tx_hash,1,2)='0x' AND substr(tx_hash,3) NOT GLOB '*[^0-9a-f]*')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_active ON chain_extrinsic_relays(extrinsic_sha256) WHERE active_claim=1;
CREATE INDEX IF NOT EXISTS idx_chain_extrinsic_relays_extrinsic
  ON chain_extrinsic_relays(extrinsic_sha256, relay_status, created_at);
CREATE INDEX IF NOT EXISTS idx_chain_extrinsic_relays_request_ip
  ON chain_extrinsic_relays(request_ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_chain_extrinsic_relays_tx_hash
  ON chain_extrinsic_relays(tx_hash)
  WHERE tx_hash IS NOT NULL;

-- 普通应用通知端点服务广场公开提醒和会员存储清理预告。
CREATE TABLE IF NOT EXISTS push_endpoints (
  cid_number TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
  account_id TEXT NOT NULL CHECK(length(account_id) = 66 AND substr(account_id, 1, 2) = '0x' AND substr(account_id, 3) NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL CHECK(length(device_id) = 64 AND device_id NOT GLOB '*[^0-9a-f]*'),
  push_provider TEXT NOT NULL CHECK(push_provider IN ('apns', 'fcm')),
  push_token TEXT NOT NULL,
  endpoint_revision INTEGER NOT NULL DEFAULT 1 CHECK(endpoint_revision>0 AND endpoint_revision<=9007199254740991),
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
  order_id TEXT PRIMARY KEY NOT NULL,
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
  settled_at INTEGER,
  intent_hash TEXT NOT NULL,
  intent_issued_at INTEGER NOT NULL,
  intent_expires_at INTEGER NOT NULL,
  payer_authorization_hash TEXT NOT NULL,
  wallet_is_contract INTEGER NOT NULL CHECK(wallet_is_contract IN (0,1)),
  evm_block_hash TEXT NOT NULL,
  evm_block_number INTEGER NOT NULL,
  evm_transaction_index INTEGER NOT NULL,
  evm_log_index INTEGER NOT NULL,
  evm_block_time_ms INTEGER NOT NULL,
  evm_actual_amount TEXT NOT NULL,
  gmb_evidence_hash TEXT,
  CHECK(chain_id=8453),
  CHECK(length(order_id)=36 AND substr(order_id,1,4)='top_' AND substr(order_id,5) NOT GLOB '*[^0-9a-f]*'),
  CHECK(intent_expires_at=intent_issued_at+600000 AND evm_block_time_ms>intent_issued_at AND evm_block_time_ms<=intent_expires_at),
  CHECK((settlement_claim_id IS NULL AND settlement_claimed_at IS NULL) OR (settlement_claim_id IS NOT NULL AND settlement_claimed_at IS NOT NULL)),
  CHECK((status='pending' AND settled_at IS NULL AND gmb_tx_hash IS NULL AND gmb_block_hash IS NULL AND gmb_extrinsic_index IS NULL AND gmb_evidence_hash IS NULL AND exception_reason IS NULL)
    OR(status='paid' AND settlement_claim_id IS NOT NULL AND settled_at IS NOT NULL AND gmb_tx_hash IS NOT NULL AND gmb_block_hash IS NOT NULL AND gmb_extrinsic_index IS NOT NULL AND gmb_evidence_hash IS NOT NULL AND exception_reason IS NULL)
    OR(status='exception' AND settlement_claim_id IS NOT NULL AND settled_at IS NOT NULL AND exception_reason IS NOT NULL AND gmb_tx_hash IS NULL AND gmb_block_hash IS NULL AND gmb_extrinsic_index IS NULL AND gmb_evidence_hash IS NULL)),
  CHECK(pay_amount IN ('15000000','1400000000') AND coin_fen IN ('1000000','100000000')),
  CHECK((package_id='pkg_15' AND pay_amount='15000000' AND coin_fen='1000000') OR(package_id='pkg_1400' AND pay_amount='1400000000' AND coin_fen='100000000')),
  CHECK(length(evm_actual_amount) BETWEEN 1 AND 78 AND evm_actual_amount NOT GLOB '*[^0-9]*' AND substr(evm_actual_amount,1,1)!='0'),
  CHECK(length(intent_hash)=64 AND intent_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(payer_authorization_hash)=64 AND payer_authorization_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(evm_tx_hash)=66 AND substr(evm_tx_hash,1,2)='0x' AND substr(evm_tx_hash,3) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(evm_block_hash)=66 AND substr(evm_block_hash,1,2)='0x' AND substr(evm_block_hash,3) NOT GLOB '*[^0-9a-f]*')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_paid_gmb ON topup_orders(gmb_tx_hash) WHERE gmb_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_orders_txhash
  ON topup_orders(chain_id, evm_tx_hash);
CREATE INDEX IF NOT EXISTS idx_topup_orders_status
  ON topup_orders(status, confirmed_at, order_id);
CREATE INDEX IF NOT EXISTS idx_topup_orders_cid_number
  ON topup_orders(cid_number, confirmed_at DESC)
  WHERE cid_number IS NOT NULL;

-- Rust注册登记。JSON事实与索引列的一致性由CHECK强制，CAS同时修改。
CREATE TABLE IF NOT EXISTS registration_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  context_hash TEXT NOT NULL CHECK(length(context_hash)=66),
  state TEXT NOT NULL CHECK(state IN ('prepared','human_verified','activated','expired','cancelled')),
  version INTEGER NOT NULL CHECK(version>=0),
  created_at_millis INTEGER NOT NULL CHECK(created_at_millis>=0 AND created_at_millis<=9007199254740991),
  expires_at_millis INTEGER NOT NULL CHECK(expires_at_millis>created_at_millis AND expires_at_millis<=9007199254740991),
  verification_id TEXT NOT NULL UNIQUE,
  row_json TEXT NOT NULL CHECK(json_valid(row_json)),
  CHECK(json_extract(row_json,'$.enrollment_id') IS enrollment_id),
  CHECK(json_extract(row_json,'$.registration_context_hash') IS context_hash),
  CHECK(json_extract(row_json,'$.state') IS state),
  CHECK(json_extract(row_json,'$.version') IS version),
  CHECK(json_extract(row_json,'$.created_at_millis') IS created_at_millis),
  CHECK(json_extract(row_json,'$.expires_at_millis') IS expires_at_millis),
  CHECK(json_extract(row_json,'$.attempt.verification_id') IS verification_id),
  CHECK(COALESCE(length(json_extract(row_json,'$.recovery_hash')),0)=64),
  CHECK(COALESCE(length(json_extract(row_json,'$.attempt.page_hash')),0)=64),
  CHECK(json_extract(row_json,'$.recovery_token') IS NULL),
  CHECK(json_extract(row_json,'$.page_token') IS NULL),
  CHECK(json_extract(row_json,'$.attempt.turnstile_token') IS NULL)
);
CREATE INDEX IF NOT EXISTS registration_capacity_context ON registration_enrollments(context_hash,state,expires_at_millis);
CREATE INDEX IF NOT EXISTS registration_capacity_global ON registration_enrollments(state,expires_at_millis);

-- 权威链复核事实与短期刷新租约。创世行没有此事实，不能直接得到准入。
CREATE TABLE IF NOT EXISTS user_identity_checks (
  cid_number TEXT PRIMARY KEY REFERENCES users(cid_number),
  account_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision>0),
  checked_at_millis INTEGER NOT NULL,
  verification_deadline_millis INTEGER NOT NULL CHECK(verification_deadline_millis>checked_at_millis AND verification_deadline_millis<=checked_at_millis+60000),
  refresh_lease_until INTEGER NOT NULL DEFAULT 0,
  row_json TEXT NOT NULL CHECK(json_valid(row_json)),
  CHECK(json_extract(row_json,'$.cid_number') IS cid_number),
  CHECK(json_extract(row_json,'$.account_id') IS account_id),
  CHECK(json_extract(row_json,'$.binding_revision') IS binding_revision),
  CHECK(json_extract(row_json,'$.checked_at_millis') IS checked_at_millis),
  CHECK(json_extract(row_json,'$.verification_deadline_millis') IS verification_deadline_millis)
);
CREATE INDEX IF NOT EXISTS user_checks_account ON user_identity_checks(account_id);
CREATE TABLE IF NOT EXISTS cid_admissions (
  cid_number TEXT NOT NULL PRIMARY KEY REFERENCES users(cid_number),
  source TEXT NOT NULL CHECK(source='turnstile'),
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES registration_enrollments(enrollment_id),
  human_verified_at_millis INTEGER NOT NULL CHECK(human_verified_at_millis>0),
  registration_scope TEXT NOT NULL,service_origin TEXT NOT NULL,chain_scope TEXT NOT NULL,
  institution TEXT NOT NULL CHECK(institution IN ('CTZN','NATP'))
);
-- 撤销与投影同事务；只使旧凭证失效，保留CID业务资料及历史真人依据。
CREATE TRIGGER IF NOT EXISTS users_revoke_credentials AFTER UPDATE ON users
WHEN NEW.cid_status='revoked' OR NEW.account_id<>OLD.account_id OR NEW.binding_revision<>OLD.binding_revision
BEGIN
  UPDATE mls_devices SET active=0 WHERE cid_number=NEW.cid_number
    AND (NEW.cid_status='revoked' OR binding_revision<NEW.binding_revision OR account_id<>NEW.account_id);
  DELETE FROM square_sessions WHERE cid_number=NEW.cid_number
    AND (NEW.cid_status='revoked' OR binding_revision<NEW.binding_revision OR account_id<>NEW.account_id);
  DELETE FROM mls_authentication_challenges WHERE cid_number=NEW.cid_number
    AND (NEW.cid_status='revoked' OR binding_revision<NEW.binding_revision OR account_id<>NEW.account_id);
  DELETE FROM push_endpoints WHERE cid_number=NEW.cid_number
    AND (NEW.cid_status='revoked' OR binding_revision<NEW.binding_revision OR account_id<>NEW.account_id);
END;

-- 业务写事务的共同授权快照。每次写入仍在同一 batch 内校验实际执行时间。

-- 注销的唯一持久合同；金融claim、钱包和users链事实不进入删除范围。
CREATE TABLE IF NOT EXISTS account_deletion_assert(value INTEGER NOT NULL CHECK(value=1));
CREATE TABLE IF NOT EXISTS account_deletion_challenges(
 challenge_id TEXT PRIMARY KEY CHECK(length(challenge_id)=64 AND challenge_id NOT GLOB '*[^0-9a-f]*'),
 cid_number TEXT NOT NULL,account_id TEXT NOT NULL,binding_revision INTEGER NOT NULL CHECK(binding_revision>0),
 purpose TEXT NOT NULL CHECK(purpose IN('delete','status')),expires_at_millis INTEGER NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE INDEX IF NOT EXISTS deletion_challenge_cid ON account_deletion_challenges(cid_number,expires_at_millis);
CREATE TABLE IF NOT EXISTS account_deletions(
 deletion_id TEXT PRIMARY KEY CHECK(length(deletion_id)=64 AND deletion_id NOT GLOB '*[^0-9a-f]*'),
 cid_number TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL,binding_revision INTEGER NOT NULL CHECK(binding_revision>0),
 chain_scope TEXT NOT NULL,enrollment_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','complete')),
 phase INTEGER NOT NULL DEFAULT 0 CHECK(phase BETWEEN 0 AND 4),rows_phase INTEGER NOT NULL DEFAULT 0 CHECK(rows_phase>=0),
 keys_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(keys_json) AND json_type(keys_json)='array' AND json_array_length(keys_json)<=8),
 public_after TEXT NOT NULL DEFAULT '',list_cursor TEXT NOT NULL DEFAULT '',
 io_started INTEGER NOT NULL DEFAULT 0 CHECK(io_started IN(0,1)),
 lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS deletion_due ON account_deletions(state,io_started,lease_until,updated_at);

CREATE VIEW IF NOT EXISTS authorized_business_sessions AS
SELECT s.session_token_hash,s.cid_number,s.account_id,s.binding_revision,s.device_id,
 s.created_at,s.expires_at,c.checked_at_millis,c.verification_deadline_millis,
 a.registration_scope,a.service_origin,a.chain_scope,a.institution
FROM square_sessions s
JOIN users u ON u.cid_number=s.cid_number AND u.account_id=s.account_id AND u.binding_revision=s.binding_revision AND u.cid_status='active'
JOIN mls_devices d ON d.cid_number=s.cid_number AND d.device_id=s.device_id AND d.account_id=s.account_id AND d.binding_revision=s.binding_revision AND d.active=1
JOIN cid_admissions a ON a.cid_number=s.cid_number AND a.institution=u.institution AND a.source='turnstile'
JOIN user_identity_checks c ON c.cid_number=s.cid_number AND json_extract(c.row_json,'$.authoritative_current')=1 AND json_extract(c.row_json,'$.chain_scope')=a.chain_scope AND c.account_id=s.account_id AND c.binding_revision=s.binding_revision
WHERE NOT EXISTS(SELECT 1 FROM account_deletions x WHERE x.cid_number=s.cid_number AND x.state='pending');

-- 同一CID资料对象只有一个代际；writing的凭据在完成/明确恢复前禁止下一代覆盖。
CREATE TABLE IF NOT EXISTS profile_asset_uploads (
 upload_id TEXT PRIMARY KEY NOT NULL,
 cid_number TEXT NOT NULL REFERENCES users(cid_number) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('avatar','banner')),
 object_key TEXT NOT NULL CHECK(object_key='profile/'||cid_number||'/'||kind),
 content_type TEXT NOT NULL CHECK(content_type='image/webp'),
 byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=CASE kind WHEN 'avatar' THEN 524288 ELSE 1572864 END),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 generation INTEGER NOT NULL CHECK(generation>0),
 prior_etag TEXT, object_etag TEXT,
 state TEXT NOT NULL CHECK(state IN ('prepared','writing','completed','superseded')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at=created_at+900000),
 started_at INTEGER, completed_at INTEGER,
 UNIQUE(cid_number,kind,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_asset_writing ON profile_asset_uploads(cid_number,kind) WHERE state='writing';
CREATE INDEX IF NOT EXISTS profile_asset_current ON profile_asset_uploads(cid_number,kind,generation DESC);
CREATE INDEX IF NOT EXISTS square_posts_local_copy ON square_posts(cid_number,post_state,created_at DESC,post_id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS square_upload_receipt ON square_uploads(storage_receipt_id);

-- 通知outbox与业务发布同事务提交；Queue不是持久事实源。
CREATE TABLE IF NOT EXISTS notification_jobs (
 job_id TEXT PRIMARY KEY NOT NULL CHECK(length(job_id)=67 AND substr(job_id,1,3)='nj_' AND substr(job_id,4) NOT GLOB '*[^0-9a-f]*'),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('post','storage_cleanup')), source_key TEXT NOT NULL UNIQUE,
 cid_number TEXT NOT NULL, post_id TEXT, tx_hash TEXT, lapse_at INTEGER,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done','cancelled','blocked')),
 cursor_created_at INTEGER, cursor_cid_number TEXT,
 lease_token TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 next_attempt_at INTEGER NOT NULL DEFAULT 0,last_dispatched_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,
 CHECK((cursor_created_at IS NULL)=(cursor_cid_number IS NULL)),
 CHECK((source_kind='post' AND post_id IS NOT NULL AND tx_hash IS NOT NULL AND lapse_at IS NULL) OR (source_kind='storage_cleanup' AND post_id IS NULL AND tx_hash IS NULL AND lapse_at IS NOT NULL)),
 CHECK((state='leased' AND length(lease_token)=32 AND lease_expires_at>0) OR (state<>'leased' AND lease_token IS NULL AND lease_expires_at=0))
);
CREATE INDEX IF NOT EXISTS notification_jobs_due ON notification_jobs(state,next_attempt_at,last_dispatched_at);
CREATE TABLE IF NOT EXISTS notification_deliveries (
 delivery_id TEXT PRIMARY KEY NOT NULL CHECK(length(delivery_id)=67 AND substr(delivery_id,1,3)='nd_' AND substr(delivery_id,4) NOT GLOB '*[^0-9a-f]*'),
 job_id TEXT NOT NULL REFERENCES notification_jobs(job_id) ON DELETE CASCADE,
 cid_number TEXT NOT NULL,account_id TEXT NOT NULL,binding_revision INTEGER NOT NULL CHECK(binding_revision>0),
 device_id TEXT NOT NULL,endpoint_revision INTEGER NOT NULL CHECK(endpoint_revision>0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','accepted','cancelled','blocked')),
 lease_token TEXT,lease_expires_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 next_attempt_at INTEGER NOT NULL DEFAULT 0,last_dispatched_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,
 UNIQUE(job_id,cid_number,device_id,endpoint_revision),
 CHECK((state='leased' AND length(lease_token)=32 AND lease_expires_at>0) OR (state<>'leased' AND lease_token IS NULL AND lease_expires_at=0))
);
CREATE INDEX IF NOT EXISTS notification_deliveries_due ON notification_deliveries(state,next_attempt_at,last_dispatched_at);
CREATE TABLE IF NOT EXISTS maintenance_jobs (
 job_id TEXT PRIMARY KEY NOT NULL CHECK(length(job_id)=67 AND substr(job_id,1,3)='mt_' AND substr(job_id,4) NOT GLOB '*[^0-9a-f]*'),
 artifact_owner TEXT REFERENCES maintenance_jobs(job_id) ON DELETE CASCADE,artifact_seq INTEGER,
 work_kind TEXT NOT NULL CHECK(work_kind IN ('authentication','identity','membership','uploads','storage','audit')),
 scheduled_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done','cancelled','blocked')),
 progress_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json) AND length(progress_json)<=65536),
 lease_token TEXT,lease_expires_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 next_attempt_at INTEGER NOT NULL DEFAULT 0,last_dispatched_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,
 CHECK((state='leased' AND length(lease_token)=32 AND lease_expires_at>0) OR (state<>'leased' AND lease_token IS NULL AND lease_expires_at=0))
);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_one_active_kind ON maintenance_jobs(work_kind) WHERE artifact_owner IS NULL AND state IN ('pending','leased');
CREATE INDEX IF NOT EXISTS maintenance_jobs_due ON maintenance_jobs(state,next_attempt_at,last_dispatched_at);
-- 固定调度槽/心跳及端点全局代际协调记录；不承载用户/金融账户。
CREATE TABLE IF NOT EXISTS scheduler_leases (
 lease_key TEXT PRIMARY KEY NOT NULL,last_slot INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0 AND revision<=9007199254740991),
 lease_token TEXT,lease_expires_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS maintenance_schedule_once ON maintenance_jobs(work_kind,scheduled_at) WHERE artifact_owner IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_artifact_once ON maintenance_jobs(artifact_owner,artifact_seq) WHERE artifact_owner IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_object_lock ON maintenance_jobs(json_extract(progress_json,'$.locator.private_keys[0]')) WHERE artifact_owner IS NULL AND state IN ('pending','leased','blocked') AND json_extract(progress_json,'$.locator.private_keys[0]') IS NOT NULL;

-- 清理期间不能以重新注册、登记设备、签发会话绕过冻结。
CREATE TRIGGER IF NOT EXISTS deletion_admission_guard BEFORE INSERT ON cid_admissions
 WHEN EXISTS(SELECT 1 FROM account_deletions d WHERE d.cid_number=NEW.cid_number AND (d.state='pending' OR NEW.human_verified_at_millis<=d.updated_at))
 BEGIN SELECT RAISE(ABORT,'account_deletion_pending'); END;
CREATE TRIGGER IF NOT EXISTS deletion_admission_renew AFTER INSERT ON cid_admissions
 BEGIN DELETE FROM account_deletions WHERE cid_number=NEW.cid_number AND state='complete' AND updated_at<NEW.human_verified_at_millis; END;
CREATE TRIGGER IF NOT EXISTS deletion_device_insert BEFORE INSERT ON mls_devices
 WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM account_deletions WHERE cid_number=NEW.cid_number AND state='pending')
 BEGIN SELECT RAISE(ABORT,'account_deletion_pending'); END;
CREATE TRIGGER IF NOT EXISTS deletion_device_update BEFORE UPDATE ON mls_devices
 WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM account_deletions WHERE cid_number=NEW.cid_number AND state='pending')
 BEGIN SELECT RAISE(ABORT,'account_deletion_pending'); END;
CREATE TRIGGER IF NOT EXISTS deletion_session_insert BEFORE INSERT ON square_sessions
 WHEN EXISTS(SELECT 1 FROM account_deletions WHERE cid_number=NEW.cid_number AND state='pending')
 BEGIN SELECT RAISE(ABORT,'account_deletion_pending'); END;
CREATE TRIGGER IF NOT EXISTS deletion_mls_challenge BEFORE INSERT ON mls_authentication_challenges
 WHEN EXISTS(SELECT 1 FROM account_deletions WHERE cid_number=NEW.cid_number AND state='pending')
 BEGIN SELECT RAISE(ABORT,'account_deletion_pending'); END;
CREATE TRIGGER IF NOT EXISTS deletion_maintenance_locator BEFORE UPDATE OF progress_json ON maintenance_jobs
 WHEN json_extract(NEW.progress_json,'$.locator.cid_number') IS NOT NULL AND EXISTS(SELECT 1 FROM account_deletions WHERE cid_number=json_extract(NEW.progress_json,'$.locator.cid_number') AND state='pending')
 BEGIN SELECT RAISE(ABORT,'account_deletion_pending'); END;

CREATE TRIGGER IF NOT EXISTS deletion_notification_target BEFORE INSERT ON notification_deliveries WHEN EXISTS(SELECT 1 FROM account_deletions WHERE cid_number=NEW.cid_number AND state='pending') BEGIN SELECT RAISE(ABORT,'account_deletion_pending'); END;
