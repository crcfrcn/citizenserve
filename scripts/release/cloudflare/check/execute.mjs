#!/usr/bin/env node
import { spawnSync as runExactProcess } from 'node:child_process';
import * as shellFs from 'node:fs';
import * as shellPath from 'node:path';
import * as shellCrypto from 'node:crypto';
import { execFileSync as shellExecute } from 'node:child_process';
import { pathToFileURL as shellFileURL } from 'node:url';


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


// 本Job独立准备官方GNU Bash；首次构建输入不进入正式测试的Shell选择。
export const TEST_SHELL_SOURCE = Object.freeze({"version":"5.3.20","url":"https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz","sha256":"0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba","root":"bash-5.3","executable":"bin/bash","upstream_patches":[{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-001","sha256":"1f608434364af86b9b45c8b0ea3fb3b165fb830d27697e6cdfc7ac17dee3287f","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-001","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-001"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-002","sha256":"e385548a00130765ec7938a56fbdca52447ab41fabc95a25f19ade527e282001","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-002","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-002"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-003","sha256":"f245d9c7dc3f5a20d84b53d249334747940936f09dc97e1dcb89fc3ab37d60ed","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-003","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-003"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-004","sha256":"9591d245045529f32f0812f94180b9d9ce9023f5a765c039b852e5dfc99747d0","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-004","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-004"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-005","sha256":"cca1ef52dbbf433bc98e33269b64b2c814028efe2538be1e2c9a377da90bc99d","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-005","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-005"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-006","sha256":"29119addefed8eff91ae37fd51822c31780ee30d4a28376e96002706c995ff10","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-006","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-006"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-007","sha256":"c0976bbfffa1453c7cfdd62058f206a318568ff2d690f5d4fa048793fa3eb299","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-007","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-007"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-008","sha256":"097cd723cbfb8907674ac32214063a3fd85282657ec5b4e544d2c0f719653fb4","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-008","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-008"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-009","sha256":"eee30fe78a4b0cb2fe20e010e00308899cfc613e0774ebb3c8557a1552f24f8c","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-009","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-009"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-010","sha256":"cf76f1cce2ea300c18bff9f002d21f280cc931acd17c28518110b93fe6e72569","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-010","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-010"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-011","sha256":"0298df8f5ea2a31d3be43ed7d269c5b3c7c342dd5b570bea7f64d66dcbbe7531","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-011","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-011"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-012","sha256":"d71379b39bebaedaf123414414e77fb458a0a43b9ad3116594c6df7ca6754573","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-012","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-012"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-013","sha256":"042f9cda967e24bf4211944697441e93d06ff42b4b998629a98a1b249279f200","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-013","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-013"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-014","sha256":"bd4360b401d38507e358783dcad8536a99c6789f0d3a5bd0cfb8c4a34144696c","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-014","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-014"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-015","sha256":"55b79ceee2fc27f6767eed697e939a7eb2fe2a28c01556bd75f18d581014f46e","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-015","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-015"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-016","sha256":"9ea29b266b7d24cb34d0ff3f1c4631e4d527bfe2d1ef15d17cdb924bf31ef767","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-016","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-016"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-017","sha256":"443b927b45c1558ca72052410f8b8f6e5152b617ed707061a2781d4375b0d1c3","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-017","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-017"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-018","sha256":"ae715d76c50341d7d7095e9a8d2eeed1ca9546152c2ac7289206f90cf30ac697","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-018","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-018"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-019","sha256":"a25c581e4d0057dea3833918438a930e2e86ee4c6dc17fe15267b7f04cbc4e3d","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-019","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-019"]},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-020","sha256":"df217ed3a9122aa2286d9b67bbe348661b6a9db262b580c29150dae55d532896","mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3-patches/bash53-020","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3-patches/bash53-020"]}],"mirrors":["https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3.tar.gz","https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3.tar.gz"]});
export const TEST_SHELL_BOOTSTRAP = Object.freeze({"commands":[{"name":"basename","path":"/usr/bin/basename","package":"coreutils"},{"name":"cat","path":"/usr/bin/cat","package":"coreutils"},{"name":"chmod","path":"/usr/bin/chmod","package":"coreutils"},{"name":"cp","path":"/usr/bin/cp","package":"coreutils"},{"name":"cut","path":"/usr/bin/cut","package":"coreutils"},{"name":"date","path":"/usr/bin/date","package":"coreutils"},{"name":"dd","path":"/usr/bin/dd","package":"coreutils"},{"name":"dirname","path":"/usr/bin/dirname","package":"coreutils"},{"name":"du","path":"/usr/bin/du","package":"coreutils"},{"name":"echo","path":"/usr/bin/echo","package":"coreutils"},{"name":"env","path":"/usr/bin/env","package":"coreutils"},{"name":"expr","path":"/usr/bin/expr","package":"coreutils"},{"name":"head","path":"/usr/bin/head","package":"coreutils"},{"name":"install","path":"/usr/bin/install","package":"coreutils"},{"name":"ln","path":"/usr/bin/ln","package":"coreutils"},{"name":"ls","path":"/usr/bin/ls","package":"coreutils"},{"name":"mkdir","path":"/usr/bin/mkdir","package":"coreutils"},{"name":"mv","path":"/usr/bin/mv","package":"coreutils"},{"name":"od","path":"/usr/bin/od","package":"coreutils"},{"name":"printf","path":"/usr/bin/printf","package":"coreutils"},{"name":"pwd","path":"/usr/bin/pwd","package":"coreutils"},{"name":"readlink","path":"/usr/bin/readlink","package":"coreutils"},{"name":"realpath","path":"/usr/bin/realpath","package":"coreutils"},{"name":"rm","path":"/usr/bin/rm","package":"coreutils"},{"name":"rmdir","path":"/usr/bin/rmdir","package":"coreutils"},{"name":"sleep","path":"/usr/bin/sleep","package":"coreutils"},{"name":"sort","path":"/usr/bin/sort","package":"coreutils"},{"name":"stat","path":"/usr/bin/stat","package":"coreutils"},{"name":"tail","path":"/usr/bin/tail","package":"coreutils"},{"name":"tee","path":"/usr/bin/tee","package":"coreutils"},{"name":"test","path":"/usr/bin/test","package":"coreutils"},{"name":"touch","path":"/usr/bin/touch","package":"coreutils"},{"name":"tr","path":"/usr/bin/tr","package":"coreutils"},{"name":"true","path":"/usr/bin/true","package":"coreutils"},{"name":"uname","path":"/usr/bin/uname","package":"coreutils"},{"name":"uniq","path":"/usr/bin/uniq","package":"coreutils"},{"name":"wc","path":"/usr/bin/wc","package":"coreutils"},{"name":"bash","path":"/usr/bin/bash","package":"bash"},{"name":"grep","path":"/usr/bin/grep","package":"grep"},{"name":"sed","path":"/usr/bin/sed","package":"sed"},{"name":"make","path":"/usr/bin/make","package":"make"},{"name":"patch","path":"/usr/bin/patch","package":"patch"},{"name":"tar","path":"/usr/bin/tar","package":"tar"},{"name":"gzip","path":"/usr/bin/gzip","package":"gzip"},{"name":"xz","path":"/usr/bin/xz","package":"xz-utils"},{"name":"awk","path":"/usr/bin/mawk","package":"mawk"},{"name":"diff","path":"/usr/bin/diff","package":"diffutils"},{"name":"cmp","path":"/usr/bin/cmp","package":"diffutils"},{"name":"find","path":"/usr/bin/find","package":"findutils"},{"name":"xargs","path":"/usr/bin/xargs","package":"findutils"},{"name":"clang","path":"/usr/lib/llvm-18/bin/clang","package":"clang-18"},{"name":"ar","path":"/usr/bin/x86_64-linux-gnu-ar","package":"binutils-x86-64-linux-gnu"},{"name":"as","path":"/usr/bin/x86_64-linux-gnu-as","package":"binutils-x86-64-linux-gnu"},{"name":"ld","path":"/usr/bin/x86_64-linux-gnu-ld.bfd","package":"binutils-x86-64-linux-gnu"},{"name":"nm","path":"/usr/bin/x86_64-linux-gnu-nm","package":"binutils-x86-64-linux-gnu"},{"name":"ranlib","path":"/usr/bin/x86_64-linux-gnu-ranlib","package":"binutils-x86-64-linux-gnu"},{"name":"strip","path":"/usr/bin/x86_64-linux-gnu-strip","package":"binutils-x86-64-linux-gnu"}],"packages":[{"name":"dpkg","version":"1.22.6ubuntu6.6","source":"https://packages.ubuntu.com/noble/dpkg"},{"name":"bash","version":"5.2.21-2ubuntu4","source":"https://packages.ubuntu.com/noble/bash"},{"name":"grep","version":"3.11-4build1","source":"https://packages.ubuntu.com/noble/grep"},{"name":"sed","version":"4.9-2ubuntu0.24.04.1","source":"https://packages.ubuntu.com/noble/sed"},{"name":"coreutils","version":"9.4-3ubuntu6.3","source":"https://packages.ubuntu.com/noble/coreutils"},{"name":"make","version":"4.3-4.1build2","source":"https://packages.ubuntu.com/noble/make"},{"name":"patch","version":"2.7.6-7build3","source":"https://packages.ubuntu.com/noble/patch"},{"name":"mawk","version":"1.3.4.20240123-1build1","source":"https://packages.ubuntu.com/noble/mawk"},{"name":"diffutils","version":"1:3.10-1ubuntu0.1","source":"https://packages.ubuntu.com/noble/diffutils"},{"name":"findutils","version":"4.9.0-5build1","source":"https://packages.ubuntu.com/noble/findutils"},{"name":"tar","version":"1.35+dfsg-3ubuntu0.4","source":"https://packages.ubuntu.com/noble/tar"},{"name":"gzip","version":"1.12-1ubuntu3.2","source":"https://packages.ubuntu.com/noble/gzip"},{"name":"xz-utils","version":"5.6.1+really5.4.5-1ubuntu0.3","source":"https://packages.ubuntu.com/noble/xz-utils"},{"name":"clang-18","version":"1:18.1.3-1ubuntu1","source":"https://packages.ubuntu.com/noble/clang-18"},{"name":"binutils-x86-64-linux-gnu","version":"2.42-4ubuntu2.10","source":"https://packages.ubuntu.com/noble/binutils-x86-64-linux-gnu"},{"name":"libexpat1-dev","version":"2.6.1-2ubuntu0.6","source":"https://packages.ubuntu.com/noble/libexpat1-dev"},{"name":"zlib1g-dev","version":"1:1.3.dfsg-3.1ubuntu2.2","source":"https://packages.ubuntu.com/noble/zlib1g-dev"},{"name":"libc6","version":"2.39-0ubuntu8.9","source":"https://packages.ubuntu.com/noble/libc6"},{"name":"libc6-dev","version":"2.39-0ubuntu8.9","source":"https://packages.ubuntu.com/noble/libc6-dev"},{"name":"libc-dev-bin","version":"2.39-0ubuntu8.9","source":"https://packages.ubuntu.com/noble/libc-dev-bin"},{"name":"libgcc-13-dev","version":"13.3.0-6ubuntu2~24.04.1","source":"https://packages.ubuntu.com/noble/libgcc-13-dev"},{"name":"libstdc++-13-dev","version":"13.3.0-6ubuntu2~24.04.1","source":"https://packages.ubuntu.com/noble/libstdc++-13-dev"}]});
const shellDigest = bytes => shellCrypto.createHash('sha256').update(bytes).digest('hex');
const shellFailure = message => { throw Error('测试Shell交付：' + message); };
const shellKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...names].sort().join('\0');
function shellFile(value, executable = false) {
  if (typeof value !== 'string' || !shellPath.isAbsolute(value) || shellPath.resolve(value) !== value
    || /[\x00-\x1f]/u.test(value)) shellFailure('缺少规范绝对路径');
  const info = shellFs.lstatSync(value);
  if (!info.isFile() || info.isSymbolicLink() || shellFs.realpathSync(value) !== value
    || executable && (!info.size || !(info.mode & 0o111))) shellFailure('必须是规范真实普通文件');
  return value;
}
function shellDirectory(value) {
  if (typeof value !== 'string' || !shellPath.isAbsolute(value) || shellPath.resolve(value) !== value
    || shellFs.realpathSync(value) !== value || !shellFs.lstatSync(value).isDirectory()) shellFailure('工作根不是规范真实目录');
  return value;
}
function shellWork(environment) {
  return shellPath.join(shellDirectory(environment.RUNNER_TEMP),
    EXACT_REMOTE_JOB_IDENTITY.pipeline === 'citizenserve.cloudflare.ci'
      ? 'citizenserve-cloudflare-ci-shell' : 'citizenserve-cloudflare-release-shell');
}
function shellContext(environment) {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== 'crcfrcn/citizenserve'
    || environment.GITHUB_WORKFLOW !== EXACT_REMOTE_JOB_IDENTITY.pipeline
    || environment.GITHUB_JOB !== 'flow' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch') shellFailure('所属远端流程身份不符');
}
function shellInventory(root, at = root) {
  const rows = [];
  for (const name of shellFs.readdirSync(at).sort()) {
    const value = shellPath.join(at, name), info = shellFs.lstatSync(value), path = value.slice(root.length + 1);
    if (info.isSymbolicLink()) {
      if (!shellFs.realpathSync(value).startsWith(root + '/')) shellFailure('工具对象链接越界');
      rows.push({path,target:shellFs.readlinkSync(value)});
    } else if (info.isDirectory()) rows.push(...shellInventory(root, value));
    else if (info.isFile()) rows.push({path,sha256:shellDigest(shellFs.readFileSync(value)),mode:info.mode & 0o777});
    else shellFailure('工具对象包含特殊文件');
  }
  return rows;
}
function shellReceiptBootstrap(value) {
  if (!shellKeys(value,['commands','packages']) || !Array.isArray(value.commands) || !Array.isArray(value.packages)
    || value.commands.length !== TEST_SHELL_BOOTSTRAP.commands.length
    || new Set(value.packages.map(p=>p.name)).size !== value.packages.length) shellFailure('基础输入回执闭集不符');
  for (const [i,expected] of TEST_SHELL_BOOTSTRAP.commands.entries()) {
    const actual=value.commands[i];
    if (!shellKeys(actual,['name','path','package','sha256']) || actual.name!==expected.name
      || actual.path!==expected.path || actual.package!==expected.package || !/^[a-f0-9]{64}$/u.test(actual.sha256)) shellFailure('基础命令来源回执不符');
  }
  for (const record of value.packages) if (!shellKeys(record,['name','version']) || !record.name || !record.version) shellFailure('基础包闭集不符');
  for (const expected of TEST_SHELL_BOOTSTRAP.packages)
    if (!value.packages.some(p=>p.name===expected.name && p.version===expected.version)) shellFailure('基础根包版本回执不符');
}
// 正式测试只接受本Job源码外对象与完整来源回执；入口、版本及全部文件同时复验。
export function validateTestShell(environment = process.env, execute = shellExecute) {
  shellContext(environment);
  const object=shellPath.join(shellWork(environment),'tools','bash');shellDirectory(object);
  const entry=shellFile(environment.PRODUCT_SHELL_BIN,true);
  if (entry!==shellPath.join(object,'payload','bin','bash')) shellFailure('工具对象不属于当前流程');
  const receipt=JSON.parse(shellFs.readFileSync(shellFile(shellPath.join(object,'receipt.json')),'utf8'));
  if (!shellKeys(receipt,['pipeline','source','bootstrap','sha256','files'])
    || receipt.pipeline!==EXACT_REMOTE_JOB_IDENTITY.pipeline
    || JSON.stringify(receipt.source)!==JSON.stringify(TEST_SHELL_SOURCE)
    || receipt.sha256!==shellDigest(shellFs.readFileSync(entry))) shellFailure('正式来源或产物摘要不符');
  shellReceiptBootstrap(receipt.bootstrap);
  if (JSON.stringify(shellInventory(object).filter(row=>row.path!=='receipt.json'))!==JSON.stringify(receipt.files)) shellFailure('完整工具对象漂移');
  const version=String(execute(entry,['--version'],{env:{HOME:environment.HOME,LANG:'C',LC_ALL:'C',PATH:shellPath.dirname(process.execPath)},encoding:'utf8',timeout:20_000,maxBuffer:1024*1024})).split(/\r?\n/u)[0];
  if (!/^GNU bash, version 5\.3\.20\([1-9][0-9]*\)-release(?:\s|$)/u.test(version)) shellFailure('正式GNU Bash版本不符');
  return entry;
}
export function runShellTests(environment = process.env, execute = runExactProcess, versionExecute = shellExecute) {
  const shell=validateTestShell(environment,versionExecute);
  const env={...environment,PRODUCT_SHELL_BIN:shell,npm_config_script_shell:shell};
  for (const name of ['BASH_ENV','ENV','BASHOPTS','SHELLOPTS']) delete env[name];
  const result=execute(shell,['--noprofile','--norc','-e','-o','pipefail','-c','npm test'],{cwd:process.cwd(),env,stdio:'inherit'});
  if (result.error || result.status!==0) shellFailure('测试命令失败');
  return result;
}

// Ubuntu虚拟依赖仅由已安装包的官方Provides满足，提供包自身依赖仍进入完整闭包。
export function resolveBootstrapPackages(records, roots, compare) {
  const packages=new Map(records.map(record=>[record.name,record]));
  if(packages.size!==records.length)shellFailure('Ubuntu包身份重复');
  const ready=record=>record?.status==='install ok installed',providers=new Map();
  for(const record of [...packages.values()].filter(ready).sort((a,b)=>a.name.localeCompare(b.name))) {
    const seen=new Set();
    for(const item of (record.provides||'').split(',').map(value=>value.trim()).filter(Boolean)) {
      const match=/^([a-z0-9+.-]+)(?:\s*\(=\s*([^()\s]+)\))?$/u.exec(item);
      if(!match)shellFailure('Ubuntu虚拟包声明无效');
      const identity=JSON.stringify([match[1],match[2]??null]);
      if(seen.has(identity))shellFailure('Ubuntu虚拟包声明重复');seen.add(identity);
      const list=providers.get(match[1])||[];list.push({record,version:match[2]});providers.set(match[1],list);
    }
  }
  for(const root of roots) {
    const actual=packages.get(root.name);
    if(!ready(actual)||actual.version!==root.version)shellFailure('基础根包不符：'+root.name+'；预期='+root.version+'；实际='+(actual?.version||'缺失'));
  }
  const selected=new Map(),queue=roots.map(root=>root.name);
  while(queue.length) {
    const name=queue.shift();if(selected.has(name))continue;const record=packages.get(name);
    if(!ready(record))shellFailure('Ubuntu内部包未安装');
    selected.set(name,{name,version:record.version});
    for(const clause of [record.depends,record.preDepends].filter(Boolean).join(',').split(',').map(value=>value.trim()).filter(Boolean)) {
      let dependency;
      for(const alternative of clause.split('|')) {
        const match=/^([a-z0-9+.-]+)(?::(?:any|native|amd64))?(?:\s*\((<<|<=|=|>=|>>)\s*([^()\s]+)\))?$/u.exec(alternative.trim());
        if(!match)shellFailure('内部依赖语法未支持');
        const candidate=packages.get(match[1]);
        if(ready(candidate)&&(!match[2]||compare(candidate.version,match[2],match[3]))) {dependency=candidate.name;break;}
        const provider=(providers.get(match[1])||[]).find(item=>!match[2]||(item.version&&compare(item.version,match[2],match[3])));
        if(provider) {dependency=provider.record.name;break;}
      }
      if(!dependency)shellFailure('Ubuntu内部依赖闭包缺失：'+clause);queue.push(dependency);
    }
  }
  return [...selected.values()].sort((a,b)=>a.name.localeCompare(b.name));
}

function shellBootstrap(environment, execute) {
  shellContext(environment);
  if (process.platform!=='linux' || process.arch!=='x64'
    || !/^ID=ubuntu$/mu.test(shellFs.readFileSync('/etc/os-release','utf8'))
    || !/^VERSION_ID="24\.04"$/mu.test(shellFs.readFileSync('/etc/os-release','utf8'))) shellFailure('Ubuntu首次构建身份不符');
  const env={HOME:environment.HOME,PATH:'',LANG:'C',LC_ALL:'C'};
  const call=(command,args)=>String(execute(shellFile(command,true),args,{env,encoding:'utf8',timeout:20_000,maxBuffer:4*1024*1024})).trim();
  const query='/usr/bin/dpkg-query',dpkg='/usr/bin/dpkg';
  const format=['Package','Architecture','Status','Version','Depends','Pre-Depends','Provides'].map(name=>'$'+'{'+name+'}').join('\t')+'\n';
  const records=call(query,['-W','-f='+format]).split('\n').filter(Boolean).map(line=>line.split('\t')).filter(row=>['all','amd64'].includes(row[1]))
    .map(([name,architecture,status,version,depends,preDepends,provides])=>({name,status,version,depends,preDepends,provides}));
  const selected=resolveBootstrapPackages(records,TEST_SHELL_BOOTSTRAP.packages,(actual,operator,expected)=>{
    try {execute(dpkg,['--compare-versions',actual,operator,expected],{env,encoding:'utf8',timeout:20_000});return true;}
    catch(error) {if(error.status===1)return false;throw error;}
  });
  for(const record of selected)if(call(dpkg,['--verify',record.name]))shellFailure('Ubuntu包文件漂移：'+record.name);
  const commands=TEST_SHELL_BOOTSTRAP.commands.map(record=>{
    const path=shellFile(record.path,true);
    if(!call(query,['-S',path]).split('\n').some(line=>line===record.package+': '+path || line===record.package+':amd64: '+path))shellFailure('基础命令包归属不符');
    return {...record,sha256:shellDigest(shellFs.readFileSync(path))};
  });
  const clang=commands.find(p=>p.name==='clang');
  if(!clang || !/^Ubuntu clang version 18\.1\.3(?:\s|$)/u.test(call(clang.path,['--version'])))shellFailure('编译器版本不符');
  return {commands,packages:selected};
}
export async function shellOriginal(record, destination, request = fetch) {
  const {response} = await requestGNUOriginal(record, request);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 128 * 1024 ** 2) shellFailure('GNU原件超限'); chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!size || shellDigest(bytes) !== record.sha256) shellFailure('GNU原件摘要不符');
  shellFs.writeFileSync(destination, bytes, {flag:'wx', mode:0o444});
}


export async function prepareTestShell(environment = process.env, {execute=shellExecute,request=fetch} = {}) {
  shellContext(environment);
  if(process.version!=='v25.2.1' || shellDirectory(environment.RUNNER_TEMP)!=='/home/runner/work/_temp')shellFailure('准确Node或Runner临时根不符');
  const inputs=shellBootstrap(environment,execute),work=shellWork(environment);
  shellFs.mkdirSync(work);shellFs.mkdirSync(shellPath.join(work,'tools'));
  const bin=shellPath.join(work,'bootstrap-bin');shellFs.mkdirSync(bin);
  const paths=Object.fromEntries(inputs.commands.map(p=>[p.name,p.path]));
  for(const record of inputs.commands)shellFs.symlinkSync(record.path,shellPath.join(bin,record.name));
  shellFs.symlinkSync(paths.bash,shellPath.join(bin,'sh'));
  const object=shellPath.join(work,'tools','bash');shellFs.mkdirSync(object);
  const archive=shellPath.join(object,'source.archive');await shellOriginal(TEST_SHELL_SOURCE,archive,request);
  const env={HOME:environment.HOME,TMPDIR:work,PATH:bin,LANG:'C',LC_ALL:'C',SHELL:paths.bash,CONFIG_SHELL:paths.bash,
    CC:paths.clang+' --gcc-install-dir=/usr/lib/gcc/x86_64-linux-gnu/13',AR:paths.ar,AS:paths.as,LD:paths.ld,
    NM:paths.nm,RANLIB:paths.ranlib,STRIP:paths.strip,MAKE:paths.make,CFLAGS:'-O2',CONFIG_SITE:'',MAKEINFO:'true',HELP2MAN:'true'};
  const run=(command,args,cwd)=>String(execute(command,args,{cwd,env,encoding:'utf8',timeout:3_600_000,maxBuffer:16*1024*1024}));
  const entries=run(paths.tar,['-tf',archive],object).split('\n').filter(Boolean);
  if(!entries.length || entries.some(name=>name.startsWith('/') || name.split('/').includes('..')
    || !(name===TEST_SHELL_SOURCE.root || name.startsWith(TEST_SHELL_SOURCE.root+'/'))))shellFailure('GNU归档路径越界');
  const unpack=shellPath.join(object,'unpack');shellFs.mkdirSync(unpack);
  run(paths.tar,['-xkf',archive,'--no-same-owner','--no-same-permissions','-C',unpack],object);
  const root=shellDirectory(shellPath.join(unpack,TEST_SHELL_SOURCE.root));shellInventory(root);
  const originals=[{path:archive,sha256:TEST_SHELL_SOURCE.sha256}];
  for(const [i,patch] of TEST_SHELL_SOURCE.upstream_patches.entries()){
    const path=shellPath.join(object,'bash53-'+String(i+1).padStart(3,'0'));
    await shellOriginal(patch,path,request);originals.push({path,sha256:patch.sha256});
    run(paths.patch,['--batch','--forward','--fuzz=0','-p0','-i',path],root);
  }
  const payload=shellPath.join(object,'payload');
  run(paths.bash,[shellPath.join(root,'configure'),'--prefix='+payload,'--disable-nls','--without-bash-malloc'],root);
  run(paths.make,['-j2','SHELL='+paths.bash],root);run(paths.make,['install','SHELL='+paths.bash],root);
  const entry=shellFile(shellPath.join(payload,'bin','bash'),true);
  if(!/^GNU bash, version 5\.3\.20\([1-9][0-9]*\)-release(?:\s|$)/u.test(run(entry,['--version'],root).split(/\r?\n/u)[0]))shellFailure('编译产物版本不符');
  if(JSON.stringify(shellBootstrap(environment,execute))!==JSON.stringify(inputs))shellFailure('基础输入在编译期间变化');
  for(const original of originals)if(shellDigest(shellFs.readFileSync(original.path))!==original.sha256)shellFailure('GNU原件在编译期间漂移');
  shellInventory(object);
  const protect=at=>{for(const name of shellFs.readdirSync(at)){const path=shellPath.join(at,name),info=shellFs.lstatSync(path);
    if(info.isDirectory()&&!info.isSymbolicLink())protect(path);else if(info.isFile()&&!info.isSymbolicLink())shellFs.chmodSync(path,info.mode&0o555);}
    shellFs.chmodSync(at,0o555);};
  for(const name of shellFs.readdirSync(object)){const path=shellPath.join(object,name),info=shellFs.lstatSync(path);
    if(info.isDirectory()&&!info.isSymbolicLink())protect(path);else if(info.isFile())shellFs.chmodSync(path,info.mode&0o555);}
  const receipt={pipeline:EXACT_REMOTE_JOB_IDENTITY.pipeline,source:TEST_SHELL_SOURCE,bootstrap:inputs,
    sha256:shellDigest(shellFs.readFileSync(entry)),files:shellInventory(object)};
  shellFs.writeFileSync(shellPath.join(object,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o444});
  shellFs.chmodSync(object,0o555);shellFs.rmSync(bin,{recursive:true});
  validateTestShell({...environment,PRODUCT_SHELL_BIN:entry},execute);
  shellFs.appendFileSync(shellFile(environment.GITHUB_ENV),'PRODUCT_SHELL_BIN='+entry+'\n');
  return entry;
}

function runExactWorkflowStep(index) {
  requireExactRemoteJobEnvironment();
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(index || '')) || !Object.hasOwn(workflowSteps, String(index))) {
    throw new Error('准确远端Job阶段无效');
  }
  const step = workflowSteps[String(index)];
  if (step.source.trim() === "npm test") { runShellTests(); return; }
  const command = step.shell === 'pwsh' ? 'pwsh' : (process.platform === 'win32' ? 'bash' : '/bin/bash');
  const args = step.shell === 'pwsh'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', step.source]
    : ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.source];
  const result = runExactProcess(command, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (result.error) throw new Error('准确远端Job阶段无法启动');
  if (result.status !== 0) process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

async function main() {
  requireExactRemoteJobEnvironment(); validateCandidate();
  if (process.argv[2] === 'prepare-test-shell') return prepareTestShell();
  if (process.argv[2] !== 'workflow-step') throw new Error('准确Release Job只接受workflow-step或prepare-test-shell');
  return runExactWorkflowStep(process.argv[3]);
}
if (process.argv[1] && shellFileURL(shellPath.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}

// GNU原件仅使用规范来源与两份固定镜像；相同文件路径、顺序和摘要不得漂移。
export function sourceMirrors(record) {
  const selected = /^https:\/\/ftp\.gnu\.org\/gnu\/(?:bash\/bash-5\.3\.tar\.gz|grep\/grep-3\.12\.tar\.xz|sed\/sed-4\.10\.tar\.xz|bash\/bash-5\.3-patches\/bash53-(?:00[1-9]|01[0-9]|020))$/u.test(record?.url);
  if (!selected) {
    if (Object.hasOwn(record ?? {}, 'mirrors')) shellFailure('未登记原件不能增加镜像');
    return [record.url];
  }
  const suffix = record.url.slice('https://ftp.gnu.org/gnu/'.length);
  const expected = ['https://mirrors.ocf.berkeley.edu/gnu/', 'https://mirror.csclub.uwaterloo.ca/gnu/'].map(base => base + suffix);
  if (!Array.isArray(record.mirrors) || JSON.stringify(record.mirrors) !== JSON.stringify(expected)
    || !/^[a-f0-9]{64}$/u.test(record.sha256)) shellFailure('GNU镜像坐标、顺序或摘要无效');
  return [record.url, ...record.mirrors];
}

// 只在连接暂时失败或明确可重试的HTTP状态时换站；证书、越界和摘要失败仍立即终止。
export async function requestGNUOriginal(record, request = fetch, {signal, headers} = {}) {
  const addresses = sourceMirrors(record), allowed = new Set(addresses);
  if (addresses.length !== 3) shellFailure('GNU获取缺少固定镜像闭集');
  const retryCodes = new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET',
    'ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN']);
  for (const [index, address] of addresses.entries()) {
    let url = address;
    for (let count = 0; count < 4; count++) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('GNU响应头等待超时', 'TimeoutError')), 12000);
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
      let response;
      try {
        response = await request(url, {redirect:'manual', credentials:'omit', signal:combined, ...(headers ? {headers} : {})});
      } catch (error) {
        signal?.throwIfAborted();
        if (index < addresses.length - 1 && (controller.signal.aborted || retryCodes.has(error?.cause?.code ?? error?.code))) break;
        throw error;
      } finally { clearTimeout(timer); }
      if (response.url && response.url !== url) shellFailure('GNU响应来源漂移');
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) shellFailure('GNU跳转缺少目标');
        const target = new URL(location, url).href;
        if (!allowed.has(target)) shellFailure('GNU跳转越出登记坐标');
        if (count === 3) shellFailure('GNU跳转次数超限');
        url = target; continue;
      }
      if ([404,408,429].includes(response.status) || response.status >= 500 && response.status <= 599) {
        await response.body?.cancel();
        if (index < addresses.length - 1) break;
        shellFailure('GNU所有固定入口均不可用');
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); shellFailure('GNU原件响应失败'); }
      return {response, url};
    }
  }
  shellFailure('GNU原件获取失败');
}
