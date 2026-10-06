import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const projectPath = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);

// 执行真实 Release 入口与 step 0，只在 gh/git 进程边界提供合成响应；不读取真实凭据或访问远端。
function withReleaseSource(run: (execute: (options?: {
  values?: Record<string, string>; ci?: Record<string, unknown>; head?: string;
  releases?: unknown; apiFailure?: boolean; invalidJSON?: boolean; step?: boolean;
}) => { result: ReturnType<typeof spawnSync>; calls: string[][] }) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'citizenserve-release-source-'));
  try {
    const bin = join(directory, 'bin');
    const calls = join(directory, 'calls.jsonl');
    mkdirSync(bin);
    const sha = 'a'.repeat(40);
    const values = {
      'ci-run-id': '123', 'version-tag': 'citizenserve-cloudflare-v1.0.17',
      'source-sha': sha, prefix: 'citizenserve-cloudflare-v',
      'product-id': 'citizenserve', target: 'cloudflare', workflow: 'citizenserve.cloudflare.ci',
    };
    run((options = {}) => {
      writeFileSync(calls, '');
      const ci = { status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
        head_branch: 'main', head_sha: sha, display_title: '公民服务端 · Cloudflare · CI',
        path: '.github/workflows/citizenserve-cloudflare-ci.yml', ...options.ci };
      const releases = options.releases ?? [{ tag_name: 'citizenserve-cloudflare-v1.0.16', draft: false, prerelease: false }];
      // 替身只接受实际需要的只读命令；任何新增调用、错误路径或越界参数都会失败。
      writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(['gh',...args])+'\\n');\nif(${options.apiFailure === true})process.exit(29);\nif(${options.invalidJSON === true}){process.stdout.write('invalid JSON');process.exit(0);}\nif(args.length!==2||args[0]!=='api')process.exit(31);\nconst response=args[1]==='repos/{owner}/{repo}/actions/runs/123'?${JSON.stringify(ci)}:args[1]==='repos/{owner}/{repo}/releases?per_page=100&page=1'?${JSON.stringify(releases)}:null;\nif(response===null)process.exit(32);process.stdout.write(JSON.stringify(response));\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'git'), `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(['git',...args])+'\\n');\nif(JSON.stringify(args)!=='["rev-parse","HEAD"]')process.exit(33);process.stdout.write(${JSON.stringify(options.head ?? sha)}+'\\n');\n`, { mode: 0o755 });
      const current = { ...values, ...options.values };
      const root = projectPath;
      const args = options.step
        ? [join(projectPath, 'scripts/release/cloudflare/check/execute.mjs'), 'workflow-step', '0']
        : [join(projectPath, 'scripts/release/cloudflare/index.mjs'), 'version-tag', 'verify-release-source',
          ...Object.entries(current).flatMap(([key, value]) => [`--${key}`, value])];
      const result = spawnSync(process.execPath, args, {
        cwd: root, encoding: 'utf8', timeout: 15_000,
        env: { PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
          TMPDIR: directory, GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: 'crcfrcn/citizenserve',
          SOURCE_SHA: sha, CI_RUN_ID: '123', SOFTWARE_VERSION: '1.0.17', VERSION_TAG: current['version-tag'],
          GMB_SOURCE_SHA: sha, GMB_CI_RUN_ID: '123', GMB_VERSION_TAG: current['version-tag'] },
      });
      return { result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// 直接执行产品的准确 D1 阶段；含空格的源码外目录用于覆盖 shell 参数边界。
function withD1Project(run: (directory: string, execute: (env?: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'citizenserve d1 '));
  try {
    for (const name of ['scripts', 'schema']) mkdirSync(join(directory, name));
    copyFileSync(join(projectPath, 'package.json'), join(directory, 'package.json'));
    copyFileSync(join(projectPath, 'scripts/wrangler.toml'), join(directory, 'scripts/wrangler.toml'));
    for (const name of ['citizenserve.sql', 'download.sql']) {
      copyFileSync(join(projectPath, 'schema', name), join(directory, 'schema', name));
    }
    symlinkSync(dirname(dirname(require.resolve('wrangler/package.json'))), join(directory, 'node_modules'), 'dir');
    run(directory, (env = {}) => spawnSync(process.execPath, [
      join(projectPath, 'scripts/ci/cloudflare/check/execute.mjs'), 'workflow-step', '8',
    ], {
      cwd: directory,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false',
        GITHUB_REPOSITORY: 'crcfrcn/citizenserve', RUNNER_TEMP: directory, ...env },
      encoding: 'utf8', timeout: 45_000,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// 只读回查真实 Wrangler 创建的本地数据库，避免仅凭退出码判定建表成功。
function localD1Tables(directory: string) {
  const root = join(directory, 'citizenserve-cloudflare-d1');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith('.sqlite')).flatMap((name) => {
    const database = new DatabaseSync(join(root, String(name)), { readOnly: true });
    try {
      return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name));
    } finally {
      database.close();
    }
  });
}

// 在源码外运行真实 npm/Wrangler 生成链；测试不修改产品类型文件，也不伪造生成器输出。
function withTypesProject(run: (directory: string, execute: (script: string) => ReturnType<typeof spawnSync>) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'citizenserve-types-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    copyFileSync(join(projectPath, 'package.json'), join(directory, 'package.json'));
    for (const name of ['wrangler.toml', 'worker-configuration.d.ts', 'check-worker-types.mjs']) {
      copyFileSync(join(projectPath, 'scripts', name), join(directory, 'scripts', name));
    }
    symlinkSync(join(projectPath, 'src'), join(directory, 'src'), 'dir');
    symlinkSync(dirname(dirname(require.resolve('wrangler/package.json'))), join(directory, 'node_modules'), 'dir');
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('类型生成合同测试必须经 npm test 执行');
    run(directory, (script) => spawnSync(process.execPath, [npm, 'run', script], {
      cwd: directory,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      encoding: 'utf8',
      timeout: 30_000,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('CitizenServe产品发布输入', () => {
  test('Release 真实 step 0 接受准确成功 CI 并保留正式版本选择合同', () => {
    withReleaseSource((execute) => {
      const { result, calls } = execute({ step: true });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}`).toContain(`Release 已锁定成功 CI：123 · ${'a'.repeat(40)}`);
      expect(calls).toEqual([
        ['gh', 'api', 'repos/{owner}/{repo}/actions/runs/123'], ['git', 'rev-parse', 'HEAD'],
        ['gh', 'api', 'repos/{owner}/{repo}/releases?per_page=100&page=1'],
      ]);
      // Release 作业会先把包版本写为候选版本；无已发布版本时应使用当前包版本作为种子。
      const seedVersion = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')).version;
      for (const [releases, version] of [
        [[], seedVersion],
        [[{ tag_name: 'citizenserve-cloudflare-v1.0.99' }], '1.1.0'],
        [[{ tag_name: 'citizenserve-cloudflare-v1.99.99' }], '2.0.0'],
        [[{ tag_name: 'citizenserve-cloudflare-v1.0.16' },
          { tag_name: 'citizenserve-cloudflare-v9.0.0', draft: true },
          { tag_name: 'citizenserve-cloudflare-v9.1.0', prerelease: true },
          { tag_name: 'citizenweb-web-v9.0.0' }], '1.0.17'],
      ] as const) {
        const accepted = execute({ releases, values: { 'version-tag': `citizenserve-cloudflare-v${version}` } }).result;
        expect(accepted.status, `${accepted.stderr}`).toBe(0);
      }
      for (const version of ['1.0.16', '1.0.18', '1.0.100']) {
        expect(execute({ values: { 'version-tag': `citizenserve-cloudflare-v${version}` } }).result.status).toBe(1);
      }
    });
  }, 30_000);

  test('Release 来源拒绝旧文件名、错误产品平台及非法输入且不查询远端', () => {
    withReleaseSource((execute) => {
      for (const values of [
        ...['repository.yml', '.github/workflows/repository.yml', 'citizenweb.web.ci',
          'citizenserve.linux-arm.ci', 'citizenserve.cloudflare.release',
          'tata.citizenserve.cloudflare.ci', ''].map((workflow) => ({ workflow })),
        { 'product-id': 'citizenweb' }, { target: 'linux-arm' },
        { prefix: 'citizenweb-web-v', 'version-tag': 'citizenweb-web-v1.0.17' },
        { 'source-sha': 'A'.repeat(40) }, { 'source-sha': 'a'.repeat(39) },
        { 'ci-run-id': '0' }, { 'ci-run-id': '12x' }, { unknown: 'value' },
      ] as Record<string, string>[]) {
        const { result, calls } = execute({ values });
        expect(result.error).toBeUndefined();
        expect(result.status, JSON.stringify(values)).toBe(1);
        expect(calls).toEqual([]);
      }
    });
  }, 30_000);

  test('Release 来源拒绝失败或错身份 CI、错误检出和 API 失败', () => {
    withReleaseSource((execute) => {
      for (const ci of [
        { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
        { event: 'push' }, { head_branch: 'other' }, { head_sha: 'b'.repeat(40) },
        { display_title: '公民聊天服务 · Cloudflare · CI' },
        { path: 'other/repository.yml' }, { path: '.github/workflows/other.yml' }, { path: null },
      ]) {
        const { result, calls } = execute({ ci });
        expect(result.status, JSON.stringify(ci)).toBe(1);
        expect(`${result.stderr}`).toContain('Release 来源不是同产品、同端、同 workflow 的成功 CI');
        expect(calls).toHaveLength(1);
      }
      const wrongHead = execute({ head: 'b'.repeat(40) });
      expect(wrongHead.result.status).toBe(1);
      expect(`${wrongHead.result.stderr}`).toContain('checkout 与 source_sha 不一致');
      expect(wrongHead.calls).toHaveLength(2);
      for (const options of [{ apiFailure: true }, { invalidJSON: true }]) {
        const rejected = execute(options);
        expect(rejected.result.error).toBeUndefined();
        expect(rejected.result.status).toBe(1);
        expect(rejected.calls).toHaveLength(1);
      }
    });
  }, 30_000);

  test('D1 阶段传递完整参数并保留首个失败及旧目录拒绝条件', () => {
    for (const failure of [0, 1, 2]) {
      withD1Project((directory, execute) => {
        const bin = join(directory, 'bin');
        const log = join(directory, 'arguments.jsonl');
        mkdirSync(bin);
        // 仅替换进程边界以观测参数和退出码；真实 Wrangler 建表另有运行态用例。
        writeFileSync(join(bin, 'npm'), `#!${process.execPath}\nimport fs from 'node:fs';\nconst p=${JSON.stringify(log)};\nfs.appendFileSync(p,JSON.stringify(process.argv.slice(2))+'\\n');\nconst count=fs.readFileSync(p,'utf8').trim().split('\\n').length;\nif(count===${failure})process.exit(29);\n`, { mode: 0o755 });
        const env = { PATH: `${bin}${delimiter}${process.env.PATH}` };
        const result = execute(env);
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stderr}`).toBe(failure ? 29 : 0);
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(calls).toEqual([
          ['DB', 'citizenserve.sql'], ['CITIZENCHAIN_DOWNLOAD_DB', 'download.sql'],
        ].slice(0, failure === 1 ? 1 : 2).map(([binding, schema]) => [
          'exec', '--', 'wrangler', 'd1', 'execute', binding, '--config', 'scripts/wrangler.toml', '--local',
          '--persist-to', join(directory, 'citizenserve-cloudflare-d1'), '--file', `schema/${schema}`,
        ]));
        if (!failure) {
          mkdirSync(join(directory, 'migrations'));
          expect(execute(env).status).toBe(1);
          const before = readFileSync(log, 'utf8');
          expect(execute({ ...env, GITHUB_REPOSITORY: 'tuyutata/tatachatserver' }).status).toBe(1);
          expect(readFileSync(log, 'utf8')).toBe(before);
        }
      });
    }
  });

  test('D1 阶段真实执行两份最终 schema 并回读数据表', () => {
    withD1Project((directory, execute) => {
      const result = execute();
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const expected = ['citizenserve.sql', 'download.sql'].flatMap((name) =>
        [...readFileSync(join(projectPath, 'schema', name), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]));
      expect(expected.length).toBeGreaterThan(1);
      expect(localD1Tables(directory)).toEqual(expect.arrayContaining(expected));
    });
  }, 60_000);

  test('D1 阶段真实 SQL 失败会停止后续数据库执行', () => {
    withD1Project((directory, execute) => {
      writeFileSync(join(directory, 'schema/citizenserve.sql'), 'THIS IS INVALID SQL;\n');
      const result = execute();
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/syntax error/i);
      expect(localD1Tables(directory)).not.toContain('citizenchain_download_publications');
    });
  }, 60_000);

  test('真实重复生成保持完整类型和唯一中文职责注释一致', () => {
    withTypesProject((directory, execute) => {
      const types = join(directory, 'scripts/worker-configuration.d.ts');
      const original = readFileSync(types, 'utf8');
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = execute('types:check');
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(readFileSync(types, 'utf8')).toBe(original);
      }
      expect(original.match(/本生成文件把CitizenServe正式Wrangler绑定/g)).toHaveLength(1);
    });
  }, 60_000);

  test('真实字段漂移仍失败且重新生成后恢复一致', () => {
    withTypesProject((directory, execute) => {
      const types = join(directory, 'scripts/worker-configuration.d.ts');
      const original = readFileSync(types, 'utf8');
      expect(original).toContain('CHAT_SERVER_URL: "https://chat.crcfrcn.com"');
      writeFileSync(types, original.replace('CHAT_SERVER_URL: "https://chat.crcfrcn.com"', 'CHAT_SERVER_URL: "https://invalid.example.test"'));
      const failed = execute('types:check');
      expect(failed.status).toBe(1);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain('已过期');
      expect(readFileSync(types, 'utf8')).toBe(original);
      const repaired = execute('types:check');
      expect(repaired.status, `${repaired.stdout}\n${repaired.stderr}`).toBe(0);
    });
  }, 60_000);

  test('类型输入缺失必须失败，不能比较两个空摘要', () => {
    withTypesProject((directory, execute) => {
      rmSync(join(directory, 'scripts/worker-configuration.d.ts'));
      const result = execute('types:check');
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ENOENT');
    });
  });

  test('生成器失败即使文件摘要未变化也必须失败', () => {
    withTypesProject((directory, execute) => {
      const types = join(directory, 'scripts/worker-configuration.d.ts');
      const original = readFileSync(types, 'utf8');
      writeFileSync(join(directory, 'scripts/wrangler.toml'), 'name = [\n');
      const result = execute('types:check');
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(readFileSync(types, 'utf8')).toBe(original);
    });
  }, 60_000);

  test('Cloudflare配置保持唯一产品身份和独立凭据声明', () => {
    const wrangler = readFileSync(resolve(projectPath, 'scripts/wrangler.toml'), 'utf8');
    expect(wrangler).toContain('name = "citizenserve"');
    expect(wrangler).toContain('binding = "CITIZENCHAIN_DOWNLOAD_DB"');
    expect(wrangler).toContain('database_name = "citizenserve"');
    expect(wrangler).toContain('database_name = "citizenweb-download"');
    expect(wrangler).toContain('bucket_name = "citizenserve-private"');
    expect(wrangler).toContain('bucket_name = "citizenserve-media"');
    expect(wrangler.match(/queue = "citizenserve"/gu)).toHaveLength(2);
    expect(wrangler).toContain('id = "d632942d82c94e45ab4058fa69268ce1"');
    expect(wrangler).toContain('"CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET"');
    expect(wrangler).not.toMatch(/\.\.\/\.\.\/|\/Users\//);
  });

  test('发布指针认证使用CitizenChain产品头且没有第二套请求头', () => {
    const source = readFileSync(resolve(projectPath, 'src/citizenchain_download.ts'), 'utf8');
    expect(source).toContain("request.headers.get('x-citizenserve-request-time')");
    expect(source).toContain("request.headers.get('x-citizenserve-request-nonce')");
    expect(source).toContain("request.headers.get('x-citizenserve-request-signature')");
    expect(source.match(/x-citizenserve-request-/g)).toHaveLength(3);
  });
});
