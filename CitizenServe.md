# CitizenServe 技术文档

## 平台编译现场

本产品编译任务使用本仓 `target/build/<平台>` 独立临时目录，平台键为 `cloudflare`。不同平台同时领取并执行；同平台已有活跃任务时立即拒绝再次领取。资源准备、工程副本、缓存和编译输出只写本平台现场；确认进程及后代退出、结果被调用方消费后，删除整个平台目录。`target/build` 仅是父目录，`target/test` 仍用于独立测试。独立执行和控制台调度调用同一本仓编译入口与清理接口。


## 工具与依赖的声明和供给职责

本产品完全独立管理全部流程所需的工具、依赖及其它资源需求。需求唯一依据为本仓源码、公开声明、锁文件及本产品拥有的准备配方，包括准确版本、平台、官方来源、摘要或固定提交、闭包、验真方式和失败条件；塔塔控制台按当前产品声明提供资源，不维护另一份产品需求或替产品决定版本、来源与流程步骤。

本产品必须能在没有塔塔控制台时完全独立执行全部已实现流程。独立执行时，本产品自行完成可信引导、资源获取、保存、复用及任务工作视图准备，不依赖控制台源码、私有资料、安装位置或资源库。

通过塔塔控制台执行本产品流程时，本产品向控制台声明所需资源并使用其已准备好的供给。控制台先核对并复用已有的匹配工具与依赖；没有的由控制台按本产品声明下载、准备并保存到控制台工具库或依赖库，再交付本产品复用。本产品负责直接使用交付路径，不因控制台缺件或供给失败改为自行下载，也不另建同一资源的永久副本；可写包管理器视图与流程过程数据仍归本产品当前任务工作目录。

两种执行方式使用本产品同一声明、锁和流程实现，仅资源供给职责随执行方式改变。该职责适用于本产品全部平台与已实现流程。独立模式下资源缺失由产品处理；控制台模式下资源缺失由控制台处理。显式离线缺件、交付失败、损坏、错误摘要、来源漂移或越界必须据实失败，不自动升级、覆盖可疑原件或切换执行方式。

本篇规定当前产品资源职责及已实现入口；完整运行态验收和实际执行结果归所属任务卡，不以资源接口存在证明全部流程通过。

## 当前能力与验收边界

### 编译、自动化、发布与门禁边界

`scripts/`现有三个所属入口：`build.mjs`持有本机Cloudflare Worker编译、资源、固定现场与所属回归；正式测试及组包归同名Workflow；`publish.mjs`只读核验已完成成功自动化的正式Run、Tag、Release、资产及归档成员；`tatachat.mjs`在原位置独立管理聊天云资源声明与受控维护能力。没有旧脚本转发入口。

`.github/workflows/release-cloudflare.yml` 与同名 MJS 独立负责 GitHub 身份、版本、固定工具准备、Cargo/Node/Python/Worker 真实测试、Worker 编译、十件成员组包、Run、Tag/Release 与三件资产上传回读；不调用本仓 Build。Linux 工具官方来源与包成员在现有 `Cargo.toml` 元数据中唯一声明，Build、Workflow、Publish 分别读取所需字段。`publish.mjs` 继续只读验真正式资产。`.github/tatagate/tatagate.mjs` 只读核对主检出、目录闭集、流程方向、登记文件、自动化声明和语法；原产品专属安全检查仍需逐项复核。用户明确保留聊天云资源独立脚本 `scripts/tatachat.mjs`。代码尚未执行正式 Runner 流程。

根库入口为lib.rs，业务模块直接位于产品根；平台实现为Cloudflare Worker，Linux ARM仅预留。账户服务要求当前链身份、真人准入、设备、会话与新鲜MLS证明。health保持account_services_ready:false，完整Worker、真实云资源、支付、推送及客户端真机验收尚未完成；历史阶段结果不作为当前源码通过证据，执行事实归所属任务卡。

## 根目录职责

test保存所属测试源码、夹具及test/worker/package.json、package-lock.json。测试依赖展开件归当前临时工作现场：target/test/worker-smoke/test/worker/node_modules或target/build/cloudflare/worker-smoke/test/worker/node_modules，按当前流程选择；与npmView、workerTestView使用同一位置。这些内部目录仅在本轮任务期间存在，工具退出、结果核验与记录完成后，成功和失败均清空当前工作根，不保留依赖展开件。源码test目录不保存node_modules；根target整体排除源码目录结构审查，依赖仍须按资源回执与锁验真后使用。

server通用宿主位于第1级，cloudflare平台适配位于第2级；普通业务存储适配、SQL及聊天平台适配分别归第3级repositories、sql、tatachat。Cloudflare聊天适配的attachment、key、mailbox、push、realtime仅为Rust逻辑模块，不再建立对应第4级源码目录。

server/cloudflare/tatachat直属文件为config.rs、routes.rs、lifecycle.rs、maintenance.rs、schema.sql；attachment.rs、attachment_objects.rs、attachment_store.rs；key.rs、key_store.rs；mailbox.rs、mailbox_store.rs、mailbox_commit.sql、mailbox_acknowledge.sql；push.rs、push_provider.rs、push_store.rs；realtime.rs、realtime_device.rs。模块入口用Rust正式path属性定位所属内部实现，保留原逻辑模块、可见性及super关系；收件箱源码和SQLite合同测试读取同一直属SQL文件。上述结构调整不改变接口、数据、协议或授权。

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
| /Users/rhett/citizenserve/tatachat/ | 按auth/protocol/key/mailbox/attachment/push/realtime分目录维护的通用聊天 | 通用核心已接入根库；Cloudflare数据面源码已装配，当前Worker统一编译与运行态仍待验收。原chat已删除，公民授权归user/membership/server。 |
| /Users/rhett/citizenserve/server/cloudflare/ | 10项用户授权/恢复、35账户、29工具API、RPC、D1/R2/Queue/Cron/WebCrypto | 完整ESM/WASM、本地fetch/queue/scheduled验收通过；生产兼容日期、线上资源/推送与正式发布未验收。 |

主库规范DDL位于server/cloudflare/schema.sql，当前39张产品表；下载库独立1张，聊天库独立使用tatachat/schema.sql。数据库结构和授权围栏由真实SQL定义，不复制为宿主影子模型；源码结构不代表线上DDL已经执行。

## 注册、设备与会话接口

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

正常业务顺序固定：确认注册→Cloudflare→CitizenServe保存通过结果→原钱包签名/上链/finalized完成CID注册→MLS设备授权激活→账户服务。验证前不计算CID。

### 链身份、准入与授权

权威RPC固定来自CHAIN_URL并携带服务端Access认证；每次先核对CHAIN_GENESIS_HASH，再取canonical finalized头。使用锚定metadata V14/V15/V16完整解码SCALE，events用parent runtime、storage用目标post-state，拒绝截断/尾随/未知编码。读取CidRegistry、AccountIdByCid、CidByAccountId、BindingRevisionByCid，核对active及双向绑定；公民/居民类型和修订只取真实链。投影保留实际注册块/时间，投票资格按链Timestamp的UTC+8日期解析。

身份投影返回finalized_block_number/finalized_block_hash/identity_event_count/projected_user_count/revoked_user_count。单块目标确认不前跳全局游标；Cron一次最多10块顺序补齐，投影/凭证撤销/游标在同一batch提交。同块账户释放先于绑定写入，CID排序不会改变结果。历史事实不能冒充当前授权。

当前身份确认期限最长60秒，15秒刷新租约合并竞争，缓存读取不延长期限。激活强制读取当前链；普通调用到期重新核验，RPC未知/失败即拒绝。Cron五分钟不承担60秒撤销时限。

挑战5分钟、每CID每用途最多64条；registration只绑定POST /api/user/devices，session只绑定POST /api/user/sessions。purpose=request仅面向实际在册的受保护业务目标，并绑定同一有效会话摘要。证明始终绑定实际方法、含/api的完整路径/查询、原始正文摘要、当前CID/修订/同一公钥。钱包GMB0x1C/Sr25519与MLS RFC9420 SignWithLabel/Ed25519都先验签，再原子消费挑战；消费后的业务失败不恢复nonce。

激活提交原子包含设备、cid_admissions与登记activated。数据库断言失败令整个batch回滚，普通CAS零行不能误报激活成功；提交后复查三个事实。登记只能固定到同一CID/账户/修订/设备；同结果用新挑战幂等返回。enrollment_id/recovery_token显式null只能复用服务器已存在的真实CID准入，再验当前钱包与新设备持钥；仅有链上投影不豁免。旧issued_at/修订、已撤销旧授权和跨环境复用拒绝。准入source仅turnstile，没有旧设备自动导入。

普通会话sqs_加16字节随机数的32位小写hex，只持久化SHA-256；created_at/expires_at统一Unix毫秒，24小时、每CID最多8条且保留本次新令牌。会话、准入、设备与当前绑定均由D1权威核对。换绑/吊销与投影同事务撤销旧设备、会话、挑战及推送端点；CID资料和真人依据保留。通用聊天只收到私有字段Authority经核验后构造的许可，15分钟上限之外另带最长60秒再核验期限。

配置须提供变量WEB_ORIGIN、REGISTRATION_SCOPE、TURNSTILE_SITEKEY、CHAIN_GENESIS_HASH、CHAIN_URL，秘密HASH_KEY、TURNSTILE_SECRET、CHAIN_ID、CHAIN_SECRET及DB/RATE_AUTH绑定。仓库未保存或猜测CHAIN_URL部署值，也未读取秘密或操作线上绑定；缺配置固定失败。注册族错误保留retryable/next_action，底层D1/RPC异常不公开。

## 运行边界与未来自建兼容

当前只落地Cloudflare WASM，平台依赖在 /Users/rhett/citizenserve/server/cloudflare/Cargo.toml。共同库不引用worker/D1/R2/Tokio/PostgreSQL驱动。具体业务端口表达完整原子操作；平台适配不能把先读取后写入当作同等事务。

未来自建接入须使用相同逻辑身份、对象键、时间单位、摘要和授权合同，scope/origin不编码部署商，缓存不作准入事实源。当前没有自建服务器运行crate、迁移crate、导出/导入、切流、迁移CLI或控制台按钮。

## 检查与构建

Cargo.lock与rust-toolchain.toml锁定本产品工具和依赖。产品测试通过scripts/build.mjs test cloudflare --work /Users/rhett/citizenserve/target/test显式执行；门禁通过.github/tatagate/tatagate.mjs local消费同一公开测试与资源能力，门禁自身仓库检查和回执独立完成。测试先对本轮固定现场执行生命周期用例并收尾，再准备当前任务资源。控制台模式只经公开供给接口交付原件路径；缺件或真实执行失败据实失败，不切换独立获取。Python用例直接加载Cloudflare生产SQL运行实际SQLite，不冒充线上D1。

Cargo生成 /Users/rhett/citizenserve/target/build/cloudflare/cargo-target/wasm32-unknown-unknown/release/citizenserve_cloudflare.wasm；官方worker-build 0.8.5生成 /Users/rhett/citizenserve/target/build/cloudflare/worker/index.js 与 /Users/rhett/citizenserve/target/build/cloudflare/worker/index_bg.wasm，Wrangler直接使用index.js。兼容shim由工具生成，不作正式main、不手改生成JS。WASM禁用strip以保留wasm-bindgen所需externref表。本地测试依赖锁在 /Users/rhett/citizenserve/test/worker/package-lock.json，使用Node25.2.1、Wrangler4.149.0和Miniflare5.20261006.1-alpha，workerd及其平台二进制包统一1.20261006.1；所有外部请求由闭合测试服务接管，没有真实链/推送调用。配置 /Users/rhett/citizenserve/server/cloudflare/wrangler.toml 已包含Queue/两个Cron，生产兼容日期仍为2026-10-07；当前Worker测试使用同一生产日期2026-10-07；旧workerd1.20260804.1仅支持至2026-08-11的历史问题由本轮测试声明/锁升级处理，本轮已实际编译及打包当前WASM，并以同一日期启动新workerd；当前完整入口实际通过Rust214项、SQLite145项、生命周期14项、Node合同49项及真实WASM/workerd42项，失败/跳过/取消/todo均为0；9项静态/RPC/CORS包含3秒总超时、128KiB边界、HEAD、Access隔离及公共/App独立CORS。通过本地闭合夹具不证明云端TLS或钱包实机验收。 test/worker/worker_smoke.mjs已增加9项静态交付及RPC/CORS回归，覆盖成功、HEAD、固定源、路由拒绝、媒体类型/UTF-8/重定向、128KiB边界、响应头/正文超时、缺Access配置及RATE_READ；使用闭合合成上游，测试供给符合external_rate原有32字节密钥下限，不代表生产TLS、静态文件或钱包验收。本轮Worker测试视图的modulesRoot准确指向target/build/cloudflare/worker，夹具请求使用本轮WEB_ORIGIN；正式配置的WEB_ORIGIN仍为https://www.crcfrcn.com。Worker统一入口在附加安全头和CORS前复制可修改响应头，保留原正文流及WebSocket升级连接，兼容运行时不可修改的上游响应头。

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

继续使用POST https://www.crcfrcn.com/api/user/challenges（内部/user/challenges）申请purpose=request；其准确六字段与16KiB预算不变，本次挑战另外绑定合法会话摘要。注册、设备和会话按本篇接口处理，不增加兼容别名。

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

这里「注册前」只表示Cloudflare验证先于原有CID注册执行，不要求用户提供或计算CID。只允许使用下表四个预注册接口：prepare检查已有账户/类型/链公开上下文，页面检查页面能力，verify/status检查本登记恢复能力。验证成功仅保存human_verified；原有钱包授权、CID finalized和MLS设备激活完成后才取得账户服务权限。完整目标请求地址见本篇注册、设备与会话接口，不能把内部路径或预注册入口当作广场、聊天、通讯录、订阅的访问授权。

| 接口 | 准确请求字段与行为 |
|---|---|
| `POST /user/registration` | 准确四字段`protocol_version, chain_scope, account_id, institution`。不接受CID或CID年份字段。创建验证登记并返回恢复秘密；只有第一次响应包含它。prepare响应丢失时，客户端尚未验证或签名，可重新准备；旧未验证记录到期清理，不通过公开ID重发恢复秘密。 |
| `GET /user/registration/page` | 查询仅`verification_id, page_token`。校验页面能力、同源/范围、期限及登记仍为prepared；不在URL放recovery_token、钱包材料或MLS秘密。 |
| `POST /user/registration/verify` | `protocol_version, enrollment_id, recovery_token, verification_id, turnstile_token`。prepared时token为1至2048字符字符串；已保存同一成功尝试的合法重试允许token为null，直接返回状态，不再调用Siteverify。 |
| `POST /user/registration/status` | `protocol_version, enrollment_id, recovery_token, operation`。operation闭集`read, refresh_verification, cancel`；read只查询，refresh仅在prepared时换发页面能力，cancel只取消未激活登记，不撤销链交易或有效设备。 |
| `POST /user/devices` | 正文为准确六字段`account_id, public_key, issued_at, binding_signature, enrollment_id, recovery_token`并携带既有X-MLS-Proof。首次激活后两字段必须有效；已具有效真实CID准入的设备重试/新增设备可显式null，由服务器判断资格；本产品无迁移豁免。删除正文中的turnstile_token，不接受新旧格式并行放行。 |

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

当前准入source仅真实turnstile。普通CID投影没有准入资格，旧设备不自动获准；已获准CID增加设备仍须当前钱包授权和新设备持钥证明；服务器依据有效准入事实决定是否复用，客户端不能自报豁免。

创建/续期会话、受保护请求和聊天授权检查当前有效绑定、准入依据及设备状态。撤销设备或CID、换绑及资格变化使旧授权失效，不删除仍属该CID的业务资料或重建MLS秘密。普通会话、钱包签名、恢复凭证和聊天访问权限不能互换用途；真人通过不免除订阅、会员及其他业务权限。

### 聊天授权边界

A提供的宿主权限语义为：来自合法当前会话的user_id与device_id、有效设备/准入状态、业务判断后的chat_enabled和max_attachment_bytes、服务器签发时间和到期时间、可检查的权限修订。账户、钱包修订和会员名称留在宿主适配内。只有通过资格的设备能输出有效权限，客户端请求中的ID不能直接成为模块身份。

聊天权限最长15分钟，且不能晚于普通账户会话、已知会员或设备资格到期；聊天服务端必须执行连接到期，不能只靠SDK timer。撤销/换绑/资格变化传播上限锁定为60秒；超过期限仍无法重新确认状态时拒绝继续处理，禁止错误时沿用旧许可。宿主撤销状态与可恢复事件在提交后可查，通用Host端口负责可靠再核验。公开函数和类型由tatachat模块定义，不在宿主复制通用模型；调用合同必须满足上述身份、到期和撤销语义。

注册完成不要求先建立聊天连接或先购买聊天会员。公民App所选账户不是默认账户时，身份适配必须明确解析冻结账户；不得把默认账户的MLS身份或签名误用于本登记。SDK通过公开接口取得所需账户输入，不复制服务端私有运行实现。

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

以下R01至R14标识只定位业务及失败边界，不表示当前验收通过；执行结果归任务卡。

| 编号与当前重建步骤 | 输入或事件 | 必须验证的结果和副作用 |
|---|---|---|
| R01 | 验证前不计算/提供CID，合法四字段prepare；重复键、额外字段或错版本 | 合法创建prepared；传入CID/年份等额外字段拒绝；不写非法登记、不调用外部、不查会员。 |
| R02 | 错genesis/账户/机构码/环境；换冻结上下文 | 拒绝，不能挪用原登记或验证结果；校验不依赖CID。 |
| R03 | 错/缺hostname、action、cdata、时间或success | 不产生human_verified，不输出许可。 |
| R04 | token超期、重复或伪造；网络超时后同UUID重试 | 不把重复/超时当成功；重试键和token摘要一致，有限外部调用。 |
| R05 | 成功响应丢失、并发verify、刷新旧尝试 | 已保存结果可恢复；CAS只通过一次，旧尝试不能覆盖新结果。 |
| R06 | 10分钟prepared、24小时已验证、页面5分钟、容量/限流边界 | 即时拒绝超期；计数创建/回收并发正确；不泄漏恢复秘密。 |
| R07 | 用户取消、验证失败、页面错误、并发确认 | 原CID注册入口/钱包签名/链提交调用均为0；没有验证前CID计算；单一在途流程、状态正确。 |
| R08 | 重启、账户切换、跨UTC年或选择非默认账户 | 复用合法账户验证记录；未开始的原注册按原规则执行，已开始的交易按原检查点恢复；不盲目重发或使用默认账户秘密。 |
| R09 | 缺真人记录、未finalized、钱包签名错或MLS证明错 | 不激活设备、不签会话；原有真实链事实保留。 |
| R10 | 同登记同设备重复/并发；换公钥、修订或旧issued_at | 合法幂等，不重复登记；冲突拒绝，不覆盖新绑定。 |
| R11 | 仅链上投影、未激活、已撤销或旧绑定 | 广场/通讯录/订阅会话和聊天权限拒绝，业务资格仍分别检查。 |
| R12 | 冷签超过5分钟、finalized后断网或激活响应丢失 | 复用真人记录和MLS身份；仅续办缺阶段，未知交易先查询，重发次数0。 |
| R13 | 可信旧设备和仅有CID；增加新设备；MLS材料丢失 | 按准入来源迁移/补验；新设备控制权必验，不伪造历史验证、不恢复旧秘密。 |
| R14，A2/7/8，B聊天执行 | 资格到期、撤销、换绑、状态服务失败 | A不输出失效许可；B到期执行、60秒内撤销传播，失败不保留旧授权。 |

### 业务与存储合同

1. **先固定路由和端口。** 将下表17项控制面入口纳入统一守卫和purpose=request挑战。证明继续签实际/api路径、原始查询和原始正文SHA-256；GET/DELETE为空正文，拒绝重复/未知参数、错误方法和旧/square别名。资产PUT是受预算限制的二进制，不先解析JSON。原MLS总正文上限1MiB无法接纳旧banner的1536KiB，本产品明确将服务端总上限提高到2MiB，仅banner允许1536KiB，其他路由预算不扩大；SignWithLabel/GMB载荷和密钥算法不变。
2. **先核对链，再确认订阅。** 只在固定CHAIN_URL增加chain_getBlock；完整读取canonical finalized块，按metadata解析完整extrinsic/扩展/调用，计算整个extrinsic的BLAKE2-256 tx_hash，检查实际签名账户、指定phase的成功结果、真实业务动作与同一区块storage。不靠事件字节扫描、客户端申报action/价格/会员或历史投影授权。平台、创作者计划/名称、订阅和价格由同锚点解码；Platform/Creator及未知枚举不得互用。价格完整u128解码，对既有HTTP/D1安全整数出口严格检查，越界拒绝，不截断或用浮点近似。
3. **会员投影和服务。** 以永久CID为属主，保持Active/Cancelled且paid_until晚于服务器/链时间的权益判断，Expired/Terminated/Suspended/IssuerPaused不能取得写权限；身份档位与会员档位独立。确认记录、会员/档位/关系投影及事务证据在一次D1事务中写入；同tx同规范结果幂等、同tx不同业务结果拒绝，较旧块不能覆盖新事实。当前资格最长核验60秒，事务内再检查期限；RPC未知不降级为无会员。恢复创作者最多10档、名称20 Unicode标量、月/季/年三种真实公历价格、当前订阅与概览。投影catch-up核心使用独立已有membership_projection_cursor、整块提交、限定工作量；Cron任务调度及过期内容清理归现有调度与维护模块。
4. **按会员原子预留，再发上传计划。** 恢复三种post_type：document无标题、文字≤300 Unicode标量、≤9张图且内容非空；video无标题、配文≤300标量且恰好1个视频；article标题10至50标量、正文1至30000标量、首项必须为图片，图片含封面共50/100/100张、视频最多1/3/10个，规范content_sections与媒体引用逐项验证；manifest≤256KiB、最多110媒体；保持Freedom/Democracy/Spark的原图像1/2/4MB与1280/1920/2560边界、视频16MB/300MB/3GB及180/1800/10800秒、缩略图256000B/封面512000B、月图片300/1500/5000、月视频18000/60000/600000秒、活跃上传1/2/3、存储100GB/1TB/10TB（十进制）。服务端计算估算量；月额度周期沿用链上last_charged_at至paid_until，不按主机时区或自然月另建重置时钟；已用+未过期预留+本次须在同事务核对；prepare先持久预留再返回15分钟计划，不信客户端余额/用量。发布仍须有效会员。
5. **R2校验后才能complete和publish。** 主媒体/衍生图直传R2，SigV4限定PUT、唯一对象键、Content-Type/长度、完整SHA-256与upload_id/media_index/object_role；大视频字节不经Worker代理或装入内存。manifest进私有桶，媒体进公开桶。complete核对R2实际大小、内容类型、完整校验和/自定义元数据；WebP解析真实结构/尺寸，HEVC MP4解析有界BMFF box与moov前置/hvc1或hev1，而非查找任意字符串。视频前缀读取最多4MiB，主视频完整校验和由R2验证，错误尺寸/时长/哈希不能ready。预留转实耗、上传complete和媒体ready事务幂等，不重复扣量。发布必须再绑定同区块链上SquarePost事实、本人CID/钱包、post_id/content_hash/storage_receipt_id/类型/分类与已完成上传；分类只由该finalized区块身份派生：candidate为campaign，visitor/voting为normal，客户端不申报分类。
6. **阅读、资料媒体与删除闭环。** 详情及本人回灌验证原始manifest字节/哈希、上传和帖子归属；回灌固定最多5条、复合游标、不重编码原始字节，一条不完整整页失败。资料媒体仍用本CID固定avatar/banner键，prepare保存在有期限的profile_asset_uploads；条件写/代际核验拒绝旧上传覆盖新版本，PUT完成事实后资料引用变更才能使用对应哈希。读取私有资料对象先过会话/MLS守卫，再校验当前引用哈希、Range/ETag。删除/取消先保留D1定位和删除状态，再批量删R2主媒体+衍生图+manifest及有界清缓存，全部确认后原子删索引并精确一次释放存储/未使用预留；已消费月额度不因删除返还。D1和R2没有共同事务，失败保留定位/状态供幂等重试，不能假报全成功或丢掉待删除对象依据。
7. **只补本产品所需Cloudflare装配。** 配置SQUARE_PRIVATE=citizenserve-private、SQUARE_PUBLIC_MEDIA=citizenserve-media；恢复历史公开media.crcfrcn.com域名、CF_ACCOUNT_ID公开标识及R2_KEY/R2_SECRET/PURGE秘密的声明，不读取/写入秘密，不创建或部署资源。控制面仍全部位于www.crcfrcn.com/api。公开已发布媒体由R2/CDN交付，不经Worker/D1；私有manifest/资料不从公开域名交付。恢复历史RATE_READ=120/60秒、RATE_WRITE=30/60秒，保留RATE_AUTH=10/60秒；request挑战按受签业务读/写类别分档，避免认证档位把普通业务统一压到10次。其余绑定以本仓当前wrangler.toml及资源声明为准。
8. **验收要求。** 运行真实签名/完整metadata与extrinsic向量、真实SQLite并发额度/版本/严格幂等/故障回滚、WebP/BMFF恶意样本、SigV4金标、R2端口故障/条件写/Range、完整WASM检查。测试适配器不冒充真实Worker/R2/RPC；本产品不发布、不执行线上DDL。更新任务卡/产品文档/注释、清理临时产物，health保持account_services_ready:false直到整套回补验收。

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

继续复用POST https://www.crcfrcn.com/api/user/challenges（内部/user/challenges）；普通request挑战还须同一有效Bearer会话。GET https://www.crcfrcn.com/api/8964/posts?cid_number=<CID>等社区路由保持，/posts/self与/posts/confirm必须先匹配，不能误作post_id。

媒体完整交付目标为：
- 已发布主图：https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/source.webp。
- 已发布视频：https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/source.mp4。
- 缩略图/封面：https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/thumbnail.webp、https://media.crcfrcn.com/square/{cid_number}/posts/{post_id}/media/{index}/cover.webp。
- 客户端源文件/衍生图直传：https://f088b553d27d9c26b81f48f1924c3bbd.r2.cloudflarestorage.com/citizenserve-media/square/{cid_number}/posts/{post_id}/media/{index}/{filename}?<服务端SigV4查询>；只使用prepare返回的完整URL与签名头。
- 私有manifest对象键：square/{cid_number}/posts/{post_id}/manifest.json，仅通过上述受保护控制面读写；资料对象键：profile/{cid_number}/avatar、profile/{cid_number}/banner。

当前CHAIN_URL没有已核实部署值，方案只读取既有配置并保持固定HTTPS源/Access认证，不凭空填写域名。本产品不开放任意RPC URL或自建迁移入口。

## 充值、结算、下载与链工具

注册主线继续为：点击确认注册→Cloudflare验证→CitizenServe保存通过结果→原钱包签名、上链及finalized完成CID注册→MLS设备授权激活→开放账户服务。没有生成候选CID，没有把充值或网络工具当成准入凭据，没有再增加Cloudflare弹窗。MLS私钥始终在TataChatSDK本机。

### 业务与权限合同

1. **固定精确路径与权限。** 统一功能前缀为/api/topup、/api/downloads、/api/chain；不保留旧/square、单数/download、根/constitution或/operations别名。将以下29项API方法及独立rpc域明确分为公共链/下载工具、HMAC付款意图、SETTLE_TOKEN结算和专用HMAC发布四类，逐方法逐路径登记；它们均不能访问广场、聊天、通讯录、会员或用户资料，现有普通账户服务守卫和MLS实际路径证明不改。保留冷钱包/代充的原产品能力，充值目标AccountId可未绑定CID；RPC失败不能记成“未绑定CID”。客户端不得让未完成准入的主体访问账户服务。
2. **报价、付款意图与付款人授权。** Base主网8453、USDC/USDT两条既有代币轨、6位最小单位；pkg_15为15000000原子单位→1000000公民币分，pkg_1400为1400000000→100000000分，金额以精确整数字符串交付。意图绑定目标AccountId、实际当前CID或null、付款地址、币轨/合约、收款地址、套餐/金额、唯一intent_id和签发/十分钟到期时间，保留服务器HMAC能力令牌。旧代码只有客户端申报payer_address及“签发早于区块”检查；观察待打包交易后仍能先造不同目标意图，所以增加**付款钱包签署完整充值意图**：intent响应返回服务端生成的wallet_authorization_message；confirm准确增加payer_signature字段。EOA以ERC-191 personal_sign恢复付款地址；合约付款钱包按该canonical付款块的ERC-1271只读验签。任何地址、目标、金额、链/域或意图变更均使签名失效，私钥不上传。客户端签名交互归CitizenApp，服务端按同一公开付款授权合同验证。
3. **以真实EVM链事实创建订单。** 固定TOPUP_BASE_RPC_URL，不接受客户端RPC URL；核对eth_chainId=8453、交易/receipt哈希、成功状态、实际token Transfer事件、付款/收款地址、足额u256金额、log所属canonical区块、区块时间和确认策略。付款发生时间必须晚于意图签发且不晚于十分钟到期；配置min_confirmations=0沿用finalized，否则使用准确确认数并核对canonical hash。未知编码、链错、重组、超时或缺区块不能成功。同(chain_id,evm_tx_hash)与intent_id双唯一，同意图/同准确规范事实幂等，不同意图抢占拒绝；保留原pending/paid/exception三态，RPC待确认不落新终态。将准确付款区块/日志、意图及钱包授权摘要和核验期限存入原topup_orders相应列，一次原子写入，不设影子用户。保留IP和目标AccountId限速、外部付款RPC每链300次/60秒D1全局硬顶；重复已确认查询不再打付款RPC。
4. **排他claim与双链结算。** 仅常量时间匹配SETTLE_TOKEN的结算客户端可操作。pending≤50，history≤100并用(confirmed_at,order_id)稳定游标合并三态。claim同ID幂等、不同ID排斥，永不自动过期释放；服务端不持发币私钥，不自动签发/广播公民币。settled在当前claim下复核Base付款，并用目标块metadata完整解析OnchainTransaction::transfer_with_remark、整交易哈希、canonical finalized块/准确index/整签名字节、配置发币账户、准确受益AccountId/金额、topup:<order_id>备注、同phase的唯一System.ExtrinsicSuccess且无失败、准确TransferWithRemark事件；不靠硬编码pallet/call index或“交易包含在块中”宣称转账成功。抽取现有通用signed/finalized核心时保留会员/帖子专用CID及SquarePost核验。最后一次D1事务比较claim、订单与全部证据，重复paid须完整证据一致；同GMB交易不能付给两笔订单。exception须匹配claim及准确理由，不从异常自动恢复或重新发币。
5. **正式下载和发布指针。** App/Wallet Android从各自固定crcfrcn产品仓读取正式非draft/非prerelease Release；公民链四平台继续使用独立CITIZENCHAIN_DOWNLOAD_DB的准确显式发布指针，保留平台对应Tag/源码SHA/资产名/资产SHA/revision。只恢复实际存在的macOS updater，不能凭空增加另外三平台updater。GET/PUT publication使用CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET及准确x-citizenserve-request-time、nonce、signature三头，HMAC规范为method、**实际/api完整路径**、时间、nonce、原始body SHA-256五行，时钟±5分钟；拒绝查询、错平台/域、坏摘要与额外字段。PUT expected_revision原子CAS，publication=null明确撤回；同规范结果幂等、旧revision不能覆盖新发布。普通会话及结算令牌没有发布权。固定GitHub官方源、仓/Release Tag/资产/HTTPS路径，有界响应和精确302目标，展示缓存≤300秒；无指针或缺实际资产不能造下载结果。本产品不写线上指针、不创建Release。
6. **链引导、宪法及受控广播。** App与CitizenSDK两个bootstrap保留各自exact schema、SS58=2027/GMB两位小数、已登记创世hash/state_root/bootnodes、签名安装包bundled chainspec/light_sync_state及P2P finalized信任合同，不下发可替换checkpoint或服务端节点/Access秘密。返回当前/api实际服务路径；广播显式关闭时返回不可用。宪法从同一canonical finalized块的LegislationYuan Laws(0)已生效版本、LawVersions、LawVersionLabels与ConstitutionImmutableManifest完整解码，拒绝尾字节/非法层级/超大内容，保留中英标签与准确更新时间；展示缓存≤300秒不能用于授权。POST extrinsics只收signed_extrinsic_hex，不收私钥/助记词、账户申报或任意RPC方法；原始extrinsic≤65536B、JSON≤131584B。显式RELAY_ENABLED=1及实际固定节点配置后才调用author_submitExtrinsic；IP每分钟20次跨PoP硬顶、SHA-256十分钟去重与排他占用，验证节点tx_hash与完整extrinsic BLAKE2-256一致。广播超时保留不确定结果/定位，不假报失败后自动重发；广播成功只表示broadcast，不签发CID/准入/会话或宣称finalized。
7. **独立公共EVM RPC与本产品本地装配。** https://nrcrpc.crcfrcn.com/根GET/HEAD交付MetaMask接入页，同域/icons/gmb.png的GET/HEAD交付PNG；根POST/OPTIONS固定代理CitizenChain的EVM节点，不是充值用Base节点。页面与PNG由CitizenChain节点自身的同一HTTPS RPC端点交付，资源源码和产物归node；cloudflared直接连接节点，机构部署参数留在服务器与Tunnel配置中。静态资源只读取CHAIN_URL的origin及两个准确路径，以服务端Access身份执行GET，禁止重定向；3秒总超时覆盖响应头和正文，实际正文最多128KiB，校验text/html或image/png，HTML必须有效UTF-8。GET/HEAD共用RATE_READ，HEAD核验资源后丢弃正文，错误及限流也保持空正文；公开响应独立设置媒体类型、no-store及公共CORS，不透传上游头、Cookie、凭据或错误。严格保留26项方法，单次/批量≤20项、JSON正文≤128KiB、合法唯一id、明确params预算及真实节点result/error；不执行通知、重复ID、未知方法或私钥参数。eth_getLogs≤1000块/32地址/4层topics，feeHistory≤1024块/100百分位，accessList≤64×64；固定Access源、10秒超时、有界响应、逐项限制及最大全局工作量，不开放任意Substrate JSON-RPC代理。本地声明既有下载D1/CACHE和准确域/秘密/变量，不读取或上传秘密、不创建资源、不部署。共同Rust核心保持无worker/D1/R2耦合，本产品不写自建服务器或迁移工具。
8. **验收要求。** 覆盖真实HMAC/ECDSA/Keccak及ERC-191向量、ERC-1271合成RPC、付款被他人观察后不能抢单、错目标/错链/错币/不足额/过期/重组、完整GMB成功及失败交易、同交易不同订单、24并发意图/付款/claim/广播/发布CAS、持久claim崩溃、故障保留不确定状态、完整引导/宪法和26方法边界、正式Release与实际/api HMAC互操作。生产SQL原文在SQLite运行，模拟端口明确标为模拟。运行全量fmt/测试/Clippy/WASM Release/WebAssembly.compile，回归现有授权/社区/内容合同，health继续account_services_ready:false。

### 付款钱包签名合同

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
| GET https://www.crcfrcn.com/api/chain/runtime-target | /chain/runtime-target | WASM Release只读链目标：块0哈希、finalized头、spec_version与spec_name；固定字段、无查询与请求体，读取限流及no-store。 |
| POST https://www.crcfrcn.com/api/chain/extrinsics | /chain/extrinsics | 仅signed_extrinsic_hex；显式开关、限流/去重的广播工具。 |
| GET/HEAD https://nrcrpc.crcfrcn.com/ | 独立域根/ | MetaMask接入页，读取固定受保护静态源。 |
| GET/HEAD https://nrcrpc.crcfrcn.com/icons/gmb.png | 独立域/icons/gmb.png | 指定PNG图标；其余路径及该路径其他方法拒绝。 |
| POST/OPTIONS https://nrcrpc.crcfrcn.com/ | 独立域根/ | 26方法JSON-RPC公共钱包网络入口；不接受/api别名。 |

public是保留的链网络/安装包/报价能力，不代表未通过验证者能进入账户业务。上述公共广播同区块链P2P一样不能在共识层强制所有链上CID注册都经过Cloudflare；本项目要求落实的是CitizenApp完整注册主线和CitizenServe账户服务准入，不能把网络API误说成全链真人证明。

`/api/chain/runtime-target`由现有Worker使用自身`CHAIN_URL`及Access服务身份经既有Tunnel查询，先以配置的创世哈希核对真实块0与canonical finalized头，再在该头读取`state_getRuntimeVersion`并要求`specName=citizenchain`及有效u32版本。公开请求仅接受精确GET、空正文与无查询参数，返回四个固定字段；沿用`RATE_READ`，响应`no-store`，不向调用方交付上游URL、Access凭据、任意RPC方法或错误正文。GitHub WASM Release另以本仓冻结常量复核返回的块0哈希；该接口成功不代表Runtime已经升级。

### 实际固定后端地址和配置来源

- 正式App/Wallet Release源：https://api.github.com/repos/crcfrcn/citizenapp/releases?per_page=100、https://api.github.com/repos/crcfrcn/citizenwallet/releases?per_page=100；链固定Tag读取：https://api.github.com/repos/crcfrcn/citizenchain/releases/tags/{version_tag}。下载只返回对应https://github.com/crcfrcn/{product}/releases/download/{version_tag}/{asset_name}，禁止任意仓/外部URL。
- 平台Tag：citizenchain-macos-v<版本>、citizenchain-windows-v<版本>、citizenchain-linux-arm-v<版本>、citizenchain-linux-amd-v<版本>；对应citizenchain-node-macOS-v<版本>.dmg、citizenchain-node-Windows-v<版本>.exe、citizenchain-node-LinuxARM-v<版本>.deb、citizenchain-node-LinuxAMD-v<版本>.deb。保持真实发布身份，路径改小写不改资产大小写。
- 旧正式配置登记的Base源是https://mainnet.base.org；实施时仅从TOPUP_BASE_RPC_URL加载固定HTTPS源，核实准确币轨合约/decimals/实际资产种类，以合约白名单为准，不凭symbol识别或把桥接资产说成原生资产。TOPUP_RECV_ADDRESS、TOPUP_DISBURSE_ACCOUNT_ID和两币合约对照历史公开配置，未核实不猜填、不增加新网络/供应商。
- CitizenChain只从既有CHAIN_URL/CHAIN_ID/CHAIN_SECRET固定Access源读取或受控广播；实际CHAIN_URL部署值目前未核实，不凭空写域名。公共EVM源属于该CitizenChain节点，不转给Base源。
- 本地声明下载D1：CITIZENCHAIN_DOWNLOAD_DB，citizenweb-download，fa70d613-ff33-43d3-aecd-84f1baef3918；展示KV沿用SQUARE_CACHE，d632942d82c94e45ab4058fa69268ce1。专用秘密为TOPUP_INTENT_SECRET、SETTLE_TOKEN、CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET，仅声明，不读值、不线上写。
- 当前/api归一化与付款签名/HMAC变更先实现服务端合同；App及产品发布器必须在各自后续接线验收新实际路径，未验收前不能替换生产。

## 通知、调度与维护

通知、Queue与Cron维护归notifications及Cloudflare适配；通用聊天及附件归tatachat。当前只实现Cloudflare，不增加自建平台迁移或其它产品接入。

### 业务合同

1. **当前设备的端点API。** 新增PUT/DELETE /api/notifications/endpoint，走现有purpose=request挑战、Bearer会话、新鲜X-MLS-Proof和写事务授权复核。CID、账户、修订、设备只取服务端已验身份；不允许正文自报device_id。PUT准确四字段push_provider、push_token、apns_environment、expires_at；APNs环境为sandbox/production，FCM必须显式null，Unix毫秒期限在当前时间之后且≤90天。APNs token规范64位hex，FCM有界可打印token；请求≤16KiB。每CID最多8个有效端点，当前设备同结果幂等、轮换递增endpoint_revision。同provider/token保持唯一，**不静默抢占其他有效设备/CID的token**；原属主先用授权DELETE释放，或服务端证实原端点已过期/原设备与绑定已撤销后才可登记。DELETE空正文，只删除当前已授权设备端点。同一设备轮换、TTL续期、换绑或吊销使旧代际任务失效。不会新增Cloudflare验证或生成MLS密钥。
2. **先持久化通知，再交Queue。** 主库包含notification_jobs、notification_deliveries、maintenance_jobs、scheduler_leases；当前主库共39表，下载库独立1表；现有push_endpoints增加单调endpoint_revision，会员清理提醒绑定同一权益失效周期。帖子确认事务同时写唯一post_id/tx_hash来源的outbox，失败全回滚，幂等发布不重复生成任务。清理提醒同样和提醒事实原子持久化。消息仅携带版本、固定任务类型和数据库job_id/delivery_id，不传任意URL、token或客户端推送正文；消费者重新读取D1权威事实。投递记录固定目标CID/绑定修订/设备/端点代际、来源和截止时间。Queue发送失败时保留未派发任务，五分钟调度补派；Queue重复消息只取得一个CAS租约，不重复建收件记录。
3. **把扇出和发送拆为不同消费轮次。** 恢复现有NOTIFY绑定和citizenserve队列，max_batch_size=1、max_retries=3。扇出每页最多5个粉丝、40个端点，按(created_at,CID)稳定游标只选择通知开关开启且关注关系有效的粉丝；写入去重delivery和推进游标同事务，后续分页可续跑。每个发送任务只处理一个端点，发送前重新核实当前CID双向绑定、真人准入/MLS设备未撤销、端点代际/期限、关注开关、来源帖子仍published；链未知则重试，不能当合法发送。系统任务用独立私有事实证明/端口，不伪造普通用户Authorization或消费用户nonce。租约120秒、续租≤45秒；网络调用前检查租约剩余时间。每个工作单元最多4次持久发送尝试，超过后记blocked，不由Cron无限重置。只有D1终态提交后ack；可重试失败保留并retry，预算不足保存游标/下一执行时间。所有子请求共用45次业务预算并预留5次提交/续跑，外连并发≤4，不能在一个消费轮次直接发送40台设备。
4. **APNs/FCM固定源发送。** APNs采用Cloudflare WebCrypto ES256签JWT，APNS_KEY只来自运行环境秘密，APNS_KID/APNS_TEAM/APNS_TOPIC为配置；准确访问https://api.push.apple.com/3/device/{token}或https://api.sandbox.push.apple.com/3/device/{token}。FCM以FCM_KEY/FCM_EMAIL签RS256服务账户JWT，通过https://oauth2.googleapis.com/token取得限定firebase.messaging scope的短期令牌，只向https://fcm.googleapis.com/v1/projects/{FCM_PROJECT}/messages:send发送。私钥不入D1/KV/日志或共同库。每次网络10秒、有界16KiB响应、禁止重定向，最终推送载荷≤4096B，只包含公开广场通知或存储提醒；不包含MLS密文/联系人/聊天资料。APNs 410/明确BadDeviceToken、FCM UNREGISTERED仅按原endpoint_revision条件删除失效端点；鉴权配置错误不误删，429/5xx有界退避并保存next_attempt_at。provider成功只表示accepted，不宣称设备已收到。外部成功而D1落库失败可能重发，固定collapse/tag减少重复展示；不能承诺跨外部系统严格恰好一次。Queue与D1去重、最多四次和单调状态保证重试有界。[Queue确认/重试规则](https://developers.cloudflare.com/queues/configuration/batching-retries/)、[Apple token认证](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)、[FCM授权](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[FCM错误码](https://firebase.google.com/docs/cloud-messaging/error-codes)作为实现依据。
5. **有界Cron与两个链投影。** 保留*/5 * * * *，恢复4 3 * * *。scheduled只取得对应调度槽的持久租约并创建固定maintenance任务；同一触发重复执行不重建。身份与会员各最多顺序补10个块，会员进度不越过已完成身份投影；每轮受统一预算约束，整块CAS提交后才推进游标，预算不足拆到下一次消费，不能把“最多10块”当成一次必须跑满。遗漏或重试不会跳块。认证清理每表每轮≤1000行，清理过期挑战、会话、失效/过期端点、过期登记能力和七天以上已完成通讯录操作；生效准入和业务资料不受TTL垃圾清理影响。pending登记仍按原10分钟/verified24小时合同，不因调度延迟扩大有效期。已终止通知记录保留7天，blocked保留诊断；没有删除topup_orders、永久财务claim或submitting/unknown广播记录的通用TTL语句。
6. **过期上传、长期超额存储和R2审计。** 未开始写入的过期预留原子释放一次；writing、完成但未发布的上传及资料临时代际先核实凭据期限/对象与当前引用，持久保留对象定位和每项进度，再分批删除。不能盲删正在写入对象，也不删除已发布帖或新的头像代际。会员权益失效满30天且实际云存储超过Freedom 100GB时，先写可查询提醒和推送任务；至少24小时后按最旧内容回收至阈值，每次扫描最多3 CID、处理最多4内容项，子请求预算更早耗尽则续跑。GET /api/membership增加storage_cleanup_notice（null或同周期notified_at/cleanup_after/storage_limit_bytes），用户离线或没有推送端点也有持久提醒；提醒已创建与provider已accepted分别记录。提醒以本次实际失效时间为周期，续费恢复或低于阈值取消；每个破坏性批次前重新核实新鲜canonical资格及当前代际，RPC不明不删。删除先保存R2/CDN定位，再删主文件/衍生图/manifest和purge，全部确认后才释放D1存储一次，不退款月用量、不删链上内容事实。旧故障任务重试仍复核当前资格；续费后的剩余对象停止删除，已执行云删除无法恢复的事实保留。日常审计在UTC03:04形成带日期游标任务，分页检查管理对象、D1引用、删除重试及孤立对象；无法证明归属/失效的对象只记审计结果，不能仅凭前缀或“查不到一行”删除。每天任务错过触发后仍从持久游标补齐，不依赖精确某一秒运行。
7. **完整Worker装载。** worker-build及wasm-bindgen按本仓锁定版本生成本轮target/build/cloudflare/worker内的ESM/WASM，Wrangler使用同一index.js入口；兼容shim仅作工具产物。Worker测试在隔离视图装载相同产物，覆盖fetch、queue、scheduled、D1/R2/DO及密码学；外部链、推送和支付使用受控端口，不作真实付款或发通知。具体工具、来源与预算由本仓声明和实际代码定义。
8. **验收要求。** 测试真实生产SQL与多连接竞争、真实WebCrypto/JWT和本地workerd；RPC/推送使用公开合成响应并明确区分。覆盖无会话/无MLS/过期身份不能登记，跨CID/token抢占、8端点竞争、代际轮换/撤销、发布与outbox原子回滚、40收件分页、Queue重投/崩溃/CAS/预算/终态ack、APNs/FCM准确失效分类/429/签名、错误配置无误删、两投影顺序与游标、30天/24小时边界、恢复会员取消、R2中途失败/继续/存储只释放一次、不确定金融记录保留。完整Worker运行与线上行为分别验收，不能以局部回归证明产品ready。

### 完整请求地址与准确权限

| 方法与完整请求地址 | 内部规范化路径 | 输入与授权 |
|---|---|---|
| PUT https://www.crcfrcn.com/api/notifications/endpoint | /notifications/endpoint | 四字段push_provider、push_token、apns_environment、expires_at；Bearer+新鲜MLS实际路径证明，写事务复核当前设备，16KiB。 |
| DELETE https://www.crcfrcn.com/api/notifications/endpoint | /notifications/endpoint | 空正文；只删除当前已授权设备端点，同样要求Bearer/MLS。 |
| POST https://www.crcfrcn.com/api/user/challenges | /user/challenges | 既有准确六字段；purpose=request增加上述两个实际/api目标，不接受其他推送管理路径。 |
| GET https://www.crcfrcn.com/api/membership | /membership | 既有空正文/Bearer/MLS接口，响应增加本人本周期storage_cleanup_notice；不新增清理管理API。 |

路由及权限以server/routes.rs的真实声明为准。Queue/Cron是Cloudflare事件入口，没有公网HTTP任务执行、推送任意载荷或重试财务接口。推送HTTP地址固定在平台适配层；MLS证明仍覆盖实际方法、完整/api路径/查询和原始正文。

### 许可接口地址与规范路径

| 方法与完整请求地址 | 内部规范路径 | 输入及权限 |
|---|---|---|
| POST https://www.crcfrcn.com/api/tatachat/access | /tatachat/access | 准确{}，≤1KiB；现有Bearer+新鲜MLS，签实际/api/tatachat/access。 |
| GET wss://www.crcfrcn.com/api/tatachat/realtime | /tatachat/realtime | WebSocket升级；专用聊天凭证、当前宿主许可及≤60秒再核验，不接受查询token。 |
| PUT https://www.crcfrcn.com/api/tatachat/attachments/{attachment_id}/chunks/{chunk_index} | /tatachat/attachments/{attachment_id}/chunks/{chunk_index} | 原始密文分块；专用凭证、上传属主、块编号/尺寸/摘要及当前许可。 |
| GET https://www.crcfrcn.com/api/tatachat/attachments/{attachment_id}/chunks/{chunk_index} | /tatachat/attachments/{attachment_id}/chunks/{chunk_index} | 专用凭证、发送者/真实收件设备权限、分块范围及当前许可。 |
| POST https://www.crcfrcn.com/api/user/challenges | /user/challenges | 既有六字段；仅给access增加purpose=request准确目标，WSS/二进制传输不冒充同一HTTP proof。 |
| GET https://www.crcfrcn.com/api/health | /health | 既有唯一health，整体ready仍false；不增加模块公网health别名。 |

## 通用聊天核心与协议资源

通用聊天唯一归本产品根tatachat，由auth、protocol、key、mailbox、attachment、push、realtime七个功能目录及根mod/service/tests组成，共28件Rust源码。公民Subject、会员Permissions与宿主Authorization仍归user/membership/server；通用层只接受可信宿主映射的中性HostAccess，不解析CID或会员Plan。密钥包目录只有key；SDK官方KeyPackage类型和既有字段编号保持。

本机Build直接读取同级TataChatSDK仓库的三件.proto，并按当前字节生成需求摘要；GitHub自动化才使用scripts/build.mjs声明的固定提交、大小与摘要。protoc35.0准确宿主坐标仍由该公开声明定义。Build提供protocol-requirements与protocol-prepare入口，以及requirements、describe、execute、test和package入口。Linux x64为现行Cloudflare构建宿主；空LinuxARM平台声明已删除。产品只读公开SDK协议，不读取邻仓工作树，也不提交生成类型。

资源主体必须显式选择：independent由产品按同一公开配方获取到显式源码外store或本轮已领取的准确固定工作根内临时store，直接复用已交付原件；console只核验控制台按本产品requirements提前交付的当前任务supply，缺件、损坏或错误身份直接失败，禁止自行下载或切换模式。console供给含schema/product_id/platform/work、dependency_root、tool_root、protoc_archive、protoc和按文件名映射的protocol路径。永久原件仍位于资源供给者库，生成和可写工作视图只归当前CitizenServe平台工作根；产品没有控制台私有路径或源码依赖。离线缺件据实失败；下载可取消，HTTPS重定向有界且仅限官方GitHub资源域，归档内容先验摘要，只展开固定普通protoc入口，提交不覆盖已有原件。

protocol-prepare读取当前任务的规范绝对输入JSON，含work、independent或console模式与准确原件/供给路径；用已交付Node25.2.1调用scripts/build.mjs protocol-prepare <绝对输入路径>。本轮receipt位于work/tatachat-protocol/receipt.json，包含规范协议目录、三件准确文件名、protoc入口及任务身份；build.rs只消费该回执和其文件列表，不解析另一份产品声明。协议原件及官方工具经Build准备与验真，缺件失败。


JWT头、Claims、签名输入、秒/毫秒一致性、最长15分钟及初次60秒窗口、严格Ed25519验签唯一归tatachat/auth；宿主只将已核实Authorization映射为Claims并调用unsigned，再由现有WebCrypto执行器签名。server不保留第二Claims/Header/VerifiedToken或第二验签实现；verify_token只委托通用CredentialContext，然后检查本产品真实CID、设备、修订、摘要与安全整数边界。server/cloudflare/tatachat.rs现有Host直接实现通用Host端口，用current_session重查真实会话/准入/设备及同块链权限后映射；recheck匹配原主体、会话、修订与额度并裁剪原期限，authorize_wake取得目标当前权限。通用Access独立保留原credential_deadline，未知或核验失败即拒绝。

## 公民客户端消费边界

客户端实现、保护记录和平台接线由CitizenApp及其根技术文档承载。服务端只定义本篇公开请求/响应、授权与恢复合同；客户端不得在真人验证前提交CID，不得在恢复时重复广播或付款。注册顺序为确认注册、真人验证通过、钱包签名和链上CID最终确认、MLS设备登记、普通会话。

## Cloudflare聊天数据面与资源

Cloudflare入口仍是同一CitizenServe Worker。server/cloudflare/tatachat根只放config、routes、schema和maintenance；key、mailbox、attachment、push、realtime各功能的mod/store或具体驱动分目录。通用权限、协议、幂等规则与协调器继续消费根tatachat已有端口；不复制SDK协议、宿主身份、设备登记或会员真源，不维护待退役旧仓。

唯一公开数据路由为GET /api/tatachat/realtime与GET/PUT /api/tatachat/attachments/{attachment_id}/chunks/{chunk_index}，WebSocket子协议为tatachat，帧为固定SDK生成Protobuf。凭证由已有/api/tatachat/access签发，数据入口复用同一验签和可信Host。配置须有四绑定；HTTPS服务origin、可选Origin、原始路径和方法严格核对，客户端内部头不产生能力。附件分块无查询字符串、非规范编号或旧/attachments别名。非创建设备执行上传、完成或中止，沿用通用附件合同返回not_found（HTTP为404），隐藏存在性；真实Worker回归同时核对拒绝前后的整件元数据及全部上传记录不变。每设备最多4连接，帧最多2MiB，单密文块最多4MiB；附件总体额度仍取可信会员许可与通用MLS开销规则。

TATACHAT_DB为独立聊天D1，schema只有聊天公开密钥包、设备密文、紧凑回执、推送outbox/端点/代际、附件元数据/对象定位/回执和模块维护/重建材料。D1 batch内先检查模块未冻结；授权写入前后都使用实际SQLite时钟检查Access.deadline。每batch最多40业务语句，每语句最多100参数、100KB SQL，每绑定字符串最多1.9MB；这不是整个请求D1查询数或账户套餐的验收证明。KeyPackage保留LastResort，解析不消费；同步先查索引轻量记录与单帧预算，再读选定密文。

消息首次提交在同一batch建立不可变全收件摘要、所有设备密文和outbox；收件集合、发送者、会话编号、时间或任何设备密文变化均冲突。ACK只删当前可信收件设备的密文与对应outbox，回执保存到原服务端期限。同ID同内容重试不延长期限，不恢复已ACK密文或推送任务。过期密文不返回。

附件创建归属可信创建设备，下载按发送用户或收件用户授权；完成和中止只允许创建设备，ACK按收件用户。每次上传先持久预留全新attachment/generation/index/attempt对象键，CAS reserved→writing后只调用一次R2 put，并实际校验长度/SHA及R2校验和。记录written的版本后才确认分块；失败只补偿本尝试，绝不覆盖或删除另一尝试。HEAD/DELETE没有版本CAS，本实现通过不可复用键限制归属。未知writing没有对象时继续保留定位，不能把超时当作未写入；观测到对象才清理，全部尝试deleted后才删除父记录并保留幂等回执。附件与尝试轮换清理，避免未知前缀饿死其他对象。进程恰在writing持久化后、发起put前崩溃仍无法仅凭HEAD不存在证明已终结，该定位会保留并阻止安全重建；必须在运行态验收中核实此边界。

TataChatDevice使用SQLite DO休眠WebSocket API，连接attachment仅保存随机小定位，完整权限快照与解析限额存DO storage。每次设备事件恢复都重新查询Host，核对actor/revision/session/额度，凭证终期不延长；每设备只有一个最早再核验alarm，无自动Pong。安排alarm失败时关闭连接，静默连接也要按期限重查。事件锁只串行本设备快照，提交和响应后释放锁再发送DO内部提示，避免互等。提示可丢失，设备同步与持久outbox负责补足；内部notify只走namespace stub。业务操作归属错误返回Failure；会话撤销、未知Host、非法文本或超限帧关闭连接。实际平台alarm调度延迟及DO休眠/重启尚未验收，不宣称硬实时截止。

TATACHAT_PUSH为独立Queue。消息持久outbox与首次密文同事务；每wake领取一件有界租约，逐端点核验当前Host许可并续租，旧lease_id不能完成新租约。补派为每任务发送对应延迟hint，成功后仅更新原快照；Queue重放由D1租约吸收，Cron五分钟槽补派及有界维护。端点移除不重置代际；明确无效端点只删除原代际，认证或配置失败不会误删token。APNS/FCM仅使用通用chat_wake负载，APNS使用固定生产地址，FCM只使用官方OAuth/发送URL；复用宿主WebCrypto签名，发送阶段10秒取消、回执最多16KiB，重定向不接受。普通NOTIFY队列保持原业务分支。

聊天云资源声明由scripts/tatachat.mjs自身唯一持有，schema版本1及当前文件SHA冻结。生产D1/R2/Queue同名citizenserve-tatachat，Worker为citizenserve；测试资源同名citizenserve-tatachat-test，Worker同名；绑定分别TATACHAT_DB/TATACHAT_ATTACHMENTS/TATACHAT_DEVICES/TATACHAT_PUSH，DO类TataChatDevice，SQLite migration tag tatachat-1。公开账户范围以正式CF_ACCOUNT_ID为准；没有进行云清点、创建、部署或填写猜测D1 ID。wrangler候选仅增加实际Queue分流公开变量及待绑定说明，四绑定须由真实资源回执产生的tatachat-wrangler-bindings.toml另审后装配，不能把现状称作数据面已启用。

scripts/tatachat.mjs提供plan/create/maintain/rebuild/verify同一配方。plan回执含账户/环境/操作/schema/真实资源ID与数量，批准摘要必须匹配重新清点现状。create只建缺件，既有D1须核真实DDL及模块归属，R2/Queue须核实际绑定或本任务匹配回执，私桶managed/custom公开访问必须关闭。配置回执只含公开ID并保存在当前工作根，DO namespace与Queue实际消费者留待部署后验真。verify检查真实DDL、私桶、Worker四绑定、SQLite DO class/script和唯一Queue消费者；只证明这些资源事实，不能代替API联调。D1官方保留表_cf_KV单独排除，未知业务对象仍拒绝，依据https://developers.cloudflare.com/d1/best-practices/import-export-data/。

rebuild只重建本模块业务表，保持D1/R2/DO/Queue资源身份与对象键，禁止资源删除。开始先把冻结状态与随机活动backup_id绑定，拒绝未知writing；数量漂移要求重新规划。在同一受保护D1中复制并按数量及EXCEPT比较验真快照，不把密文、端点token或私钥导出本机。破坏性阶段只在快照verified后开始；恢复按原列顺序插入并回读全部表，最后解除该活动备份的冻结。中断后只接受同账户/环境/schema且与活动backup_id匹配的verified快照；恢复现状、冻结状态或来源未知必须失败，不把空库当恢复。快照保留在云内，快照清理需要单独准确授权。

云能力由获准安全执行器持有和发送认证；产品脚本只通过当前任务的双向FD传公开Cloudflare请求，响应绑定schema/id/product/platform/environment/account。固定Cloudflare账户URL与Worker只读限制在产品再次检查，执行器还必须绑定获准操作和资源ID/名称，拒绝越界。CLI必须显式independent；控制台未交付所需公开能力时，console明确失败，不能读取SERVER_DEPLOY、Keychain或私有发布通道。产品支持配方与能力注入不等于安全执行器或控制台接入已经交付。



本产品公开声明由scripts/build.mjs describe交付，资源入口同为scripts/build.mjs。当前远端自动化目标仅Cloudflare，控制台从产品公开声明读取编译入口，通过所属Workflow坐标派发自动化；Build结果与供给仍按准确任务编号和固定现场核验。聊天云资源维护保留scripts/tatachat.mjs独立入口。入口存在不代表运行态已验收。

### Runner资源、可信引导与任务边界

Linux资源仅在实际GitHub Linux Runner获取、准备、验真和使用；本机Mac不下载Linux原件。资源需求由真实调用、本仓声明、Cargo.lock与test/worker/package-lock.json决定，不按固定工具数量补装。Linux执行宿主锁定Ubuntu24.04及实际glibc2.39，Node25.2.1运行字节与官方发行归档逐字节对应后，才使用其HTTPS、摘要和归档能力准备后续闭包。三个Workflow使用固定提交的官方checkout/setup-node，产品自身继续核验实际运行Node字节。

本仓配方声明Git2.54.0、Python3.14.3、Bash5.3.20、Rust1.97.1、protoc35.0、actionlint1.7.12、worker-build0.8.5、wasm-bindgen0.2.127、Binaryen130。Linux源构建闭包包含固定BusyBox/Make/Zig、Perl5.42.3、OpenSSL3.6.3、zlib1.3.2和SQLite3.53.4源码。SQLite为Linux Python源码准备的内部库，不替换Mac已交付Python及其实际内部SQLite；两个平台的内部闭包分别核验，不声称字节相同。Rust按官方rustc/cargo/rustfmt/clippy/host std和wasm std组件准备；Bash20份官方补丁按固定摘要及完整context原行应用，拒绝内容不符或匹配歧义。worker-build只从固定0.8.5来源及内部Cargo锁离线编译，不隐式下载esbuild/wasm-bindgen/wasm-opt。

Cargo registry闭包按包名、版本与checksum物化并生成离线vendor校验；npm仅按原锁真实解析路径、os/cpu/libc物化适用闭包，不运行生命周期脚本。esbuild/workerd实际二进制直接来自该锁，工具命令只解析当前任务已验真闭包，拒绝调用者PATH、代理、系统工具、Rust包装器及下载覆盖变量。本机协议消费直接读取同级TataChatSDK仓库当前工作树；GitHub自动化才固定SDK提交b0485cf0a2c0922791741a748fdec0a49003089f及该提交lib/protocol，并核对三份协议长度与摘要。

独立Runner模式将不可变原件按摘要保存于显式源码外工具库/依赖库并再次核验后复用；显式offline缺件失败，已存损坏原件保留并失败，禁止覆盖或升级。当前Workflow使用本次Runner临时资源库，没有宣称跨Runner持久缓存已验收。控制台模式只通过公开原件获取及工具供给能力消费其工具库/依赖库，缺件、验真错误或供给失败不切独立下载。Mac发起只核验本机已交付Node，不准备Linux原件。

任务首个文件步骤取得同身份短锁、核实活跃保护、清空准确流程现场并回读为空；不同身份不互清。工具执行支持取消和超时，先收集真实close，再核对Linux实际识别后代PID及启动坐标，未确认退出时保留活跃标记并禁止清场。源构建现场在安装验真且进程退出后删除；可写Cargo/npm视图、日志、报告与中间产物只归所属当前任务target。最终公开产物目录与其他身份不因清场被删除。

### Cloudflare完整检查与正式产物

自动化只由本仓release-cloudflare.yml和同名mjs执行。它按Cargo.toml唯一声明独立准备工具、执行真实测试、编译Worker并组包，核对十件成员的准确名称、唯一性、大小与摘要，为当前Run生成release-manifest.json和SHA256SUMS。自动化仅收集三件准确正式资产；Tag/Release创建、上传与逐件回读均归自动化。正式产物仍包含Worker、SQL、Wrangler配置及锁文件。独立publish.mjs只读消费唯一成功Run对应的Tag、Release、三件资产及归档全部成员，不创建Tag/Release也不改变Cloudflare资源。

全部前置成功后清理本目标旧成功，否则撤销本次产物并清理旧失败；撤销失败不跳过历史失败清理，任何未确认操作均报告失败。清理只匹配当前目标的准确Workflow，不根据已经删除的入口猜测历史归属。

### Cloudflare适配公开接口

R2适配从worker根公开导出读取Bucket、Conditional和Env。推送发送前、获取FCM令牌前及发出通知前，均通过公开Access::from_host以当前毫秒时间核验HostAccess快照；HostAccess::validate仍保持crate内可见性。公开构造复用现有主体、聊天资格、非零附件额度、授权修订、会话摘要、签发时间、最长15分钟凭证和最长60秒再核验窗口，不延长凭证终期或复用过期许可。

## 本机固定执行目录

根build.rs只接受本仓target/build/cloudflare、target/test作为PRODUCT_WORK_DIR，CARGO_TARGET_DIR必须为该工作根内cargo-target；不再使用target/cloudflare或平台目录。server/cloudflare/wrangler.toml的main固定为../../target/build/cloudflare/worker/index.js，与当前Worker构建输出一致。target整体排除源码目录审查，编译与测试工具的内部结构不按源码目录层级检查。

runTool允许当前产品源码根、当前任务工作根及其内部目录、既有Cloudflare crate源码入口作为cwd；所有路径先验真，其它目录拒绝。当前任务根本身必须可执行工具，不能因不属于自身“子目录”而拒绝Apple资源校验或测试。

## Cloudflare本机Build公开资源与完整入口

SDK版本链接仅在原入口和规范真实目标均属于该已选择Xcode时接受，返回规范真实SDK目录；越界目标、非目录及非规范入口拒绝。产品resolveSDKPath与控制台resolveProductSDK分别核验同一边界，不更改Xcode签名或版本要求。


最小宿主是本产品声明的官方Node25.2.1绝对入口；执行完整Build前先核对实际运行字节。Build只声明实际调用的Node、Rust1.97.1、protoc35.0、worker-build0.8.5、wasm-bindgen0.2.127及Binaryen130，加上锁中的esbuild及Darwin arm64二进制闭包。Build不准备Worker运行测试所需Miniflare/workerd，也不补装Git、Python、Bash或actionlint。当前Mac Rust WASM标准库使用准确官方tar.xz坐标与固定摘要；Linux继续使用自身既有坐标，只在实际GitHub Linux Runner准备和执行。Xcode27.0及随包clang/ar/ranlib、macOS SDK每次核验官方签名、准确版本、规范真实路径和包归属；固定Apple定位和签名入口不加入PATH。

requirements(platform,work)异步返回当前Build完整需求；protocolRequirements及protocol-requirements只返回根build.rs消费的协议需求。SDK消费固定b0485cf0a2c0922791741a748fdec0a49003089f及该提交lib/protocol/，公开要求中的URL和路径校验使用同一最终目录。工具入口槽位、所需目标组件、准确官方归档和产品准备配方摘要均在公开需求中。prepareToolSupply按当前需求准备缺件，不读取控制台私有登记或实现；源码工具使用官方源归档、原始Cargo锁及递归闭包离线编译。XZ/LZMA2在本产品Node内解码并核验流、块、索引及输出校验，不以系统xz或系统Shell作为Mac工具自举条件。

独立执行须显式选择independent，给出规范工具和依赖原件目录及准确工作根；目录可位于源码外，或本轮已领取的准确工作根内。产品按声明与原锁准备并直接复用原件，工具对象引用对应交付路径。显式offline缺件失败，已有损坏对象或配方变化保留并失败，禁止自动覆盖或升级。控制台调用使用provided和当前任务FD4：控制台先复用已验真对象，缺件按本产品公开配方取得、准备、验真并保存，再交付完整实际文件清单、入口与组件。产品再次核验工具、Apple、协议、Cargo/npm视图和资源环境。PRODUCT_TOOL_ROOT、PRODUCT_DEPENDENCY_ROOT只用于核对交付边界；缺通道、取消、错身份、损坏或供给失败不切换独立下载。FD4仅传身份、需求摘要及资源回执位置/摘要；完整清单留在当前任务资源回执内，不传归档字节。

work_claim=product使完整入口在创建内部现场前持短锁领取长期守卫，核验活跃保护并清空准确build现场；独立与控制台调用互斥。控制台在产品实际close及结果核验后登记确认，守卫继续保护两件候选直到既有SQLite记录完成；然后在同一短锁内删除守卫并清空当前任务现场。独立执行在返回成功或失败前确认全部工具退出并清空现场，返回的文件坐标仅作当前任务结果证据，不是持久可下载包。退出未确认或SQLite记录失败保留受保护现场，不登记成功清理；不建立替代持久产物目录。本机仅实现既有Cloudflare Build，未新增CitizenServe Start或LinuxARM实现。

Xcode官方工具别名由macApple核对入口和真实目标均在选中包内，并仅返回普通真实文件；closeCommands生成的包装器以argv0保留原命令身份，ranlib解析到libtool后仍按ranlib模式执行。跨包、越界、目录和缺失目标拒绝；同文件后置回归与原有资源模块40项实际通过，Xcode安装、工具版本及通用路径拒绝不由该修复改动。


回归源码覆盖最小闭包、资源身份/摘要/离线策略、真实close先于完成确认、原件复用、清单链接边界、未退出保存保护、短锁竞争和清场回读，以及独立编码的压缩XZ样本和损坏/取消。全部获准步骤实现、同步和清理完成后才统一执行测试与编译。生产compatibility_date继续2026-10-07；本轮已将测试工具锁统一升级到workerd1.20261006.1及匹配Wrangler/Miniflare，实际完整检查与39项当前WASM/workerd回归已通过；这份本地结果不代替云端或两端钱包验收。SDK固定消费已同步至真实新提交；原件物化验真、本机门禁供给、业务回归和云/真机联调仍须取得本轮实际结果。

## 会员确认回执

平台会员 finalized 确认的真实响应为 ok、tx_hash、block_hash 三字段回执，不是会员快照。App 先校验规范交易和块摘要，再通过同一会话的 MLS 证明确认；只接受匹配本次交易的成功回执，随后以新鲜 MLS 证明读取 GET /api/membership。任何确认、回执校验或快照读取失败都传播失败，由既有订阅恢复流程保留原交易记录，不把回执解析成会员状态。此步沿用现有服务响应、接口和依赖版本，未修改链上交易或服务端会员合同。

会员用例改用真实 /api 根和三字段回执，覆盖两次 MLS 请求、错回执、快照读取失败以及无效交易/块不发请求；推送源契约同步为 PUT /api/notifications/endpoint。用例已准备，尚未运行。动态和资料夹具同步见下述当前合同；注销运行合同与回归源码已按下节更新，当前尚未执行完整普通业务回归。

旧独立 TataChatServer 的当前正式仓库登记及已安装控制台登记均已移除，旧工作仓库、专属源归档、操作目录、原待审材料和两件旧任务记录目前不存在；不重放已过时的37件候选或重复删除。当前 Cloudflare R2 与 Workers KV 完整列表未见旧服务专属资源。云端最新补查范围与剩余证据见下述记录；这些证据不代表全部环境退役或签名安装验收已完成。历史阶段叙述和拒绝旧入口的负向用例保留。

普通动态和资料回归已按现有 /api 合同准备：动态 /8964/feed、帖子详情和本人副本 /8964/posts、上传 /8964/uploads、资料 /user/profiles/{cid_number}、作者帖子 /8964/posts?cid_number=...、资料修改 PUT /user/profile。夹具使用规范账户ID与独立CID，真实会话请求断言 MLS 证明；上传响应使用 manifest 与 media_uploads，manifest能力必须同源且属于准确上传身份。补充HTTPS根、manifest越界和资料媒体对象越界负向用例。只准备源码，尚未执行。

动态中文HTTP夹具明确以UTF-8构造响应，避免MockClient在JSON解析前使用Latin1编码失败；真实合同与负向用例不变，未执行测试。

## 账户注销与钱包恢复查询

唯一提交入口为 POST /api/user/deletion/challenges 与 POST /api/user/deletion，均要求当前账户会话与新鲜MLS请求证明。挑战不接受客户端指定其他CID；确认正文只有challenge_id和signature，不恢复旧/square/account/delete别名。云清理任务受理返回HTTP202及state=pending，不能据ok把它当作注销完成。

会话撤销后，POST /api/user/deletion/status/challenges接受cid_number、account_id，并从链上当前绑定核对主体；POST /api/user/deletion/status接受challenge_id、signature，只消费一次性status挑战并读取任务，不创建、推进、取消任务或重新签发会话。恢复不依赖旧会话或本机临时记录，App重启后仍可用当前钱包查询；不存在任务明确返回absent，不冒认完成。

钱包签名固定为signing_message(0x1d)=blake2_256(GMB‖0x1d‖SCALE)。SCALE依次包含字符串citizenserve.account_deletion、服务HTTPS origin、32字节chain_scope、CID字符串、32字节account_id、u64小端binding_revision、用途字节（delete=0/status=1）、32字节challenge_id、u64小端expires_at_millis。挑战有效期300000毫秒；App用本机可信IdentityBinding和实际服务origin独立构造完整字节，再比对服务下发payload。未知字段、错用途/域/链/绑定、期限、非规范nonce及任意不透明payload均拒绝，不直接签服务下发的任意内容。

主库增加account_deletion_challenges、account_deletions和约束断言表，最终schema源码为39表；本节不表示云DDL已经执行。提交在同一D1事务再次核对当前MLS授权、钱包挑战与准入，消费nonce、保存任务、撤销会话和设备并冻结该CID业务写入。已有profile writing、未完成/删除中的广场上传或其他维护对象定位使提交回滚，保留原会话、nonce及上传定位；不能凭过期/HEAD缺失认定在途写入已结束。准入、设备、会话、MLS挑战、维护定位与通知收件方的数据库断言共同防止绕过冻结。

后台复用既有Storage维护事件和同一资源绑定，每次仅执行一个有界批次：私有square/{cid}/与profile/{cid}/前缀、公开媒体、聊天，然后固定非金融白名单每次最多100行。公开对象先保存全部已分配键，再分页覆盖为零字节、无原内容或自定义元数据的空对象并刷新CDN；不物理移除这些空对象，使旧If-None-Match:*直传无法在删除后重建内容。普通公开媒体删除共用这一封堵方式，后续维护不能删掉封堵对象。私有对象每批最多8件；对象端口明确成功后才解除IO屏障，CDN刷新失败继续保留键并安全重试。每次外部对象操作前持久保存键与独占IO屏障，结果未知时保留pending及定位，不通过租约过期自动重发或标记完成。恢复查询始终能区分pending与complete；未知IO须取得明确结束证据后才可处理，不能承诺仅按超时自动收敛。

聊天清理仍使用同一附件one-shot尝试账本，每批只处理一个对象；writing且HEAD缺失继续保留定位。持久用户冻结拒绝旧Access写入、迟到收件消息、尚未开始的附件上传与收件关系。只删该CID收件箱，保留其他接收者的消息与共享幂等回执；所属附件对象明确删除后才移除代际定位。新真人准入必须晚于完成回执；旧激活重放不能清掉完成任务或解除聊天冻结。

钱包、链身份users及finalized身份/会员/创作者投影、topup_orders、chain_transaction_confirmations、chain_extrinsic_relays和永久结算/广播claim均保留。最终移除该CID云资料、通讯录、推送、动态、上传与资源用量，再移除原真人准入/激活凭据，提交complete回执。App严格校验六字段回执及当前绑定，pending保留本地资料、帖子与私信；complete后逐项尝试全部本地清理，单项失败仍继续其余项并显示本机清理未完成。

## 当前资源供给合同（2026-10-09）

scripts/build.mjs按本仓公开声明和原始Cargo/npm锁准备协议、工具、Cargo vendor及npm任务视图，直接消费已提供路径。协议回执包含当前任务和原始协议文件列表；build.rs只消费准确回执，不执行Node/资源版本重复判定。workerTestView仅在本轮任务根物化真实Worker测试视图；资源回执不承载自建配方或全树签名。

供给缺件、离线缺件、工具非零退出、取消或后代未退出按实际结果失败。固定工作根、任务身份、隔离、互斥与清场合同继续适用。业务授权、钱包及链签名、TLS和正式应用产物的签名安装合同保持各自职责。

固定根中的工程视图按产品根的直接子项复制，排除target与既有生成目录，避免Node把整个源码根复制进自身子目录时拒绝操作。视图根仍为当前已领取工作根中的source，不成为另一个任务工作根；成功、失败和中断恢复均由本仓target入口完成清场。

### scripts 同文件回归

正式脚本与对应测试维护在所属文件末尾，普通导入不注册测试。Build的固定根生命周期和产品合同按显式PRODUCT_TEST_SCOPE分两阶段执行；Publish、聊天资源维护、Workflow及门禁用例各归自己文件。Node测试现场由scripts/build.mjs管理，工具确认退出后清空准确固定根。

门禁独立领取本产品唯一声明的actionlint并执行仓库检查，不在产品测试资源闭包中隐式领取该工具。固定根生命周期与Build互斥回归归scripts/build.mjs；门禁从Build公开测试接口取得实际Rust、SQLite、Node和WASM/workerd结果，再独立执行自身与自动化/发布合同回归。PRODUCT_LIFECYCLE_RUN只保护同轮测试现场，未知后代或任务身份漂移时保留守卫并失败。

Worker运行测试的唯一npm声明与原生闭包在test/worker/package.json和package-lock.json：wrangler4.149.0、miniflare5.20261006.1-alpha及workerd1.20261006.1，不加overrides。生产compatibility_date继续使用2026-10-07，锁定运行时必须实际装载同一本轮WASM产物。开发取得的新npm归档只存当前固定工作根，不发布到永久资源库存。

独立original与协议prepare共用originalStore边界：源码内存储只允许本轮准确target/build/cloudflare或target/test的真子目录，要求对应产品、工作根和仍运行的占用标记；拒绝源码其他目录、另一固定根、非规范路径及缺少所有权的现场，边界检查早于建目录。固定工作根直接复用本产品既有checkFixedWork入口；同一路径兼作协议依赖库与工具库时只验一次。本机协议模式直接读取TataChatSDK源码，不校验或创建未使用的协议依赖原件库，仍校验并取得实际protoc工具。源码外已有原件目录沿用显式输入。正常获取、离线复用/缺件、获取失败、流中取消及越界不留源码目录均由真实资源函数回归覆盖。

## 第3步本机完整复验（2026-10-09）

该日期此前记录的完整检查结果归进行中任务卡，本轮源码调整后须重新按Build产品测试、门禁仓库检查和自动化各入口验收；历史结果不作为当前代码通过证据。

实际复验覆盖可写响应头且保留101升级/流正文、安全和CORS头、HTML/PNG的GET/HEAD及128KiB边界、3秒响应头与正文总截止时间、公共RPC、单一活动storage维护任务和注销pending/complete及未知IO屏障。现有Worker夹具HASH_KEY使用符合正式最小长度的合成值；不降低业务约束或放宽断言。复验完成由本仓入口清空本轮build/test；本机通过不等于云部署、真实推送到达、设备安装或账户服务开放，account_services_ready继续为false。

## 当前仓库推送流程

仓库推送仅上传本仓已经保存的main提交。控制台推送的唯一实现为console/tuisong.mjs，每仓一次生物识别，授权成功后建立独立任务，任务栏记录Git进度、准确SHA、取消及成功/失败终态。只执行Git与GitHub main只读回查，不执行源码、依赖、注释、文档、测试、签名或资源门禁；不派发产品Workflow、不运行hooks、不续签或重复认证、不自动重试、合并或强推。

本仓已移除GitHub main推送门禁触发器；main上传后不自动运行产品自动化。自动化由用户单独发起，产品仍拥有自己的Workflow、声明、资源、测试和产物实现；产品不导入控制台源码，不依赖控制台工具库、私有规则或其它仓库工作树。控制台只是可选Git客户端。各仓可独立使用公开Git接口完成仓库操作，公开SDK依赖不构成流程耦合。

## 本机编译入口

本产品完整本机编译只由scripts/build.mjs实现。声明与资源配方归本仓；独立执行自行准备，控制台发起时只消费其明确供给，不因缺件或失败切换到独立下载。控制台调用、移动端安装与macOS App约束归console/build.mjs，控制台供给的原件获取、命令执行和对象提交归tools/toolchain.mjs，产品负责自身现场与资源配方临时路径清理；供给方只收尾自己创建的候选和提交锁。

公开编译、测试、组包及资源配方唯一归scripts/build.mjs，产品独立执行或接收控制台明确供给使用同一实现。自动化将GitHub运行身份投影为产品任务编号及输出目录，不交付GitHub令牌；发布只消费自动化的公开正式产物。

## GitHub自动化

本仓自动化只在GitHub的main源码上执行；控制台只调用与展示。各目标独立拥有同名的YAML与Node实现，不调用其他仓或其他目标的Workflow。版本、构建、测试、签名、完整产物核验与正式tag/Release均由本仓负责。

- `.github/workflows/release-cloudflare.yml`及同名`.mjs`。

每个目标的最后任务使用always读取所有前置结果：全部成功清本仓本目标旧成功，否则清旧失败并失败退出。仅保留最新成功、最新失败各一条；保护本次Run和所有活动任务，另一类结果与其他目标不受影响。删除关联正式Release、tag、Actions产物和Run后回查；任何清理错误都按实际失败报告，不自动重试。

当前自动化目标仅Cloudflare；未实现的Linux ARM自动化入口、声明及对应断言移除。

所属回归位于各目标同名mjs，覆盖前置结果、版本边界、平台隔离、活动保护和完整分页；真实GitHub构建与发布验收依任务授权另行执行。

本机编译现场由本产品领取和收尾。调度任务编号随本产品领取记录保存；本轮结果消费后，只允许匹配该编号的收尾请求。产品确认自身进程及资源供给后代全部退出后才清场；异常、编号不符或退出未确认时保留现场。控制台只持有调度锁、调用本产品入口并供给资源，不实现产品清理。

软件版本计算使用本目标GitHub运行序号作为单调下界，并与本仓已成功版本比较；失败或历史清理不使版本返回源码初值。版本只在GitHub本次运行内产生，同一Run重试保持运行序号，Tag另绑定准确attempt。


### 当前自动化最后处理

本仓每个自动化目标仅由自身release-<平台>.yml与同名mjs执行，最后处理依赖全部前置任务。清理只接受该目标准确Workflow路径、main和手动事件，不根据已删除文件或旧入口名称猜测归属。前置失败时，本次产物撤销与旧失败清理分别尝试并汇总错误；任何一项未确认均失败。固定依赖仍由本仓声明和原锁管理，不参加自产历史结果分类。


### 本仓 GitHub 自动化与塔塔门禁目录

`.github/` 仅保留 `workflows/` 与 `tatagate/` 两个目录。`workflows/` 持有本仓自动化；`tatagate/` 仅保留 `tatagate.json` 与 `tatagate.mjs`。前者登记本仓门禁合同，后者保留正式门禁实现与测试报告器，测试代码统一位于正式代码之后。直接运行执行门禁命令，测试运行只执行末尾测试，普通导入不注册测试；本仓测试清单及逐文件成功回执使用同一个门禁文件且仅执行一次。


## GitHub塔塔门禁与同类记录清理

本仓保留自己的.github/tatagate门禁实现和合同。main的push只触发本仓.github/workflows/tatagate.yml，gate与cleanup在这一个文件内执行；检出准确GITHUB_SHA并验证本仓GitHub事件、main引用和HTTPS origin，门禁继续执行本仓现有检查。gate成功时删除本仓该门禁旧成功Run；gate失败时删除旧失败Run；另一类最近记录和活动Run保留。清理前重新验真Run、Attempt和结论，删除后回查；清理错误如实记录并由后续运行补清，不影响gate检查结论。塔塔控制台通过塔塔鹿鹿的一次生物识别保存、推送本仓，并按准确SHA与Run ID追踪独立门禁任务；门禁结果不影响已确认的推送。

本仓 GitHub 门禁接受 actions/checkout 的准确 HTTPS origin（同一仓库地址有或没有 `.git` 后缀），仓库、事件、提交和工作流身份仍逐项校验。

门禁清理接口只对 URL 的路径部分拒绝越界，允许 created 查询中的时间范围分隔符；同文件回归直接执行正式 HTTP 参数校验，覆盖时间范围和越界拒绝。
