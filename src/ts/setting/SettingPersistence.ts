/** 设置存储协议；所有内容脚本的写入由后台串行处理。 */
export const SETTING_PATCH_MESSAGE = 'ppbd_setting_patch'

/** 合并设置补丁，保留未修改的设置与其他页面的抓取限制。 */
export function mergeSettingPatch(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
  crawlPage?: number
) {
  const next = { ...stored, ...patch }
  if (patch.crawlNumber !== undefined) {
    next.crawlNumber = {
      ...(stored.crawlNumber as object),
      ...(crawlPage === undefined
        ? (patch.crawlNumber as object)
        : { [crawlPage]: patch.crawlNumber }),
    }
  }
  return next
}

/** storage 对象键顺序不属于值语义；验证时使用稳定的序列化顺序。 */
export function canonicalSettingValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const object = item as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, object[key]])
      )
    }
    return item
  })
}
