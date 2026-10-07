import {createHash} from 'node:crypto';

// 四份测试真源锁定同一公开链提交与逐文件摘要；源码树不保存链副本或兄弟仓路径。
export const chainSourceSHA='f66f137c880b166eaa5e45a7665c7dc4ab1cd868';
const sources=Object.freeze({
  "runtime/public/legislation-yuan/src/constitution.scale": {
    "size": 226569,
    "sha256": "08de3d01cbed3152093f39b232489723db325eef297fc9de8ea0db7c65585d49"
  },
  "runtime/primitives/tests/fixtures/scale_codec_vectors.json": {
    "size": 2549,
    "sha256": "d3127e2b87619ffe086815e4fe0197119ff140bf3f6e3de979f4800dfed08b31"
  },
  "runtime/primitives/tests/fixtures/signing_domain_vectors.json": {
    "size": 4208,
    "sha256": "e99a31c4abceda2804eda727e049d2a3dbad272845c6b4f3a769438b200373fd"
  },
  "runtime/misc/citizen-identity/src/lib.rs": {
    "size": 112525,
    "sha256": "6b741ffde886f425d67ed24510a9f0c20bb70f18349883a717313f4b441112e7"
  }
});
export const chainSourcePaths=Object.freeze(Object.keys(sources));

export async function readChainSource(path, request=fetch) {
  const expected=Object.hasOwn(sources,path)&&sources[path];
  if(!expected)throw Error('CitizenServe链真源坐标无效');
  const url='https://raw.githubusercontent.com/crcfrcn/citizenchain/'+chainSourceSHA+'/'+path;
  const response=await request(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000)});
  if(!response.ok||!response.body)throw Error('CitizenServe链真源读取失败');
  const chunks=[];let size=0;
  for await(const chunk of response.body) {
    size+=chunk.length;
    if(size>expected.size)throw Error('CitizenServe链真源大小不符');
    chunks.push(chunk);
  }
  const bytes=Buffer.concat(chunks);
  if(size!==expected.size||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error('CitizenServe链真源摘要不符');
  return bytes;
}
