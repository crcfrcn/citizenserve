// 公民服务端运行、发布及控制台接入共用的配置需求；这里不保存任何配置值。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const descriptions={CHAIN_URL:'公民链Access保护RPC HTTPS根地址',ZONE_ID:'广场公开媒体所属Cloudflare Zone编号',
  APNS_KID:'Apple推送Key ID',APNS_TEAM:'Apple开发者Team ID',APNS_TOPIC:'Apple推送Topic',
  FCM_EMAIL:'Firebase服务账户邮箱',FCM_PROJECT:'Firebase项目编号',TATACHAT_AUTH_KID:'聊天授权密钥标识',
  HASH_KEY:'敏感索引HMAC密钥',TURNSTILE_SECRET:'Turnstile服务端校验密钥',CF_ACCESS_CLIENT_ID:'Cloudflare Access客户端ID',
  CHAIN_SECRET:'公民链Access服务身份密钥',R2_KEY:'媒体桶上传Access Key ID',R2_SECRET:'媒体桶上传Secret Key',
  PURGE:'媒体精确URL缓存清理令牌',TOPUP_RPCS:'五条付款主网HTTPS RPC JSON',TOPUP_RECEIVERS:'EVM、Tron、Solana公开收款地址JSON',TOPUP_DISBURSE_KEY:'服务端GMB发币sr25519种子',TOPUP_INTENT_SECRET:'充值付款意图HMAC密钥',SETTLE_TOKEN:'结算令牌',
  APNS_KEY:'Apple推送私钥',
  FCM_KEY:'Firebase服务账户私钥',TATACHAT_AUTH_KEY:'聊天授权签发密钥'};
const names=(values,access,kind,format)=>values.map(name=>({
  environment:'production',name,title:name==='CF_ACCESS_CLIENT_ID'?'Cloudflare Access ID':name,
  description:descriptions[name]??name,revealable:true,
  accessLevel:access,kind,...(format?.[name]?{format:format[name]}:{})
}));
const publicFormats={CHAIN_URL:'https_root_url:chain.crcfrcn.com',CF_ACCESS_CLIENT_ID:'cloudflare_access_client_id',ZONE_ID:'hex16',APNS_KID:'apple_id',APNS_TEAM:'apple_id',
  APNS_TOPIC:'apns_topic',FCM_EMAIL:'fcm_email',FCM_PROJECT:'fcm_project',TATACHAT_AUTH_KID:'auth_kid',TOPUP_RPCS:'topup_rpcs',TOPUP_RECEIVERS:'topup_receivers'};
export const dynamicPublicNames=Object.freeze(['CHAIN_URL','CF_ACCESS_CLIENT_ID','ZONE_ID','APNS_KID','APNS_TEAM','APNS_TOPIC','FCM_EMAIL','FCM_PROJECT','TATACHAT_AUTH_KID','TOPUP_RPCS','TOPUP_RECEIVERS']);
export const workerSecretNames=Object.freeze(['HASH_KEY','TURNSTILE_SECRET','CHAIN_SECRET','R2_KEY','R2_SECRET','PURGE',
  'TOPUP_INTENT_SECRET','TOPUP_DISBURSE_KEY','SETTLE_TOKEN','APNS_KEY','FCM_KEY','TATACHAT_AUTH_KEY']);
export const resourceBindings=Object.freeze(['DB','TATACHAT_DB','RATE_AUTH','RATE_READ','RATE_WRITE',
  'SQUARE_PRIVATE','SQUARE_PUBLIC_MEDIA','TATACHAT_ATTACHMENTS','SQUARE_CACHE','NOTIFY','TATACHAT_PUSH','TATACHAT_DEVICES']);
export function validateDynamicPublic(values){
  if(!values||typeof values!=='object'||Array.isArray(values)
    ||Object.keys(values).sort().join('\0')!==[...dynamicPublicNames].sort().join('\0'))throw Error('公开运行变量缺失或越界');
  for(const name of dynamicPublicNames){
    const value=values[name],format=publicFormats[name];
    if(typeof value!=='string'||!value||value.length>(name.startsWith('TOPUP_')?8192:512)||/[\x00-\x1f\x7f]/u.test(value))throw Error('公开运行变量无效：'+name);
    let valid=false;
    if(format==='topup_rpcs'||format==='topup_receivers'){
      try{const v=JSON.parse(value),keys=format==='topup_rpcs'?['base','bnb','ethereum','solana','tron']:['evm','solana','tron'];
        valid=v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.join()&&Object.values(v).every(s=>typeof s==='string'&&s.length>0&&s.length<1024);
        if(valid&&format==='topup_rpcs')valid=Object.values(v).every(s=>{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;});
        if(valid&&format==='topup_receivers')valid=/^0x[0-9a-f]{40}$/u.test(v.evm)&&/^T[1-9A-HJ-NP-Za-km-z]{33}$/u.test(v.tron)&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(v.solana);
      }catch{}
    }else if(format.startsWith('https_root_url:')){
      try{const host=format.slice('https_root_url:'.length),url=new URL(value);
        valid=url.protocol==='https:'&&url.hostname===host&&url.pathname==='/'
          &&value==='https://'+host+'/'&&!url.username&&!url.password&&!url.hash&&!url.search&&!url.port;}catch{}
    }else if(format==='hex16')valid=/^[a-f0-9]{32}$/u.test(value);
    else if(format==='apple_id')valid=/^[A-Za-z0-9]{10}$/u.test(value);
    else if(format==='apns_topic')valid=/^[A-Za-z0-9.-]{1,255}$/u.test(value);
    else if(format==='fcm_email')valid=/^[^@\s]{1,128}@[^@\s]{1,128}\.iam\.gserviceaccount\.com$/u.test(value);
    else if(format==='fcm_project')valid=/^[a-z0-9-]{3,128}$/u.test(value);
    else if(format==='auth_kid')valid=/^[A-Za-z0-9_-]{1,64}$/u.test(value);
    else if(format==='cloudflare_access_client_id')valid=/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u.test(value);
    if(!valid)throw Error('公开运行变量格式无效：'+name);
  }
  return Object.freeze(Object.fromEntries(dynamicPublicNames.map(name=>[name,values[name]])));
}
const items=[
  {environment:'cloudflare',name:'SERVER_DEPLOY',title:'SERVER_DEPLOY',description:'Worker、Route与D1部署令牌',revealable:false,accessLevel:'protected',kind:'operation'},
  {environment:'cloudflare',name:'KV',title:'KV',description:'会员镜像对账Workers KV令牌',revealable:true,accessLevel:'protected',kind:'operation'},
  {environment:'citizenserve-approval',name:'COLD_SIGNER_PUBLIC_KEY',title:'发布冷签公钥',description:'仅用于公民服务端正式发布批准验签',revealable:true,accessLevel:'protected',kind:'authorization',format:'hex32'},
  ...names(dynamicPublicNames,'public','runtime',publicFormats),
  ...names(workerSecretNames,'protected','worker_secret'),
].map(item=>item.name==='TOPUP_DISBURSE_KEY'?{...item,revealable:false,format:'sr25519_seed32_hex'}:item.name==='TATACHAT_AUTH_KEY'?{...item,revealable:false,format:'ed25519_pkcs8_pem',generator:'ed25519_pkcs8_pem'}:
  item.name==='TATACHAT_AUTH_KID'?{...item,generator:'auth_kid'}:item);

function configuredNames(source){
  const section=/\[vars\]([^[]*)/u.exec(source)?.[1];
  const vars=[...(section??'').matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gmu)].map(match=>match[1]);
  const secrets=/^required\s*=\s*(\[[^\n]+\])/mu.exec(source)?.[1];
  if(!section||!secrets)throw Error('公民服务端Wrangler配置声明缺失');
  return {vars,secrets:JSON.parse(secrets)};
}
export function describeConfiguration(){
  const source=readFileSync(fileURLToPath(new URL('../cloudflare/wrangler.toml',import.meta.url)),'utf8');
  const declared=configuredNames(source),secrets=new Set(workerSecretNames);
  if(declared.secrets.length!==secrets.size||declared.secrets.some(name=>!secrets.has(name))
    ||dynamicPublicNames.some(name=>!declared.vars.includes(name))
    ||resourceBindings.some(name=>!source.includes('"'+name+'"')))throw Error('公民服务端运行配置与所属声明不一致');
  return {schema:1,product_id:'citizenserve',configuration:{id:'citizenserve',kind:'cloud',title:'服务端配置',items}};
}

// 管理坐标由服务端自身公开声明给出；调用方不解析本产品内部配置或另存一套目标。
export function describeTopup(){
  const source=readFileSync(new URL('../cloudflare/wrangler.toml',import.meta.url),'utf8');
  const field=name=>new RegExp('^'+name+' = "([^"]+)"$','m').exec(source)?.[1];
  const origin=field('WEB_ORIGIN'),account=field('CF_ACCOUNT_ID'),script=field('name');
  if(!origin||new URL(origin).origin!==origin||!origin.startsWith('https://')||!/^[a-f0-9]{32}$/.test(account||'')||!script)throw Error('充值管理坐标无效');
  const configuration=describeConfiguration().configuration.items.filter(i=>['TOPUP_DISBURSE_KEY','SETTLE_TOKEN','SERVER_DEPLOY'].includes(i.name));
  if(configuration.length!==3||configuration.some(i=>i.accessLevel!=='protected'))throw Error('充值管理声明无效');
  return {schema:1,product_id:'citizenserve',origin,account_id:account,script_name:script,history_path:'/api/topup/settlement/history',account_path:'/api/topup/account',configuration};
}

// 编译和工作流共用所属产品的工具、协议与正式包声明。
export const repository='crcfrcn/citizenserve';
export const tools=Object.freeze({node:'25.2.1',rust:'1.97.1',protoc:'35.0',worker:'0.8.5',bindgen:'0.2.127',binaryen:'130'});
export const protocol=Object.freeze({repository:'tuyutata/tatachatsdk',commit:'b0485cf0a2c0922791741a748fdec0a49003089f'});
const cargo=readFileSync(new URL('../Cargo.toml',import.meta.url),'utf8');
export const releaseMembers=Object.freeze(JSON.parse(/^release_members = '''([^']+)'''/mu.exec(cargo)[1]));
export function automationDisplayName(platform,version){if(platform!=='cloudflare'||typeof version!=='string'||version.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version))throw Error('服务端平台或版本无效');return '公民服务端·Cloudflare·v'+version;}
export function releaseIdentity(){return {prefix:'公民服务端·Cloudflare·v'};}
// 首次采用准确显示名时承接已核实正式版本v1.0.14，候选为v1.0.15；Rust包与原锁身份不变。
export const initialVersion='1.0.15';

// 本产品Workflow坐标声明。
export const workflows=Object.freeze({"cloudflare":"cloudflare.yml"});

// 只返回声明数据；派发与观察归通用调用方，版本及交付归本仓YAML。
export function describeAction({flow,platform,inputs={}}){
 const workflow=workflows[platform];
 if(flow==='release'&&workflow)return {repository:"crcfrcn/citizenserve",workflow,ref:'main',inputs};
 throw Error('本产品未声明该流程：'+flow+'·'+platform);
}
