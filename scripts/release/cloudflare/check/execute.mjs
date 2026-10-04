#!/usr/bin/env node
import { spawnSync as runExactProcess } from 'node:child_process';

function validateCandidate() {
  const value=process.env;
if(!/^[0-9a-f]{40}$/.test(value.SOURCE_SHA||'')||!/^[1-9][0-9]*$/.test(value.CI_RUN_ID||'')||!/^\d+\.\d{1,2}\.\d{1,2}$/.test(value.SOFTWARE_VERSION||'')||value.VERSION_TAG!=='citizenserve-cloudflare-v'+value.SOFTWARE_VERSION)throw Error('准确Release候选无效');
}

// 本文件只执行 citizenserve.cloudflare.release 的 check Job；阶段编号由本仓唯一 Workflow 固定，禁止接收其它身份。
export const EXACT_REMOTE_JOB_IDENTITY = Object.freeze({"pipeline":"citizenserve.cloudflare.release","job":"check"});

function requireExactRemoteJobEnvironment() {
  const expected = 'crcfrcn/citizenserve';
  if (!expected || process.env.GITHUB_REPOSITORY !== expected) {
    throw new Error('准确远端Job仓库身份无效');
  }
}
const workflowSteps = Object.freeze({
  "0": {
    "shell": "bash",
    "source": "node $GITHUB_WORKSPACE/scripts/release/cloudflare/index.mjs version-tag verify-release-source --ci-run-id \"$GMB_CI_RUN_ID\" --version-tag \"$GMB_VERSION_TAG\" --source-sha \"$GMB_SOURCE_SHA\" --prefix citizenserve-cloudflare-v --product-id citizenserve --target cloudflare --workflow citizenserve.cloudflare.ci"
  },
  "1": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$GMB_SOURCE_SHA\"\nnode - <<'NODE'\nconst fs = require('node:fs');\nconst version = process.env.GMB_SOFTWARE_VERSION;\nif (!/^\\d+\\.\\d{1,2}\\.\\d{1,2}$/.test(version)) throw new Error('后端候选版本输入无效');\nfor (const path of ['package.json', 'package-lock.json']) {\n  const value = JSON.parse(fs.readFileSync(path, 'utf8'));\n  value.version = version;\n  if (path.endsWith('package-lock.json')) {\n    if (!value.packages?.['']) throw new Error('后端 package-lock 缺少根 package');\n    value.packages[''].version = version;\n  }\n  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\\n`);\n}\nNODE\n"
  },
  "2": {
    "shell": "bash",
    "source": "npm ci --no-audit --no-fund\n"
  },
  "3": {
    "shell": "bash",
    "source": "npm run types:check"
  },
  "4": {
    "shell": "bash",
    "source": "npm run typecheck"
  },
  "5": {
    "shell": "bash",
    "source": "npm test"
  },
  "6": {
    "shell": "bash",
    "source": "npm exec -- wrangler d1 execute DB --config scripts/wrangler.toml --local \\\n  --persist-to \"$RUNNER_TEMP/citizenserve-cloudflare-d1\" \\\n  --file schema/citizenserve.sql\nnpm exec -- wrangler d1 execute CITIZENCHAIN_DOWNLOAD_DB --config scripts/wrangler.toml --local \\\n  --persist-to \"$RUNNER_TEMP/citizenserve-cloudflare-d1\" \\\n  --file schema/download.sql\ntest ! -e migrations\n"
  },
  "7": {
    "shell": "bash",
    "source": "npm exec -- wrangler deploy --config scripts/wrangler.toml --dry-run --outdir \"$RUNNER_TEMP/citizenserve-cloudflare-bundle\""
  },
  "8": {
    "shell": "bash",
    "source": "node $GITHUB_WORKSPACE/scripts/release/cloudflare/index.mjs action --project citizenserve --bundle \"$RUNNER_TEMP/citizenserve-cloudflare-bundle/index.js\" --output \"$RUNNER_TEMP/citizenserve-cloudflare-candidate\" --git-sha \"$GMB_SOURCE_SHA\" --archive \"$RUNNER_TEMP/citizenserve-cloudflare-release.tgz\""
  }
});

function runExactWorkflowStep(index) {
  requireExactRemoteJobEnvironment();
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(index || '')) || !Object.hasOwn(workflowSteps, String(index))) {
    throw new Error('准确远端Job阶段无效');
  }
  const step = workflowSteps[String(index)];
  const command = step.shell === 'pwsh' ? 'pwsh' : (process.platform === 'win32' ? 'bash' : '/bin/bash');
  const args = step.shell === 'pwsh'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', step.source]
    : ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.source];
  const result = runExactProcess(command, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (result.error) throw new Error('准确远端Job阶段无法启动');
  if (result.status !== 0) process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

requireExactRemoteJobEnvironment();
validateCandidate();
if (process.argv[2] !== 'workflow-step') throw new Error('准确Release Job只接受workflow-step');
runExactWorkflowStep(process.argv[3]);
