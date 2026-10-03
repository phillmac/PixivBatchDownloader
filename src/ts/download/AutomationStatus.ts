import { downloadDiagnostics } from './DownloadDiagnostics'
import { resume } from './Resume'
import { EVT } from '../EVT'

/** 自动化客户端可观察的下载器生命周期阶段。 */
export type AutomationPhase =
  | 'CRAWLING'
  | 'DOWNLOADING'
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
  resumed: null as LifecycleObservation | null,
}

/** 生成带 URL 的事件观察，避免 Pixiv SPA 切页后串用旧状态。 */
function observe(): LifecycleObservation {
  return {
    at: new Date().toISOString(),
    url: window.location.href.split('#')[0],
  }
}

/** 记录真实下载器事件，避免从页面标题反推状态。 */
window.addEventListener(EVT.list.crawlStart, () => {
  lifecycle.crawlStarted = observe()
  lifecycle.crawlCompleted = null
  lifecycle.crawlEmpty = null
  lifecycle.downloadStarted = null
  lifecycle.downloadCompleted = null
  lifecycle.downloadPaused = null
  lifecycle.resumed = null
})
window.addEventListener(EVT.list.crawlComplete, () => {
  lifecycle.crawlCompleted = observe()
})
window.addEventListener(EVT.list.crawlEmpty, () => {
  lifecycle.crawlEmpty = observe()
})
window.addEventListener(EVT.list.downloadStart, () => {
  lifecycle.downloadStarted = observe()
  lifecycle.downloadCompleted = null
})
window.addEventListener(EVT.list.downloadComplete, () => {
  lifecycle.downloadCompleted = observe()
})
window.addEventListener(EVT.list.downloadPause, () => {
  lifecycle.downloadPaused = observe()
})
window.addEventListener(EVT.list.resume, () => {
  lifecycle.resumed = observe()
})

/** 返回供外部自动化读取的稳定下载器状态。 */
export async function getAutomationStatus() {
  const page = downloadDiagnostics.pageSnapshot()
  const controller = page.controller as Record<string, unknown>
  const currentUrl = page.page.url.split('#')[0]
  const durable = await resume.getSavedTaskStatus()
  const resultLength = Number(controller.resultLength ?? 0)
  const busy = controller.busy === true
  const downloading = controller.downloading === true
  const pause = controller.pause === true
  const stop = controller.stop === true

  let phase: AutomationPhase = 'IDLE'
  if (downloading) phase = 'DOWNLOADING'
  else if (busy) phase = 'CRAWLING'
  else if (stop) phase = 'STOPPED'
  else if (durable && resultLength === 0) phase = 'RESTORING'
  else if (pause && durable) phase = 'PAUSED_RESUMABLE'
  else if (
    resultLength > 0 &&
    (durable !== null || lifecycle.crawlCompleted?.url === currentUrl) &&
    lifecycle.downloadCompleted?.url !== currentUrl
  )
    phase = 'READY'

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    phase,
    page: { ...page.page, url: currentUrl },
    controller,
    lifecycle: { ...lifecycle },
    durable,
  }
}

/** 在隔离世界暴露只读自动化状态查询函数。 */
const automationGlobal = globalThis as typeof globalThis & {
  __PBD_AUTOMATION_STATUS__?: typeof getAutomationStatus
}
automationGlobal.__PBD_AUTOMATION_STATUS__ = getAutomationStatus
