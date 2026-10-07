import { getCrawlRateTelemetry } from '../crawl/CrawlRateClient'
import {
  skipManagedCrawl,
  armManagedCrawl,
  abortManagedCrawl,
  getManagedCrawl,
  getManagedCrawlArm,
  managedCrawlBlocksDownload,
  managedCrawlRequiresReload,
} from './ManagedCrawlAutomation'
import { downloadDiagnostics } from './DownloadDiagnostics'
import { resume } from './Resume'
import { EVT } from '../EVT'
import { store } from '../store/Store'
import { states } from '../store/States'
import { IDTypeString } from '../store/StoreType'

/** 自动化客户端可观察的下载器生命周期阶段。 */
export type AutomationPhase =
  | 'CRAWLING'
  | 'DOWNLOADING'
  | 'BOOKMARKING'
  | 'BUSY_OTHER'
  | 'PAUSED_RESUMABLE'
  | 'READY'
  | 'RESTORING'
  | 'STOPPED'
  | 'IDLE'

/** 单个真实下载器事件的观察记录。 */
type LifecycleObservation = { at: string; url: string }

/** 自动化客户端读取的精简作品 ID 条目。 */
type AutomationIdEntry = { id: string; type: IDTypeString }

/** 自动化 ID 数量门限的同步判定结果。 */
type CrawlIdGateDecision = 'accepted' | 'rejected'
type CrawlIdGateRejectReason = 'count-exceeded' | 'novel-series-size-unknown'

/** 自动化客户端在抓取开始前预设的一次性 ID 数量门限。 */
type CrawlIdGate = { maxCount: number }

/** 在详细作品数据抓取开始前捕获的作品 ID 列表。 */
type CrawlIdListSnapshot = LifecycleObservation & {
  count: number
  items: AutomationIdEntry[]
  gate: {
    maxCount: number
    decision: CrawlIdGateDecision
    reason: CrawlIdGateRejectReason | null
  } | null
}

/** 当前内容脚本生命周期内观察到的真实下载器事件。 */
const lifecycle = {
  crawlStarted: null as LifecycleObservation | null,
  crawlCompleted: null as LifecycleObservation | null,
  crawlStopped: null as LifecycleObservation | null,
  crawlEmpty: null as LifecycleObservation | null,
  downloadStarted: null as LifecycleObservation | null,
  downloadCompleted: null as LifecycleObservation | null,
  downloadPaused: null as LifecycleObservation | null,
  downloadStopped: null as LifecycleObservation | null,
  resumed: null as LifecycleObservation | null,
}

/** 当前内容脚本生命周期内最近一次抓取到的预元数据作品 ID 列表。 */
let crawlIdListSnapshot: CrawlIdListSnapshot | null = null

/** 仅应用于下一次正常抓取的自动化 ID 数量门限。 */
let crawlIdGate: CrawlIdGate | null = null

/** 记录 transient exportIDList 是否由自动化门限设置，避免复位其他功能的状态。 */
let ownsTransientExportIdList = false

/** 生成带 URL 的事件观察，避免 Pixiv SPA 切页后串用旧状态。 */
function normalizeUrl(url: string) {
  return url.split('#')[0]
}

/** 生成带 URL 的事件观察，避免 Pixiv SPA 切页后串用旧状态。 */
function observe(url = window.location.href): LifecycleObservation {
  return {
    at: new Date().toISOString(),
    url: normalizeUrl(url),
  }
}

/** 当前活动下载所绑定的任务 URL；跨 SPA 导航时保持不变。 */
let activeDownloadUrl: string | null = null

/** 下载生命周期属于任务启动时绑定的 URL，而不是事件触发时的 SPA 路由。 */
function downloadTaskUrl() {
  return (
    activeDownloadUrl ||
    normalizeUrl(store.URLWhenCrawlStart || window.location.href)
  )
}

/** 清除上一下载队列的终止状态，并释放当前下载 URL 所有权。 */
function resetDownloadLifecycle() {
  lifecycle.downloadStarted = null
  lifecycle.downloadCompleted = null
  lifecycle.downloadPaused = null
  lifecycle.downloadStopped = null
  activeDownloadUrl = null
}

/** 返回抓取队列绑定的原始 URL，而不是事件触发时的 SPA 路由。 */
function crawlTaskUrl() {
  return normalizeUrl(store.URLWhenCrawlStart || window.location.href)
}

/** 在 ID 列表过滤完成、详细作品数据抓取开始前保存快照并同步执行自动化门限。 */
function captureCrawlIdList() {
  // 批量收藏也会触发 getIdListFinished，但它不是抓取任务，不能消费自动化门限或污染抓取快照。
  const taskUrl = lifecycle.crawlStarted?.url
  if (states.bookmarkMode || !taskUrl) {
    return
  }

  // 用户可能在 ID 过滤仍在等待时停止抓取。stopCrawl 事件先于 states.stopCrawl=true，
  // 所以迟到的 getIdListFinished 必须在这里丢弃门限，不能重新武装临时 exportIDList。
  if (states.stopCrawl) {
    crawlIdGate = null
    if (ownsTransientExportIdList) {
      states.exportIDList = false
      ownsTransientExportIdList = false
    }
    return
  }

  const items = store.idList.map((item) => ({
    id: item.id,
    type: item.type,
  }))
  const gate = crawlIdGate
  crawlIdGate = null
  const containsNovelSeries = items.some((item) => item.type === 'novelSeries')
  const rejectReason: CrawlIdGateRejectReason | null = gate
    ? containsNovelSeries
      ? 'novel-series-size-unknown'
      : items.length > gate.maxCount
        ? 'count-exceeded'
        : null
    : null
  const decision: CrawlIdGateDecision | null = gate
    ? rejectReason
      ? 'rejected'
      : 'accepted'
    : null

  // 复用下载器现有的生产级“获取 ID 列表后停止”路径；不启用持久设置，因此不会导出 JSON 文件。
  if (decision === 'rejected') {
    states.exportIDList = true
    ownsTransientExportIdList = true
  }

  crawlIdListSnapshot = {
    ...observe(taskUrl),
    count: items.length,
    items,
    gate: gate
      ? { maxCount: gate.maxCount, decision: decision!, reason: rejectReason }
      : null,
  }
  if (decision === 'rejected' && skipManagedCrawl('skipped-work-count')) {
    states.stopCrawl = true
    EVT.fire('stopCrawl')
  }
}

/** 预设下一次正常抓取的作品 ID 数量门限；超过门限时会在元数据请求前停止。 */
export function setAutomationCrawlIdGate(maxCount: number | null) {
  if (states.busy) {
    throw new Error('cannot configure crawl ID gate while downloader is busy')
  }
  if (maxCount === null) {
    crawlIdGate = null
    return { armed: false, maxCount: null }
  }
  if (!Number.isSafeInteger(maxCount) || maxCount < 0) {
    throw new RangeError('maxCount must be a non-negative safe integer or null')
  }
  crawlIdGate = { maxCount }
  return { armed: true, maxCount }
}

/** 记录真实下载器事件，避免从页面标题反推状态。 */
window.addEventListener(EVT.list.crawlStart, () => {
  lifecycle.crawlStarted = observe(window.location.href)
  crawlIdListSnapshot = null
  lifecycle.crawlCompleted = null
  lifecycle.crawlStopped = null
  lifecycle.crawlEmpty = null
  resetDownloadLifecycle()
  lifecycle.resumed = null
})
window.addEventListener(EVT.list.crawlComplete, () => {
  lifecycle.crawlCompleted = observe(crawlTaskUrl())
  resetDownloadLifecycle()
})
window.addEventListener(EVT.list.resultChange, () => {
  if (states.busy) return
  lifecycle.crawlCompleted = observe(crawlTaskUrl())
  resetDownloadLifecycle()
})
window.addEventListener(EVT.list.crawlEmpty, () => {
  lifecycle.crawlEmpty = observe(crawlTaskUrl())
})
window.addEventListener(EVT.list.getIdListFinished, captureCrawlIdList)
window.addEventListener(EVT.list.stopCrawl, () => {
  lifecycle.crawlStopped = observe(crawlTaskUrl())
  // 只复位由自动化门限持有的临时状态，避免干扰其他功能。
  if (ownsTransientExportIdList) {
    states.exportIDList = false
    ownsTransientExportIdList = false
  }
})
window.addEventListener(EVT.list.downloadStart, () => {
  activeDownloadUrl = normalizeUrl(
    store.URLWhenCrawlStart || window.location.href
  )
  lifecycle.downloadStarted = observe(activeDownloadUrl)
  lifecycle.downloadCompleted = null
  lifecycle.downloadStopped = null
})
window.addEventListener(EVT.list.downloadComplete, () => {
  lifecycle.downloadCompleted = observe(downloadTaskUrl())
  activeDownloadUrl = null
})
window.addEventListener(EVT.list.downloadPause, () => {
  lifecycle.downloadPaused = observe(downloadTaskUrl())
})
window.addEventListener(EVT.list.downloadStop, () => {
  lifecycle.downloadStopped = observe(downloadTaskUrl())
  activeDownloadUrl = null
})
window.addEventListener(EVT.list.resume, () => {
  lifecycle.resumed = observe()
})

/** 返回供外部自动化读取的稳定下载器状态。 */
export async function getAutomationStatus() {
  const requestedUrl = normalizeUrl(window.location.href)
  const durable = await resume.getSavedTaskStatus(requestedUrl)
  const crawlRate = await Promise.resolve()
    .then(() => getCrawlRateTelemetry(getManagedCrawl()?.operationId))
    .catch(() => null)
  const currentUrl = normalizeUrl(window.location.href)
  if (currentUrl !== requestedUrl) {
    return getAutomationStatus()
  }
  const controller = downloadDiagnostics.automationSnapshot()
  const resultLength = Number(controller.resultLength ?? 0)
  const busy = controller.busy === true
  const downloading = controller.downloading === true
  const bookmarkMode = controller.bookmarkMode === true
  const pause = controller.pause === true
  const stop = controller.stop === true
  const crawlObservedForCurrent =
    lifecycle.crawlStarted?.url === currentUrl ||
    lifecycle.crawlCompleted?.url === currentUrl ||
    lifecycle.crawlEmpty?.url === currentUrl
  const crawlingForCurrent =
    busy &&
    lifecycle.crawlStarted?.url === currentUrl &&
    lifecycle.crawlCompleted?.url !== currentUrl &&
    lifecycle.crawlEmpty?.url !== currentUrl
  const resumedForCurrent = lifecycle.resumed?.url === currentUrl
  const liveResultsBoundToCurrent = crawlObservedForCurrent || resumedForCurrent
  const stoppedForCurrent =
    stop && lifecycle.downloadStopped?.url === currentUrl
  const crawlIdList =
    crawlIdListSnapshot?.url === currentUrl
      ? {
          capturedAt: crawlIdListSnapshot.at,
          url: crawlIdListSnapshot.url,
          count: crawlIdListSnapshot.count,
          gate: crawlIdListSnapshot.gate
            ? { ...crawlIdListSnapshot.gate }
            : null,
        }
      : null

  let phase: AutomationPhase = 'IDLE'
  if (downloading) phase = 'DOWNLOADING'
  else if (bookmarkMode) phase = 'BOOKMARKING'
  else if (crawlingForCurrent) phase = 'CRAWLING'
  else if (busy) phase = 'BUSY_OTHER'
  else if (
    stoppedForCurrent ||
    (managedCrawlBlocksDownload() && getManagedCrawl()?.url === currentUrl)
  )
    phase = 'STOPPED'
  else if (durable && !liveResultsBoundToCurrent) phase = 'RESTORING'
  else if (pause && durable && liveResultsBoundToCurrent)
    phase = 'PAUSED_RESUMABLE'
  else if (
    resultLength > 0 &&
    (resumedForCurrent || lifecycle.crawlCompleted?.url === currentUrl) &&
    lifecycle.downloadCompleted?.url !== currentUrl
  )
    phase = 'READY'

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    phase,
    page: { url: currentUrl },
    controller,
    managedOperation: getManagedCrawl(),
    managedArm: getManagedCrawlArm(),
    requiresReload: managedCrawlRequiresReload(),
    crawlIdList,
    crawlRate,
    lifecycle: Object.fromEntries(
      Object.entries(lifecycle).map(([key, value]) => [
        key,
        value ? { ...value } : null,
      ])
    ),
    durable,
  }
}

/** 返回当前页面最近一次预元数据作品 ID 列表的独立只读快照。 */
export function getAutomationCrawlIdList() {
  const currentUrl = normalizeUrl(window.location.href)
  if (!crawlIdListSnapshot || crawlIdListSnapshot.url !== currentUrl) {
    return null
  }
  return {
    schemaVersion: 1,
    capturedAt: crawlIdListSnapshot.at,
    url: crawlIdListSnapshot.url,
    count: crawlIdListSnapshot.count,
    gate: crawlIdListSnapshot.gate ? { ...crawlIdListSnapshot.gate } : null,
    items: crawlIdListSnapshot.items.map((item) => ({ ...item })),
  }
}

/** 在隔离世界暴露只读自动化查询函数。 */
const automationGlobal = globalThis as typeof globalThis & {
  __PBD_AUTOMATION_STATUS__?: typeof getAutomationStatus
  __PBD_AUTOMATION_CRAWL_ID_LIST__?: typeof getAutomationCrawlIdList
  __PBD_AUTOMATION_SET_CRAWL_ID_GATE__?: typeof setAutomationCrawlIdGate
  __PBD_AUTOMATION_ARM_CRAWL__?: typeof armManagedCrawl
  __PBD_AUTOMATION_ABORT_CRAWL__?: typeof abortManagedCrawl
}
automationGlobal.__PBD_AUTOMATION_STATUS__ = getAutomationStatus
automationGlobal.__PBD_AUTOMATION_CRAWL_ID_LIST__ = getAutomationCrawlIdList
automationGlobal.__PBD_AUTOMATION_SET_CRAWL_ID_GATE__ = setAutomationCrawlIdGate
automationGlobal.__PBD_AUTOMATION_ARM_CRAWL__ = armManagedCrawl
automationGlobal.__PBD_AUTOMATION_ABORT_CRAWL__ = abortManagedCrawl
