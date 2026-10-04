import type { Env, IdentityLevel } from './types';
import { readUsersByCidNumbers } from './account/user_repository';
import { batchMemberships, subscriptionIsActive } from './membership/service';
import type { MembershipLevel } from './membership/plans';
import { readProfileDoc } from './profiles/repository';

/// 帖子作者展示信号（公开）：徽章身份/会员 + 展示名 + 头像对象键。
/// identity_level 是链上身份档（visitor/voting/candidate）；membership_level 是
/// 已购买会员档（freedom/democracy/spark），二者已彻底解耦（ADR-037）。
/// display_name / avatar_object_key 取自 D1 `user_profiles`，供 feed 直出真名和真头像。
export interface AuthorSignals {
  identity_level: IdentityLevel;
  membership_level: MembershipLevel | null;
  membership_active: boolean;
  display_name: string;
  avatar_object_key: string | null;
}

/// 为一页帖子的去重作者集统一解析徽章信号,返回 Map(键 = 身份主键 cid_number)。
///
/// 三项全部按**身份主键 cid_number** 批量读 D1：用户投影、会员镜像和公开资料。
/// **不得按 post 行的 account_id 解析身份**——那只是发帖当时的签名账户，作者换绑后
/// 历史内容仍归永久 CID。普通 Feed 请求不得读取链或身份 KV 缓存。
export async function resolveAuthorSignals(
  env: Env,
  authors: { cid_number: string; account_id: string }[]
): Promise<Map<string, AuthorSignals>> {
  const map = new Map<string, AuthorSignals>();
  // 按身份主键 cid_number 去重(同一身份多帖只解析一次)。
  const cidList = [...new Set(authors.map((author) => author.cid_number))];
  if (cidList.length === 0) {
    return map;
  }
  const [userMap, membershipMap, profiles] = await Promise.all([
    readUsersByCidNumbers(env, cidList),
    batchMemberships(env, cidList),
    // 去重作者的 D1 资料并行读；缺失（用户投影未建立）软降级为空名 + 无头像。
    Promise.all(cidList.map((cidNumber) => readProfileDoc(env, cidNumber).catch(() => null)))
  ]);
  cidList.forEach((cidNumber, index) => {
    const membership = membershipMap.get(cidNumber);
    const profile = profiles[index];
    const user = userMap.get(cidNumber);
    map.set(cidNumber, {
      identity_level: user?.identity_level ?? 'visitor',
      membership_level: (membership?.membership_level ?? null) as MembershipLevel | null,
      membership_active: membership ? subscriptionIsActive(membership) : false,
      display_name: profile?.display_name ?? '',
      avatar_object_key: profile?.avatar_object_key ?? null
    });
  });
  return map;
}
