import type {Buffer} from 'node:buffer';

// 与chain_source.mjs同名的静态类型投影；读取、坐标与摘要仍由该模块唯一执行。
export const chainSourceSHA: string;
export const chainSourcePaths: readonly string[];
export function readChainSource(path: string, request?: typeof globalThis.fetch): Promise<Buffer>;
