// 公民服务端运行、发布及控制台接入共用的配置需求；这里不保存任何配置值。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const descriptions={CHAIN_URL:'公民链受保护服务HTTPS根地址',ZONE_ID:'广场公开媒体所属Cloudflare Zone编号',
  APNS_KID:'Apple推送Key ID',APNS_TEAM:'Apple开发者Team ID',APNS_TOPIC:'Apple推送Topic',
  FCM_EMAIL:'Firebase服务账户邮箱',FCM_PROJECT:'Firebase项目编号',TATACHAT_AUTH_KID:'聊天授权密钥标识',
  HASH_KEY:'敏感索引HMAC密钥',TURNSTILE_SECRET:'Turnstile服务端校验密钥',CF_ACCESS_CLIENT_ID:'Cloudflare Access客户端ID',
  CHAIN_SECRET:'公民链Access服务身份密钥',R2_KEY:'媒体桶上传Access Key ID',R2_SECRET:'媒体桶上传Secret Key',
  PURGE:'媒体精确URL缓存清理令牌',TOPUP_INTENT_SECRET:'充值付款意图HMAC密钥',SETTLE_TOKEN:'结算令牌',
  CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET:'公民链下载发布指针HMAC密钥',APNS_KEY:'Apple推送私钥',
  FCM_KEY:'Firebase服务账户私钥',TATACHAT_AUTH_KEY:'聊天授权签发密钥'};
const names=(values,access,kind,format)=>values.map(name=>({
  environment:'production',name,title:name==='CF_ACCESS_CLIENT_ID'?'Cloudflare Access ID':name,
  description:descriptions[name]??name,revealable:access!=='publish',
  accessLevel:access,kind,...(format?.[name]?{format:format[name]}:{})
}));
const publicFormats={CHAIN_URL:'https_root_url:chain.crcfrcn.com',CF_ACCESS_CLIENT_ID:'cloudflare_access_client_id',ZONE_ID:'hex16',APNS_KID:'apple_id',APNS_TEAM:'apple_id',
  APNS_TOPIC:'apns_topic',FCM_EMAIL:'fcm_email',FCM_PROJECT:'fcm_project',TATACHAT_AUTH_KID:'auth_kid'};
export const dynamicPublicNames=Object.freeze(['CHAIN_URL','CF_ACCESS_CLIENT_ID','ZONE_ID','APNS_KID','APNS_TEAM','APNS_TOPIC','FCM_EMAIL','FCM_PROJECT','TATACHAT_AUTH_KID']);
export const workerSecretNames=Object.freeze(['HASH_KEY','TURNSTILE_SECRET','CHAIN_SECRET','R2_KEY','R2_SECRET','PURGE',
  'TOPUP_INTENT_SECRET','SETTLE_TOKEN','CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET','APNS_KEY','FCM_KEY','TATACHAT_AUTH_KEY']);
export const resourceBindings=Object.freeze(['DB','CITIZENCHAIN_DOWNLOAD_DB','TATACHAT_DB','RATE_AUTH','RATE_READ','RATE_WRITE',
  'SQUARE_PRIVATE','SQUARE_PUBLIC_MEDIA','TATACHAT_ATTACHMENTS','SQUARE_CACHE','NOTIFY','TATACHAT_PUSH','TATACHAT_DEVICES']);
export function validateDynamicPublic(values){
  if(!values||typeof values!=='object'||Array.isArray(values)
    ||Object.keys(values).sort().join('\0')!==[...dynamicPublicNames].sort().join('\0'))throw Error('公开运行变量缺失或越界');
  for(const name of dynamicPublicNames){
    const value=values[name],format=publicFormats[name];
    if(typeof value!=='string'||!value||value.length>512||/[\x00-\x1f\x7f]/u.test(value))throw Error('公开运行变量无效：'+name);
    let valid=false;
    if(format.startsWith('https_root_url:')){
      try{const url=new URL(value);valid=url.protocol==='https:'&&url.hostname===format.slice(15)
        &&!url.username&&!url.password&&!url.hash&&!url.search&&url.pathname==='/'&&!url.port;}catch{}
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
  {environment:'cloudflare',name:'SERVER_DEPLOY',title:'SERVER_DEPLOY',description:'Worker、Route与D1部署令牌',revealable:false,accessLevel:'publish',kind:'operation'},
  {environment:'cloudflare',name:'KV',title:'KV',description:'会员镜像对账Workers KV令牌',revealable:true,accessLevel:'protected',kind:'operation'},
  {environment:'production',name:'CF_ACCOUNT_ID',title:'CF_ACCOUNT_ID',description:'Cloudflare账户编号',revealable:true,accessLevel:'public',kind:'account',format:'hex16'},
  ...names(dynamicPublicNames,'public','runtime',publicFormats),
  ...names(workerSecretNames,'protected','worker_secret',{CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET:'hex32'}),
].map(item=>item.name==='CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET'?
  {...item,revealable:false,accessLevel:'publish',generator:'hex32'}:
  item.name==='TATACHAT_AUTH_KEY'?{...item,revealable:false}:item);

function configuredNames(source){
  const section=/\[vars\]([^[]*)/u.exec(source)?.[1];
  const vars=[...(section??'').matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gmu)].map(match=>match[1]);
  const secrets=/^required\s*=\s*(\[[^\n]+\])/mu.exec(source)?.[1];
  if(!section||!secrets)throw Error('公民服务端Wrangler配置声明缺失');
  return {vars,secrets:JSON.parse(secrets)};
}
export function describeConfiguration(){
  const source=readFileSync(fileURLToPath(new URL('../server/cloudflare/wrangler.toml',import.meta.url)),'utf8');
  const declared=configuredNames(source),secrets=new Set(workerSecretNames);
  if(declared.secrets.length!==secrets.size||declared.secrets.some(name=>!secrets.has(name))
    ||dynamicPublicNames.some(name=>!declared.vars.includes(name))
    ||resourceBindings.some(name=>!source.includes('"'+name+'"')))throw Error('公民服务端运行配置与所属声明不一致');
  const itemNames=new Set(items.map(item=>item.name));
  const fixed=[...declared.vars.filter(name=>!itemNames.has(name)).map(name=>({name,kind:'fixed',source:'wrangler.vars'})),
    ...resourceBindings.map(name=>({name,environment:'cloudflare',kind:'binding',source:'wrangler.resource'}))];
  return {schema:1,product_id:'citizenserve',configuration:{id:'citizenserve',kind:'cloud',title:'服务端配置',items},fixed};
}
