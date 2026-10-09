import {withFixedWork,withFixedWorkSync,claimFixedWork,releaseFixedWork} from '../target.mjs';
// Linux ARM CI预留；正式流程尚未实现，调用必须失败。
import {fileURLToPath} from 'node:url';
export async function main(){return withFixedWork('build',()=>mainTask(),{retain:process.env.GITHUB_ACTIONS==='true'});}
async function mainTask(){
  throw new Error('公民服务端 Linux ARM CI尚未实现');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
