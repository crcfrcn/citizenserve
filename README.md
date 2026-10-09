# CitizenServe

公民App的Rust服务端。业务模块位于产品根目录：tatachat、chain、user、8964、membership、topup、notifications、downloads、server和shared。根目录没有业务src聚合目录。

第1至第6步已完成授权/MLS设备与会话、资料/通讯录密文同步、社区/会员/媒体、稳定币充值/完整结算、正式下载/发布HMAC、链工具和独立公共RPC，以及普通推送、持久Queue任务、Cron投影和存储维护。第7步宿主阶段已完成，新增POST https://www.crcfrcn.com/api/tatachat/access；八授权、33账户业务和28项工具API使用准确/api路径；账户服务必须通过当前CID/真人准入/设备/会话与新鲜MLS证明。永久财务claim与不确定广播不会自动释放重发。

177项Rust、127项真实SQLite、17项本地Worker/密码学测试及fmt/Clippy通过。完整worker-build ESM/WASM已在本地workerd运行fetch/queue/scheduled，主库36表、独立下载库1表。外部链/推送请求均由测试拦截；线上Worker/链/D1/R2/Siteverify、推送和支付尚未验收。锁定的本地workerd支持到2026-08-11，生产配置2026-10-07未在相同兼容日期验收。聊天数据面、App及正式CI/发布仍待后续，health为account_services_ready:false。

注册顺序固定：点击确认注册→Cloudflare→CitizenServe保存通过结果→原钱包签名/上链/finalized完成CID注册→MLS设备授权激活→账户服务；没有候选CID，没有重复验证，MLS私钥留在设备。App编排在第8步接入。

```sh
cd /Users/rhett/citizenserve
sh scripts/check.sh
```

完整检查入口为[check.sh](/Users/rhett/citizenserve/scripts/check.sh)。第6步结果与第7步已确认方案及宿主阶段结果见[CitizenServe.md](/Users/rhett/citizenserve/CitizenServe.md)和[任务卡](/Users/rhett/tataconsole/tasks/塔塔通用验证与公民统一注册.md)，逐项列出文件绝对路径、API、权限及唯一修改方。第7步整体未完成：公民授权已迁回user/membership/server并删除chat；B已写入28件通用核心源码，尚待其协议/Cloudflare交付及A统一编译、数据面验收。Cloudflare聊天适配按用户回复仍由「塔塔聊天」线程交付。WSS/附件路径目前返回404，不能把许可接口成功当作聊天接线完成。

Cloudflare适配留在server/cloudflare；共同业务不引用worker/D1/R2。Wrangler main为[生成入口](/Users/rhett/citizenserve/target/cloudflare/worker/index.js)，由官方工具构建，不能手改生成JS。正式CI/生产发布控制在第8步；实际CHAIN_URL/ZONE_ID及秘密不猜填。未来自建复用业务/逻辑数据合同，当前不实施迁移或自建部署。旧功能/两份SQL/67个源码摘要与删除前Git快照保留在任务卡，旧源码不参与编译。本步未部署、未执行线上DDL或数据操作。
