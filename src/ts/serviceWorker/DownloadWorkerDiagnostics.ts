import browser from 'webextension-polyfill'

const EVENT_LIMIT = 240
const REPORT_LIMIT = 20
const REPORT_STORAGE_KEY = 'downloadHangDiagnostics'

interface WorkerTask {
  diagnosticId: string
  tabId: number
  workId: string
  fileName: string
  stage: string
  stageAt: string
  browserDownloadId?: number
}

interface WorkerEvent {
  at: string
  diagnosticId: string
  tabId: number
  stage: string
  details?: Record<string, unknown>
}

class DownloadWorkerDiagnostics {
  private readonly active = new Map<string, WorkerTask>()
  private readonly events = new Map<number, WorkerEvent[]>()

  public enter(
    tabId: number,
    diagnosticId: string | undefined,
    stage: string,
    details: Record<string, unknown> = {}
  ) {
    if (!diagnosticId) return
    const previous = this.active.get(diagnosticId)
    const task: WorkerTask = {
      diagnosticId,
      tabId,
      workId:
        typeof details.workId === 'string'
          ? details.workId
          : previous?.workId || '',
      fileName:
        typeof details.fileName === 'string'
          ? details.fileName
          : previous?.fileName || '',
      stage,
      stageAt: new Date().toISOString(),
      browserDownloadId:
        typeof details.browserDownloadId === 'number'
          ? details.browserDownloadId
          : previous?.browserDownloadId,
    }
    this.active.set(diagnosticId, task)
    const events = this.events.get(tabId) || []
    events.push({
      at: task.stageAt,
      diagnosticId,
      tabId,
      stage,
      details,
    })
    if (events.length > EVENT_LIMIT) {
      events.splice(0, events.length - EVENT_LIMIT)
    }
    this.events.set(tabId, events)
  }

  public finish(
    tabId: number,
    diagnosticId: string | undefined,
    stage: string,
    details: Record<string, unknown> = {}
  ) {
    if (!diagnosticId) return
    this.enter(tabId, diagnosticId, stage, details)
    this.active.delete(diagnosticId)
  }

  public async snapshot(
    tabId: number,
    bookkeeping: Record<string, unknown> = {}
  ) {
    const active = [...this.active.values()].filter(
      (task) => task.tabId === tabId
    )
    const downloads = []
    for (const task of active) {
      if (task.browserDownloadId === undefined) continue
      try {
        const [item] = await browser.downloads.search({
          id: task.browserDownloadId,
        })
        downloads.push(
          item
            ? {
                diagnosticId: task.diagnosticId,
                id: item.id,
                filename: item.filename,
                state: item.state,
                paused: item.paused,
                error: item.error,
                bytesReceived: item.bytesReceived,
                totalBytes: item.totalBytes,
                startTime: item.startTime,
                endTime: item.endTime,
                exists: item.exists,
              }
            : {
                diagnosticId: task.diagnosticId,
                id: task.browserDownloadId,
                missing: true,
              }
        )
      } catch (error) {
        downloads.push({
          diagnosticId: task.diagnosticId,
          id: task.browserDownloadId,
          lookupError: String(error),
        })
      }
    }

    return {
      capturedAt: new Date().toISOString(),
      active,
      recentEvents: (this.events.get(tabId) || []).slice(),
      downloads,
      bookkeeping,
    }
  }

  public async persist(tabId: number, report: unknown) {
    const stored = await browser.storage.local.get(REPORT_STORAGE_KEY)
    const reports = Array.isArray(stored[REPORT_STORAGE_KEY])
      ? stored[REPORT_STORAGE_KEY]
      : []
    reports.push({ tabId, storedAt: new Date().toISOString(), report })
    if (reports.length > REPORT_LIMIT) {
      reports.splice(0, reports.length - REPORT_LIMIT)
    }
    await browser.storage.local.set({ [REPORT_STORAGE_KEY]: reports })
  }
}

const downloadWorkerDiagnostics = new DownloadWorkerDiagnostics()
export { downloadWorkerDiagnostics }
