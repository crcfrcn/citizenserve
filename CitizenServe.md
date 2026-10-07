# CitizenServe 技术文档

## 当前工作目录归属（第8步，2026-10-06）

本产品全部测试、编译临时数据和产物归 `/Users/rhett/citizenserve/target`。多平台先使用声明中的完整平台身份，再在平台内按build、ci、release、publish、test、tmp隔离。独立入口与控制台调用消费同一产品流程；控制台仅创建任务、调用与跟踪，不准备产品专用版本、依赖或步骤。下载半包、工具编译候选、工程视图、Runner步骤临时状态和测试夹具均属于当前产品工作区；永久工具与依赖原件继续归原件库。整个根target不进入Git、源码快照、程序摘要或打包输入。准确流程短锁、活跃任务保护、成功产物保护和原清理规则继续适用。

第8、9步完成目录与路径实现、根文档迁移及测试源码维护，未运行测试、门禁、编译或安装。本文唯一原件位于/Users/rhett/citizenserve/CitizenServe.md；产品接口及流程直接以本仓实际代码和声明为准，业务字典库与其检查已撤销，不另建登记副本。历史验收事实不表示本轮改造已经通过验收，统一测试在第10步进行。根技术文档由本仓门禁按原文、JSON解码值及既有补丁快照扫描机密，仅报告路径；文档迁出不减少资料安全检查。


## 公共钱包 RPC 与 Cloudflare TLS（2026年10月7日）

公共钱包使用 https://rpc.crcfrcn.com/，由同一 CitizenServe Worker 的独立域名入口处理。Wrangler 为该域名声明 custom_domain=true，由 Cloudflare 管理 DNS 和公网边缘证书；既有 www.crcfrcn.com/api/* 路由不变。公共入口只接受 HTTPS 根路径的 JSON-RPC 2.0 POST 和必要的 CORS 预检，无 App 会话前提；允许公开跨来源调用，不发送凭据型 CORS。其他 App 接口继续执行既有来源、会话与 MLS 门禁。

公开方法仅包含实际 SDK 提供的钱包读方法及 eth_sendRawTransaction；eth_sendTransaction、personal/admin/debug、原生 state/author RPC 和 HTTP 下的订阅均拒绝。请求体最大64KiB，一批最多20项，ID须唯一且类型匹配；逐方法计读预算，已签名广播另计写预算。日志查询只接受指定区块哈希或不超过1000块的显式数值范围，费用历史最多1024块及100个有序百分位。上游复用受保护 CHAIN_URL、服务端 CHAIN_ID/CHAIN_SECRET、3秒超时、现有4MiB响应硬顶和手工重定向拒绝，不自动重试已签名交易；公开响应不复制上游头、Cookie、异常正文或 error.data。eth_chainId 和 net_version 必须实际返回0x7eb及2027，余额、gas报价和手续费不伪造。

服务端继续复用既有 nrcgch-rpc Tunnel 与 Access Service Auth。目标链路为公共 Worker → 受保护的 chain.crcfrcn.com → HTTPS回环网关18080 → HTTPS回环节点9944。公网使用 Cloudflare 边缘证书，回源使用 Cloudflare Origin CA；源证书SAN为chain.crcfrcn.com，私钥在生产服务器生成，只有CSR提交Cloudflare。cloudflared 配置 originServerName、httpHostHeader 和 caPool，Nginx 对节点配置可信CA、SNI及证书域名校验；禁止 noTLSVerify、跳过校验或明文回退。Origin CA不用于MetaMask直接访问回环节点。

2026年10月7日只读核实生产节点仍是 citizenchain 1.0.1-babef11d9a7，18080与9944仅回环监听，现有Nginx回源为HTTP，9944的TLS握手返回WRONG_VERSION_NUMBER。部署二进制的原生RPC方法标识存在，eth_chainId、eth_sendRawTransaction、eth_estimateGas和新TLS配置标识均未检出；这属于部署静态证据，不替代真实Ethereum RPC验收。生产证书签发、具备TLS及Ethereum接口的节点部署和真实链ID核对尚未完成，故公共域名尚未发布，不能宣称MetaMask已可连接或转账。上线前须完成实际TLS链路、真实方法、链身份、广播回执和费用核对。

公共入口的生产激活顺序为：旧Node先承载新Runtime升级；链上新Runtime的创世身份与真实块0一致且继续出块/最终确认后，才增加Node对应创世身份守卫并更新各节点软件；随后完成Cloudflare证书与HTTPS回源验证，再激活公共域名。证书及网关候选可提前准备，源码中的身份API或编译常量不得冒充链上升级成功的证据。

候选使用锁内77个既有npm原件离线验真物化，公共RPC模块69项与既有限额10项、链身份5项，共84项通过、0失败；候选全部生产TypeScript依赖闭包及上述测试在TypeScript6.0.2下608份文件、0诊断。上游替身覆盖协议、限流、响应校验、失败及泄露拒绝，只代表代码合同验收，不代表生产链或MetaMask实际UI通过。

## 聊天功能的唯一产品归属

**聊天客户端的逻辑功能只能在 TataChatSDK 中实现；聊天服务端的逻辑功能只能在 TataChatServer 中实现。公民、途遇及其他产品只依赖使用。**

CitizenServe 涉及聊天时只作为依赖使用方；本条不代表尚未接入聊天的产品已经具备聊天能力。

- 消息、会话、群组、加密、协议、传输、同步、重试、聊天存储、附件、通话及聊天界面行为，按客户端与服务端职责分别归 TataChatSDK 和 TataChatServer；新增功能、缺陷修复和平台差异也必须在所属塔塔聊天产品内完成。
- 消费产品只提供产品入口、身份与业务权益结果、服务地址及授权、主题和公开接口要求的平台配置；只通过公开接口接入，禁止复制、重写、包装成另一套聊天内核或维护产品专属聊天实现。CitizenServe、TuyuServe 的产品身份与权益授权不包含聊天数据面的实现职责。
- 本机开发直接依赖仓库路径；公民、途遇等产品的正式版本依赖塔塔聊天正式 Release；第三方市场分发使用公开市场版本。依赖使用不以公开市场发布为前置条件，也不改变实现归属。

受控缓存固定为 `citizenserve/target/<platform>/<build|ci|release|publish>/`。本机 Build 在 `build/source-view/` 只读引用源码，`npm ci`、Wrangler 生成的 `worker-configuration.d.ts`、TypeScript状态、临时文件与日志均写入 `build/`，不会改写源码目录。

## 2026-09-02 本机 Cloudflare 编译入口

TataConsole 已登记 `citizenserve.cloudflare.build`。依赖下载统一进入受控 npm 公共缓存，
单次安装、Wrangler 临时状态和 dry-run Worker 候选只进入当前产品/平台工作目录；产品源码通过
只读符号链接视图直接参与编译，不复制源码且不生成 `node_modules`、`.wrangler`、`dist` 或
`build`。候选只位于`citizenserve/target/cloudflare/build/`，不保留到target；Build不部署服务。

本文是 CitizenServe 唯一技术事实文档。

TypeScript、Vitest、Wrangler 配置和生成的 Worker 类型统一位于 `citizenserve/scripts/`；`package.json` 的命令均显式传入对应配置路径。

`generate:types` 使用锁定 Wrangler 生成完整声明，清理行尾空白，并在运行时类型标记后确定性生成唯一中文职责注释；标记缺失时失败。禁止单独手改生成文件。`types:check` 通过唯一scripts/check-worker-types.mjs使用Node官方crypto比较生成前后完整文件的SHA-256；同一Node执行npm的generate:types，生成或后处理非零退出、信号终止、输入缺失和文件漂移均失败。不调用外部摘要工具，不比较空摘要，不增加第二生成器。既有发布输入测试通过源码外临时目录运行真实生成命令，覆盖重复生成一致、字段漂移失败及生成失败时原文件不变。

### CitizenServe 技术文档

#### 产品边界

CitizenServe 是独立的 Cloudflare 云服务产品，源码唯一根目录为 `citizenserve/`。
CitizenApp 只包含 iOS 与 Android 移动端；CitizenWeb 只包含官网前端。三者不得共享产品 ID、
版本状态、候选、Tag、产物、发布记录或清理配额。

TataChatServer 是 tuyutata/tatachatserver的独立公开聊天服务产品，产品 ID 和源码目录统一为 `tatachatserver`。CitizenChatServer 是 crcfrcn/citizenchatserver中的独立公民聊天服务实例，正式地址固定为 `https://chat.crcfrcn.com` 与 `wss://chat.crcfrcn.com/realtime`。CitizenServe 是公民身份、会员权益和设备会话的唯一产品授权签发方，并把验证结果签成受众唯一为 `citizenchatserver` 的短期 EdDSA 授权；该过程只属于授权控制面。CitizenChatServer 独立验签并承载通用密文邮箱、附件对象、实时连接和通知触发，CitizenServe 不进入任何聊天数据链路，也不保留第二套聊天数据面。

#### 自动化合同

- 产品 ID：`citizenserve`
- 部署供应商：`cloudflare`；正式 Release 使用类型化字段 `deployment_provider`，不把 Cloudflare
  表达为宿主操作系统平台
- CI：规范路由 `citizenserve.cloudflare.ci`
- Release：规范路由 `citizenserve.cloudflare.release`
- 发布：本机 TataConsole 固定执行器；GitHub 不保留发布 Workflow
- Tag：`citizenserve-cloudflare-v<software_version>`
- Release 产物：`citizenserve-cloudflare-release.tgz`
- 生产环境：Worker、主 D1、KV 与 Queue 均为 `citizenserve`；下载 D1 为
  `citizenweb-download`；私有与公开媒体 R2 分别为 `citizenserve-private`、
  `citizenserve-media`
- 脚本：CI/Release 分别使用
  `citizenserve/scripts/ci/cloudflare/index.mjs` 与
  `citizenserve/scripts/release/cloudflare/index.mjs`；发布只在 TataConsole 本机执行

CI 与 Release 脚本直接拥有该动作实现，不导入其它产品或动作脚本。CI、Release、发布是三个独立动作；
Release 来源校验只接受 `product-id=citizenserve`、`target=cloudflare`、`workflow=citizenserve.cloudflare.ci` 和 `prefix=citizenserve-cloudflare-v` 的完整身份。`workflow` 参数表达产品 CI 身份，不接受 YAML 文件名；远端 Run 的文件路径另行严格校验为 `.github/workflows/citizenserve-cloudflare-ci.yml`。来源必须同时为 completed/success、workflow_dispatch、main、准确源码 SHA 和“公民服务端 · Cloudflare · CI”标题，实际检出 HEAD 必须一致。任一身份或 API 验证失败立即停止，不读取后续版本候选。
既有发布输入测试直接执行真实 Release 入口及 step 0，仅以合成 gh/git 响应隔离远端和凭据，覆盖成功来源、旧文件名/错产品/错平台拒绝、失败 CI、错路径/源码/检出与 API 失败；保留首次版本、进位、排除草稿/预发布/其它产品及错误候选拒绝的版本回归。无已发布版本的测试从当前 `citizenserve/package.json` 读取种子版本，因为 Release 作业在运行测试前已把包版本写为本次候选；测试不得假定检出后的包版本仍为 `1.0.0`。
CI 的 D1 阶段通过真实 shell 续行执行两份最终 schema，仅使用 `--local`，持久化目录固定在调用方的 `RUNNER_TEMP` 下；路径含空格时仍必须作为一个参数传递。任一建表命令失败立即停止，保留旧 `migrations` 目录存在时失败的检查。既有发布输入测试覆盖准确阶段参数、首个与第二个命令失败传播、仓库身份及旧目录拒绝，并真实执行 Wrangler 建表后只读回查全部 schema 表；无效 SQL 必须失败且不得执行第二份 schema。
流程测试改动必须同时通过产品 `typecheck` 与 `test`；Vitest 运行成功不能替代 TypeScript 静态检查，子进程输出用作断言说明时必须明确转换为字符串。
记录、Artifact、Release 和 Deployment 按 `product_id + target + action` 独立归组。每组最多展示或
保留一条成功记录和一条失败记录；两个结果方向独立，失败记录不得挤占或删除成功记录。

#### 塔塔控制台合同

TataConsole 使用 `citizenserve` 独立版本状态，并在“公民云”模块显示“公民服务端”。
塔塔控制台只 dispatch 上述准确 CI/Release workflow 路径；发布不 dispatch GitHub，只消费准确正式
Release，并在 QR_V1 冷签与 Touch ID 同时通过后使用本机 `SERVER_DEPLOY`。它不从 CitizenApp
或 CitizenWeb 的状态推导版本。会员镜像对账从 `citizenserve/` 执行。

现有“发布 · Cloudflare”按钮直接调用签名主进程中的固定发布器。发布器下载并验真准确
`citizenserve-cloudflare-release.tgz`，读取本机 `SERVER_DEPLOY` 和 Worker Secret，上传无流量
version，然后直接创建仅包含该新版且流量为 100% 的生产 deployment。切换后回读 deployment
并通过生产域名核对准确 version id；失败则创建仅包含旧版且流量为 100% 的 deployment，随后
复核旧版健康接口。部署器不存在多版本生产载荷入口。生产 Cron 只允许
`*/5 * * * *` 与 `4 3 * * *` 两条，并由同一发布事务准确同步；GitHub 仍只执行 CI、Release。
正式包保留 `scripts/wrangler.toml` 原文；`main = "../src/index.ts"` 按原脚本目录解释，
实际上传模块仍为包内 `worker.mjs`。发布器只接受该准确入口，并继续要求
`workers_dev=false`、`preview_urls=false`；错误入口在生产写入前失败关闭。
首次发布允许准确 `citizenserve` Worker 尚不存在，但要求两个 D1、两个 R2、KV 与 Queue 已按上述
唯一名称存在且为空；发布器执行两份唯一最终 schema、上传空 exports Worker、建立 Queue 消费者、同步
Cron，并把唯一生产 Route 从旧 Worker 原子切到 `citizenserve`。后续发布继续使用准确旧 version 作为
回滚锚点。发布器不执行 DROP、迁移、旧表清理或数据转换。
首次发布的旧版本锚点为 `none`。中断后仅在只读回验确认目标 Worker 不存在、准确 Queue 无消费者、
生产 Route 和媒体域均未切向目标时，才能确认无需回滚并关闭该次中断事务；任一证明失败继续阻断发布。
恢复过程不删除资源，也不直接修改本机事务数据库。
Cloudflare Workers Scripts 列表响应允许省略空 `exports` 字段；本产品 Release 准确要求空
`exports` 时把字段省略按空值验收。字段存在但格式错误、意外出现 export，或非空期望下字段省略，
仍禁止通过发布后控制面验收。

发布器从 TataConsole 公开配置 `ZONE_ID` 取得唯一生产区域，并在 Release 检查和正式发布写入前执行完全相同的只读权限预检：`Token Verify -> Cron
Schedules -> Workers Scripts -> Zone Workers Routes -> Queues`。生产 Route 的唯一读取合同是
`GET /zones/{zone_id}/workers/routes`，并从区域全部 Route 中唯一筛选 `script = citizenserve` 与
`www.crcfrcn.com/api/*`；禁止调用不存在的账户级脚本 Route 地址。诊断只允许输出步骤、HTTP
方法、脱敏路径、状态码、Cloudflare 受限错误和合法 `CF-Ray`，不得输出令牌、账户/区域编号或
查询参数；预检失败时不得上传 Worker 或修改任何生产资源。

#### 用户投影健康与缺失账户语义

- 不新增 migration、SQL 或数据表，也不迁移任何数据。健康判定只读取既有
  `user_projection_cursor`，并与链上当前 finalized 头比较。
- 游标高度、哈希及创世身份finalized核验均完成时状态为 `ready`，此时 D1 查无账户才允许返回
  `cid_not_bound`；游标落后或尚未建立时返回 `identity_projection_pending`，链配置、RPC、
  D1 游标读取异常或锚点矛盾时返回 `identity_projection_unavailable`。
- `GET /health` 在保留准确 Worker version 验收字段的同时返回
  `identity_projection_status / finalized_block_number / cursor_block_number`，这些字段只用于业务
  运行状态观测。TataConsole 发布器不得读取、判断这些身份投影字段，也不得据此判定发布失败
  或触发回滚。公共健康接口使用现有 KV 做 60 秒短缓存，避免匿名探活放大内部链 RPC；登录缺失
  账户的安全判定始终实时检查，不读取该缓存。

#### 原子部署与固定拓扑（2026-08-24）

CitizenServe 日常发布使用 `PUT /workers/scripts/citizenserve` 原子替换。发布不提交灰度比例。上传响应严格按 Cloudflare `ScriptUpdateResponse` 只读取脚本 `id/etag`，禁止从上传响应读取或推断部署编号；准确生产版本从 Deployments API 的唯一 100% `versions[].version_id` 获取，并以 Version Detail 的 `resources.script.etag` 验证就是本次上传产物。`citizenserve` Worker、两个准确 D1、两个准确 R2、`SQUARE_CACHE -> citizenserve`、`NOTIFY -> citizenserve` 与唯一 `citizenserve` 消费者是固定资源门禁；Release 内的 Cron、队列批量/等待/重试/并发参数是本次发布目标，禁止拿线上旧 Tag 冒充本次 Release。

发布前只验证旧生产健康、QR 绑定的回滚锚点和固定资源，并保存旧 Cron 与队列消费者快照；禁止比较旧线上 Tag、exports、Cron、Queue 与本次新 Release。每次发布都统一上传本次 Release，不设同 Tag 快捷分支。发布后必须验证新 deployment id、本次 Release 标签、单版本 100% 以及本次 Release exports/Cron/Queue；身份投影状态不属于发布验收条件。任何一步失败均恢复准确旧版本和旧配置，回滚只与发布前快照比较；回滚无法验收时事务保持未闭合并禁止下一次发布，待塔塔控制台恢复操作处理。

#### CitizenServe 聊天最终边界

CitizenServe 不是聊天服务端。它只在合法 CitizenServe 会话、finalized CID 绑定和有效会员状态全部成立时，
通过 POST /auth/chatserver/access 签发十五分钟 EdDSA 短期授权；响应只包含 CitizenChatServer HTTPS 根、
短期 Token 和到期时间。客户端随后直接连接 CitizenChatServer，CitizenServe 不参与消息或附件传输。

CitizenServe 源码、路由、D1、R2、Durable Object、Cron、限额和测试不得保存或处理聊天消息、密文邮箱、
KeyPackage、信令、ICE、ACK、聊天附件或聊天推送端点。CHAT_SERVER_URL 与
CHAT_AUTH_ED25519_PRIVATE_KEY 只属于短期授权控制面，缺失或非 HTTPS 时失败关闭。

普通应用通知与聊天完全分离：PUT /square/push-endpoint 使用已验签 Session 的 device_id 登记
push_endpoints，只服务广场公开提醒和会员存储清理预告。APNs/FCM 传输位于 src/shared/push.ts，端点登记
位于 src/auth/push_endpoint.ts；任何通知载荷都不得携带聊天消息、会话、附件或聊天唤醒状态。

CitizenServe 的唯一最终数据库结构只包含 push_endpoints 普通通知表，不包含任何聊天前缀表。Worker 不导出
聊天 Durable Object，不声明聊天数据面资源，也不运行聊天清理任务。注销用户只删除该 CID 的普通通知端点；
聊天数据的生命周期完全属于 CitizenChatServer。

测试必须正向覆盖短期授权、普通推送端点、广场通知和存储清理提醒，并反向证明聊天数据面路由、表、DO、
源码目录和生成绑定不存在。

### 2026-08-31 TataChatServer 访问授权适配

- 新增 `POST /auth/chatserver/access`。请求必须同时通过当前 Bearer 会话、同一MLS身份的请求证明、账户/CID 投影和 D1 有效会员校验。
- 成功响应只返回 `chat_server_url`、`chat_server_token` 与 `expires_at_millis`；JWT 有效期固定 15 分钟，签名使用 `CHAT_AUTH_ED25519_PRIVATE_KEY`。
- JWT 只包含通用授权：用户、设备、聊天开关、附件字节上限、签发方、受众、生效时间和到期时间；不把会员名称、链状态或 CitizenServe 会话交给 TataChatServer。
- `CHAT_SERVER_URL` 必须由正式环境显式配置为严格 HTTPS 根地址；公民实例目标地址为 `https://chat.crcfrcn.com`，但源码接线不等于生产部署。
- 2026-09-11 第1步已在 `scripts/wrangler.toml` 固定
  `CHAT_SERVER_URL=https://chat.crcfrcn.com`，并用锁定 Wrangler 4.121.0 重新生成 Worker 类型。
  缺失地址和非 HTTPS 地址继续失败关闭为 `chat_server_not_configured`；授权、配置和 Release
  专项合同 22/22 通过。本步骤没有执行 Build、CI、Release、发布或部署。
- CitizenServe 只测试短期授权、HTTPS 根、普通应用推送端点及自身产品合同；聊天消息、附件、
  KeyPackage、邮箱、实时帧和聊天推送全部由 TataChatServer 验证。

## 2026-08-31 TataChatServer 第 6 步运行时依赖边界

- CitizenServe 对 TataChatServer 的依赖是运行时授权依赖，不是 Node 包或源码嵌入：CitizenServe 只根据公民身份与 finalized 会员投影签发 Ed25519 短期通用令牌，并返回唯一 HTTPS TataChatServer 根地址。
- CitizenServe 不保存、解析或转发聊天密文，不读取 TataChatServer Rust 源码，也不复制 Cloudflare/LinuxARM 推送实现。
- 本机联调连接同仓启动的 TataChatServer；正式 CitizenServe Release 只配置并连接由准确 Git 源提交产生的 TataChatServer 正式部署。两个产品仍分别拥有版本、CI、Release、配置和部署状态。
- CitizenServe 测试只验证自身会话、会员到通用令牌字段的映射和 HTTPS 地址失败关闭；TataChatServer 令牌验证、邮箱、附件、七天期限和推送由 TataChatServer 自己验证。
## 第 6 步 TataChatServer 边界验证（2026-08-31）

- CitizenServe 独立隔离快照执行 39 个测试文件、325 项测试，全部通过；`npm run typecheck` 通过。
- CitizenServe 只保留公民号、会员和平台配置等宿主鉴权适配；TataChatServer 通用推送与聊天合同由 TataChatServer 自身测试负责。
- 本步骤未执行 CI、Release、发布或部署。

## 第 5 步：聊天授权签发边界验收（2026-09-02）

- CitizenServe 仅签发 `audience=citizenchatserver` 的短期 Ed25519 授权，并返回 HTTPS 聊天服务入口。
- 授权主体只包含当前账户、当前设备、会员聊天开关和附件上限；禁止包含聊天正文、附件、收件人或离线邮箱数据。
- CitizenServe 不代理 TataChatServer 的 WSS 控制面和 HTTPS 附件面，也不参与消息发送、拉取、ACK 或推送转发。
- 本步骤未修改 CitizenServe 生产职责，也未执行部署或发布。

## CitizenChatServer 授权边界

CitizenServe 只持有 `CHAT_AUTH_ED25519_PRIVATE_KEY` 并签发短期聊天授权；CitizenChatServer 只持有对应公钥并验证 `aud=citizenchatserver`。聊天消息、附件、推送、信令、D1、R2 与 Durable Object 均不进入 CitizenServe。

## CitizenChain macOS updater 路由（GMB 第 2.5 步，2026-09-02）

- CitizenServe 源码合同唯一登记的 macOS updater 公网路径为
  `/download/citizenchain/macOS/updater`；平台和交付用途使用两个独立路径段。
- 旧架构拼接路由不再进入源码中的下载映射或限流白名单，新代码调用时返回未登记/不存在；
  不建立兼容别名、重定向壳或第二套路由。本步没有部署，生产入口切换不在本次完成范围内。
- 新路径继续读取现有 `macos` 发布指针并 302 到当前 GitHub updater manifest；本步不修改
  生产 D1、Release Tag、安装包或 manifest 资产名。
- `limits.test.ts` 与 `citizenchain_download_publication.test.ts` 最终 16/16 通过；公民系列仓库守卫
  同时核对 Tauri、CitizenServe 路由、限流和 TataConsole 发布验收四端一致。
- 本步没有部署 CitizenServe、修改生产数据、运行远程 CI、正式 Release 或发布。

## CitizenChain 四端安装下载公开路由（GMB 第 2.6 步，2026-09-02）

- CitizenServe 源码合同登记的四端安装路径精确为
  `/download/citizenchain/macOS`、`/download/citizenchain/Windows`、
  `/download/citizenchain/LinuxARM`、`/download/citizenchain/LinuxAMD`；updater 仍使用
  `/download/citizenchain/macOS/updater`。
- 下载边界把四个标准公开路径分别映射到既有内部 D1 发布键 `macos`、`windows`、`linux-arm`、
  `linux-amd`。这些键只属于当前内部存储合同，不得泄漏成公开平台名；本步没有改写生产 D1。
- 限流白名单只接受上述四条安装路径与一条 updater 路径。旧路径 `macos`、
  `windows-x86_64`、`linux-arm64`、`linux-amd64`、`linux-arm`、`linux-amd` 均返回下载不存在，
  不提供重定向或兼容壳。
- GitHub Release Tag、资产名、manifest、来源校验和回滚指针保持原合同；本步只迁移源码公开
  路由，没有部署 CitizenServe，也没有改变线上生产入口。
- `limits.test.ts` 与 `citizenchain_download_publication.test.ts` 合计 17/17 通过；跨仓
  `repo_guard` 最终 13/13 通过，并同时锁定 CitizenWeb 与 TataConsole 使用相同公开路径。
- 独立终检确认路径合同无误，但发现既存的跨端发布 wire 分裂：本服务使用 `version_tag` 与
  旧仓库账户，而当时 TataConsole 发布器分别使用 `release_tag` 与权威仓库
  `crcfrcn/citizenchain`。真实读写指针和 302 精确验收会失败；该问题不由路径改名引入，也不能被
  本步各端自测通过掩盖。后续第 2.6.1 步须在不改 D1 schema、Tag 和资产名的前提下原子修复。

## CitizenChain 下载发布互操作（GMB 第 2.6.1 步，2026-09-02）

- CitizenServe publication wire 的版本字段唯一为 `version_tag`；D1、PUT exact-key
  校验、GET snapshot 与回滚语义均未改名。`release_tag` 只属于 TataConsole 动作/
  QR_V1 输入，如果把它写入 publication，服务端必须以 400
  `publication_payload_invalid` 失败关闭。
- GitHub 下载根地址已与CitizenChain完整产品仓对齐为
  `https://github.com/crcfrcn/citizenchain/releases/download/`；CitizenChain publication 下载不再使用
  旧仓库所有者。`routes.ts` 中 CitizenApp/CitizenWallet 安装包查询当前也统一请求
  `https://api.github.com/repos/crcfrcn/${product}/releases?per_page=100`，其中product仅允许citizenapp或citizenwallet，两产品分别筛选准确
  正式 Tag 前缀与 APK 文件名；成功返回 302，GitHub 非成功响应返回 502
  `release_lookup_failed`，缺少正式资产返回 404 `release_asset_not_found`。对应既有下载
  测试覆盖两产品的准确查询地址、成功跳转和失败状态；这不表示已部署生产服务。
- 唯一互操作 golden 同时驱动 Miniflare 真实 D1 写/读、真实下载 302、Swift
  codec/快照哈希/URL XCTest，Node 和 Rust 只负责快速防漂移门禁；不存在第二份
  publication 测试真源。
- `limits.test.ts` 与 `citizenchain_download_publication.test.ts` 合计 18/18 通过；
  GMB 跨仓守卫 14/14，TataConsole Node 1/1、Swift 2/2 通过。
- D1 schema、生产行、revision、Tag、资产名、manifest、路由定义与限流均未在本步
  扩大修改；源码尚未部署。本轮 282MB 受控验证目录已整体移入系统废纸篓。

## 聊天接入第 2.1 步：Miniflare 5 测试运行时收口（2026-09-11）

- 新增 `test/miniflare.ts` 作为 CitizenServe 测试唯一 Miniflare 构造 helper，直接使用
  Miniflare 5 原生 `workers[].config.env` 登记 D1、KV、R2 与文本 binding；没有调用 v4 转换器，
  也没有保留 `script/modules/d1Databases/r2Buckets/kvNamespaces/bindings` 顶层兼容配置。
- `account.test.ts`、`users.test.ts`、`user_projection.test.ts`、
  `subscription_projection.test.ts`、`post_local_copy.test.ts` 与
  `citizenchain_download_publication.test.ts` 六处测试已统一改用该 helper。
- Wrangler 继续精确使用 `4.121.0`，类型生成与 TypeScript 检查通过；六文件专项 44/44 通过，
  CitizenServe 全量 39 个测试文件、334/334 通过。原先 40 项失败已确认全部来自旧 Miniflare
  顶层 API，并已关闭。
- 第 1 步补入的 `CHAT_SERVER_URL=https://chat.crcfrcn.com` 与授权端点源码合同保持不变；
  本步骤没有部署 Worker、修改生产 binding/Secret/数据、执行远程 CI 或 Release。

## CitizenChain Release 资产身份校验（GMB 第 2.7 步，2026-09-02）

- CitizenServe 对四个内部发布键继续使用 `linux-arm`、`linux-amd`、`macos`、`windows`，但
  publication 的公开自定义资产必须分别匹配 `LinuxARM`、`LinuxAMD`、`macOS`、`Windows`。
  内部数据库值没有被伪装为公开平台名，也没有修改 D1 schema。
- 安装资产闭集为 Linux 两端 `.deb`、macOS `.dmg`、Windows `.exe`；updater 分别为 Linux
  `.AppImage` manifest、macOS `.app.tar.gz` manifest 和 Windows 同一 `.exe` manifest。
  manifest 精确为 `citizenchain-node-latest-LinuxARM.json`、
  `citizenchain-node-latest-LinuxAMD.json`、`citizenchain-node-latest-macOS.json`、
  `citizenchain-node-latest-Windows.json`。
- 四类旧架构拼接资产必须在 publication 写入边界以 `publication_identity_invalid` 失败关闭；
  下载 302 只会组合 `crcfrcn/citizenchain`、既有 Release Tag 与当前新资产名。
- 更新后的 macOS golden anchor 为
  `ccdp:macos:1:c7665f9bf103e67517f8c56665db3553ec3a764fc935a0d0ac5337d9bd67b042`，
  CitizenServe 真实 Miniflare/D1 测试与 Swift codec 共用同一份快照和 Location。
- `limits.test.ts` 与 publication 行为测试 18/18、GMB 跨仓守卫 15/15、TataConsole Node
  49/49、Swift 4/4 通过，共 86 项；Node 由 github 26 项、matrix 8 项、native-ui 15 项组成，
  最后一项使用 `testTuyuMerchantMobileUI` 别名注册。284MB 受控目录已移入
  `/Users/rhett/.Trash/gmb-platform-naming-step2-7-20260902-1245`。Vitest 另覆写的 3450-byte
  `node_modules/.vite/.../results.json` 已定点移至
  `/Users/rhett/.Trash/gmb-platform-naming-step2-7-vitest-results-20260902-1255.json`，源码树无本轮
  缓存文件残留。
- 本步没有部署 Worker 或改写生产行。若生产指针仍引用旧资产，部署新版严格校验前必须先准备
  同版本新 Release，并在受控维护事务中切换 publication；禁止让旧指针与新校验形成确定性
  不兼容窗口。

## CitizenChatServer 授权边界

CitizenServe 只持有 `CHAT_AUTH_ED25519_PRIVATE_KEY` 并签发短期聊天授权；CitizenChatServer 只持有对应公钥并验证 `aud=citizenchatserver`。聊天消息、附件、推送、信令、D1、R2 与 Durable Object 均不进入 CitizenServe。

## CitizenServe Release 部署供应商身份（GMB 第 2.10 步，2026-09-02）

- CitizenServe 正式 `release-manifest.json` 使用精确七字段闭集：`product_id`、
  `deployment_provider`、`software_version`、`git_commit_sha`、`tools`、`files`、`resources`；
  产品固定为 `citizenserve`，部署供应商固定为 `cloudflare`。缺失、错误值、旧 `platform`、
  新旧双写和任意额外字段均失败关闭。
- CI 与 Release 两个产品入口继续内嵌逐字节相同的动作实现，当前均为 21,637 bytes，SHA-256
  均为 `818d36f8fea1aef801873796adba99122e7a321d0113e802907d7594ab795793`。测试读取当前
  `tataconsole/console/citizenserve/{ci-cloudflare,release-cloudflare}.mjs`，不再引用已经不存在的
  `gmb/scripts/citizenserve-*-global.mjs`。
- 新字段没有改变确定性 payload、Wrangler 资源摘要、逐文件 SHA-256、`SHA256SUMS`、规范 tar、
  普通文件限制、解包回验或私密材料拒绝语义。非 CitizenChatServer 候选继续要求外部 manifest
  与 `SHA256SUMS` 和归档内字节完全一致。
- TataConsole 原生发布器只在 `input.productID == "citizenserve"` 时启用专用七字段验证，并在
  QR 授权和任何 Cloudflare 控制面写入前失败关闭。CitizenWeb、CitizenChatServer、TuyuWeb 及
  `CloudPublishInput.platform`、恢复状态、目标键中的既有 `platform=cloudflare` wire 均未改变。
- 本机定向验证通过：CitizenServe Release 6/6、GMB `repo_guard` 18/18、
  CloudflarePublisher XCTest 43/43，共 68 项。首次 Vitest 调用因命令遗漏
  旧外部流程根在收集阶段退出，0项测试执行；补齐当时流程根后完整重跑6/6通过。现行CI与Release已归入产品`scripts`。
  XCTest 使用命令级排除正式打包入口才提供的 `tataconsole` 与 `node` 运行资源，只证明当前
  Swift 源码与测试合同，不冒充正式 TataConsole 安装包。

## CitizenChain publication 负向夹具收口

- `test/citizenchain_download_publication.test.ts` 直接以唯一互操作 golden 的
  `action_tag_field` 作为计算属性键，构造应被拒绝的 TataConsole 动作域旧字段；同一测试先把
  golden 值精确锁定，再删除规范 `version_tag` 并发送真实请求。
- 服务端仍必须返回 HTTP 400 `publication_payload_invalid`。该夹具不是兼容读取、双写或回退，
  CitizenServe publication 的唯一生产版本字段仍为 `version_tag`，D1 schema、路由、revision、
  Tag、资产名和下载 302 均未改变。
- publication 完整行为测试 10/10 通过。本步没有部署 Worker，也未执行远程 CI、Release
  或发布。
### Build与Start物理归属（2026-09-12）

本产品Build、CI和Release唯一实现位于产品scripts目录；TataConsole只按固定身份调用。Start由TataConsole启动产物库中的macOS成功产物，产品不实现Start。

- citizenserve：
  - `citizenserve.cloudflare.build` → `tataconsole/console/citizenserve/cloudflare/build.sh`
  - `citizenserve.linux-arm.build` → `tataconsole/console/citizenserve/linux-arm/build.sh`

## CI与Release入口归属

本产品CI与Release由所属仓当前`scripts/flows.json`的remote_routes及各平台Workflow声明定位，完整执行入口为本仓`scripts/flow.mjs`。控制台读取当前声明、创建原有真实任务、获取准确仓权限并跟踪原Run；旧控制台CI/Release Shell与Swift执行文件已删除，不作为入口。

## 独立 GitHub CI 与 Release 工作流

本产品每个实际产品、平台、流程身份使用下列独立文件，主 Job 为 `flow`；CI 验证源码，Release 生成正式产物，发布由塔塔控制台的独立 Publish 流程负责。

- `.github/workflows/citizenserve-cloudflare-ci.yml`
- `.github/workflows/citizenserve-cloudflare-release.yml`

## 目录整合与平台输入

contacts、media、author_signals、r2_keys 模块直接位于 `src/`，区块链下载模块为 `src/citizenchain_download.ts`。测试配置归入 `scripts/ci/vitest.config.ts`；发布合同测试归入 `scripts/release/release_manifest.test.ts`，Vitest 仍以产品根发现测试。原 Workflow 固定入口不移动，业务接口和存储合同不变。

`src/moderation/` 没有源码或独立职责，空目录移除，不保留占位入口。

## 创世身份与会员投影闭环

正式创世身份作为公开链数据直接写入既有`schema/citizenserve.sql`最终基线，不新增迁移、表或初始化脚本。重复执行仅建立缺失CID及默认公开资料，保留更高绑定版本、现有身份和用户编辑资料。身份投影每次核对基线第0块锚点及最新finalized状态；同绑定版本保留原换绑锚点，新版本才推进绑定轴。创世登记没有普通注册事件，不能仅从第1块事件发现。未完成核验的创世记录不得作为登录身份或会员外键依据，健康检查显示pending；撤销仍走既有清理入口。创世核验失败不得推进游标。会员任务继续按原canonical游标重放，不跳过缺失身份或伪造会员。定时 project-subscriptions 明确等待 project-users 成功，身份失败不启动会员任务且不推进其游标；清理任务独立结算，不受投影等待和失败阻断。调度仅输出失败任务和稳定错误码，不输出异常正文或凭据。

创世基线的第0块身份锚点不表示已完成运行态核验；即使初始化游标也在第0块，登录和会员仍拒绝使用基线授权，健康检查保持pending。首次非零finalized块核验当前有效绑定后才开放对应授权。

### 独立检出下的SDK金标验收
bootstrap回归只读取CitizenSDK所有者test/node/citizensdk_bootstrap_manifest.json，来源固定为crcfrcn/citizensdk提交52b83f8f33a9424f3a92161da4f183678263ab7c的HTTPS原件。测试拒绝重定向、非成功响应和超过64KiB输入，所有响应键、链上信任字段及禁止RPC暴露的断言保留；不在服务端另存金标副本。正式下载分路由查询公民或钱包准确仓，链下载指针只组合crcfrcn/citizenchain正式资产。
## 完整产品组织与执行合同

所有者：`citizenserve`，正式源码根 `/Users/rhett/citizenserve`；本说明属于该完整产品。组件不会拆成独立仓库或目录产品。所有执行身份统一为 `产品.平台.流程`，单平台仅在控制台显示和物理目录中省略平台层。

真实平台目标：`cloudflare`、`linux-arm`。

推送门禁唯一源码位于 `/Users/rhett/citizenserve/.github/tatagate/`，GitHub入口 `/Users/rhett/citizenserve/.github/workflows/tatagate.yml`。控制台先从本仓已保存提交执行这份门禁，通过后推送准确SHA；GitHub main push再执行同一提交的门禁，控制台核对所属仓、Workflow、main、SHA、Run和attempt，只有success并再次回查main一致才完成推送。失败、取消、超时或身份漂移均不得显示成功，不自动重试或派发CI/Release。

技术文档由所属完整产品仓根唯一持有；私有规则和任务库由控制台私仓持有，公开产品不读取它们。公开门禁不依赖私仓资料、安装包源码、其它本机产品或个人账号；必要链真源先锁定公开main的实际SHA后只读该SHA。本机开发跨产品验收仍比较三仓已保存快照与各端真实镜像。

正式创世身份直接登记于既有最终schema；重复初始化不得覆盖更新后的绑定、身份和资料。创世身份投影必须核对第0块canonical锚点与当前finalized状态；未完成核验不得用作登录身份或会员依据，失败不得推进游标。

公民链发布指针的version_tag只接受完整citizenchain产品四个平台Tag：citizenchain-<platform>-v<version>；Node资产名保持citizenchain-node-<公开平台>-v<version>。旧拆分Node Tag即使搭配正确资产也拒绝，协议字段、D1平台键、revision事务及回滚边界不变。既有互操作金标同步这一完整Tag与Location，snapshot_anchor按snapshot_json规范字节派生，与Swift和Node开发回归保持一致。

### 门禁与开发审查职责

准确中文注释按开发阶段逐项复核，不以保留源码每文件包含汉字作为仓库门禁的开发凭证。初始完整内容、生成文件和上游原件保持原文；真实第一方临时注释、机密、源码输出、Workflow、依赖和适用测试仍由本仓同提交门禁验真。公民门禁只把scripts中的Node命令行结果报告识别为CLI输出；本仓实际执行测试的准确协议拒绝断言不属于新运行协议，字符串、注释、模板和未登记测试中的同文不豁免。保存及推送仍逐仓独立授权，并以本机门禁和同SHA的GitHub门禁双成功为唯一终态。

明文地址仅作为本仓三个既有完整负向测试的拒绝输入保留：链 RPC 在 fetch 前拒绝，聊天签发方与部署地址配置拒绝；门禁按准确测试路径、完整执行正文与拒绝断言识别。注释/模板伪装、成功断言、其它地址和其它路径仍拒绝，不豁免整个测试目录。

版本标识检查准确区分 Cloudflare 官方 v4/v0、FCM 官方 v1 与公民产品软件 Release Tag/资产名、既有互操作金标文件；这些外部 API 和软件版本不构成新增第一方协议。错误域名、未知路径版本和新协议名继续拒绝；错误拼接资产后缀仅在既有下载拒绝测试中认可，原完整下载格式断言保持。

## 产品介绍与开源许可

根目录 `README.md` 仅提供本产品简明介绍，不承载技术方案、任务记录或验收结论。独立自有代码采用根 `LICENSE` 的MIT；上游代码、衍生修改、依赖及组合分发遵循各自原许可、版权、例外与附加要求。

### 本机Build代码所有权

本产品的scripts/flows.json声明自身平台、准确工具版本、原始锁以及既有CI/Release入口；scripts/build.mjs独立实现requirements、prepare、build三个阶段，拥有工程准备、编译命令、候选验真和失败条件。产品只消费调用方交付的公开资源回执，按本仓原始锁取得依赖，所有生成状态进入规范源码外工作目录。平台或资源身份不符、版本错误、缺锁、链接越界、归档摘要错误、旧工程复用或编译器失败均立即失败。

## MLS设备身份与认证

CitizenServe源码的客户端设备认证唯一使用TataChatSDK已经持久化的同一MLS Ed25519身份。用户主键是CID，证明user_id等于cid_number；device_id等于public_key去掉0x后的64位小写hex。服务端只保存公开身份及钱包授权的当前绑定，不生成或接收客户端私钥。

POST /square/auth/challenge接收准确六字段：account_id、public_key、purpose、method、request_target、body_sha256。purpose闭集为session、request、registration。CID与binding_revision只从已核验finalized投影读取；会话/普通请求挑战还必须匹配当前登记。request挑战必须持有当前设备会话，并绑定服务端计算的Bearer token SHA-256。成功响应提供ok及固定证明中除signature以外的十一字段，不提供任意签名域或任意待签消息。

认证唯一通过X-MLS-Proof头传递无填充规范base64url的UTF-8紧凑JSON，必须包含准确十二字段：user_id、device_id、public_key、account_id、binding_revision、service_origin、challenge、expires_at_millis、method、request_target、body_sha256、signature。重复、缺失、多余字段、非法UTF-8、非规范编码、错误公钥格式或设备对应关系均拒绝。证明最多16KiB，请求正文最多1MiB。

签名逐字使用RFC9420 SignWithLabel的固定TataChatAuthentication标签。SignContent中的标签为MLS 1.0 TataChatAuthentication；content顺序为TLS user_id<V>、device_id原始32字节、account_id原始32字节、binding_revision uint64大端、service_origin<V>、challenge原始32字节、expires_at_millis uint64大端、method<V>、request_target<V>、body_sha256原始32字节。<V>是MLS最短TLS变长长度编码。签名为小写0x加128位hex，公钥、账户、挑战和正文摘要为小写0x加64位hex。这是同一MLS身份的固定应用认证扩展，不是MLS内置HTTP登录。

service_origin必须等于实际请求的规范HTTPS源；method、含实际/api前缀的原始路径和查询及全部实际正文字节必须匹配。GET、HEAD、DELETE也计算实际正文，不默认为空。原有路由业务授权及不要求设备证明的明确例外仍各自适用；需要设备证明的路由全部走同一MLS验签与挑战消费。

mls_authentication_challenges是唯一挑战表，每CID每用途最多64条未过期、未消费挑战，三种用途合计最多192条活跃记录。挑战为服务端32字节随机数，有效期最长五分钟。签发以单条条件INSERT原子计数；实际签名验证成功后，以条件DELETE同时核对全部挑战字段、当前有效绑定及已登记公钥。删除成功一行才允许业务继续；不存在的挑战一律拒绝，所以并发只能消费一次。消费后业务或会话写入失败不恢复挑战，重试申请新挑战。定时任务删除到期记录，CID注销删除所属挑战与登记。

每次需要设备证明的普通请求增加一次挑战往返、一次D1签发写入及一次D1消费删除，另有身份、登记和挑战读取；不能称为零写入认证。边缘限流、每用途存储上限、正文上限和到期清理共同限定资源使用。普通客户端不需要新密钥或生物识别。

POST /square/auth/session正文唯一为account_id；MLS证明核验登记公钥并消费session挑战后签发会话。KV会话及square_sessions强一致索引均保存同一device_id，拒绝旧缓存结构。索引写入再次检查当前绑定和登记，KV/D1任一写入失败均清理半成品。每CID保留最多八个会话；换绑清理只删除更早绑定，不能删除并发产生的更高代次。

POST /square/auth/device/register正文唯一为account_id、public_key、issued_at、binding_signature、turnstile_token。登记必须同时通过当前钱包授权和同一MLS身份对新鲜registration挑战的持钥证明，自签公钥不能授权CID。钱包登记消息唯一命名OP_SIGN_MLS_DEVICE_BIND，仍使用GMB op_tag 0x1c，SCALE字段顺序为cid_number、binding_revision u64LE、account_id、public_key、issued_at u64LE；public_key现在为同一MLS公钥的规范0x文本。该登记载荷变化已取得单独授权；钱包私钥保管与签名流程不属于本步修改范围。

已持久化的钱包登记授权可复用，issued_at必须为安全正整数且不能超过当前时间五分钟；历史时间授权仍必须配合新鲜MLS请求证明。新登记或更新要求Turnstile，完全相同登记回执重试不重复要求Turnstile。旧证明不能覆盖更高代次或同代次较新issued_at。登记仅写mls_devices公开身份，并收敛旧鉴权记录，不删除CID公开业务数据或钱包材料。

聊天授权请求仍提交device_id，但只能等于已验签会话中的同一MLS设备，否则拒绝。普通通知端点也以该设备编号归属，不再从另一设备认证体系推导编号。

服务端与App源码及测试合同均已接入同一MLS身份认证；正式SDK消费与全域验证须完成最终收口。没有迁移、双轨字段或运行时回退。当前修改未编译、未执行测试、未部署，也未删除实际服务数据。最终切换时按已授权所有权范围清除旧非钱包鉴权数据、重新建立唯一结构；不能把最终schema的CREATE TABLE IF NOT EXISTS当成旧表已经移除的证明。全部七步完成后统一进行静态分析、编译、适用测试与真实环境验收。

## 同CID通讯录MLS传递（第5步源合同）

唯一入口POST /square/contacts/mls，CID、账户、绑定版本和设备仅来自当前普通MLS会话。动作闭集publish/state/reserve/commit/ack；不依赖聊天会员权益。contact_mls_groups保存公开组与版本，contact_mls_packages保存公开KeyPackage，contact_mls_operations保存幂等结果，contact_mls_messages保存设备队列的不透明MLS字节。服务端不接收联系人关系或私人备注明文。

同CID最多32设备，每KeyPackage16KiB，每消息48KiB，每设备队列1024条，同CID队列总量32MiB；接口正文最多256KiB。已提交操作最多1024条，保留七天；待确认操作须原设备恢复。预留和提交都采用组版本CAS，重复提交必须原结果逐字一致。Commit按设备扇出，Welcome只发新设备；移除只允许已失去当前授权的精确设备，并删除其队列与公开包。全量账户删除准确清除四张所属表。

客户端使用真正OpenMLS处理、验证实际身份、保存原子协议结果；application内部严格绑定operation_id、owner_cid_number和最多32KiB的规范payload_base64，业务合并之后才ACK。原生确认成功而服务端ACK失败时，精确重放只补服务端ACK。新设备经现有有效成员Welcome加入；全部MLS状态丢失时无法由钱包恢复旧组。旧通讯录存储合同与路由已删除，无迁移或兼容。当前未执行D1初始化/清理、部署、测试或运行验收，统一安排在全部七步源修改完成后。


### 产品独立资源与编译入口

本产品的scripts/flows.json声明自身平台、准确工具版本、原始锁以及既有CI/Release入口；scripts/build.mjs独立实现requirements、prepare、build三个阶段，拥有工程准备、编译命令、候选验真和失败条件。产品只消费调用方交付的公开资源回执，按本仓原始锁取得依赖，所有生成状态进入规范源码外工作目录。平台或资源身份不符、版本错误、缺锁、链接越界、归档摘要错误、旧工程复用或编译器失败均立即失败。

本产品平台闭集为`cloudflare`、`linux-arm`。调用格式为`node scripts/build.mjs <requirements|prepare|build> <platform> --work <绝对工作目录>`；requirements只读并输出唯一JSON，prepare/build从标准输入读取schema=1的资源回执。调用方交付准确工具执行器、锁定依赖目录、Git来源和归档后先prepare，再读取展开来源新增的需求，完整交付后执行build。准备、展开和编译属于同一调用工作根，各平台互不共享可写状态。独立调用方按本仓声明准备资源即可运行，无需读取其他产品工作树或私有资料。

Git依赖只接受本仓声明与锁一致的HTTPS地址及40位固定提交；原生归档只接受本产品锁定坐标及完整SHA-256。工程副本排除旧生成物，内部文件链接重映射到同轮副本，外部链接与已有工程拒绝。原始依赖缓存必须显式交付，不能落入用户默认缓存；离线编译禁止隐式取得缺失资源。已有CI/Release Workflow仍各自调用本仓scripts，不受本机可视化入口是否存在影响。入口回归由本仓`scripts/build.test.mjs`负责，适配与资源服务的验证不替代产品编译和真实候选验收。

唯一npm test依次执行Vitest业务TypeScript测试及Node构建合同，任一失败即阻断；构建测试的Shell由调用方通过PRODUCT_SHELL_BIN交付已验真的绝对普通入口，不使用系统回退。假Wrangler脚本遵循其CommonJS执行边界，成功、旧输出、空输出、编译失败及产品来源漂移断言全部保留。该工具输入只属于验证，不引入设备秘密、协议用途钥或新业务字段；唯一入口实际329项业务及11项Node合同全部通过。

Cloudflare CI与Release各自在所属check/execute.mjs独立准备GNU Bash5.3.20，固定Bash5.3原件及20份有序官方补丁；只在准确Ubuntu24.04 x64手动作业核验现成基础包、命令归属、版本与摘要后编译，并在编译后复验。两个源码外工具对象分别位于Runner临时根的citizenserve-cloudflare-ci-shell和citizenserve-cloudflare-release-shell，不共享可写对象或导入另一流程实现。完整文件回执、产物摘要、普通绝对入口和版本再次通过后，CI第7阶段及Release第5阶段显式使用该Shell执行唯一npm test，同时交付PRODUCT_SHELL_BIN与npm_config_script_shell；缺失、链接、错版本、错流程回执或测试失败立即阻断。这次远端接线尚未执行真实Ubuntu编译或完整CI/Release验收，前述历史测试结果不代表本次验证。


## 2026-10-06 产品自主资源阶段（第2步）

本仓`scripts/resources.mjs`拥有工具准确来源/版本/配方、递归锁解析、缺失获取、验真、复用和本轮依赖准备；`scripts/build.mjs resources <platform> --work <绝对外部工作根>`调用同一实现，独立入口为`resources.mjs <platform> --work <工作根> [--offline]`。前者从stdin读取公开身份回执；后者允许空请求。最小宿主必须使用本仓声明的官方Node25.2.1绝对入口，本机配方限定macOS ARM；资源阶段回读官方发行归档与运行Node字节，不能从PATH取同名程序。工作根预先存在、位于源码外且不经过链接。

可选`PRODUCT_TOOL_ROOT`只供读取工具原件，`PRODUCT_DEPENDENCY_ROOT`只供读取依赖原件；产品不读取供给者的版本决策或私有任务变量。独立缺省原件库为源码外`~/.local/share/product-resources`，本轮可写状态仅在work。GNU Bash/grep/sed纳入自身需求；发行件旧Shell仅用于声明中的首次GNU构建，不进入正式PATH。下载/源码工具编译不持全局锁，最终不可变对象提交使用短锁，取消传递到工具进程组。错误摘要、损坏、未锁来源、路径越界和显式离线缺失失败并保留可疑原件。

Pub/npm/Cargo按原始锁准备；Git按固定HTTPS提交检出，Git Cargo目录源展开workspace继承并锁定相对包版本；CocoaPods按准确锁摘要恢复验真快照，缺失spec校验规范摘要，未锁源码来源拒绝取得。Android固定包与修订归产品；额外平台仅消费官方固定发行来源与发行树摘要，不借宿主历史SDK目录。Maven供给只读验真后复制到独占Gradle缓存，由产品准备现有配置，消费仍离线；全库坐标导入与旧目录清理留到第5步。

`PRODUCT_WORK_DIR`、`PRODUCT_BASH_BIN`、`PRODUCT_RSYNC_BIN`及`PRODUCT_SOURCE_DIR`是公开工作/工具/工程入口；Flutter修订不读取调用方私有变量，也不回退系统rsync。旧Flutter补丁对象与当前配方不符时拒绝复用，真实替换须按准确资源操作另行授权。本步不改变编译、签名、安装及回读顺序，不修改产品UI，也未执行真实工具下载/安装。受控资源测试不能代替官方首次取得、正式编译或最终真实运行验收；第4至7步仍待逐步确认实施。

资源原件按完整内容验真后整体提交：Git bundle与固定来源/摘要回执处于同一个不可变对象，不暴露中间状态；可选依赖供给读取`objects/<SHA256>.blob`。锁解析器、源码工具依赖与官方有序补丁也从同一产品原件存储复用。Pod spec每次按锁中的规范checksum回验，Git tag只核对发行声明并消费本产品预锁提交；HTTP发行件消费固定SHA256，首次源码准备命令来自该已验真spec并由GNU Bash执行。spec、准备后源码与文件清单整体提交，再复制到本轮缓存；供给索引不决定产品版本。正式PATH排除旧POSIX Shell，`sh`对应已验真的GNU Bash。

独立缺省资源目录内`tools`保存工具发行件及工具编译输入，`rely`保存产品依赖的归档、Git和Pod原件；工作区只承载本轮可写视图。根据用户最新要求，分步骤先完成实现与用例，整项解耦任务完成后统一测试；本步实施记录不等于真实工具首次取得、完整Build或安装验收通过。

### GNU原件固定镜像获取

本节适用于Cloudflare CI与Release各自check/execute.mjs的正式测试Shell准备入口；两流程保留独立工具对象与回执。

GNU Bash5.3.20、grep3.12、sed4.10与Bash的20份有序补丁保留当前规范官方URL、完整SHA-256和构建配方；每份原件的mirrors闭集依次为https://mirrors.ocf.berkeley.edu/gnu/与https://mirror.csclub.uwaterloo.ca/gnu/下的同一文件路径。主站连接暂时失败或返回404/408/429/5xx时依次切换；响应头等待有固定上限，调用方取消、TLS证书错误、越界跳转、正文错误及摘要漂移立即终止。镜像不能改变版本或绕过完整原件验真，不启用系统工具回退。


### 第3步：产品完整Build入口（2026-10-06）

本产品的正式完整入口为已锁定Node的绝对路径调用`/Users/rhett/citizenserve/scripts/build.mjs execute <platform> --work <已存在绝对工作根>`，可选`--offline`。输入stdin可为空；调用方可传schema/product_id/platform/work及真实run_id/program_digest，禁止私有变量或执行命令。入口内部完成需求→资源→准备→再次需求/资源闭包→编译→适用签名/安装/回读；独立与控制台调用同一实现。最小引导Node只启动本产品的资源引导器，产品按自己的官方Node声明验真、准备并重入，控制台运行Node不决定产品Node版本。

标准输出只有唯一有界JSON：schema、product_id、platform、work、completion、files及可选真实run_id。completion沿用固定平台的device-install/macos-artifact/compile-only；files按本产品flows.json登记路径和SHA256。编译日志使用stderr进入现有任务日志，不新增资源任务或任务状态。完整结果只在各阶段成功、源码/锁不漂移、工具进程确认退出后落入本轮build-result.json；同根并发或复用旧结果拒绝，取消/失联/错误身份/损坏候选不得成功。

控制台每次Build直接读取本产品当前flows.json入口，调用一次execute；控制台只跟踪真实任务、核验公开结果和保存产物，不解释产品工具、依赖、编译参数或设备规则。当前控制台静态菜单、其它产品流程/安装器与程序摘要的历史耦合仍归第4步解除，本步不能当作整项解耦已完成。

本步同步完整入口、失败/取消/并发、结果/路径/摘要及适用移动端用例，但未运行测试、语法检查、编译、签名、安装或工具下载/替换；全部实现步骤完成后统一验收。源码交付与用例存在不代表真实Build已经通过。


### 第4步实施中：远端路由当前声明

CI/Release的规范身份、标题、版本前缀和正式版本记录标志已迁入所属仓现有scripts/flows.json的remote_routes。调用方按固定已接入动作重读当前声明；原生授权与流程查询不再使用编译期产品路由常量。产品声明只提供数据，不授予凭据、扩大平台矩阵或新增按钮。损坏、重复、越仓、字段越界及超限拒绝。

本次同步路线读取、热更新和失败边界用例，未运行测试、语法检查、编译、签名、安装或下载。第4步仍在开发中：Publish执行器、聊天安装器、Start、固定菜单声明与完整程序摘要的其余实际耦合尚未解除，不能报告该步或整项任务完成。

### 产品远端完整入口

本仓`scripts/flows.json`的`flow_entry`定位公开`scripts/flow.mjs`。`run ci <platform>`和`run release <platform>`分别执行同一产品流程，当前读取本仓Workflow与路由；Release的`version_source`声明准确版本文件类型和相对路径。成功CI选择、同源候选复用、版本递增、正式Release验真与旧Run/Artifact清理均由本产品入口完成。独立执行只需等价的本仓短期GitHub权限；没有宿主控制管道时入口自行跟踪Run，不依赖其它产品程序。

可选`PRODUCT_CONTROL_FD=3`只接受当前Run绑定确认、候选持久化确认和二值远端终态；令牌仅进入HTTPS请求头，未知身份、越仓、无成功CI、候选错源、控制帧错误、超时或取消均失败。宿主重启后的`recover`使用同一公开入口核验原Run、原候选并清理，不重新派发。公开控制协议不携带私有调用方变量，现有授权及用户操作顺序保持。源码、声明或Workflow在本次流程期间变化将拒绝继续。

相关正常、失败、身份、版本来源、独立远端跟踪、候选重试和真实控制管道边界用例位于本仓`scripts/flow.test.mjs`；当前只完善源码，尚未运行用例或远端操作。


### 产品软件记录与正式版本恢复

本仓公开`scripts/flow.mjs records`使用准确同仓短期GitHub权限，重读本仓当前路由，复用远端流程同一Run保留器并确认实际删除，再读取各平台最新正式版本。来源合同归本仓release.record_source：按实际产品选择Tag、单包正文或正式元数据资产验真，标题、版本、源码与适用不可变标志不能由调用方推测。准确元数据资产仅经官方HTTPS地址读取，跨主机不转发仓库令牌。正式资产和Tag不会在记录刷新中删除。公开结果仍是records/removed_run_ids，原记录页行为保持。

`recover`不重新派发；重新核验原候选、成功CI、原Run终态、正式资产来源与Tag，输出formal_release/removed_run_ids。控制调用方仅绑定原任务身份、原候选和产品公开回执，更新现有持久发布目标；产品验真算法不再随调用方程序编译。相关正常、失败、错资产/正文/来源、重定向隔离、独立记录刷新和恢复用例源码归本仓flow.test.mjs。

资源工具取消、超时、输出超限和异常收尾均等待主进程与整个后代组退出；无法确认退出时保留工作根和候选，禁止删除输入或改为可写。真实取消退出顺序用例仅写入resources.test.mjs，尚未执行。


### 发布实现范围

本轮新增产品发布实现已撤销，发布功能由后续逐个产品重建。现有操作入口与界面保留，当前不提供已删除实现的执行保证；Build、CI、Release和Start继续按各自现有入口运行。


### 产品独立资源与唯一依赖供给

本产品的scripts/resources.mjs拥有资源解析、来源与摘要验证、缺件取得、可写视图和失败条件。PRODUCT_DEPENDENCY_ROOT是可选只读供给；没有供给时使用源码外的本产品原件存储，产品需求仍只由当前源码、声明和锁决定。依赖索引读取仅接受schema_version=2及packages、git_sources、pods，不恢复旧目录或整锁快照。

Maven的具体JAR、AAR、POM、module及分类器文件统一由packages的group:artifact、version、准确上游URL、SHA256和SRI定位objects中的原件。产品在本轮work/dependencies/maven按上游分区复制独占文件；不复制Gradle二进制元数据、锁和下载状态。产品生成本轮GRADLE_USER_HOME/init.d初始化脚本，只在自身已声明的同源仓库之前加入本轮原件视图，缺件仍按产品原仓库解析，明确离线则失败。Gradle解析、工程状态和后续编译都属于同一产品任务。

Pod由pods中的name、version、checksum匹配当前Podfile.lock；spec保存官方CDN地址和原件摘要，source保存官方podspec来源，files保存发布树相对路径、文件内容摘要与权限或安全内部链接。只物化本产品所需的单个发布坐标；其它Pod、整锁、平台或宿主变化不要求复制全树。产品仍按CocoaPods官方规范回验SPEC CHECKSUMS，再验证本产品预锁定Git提交或HTTP发行摘要与源码回执。可写缓存和工具VERSION仅在本轮work产生，不能写回共享原件。

错来源、摘要、重复同源内容、生成状态、硬链接、内部链接越界或循环、取消及任务副本漂移均据实失败。独立与控制台调用使用同一实现；控制台只提供可选原件并跟踪原有任务，UI、功能、按钮、平台与操作顺序保持。用例源码已同步，执行留待整项实现结束后的统一测试。


### 独立入口回归验真边界

资源回归使用自带固定提交、源码字节和spec的合成Pod，不借用产品真实Pod清单提供测试输入；无真实Pod需求的平台也验证来源、摘要、链接、循环、取消和物化失败。测试现场仍位于本产品target的准确平台，不写源码或其它产品目录。资源声明与生产依赖坐标不因测试夹具改变。

资源取消对同一真实进程组每轮只发送一次信号；组不存在或Windows时才发送给主进程。仍等待主进程和后代实际退出，8秒未退出才强杀，12秒仍未确认则保留现场并失败；取消不能成为成功。


本产品scripts/build.mjs的模块初始化与CLI执行分离：私有异步runCLI承载原命令主体，仅在直接执行文件时启动，拒绝时输出错误并以退出码1失败。模块求值先完成，scripts/resources.mjs可反向导入同一checkWork、requirements和平台校验，不复制实现或增加启动入口；普通import不启动CLI。现有公开参数、JSON请求、--offline、锁定Node验真和必要重入、资源/准备/编译/适用签名安装回读步骤以及取消与结果合同保持。离线缺件和非法输入必须真实失败，禁止以未完成顶层await退出替代完整结果。对应真实CLI回归只在自有target测试现场替换资源供给边界，验证反向导入、参数与错误传播，不据此声称实际产品编译通过。


本产品scripts/resources.mjs的普通inventory清单保持独占文件要求；工具原件toolInventory复用同一扫描实现，只允许全部真实名称均位于同一规范payload内的硬链接组。扫描按dev/ino分组，实际名称数量必须与nlink闭合；工具普通文件以O_NOFOLLOW打开，打开及读取后复验身份、计数、权限和字节相关元数据，扫描结束再回读全部目录、文件及链接身份与规范目标。原件外额外名称、目录或链接越界、特殊项、读取期间替换/权限/内容变化均失败。清单仍逐路径保留原有path/sha256/executable或directory/target格式，继续由既有回执、准确官方归档/版本、配方和编译输入证明验真；regular与其它资源默认独占校验不放宽。不新增公开命令、参数、声明字段或原件登记，不改版本、锁、配方和工具原件，不以拆分内部链接、重新安装或下载解决验真。回归复制本仓完整实现到所属target测试现场，仅替换文件IO边界以确定性制造读取变化，并在夹具内暴露已有私有验真函数；纯合成对象覆盖正常、拒绝与回执漂移，不据此宣称真实工具或产品编译通过。


本产品资源验真将下载运输元数据与源码工具编译身份分开：仅在源码工具证明和本产品声明的比较副本中，验证并移除archive.mirrors与upstream_patches各项mirrors。镜像须为非空、无重复、无控制字符/空白、无账号/口令/片段的准确规范HTTPS地址数组；错误格式直接失败。官方来源URL、版本、归档字节摘要、kind/root/executable、补丁来源/摘要/顺序、前置与依赖闭包、其它位置同名字段及未知字段继续严格比较。Xcode/POSIX输入、recipe.source和source.archive/source.gem摘要、原回执清单及入口独占规则不变；比较不改写原证明、声明或回执，不改变原件/登记/配方/版本/锁和实际下载策略，不读取控制台登记作为产品版本或策略来源。既有回归使用完整本仓资源实现及纯合成物理证明，逐次重算清单，验证运输差异可复用与真正输入漂移必须失败；测试不启动工具或冒充真实编译交付。


本仓平台命名门禁仍扫描完整Git跟踪路径和正文，仅在内存副本识别scripts/resources.mjs中唯一规范的toolDefinitions与flutterPatch声明。规范JSON回读及唯一工具身份阻断重复键、转义、歧义和重复声明；使用Flutter时核验准确官方来源、版本对应归档和本仓补丁来源与全文摘要，未使用Flutter时只接受已核实固定来源与全文SHA-256的共同原补丁。仅处理官方native_assets_host.dart中与准确文件头、行号、lipoDylibs签名及紧邻调用同时闭合的一行原上下文注释，其它新增、删除、上下文、源码和路径的旧平台名称继续拒绝；实际资源源码、补丁、版本、锁和原件不变。目录边界回归以unlinkSync删除自身合成目录符号链接，继续完整验证根target普通目录可用、嵌套target/目录链接/普通文件拒绝；生产目录边界规则不变。回归使用本仓真实门禁与完整Git跟踪合成文件，只在本产品准确target测试现场运行，不将扫描夹具作为真实产品编译或发布证据。

本仓门禁的测试子进程白名单仅保留已有PRODUCT_GIT_BIN准确执行器路径，供完整Git索引夹具使用；缺少该准确入口时回归失败，不查询PATH、不回退系统Git、不传凭据或其它产品材料。不新增工具版本、声明字段、公开参数或生产资源获取步骤。
