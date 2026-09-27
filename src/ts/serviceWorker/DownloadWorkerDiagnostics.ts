import browser from 'webextension-polyfill'

/** 每个标签页保留的最近 worker 诊断事件数量。 */
const EVENT_LIMIT = 240
/** 持久化保留的疑似卡住报告数量。 */
const REPORT_LIMIT = 20
/** 疑似卡住报告的 storage.local 键名。 */
const REPORT_STORAGE_KEY = 'downloadHangDiagnostics'

/** Service worker 侧仍在处理的下载诊断任务。 */
interface WorkerTask {
  diagnosticId: string
  tabId: number
  workId: string
  fileName: string
  stage: string
  stageAt: string
  browserDownloadId?: number
}

/** Service worker 侧诊断事件。 */
interface WorkerEvent {
  at: string
  diagnosticId: string
  tabId: number
  stage: string
  details?: Record<string, unknown>
}

/** 跟踪 service worker 下载阶段并持久化异常诊断报告。 */
class DownloadWorkerDiagnostics {
  /** 当前仍在 worker 中活动的诊断任务。 */
  private readonly active = new Map<string, WorkerTask>()
  /** 按标签页保存的有界 worker 诊断事件。 */
  private readonly events = new Map<number, WorkerEvent[]>()
  /** 串行化持久化报告的队列，防止并发读改写丢失数据。 */
  private persistQueue: Promise<void> = Promise.resolve()

  /** 记录 worker 侧任务进入新的诊断阶段。 */
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

  /** 记录最终 worker 阶段并移除活动任务。 */
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

  /** 捕获指定标签页的 worker 状态及已知 Chrome 下载状态。 */
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

  /** 串行化 storage.local 的读改写，避免并发异常报告相互覆盖。 */
  public persist(tabId: number, report: unknown) {
    const write = async () => {
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
    const result = this.persistQueue.then(write, write)
    this.persistQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/** Service worker 侧下载诊断单例。 */
const downloadWorkerDiagnostics = new DownloadWorkerDiagnostics()
export { downloadWorkerDiagnostics }
