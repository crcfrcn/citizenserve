-- 聊天专用数据库；不复制宿主身份、设备激活或会员真源。
PRAGMA foreign_keys=ON;
CREATE TABLE tatachat_module(version INTEGER PRIMARY KEY CHECK(version=1),product TEXT NOT NULL CHECK(product='citizenserve'),frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN(0,1)),schema_sha256 TEXT NOT NULL DEFAULT '',backup_id TEXT);
INSERT INTO tatachat_module(version,product) VALUES(1,'citizenserve') ON CONFLICT(version) DO NOTHING;
-- 重建快照保存在同一受保护云数据库内，不把密文或推送令牌导出到本机日志。
CREATE TABLE tatachat_backup_sets(backup_id TEXT PRIMARY KEY,schema_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('preparing','verified')),columns TEXT NOT NULL);
CREATE TABLE tatachat_backups(backup_id TEXT NOT NULL,table_name TEXT NOT NULL,row_id INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(backup_id,table_name,row_id),FOREIGN KEY(backup_id) REFERENCES tatachat_backup_sets(backup_id));
CREATE TABLE tatachat_assert(value INTEGER PRIMARY KEY CHECK(value=1));
CREATE TABLE key_packages(user_id TEXT NOT NULL,device_id TEXT NOT NULL,record TEXT NOT NULL,wire_bytes INTEGER NOT NULL CHECK(wire_bytes>0),not_before INTEGER NOT NULL,not_after INTEGER NOT NULL,PRIMARY KEY(user_id,device_id));
CREATE INDEX key_expiry ON key_packages(not_after);
CREATE TABLE message_receipts(message_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,operation TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL);
CREATE TRIGGER receipt_immutable BEFORE UPDATE ON message_receipts WHEN NEW.fingerprint<>OLD.fingerprint BEGIN SELECT RAISE(ABORT,'chat_conflict'); END;
CREATE INDEX receipt_expiry ON message_receipts(expires_at);
CREATE TABLE messages(message_id TEXT NOT NULL,user_id TEXT NOT NULL,device_id TEXT NOT NULL,record TEXT NOT NULL,wire_bytes INTEGER NOT NULL CHECK(wire_bytes>0),accepted_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(message_id,user_id,device_id),FOREIGN KEY(message_id) REFERENCES message_receipts(message_id) ON DELETE CASCADE);
CREATE INDEX mailbox_order ON messages(user_id,device_id,accepted_at,message_id);
CREATE INDEX mailbox_expiry ON messages(expires_at);
-- 密文、回执和唤醒任务由同一个事务建立；ACK删除密文时自动取消任务。
CREATE TABLE push_jobs(message_id TEXT NOT NULL,user_id TEXT NOT NULL,device_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','leased','completed','failed')),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),due_at INTEGER NOT NULL,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,dispatch_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(message_id,user_id,device_id),FOREIGN KEY(message_id,user_id,device_id) REFERENCES messages(message_id,user_id,device_id) ON DELETE CASCADE);
CREATE INDEX push_due ON push_jobs(state,due_at,lease_until);
CREATE TABLE push_generations(user_id TEXT NOT NULL,device_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN('ios','android')),generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),PRIMARY KEY(user_id,device_id,platform));
CREATE TABLE push_endpoints(user_id TEXT NOT NULL,device_id TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN('ios','android')),generation INTEGER NOT NULL,token TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(user_id,device_id,platform),UNIQUE(platform,token));
CREATE TABLE attachments(attachment_id TEXT PRIMARY KEY,generation TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,metadata TEXT NOT NULL,creator_user TEXT NOT NULL,creator_device TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','ready','deleting')),completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)),aborted INTEGER NOT NULL DEFAULT 0 CHECK(aborted IN(0,1)),expires_at INTEGER NOT NULL,cleanup_after INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER attachment_immutable BEFORE UPDATE OF fingerprint ON attachments WHEN NEW.fingerprint<>OLD.fingerprint BEGIN SELECT RAISE(ABORT,'chat_conflict'); END;
CREATE INDEX attachment_expiry ON attachments(state,expires_at);
CREATE INDEX attachment_cleanup ON attachments(state,cleanup_after,expires_at);
CREATE TABLE attachment_recipients(attachment_id TEXT NOT NULL,user_id TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN(0,1)),PRIMARY KEY(attachment_id,user_id),FOREIGN KEY(attachment_id) REFERENCES attachments(attachment_id) ON DELETE CASCADE);
CREATE TABLE attachment_chunks(attachment_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,expected TEXT NOT NULL,written TEXT,PRIMARY KEY(attachment_id,chunk_index),FOREIGN KEY(attachment_id) REFERENCES attachments(attachment_id) ON DELETE CASCADE);
-- 每次尝试使用全新对象键，writing未知结果不能按超时视为完成或删除定位。
CREATE TABLE attachment_uploads(attempt_id TEXT PRIMARY KEY,attachment_id TEXT NOT NULL,generation TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,upload TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('reserved','writing','written','deleted')),object_version TEXT,cleanup_after INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(attachment_id) REFERENCES attachments(attachment_id) ON DELETE CASCADE);
CREATE INDEX attachment_upload_generation ON attachment_uploads(attachment_id,generation,state);
CREATE TABLE attachment_receipts(attachment_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,creator_user TEXT NOT NULL,creator_device TEXT NOT NULL,recipients TEXT NOT NULL,acknowledged TEXT NOT NULL,completed INTEGER NOT NULL,aborted INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX attachment_receipt_expiry ON attachment_receipts(expires_at);
CREATE TABLE maintenance(slot INTEGER PRIMARY KEY,state TEXT NOT NULL CHECK(state IN('pending','leased','completed','failed')),lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0);

-- 宿主清理任务安装冻结后，旧Access及尚未开写的上传均不能继续写入。
CREATE TABLE account_deletion_fences(user_id TEXT PRIMARY KEY,deletion_id TEXT NOT NULL,started_at INTEGER NOT NULL);
CREATE TRIGGER deleting_attachment_insert BEFORE INSERT ON attachments WHEN EXISTS(SELECT 1 FROM account_deletion_fences WHERE user_id=NEW.creator_user) BEGIN SELECT RAISE(ABORT,'chat_conflict'); END;
CREATE TRIGGER deleting_attachment_write BEFORE UPDATE OF state ON attachment_uploads WHEN NEW.state='writing' AND OLD.state<>'writing' AND EXISTS(SELECT 1 FROM attachments a JOIN account_deletion_fences f ON f.user_id=a.creator_user WHERE a.attachment_id=NEW.attachment_id) BEGIN SELECT RAISE(ABORT,'chat_conflict'); END;

CREATE TRIGGER deleting_mailbox_recipient BEFORE INSERT ON messages WHEN EXISTS(SELECT 1 FROM account_deletion_fences WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'chat_conflict'); END;
CREATE TRIGGER deleting_attachment_recipient BEFORE INSERT ON attachment_recipients WHEN EXISTS(SELECT 1 FROM account_deletion_fences WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'chat_conflict'); END;
