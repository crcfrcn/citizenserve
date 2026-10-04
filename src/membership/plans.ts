// 会员套餐真源（ADR-037：链上 GMB 会员与身份彻底解耦）。会员档 `membership_level` 是纯付费订阅轴，
// **不再绑定任何身份档**——任意身份（访客/投票/竞选）可订阅任意会员档，全组合放行。
// 三档：freedom 自由 / democracy 民主 / spark 薪火。发帖额度、媒体质量、完整聊天权益均按
// 所购套餐（membershipPlan(level)）。**价格真源与实际扣款属于链上 `square-post`，真实公历
// 到期时间由 runtime 根据共识时间戳确定**；本表只定档位与配额，不涉计价。一改此表须同步 App 卡片。
import { resourceLimit, usageLimits } from '../limits/catalog';

export type MembershipLevel = 'freedom' | 'democracy' | 'spark';

export type MediaQuality = 'sd' | 'hd';

const mib = 1024 * 1024;

export interface DocumentQuota {
  text_max_chars: number;
  image_quality: MediaQuality;
  max_images: number;
}

export interface VideoQuota {
  text_max_chars: number;
  video_quality: MediaQuality;
  max_video_seconds: number;
  /// 单个视频体积上限来自 limits 唯一资源表，会员接口只负责展示同一值。
  max_video_bytes: number;
}

export interface ArticleQuota {
  title_min_chars: number;
  title_max_chars: number;
  body_max_chars: number;
  cover_quality: MediaQuality;
  cover_required: true;
  image_quality: MediaQuality;
  /// 单篇文章全部图片总数，包含首图。
  max_images: number;
  /// 单篇文章视频数量；每个视频仍逐个执行本档时长和体积限制。
  max_videos: number;
}

/// 聊天权益真源。无有效会员时不存在 MembershipPlan，因此全部聊天能力默认禁止；
/// 三档有效会员当前均开放消息和一对一通话，语音、视频消息每条最长 3 分钟。
export interface ChatQuota {
  text_enabled: true;
  emoji_enabled: true;
  sticker_enabled: true;
  image_enabled: true;
  voice_message_max_seconds: number;
  video_message_max_seconds: number;
  voice_call_enabled: true;
  video_call_enabled: true;
}

export interface MembershipPlan {
  membership_level: MembershipLevel;
  display_name: string;
  /// 单个聊天附件大小上限（字节，会员权益之一，ADR-037）。
  chat_file_max_bytes: number;
  chat: ChatQuota;
  document: DocumentQuota;
  video: VideoQuota;
  article: ArticleQuota;
  /// 订阅周期累计用量额度（每月）。真源 limits/catalog.ts `usageLimits`，会员接口透传展示。
  usage: {
    monthly_images: number;
    monthly_video_seconds: number;
    active_uploads: number;
  };
}

const activeChatQuota: ChatQuota = {
  text_enabled: true,
  emoji_enabled: true,
  sticker_enabled: true,
  image_enabled: true,
  voice_message_max_seconds: 3 * 60,
  video_message_max_seconds: 3 * 60,
  voice_call_enabled: true,
  video_call_enabled: true
};

export const membershipPlans: Record<MembershipLevel, MembershipPlan> = {
  freedom: {
    membership_level: 'freedom',
    display_name: '自由会员',
    chat_file_max_bytes: 10 * mib,
    chat: activeChatQuota,
    document: {
      text_max_chars: 300,
      image_quality: 'sd',
      max_images: 9,
    },
    video: {
      text_max_chars: 300,
      video_quality: 'sd',
      max_video_seconds: 3 * 60,
      max_video_bytes: resourceLimit('square_video_freedom').max_bytes
    },
    article: {
      title_min_chars: 10,
      title_max_chars: 50,
      body_max_chars: 30_000,
      cover_quality: 'hd',
      cover_required: true,
      image_quality: 'sd',
      max_images: 50,
      max_videos: 1
    },
    usage: usageLimits.freedom
  },
  democracy: {
    membership_level: 'democracy',
    display_name: '民主会员',
    chat_file_max_bytes: 100 * mib,
    chat: activeChatQuota,
    document: {
      text_max_chars: 300,
      image_quality: 'hd',
      max_images: 9,
    },
    video: {
      text_max_chars: 300,
      video_quality: 'hd',
      max_video_seconds: 30 * 60,
      max_video_bytes: resourceLimit('square_video_democracy').max_bytes
    },
    article: {
      title_min_chars: 10,
      title_max_chars: 50,
      body_max_chars: 30_000,
      cover_quality: 'hd',
      cover_required: true,
      image_quality: 'hd',
      max_images: 100,
      max_videos: 3
    },
    usage: usageLimits.democracy
  },
  spark: {
    membership_level: 'spark',
    display_name: '薪火会员',
    chat_file_max_bytes: 5120 * mib,
    chat: activeChatQuota,
    document: {
      text_max_chars: 300,
      image_quality: 'hd',
      max_images: 9,
    },
    video: {
      text_max_chars: 300,
      video_quality: 'hd',
      max_video_seconds: 3 * 60 * 60,
      max_video_bytes: resourceLimit('square_video_spark').max_bytes
    },
    article: {
      title_min_chars: 10,
      title_max_chars: 50,
      body_max_chars: 30_000,
      cover_quality: 'hd',
      cover_required: true,
      image_quality: 'hd',
      max_images: 100,
      max_videos: 10
    },
    usage: usageLimits.spark
  }
};

export function assertMembershipLevel(value: unknown): MembershipLevel {
  if (value === 'freedom' || value === 'democracy' || value === 'spark') {
    return value;
  }
  throw new Error('invalid membership level');
}

export function membershipPlan(level: string): MembershipPlan {
  return membershipPlans[assertMembershipLevel(level)];
}

export function membershipPlanList(): MembershipPlan[] {
  return [membershipPlans.freedom, membershipPlans.democracy, membershipPlans.spark];
}
