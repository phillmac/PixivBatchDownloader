import { API } from '../API'
import { pageType } from '../PageType'
import { getBookmarkQuery } from '../crawlMixedPage/BookmarkQuery'

/** 从 PPBD 收藏 API 获取权威过滤总数，不改变抓取或设置。 */
export async function getAutomationBookmarkInfo() {
  if (pageType.type !== pageType.list.Bookmark) {
    throw new Error('bookmark info is available only on Bookmark pages')
  }
  const query = getBookmarkQuery()
  const data = await API.getBookmarkData(
    query.userId,
    query.type,
    query.tag,
    0,
    query.rest === 'hide',
    query.order,
    query.mode,
    query.work_tag,
    query.bm,
    1
  )
  if (getBookmarkQuery().currentUrl !== query.currentUrl) {
    throw new Error('Bookmark page changed during info lookup')
  }
  if (
    data.error ||
    !Number.isSafeInteger(data.body?.total) ||
    data.body.total < 0
  ) {
    throw new Error('invalid bookmark total')
  }
  return {
    apiVersion: 1,
    ...query,
    total: data.body.total,
    lastPage: Math.max(1, Math.ceil(data.body.total / query.uiPageSize)),
  }
}

/** SPA 切换后也仅在真实收藏页面提供只读函数。 */
Object.defineProperty(globalThis, '__PBD_AUTOMATION_BOOKMARK_INFO__', {
  configurable: true,
  get: () => {
    if (pageType.type !== pageType.list.Bookmark) return undefined
    try {
      getBookmarkQuery()
      return getAutomationBookmarkInfo
    } catch {
      return undefined
    }
  },
})
