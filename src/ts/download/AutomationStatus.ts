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

/** 当前页面加载周期内观察到的生命周期事件。 */
const lifecycle = {
  crawlStartedAt: null as string | null,
  crawlCompletedAt: null as string | null,
  crawlEmptyAt: null as string | null,
  downloadStartedAt: null as string | null,
  downloadCompletedAt: null as string | null,
  downloadPausedAt: null as string | null,
  resumedAt: null as string | null,
}

/** 记录真实下载器事件，避免从页面标题反推状态。 */
for (const [event, key] of [
  [EVT.list.crawlStart, 'crawlStartedAt'],
  [EVT.list.crawlComplete, 'crawlCompletedAt'],
  [EVT.list.crawlEmpty, 'crawlEmptyAt'],
  [EVT.list.downloadStart, 'downloadStartedAt'],
  [EVT.list.downloadComplete, 'downloadCompletedAt'],
  [EVT.list.downloadPause, 'downloadPausedAt'],
  [EVT.list.resume, 'resumedAt'],
] as const) {
  window.addEventListener(event, () => {
    lifecycle[key] = new Date().toISOString()
  })
}

/** 返回供外部自动化读取的稳定下载器状态。 */
export async function getAutomationStatus() {
  const page = downloadDiagnostics.pageSnapshot()
  const controller = page.controller as Record<string, unknown>
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
    (durable !== null || lifecycle.crawlCompletedAt !== null) &&
    lifecycle.downloadCompletedAt === null
  )
    phase = 'READY'

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    phase,
    page: page.page,
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
