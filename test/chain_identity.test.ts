import { describe, expect, it, vi } from "vitest";

// 链读桩只验证动权投影的精确区块 storage 解码，不供普通请求使用。
const chainCidHex = vi.fn<() => Promise<string | null>>();
vi.mock("../src/chain/rpc", () => ({
  fetchFinalizedHead: vi.fn(async () => "0x" + "11".repeat(32)),
  fetchChainStorage: vi.fn(async () => chainCidHex()),
  fetchChainStorageBatch: vi.fn(async (_env, requests: unknown[]) =>
    Promise.all(requests.map(() => chainCidHex()))),
}));

import {
  cidRecordIsActive,
  fetchChainCidProjectionStateAtBlock,
  decodeCandidateIdentity,
  decodeCidNumber,
  decodeVotingIdentity,
  encodeBoundedBytes,
  votingIdentityIsActive,
} from "../src/chain/identity";

const utf8 = new TextEncoder();

describe("citizen-identity 永久 CID 闭环解码", () => {
  it("CID 值只接受唯一完整的 BoundedVec 编码", () => {
    const cid = "GD-CTZN1-8F3A2B";
    const encoded = encodeBoundedBytes(utf8.encode(cid));
    expect(decodeCidNumber(encoded)).toBe(cid);
    expect(decodeCidNumber(Uint8Array.from([...encoded, 0]))).toBeNull();
  });

  it("CidRegistry 只接受 Active 状态", () => {
    expect(cidRecordIsActive(cidRecord(0))).toBe(true);
    expect(cidRecordIsActive(cidRecord(1))).toBe(false);
    expect(cidRecordIsActive(cidRecord(0, true))).toBe(false);
    expect(cidRecordIsActive(null)).toBe(false);
  });

  it("VotingIdentityByCid 不再重复保存 CID，并按 UTC+8 有效期判定", () => {
    const active = decodeVotingIdentity(votingIdentity(0));
    const revoked = decodeVotingIdentity(votingIdentity(1));
    expect(active).not.toBeNull();
    expect(
      votingIdentityIsActive(active!, new Date("2026-07-21T16:30:00Z")),
    ).toBe(true);
    expect(
      votingIdentityIsActive(active!, new Date("2040-01-01T00:00:00Z")),
    ).toBe(false);
    expect(
      votingIdentityIsActive(revoked!, new Date("2026-07-22T00:00:00Z")),
    ).toBe(false);
    expect(decodeVotingIdentity(votingIdentity(0).slice(0, 9))).toBeNull();
  });

  it("竞选身份必须是姓、名和出生日期完整的最终布局", () => {
    expect(decodeCandidateIdentity(candidateIdentity())).not.toBeNull();
    expect(
      decodeCandidateIdentity(candidateIdentity({ familyName: "" })),
    ).toBeNull();
    expect(
      decodeCandidateIdentity(candidateIdentity().slice(0, -1)),
    ).toBeNull();
  });

  it("精确 finalized 区块解码 Active 与 Revoked CID 投影", async () => {
    const cidNumber = "GD-CTZN1-8F3A2B";
    chainCidHex.mockReset();
    chainCidHex
      .mockResolvedValueOnce(hex(Uint8Array.from(new Array(32).fill(0x77))))
      .mockResolvedValueOnce(hex(cidRecord(0)))
      .mockResolvedValueOnce(hex(Uint8Array.from([...u32(2), 0, 0, 0, 0])))
      .mockResolvedValueOnce(hex(votingIdentity(0)))
      .mockResolvedValueOnce(hex(candidateIdentity()));
    await expect(fetchChainCidProjectionStateAtBlock(
      {} as never,
      cidNumber,
      `0x${"11".repeat(32)}`,
      Date.parse("2026-07-22T00:00:00Z"),
    )).resolves.toMatchObject({
      cid_number: cidNumber,
      cid_record_status: "Active",
      account_id: ACCOUNT_ID,
      binding_revision: 2,
      identity_level: "candidate",
      registered_block_number: 1,
      revoked_block_number: null,
    });

    chainCidHex.mockReset();
    chainCidHex
      .mockResolvedValueOnce(hex(Uint8Array.from(new Array(32).fill(0x77))))
      .mockResolvedValueOnce(hex(cidRecord(1, true)))
      .mockResolvedValueOnce(hex(Uint8Array.from([...u32(3), 0, 0, 0, 0])))
      .mockResolvedValueOnce(hex(votingIdentity(1)))
      .mockResolvedValueOnce(null);
    await expect(fetchChainCidProjectionStateAtBlock(
      {} as never,
      cidNumber,
      `0x${"22".repeat(32)}`,
      Date.parse("2026-07-22T00:00:00Z"),
    )).resolves.toMatchObject({
      cid_record_status: "Revoked",
      binding_revision: 3,
      identity_level: "visitor",
      revoked_block_number: 2,
    });
  });
});

function bounded(value: string): number[] {
  const bytes = [...utf8.encode(value)];
  return [bytes.length << 2, ...bytes];
}

function u32(value: number): number[] {
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
}

function hex(value: Uint8Array): string {
  return `0x${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function cidRecord(status: number, revokedAt = false): Uint8Array {
  return Uint8Array.from([
    ...bounded("FEDERAL_REGISTRY-CID"),
    ...new Array(32).fill(7),
    ...bounded("GD"),
    ...bounded("0755"),
    status,
    ...u32(1),
    revokedAt ? 1 : 0,
    ...(revokedAt ? u32(2) : []),
  ]);
}

function votingIdentity(status: number): Uint8Array {
  return Uint8Array.from([
    ...u32(20260101),
    ...u32(20310101),
    status,
    ...bounded("GD"),
    ...bounded("0755"),
    ...bounded("001"),
    ...u32(1),
  ]);
}

function candidateIdentity(options: { familyName?: string } = {}): Uint8Array {
  return Uint8Array.from([
    ...bounded("GD"),
    ...bounded("0755"),
    ...bounded("001"),
    ...bounded(options.familyName ?? "陈"),
    ...bounded("明"),
    0,
    ...u32(20000131),
    ...u32(1),
  ]);
}

const ACCOUNT_ID = `0x${"77".repeat(32)}`;
