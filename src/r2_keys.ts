import { assertCidNumber } from './shared/ids';

export interface ObjectKeyPlan {
  manifest_object_key: string;
}

export type SquareDerivativeKind = 'thumbnail' | 'cover';

/// 头像/背景 R2 object key 前缀(按身份主键 cid_number);本人上传的头像与背景对象必须落在此前缀下。
export function profileAssetPrefix(cidNumber: string): string {
  return `profile/${assertCidNumber(cidNumber)}/`;
}

export function buildObjectKeyPlan(
  cidNumber: string,
  postId: string
): ObjectKeyPlan {
  const basePath = squarePostPrefix(cidNumber, postId);
  const manifestObjectKey = `${basePath}/manifest.json`;

  return {
    manifest_object_key: manifestObjectKey,
  };
}

/** 广场媒体对象键只由服务端生成，客户端不能提交路径或文件名。 */
export function squareMediaObjectKeys(input: {
  cid_number: string;
  post_id: string;
  media_index: number;
  media_kind: 'image' | 'video';
}): { object_key: string; derivative_kind: SquareDerivativeKind; derivative_object_key: string } {
  if (!Number.isSafeInteger(input.media_index) || input.media_index < 0) {
    throw new Error('invalid media index');
  }
  const prefix = `${squarePostPrefix(input.cid_number, input.post_id)}/media/${input.media_index}`;
  const derivativeKind = input.media_kind === 'video' ? 'cover' : 'thumbnail';
  return {
    object_key: `${prefix}/source.${input.media_kind === 'video' ? 'mp4' : 'webp'}`,
    derivative_kind: derivativeKind,
    derivative_object_key: `${prefix}/${derivativeKind}.webp`,
  };
}

/// 广场 R2 只保存唯一规范 manifest；路径由永久 CID 和 post_id 确定，
/// 钱包换绑不得改变或迁移对象键。
export function manifestObjectKey(row: {
  cid_number: string;
  post_id: string;
}): string {
  return buildObjectKeyPlan(row.cid_number, row.post_id).manifest_object_key;
}

function squarePostPrefix(cidNumber: string, postId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(postId)) throw new Error('invalid post id');
  return `square/${assertCidNumber(cidNumber)}/posts/${postId}`;
}
