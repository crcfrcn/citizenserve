import { describe, expect, it } from 'vitest';
import {
  getUserFollowsRoute,
  getUserPostsRoute,
  getUserProfileRoute,
  putProfileRoute
} from '../src/profiles/service';
import { setFollowNotifyRoute } from '../src/feeds/follows';
import { readProfileDoc, writeProfileDoc } from '../src/profiles/repository';
import type { CitizenProfileDoc, Env, SessionState, UserProfileRow, UserRow } from '../src/types';

// 社交面统一按身份主键 cid_number 寻址(F1):路由第三参 = 目标 cid_number(不再是 account_id)。
const accountId = '0x1111111111111111111111111111111111111111111111111111111111111111';
const viewer = '0x2222222222222222222222222222222222222222222222222222222222222222';
// 账户↔CID 固定映射:身份主键 = cid_number(换绑不丢),归属数据全部按 cid 存取。
const targetCid = 'CN001-CTZN-000000001-2026'; // accountId 绑定的 CID
const viewerCid = 'CN220-CTZN2-198805200-2026'; // viewer 绑定的 CID(= 标准会话 CID)
const candidateCid = 'CN001-CTZN-000000009-2026'; // 独立于 targetCid 的另一目标身份主键

interface PostSeed {
  post_id: string;
  account_id: string;
  /// 身份主键:发布者 cid_number(帖子归属键)。
  cid_number: string;
  post_category: 'normal' | 'campaign';
  post_type: 'document' | 'article' | 'video';
  created_at: number;
  post_state: string;
}

interface FollowSeed {
  /// 关注关系双端均为身份主键 cid_number。
  follower_cid_number: string;
  followed_cid_number: string;
  created_at?: number;
  /// 关注即默认开通知（1）；0=对该关注静音。缺省视为 1。
  notify_enabled?: number;
}

describe('citizen profile repository', () => {
  it('round-trips a profile through D1 user_profiles', async () => {
    const env = fakeEnv();
    const doc: CitizenProfileDoc = {
      schema: 'citizenapp.square.profile',
      cid_number: targetCid,
      display_name: '轻节点',
      bio: '链上公民',
      avatar_object_key: `profile/${targetCid}/avatar`,
      avatar_content_hash: 'a'.repeat(64),
      banner_object_key: null,
      banner_content_hash: null,
      updated_at: 123
    };

    await writeProfileDoc(env, doc);
    const loaded = await readProfileDoc(env, targetCid);

    expect(loaded).toMatchObject({
      display_name: '轻节点',
      bio: '链上公民',
      avatar_object_key: `profile/${targetCid}/avatar`,
      updated_at: 123
    });
  });

  it('returns null without a D1 user profile', async () => {
    const env = fakeEnv();
    const missingCid = 'CN001-CTZN-000000099-2026';
    expect(await readProfileDoc(env, missingCid)).toBeNull();
  });
});

describe('GET /square/users/:account', () => {
  it('reports counts, certification and follow state for the viewer', async () => {
    const env = fakeEnv({
      // 目标身份的两条已发布帖(归属键 cid_number = targetCid)。
      posts: [
        published({ post_id: 'p1', created_at: 200 }),
        published({ post_id: 'p2', post_type: 'article', created_at: 100 }),
        published({ post_id: 'v1', post_type: 'video', created_at: 90 }),
        published({ post_id: 'c1', post_category: 'campaign', post_type: 'video', created_at: 80 }),
        published({ post_id: 'c2', post_category: 'campaign', post_type: 'article', created_at: 70 }),
        published({ post_id: 'pending', post_state: 'pending', created_at: 60 })
      ],
      // 认证真源经 finalized 投影进入 D1：主页普通读取只查用户表。
      identity: { identity_level: 'voting', cid_number: targetCid },
      // 购买了民主会员且有效 → 徽章带勾（会员与身份解耦，勾只看会员是否有效）。
      membership: { membership_level: 'democracy' },
      // 关注关系全部按 cid：目标与 viewer 互关，另单向关注一人。
      follows: [
        { follower_cid_number: targetCid, followed_cid_number: 'CN001-CTZN-000000004-2026' },
        { follower_cid_number: targetCid, followed_cid_number: viewerCid },
        { follower_cid_number: viewerCid, followed_cid_number: targetCid }
      ],
      session: { token: 'tok', account_id: viewer }
    });

    const response = await getUserProfileRoute(
      request(`https://w/square/users/${targetCid}`, { authToken: 'tok' }),
      env,
      targetCid
    );
    const body = (await response.json()) as { profile: Record<string, unknown> };

    expect(body.profile).toMatchObject({
      account_id: accountId,
      is_certified: true,
      identity_level: 'voting',
      membership_level: 'democracy',
      membership_active: true,
      cid_number: targetCid,
      is_following: true,
      is_followed_by: true
    });
    expect(body.profile.counts).toEqual({
      following: 2,
      followers: 1,
      mutual_following: 1,
      posts: 1,
      campaigns: 2,
      videos: 1,
      articles: 1
    });
  });

  it('reports identity and membership independently (decoupled)', async () => {
    // 会员与身份解耦（ADR-037）：竞选身份可只买自由会员，两轴各自上报、互不影响。
    const env = fakeEnv({
      identity: { identity_level: 'candidate', cid_number: candidateCid },
      membership: { membership_level: 'freedom' }
    });
    const response = await getUserProfileRoute(
      request(`https://w/square/users/${candidateCid}`, { authToken: 'tok' }),
      env,
      candidateCid
    );
    const body = (await response.json()) as { profile: Record<string, unknown> };
    expect(body.profile).toMatchObject({
      identity_level: 'candidate',
      membership_level: 'freedom',
      membership_active: true
    });
  });

  it('reports a cancelled membership as active until paid_until', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      membership: { membership_level: 'democracy', subscription_status: 'cancelled' }
    });
    const response = await getUserProfileRoute(
      request(`https://w/square/users/${targetCid}`, { authToken: 'tok' }),
      env,
      targetCid
    );
    const body = (await response.json()) as { profile: Record<string, unknown> };
    expect(body.profile).toMatchObject({
      identity_level: 'voting',
      membership_level: 'democracy',
      membership_active: true
    });
  });

  it('keeps a finalized D1 membership confirmed when the old chain clock is stale', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      membership: {
        membership_level: 'democracy',
        chain_observed_at: Date.now() - 16 * 60 * 1000,
      }
    });
    const response = await getUserProfileRoute(
      request(`https://w/square/users/${targetCid}`, { authToken: 'tok' }),
      env,
      targetCid
    );
    const body = (await response.json()) as { profile: Record<string, unknown> };

    expect(body.profile).toMatchObject({
      membership_level: 'democracy',
      membership_active: true
    });
  });

  it('marks a candidate identity account as certified candidate', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'candidate', cid_number: candidateCid }
    });
    const response = await getUserProfileRoute(
      request(`https://w/square/users/${candidateCid}`, { authToken: 'tok' }),
      env,
      candidateCid
    );
    const body = (await response.json()) as { profile: Record<string, unknown> };

    expect(body.profile).toMatchObject({
      is_certified: true,
      identity_level: 'candidate',
      cid_number: candidateCid
    });
  });

  it('未配置链 RPC 时仍从 D1 用户投影返回未认证访客', async () => {
    const env = fakeEnv({ posts: [], follows: [] });
    const response = await getUserProfileRoute(
      request(`https://w/square/users/${targetCid}`, { authToken: 'tok' }),
      env,
      targetCid
    );
    const body = (await response.json()) as { profile: Record<string, unknown> };

    expect(body.profile).toMatchObject({
      account_id: accountId,
      is_certified: false,
      identity_level: 'visitor',
      cid_number: targetCid,
      is_following: false,
      display_name: '',
      membership_active: false
    });
  });
});

describe('PUT /square/profile', () => {
  it('persists display_name and bio for the session cid', async () => {
    const env = fakeEnv({
      session: { token: 'tok', account_id: accountId },
      identity: { identity_level: 'voting', cid_number: targetCid }
    });
    const response = await putProfileRoute(
      request('https://w/square/profile', {
        method: 'PUT',
        authToken: 'tok',
        body: { display_name: '  轻节点  ', bio: '个性签名' }
      }),
      env
    );
    const body = (await response.json()) as { profile: CitizenProfileDoc };

    expect(body.profile.display_name).toBe('轻节点');
    expect(body.profile.bio).toBe('个性签名');
    expect(await readProfileDoc(env, targetCid)).toMatchObject({ display_name: '轻节点' });
  });

  it('rejects an avatar key outside the cid profile directory', async () => {
    const env = fakeEnv({ session: { token: 'tok', account_id: accountId } });
    await expect(
      putProfileRoute(
        request('https://w/square/profile', {
          method: 'PUT',
          authToken: 'tok',
          body: { avatar_object_key: `profile/${viewer}/avatar` }
        }),
        env
      )
    ).rejects.toMatchObject({ code: 'invalid_asset_key' });
  });

  it('rejects a non-fixed avatar key inside the cid profile directory', async () => {
    const env = fakeEnv({ session: { token: 'tok', account_id: accountId } });
    await expect(
      putProfileRoute(
        request('https://w/square/profile', {
          method: 'PUT',
          authToken: 'tok',
          body: { avatar_object_key: `profile/${targetCid}/avatar_extra` }
        }),
        env
      )
    ).rejects.toMatchObject({ code: 'invalid_asset_key' });
  });

  it('rejects a display_name over the length limit', async () => {
    const env = fakeEnv({ session: { token: 'tok', account_id: accountId } });
    await expect(
      putProfileRoute(
        request('https://w/square/profile', {
          method: 'PUT',
          authToken: 'tok',
          body: { display_name: 'x'.repeat(41) }
        }),
        env
      )
    ).rejects.toMatchObject({ code: 'profile_field_too_long' });
  });

  it('rejects an invalid media hash or an incomplete object/hash pair', async () => {
    const env = fakeEnv({ session: { token: 'tok', account_id: accountId } });
    await expect(
      putProfileRoute(
        request('https://w/square/profile', {
          method: 'PUT',
          authToken: 'tok',
          body: {
            avatar_object_key: `profile/${targetCid}/avatar`,
            avatar_content_hash: 'not-a-sha256',
          },
        }),
        env,
      ),
    ).rejects.toMatchObject({ code: 'invalid_profile_content_hash' });
    await expect(
      putProfileRoute(
        request('https://w/square/profile', {
          method: 'PUT',
          authToken: 'tok',
          body: { avatar_object_key: `profile/${targetCid}/avatar` },
        }),
        env,
      ),
    ).rejects.toMatchObject({ code: 'invalid_profile_asset_pair' });
  });
});

describe('GET /square/users/:account/posts', () => {
  it('filters by category and paginates by cursor', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      posts: [
        published({ post_id: 'c1', post_category: 'campaign', created_at: 300 }),
        published({ post_id: 'n1', post_category: 'normal', created_at: 200 }),
        published({ post_id: 'n2', post_category: 'normal', created_at: 100 })
      ]
    });

    const campaign = await readPosts(env, `category=campaign`);
    expect(campaign.posts.map((p) => p.post_id)).toEqual(['c1']);

    const page1 = await readPosts(env, `limit=2`);
    expect(page1.posts.map((p) => p.post_id)).toEqual(['c1', 'n1']);
    expect(page1.next_cursor).toBe(200);

    const page2 = await readPosts(env, `limit=2&cursor=200`);
    expect(page2.posts.map((p) => p.post_id)).toEqual(['n2']);
    expect(page2.next_cursor).toBeNull();
  });

  it('filters articles and documents by post_type', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      posts: [
        published({ post_id: 'a1', post_type: 'article', created_at: 300 }),
        published({ post_id: 'p1', post_type: 'document', created_at: 200 })
      ]
    });

    const articles = await readPosts(env, 'post_type=article');
    expect(articles.posts.map((p) => p.post_id)).toEqual(['a1']);

    const shorts = await readPosts(env, 'category=normal&post_type=document');
    expect(shorts.posts.map((p) => p.post_id)).toEqual(['p1']);
  });

  it('filters videos before pagination and rejects an invalid post_type', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      posts: [
        published({ post_id: 'v2', post_type: 'video', created_at: 400 }),
        published({ post_id: 'p2', created_at: 300 }),
        published({ post_id: 'v1', post_type: 'video', created_at: 200 }),
        published({ post_id: 'p1', created_at: 100 })
      ]
    });

    const videos = await readPosts(env, 'category=normal&post_type=video&limit=1');
    expect(videos.posts.map((p) => p.post_id)).toEqual(['v2']);
    expect(videos.next_cursor).toBe(400);

    const posts = await readPosts(env, 'category=normal&post_type=document');
    expect(posts.posts.map((p) => p.post_id)).toEqual(['p2', 'p1']);

    await expect(readPosts(env, 'post_type=unknown')).rejects.toMatchObject({
      code: 'invalid_post_type'
    });
  });

  async function readPosts(
    env: Env,
    query: string
  ): Promise<{ posts: Array<{ post_id: string }>; next_cursor: number | null }> {
    const response = await getUserPostsRoute(
      request(`https://w/square/users/${targetCid}/posts?${query}`, { authToken: 'tok' }),
      env,
      targetCid
    );
    return (await response.json()) as {
      posts: Array<{ post_id: string }>;
      next_cursor: number | null;
    };
  }
});

describe('GET /square/users/:account/follows', () => {
  it('lists following, followers and mutual following ordered by recency', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      follows: [
        { follower_cid_number: targetCid, followed_cid_number: 'CN001-CTZN-000000004-2026', created_at: 100 },
        { follower_cid_number: 'CN001-CTZN-000000004-2026', followed_cid_number: targetCid, created_at: 150 },
        { follower_cid_number: targetCid, followed_cid_number: 'CN001-CTZN-000000005-2026', created_at: 200 },
        { follower_cid_number: 'CN001-CTZN-000000006-2026', followed_cid_number: targetCid, created_at: 300 }
      ]
    });

    // 列表项为身份主键 cid_number(响应字段 entries)。
    const following = await readFollows(env, 'type=following');
    expect(following.entries.map((e) => e.cid_number)).toEqual([
      'CN001-CTZN-000000005-2026',
      'CN001-CTZN-000000004-2026'
    ]);

    const followers = await readFollows(env, 'type=followers');
    expect(followers.entries.map((e) => e.cid_number)).toEqual([
      'CN001-CTZN-000000006-2026',
      'CN001-CTZN-000000004-2026'
    ]);

    const mutual = await readFollows(env, 'type=mutual_following');
    expect(mutual.entries).toEqual([
      { cid_number: 'CN001-CTZN-000000004-2026', created_at: 150 }
    ]);
  });

  it('rejects an unknown follow list type instead of silently falling back', async () => {
    const env = fakeEnv();
    await expect(readFollows(env, 'type=unknown')).rejects.toMatchObject({
      code: 'invalid_follow_type'
    });
  });

  async function readFollows(
    env: Env,
    query: string
  ): Promise<{
    entries: Array<{ cid_number: string; created_at: number }>;
    next_cursor: number | null;
  }> {
    const response = await getUserFollowsRoute(
      request(`https://w/square/users/${targetCid}/follows?${query}`, { authToken: 'tok' }),
      env,
      targetCid
    );
    return (await response.json()) as {
      entries: Array<{ cid_number: string; created_at: number }>;
      next_cursor: number | null;
    };
  }
});

describe('post notify (is_notifying + PUT .../notify)', () => {
  it('reports is_notifying true when following with notify enabled (default)', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      follows: [{ follower_cid_number: viewerCid, followed_cid_number: targetCid }],
      session: { token: 'tok', account_id: viewer }
    });
    const body = await readProfile(env);
    expect(body.profile).toMatchObject({ is_following: true, is_notifying: true });
  });

  it('reports is_notifying false when following but muted', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      follows: [
        { follower_cid_number: viewerCid, followed_cid_number: targetCid, notify_enabled: 0 }
      ],
      session: { token: 'tok', account_id: viewer }
    });
    const body = await readProfile(env);
    expect(body.profile).toMatchObject({ is_following: true, is_notifying: false });
  });

  it('reports is_notifying false when not following', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      follows: [],
      session: { token: 'tok', account_id: viewer }
    });
    const body = await readProfile(env);
    expect(body.profile).toMatchObject({ is_following: false, is_notifying: false });
  });

  it('PUT .../notify accepts a boolean and echoes the new state', async () => {
    const env = fakeEnv({
      identity: { identity_level: 'voting', cid_number: targetCid },
      follows: [{ follower_cid_number: viewerCid, followed_cid_number: targetCid }],
      session: { token: 'tok', account_id: viewer }
    });
    const response = await setFollowNotifyRoute(
      request(`https://w/square/follows/${targetCid}/notify`, {
        method: 'PUT',
        authToken: 'tok',
        body: { enabled: false }
      }),
      env
    );
    const body = (await response.json()) as { ok: boolean; notify_enabled: boolean };
    expect(body).toMatchObject({ ok: true, notify_enabled: false });
  });

  it('PUT .../notify rejects a non-boolean enabled', async () => {
    const env = fakeEnv({ session: { token: 'tok', account_id: viewer } });
    await expect(
      setFollowNotifyRoute(
        request(`https://w/square/follows/${targetCid}/notify`, {
          method: 'PUT',
          authToken: 'tok',
          body: { enabled: 'yes' }
        }),
        env
      )
    ).rejects.toMatchObject({ code: 'invalid_enabled' });
  });

  async function readProfile(env: Env): Promise<{ profile: Record<string, unknown> }> {
    const response = await getUserProfileRoute(
      request(`https://w/square/users/${targetCid}`, { authToken: 'tok' }),
      env,
      targetCid
    );
    return (await response.json()) as { profile: Record<string, unknown> };
  }
});

function published(overrides: Partial<PostSeed> & Pick<PostSeed, 'post_id'>): PostSeed {
  return {
    account_id: accountId,
    cid_number: targetCid,
    post_category: 'normal',
    post_type: 'document',
    created_at: 0,
    post_state: 'published',
    ...overrides
  };
}

interface FakeEnvOptions {
  posts?: PostSeed[];
  follows?: FollowSeed[];
  session?: { token: string; account_id: string };
  /// 预置目标 cid 的 D1 finalized 身份档位；缺省为已注册的 visitor 用户。
  identity?: { identity_level: 'visitor' | 'voting' | 'candidate'; cid_number?: string | null };
  /// 预置 accountId 的会员购买（对应 D1 square_memberships 一行）；缺省=未购买（无行）。
  membership?: {
    membership_level: 'freedom' | 'democracy' | 'spark';
    subscription_status?: string;
    paid_until?: number;
    chain_timestamp?: number | null;
    chain_observed_at?: number | null;
  };
}

/// 会话身份主键 = D1 用户投影中账户绑定的 cid_number。
function cidForAccount(account: string): string {
  return account === accountId ? targetCid : viewerCid;
}

function fakeEnv(options: FakeEnvOptions = {}): Env {
  const posts = options.posts ?? [];
  const follows = options.follows ?? [];
  const kv = new Map<string, unknown>();
  const sessionToken = options.session?.token ?? 'tok';
  if (sessionToken !== 'tok') {
    throw new Error('profiles fixture only supports token=tok');
  }
  const sessionAccount = options.session?.account_id ?? viewer;
  const session: SessionState = {
    cid_number: cidForAccount(sessionAccount),
    binding_revision: 1,
    account_id: sessionAccount,
    device_key_hash: 'a'.repeat(64),
    created_at: 0,
    expires_at: Date.now() + 60_000
  };
  // 本文件所有鉴权请求固定使用 token=tok；KV 键只保存 token 的 SHA-256。
  kv.set(
    'square_session:1a7674eb4ee78df7e1ac439a93c3fa8e3c945784d4dec9fd8e3011738b2f1d62',
    session
  );
  const users = new Map<string, UserRow>([
    [targetCid, projectedUser(targetCid, accountId, 'visitor')],
    [viewerCid, projectedUser(viewerCid, viewer, 'visitor')],
    [candidateCid, projectedUser(candidateCid, accountId, 'visitor')],
  ]);
  if (options.identity?.cid_number) {
    users.set(
      options.identity.cid_number,
      projectedUser(options.identity.cid_number, accountId, options.identity.identity_level),
    );
  }

  const membershipRow = options.membership
    ? {
        // 身份主键 cid_number = D1 用户投影中的目标用户（buildProfileResponse 按此查会员）。
        cid_number: options.identity?.cid_number ?? null,
        account_id: accountId,
        membership_level: options.membership.membership_level,
        subscription_status: options.membership.subscription_status ?? 'active',
        paid_until: options.membership.paid_until ?? Date.now() + 60_000,
        chain_timestamp: options.membership.chain_timestamp === undefined
          ? Date.now()
          : options.membership.chain_timestamp,
        chain_observed_at: options.membership.chain_observed_at === undefined
          ? Date.now()
          : options.membership.chain_observed_at
      }
    : null;
  const profiles = new Map(
    [targetCid, viewerCid, candidateCid].map((cidNumber) => [
      cidNumber,
      emptyProfileRow(cidNumber),
    ]),
  );

  return {
    DB: new FakeDb(posts, follows, membershipRow, profiles, users) as unknown as D1Database,
    SQUARE_PRIVATE: new FakeR2() as unknown as R2Bucket,
    SQUARE_PUBLIC_MEDIA: new FakeR2() as unknown as R2Bucket,
    SQUARE_CACHE: new FakeKv(kv) as unknown as KVNamespace
  } as unknown as Env;
}

function emptyProfileRow(cidNumber: string): UserProfileRow {
  return {
    cid_number: cidNumber,
    display_name: '',
    bio: '',
    avatar_object_key: null,
    avatar_content_hash: null,
    banner_object_key: null,
    banner_content_hash: null,
    updated_at: 0,
  };
}

function projectedUser(
  cidNumber: string,
  account: string,
  identityLevel: UserRow['identity_level'],
): UserRow {
  return {
    cid_number: cidNumber,
    account_id: account,
    binding_revision: 1,
    identity_level: identityLevel,
    registration_finalized_block_number: 1,
    registration_finalized_block_hash: `0x${'1'.repeat(64)}`,
    binding_finalized_block_number: 1,
    binding_finalized_block_hash: `0x${'1'.repeat(64)}`,
    identity_finalized_block_number: 1,
    identity_finalized_block_hash: `0x${'1'.repeat(64)}`,
    registered_at: 1,
    binding_updated_at: 1,
    identity_updated_at: 1,
  };
}

function request(
  url: string,
  init: { method?: string; authToken?: string; body?: unknown } = {}
): Request {
  const headers = new Headers();
  if (init.authToken) {
    headers.set('authorization', `Bearer ${init.authToken}`);
  }
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Request(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  });
}

class FakeR2 {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const value = this.store.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (typeof value === 'string') {
      this.store.set(key, value);
      return;
    }
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.store.set(key, new TextDecoder().decode(bytes));
  }
}

class FakeKv {
  constructor(private readonly store: Map<string, unknown>) {}

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
}

class FakeDb {
  constructor(
    private readonly posts: PostSeed[],
    private readonly follows: FollowSeed[],
    private readonly membership: Record<string, unknown> | null,
    private readonly profiles: Map<string, UserProfileRow>,
    private readonly users: Map<string, UserRow>,
  ) {}

  prepare(sql: string): FakeStmt {
    return new FakeStmt(this.posts, this.follows, this.membership, this.profiles, this.users, sql);
  }
}

class FakeStmt {
  private binds: unknown[] = [];

  constructor(
    private readonly posts: PostSeed[],
    private readonly follows: FollowSeed[],
    private readonly membership: Record<string, unknown> | null,
    private readonly profiles: Map<string, UserProfileRow>,
    private readonly users: Map<string, UserRow>,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]): FakeStmt {
    this.binds = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql;
    const b0 = this.binds[0] as string;

    if (sql.includes('FROM users') && sql.includes('WHERE cid_number = ?')) {
      return (this.users.get(b0) as T | undefined) ?? null;
    }

    if (sql.includes('FROM user_profiles')) {
      return (this.profiles.get(b0) as T | undefined) ?? null;
    }

    // 会员按身份主键 cid_number 命中（getMembership 绑定目标 cid）。
    if (sql.includes('square_memberships')) {
      const m = this.membership;
      return m && m.cid_number === b0 ? (m as T) : null;
    }

    // isFollowing / isNotifying：关注关系双端 cid（follower + followed），非计数。
    if (
      sql.includes('square_follows') &&
      sql.includes('follower_cid_number = ?') &&
      sql.includes('followed_cid_number = ?')
    ) {
      const b1 = this.binds[1] as string;
      const follow = this.follows.find(
        (f) => f.follower_cid_number === b0 && f.followed_cid_number === b1
      );
      // isNotifying 读 notify_enabled；isFollowing 读 1 AS n。
      if (sql.includes('notify_enabled')) {
        return follow ? ({ notify_enabled: follow.notify_enabled ?? 1 } as T) : null;
      }
      return follow ? ({ n: 1 } as T) : null;
    }
    // 互关数：目标主动关注与对方反向关注同时存在才计一次。
    if (sql.includes('COUNT(*)') && sql.includes('INNER JOIN square_follows inbound')) {
      const outbound = this.follows.filter((f) => f.follower_cid_number === b0);
      return {
        n: outbound.filter((f) => this.follows.some(
          (reverse) => reverse.follower_cid_number === f.followed_cid_number &&
            reverse.followed_cid_number === b0
        )).length
      } as T;
    }
    // 粉丝数：followed_cid_number = ? 命中该身份被关注的条数。
    if (sql.includes('COUNT(*)') && sql.includes('square_follows') &&
      sql.includes('followed_cid_number = ?')) {
      return { n: this.follows.filter((f) => f.followed_cid_number === b0).length } as T;
    }
    // 关注数：follower_cid_number = ? 命中该身份主动关注的条数。
    if (sql.includes('COUNT(*)') && sql.includes('square_follows') &&
      sql.includes('follower_cid_number = ?')) {
      return { n: this.follows.filter((f) => f.follower_cid_number === b0).length } as T;
    }
    // 四类内容按竞选、文章、视频、帖子互斥聚合，模拟真实 D1 条件聚合。
    if (sql.includes('COALESCE(SUM(CASE') && sql.includes('square_posts')) {
      const visible = this.posts.filter(
        (p) => p.cid_number === b0 && p.post_state === 'published'
      );
      return {
        posts: visible.filter(
          (p) => p.post_category === 'normal' && p.post_type === 'document'
        ).length,
        campaigns: visible.filter((p) => p.post_category === 'campaign').length,
        videos: visible.filter(
          (p) => p.post_category === 'normal' && p.post_type === 'video'
        ).length,
        articles: visible.filter(
          (p) => p.post_category === 'normal' && p.post_type === 'article'
        ).length
      } as T;
    }
    if (sql.includes('FROM square_uploads')) {
      return null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM users') && this.sql.includes('WHERE cid_number IN')) {
      return {
        results: this.binds
          .map((cidNumber) => this.users.get(cidNumber as string))
          .filter((row): row is UserRow => row !== undefined) as T[],
      };
    }
    // 批量会员：按身份主键 cid_number IN(...) 命中；测试仅置一行。
    if (this.sql.includes('square_memberships')) {
      const cidNumbers = this.binds as string[];
      const rows = this.membership && cidNumbers.includes(this.membership.cid_number as string)
        ? [this.membership]
        : [];
      return { results: rows as unknown as T[] };
    }
    if (this.sql.includes('FROM square_media_assets')) {
      return { results: [] as T[] };
    }

    if (this.sql.includes('INNER JOIN square_follows inbound')) {
      let fi = 0;
      const key = this.binds[fi++] as string;
      const cursor = this.sql.includes('MAX(outbound.created_at, inbound.created_at) < ?')
        ? (this.binds[fi++] as number)
        : null;
      const limit = this.binds[fi++] as number;
      const rows = this.follows
        .filter((outbound) => outbound.follower_cid_number === key)
        .flatMap((outbound) => {
          const inbound = this.follows.find(
            (candidate) => candidate.follower_cid_number === outbound.followed_cid_number &&
              candidate.followed_cid_number === key
          );
          if (!inbound) return [];
          return [{
            cid_number: outbound.followed_cid_number,
            created_at: Math.max(outbound.created_at ?? 0, inbound.created_at ?? 0)
          }];
        })
        .filter((row) => (cursor !== null ? row.created_at < cursor : true))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
      return { results: rows as unknown as T[] };
    }

    if (this.sql.includes('FROM square_follows')) {
      // following: WHERE follower_cid_number = ?（选 followed 列）；followers 反之。
      const isFollowing = this.sql.includes('follower_cid_number = ?');
      let fi = 0;
      const key = this.binds[fi++] as string;
      const cursor = this.sql.includes('created_at < ?')
        ? (this.binds[fi++] as number)
        : null;
      const limit = this.binds[fi++] as number;
      const rows = this.follows
        .filter((f) =>
          isFollowing ? f.follower_cid_number === key : f.followed_cid_number === key
        )
        .map((f) => ({
          cid_number: isFollowing ? f.followed_cid_number : f.follower_cid_number,
          created_at: f.created_at ?? 0
        }))
        .filter((r) => (cursor !== null ? r.created_at < cursor : true))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
      return { results: rows as unknown as T[] };
    }

    // listAuthorPosts：按身份主键 cid_number 过滤已发布帖。
    let i = 0;
    const cidNumber = this.binds[i++] as string;
    const category = this.sql.includes('post_category = ?')
      ? (this.binds[i++] as string)
      : null;
    const postType = this.sql.includes('post_type = ?')
      ? (this.binds[i++] as string)
      : null;
    const cursor = this.sql.includes('created_at < ?')
      ? (this.binds[i++] as number)
      : null;
    const limit = this.binds[i++] as number;

    const results = this.posts
      .filter((p) => p.cid_number === cidNumber && p.post_state === 'published')
      .filter((p) => (category ? p.post_category === category : true))
      .filter((p) => (postType ? p.post_type === postType : true))
      .filter((p) => (cursor !== null ? p.created_at < cursor : true))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);

    return { results: results as unknown as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes('UPDATE user_profiles')) {
      const cidNumber = this.binds[7] as string;
      const current = this.profiles.get(cidNumber);
      if (!current) return { meta: { changes: 0 } };
      this.profiles.set(cidNumber, {
        cid_number: cidNumber,
        display_name: this.binds[0] as string,
        bio: this.binds[1] as string,
        avatar_object_key: this.binds[2] as string | null,
        avatar_content_hash: this.binds[3] as string | null,
        banner_object_key: this.binds[4] as string | null,
        banner_content_hash: this.binds[5] as string | null,
        updated_at: this.binds[6] as number,
      });
    }
    return { meta: { changes: 1 } };
  }
}
