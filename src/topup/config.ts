import type { Env } from '../types';
import { HttpError } from '../shared/http';

/// 稳定币充值购买公民币 · 静态配置真源。
///
/// 当前两条入金轨都固定在 Base：USDC→Base、USDT→Base。
/// 合约地址是安全关键项:错地址 = 收假币,任何改动必须二次核对。

/// 支持的稳定币币种(首期两种)。
export type TopupToken = 'USDC' | 'USDT';

/// 充值只允许 Base 主网，不保留测试网络分支。
export type TopupNetwork = 'mainnet';

/// 一条「币 + 链」入金轨的解析后配置。
export interface TopupRail {
  token: TopupToken;
  chain_id: number;
  /// ERC-20 代币合约地址(小写 0x),来自网络表默认 + Env 覆盖。
  token_contract: string;
  /// 代币精度(USDC/USDT 均为 6 位)。
  token_decimals: number;
  /// 该链 EVM JSON-RPC 的 Env 变量名(URL 值放 wrangler vars/secret,不硬编码)。
  rpc_env_key: 'TOPUP_BASE_RPC_URL';
  /// Env 中覆盖该币合约地址的变量名，仅供生产合约勘误。
  contract_env_key: 'TOPUP_USDC_CONTRACT' | 'TOPUP_USDT_CONTRACT';
  label: string;
}

/// Base 主网默认合约地址。
interface RailTemplate {
  chain_id: number;
  default_contract: string;
  rpc_env_key: TopupRail['rpc_env_key'];
  contract_env_key: TopupRail['contract_env_key'];
  label: string;
}

const MAINNET_TEMPLATES: Readonly<Record<TopupToken, RailTemplate>> = {
  USDC: {
    chain_id: 8453,
    default_contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    rpc_env_key: 'TOPUP_BASE_RPC_URL',
    contract_env_key: 'TOPUP_USDC_CONTRACT',
    label: 'USDC · Base',
  },
  USDT: {
    chain_id: 8453,
    // USDC/USDT 同走 Base(一条链、一种 gas)。Base 主网 USDT 合约(用户从钱包核对提供)。
    default_contract: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
    rpc_env_key: 'TOPUP_BASE_RPC_URL',
    contract_env_key: 'TOPUP_USDT_CONTRACT',
    label: 'USDT · Base',
  },
};

const TOKEN_DECIMALS = 6;

/// 充值套餐(定价真源)。USDC/USDT 均按 1:1 美元、6 位精度,两币共用同一套金额。
/// pay_amount = 应付稳定币最小单位;coin_fen = 应发公民币分额(2 位精度)。
/// 两档单价不同 = 约 7% 批量折扣(已确认有意保留)。
export interface TopupPackage {
  package_id: string;
  pay_display: string;
  pay_amount: string;
  coin_display: string;
  coin_fen: string;
}

const PACKAGES: readonly TopupPackage[] = [
  // 15 USDC/USDT → 10,000.00 公民币:15 × 10^6 = 15000000;10000.00 × 100 = 1000000 分。
  { package_id: 'pkg_15', pay_display: '15', pay_amount: '15000000', coin_display: '10,000.00', coin_fen: '1000000' },
  // 1,400 USDC/USDT → 1,000,000.00 公民币:1400 × 10^6 = 1400000000;1000000.00 × 100 = 100000000 分。
  { package_id: 'pkg_1400', pay_display: '1400', pay_amount: '1400000000', coin_display: '1,000,000.00', coin_fen: '100000000' },
];

export function topupNetwork(_env: Env): TopupNetwork {
  return 'mainnet';
}

/// 解析一条币轨:合并网络表默认合约 + Env 覆盖;合约为空视为该轨未配置。
export function topupRail(env: Env, token: TopupToken): TopupRail {
  const template = MAINNET_TEMPLATES[token];
  const override = (env[template.contract_env_key] ?? '').trim().toLowerCase();
  // 合约地址：生产勘误覆盖优先，否则使用内置 Base 主网地址。
  const contract = override || template.default_contract;
  return {
    token,
    chain_id: template.chain_id,
    token_contract: contract,
    token_decimals: TOKEN_DECIMALS,
    rpc_env_key: template.rpc_env_key,
    contract_env_key: template.contract_env_key,
    label: template.label,
  };
}

/// USDC 与 USDT 两轨**始终同时提供**(不因合约未配置而隐藏)。
/// Base 主网两币合约均内置。
export function topupRails(env: Env): TopupRail[] {
  return [topupRail(env, 'USDC'), topupRail(env, 'USDT')];
}

export function topupPackages(): readonly TopupPackage[] {
  return PACKAGES;
}

export function findPackage(packageId: string): TopupPackage | null {
  return PACKAGES.find((item) => item.package_id === packageId) ?? null;
}

export function isTopupToken(value: unknown): value is TopupToken {
  return value === 'USDC' || value === 'USDT';
}

/// 平台/国储会 EVM 收款地址(同一 EOA 跨链复用),小写返回。
export function topupRecvAddress(env: Env): string {
  const address = (env.TOPUP_RECV_ADDRESS ?? '').trim().toLowerCase();
  if (!isEvmAddress(address)) {
    throw new HttpError(503, 'topup_recv_unconfigured', 'EVM 收款地址未配置');
  }
  return address;
}

/// 取某条链的 EVM JSON-RPC URL(必须 https)。
export function railRpcUrl(env: Env, rail: TopupRail): string {
  const url = (env[rail.rpc_env_key] ?? '').trim();
  if (!url.startsWith('https://')) {
    throw new HttpError(503, 'topup_rpc_unconfigured', `${rail.label} 的 EVM RPC 未配置`);
  }
  return url;
}

/// 最小确认数:>0 时按 latest 计算确认数,=0 时按 finalized 区块判定。
export function topupMinConfirmations(env: Env): number {
  const parsed = Number.parseInt(env.TOPUP_MIN_CONFIRMATIONS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(value);
}

export function isEvmTxHash(value: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(value.toLowerCase());
}
