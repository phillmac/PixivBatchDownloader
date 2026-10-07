import { API } from './API'
import { getImg } from './utils/GetImage'
import { Utils } from './utils/Utils'

/** 自动化和用户功能共享的头像元数据。 */
export interface ProfileAvatarMetadata {
  sourceUrl: string
  downloadUrl: string
  versionKey: string
  isDefault: boolean
}

/** 自动化和用户功能共享的主页背景元数据。 */
export interface ProfileBackgroundMetadata {
  sourceUrl: string
  versionKey: string
  isPrivate: boolean
}

/** 从 Pixiv 用户资料接口提取的稳定资源元数据。 */
export interface ProfileAssetMetadata {
  userId: string
  name: string
  avatar: ProfileAvatarMetadata
  background: ProfileBackgroundMetadata | null
}

/** 自动化可请求的用户资源类型。 */
export type ProfileAssetKind = 'avatar' | 'background'

/** 从浏览器上下文读取、供外部自动化持久化的资源内容。 */
export interface ProfileAssetPayload {
  userId: string
  kind: ProfileAssetKind
  sourceUrl: string
  versionKey: string
  contentType: string
  byteLength: number
  dataUrl: string
}

/** 自动化单个用户资源允许返回的最大体积，避免异常响应撑爆 CDP 消息。 */
const maxAutomationAssetBytes = 16 * 1024 * 1024

/** 把 Pixiv 的 170px 头像地址转换为现有保存功能使用的最大尺寸地址。 */
export function profileAvatarDownloadUrl(imageBig: string) {
  const path = imageBig.split(/[?#]/, 1)[0]
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === 'gif') {
    return imageBig
  }
  return imageBig.replace(/_170(?=\.[^./?#]+(?:[?#]|$))/, '')
}

/** 获取一个 Pixiv 用户的头像和主页背景元数据，不下载文件。 */
export async function getProfileAssetMetadata(
  userId: string
): Promise<ProfileAssetMetadata> {
  const profile = await API.getUserProfile(userId)
  if (profile.error) {
    throw new Error(
      profile.message || `Pixiv user profile request failed: ${userId}`
    )
  }

  const body = profile.body
  const avatarSourceUrl = body.imageBig
  const avatarDownloadUrl = profileAvatarDownloadUrl(avatarSourceUrl)
  const backgroundUrl = body.background?.url || null

  return {
    userId: body.userId,
    name: body.name,
    avatar: {
      sourceUrl: avatarSourceUrl,
      downloadUrl: avatarDownloadUrl,
      versionKey: avatarDownloadUrl,
      isDefault: /\/common\/images\/no_profile(?:_[^/]*)?\./.test(
        avatarSourceUrl
      ),
    },
    background: backgroundUrl
      ? {
          sourceUrl: backgroundUrl,
          versionKey: backgroundUrl,
          isPrivate: body.background?.isPrivate === true,
        }
      : null,
  }
}

/** 获取并编码指定用户资源；资源缺失时返回 null，网络失败会进行有限次数重试。 */
export async function getProfileAssetPayload(
  userId: string,
  kind: ProfileAssetKind,
  expectedVersionKey?: string,
  attempts = 3
): Promise<ProfileAssetPayload | null> {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new RangeError('attempts must be an integer between 1 and 5')
  }

  const metadata = await getProfileAssetMetadata(userId)
  const asset = kind === 'avatar' ? metadata.avatar : metadata.background
  if (!asset) {
    return null
  }
  const sourceUrl =
    kind === 'avatar' ? metadata.avatar.downloadUrl : asset.sourceUrl
  if (expectedVersionKey && asset.versionKey !== expectedVersionKey) {
    throw new Error(`profile ${kind} version changed before materialization`)
  }

  let blob: Blob | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    blob = await getImg(sourceUrl, false)
    if (blob) {
      break
    }
    if (attempt < attempts) {
      await Utils.sleep(250 * attempt)
    }
  }
  if (!blob) {
    throw new Error(
      `failed to fetch profile ${kind} after ${attempts} attempts`
    )
  }
  if (blob.size > maxAutomationAssetBytes) {
    throw new Error(
      `profile ${kind} exceeds automation size limit: ${blob.size} bytes`
    )
  }

  return {
    userId: metadata.userId,
    kind,
    sourceUrl,
    versionKey: asset.versionKey,
    contentType: blob.type || 'application/octet-stream',
    byteLength: blob.size,
    dataUrl: await Utils.blobToDataURL(blob),
  }
}
