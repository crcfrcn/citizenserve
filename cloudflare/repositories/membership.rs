use super::{all, batch, fail, first, string};
use citizenserve::{
    chain::finalized::Anchor,
    membership::{
        creator::Overview,
        ports::{Repository, Usage},
        projection::Batch,
    },
    shared::{Error, Result},
    user::profile_service::Authorization,
};
use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Membership {
    pub db: D1Database,
}
const PROJECT: &str = include_str!("../sql/project_subscription.sql");
const RESOURCE_MARKER: &str = "-- resource budget\n";

// 一次查询只交付一行；逐笔公历周期月摊仍取整数，拆位求和防止SQLite溢出/JS失真。
// 最大100001条、单价<=MAX_SAFE_INTEGER使每个分量本身也在JSON精确整数范围内。
const OVERVIEW: &str = r#"
WITH candidates AS (
 SELECT billing_period,last_charged_price_fen
 FROM square_creator_subscriptions
 WHERE creator_cid_number=?1 AND subscription_status IN ('active','cancelled') AND paid_until>?2
 LIMIT 100001
), monthly AS (
 SELECT CASE WHEN typeof(last_charged_price_fen)='integer'
  AND last_charged_price_fen BETWEEN 0 AND 9007199254740991
  AND billing_period IN ('monthly','quarterly','yearly')
 THEN last_charged_price_fen / CASE billing_period WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 ELSE 12 END
 END price FROM candidates
)
SELECT COUNT(*) subscriber_count,COUNT(*)-COUNT(price) invalid_count,
 COALESCE(SUM(price/1000000),0) monthly_high,COALESCE(SUM(price%1000000),0) monthly_low,
 (SELECT COUNT(*) FROM square_creator_tiers WHERE creator_cid_number=?1) tier_count
FROM monthly
"#;

fn resource_charge(metric: &str, amount: u64, cid_limit: u64, global_limit: u64) -> Value {
    json!({"metric":metric,"amount":amount,"cid_limit":cid_limit,"global_limit":global_limit})
}

/// CID与全站额度同批预扣；这里只接受所属宿主生成的当前授权和成本，失败不退款。
async fn reserve_resource_batch(
    db: &D1Database,
    auth: Value,
    permit: Option<&citizenserve::membership::gate::Permit>,
    charges: Vec<Value>,
) -> Result<()> {
    let mut metrics = std::collections::BTreeSet::new();
    if charges.is_empty() || charges.len() > 8 {
        return Err(fail());
    }
    for charge in &charges {
        let metric = charge["metric"].as_str().ok_or_else(fail)?;
        if !metrics.insert(metric) {
            return Err(fail());
        }
        let amount = charge["amount"].as_u64().ok_or_else(fail)?;
        let cid = charge["cid_limit"].as_u64().ok_or_else(fail)?;
        let global = charge["global_limit"].as_u64().ok_or_else(fail)?;
        if amount == 0
            || amount > citizenserve::shared::MAX_SAFE_INTEGER
            || cid == 0
            || global == 0
            || cid > citizenserve::shared::MAX_SAFE_INTEGER
            || global > citizenserve::shared::MAX_SAFE_INTEGER
        {
            return Err(fail());
        }
        if amount > cid || amount > global {
            return Err(Error::new(429, "resource_limit"));
        }
    }
    let now = js_sys::Date::now() as u64;
    let mut command = if let Some(permit) = permit {
        permit.evidence(now)?
    } else {
        json!({})
    };
    command["auth"] = auth;
    command["quota"] = json!({"member":permit.is_some(),"day_millis":citizenserve::membership::limits::QUOTA_DAY_MILLIS,"charges":charges});
    let (_, sql) = include_str!("../sql/meter.sql")
        .split_once(RESOURCE_MARKER)
        .ok_or_else(fail)?;
    batch(db, command, sql, Error::new(429, "resource_limit"))
        .await
        .map_err(|error| {
            if error.code == "upload_rate_exceeded" {
                Error::new(429, "resource_limit")
            } else {
                error
            }
        })?;
    Ok(())
}

pub(crate) async fn reserve_chat_resources(
    db: &D1Database,
    subject: &citizenserve::user::chat_access::Subject,
    authority: &citizenserve::gate::identity::Authority,
    config: &citizenserve::user::registration::protocol::Config,
    credential_deadline: u64,
    permit: Option<&citizenserve::membership::gate::Permit>,
    cost: citizenserve::tatachat::auth::ports::ResourceCost,
) -> Result<()> {
    use citizenserve::{membership::limits as l, tatachat::auth::ports::ResourceCost};
    let now = js_sys::Date::now() as u64;
    subject.require_current(now)?;
    authority.require_current(now)?;
    let i = subject.identity();
    if credential_deadline <= now
        || i.cid_number != authority.identity().cid_number
        || subject.device_id() != authority.device_id()
    {
        return Err(Error::new(401, "invalid_session"));
    }
    let auth = json!({"cid_number":i.cid_number,"account_id":i.account_id,"binding_revision":i.binding_revision,
        "device_id":subject.device_id(),"session_token_hash":subject.session_hash(),
        "registration_scope":config.registration_scope,"service_origin":config.service_origin,
        "chain_scope":config.chain_scope,"institution":i.institution,"now":now,
        "deadline":authority.recheck_deadline().min(credential_deadline),"sync_health_millis":citizenserve::gate::policy::SYNC_HEALTH_MILLIS});
    let member = || {
        permit
            .ok_or(Error::new(403, "attachment_membership_required"))?
            .level(now)
            .map(l::resources)
    };
    let mut charges = Vec::new();
    match cost {
        ResourceCost::Connection => charges.push(resource_charge(
            "chat_connections",
            1,
            l::CHAT_CONNECTIONS_DAY,
            l::GLOBAL_CHAT_CONNECTIONS_DAY,
        )),
        ResourceCost::Command {
            frame_bytes,
            deliveries,
            begin_attachment,
            ..
        } => {
            charges.push(resource_charge(
                "chat_commands",
                1,
                l::CHAT_COMMANDS_DAY,
                l::GLOBAL_CHAT_COMMANDS_DAY,
            ));
            charges.push(resource_charge(
                "chat_frame_bytes",
                frame_bytes,
                l::CHAT_FRAME_BYTES_DAY,
                l::GLOBAL_CHAT_FRAME_BYTES_DAY,
            ));
            if deliveries > 0 {
                charges.push(resource_charge(
                    "chat_deliveries",
                    deliveries,
                    l::CHAT_DELIVERIES_DAY,
                    l::GLOBAL_CHAT_DELIVERIES_DAY,
                ));
            }
            if begin_attachment {
                charges.push(resource_charge(
                    "attachment_begins",
                    1,
                    member()?.attachment_begins_day,
                    l::GLOBAL_ATTACHMENT_BEGINS_DAY,
                ));
            }
        }
        ResourceCost::AttachmentUpload { bytes } => {
            let limits = member()?;
            charges.push(resource_charge(
                "chat_chunk_operations",
                1,
                limits.chunk_operations_day,
                l::GLOBAL_CHUNK_OPERATIONS_DAY,
            ));
            charges.push(resource_charge(
                "upload_bytes",
                bytes,
                limits.upload_bytes_day,
                l::GLOBAL_UPLOAD_BYTES_DAY,
            ));
        }
        ResourceCost::AttachmentDownload { bytes } => {
            let limits = member()?;
            charges.push(resource_charge(
                "chat_chunk_operations",
                1,
                limits.chunk_operations_day,
                l::GLOBAL_CHUNK_OPERATIONS_DAY,
            ));
            charges.push(resource_charge(
                "delivery_bytes",
                bytes,
                limits.delivery_bytes_day,
                l::GLOBAL_DELIVERY_BYTES_DAY,
            ));
        }
        ResourceCost::AttachmentRecovery => charges.push(resource_charge(
            "chat_chunk_operations",
            1,
            member()?.chunk_operations_day,
            l::GLOBAL_CHUNK_OPERATIONS_DAY,
        )),
    }
    reserve_resource_batch(db, auth, permit, charges).await
}
impl Repository for D1Membership {
    fn current(
        &self,
        cid: &str,
    ) -> impl std::future::Future<Output = Result<Option<citizenserve::membership::Record>>> + Send
    {
        SendFuture::new(async move {
            first(
                &self.db,
                "SELECT * FROM square_memberships WHERE cid_number=?1",
                &[string(cid)],
            )
            .await
        })
    }
    fn creator_plans(
        &self,
        auth: &Authorization,
        cid: &str,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            citizenserve::shared::ids::cid(cid)?;
            let owner: Option<Value> = first(
                &self.db,
                "SELECT account_id FROM users WHERE cid_number=?1 AND cid_status='active'",
                &[string(cid)],
            )
            .await?;
            let owner = owner.ok_or(Error::new(404, "creator_not_found"))?;
            let tiers:Vec<Value>=all(&self.db,"SELECT tier_id,tier_name,monthly_price_fen,quarterly_price_fen,yearly_price_fen FROM square_creator_tiers WHERE creator_cid_number=?1 ORDER BY tier_order LIMIT 11",&[string(cid)]).await?;
            if tiers.len() > 10 {
                return Err(Error::new(503, "creator_plans_invalid"));
            }
            let mut subscription:Option<Value>=first(&self.db,"SELECT * FROM square_creator_subscriptions WHERE subscriber_cid_number=?1 AND creator_cid_number=?2",&[string(auth.cid()),string(cid)]).await?;
            let sub = if let Some(ref mut value) = subscription {
                value["cid_number"] = value["subscriber_cid_number"].clone();
                Some(
                    serde_json::from_value::<citizenserve::membership::Record>(value.clone())
                        .map_err(|_| fail())?
                        .wire()?,
                )
            } else {
                None
            };
            let member = self.current(cid).await?;
            Ok(
                json!({"ok":true,"creator_cid_number":cid,"creator_account_id":owner["account_id"],"tiers":tiers,
                "membership_active":member.is_some_and(|m|m.active(auth.now())),"subscription":sub}),
            )
        })
    }
    fn cleanup_notice(
        &self,
        auth: &Authorization,
    ) -> impl std::future::Future<Output = Result<Option<citizenserve::membership::cleanup::Notice>>>
           + Send {
        SendFuture::new(async move {
            first(&self.db,"SELECT storage_cleanup_lapse_at lapse_at,storage_cleanup_notified_at notified_at,storage_cleanup_notified_at+86400000 cleanup_after,100000000000 storage_limit_bytes FROM square_memberships WHERE cid_number=?1 AND storage_cleanup_lapse_at IS NOT NULL AND storage_cleanup_notified_at IS NOT NULL",&[string(auth.cid())]).await
        })
    }

    fn usage(
        &self,
        auth: &Authorization,
        start: u64,
    ) -> impl std::future::Future<Output = Result<Usage>> + Send {
        SendFuture::new(async move {
            first(&self.db,"SELECT COALESCE((SELECT byte_size FROM resource_totals WHERE cid_number=?1 AND resource_key='square_storage'),0) used_bytes,COALESCE(SUM(byte_size),0) reserved_bytes,COALESCE((SELECT image_count FROM resource_usage WHERE cid_number=?1 AND resource_key='square_upload' AND period_start=?2),0) used_images,COALESCE(SUM(CASE WHEN period_start=?2 THEN image_count ELSE 0 END),0) reserved_images,COALESCE((SELECT video_seconds FROM resource_usage WHERE cid_number=?1 AND resource_key='square_upload' AND period_start=?2),0) used_video_seconds,COALESCE(SUM(CASE WHEN period_start=?2 THEN video_seconds ELSE 0 END),0) reserved_video_seconds,COUNT(*) active_uploads FROM resource_reservations WHERE cid_number=?1 AND resource_key='square_upload' AND reservation_state='reserved' AND expires_at>?3",&[string(auth.cid()),JsValue::from_f64(start as f64),JsValue::from_f64(auth.now() as f64)]).await?.ok_or_else(fail)
        })
    }
    fn project(
        &self,
        auth: &Authorization,
        projection: &Batch,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"projection":projection,"legacy_action_kind":projection.evidence.as_ref().map(|e|e.action_kind.rsplit(':').next().unwrap_or(&e.action_kind))}),
                PROJECT,
                Error::new(409, "subscription_confirmation_conflict"),
            )
            .await?;
            Ok(())
        })
    }
    fn overview(
        &self,
        auth: &Authorization,
        current: &citizenserve::membership::Record,
    ) -> impl std::future::Future<Output = Result<Overview>> + Send {
        SendFuture::new(async move {
            current.level(js_sys::Date::now() as u64)?;
            #[derive(Deserialize)]
            struct Summary {
                subscriber_count: u64,
                invalid_count: u64,
                monthly_high: u64,
                monthly_low: u64,
                tier_count: u64,
            }
            let summary: Summary = first(
                &self.db,
                OVERVIEW,
                &[string(auth.cid()), JsValue::from_f64(auth.now() as f64)],
            )
            .await?
            .ok_or_else(fail)?;
            if summary.subscriber_count > 100000 {
                return Err(Error::new(503, "creator_overview_unavailable"));
            }
            if summary.invalid_count != 0 {
                return Err(fail());
            }
            let monthly = u128::from(summary.monthly_high)
                .checked_mul(1_000_000)
                .and_then(|high| high.checked_add(u128::from(summary.monthly_low)))
                .ok_or_else(fail)?;
            Ok(Overview {
                subscriber_count: summary.subscriber_count,
                monthly_income_fen: citizenserve::chain::subscription::safe_price(monthly)?,
                tier_count: summary.tier_count,
            })
        })
    }
    fn cursor(&self) -> impl std::future::Future<Output = Result<Option<Anchor>>> + Send {
        SendFuture::new(async move {
            first(&self.db,"SELECT finalized_block_number number,finalized_block_hash hash,'' parent_hash FROM membership_projection_cursor WHERE cursor_id=1",&[]).await
        })
    }
    fn commit_block(
        &self,
        expected: Option<&Anchor>,
        projection: &Batch,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let command = json!({"auth":{"now":js_sys::Date::now() as u64},"background":true,"expected":expected,"projection":projection});
            let raw = string(&command.to_string());
            let queries = PROJECT
                .split("-- statement")
                .skip(1)
                .map(|s| self.db.prepare(s).bind(std::slice::from_ref(&raw)))
                .collect::<worker::Result<Vec<_>>>()
                .map_err(|_| fail())?;
            let results = self
                .db
                .batch(queries)
                .await
                .map_err(|_| Error::new(409, "membership_projection_conflict"))?;
            if results.iter().any(|r| !r.success()) {
                return Err(fail());
            }
            Ok(())
        })
    }
}

fn metric_command(
    auth: &Authorization,
    permit: &citizenserve::membership::gate::Permit,
    metric: &str,
    amount: u64,
) -> Result<Value> {
    permit.require(auth, permit.operation(), js_sys::Date::now() as u64)?;
    if !permit.operation().meters(metric) {
        return Err(Error::new(403, "membership_scope_mismatch"));
    }
    let mut command = permit.evidence(js_sys::Date::now() as u64)?;
    command["auth"] = json!(auth);
    command["metric"] = json!(metric);
    command["amount"] = json!(amount);
    command["period"] = json!(if metric == "published" {
        command["period_start"].as_u64().ok_or_else(fail)?
    } else {
        auth.now() / citizenserve::membership::limits::QUOTA_DAY_MILLIS
            * citizenserve::membership::limits::QUOTA_DAY_MILLIS
    });
    command["day"] = json!(citizenserve::square::feed::utc_day(auth.now()));
    Ok(command)
}
async fn save_metric(db: &D1Database, command: Value) -> Result<()> {
    let sql = include_str!("../sql/meter.sql")
        .split_once(RESOURCE_MARKER)
        .ok_or_else(fail)?
        .0;
    batch(
        db,
        command,
        sql,
        Error::new(409, "membership_meter_conflict"),
    )
    .await?;
    Ok(())
}
/// 成功读取只更新汇总，不接收随机id或资源明细；重读按真实业务动作计数。
pub(crate) async fn record_read(
    db: &D1Database,
    auth: &Authorization,
    permit: &citizenserve::membership::gate::Permit,
    metric: &str,
    amount: u64,
) -> Result<()> {
    if !matches!(metric, "browse" | "detail" | "profile") {
        return Err(Error::new(403, "membership_scope_mismatch"));
    }
    save_metric(db, metric_command(auth, permit, metric, amount)?).await
}

async fn reserve_media_resources(
    db: &D1Database,
    auth: &Authorization,
    permit: &citizenserve::membership::gate::Permit,
    bytes: Option<u64>,
) -> Result<()> {
    use citizenserve::membership::{limits as l, policy::Operation};
    let now = js_sys::Date::now() as u64;
    permit.require(auth, permit.operation(), now)?;
    if !matches!(permit.operation(), Operation::Media(_)) {
        return Err(Error::new(403, "membership_scope_mismatch"));
    }
    let limits = l::resources(permit.level(now)?);
    let charge = if let Some(bytes) = bytes {
        resource_charge(
            "delivery_bytes",
            bytes,
            limits.delivery_bytes_day,
            l::GLOBAL_DELIVERY_BYTES_DAY,
        )
    } else {
        resource_charge(
            "media_requests",
            1,
            l::MEDIA_REQUESTS_DAY,
            l::GLOBAL_MEDIA_REQUESTS_DAY,
        )
    };
    reserve_resource_batch(db, json!(auth), Some(permit), vec![charge]).await
}

impl D1Membership {
    /// 资料媒体先扣最坏读取量，再查引用/R2；基础名片头像和本人资料不要求会员。
    pub(crate) async fn reserve_profile_read(
        &self,
        auth: &Authorization,
        permit: &citizenserve::membership::gate::Permit,
        target: &str,
        kind: citizenserve::user::profile_assets::Kind,
    ) -> Result<()> {
        use citizenserve::{
            membership::{
                limits as l,
                policy::{Operation, Requirement},
            },
            user::profile_assets::Kind,
        };
        let operation = match permit.operation() {
            Operation::CardAvatar(_) if kind == Kind::Avatar => {
                Operation::CardAvatar(target.into())
            }
            Operation::ProfileAsset { .. } => Operation::ProfileAsset {
                target: target.into(),
                kind: kind.name().into(),
            },
            _ => return Err(Error::new(403, "membership_scope_mismatch")),
        };
        permit.require(auth, &operation, js_sys::Date::now() as u64)?;
        let member = (operation.requirement(auth.cid()) == Requirement::Member).then_some(permit);
        reserve_resource_batch(
            &self.db,
            json!(auth),
            member,
            vec![
                resource_charge(
                    "profile_requests",
                    1,
                    l::PROFILE_REQUESTS_DAY,
                    l::GLOBAL_PROFILE_REQUESTS_DAY,
                ),
                resource_charge(
                    "profile_read_bytes",
                    kind.limit() as u64,
                    l::PROFILE_READ_BYTES_DAY,
                    l::GLOBAL_PROFILE_READ_BYTES_DAY,
                ),
            ],
        )
        .await
    }
    /// HEAD/304也计请求；正文按原Range结果在R2 GET前预扣，每次重试单独计量。
    pub async fn reserve_media(
        &self,
        auth: &Authorization,
        permit: &citizenserve::membership::gate::Permit,
        bytes: Option<u64>,
    ) -> Result<()> {
        reserve_media_resources(&self.db, auth, permit, bytes).await
    }

    pub async fn record_read(
        &self,
        auth: &Authorization,
        permit: &citizenserve::membership::gate::Permit,
        metric: &str,
        amount: u64,
    ) -> Result<()> {
        record_read(&self.db, auth, permit, metric, amount).await
    }
    /// 发布仍是稳定业务事件，跨周期重试不重复计量。
    pub async fn record_publication(
        &self,
        auth: &Authorization,
        permit: &citizenserve::membership::gate::Permit,
        post_id: &str,
    ) -> Result<()> {
        let mut command = metric_command(auth, permit, "published", 1)?;
        command["resource_key"] = json!(post_id);
        command["operation_id"] = json!(format!("publish:{post_id}"));
        save_metric(&self.db, command).await
    }
}

impl D1Membership {
    /// 已完成的同主体、同区块、同用途确认只读D1；冲突不能触发链调用。
    pub async fn confirmed(
        &self,
        auth: &Authorization,
        input: &citizenserve::chain::transaction::Confirm,
        route: citizenserve::membership::routes::MembershipRoute,
        target: Option<&str>,
    ) -> Result<bool> {
        use citizenserve::membership::routes::MembershipRoute;
        citizenserve::shared::ids::account(&input.tx_hash)?;
        citizenserve::shared::ids::account(&input.block_hash)?;
        let row: Option<Value> = first(
            &self.db,
            "SELECT * FROM chain_transaction_confirmations WHERE tx_hash=?1",
            &[string(&input.tx_hash)],
        )
        .await?;
        let Some(row) = row else { return Ok(false) };
        if row["cid_number"].as_str() != Some(auth.cid())
            || row["account_id"].as_str() != Some(auth.account())
            || row["block_hash"].as_str() != Some(&input.block_hash)
        {
            return Err(Error::new(409, "subscription_confirmation_conflict"));
        }
        let scope = if route == MembershipRoute::ConfirmPlans {
            "plans".into()
        } else {
            target
                .map(|c| format!("creator:{c}"))
                .unwrap_or_else(|| "platform".into())
        };
        let prefix = format!("membership:{scope}:");
        let action = row["action_kind"].as_str().ok_or_else(fail)?;
        if action.starts_with(&prefix) {
            return Ok(true);
        }
        if action.starts_with("membership:") || action == "publish_post" {
            return Err(Error::new(409, "subscription_confirmation_conflict"));
        }
        let legacy_action = match route {
            MembershipRoute::ConfirmPlans => {
                matches!(action, "set_creator_plans" | "update_creator_tier_name")
            }
            MembershipRoute::Confirm | MembershipRoute::ConfirmCreator => {
                matches!(action, "subscribe" | "cancel" | "change_subscription_plan")
            }
            _ => false,
        };
        if !legacy_action {
            return Err(Error::new(409, "subscription_confirmation_conflict"));
        }
        // 历史裸动作回执只有原投影仍能证明用途时才复用；无法证明即拒绝，不补查链。
        let sql=match route {
            MembershipRoute::Confirm=>"SELECT 1 n FROM square_memberships WHERE cid_number=?1 AND last_tx_hash=?2",
            MembershipRoute::ConfirmCreator=>"SELECT 1 n FROM square_creator_subscriptions WHERE subscriber_cid_number=?1 AND last_tx_hash=?2 AND creator_cid_number=?3",
            MembershipRoute::ConfirmPlans=>"SELECT 1 n FROM square_memberships WHERE cid_number=?1 AND last_tx_hash=?2 AND creator_plans_block_hash=?3",
            _=>return Err(fail()),
        };
        let mut args = vec![string(auth.cid()), string(&input.tx_hash)];
        if route == MembershipRoute::ConfirmCreator {
            args.push(string(target.ok_or_else(fail)?));
        }
        if route == MembershipRoute::ConfirmPlans {
            args.push(string(&input.block_hash));
        }
        let legacy: Option<Value> = first(&self.db, sql, &args).await?;
        if legacy.is_some() {
            Ok(true)
        } else {
            Err(Error::new(409, "subscription_confirmation_conflict"))
        }
    }
}
