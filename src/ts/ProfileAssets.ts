import { API } from './API'

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
