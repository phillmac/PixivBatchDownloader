import { EVT } from '../EVT'
import { store } from '../store/Store'
import { states } from '../store/States'
import {
  CrawlGeneration,
  currentCrawl,
  ownsCrawl,
  revokeCrawl,
} from '../crawl/CrawlGeneration'

/** 托管抓取终态；aborted 表示写入权限已撤销，迟到网络响应不能再改变队列。 */
export type ManagedCrawlState =
  | 'armed'
  | 'crawling'
  | 'completed'
  | 'aborted'
  | 'skipped-work-count'
  | 'skipped-id-list'
/** 单次托管操作及绑定的抓取所有权。 */
type ManagedOperation = {
  operationId: string
  url: string
  generation: CrawlGeneration | null
  state: ManagedCrawlState
  armedAt: string
  startedAt: string | null
  completedAt: string | null
  abortedAt: string | null
}
/** 已消费的操作。 */
let operation: ManagedOperation | null = null
/** 下一次精确 URL 抓取的武装。 */
let armed: ManagedOperation | null = null
/** 内容脚本内的操作序号。 */
let sequence = 0
/** 终止过托管抓取的文档不再复用；刷新页面会重建模块状态。 */
let reloadRequired = false
/** 当前文档是否必须刷新后才能开始新的托管抓取。 */
export function managedCrawlRequiresReload() {
  return reloadRequired
}
/** 忽略 URL fragment，与任务 URL 规则保持一致。 */
function normalizeUrl(url: string) {
  return url.split('#')[0]
}
/** 获取抓取绑定 URL，不受 SPA 路由变化影响。 */
function taskUrl() {
  return normalizeUrl(store.URLWhenCrawlStart || window.location.href)
}
/** 武装下一次匹配 URL 的真实抓取。 */
export function armManagedCrawl(url: string) {
  if (typeof url !== 'string' || !/^https:\/\/www\.pixiv\.net\//.test(url))
    throw new Error('expected an exact Pixiv URL')
  const expectedUrl = normalizeUrl(url)
  if (normalizeUrl(window.location.href) !== expectedUrl)
    throw new Error('managed crawl URL does not match the live page')
  if (reloadRequired)
    throw new Error('reload required after terminal managed crawl')
  if (states.busy || operation?.state === 'crawling')
    throw new Error('cannot arm while a crawl is active')
  armed = {
    operationId: `${Date.now()}-${++sequence}`,
    url: expectedUrl,
    generation: null,
    state: 'armed',
    armedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    abortedAt: null,
  }
  return { ...armed }
}
/** 返回操作的独立快照。 */
export function getManagedCrawl() {
  return operation ? { ...operation } : null
}
/** 返回待消费武装的独立快照。 */
export function getManagedCrawlArm() {
  return armed ? { ...armed } : null
}
/** 终止的部分队列不允许下载，已完成队列保持可下载。 */
export function managedCrawlBlocksDownload(
  url = store.URLWhenCrawlStart || window.location.href
) {
  return (
    !!operation &&
    ['aborted', 'skipped-work-count', 'skipped-id-list'].includes(
      operation.state
    ) &&
    operation.url === normalizeUrl(url)
  )
}
/** 同步撤销写入权限；终止事件只用于推进等待的快速抓取队列。 */
function terminate(
  owned: ManagedOperation,
  state: 'aborted' | 'skipped-work-count' | 'skipped-id-list'
) {
  if (owned.generation !== null) revokeCrawl(owned.generation)
  owned.state = state
  owned.abortedAt = new Date().toISOString()
  reloadRequired = true
  // 等 stopCrawl 的同步监听器结束后再推进等待队列。抓取代数已经撤销，
  // 因此迟到 worker 即使尚未返回也不能污染下一任务。
  queueMicrotask(() => {
    if (operation === owned) EVT.fire('managedCrawlTerminal')
  })
}
/** 标记明确的非元数据停止原因，在真实 stopCrawl 前撤销权限。 */
export function skipManagedCrawl(
  reason: 'skipped-work-count' | 'skipped-id-list'
) {
  if (
    operation?.state === 'crawling' &&
    operation.generation !== null &&
    ownsCrawl(operation.generation) &&
    operation.url === taskUrl()
  ) {
    terminate(operation, reason)
    return true
  }
  return false
}
/** 比较全部所有权后同步撤销，再通知物理 worker 停止。 */
export async function abortManagedCrawl(
  operationId: string,
  expectedUrl: string,
  expectedGeneration?: CrawlGeneration
) {
  const owned = operation?.operationId === operationId ? operation : armed
  if (
    !owned ||
    owned.operationId !== operationId ||
    typeof expectedUrl !== 'string' ||
    owned.url !== normalizeUrl(expectedUrl) ||
    (expectedGeneration !== undefined &&
      owned.generation !== expectedGeneration)
  )
    return { outcome: 'ownership-mismatch' as const }
  if (owned.state === 'completed')
    return { outcome: 'already-completed' as const }
  if (owned.state === 'armed') {
    armed = null
    return { outcome: 'not-started' as const, operationId, url: owned.url }
  }
  if (owned.state !== 'crawling')
    return { outcome: 'already-aborted' as const, operationId, url: owned.url }
  if (
    owned.url !== taskUrl() ||
    owned.generation === null ||
    !ownsCrawl(owned.generation)
  )
    return { outcome: 'ownership-mismatch' as const }
  terminate(owned, 'aborted')
  states.stopCrawl = true
  EVT.fire('stopCrawl')
  return { outcome: 'aborted' as const, operationId, url: owned.url }
}
window.addEventListener(EVT.list.crawlStart, () => {
  const generation = currentCrawl()
  if (
    armed &&
    armed.url === normalizeUrl(window.location.href) &&
    !states.bookmarkMode &&
    !states.crawlTagList &&
    generation !== null
  ) {
    operation = armed
    operation.generation = generation
    operation.state = 'crawling'
    operation.startedAt = new Date().toISOString()
    armed = null
  } else {
    // Any real crawl that does not consume this exact reservation expires it.
    // This prevents a later user crawl from inheriting stale automation ownership.
    operation = null
    armed = null
  }
})
/** 完成事件仅能完成仍持有权限的操作。 */
function markCompleted() {
  if (
    operation?.state === 'crawling' &&
    operation.generation !== null &&
    ownsCrawl(operation.generation) &&
    operation.url === taskUrl()
  ) {
    operation.state = 'completed'
    operation.completedAt = new Date().toISOString()
  }
}
window.addEventListener(EVT.list.crawlComplete, markCompleted)
window.addEventListener(EVT.list.crawlEmpty, markCompleted)
window.addEventListener(EVT.list.stopCrawl, () => {
  if (
    operation?.state === 'crawling' &&
    operation.generation !== null &&
    ownsCrawl(operation.generation)
  ) {
    terminate(operation, 'aborted')
    states.stopCrawl = true
  }
})
/** A trusted replacement queue supersedes a revoked managed result for the same URL. */
function releaseReplacedQueueOwnership() {
  if (
    operation &&
    operation.generation !== null &&
    !ownsCrawl(operation.generation) &&
    operation.url === taskUrl()
  ) {
    operation = null
  }
}
window.addEventListener(
  EVT.list.importResultLoaded,
  releaseReplacedQueueOwnership
)
window.addEventListener(EVT.list.resume, releaseReplacedQueueOwnership)
