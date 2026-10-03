import { downloadDiagnostics } from './DownloadDiagnostics'
import { resume } from './Resume'
import { EVT } from '../EVT'
import { store } from '../store/Store'

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

/** 当前内容脚本生命周期内观察到的真实下载器事件。 */
const lifecycle = {
  crawlStarted: null as LifecycleObservation | null,
  crawlCompleted: null as LifecycleObservation | null,
  crawlEmpty: null as LifecycleObservation | null,
  downloadStarted: null as LifecycleObservation | null,
  downloadCompleted: null as LifecycleObservation | null,
  downloadPaused: null as LifecycleObservation | null,
  downloadStopped: null as LifecycleObservation | null,
  resumed: null as LifecycleObservation | null,
}

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

/** 记录真实下载器事件，避免从页面标题反推状态。 */
window.addEventListener(EVT.list.crawlStart, () => {
  lifecycle.crawlStarted = observe(window.location.href)
  lifecycle.crawlCompleted = null
  lifecycle.crawlEmpty = null
  resetDownloadLifecycle()
  lifecycle.resumed = null
})
window.addEventListener(EVT.list.crawlComplete, () => {
  lifecycle.crawlCompleted = observe(crawlTaskUrl())
  resetDownloadLifecycle()
})
window.addEventListener(EVT.list.resultChange, () => {
  lifecycle.crawlCompleted = observe(crawlTaskUrl())
  resetDownloadLifecycle()
})
window.addEventListener(EVT.list.crawlEmpty, () => {
  lifecycle.crawlEmpty = observe(crawlTaskUrl())
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

  let phase: AutomationPhase = 'IDLE'
  if (downloading) phase = 'DOWNLOADING'
  else if (bookmarkMode) phase = 'BOOKMARKING'
  else if (crawlingForCurrent) phase = 'CRAWLING'
  else if (busy) phase = 'BUSY_OTHER'
  else if (stoppedForCurrent) phase = 'STOPPED'
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
    lifecycle: Object.fromEntries(
      Object.entries(lifecycle).map(([key, value]) => [
        key,
        value ? { ...value } : null,
      ])
    ),
    durable,
  }
}

/** 在隔离世界暴露只读自动化状态查询函数。 */
const automationGlobal = globalThis as typeof globalThis & {
  __PBD_AUTOMATION_STATUS__?: typeof getAutomationStatus
}
automationGlobal.__PBD_AUTOMATION_STATUS__ = getAutomationStatus
