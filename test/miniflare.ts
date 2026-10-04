import { Miniflare, type MiniflareOptions } from 'miniflare';

const TEST_WORKER_NAME = 'citizenserve-test';
const TEST_WORKER_MODULE = 'citizenserve-test.mjs';
const TEST_WORKER_SOURCE =
  'export default { fetch() { return new Response("test"); } }';

type TestBinding =
  | { type: 'text'; value: string }
  | { type: 'd1'; id: string }
  | { type: 'kv'; id: string }
  | { type: 'r2'; name: string };

interface TestMiniflareOptions {
  d1Bindings?: readonly string[];
  kvBindings?: readonly string[];
  r2Bindings?: readonly string[];
  textBindings?: Readonly<Record<string, string>>;
}

/**
 * 以 Miniflare 5 的原生 workers 配置创建 CitizenServe 测试运行时。
 * 所有资源 binding 都集中在 Worker 的 config.env 中，避免测试继续使用已移除的 v4 顶层选项。
 */
export function createTestMiniflare(
  options: TestMiniflareOptions = {},
): Miniflare {
  const env: Record<string, TestBinding> = {};

  for (const name of options.d1Bindings ?? []) {
    env[name] = { type: 'd1', id: name };
  }
  for (const name of options.kvBindings ?? []) {
    env[name] = { type: 'kv', id: name };
  }
  for (const name of options.r2Bindings ?? []) {
    env[name] = { type: 'r2', name };
  }
  for (const [name, value] of Object.entries(options.textBindings ?? {})) {
    env[name] = { type: 'text', value };
  }

  const rootPath = process.cwd();
  const miniflareOptions = {
    logRequests: false,
    stripDisablePrettyError: true,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          type: 'worker',
          name: TEST_WORKER_NAME,
          compatibilityDate: '2026-07-29',
          manifest: {
            mainModule: TEST_WORKER_MODULE,
            modulesRoot: rootPath,
            modules: {
              [TEST_WORKER_MODULE]: {
                type: 'esm',
                contents: TEST_WORKER_SOURCE,
              },
            },
          },
          env,
          exports: {},
        },
        dev: {
          rootPath,
          unsafeRegisterWorker: true,
          stripCfConnectingIp: true,
        },
      },
    ],
  } satisfies MiniflareOptions;

  return new Miniflare(miniflareOptions);
}
