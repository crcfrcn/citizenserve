// Linux ARM Release预留；正式流程尚未实现，调用必须失败。
import {fileURLToPath} from 'node:url';
export async function main() {
  throw new Error('公民服务端 Linux ARM Release尚未实现');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
