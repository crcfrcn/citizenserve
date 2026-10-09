# CitizenServe Rust重建

## 工具与依赖的声明和供给职责（2026-10-08）

本产品完全独立管理全部流程所需的工具、依赖及其它资源需求。需求唯一依据为本仓源码、公开声明、锁文件及本产品拥有的准备配方，包括准确版本、平台、官方来源、摘要或固定提交、闭包、验真方式和失败条件；塔塔控制台按当前产品声明提供资源，不维护另一份产品需求或替产品决定版本、来源与流程步骤。

本产品必须能在没有塔塔控制台时完全独立执行全部已实现流程。独立执行时，本产品自行完成可信引导、资源获取、验真、保存、复用及任务工作视图准备，不依赖控制台源码、私有资料、安装位置或资源库。

通过塔塔控制台执行本产品流程时，本产品向控制台声明所需资源并使用其已准备好的供给。控制台先核对并复用已有的匹配工具与依赖；没有的由控制台按本产品声明下载、准备、验真并保存到控制台工具库或依赖库，再交付本产品复用。本产品负责核验交付与自身需求一致并使用资源，不因控制台缺件或供给失败改为自行下载，也不另建同一资源的永久副本；可写包管理器视图与流程过程数据仍归本产品当前任务工作目录。

两种执行方式使用本产品同一声明、锁和流程实现，仅资源供给职责随执行方式改变。该职责适用于本产品全部平台与已实现流程；控制台本身作为产品同样适用。独立模式下资源缺失由产品处理；控制台模式下资源缺失由控制台处理。显式离线缺件、交付失败、损坏、错误摘要、来源漂移或越界必须据实失败，不自动升级、覆盖可疑原件或切换执行方式。

以上为当前职责规范。Cloudflare CI/Release与本仓门禁第2步源码按下文合同装配，完整Linux运行、控制台既有Cloudflare Build及资源供给接入尚未验收；历史记录中的“可选供给”或“产品负责缺件获取”不作为当前职责依据。

## 当前实施状态

2026-10-07：用户授权先完整登记现有功能与实现逻辑，再删除本地旧实现并用Rust重建。旧TypeScript业务、npm锁、旧测试和构建脚本已删除。根目录业务模块已重建；根库入口为 /Users/rhett/citizenserve/lib.rs，不设置聚合业务src目录。

当前第1至第6步已完成授权/社区/会员/媒体、稳定币付款与GMB结算、下载/发布HMAC、链工具及普通推送/Queue/Cron维护。10项用户授权/恢复入口、35项账户业务入口及28项工具API使用唯一/api前缀；永久公共RPC固定为https://nrcrpc.crcfrcn.com/，隧道重构不改变该对外地址。账户业务要求当前CID/真人准入/设备/会话与新鲜MLS证明。第7步宿主阶段177项Rust、127项真实SQLite、17项本地Worker/密码学测试、fmt/Clippy与完整Worker构建通过；本地workerd已运行fetch/queue/scheduled。生产compatibility_date=2026-10-07仍未在相同日期验收，锁定的本地workerd最高支持2026-08-11。聊天、App及正式CI/发布仍待后续；线上链/D1/R2/Siteverify、推送和支付未验收，health继续account_services_ready:false。第7步7.1宿主阶段已完成；通用聊天核心、35件Cloudflare数据面源码及7件App接线已经正式装配，SDK目录清理已经收口。当前源码的统一编译、聊天运行态、完整SDK原生、正式CI/Release及云端和双平台真机验收仍未完成。

旧功能、每项实际逻辑、两份完整SQL和67个源码SHA-256已记录在 /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md。删除前跟踪文件及未提交差异的Git快照为5a11a98c5c32b6a4f89cec35d760609dd628d3be，引用refs/codex/citizenserve-before-rust/20261007；它只用于核实旧逻辑，不参与新工程编译。

## 根目录职责与完成范围

| 完整路径 | 当前内容 | 当前范围 |
|---|---|---|
| /Users/rhett/citizenserve/user/registration/ | 四字段准备、七字段摘要、登记/恢复/页面能力、期限、状态、验证尝试 | 核心与Cloudflare接口已实现，本机协议/SQL验收；App与线上Turnstile未接入验收。 |
| /Users/rhett/citizenserve/user/auth/mls_authentication.rs | MLS SignContent、Ed25519验签、规范证明、GMB设备授权、Sr25519验签 | 密码学与持久挑战/设备激活/会话handler已实现；本机真实签名与SQL验收。 |
| /Users/rhett/citizenserve/user/identity.rs | 当前绑定与投影更新规则 | 锚定读取、双向绑定、撤销/投影/游标事务及60秒确认期限已实现。 |
| /Users/rhett/citizenserve/user/profiles.rs | 资料长度、CID头像/背景对象键 | 资料API、引用/并发CAS已实现；资料资产准备/代际/条件写/受保护读取由profile_assets服务完成。 |
| /Users/rhett/citizenserve/8964/ | 信息流/关注、上传/额度、完整manifest、媒体、帖子 | 三种feed及浏览计量、原子预留/完成、R2事实核验、同块发布/详情/回灌/故障删除闭环已实现。 |
| /Users/rhett/citizenserve/membership/ | 有效期、独立会员轴、三档完整额度与创作者 | 当前权益、交易确认/投影、档位/订阅/概览、调度及30天/24小时清理提醒已实现。 |
| /Users/rhett/citizenserve/topup/ | 原包ID/金额、claim及结算状态规则 | HMAC意图、ERC-191/1271付款钱包自证、EVM canonical付款/原子订单及完整GMB结算API已实现。 |
| /Users/rhett/citizenserve/notifications/ | 当前设备端点、持久任务、扇出与发送合同 | 未读、端点登记/代际、原子outbox、40端点分页、单端点APNs/FCM与Queue消费已本地验收。 |
| /Users/rhett/citizenserve/downloads/ | 正式安装包固定目标和下载源校验 | 正式GitHub源/Tag提交/资产digest核验、四平台指针及实际/api发布HMAC/CAS已实现。 |
| /Users/rhett/citizenserve/chain/ | canonical finalized、metadata/SCALE、身份/会员/完整交易 | 身份/订阅/完整交易、两引导schema、同块宪法/清单、受控广播和26方法EVM代理已实现。 |
| /Users/rhett/citizenserve/tatachat/ | 按auth/protocol/key/mailbox/attachment/push/realtime分目录维护的通用聊天 | 通用核心已接入根库并通过历史第2步编译；Cloudflare数据面源码已装配，当前Worker统一编译与运行态仍待验收。原chat已删除，公民授权归user/membership/server。 |
| /Users/rhett/citizenserve/server/cloudflare/ | 10项用户授权/恢复、35账户、28工具API、RPC、D1/R2/Queue/Cron/WebCrypto | 完整ESM/WASM、本地fetch/queue/scheduled验收通过；生产兼容日期、线上资源/推送与正式发布未验收。 |

旧数据库模型28张业务表与1张下载表保留在新Cloudflare规范DDL；第1至第4步增加四张授权/资料资产表，第6步增加notification_jobs、notification_deliveries、maintenance_jobs、scheduler_leases，共主库36张、下载1张。聊天模型归tatachat交接，不复制成宿主影子表。本轮没有执行线上DDL、数据导出/导入或部署。

## 本次注册实现

完整生产目标与内部路径如下；没有旧路径兼容别名。在原八个授权入口中proof用于设备/会话；新增普通账户业务全部需要会话和proof，预注册能力不能访问账户业务。

| 方法与完整请求地址 | 内部路径 | 准确输入/权限 |
|---|---|---|
| POST https://www.crcfrcn.com/api/user/registration | /user/registration | protocol_version、chain_scope、account_id、institution四字段；不接受CID/年份。 |
| GET https://www.crcfrcn.com/api/user/registration/page?verification_id=<UUID>&page_token=<PAGE_TOKEN> | /user/registration/page | 仅页面能力。 |
| POST https://www.crcfrcn.com/api/user/registration/verify | /user/registration/verify | protocol_version、enrollment_id、recovery_token、verification_id、turnstile_token。 |
| POST https://www.crcfrcn.com/api/user/registration/status | /user/registration/status | protocol_version、enrollment_id、recovery_token、operation。 |
| POST https://www.crcfrcn.com/api/user/identity | /user/identity | 仅block_hash；canonical finalized事件/storage投影，不签发准入/会话，不跳全局游标。 |
| POST https://www.crcfrcn.com/api/user/challenges | /user/challenges | account_id、public_key、purpose、method、request_target、body_sha256六字段。 |
| POST https://www.crcfrcn.com/api/user/devices | /user/devices | account_id、public_key、issued_at、binding_signature、enrollment_id、recovery_token准确六字段及X-MLS-Proof。 |
| POST https://www.crcfrcn.com/api/user/sessions | /user/sessions | 仅account_id及X-MLS-Proof；有效CID/真人准入/设备。 |

上下文只接受protocol_version、chain_scope、account_id、institution。服务端冻结scope/origin/genesis；验证之前没有CID字段、CID生成或CID年份。页能力与恢复能力各自32字节随机，仅存SHA-256；prepare首次响应交付恢复秘密。verification_id固定对应一次尝试且用作Cloudflare idempotency_key，首次token哈希通过D1 CAS锁定。

准备10分钟、页能力5分钟、已通过登记最多到创建后24小时。单尝试10秒网络超时、最多3次调用，失败不能变成通过；action、hostname、cdata、challenge_ts全部核对。成功记录并发重读返回现有结果；刷新使旧verification_id失效。容量检查与创建为同一INSERT SELECT，CAS以版本和当前状态防竞争，过期即无效而不依赖清理。数据库故障返回固定失败代码，不伪造容量拒绝或验证成功。

正常业务顺序固定：确认注册→Cloudflare→CitizenServe保存通过结果→原钱包签名/上链/finalized完成CID注册→MLS设备授权激活→账户服务。本步服务端已完成授权闭环，App编排仍在第8步接入；验证前不计算CID。

### 第2步身份与授权实现

权威RPC固定来自CHAIN_URL并携带服务端Access认证；每次先核对CHAIN_GENESIS_HASH，再取canonical finalized头。使用锚定metadata V14/V15/V16完整解码SCALE，events用parent runtime、storage用目标post-state，拒绝截断/尾随/未知编码。读取CidRegistry、AccountIdByCid、CidByAccountId、BindingRevisionByCid，核对active及双向绑定；公民/居民类型和修订只取真实链。投影保留实际注册块/时间，投票资格按链Timestamp的UTC+8日期解析。

用户确认返回旧projection字段finalized_block_number/finalized_block_hash/identity_event_count/projected_user_count/revoked_user_count。单块目标确认不前跳全局游标；Cron一次最多10块顺序补齐，投影/凭证撤销/游标在同一batch提交。同块账户释放先于绑定写入，CID排序不会改变结果。历史事实不能冒充当前授权。

当前身份确认期限最长60秒，15秒刷新租约合并竞争，缓存读取不延长期限。激活强制读取当前链；普通调用到期重新核验，RPC未知/失败即拒绝。Cron五分钟不承担60秒撤销时限。

挑战5分钟、每CID每用途最多64条；registration只绑定POST /api/user/devices，session只绑定POST /api/user/sessions。第3步已向13条受保护业务目标签发purpose=request，并绑定同一有效会话摘要；原第2步证明格式不变。证明始终绑定实际方法、含/api的完整路径/查询、原始正文摘要、当前CID/修订/同一公钥。钱包GMB0x1C/Sr25519与MLS RFC9420 SignWithLabel/Ed25519都先验签，再原子消费挑战；消费后的业务失败不恢复nonce。

激活提交原子包含设备、cid_admissions与登记activated。数据库断言失败令整个batch回滚，普通CAS零行不能误报激活成功；提交后复查三个事实。登记只能固定到同一CID/账户/修订/设备；同结果用新挑战幂等返回。enrollment_id/recovery_token显式null只能复用服务器已存在的真实CID准入，再验当前钱包与新设备持钥；仅有链上投影不豁免。旧issued_at/修订、已撤销旧授权和跨环境复用拒绝。本步source仅turnstile，没有旧设备自动导入。

普通会话sqs_加16字节随机数的32位小写hex，只持久化SHA-256；created_at/expires_at统一Unix毫秒，24小时、每CID最多8条且保留本次新令牌。会话、准入、设备与当前绑定均由D1权威核对。换绑/吊销与投影同事务撤销旧设备、会话、挑战及推送端点；CID资料和真人依据保留。通用聊天只收到私有字段Authority经核验后构造的许可，15分钟上限之外另带最长60秒再核验期限；WSS实际执行待第7步与B接线。

配置须提供变量WEB_ORIGIN、REGISTRATION_SCOPE、TURNSTILE_SITEKEY、CHAIN_GENESIS_HASH、CHAIN_URL，秘密HASH_KEY、TURNSTILE_SECRET、CHAIN_ID、CHAIN_SECRET及DB/RATE_AUTH绑定。仓库未保存或猜测CHAIN_URL部署值，也未读取秘密或操作线上绑定；缺配置固定失败。注册族错误保留retryable/next_action，底层D1/RPC异常不公开。

验收：53项Rust测试、31项真实SQLite合同测试，fmt、核心/Cloudflare WASM Clippy（-D warnings）、WASM Release及WebAssembly.compile均通过。产物/Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm为3662156字节，SHA-256为19ded21d58d7f0424716f08f02456d8eb3e8a7c3f5a490a2b9218af31c65ff87。测试使用真实密码学和规范SQL；RPC/metadata使用公开合成夹具，不能据此声称线上链/Worker/App已验收。

## 运行边界与未来自建兼容

当前只落地Cloudflare WASM，平台依赖在 /Users/rhett/citizenserve/server/cloudflare/Cargo.toml。共同库不引用worker/D1/R2/Tokio/PostgreSQL驱动。具体业务端口表达完整原子操作；平台适配不能把先读取后写入当作同等事务。

未来自建接入须使用相同逻辑身份、对象键、时间单位、摘要和授权合同，scope/origin不编码部署商，缓存不作准入事实源。当前没有自建服务器运行crate、迁移crate、导出/导入、切流、迁移CLI或控制台按钮。

## 检查与构建

锁文件 /Users/rhett/citizenserve/Cargo.lock、工具链 /Users/rhett/citizenserve/rust-toolchain.toml 固定当前验收版本。检查入口 /Users/rhett/citizenserve/scripts/check.sh；在产品目录执行sh scripts/check.sh。Python用例直接加载Cloudflare生产SQL，执行真实SQLite容量和多连接竞争，但不冒充线上D1测试。

Cargo生成 /Users/rhett/citizenserve/target/build/cargo-target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm；官方worker-build 0.8.5生成 /Users/rhett/citizenserve/target/build/worker/index.js 与 /Users/rhett/citizenserve/target/build/worker/index_bg.wasm，Wrangler直接使用index.js。兼容shim由工具生成，不作正式main、不手改生成JS。WASM禁用strip以保留wasm-bindgen所需externref表。本地测试依赖锁在 /Users/rhett/citizenserve/test/worker/package-lock.json，使用Node25.2.1、Wrangler4.121.0和Miniflare5.20260804.1-alpha；所有外部请求由闭合测试服务接管，没有真实链/推送调用。配置 /Users/rhett/citizenserve/server/cloudflare/wrangler.toml 已包含Queue/两个Cron，生产兼容日期仍为2026-10-07；当前Worker测试使用同一生产日期2026-10-07；锁定workerd仅支持至2026-08-11的历史问题仍未解决，运行验收未通过。

## 第3步完整技术方案（已按确认方案完成，保留实施前清单）

本步恢复资料、通讯录MLS密文同步、广场信息流/帖子索引、关注关系与通知读取，全部接入第2步的当前CID、真人准入、设备与会话守卫。唯一修改方为线程A。本步不修改公民App、SDK、钱包、CitizenChain或通用聊天产品；本步完成后给出第4步方案再等待确认。

### 实施顺序与业务合同

1. 先登记下面13项受保护路由及查询/正文预算，再开放purpose=request挑战。签发时检查同一有效会话和已激活设备；消费时再次绑定会话摘要、实际HTTP方法、完整/api路径/原始查询和原始正文SHA-256。GET正文必须为空。未知方法、未知参数、重复查询、旧/square别名不签挑战。所有读写必须通过统一守卫，写事务再核对当前CID修订/设备/会话及确认期限，避免验签后换绑的竞争窗口。
2. 资料按CID永久归属。显示名40、简介160的旧UTF-16计数与trim规则保留；省略字段沿用原值。头像/背景对象键只允许本CID固定键，哈希与对象键同时设置/清空。返回旧完整profile结构；本步只处理资料引用，上传与实际媒体交付在第4步。
3. 通讯录保持publish/state/reserve/commit/ack五种操作和create/add/remove/application四种MLS操作。属主CID、当前设备由守卫给出；eligible设备必须active且账户/修订匹配。最多32设备、KeyPackage最多16KiB、单条wire最多48KiB、请求256KiB；每设备待消息/每CID操作最多1024条、总密文32MiB、已提交操作保留7天、state每次最多100条。预留和提交使用版本/容量/当前授权的事务断言，只有一个pending操作；同操作同规范结果幂等，不同结果拒绝；移除失效设备时清理其投递材料。服务端只保存公开KeyPackage与密文，不生成、读取或解密MLS私钥/通讯录明文。
4. 推荐/关注/竞选流只查询D1帖子与一次批量媒体索引，不能逐帖读取R2。分页默认20、统一上限50；关注/竞选分类和响应字段沿用旧逻辑。非有效会员仍按已注册CID、UTC日、实际返回条数累计100条/日；原子扣量失败不返回内容。有效会员不限产品浏览额度，技术限速仍有效。为正确区分会员，本步仅增加当前finalized平台订阅读取：核对真实Subscriptions plan/status/paid_until，未知编码/RPC故障拒绝，不把未知当无会员；会员写投影、确认与创作者业务仍归第4步。
5. 帖子索引恢复按作者CID、分类、类型及游标查询；关注关系保留禁止关注自己、幂等、通知开关、关注/粉丝/互关列表和固定分页合同。资料、帖子、关注和计量不随钱包换绑改属主。通知保留square/following两条独立已读游标，只计算启用通知的关注作者已发布帖子，写入只推进指定游标且不能倒退。
6. 本步的“帖子索引”是D1列表与feed索引。完整发布确认、详情manifest、本人原始manifest回灌和删除释放媒体均依赖同区块会员、上传、R2哈希/额度校验，在第4步一起恢复；不先做绕过这些依赖的写入口。推送端点与Queue任务归第6步，聊天归第7步，App统一注册接线归第8步。
7. 最后更新文档/任务卡/注释，完成真实签名、授权失效、数据库并发/回滚和WASM检查，清理本步临时产物，再提交第4步方案。health仍保持整套业务未恢复状态，不能用局部路由通过声明可替换生产。

### 完整请求地址与内部路径

完整外部地址只接受唯一/api前缀。以下全部要求Authorization: Bearer <sqs_会话令牌>及新鲜X-MLS-Proof；不重新弹Cloudflare。查询字符串按实际发送字节参与证明，表中可选参数示意不表示必填。

| 方法与完整请求地址 | 内部路径 | 用途 |
|---|---|---|
| GET https://www.crcfrcn.com/api/user/profiles/{cid_number} | /user/profiles/{cid_number} | 任一合法CID资料，本人也用真实CID。 |
| PUT https://www.crcfrcn.com/api/user/profile | /user/profile | 修改本人资料，正文16KiB。 |
| POST https://www.crcfrcn.com/api/user/contacts | /user/contacts | 五种MLS密文同步操作，正文256KiB。 |
| GET https://www.crcfrcn.com/api/8964/feed/recommended?limit=<N> | /8964/feed/recommended | 推荐流，limit可省略。 |
| GET https://www.crcfrcn.com/api/8964/feed/following?limit=<N> | /8964/feed/following | 关注流。 |
| GET https://www.crcfrcn.com/api/8964/feed/campaign?limit=<N> | /8964/feed/campaign | 竞选流。 |
| GET https://www.crcfrcn.com/api/8964/posts?cid_number=<CID>&category=<CATEGORY>&post_type=<TYPE>&limit=<N>&cursor=<CURSOR> | /8964/posts | 作者帖子索引；作者CID必填，其余依旧合同可省略。 |
| GET https://www.crcfrcn.com/api/8964/follows?cid_number=<CID>&type=<TYPE>&limit=<N>&cursor=<CURSOR> | /8964/follows | following/followers/mutual_following列表；CID/type必填。 |
| POST https://www.crcfrcn.com/api/8964/follows | /8964/follows | 关注，正文16KiB，目标CID字段沿用旧合同。 |
| DELETE https://www.crcfrcn.com/api/8964/follows/{cid_number} | /8964/follows/{cid_number} | 取消关注，空正文。 |
| PUT https://www.crcfrcn.com/api/8964/follows/{cid_number}/notifications | /8964/follows/{cid_number}/notifications | 通知开关，正文16KiB。 |
| GET https://www.crcfrcn.com/api/notifications/unread | /notifications/unread | 两条未读计数。 |
| POST https://www.crcfrcn.com/api/notifications/read | /notifications/read | {scope:square或following}，正文16KiB。 |

继续使用POST https://www.crcfrcn.com/api/user/challenges（内部/user/challenges）申请purpose=request；其准确六字段与16KiB预算不变，本次挑战另外绑定合法会话摘要。注册族和设备/会话路径继续沿用第2步，不增加兼容别名。

### 拟新增文件（当前均不存在，全部由A修改）

| 完整绝对路径 | 作用 |
|---|---|
| /Users/rhett/citizenserve/user/profile_service.rs | 资料请求/响应、CID属主、更新服务及存储端口。 |
| /Users/rhett/citizenserve/user/contacts.rs | MLS操作类型、资格/收件人/队列规则及原子端口。 |
| /Users/rhett/citizenserve/8964/routes.rs | 广场精确路由、查询校验与预算。 |
| /Users/rhett/citizenserve/8964/feed.rs | 三种feed与实际条数计量编排。 |
| /Users/rhett/citizenserve/8964/posts.rs | D1帖子列表、分类/类型/游标和媒体索引响应。 |
| /Users/rhett/citizenserve/8964/follows.rs | 关注、取消、通知开关及三类列表规则。 |
| /Users/rhett/citizenserve/8964/ports.rs | 广场查询、原子浏览扣量和关系写操作端口。 |
| /Users/rhett/citizenserve/notifications/routes.rs | 通知读/标记精确路由与预算。 |
| /Users/rhett/citizenserve/notifications/inbox.rs | 双游标计数与单调更新服务/端口。 |
| /Users/rhett/citizenserve/chain/subscription.rs | 本步浏览权益所需的当前finalized平台订阅只读核验。 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/profiles.rs | D1资料读写。 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/contacts.rs | D1 MLS组/操作/密文与事务。 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/square.rs | D1帖子/批量媒体索引/关注/浏览量。 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/notifications.rs | D1双游标与未读计数。 |
| /Users/rhett/citizenserve/server/cloudflare/sql/reserve_contact.sql | 授权/组修订/容量断言与唯一预留。 |
| /Users/rhett/citizenserve/server/cloudflare/sql/commit_contact.sql | 结果/收件人/队列上限断言与整组原子提交。 |
| /Users/rhett/citizenserve/server/cloudflare/sql/charge_browse.sql | 按CID/UTC日原子扣实际返回条数。 |
| /Users/rhett/citizenserve/server/cloudflare/sql/mark_notifications_read.sql | 固定scope映射与单调游标更新。 |
| /Users/rhett/citizenserve/test/profiles_contract.rs | 资料属主、长度/哈希配对及换绑保持数据。 |
| /Users/rhett/citizenserve/test/contacts_contract.rs | MLS收件人/幂等/设备资格与密文端口边界。 |
| /Users/rhett/citizenserve/test/square_contract.rs | feed/列表/查询、订阅真源与通知合同。 |
| /Users/rhett/citizenserve/test/community_storage_contract.py | 直接运行规范DDL/SQL的并发容量、回滚及授权竞争。 |
| /Users/rhett/citizenserve/test/contract/contact_mls.json | 公开合成MLS操作/收件人向量，不含真实秘密。 |
| /Users/rhett/citizenserve/test/contract/square_feed.json | 公开合成分类/分页/浏览计量向量。 |

### 拟修改文件（全部由A修改）

| 完整绝对路径 | 作用 |
|---|---|
| /Users/rhett/citizenserve/user/routes.rs | 增加受保护资料/通讯录路由声明，与原八个用户授权入口区分权限。 |
| /Users/rhett/citizenserve/user/mod.rs | 导出资料与通讯录服务。 |
| /Users/rhett/citizenserve/user/profiles.rs | 补齐旧资料长度、固定键与哈希配对校验。 |
| /Users/rhett/citizenserve/user/auth/challenge.rs | 只向本步已登记的受保护业务目标签发request挑战。 |
| /Users/rhett/citizenserve/8964/mod.rs | 导出广场服务与端口。 |
| /Users/rhett/citizenserve/notifications/mod.rs | 导出通知服务与路由。 |
| /Users/rhett/citizenserve/chain/mod.rs | 导出订阅只读核验。 |
| /Users/rhett/citizenserve/server/routes.rs | 合并精确功能路由，保留实际/api证明目标。 |
| /Users/rhett/citizenserve/server/cloudflare/lib.rs | 接入受保护服务、request挑战的会话绑定和各路由预算。 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/mod.rs | 导出四类新增D1适配。 |
| /Users/rhett/citizenserve/server/cloudflare/schema.sql | 核对现有表/索引与事务约束，补齐需要的索引/约束；不执行线上DDL。 |
| /Users/rhett/citizenserve/Cargo.toml | 登记三组新增Rust合同测试；不引入新运行平台。 |
| /Users/rhett/citizenserve/test/route_contract.rs | 精确新路由、禁止别名/越权和查询/预算验收。 |
| /Users/rhett/citizenserve/test/activation_contract.rs | request挑战签发/守卫接入后的会话与设备失效验收。 |
| /Users/rhett/citizenserve/CitizenServe.md | 实际模块状态、接口/权限/预算和第4步方案。 |
| /Users/rhett/citizenserve/README.md | 实施范围与检查入口。 |
| /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md | 本步执行证据、边界、结果和下一步方案。 |

### 复用文件（只读复用，不改写）

| 完整绝对路径 | 复用内容 |
|---|---|
| /Users/rhett/citizenserve/server/guard.rs | 当前准入/设备/会话/实际请求证明及一次性消费。 |
| /Users/rhett/citizenserve/user/identity.rs | CID状态、绑定修订与60秒权威确认期限。 |
| /Users/rhett/citizenserve/user/projection.rs | 当前finalized身份解析与短期复核。 |
| /Users/rhett/citizenserve/user/admission.rs | 同一环境/主体的真实Turnstile准入事实。 |
| /Users/rhett/citizenserve/user/ports.rs | 授权与身份仓库端口。 |
| /Users/rhett/citizenserve/user/auth/mls_authentication.rs | 原MLS SignWithLabel和钱包GMB协议，保持字节不变。 |
| /Users/rhett/citizenserve/user/auth/session.rs | D1权威会话令牌摘要及24小时期限。 |
| /Users/rhett/citizenserve/user/registration/protocol.rs | 当前注册范围与冻结上下文。 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/auth.rs | 挑战持久化/消费及权威设备/会话查询。 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/identity.rs | 当前投影查询/刷新租约。 |
| /Users/rhett/citizenserve/server/cloudflare/sql/issue_mls_challenge.sql | 已支持request用途/会话摘要的挑战写入。 |
| /Users/rhett/citizenserve/server/cloudflare/sql/consume_mls_challenge.sql | 原子核对同一有效会话/设备再消费。 |
| /Users/rhett/citizenserve/server/cloudflare/chain.rs | 固定HTTPS RPC、Access认证、超时与响应上限。 |
| /Users/rhett/citizenserve/chain/ports.rs | 平台无关RPC端口。 |
| /Users/rhett/citizenserve/chain/finalized.rs | genesis、canonical finalized锚定。 |
| /Users/rhett/citizenserve/chain/scale.rs | 锚定metadata与完整SCALE解码。 |
| /Users/rhett/citizenserve/chain/identity.rs | 同区块storage读取与身份。 |
| /Users/rhett/citizenserve/membership/mod.rs | 独立会员有效期与档位规则。 |
| /Users/rhett/citizenserve/8964/objects.rs | CID固定对象键，保留换绑后的数据归属。 |
| /Users/rhett/citizenserve/shared/crypto.rs | SHA-256与规范公开编码。 |
| /Users/rhett/citizenserve/shared/ids.rs | CID/账户/设备格式。 |
| /Users/rhett/citizenserve/shared/error.rs | 固定公开错误结构。 |
| /Users/rhett/citizenserve/scripts/check.sh | 自动发现所有*storage_contract.py及Cargo测试，完整本机检查。 |
| /Users/rhett/citizenserve/Cargo.lock | 沿用已锁依赖；本方案没有新增依赖。 |

历史逻辑只读来自Git引用refs/codex/citizenserve-before-rust/20261007中的已删除文件：/Users/rhett/citizenserve/src/profiles/service.ts、/Users/rhett/citizenserve/src/profiles/repository.ts、/Users/rhett/citizenserve/src/contacts.ts、/Users/rhett/citizenserve/src/feeds/service.ts、/Users/rhett/citizenserve/src/feeds/browse.ts、/Users/rhett/citizenserve/src/feeds/follows.ts、/Users/rhett/citizenserve/src/feeds/notify.ts、/Users/rhett/citizenserve/src/posts/repository.ts、/Users/rhett/citizenserve/src/chain/subscription.ts、/Users/rhett/citizenserve/src/limits/catalog.ts。这些是Git历史路径，不是现存源码，不恢复src目录。

只读链定义证据：/Users/rhett/citizenchain/runtime/misc/square-post/src/lib.rs。本步不修改它；订阅结构与key必须以真实定义/metadata核对，不猜枚举位置。

### 生成文件与验收

生成方为A的检查流程；Rust/Python缓存留在忽略目录。明确交付产物只有/Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm，记录字节数/摘要；本步不生成JS发布装载包、不部署、不操作线上数据。

验收：所有新业务缺会话/真人准入/设备或绑定过期均拒绝；GET查询/正文篡改及跨会话证明拒绝；错误签名不消费挑战；新鲜合法证明只消费一次；16连接竞争不超过100次浏览/32设备/1024队列/32MiB容量；MLS组预留与提交失败整体回滚；同操作同结果幂等、不同结果冲突；一设备只能ack自己的密文；UTC跨日、0条feed、会员到期/未知订阅、分页稳定和双通知游标独立正确。核心/Cloudflare Clippy以-D warnings、真实SQLite合同和WASM Release通过；线上平台与App全链路验收仍按第8步进行。

## 冻结合同的解释

以下协议字段/签名域继续有效；第2步已按本地Rust源代码实现服务端授权闭环，App/平台真实验收仍未完成。旧第1步文档的阶段编号已在矩阵中换成当前Rust重建步骤。

## 公民统一注册协议（2026-10-07，第1步合同）

本节为按用户最新纠正修订的协议合同。原第1步仅更新文档；Rust重建第2步已实现注册前登记与最终设备授权。验证前不生成或提交CID，原有CID注册内部流程保持；当前App尚未接线，生产尚未切换。实施进度唯一记录在[注册任务卡](/Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md)，聊天模块装配由[集成线程任务卡](/Users/rhett/tataconsole/tasks/塔塔聊天服务模块与公民途遇服务端集成.md)负责。

### 授权事实与职责

CitizenServe保存注册前真人结果，核验finalized CID与钱包控制权，管理MLS公开设备授权、账户会话和撤销。TataChatSDK在本机持有MLS私钥，提供受限证明和可选验证界面；公民App编排钱包和链阶段。CitizenServe.tatachat只消费宿主授予的通用聊天身份/权限，负责聊天数据，不能再批准公民注册。普通链上用户投影只证明链上身份，不自动构成真人通过或有效设备授权。

首次设备激活须同时成立：本次登记的有效真人结果、当前finalized CID/账户绑定和修订、钱包对同一MLS公钥的设备授权、新鲜MLS私钥持有证明。通过验证码不生成MLS秘密，不代替钱包控制权，不直接签发业务会话或聊天权限。设备登记事实保留在CitizenServe；聊天KeyPackage是公开投递材料，不能成为另一份权威设备授权表。

### 冻结上下文和字段编码

「确认注册」后先弹出Cloudflare验证。验证登记只使用用户已选的钱包账户、公民/居民类型，以及已有链和服务环境；不执行CID计算，不要求CID字段，也不预先冻结CID年份。验证通过并由CitizenServe保存后，才调用原有注册流程；其中的费用检查、载荷准备、钱包签名、提交和finalized身份闭环均保持原位。最终CID只取既有注册流程完成finalized核验后的结果，CitizenServe再独立核验当前链上绑定。机构码沿用institution，只允许CTZN公民、NATP居民，不引入机构注册。

完整顺序：点击「确认注册」→Cloudflare验证→CitizenServe保存通过结果→执行现有钱包签名、上链和最终性确认，完成原有CID注册→MLS设备授权和激活→开放账户服务。注册前验证记录不预占CID，也不形成另一套CID登记。

| 字段 | 固定合同 |
|---|---|
| `protocol_version` | JSON整数1；其他版本拒绝。 |
| `registration_scope` | 服务器公开变量REGISTRATION_SCOPE，形式`citizenserve:<environment>`，environment为1至32位小写字母/数字/连字符且首位字母或数字；必须显式配置，客户端不能指定。不同环境使用不同值和数据库。 |
| `service_origin` | 实际请求的规范HTTPS源，必须在服务器WEB_ORIGIN白名单中；无凭据、路径、查询或片段。恢复与证明只能用于同一源。 |
| `chain_scope` | 小写`0x`加64位hex，必须等于服务器CHAIN_GENESIS_HASH；不信客户端选择另一条链。 |
| `account_id` | 小写`0x`加64位hex；来自已有账户选择，激活时须核验控制权。 |
| `institution` | `CTZN`或`NATP`；验证前仅记录已有选择，激活时与真实finalized CID类型核对。 |
| `registration_context_hash` | 下述规范字节的SHA-256，小写`0x`加64位hex；服务器计算，客户端复算核对。 |
| `enrollment_id`、`verification_id` | 服务器生成的独立规范小写UUID v4；前者标识登记，后者标识一次页面验证尝试。ID不当作授权秘密。 |
| `recovery_token`、`page_token` | 服务器各自生成32字节随机数，以无填充规范base64url表示，43字符；不复用。数据库只存SHA-256校验值。 |
| `*_at_millis`、会话`created_at/expires_at` | UTC Unix毫秒，JSON安全非负整数，最多`9007199254740991`；API与会话统一毫秒，不按字段名推断成秒。 |
| `binding_revision` | 来自当前finalized投影的正安全整数，不接受客户端覆盖。 |
| `public_key`、`device_id` | 沿用MLS规范公钥`0x`加64位小写hex；device_id为去掉前缀的64位hex。 |

上下文按以下固定顺序构造JSON数组，UTF-8、紧凑编码、无BOM/空白/换行；所有字符串先按上表校验，只含允许的ASCII字符。这里编码的是JSON数组，不能换成对象排序、拼接文本或SCALE。字段顺序本身属于合同：

```text
[1,"CitizenCidRegistration",registration_scope,service_origin,chain_scope,account_id,institution]
registration_context_hash = "0x" + lowercase_hex(SHA256(UTF8(compact_JSON(array))))
```

冻结后改变账户、机构码、链或服务环境必须新建验证登记；不能挪用通过记录。prepare与验证摘要不含任何CID，最终CID只在原注册完成后用于设备激活。

公开编码向量：scope为citizenserve:fixture，origin为https://registration.example.test，chain_scope为0x加32个00字节，account_id为下列公开测试账户，institution为CTZN；没有CID或CID年份。上述七字段规范数组为232字节，SHA-256须为0x3f41f857b7cdc569ac12579659aab7a5f319b716624bc9a4fcdbb33cfacf7d2b；此向量仅核对跨语言编码，不表示有效部署、链或授权。此前含CID的八字段向量已撤销；当前Rust实现已通过此公开向量，不并行接受旧字段或旧编码。

```json
[1,"CitizenCidRegistration","citizenserve:fixture","https://registration.example.test","0x0000000000000000000000000000000000000000000000000000000000000000","0x2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972","CTZN"]
```

### 接口和请求响应

路径表使用去掉唯一`/api`部署前缀后的内部路由；生产请求仍保留实际前缀，MLS证明也签实际路径。所有POST为UTF-8 JSON，拒绝重复键、未知/缺失字段、错误类型、非规范编码；三个预注册POST最大8KiB，身份/挑战/设备/会话POST最大16KiB。MLS证明解码上限16KiB，普通签名正文协议上限1MiB，具体路由预算优先。接口必须HTTPS、通过来源和限流检查；注册前接口免CID/会员会话和MLS证明，恢复操作仍须恢复凭证。

这里「注册前」只表示Cloudflare验证先于原有CID注册执行，不要求用户提供或计算CID。只允许使用下表四个预注册接口：prepare检查已有账户/类型/链公开上下文，页面检查页面能力，verify/status检查本登记恢复能力。验证成功仅保存human_verified；原有钱包授权、CID finalized和MLS设备激活完成后才取得账户服务权限。完整目标请求地址见任务卡第2步方案，不能把内部路径或预注册入口当作广场、聊天、通讯录、订阅的访问授权。

| 接口 | 准确请求字段与行为 |
|---|---|
| `POST /user/registration` | 准确四字段`protocol_version, chain_scope, account_id, institution`。不接受CID或CID年份字段。创建验证登记并返回恢复秘密；只有第一次响应包含它。prepare响应丢失时，客户端尚未验证或签名，可重新准备；旧未验证记录到期清理，不通过公开ID重发恢复秘密。 |
| `GET /user/registration/page` | 查询仅`verification_id, page_token`。校验页面能力、同源/范围、期限及登记仍为prepared；不在URL放recovery_token、钱包材料或MLS秘密。 |
| `POST /user/registration/verify` | `protocol_version, enrollment_id, recovery_token, verification_id, turnstile_token`。prepared时token为1至2048字符字符串；已保存同一成功尝试的合法重试允许token为null，直接返回状态，不再调用Siteverify。 |
| `POST /user/registration/status` | `protocol_version, enrollment_id, recovery_token, operation`。operation闭集`read, refresh_verification, cancel`；read只查询，refresh仅在prepared时换发页面能力，cancel只取消未激活登记，不撤销链交易或有效设备。 |
| `POST /user/devices` | 当前Rust第2步正文为准确六字段`account_id, public_key, issued_at, binding_signature, enrollment_id, recovery_token`并携带既有X-MLS-Proof。首次激活后两字段必须有效；已具有效真实CID准入的设备重试/新增设备可显式null，由服务器判断资格；本步无迁移豁免。删除正文中的turnstile_token，不接受新旧格式并行放行。 |

prepare成功为201，其余成功为200。共同响应准确包含`ok:true, protocol_version:1, enrollment_id, registration_scope, service_origin, registration_context_hash, state, created_at_millis, expires_at_millis, human_verified_at_millis, activation, verification`。human_verified_at_millis未通过时为null；activation未激活时为null，激活时为`cid_number,account_id,binding_revision,device_id,public_key`对象，不返回恢复秘密。prepare另包含recovery_token；普通status/verify响应不得重发它。

verification仅prepare或成功refresh返回，其他响应为null；准确字段为`verification_id,page_url,page_expires_at_millis,action,hostname`。page_url为受信源上的上述页面地址，仅带页面能力；action固定`cid_register`，hostname从受信页面源确定。page_token只为该页面尝试生效，不能查询登记、激活设备或登录。

以下是完整prepare字段示例，占位值必须替换成满足字段表的实际公开上下文：

```json
{"protocol_version":1,"chain_scope":"<GENESIS_HASH>","account_id":"<ACCOUNT_ID>","institution":"CTZN"}
```

status读取与verify提交示例：

```json
{"protocol_version":1,"enrollment_id":"<ENROLLMENT_UUID>","recovery_token":"<RECOVERY_TOKEN>","operation":"read"}
```

```json
{"protocol_version":1,"enrollment_id":"<ENROLLMENT_UUID>","recovery_token":"<RECOVERY_TOKEN>","verification_id":"<VERIFICATION_UUID>","turnstile_token":"<TURNSTILE_TOKEN>"}
```

示例是字段示意，不是测试放行凭据。恢复秘密不得进入日志、页面DOM、响应错误或URL；页面查询值也需日志脱敏，页面设置no-store与no-referrer，保持受限CSP。

### 验证 状态与期限

服务器状态固定`prepared,human_verified,activated,expired,cancelled`。prepared在创建后10分钟内须完成校验；human_verified可续办至创建后24小时，原始created_at不改且不能继续延期。验证页面能力最长5分钟且不超过当前登记期限；客户端凭恢复能力可刷新尚未通过的页面尝试，已通过状态不再弹验证。MLS请求挑战最长5分钟。activated不依赖待登记TTL维持账户资格，后续由有效设备及准入记录控制；设备撤销是另一生命周期。

prepared → human_verified只能由Siteverify成功写入；human_verified → activated只能由最终绑定、钱包授权及MLS证明共同通过。prepared或human_verified可取消/到期；activated不能被status.cancel撤销。过期行即使尚未物理清理，也立即拒绝使用。外部请求失败不把prepared自动改成human_verified或永久失败。

页面设置独立随机32字节nonce，其64位小写hex作为cdata，服务器将它与verification_id、登记上下文、页面能力和范围绑定。Siteverify须同时核对HTTP成功、success、action、hostname、cdata及有效challenge_ts；未来超过允许时钟偏差或早于当前尝试的结果拒绝。服务端允许最多30秒时钟偏差且不得突破登记到期；页面加载/刷新产生新尝试，旧尝试立即不可用于新提交。

同一尝试以服务器生成的verification_id作为Cloudflare idempotency_key；首次提交原子绑定token SHA-256，此后只能重试同一token。原始token仅瞬时参与外部校验，不存数据库或本机恢复记录。10秒外部超时后保持未通过；同一UUID和token最多3次外部调用（首次及两次重试），超过上限或Cloudflare已明确拒绝/过期时要求刷新尝试。每次外部调用前后都核对当前状态、上下文和尝试；已保存成功的合法重试返回状态，并发失败者也须复查已保存结果，不能反向覆盖成功。不能将timeout-or-duplicate解释成已经通过。

限流沿用RATE_AUTH边缘计数，注册族合计10次/60秒/受信IP；每上下文最多8个活跃待登记，全环境最多100000个活跃未完成登记。容量与创建使用D1原子约束，过期计数须正确回收；限流器不等于全局唯一身份。数据库结果为准，KV只能加速不作通过授权的唯一来源。测试须覆盖边界、并发、释放与超期即时拒绝；物理清理失败不让过期记录继续有效。

Cloudflare原始token为300秒单次校验；idempotency_key用于同一次校验重试，不能当作永久通过结果。[官方Siteverify合同](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

### MLS激活 幂等与业务准入

既有钱包0x1C签名域与SCALE顺序不变：CID、binding_revision、account_id、public_key、issued_at。SDK签名域仍为MLS SignWithLabel的固定TataChatAuthentication，X-MLS-Proof十二字段不变；登记ID/恢复能力通过实际请求体SHA-256进入该证明，不新建任意消息签名入口。钱包签名可先完成和受保护保存，随后申请新鲜MLS挑战，冷签耗时不得迫使用户再次验证。

激活时才从已核验的finalized事实取得真实CID，核对CID active、双向账户绑定、当前修订，以及验证记录中的账户/主体类型；验证前不绑定具体CID。真实CID与修订首次写入激活结果后，同一验证登记不得被另一CID或设备复用。当前投影缺失/滞后时返回pending，不当作未注册或自动放行。查验、挑战消费、设备记录与登记结果写入必须阻止并发更新或更高修订覆盖，不能以客户端自报CID或finalized块号作为证明。

成功后原子记录该CID的准入依据、设备授权与激活结果；同一登记绑定同一用户/公钥/修订，重复请求经新鲜MLS证明返回原结果。同一登记换身份或公钥拒绝，旧issued_at不能覆盖更高代次。同一业务提交在挑战消费后失败，重试先查状态并申请新挑战，不恢复已消费挑战。会话只由D1权威事务签发，写入失败整体回滚；KV不是授权来源。

当前准入source仅真实turnstile。普通CID投影没有准入资格，旧设备不自动获准；未来若单独批准旧设备导入，必须区分来源且不能伪造验证时间，本轮不实施。已获准CID增加设备仍须当前钱包授权和新设备持钥证明；服务器依据有效准入事实决定是否复用，客户端不能自报豁免。

创建/续期会话、受保护请求和聊天授权检查当前有效绑定、准入依据及设备状态。撤销设备或CID、换绑及资格变化使旧授权失效，不删除仍属该CID的业务资料或重建MLS秘密。普通会话、钱包签名、恢复凭证和聊天访问权限不能互换用途；真人通过不免除订阅、会员及其他业务权限。

### 与聊天模块线程的交接

Rust重建后A统一维护CitizenServe公民业务、宿主路由、Cloudflare入口/配置、注册授权与本节。关联线程2026-10-08最新目标为CitizenServe.tatachat：B维护通用聊天核心/CF适配/聊天资源、公开宿主ABI及SDK聊天runtime/transport；共享装配补丁交A，不同时编辑。原chat宿主计算已迁回user/membership/server并删除；第7步已获用户确认，7.1宿主阶段完成，通用数据面仍待B交付和7.3装配。

A提供的宿主权限语义为：来自合法当前会话的user_id与device_id、有效设备/准入状态、业务判断后的chat_enabled和max_attachment_bytes、服务器签发时间和到期时间、可检查的权限修订。账户、钱包修订和会员名称留在宿主适配内。只有通过资格的设备能输出有效权限，客户端请求中的ID不能直接成为模块身份。

聊天权限最长15分钟，且不能晚于普通账户会话、已知会员或设备资格到期；B须在服务端执行连接到期，不能只靠SDK timer。撤销/换绑/资格变化传播上限锁定为60秒；超过期限仍无法重新确认状态时拒绝继续处理，禁止错误时沿用旧许可。A的撤销状态与可恢复事件须在提交后可查，B选择可靠事件或受限重新核验实现。具体公开函数/类型由B的模块协议声明，不在本仓复制通用模型；调用合同必须满足上述身份、到期和撤销语义。

注册完成不要求先建立聊天连接或先购买聊天会员。公民App所选账户不是默认账户时，身份适配必须明确解析冻结账户；不得把默认账户的MLS身份或签名误用于本登记。SDK所需公开账户输入由A交B，不通过复制私有运行实现处理。

### 错误响应和测试合同

注册错误固定为`{ok:false,protocol_version:1,error:<code>,retryable:<boolean>,next_action:<enum>}`，不携带第三方原始响应或秘密。next_action闭集`none,prepare,read_status,refresh_verification,retry,resolve_identity,prove_device`。下面代码及HTTP状态属于注册合同，现有钱包/MLS验签错误保持其原有稳定代码。

注册族在入口守卫失败时也使用上述错误结构；现有通用入口的HTTP与代码保持：400的https_required、invalid_json、invalid_utf8、content_length_invalid、content_length_mismatch；403的origin_forbidden；404的route_not_found；411的content_length_required；413的request_too_large。这些错误均为retryable:false、next_action:none。缺少必需注册配置映射为registration_not_configured，注册限流映射为registration_rate_limited；不得向客户端展开底层异常。其余业务接口保留原有错误响应格式。

| HTTP | error | retryable / next_action |
|---|---|---|
| 400 | unsupported_registration_version / invalid_registration_context / invalid_registration_request | false / none |
| 401 | invalid_registration_recovery / invalid_verification_capability | false / none |
| 403 | registration_scope_mismatch / registration_context_mismatch | false / prepare |
| 403 | turnstile_failed | true / refresh_verification |
| 409 | verification_in_progress | true / read_status |
| 409 | identity_finalization_pending | true / resolve_identity |
| 409 | registration_activation_conflict / registration_already_activated | false / read_status |
| 410 | registration_expired / registration_cancelled | false / prepare |
| 429 | registration_rate_limited / registration_capacity_exceeded | true / retry，返回Retry-After |
| 503 | registration_not_configured | false / none |
| 503 | registration_unavailable / turnstile_unavailable | true / read_status |

以下矩阵保留R01至R14标识并映射当前Rust重建步骤。R01至R06服务端已由第1步本机验收，R09/R10和R11/R14的宿主授权边界已由第2步本机验收；R07/R08/R12的App编排、R11完整业务和R14聊天执行仍待后续。

| 编号与当前重建步骤 | 输入或事件 | 必须验证的结果和副作用 |
|---|---|---|
| R01，1 | 验证前不计算/提供CID，合法四字段prepare；重复键、额外字段或错版本 | 合法创建prepared；传入CID/年份等额外字段拒绝；不写非法登记、不调用外部、不查会员。 |
| R02，1 | 错genesis/账户/机构码/环境；换冻结上下文 | 拒绝，不能挪用原登记或验证结果；校验不依赖CID。 |
| R03，1 | 错/缺hostname、action、cdata、时间或success | 不产生human_verified，不输出许可。 |
| R04，1 | token超期、重复或伪造；网络超时后同UUID重试 | 不把重复/超时当成功；重试键和token摘要一致，有限外部调用。 |
| R05，1 | 成功响应丢失、并发verify、刷新旧尝试 | 已保存结果可恢复；CAS只通过一次，旧尝试不能覆盖新结果。 |
| R06，1 | 10分钟prepared、24小时已验证、页面5分钟、容量/限流边界 | 即时拒绝超期；计数创建/回收并发正确；不泄漏恢复秘密。 |
| R07，8 | 用户取消、验证失败、页面错误、并发确认 | 原CID注册入口/钱包签名/链提交调用均为0；没有验证前CID计算；单一在途流程、状态正确。 |
| R08，8 | 重启、账户切换、跨UTC年或选择非默认账户 | 复用合法账户验证记录；未开始的原注册按原规则执行，已开始的交易按原检查点恢复；不盲目重发或使用默认账户秘密。 |
| R09，2 | 缺真人记录、未finalized、钱包签名错或MLS证明错 | 不激活设备、不签会话；原有真实链事实保留。 |
| R10，2 | 同登记同设备重复/并发；换公钥、修订或旧issued_at | 合法幂等，不重复登记；冲突拒绝，不覆盖新绑定。 |
| R11，2/3/4/7/8 | 仅链上投影、未激活、已撤销或旧绑定 | 广场/通讯录/订阅会话和聊天权限拒绝，业务资格仍分别检查。 |
| R12，8 | 冷签超过5分钟、finalized后断网或激活响应丢失 | 复用真人记录和MLS身份；仅续办缺阶段，未知交易先查询，重发次数0。 |
| R13，2；未来导入另批 | 可信旧设备和仅有CID；增加新设备；MLS材料丢失 | 按准入来源迁移/补验；新设备控制权必验，不伪造历史验证、不恢复旧秘密。 |
| R14，A2/7/8，B聊天执行 | 资格到期、撤销、换绑、状态服务失败 | A不输出失效许可；B到期执行、60秒内撤销传播，失败不保留旧授权。 |

## Rust重建第3步执行记录（2026-10-07）

用户确认严格按第3步完整方案执行；本窗口A已完成本步。实际新增24文件、修改17文件，均在上方完整绝对路径清单范围内；只读复用文件没有改写，不增加依赖，不修改公民App/SDK/钱包/链、聊天产品、B任务卡或其他消费方。上方为实施前确认清单，本节为实际验收记录。

1. 已登记13项账户业务路由，保持原8项注册/授权入口与health。统一守卫要求真人CID准入、当前active双向绑定、已激活MLS设备、有效sqs_会话及一次性请求证明。request挑战签发核对同一会话/设备并持久绑定令牌SHA-256；实际/api方法/原始查询/原始正文全部验签，GET/DELETE只签空正文，入口逐块拒绝非空字节而不聚合异常正文。未知路由/方法/参数、重复查询及旧别名均拒绝。
2. 资料按永久CID归属，保存旧UTF-16长度、ECMAScript trim、省略字段保留及本人固定头像/背景键与哈希配对。返回原完整profile、认证/会员徽标、关系与四类内容计数；更新CAS比较所有旧字段和时间，避免同时间并发覆盖遗漏字段。换绑保留资料数据，旧凭证不能更新。
3. 通讯录五动作与四MLS操作已恢复。active/current设备资格、32设备、16KiB包、48KiB wire、256KiB请求、1024操作/设备队列、32MiB密文、7天已提交保留与100条投递预算均落地。state保留eligible_device_ids/key_packages/messages/pending/busy原格式；只有操作所有者看到pending详情。预留/提交核对版本、当前目标资格、容量与当前授权，全部batch原子；同规范结果幂等，不同结果409，容量429；移除失效设备只清其包/消息，ack只能消费当前设备消息。服务端不读取MLS私钥或通讯录明文。
4. 三种feed/作者列表恢复D1索引与每页一次媒体查询，推荐包含全部已发布分类，关注按viewer CID关系过滤、竞选只取campaign，作者支持原分类/类型/时间游标；分页默认20、上限50。非有效会员UTC日100条，以实际返回量原子扣量，失败不返回已查询内容；当前有效会员不限产品浏览额度。
5. 浏览权益使用当前canonical finalized的真实平台Subscriptions与Timestamp，只读核验不写会员投影。键的Platform枚举索引从metadata读取，完整解码plan/status/paid_until/价格/原因，真实null才是无订阅；未知/RPC错误拒绝。当前核验最长60秒，计费事务再次检查实际提交时间、会员核验期限和paid_until，查询等待不能延长权益。
6. 关注保持CID属主、禁止自己、重复关注保留原时间及通知开关、重复取消幂等；互关时间取双方关系较晚建立时间，游标沿用原合同。通知只统计通知开启关注作者的published帖子，两条独立单调已读游标互不清除。
7. 在 /Users/rhett/citizenserve/server/cloudflare/schema.sql 增加authorized_business_sessions视图，不增加业务表；主库仍31表、下载1表。共同业务授权断言位于 /Users/rhett/citizenserve/server/cloudflare/repositories/profiles.rs，所有写batch首句再次核对范围、源、链、机构、CID、账户、修订、设备、令牌、会话与身份期限，使用实际提交时间；断言失败整批回滚，底层SQL/命令不公开。本步4份规范SQL和其余适配内嵌SQL被真实SQLite测试直接加载。
8. 媒体索引不读取R2正文、不提供发布/详情/删除捷径。媒体键、种类、ready、哈希与CID匹配后才组装URL，article只显示媒体index=0。SQUARE_PUBLIC_MEDIA_BASE_URL仅由部署配置读取，本步未扩展wrangler配置；缺配置且页面含媒体返回503，异常媒体索引拒绝。两R2桶、完整内容与该变量的正式装配在第4步。

验收命令在 /Users/rhett/citizenserve 执行sh scripts/check.sh，最终结果：
- 77项Rust合同测试通过：25核心、9身份、15激活、7路由、5资料、7通讯录、9广场/订阅。既有真实Sr25519/Ed25519签名继续验收，新增计费失败不返回内容/实际量、完整metadata/动态键与编码尾字节等用例。
- 55项真实SQLite合同通过：9注册、22授权、24社区。含16连接并发：9条请求批次最多11次成功、最终99/100，预留只有1个pending赢家；容量32设备/1024队列/1024操作/32MiB、回滚、已读/互关时序、资料同时间CAS、换绑失权、跨会话挑战和等待中会员期限失效均验证。
- fmt、核心与Cloudflare WASM Clippy(-D warnings)、locked Release及WebAssembly.compile通过。生成 /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm，4090595字节，SHA-256 6b7c6b36768f9390b96d1bcf473de5ff612ad238f682e3cad83e69da543cf876。
- 删除前67个源码SHA-256再与refs/codex/citizenserve-before-rust/20261007逐件核对一致；此前功能/SQL账本保持。根目录没有src聚合、旧npm工程或临时原生实现；Python缓存与本步临时检查日志在交付前清理。

上述是本地真实密码学/SQLite和合成RPC/metadata/端口测试；未调用真实Siteverify、线上D1/链RPC、R2或App。health仍account_services_ready:false，没有Worker JS装载包、线上DDL、提交/push或部署；不能据局部恢复宣称可替换生产。下一步仅提交下方完整第4步方案，等待确认。

## 第4步完整技术方案（已按确认方案完成）

本步只恢复CitizenServe的会员/创作者、上传与配额、媒体校验/R2交付、发布确认/详情/本人回灌/删除。唯一执行与修改方为A；不修改CitizenApp、CitizenSDK、TataChatSDK、CitizenChain、钱包或B线程代码，不操作途遇产品。完整注册顺序及MLS私钥本机边界保持不变。充值/公共RPC/下载仍归第5步，推送/Queue/过期清理归第6步，聊天集成归第7步，App接线归第8步。用户已确认严格按本方案执行；本步已完成，结果与验收见下文；后续步骤仍须逐步确认。

### 分步骤实施与不可绕过的事实

1. **先固定路由和端口。** 将下表17项控制面入口纳入统一守卫和purpose=request挑战。证明继续签实际/api路径、原始查询和原始正文SHA-256；GET/DELETE为空正文，拒绝重复/未知参数、错误方法和旧/square别名。资产PUT是受预算限制的二进制，不先解析JSON。原MLS总正文上限1MiB无法接纳旧banner的1536KiB，本步明确将服务端总上限提高到2MiB，仅banner允许1536KiB，其他路由预算不扩大；SignWithLabel/GMB载荷和密钥算法不变。
2. **先核对链，再确认订阅。** 只在固定CHAIN_URL增加chain_getBlock；完整读取canonical finalized块，按metadata解析完整extrinsic/扩展/调用，计算整个extrinsic的BLAKE2-256 tx_hash，检查实际签名账户、指定phase的成功结果、真实业务动作与同一区块storage。不靠事件字节扫描、客户端申报action/价格/会员或历史投影授权。平台、创作者计划/名称、订阅和价格由同锚点解码；Platform/Creator及未知枚举不得互用。价格完整u128解码，对既有HTTP/D1安全整数出口严格检查，越界拒绝，不截断或用浮点近似。
3. **完成会员投影和服务。** 以永久CID为属主，保持Active/Cancelled且paid_until晚于服务器/链时间的权益判断，Expired/Terminated/Suspended/IssuerPaused不能取得写权限；身份档位与会员档位独立。确认记录、会员/档位/关系投影及事务证据在一次D1事务中写入；同tx同规范结果幂等、同tx不同业务结果拒绝，较旧块不能覆盖新事实。当前资格最长核验60秒，事务内再检查期限；RPC未知不降级为无会员。恢复创作者最多10档、名称20 Unicode标量、月/季/年三种真实公历价格、当前订阅与概览。投影catch-up核心使用独立已有membership_projection_cursor、整块提交、限定工作量；Cron任务调度及过期内容清理在第6步装配。
4. **按会员原子预留，再发上传计划。** 恢复三种post_type：document无标题、文字≤300 Unicode标量、≤9张图且内容非空；video无标题、配文≤300标量且恰好1个视频；article标题10至50标量、正文1至30000标量、首项必须为图片，图片含封面共50/100/100张、视频最多1/3/10个，规范content_sections与媒体引用逐项验证；manifest≤256KiB、最多110媒体；保持Freedom/Democracy/Spark的原图像1/2/4MB与1280/1920/2560边界、视频16MB/300MB/3GB及180/1800/10800秒、缩略图256000B/封面512000B、月图片300/1500/5000、月视频18000/60000/600000秒、活跃上传1/2/3、存储100GB/1TB/10TB（十进制）。服务端计算估算量；月额度周期沿用链上last_charged_at至paid_until，不按主机时区或自然月另建重置时钟；已用+未过期预留+本次须在同事务核对；prepare先持久预留再返回15分钟计划，不信客户端余额/用量。发布仍须有效会员。
5. **R2校验后才能complete和publish。** 主媒体/衍生图直传R2，SigV4限定PUT、唯一对象键、Content-Type/长度、完整SHA-256与upload_id/media_index/object_role；大视频字节不经Worker代理或装入内存。manifest进私有桶，媒体进公开桶。complete核对R2实际大小、内容类型、完整校验和/自定义元数据；WebP解析真实结构/尺寸，HEVC MP4解析有界BMFF box与moov前置/hvc1或hev1，而非查找任意字符串。视频前缀读取最多4MiB，主视频完整校验和由R2验证，错误尺寸/时长/哈希不能ready。预留转实耗、上传complete和媒体ready事务幂等，不重复扣量。发布必须再绑定同区块链上SquarePost事实、本人CID/钱包、post_id/content_hash/storage_receipt_id/类型/分类与已完成上传；分类只由该finalized区块身份派生：candidate为campaign，visitor/voting为normal，客户端不申报分类。
6. **恢复阅读、资料媒体与删除闭环。** 详情及本人回灌验证原始manifest字节/哈希、上传和帖子归属；回灌固定最多5条、复合游标、不重编码原始字节，一条不完整整页失败。资料媒体仍用本CID固定avatar/banner键，prepare保存在有期限的profile_asset_uploads；条件写/代际核验拒绝旧上传覆盖新版本，PUT完成事实后资料引用变更才能使用对应哈希。读取私有资料对象先过会话/MLS守卫，再校验当前引用哈希、Range/ETag。删除/取消先保留D1定位和删除状态，再批量删R2主媒体+衍生图+manifest及有界清缓存，全部确认后原子删索引并精确一次释放存储/未使用预留；已消费月额度不因删除返还。D1和R2没有共同事务，失败保留定位/状态供幂等重试，不能假报全成功或丢掉待删除对象依据。
7. **只补本步所需Cloudflare装配。** 配置SQUARE_PRIVATE=citizenserve-private、SQUARE_PUBLIC_MEDIA=citizenserve-media；恢复历史公开media.crcfrcn.com域名、CF_ACCOUNT_ID公开标识及R2_KEY/R2_SECRET/PURGE秘密的声明，不读取/写入秘密，不创建或部署资源。控制面仍全部位于www.crcfrcn.com/api。公开已发布媒体由R2/CDN交付，不经Worker/D1；私有manifest/资料不从公开域名交付。恢复历史RATE_READ=120/60秒、RATE_WRITE=30/60秒，保留RATE_AUTH=10/60秒；request挑战按受签业务读/写类别分档，避免认证档位把普通业务统一压到10次。完整其余绑定仍在第6步收敛。
8. **验收、清理和交接。** 运行真实签名/完整metadata与extrinsic向量、真实SQLite并发额度/版本/严格幂等/故障回滚、WebP/BMFF恶意样本、SigV4金标、R2端口故障/条件写/Range、完整WASM检查。测试适配器不冒充真实Worker/R2/RPC；本步不发布、不执行线上DDL。更新任务卡/产品文档/注释、清理临时产物，给出第5步完整方案后等用户确认。health保持account_services_ready:false直到整套回补验收。

### 全部控制面请求地址及内部路径

以下17项均要求有效sqs_会话和新鲜X-MLS-Proof，不再弹Cloudflare；登记/恢复/钱包/CID算法不变。动态CID、upload_id和post_id只接受规范实际值；POST body不重复传路径已给出的ID。新增路径不保留旧别名。

| 方法与完整外部请求地址 | 内部路径 | 用途/预算 |
|---|---|---|
| GET https://www.crcfrcn.com/api/membership | /membership | 当前本人会员、计划和使用量；空正文。 |
| POST https://www.crcfrcn.com/api/membership/confirm | /membership/confirm | 准确tx_hash、block_hash，16KiB。 |
| GET https://www.crcfrcn.com/api/membership/creators/{cid_number}/plans | /membership/creators/{cid_number}/plans | 本人/其他创作者用同一真实CID路径，含当前订阅信号。 |
| POST https://www.crcfrcn.com/api/membership/creators/plans | /membership/creators/plans | 只确认当前本人已上链档位交易；tx_hash、block_hash，16KiB。 |
| GET https://www.crcfrcn.com/api/membership/creator/overview | /membership/creator/overview | 本人订阅者数/月收入/档位数；须有效平台资格。 |
| POST https://www.crcfrcn.com/api/membership/creators/{cid_number}/subscription/confirm | /membership/creators/{cid_number}/subscription/confirm | tx_hash、block_hash，16KiB；链动作的目标必须与路径CID相同。 |
| POST https://www.crcfrcn.com/api/8964/uploads | /8964/uploads | 准备上传；post_type/title_length/text_length/manifest_hash/manifest_byte_size/media_items，128KiB。 |
| PUT https://www.crcfrcn.com/api/8964/uploads/{upload_id}/manifest | /8964/uploads/{upload_id}/manifest | 原始UTF-8 manifest字节，256KiB；upload_id只取路径。 |
| POST https://www.crcfrcn.com/api/8964/uploads/{upload_id}/complete | /8964/uploads/{upload_id}/complete | manifest_hash、content_hash，16KiB；核对所有R2事实。 |
| DELETE https://www.crcfrcn.com/api/8964/uploads/{upload_id} | /8964/uploads/{upload_id} | 本人取消，空正文，重复操作幂等。 |
| POST https://www.crcfrcn.com/api/8964/posts/confirm | /8964/posts/confirm | post_id、tx_hash、block_hash，16KiB；上传由唯一post_id索引定位，全部与链/上传互相核对。 |
| GET https://www.crcfrcn.com/api/8964/posts/self?limit=<1..5>&cursor=<BASE64URL> | /8964/posts/self | 本人原始manifest回灌；复合时间/帖子ID游标，任一失败整页失败。 |
| GET https://www.crcfrcn.com/api/8964/posts/{post_id} | /8964/posts/{post_id} | 发布详情、manifest与作者信号，空正文。 |
| DELETE https://www.crcfrcn.com/api/8964/posts/{post_id} | /8964/posts/{post_id} | 仅本人删除，空正文；保留失败定位供幂等重试。 |
| POST https://www.crcfrcn.com/api/user/profile/assets | /user/profile/assets | kind/content_type/byte_size/sha256，16KiB；准备15分钟本人上传凭据。 |
| PUT https://www.crcfrcn.com/api/user/profile/assets/{upload_id} | /user/profile/assets/{upload_id} | 原始WebP；avatar≤512KiB、banner≤1536KiB，种类取服务端凭据。 |
| GET https://www.crcfrcn.com/api/user/profiles/{cid_number}/assets/{kind} | /user/profiles/{cid_number}/assets/{kind} | 已登记用户读取avatar/banner；范围/ETag在授权后处理。 |

继续复用POST https://www.crcfrcn.com/api/user/challenges（内部/user/challenges）；普通request挑战还须同一有效Bearer会话。当前GET https://www.crcfrcn.com/api/8964/posts?cid_number=<CID>等第3步路由保持，/posts/self与/posts/confirm必须先匹配，不能误作post_id。

媒体完整交付目标为：
- 已发布主图：https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/source.webp。
- 已发布视频：https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/source.mp4。
- 缩略图/封面：https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/thumbnail.webp、https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/cover.webp。
- 客户端源文件/衍生图直传：https://f088b553d27d9c26b81f48f1924c3bbd.r2.cloudflarestorage.com/citizenserve-media/square/{cid_number}/posts/{post_id}/media/{index}/{filename}?<服务端SigV4查询>；只使用prepare返回的完整URL与签名头。
- 私有manifest对象键：square/{cid_number}/posts/{post_id}/manifest.json，仅通过上述受保护控制面读写；资料对象键：profile/{cid_number}/avatar、profile/{cid_number}/banner。

当前CHAIN_URL没有已核实部署值，方案只读取既有配置并保持固定HTTPS源/Access认证，不凭空填写域名。本步不开放任意RPC URL或自建迁移入口。

### 新增文件（35个，已由A实施）

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/membership/routes.rs | 会员与创作者精确路由/预算。 | A |
| /Users/rhett/citizenserve/membership/service.rs | 当前平台权益、会员响应与使用量编排。 | A |
| /Users/rhett/citizenserve/membership/creator.rs | 创作者档位、订阅确认、概览与访问资格。 | A |
| /Users/rhett/citizenserve/membership/projection.rs | 订阅/档位的按块投影、幂等与单调更新。 | A |
| /Users/rhett/citizenserve/membership/ports.rs | 订阅读取/确认/投影的原子端口。 | A |
| /Users/rhett/citizenserve/membership/limits.rs | 恢复图片、视频、存储、活跃上传与月额度三档完整限制。 | A |
| /Users/rhett/citizenserve/8964/uploads.rs | prepare、manifest、complete、abort状态机。 | A |
| /Users/rhett/citizenserve/8964/upload_validation.rs | 申报字段、WebP/BMFF实际结构、尺寸/时长与哈希校验。 | A |
| /Users/rhett/citizenserve/8964/manifest.rs | 原始manifest字节、类型/归属与SHA-256一致性。 | A |
| /Users/rhett/citizenserve/8964/media.rs | 主文件/衍生图计划、公开URL和受保护资料媒体交付。 | A |
| /Users/rhett/citizenserve/8964/post_service.rs | finalized发布确认、详情和本人删除编排。 | A |
| /Users/rhett/citizenserve/8964/local_copy.rs | 本人原始manifest回灌及复合游标。 | A |
| /Users/rhett/citizenserve/8964/storage.rs | 对象读取/条件写/批量删除/预签名/缓存清理的中性端口。 | A |
| /Users/rhett/citizenserve/user/profile_assets.rs | 资料上传准备/消费、本人固定对象键与当前哈希依据。 | A |
| /Users/rhett/citizenserve/chain/transaction.rs | 完整extrinsic、tx_hash、成功phase与metadata动作核验。 | A |
| /Users/rhett/citizenserve/chain/post.rs | 同区块SquarePost事实与发布事件匹配。 | A |
| /Users/rhett/citizenserve/server/cloudflare/media.rs | R2两桶、SigV4直传、条件写、Range和有界清缓存适配。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/membership.rs | D1平台/创作者/档位投影、统计与确认幂等。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/uploads.rs | D1上传/媒体索引、月额度预留及存储计量。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/media.rs | D1资料上传凭据、代际/租约和引用一致性。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/posts.rs | D1发布/详情/回灌查询和删除定位。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/project_subscription.sql | 同块订阅/档位事实与游标原子提交。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/reserve_upload.sql | 当前授权/权益/活动上传数/存储/月额度共同预留。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/complete_upload.sql | 核验完成事实、媒体ready与预留转实耗的原子提交。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/confirm_post.sql | 确认占用、同事务发布索引与严格重复确认。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/release_content.sql | 删除定位保留、对象删除后精确一次释放当前存储与预留。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/reserve_profile_asset.sql | 固定CID/种类、单活跃上传、有效期和条件写代际。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/complete_profile_asset.sql | 当前上传消费、对象哈希依据与完成幂等。 | A |
| /Users/rhett/citizenserve/test/membership_contract.rs | 同块订阅/动作、会员期限、创作者价格/名称与单调投影。 | A |
| /Users/rhett/citizenserve/test/uploads_contract.rs | 上传状态、权限、额度、字节/哈希、WebP/BMFF与直传合同。 | A |
| /Users/rhett/citizenserve/test/posts_contract.rs | 发布/回灌/详情/删除归属与完整manifest字节合同。 | A |
| /Users/rhett/citizenserve/test/media_contract.rs | 公开/私有键、SigV4签名向量、Range及条件写。 | A |
| /Users/rhett/citizenserve/test/content_storage_contract.py | 真实SQL并发预留/完成/投影/释放/回滚。 | A |
| /Users/rhett/citizenserve/test/contract/subscription.json | 公开合成订阅/动作/档位向量。 | A |
| /Users/rhett/citizenserve/test/contract/content.json | 公开合成manifest/WebP/BMFF/对象与上传向量。 | A |

### 修改文件（28个，已由A实施，含任务卡）

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/membership/mod.rs | 导出服务/端口并接齐三档资源限制。 | A |
| /Users/rhett/citizenserve/8964/mod.rs | 导出上传、manifest、媒体和帖子服务。 | A |
| /Users/rhett/citizenserve/8964/routes.rs | 新增资源路由、优先匹配self/confirm和查询/正文预算。 | A |
| /Users/rhett/citizenserve/8964/ports.rs | 复用帖子索引，新增内容状态交接端口所需类型。 | A |
| /Users/rhett/citizenserve/chain/mod.rs | 导出交易与发布事实核验。 | A |
| /Users/rhett/citizenserve/chain/subscription.rs | 扩展平台/创作者/档位同块读取并复用当前核验。 | A |
| /Users/rhett/citizenserve/chain/scale.rs | 公开必要metadata键/调用类型解析，仍完整解码拒绝尾字节。 | A |
| /Users/rhett/citizenserve/user/mod.rs | 导出资料上传服务。 | A |
| /Users/rhett/citizenserve/user/routes.rs | 新增资料资产路由及种类/上传ID校验。 | A |
| /Users/rhett/citizenserve/user/profile_service.rs | 资料引用变更须匹配已完成的本人上传哈希依据。 | A |
| /Users/rhett/citizenserve/user/auth/mls_authentication.rs | 正文验签总上限由1MiB调整为2MiB；消息格式/密钥/签名算法不变，各路由仍用较小独立预算。 | A |
| /Users/rhett/citizenserve/server/routes.rs | 合并会员/内容/资产精确路由。 | A |
| /Users/rhett/citizenserve/server/cloudflare/lib.rs | 控制面守卫、原始字节/二进制响应、分档限流与内容服务编排。 | A |
| /Users/rhett/citizenserve/server/cloudflare/chain.rs | 仅增chain_getBlock白名单，继续固定源/认证/超时/响应上界。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/mod.rs | 导出新适配，收拢统一业务事务授权工具。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/profiles.rs | 核对已完成资产引用；统一事务工具迁至repositories/mod.rs。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/contacts.rs | 只更新统一事务工具导入，MLS逻辑不变。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/square.rs | 只更新统一工具导入并接复原后的媒体配置。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/notifications.rs | 只更新统一工具导入，双游标合同不变。 | A |
| /Users/rhett/citizenserve/server/cloudflare/schema.sql | 收敛现有内容/订阅表约束和索引；新增profile_asset_uploads保存有期限的资料上传事实，不新增影子会员/影子身份表。 | A |
| /Users/rhett/citizenserve/server/cloudflare/wrangler.toml | 声明本步两R2桶、公开域名/账户标识、R2/Purge秘密及原读写限流；不做线上配置。 | A |
| /Users/rhett/citizenserve/Cargo.toml | 登记四组Rust合同测试，不增加平台crate或新第三方依赖。 | A |
| /Users/rhett/citizenserve/test/route_contract.rs | 精确路由、旧路径拒绝和二进制预算。 | A |
| /Users/rhett/citizenserve/test/storage_contract.py | 实施验收必要补充：新增资料上传凭据表后，重复执行schema的主库表数断言由31同步为32；不改变原业务结构。 | A |
| /Users/rhett/citizenserve/test/community_storage_contract.py | 保持第3步SQL验收，调整共用授权SQL常量的归属位置。 | A |
| /Users/rhett/citizenserve/CitizenServe.md | 实际结果、接口和第5步完整方案。 | A |
| /Users/rhett/citizenserve/README.md | 状态与检查证据。 | A |
| /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md | 本步结果、证据、完整第5步方案。 | A |

### 只读复用文件（不改写）

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/server/guard.rs | 准入/设备/会话/实际请求与一次性挑战。 | A只读复用 |
| /Users/rhett/citizenserve/user/identity.rs | 当前绑定、撤销及60秒确认。 | A只读复用 |
| /Users/rhett/citizenserve/user/admission.rs | Turnstile准入事实。 | A只读复用 |
| /Users/rhett/citizenserve/user/projection.rs | 当前链身份与投影。 | A只读复用 |
| /Users/rhett/citizenserve/user/auth/challenge.rs | 已登记受保护目标的request挑战。 | A只读复用 |
| /Users/rhett/citizenserve/user/auth/session.rs | 会话摘要与24小时期限。 | A只读复用 |
| /Users/rhett/citizenserve/user/registration/protocol.rs | 冻结范围/源/创世哈希与注册合同。 | A只读复用 |
| /Users/rhett/citizenserve/user/profiles.rs | 固定资料键与UTF-16/trim。 | A只读复用 |
| /Users/rhett/citizenserve/8964/objects.rs | 唯一CID/帖子/媒体对象键。 | A只读复用 |
| /Users/rhett/citizenserve/8964/quota.rs | 已用加预留的配额规则。 | A只读复用 |
| /Users/rhett/citizenserve/8964/feed.rs | 实际条数计费及当前权益期限。 | A只读复用 |
| /Users/rhett/citizenserve/8964/follows.rs | 关系与旧响应合同。 | A只读复用 |
| /Users/rhett/citizenserve/8964/posts.rs | D1帖子/媒体索引响应。 | A只读复用 |
| /Users/rhett/citizenserve/notifications/inbox.rs | 双游标与未读服务。 | A只读复用 |
| /Users/rhett/citizenserve/chain/ports.rs | 固定RPC端口。 | A只读复用 |
| /Users/rhett/citizenserve/chain/finalized.rs | canonical finalized锚点。 | A只读复用 |
| /Users/rhett/citizenserve/chain/identity.rs | 同锚点身份和storage读取。 | A只读复用 |
| /Users/rhett/citizenserve/shared/crypto.rs | SHA-256、BLAKE2与HMAC。 | A只读复用 |
| /Users/rhett/citizenserve/shared/ids.rs | 规范CID/账户/对象编号。 | A只读复用 |
| /Users/rhett/citizenserve/shared/error.rs | 固定错误响应。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/auth.rs | 权威会话/设备及挑战。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/identity.rs | 当前投影与刷新租约。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/sql/consume_mls_challenge.sql | 请求绑定会话与设备的原子消费。 | A只读复用 |
| /Users/rhett/citizenserve/scripts/check.sh | 完整只检查入口。 | A只读复用 |
| /Users/rhett/citizenserve/Cargo.lock | 固定依赖版本，保持不变。 | A只读复用 |

B只拥有通用聊天产品、既有聊天宿主合同及 /Users/rhett/tataconsole/tasks/塔塔聊天服务模块与公民途遇服务端集成.md。本步没有B修改文件；A不编辑该卡，不因此授权B下一步或改造其他产品。

### 生成物与验收门槛

| 完整绝对路径 | 内容/处理 | 唯一方 |
|---|---|---|
| /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm | 本步WASM release生成物，保留验证摘要；不能单独宣称可部署。 | A生成 |
| /Users/rhett/citizenserve/target/ | Cargo可再生缓存，已忽略，不提交。 | A生成 |
| /Users/rhett/citizenserve/test/__pycache__/ | Python检查缓存，验收后清理。 | A清理 |

必须证明：RPC/编码/哈希/权限/事务异常均不能变成功；迟到核验不延长授权；同CID换绑业务数据留存而旧设备失权；配额并发不超顶、失败无半ready/半发布；同确认不重复计量；正文和回灌字节完全一致；对象键/版本/取消不能越权，故障重试不丢定位；旧媒体路径和旧鉴权别名仍拒绝。全量fmt、Rust测试、核心与Cloudflare WASM Clippy(-D warnings)、规范SQL真实SQLite、WASM release与WebAssembly.compile通过后才将本步记为完成。

## 第4步执行结果（已完成，2026-10-08）

本步由A完成上述35个新增文件、28个修改文件（含任务卡），对应完整路径和唯一修改方见本步实施清单；25个只读复用文件的实施前后SHA-256全部一致。原清单额外补充的 /Users/rhett/citizenserve/test/storage_contract.py 只同步新增资料上传表后的32表断言，已在实施时登记。任务卡67份旧源码摘要全部与删除前Git快照一致。没有修改其他产品或B任务卡。

1. 新增17项控制面入口，全部复用当前CID、真人准入、设备、会话和一次性MLS请求证明；继续签原始/api路径、原始查询和原始正文。MLS正文总上限2MiB，只放宽banner至1536KiB，其余路由独立限额不扩大；资产Range/ETag预检头已补齐。
2. 完整extrinsic核验使用metadata V14/V15/V16的地址、签名、调用及扩展类型；保持现有钱包v4 signed envelope，不把v5 general当钱包证明。核对整交易BLAKE2-256、canonical finalized块、区块完整header、准确成功phase、签名账户/CID、业务动作与同块storage。会员确认、创作者档位及价格按准确u128解码，HTTP/D1数值越安全整数范围时拒绝。
3. 平台/创作者投影、事务证据和单调块号一次提交；空创作者档位也在既有square_memberships保存独立块头，防止旧确认恢复已删除档位。最长60秒当前资格在D1提交和最终交付时再检查。整块catch-up核心已实现，调度仍归第6步。
4. prepare先原子检查有效会员、已用加预留、跨周期存储及活跃上传数，再返回15分钟SigV4计划。补齐原CID每小时30次持久硬顶：rate_windows与成功预留同事务提交，失败预留整体回滚；技术读写边缘限速仍独立执行。价格、会员、剩余额度和分类不接受客户端口头申报。
5. R2计划签PUT/对象键/长度/类型/完整SHA-256/上传与媒体身份，条件写拒绝覆盖。主媒体与衍生图直传公开桶；manifest进私有桶。complete验证R2实际完整校验和、对象元数据与有界WebP/BMFF结构、尺寸/时长后一次转实耗。WebP/BMFF是结构校验，不声明已逐像素或逐视频帧解码。
6. 发布必须绑定完成上传与同块调用、成功事件、SquarePost存储、CID/钱包、类型/哈希/receipt和真实身份分类。详情/本人回灌保留原始manifest字节，复合游标每页最多5条，任一缺失或哈希不一致整页失败。
7. 资料资产使用新增profile_asset_uploads的代际、有效期和R2条件ETag；旧上传不能覆盖新版本。对象成功但D1失败保留writing凭据，同字节重试完成；资料引用只能采用已完成的当前资产哈希。私有读取先授权，再处理当前引用、完整校验和与Range/ETag。
8. 删除先持久记录定位/状态，再删除主媒体、衍生图、manifest并清缓存。已签直传URL在15分钟内仍可能重新写入，因此到期前返回pending并保留定位，到期后重删/清缓存完成才原子清索引、精确一次释放存储/未消费预留；已消费月额度不返还。故障不能假报删除成功。
9. 当前主库32表、下载库1表；保留所有旧业务表。R2、公开media域、原读写边缘限速及秘密声明已装配到本地配置；实际ZONE_ID/CHAIN_URL未核实值不猜填，不读取秘密、不做线上配置。
10. 更新任务卡、产品文档、注释与测试；验收后清理Python缓存和本步临时检查文件。Cargo.lock、依赖版本与只检查脚本保持不变。

### 验收证据与实际限制

| 检查 | 结果 |
|---|---|
| /Users/rhett/citizenserve/scripts/check.sh（以sh执行） | fmt、104项Rust测试、77项真实SQLite测试、核心及Cloudflare WASM Clippy(-D warnings)、locked WASM Release均通过。 |
| /Users/rhett/citizenserve/test/membership_contract.rs | 10项：真实Sr25519签名、V14/V15/V16完整extrinsic/扩展、准确phase、完整合成RPC链锚/身份、原始u128与价格/档位边界。 |
| /Users/rhett/citizenserve/test/uploads_contract.rs、/Users/rhett/citizenserve/test/posts_contract.rs、/Users/rhett/citizenserve/test/media_contract.rs | 共16项：申报/原始manifest/引用/游标、恶意WebP/BMFF、SigV4金标、真实MLS大banner证明、条件写/Range与故障幂等。 |
| /Users/rhett/citizenserve/test/content_storage_contract.py | 22项：生产SQL原文、24并发prepare/complete/每小时最后名额、回滚、严格证据幂等、单调/空档位投影、资料代际及删除精确释放。 |
| /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm | 4677631字节；SHA-256 b7907cb85e76b471360ee74b1eb63e8d6496baf3c99d4300fc46b7452c54030a；WebAssembly.compile通过。 |
| 只读文件/旧源码证据 | 25个只读文件未变化，67个旧源码摘要逐项复核通过。 |

上述RPC、metadata、R2端口与坏对象均为本机合成/故障测试；SQLite及密码学执行真实实现。没有真实Worker运行、线上链RPC/D1/R2/Siteverify验收，没有Worker JS装载包、线上DDL、Git提交/push或部署。health继续account_services_ready:false，当前不能替换生产服务。此句为第4步结束时的交接记录；第5步随后获确认并完成，实际结果见下方。

## 第5步完整技术方案（已按确认方案完成，保留实施前清单）

本步恢复CitizenServe的稳定币充值、授权结算、正式下载/发布指针、链引导/宪法/签名广播及公共EVM RPC。唯一执行与修改方为A。下列路径、权限、文件和验收为完整范围；不修改CitizenApp、CitizenSDK、CitizenWallet、CitizenChain、TataChatSDK、TataChatServer、B代码/卡或其他产品。客户端接线归第8步，推送/队列/过期清理及本地Worker装配归第6步，正式CI/发布控制归第8步，聊天归第7步。用户已确认严格按本方案执行；现已完成，结果见下节，后续步骤仍须逐步确认。

注册主线继续为：点击确认注册→Cloudflare验证→CitizenServe保存通过结果→原钱包签名、上链及finalized完成CID注册→MLS设备授权激活→开放账户服务。没有生成候选CID，没有把充值或网络工具当成准入凭据，没有再增加Cloudflare弹窗。MLS私钥始终在TataChatSDK本机。

### 分步骤实施

1. **固定精确路径与权限。** 统一功能前缀为/api/topup、/api/downloads、/api/chain；不保留旧/square、单数/download、根/constitution或/operations别名。将以下28项API方法及独立rpc域明确分为公共链/下载工具、HMAC付款意图、SETTLE_TOKEN结算和专用HMAC发布四类，逐方法逐路径登记；它们均不能访问广场、聊天、通讯录、会员或用户资料，现有普通账户服务守卫和MLS实际路径证明不改。保留冷钱包/代充的原产品能力，充值目标AccountId可未绑定CID；RPC失败不能记成“未绑定CID”。App在第8步按已确认主线阻止未完成准入访问账户服务。
2. **恢复精确报价与付款意图，并修复实际抢单风险。** Base主网8453、USDC/USDT两条既有代币轨、6位最小单位；pkg_15为15000000原子单位→1000000公民币分，pkg_1400为1400000000→100000000分，金额以精确整数字符串交付。意图绑定目标AccountId、实际当前CID或null、付款地址、币轨/合约、收款地址、套餐/金额、唯一intent_id和签发/十分钟到期时间，保留服务器HMAC能力令牌。旧代码只有客户端申报payer_address及“签发早于区块”检查；观察待打包交易后仍能先造不同目标意图，所以增加**付款钱包签署完整充值意图**：intent响应返回服务端生成的wallet_authorization_message；confirm准确增加payer_signature字段。EOA以ERC-191 personal_sign恢复付款地址；合约付款钱包按该canonical付款块的ERC-1271只读验签。任何地址、目标、金额、链/域或意图变更均使签名失效，私钥不上传。此改动按用户确认在本步服务端和合同实现，App签名交互第8步接入。
3. **以真实EVM链事实创建订单。** 固定TOPUP_BASE_RPC_URL，不接受客户端RPC URL；核对eth_chainId=8453、交易/receipt哈希、成功状态、实际token Transfer事件、付款/收款地址、足额u256金额、log所属canonical区块、区块时间和确认策略。付款发生时间必须晚于意图签发且不晚于十分钟到期；配置min_confirmations=0沿用finalized，否则使用准确确认数并核对canonical hash。未知编码、链错、重组、超时或缺区块不能成功。同(chain_id,evm_tx_hash)与intent_id双唯一，同意图/同准确规范事实幂等，不同意图抢占拒绝；保留原pending/paid/exception三态，RPC待确认不落新终态。将准确付款区块/日志、意图及钱包授权摘要和核验期限存入原topup_orders相应列，一次原子写入，不设影子用户。保留IP和目标AccountId限速、外部付款RPC每链300次/60秒D1全局硬顶；重复已确认查询不再打付款RPC。
4. **恢复排他claim和完整双链结算。** 仅常量时间匹配SETTLE_TOKEN的结算客户端可操作。pending≤50，history≤100并用(confirmed_at,order_id)稳定游标合并三态。claim同ID幂等、不同ID排斥，永不自动过期释放；服务端不持发币私钥，不自动签发/广播公民币。settled在当前claim下复核Base付款，并用目标块metadata完整解析OnchainTransaction::transfer_with_remark、整交易哈希、canonical finalized块/准确index/整签名字节、配置发币账户、准确受益AccountId/金额、topup:<order_id>备注、同phase的唯一System.ExtrinsicSuccess且无失败、准确TransferWithRemark事件；不靠硬编码pallet/call index或“交易包含在块中”宣称转账成功。抽取现有通用signed/finalized核心时保留会员/帖子专用CID及SquarePost核验。最后一次D1事务比较claim、订单与全部证据，重复paid须完整证据一致；同GMB交易不能付给两笔订单。exception须匹配claim及准确理由，不从异常自动恢复或重新发币。
5. **恢复正式下载和发布指针。** App/Wallet Android从各自固定crcfrcn产品仓读取正式非draft/非prerelease Release；公民链四平台继续使用独立CITIZENCHAIN_DOWNLOAD_DB的准确显式发布指针，保留平台对应Tag/源码SHA/资产名/资产SHA/revision。只恢复实际存在的macOS updater，不能凭空增加另外三平台updater。GET/PUT publication使用CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET及准确x-citizenserve-request-time、nonce、signature三头，HMAC规范为method、**实际/api完整路径**、时间、nonce、原始body SHA-256五行，时钟±5分钟；拒绝查询、错平台/域、坏摘要与额外字段。PUT expected_revision原子CAS，publication=null明确撤回；同规范结果幂等、旧revision不能覆盖新发布。普通会话及结算令牌没有发布权。固定GitHub官方源、仓/Release Tag/资产/HTTPS路径，有界响应和精确302目标，展示缓存≤300秒；无指针或缺实际资产不能造下载结果。本步不写线上指针、不创建Release。
6. **恢复链引导、宪法及受控广播。** App与CitizenSDK两个bootstrap保留各自exact schema、SS58=2027/GMB两位小数、已登记创世hash/state_root/bootnodes、签名安装包bundled chainspec/light_sync_state及P2P finalized信任合同，不下发可替换checkpoint或服务端节点/Access秘密。返回当前/api实际服务路径；广播显式关闭时返回不可用。宪法从同一canonical finalized块的LegislationYuan Laws(0)已生效版本、LawVersions、LawVersionLabels与ConstitutionImmutableManifest完整解码，拒绝尾字节/非法层级/超大内容，保留中英标签与准确更新时间；展示缓存≤300秒不能用于授权。POST extrinsics只收signed_extrinsic_hex，不收私钥/助记词、账户申报或任意RPC方法；原始extrinsic≤65536B、JSON≤131584B。显式RELAY_ENABLED=1及实际固定节点配置后才调用author_submitExtrinsic；IP每分钟20次跨PoP硬顶、SHA-256十分钟去重与排他占用，验证节点tx_hash与完整extrinsic BLAKE2-256一致。广播超时保留不确定结果/定位，不假报失败后自动重发；广播成功只表示broadcast，不签发CID/准入/会话或宣称finalized。
7. **恢复独立公共EVM RPC与本步本地装配。** https://nrcrpc.crcfrcn.com/仅POST和OPTIONS，固定代理CitizenChain的EVM节点，不是充值用Base节点。严格保留26项方法，单次/批量≤20项、JSON正文≤128KiB、合法唯一id、明确params预算及真实节点result/error；不执行通知、重复ID、未知方法或私钥参数。eth_getLogs≤1000块/32地址/4层topics，feeHistory≤1024块/100百分位，accessList≤64×64；固定Access源、10秒超时、有界响应、逐项限制及最大全局工作量，不开放任意Substrate JSON-RPC代理。本地声明既有下载D1/CACHE和准确域/秘密/变量，不读取或上传秘密、不创建资源、不部署。共同Rust核心保持无worker/D1/R2耦合，本步不写自建服务器或迁移工具。
8. **验收、更新文档与清理后交接。** 覆盖真实HMAC/ECDSA/Keccak及ERC-191向量、ERC-1271合成RPC、付款被他人观察后不能抢单、错目标/错链/错币/不足额/过期/重组、完整GMB成功及失败交易、同交易不同订单、24并发意图/付款/claim/广播/发布CAS、持久claim崩溃、故障保留不确定状态、完整引导/宪法和26方法边界、正式Release与实际/api HMAC互操作。生产SQL原文在SQLite运行，模拟端口明确标为模拟。运行全量fmt/测试/Clippy/WASM Release/WebAssembly.compile，回归现有授权/社区/内容合同，逐项更新任务卡/文档/注释，清理临时产物，输出第6步完整方案并等确认。health继续account_services_ready:false。

### 付款钱包签名合同（已随本步确认）

消息由服务端生成，UTF-8 ASCII，固定顺序逐行包含：CitizenServe Topup v1、service_origin、chain_genesis_hash、intent_id、chain_id、payer_address、token_contract、recv_address、pay_amount、coin_fen、account_id、package_id、issued_at、expires_at、intent_sha256；key=value，各行LF且最后一行带LF，intent_sha256对返回的完整payment_intent ASCII字节求SHA-256。展示金额与目标，客户端不得自行重排/重编码。EOA采用personal_sign的Ethereum Signed Message前缀和**消息字节长度**再Keccak-256；只接受规范65字节r/s/v及low-S，v=0/1或27/28规范化，恢复地址须与意图payer_address相同。合约钱包使用同一digest及有界签名（≤4096B），在已核实付款块读取代码并只调用该地址isValidSignature，gas≤500000，准确返回0x1626ba7e才通过；不能把RPC故障降级成EOA或成功。

这是对旧充值实现实际抢单漏洞的方案加固，增加的是付款意图签名，不是CID注册步骤。EOA标准依据 [ERC-191](https://eips.ethereum.org/EIPS/eip-191)，合约钱包依据 [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271)。所需最小纯Rust ECDSA/Keccak依赖实施前核实官方版本/API并固定到Cargo.toml/Cargo.lock，记录版本与验证，不批量升级其他依赖。

### 全部外部请求地址、内部路径和权限

API origin为https://www.crcfrcn.com，权限由精确路由决定。下列POST（settled/广播除外）正文上限16KiB；settled≤131584B、广播≤131584B且原始交易≤65536B；GET/PUT publication≤16KiB（GET空正文）。GET仅接受标出的规范查询；拒绝重复/未知查询、字段和方法。动态order_id只接受top_<32位小写hex>。public/付款/结算/发布均不签发账户服务授权；现有普通账户业务始终走MLS守卫。

| 方法与完整请求地址 | 内部路径 | 准确输入/权限 |
|---|---|---|
| GET https://www.crcfrcn.com/api/topup/config | /topup/config | 公开准确报价/已配置币轨，空正文。 |
| POST https://www.crcfrcn.com/api/topup/intent | /topup/intent | account_id、token、package_id、payer_address；返回HMAC意图与完整钱包签名消息。 |
| POST https://www.crcfrcn.com/api/topup/confirm | /topup/confirm | payment_intent、evm_tx_hash、payer_signature；实际付款钱包授权+双唯一付款事实。 |
| POST https://www.crcfrcn.com/api/topup/status | /topup/status | order_id、payment_intent；只查该意图订单；既有订单查询不因付款意图TTL结束失联。 |
| GET https://www.crcfrcn.com/api/topup/settlement/pending?limit=<1..50> | /topup/settlement/pending | SETTLE_TOKEN；空正文。 |
| GET https://www.crcfrcn.com/api/topup/settlement/history?limit=<1..100>&cursor=<BASE64URL> | /topup/settlement/history | SETTLE_TOKEN；准确复合游标。 |
| POST https://www.crcfrcn.com/api/topup/settlement/{order_id}/claim | /topup/settlement/{order_id}/claim | SETTLE_TOKEN；可选claim_id（缺省由服务端生成）。 |
| POST https://www.crcfrcn.com/api/topup/settlement/{order_id}/settled | /topup/settlement/{order_id}/settled | SETTLE_TOKEN；claim_id、gmb_tx_hash、gmb_block_hash、gmb_extrinsic_index、signed_extrinsic_hex。 |
| POST https://www.crcfrcn.com/api/topup/settlement/{order_id}/exception | /topup/settlement/{order_id}/exception | SETTLE_TOKEN；claim_id、reason。 |
| GET https://www.crcfrcn.com/api/downloads/citizenapp/android | /downloads/citizenapp/android | 固定App正式安装包；公开。 |
| GET https://www.crcfrcn.com/api/downloads/citizenwallet/android | /downloads/citizenwallet/android | 固定Wallet正式安装包；公开。 |
| GET https://www.crcfrcn.com/api/downloads/citizenchain/macos | /downloads/citizenchain/macos | 该平台正式指针/准确dmg；公开。 |
| GET https://www.crcfrcn.com/api/downloads/citizenchain/macos/updater | /downloads/citizenchain/macos/updater | 同指针citizenchain-node-latest-macOS.json；公开。 |
| GET https://www.crcfrcn.com/api/downloads/citizenchain/windows | /downloads/citizenchain/windows | 该平台正式指针/准确exe；公开。 |
| GET https://www.crcfrcn.com/api/downloads/citizenchain/linux-arm | /downloads/citizenchain/linux-arm | 该平台正式指针/准确deb；公开。 |
| GET https://www.crcfrcn.com/api/downloads/citizenchain/linux-amd | /downloads/citizenchain/linux-amd | 该平台正式指针/准确deb；公开。 |
| GET/PUT https://www.crcfrcn.com/api/downloads/citizenchain/macos/publication | /downloads/citizenchain/macos/publication | 专用发布HMAC；PUT expected_revision、publication。 |
| GET/PUT https://www.crcfrcn.com/api/downloads/citizenchain/windows/publication | /downloads/citizenchain/windows/publication | 同上，仅本平台。 |
| GET/PUT https://www.crcfrcn.com/api/downloads/citizenchain/linux-arm/publication | /downloads/citizenchain/linux-arm/publication | 同上，仅本平台。 |
| GET/PUT https://www.crcfrcn.com/api/downloads/citizenchain/linux-amd/publication | /downloads/citizenchain/linux-amd/publication | 同上，仅本平台。 |
| GET https://www.crcfrcn.com/api/chain/bootstrap | /chain/bootstrap | App准确引导schema；公开只读。 |
| GET https://www.crcfrcn.com/api/chain/citizensdk/bootstrap | /chain/citizensdk/bootstrap | CitizenSDK准确窄schema；公开只读。 |
| GET https://www.crcfrcn.com/api/chain/constitution | /chain/constitution | 已生效宪法；公开只读。 |
| POST https://www.crcfrcn.com/api/chain/extrinsics | /chain/extrinsics | 仅signed_extrinsic_hex；显式开关、限流/去重的广播工具。 |
| POST/OPTIONS https://nrcrpc.crcfrcn.com/ | 独立域根/ | 26方法JSON-RPC公共钱包网络入口；不接受/api别名。 |

public是保留的链网络/安装包/报价能力，不代表未通过验证者能进入账户业务。上述公共广播同区块链P2P一样不能在共识层强制所有链上CID注册都经过Cloudflare；本项目要求落实的是CitizenApp完整注册主线和CitizenServe账户服务准入，不能把网络API误说成全链真人证明。

### 实际固定后端地址和配置来源

- 正式App/Wallet Release源：https://api.github.com/repos/crcfrcn/citizenapp/releases?per_page=100、https://api.github.com/repos/crcfrcn/citizenwallet/releases?per_page=100；链固定Tag读取：https://api.github.com/repos/crcfrcn/citizenchain/releases/tags/{version_tag}。下载只返回对应https://github.com/crcfrcn/{product}/releases/download/{version_tag}/{asset_name}，禁止任意仓/外部URL。
- 平台Tag：citizenchain-macos-v<版本>、citizenchain-windows-v<版本>、citizenchain-linux-arm-v<版本>、citizenchain-linux-amd-v<版本>；对应citizenchain-node-macOS-v<版本>.dmg、citizenchain-node-Windows-v<版本>.exe、citizenchain-node-LinuxARM-v<版本>.deb、citizenchain-node-LinuxAMD-v<版本>.deb。保持真实发布身份，路径改小写不改资产大小写。
- 旧正式配置登记的Base源是https://mainnet.base.org；实施时仅从TOPUP_BASE_RPC_URL加载固定HTTPS源，核实准确币轨合约/decimals/实际资产种类，以合约白名单为准，不凭symbol识别或把桥接资产说成原生资产。TOPUP_RECV_ADDRESS、TOPUP_DISBURSE_ACCOUNT_ID和两币合约对照历史公开配置，未核实不猜填、不增加新网络/供应商。
- CitizenChain只从既有CHAIN_URL/CHAIN_ID/CHAIN_SECRET固定Access源读取或受控广播；实际CHAIN_URL部署值目前未核实，不凭空写域名。公共EVM源属于该CitizenChain节点，不转给Base源。
- 本地声明下载D1：CITIZENCHAIN_DOWNLOAD_DB，citizenweb-download，fa70d613-ff33-43d3-aecd-84f1baef3918；展示KV沿用SQUARE_CACHE，d632942d82c94e45ab4058fa69268ce1。专用秘密为TOPUP_INTENT_SECRET、SETTLE_TOKEN、CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET，仅声明，不读值、不线上写。
- 当前/api归一化与付款签名/HMAC变更先实现服务端合同；App及产品发布器必须在各自后续接线验收新实际路径，未验收前不能替换生产。


### 拟新增文件（42个，均由A新建）

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/topup/routes.rs | 充值/结算精确路由、查询和独立正文预算。 | A |
| /Users/rhett/citizenserve/topup/config.rs | Base主网、双币轨、精确套餐及配置核验。 | A |
| /Users/rhett/citizenserve/topup/intent.rs | 十分钟HMAC付款意图、规范字节与能力验证。 | A |
| /Users/rhett/citizenserve/topup/wallet_authorization.rs | 付款钱包对完整意图的ERC-191签名恢复/ERC-1271只读验证，防抢占他人付款。 | A |
| /Users/rhett/citizenserve/topup/orders.rs | 同意图/交易严格幂等的订单确认与状态。 | A |
| /Users/rhett/citizenserve/topup/evm_verify.rs | 链ID、canonical区块、回执/付款人/Transfer金额核验。 | A |
| /Users/rhett/citizenserve/topup/settlement.rs | 运维令牌、claim、完整双链结算与异常状态机。 | A |
| /Users/rhett/citizenserve/topup/ports.rs | 付款RPC、结算事实、订单事务与时钟的中性端口。 | A |
| /Users/rhett/citizenserve/chain/bootstrap.rs | App与CitizenSDK两个准确schema及轻客户端信任合同。 | A |
| /Users/rhett/citizenserve/chain/constitution.rs | 同一finalized锚点的已生效宪法与完整SCALE解码。 | A |
| /Users/rhett/citizenserve/chain/relay.rs | 已签名交易广播、持久硬顶、去重及不确定结果。 | A |
| /Users/rhett/citizenserve/chain/ethereum_rpc.rs | 26个公共EVM方法、JSON-RPC批量与有界参数。 | A |
| /Users/rhett/citizenserve/chain/settlement.rs | OnchainTransaction带备注转账的同块完整成功证据。 | A |
| /Users/rhett/citizenserve/chain/network_ports.rs | 广播、公共EVM、展示缓存和固定HTTP源的中性端口。 | A |
| /Users/rhett/citizenserve/downloads/routes.rs | 下载和发布指针精确路径/平台/预算。 | A |
| /Users/rhett/citizenserve/downloads/release.rs | 正式GitHub Release/资产/仓库/标签的完整核验。 | A |
| /Users/rhett/citizenserve/downloads/publication.rs | 专用HMAC、完整实际路径、平台指针与revision CAS。 | A |
| /Users/rhett/citizenserve/downloads/service.rs | App/Wallet/链安装包与macOS updater交付。 | A |
| /Users/rhett/citizenserve/downloads/ports.rs | 正式Release读取、指针事务与缓存的中性端口。 | A |
| /Users/rhett/citizenserve/server/cloudflare/topup.rs | 配置/令牌装配与充值/结算handler。 | A |
| /Users/rhett/citizenserve/server/cloudflare/downloads.rs | GitHub固定源和发布HMAC handler。 | A |
| /Users/rhett/citizenserve/server/cloudflare/network.rs | 固定Base RPC、公共CitizenChain EVM与受控广播适配。 | A |
| /Users/rhett/citizenserve/server/cloudflare/cache.rs | 已有SQUARE_CACHE绑定的有界展示缓存；不缓存资金授权结论。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/topup.rs | D1付款去重、claim、settled/exception原子事务。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/relay.rs | D1持久IP限量、唯一广播占用/结果。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/downloads.rs | 独立下载D1平台指针、严格CAS与幂等。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/insert_topup.sql | 订单与付款意图/链交易双唯一占用。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/claim_topup.sql | 不自动过期的排他claim。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/settle_topup.sql | 完整证据一致后的paid原子更新。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/exception_topup.sql | 匹配claim的准确异常终态。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/relay_attempt.sql | 十分钟广播占用与持久硬顶。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/publish_download.sql | 仅目标平台revision条件更新/撤回。 | A |
| /Users/rhett/citizenserve/test/topup_contract.rs | 真实HMAC/意图TTL/精确金额/恶意EVM响应。 | A |
| /Users/rhett/citizenserve/test/settlement_contract.rs | metadata驱动完整交易、实际phase、转账事件与严格重试。 | A |
| /Users/rhett/citizenserve/test/chain_services_contract.rs | 引导schema、宪法完整解码、广播限制/结果。 | A |
| /Users/rhett/citizenserve/test/ethereum_rpc_contract.rs | 26方法、批量ID/通知/参数/响应边界。 | A |
| /Users/rhett/citizenserve/test/downloads_contract.rs | 发布HMAC金标、完整路径、资产身份与重放。 | A |
| /Users/rhett/citizenserve/test/external_storage_contract.py | 真实SQLite并发付款去重/claim/广播占用/发布CAS及回滚。 | A |
| /Users/rhett/citizenserve/test/contract/topup.json | 公开合成HMAC意图和EVM付款向量。 | A |
| /Users/rhett/citizenserve/test/contract/settlement.json | 公开合成完整metadata/结算交易/事件向量。 | A |
| /Users/rhett/citizenserve/test/contract/downloads.json | 公开发布HMAC、平台指针和正式Release向量。 | A |
| /Users/rhett/citizenserve/test/contract/ethereum_rpc.json | 26方法、批量及恶意RPC向量。 | A |

### 拟修改文件（20个，均由A修改，含任务卡）

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/topup/mod.rs | 导出新服务，保留报价、三态与claim不自动过期规则。 | A |
| /Users/rhett/citizenserve/chain/mod.rs | 导出引导/宪法/广播/EVM/结算；Relay输入恢复signed_extrinsic_hex准确字段。 | A |
| /Users/rhett/citizenserve/chain/transaction.rs | 抽出metadata驱动通用signed/finalized证明；原SquarePost包装及CID核验保持。 | A |
| /Users/rhett/citizenserve/downloads/mod.rs | 导出下载/发布服务并切换统一downloads路径。 | A |
| /Users/rhett/citizenserve/server/routes.rs | 精确登记四种权限类别及全部API，不用前缀绕过账户守卫。 | A |
| /Users/rhett/citizenserve/server/cloudflare/lib.rs | 按域名/精确路由/权限分派，保留现有业务守卫。 | A |
| /Users/rhett/citizenserve/server/cloudflare/chain.rs | 固定Access源中增加受类型限制的广播/EVM请求；六个只读RPC白名单保持。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/mod.rs | 导出财务/广播/下载适配；独立权限事务不复用会话AUTH_ASSERT。 | A |
| /Users/rhett/citizenserve/server/cloudflare/schema.sql | 收敛topup/relay现有表的证据一致性、唯一占用和索引；不新增影子账户或发送中订单状态。 | A |
| /Users/rhett/citizenserve/server/cloudflare/download-schema.sql | 四平台指针严格一致性与CAS断言；仍独立一表。 | A |
| /Users/rhett/citizenserve/server/cloudflare/wrangler.toml | 声明已有下载D1/SQUARE_CACHE、公共RPC域和本步准确配置/专用秘密；不执行线上装配。 | A |
| /Users/rhett/citizenserve/Cargo.toml | 登记五组新Rust合同测试；锁定付款钱包验签所需最小ECDSA/Keccak纯Rust依赖。 | A |
| /Users/rhett/citizenserve/Cargo.lock | 仅随本步所需ECDSA/Keccak依赖的明确固定版本更新；其他版本不批量升级。 | A |
| /Users/rhett/citizenserve/test/route_contract.rs | 权限分类、完整/api路径、未知字段/旧别名与host拒绝。 | A |
| /Users/rhett/citizenserve/test/contracts.rs | 基础Relay/下载模型按准确新字段和路径更新。 | A |
| /Users/rhett/citizenserve/test/storage_contract.py | 增加重复DDL的财务/广播约束验收，保持32+1表合同。 | A |
| /Users/rhett/citizenserve/test/membership_contract.rs | 通用完整交易证明抽取后回归原会员动作与非SquarePost拒绝。 | A |
| /Users/rhett/citizenserve/CitizenServe.md | 本步准确接口/证据/限制及下一步完整方案。 | A |
| /Users/rhett/citizenserve/README.md | 实施状态和完整检查入口。 | A |
| /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md | 实际执行结果、验收证据、文件边界与第6步方案。 | A |

### 只读复用文件（20个，不改写）

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/server/guard.rs | 现有账户服务守卫，不改变统一真人准入/MLS合同。 | A只读复用 |
| /Users/rhett/citizenserve/user/registration/protocol.rs | 冻结注册范围、源和创世哈希，禁止候选CID。 | A只读复用 |
| /Users/rhett/citizenserve/user/identity.rs | 当前绑定与60秒授权期限。 | A只读复用 |
| /Users/rhett/citizenserve/user/projection.rs | CID投影/换绑/撤销逻辑。 | A只读复用 |
| /Users/rhett/citizenserve/user/auth/mls_authentication.rs | 实际请求签名与2MiB总上限。 | A只读复用 |
| /Users/rhett/citizenserve/user/auth/challenge.rs | 普通账户request挑战。 | A只读复用 |
| /Users/rhett/citizenserve/chain/finalized.rs | canonical finalized读取。 | A只读复用 |
| /Users/rhett/citizenserve/chain/identity.rs | 当前CID双向绑定与完整metadata/storage。 | A只读复用 |
| /Users/rhett/citizenserve/chain/scale.rs | 现有metadata驱动解码/多hasher键/完整u128工具。 | A只读复用 |
| /Users/rhett/citizenserve/chain/ports.rs | 现有只读RPC端口。 | A只读复用 |
| /Users/rhett/citizenserve/shared/crypto.rs | 既有SHA-256/BLAKE2/HMAC和常量时间比较。 | A只读复用 |
| /Users/rhett/citizenserve/shared/ids.rs | 规范CID/AccountId与ID。 | A只读复用 |
| /Users/rhett/citizenserve/shared/error.rs | 固定错误响应。 | A只读复用 |
| /Users/rhett/citizenserve/membership/projection.rs | 第4步同块会员投影。 | A只读复用 |
| /Users/rhett/citizenserve/8964/post_service.rs | 第4步发布/详情/删除链事实复用。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/auth.rs | 会话/设备/挑战保持不变。 | A只读复用 |
| /Users/rhett/citizenserve/scripts/check.sh | 已自动发现SQL测试的完整检查入口。 | A只读复用 |
| /Users/rhett/citizenchain/runtime/transaction/onchain/src/lib.rs | 真实OnchainTransaction::transfer_with_remark调用/事件字段，A只读。 | A只读复用 |
| /Users/rhett/citizenchain/runtime/public/legislation-yuan/src/lib.rs | 真实Laws/LawVersions/LawVersionLabels/不可修改清单，A只读。 | A只读复用 |
| /Users/rhett/tataconsole/tasks/塔塔聊天服务模块与公民途遇服务端集成.md | B卡及聊天分工，A只读、不代替B更新。 | A只读复用 |

### 本步生成物与结束条件

| 完整绝对路径 | 处理 | 唯一方 |
|---|---|---|
| /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm | 记录本步准确大小/SHA-256及装载格式检查，不能单独作为部署验收。 | A生成 |
| /Users/rhett/citizenserve/target/ | 已忽略的可再生Cargo缓存。 | A生成 |
| /Users/rhett/citizenserve/test/__pycache__/ | 全量验收后清理。 | A清理 |

必须逐项证明：未授权付款地址不能抢单；金额全程精确；错链/重组/失败交易/不足额不产生paid；不确定广播与持久claim不自动释放重发；同链交易不结算两单；下载只指向真实固定平台资产；发布HMAC签实际/api原始正文，旧revision/其他凭据不能改指针；公共EVM未知方法不代理；旧授权/社区/内容合同仍通过。完成本步再更新结果、完善注释/测试、清理残留并输出第6步完整技术方案。本步不执行真实付款、签名广播、线上结算/发布指针变更或生产部署。B边界保持不变，A不因此授权B改下一步或其他产品。


## 第5步执行结果（2026-10-08）

用户确认的第5步已完成。新增42个文件、修改19个CitizenServe既有文件及本任务卡；实施前登记的19个本地/链只读文件摘要未改变。所有改动归线程A，A未修改B代码或任务卡；结束复核时B任务卡已由其他线程更新，保留其内容，不将此计为A的源码改动。实施前清单保留在上节，以下记录最终行为和验收。

1. **接口与权限。** 恢复9项充值/结算、15项下载/发布、4项链工具API，共28项方法；使用唯一/api功能路径。独立POST https://nrcrpc.crcfrcn.com/只在准确主机根路径提供26方法的EVM代理。工具、付款意图、结算令牌与发布HMAC均不能取得账户服务权限；原八授权入口、30账户业务入口和统一注册顺序不变。所有新接口按实际路由登记正文、查询和限速，不恢复旧别名。
2. **付款不能被观察者抢单。** HMAC意图绑定完整报价/目标/付款地址/链和十分钟期限。确认要求付款钱包对服务端生成的完整消息签名；EOA采用真实Keccak/ERC-191/low-S secp256k1恢复，ERC-1271在已核实付款块读取代码并检查准确ABI返回。合约签名保留原字节，不错误套用EOA的v规范化。配置与输入全程使用精确整数；Base 8453、两条原有币轨和套餐金额不改。固定原代币地址，并在每次付款核验中读取真实decimals=6；本机合成RPC测试不冒充当前线上代币/节点验收。
3. **订单与结算依赖完整链事实。** 验证交易/成功receipt/唯一足额Transfer、实际区块与交易位置、签发后且到期前的付款时间、finalized或准确确认数，并在结束前再查canonical hash。意图、付款和授权摘要原子写入原topup_orders；同付款/同意图双唯一，重试不重复打付款RPC。目标AccountId读取实际CID双向绑定，未绑定才能为null；RPC故障、反向缺失或吊销不能冒充未注册。全球300次/60秒预算按**实际Base RPC调用次数**扣量。SETTLE_TOKEN取单后的claim永久持久化；不确定结果不会自动解锁。paid必须核实完整GMB transfer_with_remark签名交易、指定出币账户、准确目标/金额/订单remark、System成功及同phase实际事件，同GMB交易不可结算两单。runtime升级区块使用执行该区块的parent runtime解析调用/事件，storage仍用post-state。
4. **下载与发布。** App/Wallet Android只读取固定产品仓的正式Release及准确平台资产。公民链四平台发布指针保留在独立下载库，只恢复macOS updater。publication GET/PUT使用专用HMAC，绑定实际/api路径和原始正文；明确null撤回，revision CAS与规范结果幂等。读取或修改指针时核对真实Release Tag提交SHA和GitHub资产SHA-256，拒绝不符源码/资产/仓/标签的结果；展示缓存最长300秒，不能作为签名、付款或授权事实源。
5. **链工具与RPC。** App/SDK引导各保留准确schema、冻结创世/状态根和实际/api服务位置，未核实bootnodes不猜填。宪法完整读取同一canonical finalized块的当前生效版本、标签和不可修改清单，验证层级、哈希、BoundedVec及尾字节。广播默认RELAY_ENABLED=0；显式启用后才向固定Access节点提交完整已签交易。20次/IP/60秒硬顶和持久排他去重先于网络请求；明确InvalidTransaction才记failed，超时、AlreadyImported、hash不符等保留unknown，submitting/unknown不会因十分钟窗口到期再次发送。公共RPC限制方法/参数/批次/ID/正文/响应预算，核对真实CitizenChain网络2027，拒绝错链、通知、重复字段/ID和任意上游地址；CORS覆盖成功与错误响应。
6. **依赖、注释与测试。** 仅增加锁定k256=0.13.4、sha3=0.10.9及必要传递依赖，并启用已有serde_json raw_value；共同库不引用worker/D1/R2。源码注释覆盖钱包签名字节、canonical证据、持久claim、不确定广播、CAS和缓存边界。新增测试执行真实密码学及生产SQL，并检查错误链/重组/错误事件/金额/目标/签名/时效、runtime升级、完整宪法、26 RPC方法和下载源。

验收命令为在 /Users/rhett/citizenserve 执行sh scripts/check.sh：**143项Rust测试、95项真实SQLite合同测试全部通过**；fmt、核心all-targets与Cloudflare WASM Clippy（-D warnings）、WASM Release全部通过。多连接SQLite包含24竞争者抢意图/付款/claim/结算交易/广播/发布CAS，证明只有一个规范结果；覆盖永久claim、unknown广播、旧revision、事务回滚及真正300次RPC硬顶。WASM另经Node WebAssembly.compile通过，大小5347752字节，SHA-256为a823ac1862482a36e54b5c02b6fcd9442c301f4af07e3aa72be77ed45d0c12e9，导出fetch/scheduled。

主库仍为32表，独立下载库仍为1表；没有新增金融影子表或用户体系。67个历史源码摘要再次与删除前Git快照逐一吻合，旧src/npm工程仍不存在，本轮测试产生的Python缓存已清理。测试RPC/metadata/Release使用合成夹具；真实密码学和SQLite通过不能代替线上Worker、D1/R2、链RPC、Siteverify或支付验收。当前只有Cargo WASM，没有完整Worker JS装载包；health继续account_services_ready:false。A未执行提交/推送/部署，未执行线上DDL、真实付款/广播/结算或发布指针修改。

注册主线始终是：点击确认注册→Cloudflare验证→CitizenServe保存通过结果→原钱包签名、上链与finalized完成CID注册→MLS设备授权激活→账户服务。没有候选CID，没有再次弹Cloudflare。App编排在第8步接入；聊天模块在第7步按B的公开合同接入。

## 第6步完整技术方案（已完成，保留实施前确认清单）

本步恢复公民App普通应用推送端点、持久通知任务、Queue消费、Cron补投影与清理，并生成能在本地workerd装载的完整Rust Worker包。唯一执行与修改方为A。第6步的“完整Cloudflare装配”指当前CitizenServe所需绑定、队列/定时入口和**本地**装载/检查；正式CI、构建发布控制与生产切换仍在第8步。聊天唤醒/MLS消息/聊天附件由CitizenServe.tatachat负责；第7步已完成获准源码装配，真实数据面验收仍归关联聊天任务第5步。本步不修改App/SDK/钱包/链、B、其他产品，不实现未来自建迁移。

### 分步骤实施与业务合同

1. **补齐当前设备的端点API。** 新增PUT/DELETE /api/notifications/endpoint，走现有purpose=request挑战、Bearer会话、新鲜X-MLS-Proof和写事务授权复核。CID、账户、修订、设备只取服务端已验身份；不允许正文自报device_id。PUT准确四字段push_provider、push_token、apns_environment、expires_at；APNs环境为sandbox/production，FCM必须显式null，Unix毫秒期限在当前时间之后且≤90天。APNs token规范64位hex，FCM有界可打印token；请求≤16KiB。每CID最多8个有效端点，当前设备同结果幂等、轮换递增endpoint_revision。同provider/token保持唯一，**不静默抢占其他有效设备/CID的token**；原属主先用授权DELETE释放，或服务端证实原端点已过期/原设备与绑定已撤销后才可登记。DELETE空正文，只删除当前已授权设备端点。同一设备轮换、TTL续期、换绑或吊销使旧代际任务失效。不会新增Cloudflare验证或生成MLS密钥。
2. **先持久化通知，再交Queue。** 主库增加notification_jobs、notification_deliveries、maintenance_jobs、scheduler_leases四表，主库32→36，下载库仍1；现有push_endpoints增加单调endpoint_revision，会员清理提醒绑定同一权益失效周期。帖子确认事务同时写唯一post_id/tx_hash来源的outbox，失败全回滚，幂等发布不重复生成任务。清理提醒同样和提醒事实原子持久化。消息仅携带版本、固定任务类型和数据库job_id/delivery_id，不传任意URL、token或客户端推送正文；消费者重新读取D1权威事实。投递记录固定目标CID/绑定修订/设备/端点代际、来源和截止时间。Queue发送失败时保留未派发任务，五分钟调度补派；Queue重复消息只取得一个CAS租约，不重复建收件记录。
3. **把扇出和发送拆为不同消费轮次。** 恢复现有NOTIFY绑定和citizenserve队列，max_batch_size=1、max_retries=3。扇出每页最多5个粉丝、40个端点，按(created_at,CID)稳定游标只选择通知开关开启且关注关系有效的粉丝；写入去重delivery和推进游标同事务，后续分页可续跑。每个发送任务只处理一个端点，发送前重新核实当前CID双向绑定、真人准入/MLS设备未撤销、端点代际/期限、关注开关、来源帖子仍published；链未知则重试，不能当合法发送。系统任务用独立私有事实证明/端口，不伪造普通用户Authorization或消费用户nonce。租约120秒、续租≤45秒；网络调用前检查租约剩余时间。每个工作单元最多4次持久发送尝试，超过后记blocked，不由Cron无限重置。只有D1终态提交后ack；可重试失败保留并retry，预算不足保存游标/下一执行时间。所有子请求共用45次业务预算并预留5次提交/续跑，外连并发≤4，不能在一个消费轮次直接发送40台设备。
4. **恢复APNs/FCM固定源发送。** APNs采用Cloudflare WebCrypto ES256签JWT，APNS_KEY只来自运行环境秘密，APNS_KID/APNS_TEAM/APNS_TOPIC为配置；准确访问https://api.push.apple.com/3/device/{token}或https://api.sandbox.push.apple.com/3/device/{token}。FCM以FCM_KEY/FCM_EMAIL签RS256服务账户JWT，通过https://oauth2.googleapis.com/token取得限定firebase.messaging scope的短期令牌，只向https://fcm.googleapis.com/v1/projects/{FCM_PROJECT}/messages:send发送。私钥不入D1/KV/日志或共同库。每次网络10秒、有界16KiB响应、禁止重定向，最终推送载荷≤4096B，只包含公开广场通知或存储提醒；不包含MLS密文/联系人/聊天资料。APNs 410/明确BadDeviceToken、FCM UNREGISTERED仅按原endpoint_revision条件删除失效端点；鉴权配置错误不误删，429/5xx有界退避并保存next_attempt_at。provider成功只表示accepted，不宣称设备已收到。外部成功而D1落库失败可能重发，固定collapse/tag减少重复展示；不能承诺跨外部系统严格恰好一次。Queue与D1去重、最多四次和单调状态保证重试有界。[Queue确认/重试规则](https://developers.cloudflare.com/queues/configuration/batching-retries/)、[Apple token认证](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)、[FCM授权](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[FCM错误码](https://firebase.google.com/docs/cloud-messaging/error-codes)作为实现依据。
5. **恢复有界Cron与两个链投影。** 保留*/5 * * * *，恢复4 3 * * *。scheduled只取得对应调度槽的持久租约并创建固定maintenance任务；同一触发重复执行不重建。身份与会员各最多顺序补10个块，会员进度不越过已完成身份投影；每轮受统一预算约束，整块CAS提交后才推进游标，预算不足拆到下一次消费，不能把“最多10块”当成一次必须跑满。遗漏或重试不会跳块。认证清理每表每轮≤1000行，清理过期挑战、会话、失效/过期端点、过期登记能力和七天以上已完成通讯录操作；生效准入和业务资料不受TTL垃圾清理影响。pending登记仍按原10分钟/verified24小时合同，不因调度延迟扩大有效期。已终止通知记录保留7天，blocked保留诊断；没有删除topup_orders、永久财务claim或submitting/unknown广播记录的通用TTL语句。
6. **恢复过期上传、长期超额存储和R2审计。** 未开始写入的过期预留原子释放一次；writing、完成但未发布的上传及资料临时代际先核实凭据期限/对象与当前引用，持久保留对象定位和每项进度，再分批删除。不能盲删正在写入对象，也不删除已发布帖或新的头像代际。会员权益失效满30天且实际云存储超过Freedom 100GB时，先写可查询提醒和推送任务；至少24小时后按最旧内容回收至阈值，每次扫描最多3 CID、处理最多4内容项，子请求预算更早耗尽则续跑。GET /api/membership增加storage_cleanup_notice（null或同周期notified_at/cleanup_after/storage_limit_bytes），用户离线或没有推送端点也有持久提醒；提醒已创建与provider已accepted分别记录。提醒以本次实际失效时间为周期，续费恢复或低于阈值取消；每个破坏性批次前重新核实新鲜canonical资格及当前代际，RPC不明不删。删除先保存R2/CDN定位，再删主文件/衍生图/manifest和purge，全部确认后才释放D1存储一次，不退款月用量、不删链上内容事实。旧故障任务重试仍复核当前资格；续费后的剩余对象停止删除，已执行云删除无法恢复的事实保留。日常审计在UTC03:04形成带日期游标任务，分页检查管理对象、D1引用、删除重试及孤立对象；无法证明归属/失效的对象只记审计结果，不能仅凭前缀或“查不到一行”删除。每天任务错过触发后仍从持久游标补齐，不依赖精确某一秒运行。
7. **生成并本地装载完整Worker。** 平台依赖只留server/cloudflare；worker=0.8.5启用queue和必要WebCrypto特性，共同库保持平台中立。绑定保持DB、CITIZENCHAIN_DOWNLOAD_DB、SQUARE_PRIVATE、SQUARE_PUBLIC_MEDIA、SQUARE_CACHE、三限速器，恢复NOTIFY和两个Cron；加入APNS_KEY/FCM_KEY秘密名称与推送公开配置校验。没有验证过的CHAIN_URL/ZONE_ID/推送标识不猜填，缺项只令对应功能明确不可用。固定worker-build=0.8.5、匹配wasm-bindgen=0.2.127，从Cloudflare crate运行--out-dir ../../target/cloudflare/worker --release -- --locked。按官方实际输出使用/Users/rhett/citizenserve/target/cloudflare/worker/index.js作为Wrangler main；替换当前尚未生成的旧shim目标，工具生成的兼容shim只作构建产物。用隔离的test/worker工具包锁定旧已登记wrangler=4.121.0和其配套miniflare=5.20260804.1-alpha，Node=25.2.1；它只提供本地workerd测试，不重建TypeScript业务工程。验证fetch/queue/scheduled真实装载和本地D1/R2/Queue调用，所有外部链/推送请求由测试拦截器接管，禁止实际联网发通知或付款。构建脚本只构建/检查，不包含deploy/remote D1/Release创建。[worker-build 0.8.5实际输出与入口](https://github.com/cloudflare/workers-rs/blob/v0.8.5/worker-build/src/main.rs)、[相对crate的输出目录规则](https://github.com/cloudflare/workers-rs/blob/v0.8.5/worker-build/src/build/mod.rs)已核实。45+5是本产品保守预算，不据此宣称任何Cloudflare套餐CPU/线上性能验收；[平台预算说明](https://developers.cloudflare.com/workers/platform/limits/)供核对。
8. **验收、注释、清理并输出第7步方案。** 测试真实生产SQL与多连接竞争、真实WebCrypto/JWT和本地workerd；RPC/推送使用公开合成响应并明确区分。覆盖无会话/无MLS/过期身份不能登记，跨CID/token抢占、8端点竞争、代际轮换/撤销、发布与outbox原子回滚、40收件分页、Queue重投/崩溃/CAS/预算/终态ack、APNs/FCM准确失效分类/429/签名、错误配置无误删、两投影顺序与游标、30天/24小时边界、恢复会员取消、R2中途失败/继续/存储只释放一次、不确定金融记录保留。回归现有143 Rust/95 SQLite合同并新增本步测试，完整检查包含Worker本地装载。清理本步缓存/暂存构建文件，更新文档/任务卡及准确检查数据，再给出第7步全部路径与B交接合同，等待确认。health继续account_services_ready:false；聊天、App全链路与正式发布未验收前不改成整产品ready。

### 完整请求地址与准确权限

| 方法与完整请求地址 | 内部规范化路径 | 输入与授权 |
|---|---|---|
| PUT https://www.crcfrcn.com/api/notifications/endpoint | /notifications/endpoint | 四字段push_provider、push_token、apns_environment、expires_at；Bearer+新鲜MLS实际路径证明，写事务复核当前设备，16KiB。 |
| DELETE https://www.crcfrcn.com/api/notifications/endpoint | /notifications/endpoint | 空正文；只删除当前已授权设备端点，同样要求Bearer/MLS。 |
| POST https://www.crcfrcn.com/api/user/challenges | /user/challenges | 既有准确六字段；purpose=request增加上述两个实际/api目标，不接受其他推送管理路径。 |
| GET https://www.crcfrcn.com/api/membership | /membership | 既有空正文/Bearer/MLS接口，响应增加本人本周期storage_cleanup_notice；不新增清理管理API。 |

新增两个受保护方法后账户业务30→32，原八授权及第5步28项工具API不改。Queue/Cron是Cloudflare事件入口，没有公网HTTP任务执行、推送任意载荷或重试财务接口。推送HTTP地址固定在平台适配层；MLS证明仍覆盖实际方法、完整/api路径/查询和原始正文。

### 拟新增文件（40个，实施前清单；现已全部创建）

| 完整绝对路径 | 作用 | 唯一修改/执行方 |
|---|---|---|
| /Users/rhett/citizenserve/notifications/endpoint.rs | 端点准确请求/响应、期限/容量/代际与当前设备业务服务。 | A，拟新增 |
| /Users/rhett/citizenserve/notifications/jobs.rs | 持久任务、来源去重、状态/期限/租约和精确消息类型。 | A，拟新增 |
| /Users/rhett/citizenserve/notifications/fanout.rs | 最多5粉丝/40端点的稳定游标与原子分批扇出。 | A，拟新增 |
| /Users/rhett/citizenserve/notifications/delivery.rs | 单端点发送编排、资格再核验、重试与accepted语义。 | A，拟新增 |
| /Users/rhett/citizenserve/notifications/ports.rs | 端点/任务/原子fanout/发送事实与供应商中立端口。 | A，拟新增 |
| /Users/rhett/citizenserve/server/maintenance.rs | 固定维护任务、调度槽、租约和统一请求/时间预算。 | A，拟新增 |
| /Users/rhett/citizenserve/membership/cleanup.rs | 30天失效周期/24小时提醒及新鲜清理资格证明。 | A，拟新增 |
| /Users/rhett/citizenserve/8964/maintenance.rs | 过期预留、对象定位、分批回收与审计规则。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/notifications.rs | 端点HTTP接入现有守卫、响应及预算。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/push.rs | WebCrypto JWT、固定APNs/FCM源、错误分类与有界网络。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/queue.rs | NOTIFY消息校验、消费、单条ack/retry和预算适配。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/scheduled.rs | 五分钟/日常触发、固定任务持久补派与租约。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/maintenance.rs | 链/D1/R2/CDN有界维护适配及暂停/续跑。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/push_endpoints.rs | 当前设备端点原子限量、token归属/代际和条件撤销。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/notification_jobs.rs | D1 outbox/扇出/单端点尝试与终态CAS。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/maintenance.rs | D1维护资格、调度槽、游标、持久提醒及回收账务。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/register_push_endpoint.sql | 授权复核、8端点硬顶、token排他和代际单调登记。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/delete_push_endpoint.sql | 当前设备授权删除/失效token代际条件撤销。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/enqueue_notification.sql | 通知来源唯一及提醒事实/outbox原子写入。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/claim_notification_job.sql | 任务/投递租约与持久尝试次数CAS。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/commit_fanout.sql | 同页收件去重、游标推进与下一页任务原子提交。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/complete_delivery.sql | accepted/cancelled/blocked或next_attempt_at提交。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/schedule_maintenance.sql | 固定调度槽/任务排他与错过触发后的补齐。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/claim_maintenance_job.sql | 维护租约、资格快照与版本CAS。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/progress_maintenance_job.sql | 对象/分页/投影进度和重试的单调持久提交。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/begin_background_delete.sql | 新鲜周期资格/对象代际断言及删除定位原子保存。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/finish_background_delete.sql | 全部对象/CDN完成后释放存储一次并保存完成事实。 | A，拟新增 |
| /Users/rhett/citizenserve/server/cloudflare/sql/release_expired_upload.sql | 非writing过期预留原子释放，writing仅进入可核实维护任务。 | A，拟新增 |
| /Users/rhett/citizenserve/scripts/build-worker.sh | 锁定工具/相对crate输出的本地Worker构建，无部署命令。 | A，拟新增 |
| /Users/rhett/citizenserve/scripts/check-worker.sh | 本地完整装载包、绑定/事件入口和测试检查。 | A，拟新增 |
| /Users/rhett/citizenserve/test/notifications_contract.rs | 端点/扇出/投递/租约/代际/重试核心合同。 | A，拟新增 |
| /Users/rhett/citizenserve/test/maintenance_contract.rs | 清理周期/预算/投影顺序/对象故障与续跑。 | A，拟新增 |
| /Users/rhett/citizenserve/test/notification_storage_contract.py | 生产通知SQL真实SQLite与多连接并发。 | A，拟新增 |
| /Users/rhett/citizenserve/test/maintenance_storage_contract.py | 生产维护SQL真实SQLite、回滚和清理去重。 | A，拟新增 |
| /Users/rhett/citizenserve/test/contract/notifications.json | 公开推送端点/消息/供应商响应与预算夹具。 | A，拟新增 |
| /Users/rhett/citizenserve/test/contract/maintenance.json | 公开清理周期/代际/对象失败及调度夹具。 | A，拟新增 |
| /Users/rhett/citizenserve/test/worker/package.json | 仅本地workerd/Wrangler测试工具与固定版本。 | A，拟新增 |
| /Users/rhett/citizenserve/test/worker/package-lock.json | 本地JS测试工具依赖完整锁定。 | A，拟新增 |
| /Users/rhett/citizenserve/test/worker/worker_smoke.mjs | 实际WASM/JS在本地workerd的fetch/queue/scheduled smoke。 | A，拟新增 |
| /Users/rhett/citizenserve/test/worker/push_crypto.mjs | 公开测试密钥ES256/RS256真实WebCrypto互操作与伪造拒绝。 | A，拟新增 |

### 拟修改既有文件（30个，含任务卡）

| 完整绝对路径 | 作用 | 唯一修改/执行方 |
|---|---|---|
| /Users/rhett/citizenserve/notifications/mod.rs | 导出新服务并移除不匹配旧四字段合同的未接线Endpoint模型。 | A |
| /Users/rhett/citizenserve/notifications/routes.rs | 唯一endpoint PUT/DELETE及方法/正文预算。 | A |
| /Users/rhett/citizenserve/server/mod.rs | 导出维护业务模块。 | A |
| /Users/rhett/citizenserve/8964/mod.rs | 导出媒体维护核心。 | A |
| /Users/rhett/citizenserve/membership/mod.rs | 导出清理/提醒核心。 | A |
| /Users/rhett/citizenserve/membership/service.rs | 既有current响应交付本人当期storage_cleanup_notice。 | A |
| /Users/rhett/citizenserve/membership/ports.rs | 增加同一授权scope的提醒读取端口。 | A |
| /Users/rhett/citizenserve/server/routes.rs | 将两个实际/api端点纳入精确普通请求挑战与账户服务。 | A |
| /Users/rhett/citizenserve/server/cloudflare/lib.rs | 新端点handler、queue入口及scheduled委托，保留统一错误/守卫。 | A |
| /Users/rhett/citizenserve/server/cloudflare/Cargo.toml | worker queue特性与所需WebCrypto接口。 | A |
| /Users/rhett/citizenserve/server/cloudflare/runtime.rs | 平台WebCrypto辅助与有界执行时钟，不向共同库引入平台类型。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/mod.rs | 导出端点/通知/维护存储适配。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/posts.rs | 发布事务返回/查询同一outbox结果，不先写业务后忘记通知。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/membership.rs | 授权提醒读取与同周期状态访问。 | A |
| /Users/rhett/citizenserve/server/cloudflare/schema.sql | 四任务表、端点代际、提醒周期和准确约束/索引。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/confirm_post.sql | 同一发布事务插入唯一通知outbox。 | A |
| /Users/rhett/citizenserve/server/cloudflare/sql/project_subscription.sql | 新权益恢复/周期变化时清除旧周期提醒，不改链事实。 | A |
| /Users/rhett/citizenserve/server/cloudflare/wrangler.toml | NOTIFY、两Cron、推送配置/秘密及实际index.js装载入口。 | A |
| /Users/rhett/citizenserve/Cargo.toml | 登记两个新增Rust合同测试，保持共同库平台中立。 | A |
| /Users/rhett/citizenserve/Cargo.lock | 仅必要平台特性导致的锁定变化，不整仓升级依赖。 | A |
| /Users/rhett/citizenserve/scripts/check.sh | 完整检查追加本地Worker包检查入口。 | A |
| /Users/rhett/citizenserve/.gitignore | 精确忽略本地测试node_modules/workerd缓存及构建暂存。 | A |
| /Users/rhett/citizenserve/test/route_contract.rs | 两个endpoint目标/权限/正文与旧工具/公共RPC回归。 | A |
| /Users/rhett/citizenserve/test/contracts.rs | 替换旧未接线端点测试/补新准确合同。 | A |
| /Users/rhett/citizenserve/test/membership_contract.rs | 当期持久提醒/会员恢复状态及旧响应回归。 | A |
| /Users/rhett/citizenserve/test/content_storage_contract.py | 原发布SQL加入outbox后的原子回滚与幂等回归。 | A |
| /Users/rhett/citizenserve/test/storage_contract.py | 主库36/下载1、重复DDL及原身份/财务约束回归。 | A |
| /Users/rhett/citizenserve/CitizenServe.md | 本步实际接口/文件/检查数据及第7步完整方案。 | A |
| /Users/rhett/citizenserve/README.md | 准确范围与本地Worker检查说明，保留未完成边界。 | A |
| /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md | 本步授权/结果/完整路径及第7步方案。 | A |

### 明确只读复用文件

| 完整绝对路径 | 作用 | 唯一修改/执行方 |
|---|---|---|
| /Users/rhett/citizenserve/server/guard.rs | 普通HTTP当前CID/真人准入/设备/会话/MLS统一守卫。 | A只读复用 |
| /Users/rhett/citizenserve/user/registration/protocol.rs | 既有注册协议/顺序不改。 | A只读复用 |
| /Users/rhett/citizenserve/user/identity.rs | 当前身份规则只读复用。 | A只读复用 |
| /Users/rhett/citizenserve/user/projection.rs | 身份canonical整块投影/catch-up只读复用。 | A只读复用 |
| /Users/rhett/citizenserve/user/auth/mls_authentication.rs | 实际/api证明和签名格式不改。 | A只读复用 |
| /Users/rhett/citizenserve/user/auth/challenge.rs | 现有一次性挑战业务复用。 | A只读复用 |
| /Users/rhett/citizenserve/chain/finalized.rs | canonical finalized锚点读取。 | A只读复用 |
| /Users/rhett/citizenserve/chain/identity.rs | 双向绑定与metadata/storage读取。 | A只读复用 |
| /Users/rhett/citizenserve/chain/subscription.rs | 当前真实平台订阅读取。 | A只读复用 |
| /Users/rhett/citizenserve/chain/ports.rs | 可由维护预算包装的中立RPC端口。 | A只读复用 |
| /Users/rhett/citizenserve/membership/projection.rs | 会员同块投影/catch-up及真实runtime解析。 | A只读复用 |
| /Users/rhett/citizenserve/membership/limits.rs | Freedom 100GB及既有三档额度。 | A只读复用 |
| /Users/rhett/citizenserve/8964/storage.rs | 中立对象/CDN存储端口。 | A只读复用 |
| /Users/rhett/citizenserve/8964/media.rs | 已有完整对象定位与媒体规则。 | A只读复用 |
| /Users/rhett/citizenserve/8964/post_service.rs | 用户主动发布/详情/删除业务合同。 | A只读复用 |
| /Users/rhett/citizenserve/user/profile_assets.rs | 当前头像代际与临时上传合同。 | A只读复用 |
| /Users/rhett/citizenserve/notifications/inbox.rs | 双游标通知已读/未读合同。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/auth.rs | 现有D1会话/设备/挑战权威存储。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/identity.rs | 身份投影原子事务及撤销。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/media.rs | 已有R2定位/账务实现供核实，维护另走私有端口。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/chain.rs | 现有Access RPC，预算包装不修改其真实结果。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/media.rs | 现有R2/CDN网络访问供维护复用。 | A只读复用 |
| /Users/rhett/citizenserve/server/cloudflare/download-schema.sql | 下载独立1表结构不改。 | A只读复用 |
| /Users/rhett/citizenserve/topup/settlement.rs | 永久claim与结算证据不变，禁止后台TTL清除。 | A只读复用 |
| /Users/rhett/citizenserve/chain/relay.rs | 不确定广播永久去重，不作为过期垃圾清理。 | A只读复用 |
| /Users/rhett/citizenserve/shared/crypto.rs | 已验收摘要/HMAC算法不变。 | A只读复用 |
| /Users/rhett/citizenserve/shared/ids.rs | 账户/CID/标识规范不变。 | A只读复用 |
| /Users/rhett/citizenserve/shared/error.rs | 固定错误码机制复用。 | A只读复用 |
| /Users/rhett/tataconsole/tasks/塔塔聊天服务模块与公民途遇服务端集成.md | B的任务卡及公开交接边界，A不代更新。 | A只读 |

本步全部源码改动限于上述40个拟新增和30个拟修改文件；实施前保存修改/只读基线，验收时逐件核对。CitizenApp、CitizenSDK、CitizenWallet、CitizenChain、TataChatSDK、TataChatServer、旧两个聊天产品及其他消费方的文件均不属于本步修改范围。共用授权、链和金融规则复用不等于授权顺带重写；确有新增必要须先列准确路径与原因，再按逐步规则确认。

### 拟生成及清理的准确路径

以下为实施前已确认的Worker包/测试缓存生成清单，实际产物和清理结果见本步执行记录，均由A执行，不手改生成JS业务代码。worker-build默认关闭TypeScript声明，不声明不存在的index.d.ts；兼容shim由官方工具生成，Wrangler直接使用index.js。

| 完整绝对路径 | 处理及用途 | 唯一方 |
|---|---|---|
| /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm | Cargo Release及准确大小/SHA-256；更新本步验收记录。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index.js | 官方worker-build实际ESM入口，本地workerd装载及Wrangler main。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index_bg.wasm | 与ESM配对的wasm-bindgen产物，核对配套摘要。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/package.json | 官方生成包信息；不作为第二套产品源码/依赖。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/worker/shim.mjs | 官方兼容入口，构建产物，不再作为正式main。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/.gitignore | 官方create_pkg_dir生成的包忽略文件，内容为*。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/.tmp/ | 官方心跳锁/临时构建暂存；仅在确认本轮构建退出后清理残留。 | A生成/清理 |
| /Users/rhett/citizenserve/target/cloudflare/worker/.oldtmp/ | 官方失效构建暂存目录；不触碰活跃心跳锁，结束后按工具结果核对/清理。 | A生成/清理 |
| /Users/rhett/citizenserve/test/worker/node_modules/ | 锁定本地测试依赖缓存，忽略且不提交。 | A生成 |
| /Users/rhett/citizenserve/test/worker/.wrangler/ | 仅本地workerd/D1/R2/Queue测试持久数据，验收后清理本轮数据。 | A生成/清理 |
| /Users/rhett/citizenserve/server/cloudflare/.wrangler/ | 如本地Wrangler使用则准确盘点/清理本轮缓存。 | A生成/清理 |
| /Users/rhett/citizenserve/test/__pycache__/ | Python测试缓存，全量验收后清理。 | A清理 |
| /Users/rhett/citizenserve/target/ | 已忽略的可再生Cargo/工具缓存，不是运行源码。 | A生成 |

以上为第6步实施前已确认清单；本步现已完成，实际结果如下。原第7步独立TataChatServer公开库接入安排根据关联线程最新决定撤销，改为CitizenServe.tatachat宿主接线，须按B真实交接及下述完整方案逐步确认。

## 第6步执行结果（2026-10-08）

用户确认的第6步已完成本地实现与验收。实施前40个新增路径全部落地；实际修改28个CitizenServe既有文件及本任务卡，Cargo.lock核对后无需改动。实施前清单继续保留用于审阅。列为只读复用的28个CitizenServe源码/规范文件摘要均不变；B任务卡由关联线程自行更新。核对期间另观察到 /Users/rhett/citizenserve/chain/ethereum_rpc.rs 与 /Users/rhett/citizenserve/server/cloudflare/network.rs 的并行公共RPC主机变化，以及B经用户确认恢复的 /Users/rhett/citizenserve/scripts/flows.json 产品/记录元数据声明。本窗口未编辑这些内容，保留它们，不计入上述第6步新增/修改数。本文与测试使用当前实际公共地址https://nrcrpc.crcfrcn.com/。

1. **端点与权限。** PUT/DELETE https://www.crcfrcn.com/api/notifications/endpoint已接入现有Bearer、当前身份/真人准入/设备/会话及新鲜MLS守卫，MLS签实际/api路径与原始正文。PUT准确四字段，FCM的apns_environment必须显式null；TTL最长90天，每CID最多8个有效端点。令牌不能抢占其他有效设备，轮换及删除后重建均保持服务端单调代际；旧发送结果只能条件处理旧代际。原注册、CID算法、钱包与MLS密钥边界未改。
2. **持久任务与发送。** 帖子确认与通知outbox同事务，来源幂等；Queue消息仅携带固定版本/种类/ID。扇出每页最多5粉丝、40端点，收件记录与游标原子提交；发送每轮一个端点，重新核实链双向绑定、准入/设备、端点代际、来源和开关。120秒CAS租约由30秒定时器续期；丢失租约即停止本轮。业务45次子请求、提交预留5次共用预算。每单元最多4次持久尝试，blocked保留诊断且不被Cron重置；只有D1终态提交后ack。
3. **真实密码学、模拟外部服务。** Cloudflare WebCrypto生成APNs ES256与FCM RS256 JWT；私钥只来自运行环境。固定Apple/OAuth/FCM源、有界10秒网络/16KiB响应/4KiB推送。独立Node公钥验签验证实际Rust Worker输出；失效令牌按代际条件删除，topic/鉴权配置错误保留端点，429/5xx有界重试。accepted只表示provider接受；外部成功后D1失败仍可能重复，固定collapse/tag不能代替跨系统恰好一次。
4. **Cron和维护。** 五分钟任务与UTC03:04审计以持久槽去重、补派。身份先于会员，整块CAS游标；每类最多10块且预算优先，未完成读取的不可变块材料保存在同一maintenance任务中续跑。认证TTL每表有界，不删除生效准入、未ACK通讯录密文、永久财务claim或unknown广播。过期未写预留只释放一次；对象删除先持久定位/阶段，再删R2与purge，全部完成后释放存储一次，不返还月用量。
5. **长期超额清理。** 权益失效30天且超过Freedom 100GB才持久提醒；GET https://www.crcfrcn.com/api/membership返回本周期storage_cleanup_notice，至少24小时后方可回收。每个破坏性批次重新核验当前canonical资格与代际；续费停止剩余删除。部分云删除后遇续费或未知状态，保留定位/账务与blocked诊断，不假称对象可恢复或已全部释放。日审计分页核对D1引用和两个R2桶；不能证明归属/失效的对象仅诊断、保留原物。
6. **完整Worker。** worker/worker-build=0.8.5、wasm-bindgen=0.2.127，官方生成index.js/index_bg.wasm；Wrangler main已改为实际index.js。Node25.2.1、Wrangler4.121.0、Miniflare5.20260804.1-alpha锁定在独立本地测试工具包，未恢复TS业务工程。源代码注释已说明授权、代际、CAS、预算、故障定位及accepted语义。

完整检查命令：在 /Users/rhett/citizenserve 执行sh scripts/check.sh，**161项Rust、116项真实SQLite、12项本地Worker/密码学测试全部通过，无失败/跳过**；fmt、核心all-targets/Cloudflare WASM Clippy(-D warnings)、locked Release、官方Worker构建及两个WASM的WebAssembly.compile通过。12项Node测试包含11项实际Rust Worker fetch/queue/scheduled测试和1项独立验签器测试；真实D1/R2/Queue本地绑定执行，不以自制JS业务代替Rust。额外验证32秒链读取触发同租约CAS续期、48收件端点按40+8分页、R2删除后purge失败保存定位并恢复一次账务释放。116项SQLite覆盖生产SQL原文和24写者竞争；链/metadata/provider仍为公开合成夹具，所有外部请求均被闭合白名单服务拦截。

| 本轮实际产物完整路径 | 大小与SHA-256 |
|---|---|
| /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm | 5845185字节；b2f0fee47520d27600ed8eb3e52cff4a3c0b129e80569ea920a04ad812e65aa2 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index.js | 32741字节；76d188bde3d474f2cefadfcaa7beeed8ec64c6168a682d76cb6ad1bec48aa034 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index_bg.wasm | 3105785字节；4b8e71250224e27f808f589a766bf8dbd904f984efb59754b75da488247fba1f |
| /tmp/citizenserve-step6-check.log | 本轮完整检查记录；退出码0。 |

主库36表、下载库1表。67项旧源码摘要再次逐一核对删除前Git快照吻合，旧src/npm工程未恢复。已清除本轮四个临时源码生成脚本和test/__pycache__；官方.tmp/.oldtmp及两个.wrangler测试目录不存在，锁定依赖与可复现构建产物保留在忽略缓存中。

**验收限制：** 锁定的本地workerd最多支持compatibility_date=2026-08-11，实际本地测试使用该日期；生产wrangler.toml保持2026-10-07。这次验证不能冒称同生产兼容日期、线上链/D1/R2/Siteverify、真实推送或支付已经验收。正式CI/发布仍归第8步。本窗口未提交/推送/部署，未执行线上DDL、资源创建、真实清理/推送/付款。health继续account_services_ready:false，App编排仍归第8步。

## 第7步技术方案：公民宿主授权归位与tatachat接入（用户已确认，实施中）

### 当前证据与实施顺序

2026-10-08按关联线程「塔塔聊天」及其唯一任务卡实施；原「聊天服务端」线程只保留历史。用户已把目标改为CitizenServe.tatachat承接全部通用Rust聊天服务端，独立TataChatServer迁入后由B按授权退役。A开工前只读方案时tatachat入口尚未交付；本次执行中B已写入28件功能目录源码，当前仍未完成协议生成/编译/CF交付。原chat只含公民Authority和会员许可，已由A迁出并删除。用户本次再次确认Cloudflare适配由「塔塔聊天」线程交付，维持原分工。

第7步分三个依赖阶段，编号不新增产品步骤：**7.1 A先迁出公民授权并冻结宿主合同 → 7.2 B按其单步授权交付通用核心和Cloudflare模块 → 7.3 A依据准确交接装配并完成本地数据面验收。** 本窗口确认不代替B的实施确认。B未交付时可以完成7.1的独立工作，但第7步整体保持未完成，不提前宣称聊天已接入或进入App/生产切换。B的Cloudflare适配文件、资源声明、协议准备与生成入口尚未冻结；收到后必须把真实完整路径及最终补丁补入本表并按用户规则确认，不能猜路径、造空壳或照搬旧独立Worker。

### 具体实施合同

1. **把公民授权移回所属模块。** user只输出守卫已核验的CID/设备/绑定修订/准入/会话事实，membership沿用当前独立会员资格和Plan计算chat_enabled/max_attachment_bytes及权益截止，server组合成通用许可。tatachat只能接收中性user_id/device_id、权限、期限和授权修订；不能导入CID解析、Plan、会员数据库或公民Authority。最长许可15分钟，裁剪至会话/权益及实际设备截止；再核验截止不超过身份期限且最长60秒。既有Freedom/Democracy/Spark聊天附件上限10MiB/100MiB/5120MiB保持，不改会员获取条件。
2. **设置唯一宿主许可接口。** POST https://www.crcfrcn.com/api/tatachat/access，准确正文{}、最多1KiB、无查询，Bearer普通会话+purpose=request一次性MLS证明。用户/设备/权益全部取服务端，不接受客户端CID、device_id、plan或权限。响应仅返回短期聊天凭证、expires_at、recheck_at及实际realtime_url；不能返回MLS私钥。此接口不再次验证Cloudflare、不新增钱包签名，不恢复旧/chat/auth。JWT仅作客户端短期传递；模块同进程调用使用可信宿主上下文，不能把客户端JSON反序列化成内部授权。
3. **冻结通用凭证与再核验。** 与B共同冻结EdDSA算法、准确iss/aud/purpose、user/device/authorization_revision、会话关联摘要、nbf/exp/recheck_at、chat_enabled/max_attachment_bytes及版本。绑定修订如何映射通用修订只由宿主解释；模块不能只验证JWT到期就保活15分钟。零宽容接受过期权限，当前链未知/反向绑定缺失/准入或设备撤销/会话失效均拒绝。WSS连接、恢复、每个命令、附件读写及唤醒投递必须在期限内；最长60秒到期前重新调用可信宿主状态端口，失败停止服务并关闭连接。签发私钥只在Cloudflare环境秘密，不入D1/日志/协议夹具；与MLS设备私钥完全独立。[Cloudflare WebCrypto支持Ed25519签名与导入](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)已核对；具体Rust导入/签名需本地workerd实际验收，不用文档代替测试。
4. **完整消费聊天功能。** B交付全部12类SDK Protobuf命令：Ping、发布/解析KeyPackage、发送/同步/ACK密文、开始/完成/ACK/中止附件、登记/移除聊天推送。保留字段编号、LastResort、每设备收件箱、幂等冲突、事务后回复/唤醒顺序及附件删除闭环。A只作宿主接线，不另写明文消息REST、MLS实现、影子聊天库或通用推送执行器。MLS密钥及内容加解密留在TataChatSDK；服务端只保存公开包、路由材料和密文。
5. **统一请求入口。** 数据面仅使用下表/api/tatachat路径，SDK基础地址不得用根路径resolve丢失前缀。WSS和附件使用专用聊天凭证与宿主当前授权复核，不能放入公开路由白名单或使用普通请求proof重放来维持长连接。模块从验证后的主体定位收件箱/附件，忽略或拒绝任何伪造内部身份头。WebSocket帧大小、附件分块/总量/哈希/归属/下载范围按B真实合同执行，不能把普通JSON正文预算套在二进制附件上。
6. **一个CitizenServe运行包。** server/cloudflare统一fetch/queue/scheduled出口、DO导出、绑定、CORS及错误映射；tatachat适配作为模块调用，不能导入第二套#[event(fetch/scheduled)]导出或转发到旧聊天服务。模块单独拥有聊天D1/R2/DO和唤醒资源声明，A只装配B已核实的名称/schema/类导出/ABI，不能挪用主库DB、普通NOTIFY、广场R2或下载库。聊天资源重建不能删除其他模块资源，也不等于历史数据恢复；本步只本地声明与测试，不创建线上资源或重建生产数据。
7. **锁定协议及依赖。** SDK三份.proto是唯一协议源；B交付真实Git提交、三文件SHA、协议版本、protoc与prost精确版本及准备入口。A统一修改Cargo.toml/Cargo.lock、根build.rs和现有构建接入；不复制旧服务锁文件，不从邻仓或退役仓猜路径加载源码/运行代码。协议输入只接受明确准备并验真的绝对路径，缺失即失败。旧服务当前protoc35.0与旧固定SDK提交仅作为核对证据，不自动成为新宿主批准的依赖。实际资源/协议生成路径在7.2交接后补齐准确清单再实施，不提前编造流程入口。
8. **本地验收、清理及交接。** 真实测试宿主权限、Ed25519签发/验签、WSS/DO休眠恢复、12命令、两设备密文与附件、多次ACK/重投、跨用户访问、修订/会话/会员撤销≤60秒、未知链拒绝、聊天推送当前资格、资源隔离。上一步161/116/12全量回归继续通过，不降低门禁。完善中文注释/文档/任务卡，清理本步缓存，记录完整包摘要及限制；第7步全部完成后才给第8步App统一注册接线与正式CI/发布技术方案。当前不改health为整产品ready、不部署、不退役独立旧服务、不开发途遇或自建运行端。

### 完整API地址与内部规范路径（均为第7步拟实现）

| 方法与完整请求地址 | 内部规范路径 | 输入及权限 |
|---|---|---|
| POST https://www.crcfrcn.com/api/tatachat/access | /tatachat/access | 准确{}，≤1KiB；现有Bearer+新鲜MLS，签实际/api/tatachat/access。 |
| GET wss://www.crcfrcn.com/api/tatachat/realtime | /tatachat/realtime | WebSocket升级；专用聊天凭证、当前宿主许可及≤60秒再核验，不接受查询token。 |
| PUT https://www.crcfrcn.com/api/tatachat/attachments/{attachment_id}/chunks/{chunk_index} | /tatachat/attachments/{attachment_id}/chunks/{chunk_index} | 原始密文分块；专用凭证、上传属主、块编号/尺寸/摘要及当前许可。 |
| GET https://www.crcfrcn.com/api/tatachat/attachments/{attachment_id}/chunks/{chunk_index} | /tatachat/attachments/{attachment_id}/chunks/{chunk_index} | 专用凭证、发送者/真实收件设备权限、分块范围及当前许可。 |
| POST https://www.crcfrcn.com/api/user/challenges | /user/challenges | 既有六字段；仅给access增加purpose=request准确目标，WSS/二进制传输不冒充同一HTTP proof。 |
| GET https://www.crcfrcn.com/api/health | /health | 既有唯一health，整体ready仍false；不增加模块公网health别名。 |

### A新增文件范围（11个：7.1已新增10个，build.rs仍待真实协议装配）

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/user/chat_access.rs | 从已验Authority提取当前用户/设备/会话事实；无会员计算。 | A |
| /Users/rhett/citizenserve/membership/chat.rs | 当前会员到中性聊天权限/额度/截止的映射。 | A |
| /Users/rhett/citizenserve/server/tatachat.rs | 组合宿主许可、15分钟/60秒期限、可信再核验端口。 | A |
| /Users/rhett/citizenserve/server/tatachat_routes.rs | access与模块数据面准确路由、权限与独立预算。 | A |
| /Users/rhett/citizenserve/server/cloudflare/tatachat.rs | 宿主许可HTTP、签发/再核验、调用B公开模块，不实现通用聊天业务。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/chat_access.rs | 使用现有身份/准入/设备/会话事实复核，拒绝客户端自报；不新增影子用户表。 | A |
| /Users/rhett/citizenserve/build.rs | 仅在B准确协议交接后接入锁定/验真输入及真实协议生成。 | A，共享生成接入 |
| /Users/rhett/citizenserve/test/tatachat_contract.rs | 宿主许可、期限、修订、私钥边界和中性权限测试。 | A |
| /Users/rhett/citizenserve/test/tatachat_storage_contract.py | 真实SQLite宿主准入/设备/会话/修订/撤销读合同。 | A |
| /Users/rhett/citizenserve/test/contract/tatachat.json | 公开的正反例凭证/协议合同，禁止写私钥或真实token。 | A |
| /Users/rhett/citizenserve/test/worker/tatachat_smoke.mjs | 实际Rust Worker/WSS/DO/D1/R2与闭合外部测试。 | A |

### A拟修改与删除既有文件

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/chat/mod.rs | 授权迁出并回归后删除，退出旧chat模块；不把公民逻辑更名塞入通用模块。 | A，拟删除 |
| /Users/rhett/citizenserve/lib.rs | 退出pub mod chat；在B模块交付后接入pub mod tatachat。 | A |
| /Users/rhett/citizenserve/user/mod.rs | 导出当前主体事实适配。 | A |
| /Users/rhett/citizenserve/membership/mod.rs | 导出会员聊天权限映射。 | A |
| /Users/rhett/citizenserve/server/mod.rs | 导出宿主许可与路由。 | A |
| /Users/rhett/citizenserve/server/routes.rs | 区分受MLS保护的access与受模块许可保护的数据面，拒绝未知路径/旧别名。 | A |
| /Users/rhett/citizenserve/Cargo.toml | 宿主统一依赖/真实测试目标/协议生成，版本按交接核对。 | A |
| /Users/rhett/citizenserve/Cargo.lock | 只更新确实必要的锁定依赖，不复制独立服务锁。 | A |
| /Users/rhett/citizenserve/server/cloudflare/Cargo.toml | 在当前Worker crate编入实际B适配、DO/WebSocket与签名必要特性。 | A |
| /Users/rhett/citizenserve/server/cloudflare/lib.rs | 唯一HTTP/事件与DO装配，保持现有业务入口。 | A |
| /Users/rhett/citizenserve/server/cloudflare/runtime.rs | 环境秘密中的宿主Ed25519签发，密钥不入共同库/日志。 | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/mod.rs | 导出宿主聊天状态读取适配。 | A |
| /Users/rhett/citizenserve/server/cloudflare/wrangler.toml | 仅装配B确实交付的聊天绑定/DO/任务合同；不猜资源ID。 | A |
| /Users/rhett/citizenserve/scripts/build-worker.sh | 接入已交接、验真的协议准备/生成输入，保持官方单Worker输出。 | A |
| /Users/rhett/citizenserve/scripts/check-worker.sh | 加入真实tatachat_smoke检查。 | A |
| /Users/rhett/citizenserve/scripts/check.sh | 保持全量门禁并检查新许可/模块回归。 | A |
| /Users/rhett/citizenserve/test/contracts.rs | 将旧chat::authorize调用迁为宿主许可调用，保留会员/会话期限断言。 | A |
| /Users/rhett/citizenserve/test/route_contract.rs | 新方法、完整/api证明目标签发、WSS与附件权限及未知路径拒绝。 | A |
| /Users/rhett/citizenserve/CitizenServe.md | 准确职责/交接/文件/API/验收及第8步方案。 | A |
| /Users/rhett/citizenserve/README.md | 更新当前能力、构建入口和真实限制。 | A |
| /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md | A授权、分阶段进度与准确结果。 | A |

### 第7步执行中测试装配补充（A）

增加修改准确路径 **/Users/rhett/citizenserve/test/worker/worker_smoke.mjs**：将已验收的真实Rust Worker启动/MLS请求证明/固定RPC夹具导出供新聊天许可smoke复用，原11项推送/维护测试保持；冻结同一合成块的Timestamp，避免每次读取同一块却返回不同时间。新验证位于已批准的 **/Users/rhett/citizenserve/test/worker/tatachat_smoke.mjs**，不复制第二套Worker业务或新增生产端点。A执行，B不修改；依据本次用户“执行过程中做对应更新”的测试装配范围登记。原主库schema及B通用核心目录仍只读。

### B已确认的功能目录交接范围（28个，B正在实施，A只消费）

用户在新线程「塔塔聊天」确认按功能分子目录，key_package目录改为key；A本步执行确认同时要求按此更新。2026-10-08开工核对时这些文件尚在B实施中，以实际交付为准，不建立第二套扁平文件。

| 完整绝对路径 | 作用 | 唯一修改方 |
|---|---|---|
| /Users/rhett/citizenserve/tatachat/mod.rs | 公开通用模块 | B |
| /Users/rhett/citizenserve/tatachat/service.rs | 跨功能命令协调/提交后副作用 | B |
| /Users/rhett/citizenserve/tatachat/tests.rs | 跨功能业务测试 | B |
| /Users/rhett/citizenserve/tatachat/auth/mod.rs | auth所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/auth/ports.rs | auth所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/auth/tests.rs | auth所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/protocol/mod.rs | protocol所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/protocol/command.rs | protocol所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/protocol/tests.rs | protocol所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/key/mod.rs | key所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/key/ports.rs | key所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/key/tests.rs | key所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/mailbox/mod.rs | mailbox所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/mailbox/service.rs | mailbox所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/mailbox/ports.rs | mailbox所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/mailbox/tests.rs | mailbox所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/attachment/mod.rs | attachment所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/attachment/service.rs | attachment所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/attachment/ports.rs | attachment所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/attachment/tests.rs | attachment所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/push/mod.rs | push所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/push/service.rs | push所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/push/ports.rs | push所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/push/tests.rs | push所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/realtime/mod.rs | realtime所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/realtime/session.rs | realtime所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/realtime/ports.rs | realtime所属模型/业务/接口/测试 | B |
| /Users/rhett/citizenserve/tatachat/realtime/tests.rs | realtime所属模型/业务/接口/测试 | B |

B的CF源码、聊天SQL/资源声明、DO类、协议准备/生成产物路径目前尚未交付。这里明确留为**未冻结的交接项**，不写虚构路径、不以其原standalone api::handle当成已经可组合的模块；7.3开始前必须拿到最终准确清单、ABI和检查证据。共享Cargo/lib/build.rs/server配置继续由A唯一写入，B只交补丁与接口；SDK及通用模块由B唯一写入。

### 明确只读复用文件

| 完整绝对路径 | 复用/核对用途 | 本窗口权限 |
|---|---|---|
| /Users/rhett/citizenserve/server/guard.rs | 既有Authority/当前身份、会话与准入守卫。 | A只读 |
| /Users/rhett/citizenserve/user/identity.rs | 当前CID、双向绑定及60秒期限。 | A只读 |
| /Users/rhett/citizenserve/user/auth/mls_authentication.rs | 原MLS请求证明算法与格式。 | A只读 |
| /Users/rhett/citizenserve/user/auth/challenge.rs | 原一次性挑战合同。 | A只读 |
| /Users/rhett/citizenserve/user/auth/device.rs | 已授权设备与撤销合同。 | A只读 |
| /Users/rhett/citizenserve/user/auth/session.rs | 普通会话及真实期限。 | A只读 |
| /Users/rhett/citizenserve/user/ports.rs | 已有授权读取端口，不能伪造准入。 | A只读 |
| /Users/rhett/citizenserve/membership/service.rs | 当前同块会员资格读取。 | A只读 |
| /Users/rhett/citizenserve/membership/ports.rs | 既有资格与原子投影合同。 | A只读 |
| /Users/rhett/citizenserve/server/cloudflare/repositories/auth.rs | 既有设备/会话/准入事实读取。 | A只读 |
| /Users/rhett/citizenserve/server/cloudflare/chain.rs | 现有固定链与canonical读取。 | A只读 |
| /Users/rhett/citizenserve/server/cloudflare/schema.sql | 主库36表，不复制通用聊天物理schema。 | A只读 |
| /Users/rhett/citizenserve/server/cloudflare/download-schema.sql | 独立下载库不被聊天改动。 | A只读 |
| /Users/rhett/tatachatsdk/lib/src/protocol/message.proto | 已存在的SDK消息协议真源。 | A只读；B维护 |
| /Users/rhett/tatachatsdk/lib/src/protocol/attachment.proto | 已存在的SDK附件协议真源。 | A只读；B维护 |
| /Users/rhett/tatachatsdk/lib/src/protocol/chat_frame.proto | 已存在的12命令/帧协议真源。 | A只读；B维护 |
| /Users/rhett/tatachatsdk/TataChatSDK.md | 客户端协议与MLS边界核对。 | A只读 |
| /Users/rhett/tataconsole/tasks/塔塔聊天服务模块与公民途遇服务端集成.md | B最新架构/单步授权/准确交接证据。 | A只读，不改B进度 |

### 本窗口拟生成与清理的完整路径

| 完整绝对路径 | 用途 | 唯一执行方 |
|---|---|---|
| /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm | 同一Rust Worker的原始WASM与摘要。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index.js | 官方装载包，不手改。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index_bg.wasm | 官方绑定后WASM，实际WSS/DO验收。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/package.json | 官方生成包声明。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/.gitignore | 官方生成包忽略声明。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/worker/shim.mjs | 官方兼容shim，不作main。 | A生成 |
| /Users/rhett/citizenserve/target/cloudflare/worker/.tmp/ | 官方活跃构建暂存，结束后核对清理。 | A生成/清理 |
| /Users/rhett/citizenserve/target/cloudflare/worker/.oldtmp/ | 官方失效暂存，保留活跃锁、只清本轮残留。 | A生成/清理 |
| /Users/rhett/citizenserve/test/worker/node_modules/ | 现有锁定测试工具缓存，不提交。 | A生成 |
| /Users/rhett/citizenserve/test/worker/.wrangler/ | 仅本轮本地聊天D1/R2/DO测试数据，结束后准确清理。 | A生成/清理 |
| /Users/rhett/citizenserve/server/cloudflare/.wrangler/ | 如本轮使用则核对本地缓存，不触碰线上数据。 | A生成/清理 |
| /Users/rhett/citizenserve/test/__pycache__/ | Python合同缓存，结束清理。 | A清理 |

协议材料与生成Rust文件的最终绝对路径不是当前已知产物；7.2交接时必须补齐，不能用目录名/哈希占位代替。没有交接验真就不运行build.rs或声明7.3可实施。当前只请求确认上述第7步设计与A的7.1范围；后续未知文件不自动获准。注册仍严格保持：点击确认注册→Cloudflare→CitizenServe保存通过结果→原钱包签名/上链/finalized完成CID注册→MLS设备授权激活→账户服务。

## 第7步7.1执行结果与剩余交接（2026-10-08）

**7.1宿主阶段已完成；第7步整体未完成。** 用户本次明确回复“仍由塔塔聊天线程交付，维持原分工”，指Cloudflare聊天适配。A已完成本窗口可独立实施的授权迁出、许可签发、宿主状态读取与测试。B的当前线程为「塔塔聊天」（01a11c57-73af-7170-96eb-db5738b9dce4），原「聊天服务端」线程只保留历史，不混写两份卡。A不实施B的Cloudflare模块、资源或SDK，不代替其第3步确认。

### 已实现行为

1. 删除 /Users/rhett/citizenserve/chat/mod.rs 及空chat目录，退出根pub mod chat。/Users/rhett/citizenserve/user/chat_access.rs 只从已核验Authority、同设备/同会话提取Subject；/Users/rhett/citizenserve/membership/chat.rs 在身份与会员同一canonical finalized块hash/number/Timestamp下计算当前权益；/Users/rhett/citizenserve/server/tatachat.rs 组合私有字段Authorization。三档聊天附件10MiB/100MiB/5120MiB保留，Active/Cancelled未到期可用，其他状态/未知资格拒绝。准入、普通会话与设备事实仍由现有user存储持有，没有影子聊天用户表。
2. 本地实际Rust Worker已登记 **POST https://www.crcfrcn.com/api/tatachat/access**，内部 /tatachat/access。准确正文{}、≤1KiB、无查询，现有Bearer+purpose=request一次性MLS证明绑定真实/api路径、方法与原始正文。客户端不能提交CID、设备或会员权限。接口不重复调用Turnstile、不追加钱包签名。响应为ok/access_token/expires_at/recheck_at/realtime_url。
3. EdDSA头严格为alg/typ/kid，iss为服务HTTPS origin、aud=citizenserve.tatachat、purpose=tatachat_access。version/sub/device_id/authorization_revision/session_hash/chat_enabled/max_attachment_bytes与秒级iat/nbf/exp和毫秒级issued_at_millis/expires_at_millis/recheck_at_millis相互绑定。最长15分钟、裁剪至普通会话/会员；初次核验≤60秒并裁剪至当前身份和会员核验期限。秒级exp向下裁剪；不足一秒的许可不返回已过期JWT。签发只从CF环境秘密TATACHAT_AUTH_KEY导入非可导出Ed25519 PKCS8；TATACHAT_AUTH_KID只为公开密钥标识，本地声明仍为空，未填写任何生产秘密。
4. /Users/rhett/citizenserve/server/cloudflare/repositories/chat_access.rs 在异步签发后通过原authorized_business_sessions view和当前设备issued_at同一D1快照再次核对准入/绑定/设备/会话/身份确认期限；签名期间撤销、注销或同公钥重新授权都不能交付旧凭证。不新建主库表，主库36/下载1保持。
5. 再核验合同实际绑定不透明授权修订，覆盖服务/链、CID账户绑定、设备issued_at、会话摘要和字节权限。正常当前链刷新及同额度续费不无故改变修订；换绑、设备代际、会话或权限变化拒绝旧许可。native recheck只能更新确认窗口，不能延长原15分钟或复活旧会话。VerifiedToken仅为验签结果，必须配合fresh Authorization才能授权，旧60秒窗口不能作为新事实。
6. /Users/rhett/citizenserve/server/cloudflare/tatachat.rs 的公开Rust Host为同进程可信状态源，new(env,config)、current_session(session_hash)及A Rechecker实现已写入并通过WASM编译/Clippy。current_session读取当前D1会话，以固定RPC读取同块身份与会员、复用现有投影撤销，然后重新读会话/准入/设备及交付前快照；未知或过期拒绝。它没有公网查询入口。实际WSS/休眠/推送回调调用这些方法的运行验收仍属于7.3，不能把编译通过宣称为长连接已接入。

### A/B公开合同与未实施部分

B已在 /Users/rhett/citizenserve/tatachat/auth/mod.rs 和 /Users/rhett/citizenserve/tatachat/auth/ports.rs 将凭证字段与A实际签发对齐。HostAccess中actor.user_id/device_id对应Authorization.user_id()/device_id()；chat_enabled/max_attachment_bytes/authorization_revision对应同名许可；session_id_digest对应session_hash()；三个毫秒时间对应issued_at()/expires_at()/recheck_at()。B Host方法为now_millis/recheck(previous)/authorize_wake(registered)，Future无Send要求；A当前私有许可Rechecker是宿主内部合同，不要求B继承它。重核验窗口按当前事实≤60秒；WSS原credential_deadline保持。唤醒必须据当前普通会话/准入/设备/链资格生成目标许可，不能照抄登记时旧权限。

B的28件功能源码已实际存在，采用auth、protocol、key、mailbox、attachment、push、realtime目录。它们尚未编入当前lib.rs/Worker；本轮177项Rust不包含B的通用模块测试。B已提供SDK固定提交29b7e4377833802a0a9f833c44c3e92036bd8493、三件.proto摘要、prost/prost-build=0.14.4与protoc35.0，准确来源/字节数见B唯一任务卡；尚未交付本产品协议准备的最终流程补丁与CF资源/DO/路由/任务清单。

/Users/rhett/citizenserve/build.rs 尚未新建；Cargo.lock、Cloudflare Cargo.toml、scripts/build-worker.sh及scripts/check.sh均保持本步基线，未假装协议已生成。B提供实际完整Cloudflare交接与准备流程后，A在7.3统一接入Cargo/lib/build.rs、B Host shim、唯一Worker事件与DO/资源，消费通用Claims/验签并收口当前宿主临时同形模型，不能长期维护两个通用凭证合同。WSS **wss://www.crcfrcn.com/api/tatachat/realtime** 和GET/PUT **https://www.crcfrcn.com/api/tatachat/attachments/{attachment_id}/chunks/{chunk_index}** 当前仍未登记，返回404；realtime_url目前是冻结的目标地址，不能据此宣称可连接。健康状态仍account_services_ready:false。

### 验收与准确修改范围

/Users/rhett/citizenserve/scripts/check.sh 完整退出码0：**177 Rust、127 SQLite、17 Node全部通过，无跳过**，包括原161/116/12回归；fmt、native all-targets Clippy、WASM Clippy(-D warnings)、locked Release与官方worker-build通过。16项新增native覆盖同块资格/三档权限/过期/代际/修订/真实Ed25519正反例/时间边界；11项新增SQLite执行生产SQL原文，覆盖签发期间撤销/换绑/同公钥代际/期限/缺字段；5项新增workerd测试执行真实Rust许可HTTP和WebCrypto，由独立Node Ed25519验签，并拒绝MLS重放、客户端身份、过期会员和未知RPC。原11项Worker推送/Queue/Cron/故障清理/32秒租约续期继续通过。

A实际新增10件，均为前述11件范围中除 /Users/rhett/citizenserve/build.rs 以外的文件。A实际修改16件如下：

| 完整绝对路径 | 唯一修改方 |
|---|---|
| /Users/rhett/citizenserve/Cargo.toml | A |
| /Users/rhett/citizenserve/lib.rs | A |
| /Users/rhett/citizenserve/user/mod.rs | A |
| /Users/rhett/citizenserve/membership/mod.rs | A |
| /Users/rhett/citizenserve/server/mod.rs | A |
| /Users/rhett/citizenserve/server/routes.rs | A |
| /Users/rhett/citizenserve/server/cloudflare/lib.rs | A |
| /Users/rhett/citizenserve/server/cloudflare/runtime.rs | A |
| /Users/rhett/citizenserve/server/cloudflare/wrangler.toml | A |
| /Users/rhett/citizenserve/server/cloudflare/repositories/mod.rs | A |
| /Users/rhett/citizenserve/test/contracts.rs | A |
| /Users/rhett/citizenserve/test/worker/worker_smoke.mjs | A |
| /Users/rhett/citizenserve/scripts/check-worker.sh | A |
| /Users/rhett/citizenserve/CitizenServe.md | A |
| /Users/rhett/citizenserve/README.md | A |
| /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md | A |

删除 /Users/rhett/citizenserve/chat/mod.rs。Worker夹具导出共享启动/MLS/RPC，不复制Rust业务，冻结同一块的Timestamp。B功能目录/其任务卡在执行中由B更新，A不写入。

本轮冻结基线 /tmp/citizenserve-step7-baseline.json，检查日志 /tmp/citizenserve-step7-check.log。本步只读宿主授权/链/主库schema文件与基线摘要一致；67件删除前旧源码再次逐件对照Git快照5a11a98c5c32b6a4f89cec35d760609dd628d3be一致，旧src/npm产品未恢复。另一线程的永久公共RPC https://nrcrpc.crcfrcn.com/及其差异保留。

| 本轮实际产物完整路径 | 大小与SHA-256 |
|---|---|
| /Users/rhett/citizenserve/target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm | 5880561字节；48d4cbf6b6539d1161fee98d83e8cfbe8e2e5e23a7cc50a50e1b7992042f4725 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index.js | 32741字节；76d188bde3d474f2cefadfcaa7beeed8ec64c6168a682d76cb6ad1bec48aa034 |
| /Users/rhett/citizenserve/target/cloudflare/worker/index_bg.wasm | 3135863字节；bc0cfb77982b7f96a6b0270d50026856a3a6aecf7ecbac917ce44974307e44c9 |

**实际限制：** 本地workerd仍用2026-08-11，生产2026-10-07未同日期验收；链/metadata/provider都是公开合成拦截夹具，无真实线上链/D1/R2/Siteverify/聊天推送验收。MLS私钥仅测试内存生成，未写入任何夹具/日志；实际MLS私钥留SDK设备。B通用核心、12命令/WSS/DO休眠、附件、聊天唤醒仍待共同运行验收。A未提交、推送、部署、创建资源、执行线上DDL或真实支付/清理；本阶段已清除 /Users/rhett/citizenserve/test/__pycache__；官方.tmp/.oldtmp及两个.wrangler测试目录均不存在，忽略的锁定依赖和构建产物保留，不清理B源码/准备现场。最终文件审计 /tmp/citizenserve-step7-audit.json 确认16修改/10新增/1删除，17件只读及延后装配文件摘要未变，B的并行差异保留，没有范围外修改。

第7步剩余装配保持 **7.2 B交付通用核心/Cloudflare与真实资源协议清单 → 7.3 A统一装配和全量数据面验收**。用户随后明确要求本窗口继续独立工作、不要停下来等待B；据此A并行完成.github纠偏、App统一注册及接口适配的只读分析和第8步预备方案。第8步代码仍须逐步确认，聊天实际运行验收在B交付后完成，不把第7步整体标记完成。

## 仓库流程目录恢复与独立接线准备（2026-10-08）

删除旧TypeScript产品实现时将.github一并删除是范围处理错误。业务重建不应删除仓库门禁、CI、Release目录；以后只按准确文件差异适配流程，保留仓库入口。

已从当前HEAD 08a9b33b2b03cf6fcd21c6b1798d8cf5b023a38b恢复 /Users/rhett/citizenserve/.github/tatagate/contracts.json、/Users/rhett/citizenserve/.github/tatagate/index.mjs、/Users/rhett/citizenserve/.github/tatagate/test.mjs、/Users/rhett/citizenserve/.github/workflows/tatagate.yml、/Users/rhett/citizenserve/.github/workflows/citizenserve-cloudflare-ci.yml、/Users/rhett/citizenserve/.github/workflows/citizenserve-cloudflare-release.yml。六件逐字节相同，保留最新提交的旧聊天引用清理；没有复活旧src/npm业务。

恢复的两个MJS语法检查通过。原门禁测试实际14项中8通过、6失败、0跳过，失败依赖已删除的旧构建源码和TS夹具，**Rust正式CI尚未适配完成**。恢复证据与原失败日志归 /Users/rhett/citizenserve/target/cloudflare/test/registration-review/github-restoration.json 和 /Users/rhett/citizenserve/target/cloudflare/test/registration-review/github-restoration-tests.log；没有发起或重试GitHub Run。正式流程最终补丁仍按TATA第6.13条确认。

App第8步预备方案已写入[公民统一注册任务卡](/Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md)，包含唯一注册编排、受保护恢复记录、两平台原生白名单、全部实际API与响应适配、测试路径及正式流程后续范围。当前38件只读源码证据在 /Users/rhett/citizenserve/target/cloudflare/test/registration-review/source-audit.json；App代码未切换，未执行新App用例。

本次核实的主要兼容要求：新验证页面回传verification_id/token的JSON；设备登记六字段且无turnstile_token；上传prepare返回manifest/media_uploads；头像prepare返回相对upload_url，content_hash由PUT回执取得；创作者读取真实tiers/subscription，确认回执后重新读取，投影POST同样需要普通请求MLS证明；充值confirm需要实际付款钱包payer_signature；链清单唯一转发路径为/api/chain/extrinsics。不能只替换旧/square路径便宣称兼容完成。

App旧账户注销HTTP调用在Git当前提交的旧TypeScript分派中也没有入口，不能误记为本次Rust重建删除了原可用HTTP功能。原finalized Revoked触发的同CID云端清理等价闭环仍作为恢复缺口登记；当前撤销会话/准入/设备的测试通过不等于云端全部清理已完成。后续准确方案必须涵盖对象定位、财务claim及B聊天数据生命周期，不编造HTTP入口或先删本地数据。

B已交付 /Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/candidate 的13件最终共享补丁；关联线程的人类确认核实后由A唯一正式写入。原candidate、manifest与final.patch保留，测试现场归同目录run。A继续注册、恢复存储、普通API及正式流程分析；聊天Cloudflare数据面仍由B交付后验收。account_services_ready仍为false；没有线上DDL、资源创建、签名发布、部署或迁移实施。

## 通用聊天核心第2步装配与协议资源

通用聊天唯一归本产品根tatachat，由auth、protocol、key、mailbox、attachment、push、realtime七个功能目录及根mod/service/tests组成，共28件Rust源码。公民Subject、会员Permissions与宿主Authorization仍归user/membership/server；通用层只接受可信宿主映射的中性HostAccess，不解析CID或会员Plan。密钥包目录只有key；SDK官方KeyPackage类型和既有字段编号保持。

本节接口已由A按确认的13件共享补丁正式装配。根lib.rs声明tatachat，根Cargo.toml直接依赖prost，并用prost-build生成协议，两者统一精确0.14.4；sha2与serde_json构建依赖复用本产品现有精确版本，不新增第二Cargo产品或旧服务运行依赖。首次Cargo --locked发现手工合并锁同时指定兼容的syn2.0.117与原有2.0.119，求解失败。A先在target临时测试视图修正并完成真实编译，展示准确锁差异后取得关联线程人类再次确认，再唯一应用正式Cargo.lock并完成正式源码locked复验。

SDK协议来源、固定40位提交、三件.proto长度和SHA-256以及protoc35.0两种实际宿主官方归档，唯一声明在本产品scripts/flows.json的tatachat字段。scripts/resources.mjs提供protocolRequirements、protocol-requirements、prepare和verify协议入口，以及requirements、execute完整Build入口。Linux x64仅用于当前Cloudflare构建宿主，不新增LinuxARM聊天运行产品或流程；其他宿主不自动选版本。协议获取只按固定来源和摘要，不读邻仓工作树，不从旧仓加载代码，也不手写或提交生成类型。

资源主体必须显式选择：independent由产品按同一公开配方从官方固定来源获取、验真并保存到显式源码外store，已存原件逐件回读复用；console只核验控制台按本产品requirements提前交付的当前任务supply，缺件、损坏或错误身份直接失败，禁止自行下载或切换模式。console供给含schema/product_id/platform/work、dependency_root、tool_root、protoc_archive、protoc和按文件名映射的protocol路径。永久原件仍位于资源供给者库，生成和可写工作视图只归当前CitizenServe平台工作根；产品没有控制台私有路径或源码依赖。离线缺件据实失败；下载可取消，HTTPS重定向有界且仅限官方GitHub资源域，归档内容先验摘要，只展开固定普通protoc入口，提交不覆盖已有原件。

prepare输入是显式JSON文件，含work/mode和独立store或控制台supply；通过已验真的Node25.2.1绝对入口调用scripts/resources.mjs prepare <绝对输入路径>。输出receipt位于work/tatachat-protocol/receipt.json，协议位于同目录protocol，工具为同目录protoc；verify再次逐件检查源码声明摘要、协议目录闭集、原件归档摘要、展开的实际protoc字节及35.0版本。独立模式与控制台模式共用这些核验，不依赖PATH工具或系统解压器。

正式编译前由既有产品资源供给者交付准确Node/Rust/Cargo/Python/worker-build等工具及锁闭包；新增聊天prepare配方仅负责协议资源，不冒充整个产品Build/CI/Release资源接入完成。构建输入显式为PRODUCT_NODE_BIN、PRODUCT_WORK_DIR、CARGO_TARGET_DIR、TATACHAT_RESOURCE_RECEIPT、TATACHATSDK_PROTOCOL_DIR、PROTOC；CARGO_TARGET_DIR必须是work/cargo-target；执行前还需显式交付当前work内的CARGO_HOME依赖视图，exec强制Cargo离线，缺件直接失败，不读取用户默认缓存或隐式下载。根build.rs用同一公开verify再次检查归档和实际执行字节，随后核对三件SHA/长度，调用显式protoc，由prost-build生成OUT_DIR/chat.protocol.rs；所有路径规范、无链接、归当前产品平台工作边界，构建不联网、不安装工具。根scripts/check.sh与build-worker.sh通过resources exec传递同一已验真输入；构建缺工具直接失败。当前Worker产物归本轮target/build/worker，结果核验与记录后清空；历史产物路径仅作当时验收记录。

JWT头、Claims、签名输入、秒/毫秒一致性、最长15分钟及初次60秒窗口、严格Ed25519验签唯一归tatachat/auth；宿主只将已核实Authorization映射为Claims并调用unsigned，再由现有WebCrypto执行器签名。server不保留第二Claims/Header/VerifiedToken或第二验签实现；verify_token只委托通用CredentialContext，然后检查本产品真实CID、设备、修订、摘要与安全整数边界。server/cloudflare/tatachat.rs现有Host直接实现通用Host端口，用current_session重查真实会话/准入/设备及同块链权限后映射；recheck匹配原主体、会话、修订与额度并裁剪原期限，authorize_wake取得目标当前权限。通用Access独立保留原credential_deadline，未知或核验失败即拒绝。

真实验收已在 /Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run 完成固定原件取得和console协议准备：准确批准的9件Cargo原件与3件SDK协议均按官方URL、固定SHA及声明长度核验保存。既有protoc35.0、Node25.2.1、Rust1.97.1及Python3.14.3由工具所有者核验；其余既有Cargo原件逐件对锁验真，只向当前任务生成隔离依赖视图，正式编译无默认缓存或网络回退。

修正锁候选仅将prettyplease、prost-build、prost-derive的3个syn引用统一到原锁2.0.119，删除2.0.117包段；没有升级原版本、改变来源或增加资源。临时视图除这一锁差异外262件当前源码逐件与正式文件匹配。B只修正tatachat/tests.rs的即时内存端口测试辅助器为标准Waker::noop()，没有关闭Clippy警告；修正后207项Rust（30通用、177既有宿主）、127项真实SQLite、10项资源测试全部通过，fmt、原生all-targets与WASM Clippy(-D warnings)、locked WASM Release均通过。生成协议来自三件固定SDK原件，经真实protoc/prost-build生成，不手写第二协议。

准确候选与证明为 /Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run/Cargo.lock.candidate、/Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run/Cargo.lock.patch、/Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run/final-evidence.json。锁候选SHA-256为49a5c78a2a81459acdafe5a1d285022c4bf3152f6d3e1c16cd4d5f3f0b9d8f37，补丁为7a91badce09172ccb1a07ac7d7c5a7da98366d252d5a00b1a92d71469477f3c9；准确差异3行新增、14行删除。关联线程人类确认记录01a11cd3-3b79-7803-ae1e-80fa502b9d73已由A直接核实，正式锁现与最终候选逐字节一致。

正式源码执行现场仍是 /Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run，准确正式应用回执 /Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run/formal-lock-applied.json，正式完整验收证明 /Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run/formal-evidence.json。**正式源码207 Rust、127真实SQLite、10资源、fmt、native all-targets及WASM Clippy(-D warnings)、locked WASM Release均通过**，不借用临时候选结果。正式WASM位于 /Users/rhett/citizenserve/target/cloudflare/test/tatachat-step2/run/cargo-target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm，5887846字节，SHA-256为88c7d92f38778f6a54ee447fbb11657cf7d1b763b9d410a7c95efcf972ddc043；四份实际生成chat.protocol.rs均9765字节且SHA-256为c8c99498913507a9ed132997998bf430d7b0d5dae7de210b9c6cc49003e3474e。第2步通用核心共享装配已验收，App源代码核对的22件摘要未变。

本轮没有重新打包Worker或执行workerd用例；先前17项本地Worker通过记录属于7.1，不能充当当前候选运行结果。B第3步D1/R2/DO/WSS与模块资源管理、第4步客户端接线、第5步线上联调及第6步旧产品退役保持既定阶段。第7步整体、正式Rust CI及App第8步仍未完成，没有聊天数据面绑定、部署或生产切换，健康状态不因此变更。


## CitizenApp第8步消费合同（2026-10-08）

用户已确认8.1—8.4及8.6。注册顺序为：确认注册 → Cloudflare验证 → CitizenServe保存通过结果 → 原余额检查/钱包签名/CID上链/finalized → 同一TataChatSDK的MLS设备登记 → 普通会话。原CID生成保留在MyIdService.registerAnonymousCid内部；验证前只有账户、机构、genesis、服务范围，没有CID或年份。

新增编排位于 /Users/rhett/citizenapp/lib/my/myid/registration/registration_coordinator.dart，能力API/严格模型/页面/保护记录同目录。统一根在 /Users/rhett/citizenapp/lib/security/citizen_serve_api_config.dart。registration.json经原生白名单、锁/CAS、原子提交及读回保存；身份公开记录和恢复能力分开，全量/胁迫擦除包含新记录。MLS私钥仍由SDK持有。

恢复先读取服务器status，再查所选账户finalized双向绑定及SDK公开检查点。未知广播不重发；finalized后只恢复投影、设备和普通会话；余额不足保留验证结果。设备登记只有六字段 account_id/public_key/issued_at/binding_signature/enrollment_id/recovery_token，已准入登记两个能力字段明确为null。原独立设备Turnstile页面删除。

普通API改用/api/user、/api/8964、/api/notifications、/api/membership、/api/topup；证明覆盖实际方法/原始URL查询/正文。创作者档位读取tiers及各周期价格；finalized确认需普通request MLS证明。资料上传核对同源能力URL和PUT内容哈希；manifest与complete按新结构/路径。公开链extrinsic入口为/api/chain/extrinsics。

付款意图核对当前链genesis、服务origin、付款人/代币/收款地址/金额/目标账户/套餐/期限及原始token摘要；WalletConnect先personal_sign固定CitizenServe Topup v1消息，成功后才发送原ERC20交易。确认复用同一payer_signature及交易哈希，不重复支付。

聊天宿主HTTP许可已按/api/tatachat/access接入；实际WSS/DO/附件源码已装配，可用性仍待统一运行验收。历史云端清理和正式CI/Release改造未纳入本次源码修改。App源码已落地，相关宿主检查通过；第8步整体验收未完成。


本轮相关21件Flutter文件的178项用例全部通过，完整App源视图analyze无问题，47件批准Dart源码/测试的format检查零变化。实际充值HTML内联JavaScript另有7项Node VM检查通过：成功先签授权再发送一次交易；取消、无效签名、错链、账户变化和签名期间过期均不发送交易，重复提交不重复支付。VM中的钱包提供方是模拟端口，没有真实签名或付款。Flutter测试使用准确公开CitizenSDK提交0c442b4065ff1577e235cba76978749827d9f575、TataChatSDK提交29b7e4377833802a0a9f833c44c3e92036bd8493和既有固定链金标；SDK工作树未被修改。CitizenSDK由固定提交真实编译并通过其ABI符号及C/C++头文件检查；相关Flutter结果不等于TataChatSDK MLS原生库或完整scripts/citizenapp-test.sh通过。

完整iOS原资源入口在Pod spec/锁摘要不符处失败。固定libcrux-intrinsics0.0.6归档同时包含内容不同的README.md与Readme.md；本轮工作文件系统实测不区分大小写，不能忠实保存二者。原版本/锁/归档摘要及正式流程保持不变，未删减上游文件或弱化验真。两平台原生registration保护/CAS测试已补充源码，尚未实际运行；真实WebView挑战、热签/冷签、后台恢复、MLS原生及签名Release真机验收也尚未完成。

本步的恢复与拒绝规则包括：真人通过结果落盘失败时零钱包动作；未知广播不重发；既有finalized回执不被新链头覆盖；激活必须对应同一普通会话设备ID、CID和binding_revision；受保护记录按服务origin、链genesis与所选账户隔离。验证码仅短暂留在内存，registration.json不保存MLS私钥或钱包签名；设备绑定仍通过原TataChatSDK身份执行。

完整旧测试尚有原/square会话、feed、资料路径夹具未纳入本轮21件执行；注销历史缺口仍未补齐。因此178项局部通过不能代表全套回归。准确未修改路径及后续边界已逐项记录于 /Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md。


## TataChat第3步Cloudflare数据面候选（2026-10-08）

本节保留第3步实现合同。获准的7个目录、22件新增文件与13件共享修改共35件已经正式装配；实际测试统一留到联调阶段，不能沿用第2步编译或原17项Worker结果证明当前数据面可用。整项任务仍开发中。

Cloudflare入口仍是同一CitizenServe Worker。server/cloudflare/tatachat根只放config、routes、schema和maintenance；key、mailbox、attachment、push、realtime各功能的mod/store或具体驱动分目录。通用权限、协议、幂等规则与协调器继续消费根tatachat已有端口；不复制SDK协议、宿主身份、设备登记或会员真源，不维护待退役旧仓。

唯一公开数据路由为GET /api/tatachat/realtime与GET/PUT /api/tatachat/attachments/{attachment_id}/chunks/{chunk_index}，WebSocket子协议为tatachat，帧为固定SDK生成Protobuf。凭证由已有/api/tatachat/access签发，数据入口复用同一验签和可信Host。配置须有四绑定；HTTPS服务origin、可选Origin、原始路径和方法严格核对，客户端内部头不产生能力。附件分块无查询字符串、非规范编号或旧/attachments别名。每设备最多4连接，帧最多2MiB，单密文块最多4MiB；附件总体额度仍取可信会员许可与通用MLS开销规则。

TATACHAT_DB为独立聊天D1，schema只有聊天公开密钥包、设备密文、紧凑回执、推送outbox/端点/代际、附件元数据/对象定位/回执和模块维护/重建材料。D1 batch内先检查模块未冻结；授权写入前后都使用实际SQLite时钟检查Access.deadline。每batch最多40业务语句，每语句最多100参数、100KB SQL，每绑定字符串最多1.9MB；这不是整个请求D1查询数或账户套餐的验收证明。KeyPackage保留LastResort，解析不消费；同步先查索引轻量记录与单帧预算，再读选定密文。

消息首次提交在同一batch建立不可变全收件摘要、所有设备密文和outbox；收件集合、发送者、会话编号、时间或任何设备密文变化均冲突。ACK只删当前可信收件设备的密文与对应outbox，回执保存到原服务端期限。同ID同内容重试不延长期限，不恢复已ACK密文或推送任务。过期密文不返回。

附件创建归属可信创建设备，下载按发送用户或收件用户授权；完成和中止只允许创建设备，ACK按收件用户。每次上传先持久预留全新attachment/generation/index/attempt对象键，CAS reserved→writing后只调用一次R2 put，并实际校验长度/SHA及R2校验和。记录written的版本后才确认分块；失败只补偿本尝试，绝不覆盖或删除另一尝试。HEAD/DELETE没有版本CAS，本实现通过不可复用键限制归属。未知writing没有对象时继续保留定位，不能把超时当作未写入；观测到对象才清理，全部尝试deleted后才删除父记录并保留幂等回执。附件与尝试轮换清理，避免未知前缀饿死其他对象。进程恰在writing持久化后、发起put前崩溃仍无法仅凭HEAD不存在证明已终结，该定位会保留并阻止安全重建；第5步必须实测并记录此边界。

TataChatDevice使用SQLite DO休眠WebSocket API，连接attachment仅保存随机小定位，完整权限快照与解析限额存DO storage。每次设备事件恢复都重新查询Host，核对actor/revision/session/额度，凭证终期不延长；每设备只有一个最早再核验alarm，无自动Pong。安排alarm失败时关闭连接，静默连接也要按期限重查。事件锁只串行本设备快照，提交和响应后释放锁再发送DO内部提示，避免互等。提示可丢失，设备同步与持久outbox负责补足；内部notify只走namespace stub。业务操作归属错误返回Failure；会话撤销、未知Host、非法文本或超限帧关闭连接。实际平台alarm调度延迟及DO休眠/重启尚未验收，不宣称硬实时截止。

TATACHAT_PUSH为独立Queue。消息持久outbox与首次密文同事务；每wake领取一件有界租约，逐端点核验当前Host许可并续租，旧lease_id不能完成新租约。补派为每任务发送对应延迟hint，成功后仅更新原快照；Queue重放由D1租约吸收，Cron五分钟槽补派及有界维护。端点移除不重置代际；明确无效端点只删除原代际，认证或配置失败不会误删token。APNS/FCM仅使用通用chat_wake负载，APNS使用固定生产地址，FCM只使用官方OAuth/发送URL；复用宿主WebCrypto签名，发送阶段10秒取消、回执最多16KiB，重定向不接受。普通NOTIFY队列保持原业务分支。

唯一模块资源声明在scripts/flows.json的tatachat.cloudflare，schema版本1及当前文件SHA冻结。生产D1/R2/Queue同名citizenserve-tatachat，Worker为citizenserve；测试资源同名citizenserve-tatachat-test，Worker同名；绑定分别TATACHAT_DB/TATACHAT_ATTACHMENTS/TATACHAT_DEVICES/TATACHAT_PUSH，DO类TataChatDevice，SQLite migration tag tatachat-1。公开账户范围以正式CF_ACCOUNT_ID为准；没有进行云清点、创建、部署或填写猜测D1 ID。wrangler候选仅增加实际Queue分流公开变量及待绑定说明，四绑定须由真实资源回执产生的tatachat-wrangler-bindings.toml另审后装配，不能把现状称作数据面已启用。

scripts/tatachat/resources.mjs提供plan/create/maintain/rebuild/verify同一配方。plan回执含账户/环境/操作/schema/真实资源ID与数量，批准摘要必须匹配重新清点现状。create只建缺件，既有D1须核真实DDL及模块归属，R2/Queue须核实际绑定或本任务匹配回执，私桶managed/custom公开访问必须关闭。配置回执只含公开ID并保存在当前工作根，DO namespace与Queue实际消费者留待部署后验真。verify检查真实DDL、私桶、Worker四绑定、SQLite DO class/script和唯一Queue消费者；只证明这些资源事实，不能代替API联调。D1官方保留表_cf_KV单独排除，未知业务对象仍拒绝，依据https://developers.cloudflare.com/d1/best-practices/import-export-data/。

rebuild只重建本模块业务表，保持D1/R2/DO/Queue资源身份与对象键，禁止资源删除。开始先把冻结状态与随机活动backup_id绑定，拒绝未知writing；数量漂移要求重新规划。在同一受保护D1中复制并按数量及EXCEPT比较验真快照，不把密文、端点token或私钥导出本机。破坏性阶段只在快照verified后开始；恢复按原列顺序插入并回读全部表，最后解除该活动备份的冻结。中断后只接受同账户/环境/schema且与活动backup_id匹配的verified快照；恢复现状、冻结状态或来源未知必须失败，不把空库当恢复。快照保留在云内，本步没有清理授权。

云能力由获准安全执行器持有和发送认证；产品脚本只通过当前任务的双向FD传公开Cloudflare请求，响应绑定schema/id/product/platform/environment/account。固定Cloudflare账户URL与Worker只读限制在产品再次检查，执行器还必须绑定获准操作和资源ID/名称，拒绝越界。CLI必须显式independent；控制台目前没有本轮所需公开能力，console明确失败，不能读取SERVER_DEPLOY、Keychain或私有发布通道。产品支持配方与能力注入不等于安全执行器或控制台接入已经交付。

新增10项SQLite存储用例、11项实际Worker数据面用例及12项模块资源用例；根资源回归补充npm锁及错供给拒绝用例，既有普通Worker/宿主许可回归同入口。scripts/check-worker.sh取消PATH Node与源码npm ci，只接受绝对已验真Node/Python、当前任务绑定且由供给者交付摘要的Worker闭包回执，逐文件验字节和当前npm锁后在所属target工作现场运行真实打包产物。来源只取本仓test/worker/package-lock.json；现锁Miniflare5.20260804.1-alpha/workerd1.20260804.1与生产compatibility_date 2026-10-07的运行兼容尚未证明，缺件、版本差距及worker-build0.8.5/wasm-bindgen0.2.127打包供给须在第5步前准确核验并另列获准资源需求，不隐式下载或升级。

四项复核：中文注释说明实际期限/事务/版本/租约/能力边界；正常、失败、边界与普通业务回归源码同步，尚未运行；本文只在最新正式唯一文档之上追加候选，保留A的App接线记录；正式API、通用端口、固定生成协议和唯一flows已对照。未改SDK、App、根Cargo、旧仓或控制台UI。下一步A在最终差异确认后唯一装配上述共享候选，并与A的8.7.1临时流程候选按实际基线合并；B继续第4步SDK runtime/transport前先给准确方案。第5步统一执行编译、存储/Worker、真实云休眠与静默再核验、对象补偿/未知结果、推送租约/端点更新/提供方以及资料门禁；全部通过前不标记完整任务已完成。

## Cloudflare CI、Release与本仓门禁（2026-10-08）

本节定义第2步最终源码结构及其真实验收边界。历史8.7.1十八件草稿已撤回；当前实现直接归本仓，旧六件多层入口保持删除。源码装配不能替代运行态通过，整项统一联调仍为开发中，实际测试、编译和资源操作等全部获准步骤实施完成后统一执行。

scripts根下最多一层子目录。CI唯一完整入口为/Users/rhett/citizenserve/scripts/ci/cloudflare.mjs，配套测试为/Users/rhett/citizenserve/scripts/ci/cloudflare.test.mjs；Release唯一完整入口为/Users/rhett/citizenserve/scripts/release/cloudflare.mjs，配套测试为/Users/rhett/citizenserve/scripts/release/cloudflare.test.mjs。没有平台子目录、check子目录、index/execute转发或兼容入口。/Users/rhett/citizenserve/scripts/tatachat仍直接承载模块资源实现及测试，不重建旧构建入口。

唯一公开声明/Users/rhett/citizenserve/scripts/flows.json将两个远端身份直接绑定上述入口；资源入口固定/Users/rhett/citizenserve/scripts/resources.mjs。独立发起与控制台发起均调用该资源入口的run ci|release cloudflare和recover，使用同一派发、来源核验、恢复及保留实现。控制台通过公开FD3协议保存正式候选、绑定真实Run并返回成功或失败；源仓声明不授予令牌，产品只使用当前准确仓库授权。现有控制台本机Build/Start及本机门禁资源交付尚待后续步骤接入，不以本轮入口存在宣称全部流程解耦完成。

### Runner资源、可信引导与任务边界

Linux资源仅在实际GitHub Linux Runner获取、准备、验真和使用；本机Mac不下载Linux原件。资源需求由真实调用、本仓声明、Cargo.lock与test/worker/package-lock.json决定，不按固定工具数量补装。Linux执行宿主锁定Ubuntu24.04及实际glibc2.39，Node25.2.1运行字节与官方发行归档逐字节对应后，才使用其HTTPS、摘要和归档能力准备后续闭包。三个Workflow使用固定提交的官方checkout/setup-node，产品自身继续核验实际运行Node字节。

本仓配方声明Git2.54.0、Python3.14.3、Bash5.3.20、Rust1.97.1、protoc35.0、actionlint1.7.12、worker-build0.8.5、wasm-bindgen0.2.127、Binaryen130及Release所调用的GitHub CLI2.102.0。Linux源构建闭包包含固定BusyBox/Make/Zig、Perl5.42.3、OpenSSL3.6.3、zlib1.3.2和SQLite3.53.4源码。SQLite为Linux Python源码准备的内部库，不替换Mac已交付Python及其实际内部SQLite；两个平台的内部闭包分别核验，不声称字节相同。Rust按官方rustc/cargo/rustfmt/clippy/host std和wasm std组件准备；Bash20份官方补丁按固定摘要及完整context原行应用，拒绝内容不符或匹配歧义。worker-build只从固定0.8.5来源及内部Cargo锁离线编译，不隐式下载esbuild/wasm-bindgen/wasm-opt。

Cargo registry闭包按包名、版本与checksum物化并生成离线vendor校验；npm仅按原锁真实解析路径、os/cpu/libc物化适用闭包，不运行生命周期脚本。esbuild/workerd实际二进制直接来自该锁，工具命令只解析当前任务已验真闭包，拒绝调用者PATH、代理、系统工具、Rust包装器及下载覆盖变量。协议消费继续固定SDK提交29b7e4377833802a0a9f833c44c3e92036bd8493和该提交真实lib/src/protocol；不读取SDK工作树或提前改新SHA。

独立Runner模式将不可变原件按摘要保存于显式源码外工具库/依赖库并再次核验后复用；显式offline缺件失败，已存损坏原件保留并失败，禁止覆盖或升级。当前Workflow使用本次Runner临时资源库，没有宣称跨Runner持久缓存已验收。控制台模式只通过公开原件获取及工具供给能力消费其工具库/依赖库，缺件、验真错误或供给失败不切独立下载。Mac发起只核验本机已交付Node，不准备Linux原件。

任务首个文件步骤取得同身份短锁、核实活跃保护、清空准确流程现场并回读为空；不同身份不互清。工具执行支持取消和超时，先收集真实close，再核对Linux实际识别后代PID及启动坐标，未确认退出时保留活跃标记并禁止清场。源构建现场在安装验真且进程退出后删除；可写Cargo/npm视图、日志、报告与中间产物只归所属本轮target。最终公开产物目录与其他身份不因清场被删除。

### 完整检查、CI证明与正式发布

/Users/rhett/citizenserve/.github/tatagate/index.mjs由本机和GitHub调用同提交实现，只检查本仓根文档、真实声明、源码及Workflow，不依赖私有规则或控制台资料。push main只触发/Users/rhett/citizenserve/.github/workflows/tatagate.yml，不派发CI/Release。另两份独立Workflow为/Users/rhett/citizenserve/.github/workflows/citizenserve-cloudflare-ci.yml与/Users/rhett/citizenserve/.github/workflows/citizenserve-cloudflare-release.yml，只由workflow_dispatch启动，各自唯一flow Job、完整三维身份及并发保护保持。

完整检查执行Rust fmt、核心all-targets测试及Clippy、原九件SQLite合同测试、WASM Clippy及locked Release、五件Node资源/流程/门禁测试、真实Worker打包及四件WASM/workerd接口测试。Node报告通过同一本仓门禁reporter取得实际计数，Rust/SQLite也验证非零真实执行；失败、跳过、todo、取消或缺报告均失败，不接受零用例退出0。根三件shell入口仅在已验真的Bash绝对入口中使用当前Node和完整资源回执调用同一资源实现。

CI先核验真实Runner事件、main、仓库、SHA、Run及Attempt和同SHA最新push门禁成功，完整检查后确认干净已保存源码。ci.tgz包含十一件：index.js、index_bg.wasm、宿主schema.sql、download-schema.sql、聊天schema.sql、wrangler.toml、Cargo.toml、Cargo.lock、rust-toolchain.toml、Worker npm锁和ci-proof.json。证明记录所有源文件摘要、资源需求摘要、八项检查与四组真实计数、十件有效载荷长度及摘要，绑定Run/Attempt。官方上传动作生成唯一带Run/Attempt的Artifact，上传后读取实际ID、来源和整体ZIP SHA-256。

Release只消费同仓main同SHA、当前成功Attempt的唯一CI Artifact。先校验不可变Artifact ID及整个ZIP摘要，再核十一件闭集、实际成功计数、完整源码与需求摘要、Worker字节；下载后重新读取Run/Attempt及资产，发生重跑或漂移即失败。Release复用CI真实Worker，不重编译、不部署、不执行DDL。正式资产只有citizenserve-cloudflare-release.tgz、release-manifest.json与SHA256SUMS，归档包含十件有效载荷及生产聊天DDL，manifest绑定CI/Release实际来源。

三件正式资产由固定官方attest-build-provenance动作生成来源证明，随后用准确GitHub CLI对源码SHA、main、签署Workflow及资产字节做密码学核验；通过后建立或继续相同字节的草稿并发布正式Release。同Tag或同名资产来源/字节不同即拒绝，已发布缺件不追加改写。最终回读正式Release、每件真实资产ID/长度/摘要/完整字节及Tag提交，全部吻合才返回成功。令牌仅交给准确GitHub API，官方存储重定向不携带令牌，错误日志不透传秘密或响应内容。

发起与恢复绑定准确Run，不猜测歧义Run、不自动重试失败。每个CI/Release身份保留最新成功与失败，清理前再核终态、删除后回读不存在，保护活跃Run及正式Release引用的CI/Release来源。控制台恢复收到准确正式版本回执及已删除Run ID，取消、超时或任何非成功结论均失败。

### 尚未完成的验收与下一步

本轮未运行测试、语法检查、门禁、编译或任何Linux配方；本机Linux原件下载为零，也未保存/推送、发起GitHub Run、发布Release、操作云或生产交易。生产compatibility_date保持2026-10-07，Worker测试继续使用相同日期；锁定workerd1.20260804.1历史结果最高支持2026-08-11，此兼容性问题仍未解决，不能降日期或绕过后冒称通过。

后续先完成现有控制台公开资源供给与本机Build/Start/门禁真实调用的准确接入，再处理SDK完整验收、实际新SHA及App/Serve固定消费者，普通账户和注销回归，最后统一运行全套测试/编译、准确保存提交的门禁/CI/Release以及隔离云与双平台真机验收。控制台界面、按钮、平台矩阵、节点部署、开发升级与公民云固定功能不属于本轮修改。所有后续源码或资源操作仍逐步按准确方案授权。

### Cloudflare适配公开接口与锁文件规范化（2026-10-08）

R2适配从worker根公开导出读取Bucket、Conditional和Env。推送发送前、获取FCM令牌前及发出通知前，均通过公开Access::from_host以当前毫秒时间核验HostAccess快照；HostAccess::validate仍保持crate内可见性。公开构造复用现有主体、聊天资格、非零附件额度、授权修订、会话摘要、签发时间、最长15分钟凭证和最长60秒再核验窗口，不延长凭证终期或复用过期许可。

授权测试新增公开构造入口的严格截止、未来签发、零额度及无效主体/设备/修订/会话摘要用例，原撤销、换绑和宿主失败回归保留；本轮只完善用例，未执行测试或编译。Cargo.lock仅将顶部过时候选注释替换为Cargo标准生成注释，version = 4以下所有字节保持不变；Cargo能否保持锁文件字节稳定仍待统一locked编译复核。模块资源脚本已删除第6行一个行尾空格，执行逻辑、权限和资源合同保持不变。公开API路径、请求字段、模块资源绑定、依赖版本和协议固定提交均已检查，本步无需修改。


### 2026-10-08 统一联调第1步范围确认与源码执行

人类明确“确认执行”，并纠正后续方案不得列测试工作目录、临时现场用完直接删除。本聊天完整重读最新TATA，核对CitizenServe/TataConsole的main与准确HTTPS origin，经工具所有者verifyTool核验既有Node25.2.1和Git2.54.0，只在本任务同身份现场冻结8件现存文件的基线与模式。SDK29件最终文件/模式及装配回执已只读核实；134项局部回归、25项语法/Workflow结果属于SDK清理交接，本轮未重跑，也不能替代完整SDK/MLS/Isar和联调验收。

本轮正式修改限定7件：/Users/rhett/citizenserve/server/cloudflare/tatachat/attachment/objects.rs改用worker公开Bucket/Conditional/Env；/Users/rhett/citizenserve/server/cloudflare/tatachat/push/provider.rs经公开Access::from_host核验当前推送快照；/Users/rhett/citizenserve/tatachat/auth/tests.rs新增3项公开构造边界测试；/Users/rhett/citizenserve/Cargo.lock仅替换顶部两行注释；/Users/rhett/citizenserve/CitizenServe.md及两张原任务卡同步当前状态和责任。既有源码模式保留，未扩大HostAccess::validate可见性，推送原三个核验调用点保留。/Users/rhett/citizenserve/scripts/tatachat/resources.mjs只生成删除第6行末尾一个空格的实际最终候选，正式源未写入，按6.13等待第二次明确确认。

四项复核：中文注释说明公开可信构造与严格时钟边界；测试新增截止前/截止时、到期、未来签发、零额度与无效主体/修订/会话摘要，原撤销/换绑/宿主失败用例保留，未执行；唯一CitizenServe.md与两张既有任务卡已同步，未创建第三张任务卡或独立方案文档；实际公开API、Cloudflare模块绑定、依赖版本和固定协议来源已检查，本步无需修改。此为第1步时的历史边界。第2步正式结构以本节之前的Cloudflare CI、Release与本仓门禁合同为准，仍不声称门禁或运行验收通过。

本步只完成获准源码装配与读回，实际编译、锁稳定性和所有运行态留到统一验收；没有资源获取、Git暂存/保存/推送、远端Run、云操作或生产交易。整体保持开发中。临时现场按人类本轮要求用完直接删除，只把必要结论写回原任务卡；其他任务现场和永久资源不在清理范围。


## 本机固定执行目录

target直属仅允许build、test两个固定目录，不建立平台、ci、release、publish或tmp固定目录。平台仍属于任务身份。编译器必需的内部目录只在本轮执行时存在；本轮工具全部退出、结果核验和记录完成后，成功或失败都清空对应现场。同产品共用固定编译根的任务串行领取，禁止清理其他活动任务。测试现场归test，测试结束清空。最终编译包也属于本轮现场，不保留在target根；控制台自身更新先完成既有原子安装，再清空build。远端CI、Release继续在GitHub执行，不建立本机固定流程目录。

历史验收路径保留原记录；本节为当前本机目录规则。

## Cloudflare本机Build公开资源与完整入口

当前本机Build由 /Users/rhett/citizenserve/scripts/resources.mjs 的 execute cloudflare 完成，/Users/rhett/citizenserve/scripts/flows.json 的 entry、resource_entry、completion、files及work_claim为公开接口。Cloudflare completion为compile-only，当前产物在本轮build内为worker/index.js、worker/index_bg.wasm；返回本轮身份及两件实际文件摘要。独立执行和控制台调用共用同一资源准备、工程准备、离线编译、Worker打包和结果核验实现。此为当前源码合同，运行态尚待统一验收。

最小宿主是本产品声明的官方Node25.2.1绝对入口；执行完整Build前先核对实际运行字节。Build只声明实际调用的Node、Rust1.97.1、protoc35.0、worker-build0.8.5、wasm-bindgen0.2.127及Binaryen130，加上锁中的esbuild及Darwin arm64二进制闭包。Build不准备Worker运行测试所需Miniflare/workerd，也不补装Git、Python、Bash或actionlint。当前Mac Rust WASM标准库使用准确官方tar.xz坐标与固定摘要；Linux继续使用自身既有坐标，只在实际GitHub Linux Runner准备和执行。Xcode27.0及随包clang/ar/ranlib、macOS SDK每次核验官方签名、准确版本、规范真实路径和包归属；固定Apple定位和签名入口不加入PATH。

requirements(platform,work)异步返回当前Build完整需求；protocolRequirements及protocol-requirements只返回根build.rs消费的协议需求。SDK消费继续固定29b7e4377833802a0a9f833c44c3e92036bd8493及该提交lib/src/protocol/。工具入口槽位、所需目标组件、准确官方归档和产品准备配方摘要均在公开需求中。prepareToolSupply按当前需求准备缺件，不读取控制台私有登记或实现；源码工具使用官方源归档、原始Cargo锁及递归闭包离线编译。XZ/LZMA2在本产品Node内解码并核验流、块、索引及输出校验，不以系统xz或系统Shell作为Mac工具自举条件。

独立执行须显式选择independent，给出两处规范源码外工具和依赖原件库及准确工作根；原件按摘要保存并再次验真复用，工具对象只引用同一已保存原件。显式offline缺件失败，已有损坏对象或配方变化保留并失败，禁止自动覆盖或升级。控制台调用使用provided和当前任务FD4：控制台先复用已验真对象，缺件按本产品公开配方取得、准备、验真并保存，再交付完整实际文件清单、入口与组件。产品再次核验工具、Apple、协议、Cargo/npm视图和资源环境。PRODUCT_TOOL_ROOT、PRODUCT_DEPENDENCY_ROOT只用于核对交付边界；缺通道、取消、错身份、损坏或供给失败不切换独立下载。FD4仅传身份、需求摘要及资源回执位置/摘要；完整清单留在当前任务资源回执内，不传归档字节。

work_claim=product使完整入口在创建内部现场前持短锁领取长期守卫，核验活跃保护并清空准确build现场；独立与控制台调用互斥。控制台在产品实际close及结果核验后登记确认，守卫继续保护两件候选直到既有SQLite记录完成；然后在同一短锁内删除守卫并清空本轮现场。独立执行在返回成功或失败前确认全部工具退出并清空现场，返回的文件坐标仅作本轮结果证据，不是持久可下载包。退出未确认或SQLite记录失败保留受保护现场，不登记成功清理；不建立替代持久产物目录。本机仅实现既有Cloudflare Build，未新增CitizenServe Start或LinuxARM实现。

回归源码覆盖最小闭包、资源身份/摘要/离线策略、真实close先于完成确认、原件复用、清单链接边界、未退出保存保护、短锁竞争和清场回读，以及独立编码的压缩XZ样本和损坏/取消。全部获准步骤实现、同步和清理完成后才统一执行测试与编译。生产compatibility_date继续2026-10-07；workerd1.20260804.1对该日期的兼容性仍未解决，不能据本机Build接口存在宣称Worker运行测试通过。本机门禁供给、SDK真实新SHA及消费者、业务回归和云/真机联调仍按后续步骤实施。

## 统一联调：会员确认回执与旧聊天服务退役收口

平台会员 finalized 确认的真实响应为 ok、tx_hash、block_hash 三字段回执，不是会员快照。App 先校验规范交易和块摘要，再通过同一会话的 MLS 证明确认；只接受匹配本次交易的成功回执，随后以新鲜 MLS 证明读取 GET /api/membership。任何确认、回执校验或快照读取失败都传播失败，由既有订阅恢复流程保留原交易记录，不把回执解析成会员状态。此步沿用现有服务响应、接口和依赖版本，未修改链上交易或服务端会员合同。

会员用例改用真实 /api 根和三字段回执，覆盖两次 MLS 请求、错回执、快照读取失败以及无效交易/块不发请求；推送源契约同步为 PUT /api/notifications/endpoint。用例已准备，尚未运行。动态和资料夹具同步见下述当前合同；注销运行合同与回归源码已按下节更新，当前尚未执行完整普通业务回归。

旧独立 TataChatServer 的当前正式仓库登记及已安装控制台登记均已移除，旧工作仓库、专属源归档、操作目录、原待审材料和两件旧任务记录目前不存在；不重放已过时的37件候选或重复删除。当前 Cloudflare R2 与 Workers KV 完整列表未见旧服务专属资源。云端最新补查范围与剩余证据见下述记录；这些证据不代表全部环境退役或签名安装验收已完成。历史阶段叙述和拒绝旧入口的负向用例保留。

本轮只修改源码、用例、文档及原两张任务卡，没有执行产品测试、门禁、编译、部署、云DDL或资源删除。整项继续开发中。

普通动态和资料回归已按现有 /api 合同准备：动态 /8964/feed、帖子详情和本人副本 /8964/posts、上传 /8964/uploads、资料 /user/profiles/{cid_number}、作者帖子 /8964/posts?cid_number=...、资料修改 PUT /user/profile。夹具使用规范账户ID与独立CID，真实会话请求断言 MLS 证明；上传响应使用 manifest 与 media_uploads，manifest能力必须同源且属于准确上传身份。补充HTTPS根、manifest越界和资料媒体对象越界负向用例。只准备源码，尚未执行。

旧退役本轮补查结果：ChengWei账户完整列表 Workers/Pages 4、D1 2、Durable Objects 1、Queues 2、R2 4、Workers KV 2，公民域名 crcfrcn.com 的 DNS 7条均无旧独立服务专属项。citizenapp_Chat明确绑定CitizenApp；notify和citizenserve队列以及所有现存资源保留。范围以该已登录账户和公民域名为准，不推断其它账户、其它域名或未登记原生实例。用户确认没有其他部署，旧退役的其它宿主范围据此收口；数据保护钥匙串仍未取得准确调用上下文证据，剩余独立元数据核验不能据经典钥匙串结果冒认通过。

动态中文HTTP夹具明确以UTF-8构造响应，避免MockClient在JSON解析前使用Latin1编码失败；真实合同与负向用例不变，未执行测试。

本机旧独立TataChatServer启动项补查：用户 LaunchAgents、系统 LaunchAgents 与 LaunchDaemons 的准确旧产品名文件匹配均为0。此为名称范围证据，不能替代未登记Linux/其它宿主实例的定位；目前任务记录未提供可核对的原生部署地址。数据保护钥匙串也没有可在当前批准上下文调用的准确只读端口，经典钥匙串未找到项目与SQLite元数据0不能代替该证明。


## 账户注销与钱包恢复查询

唯一提交入口为 POST /api/user/deletion/challenges 与 POST /api/user/deletion，均要求当前账户会话与新鲜MLS请求证明。挑战不接受客户端指定其他CID；确认正文只有challenge_id和signature，不恢复旧/square/account/delete别名。云清理任务受理返回HTTP202及state=pending，不能据ok把它当作注销完成。

会话撤销后，POST /api/user/deletion/status/challenges接受cid_number、account_id，并从链上当前绑定核对主体；POST /api/user/deletion/status接受challenge_id、signature，只消费一次性status挑战并读取任务，不创建、推进、取消任务或重新签发会话。恢复不依赖旧会话或本机临时记录，App重启后仍可用当前钱包查询；不存在任务明确返回absent，不冒认完成。

钱包签名固定为signing_message(0x1d)=blake2_256(GMB‖0x1d‖SCALE)。SCALE依次包含字符串citizenserve.account_deletion、服务HTTPS origin、32字节chain_scope、CID字符串、32字节account_id、u64小端binding_revision、用途字节（delete=0/status=1）、32字节challenge_id、u64小端expires_at_millis。挑战有效期300000毫秒；App用本机可信IdentityBinding和实际服务origin独立构造完整字节，再比对服务下发payload。未知字段、错用途/域/链/绑定、期限、非规范nonce及任意不透明payload均拒绝，不直接签服务下发的任意内容。

主库增加account_deletion_challenges、account_deletions和约束断言表，最终schema源码为39表；本节不表示云DDL已经执行。提交在同一D1事务再次核对当前MLS授权、钱包挑战与准入，消费nonce、保存任务、撤销会话和设备并冻结该CID业务写入。已有profile writing、未完成/删除中的广场上传或其他维护对象定位使提交回滚，保留原会话、nonce及上传定位；不能凭过期/HEAD缺失认定在途写入已结束。准入、设备、会话、MLS挑战、维护定位与通知收件方的数据库断言共同防止绕过冻结。

后台复用既有Storage维护事件和同一资源绑定，每次仅执行一个有界批次：私有square/{cid}/与profile/{cid}/前缀、公开媒体、聊天，然后固定非金融白名单每次最多100行。公开对象先保存全部已分配键，再分页覆盖为零字节、无原内容或自定义元数据的空对象并刷新CDN；不物理移除这些空对象，使旧If-None-Match:*直传无法在删除后重建内容。普通公开媒体删除共用这一封堵方式，后续维护不能删掉封堵对象。私有对象每批最多8件；对象端口明确成功后才解除IO屏障，CDN刷新失败继续保留键并安全重试。每次外部对象操作前持久保存键与独占IO屏障，结果未知时保留pending及定位，不通过租约过期自动重发或标记完成。恢复查询始终能区分pending与complete；未知IO须取得明确结束证据后才可处理，不能承诺仅按超时自动收敛。

聊天清理仍使用同一附件one-shot尝试账本，每批只处理一个对象；writing且HEAD缺失继续保留定位。持久用户冻结拒绝旧Access写入、迟到收件消息、尚未开始的附件上传与收件关系。只删该CID收件箱，保留其他接收者的消息与共享幂等回执；所属附件对象明确删除后才移除代际定位。新真人准入必须晚于完成回执；旧激活重放不能清掉完成任务或解除聊天冻结。

钱包、链身份users及finalized身份/会员/创作者投影、topup_orders、chain_transaction_confirmations、chain_extrinsic_relays和永久结算/广播claim均保留。最终移除该CID云资料、通讯录、推送、动态、上传与资源用量，再移除原真人准入/激活凭据，提交complete回执。App严格校验六字段回执及当前绑定，pending保留本地资料、帖子与私信；complete后逐项尝试全部本地清理，单项失败仍继续其余项并显示本机清理未完成。

正常、失败、边界和回归用例已在既有App账户测试、Serve路由/真实SQLite和本地Worker测试，以及user/deletion.rs末尾同步准备。覆盖真实钱包签名分域、MLS提交、无会话恢复、丢失受理响应、坏挑战/回执、换绑迟到结果、未知写入与租约、持久清理、空对象阻止迟到PUT、其他收件箱和金融记录保留。本轮未执行测试、语法、门禁、编译或云操作；这些源码改动不等于运行态验收通过。

旧独立TataChatServer部署范围：用户已明确确认没有其它部署；本轮退役剩余证据仅为数据保护钥匙串的准确元数据核验。该范围确认不冒充远程主机运行核验。
