import { describe, expect, it } from 'vitest';
import { buildObjectKeyPlan } from '../src/r2_keys';

describe('R2 object key plan', () => {
  it('keeps the square manifest under the CID-owned post directory', () => {
    const cidNumber = 'CN220-CTZN2-198805200-2026';
    const plan = buildObjectKeyPlan(cidNumber, 'sqp_abc');

    expect(plan.manifest_object_key).toBe(
      'square/CN220-CTZN2-198805200-2026/posts/sqp_abc/manifest.json'
    );
  });

  it('rejects non-canonical CID values instead of sanitizing them', () => {
    expect(() => buildObjectKeyPlan('wallet/account:001', 'sqp_abc')).toThrow();
    expect(() => buildObjectKeyPlan('CN220/CTZN2/198805200/2026', 'sqp_abc')).toThrow();
  });
});
