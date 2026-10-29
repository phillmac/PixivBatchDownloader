import browser from 'webextension-polyfill'
import {
  diagnosticBytes,
  diagnosticLimits,
  diagnosticRecord,
  diagnosticSample,
  diagnosticText,
  trimDiagnosticEvents,
} from '../download/DiagnosticSerialization'

/** worker 诊断只保留有限活动任务和最近有事件的标签页。 */
const ACTIVE_LIMIT = 256
/** worker 历史事件最多保留的标签页数。 */
const TAB_LIMIT = 32
/** 待持久化报告最多排队数量，避免存储阻塞时积压。 */
const PENDING_LIMIT = 8
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
interface WorkerEvent extends Record<string, unknown> {
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
  private persistQueue: Promise<unknown> = Promise.resolve()
  /** 当前等待持久化的报告数量。 */
  private pendingReports = 0
  /** 容量限制移除的活动诊断任务总数。 */
  private evictedTasks = 0
  /** 各标签页已被事件环省略的记录数量。 */
  private readonly omittedEvents = new Map<number, number>()

  /** 记录 worker 侧任务进入新的诊断阶段。 */
  public enter(
    tabId: number,
    diagnosticId: string | undefined,
    stage: string,
    details: Record<string, unknown> = {}
  ) {
    if (!diagnosticId) return
    const key = `${tabId}:${diagnosticId}`
    const previous = this.active.get(key)
    if (!previous && this.active.size >= ACTIVE_LIMIT) {
      this.active.delete(this.active.keys().next().value!)
      this.evictedTasks++
    }
    const task: WorkerTask = {
      diagnosticId,
      tabId,
      workId:
        typeof details.workId === 'string'
          ? diagnosticText(details.workId)
          : previous?.workId || '',
      fileName:
        typeof details.fileName === 'string'
          ? diagnosticText(details.fileName)
          : previous?.fileName || '',
      stage: diagnosticText(stage),
      stageAt: new Date().toISOString(),
      browserDownloadId:
        typeof details.browserDownloadId === 'number'
          ? details.browserDownloadId
          : previous?.browserDownloadId,
    }
    this.active.set(key, task)
    const events = this.events.get(tabId) || []
    events.push({
      at: task.stageAt,
      diagnosticId,
      tabId,
      stage: diagnosticText(stage),
      details: diagnosticRecord(details),
    })
    this.omittedEvents.set(
      tabId,
      (this.omittedEvents.get(tabId) || 0) + trimDiagnosticEvents(events)
    )
    this.events.delete(tabId)
    this.events.set(tabId, events)
    if (this.events.size > TAB_LIMIT) {
      const oldest = this.events.keys().next().value!
      this.events.delete(oldest)
      this.omittedEvents.delete(oldest)
    }
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
    this.active.delete(`${tabId}:${diagnosticId}`)
  }

  /** 捕获指定标签页的 worker 状态及已知 Chrome 下载状态。 */
  public async snapshot(
    tabId: number,
    bookkeeping: Record<string, unknown> = {}
  ) {
    const tasks = [...this.active.values()].filter(
      (task) => task.tabId === tabId
    )
    const active = diagnosticSample(
      tasks.map((task) => ({ ...task })),
      tasks.length
    )
    const recent = diagnosticSample(
      (this.events.get(tabId) || []).slice().reverse(),
      (this.events.get(tabId) || []).length
    )
    // 在第一次异步查询前复制事件和账目，避免混入查询期间的新状态。
    const capturedBookkeeping = diagnosticRecord(
      bookkeeping,
      diagnosticLimits.collection
    )
    const downloads = []
    for (const task of active.items) {
      if (typeof task.browserDownloadId !== 'number') continue
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

    return diagnosticRecord(
      {
        capturedAt: new Date().toISOString(),
        active: active.items,
        activeTotal: active.total,
        activeOmitted: active.omitted,
        evictedTasks: this.evictedTasks,
        recentEvents: recent.items.reverse(),
        recentEventsOmitted:
          (this.omittedEvents.get(tabId) || 0) + recent.omitted,
        bookkeeping: capturedBookkeeping,
        downloads,
      },
      diagnosticLimits.worker
    )
  }

  /** 串行化读改写并按 UTF-8 JSON 字节淘汰旧报告；存储失败不影响下载。 */
  public persist(tabId: number, report: unknown) {
    if (this.pendingReports >= PENDING_LIMIT) {
      return Promise.resolve({ stored: false, reason: 'diagnostic-queue-full' })
    }
    const entry = diagnosticRecord(
      { tabId, storedAt: new Date().toISOString(), report },
      diagnosticLimits.report
    )
    this.pendingReports++
    const write = async () => {
      try {
        const stored = await browser.storage.local.get(REPORT_STORAGE_KEY)
        const previous: unknown[] = Array.isArray(stored[REPORT_STORAGE_KEY])
          ? stored[REPORT_STORAGE_KEY]
          : []
        const reports = [entry]
        // 计算完整 storage 对象的大小，包含键名、数组和封装信息。
        let bytes = diagnosticBytes({ [REPORT_STORAGE_KEY]: reports })
        for (
          let i = previous.length - 1;
          i >= 0 && reports.length < REPORT_LIMIT;
          i--
        ) {
          const old = previous[i]
          const bounded = diagnosticRecord(
            old && typeof old === 'object' && !Array.isArray(old)
              ? (old as Record<string, unknown>)
              : { report: old },
            diagnosticLimits.report
          )
          const size = diagnosticBytes(bounded) + 1
          if (bytes + size > diagnosticLimits.retention) break
          reports.unshift(bounded)
          bytes += size
        }
        await browser.storage.local.set({ [REPORT_STORAGE_KEY]: reports })
        return { stored: true }
      } catch {
        // 不重试同一份大报告，也不让遥测异常拒绝原始下载消息。
        return { stored: false, reason: 'diagnostic-storage-unavailable' }
      } finally {
        this.pendingReports--
      }
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
