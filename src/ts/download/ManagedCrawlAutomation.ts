import { EVT } from '../EVT'
import { store } from '../store/Store'
import { states } from '../store/States'
import { resume } from './Resume'

/** 托管抓取的生命周期状态。 */
export type ManagedCrawlState =
  'armed' | 'crawling' | 'completed' | 'aborting' | 'aborted' | 'abort-failed'

/** 单次托管抓取的所有权和时间记录。 */
type ManagedOperation = {
  operationId: string
  url: string
  state: ManagedCrawlState
  armedAt: string
  startedAt: string | null
  completedAt: string | null
  abortedAt: string | null
  abortError: string | null
}

/** 当前已消费的抓取所有权。 */
let operation: ManagedOperation | null = null
/** 下一次精确匹配抓取的武装，不释放旧部分队列的保护。 */
let armed: ManagedOperation | null = null
/** 当前操作共享的异步清理。 */
let cleanup: Promise<void> | null = null
/** 内容脚本内的操作序号。 */
let sequence = 0

/** 与 Resume 保持一致的 URL 规范。 */
function normalizeUrl(url: string) {
  return url.split('#')[0]
}

/** 获取抓取绑定的 URL，独立于 SPA 导航。 */
function taskUrl() {
  return normalizeUrl(store.URLWhenCrawlStart || window.location.href)
}

/** 返回独立的所有权快照。 */
function snapshot() {
  return operation ? { ...operation } : null
}

/**
 * Reserve ownership of the next normal crawl on this exact Pixiv URL.
 * The reservation is consumed only by a matching crawlStart event.
 */
export function armManagedCrawl(url: string) {
  if (typeof url !== 'string' || !url) {
    throw new Error('expected an exact Pixiv URL')
  }
  const expectedUrl = normalizeUrl(url)
  if (!/^https:\/\/www\.pixiv\.net\//.test(expectedUrl)) {
    throw new Error('expected an exact Pixiv URL')
  }
  if (normalizeUrl(window.location.href) !== expectedUrl) {
    throw new Error('managed crawl URL does not match the live page')
  }
  if (
    states.busy ||
    operation?.state === 'aborting' ||
    operation?.state === 'crawling'
  ) {
    throw new Error('cannot arm while a crawl or cleanup is active')
  }

  armed = {
    operationId: `${Date.now()}-${++sequence}`,
    url: expectedUrl,
    state: 'armed',
    armedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    abortedAt: null,
    abortError: null,
  }
  return { ...armed }
}

/** Return the owned operation independently of the current SPA route. */
export function getManagedCrawl() {
  return snapshot()
}

/** 返回尚未消费的下一次抓取武装。 */
export function getManagedCrawlArm() {
  return armed ? { ...armed } : null
}

/**
 * Central download safety gate. An aborted managed crawl can keep live partial
 * results in memory until the next crawl/reload, but those results are never a
 * valid download source.
 */
export function managedCrawlBlocksDownload(
  url = store.URLWhenCrawlStart || window.location.href
) {
  if (!operation) return false
  if (
    operation.state !== 'aborting' &&
    operation.state !== 'aborted' &&
    operation.state !== 'abort-failed'
  ) {
    return false
  }
  return operation.url === normalizeUrl(url)
}

/** 完成已取得所有权的删除，失败时保持下载保护。 */
async function finishAbort(owned: ManagedOperation) {
  try {
    await resume.discardSavedTask(owned.url)
    if (owned.state === 'aborting') {
      owned.state = 'aborted'
      owned.abortedAt = new Date().toISOString()
      EVT.fire('managedCrawlAbortComplete')
    }
  } catch (error) {
    if (operation === owned) {
      owned.state = 'abort-failed'
      owned.abortError = error instanceof Error ? error.message : String(error)
    }
    throw error
  }
}

/**
 * Atomically compare ownership before mutating anything. The operation token is
 * the authority; the current SPA route is deliberately not used as the target.
 */
export async function abortManagedCrawl(
  operationId: string,
  expectedUrl: string,
  requestStop = true
) {
  const owned = operation?.operationId === operationId ? operation : armed
  if (
    !owned ||
    owned.operationId !== operationId ||
    typeof expectedUrl !== 'string' ||
    owned.url !== normalizeUrl(expectedUrl)
  ) {
    return { outcome: 'ownership-mismatch' as const }
  }

  if (owned.state === 'completed') {
    return { outcome: 'already-completed' as const }
  }
  if (owned.state === 'armed') {
    if (armed === owned) {
      armed = null
    }
    return {
      outcome: 'not-started' as const,
      operationId: owned.operationId,
      url: owned.url,
    }
  }
  if (owned.state === 'aborted') {
    return {
      outcome: 'already-aborted' as const,
      operationId: owned.operationId,
      url: owned.url,
    }
  }
  if (owned.state === 'abort-failed') {
    return {
      outcome: 'cleanup-failed' as const,
      operationId: owned.operationId,
      url: owned.url,
      error: owned.abortError,
    }
  }

  let ownedCleanup = cleanup
  if (owned.state === 'crawling') {
    if (taskUrl() !== owned.url) {
      return { outcome: 'ownership-mismatch' as const }
    }

    owned.state = 'aborting'
    owned.abortError = null
    // discardSavedTask suppresses persistence synchronously before its first
    // await, so stopCrawl/late resultChange cannot create a new partial queue.
    ownedCleanup = finishAbort(owned)
    cleanup = ownedCleanup

    if (requestStop) {
      // Match the real Stop Crawl button semantics: listeners first, then the
      // stop flag that the active crawl workers observe.
      EVT.fire('stopCrawl')
    }
    // 外部直接派发停止事件时也要通知抓取线程；重入建立的新任务不受影响。
    if (operation === owned && taskUrl() === owned.url) {
      states.stopCrawl = true
    }
  }

  if (ownedCleanup) {
    try {
      await ownedCleanup
    } catch {
      return {
        outcome: 'cleanup-failed' as const,
        operationId: owned.operationId,
        url: owned.url,
        error: owned.abortError,
      }
    }
  }

  return {
    outcome: 'aborted' as const,
    operationId: owned.operationId,
    url: owned.url,
    ...(owned.abortError ? { error: owned.abortError } : {}),
  }
}

window.addEventListener(EVT.list.crawlStart, () => {
  const url = normalizeUrl(window.location.href)
  if (armed && armed.url === url && !states.bookmarkMode) {
    operation = armed
    operation.state = 'crawling'
    operation.startedAt = new Date().toISOString()
    armed = null
    cleanup = null
    return
  }

  // A real crawl that does not consume the reservation is not automation-owned.
  operation = null
  cleanup = null
})

function markManagedCrawlCompleted() {
  // Once aborting has begun, a late completion event cannot make the partial
  // queue valid again. Stop wins over completion.
  if (operation?.state === 'crawling' && operation.url === taskUrl()) {
    operation.state = 'completed'
    operation.completedAt = new Date().toISOString()
  }
}

window.addEventListener(EVT.list.crawlComplete, markManagedCrawlCompleted)
window.addEventListener(EVT.list.crawlEmpty, markManagedCrawlCompleted)

window.addEventListener(EVT.list.stopCrawl, () => {
  if (operation?.state === 'crawling') {
    void abortManagedCrawl(operation.operationId, operation.url, false)
  }
})

[executed on device: vps-2782c273.vps.ovh.ca (aab511b1-1559-4c02-ab43-c54e410fdc88)]