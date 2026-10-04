import { isAbsolute, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 测试生成物写入CitizenServe命名的源码外目录；普通开发者和CI使用同一入口。
const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configuredCache = process.env.CITIZENSERVE_TEST_WORK_DIR
  || resolve(tmpdir(), 'citizenserve', 'test');
const cache = resolve(configuredCache);
if (!isAbsolute(configuredCache) || resolve(cache) !== cache
  || cache === projectRoot || cache.startsWith(projectRoot + sep)) {
  throw new Error('CITIZENSERVE_TEST_WORK_DIR必须是CitizenServe源码外的绝对路径');
}

export default {
  root: projectRoot,
  cacheDir: resolve(cache, 'vitest'),
  test: {
    environment: 'node',
    globals: true,
    coverage: { reportsDirectory: resolve(cache, 'vitest/coverage') }
  }
};
