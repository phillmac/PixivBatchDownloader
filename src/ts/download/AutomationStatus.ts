import { downloadDiagnostics } from './DownloadDiagnostics'
import { resume } from './Resume'
import { states } from '../store/States'

/** 自动化客户端可观察的下载器生命周期阶段。 */
export type AutomationPhase =
  | 'CRAWLING'
  | 'DOWNLOADING'
  | 'PAUSED_RESUMABLE'
  | 'READY'
  | 'RESTORING'
  | 'STOPPED'
  | 'IDLE'

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
    states.crawlCompleteTime > states.downloadCompleteTime
  )
    phase = 'READY'

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    phase,
    page: page.page,
    controller,
    lifecycle: {
      crawlCompleteTime: states.crawlCompleteTime,
      downloadCompleteTime: states.downloadCompleteTime,
    },
    durable,
  }
}

/** 在隔离世界暴露只读自动化状态查询函数。 */
const automationGlobal = globalThis as typeof globalThis & {
  __PBD_AUTOMATION_STATUS__?: typeof getAutomationStatus
}
automationGlobal.__PBD_AUTOMATION_STATUS__ = getAutomationStatus
