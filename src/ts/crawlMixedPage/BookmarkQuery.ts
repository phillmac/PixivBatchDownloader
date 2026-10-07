import { Tools } from '../Tools'
import { Utils } from '../utils/Utils'

/** 收藏抓取与只读自动化共用的 URL 解释。 */
export function getBookmarkQuery(url: string = location.href) {
  const parsed = new URL(url)
  const userId = parsed.pathname.match(/\/users\/(\d+)\/bookmarks\//)?.[1]
  if (
    !userId ||
    !/\/bookmarks\/(artworks|novels)(\/|$)/.test(parsed.pathname)
  ) {
    throw new Error('expected a real artwork or novel Bookmark page')
  }
  const type = parsed.pathname.includes('/novels') ? 'novels' : 'illusts'
  const uiPageSize = type === 'novels' ? 30 : 48
  const page = Math.max(
    1,
    Number.parseInt(Utils.getURLSearchField(url, 'p')) || 1
  )
  const query = {
    userId,
    type: type as 'illusts' | 'novels',
    bookmarkType: type === 'novels' ? 'novels' : 'artworks',
    tag: Tools.getTagFromURL(url),
    rest: Utils.getURLSearchField(url, 'rest') === 'hide' ? 'hide' : 'show',
    order: (Utils.getURLSearchField(url, 'order') || 'desc') as 'desc' | 'asc',
    mode: (Utils.getURLSearchField(url, 'mode') || 'all') as
      'all' | 'safe' | 'r18',
    work_tag: Utils.getURLSearchField(url, 'work_tag') || '',
    bm: Utils.getURLSearchField(url, 'bm').replaceAll('-', '') || '',
  }
  parsed.hash = ''
  const currentUrl = parsed.href
  parsed.searchParams.delete('p')
  return {
    ...query,
    currentUrl,
    canonicalUrl: parsed.href,
    queryIdentity: JSON.stringify(query),
    uiPageSize,
    page,
    offset: (page - 1) * uiPageSize,
  }
}
