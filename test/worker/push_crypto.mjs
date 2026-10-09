// 本地即时测试密钥；不读取生产秘密，也不把测试私钥写入文件或日志。
import {generateKeyPairSync,verify,sign} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
export function testKeys(){
 const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
 return {ec,rsa,apns:ec.privateKey.export({format:'pem',type:'pkcs8'}),fcm:rsa.privateKey.export({format:'pem',type:'pkcs8'})};
}
export function verifyJwt(jwt,key,alg){
 const parts=jwt.split('.');assert.equal(parts.length,3);
 const header=JSON.parse(Buffer.from(parts[0],'base64url'));
 assert.equal(header.alg,alg);
 assert.ok(verify('sha256',Buffer.from(parts.slice(0,2).join('.')),alg==='ES256'?{key,dsaEncoding:'ieee-p1363'}:key,Buffer.from(parts[2],'base64url')),'actual Rust WebCrypto JWT signature');
 return {header,claims:JSON.parse(Buffer.from(parts[1],'base64url'))};
}
if(import.meta.url===pathToFileURL(process.argv[1]).href) test('independent verifier rejects altered JWT and wrong public key',()=>{
 const {ec}=testKeys();const unsigned=[{alg:'ES256'},{iss:'test'}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');const jwt=unsigned+'.'+sign('sha256',Buffer.from(unsigned),{key:ec.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');verifyJwt(jwt,ec.publicKey,'ES256');assert.throws(()=>verifyJwt(jwt.replace(jwt.split('.')[1],Buffer.from('{"iss":"forged"}').toString('base64url')),ec.publicKey,'ES256'));assert.throws(()=>verifyJwt(jwt,testKeys().ec.publicKey,'ES256'));
});
