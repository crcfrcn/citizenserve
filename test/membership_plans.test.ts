import { describe, expect, it } from 'vitest';
import {
  membershipPlan,
  membershipPlanList,
  membershipPlans,
} from '../src/membership/plans';

describe('membership chat entitlements', () => {
  it('keeps one chat contract across all active membership levels', () => {
    expect(membershipPlanList()).toHaveLength(3);

    for (const plan of membershipPlanList()) {
      expect(plan.chat).toEqual({
        text_enabled: true,
        emoji_enabled: true,
        sticker_enabled: true,
        image_enabled: true,
        voice_message_max_seconds: 180,
        video_message_max_seconds: 180,
        voice_call_enabled: true,
        video_call_enabled: true,
      });
    }

    expect(membershipPlans.freedom.chat_file_max_bytes).toBe(10 * 1024 * 1024);
    expect(membershipPlans.democracy.chat_file_max_bytes).toBe(100 * 1024 * 1024);
    expect(membershipPlans.spark.chat_file_max_bytes).toBe(5120 * 1024 * 1024);
  });

  it('rejects missing or unknown membership instead of granting freedom rights', () => {
    expect(() => membershipPlan('')).toThrow('invalid membership level');
    expect(() => membershipPlan('unknown')).toThrow('invalid membership level');
  });
});
